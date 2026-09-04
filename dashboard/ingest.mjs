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

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import * as rebuildApi from './ingest-rebuild.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 이 파일이 `node ingest.mjs` 로 직접 실행됐는가.
 *
 * 2026-08-12 에 사고가 있었다 — 다른 스크립트가 집계 함수를 쓰려고 이 모듈을
 * import 했는데, 진입점 가드가 "--selftest 가 없으면 main()" 이라 **전량 수집이
 * 돌아 data.js 가 덮어써졌다.** import 는 수집을 실행시키면 안 된다.
 *
 * `import.meta.main` 은 Node 24+ 에서만 있다. 러너는 Node 22 라 그걸 쓰면
 * CI 에서 항상 false 가 되어 이번엔 반대로 수집이 영영 안 돈다. 그래서
 * argv[1] 과 이 모듈의 URL 을 직접 비교한다(심볼릭 링크는 realpath 로 푼다).
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
//  .env 자동 로드 (의존성 없음)
//  이미 설정된 환경 변수는 덮어쓰지 않음(인라인 우선)
// ════════════════════════════════════════════════
(() => {
  const envPath = join(__dirname, '..', '.env');  // 루트 .env (dashboard/ 하위 이동 후 상위 참조)
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
const DELAY_MS  = 200;   // (미사용) 순차 수집 시절의 요청 간 대기 — pace()가 대체
const PAGE_SIZE = 1000;  // numOfRows
const MAX_RETRY = 3;     // 지수 백오프 최대 재시도

// ── 요청 페이싱 ────────────────────────────────────
// 2026-08-12 실측: 제한 대상은 동시 연결 수가 아니라 "요청 간격"이다.
// 간격 없이 동시에 던지면 동시 4에서도 429가 나지만, 일정 간격으로 흘려보내면
// 30/s까지 실패 0건이었다(무거운 응답 150회 검증 포함). 한계는 30~40/s 사이.
// 20/s는 한계 대비 33% 여유를 둔 값 — 5,601회 기준 약 5분.
const REQ_PER_SEC     = 20;  // 초당 요청 시작 수 상한
const MAX_CONCURRENT  = 6;   // 동시 in-flight 요청 수 상한
const COMBO_WORKERS   = 6;   // 콤보 단위 병렬 워커 수
const CACHE_DIR = join(__dirname, '.cache', 'ingest');

// 캐시 스키마 버전 — 저장(cacheSave)과 유효성 판정(fetchCombo)이 함께 참조한다.
// 이 값을 올리면 이전 버전 캐시가 전량 무효화되어 자동 재수집된다.
//   v1: year/month/day 만
//   v2: + area / amount
//   v3: + 식별 필드(name, umdNm, jibun, floor, buildYear, aptSeq, houseType,
//        plottageAr, totalFloorAr) 및 왜곡 거래 식별 필드(cdealType, cdealDay,
//        dealingGbn, rgstDate) — parseItems 확장. 전부 캐시 계층 전용
const CACHE_SCHEMA_VERSION = 3;

// 공간 규격 버킷 경계 (전용면적 m²) — 원룸형 ≤40 / 투룸형 40<x≤60 / 쓰리룸+ >60
const AREA_BUCKETS = { studioMax: 40, twoMax: 60 };
// 금액대 버킷 경계 (거래금액 만원) — 3억↓ ≤30000 / 3~6억 30000<x≤60000 / 6억↑ >60000
const PRICE_BUCKETS = { under3Max: 30000, under6Max: 60000 };
// 월간 집계 시작 (YYYYMM) — 연도 탐색을 위해 2022-01부터 수집
const START_YM = '202201';

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
 * monthPeriods는 START_YM(2022-01)부터 직전 완료월까지 가변 길이 목록이다.
 * weekPeriods는 항상 완료된 최근 12주로 고정된다.
 * @param {Date} runDate
 * @returns {{
 *   dealYmdList: string[],       // 요청할 YYYYMM 목록 (START_YM~당월, monthPeriods.length+1개)
 *   monthPeriods: string[],      // START_YM 이후 완료된 모든 월 키 ["YYYY-MM", ...] 오래된순
 *   weekPeriods:  string[],      // 완료된 12주 키 ["YYYY-MM-DD~YYYY-MM-DD", ...] 오래된순
 *   currentYM:    string,        // 진행 중인 당월 "YYYYMM"
 *   currentWeekMon: string,      // 진행 중인 이번 주 월요일 "YYYY-MM-DD"
 * }}
 */
export function buildPeriods(runDate) {
  const year  = runDate.getFullYear();
  const month = runDate.getMonth(); // 0-based

  // ── 월 기간 ────────────────────────────────────
  // START_YM(2022-01)부터 직전 완료월까지 모든 월을 오래된순으로 수집
  const startYear  = parseInt(START_YM.slice(0, 4), 10);
  const startMonth = parseInt(START_YM.slice(4, 6), 10) - 1; // 0-based

  const monthPeriods = [];
  // cur = START_YM 부터 시작, 직전 완료월(month-1, 0-based)까지 순회
  let curYear  = startYear;
  let curMonth = startMonth; // 0-based
  // 직전 완료월: runDate의 month(0-based)가 0이면 전년 12월, 아니면 month-1
  const lastCompYear  = month === 0 ? year - 1 : year;
  const lastCompMonth = month === 0 ? 11 : month - 1; // 0-based
  while (
    curYear < lastCompYear ||
    (curYear === lastCompYear && curMonth <= lastCompMonth)
  ) {
    const y = String(curYear);
    const m = String(curMonth + 1).padStart(2, '0');
    monthPeriods.push(`${y}-${m}`);
    // 다음 달
    curMonth++;
    if (curMonth > 11) { curMonth = 0; curYear++; }
  }

  // 요청할 DEAL_YMD: START_YM 이후 완료월 전부 + 당월
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

  // 최근 2개월(직전 완료월 + 당월)은 신고 지연으로 계속 갱신되므로 캐시 무시 대상
  const recentYmds = dealYmdList.slice(-2);

  return { dealYmdList, monthPeriods, weekPeriods, currentYM, currentWeekMon, recentYmds };
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
 * <item> 블록에서 텍스트 태그 하나를 읽는다.
 * 값이 없거나 공백뿐이면 null. API는 미제공 필드를 공백 1칸으로 주는 경우가 있다
 * (예: <aptDong> </aptDong>, <cdealDay> </cdealDay>).
 *
 * @param {string} block  <item>…</item> 내부
 * @param {string} tag    태그명
 * @returns {string|null}
 */
function textTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  if (!m) return null;
  const v = m[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')   // amp는 마지막 — 이중 디코딩 방지
    .trim();
  return v === '' ? null : v;
}

/**
 * <item> 블록에서 수치 태그 하나를 읽는다. 파싱 실패 시 null.
 *
 * @param {string} block
 * @param {string} tag
 * @returns {number|null}
 */
function numTag(block, tag) {
  const v = textTag(block, tag);
  if (v === null) return null;
  const n = parseFloat(v.replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

/**
 * XML 응답에서 <item> 블록을 추출하고 계약 날짜, 전용면적, 거래금액에 더해
 * 개별 거래를 식별할 수 있는 필드(단지명·법정동·지번·층·건축년도 등)를 파싱한다.
 * resultCode 검사를 포함한다.
 *
 * ── 계층 경계 (schemaVersion 3) ────────────────────────────────
 * 여기서 반환하는 확장 필드는 대부분 **캐시 계층 전용**이다. 예외는 해제 짝 제거
 * (removeCancelledPairs, 2026-09-04) — `aggregateItems` 도 cdealType 과 짝 키 필드
 * (name/umdNm/jibun/floor)를 읽어 취소된 계약을 걷어낸 뒤 5개 필드로 집계한다.
 * 그 밖의 확장 필드를 화면에 노출하려면 buildNormalized 단계에서 별도 집계를 만들어야 한다.
 *
 * ── 유형별 제공 현황 (2026-08-12 API 실측) ──────────────────────
 *   name       apt=aptNm / rh=mhouseNm / offi=offiNm / sh=미제공(null)
 *   floor      apt·rh·offi 제공 / sh=미제공(null)
 *   area       apt·rh·offi 제공 / sh=미제공(plottageAr·totalFloorAr로 대체)
 *   jibun      sh는 마스킹된 값을 준다(예: "6**"). API 원문 그대로 보존한다.
 *   aptSeq     apt 전용 단지 고유키(예: "11680-3834"). 단지명 변경에 강하다.
 *   houseType  rh=연립/다세대, sh=단독/다가구. apt·offi 미제공.
 *   cdealType  4종 모두 제공. 값 'O'=계약해제(표본 3~19%), 그 외 공백.
 *   cdealDay   4종 모두 제공. cdealType과 세트.
 *   dealingGbn 4종 모두 제공, 100% 값 있음. '중개거래' | '직거래'.
 *   rgstDate   **apt·rh만 제공.** sh·offi는 태그 자체가 없어 항상 null.
 *              → 등기완료 필터를 sh·offi에 적용하면 전량이 걸러진다. 주의.
 * API가 주지 않는 값은 만들어내지 않고 null로 둔다.
 *
 * @param {string} xml
 * @returns {{
 *   year: number, month: number, day: number|null,
 *   area: number|null, amount: number|null,
 *   name: string|null, umdNm: string|null, jibun: string|null,
 *   floor: number|null, buildYear: number|null, aptSeq: string|null,
 *   houseType: string|null, plottageAr: number|null, totalFloorAr: number|null,
 *   cdealType: string|null, cdealDay: string|null,
 *   dealingGbn: string|null, rgstDate: string|null
 * }[]}
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

    // 전용면적 파싱: 영문 태그 <excluUseAr> 또는 한글 태그 <전용면적>
    const areaMatch = block.match(/<excluUseAr>\s*([\d.]+)\s*<\/excluUseAr>/) ||
                      block.match(/<전용면적>\s*([\d.]+)\s*<\/전용면적>/);
    const area = areaMatch ? parseFloat(areaMatch[1]) : null;

    // 거래금액 파싱: 영문 태그 <dealAmount> 또는 한글 태그 <거래금액>
    // 값에 쉼표와 공백이 포함될 수 있음 (예: "  82,500") — 제거 후 정수 변환
    const amountMatch = block.match(/<dealAmount>\s*([\d,\s]+)\s*<\/dealAmount>/) ||
                        block.match(/<거래금액>\s*([\d,\s]+)\s*<\/거래금액>/);
    const amount = amountMatch
      ? parseInt(amountMatch[1].replace(/[,\s]/g, ''), 10)
      : null;

    items.push({
      // ── 집계 계층이 읽는 5개 필드 (aggregateItems) ──
      year:   parseInt(yearMatch[1],  10),
      month:  parseInt(monthMatch[1], 10),
      day:    dayMatch ? parseInt(dayMatch[1], 10) : null,
      area:   (area !== null && !isNaN(area))     ? area   : null,
      amount: (amount !== null && !isNaN(amount)) ? amount : null,

      // ── 캐시 계층 전용 식별 필드 (집계·화면은 읽지 않는다) ──
      // 단지·건물명: 유형마다 태그가 다르다. sh(단독/다가구)는 셋 다 없어 null.
      name:         textTag(block, 'aptNm') || textTag(block, 'mhouseNm') || textTag(block, 'offiNm'),
      umdNm:        textTag(block, 'umdNm'),
      jibun:        textTag(block, 'jibun'),
      floor:        numTag(block, 'floor'),
      buildYear:    numTag(block, 'buildYear'),
      aptSeq:       textTag(block, 'aptSeq'),
      houseType:    textTag(block, 'houseType'),
      // sh 전용 면적 대체 필드 — excluUseAr이 없는 유형의 규모 지표
      plottageAr:   numTag(block, 'plottageAr'),
      totalFloorAr: numTag(block, 'totalFloorAr'),

      // ── 왜곡 거래 식별 필드 (리포트 집계에서 필터로 쓴다. 이번엔 보존만) ──
      // cdealType='O' = 계약해제. 해제된 거래도 응답에 그대로 남아 신고가를 왜곡한다.
      // 2020-02-21 이후 계약분부터 공개. cdealDay는 해제일(YY.MM.DD 문자열).
      cdealType:    textTag(block, 'cdealType'),
      cdealDay:     textTag(block, 'cdealDay'),
      // 직거래는 가족 간 거래 등 특수관계에서 시세와 동떨어질 수 있다.
      dealingGbn:   textTag(block, 'dealingGbn'),
      // 소유권이전등기 완료일. 비어 있으면 미확정 거래.
      // 주의: apt·rh만 제공한다. sh·offi는 태그 자체가 없어 항상 null (§API 실측).
      rgstDate:     textTag(block, 'rgstDate'),
    });
  }
  return items;
}

// ════════════════════════════════════════════════
//  로컬 캐시 (LAWD_CD + DEAL_YMD + propertyType)
//  캐시 항목: { schemaVersion, totalCount, items: [...] }
//  items 원소는 집계용 5개 필드(year,month,day,area,amount)에 더해
//  식별 필드(name,umdNm,jibun,floor,buildYear,aptSeq,houseType,
//  plottageAr,totalFloorAr)와 왜곡 거래 식별 필드(cdealType,cdealDay,
//  dealingGbn,rgstDate)를 함께 담는다 — parseItems 참조
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
  // schemaVersion 을 함께 저장해 구버전 캐시와 구분
  writeFileSync(
    cachePath(lawdCd, dealYmd, propType),
    JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, ...data }),
    'utf8'
  );
}

// ════════════════════════════════════════════════
//  집계 (순수 함수 — 단위 테스트 가능)
// ════════════════════════════════════════════════

/** 해제 짝 판별 키. 국토부 API 는 계약 ID 를 주지 않아 이 조합이 사실상의 계약 식별자다. */
function cancelPairKey(it) {
  return [
    it.name ?? '', it.umdNm ?? '', it.jibun ?? '',
    it.year, it.month, it.day, it.amount, it.area, it.floor,
  ].join('|');
}

/**
 * 해제 신고와 그 짝을 함께 걷어낸다 — 취소된 계약은 0건으로 센다.
 *
 * API 는 취소된 계약을 정상 행 + 해제 행(cdealType='O') **두 줄**로 준다
 * (2026-09-03 실측: 캐시 중복 그룹 17,571개 중 12,253개가 이 짝).
 * 해제 행만 빼면 취소된 계약이 여전히 1건으로 남으므로, 같은
 * (단지·법정동·지번·계약일·금액·면적·층) 키의 정상 행을 해제 행 수만큼 함께 뺀다.
 * 짝이 없는 해제 행(원래 행이 응답에 없는 경우)은 해제 행만 빠진다.
 * 본체 집계(aggregateItems)와 리포트(reportRows)가 이 함수 하나를 같이 쓴다.
 */
export function removeCancelledPairs(items) {
  const cancels = new Map();
  for (const it of items) {
    if (it.cdealType !== 'O') continue;
    const k = cancelPairKey(it);
    cancels.set(k, (cancels.get(k) ?? 0) + 1);
  }
  if (cancels.size === 0) return items;
  const out = [];
  for (const it of items) {
    if (it.cdealType === 'O') continue;
    const k = cancelPairKey(it);
    const left = cancels.get(k) ?? 0;
    if (left > 0) { cancels.set(k, left - 1); continue; }
    out.push(it);
  }
  return out;
}

/**
 * 파싱된 item 목록을 monthPeriods / weekPeriods 기준으로 집계한다.
 * 건수 외에 공간규격별(area) 및 금액대별(amount) 버킷 히스토그램도 반환한다.
 *
 * @param {{ year: number, month: number, day: number|null, area: number|null, amount: number|null }[]} items
 * @param {string[]} monthPeriods   "YYYY-MM" 배열 (오래된순 12개)
 * @param {string[]} weekPeriods    "YYYY-MM-DD~YYYY-MM-DD" 배열 (오래된순 12개)
 * @returns {{
 *   monthly: number[],
 *   weekly:  number[],
 *   monthlyArea:  { studio: number[], two: number[], three: number[] },
 *   weeklyArea:   { studio: number[], two: number[], three: number[] },
 *   monthlyPrice: { under3: number[], under6: number[], over6: number[] },
 *   weeklyPrice:  { under3: number[], under6: number[], over6: number[] },
 * }}
 */
export function aggregateItems(items, monthPeriods, weekPeriods) {
  const n = monthPeriods.length;
  const w = weekPeriods.length;

  // 건수 집계용
  const monthMap  = {};
  for (const p of monthPeriods) monthMap[p] = 0;

  const weekRanges = weekPeriods.map(p => {
    const [monStr, sunStr] = p.split('~');
    return { key: p, monStr, sunStr };
  });
  const weekCount = Object.fromEntries(weekPeriods.map(k => [k, 0]));

  // 면적 버킷 집계용 (인덱스는 monthPeriods / weekPeriods와 1:1 대응)
  const monthArea  = { studio: new Array(n).fill(0), two: new Array(n).fill(0), three: new Array(n).fill(0) };
  const weekArea   = { studio: new Array(w).fill(0), two: new Array(w).fill(0), three: new Array(w).fill(0) };

  // 금액 버킷 집계용
  const monthPrice = { under3: new Array(n).fill(0), under6: new Array(n).fill(0), over6: new Array(n).fill(0) };
  const weekPrice  = { under3: new Array(w).fill(0), under6: new Array(w).fill(0), over6: new Array(w).fill(0) };

  // 면적 버킷 결정 헬퍼 (null이면 null 반환 → 히스토그램 미반영)
  function areaBucket(area) {
    if (area === null) return null;
    if (area <= AREA_BUCKETS.studioMax) return 'studio';
    if (area <= AREA_BUCKETS.twoMax)    return 'two';
    return 'three';
  }

  // 금액 버킷 결정 헬퍼
  function priceBucket(amount) {
    if (amount === null) return null;
    if (amount <= PRICE_BUCKETS.under3Max) return 'under3';
    if (amount <= PRICE_BUCKETS.under6Max) return 'under6';
    return 'over6';
  }

  // 취소된 계약(해제 행 + 그 짝인 정상 행)을 집계 전에 걷어낸다 (2026-09-04 결정).
  // 이전에는 해제 거래도 그대로 포함했으나, 리포트와 기준이 갈라져 통일했다.
  // 직거래는 여기서도 리포트와 달리 **포함**한다 — 이번 결정의 범위 밖이다.
  items = removeCancelledPairs(items);

  for (const item of items) {
    // 짝 제거 이후의 집계는 이 5개 필드만 읽는다. 나머지 식별 필드는 캐시 계층 전용.
    const { year, month, day, area, amount } = item;
    const ymKey = `${year}-${String(month).padStart(2, '0')}`;

    // 월 인덱스
    const mIdx = monthPeriods.indexOf(ymKey);
    if (mIdx >= 0) {
      // 건수 (변경 없음)
      monthMap[ymKey]++;

      // 면적 버킷 (null이면 건너뜀)
      const ab = areaBucket(area);
      if (ab !== null) monthArea[ab][mIdx]++;

      // 금액 버킷 (null이면 건너뜀)
      const pb = priceBucket(amount);
      if (pb !== null) monthPrice[pb][mIdx]++;
    }

    if (day !== null) {
      const itemDateStr =
        `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      for (let wi = 0; wi < weekRanges.length; wi++) {
        const { key, monStr, sunStr } = weekRanges[wi];
        if (itemDateStr >= monStr && itemDateStr <= sunStr) {
          // 건수 (변경 없음)
          weekCount[key]++;

          // 면적 버킷
          const ab = areaBucket(area);
          if (ab !== null) weekArea[ab][wi]++;

          // 금액 버킷
          const pb = priceBucket(amount);
          if (pb !== null) weekPrice[pb][wi]++;

          break;
        }
      }
    }
  }

  return {
    monthly:      monthPeriods.map(p => monthMap[p]),
    weekly:       weekPeriods.map(p => weekCount[p]),
    monthlyArea:  monthArea,
    weeklyArea:   weekArea,
    monthlyPrice: monthPrice,
    weeklyPrice:  weekPrice,
  };
}

// ════════════════════════════════════════════════
//  정규화 JSON 생성
// ════════════════════════════════════════════════

/**
 * 수집된 구별 원시 아이템을 정규화 구조로 조립한다.
 *
 * @param {Object} rawByDistrict  { districtName: { apt: items[], rh: items[], sh: items[], offi?: items[] } }
 * @param {string[]} monthPeriods
 * @param {string[]} weekPeriods
 * @param {string}   generatedAt  "YYYY-MM-DD"
 * @returns {Object}  정규화 JSON (schemaVersion: 2)
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

    // 면적별 합산 헬퍼 (apt + rh + sh + offi 전체)
    // @MX:NOTE: [AUTO] room은 모든 유형(아파트 포함) 면적 합산, price는 비아파트(rh+sh+offi)만
    const sumArr = (arrs) => arrs[0].map((_, i) => arrs.reduce((s, a) => s + a[i], 0));

    byDistrict[name] = {
      month: monthPeriods.map((_, i) => ({
        apt:    aptAgg.monthly[i],
        nonApt: rhAgg.monthly[i] + shAgg.monthly[i] + offiAgg.monthly[i],
        // 공간규격별: apt + rh + sh + offi 전체 면적 버킷 합산
        room: {
          studio: aptAgg.monthlyArea.studio[i] + rhAgg.monthlyArea.studio[i] + shAgg.monthlyArea.studio[i] + offiAgg.monthlyArea.studio[i],
          two:    aptAgg.monthlyArea.two[i]    + rhAgg.monthlyArea.two[i]    + shAgg.monthlyArea.two[i]    + offiAgg.monthlyArea.two[i],
          three:  aptAgg.monthlyArea.three[i]  + rhAgg.monthlyArea.three[i]  + shAgg.monthlyArea.three[i]  + offiAgg.monthlyArea.three[i],
        },
        // 금액대별: 비아파트(rh + sh + offi)만 집계 — 레이블 "금액대별(비아파트)"
        price: {
          under3: rhAgg.monthlyPrice.under3[i] + shAgg.monthlyPrice.under3[i] + offiAgg.monthlyPrice.under3[i],
          under6: rhAgg.monthlyPrice.under6[i] + shAgg.monthlyPrice.under6[i] + offiAgg.monthlyPrice.under6[i],
          over6:  rhAgg.monthlyPrice.over6[i]  + shAgg.monthlyPrice.over6[i]  + offiAgg.monthlyPrice.over6[i],
        },
      })),
      week: weekPeriods.map((_, i) => ({
        apt:    aptAgg.weekly[i],
        nonApt: rhAgg.weekly[i] + shAgg.weekly[i] + offiAgg.weekly[i],
        room: {
          studio: aptAgg.weeklyArea.studio[i] + rhAgg.weeklyArea.studio[i] + shAgg.weeklyArea.studio[i] + offiAgg.weeklyArea.studio[i],
          two:    aptAgg.weeklyArea.two[i]    + rhAgg.weeklyArea.two[i]    + shAgg.weeklyArea.two[i]    + offiAgg.weeklyArea.two[i],
          three:  aptAgg.weeklyArea.three[i]  + rhAgg.weeklyArea.three[i]  + shAgg.weeklyArea.three[i]  + offiAgg.weeklyArea.three[i],
        },
        price: {
          under3: rhAgg.weeklyPrice.under3[i] + shAgg.weeklyPrice.under3[i] + offiAgg.weeklyPrice.under3[i],
          under6: rhAgg.weeklyPrice.under6[i] + shAgg.weeklyPrice.under6[i] + offiAgg.weeklyPrice.under6[i],
          over6:  rhAgg.weeklyPrice.over6[i]  + shAgg.weeklyPrice.over6[i]  + offiAgg.weeklyPrice.over6[i],
        },
      })),
    };
  }

  return {
    schemaVersion: 2,
    generatedAt,
    source: 'rtms',
    periods: { week: weekPeriods, month: monthPeriods },
    byDistrict,
  };
}

// ════════════════════════════════════════════════
//  시장 리포트 집계 — 블록 ①②③④
// ════════════════════════════════════════════════
//
// 화면이 그릴 결과만 미리 계산해 data.js 에 싣는다. 개별 거래 45만 건을 data.js 에
// 넣으면 66MB 가 되므로 원본은 캐시에만 둔다. 이 구간은 aggregateItems /
// buildNormalized 를 건드리지 않는다 — 기존 거래량 집계가 달라지면 안 되기 때문이다.
//
// ── 축이 둘이다 ──
//   기준선(baseline) : REPORT_BASELINE_FROM 이후 전체 누적. 신고가·신저가 판정용 이력
//   대상(target)     : 직전 수집 대비 새로 들어온 거래 = "최근 신고분". 화면에 나오는 행
// 국토부 API 는 신고일을 주지 않는다. 직전 캐시와 대조해 새로 들어온 것이 곧 신고분이다.

/**
 * 기준선 시작일. START_YM(수집 시작월)과 **의도적으로 분리**했다.
 * 예전에 START_YM 을 기준선으로 재사용하는 바람에 화면 각주에 "2022년 이후"가 찍히고
 * 실제 의도(2024-01)와 어긋났다. 상수를 나눠야 그 사고가 다시 안 난다.
 */
const REPORT_BASELINE_FROM = '20240101';

/**
 * 1985-04-11 이전 준공 아파트는 전용면적에 복도·계단·엘리베이터 등 공용면적이 포함된
 * 상태로 신고된다. 같은 84㎡라도 실제 전용은 더 좁아 이후 준공 단지와 같은 평형으로
 * 비교하면 안 된다. 데이터에 준공 "월"이 없어 연 단위로 자르므로 1985년 4~12월
 * 준공분도 함께 빠지지만 감수한다.
 */
const REPORT_MIN_BUILD_YEAR = 1986;

/** 각 목록에 표시할 줄 수 */
const REPORT_TOP_N = 10;

/** ② 거래 1위에서 층위별로 표시할 줄 수. 3단 × 5행이면 화면이 차고 순위 흐름이 보인다 */
const REPORT_RANK_N = 5;

/** 1평 = 3.3058㎡ */
const PYEONG_M2 = 3.3058;

const DISTRICT_BY_CODE = new Map(DISTRICTS.map(d => [d.code, d.name]));

// ── 신고분(델타) ────────────────────────────────
// fetchCombo 가 캐시를 덮어쓰기 **전에** 옛 내용과 대조해 여기에 채운다.
// 같은 (단지·계약일·금액·면적·층) 조합이 실제로 여러 건 있을 수 있어 개수까지 센다.
const reportDelta = new Map();

function deltaKey(district, propType, it) {
  return [
    district, propType, it.name ?? '', it.umdNm ?? '', it.jibun ?? '',
    it.year, it.month, it.day, it.amount, it.area, it.floor,
  ].join('|');
}

/** 새로 들어온 거래를 기록한다. old 가 없으면(첫 수집) 아무것도 기록하지 않는다. */
export function recordDelta(lawdCd, propType, oldItems, newItems) {
  if (!Array.isArray(oldItems)) return;
  const district = DISTRICT_BY_CODE.get(lawdCd) ?? lawdCd;
  const seen = new Map();
  for (const it of oldItems) {
    const k = deltaKey(district, propType, it);
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const it of newItems) {
    const k = deltaKey(district, propType, it);
    const left = seen.get(k) ?? 0;
    if (left > 0) seen.set(k, left - 1);
    else reportDelta.set(k, (reportDelta.get(k) ?? 0) + 1);
  }
}

// ── 공통 필터 ───────────────────────────────────
// 제외는 셋뿐이다. 등기(rgstDate)는 **기준선에도 걸지 않는다** — 과거의 더 비싼
// 미등기 거래가 기준선에서 빠지면 현재 거래가 거짓 신고가로 뜬다.
const REPORT_EXCLUDES = ['취소 신고 제외', '직거래 제외', `${REPORT_MIN_BUILD_YEAR}년 이전 준공 제외`];

function itemYmd(it) {
  return `${it.year}${String(it.month).padStart(2, '0')}${String(it.day).padStart(2, '0')}`;
}

/**
 * 평형 그룹 키 — 전용면적의 **정수부**.
 * 반올림하면 국평 84.0~84.99 가 84.5 에서 갈려 84.9㎡ 4만 건을 포함한 6만 건 이상이
 * "85㎡" 로 떨어져 나간다. 실측으로 확인했다. 정수부는 "전용 59/84/114" 표기와도 맞는다.
 */
function sizeKey(area) {
  return Math.floor(area);
}

/**
 * 리포트 대상 거래를 평평한 배열로 만든다.
 * @param {Object} rawByDistrict
 * @param {string[]} propTypes  읽을 유형. ③ 은 rh·offi 만 넘긴다(sh 는 건물명·면적이 전부 null)
 */
function reportRows(rawByDistrict, propTypes) {
  const rows = [];
  for (const [district, raw] of Object.entries(rawByDistrict)) {
    for (const propType of propTypes) {
      // 해제 짝 제거는 다른 필터보다 먼저 건다 — 해제 행과 정상 행의 dealingGbn 이
      // 다른 경우가 실측에 있어, 직거래 필터를 먼저 걸면 짝이 어긋난다.
      for (const it of removeCancelledPairs(raw[propType] ?? [])) {
        const area = Number(it.area);
        const amount = Number(it.amount);
        if (!Number.isFinite(area) || area <= 0 || !Number.isFinite(amount)) continue;
        if (String(it.dealingGbn ?? '').includes('직거래')) continue;
        if (!(Number(it.buildYear) >= REPORT_MIN_BUILD_YEAR)) continue;
        const ymd = itemYmd(it);
        if (ymd < REPORT_BASELINE_FROM) continue;
        rows.push({
          district, propType,
          name: it.name, umd: it.umdNm, jibun: it.jibun,
          area, amount, floor: it.floor, buildYear: it.buildYear,
          size: sizeKey(area), ymd,
          // 단지 식별 — aptSeq 는 apt 에만 있다. 없으면 이름+법정동으로 묶는다.
          seq: it.aptSeq ?? `${district}|${it.umdNm}|${it.name}`,
          // 법정동 식별 — 동 이름만 쓰면 다른 구의 같은 동이 합쳐진다.
          umdKey: `${district}|${it.umdNm}`,
          isNew: reportDelta.has(deltaKey(district, propType, it)),
        });
      }
    }
  }
  return rows;
}

/** 표시용 행 — data.js 에 싣는 최소 필드 */
function outRow(r, prev, gap) {
  return {
    name: r.name, umd: r.umd, district: r.district, size: r.size,
    area: r.area, floor: r.floor, amount: r.amount, date: r.ymd,
    prev, gap,
    // 상승률도 **화면에 찍는 두 금액**으로 계산한다. 원값으로 계산하면
    // 화면의 "11.1 → 13.8" 과 "+24.3%" 가 나눗셈으로 맞지 않는다(변동폭과 같은 이유).
    pct: Number(((eok1(r.amount) - eok1(prev)) / eok1(prev) * 100).toFixed(1)),
  };
}

/**
 * 화면에 찍히는 억 단위 값(소수 첫째 자리). 화면의 rptEok 와 같은 반올림이다.
 */
function eok1(manwon) {
  return Number((manwon / 10000).toFixed(1));
}

/**
 * 변동폭은 **원값의 차이가 아니라 화면에 찍는 두 값의 차이**다.
 * 원값끼리 빼고 반올림하면 "직전 11.1 → 이번 13.8, +2.8억" 처럼 화면 안에서
 * 산수가 맞지 않는 행이 나온다(11.05→11.1, 13.84→13.8 처럼 양끝이 각각 반올림되기 때문).
 * 읽는 사람은 원값을 볼 수 없으므로 화면 안에서 맞아야 한다.
 * 반환은 만원 단위 — 표시 코드가 그대로 억으로 환산한다.
 */
function shownGap(lo, hi) {
  return Math.round((eok1(hi) - eok1(lo)) * 10) * 1000;
}

/**
 * 신고가·신저가 — 대상(신고분)을 기준선(누적 이력)에 대본다.
 * 판정 단위는 같은 단지 + 같은 평형 그룹. 한 단지가 평형을 바꿔가며 목록을 채우지
 * 않도록 단지당 1건(변동폭 최대)만 남긴다.
 *
 * 기록을 갱신했더라도 **화면 표시상 변동폭이 0.0억이 되는 건은 목록에서 뺀다.**
 * "1.7 → 1.7, +0.0억" 은 읽는 사람에게 아무 정보가 아니고 오히려 오류로 읽힌다.
 */
function findRecords(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.seq}|${r.size}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const highs = [], lows = [];
  for (const g of groups.values()) {
    const targets = g.filter(r => r.isNew);
    if (!targets.length) continue;
    const history = g.filter(r => !r.isNew);
    if (!history.length) continue;              // 비교할 이력이 없으면 판정 불가
    const prevMax = Math.max(...history.map(r => r.amount));
    const prevMin = Math.min(...history.map(r => r.amount));
    const top = targets.reduce((m, r) => (r.amount > m.amount ? r : m));
    const bot = targets.reduce((m, r) => (r.amount < m.amount ? r : m));
    if (top.amount > prevMax) {
      const gap = shownGap(prevMax, top.amount);
      if (gap > 0) highs.push(outRow(top, prevMax, gap));
    }
    if (bot.amount < prevMin) {
      const gap = shownGap(bot.amount, prevMin);
      if (gap > 0) lows.push(outRow(bot, prevMin, gap));
    }
  }

  const pick = (list) => {
    const best = new Map();
    for (const x of list) {
      const k = `${x.district}|${x.umd}|${x.name}`;
      const cur = best.get(k);
      if (!cur || x.gap > cur.gap) best.set(k, x);
    }
    return [...best.values()].sort((a, b) => b.gap - a.gap);
  };
  return { highs: pick(highs), lows: pick(lows) };
}

/** ② 거래 1위 — 세기만 한다. 기준선 구간 전체가 대상이라 델타가 필요 없다. */
function rankCounts(rows) {
  const bump = (m, k, label) => {
    if (!m.has(k)) m.set(k, { label, n: 0 });
    m.get(k).n++;
  };
  const byGu = new Map(), byUmd = new Map(), bySeq = new Map();
  for (const r of rows) {
    bump(byGu,  r.district, r.district);
    bump(byUmd, r.umdKey,   `${r.umd}`);
    bump(bySeq, r.seq,      r.name);
  }
  const top = (m, extra) => [...m.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, REPORT_RANK_N)
    .map(([k, v]) => ({ label: v.label, count: v.n, ...(extra ? extra(k, v) : {}) }));

  const guOf = k => k.split('|')[0];
  return {
    district: top(byGu),
    umd:      top(byUmd, k => ({ sub: guOf(k) })),
    complex:  top(bySeq, (k, v) => {
      const r = rows.find(x => x.seq === k);
      return { sub: r ? `${r.district} ${r.umd}` : '' };
    }),
  };
}

/**
 * ⑤ 월별 거래량 추이 — 계약월별 건수를 유형 세 갈래로 센다.
 * 모집단은 ② 와 같은 기준선 구간이라 유형별 합계가 ③ 의 거래량과 정확히 맞는다.
 *
 * **마지막 달은 버린다.** 수집은 항상 진행 중인 당월을 포함하므로 마지막 버킷은
 * 언제나 부분값이다(실측: 2026-08 이 364건 — 다른 달의 8%). 그대로 그리면 폭락으로 읽힌다.
 *
 * **남은 마지막 두 달은 잠정으로 표시한다.** 재수집 범위가 최근 2개월이라 그 구간은
 * 아직 신고분이 차오르는 중이다. 표시가 없으면 미신고분이 거래 감소로 보인다.
 */
const REPORT_TREND_PROVISIONAL = 2;

function buildTrend(series) {
  const counts = {};
  const all = new Set();
  for (const [key, rows] of Object.entries(series)) {
    counts[key] = {};
    for (const r of rows) {
      const ym = `${r.ymd.slice(0, 4)}-${r.ymd.slice(4, 6)}`;
      counts[key][ym] = (counts[key][ym] ?? 0) + 1;
      all.add(ym);
    }
  }
  const months = [...all].sort();
  const dropped = months.pop() ?? null;   // 진행 중인 당월
  const out = { months, dropped, provisional: Math.min(REPORT_TREND_PROVISIONAL, months.length) };
  for (const key of Object.keys(series)) out[key] = months.map(m => counts[key][m] ?? 0);
  return out;
}

/** ④ 정비사업 — 캐시가 없으면 null. 없다고 실패시키지 않는다(월 1회 수동 수집). */
function buildRebuildBlock(rebuild) {
  if (!rebuild) return null;
  const { buildProjects, extractNewDesignations, extractCancellations } = rebuild.api;
  const projects = buildProjects(rebuild.rebuildRows, rebuild.announcementRows);
  const from = `${REPORT_BASELINE_FROM.slice(0, 4)}-${REPORT_BASELINE_FROM.slice(4, 6)}-${REPORT_BASELINE_FROM.slice(6)}`;
  // 구역명(rgnNm)만으로는 구분이 안 되는 경우가 있다 — 성수전략정비구역 1~4지구는
  // 이름이 같고 PRJC_CD·지번만 다르다. 소재지를 함께 실어야 읽는 사람이 구별한다.
  /**
   * 화면에 찍는 소재지 한 줄.
   * 자치구는 대개 지번(PSTN_NM) 앞에 이미 들어 있어("강북구 미아동 130번지 일대")
   * 따로 붙이면 "강북구 · 강북구 미아동 …" 으로 두 번 나온다. 들어 있지 않은 경우
   * ("봉래동1가 58-4번지 일원")에만 앞에 세운다.
   * 원본에 자치구가 없는 건(중화6구역 — PSTN_NM 에 구가 없고 LOGVM 이 "서울특별시")은
   * **지번만 그대로 둔다.** 동 이름으로 구를 유추하면 원본에 없는 값을 만드는 것이다.
   */
  const place = (district, addr) => {
    if (!addr) return district ?? null;
    return district && !addr.includes(district) ? `${district} ${addr}` : addr;
  };
  const shape = x => {
    const addr = x.rgnNm ? (x.pstnNm ?? null) : null;
    return {
      name: x.rgnNm || x.pstnNm || x.prjcCd,
      addr,
      district: x.district ?? null,
      place: place(x.district ?? null, addr),
      date: x.ancmntYmd,
    };
  };
  const inSpan = a => a.filter(x => x.ancmntYmd && x.ancmntYmd >= from);
  const news = inSpan(extractNewDesignations(projects));
  const cancels = inSpan(extractCancellations(projects));

  // 표시 행이 같은 값으로 겹치는 경우가 있다 — 성수전략정비구역 1~4지구는 PRJC_CD 만
  // 다르고 구역명·소재지·고시일이 모두 같아, 그대로 늘어놓으면 읽는 사람이 구별하지
  // 못한 채 목록 슬롯만 먹는다. 같은 값이면 묶고 몇 개 구역인지 적는다.
  const group = (list) => {
    const m = new Map();
    for (const x of list.map(shape)) {
      const k = [x.name, x.addr ?? '', x.district ?? '', x.date ?? ''].join('|');
      if (m.has(k)) m.get(k).zones++;
      else m.set(k, { ...x, zones: 1 });
    }
    return [...m.values()].slice(0, REPORT_TOP_N);
  };

  return {
    projects: projects.size,
    counts: { news: news.length, cancels: cancels.length },
    news:    group(news),
    cancels: group(cancels),
  };
}

/**
 * 각주는 손으로 쓰지 않는다. 집계에 실제로 쓴 상수에서 만든다.
 * 상수를 바꾸면 각주가 따라 바뀌므로 코드와 문구가 어긋날 수 없다.
 */
export function buildReportMeta(deltaCount) {
  const f = REPORT_BASELINE_FROM;
  return {
    baselineFrom: f,
    baselineLabel: `${f.slice(0, 4)}년 ${Number(f.slice(4, 6))}월 이후 누적`,
    target: '최근 신고분',
    targetNote: '직전 수집 대비 새로 들어온 거래. 국토부는 신고일을 제공하지 않아 캐시 대조로 구한다',
    targetCount: deltaCount,
    excludes: REPORT_EXCLUDES,
    compareUnit: '같은 단지 · 같은 평형(전용면적 정수부)',
    sortBy: '변동폭 큰 순',
    topN: REPORT_TOP_N,
    rankN: REPORT_RANK_N,
    provisional: true,
    gapZero: '표시상 변동폭이 0.0억인 건 제외',
    pctNote: '상승률은 표시된 두 금액으로 계산',
    trendNote: '계약월 기준 · 진행 중인 당월 제외 · 최근 2개월은 신고 지연으로 아직 차오르는 중(잠정)',
    // 출처는 블록마다 다르다. ①②③ 은 실거래, ④ 는 정비사업 고시다.
    // 둘을 한 문자열로 묶으면 네 장 모두에 해당 없는 출처가 하나씩 붙는다.
    sourceTrade: '국토교통부 RTMS 실거래가',
    sourceZone: '서울 열린데이터광장 정비사업 현황',
    lagNote: '신고 기한은 계약 후 30일이지만 그보다 늦게 들어오는 거래도 있다',
    deltaLimit: '재수집 범위가 최근 2개월이라 신고 지연이 그보다 긴 거래는 잡히지 않는다',
  };
}

/**
 * 정비사업 캐시를 읽는다. 없으면 null — ④ 블록만 비고 나머지는 정상 동작한다.
 * 이 캐시는 gitignored 이고 수집 워크플로가 아직 없다(월 1회 수동 실행).
 */
export function loadRebuildCache() {
  const dir = join(__dirname, '.cache', 'rebuild');
  if (!existsSync(dir)) return null;
  try {
    const rebuildRows = [], announcementRows = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const rows = JSON.parse(readFileSync(join(dir, f), 'utf8')).rows ?? [];
      (f.startsWith('upisAnnouncement') ? announcementRows : rebuildRows).push(...rows);
    }
    if (!rebuildRows.length) return null;
    return { api: rebuildApi, rebuildRows, announcementRows };
  } catch (err) {
    console.warn(`  [경고] 정비사업 캐시를 읽지 못했다 — ④ 건너뜀: ${err.message}`);
    return null;
  }
}

/**
 * @param {Object} rawByDistrict
 * @param {Object|null} rebuild  { api, rebuildRows, announcementRows } 또는 null
 */
export function buildReport(rawByDistrict, rebuild) {
  const aptRows = reportRows(rawByDistrict, ['apt']);
  const rhRows  = reportRows(rawByDistrict, ['rh']);
  const offiRows = reportRows(rawByDistrict, ['offi']);

  const apt = findRecords(aptRows);
  const rh  = findRecords(rhRows);
  const offi = findRecords(offiRows);

  const newCount = a => a.filter(r => r.isNew).length;
  const meta = buildReportMeta(newCount(aptRows) + newCount(rhRows) + newCount(offiRows));

  return {
    meta,
    // ① 아파트 신고가·신저가
    apt: {
      target: newCount(aptRows),
      baseline: aptRows.length,
      counts: { high: apt.highs.length, low: apt.lows.length },
      highs: apt.highs.slice(0, REPORT_TOP_N),
      lows:  apt.lows.slice(0, REPORT_TOP_N),
    },
    // ② 거래 1위 — 기준선 구간 누적 건수
    rank: { baseline: aptRows.length, ...rankCounts(aptRows) },
    // ③ 비아파트 — 연립다세대 + 오피스텔. 단독·다가구(sh)는 건물명·면적이 없어 제외
    nonApt: {
      rh: {
        label: '연립·다세대', volume: rhRows.length, target: newCount(rhRows),
        counts: { high: rh.highs.length, low: rh.lows.length },
        highs: rh.highs.slice(0, 5), lows: rh.lows.slice(0, 5),
      },
      offi: {
        label: '오피스텔', volume: offiRows.length, target: newCount(offiRows),
        counts: { high: offi.highs.length, low: offi.lows.length },
        highs: offi.highs.slice(0, 5), lows: offi.lows.slice(0, 5),
      },
    },
    // ④ 정비사업
    rebuild: buildRebuildBlock(rebuild),
    // ⑤ 월별 거래량 추이 — ② 와 같은 모집단
    trend: buildTrend({ apt: aptRows, rh: rhRows, offi: offiRows }),
  };
}

// ════════════════════════════════════════════════
//  dashboard.html 주입
// ════════════════════════════════════════════════

function inject(normalized) {
  const htmlPath = join(__dirname, 'dashboard.html');
  const jsonPath = join(__dirname, 'data.json');
  const jsPath   = join(__dirname, 'data.js');

  const jsonStr = JSON.stringify(normalized, null, 2);

  // data.js — 화면이 읽는 파일. file:// 에서도 로드되도록 fetch가 아닌 script 태그 방식.
  const jsStr =
    '// 자동 생성 파일 — 직접 수정하지 마세요. dashboard/ingest.mjs 의 inject()가 씁니다.\n' +
    `// 생성: ${normalized.generatedAt}\n` +
    `window.__DASHBOARD_DATA__ = ${jsonStr};\n`;

  // 캐시 버스팅 버전 — data.js 내용의 sha256 앞 8자.
  // 수집일(generatedAt)이 아니라 내용 해시를 쓰는 이유: 같은 날 재수집·수동 재실행·
  // 실패 후 재시도로 하루에 여러 번 데이터가 바뀐다(2026-08-12에 실제로 3회).
  // 날짜 기반이면 그 경우 버전이 그대로라 브라우저가 낡은 data.js를 계속 쓴다.
  // 내용이 같으면 해시도 같으므로 멱등성은 오히려 더 정확해진다.
  const version = createHash('sha256').update(jsStr).digest('hex').slice(0, 8);

  // dashboard.html 은 데이터를 담지 않지만(2026-08-12 데이터 분리) 버전 쿼리는 여기 박힌다.
  // 화면이 data.js 를 로드하지 않는 상태로 어긋나면 수집이 조용히 무의미해지므로,
  // 참조 존재 여부를 먼저 검사한다. 실패 = 진짜 오류.
  const html = readFileSync(htmlPath, 'utf8');
  const srcRe = /(<script\s+src="data\.js)(\?v=[^"]*)?(")/;
  if (!srcRe.test(html)) {
    throw new Error(
      'dashboard.html 에서 <script src="data.js"> 참조를 찾지 못했습니다.\n' +
      '       화면이 데이터를 로드하지 못하는 상태입니다. dashboard.html을 확인하세요.'
    );
  }

  // data.json — 동일 내용의 표준 JSON. 리포트 계산·SQLite 전환 등 다른 프로그램용 중간 재료.
  writeFileSync(jsonPath, jsonStr, 'utf8');

  // ── data.js ──
  // 데이터 무변경(동일 스냅샷) = 정상 no-op.
  const prevJs = existsSync(jsPath) ? readFileSync(jsPath, 'utf8') : null;
  if (prevJs === jsStr) {
    console.log('[ingest] 데이터 변경 없음 — data.js 갱신 생략 (data.json만 저장)');
  } else {
    writeFileSync(jsPath, jsStr, 'utf8');
    console.log(`[ingest] data.js 저장 완료 (generatedAt: ${normalized.generatedAt}, v=${version})`);
    console.log(`[ingest] data.json 저장 완료`);
  }

  // ── dashboard.html 의 버전 쿼리 ──
  // 항상 "있어야 할 값"으로 맞춘다(자기 치유). 이미 같으면 파일을 건드리지 않는다.
  const newHtml = html.replace(srcRe, `$1?v=${version}$3`);
  if (newHtml === html) {
    console.log('[ingest] data.js 버전 동일 — dashboard.html 갱신 생략');
    return;
  }
  writeFileSync(htmlPath, newHtml, 'utf8');
  console.log(`[ingest] dashboard.html 버전 갱신 완료 (data.js?v=${version})`);
}

// ════════════════════════════════════════════════
//  네트워크 유틸리티
// ════════════════════════════════════════════════

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 요청 페이서 — 모든 HTTP 요청이 여기를 통과한다.
 * 두 가지를 동시에 강제한다:
 *   1) 요청 시작 간격이 최소 1000/REQ_PER_SEC ms  (429 회피의 핵심)
 *   2) 동시 in-flight 요청이 MAX_CONCURRENT 이하  (안전망)
 * 페이지네이션 추가 요청과 재시도도 전부 이 게이트를 지난다.
 */
const pacer = (() => {
  const minGap = 1000 / REQ_PER_SEC;
  let nextSlot = 0;   // 다음 요청을 시작해도 되는 시각(ms)
  let inFlight = 0;
  const waiters = [];

  function release() {
    inFlight--;
    const next = waiters.shift();
    if (next) { inFlight++; next(); }
  }

  async function acquire() {
    // (1) 간격 확보 — 슬롯을 선점해 동시 호출끼리도 겹치지 않게 한다
    const now = Date.now();
    const start = Math.max(now, nextSlot);
    nextSlot = start + minGap;
    const wait = start - now;
    if (wait > 0) await sleep(wait);

    // (2) 동시 수 상한
    if (inFlight >= MAX_CONCURRENT) {
      await new Promise(resolve => waiters.push(resolve));
    } else {
      inFlight++;
    }
  }

  return { acquire, release, inFlightNow: () => inFlight };
})();

/** 페이서를 통과시켜 fn을 실행한다. */
async function paced(fn) {
  await pacer.acquire();
  try { return await fn(); } finally { pacer.release(); }
}

/**
 * 작업 목록을 워커 n개로 병렬 처리한다. 결과는 입력 순서를 유지한다.
 * 개별 작업이 던지면 그대로 전파된다(일일 한도 초과 즉시 중단 경로 보존).
 */
async function runPool(items, workers, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const worker = async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, worker));
  return out;
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
  // 캐시 확인: 현재 스키마 버전과 일치할 때만 유효한 캐시로 처리
  // 구버전 캐시(v1=날짜만, v2=area/amount까지)는 자동 무효화 → 재수집
  if (useCache) {
    const cached = cacheLoad(lawdCd, dealYmd, propType);
    if (cached !== null && cached.schemaVersion === CACHE_SCHEMA_VERSION) {
      stats.hits++;
      stats.hitsByType[propType]++;
      return cached;
    }
  }

  // 지수 백오프 재시도
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      // 요청 간격·동시 수는 pacer가 강제한다 (sleep(DELAY_MS) 대체)
      stats.calls++;
      stats.callsByType[propType]++;

      const allItems = [];
      let pageNo = 1;
      let totalCount = 0;

      while (true) {
        const { items, totalCount: tc } = await paced(() => fetchOnePage(
          serviceKey, endpoint, lawdCd, dealYmd, pageNo
        ));
        if (pageNo === 1) totalCount = tc;
        allItems.push(...items);

        if (allItems.length >= totalCount || items.length < PAGE_SIZE) break;
        pageNo++;
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

      // 캐시를 덮어쓰기 **전에** 옛 내용과 대조해 신규 유입(=신고분)을 기록한다.
      // 덮어쓴 뒤에는 무엇이 새로 들어왔는지 알 방법이 없다.
      const prev = cacheLoad(lawdCd, dealYmd, propType);
      if (prev && prev.schemaVersion === CACHE_SCHEMA_VERSION) {
        recordDelta(lawdCd, propType, prev.items, allItems);
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
      <!-- area: 35m²(studio), amount: 25000만원(under3) -->
      <item><년>2026</년><월>6</월><일>10</일><전용면적>35</전용면적><거래금액>25,000</거래금액></item>
      <!-- area: 50m²(two), amount: 45000만원(under6) -->
      <item><년>2026</년><월>6</월><일>15</일><전용면적>50</전용면적><거래금액>  45,000</거래금액></item>
      <!-- area: 80m²(three), amount: 82500만원(over6) -->
      <item><년>2026</년><월>6</월><일>29</일><전용면적>80</전용면적><거래금액>82,500</거래금액></item>
      <!-- area/amount 없음(null) — 건수엔 포함, 버킷엔 미반영 -->
      <item><년>2026</년><월>7</월><일>2</일></item>
      <!-- 2025-07 2건 -->
      <item><년>2025</년><월>7</월><일>5</일><전용면적>40</전용면적><거래금액>30,000</거래금액></item>
      <item><년>2025</년><월>7</월><일>20</일><전용면적>61</전용면적><거래금액>70,000</거래금액></item>
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
      <!-- 영문 태그 area/amount 검증 -->
      <item><dealYear>2026</dealYear><dealMonth>6</dealMonth><dealDay>10</dealDay><excluUseAr>35.5</excluUseAr><dealAmount>82,500</dealAmount></item>
      <item><dealYear>2026</dealYear><dealMonth>6</dealMonth><dealDay>25</dealDay><excluUseAr>55</excluUseAr><dealAmount>  45,000</dealAmount></item>
      <!-- area/amount 태그 없음 → null -->
      <item><dealYear>2026</dealYear><dealMonth>6</dealMonth></item>
    </items>
    <totalCount>3</totalCount>
    <pageNo>1</pageNo>
    <numOfRows>1000</numOfRows>
  </body>
</response>
`;

// 식별 필드(schemaVersion 3) 검증용 — 2026-08-12 라이브 API 응답 실측을 축약한 것.
// 4유형의 태그 구성 차이를 한 픽스처에 모았다: apt(aptNm/aptSeq/floor),
// rh(mhouseNm/houseType/landAr), sh(단지명·층·전용면적 없음 + 마스킹된 jibun +
// plottageAr/totalFloorAr), offi(offiNm). XML 이스케이프(&amp;) 항목도 포함.
// 왜곡 거래 필드도 실 API 동작을 재현한다: apt=해제(O)+직거래+등기공백,
// rh=등기완료, sh·offi=rgstDate 태그 자체 없음, offi=자기닫힘 <cdealType/>.
const FIXTURE_XML_IDENT = `
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<response>
  <header><resultCode>000</resultCode><resultMsg>OK</resultMsg></header>
  <body>
    <items>
      <item><aptDong>1단지 116</aptDong><aptNm>삼성동힐스테이트 1단지</aptNm><aptSeq>11680-3834</aptSeq><buildYear>2008</buildYear><cdealType>O</cdealType><cdealDay>26.07.24</cdealDay><dealingGbn>직거래</dealingGbn><rgstDate> </rgstDate><dealAmount>140,000</dealAmount><dealDay>19</dealDay><dealMonth>6</dealMonth><dealYear>2026</dealYear><excluUseAr>31.402</excluUseAr><floor>1</floor><jibun>16-2</jibun><sggCd>11680</sggCd><umdCd>10500</umdCd><umdNm>삼성동</umdNm></item>
      <item><buildYear>2026</buildYear><cdealType> </cdealType><cdealDay> </cdealDay><dealingGbn>중개거래</dealingGbn><rgstDate>26.05.08</rgstDate><dealAmount>77,000</dealAmount><dealDay>19</dealDay><dealMonth>6</dealMonth><dealYear>2026</dealYear><excluUseAr>32.657</excluUseAr><floor>2</floor><houseType>연립</houseType><jibun>1165-4</jibun><landAr>20.541</landAr><mhouseNm>개포라온채</mhouseNm><umdNm>개포동</umdNm></item>
      <item><buildYear>1991</buildYear><dealingGbn>중개거래</dealingGbn><dealAmount>560,000</dealAmount><dealDay>22</dealDay><dealMonth>6</dealMonth><dealYear>2026</dealYear><houseType>다가구</houseType><jibun>6**</jibun><plottageAr>189.7</plottageAr><totalFloorAr>367.22</totalFloorAr><umdNm>역삼동</umdNm></item>
      <item><buildYear>1991</buildYear><cdealType/><dealingGbn>직거래</dealingGbn><dealAmount>64,300</dealAmount><dealDay>16</dealDay><dealMonth>6</dealMonth><dealYear>2026</dealYear><excluUseAr>72.96</excluUseAr><floor>10</floor><jibun>702-13</jibun><offiNm>702-13(성지하이츠)</offiNm><sggNm>강남구</sggNm><umdNm>역삼동</umdNm></item>
      <item><aptNm>래미안A&amp;B</aptNm><aptDong> </aptDong><buildYear>2015</buildYear><dealAmount>90,000</dealAmount><dealDay>3</dealDay><dealMonth>6</dealMonth><dealYear>2026</dealYear><excluUseAr>84.9</excluUseAr><floor>7</floor><jibun> </jibun><umdNm>대치동</umdNm></item>
    </items>
    <totalCount>5</totalCount>
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
      <!-- 강남구 연립: 2026-06 2건 (area/amount 포함) -->
      <!-- area: 38m²(studio), amount: 20000만원(under3) -->
      <item><년>2026</년><월>6</월><일>5</일><전용면적>38</전용면적><거래금액>20,000</거래금액></item>
      <!-- area: 45m²(two), amount: 35000만원(under6) -->
      <item><년>2026</년><월>6</월><일>22</일><전용면적>45</전용면적><거래금액>35,000</거래금액></item>
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
      <!-- 강남구 단독: 2026-06 1건(area/amount 있음), 일자 없는 항목 1건 (월 집계에만 반영) -->
      <!-- area: 70m²(three), amount: 65000만원(over6) -->
      <item><년>2026</년><월>6</월><일>18</일><전용면적>70</전용면적><거래금액>65,000</거래금액></item>
      <!-- area/amount 없음(null), 일자도 없음 — 월 건수만 반영 -->
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
      <!-- area: 30m²(studio), amount: 15000만원(under3) -->
      <item><년>2026</년><월>6</월><일>8</일><전용면적>30</전용면적><거래금액>15,000</거래금액></item>
      <!-- area: 55m²(two), amount: 50000만원(under6) -->
      <item><년>2026</년><월>6</월><일>25</일><전용면적>55</전용면적><거래금액>50,000</거래금액></item>
      <!-- area: 65m²(three), amount: 75000만원(over6) -->
      <item><년>2025</년><월>7</월><일>12</일><전용면적>65</전용면적><거래금액>75,000</거래금액></item>
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

  // runDate=2026-07-10: START_YM=2022-01 → 마지막 완료월=2026-06
  // monthPeriods = 2022-01 ~ 2026-06 = 54개월
  // (2026-2022)*12 + (6-1+1) = 48+6 = 54
  // dealYmdList  = 54 + 1(당월) = 55개
  const EXPECTED_MONTH_LEN = 54; // 2022-01 ~ 2026-06 포함 54개월
  assert(`monthPeriods 길이 = ${EXPECTED_MONTH_LEN} (2022-01~2026-06)`,
    periods.monthPeriods.length === EXPECTED_MONTH_LEN,
    `실제: ${periods.monthPeriods.length}`);
  assert('weekPeriods 길이 = 12',  periods.weekPeriods.length  === 12);
  assert(`dealYmdList 길이 = ${EXPECTED_MONTH_LEN + 1}`,
    periods.dealYmdList.length === EXPECTED_MONTH_LEN + 1,
    `실제: ${periods.dealYmdList.length}`);
  assert('currentYM = 202607',     periods.currentYM === '202607');
  // 2026-07-10은 금요일(day=5) → 월요일은 2026-07-06
  assert('currentWeekMon = 2026-07-06', periods.currentWeekMon === '2026-07-06');
  assert(`monthPeriods[${EXPECTED_MONTH_LEN-1}] = 2026-06`,
    periods.monthPeriods[EXPECTED_MONTH_LEN - 1] === '2026-06',
    `실제: ${periods.monthPeriods[EXPECTED_MONTH_LEN - 1]}`);
  assert('monthPeriods[0] = 2022-01', periods.monthPeriods[0] === '2022-01',
    `실제: ${periods.monthPeriods[0]}`);
  assert('weekPeriods[11] = 2026-06-29~2026-07-05',
    periods.weekPeriods[11] === '2026-06-29~2026-07-05');
  // 최근 2개월(신고 지연 → 캐시 무시 대상) = 직전월 + 당월
  assert('recentYmds 길이 = 2', periods.recentYmds.length === 2);
  assert('recentYmds = [202606, 202607]',
    periods.recentYmds[0] === '202606' && periods.recentYmds[1] === '202607');

  // ── 2. parseItems + parseTotalCount 검증 ────────
  console.log('\n[2] parseItems + parseTotalCount 검증');
  const aptItems = parseItems(FIXTURE_XML_APT);
  assert('아파트 픽스처 6건 파싱', aptItems.length === 6,
    `실제: ${aptItems.length}`);
  assert('첫 번째 item year=2026', aptItems[0].year === 2026);
  assert('첫 번째 item month=6',   aptItems[0].month === 6);
  assert('첫 번째 item day=10',    aptItems[0].day === 10);

  // 한글 태그 area/amount 파싱 검증
  assert('APT item[0] area=35 (한글 전용면적)', aptItems[0].area === 35,
    `실제: ${aptItems[0].area}`);
  assert('APT item[0] amount=25000 (콤마 제거)', aptItems[0].amount === 25000,
    `실제: ${aptItems[0].amount}`);
  assert('APT item[1] area=50 (two 버킷)', aptItems[1].area === 50,
    `실제: ${aptItems[1].area}`);
  assert('APT item[2] amount=82500 (over6)', aptItems[2].amount === 82500,
    `실제: ${aptItems[2].amount}`);
  // area/amount 없는 항목은 null
  assert('APT item[3] area=null (태그 없음)', aptItems[3].area === null,
    `실제: ${aptItems[3].area}`);
  assert('APT item[3] amount=null (태그 없음)', aptItems[3].amount === null,
    `실제: ${aptItems[3].amount}`);
  // area 경계값: 40m² = studio(≤40)
  assert('APT item[4] area=40 → studio 경계', aptItems[4].area === 40,
    `실제: ${aptItems[4].area}`);

  const shItems = parseItems(FIXTURE_XML_SH);
  assert('SH 픽스처 2건 파싱', shItems.length === 2);
  assert('일자 없는 항목 day=null', shItems[1].day === null);
  assert('SH 일자없는 항목 area=null', shItems[1].area === null,
    `실제: ${shItems[1].area}`);

  // 영문 태그(라이브 API 주 경로) 검증
  const enItems = parseItems(FIXTURE_XML_APT_EN);
  assert('영문 태그 3건 파싱', enItems.length === 3, `실제: ${enItems.length}`);
  assert('영문 item year=2026/month=6', enItems[0].year === 2026 && enItems[0].month === 6);
  assert('영문 item day=10', enItems[0].day === 10);
  assert('영문 dealDay 없는 항목 day=null', enItems[2].day === null);
  assert('영문 픽스처 totalCount=3', parseTotalCount(FIXTURE_XML_APT_EN) === 3);
  // 영문 태그 excluUseAr / dealAmount 파싱 검증
  assert('영문 item[0] area=35.5 (excluUseAr)', enItems[0].area === 35.5,
    `실제: ${enItems[0].area}`);
  assert('영문 item[0] amount=82500 (dealAmount 콤마 제거)', enItems[0].amount === 82500,
    `실제: ${enItems[0].amount}`);
  assert('영문 item[1] area=55 (two 버킷)', enItems[1].area === 55,
    `실제: ${enItems[1].area}`);
  assert('영문 item[1] amount=45000 (공백 포함 파싱)', enItems[1].amount === 45000,
    `실제: ${enItems[1].amount}`);
  assert('영문 item[2] area=null (태그 없음)', enItems[2].area === null,
    `실제: ${enItems[2].area}`);
  assert('영문 item[2] amount=null (태그 없음)', enItems[2].amount === null,
    `실제: ${enItems[2].amount}`);
  let en000ok = true;
  try { checkResultCode(FIXTURE_XML_APT_EN); } catch { en000ok = false; }
  assert('영문 픽스처 resultCode=000 통과', en000ok);

  // ── 2-b. 식별 필드(schemaVersion 3) 파싱 검증 ────────
  console.log('\n[2-b] 식별 필드 파싱 검증 (캐시 계층 전용)');
  const idItems = parseItems(FIXTURE_XML_IDENT);
  assert('식별 픽스처 5건 파싱', idItems.length === 5, `실제: ${idItems.length}`);

  // apt — aptNm / aptSeq / floor / buildYear / jibun / umdNm
  assert('apt name=aptNm',        idItems[0].name === '삼성동힐스테이트 1단지', `실제: ${idItems[0].name}`);
  assert('apt aptSeq 보존',        idItems[0].aptSeq === '11680-3834', `실제: ${idItems[0].aptSeq}`);
  assert('apt umdNm=삼성동',       idItems[0].umdNm === '삼성동', `실제: ${idItems[0].umdNm}`);
  assert('apt jibun=16-2',        idItems[0].jibun === '16-2', `실제: ${idItems[0].jibun}`);
  assert('apt floor=1 (숫자)',     idItems[0].floor === 1, `실제: ${idItems[0].floor}`);
  assert('apt buildYear=2008',    idItems[0].buildYear === 2008, `실제: ${idItems[0].buildYear}`);
  assert('apt houseType=null',    idItems[0].houseType === null, `실제: ${idItems[0].houseType}`);

  // rh — mhouseNm이 name으로, houseType 보존
  assert('rh name=mhouseNm',      idItems[1].name === '개포라온채', `실제: ${idItems[1].name}`);
  assert('rh houseType=연립',      idItems[1].houseType === '연립', `실제: ${idItems[1].houseType}`);
  assert('rh aptSeq=null',        idItems[1].aptSeq === null, `실제: ${idItems[1].aptSeq}`);

  // sh — 단지명·층·전용면적 없음(만들어내지 않는다) + 마스킹 지번 원문 보존
  assert('sh name=null (API 미제공)',   idItems[2].name === null, `실제: ${idItems[2].name}`);
  assert('sh floor=null (API 미제공)',  idItems[2].floor === null, `실제: ${idItems[2].floor}`);
  assert('sh area=null (excluUseAr 없음)', idItems[2].area === null, `실제: ${idItems[2].area}`);
  assert('sh jibun 마스킹 원문 보존',    idItems[2].jibun === '6**', `실제: ${idItems[2].jibun}`);
  assert('sh plottageAr=189.7',        idItems[2].plottageAr === 189.7, `실제: ${idItems[2].plottageAr}`);
  assert('sh totalFloorAr=367.22',     idItems[2].totalFloorAr === 367.22, `실제: ${idItems[2].totalFloorAr}`);
  assert('sh houseType=다가구',         idItems[2].houseType === '다가구', `실제: ${idItems[2].houseType}`);

  // offi — offiNm이 name으로
  assert('offi name=offiNm', idItems[3].name === '702-13(성지하이츠)', `실제: ${idItems[3].name}`);
  assert('offi plottageAr=null', idItems[3].plottageAr === null, `실제: ${idItems[3].plottageAr}`);

  // XML 엔티티 디코딩 + 공백뿐인 태그는 null
  assert('&amp; 디코딩',        idItems[4].name === '래미안A&B', `실제: ${idItems[4].name}`);
  assert('공백뿐인 jibun=null', idItems[4].jibun === null, `실제: ${idItems[4].jibun}`);

  // 왜곡 거래 식별 필드 (리포트 집계용 — 이번엔 보존만)
  assert('apt cdealType=O (계약해제)',   idItems[0].cdealType === 'O', `실제: ${idItems[0].cdealType}`);
  assert('apt cdealDay=26.07.24',        idItems[0].cdealDay === '26.07.24', `실제: ${idItems[0].cdealDay}`);
  assert('apt dealingGbn=직거래',         idItems[0].dealingGbn === '직거래', `실제: ${idItems[0].dealingGbn}`);
  assert('apt rgstDate 공백→null',        idItems[0].rgstDate === null, `실제: ${idItems[0].rgstDate}`);
  assert('rh cdealType 공백→null',        idItems[1].cdealType === null, `실제: ${idItems[1].cdealType}`);
  assert('rh dealingGbn=중개거래',        idItems[1].dealingGbn === '중개거래', `실제: ${idItems[1].dealingGbn}`);
  assert('rh rgstDate=26.05.08 (등기완료)', idItems[1].rgstDate === '26.05.08', `실제: ${idItems[1].rgstDate}`);
  // sh·offi는 rgstDate 태그 자체가 없다 — 등기완료 필터를 걸면 전량 제외된다
  assert('sh rgstDate=null (태그 미제공)',   idItems[2].rgstDate === null, `실제: ${idItems[2].rgstDate}`);
  assert('offi rgstDate=null (태그 미제공)', idItems[3].rgstDate === null, `실제: ${idItems[3].rgstDate}`);
  assert('offi 자기닫힘 <cdealType/>→null',  idItems[3].cdealType === null, `실제: ${idItems[3].cdealType}`);
  assert('offi dealingGbn=직거래',           idItems[3].dealingGbn === '직거래', `실제: ${idItems[3].dealingGbn}`);

  // 해제 짝 제거(2026-09-04): 집계는 cdealType 과 짝 키 필드를 읽는다.
  // idItems[0] 은 해제 행인데 짝(같은 키의 정상 행)이 없다 → 해제 행만 빠진다.
  const identAgg = aggregateItems(idItems, ['2026-06'], []);
  assert('짝 없는 해제 행은 해제 행만 제외 (5건 중 1건 = 4)', identAgg.monthly[0] === 4,
    `실제: ${identAgg.monthly[0]}`);

  const pairBase = { year: 2026, month: 6, day: 10, area: 84.9, amount: 90000,
    name: '짝검증단지', umdNm: '짝동', jibun: '1-1', floor: 5 };
  const pairItems = [
    { ...pairBase, dealingGbn: '중개거래' },               // 취소된 계약의 정상 행 → 짝으로 제외
    { ...pairBase, cdealType: 'O', dealingGbn: '직거래' }, // 해제 행 — dealingGbn 이 달라도 짝이다
    { ...pairBase, floor: 6 },                             // 층이 다른 별개 거래 → 유지
  ];
  const pairLeft = removeCancelledPairs(pairItems);
  assert('해제 행 + 짝 정상 행 함께 제외, 별개 거래만 남음',
    pairLeft.length === 1 && pairLeft[0].floor === 6, `남은 행: ${pairLeft.length}`);
  const pairAgg = aggregateItems(pairItems, ['2026-06'], []);
  assert('aggregateItems 도 같은 짝 제거를 탄다 (3건 → 1건)', pairAgg.monthly[0] === 1,
    `실제: ${pairAgg.monthly[0]}`);

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

  // aggregateItems 면적/금액 버킷 어서션
  const jun26MIdx = periods.monthPeriods.indexOf('2026-06');
  const jul25MIdx = periods.monthPeriods.indexOf('2025-07');

  // 2026-06 아파트 면적 버킷: studio(35)=1, two(50)=1, three(80)=1
  assert('aptAgg monthlyArea 2026-06 studio=1', aptAgg.monthlyArea.studio[jun26MIdx] === 1,
    `실제: ${aptAgg.monthlyArea.studio[jun26MIdx]}`);
  assert('aptAgg monthlyArea 2026-06 two=1', aptAgg.monthlyArea.two[jun26MIdx] === 1,
    `실제: ${aptAgg.monthlyArea.two[jun26MIdx]}`);
  assert('aptAgg monthlyArea 2026-06 three=1', aptAgg.monthlyArea.three[jun26MIdx] === 1,
    `실제: ${aptAgg.monthlyArea.three[jun26MIdx]}`);

  // 2026-06 아파트 금액 버킷: under3(25000)=1, under6(45000)=1, over6(82500)=1
  assert('aptAgg monthlyPrice 2026-06 under3=1', aptAgg.monthlyPrice.under3[jun26MIdx] === 1,
    `실제: ${aptAgg.monthlyPrice.under3[jun26MIdx]}`);
  assert('aptAgg monthlyPrice 2026-06 under6=1', aptAgg.monthlyPrice.under6[jun26MIdx] === 1,
    `실제: ${aptAgg.monthlyPrice.under6[jun26MIdx]}`);
  assert('aptAgg monthlyPrice 2026-06 over6=1', aptAgg.monthlyPrice.over6[jun26MIdx] === 1,
    `실제: ${aptAgg.monthlyPrice.over6[jun26MIdx]}`);

  // 2025-07 아파트: area=40(studio, 경계값), area=61(three), amount=30000(under3 경계), amount=70000(over6)
  assert('aptAgg monthlyArea 2025-07 studio=1 (40m² 경계)', aptAgg.monthlyArea.studio[jul25MIdx] === 1,
    `실제: ${aptAgg.monthlyArea.studio[jul25MIdx]}`);
  assert('aptAgg monthlyArea 2025-07 three=1 (61m²)', aptAgg.monthlyArea.three[jul25MIdx] === 1,
    `실제: ${aptAgg.monthlyArea.three[jul25MIdx]}`);
  assert('aptAgg monthlyPrice 2025-07 under3=1 (30000만원 경계)', aptAgg.monthlyPrice.under3[jul25MIdx] === 1,
    `실제: ${aptAgg.monthlyPrice.under3[jul25MIdx]}`);
  assert('aptAgg monthlyPrice 2025-07 over6=1 (70000만원)', aptAgg.monthlyPrice.over6[jul25MIdx] === 1,
    `실제: ${aptAgg.monthlyPrice.over6[jul25MIdx]}`);

  // null area/amount 항목(2026-07-02 아파트)은 버킷에 미반영, 건수엔 반영되지 않음(진행중 월)
  // → 진행중 월이므로 monthlyArea에도 반영 안됨(monthPeriods에 없음)
  // 2026-06 studio+two+three 합이 건수 3보다 크지 않아야 함 (null 항목은 건수 제외)
  const totalBucketed = aptAgg.monthlyArea.studio[jun26MIdx] +
                        aptAgg.monthlyArea.two[jun26MIdx]    +
                        aptAgg.monthlyArea.three[jun26MIdx];
  assert('null area 항목은 버킷 합산에 미포함 (2026-06 버킷합=3 = 건수 3과 일치)',
    totalBucketed === 3, `버킷합: ${totalBucketed}`);

  const shAgg = aggregateItems(shItems, periods.monthPeriods, periods.weekPeriods);
  assert('SH 월별[2026-06] = 2 (일자없는항목도 월 카운트)',
    shAgg.monthly[periods.monthPeriods.indexOf('2026-06')] === 2,
    `실제: ${shAgg.monthly[periods.monthPeriods.indexOf('2026-06')]}`);
  const weekIdx0618 = periods.weekPeriods.findIndex(p => p.startsWith('2026-06-15'));
  assert('SH 주별[2026-06-15주] = 1 (일자있는항목만)',
    weekIdx0618 >= 0 && shAgg.weekly[weekIdx0618] === 1,
    `weekIdx=${weekIdx0618}, 실제: ${weekIdx0618 >= 0 ? shAgg.weekly[weekIdx0618] : 'N/A'}`);

  // SH 면적/금액 버킷: item[0] area=70(three), amount=65000(over6); item[1] area=null, amount=null
  assert('shAgg monthlyArea 2026-06 three=1 (70m²)', shAgg.monthlyArea.three[jun26MIdx] === 1,
    `실제: ${shAgg.monthlyArea.three[jun26MIdx]}`);
  assert('shAgg monthlyArea 2026-06 studio=0 (null 미반영)', shAgg.monthlyArea.studio[jun26MIdx] === 0,
    `실제: ${shAgg.monthlyArea.studio[jun26MIdx]}`);
  assert('shAgg monthlyPrice 2026-06 over6=1 (65000만원)', shAgg.monthlyPrice.over6[jun26MIdx] === 1,
    `실제: ${shAgg.monthlyPrice.over6[jun26MIdx]}`);

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

  assert('schemaVersion = 2', normalized.schemaVersion === 2,
    `실제: ${normalized.schemaVersion}`);
  assert('generatedAt = 2026-07-10', normalized.generatedAt === '2026-07-10');
  assert('source = rtms',            normalized.source === 'rtms');
  assert(`periods.month 길이 = ${EXPECTED_MONTH_LEN}`,
    normalized.periods.month.length === EXPECTED_MONTH_LEN,
    `실제: ${normalized.periods.month.length}`);
  assert('periods.week 길이 = 12',   normalized.periods.week.length === 12);
  assert('byDistrict.강남구 존재',   '강남구' in normalized.byDistrict);
  assert(`강남구.month 길이 = ${EXPECTED_MONTH_LEN}`,
    normalized.byDistrict['강남구'].month.length === EXPECTED_MONTH_LEN,
    `실제: ${normalized.byDistrict['강남구'].month.length}`);
  assert('강남구.week 길이 = 12',    normalized.byDistrict['강남구'].week.length === 12);

  const jun26Idx   = normalized.periods.month.indexOf('2026-06');
  const gangnamJun = normalized.byDistrict['강남구'].month[jun26Idx];
  assert('강남구 2026-06 apt = 3',
    gangnamJun.apt === 3, `실제: ${gangnamJun.apt}`);
  // nonApt = rh(2) + sh(2) + offi(2) = 6
  assert('강남구 2026-06 nonApt = 6 (rh=2 + sh=2 + offi=2)',
    gangnamJun.nonApt === 6, `실제: ${gangnamJun.nonApt}`);

  // room: apt+rh+sh+offi 전체 면적 합산 (2026-06)
  // apt: studio=1(35m²), two=1(50m²), three=1(80m²)
  // rh:  studio=1(38m²), two=1(45m²), three=0
  // sh:  studio=0, two=0, three=1(70m²)
  // offi:studio=1(30m²), two=1(55m²), three=0
  // room.studio = 1+1+0+1 = 3, room.two = 1+1+0+1 = 3, room.three = 1+0+1+0 = 2
  assert('강남구 2026-06 room.studio = 3 (apt+rh+sh+offi 합산)',
    gangnamJun.room.studio === 3, `실제: ${gangnamJun.room.studio}`);
  assert('강남구 2026-06 room.two = 3',
    gangnamJun.room.two === 3, `실제: ${gangnamJun.room.two}`);
  assert('강남구 2026-06 room.three = 2',
    gangnamJun.room.three === 2, `실제: ${gangnamJun.room.three}`);

  // price: 비아파트(rh+sh+offi)만 금액 합산 (2026-06)
  // rh:  under3=1(20000), under6=1(35000), over6=0
  // sh:  under3=0, under6=0, over6=1(65000)
  // offi:under3=1(15000), under6=1(50000), over6=0
  // price.under3 = 1+0+1 = 2, price.under6 = 1+0+1 = 2, price.over6 = 0+1+0 = 1
  assert('강남구 2026-06 price.under3 = 2 (비아파트만)',
    gangnamJun.price.under3 === 2, `실제: ${gangnamJun.price.under3}`);
  assert('강남구 2026-06 price.under6 = 2 (비아파트만)',
    gangnamJun.price.under6 === 2, `실제: ${gangnamJun.price.under6}`);
  assert('강남구 2026-06 price.over6 = 1 (비아파트만, sh)',
    gangnamJun.price.over6 === 1, `실제: ${gangnamJun.price.over6}`);

  // room/price 필드 존재 확인
  assert('month 엔트리에 room 필드 존재', gangnamJun.room !== undefined);
  assert('month 엔트리에 price 필드 존재', gangnamJun.price !== undefined);
  const gangnamJunWeek = normalized.byDistrict['강남구'].week[normalized.periods.week.indexOf('2026-06-29~2026-07-05')];
  assert('week 엔트리에 room 필드 존재', gangnamJunWeek !== undefined && gangnamJunWeek.room !== undefined);
  assert('week 엔트리에 price 필드 존재', gangnamJunWeek !== undefined && gangnamJunWeek.price !== undefined);

  // 2025-07: offi 1건 포함 → rh(0) + sh(0) + offi(1) = 1
  const jul25Idx   = normalized.periods.month.indexOf('2025-07');
  const gangnamJul = normalized.byDistrict['강남구'].month[jul25Idx];
  assert('강남구 2025-07 apt = 2',
    gangnamJul.apt === 2, `실제: ${gangnamJul.apt}`);
  assert('강남구 2025-07 nonApt = 1 (offi만)',
    gangnamJul.nonApt === 1, `실제: ${gangnamJul.nonApt}`);
  // 2025-07 room: apt(studio=1(40m²), three=1(61m²)) + offi(three=1(65m²))
  assert('강남구 2025-07 room.studio = 1 (apt 40m²)', gangnamJul.room.studio === 1,
    `실제: ${gangnamJul.room.studio}`);
  assert('강남구 2025-07 room.three = 2 (apt 61m² + offi 65m²)', gangnamJul.room.three === 2,
    `실제: ${gangnamJul.room.three}`);
  // 2025-07 price(비아파트만): offi(over6=1(75000))
  assert('강남구 2025-07 price.over6 = 1 (offi 75000만원)', gangnamJul.price.over6 === 1,
    `실제: ${gangnamJul.price.over6}`);
  assert('강남구 2025-07 price.under3 = 0 (비아파트 없음)', gangnamJul.price.under3 === 0,
    `실제: ${gangnamJul.price.under3}`);

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
  assert('offi 없을 때 schemaVersion = 2', normalizedNoOffi.schemaVersion === 2,
    `실제: ${normalizedNoOffi.schemaVersion}`);
  // offi 없을 때 room은 apt+rh+sh만 합산 (studio: apt=1, rh=1, sh=0 = 2)
  assert('offi 없을 때 room.studio = 2 (apt=1+rh=1)', gangnamJunNoOffi.room.studio === 2,
    `실제: ${gangnamJunNoOffi.room.studio}`);

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
  const { dealYmdList, monthPeriods, weekPeriods, recentYmds } = buildPeriods(runDate);
  const recentYmdSet = new Set(recentYmds);
  const generatedAt = runDate.toISOString().slice(0, 10);

  const propTypes = Object.keys(ENDPOINTS);
  const totalExpected = DISTRICTS.length * dealYmdList.length * propTypes.length;
  console.log(`\n[ingest] 실행 날짜: ${generatedAt}`);
  console.log(`[ingest] 수집 기간: ${dealYmdList[0]} ~ ${dealYmdList[dealYmdList.length - 1]}`);
  console.log(`[ingest] 유형: ${propTypes.join(', ')} (${propTypes.length}종)`);
  console.log(`[ingest] 예상 요청 수(캐시 미스 시): 25구 × ${dealYmdList.length}개월 × ${propTypes.length}종 = ${totalExpected}건`);
  console.log(`[ingest] 일일 한도: 10,000건 — 여유 있음\n`);
  console.log('[ingest] ⚠️  오피스텔 API는 별도 활용신청 필요 — 미신청 시 해당 유형만 건너뜁니다');
  if (useCache) {
    console.log(`[ingest] 최근 2개월(${recentYmds.join(', ')})은 신고 지연 반영을 위해 캐시 무시하고 재수집`);
  }
  console.log('');

  const stats = { calls: 0, hits: 0, failures: [], callsByType: {}, hitsByType: {} };
  for (const t of propTypes) { stats.callsByType[t] = 0; stats.hitsByType[t] = 0; }

  const rawByDistrict = {};
  const crossCheckData = {};

  // 모든 propType 슬롯을 빈 배열로 초기화 (offi 포함)
  for (const district of DISTRICTS) {
    rawByDistrict[district.name] = Object.fromEntries(propTypes.map(t => [t, []]));
  }

  // 콤보를 평탄한 작업 목록으로 펼쳐 워커 풀에 넘긴다.
  // 순서는 유지되지만(runPool) 실행은 병렬 — 요청 간격·동시 수는 pacer가 강제한다.
  const tasks = [];
  for (const district of DISTRICTS) {
    for (const ym of dealYmdList) {
      for (const [propType, endpoint] of Object.entries(ENDPOINTS)) {
        tasks.push({ district, ym, propType, endpoint });
      }
    }
  }

  const progressEvery = 500;
  let done = 0;
  const tStart = Date.now();

  try {
    const results = await runPool(tasks, COMBO_WORKERS, async (t) => {
      // @MX:WARN: [AUTO] 일일 한도 초과 시 즉시 중단 — 재시도 없음
      // @MX:REASON: resultCode 22는 재시도해도 의미 없음. 캐시로 이어서 가능.
      // 최근 2개월은 신고 지연 반영 위해 캐시 무시(재수집). cacheSave는 유지되어 스냅샷 갱신.
      const comboUseCache = useCache && !recentYmdSet.has(t.ym);
      const result = await fetchCombo(
        serviceKey, t.endpoint, t.district.code, t.ym, t.propType, comboUseCache, stats
      );
      if (++done % progressEvery === 0) {
        const el = (Date.now() - tStart) / 1000;
        const rate = stats.calls / el;
        console.log(
          `[ingest] 진행 ${done}/${tasks.length} (${(done / tasks.length * 100).toFixed(0)}%) · ` +
          `경과 ${el.toFixed(0)}s · 실호출 ${stats.calls}건 (${rate.toFixed(1)}/s) · 실패 ${stats.failures.length}건`
        );
      }
      return result;
    });

    // 결과 반영은 병렬 구간이 끝난 뒤 순서대로 — 배열 순서가 곧 콤보 순서다
    for (let i = 0; i < tasks.length; i++) {
      const result = results[i];
      if (result === null || result === undefined) continue; // 실패 콤보, 건너뜀 (offi 인증오류 포함)
      const { district, ym, propType } = tasks[i];

      rawByDistrict[district.name][propType].push(...result.items);

      // 교차검증 데이터 수집
      const crossKey = `${district.name}_${propType}_${ym}`;
      crossCheckData[crossKey] = {
        totalCount:     result.totalCount,
        collectedCount: result.items.length,
      };
    }

    for (const district of DISTRICTS) {
      const d = rawByDistrict[district.name];
      const typeSummary = propTypes.map(t => `${t}: ${d[t].length}건`).join(', ');
      console.log(`[ingest] ${district.name} (${district.code}) → ${typeSummary}`);
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

  // 리포트는 기존 집계와 분리해서 붙인다 — buildNormalized 의 반환값을
  // 바꾸지 않으므로 거래량 집계 구간은 그대로다.
  normalized.report = buildReport(rawByDistrict, loadRebuildCache());
  const rep = normalized.report;
  console.log(
    `[ingest] 리포트 집계 — 기준선 ${rep.meta.baselineLabel}, 신고분 ${rep.meta.targetCount}건\n` +
    `           ① 아파트 신고가 ${rep.apt.counts.high} / 신저가 ${rep.apt.counts.low}\n` +
    `           ③ 연립다세대 신고가 ${rep.nonApt.rh.counts.high} / 오피스텔 ${rep.nonApt.offi.counts.high}\n` +
    `           ④ 정비사업 ${rep.rebuild ? `신규 ${rep.rebuild.counts.news} / 해제 ${rep.rebuild.counts.cancels}` : '캐시 없음 — 건너뜀'}`
  );

  console.log('[ingest] data.js 및 data.json 저장 중...');
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
// import 로 들어온 경우에는 아무것도 실행하지 않는다. 위 isDirectRun 주석 참조.
if (isDirectRun) {
  if (process.argv.includes('--selftest')) {
    runSelfTest();
  } else {
    main().catch(err => {
      console.error('[ingest] 오류:', err.message);
      process.exit(1);
    });
  }
}
