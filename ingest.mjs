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

// 공간 규격 버킷 경계 (전용면적 m²) — 원룸형 ≤40 / 투룸형 40<x≤60 / 쓰리룸+ >60
const AREA_BUCKETS = { studioMax: 40, twoMax: 60 };
// 금액대 버킷 경계 (거래금액 만원) — 3억↓ ≤30000 / 3~6억 30000<x≤60000 / 6억↑ >60000
const PRICE_BUCKETS = { under3Max: 30000, under6Max: 60000 };

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
 * XML 응답에서 <item> 블록을 추출하고 계약 날짜, 전용면적, 거래금액을 파싱한다.
 * resultCode 검사를 포함한다.
 *
 * @param {string} xml
 * @returns {{ year: number, month: number, day: number|null, area: number|null, amount: number|null }[]}
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
      year:   parseInt(yearMatch[1],  10),
      month:  parseInt(monthMatch[1], 10),
      day:    dayMatch ? parseInt(dayMatch[1], 10) : null,
      area:   (area !== null && !isNaN(area))     ? area   : null,
      amount: (amount !== null && !isNaN(amount)) ? amount : null,
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
  // schemaVersion: 2 를 함께 저장해 구버전 캐시(v1)와 구분
  writeFileSync(cachePath(lawdCd, dealYmd, propType), JSON.stringify({ schemaVersion: 2, ...data }), 'utf8');
}

// ════════════════════════════════════════════════
//  집계 (순수 함수 — 단위 테스트 가능)
// ════════════════════════════════════════════════

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

  for (const item of items) {
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
  // 캐시 확인: schemaVersion === 2 인 경우에만 유효한 캐시로 처리
  // v1 캐시(날짜만 있고 area/amount 없음)는 자동 무효화 → 재수집
  if (useCache) {
    const cached = cacheLoad(lawdCd, dealYmd, propType);
    if (cached !== null && cached.schemaVersion === 2) {
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

  try {
    for (const district of DISTRICTS) {
      console.log(`[ingest] ${district.name} (${district.code}) 수집 중...`);
      // 모든 propType 슬롯을 빈 배열로 초기화 (offi 포함)
      rawByDistrict[district.name] = Object.fromEntries(propTypes.map(t => [t, []]));

      for (const ym of dealYmdList) {
        for (const [propType, endpoint] of Object.entries(ENDPOINTS)) {
          // @MX:WARN: [AUTO] 일일 한도 초과 시 즉시 중단 — 재시도 없음
          // @MX:REASON: resultCode 22는 재시도해도 의미 없음. 캐시로 이어서 가능.
          // 최근 2개월은 신고 지연 반영 위해 캐시 무시(재수집). cacheSave는 유지되어 스냅샷 갱신.
          const comboUseCache = useCache && !recentYmdSet.has(ym);
          const result = await fetchCombo(
            serviceKey, endpoint, district.code, ym, propType, comboUseCache, stats
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
