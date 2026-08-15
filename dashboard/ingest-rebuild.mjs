/**
 * ingest-rebuild.mjs — 서울 열린데이터광장 정비사업 API → 신규 지정 / 해제 목록
 *
 * 사용법:
 *   SEOUL_OPENAPI_KEY=<키> node ingest-rebuild.mjs           # 실 데이터 수집 (캐시 활용)
 *   SEOUL_OPENAPI_KEY=<키> node ingest-rebuild.mjs --fresh   # 캐시 무시, 전체 재수집
 *   node ingest-rebuild.mjs --selftest                        # 로컬 픽스처로 파이프라인 검증
 *
 * 데이터 출처: docs/정비사업-데이터-확인.md (2026-08-12 실측 조사)
 *   - upisRebuild (OA-20281)      정비사업 현황 — RPT_TYPE 으로 신설/변경/폐지/실효 구분
 *   - upisAnnouncement (OA-20283) 결정고시 정보 — 고시일(ANCMNT_YMD) 공급원
 *   조인 경로: upisRebuild.DCSN_ANCMNT_MNG_CD → upisAnnouncement.ANCMNT_MNG_CD (99.0% 성립)
 *
 * 환경 변수:
 *   SEOUL_OPENAPI_KEY  서울 열린데이터광장 인증키 (URL-encoded 없는 원문)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 이 파일이 `node ingest-rebuild.mjs` 로 직접 실행됐는가.
 * ingest.mjs 와 같은 이유다 — import 만으로 main() 이 돌면 안 된다(2026-08-12 사고).
 * import.meta.main 은 Node 24+ 전용이라 러너(Node 22)에서 항상 false 가 되므로 쓰지 않는다.
 */
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
})();

// ════════════════════════════════════════════════
//  .env 자동 로드 (ingest.mjs 와 동일 방식)
// ════════════════════════════════════════════════
(() => {
  const envPath = join(__dirname, '..', '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim().replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = val;
  }
})();

// ════════════════════════════════════════════════
//  상수
// ════════════════════════════════════════════════
const PAGE_SIZE = 1000; // 서울 열린데이터광장 1회 최대 건수
const MAX_RETRY = 3;
const REQ_DELAY_MS = 150; // 호출 횟수 제한은 없으나, 순차 호출 사이 최소 여유

const CACHE_DIR = join(__dirname, '.cache', 'rebuild');

// 캐시 스키마 버전 — 값을 올리면 이전 버전 캐시가 전량 무효화되어 자동 재수집된다.
//   v1: row 원문 필드(CN 제외) 그대로 보존
const CACHE_SCHEMA_VERSION = 1;

// 서비스명 (docs/정비사업-데이터-확인.md §0 에서 실측 확인)
const SERVICES = {
  rebuild:      'upisRebuild',      // OA-20281 — 정비사업 현황
  announcement: 'upisAnnouncement', // OA-20283 — 결정고시 정보
};

// 해제를 나타내는 RPT_TYPE 값. 고시 제목(TTL)으로는 26~44%만 잡힌다 — RPT_TYPE 필수.
const CANCELLED_TYPES = new Set(['폐지', '실효']);
const NEW_TYPE = '신설';

// 서울 25개 자치구 — PSTN_NM/LOGVM에서 자치구를 추출할 때 쓰는 사전
const SEOUL_DISTRICTS = [
  '종로구', '중구', '용산구', '성동구', '광진구', '동대문구', '중랑구', '성북구',
  '강북구', '도봉구', '노원구', '은평구', '서대문구', '마포구', '양천구', '강서구',
  '구로구', '금천구', '영등포구', '동작구', '관악구', '서초구', '강남구', '송파구',
  '강동구',
];

// ════════════════════════════════════════════════
//  XML 파싱 (의존성 없는 정규식 기반)
// ════════════════════════════════════════════════

/**
 * 서울 열린데이터광장 응답의 <RESULT><CODE>를 검사한다.
 * 정상 코드는 'INFO-000'. 그 외는 에러로 취급한다.
 * @param {string} xml
 * @throws {Error}
 */
function checkApiResult(xml) {
  const codeMatch = xml.match(/<CODE>\s*([^<]*?)\s*<\/CODE>/);
  if (!codeMatch) return; // CODE 태그 없으면 통과 (row 파싱에서 판정)
  const code = codeMatch[1].trim();
  if (code === 'INFO-000') return;

  const msgMatch = xml.match(/<MESSAGE>\s*([\s\S]*?)\s*<\/MESSAGE>/);
  const msg = msgMatch ? msgMatch[1].trim() : '알 수 없는 오류';
  const err = new Error(`API 오류 (CODE ${code}): ${msg}`);
  err.apiCode = code;
  throw err;
}

/**
 * 응답에서 list_total_count 를 읽는다.
 * @param {string} xml
 * @returns {number}
 */
export function parseListTotalCount(xml) {
  const m = xml.match(/<list_total_count>\s*(\d+)\s*<\/list_total_count>/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * <row>...</row> 블록을 추출해 태그명→텍스트 맵 배열로 반환한다.
 * 서비스마다 필드 구성이 달라 태그를 미리 정하지 않고 전부 읽는다.
 * CN(고시 전문)은 조인에 쓰이지 않고 용량만 커서 제외한다.
 *
 * @param {string} xml
 * @returns {Object[]}  각 row의 { TAG: string|null } 맵
 */
export function parseRows(xml) {
  checkApiResult(xml);

  const rows = [];
  const rowRe = /<row>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const block = rowMatch[1];
    const obj = {};
    const tagRe = /<([A-Za-z_][A-Za-z0-9_]*)>([\s\S]*?)<\/\1>/g;
    let tagMatch;
    while ((tagMatch = tagRe.exec(block)) !== null) {
      const tag = tagMatch[1];
      if (tag === 'CN') continue; // 고시 전문 — 조인·집계에 불필요, 캐시 용량 절감
      const raw = tagMatch[2]
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .trim();
      obj[tag] = raw === '' ? null : raw;
    }
    rows.push(obj);
  }
  return rows;
}

// ════════════════════════════════════════════════
//  로컬 캐시 (서비스명 + 페이지 범위)
//  캐시 항목: { schemaVersion, totalCount, rows: [...] }
// ════════════════════════════════════════════════

function cacheKey(service, start, end) {
  return `${service}_${start}_${end}`;
}

function cachePath(service, start, end) {
  return join(CACHE_DIR, `${cacheKey(service, start, end)}.json`);
}

function cacheLoad(service, start, end) {
  const p = cachePath(service, start, end);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function cacheSave(service, start, end, data) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(
    cachePath(service, start, end),
    JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, ...data }),
    'utf8'
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ════════════════════════════════════════════════
//  네트워크
// ════════════════════════════════════════════════

/**
 * 단일 페이지 요청 (재시도 없음).
 * @returns {{ rows: Object[], totalCount: number }}
 */
async function fetchOnePage(serviceKey, service, start, end) {
  const url = `http://openAPI.seoul.go.kr:8088/${serviceKey}/xml/${service}/${start}/${end}/`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    err.httpStatus = res.status;
    throw err;
  }
  const xml = await res.text();
  const rows = parseRows(xml);
  const totalCount = parseListTotalCount(xml);
  return { rows, totalCount };
}

/**
 * 한 서비스의 전체 데이터를 페이지(1,000건)씩 나눠 수집한다.
 * 페이지 단위로 캐시하며, 캐시 히트 시 네트워크 호출을 건너뛴다.
 *
 * @param {string} serviceKey
 * @param {string} service    'upisRebuild' | 'upisAnnouncement'
 * @param {boolean} useCache
 * @param {Object} stats       { calls, hits, failures: [] }
 * @returns {Object[]}  전체 row 배열
 */
async function fetchAllRows(serviceKey, service, useCache, stats) {
  const allRows = [];
  let start = 1;
  let totalCount = Infinity;

  while (start <= totalCount) {
    const end = start + PAGE_SIZE - 1;

    if (useCache) {
      const cached = cacheLoad(service, start, end);
      if (cached !== null && cached.schemaVersion === CACHE_SCHEMA_VERSION) {
        stats.hits++;
        allRows.push(...cached.rows);
        totalCount = cached.totalCount;
        start = end + 1;
        continue;
      }
    }

    let lastErr;
    let result = null;
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        stats.calls++;
        await sleep(REQ_DELAY_MS);
        result = await fetchOnePage(serviceKey, service, start, end);
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_RETRY) {
          const waitMs = 1000 * Math.pow(2, attempt - 1);
          console.warn(`  [재시도 ${attempt}/${MAX_RETRY}] ${service} ${start}-${end}: ${err.message} — ${waitMs}ms 후 재시도`);
          await sleep(waitMs);
        }
      }
    }

    if (result === null) {
      stats.failures.push({ service, start, end, reason: lastErr.message });
      console.error(`  [실패] ${service} ${start}-${end}: ${lastErr.message}`);
      break; // totalCount를 모르는 상태이므로 더 진행하지 않음
    }

    cacheSave(service, start, end, result);
    allRows.push(...result.rows);
    totalCount = result.totalCount;
    start = end + 1;
  }

  return allRows;
}

// ════════════════════════════════════════════════
//  집계 (순수 함수 — 단위 테스트 가능)
// ════════════════════════════════════════════════

/**
 * RPT_MNG_CD/PRJC_CD 같은 관리코드에 박힌 8자리 날짜를 뽑아낸다.
 * 형식: 자치구코드(5) + 유형코드(3) + 날짜(8) + 일련번호(...)
 * 조인된 고시일(ANCMNT_YMD)이 없을 때만 정렬 폴백으로 쓴다.
 *
 * @param {string|null|undefined} code
 * @returns {string|null}  "YYYY-MM-DD" 또는 추출 불가 시 null
 */
export function embeddedDateISO(code) {
  if (!code || code.length < 16) return null;
  const d = code.slice(8, 16);
  if (!/^\d{8}$/.test(d)) return null;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/**
 * PSTN_NM(우선) 또는 LOGVM에서 서울 자치구명을 추출한다.
 * @param {string|null} pstnNm
 * @param {string|null} logvm
 * @returns {string|null}
 */
export function extractDistrict(pstnNm, logvm) {
  if (pstnNm) {
    const found = SEOUL_DISTRICTS.find(d => pstnNm.includes(d));
    if (found) return found;
  }
  if (logvm && SEOUL_DISTRICTS.includes(logvm)) return logvm;
  return null;
}

/**
 * upisRebuild row와 조인된 고시일을 하나의 이벤트 레코드로 정규화한다.
 * @param {Object} row           upisRebuild의 row (원본 태그 맵)
 * @param {Map<string,Object>} announcementByCode  ANCMNT_MNG_CD → announcement row
 * @returns {{
 *   prjcCd: string, rptMngCd: string, rptType: string,
 *   pstnNm: string|null, rgnNm: string|null, district: string|null,
 *   ancmntYmd: string|null, ancmntNo: string|null, sortKey: string,
 * }}
 */
function normalizeEvent(row, announcementByCode) {
  const dcsnCode = row.DCSN_ANCMNT_MNG_CD;
  const announcement = dcsnCode ? announcementByCode.get(dcsnCode) : undefined;
  const ancmntYmd = announcement?.ANCMNT_YMD ? announcement.ANCMNT_YMD.slice(0, 10) : null;

  return {
    prjcCd:    row.PRJC_CD,
    rptMngCd:  row.RPT_MNG_CD,
    rptType:   row.RPT_TYPE,
    pstnNm:    row.PSTN_NM ?? null,
    rgnNm:     row.RGN_NM ?? null,
    district:  extractDistrict(row.PSTN_NM, row.LOGVM),
    ancmntYmd,
    ancmntNo:  announcement?.ANCMNT_NO ?? null,
    // 정렬 기준: 조인된 고시일 우선, 없으면 관리코드 내장 날짜로 폴백
    sortKey: ancmntYmd ?? embeddedDateISO(row.RPT_MNG_CD) ?? '0000-00-00',
  };
}

/**
 * upisRebuild + upisAnnouncement 원본 row를 PRJC_CD 기준으로 묶어
 * 사업(정비구역) 단위 타임라인을 만든다.
 *
 * 레코드 단위가 "구역"이 아니라 "고시 이벤트"이므로(§docs), 같은 PRJC_CD의
 * 신설→변경→폐지 이벤트를 시간순으로 정렬해 최신 상태를 판단할 수 있게 한다.
 *
 * @param {Object[]} rebuildRows        upisRebuild row 배열 (원본 태그 맵)
 * @param {Object[]} announcementRows   upisAnnouncement row 배열 (원본 태그 맵)
 * @returns {Map<string, { events: Object[], currentStatus: string }>}
 */
export function buildProjects(rebuildRows, announcementRows) {
  const announcementByCode = new Map();
  for (const a of announcementRows) {
    if (a.ANCMNT_MNG_CD) announcementByCode.set(a.ANCMNT_MNG_CD, a);
  }

  const projects = new Map();
  for (const row of rebuildRows) {
    if (!row.PRJC_CD) continue;
    const event = normalizeEvent(row, announcementByCode);
    if (!projects.has(row.PRJC_CD)) projects.set(row.PRJC_CD, []);
    projects.get(row.PRJC_CD).push(event);
  }

  const result = new Map();
  for (const [prjcCd, events] of projects) {
    // sortKey(날짜) 오름차순 — 동일 날짜는 원본 순서 유지(안정 정렬)
    const sorted = [...events].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    const currentStatus = sorted[sorted.length - 1].rptType;
    result.set(prjcCd, { events: sorted, currentStatus });
  }
  return result;
}

/**
 * 신규 지정 목록 — RPT_TYPE='신설' 이벤트 중, 그 사업의 최신 상태가
 * 이미 폐지/실효로 넘어가지 않은 것만 포함한다(안 그러면 폐지된 구역이
 * 신규 목록에 남는다 — docs §2).
 *
 * @param {Map<string, {events: Object[], currentStatus: string}>} projects
 * @returns {{ prjcCd: string, district: string|null, rgnNm: string|null, pstnNm: string|null, ancmntYmd: string|null }[]}
 */
export function extractNewDesignations(projects) {
  const out = [];
  for (const [prjcCd, { events, currentStatus }] of projects) {
    if (CANCELLED_TYPES.has(currentStatus)) continue; // 이미 폐지된 사업 — 제외
    const newEvent = events.find(e => e.rptType === NEW_TYPE);
    if (!newEvent) continue;
    out.push({
      prjcCd,
      district: newEvent.district,
      rgnNm:    newEvent.rgnNm,
      pstnNm:   newEvent.pstnNm,
      ancmntYmd: newEvent.ancmntYmd,
    });
  }
  return out.sort((a, b) => (b.ancmntYmd ?? '').localeCompare(a.ancmntYmd ?? ''));
}

/**
 * 해제 목록 — 사업의 최신 상태가 폐지/실효인 경우, 그 최신(해제) 이벤트를 낸다.
 * 제목(TTL)이 아니라 RPT_TYPE으로 판별한다(docs §3 — 제목 키워드로는 26~44%만 잡힘).
 *
 * @param {Map<string, {events: Object[], currentStatus: string}>} projects
 * @returns {{ prjcCd: string, district: string|null, rgnNm: string|null, pstnNm: string|null, ancmntYmd: string|null, rptType: string }[]}
 */
export function extractCancellations(projects) {
  const out = [];
  for (const [prjcCd, { events, currentStatus }] of projects) {
    if (!CANCELLED_TYPES.has(currentStatus)) continue;
    const latest = events[events.length - 1];
    out.push({
      prjcCd,
      district: latest.district,
      rgnNm:    latest.rgnNm,
      pstnNm:   latest.pstnNm,
      ancmntYmd: latest.ancmntYmd,
      rptType:  latest.rptType,
    });
  }
  return out.sort((a, b) => (b.ancmntYmd ?? '').localeCompare(a.ancmntYmd ?? ''));
}

// ════════════════════════════════════════════════
//  셀프테스트 모드 (--selftest)
//  네트워크 없이 인라인 픽스처로 파이프라인 검증
// ════════════════════════════════════════════════

const FIXTURE_REBUILD_XML = `
<?xml version="1.0" encoding="UTF-8"?>
<upisRebuild>
  <list_total_count>5</list_total_count>
  <RESULT><CODE>INFO-000</CODE><MESSAGE>정상 처리되었습니다.</MESSAGE></RESULT>
  <row>
    <RPT_MNG_CD>11680AGZ202401150001</RPT_MNG_CD>
    <PRJC_CD>11680PPL202401150001</PRJC_CD>
    <LOGVM>강남구</LOGVM>
    <RPT_TYPE>신설</RPT_TYPE>
    <LCLSF>의제처리구역</LCLSF>
    <MCLSF>정비구역</MCLSF>
    <SCLSF>주택재건축사업</SCLSF>
    <PSTN_NM>강남구 개포동 12번지 일대</PSTN_NM>
    <RGN_NM>개포1 재건축사업 정비구역</RGN_NM>
    <AREA_EXS>10000</AREA_EXS>
    <DCSN_ANCMNT_MNG_CD>11680NTC202401200001</DCSN_ANCMNT_MNG_CD>
  </row>
  <!-- 신설 이후 변경 이벤트 — 같은 PRJC_CD, 여전히 살아있는 구역 -->
  <row>
    <RPT_MNG_CD>11680UTZ202501100002</RPT_MNG_CD>
    <PRJC_CD>11680PPL202401150001</PRJC_CD>
    <LOGVM>강남구</LOGVM>
    <RPT_TYPE>변경</RPT_TYPE>
    <LCLSF>의제처리구역</LCLSF>
    <MCLSF>정비구역</MCLSF>
    <SCLSF>주택재건축사업</SCLSF>
    <PSTN_NM>강남구 개포동 12번지 일대</PSTN_NM>
    <RGN_NM>개포1 재건축사업 정비구역</RGN_NM>
    <AREA_EXS>10500</AREA_EXS>
    <DCSN_ANCMNT_MNG_CD>11680NTC202501150002</DCSN_ANCMNT_MNG_CD>
  </row>
  <!-- 신설 후 폐지된 사업 — 신규 목록에서 반드시 빠져야 한다 -->
  <row>
    <RPT_MNG_CD>11350AGZ202203010003</RPT_MNG_CD>
    <PRJC_CD>11350PPL202203010003</PRJC_CD>
    <LOGVM>노원구</LOGVM>
    <RPT_TYPE>신설</RPT_TYPE>
    <LCLSF>의제처리구역</LCLSF>
    <MCLSF>정비구역</MCLSF>
    <SCLSF>주택재개발사업구역</SCLSF>
    <PSTN_NM>노원구 월계동 400번지 일대</PSTN_NM>
    <RGN_NM>월계 재개발 정비구역</RGN_NM>
    <AREA_EXS>20000</AREA_EXS>
    <DCSN_ANCMNT_MNG_CD>11350NTC202203050003</DCSN_ANCMNT_MNG_CD>
  </row>
  <row>
    <RPT_MNG_CD>11350UTZ202411200004</RPT_MNG_CD>
    <PRJC_CD>11350PPL202203010003</PRJC_CD>
    <LOGVM>노원구</LOGVM>
    <RPT_TYPE>폐지</RPT_TYPE>
    <LCLSF>의제처리구역</LCLSF>
    <MCLSF>정비구역</MCLSF>
    <SCLSF>주택재개발사업구역</SCLSF>
    <PSTN_NM>노원구 월계동 400번지 일대</PSTN_NM>
    <RGN_NM>월계 재개발 정비구역 해제</RGN_NM>
    <AREA_EXS>20000</AREA_EXS>
    <DCSN_ANCMNT_MNG_CD>11350NTC202411250004</DCSN_ANCMNT_MNG_CD>
  </row>
  <!-- 제목에 해제 키워드가 없는 실효 사례 — RPT_TYPE으로만 잡혀야 한다 -->
  <row>
    <RPT_MNG_CD>11740AGZ202001100005</RPT_MNG_CD>
    <PRJC_CD>11740PPL202001100005</PRJC_CD>
    <LOGVM>강동구</LOGVM>
    <RPT_TYPE>실효</RPT_TYPE>
    <LCLSF>의제처리구역</LCLSF>
    <MCLSF>정비구역</MCLSF>
    <SCLSF>도시환경정비사업구역</SCLSF>
    <PSTN_NM>강동구 천호동 500번지 일대</PSTN_NM>
    <RGN_NM>천호 재정비촉진지구 세부계획 변경(경미한 변경)</RGN_NM>
    <AREA_EXS>8000</AREA_EXS>
    <DCSN_ANCMNT_MNG_CD>11740NTC202601100005</DCSN_ANCMNT_MNG_CD>
  </row>
</upisRebuild>
`;

const FIXTURE_ANNOUNCEMENT_XML = `
<?xml version="1.0" encoding="UTF-8"?>
<upisAnnouncement>
  <list_total_count>6</list_total_count>
  <RESULT><CODE>INFO-000</CODE><MESSAGE>정상 처리되었습니다.</MESSAGE></RESULT>
  <row>
    <ANCMNT_MNG_CD>11680NTC202401200001</ANCMNT_MNG_CD>
    <TKCG_INST>강남구</TKCG_INST>
    <PRJC_CD>11680PPL202401150001</PRJC_CD>
    <ANCMNT_TYPE>결정</ANCMNT_TYPE>
    <ANCMNT_NO>2024-11</ANCMNT_NO>
    <ANCMNT_YMD>2024-01-20T00:00:00.000</ANCMNT_YMD>
    <ANCMNT_INST>강남구</ANCMNT_INST>
    <TTL>개포1 재건축사업 정비구역 지정 고시</TTL>
  </row>
  <row>
    <ANCMNT_MNG_CD>11680NTC202501150002</ANCMNT_MNG_CD>
    <TKCG_INST>강남구</TKCG_INST>
    <PRJC_CD>11680PPL202401150001</PRJC_CD>
    <ANCMNT_TYPE>결정</ANCMNT_TYPE>
    <ANCMNT_NO>2025-05</ANCMNT_NO>
    <ANCMNT_YMD>2025-01-15T00:00:00.000</ANCMNT_YMD>
    <ANCMNT_INST>강남구</ANCMNT_INST>
    <TTL>개포1 재건축사업 정비계획 변경 고시</TTL>
  </row>
  <row>
    <ANCMNT_MNG_CD>11350NTC202203050003</ANCMNT_MNG_CD>
    <TKCG_INST>노원구</TKCG_INST>
    <PRJC_CD>11350PPL202203010003</PRJC_CD>
    <ANCMNT_TYPE>결정</ANCMNT_TYPE>
    <ANCMNT_NO>2022-40</ANCMNT_NO>
    <ANCMNT_YMD>2022-03-05T00:00:00.000</ANCMNT_YMD>
    <ANCMNT_INST>노원구</ANCMNT_INST>
    <TTL>월계 재개발 정비구역 지정 고시</TTL>
  </row>
  <row>
    <ANCMNT_MNG_CD>11350NTC202411250004</ANCMNT_MNG_CD>
    <TKCG_INST>노원구</TKCG_INST>
    <PRJC_CD>11350PPL202203010003</PRJC_CD>
    <ANCMNT_TYPE>결정</ANCMNT_TYPE>
    <ANCMNT_NO>2024-88</ANCMNT_NO>
    <ANCMNT_YMD>2024-11-25T00:00:00.000</ANCMNT_YMD>
    <ANCMNT_INST>노원구</ANCMNT_INST>
    <TTL>월계 재개발 정비구역 및 정비계획 해제 결정 고시</TTL>
  </row>
  <!-- 강동구 실효 건은 의도적으로 조인 실패시켜 embeddedDateISO 폴백 경로를 검증한다 -->
  <row>
    <ANCMNT_MNG_CD>99999NTC000000000000</ANCMNT_MNG_CD>
    <TKCG_INST>서울특별시</TKCG_INST>
    <PRJC_CD>00000PPL000000000000</PRJC_CD>
    <ANCMNT_TYPE>결정</ANCMNT_TYPE>
    <ANCMNT_NO>0000-00</ANCMNT_NO>
    <ANCMNT_YMD>2000-01-01T00:00:00.000</ANCMNT_YMD>
    <ANCMNT_INST>서울특별시</ANCMNT_INST>
    <TTL>무관한 고시</TTL>
  </row>
</upisAnnouncement>
`;

const FIXTURE_ERROR_XML = `
<?xml version="1.0" encoding="UTF-8"?>
<upisRebuild>
  <RESULT><CODE>ERROR-300</CODE><MESSAGE>필수 파라미터가 누락되어 있습니다.</MESSAGE></RESULT>
</upisRebuild>
`;

function runSelfTest() {
  console.log('=== 정비사업 파이프라인 셀프테스트 시작 ===\n');
  let pass = true;
  const failures = [];

  function assert(label, condition, detail = '') {
    if (condition) {
      console.log(`  PASS  ${label}`);
    } else {
      console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
      pass = false;
      failures.push(label);
    }
  }

  // ── 1. parseRows / parseListTotalCount ──────────
  console.log('[1] parseRows + parseListTotalCount 검증');
  const rebuildRows = parseRows(FIXTURE_REBUILD_XML);
  assert('upisRebuild 픽스처 5건 파싱', rebuildRows.length === 5, `실제: ${rebuildRows.length}`);
  assert('list_total_count = 5', parseListTotalCount(FIXTURE_REBUILD_XML) === 5);
  assert('row[0].RPT_TYPE = 신설', rebuildRows[0].RPT_TYPE === '신설');
  assert('row[0].PRJC_CD 보존', rebuildRows[0].PRJC_CD === '11680PPL202401150001');
  assert('CN 태그는 애초에 없음(제외 대상)', rebuildRows[0].CN === undefined);

  const announcementRows = parseRows(FIXTURE_ANNOUNCEMENT_XML);
  assert('upisAnnouncement 픽스처 6건 파싱', announcementRows.length === 6, `실제: ${announcementRows.length}`);
  assert('announcement[0].ANCMNT_YMD 보존',
    announcementRows[0].ANCMNT_YMD === '2024-01-20T00:00:00.000');

  let apiErrCaught = false;
  try { parseRows(FIXTURE_ERROR_XML); } catch { apiErrCaught = true; }
  assert('CODE != INFO-000 → 예외 발생', apiErrCaught);

  // ── 2. embeddedDateISO ───────────────────────────
  console.log('\n[2] embeddedDateISO 검증');
  assert('11000AGZ198504032330 → 1985-04-03',
    embeddedDateISO('11000AGZ198504032330') === '1985-04-03',
    `실제: ${embeddedDateISO('11000AGZ198504032330')}`);
  assert('null/undefined → null', embeddedDateISO(null) === null && embeddedDateISO(undefined) === null);
  assert('짧은 코드 → null', embeddedDateISO('1234') === null);

  // ── 3. extractDistrict ───────────────────────────
  console.log('\n[3] extractDistrict 검증');
  assert('PSTN_NM에서 강남구 추출', extractDistrict('강남구 개포동 12번지 일대', null) === '강남구');
  assert('PSTN_NM 매칭 실패 시 LOGVM 폴백', extractDistrict('알수없는 동네', '서초구') === '서초구');
  assert('둘 다 실패 시 null', extractDistrict('동명만 있음', '서울특별시') === null);

  // ── 4. buildProjects — PRJC_CD 그룹핑 + 조인 ─────
  console.log('\n[4] buildProjects 검증');
  const projects = buildProjects(rebuildRows, announcementRows);
  assert('프로젝트 3개로 그룹핑 (5건 → 3 PRJC_CD)', projects.size === 3, `실제: ${projects.size}`);

  const gangnam = projects.get('11680PPL202401150001');
  assert('강남 사업 이벤트 2건(신설+변경)', gangnam.events.length === 2);
  assert('강남 사업 currentStatus = 변경 (최신 이벤트)', gangnam.currentStatus === '변경',
    `실제: ${gangnam.currentStatus}`);
  assert('강남 사업 신설 이벤트 조인 성공 → ancmntYmd=2024-01-20',
    gangnam.events[0].ancmntYmd === '2024-01-20', `실제: ${gangnam.events[0].ancmntYmd}`);
  assert('강남 사업 신설 이벤트 district=강남구', gangnam.events[0].district === '강남구');

  const nowon = projects.get('11350PPL202203010003');
  assert('노원 사업 이벤트 2건(신설+폐지)', nowon.events.length === 2);
  assert('노원 사업 currentStatus = 폐지', nowon.currentStatus === '폐지');
  assert('노원 사업 정렬 순서: 신설이 먼저', nowon.events[0].rptType === '신설');

  const gangdong = projects.get('11740PPL202001100005');
  assert('강동 사업(조인 실패) currentStatus = 실효', gangdong.currentStatus === '실효');
  assert('강동 사업 조인 실패 → ancmntYmd=null (embeddedDateISO 폴백만 sortKey에 사용)',
    gangdong.events[0].ancmntYmd === null);
  assert('강동 사업 sortKey는 RPT_MNG_CD 내장 날짜로 폴백 (2020-01-10)',
    gangdong.events[0].sortKey === '2020-01-10', `실제: ${gangdong.events[0].sortKey}`);

  // ── 5. extractNewDesignations — 폐지된 사업은 제외 ──
  console.log('\n[5] extractNewDesignations 검증');
  const newDesignations = extractNewDesignations(projects);
  assert('신규 지정 1건만 (노원 사업은 이미 폐지되어 제외)',
    newDesignations.length === 1, `실제: ${newDesignations.length}`);
  assert('신규 지정 = 개포1 재건축사업', newDesignations[0].prjcCd === '11680PPL202401150001');
  assert('신규 지정 district = 강남구', newDesignations[0].district === '강남구');
  assert('신규 지정 ancmntYmd = 2024-01-20', newDesignations[0].ancmntYmd === '2024-01-20');

  // ── 6. extractCancellations — RPT_TYPE 기반, 제목 무관 ──
  console.log('\n[6] extractCancellations 검증');
  const cancellations = extractCancellations(projects);
  assert('해제 2건 (노원 폐지 + 강동 실효)', cancellations.length === 2, `실제: ${cancellations.length}`);
  const byPrjc = Object.fromEntries(cancellations.map(c => [c.prjcCd, c]));
  assert('노원 사업 해제 rptType=폐지', byPrjc['11350PPL202203010003'].rptType === '폐지');
  assert('노원 사업 해제 ancmntYmd=2024-11-25', byPrjc['11350PPL202203010003'].ancmntYmd === '2024-11-25');
  assert('강동 사업 해제 rptType=실효 (제목에 해제 키워드 없어도 잡힘)',
    byPrjc['11740PPL202001100005'].rptType === '실효');
  assert('강남 사업(현재 활성)은 해제 목록에 없음',
    !('11680PPL202401150001' in byPrjc));

  // ── 7. 캐시 키/경로 검증 ─────────────────────────
  console.log('\n[7] 캐시 키 / 경로 검증');
  const key = cacheKey('upisRebuild', 1, 1000);
  const path = cachePath('upisRebuild', 1, 1000);
  assert('캐시 키 = upisRebuild_1_1000', key === 'upisRebuild_1_1000');
  assert('캐시 경로에 .cache/rebuild 포함', path.includes(join('.cache', 'rebuild')));
  assert('존재하지 않는 캐시 → null', cacheLoad('upisRebuild', 999999, 999999) === null);

  // ── 결과 출력 ────────────────────────────────────
  console.log('\n=== 집계 샘플 ===');
  console.log('신규 지정:', newDesignations);
  console.log('해제:', cancellations);

  console.log(`\n${pass ? 'PASS' : `FAIL (${failures.length}건 실패: ${failures.join(', ')})`}`);
  process.exit(pass ? 0 : 1);
}

// ════════════════════════════════════════════════
//  실 데이터 수집 메인 플로우
// ════════════════════════════════════════════════

async function main() {
  const serviceKey = process.env.SEOUL_OPENAPI_KEY;
  if (!serviceKey) {
    console.error(
      '[오류] SEOUL_OPENAPI_KEY 환경 변수가 설정되지 않았습니다.\n' +
      '       .env 파일에 SEOUL_OPENAPI_KEY=여기에인증키 를 설정하세요.\n\n' +
      '       파이프라인 검증만 하려면:\n' +
      '       node ingest-rebuild.mjs --selftest'
    );
    process.exit(1);
  }

  const useFresh = process.argv.includes('--fresh');
  const useCache = !useFresh;

  if (useFresh) {
    console.log('[ingest-rebuild] --fresh 모드: 캐시를 무시하고 전체 재수집합니다.');
  } else {
    console.log('[ingest-rebuild] 캐시 모드: 이미 수집된 페이지는 건너뜁니다.');
  }

  const stats = { calls: 0, hits: 0, failures: [] };

  console.log('\n[ingest-rebuild] upisRebuild 수집 중...');
  const rebuildRows = await fetchAllRows(serviceKey, SERVICES.rebuild, useCache, stats);
  console.log(`[ingest-rebuild] upisRebuild ${rebuildRows.length}건 수집 완료`);

  console.log('\n[ingest-rebuild] upisAnnouncement 수집 중...');
  const announcementRows = await fetchAllRows(serviceKey, SERVICES.announcement, useCache, stats);
  console.log(`[ingest-rebuild] upisAnnouncement ${announcementRows.length}건 수집 완료`);

  console.log(`\n[ingest-rebuild] 수집 완료 요약: 호출 ${stats.calls}건 · 캐시 ${stats.hits}건 · 실패 ${stats.failures.length}건`);
  if (stats.failures.length > 0) {
    for (const f of stats.failures) {
      console.log(`  ✗ ${f.service} ${f.start}-${f.end}: ${f.reason}`);
    }
  }

  console.log('\n[ingest-rebuild] PRJC_CD 기준 그룹핑 및 조인 중...');
  const projects = buildProjects(rebuildRows, announcementRows);
  console.log(`[ingest-rebuild] 고유 사업(PRJC_CD) 수: ${projects.size}`);

  const newDesignations = extractNewDesignations(projects);
  const cancellations = extractCancellations(projects);

  console.log(`\n[ingest-rebuild] 신규 지정: ${newDesignations.length}건`);
  console.log(`[ingest-rebuild] 해제(폐지+실효): ${cancellations.length}건`);

  console.log('\n[ingest-rebuild] 최근 신규 지정 5건:');
  for (const d of newDesignations.slice(0, 5)) {
    console.log(`  ${d.ancmntYmd ?? '(고시일 미확인)'} [${d.district ?? '자치구 미확인'}] ${d.rgnNm ?? d.pstnNm}`);
  }

  console.log('\n[ingest-rebuild] 최근 해제 5건:');
  for (const c of cancellations.slice(0, 5)) {
    console.log(`  ${c.ancmntYmd ?? '(고시일 미확인)'} [${c.district ?? '자치구 미확인'}] (${c.rptType}) ${c.rgnNm ?? c.pstnNm}`);
  }

  console.log('\n[ingest-rebuild] 완료!');

  if (stats.failures.length > 0) {
    process.exit(1);
  }
}

// ════════════════════════════════════════════════
//  진입점
// ════════════════════════════════════════════════
// import 로 들어온 경우에는 아무것도 실행하지 않는다.
if (isDirectRun) {
  if (process.argv.includes('--selftest')) {
    runSelfTest();
  } else {
    main().catch(err => {
      console.error('[ingest-rebuild] 오류:', err.message);
      process.exit(1);
    });
  }
}
