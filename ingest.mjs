/**
 * ingest.mjs — 국토교통부 RTMS 실거래가 API → dashboard.html 주입
 *
 * 사용법:
 *   RTMS_SERVICE_KEY=<키> node ingest.mjs        # 실 데이터 수집
 *   node ingest.mjs --selftest                   # 로컬 픽스처로 파이프라인 검증
 *
 * 환경 변수:
 *   RTMS_SERVICE_KEY  공공데이터포털 API 인증키 (URL-encoded)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
// ════════════════════════════════════════════════
const ENDPOINTS = {
  apt: 'http://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev',
  rh:  'http://apis.data.go.kr/1613000/RTMSDataSvcRHTrade/getRTMSDataSvcRHTrade',
  sh:  'http://apis.data.go.kr/1613000/RTMSDataSvcSHTrade/getRTMSDataSvcSHTrade',
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
 * XML 응답에서 <item> 블록을 추출하고 계약 날짜를 파싱한다.
 * @param {string} xml
 * @returns {{ year: number, month: number, day: number|null }[]}
 */
export function parseItems(xml) {
  // 에러 응답 감지 (resultCode != 00)
  const codeMatch = xml.match(/<resultCode>\s*(\d+)\s*<\/resultCode>/);
  if (codeMatch && codeMatch[1] !== '00') {
    const msgMatch = xml.match(/<resultMsg>\s*([\s\S]*?)\s*<\/resultMsg>/);
    const msg = msgMatch ? msgMatch[1] : '알 수 없는 오류';
    throw new Error(`API 오류 (resultCode ${codeMatch[1]}): ${msg}`);
  }

  const items = [];
  // <item>...</item> 블록 분리
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let itemMatch;
  while ((itemMatch = itemRe.exec(xml)) !== null) {
    const block = itemMatch[1];
    const yearMatch  = block.match(/<년>\s*(\d+)\s*<\/년>/);
    const monthMatch = block.match(/<월>\s*(\d+)\s*<\/월>/);
    const dayMatch   = block.match(/<일>\s*(\d+)\s*<\/일>/);
    if (!yearMatch || !monthMatch) continue; // 날짜 없으면 건너뜀
    items.push({
      year:  parseInt(yearMatch[1],  10),
      month: parseInt(monthMatch[1], 10),
      day:   dayMatch ? parseInt(dayMatch[1], 10) : null,
    });
  }
  return items;
}

/**
 * totalCount를 XML에서 읽는다.
 * @param {string} xml
 * @returns {number}
 */
function parseTotalCount(xml) {
  const m = xml.match(/<totalCount>\s*(\d+)\s*<\/totalCount>/);
  return m ? parseInt(m[1], 10) : 0;
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
  // 월별 카운터
  const monthMap = {};
  for (const p of monthPeriods) monthMap[p] = 0;

  // 주별: 각 주의 [monDate, sunDate] 파싱
  const weekRanges = weekPeriods.map(p => {
    const [monStr, sunStr] = p.split('~');
    return { key: p, monStr, sunStr };
  });
  const weekCount = Object.fromEntries(weekPeriods.map(k => [k, 0]));

  for (const item of items) {
    const { year, month, day } = item;
    const ymKey = `${year}-${String(month).padStart(2, '0')}`;

    // 월 집계
    if (ymKey in monthMap) {
      monthMap[ymKey]++;
    }

    // 주 집계 (일자 없으면 주 버킷에는 포함하지 않음)
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
//  실 API 페치 (네트워크 필요)
// ════════════════════════════════════════════════

const DELAY_MS  = 120;  // 요청 간 대기 (ms)
const PAGE_SIZE = 1000; // numOfRows

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 단일 LAWD_CD + DEAL_YMD + 엔드포인트에 대해 전체 페이지를 수집한다.
 * @returns {{ year, month, day }[]}
 */
async function fetchAllPages(serviceKey, endpoint, lawdCd, dealYmd) {
  const items = [];
  let pageNo = 1;

  while (true) {
    const url = new URL(endpoint);
    url.searchParams.set('serviceKey', serviceKey);
    url.searchParams.set('LAWD_CD',    lawdCd);
    url.searchParams.set('DEAL_YMD',   dealYmd);
    url.searchParams.set('pageNo',     String(pageNo));
    url.searchParams.set('numOfRows',  String(PAGE_SIZE));

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
    }
    const xml = await res.text();
    const parsed = parseItems(xml);
    items.push(...parsed);

    if (parsed.length < PAGE_SIZE) break; // 마지막 페이지
    pageNo++;
  }

  return items;
}

// ════════════════════════════════════════════════
//  정규화 JSON 생성
// ════════════════════════════════════════════════

/**
 * 수집된 구별 원시 카운트를 정규화 구조로 조립한다.
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
    const aptAgg = aggregateItems(raw.apt, monthPeriods, weekPeriods);
    const rhAgg  = aggregateItems(raw.rh,  monthPeriods, weekPeriods);
    const shAgg  = aggregateItems(raw.sh,  monthPeriods, weekPeriods);

    byDistrict[name] = {
      month: monthPeriods.map((_, i) => ({
        apt:    aptAgg.monthly[i],
        nonApt: rhAgg.monthly[i] + shAgg.monthly[i],
      })),
      week: weekPeriods.map((_, i) => ({
        apt:    aptAgg.weekly[i],
        nonApt: rhAgg.weekly[i] + shAgg.weekly[i],
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

/**
 * dashboard.html의 #real-data 블록에 JSON을 주입하고
 * 사이드카 data.json도 저장한다.
 */
function inject(normalized) {
  const htmlPath = join(__dirname, 'dashboard.html');
  const jsonPath = join(__dirname, 'data.json');

  const html = readFileSync(htmlPath, 'utf8');
  const jsonStr = JSON.stringify(normalized, null, 2);

  // <script type="application/json" id="real-data">...</script> 블록 교체
  const newHtml = html.replace(
    /(<script\s+type="application\/json"\s+id="real-data">)([\s\S]*?)(<\/script>)/,
    `$1${jsonStr}$3`
  );

  if (newHtml === html) {
    throw new Error('#real-data 슬롯을 찾지 못했습니다. dashboard.html을 확인하세요.');
  }

  writeFileSync(htmlPath, newHtml, 'utf8');
  writeFileSync(jsonPath, jsonStr, 'utf8');

  console.log(`[ingest] dashboard.html 주입 완료 (generatedAt: ${normalized.generatedAt})`);
  console.log(`[ingest] data.json 저장 완료`);
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

// 종로구 픽스처 (다른 구도 정상 처리되는지 확인)
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
  const runDate = new Date('2026-07-10'); // 목요일
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

  // ── 2. parseItems 검증 ──────────────────────────
  console.log('\n[2] parseItems 검증');
  const aptItems = parseItems(FIXTURE_XML_APT);
  assert('아파트 픽스처 6건 파싱', aptItems.length === 6,
    `실제: ${aptItems.length}`);
  assert('첫 번째 item year=2026', aptItems[0].year === 2026);
  assert('첫 번째 item month=6',   aptItems[0].month === 6);
  assert('첫 번째 item day=10',    aptItems[0].day === 10);

  const shItems = parseItems(FIXTURE_XML_SH);
  assert('SH 픽스처 2건 파싱', shItems.length === 2);
  assert('일자 없는 항목 day=null', shItems[1].day === null);

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

  // 진행중 당월(2026-07)은 monthPeriods에 없으므로 집계 안됨
  assert('진행중 월(202607)은 monthPeriods에 없음',
    !periods.monthPeriods.includes('2026-07'));

  // 주별 집계: 2026-06-29~2026-07-05 (완료 주)에 해당하는 아파트 항목
  // 픽스처: 2026-06-29(month=6) + 2026-07-02(month=7) → 둘 다 이 주에 속함 → 2건
  const lastWeekKey = periods.weekPeriods[11]; // "2026-06-29~2026-07-05"
  assert('마지막 완료주 키 = 2026-06-29~2026-07-05',
    lastWeekKey === '2026-06-29~2026-07-05');
  assert('아파트 주별[마지막완료주] = 2 (06-29 + 07-02 모두 이 주에 속함)',
    aptAgg.weekly[11] === 2,
    `실제: ${aptAgg.weekly[11]}`);

  // SH 집계: 일자 없는 항목은 주 버킷에서 제외
  const shAgg = aggregateItems(shItems, periods.monthPeriods, periods.weekPeriods);
  assert('SH 월별[2026-06] = 2 (일자없는항목도 월 카운트)',
    shAgg.monthly[periods.monthPeriods.indexOf('2026-06')] === 2,
    `실제: ${shAgg.monthly[periods.monthPeriods.indexOf('2026-06')]}`);
  // 일자 없는 SH 항목은 6월 18일 만 주 버킷에 들어감
  // 2026-06-18은 2026-06-15~2026-06-21 주에 속함
  const weekIdx0618 = periods.weekPeriods.findIndex(p => p.startsWith('2026-06-15'));
  assert('SH 주별[2026-06-15주] = 1 (일자있는항목만)',
    weekIdx0618 >= 0 && shAgg.weekly[weekIdx0618] === 1,
    `weekIdx=${weekIdx0618}, 실제: ${weekIdx0618 >= 0 ? shAgg.weekly[weekIdx0618] : 'N/A'}`);

  // ── 4. buildNormalized 검증 ─────────────────────
  console.log('\n[4] buildNormalized 검증');

  const rawByDistrict = {
    강남구: {
      apt: aptItems,
      rh:  parseItems(FIXTURE_XML_RH),
      sh:  shItems,
    },
    종로구: {
      apt: parseItems(FIXTURE_XML_APT_JONGNO),
      rh:  parseItems(FIXTURE_XML_EMPTY),
      sh:  parseItems(FIXTURE_XML_EMPTY),
    },
  };

  const normalized = buildNormalized(
    rawByDistrict,
    periods.monthPeriods,
    periods.weekPeriods,
    '2026-07-10'
  );

  assert('generatedAt = 2026-07-10',
    normalized.generatedAt === '2026-07-10');
  assert('source = rtms',
    normalized.source === 'rtms');
  assert('periods.month 길이 = 12',
    normalized.periods.month.length === 12);
  assert('periods.week 길이 = 12',
    normalized.periods.week.length === 12);
  assert('byDistrict.강남구 존재',
    '강남구' in normalized.byDistrict);
  assert('강남구.month 길이 = 12',
    normalized.byDistrict['강남구'].month.length === 12);
  assert('강남구.week 길이 = 12',
    normalized.byDistrict['강남구'].week.length === 12);

  // 2026-06: apt=3, nonApt=(rh=2 + sh=2)=4
  const jun26Idx = normalized.periods.month.indexOf('2026-06');
  const gangnamJun = normalized.byDistrict['강남구'].month[jun26Idx];
  assert('강남구 2026-06 apt = 3',
    gangnamJun.apt === 3,
    `실제: ${gangnamJun.apt}`);
  assert('강남구 2026-06 nonApt = 4 (rh=2 + sh=2)',
    gangnamJun.nonApt === 4,
    `실제: ${gangnamJun.nonApt}`);

  // 종로구 2026-06 apt = 1
  const jongnoJun = normalized.byDistrict['종로구'].month[jun26Idx];
  assert('종로구 2026-06 apt = 1',
    jongnoJun.apt === 1,
    `실제: ${jongnoJun.apt}`);
  assert('종로구 2026-06 nonApt = 0',
    jongnoJun.nonApt === 0,
    `실제: ${jongnoJun.nonApt}`);

  // ── 5. 에러 XML 감지 ────────────────────────────
  console.log('\n[5] API 에러 응답 감지 검증');
  const errorXml = `<response><header><resultCode>30</resultCode><resultMsg>SERVICE ERROR</resultMsg></header></response>`;
  let errorCaught = false;
  try { parseItems(errorXml); } catch (e) { errorCaught = true; }
  assert('resultCode!=00 에서 예외 발생', errorCaught);

  // ── 결과 출력 ───────────────────────────────────
  console.log('\n=== 집계 샘플 ===');
  console.log('강남구 2026-06:', gangnamJun);
  console.log('강남구 주간[마지막완료주]:', normalized.byDistrict['강남구'].week[11]);
  console.log('종로구 2026-06:', jongnoJun);

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

  const runDate = new Date();
  const { dealYmdList, monthPeriods, weekPeriods } = buildPeriods(runDate);
  const generatedAt = runDate.toISOString().slice(0, 10);

  console.log(`[ingest] 실행 날짜: ${generatedAt}`);
  console.log(`[ingest] 수집 기간: ${dealYmdList[0]} ~ ${dealYmdList[dealYmdList.length - 1]}`);
  console.log(`[ingest] 총 요청 수: 25구 × ${dealYmdList.length}개월 × 3종 = ${25 * dealYmdList.length * 3}건\n`);

  const rawByDistrict = {};

  for (const district of DISTRICTS) {
    console.log(`[ingest] ${district.name} (${district.code}) 수집 중...`);
    rawByDistrict[district.name] = { apt: [], rh: [], sh: [] };

    for (const ym of dealYmdList) {
      // APT
      await sleep(DELAY_MS);
      const aptItems = await fetchAllPages(serviceKey, ENDPOINTS.apt, district.code, ym);
      rawByDistrict[district.name].apt.push(...aptItems);

      // RH (연립다세대)
      await sleep(DELAY_MS);
      const rhItems = await fetchAllPages(serviceKey, ENDPOINTS.rh, district.code, ym);
      rawByDistrict[district.name].rh.push(...rhItems);

      // SH (단독/다가구)
      await sleep(DELAY_MS);
      const shItems = await fetchAllPages(serviceKey, ENDPOINTS.sh, district.code, ym);
      rawByDistrict[district.name].sh.push(...shItems);
    }

    const d = rawByDistrict[district.name];
    console.log(
      `  → apt: ${d.apt.length}건, rh: ${d.rh.length}건, sh: ${d.sh.length}건`
    );
  }

  console.log('\n[ingest] 집계 중...');
  const normalized = buildNormalized(rawByDistrict, monthPeriods, weekPeriods, generatedAt);

  console.log('[ingest] dashboard.html 및 data.json 저장 중...');
  inject(normalized);

  console.log('[ingest] 완료!');
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
