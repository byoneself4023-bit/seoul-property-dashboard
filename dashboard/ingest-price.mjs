/**
 * ingest-price.mjs — 한국부동산원 R-ONE → 서울 주간 아파트 매매가격지수
 *
 * 사용법:
 *   REB_SERVICE_KEY=<키> node ingest-price.mjs            # 수집 (이미 받은 주면 아무것도 안 바꾼다)
 *   REB_SERVICE_KEY=<키> node ingest-price.mjs --force    # 같은 주차도 다시 받아 캐시를 덮어쓴다
 *   node ingest-price.mjs --selftest                      # 픽스처로 파이프라인 검증
 *
 * ── 이 파일의 경계 ───────────────────────────────────────
 * **여기는 "출처에서 지수를 받아 오는 일"만 한다.** 변동률 계산·집계·화면 가공은
 * ingest.mjs 쪽(buildPriceBlock)이 한다. 주간 통계는 폐지·개편 논의가 있어
 * (2026-06~07 보도) 출처가 바뀔 수 있는데, 그때 **이 파일 하나만 새로 쓰면**
 * 나머지가 그대로 돈다. 그래서 내보내는 모양을 출처 중립으로 고정한다:
 *
 *   { asOf, weekId, prevAsOf, prevWeekId, source:{...}, index:{ 지역명:{cur,prev} } }
 *
 * 이 모양만 지키면 KB든 다른 무엇이든 교체 가능하다. R-ONE 고유의 것
 * (STATBL_ID·CLS_ID·WRTTIME_IDTFR_ID)은 이 파일 밖으로 나가지 않는다.
 *
 * 환경 변수:
 *   REB_SERVICE_KEY  R-ONE Open API 인증키 (reb.or.kr/r-one 로그인 후 발급)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** import 만으로 수집이 돌면 안 된다 — ingest.mjs 와 같은 가드(2026-08-12 사고). */
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(entry)).href; }
  catch { return false; }
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
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
})();

// ════════════════════════════════════════════════
//  상수 — 1단계(2026-09-30~10-01)에서 실측 확인한 식별자
// ════════════════════════════════════════════════
const BASE = 'https://www.reb.or.kr/r-one/openapi/';

/**
 * 통계표 — (주) 매매가격지수. 공식 API `SttsApiTbl.do` 로 이름으로도 찾을 수 있지만
 * (키가 있으면 pIndex/pSize 페이징이 열린다 — 실측), 매번 738건을 훑는 대신
 * 번호를 상수로 두고 **수집할 때 유효성만 확인**한다. 어긋나면 실패시킨다.
 */
const STATBL_ID = 'T244183132827305';
const DTACYCLE_CD = 'WK';
const ITM_ID = 10001;          // 항목: 지수 (이 표에 변동률 항목은 없다)

// 캐시 스키마 버전 — 올리면 이전 캐시가 무효가 되어 다시 받는다.
//   v1: 서울 33개 지역 × 2주차 원본 행
const CACHE_SCHEMA_VERSION = 1;
const CACHE_DIR = join(__dirname, '.cache', 'price');

/**
 * 서울 33개 지역의 CLS_ID. 응답의 CLS_FULLNM 으로 계층을 알 수 있으므로
 * 부모-자식 표를 따로 들지 않는다 — 여기 있는 것은 "무엇을 받아야 하는가" 뿐이다.
 */
const SEOUL_CLS = {
  50008: '서울',
  50009: '강북지역', 50013: '강남지역',
  50010: '도심권', 50011: '동북권', 50012: '서북권', 50014: '서남권', 50015: '동남권',
  50043: '종로구', 50044: '중구', 50045: '용산구', 50047: '성동구', 50048: '광진구',
  50049: '동대문구', 50050: '중랑구', 50051: '성북구', 50052: '강북구', 50053: '도봉구',
  50054: '노원구', 50056: '은평구', 50057: '서대문구', 50058: '마포구', 50060: '양천구',
  50061: '강서구', 50062: '구로구', 50063: '금천구', 50064: '영등포구', 50065: '동작구',
  50066: '관악구', 50067: '서초구', 50068: '강남구', 50069: '송파구', 50070: '강동구',
};

const SOURCE = {
  name: '한국부동산원',
  stat: '주간 아파트 매매가격지수',
  label: '출처: 한국부동산원 주간 아파트 매매가격지수',
  url: 'https://www.reb.or.kr/r-one/',
  note: '조사기준일 월요일 · 발표 목요일',
};

// ════════════════════════════════════════════════
//  HTTP
// ════════════════════════════════════════════════

/** 응답에 제어문자가 섞여 들어와 JSON.parse 가 깨진다 — 코드포인트로 걸러낸다(실측). */
const stripControl = s => [...s].filter(c => c.codePointAt(0) >= 32 || c === '\n').join('');

async function callApi(op, params, key) {
  const q = new URLSearchParams({ ...params, Type: 'json', KEY: key });
  const res = await fetch(`${BASE}${op}?${q}`);
  if (!res.ok) throw new Error(`${op} HTTP ${res.status}`);
  const body = JSON.parse(stripControl(await res.text()));
  // 조회 결과가 없거나 오류면 RESULT 만 내려온다.
  if (body.RESULT) {
    const { CODE, MESSAGE } = body.RESULT;
    if (CODE === 'INFO-200') return { rows: [], total: 0 };   // 데이터 없음 — 오류가 아니다
    throw new Error(`${op} ${CODE}: ${MESSAGE}`);
  }
  const root = body[op.replace('.do', '')];
  return { rows: root[1].row ?? [], total: root[0].head[0].list_total_count };
}

// ════════════════════════════════════════════════
//  식별자 검증 — 어긋나면 수집을 실패시킨다
// ════════════════════════════════════════════════

/**
 * 상수로 박아 둔 STATBL_ID·ITM_ID·CLS_ID 가 아직 유효한지 공식 API 로 확인한다.
 * 조용히 넘어가면 엉뚱한 지역 값이 화면에 실린다 — 그래서 예외를 던진다.
 */
export async function verifyIdentifiers(key) {
  const { rows, total } = await callApi('SttsApiTblItm.do', { STATBL_ID, pIndex: 1, pSize: 1000 }, key);
  if (!rows.length) throw new Error(`식별자 검증 실패: ${STATBL_ID} 의 세부항목이 비어 있다`);

  const byId = new Map(rows.map(r => [Number(r.ITM_ID), r]));
  const missing = [];
  for (const [cls, name] of Object.entries(SEOUL_CLS)) {
    const got = byId.get(Number(cls));
    if (!got) { missing.push(`${name}(${cls}) 없음`); continue; }
    if (got.ITM_NM !== name) missing.push(`${cls} 이름 불일치: 상수 "${name}" vs 응답 "${got.ITM_NM}"`);
  }
  const itm = byId.get(ITM_ID);
  if (!itm) missing.push(`항목 ITM_ID=${ITM_ID} 없음`);
  else if (itm.ITM_NM !== '지수') missing.push(`ITM_ID=${ITM_ID} 가 "지수" 가 아니라 "${itm.ITM_NM}"`);

  if (missing.length) {
    throw new Error(
      `식별자 검증 실패 — 출처의 코드 체계가 바뀌었다. 상수를 고치기 전에는 수집하지 않는다.\n  ` +
      missing.join('\n  '));
  }
  return { checked: Object.keys(SEOUL_CLS).length + 1, total };
}

// ════════════════════════════════════════════════
//  기준일 / 주차
// ════════════════════════════════════════════════

/** KST 기준 오늘(UTC 자정 Date 로 정규화). */
export function kstToday(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  return new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()));
}

/**
 * "지금 나와 있어야 하는 기준일" — 조사기준일은 월요일, 발표는 그 주 목요일이다.
 * 목요일 이후면 이번 주 월요일이, 그 전이면 지난주 월요일이 최신이어야 한다.
 */
export function expectedAsOf(today = kstToday()) {
  const dow = today.getUTCDay();                  // 0=일 … 4=목
  const mondayOffset = (dow + 6) % 7;             // 이번 주 월요일까지 뒤로
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() - mondayOffset);
  // 목(4)·금(5)·토(6)·일(0) 이면 이번 주 월요일, 월~수면 지난주 월요일
  if (!(dow >= 4 || dow === 0)) d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

/** 발표 상태를 사람이 읽는 말로. 실행 기록과 화면이 같은 문구를 쓴다. */
export function describeState(latestAsOf, expected = expectedAsOf()) {
  if (!latestAsOf) return { state: 'none', text: '아직 받은 발표분이 없다' };
  if (latestAsOf >= expected) {
    return { state: 'current', text: `이번 주 발표분 수집 완료 — ${krDate(latestAsOf)} 기준` };
  }
  return { state: 'pending', text: `아직 발표 전 — ${krDate(latestAsOf)} 기준 유지` };
}

/** '2026-09-28' → '9월 28일' */
export function krDate(iso) {
  if (!iso) return '';
  return `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일`;
}

// ════════════════════════════════════════════════
//  캐시
// ════════════════════════════════════════════════

function cachePath(weekId) { return join(CACHE_DIR, `${weekId}.json`); }

/** 캐시에 있는 주차 중 가장 최근 것. 없으면 null. */
export function loadLatestCached(dir = CACHE_DIR) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(f => /^\d{6}\.json$/.test(f)).sort();
  if (!files.length) return null;
  try {
    const d = JSON.parse(readFileSync(join(dir, files[files.length - 1]), 'utf8'));
    return d.schemaVersion === CACHE_SCHEMA_VERSION ? d : null;
  } catch { return null; }
}

// ════════════════════════════════════════════════
//  수집
// ════════════════════════════════════════════════

/** 서울(50008) 시계열에서 최신 두 주차를 찾는다. */
async function discoverWeeks(key, year = new Date().getFullYear()) {
  const { rows } = await callApi('SttsApiTblData.do', {
    STATBL_ID, DTACYCLE_CD, ITM_ID, CLS_ID: 50008,
    START_WRTTIME: `${year}01`, pIndex: 1, pSize: 200,
  }, key);
  if (rows.length < 2) throw new Error(`주차를 찾지 못했다 (${year}년 ${rows.length}건)`);
  const sorted = rows.slice().sort((a, b) => String(a.WRTTIME_IDTFR_ID).localeCompare(String(b.WRTTIME_IDTFR_ID)));
  const cur = sorted[sorted.length - 1], prev = sorted[sorted.length - 2];
  return {
    weekId: String(cur.WRTTIME_IDTFR_ID), asOf: cur.WRTTIME_DESC,
    prevWeekId: String(prev.WRTTIME_IDTFR_ID), prevAsOf: prev.WRTTIME_DESC,
  };
}

/**
 * 두 주차 × 서울 33개 지역을 **한 번의 호출**로 받는다.
 * 실측: 2주차 전국 472행(그중 서울 66행). pSize 상한은 1,000 이다
 * (넘기면 ERROR-336). 전국 236행/주차이므로 2주는 여유가 있다.
 */
async function fetchWeeks(key, prevWeekId, weekId) {
  const { rows } = await callApi('SttsApiTblData.do', {
    STATBL_ID, DTACYCLE_CD, ITM_ID,
    START_WRTTIME: prevWeekId, END_WRTTIME: weekId, pIndex: 1, pSize: 1000,
  }, key);
  return rows
    .filter(r => SEOUL_CLS[r.CLS_ID] !== undefined)
    .map(r => ({
      clsId: Number(r.CLS_ID), name: SEOUL_CLS[r.CLS_ID], path: r.CLS_FULLNM,
      weekId: String(r.WRTTIME_IDTFR_ID), asOf: r.WRTTIME_DESC, value: Number(r.DTA_VAL),
    }));
}

/**
 * 수집 본체.
 * @returns {{changed:boolean, state:string, text:string, payload:Object|null}}
 */
export async function collectPrice({ key, force = false } = {}) {
  if (!key) throw new Error('REB_SERVICE_KEY 가 없다');

  const ident = await verifyIdentifiers(key);
  const weeks = await discoverWeeks(key);
  const cached = loadLatestCached();
  const state = describeState(weeks.asOf);

  // 이미 받은 주차면 아무것도 바꾸지 않는다. 예약 실행이 한 주에 여러 번 돌기 때문에
  // 이 분기가 정상 경로다 — 실패시키면 안 된다.
  if (!force && cached && cached.weekId === weeks.weekId) {
    return { changed: false, state: state.state, text: state.text, identifiers: ident, payload: null };
  }

  const rows = await fetchWeeks(key, weeks.prevWeekId, weeks.weekId);
  const expectCount = Object.keys(SEOUL_CLS).length * 2;
  if (rows.length !== expectCount) {
    throw new Error(`행 수가 맞지 않는다 — 기대 ${expectCount}, 실제 ${rows.length}`);
  }

  const payload = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    ...weeks,
    source: SOURCE,
    rows,
  };
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(weeks.weekId), JSON.stringify(payload, null, 1) + '\n');
  return { changed: true, state: state.state, text: state.text, identifiers: ident, payload };
}

/**
 * 캐시 → **출처 중립 형태**. ingest.mjs 가 읽는 유일한 출구다.
 * 다른 출처로 갈아 끼울 때 이 모양만 맞추면 된다.
 */
export function toNeutral(cache) {
  if (!cache || !cache.rows) return null;
  const index = {};
  for (const r of cache.rows) {
    (index[r.name] ??= {})[r.weekId === cache.weekId ? 'cur' : 'prev'] = r.value;
    if (r.weekId === cache.weekId) index[r.name].path = r.path;
  }
  return {
    asOf: cache.asOf, weekId: cache.weekId,
    prevAsOf: cache.prevAsOf, prevWeekId: cache.prevWeekId,
    source: cache.source ?? SOURCE,
    index,
  };
}

export { SEOUL_CLS, SOURCE, CACHE_DIR, STATBL_ID, ITM_ID, CACHE_SCHEMA_VERSION };

// ════════════════════════════════════════════════
//  셀프테스트 — 네트워크 없이 파이프라인만 검증
// ════════════════════════════════════════════════
function runSelfTest() {
  let pass = true; const fails = [];
  const ok = (name, cond, extra = '') => {
    if (cond) console.log(`  PASS  ${name}`);
    else { pass = false; fails.push(name); console.log(`  FAIL  ${name} ${extra}`); }
  };

  console.log('[1] 기준일 계산 — 조사기준일 월요일 / 발표 목요일');
  // 2026-10-01 은 목요일 → 이번 주 월요일(09-28)이 나와 있어야 한다
  ok('목요일 → 이번 주 월요일', expectedAsOf(new Date(Date.UTC(2026, 9, 1))) === '2026-09-28',
     expectedAsOf(new Date(Date.UTC(2026, 9, 1))));
  // 2026-09-30 은 수요일 → 아직 지난주 월요일(09-21)
  ok('수요일 → 지난주 월요일', expectedAsOf(new Date(Date.UTC(2026, 8, 30))) === '2026-09-21',
     expectedAsOf(new Date(Date.UTC(2026, 8, 30))));
  // 2026-10-02 금요일 → 이번 주 월요일
  ok('금요일 → 이번 주 월요일', expectedAsOf(new Date(Date.UTC(2026, 9, 2))) === '2026-09-28');
  // 2026-10-05 월요일 → 지난주 월요일
  ok('월요일 → 지난주 월요일', expectedAsOf(new Date(Date.UTC(2026, 9, 5))) === '2026-09-28');

  console.log('\n[2] 발표 상태 문구');
  const a = describeState('2026-09-28', '2026-09-28');
  ok('받았으면 "수집 완료"', a.state === 'current' && a.text.includes('이번 주 발표분 수집 완료'), a.text);
  const b = describeState('2026-09-21', '2026-09-28');
  ok('아직이면 "발표 전 — 기준 유지"', b.state === 'pending' && b.text.includes('아직 발표 전') && b.text.includes('9월 21일'), b.text);
  ok('날짜 한글 변환', krDate('2026-09-28') === '9월 28일', krDate('2026-09-28'));

  console.log('\n[3] 출처 중립 변환');
  const fixture = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    weekId: '202640', asOf: '2026-09-28', prevWeekId: '202639', prevAsOf: '2026-09-21',
    source: SOURCE,
    rows: [
      { clsId: 50008, name: '서울', path: '서울', weekId: '202639', asOf: '2026-09-21', value: 102.5 },
      { clsId: 50008, name: '서울', path: '서울', weekId: '202640', asOf: '2026-09-28', value: 102.6 },
      { clsId: 50068, name: '강남구', path: '서울>강남지역>동남권>강남구', weekId: '202639', asOf: '2026-09-21', value: 98.6 },
      { clsId: 50068, name: '강남구', path: '서울>강남지역>동남권>강남구', weekId: '202640', asOf: '2026-09-28', value: 98.2 },
    ],
  };
  const n = toNeutral(fixture);
  ok('asOf 보존', n.asOf === '2026-09-28' && n.prevAsOf === '2026-09-21');
  ok('cur/prev 분리', n.index['서울'].cur === 102.6 && n.index['서울'].prev === 102.5);
  ok('계층 경로 보존', n.index['강남구'].path.endsWith('강남구'));
  ok('출처 라벨', n.source.label.includes('한국부동산원'));
  ok('빈 입력은 null', toNeutral(null) === null);

  console.log('\n[4] 상수 점검');
  const names = Object.values(SEOUL_CLS);
  ok('지역 33개', names.length === 33, String(names.length));
  ok('구 25개', names.filter(x => x.endsWith('구')).length === 25);
  ok('서울 포함', names.includes('서울'));
  ok('권역 7개', names.filter(x => /지역$|권$/.test(x)).length === 7);

  console.log(`\n${pass ? 'PASS' : `FAIL (${fails.length}건: ${fails.join(', ')})`}`);
  process.exit(pass ? 0 : 1);
}

// ════════════════════════════════════════════════
//  진입점
// ════════════════════════════════════════════════
if (isDirectRun) {
  if (process.argv.includes('--selftest')) {
    runSelfTest();
  } else {
    const key = process.env.REB_SERVICE_KEY;
    if (!key) {
      console.error('[오류] REB_SERVICE_KEY 가 없습니다. .env 에 넣거나 환경 변수로 넘기세요.\n' +
                    '       파이프라인만 검증하려면: node ingest-price.mjs --selftest');
      process.exit(1);
    }
    const r = await collectPrice({ key, force: process.argv.includes('--force') });
    console.log(`[ingest-price] 식별자 검증 통과 (${r.identifiers.checked}개 / 전체 ${r.identifiers.total})`);
    console.log(`[ingest-price] ${r.text}`);
    if (r.changed) {
      const n = toNeutral(r.payload);
      const seoul = n.index['서울'];
      const pct = ((seoul.cur / seoul.prev - 1) * 100).toFixed(2);
      console.log(`[ingest-price] 새 주차 ${n.weekId} 저장 — ${n.asOf} 기준 · 서울 전주 대비 ${pct >= 0 ? '+' : ''}${pct}%`);
      console.log(`[ingest-price] 캐시: .cache/price/${n.weekId}.json (지역 ${Object.keys(n.index).length}개 × 2주)`);
    } else {
      console.log('[ingest-price] 바꾼 것 없음 — 캐시 그대로 둔다');
    }
  }
}
