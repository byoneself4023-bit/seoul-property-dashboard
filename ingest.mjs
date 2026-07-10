/**
 * ingest.mjs — 국토교통부 RTMS 실거래가 API → dashboard.html 주입
 *
 * 사용법:
 *   RTMS_SERVICE_KEY=<키> node ingest.mjs           # 실 데이터 수집 (캐시 활용)
 *   RTMS_SERVICE_KEY=<키> node ingest.mjs --fresh   # 캐시 무시, 전체 재수집
 *   node ingest.mjs --selftest                      # 로컬 픽스처로 파이프라인 검증
 *
 * 환경 변수:
 *   RTMS_SERVICE_KEY  공공데이터포털 API 인증키 (URL-encoded 없는 원문)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ════════════════════════════════════════════════
//  .env 자동 로드 (의존성 없음)
//  이미 설정된 환경 변수는 덮어쓰지 않음(인라인 우선)
// ════════════════════════════════════════════════
(() => {
  const envPath = join(__dirname, '.env');
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
const DELAY_MS  = 200;   // 요청 간 대기 — 일일 한도(10,000건) 방어
const PAGE_SIZE = 1000;  // numOfRows
const MAX_RETRY = 3;     // 지수 백오프 최대 재시도
const CACHE_DIR = join(__dirname, '.cache', 'ingest');

// ════════════════════════════════════════════════
//  25개 서울 자치구 법정동코드
// ════════════════════════════════════════════════
const DISTRICTS = [
  { name: '종로구',   code: '11110' },
  { name: '중구',     code: '11140' },
  { name: '용산구',   code: '11170' },
  { name: '성동구',   code: '11200' },
  { name: '광진구',   code: '11215' },
  { name: '동대문구', code: '11230' },
  { name: '중랑구',   code: '11260' },
  { name: '성북구',   code: '11290' },
  { name: '강북구',   code: '11305' },
  { name: '도봉구',   code: '11320' },
  { name: '노원구',   code: '11350' },
  { name: '은평구',   code: '11380' },
  { name: '서대문구', code: '11410' },
  { name: '마포구',   code: '11440' },
  { name: '양천구',   code: '11470' },
  { name: '강서구',   code: '11500' },
  { name: '구로구',   code: '11530' },
  { name: '금천구',   code: '11545' },
  { name: '영등포구', code: '11560' },
  { name: '동작구',   code: '11590' },
  { name: '관악구',   code: '11620' },
  { name: '서초구',   code: '11650' },
  { name: '강남구',   code: '11680' },
  { name: '송파구',   code: '11710' },
  { name: '강동구',   code: '11740' },
];

// ════════════════════════════════════════════════
//  API 엔드포인트
//  호출 순서: apt → rh → sh → offi (offi는 마지막)
//  ⚠️  오피스텔 API는 별도 활용신청 필요 (data.go.kr)
//  비아파트 정의로 오피스텔을 제외하려면 아래 offi 줄을 주석 처리한다.
// ════════════════════════════════════════════════
const ENDPOINTS = {
  apt:  'http://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev',
  rh:   'http://apis.data.go.kr/1613000/RTMSDataSvcRHTrade/getRTMSDataSvcRHTrade',
  sh:   'http://apis.data.go.kr/1613000/RTMSDataSvcSHTrade/getRTMSDataSvcSHTrade',
  offi: 'http://apis.data.go.kr/1613000/RTMSDataSvcOffiTrade/getRTMSDataSvcOffiTrade', // 오피스텔 — 제외하려면 이 줄 주석 처리
};

// ════════════════════════════════════════════════
//  기간 계산 (순수 함수 — 단위 테스트 가능)
// ════════════════════════════════════════════════

/**
 * runDate 기준으로 수집 범위를 계산한다.
 * @param {Date} runDate
 * @returns {{
 *   dealYmdList: string[],       // 요청할 YYYYMM 목록 (당월 포함 13개)
 *   monthPeriods: string[],      // 완료된 12개월 키 ["YYYY-MM", ...] 오래된순
 *   weekPeriods:  string[],      // 완료된 12주 키 ["YYYY-MM-DD~YYYY-MM-DD", ...] 오래된순
 *   currentYM:    string,        // 진행 중인 당월 "YYYYMM"
 *   currentWeekMon: string,      // 진행 중인 이번 주 월요일 "YYYY-MM-DD"
 * }}
 */
export function buildPeriods(runDate) {
  const year  = runDate.getFullYear();
  const month = runDate.getMonth(); // 0-based

  // ── 월 기간 ────────────────────────────────────
  // 완료된 최근 12개월 (당월 제외)
  const monthPeriods = [];
  for (let i = 12; i >= 1; i--) {
    const d = new Date(year, month - i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    monthPeriods.push(`${y}-${m}`);
  }

  // 요청할 DEAL_YMD: 완료 12개월 + 당월 = 13개
  const currentYM = `${year}${String(month + 1).padStart(2, '0')}`;
  const dealYmdList = [
    ...monthPeriods.map(p => p.replace('-', '')),
    currentYM,
  ];

  // ── 주 기간 ────────────────────────────────────
  // 이번 주 월요일 계산
  const day = runDate.getDay(); // 0=일, 1=월 .. 6=토
  const daysToMon = day === 0 ? 6 : day - 1;
  const thisMon = new Date(runDate);
  thisMon.setDate(runDate.getDate() - daysToMon);

  const fmtDate = d =>
    `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

  const currentWeekMon = fmtDate(thisMon);

  // 완료된 최근 12주 (이번 주 제외)
  const weekPeriods = [];
  for (let i = 12; i >= 1; i--) {
    const mon = new Date(thisMon);
    mon.setDate(thisMon.getDate() - i * 7);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    weekPeriods.push(`${fmtDate(mon)}~${fmtDate(sun)}`);
  }

  return { dealYmdList, monthPeriods, weekPeriods, currentYM, currentWeekMon };
}

// ════════════════════════════════════════════════
//  XML 파싱 (의존성 없는 정규식 기반)
// ════════════════════════════════════════════════

/**
 * XML 응답에서 resultCode를 검사하고, 성공(0)이 아니면 에러를 던진다.
 * 성공 코드는 API에 따라 '00' 또는 '000' 으로 오므로 숫자 0으로 판정한다.
 * resultCode 22 (일일 한도 초과)는 별도 플래그를 포함한다.
 *
 * @param {string} xml
 * @throws {Error}  resultCode 가 0이 아닐 때
 */
function checkResultCode(xml) {
  const codeMatch = xml.match(/<resultCode>\s*(\d+)\s*<\/resultCode>/);
  if (!codeMatch) return; // 코드 없으면 통과 (본문 파싱에서 처리)
  if (parseInt(codeMatch[1], 10) === 0) return; // '00', '000' 모두 성공

  const msgMatch = xml.match(/<resultMsg>\s*([\s\S]*?)\s*<\/resultMsg>/);
  const msg = msgMatch ? msgMatch[1].trim() : '알 수 없는 오류';
  const err = new Error(`API 오류 (resultCode ${codeMatch[1]}): ${msg}`);
  err.resultCode = codeMatch[1];

  // resultCode 22 = 일일 한도 초과 — 즉시 중단 신호
  if (parseInt(codeMatch[1], 10) === 22) {
    err.message = '일일 한도 초과 — 내일 재실행(캐시로 이어서 진행됨)';
    err.isQuotaExceeded = true;
  }

  throw err;
}

/**
 * XML 응답에서 totalCount를 읽는다.
 * @param {string} xml
 * @returns {number}
 */
export function parseTotalCount(xml) {
  const m = xml.match(/<totalCount>\s*(\d+)\s*<\/totalCount>/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * XML 응답에서 <item> 블록을 추출하고 계약 날짜를 파싱한다.
 * resultCode 검사를 포함한다.
 *
 * @param {string} xml
 * @returns {{ year: number, month: number, day: number|null }[]}
 */
export function parseItems(xml) {
  checkResultCode(xml);

  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let itemMatch;
  while ((itemMatch = itemRe.exec(xml)) !== null) {
    const block = itemMatch[1];
    // data.go.kr 상세(Dev) 엔드포인트는 영문 태그(dealYear/dealMonth/dealDay),
    // 구형 엔드포인트는 한글 태그(년/월/일) — 둘 다 지원
    const yearMatch  = block.match(/<dealYear>\s*(\d+)\s*<\/dealYear>/)   || block.match(/<년>\s*(\d+)\s*<\/년>/);
    const monthMatch = block.match(/<dealMonth>\s*(\d+)\s*<\/dealMonth>/) || block.match(/<월>\s*(\d+)\s*<\/월>/);
    const dayMatch   = block.match(/<dealDay>\s*(\d+)\s*<\/dealDay>/)     || block.match(/<일>\s*(\d+)\s*<\/일>/);
    if (!yearMatch || !monthMatch) continue;
    items.push({
      year:  parseInt(yearMatch[1],  10),
      month: parseInt(monthMatch[1], 10),
      day:   dayMatch ? parseInt(dayMatch[1], 10) : null,
    });
  }
  return items;
}

// ════════════════════════════════════════════════
//  로컬 캐시 (LAWD_CD + DEAL_YMD + propertyType)
//  캐시 항목: { totalCount, items: [{year,month,day|null},...] }
// ════════════════════════════════════════════════

function cacheKey(lawdCd, dealYmd, propType) {
  return `${lawdCd}_${dealYmd}_${propType}`;
}

function cachePath(lawdCd, dealYmd, propType) {
  return join(CACHE_DIR, `${cacheKey(lawdCd, dealYmd, propType)}.json`);
}

function cacheLoad(lawdCd, dealYmd, propType) {
  const p = cachePath(lawdCd, dealYmd, propType);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function cacheSave(lawdCd, dealYmd, propType, data) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(lawdCd, dealYmd, propType), JSON.stringify(data), 'utf8');
}

// ════════════════════════════════════════════════
//  집계 (순수 함수 — 단위 테스트 가능)
// ════════════════════════════════════════════════

/**
 * 파싱된 item 목록을 monthPeriods / weekPeriods 기준으로 집계한다.
 *
 * @param {{ year: number, month: number, day: number|null }[]} items
 * @param {string[]} monthPeriods   "YYYY-MM" 배열 (오래된순 12개)
 * @param {string[]} weekPeriods    "YYYY-MM-DD~YYYY-MM-DD" 배열 (오래된순 12개)
 * @returns {{
 *   monthly: number[],  // monthPeriods 순서의 건수 배열
 *   weekly:  number[],  // weekPeriods 순서의 건수 배열
 * }}
 */
export function aggregateItems(items, monthPeriods, weekPeriods) {
  const monthMap = {};
  for (const p of monthPeriods) monthMap[p] = 0;

  const weekRanges = weekPeriods.map(p => {
    const [monStr, sunStr] = p.split('~');
    return { key: p, monStr, sunStr };
  });
  const weekCount = Object.fromEntries(weekPeriods.map(k => [k, 0]));

  for (const item of items) {
    const { year, month, day } = item;
    const ymKey = `${year}-${String(month).padStart(2, '0')}`;

    if (ymKey in monthMap) {
      monthMap[ymKey]++;
    }

    if (day !== null) {
      const itemDateStr =
        `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      for (const { key, monStr, sunStr } of weekRanges) {
        if (itemDateStr >= monStr && itemDateStr <= sunStr) {
          weekCount[key]++;
          break;
        }
      }
    }
  }

  return {
    monthly: monthPeriods.map(p => monthMap[p]),
    weekly:  weekPeriods.map(p => weekCount[p]),
  };
}

// ════════════════════════════════════════════════
//  정규화 JSON 생성
// ════════════════════════════════════════════════

/**
 * 수집된 구별 원시 아이템을 정규화 구조로 조립한다.
 *
 * @param {Object} rawByDistrict  { districtName: { apt: items[], rh: items[], sh: items[] } }
 * @param {string[]} monthPeriods
 * @param {string[]} weekPeriods
 * @param {string}   generatedAt  "YYYY-MM-DD"
 * @returns {Object}  정규화 JSON
 */
export function buildNormalized(rawByDistrict, monthPeriods, weekPeriods, generatedAt) {
  const byDistrict = {};

  for (const [name, raw] of Object.entries(rawByDistrict)) {
    const aptAgg  = aggregateItems(raw.apt,  monthPeriods, weekPeriods);
    const rhAgg   = aggregateItems(raw.rh,   monthPeriods, weekPeriods);
    const shAgg   = aggregateItems(raw.sh,   monthPeriods, weekPeriods);
    // 오피스텔: raw.offi 가 없으면 0으로 처리 (offi 엔드포인트 주석 처리 시)
    const offiItems = raw.offi ?? [];
    const offiAgg = aggregateItems(offiItems, monthPeriods, weekPeriods);

    byDistrict[name] = {
      month: monthPeriods.map((_, i) => ({
        apt:    aptAgg.monthly[i],
        nonApt: rhAgg.monthly[i] + shAgg.monthly[i] + offiAgg.monthly[i],
      })),
      week: weekPeriods.map((_, i) => ({
        apt:    aptAgg.weekly[i],
        nonApt: rhAgg.weekly[i] + shAgg.weekly[i] + offiAgg.weekly[i],
      })),
    };
  }

  return {
    generatedAt,
    source: 'rtms',
    periods: { week: weekPeriods, month: monthPeriods },
    byDistrict,
  };
}

// ════════════════════════════════════════════════
//  dashboard.html 주입
// ════════════════════════════════════════════════

function inject(normalized) {
  const htmlPath = join(__dirname, 'dashboard.html');
  const jsonPath = join(__dirname, 'data.json');

  const html = readFileSync(htmlPath, 'utf8');
  const jsonStr = JSON.stringify(normalized, null, 2);

  const slotRe = /(<script\s+type="application\/json"\s+id="real-data">)([\s\S]*?)(<\/script>)/;

  // 슬롯 부재 = 진짜 오류. (내용 유무와 무관하게 슬롯 존재 여부로 판정 — 재실행 멱등)
  if (!slotRe.test(html)) {
    throw new Error('#real-data 슬롯을 찾지 못했습니다. dashboard.html을 확인하세요.');
  }

  const newHtml = html.replace(slotRe, `$1${jsonStr}$3`);
  writeFileSync(jsonPath, jsonStr, 'utf8');

  // 데이터 무변경(동일 스냅샷) = 정상 no-op. HTML 갱신 생략.
  if (newHtml === html) {
    console.log('[ingest] 데이터 변경 없음 — dashboard.html 갱신 생략 (data.json만 저장)');
    return;
  }

  writeFileSync(htmlPath, newHtml, 'utf8');
  console.log(`[ingest] dashboard.html 주입 완료 (generatedAt: ${normalized.generatedAt})`);
  console.log(`[ingest] data.json 저장 완료`);
}

// ════════════════════════════════════════════════
//  네트워크 유틸리티
// ════════════════════════════════════════════════

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 단일 페이지 요청 (resultCode 검사 포함, 재시도 없음).
 * @returns {{ xml: string, items: array, totalCount: number }}
 */
async function fetchOnePage(serviceKey, endpoint, lawdCd, dealYmd, pageNo) {
  const url = new URL(endpoint);
  url.searchParams.set('serviceKey', serviceKey);
  url.searchParams.set('LAWD_CD',    lawdCd);
  url.searchParams.set('DEAL_YMD',   dealYmd);
  url.searchParams.set('pageNo',     String(pageNo));
  url.searchParams.set('numOfRows',  String(PAGE_SIZE));

  const res = await fetch(url.toString());
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    err.httpStatus = res.status;
    throw err;
  }
  const xml = await res.text();

  // resultCode 검사 — 22(한도초과) 포함 non-00 전부 checkResultCode에서 처리
  checkResultCode(xml);

  const items      = parseItems(xml);
  const totalCount = parseTotalCount(xml);
  return { xml, items, totalCount };
}

/**
 * 단일 콤보(LAWD_CD + DEAL_YMD + propType)에 대해
 * 전체 페이지를 수집하고 totalCount를 검증한다.
 *
 * @param {string} serviceKey
 * @param {string} endpoint
 * @param {string} lawdCd
 * @param {string} dealYmd
 * @param {string} propType   'apt' | 'rh' | 'sh'
 * @param {boolean} useCache
 * @param {Object}  stats     { calls, hits, failures }
 * @returns {{ items: array, totalCount: number } | null}  null = 실패(계속 진행)
 */
async function fetchCombo(serviceKey, endpoint, lawdCd, dealYmd, propType, useCache, stats) {
  // 캐시 확인
  if (useCache) {
    const cached = cacheLoad(lawdCd, dealYmd, propType);
    if (cached !== null) {
      stats.hits++;
      stats.hitsByType[propType]++;
      return cached;
    }
  }

  // 지수 백오프 재시도
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      await sleep(DELAY_MS);
      stats.calls++;
      stats.callsByType[propType]++;

      const allItems = [];
      let pageNo = 1;
      let totalCount = 0;

      while (true) {
        const { items, totalCount: tc } = await fetchOnePage(
          serviceKey, endpoint, lawdCd, dealYmd, pageNo
        );
        if (pageNo === 1) totalCount = tc;
        allItems.push(...items);

        if (allItems.length >= totalCount || items.length < PAGE_SIZE) break;
        pageNo++;
        await sleep(DELAY_MS);
        stats.calls++;
        stats.callsByType[propType]++;
      }

      // totalCount vs 수집 건수 검증
      if (allItems.length !== totalCount) {
        console.warn(
          `  [경고] ${lawdCd}/${dealYmd}/${propType}: ` +
          `totalCount=${totalCount} 인데 수집=${allItems.length}건`
        );
        stats.failures.push({
          combo: `${lawdCd}/${dealYmd}/${propType}`,
          reason: `totalCount 불일치 (${totalCount} vs ${allItems.length})`
        });
        // 불일치라도 수집된 건 캐시에 저장 (부분 데이터 활용)
      }

      const result = { items: allItems, totalCount };
      cacheSave(lawdCd, dealYmd, propType, result);
      return result;

    } catch (err) {
      // 일일 한도 초과 — 즉시 재전파 (재시도 없음)
      if (err.isQuotaExceeded) throw err;

      lastErr = err;
      if (attempt < MAX_RETRY) {
        const waitMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        console.warn(`  [재시도 ${attempt}/${MAX_RETRY}] ${lawdCd}/${dealYmd}/${propType}: ${err.message} — ${waitMs}ms 후 재시도`);
        await sleep(waitMs);
      }
    }
  }

  // MAX_RETRY 모두 실패 → 목록에 기록하고 null 반환 (중단 없이 계속)
  stats.failures.push({
    combo: `${lawdCd}/${dealYmd}/${propType}`,
    reason: lastErr.message
  });
  console.error(`  [실패] ${lawdCd}/${dealYmd}/${propType}: ${lastErr.message}`);
  return null;
}

// ════════════════════════════════════════════════
//  월별 day-level 교차 검증
//  totalCount(API) === 해당 월 내 일자 있는 records 합계가 아니라,
//  item 목록 길이(월 전체 건수)와 totalCount를 비교한다.
//  주의: API는 DEAL_YMD(YYYYMM)별로 한 번에 호출하므로
//        월별 totalCount = 해당 월 item 수 = monthMap[YM] 와 비교 가능.
// ════════════════════════════════════════════════

/**
 * 각 구·유형별 월 단위 캐시 데이터로 교차 검증을 수행한다.
 * API는 DEAL_YMD=YYYYMM 으로 호출하므로,
 * 해당 월 totalCount = 수집된 items.length 여야 한다.
 * (위의 fetchCombo에서 이미 개별 경고를 내지만, 여기서 집계 요약을 출력한다.)
 *
 * @param {Object} crossCheckData  { districtName_propType_ym: { totalCount, collectedCount } }
 */
function printCrossCheck(crossCheckData) {
  const mismatches = Object.entries(crossCheckData).filter(
    ([, v]) => v.totalCount !== v.collectedCount
  );
  if (mismatches.length === 0) {
    console.log('[교차검증] 전체 콤보 totalCount === 수집건수 일치 ✓');
  } else {
    console.log(`[교차검증] 불일치 ${mismatches.length}건:`);
    for (const [key, v] of mismatches) {
      console.log(`  ${key}: totalCount=${v.totalCount}, 수집=${v.collectedCount}`);
    }
  }
}

// ════════════════════════════════════════════════
//  셀프테스트 모드 (--selftest)
//  네트워크 없이 인라인 픽스처로 파이프라인 검증
// ════════════════════════════════════════════════

const FIXTURE_XML_APT = `
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<response>
  <header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header>
  <body>
    <items>
      <!-- 강남구 아파트: 2026-06 3건, 2026-07(진행중) 1건 -->
      <item><년>2026</년><월>6</월><일>10</일></item>
      <item><년>2026</년><월>6</월><일>15</일></item>
      <item><년>2026</년><월>6</월><일>29</일></item>
      <item><년>2026</년><월>7</월><일>2</일></item>
      <!-- 2025-07 2건 -->
      <item><년>2025</년><월>7</월><일>5</일></item>
      <item><년>2025</년><월>7</월><일>20</일></item>
    </items>
    <totalCount>6</totalCount>
    <pageNo>1</pageNo>
    <numOfRows>1000</numOfRows>
  </body>
</response>
`;

// 라이브 data.go.kr 상세(Dev) 엔드포인트 포맷: resultCode 000 + 영문 태그
// (실 API가 쓰는 경로 — 파서의 주 경로 검증. 한글 픽스처는 폴백 경로 검증용으로 유지)
const FIXTURE_XML_APT_EN = `
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<response>
  <header><resultCode>000</resultCode><resultMsg>OK</resultMsg></header>
  <body>
    <items>
      <item><dealYear>2026</dealYear><dealMonth>6</dealMonth><dealDay>10</dealDay></item>
      <item><dealYear>2026</dealYear><dealMonth>6</dealMonth><dealDay>25</dealDay></item>
      <item><dealYear>2026</dealYear><dealMonth>6</dealMonth></item>
    </items>
    <totalCount>3</totalCount>
    <pageNo>1</pageNo>
    <numOfRows>1000</numOfRows>
  </body>
</response>
`;

const FIXTURE_XML_RH = `
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<response>
  <header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header>
  <body>
    <items>
      <!-- 강남구 연립: 2026-06 2건 -->
      <item><년>2026</년><월>6</월><일>5</일></item>
      <item><년>2026</년><월>6</월><일>22</일></item>
    </items>
    <totalCount>2</totalCount>
    <pageNo>1</pageNo>
    <numOfRows>1000</numOfRows>
  </body>
</response>
`;

const FIXTURE_XML_SH = `
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<response>
  <header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header>
  <body>
    <items>
      <!-- 강남구 단독: 2026-06 1건, 일자 없는 항목 1건 (월 집계에만 반영) -->
      <item><년>2026</년><월>6</월><일>18</일></item>
      <item><년>2026</년><월>6</월></item>
    </items>
    <totalCount>2</totalCount>
    <pageNo>1</pageNo>
    <numOfRows>1000</numOfRows>
  </body>
</response>
`;

// 종로구 픽스처
const FIXTURE_XML_APT_JONGNO = `
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<response>
  <header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header>
  <body>
    <items>
      <item><년>2026</년><월>6</월><일>3</일></item>
    </items>
    <totalCount>1</totalCount>
    <pageNo>1</pageNo>
    <numOfRows>1000</numOfRows>
  </body>
</response>
`;

const FIXTURE_XML_EMPTY = `
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<response>
  <header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header>
  <body>
    <items/>
    <totalCount>0</totalCount>
    <pageNo>1</pageNo>
    <numOfRows>1000</numOfRows>
  </body>
</response>
`;

// 페이지네이션 테스트 픽스처 (totalCount=3 인데 items가 2건 = 불일치 케이스)
const FIXTURE_XML_PAGINATION_PAGE1 = `
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<response>
  <header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header>
  <body>
    <items>
      <item><년>2026</년><월>5</월><일>1</일></item>
      <item><년>2026</년><월>5</월><일>2</일></item>
    </items>
    <totalCount>3</totalCount>
    <pageNo>1</pageNo>
    <numOfRows>2</numOfRows>
  </body>
</response>
`;

const FIXTURE_XML_PAGINATION_PAGE2 = `
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<response>
  <header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header>
  <body>
    <items>
      <item><년>2026</년><월>5</월><일>3</일></item>
    </items>
    <totalCount>3</totalCount>
    <pageNo>2</pageNo>
    <numOfRows>2</numOfRows>
  </body>
</response>
`;

// 오피스텔 픽스처 (강남구 — 2026-06 2건, 2025-07 1건)
const FIXTURE_XML_OFFI = `
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<response>
  <header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header>
  <body>
    <items>
      <item><년>2026</년><월>6</월><일>8</일></item>
      <item><년>2026</년><월>6</월><일>25</일></item>
      <item><년>2025</년><월>7</월><일>12</일></item>
    </items>
    <totalCount>3</totalCount>
    <pageNo>1</pageNo>
    <numOfRows>1000</numOfRows>
  </body>
</response>
`;

// 오피스텔 인증 오류 픽스처 (활용신청 미완료 시 — non-00 resultCode)
const FIXTURE_XML_OFFI_AUTH_ERR = `
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<response>
  <header>
    <resultCode>30</resultCode>
    <resultMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR.</resultMsg>
  </header>
</response>
`;

// 일일 한도 초과 픽스처 (resultCode 22)
const FIXTURE_XML_QUOTA = `
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<response>
  <header>
    <resultCode>22</resultCode>
    <resultMsg>LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR.</resultMsg>
  </header>
</response>
`;

function runSelfTest() {
  console.log('=== RTMS 파이프라인 셀프테스트 시작 ===\n');
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

  // ── 1. buildPeriods 검증 ────────────────────────
  console.log('[1] buildPeriods(2026-07-10) 검증');
  const runDate = new Date('2026-07-10'); // 금요일
  const periods = buildPeriods(runDate);

  assert('monthPeriods 길이 = 12', periods.monthPeriods.length === 12);
  assert('weekPeriods 길이 = 12',  periods.weekPeriods.length  === 12);
  assert('dealYmdList 길이 = 13',  periods.dealYmdList.length  === 13);
  assert('currentYM = 202607',     periods.currentYM === '202607');
  // 2026-07-10은 금요일(day=5) → 월요일은 2026-07-06
  assert('currentWeekMon = 2026-07-06', periods.currentWeekMon === '2026-07-06');
  assert('monthPeriods[11] = 2026-06',  periods.monthPeriods[11] === '2026-06');
  assert('monthPeriods[0] = 2025-07',   periods.monthPeriods[0]  === '2025-07');
  assert('weekPeriods[11] = 2026-06-29~2026-07-05',
    periods.weekPeriods[11] === '2026-06-29~2026-07-05');

  // ── 2. parseItems + parseTotalCount 검증 ────────
  console.log('\n[2] parseItems + parseTotalCount 검증');
  const aptItems = parseItems(FIXTURE_XML_APT);
  assert('아파트 픽스처 6건 파싱', aptItems.length === 6,
    `실제: ${aptItems.length}`);
  assert('첫 번째 item year=2026', aptItems[0].year === 2026);
  assert('첫 번째 item month=6',   aptItems[0].month === 6);
  assert('첫 번째 item day=10',    aptItems[0].day === 10);

  const shItems = parseItems(FIXTURE_XML_SH);
  assert('SH 픽스처 2건 파싱', shItems.length === 2);
  assert('일자 없는 항목 day=null', shItems[1].day === null);

  // 영문 태그(라이브 API 주 경로) 검증
  const enItems = parseItems(FIXTURE_XML_APT_EN);
  assert('영문 태그 3건 파싱', enItems.length === 3, `실제: ${enItems.length}`);
  assert('영문 item year=2026/month=6', enItems[0].year === 2026 && enItems[0].month === 6);
  assert('영문 item day=10', enItems[0].day === 10);
  assert('영문 dealDay 없는 항목 day=null', enItems[2].day === null);
  assert('영문 픽스처 totalCount=3', parseTotalCount(FIXTURE_XML_APT_EN) === 3);
  let en000ok = true;
  try { checkResultCode(FIXTURE_XML_APT_EN); } catch { en000ok = false; }
  assert('영문 픽스처 resultCode=000 통과', en000ok);

  // parseTotalCount 검증
  assert('parseTotalCount APT = 6',
    parseTotalCount(FIXTURE_XML_APT) === 6);
  assert('parseTotalCount RH = 2',
    parseTotalCount(FIXTURE_XML_RH) === 2);
  assert('parseTotalCount EMPTY = 0',
    parseTotalCount(FIXTURE_XML_EMPTY) === 0);

  // ── 3. aggregateItems 검증 ──────────────────────
  console.log('\n[3] aggregateItems 검증');

  const aptAgg = aggregateItems(aptItems, periods.monthPeriods, periods.weekPeriods);

  // 2026-06 아파트: 3건 (7월 진행중 1건 제외)
  assert('아파트 월별[2026-06] = 3',
    aptAgg.monthly[periods.monthPeriods.indexOf('2026-06')] === 3,
    `실제: ${aptAgg.monthly[periods.monthPeriods.indexOf('2026-06')]}`);

  // 2025-07 아파트: 2건
  assert('아파트 월별[2025-07] = 2',
    aptAgg.monthly[periods.monthPeriods.indexOf('2025-07')] === 2,
    `실제: ${aptAgg.monthly[periods.monthPeriods.indexOf('2025-07')]}`);

  assert('진행중 월(202607)은 monthPeriods에 없음',
    !periods.monthPeriods.includes('2026-07'));

  // 주별 집계: 2026-06-29~2026-07-05에 6월29일 + 7월2일 모두 포함 → 2건
  const lastWeekKey = periods.weekPeriods[11];
  assert('마지막 완료주 키 = 2026-06-29~2026-07-05',
    lastWeekKey === '2026-06-29~2026-07-05');
  assert('아파트 주별[마지막완료주] = 2 (06-29 + 07-02 모두 이 주에 속함)',
    aptAgg.weekly[11] === 2,
    `실제: ${aptAgg.weekly[11]}`);

  const shAgg = aggregateItems(shItems, periods.monthPeriods, periods.weekPeriods);
  assert('SH 월별[2026-06] = 2 (일자없는항목도 월 카운트)',
    shAgg.monthly[periods.monthPeriods.indexOf('2026-06')] === 2,
    `실제: ${shAgg.monthly[periods.monthPeriods.indexOf('2026-06')]}`);
  const weekIdx0618 = periods.weekPeriods.findIndex(p => p.startsWith('2026-06-15'));
  assert('SH 주별[2026-06-15주] = 1 (일자있는항목만)',
    weekIdx0618 >= 0 && shAgg.weekly[weekIdx0618] === 1,
    `weekIdx=${weekIdx0618}, 실제: ${weekIdx0618 >= 0 ? shAgg.weekly[weekIdx0618] : 'N/A'}`);

  // ── 4. buildNormalized 검증 (오피스텔 포함) ──────
  console.log('\n[4] buildNormalized 검증 (offi 포함)');

  const offiItems = parseItems(FIXTURE_XML_OFFI);
  assert('오피스텔 픽스처 3건 파싱', offiItems.length === 3, `실제: ${offiItems.length}`);

  const rawByDistrict = {
    강남구: {
      apt:  aptItems,
      rh:   parseItems(FIXTURE_XML_RH),
      sh:   shItems,
      offi: offiItems,
    },
    종로구: {
      apt:  parseItems(FIXTURE_XML_APT_JONGNO),
      rh:   parseItems(FIXTURE_XML_EMPTY),
      sh:   parseItems(FIXTURE_XML_EMPTY),
      offi: parseItems(FIXTURE_XML_EMPTY),
    },
  };

  const normalized = buildNormalized(
    rawByDistrict,
    periods.monthPeriods,
    periods.weekPeriods,
    '2026-07-10'
  );

  assert('generatedAt = 2026-07-10', normalized.generatedAt === '2026-07-10');
  assert('source = rtms',            normalized.source === 'rtms');
  assert('periods.month 길이 = 12',  normalized.periods.month.length === 12);
  assert('periods.week 길이 = 12',   normalized.periods.week.length === 12);
  assert('byDistrict.강남구 존재',   '강남구' in normalized.byDistrict);
  assert('강남구.month 길이 = 12',   normalized.byDistrict['강남구'].month.length === 12);
  assert('강남구.week 길이 = 12',    normalized.byDistrict['강남구'].week.length === 12);

  const jun26Idx   = normalized.periods.month.indexOf('2026-06');
  const gangnamJun = normalized.byDistrict['강남구'].month[jun26Idx];
  assert('강남구 2026-06 apt = 3',
    gangnamJun.apt === 3, `실제: ${gangnamJun.apt}`);
  // nonApt = rh(2) + sh(2) + offi(2) = 6
  assert('강남구 2026-06 nonApt = 6 (rh=2 + sh=2 + offi=2)',
    gangnamJun.nonApt === 6, `실제: ${gangnamJun.nonApt}`);

  // 2025-07: offi 1건 포함 → rh(0) + sh(0) + offi(1) = 1
  const jul25Idx   = normalized.periods.month.indexOf('2025-07');
  const gangnamJul = normalized.byDistrict['강남구'].month[jul25Idx];
  assert('강남구 2025-07 apt = 2',
    gangnamJul.apt === 2, `실제: ${gangnamJul.apt}`);
  assert('강남구 2025-07 nonApt = 1 (offi만)',
    gangnamJul.nonApt === 1, `실제: ${gangnamJul.nonApt}`);

  const jongnoJun = normalized.byDistrict['종로구'].month[jun26Idx];
  assert('종로구 2026-06 apt = 1',
    jongnoJun.apt === 1, `실제: ${jongnoJun.apt}`);
  assert('종로구 2026-06 nonApt = 0 (offi 없음)',
    jongnoJun.nonApt === 0, `실제: ${jongnoJun.nonApt}`);

  // ── 4b. offi 없을 때 fallback (raw.offi 미정의) ──
  console.log('\n[4b] offi 슬롯 없을 때 buildNormalized fallback 검증');
  const rawNoOffi = {
    강남구: { apt: aptItems, rh: parseItems(FIXTURE_XML_RH), sh: shItems },
  };
  const normalizedNoOffi = buildNormalized(
    rawNoOffi, periods.monthPeriods, periods.weekPeriods, '2026-07-10'
  );
  const gangnamJunNoOffi = normalizedNoOffi.byDistrict['강남구'].month[jun26Idx];
  assert('offi 없을 때 nonApt = 4 (rh=2 + sh=2 + offi=0)',
    gangnamJunNoOffi.nonApt === 4, `실제: ${gangnamJunNoOffi.nonApt}`);

  // ── 4c. offi 인증 오류는 non-fatal ───────────────
  console.log('\n[4c] 오피스텔 인증 오류 non-fatal 검증');
  let offiAuthErr = null;
  try { parseItems(FIXTURE_XML_OFFI_AUTH_ERR); } catch (e) { offiAuthErr = e; }
  assert('offi 인증오류 → 예외 발생', offiAuthErr !== null);
  assert('offi 인증오류 → isQuotaExceeded=false (non-fatal)',
    offiAuthErr?.isQuotaExceeded !== true);

  // ── 5. 에러 XML / resultCode 검증 ───────────────
  console.log('\n[5] resultCode 검증');

  const errorXml = `<response><header><resultCode>30</resultCode><resultMsg>SERVICE ERROR</resultMsg></header></response>`;
  let caughtGeneric = false;
  try { parseItems(errorXml); } catch (e) { caughtGeneric = true; }
  assert('resultCode=30 → 예외 발생', caughtGeneric);

  // 성공 코드는 '00'과 '000'(라이브 API) 둘 다 통과해야 한다 (회귀 방지)
  let ok00 = true, ok000 = true;
  try { checkResultCode('<header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header>'); } catch { ok00 = false; }
  try { checkResultCode('<header><resultCode>000</resultCode><resultMsg>OK</resultMsg></header>'); } catch { ok000 = false; }
  assert("resultCode='00' → 성공 통과", ok00);
  assert("resultCode='000' → 성공 통과", ok000);

  // resultCode 22 (일일 한도 초과)
  let quotaErr = null;
  try { checkResultCode(FIXTURE_XML_QUOTA); } catch (e) { quotaErr = e; }
  assert('resultCode=22 → 예외 발생', quotaErr !== null);
  assert('resultCode=22 → isQuotaExceeded=true', quotaErr?.isQuotaExceeded === true);

  // ── 6. totalCount 기반 집계 검증 ────────────────
  console.log('\n[6] totalCount 및 페이지네이션 검증');

  // parseTotalCount 재확인
  assert('APT totalCount=6 파싱', parseTotalCount(FIXTURE_XML_APT) === 6);
  assert('EMPTY totalCount=0 파싱', parseTotalCount(FIXTURE_XML_EMPTY) === 0);

  // 페이지네이션 시뮬레이션:
  // 페이지1에서 items=2, totalCount=3 → 페이지2 필요
  const page1Items     = parseItems(FIXTURE_XML_PAGINATION_PAGE1);
  const page1Total     = parseTotalCount(FIXTURE_XML_PAGINATION_PAGE1);
  const page2Items     = parseItems(FIXTURE_XML_PAGINATION_PAGE2);
  const allPagedItems  = [...page1Items, ...page2Items];

  assert('페이지1 items=2건 파싱', page1Items.length === 2);
  assert('페이지1 totalCount=3',   page1Total === 3);
  assert('페이지2 items=1건 파싱', page2Items.length === 1);
  assert('전체 수집 3건 = totalCount 일치',
    allPagedItems.length === page1Total,
    `수집=${allPagedItems.length}, totalCount=${page1Total}`);

  // 수집된 날짜 확인 (5월 1, 2, 3일)
  assert('페이지네이션 items 날짜 올바름',
    allPagedItems.every((it, i) => it.year === 2026 && it.month === 5 && it.day === i + 1));

  // ── 7. 캐시 로직 검증 (파일시스템 없이) ──────────
  console.log('\n[7] 캐시 키 / 경로 검증');

  const key  = cacheKey('11680', '202606', 'apt');
  const path = cachePath('11680', '202606', 'apt');
  assert('캐시 키 = 11680_202606_apt', key === '11680_202606_apt');
  assert('캐시 경로에 키 포함', path.includes('11680_202606_apt.json'));
  assert('캐시 경로에 .cache/ingest 포함', path.includes(join('.cache', 'ingest')));

  // 캐시 로드 (존재하지 않는 파일 → null)
  const missResult = cacheLoad('99999', '000000', 'apt');
  assert('존재하지 않는 캐시 → null', missResult === null);

  // ── 8. 교차검증 함수 검증 ───────────────────────
  console.log('\n[8] 월별 교차검증 출력 검증');

  // 불일치 없는 경우
  const crossOk = { '강남구_apt_202606': { totalCount: 3, collectedCount: 3 } };
  // 불일치 있는 경우
  const crossBad = {
    '강남구_apt_202606': { totalCount: 3, collectedCount: 3 },
    '종로구_rh_202606':  { totalCount: 5, collectedCount: 4 },
  };

  // printCrossCheck는 stdout 출력만 하므로 실행 자체가 오류 없으면 PASS
  let crossOkRan = false, crossBadRan = false;
  try { printCrossCheck(crossOk);  crossOkRan  = true; } catch {}
  try { printCrossCheck(crossBad); crossBadRan = true; } catch {}
  assert('교차검증 일치 케이스 오류 없음', crossOkRan);
  assert('교차검증 불일치 케이스 오류 없음', crossBadRan);

  // ── 결과 출력 ───────────────────────────────────
  console.log('\n=== 집계 샘플 ===');
  console.log('강남구 2026-06 (apt/nonApt):', gangnamJun, '← rh=2+sh=2+offi=2=6');
  console.log('강남구 2025-07 (apt/nonApt):', gangnamJul, '← offi=1');
  console.log('강남구 주간[마지막완료주]:', normalized.byDistrict['강남구'].week[11]);
  console.log('종로구 2026-06:', jongnoJun);
  console.log('페이지네이션 수집 3건:', allPagedItems.map(i => `${i.year}-${i.month}-${i.day}`));

  console.log(`\n${pass ? 'PASS' : `FAIL (${failures.length}건 실패: ${failures.join(', ')})`}`);
  process.exit(pass ? 0 : 1);
}

// ════════════════════════════════════════════════
//  실 데이터 수집 메인 플로우
// ════════════════════════════════════════════════

async function main() {
  const serviceKey = process.env.RTMS_SERVICE_KEY;
  if (!serviceKey) {
    console.error(
      '[오류] RTMS_SERVICE_KEY 환경 변수가 설정되지 않았습니다.\n' +
      '       docs/실데이터_연동_가이드.md 를 참고하여 공공데이터포털에서\n' +
      '       API 인증키를 발급받고 .env 파일에 설정하세요.\n' +
      '       예: RTMS_SERVICE_KEY=여기에인증키\n\n' +
      '       파이프라인 검증만 하려면:\n' +
      '       node ingest.mjs --selftest'
    );
    process.exit(1);
  }

  const useFresh = process.argv.includes('--fresh');
  const useCache = !useFresh;

  if (useFresh) {
    console.log('[ingest] --fresh 모드: 캐시를 무시하고 전체 재수집합니다.');
  } else {
    console.log('[ingest] 캐시 모드: 이미 수집된 콤보는 건너뜁니다.');
    console.log('[ingest] (재수집하려면 --fresh 플래그를 사용하세요.)');
  }

  const runDate = new Date();
  const { dealYmdList, monthPeriods, weekPeriods } = buildPeriods(runDate);
  const generatedAt = runDate.toISOString().slice(0, 10);

  const propTypes = Object.keys(ENDPOINTS);
  const totalExpected = DISTRICTS.length * dealYmdList.length * propTypes.length;
  console.log(`\n[ingest] 실행 날짜: ${generatedAt}`);
  console.log(`[ingest] 수집 기간: ${dealYmdList[0]} ~ ${dealYmdList[dealYmdList.length - 1]}`);
  console.log(`[ingest] 유형: ${propTypes.join(', ')} (${propTypes.length}종)`);
  console.log(`[ingest] 예상 요청 수(캐시 미스 시): 25구 × ${dealYmdList.length}개월 × ${propTypes.length}종 = ${totalExpected}건`);
  console.log(`[ingest] 일일 한도: 10,000건 — 여유 있음\n`);
  console.log('[ingest] ⚠️  오피스텔 API는 별도 활용신청 필요 — 미신청 시 해당 유형만 건너뜁니다\n');

  const stats = { calls: 0, hits: 0, failures: [], callsByType: {}, hitsByType: {} };
  for (const t of propTypes) { stats.callsByType[t] = 0; stats.hitsByType[t] = 0; }

  const rawByDistrict = {};
  const crossCheckData = {};

  try {
    for (const district of DISTRICTS) {
      console.log(`[ingest] ${district.name} (${district.code}) 수집 중...`);
      // 모든 propType 슬롯을 빈 배열로 초기화 (offi 포함)
      rawByDistrict[district.name] = Object.fromEntries(propTypes.map(t => [t, []]));

      for (const ym of dealYmdList) {
        for (const [propType, endpoint] of Object.entries(ENDPOINTS)) {
          // @MX:WARN: [AUTO] 일일 한도 초과 시 즉시 중단 — 재시도 없음
          // @MX:REASON: resultCode 22는 재시도해도 의미 없음. 캐시로 이어서 가능.
          const result = await fetchCombo(
            serviceKey, endpoint, district.code, ym, propType, useCache, stats
          );

          if (result === null) continue; // 실패 콤보, 건너뜀 (offi 인증오류 포함)

          rawByDistrict[district.name][propType].push(...result.items);

          // 교차검증 데이터 수집
          const crossKey = `${district.name}_${propType}_${ym}`;
          crossCheckData[crossKey] = {
            totalCount:     result.totalCount,
            collectedCount: result.items.length,
          };
        }
      }

      const d = rawByDistrict[district.name];
      const typeSummary = propTypes.map(t => `${t}: ${d[t].length}건`).join(', ');
      console.log(`  → ${typeSummary}`);
    }
  } catch (err) {
    if (err.isQuotaExceeded) {
      console.error(`\n[ingest] ${err.message}`);
      console.error('[ingest] 내일 node ingest.mjs 를 재실행하면 캐시로 이어서 진행됩니다.');
      process.exit(1);
    }
    throw err;
  }

  // 교차검증 출력
  console.log('\n[ingest] 교차검증 중...');
  printCrossCheck(crossCheckData);

  // 완료 요약
  console.log('\n[ingest] 수집 완료 요약');
  console.log(`  총 API 호출: ${stats.calls}건 (캐시 히트: ${stats.hits}건)`);
  // 유형별 실측 통계 (실 호출 · 캐시 히트 · 실패). 페이지네이션 추가 호출도 calls에 포함됨.
  let sumCalls = 0, sumHits = 0, sumFail = 0;
  for (const t of propTypes) {
    const calls  = stats.callsByType[t] ?? 0;
    const hits   = stats.hitsByType[t] ?? 0;
    const failed = stats.failures.filter(f => f.combo.endsWith(`/${t}`)).length;
    sumCalls += calls; sumHits += hits; sumFail += failed;
    console.log(`    ${t.padEnd(5)}: 호출 ${calls}건 · 캐시 ${hits}건 · 실패 ${failed}건`);
  }
  console.log(`    ${'합계'.padEnd(4)}: 호출 ${sumCalls}건 · 캐시 ${sumHits}건 · 실패 ${sumFail}건`);
  // 유형별 합 = 총합 일치 검증 (불일치 시 집계 지점 누락)
  if (sumCalls !== stats.calls || sumHits !== stats.hits || sumFail !== stats.failures.length) {
    console.warn(
      `  [경고] 유형별 통계 합 ≠ 총합 ` +
      `(호출 ${sumCalls}/${stats.calls}, 캐시 ${sumHits}/${stats.hits}, 실패 ${sumFail}/${stats.failures.length})`
    );
  }
  console.log(`  실패 콤보:   ${stats.failures.length}건`);
  if (stats.failures.length > 0) {
    for (const f of stats.failures) {
      console.log(`    ✗ ${f.combo}: ${f.reason}`);
    }
    console.log('\n  재실행 시 실패분만 다시 시도됨');
  }

  console.log('\n[ingest] 집계 중...');
  const normalized = buildNormalized(rawByDistrict, monthPeriods, weekPeriods, generatedAt);

  console.log('[ingest] dashboard.html 및 data.json 저장 중...');
  inject(normalized);

  console.log('[ingest] 완료!');

  // 실패가 있으면 exit code 1
  if (stats.failures.length > 0) {
    process.exit(1);
  }
}

// ════════════════════════════════════════════════
//  진입점
// ════════════════════════════════════════════════
if (process.argv.includes('--selftest')) {
  runSelfTest();
} else {
  main().catch(err => {
    console.error('[ingest] 오류:', err.message);
    process.exit(1);
  });
}
