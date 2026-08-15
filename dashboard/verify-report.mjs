/**
 * verify-report.mjs — 리포트에 표시되는 값이 원본과 어긋나지 않는지 검사한다.
 *
 * 대표에게 나가는 이미지라 숫자가 하나라도 틀리면 안 된다.
 * render-report.mjs 가 이것을 **먼저** 부르고, 실패하면 PNG 를 쓰지 않는다.
 *
 *   node dashboard/verify-report.mjs
 *
 * 실패하면 무엇이 어떻게 틀렸는지 행 단위로 찍고 exit 1.
 *
 * 1단계 검사 두 종:
 *   [오염] 빠져야 할 거래가 섞이지 않았는가 (취소·직거래·1985년 이전 준공·sh·중복)
 *   [건수] 화면에 적히는 건수 표기가 실제 집계와 같은가
 * 값 일치·선별 정확성·각주 일치는 2단계에서 붙인다.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '.cache', 'ingest');

// 전 기간 누적치. ④가 이 값이면 2024-01 필터가 빠진 것이다(실제 사고 이력).
const REBUILD_ALLTIME = { news: 1037, cancels: 182 };

const problems = [];
const fail = (area, msg) => problems.push(`  [${area}] ${msg}`);

/** data.js 에서 window.__DASHBOARD_DATA__ 를 꺼낸다. */
export function loadData(jsPath = join(__dirname, 'data.js')) {
  const src = readFileSync(jsPath, 'utf8');
  const m = src.match(/window\.__DASHBOARD_DATA__ = ([\s\S]*);\n$/);
  if (!m) throw new Error('data.js 형식을 알아보지 못했다');
  return JSON.parse(m[1]);
}

/** 캐시 원본을 유형별로 읽는다. 리포트가 표시한 행을 되짚기 위한 것이다. */
function loadCache() {
  const byType = { apt: [], rh: [], sh: [], offi: [] };
  for (const f of readdirSync(CACHE_DIR)) {
    const m = f.match(/^(\d+)_(\d+)_(\w+)\.json$/);
    if (!m || !(m[3] in byType)) continue;
    for (const it of (JSON.parse(readFileSync(join(CACHE_DIR, f), 'utf8')).items ?? [])) {
      byType[m[3]].push(it);
    }
  }
  return byType;
}

const ymdOf = it =>
  `${it.year}${String(it.month).padStart(2, '0')}${String(it.day).padStart(2, '0')}`;

/** 표시된 행 → 원본 거래 후보. 단지명·법정동·면적·금액·날짜로 찾는다. */
function findSource(cache, types, row) {
  const hits = [];
  for (const t of types) {
    for (const it of cache[t]) {
      if (it.name !== row.name) continue;
      if (it.umdNm !== row.umd) continue;
      if (Number(it.amount) !== Number(row.amount)) continue;
      if (Number(it.area) !== Number(row.area)) continue;
      if (ymdOf(it) !== row.date) continue;
      hits.push({ ...it, _type: t });
    }
  }
  return hits;
}

/** 모든 블록의 표시 행을 (라벨, 행, 허용 유형)으로 펼친다. */
function displayedRows(rep) {
  const out = [];
  const push = (label, rows, types) => (rows ?? []).forEach(r => out.push({ label, row: r, types }));
  push('① 신고가', rep.apt?.highs, ['apt']);
  push('① 신저가', rep.apt?.lows, ['apt']);
  push('③ 연립다세대 신고가', rep.nonApt?.rh?.highs, ['rh']);
  push('③ 연립다세대 신저가', rep.nonApt?.rh?.lows, ['rh']);
  push('③ 오피스텔 신고가', rep.nonApt?.offi?.highs, ['offi']);
  push('③ 오피스텔 신저가', rep.nonApt?.offi?.lows, ['offi']);
  return out;
}

// ════════════════════════════════════════════════
//  [오염] 빠져야 할 것이 섞이지 않았는가
// ════════════════════════════════════════════════
function checkContamination(rep, cache) {
  const rows = displayedRows(rep);
  const minYear = 1986;

  for (const { label, row, types } of rows) {
    const hits = findSource(cache, types, row);
    if (!hits.length) {
      fail('오염', `${label} "${row.name}"(${row.umd}) — 원본에서 대응 거래를 찾지 못했다 ` +
                   `(${row.amount}만원 / ${row.area}㎡ / ${row.date})`);
      continue;
    }
    // 후보가 여럿이면 하나라도 조건을 만족하면 통과로 본다(같은 날 같은 값 거래가 실재한다)
    const clean = hits.filter(it =>
      it.cdealType !== 'O' &&
      !String(it.dealingGbn ?? '').includes('직거래') &&
      Number(it.buildYear) >= minYear);
    if (!clean.length) {
      const it = hits[0];
      fail('오염', `${label} "${row.name}"(${row.umd}) — 제외 대상이 표시됐다: ` +
                   `cdealType=${it.cdealType ?? '-'} / dealingGbn=${it.dealingGbn ?? '-'} / ` +
                   `buildYear=${it.buildYear}`);
    }
  }

  // ③ 에 sh(단독·다가구)가 섞였는가 — sh 는 건물명이 전부 null 이라 이름으로 걸러진다
  const shNames = new Set(cache.sh.map(it => it.name).filter(Boolean));
  for (const key of ['rh', 'offi']) {
    for (const kind of ['highs', 'lows']) {
      for (const r of (rep.nonApt?.[key]?.[kind] ?? [])) {
        if (shNames.has(r.name)) {
          fail('오염', `③ ${key}.${kind} "${r.name}" — 단독·다가구(sh) 가 섞였다`);
        }
      }
    }
  }

  // 같은 거래가 두 번 나오는가 (목록 안에서)
  const lists = [
    ['① 신고가', rep.apt?.highs], ['① 신저가', rep.apt?.lows],
    ['③ rh 신고가', rep.nonApt?.rh?.highs], ['③ rh 신저가', rep.nonApt?.rh?.lows],
    ['③ offi 신고가', rep.nonApt?.offi?.highs], ['③ offi 신저가', rep.nonApt?.offi?.lows],
    ['④ 신규 지정', rep.rebuild?.news], ['④ 해제', rep.rebuild?.cancels],
  ];
  for (const [label, list] of lists) {
    const seen = new Set();
    for (const r of (list ?? [])) {
      const k = [r.name, r.umd ?? '', r.addr ?? '', r.amount ?? '', r.date ?? '', r.size ?? ''].join('|');
      if (seen.has(k)) fail('오염', `${label} — 같은 항목이 두 번 나온다: ${r.name}`);
      seen.add(k);
    }
  }
}

// ════════════════════════════════════════════════
//  [건수] 화면 표기가 실제 집계와 같은가
// ════════════════════════════════════════════════
function checkCounts(rep) {
  const m = rep.meta;
  if (!m) { fail('건수', 'report.meta 가 없다'); return; }

  const pairs = [
    ['① 신고가', rep.apt?.counts?.high, rep.apt?.highs?.length],
    ['① 신저가', rep.apt?.counts?.low, rep.apt?.lows?.length],
    ['③ rh 신고가', rep.nonApt?.rh?.counts?.high, rep.nonApt?.rh?.highs?.length],
    ['③ rh 신저가', rep.nonApt?.rh?.counts?.low, rep.nonApt?.rh?.lows?.length],
    ['③ offi 신고가', rep.nonApt?.offi?.counts?.high, rep.nonApt?.offi?.highs?.length],
    ['③ offi 신저가', rep.nonApt?.offi?.counts?.low, rep.nonApt?.offi?.lows?.length],
  ];
  for (const [label, total, shown] of pairs) {
    if (!Number.isInteger(total)) { fail('건수', `${label} — 집계 건수가 없다`); continue; }
    if (shown > total) fail('건수', `${label} — 표시 ${shown}건이 집계 ${total}건보다 많다`);
  }

  // ② 순위는 층위마다 rankN 이하여야 하고 건수가 내림차순이어야 한다
  for (const [label, list] of [['자치구', rep.rank?.district], ['법정동', rep.rank?.umd], ['단지', rep.rank?.complex]]) {
    if (!Array.isArray(list)) { fail('건수', `② ${label} 목록이 없다`); continue; }
    if (list.length > m.rankN) fail('건수', `② ${label} — ${list.length}줄로 상한 ${m.rankN} 을 넘었다`);
    for (let i = 1; i < list.length; i++) {
      if (list[i - 1].count < list[i].count) {
        fail('건수', `② ${label} — 건수가 내림차순이 아니다 (${list[i - 1].count} < ${list[i].count})`);
      }
    }
  }

  // ④ 누적치 오용 — 2024-01 필터가 빠지면 1966년부터의 값이 나온다
  if (rep.rebuild) {
    const { news, cancels } = rep.rebuild.counts ?? {};
    if (news === REBUILD_ALLTIME.news && cancels === REBUILD_ALLTIME.cancels) {
      fail('건수', `④ 신규 ${news} / 해제 ${cancels} — 전 기간 누적치와 같다. ` +
                   `${m.baselineFrom} 이후 필터가 빠졌다`);
    }
    if (rep.rebuild.news?.length > m.topN) fail('건수', `④ 신규 지정 표시가 상한 ${m.topN} 을 넘었다`);
    if (rep.rebuild.cancels?.length > m.topN) fail('건수', `④ 해제 표시가 상한 ${m.topN} 을 넘었다`);
  }

  // 표시 줄 수 상한
  if (rep.apt?.highs?.length > m.topN) fail('건수', `① 신고가 표시가 상한 ${m.topN} 을 넘었다`);
  if (rep.apt?.lows?.length > m.topN) fail('건수', `① 신저가 표시가 상한 ${m.topN} 을 넘었다`);
}

export function verifyReport() {
  problems.length = 0;
  if (!existsSync(CACHE_DIR)) {
    console.error('캐시가 없다:', CACHE_DIR);
    return false;
  }
  const data = loadData();
  const rep = data.report;
  if (!rep) { console.error('data.js 에 report 가 없다. 수집을 먼저 실행하라.'); return false; }

  const cache = loadCache();
  checkContamination(rep, cache);
  checkCounts(rep);

  const shown = displayedRows(rep).length;
  if (problems.length) {
    console.error(`\n검증 실패 — ${problems.length}건\n`);
    problems.forEach(p => console.error(p));
    console.error('');
    return false;
  }
  console.log('리포트 검증 통과');
  console.log(`  [오염] 표시된 거래 ${shown}건 전건을 원본에서 되짚어 ` +
              `취소·직거래·${1986}년 이전 준공·sh 혼입·중복 없음`);
  console.log(`  [건수] 블록별 표시/집계 건수 정합, ② 순위 내림차순, ` +
              `④ 전 기간 누적치(${REBUILD_ALLTIME.news}/${REBUILD_ALLTIME.cancels}) 오용 아님`);
  return true;
}

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(entry)).href; } catch { return false; }
})();

if (isDirectRun) {
  process.exit(verifyReport() ? 0 : 1);
}
