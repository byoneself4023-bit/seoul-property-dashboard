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
 * 검사 네 종:
 *   [오염] 빠져야 할 거래가 섞이지 않았는가 (취소·직거래·1986년 이전 준공·sh·중복)
 *   [건수] 화면에 적히는 건수 표기가 실제 집계와 같은가
 *   [값]   표시된 여섯 필드가 원본 거래 한 건과 정확히 같은가
 *   [선별] 신고가로 표시된 건이 실제로 그 단지 그 평형의 기록을 깼는가 (재계산 대조)
 *   [상승률] 화면에 찍힌 두 금액으로 그 비율이 실제로 나오는가
 *   [추이] 월별 건수가 캐시 재계산과 원소 단위로 같은가 (당월 혼입 포함)
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '.cache', 'ingest');

// 전 기간 누적치. ④가 이 값이면 2024-01 필터가 빠진 것이다(실제 사고 이력).
const REBUILD_ALLTIME = { news: 1037, cancels: 182 };

// 리포트가 거는 준공 하한. ingest 의 REPORT_MIN_BUILD_YEAR 과 같은 값을 여기서 다시 쓴다.
const MIN_BUILD_YEAR = 1986;

const problems = [];
const fail = (area, msg) => problems.push(`  [${area}] ${msg}`);

/** data.js 에서 window.__DASHBOARD_DATA__ 를 꺼낸다. */
export function loadData(jsPath = join(__dirname, 'data.js')) {
  const src = readFileSync(jsPath, 'utf8');
  const m = src.match(/window\.__DASHBOARD_DATA__ = ([\s\S]*);\n$/);
  if (!m) throw new Error('data.js 형식을 알아보지 못했다');
  return JSON.parse(m[1]);
}

/**
 * 해제 짝 제거 — ingest 의 removeCancelledPairs 와 같은 규칙을 **일부러 다시 구현한다**
 * (함수를 공유하면 같은 버그를 두 번 실행할 뿐이다 — baselineRows 주석 참조).
 * 같은 (구·단지·법정동·지번·계약일·금액·면적·층) 키에서 해제 행(cdealType='O') 전부와
 * 정상 행을 해제 수만큼 걷어낸다. 취소된 계약은 0건이어야 한다.
 * data.js 의 meta.cancelPairsRemoved 가 참일 때만 적용한다 — 구 규칙으로 만든
 * data.js(해제 행만 제외)도 이 스크립트로 검증할 수 있게 하는 스위치다.
 */
function dropCancelledPairs(items) {
  const key = it => [it._lawd, it.name ?? '', it.umdNm ?? '', it.jibun ?? '',
    it.year, it.month, it.day, it.amount, it.area, it.floor].join('|');
  const cancels = new Map();
  for (const it of items) {
    if (it.cdealType !== 'O') continue;
    const k = key(it);
    cancels.set(k, (cancels.get(k) ?? 0) + 1);
  }
  if (cancels.size === 0) return items;
  const out = [];
  for (const it of items) {
    if (it.cdealType === 'O') continue;
    const k = key(it), left = cancels.get(k) ?? 0;
    if (left > 0) { cancels.set(k, left - 1); continue; }
    out.push(it);
  }
  return out;
}

/** 캐시 원본을 유형별로 읽는다. 리포트가 표시한 행을 되짚기 위한 것이다. */
function loadCache() {
  const byType = { apt: [], rh: [], sh: [], offi: [] };
  for (const f of readdirSync(CACHE_DIR)) {
    const m = f.match(/^(\d+)_(\d+)_(\w+)\.json$/);
    if (!m || !(m[3] in byType)) continue;
    for (const it of (JSON.parse(readFileSync(join(CACHE_DIR, f), 'utf8')).items ?? [])) {
      // 시군구코드를 함께 실어 둔다 — 같은 법정동·단지명이 다른 구에 또 있을 때
      // 그룹이 섞이는 것을 막는다.
      byType[m[3]].push({ ...it, _lawd: m[1] });
    }
  }
  return byType;
}

/**
 * 선별 검증용 기준선 모집단 — ingest 의 reportRows 와 **같은 조건을 여기서 다시 쓴다.**
 * 일부러 함수를 공유하지 않는다. 집계 코드를 그대로 불러다 대조하면 같은 버그를
 * 두 번 실행할 뿐이라 아무것도 검증되지 않는다.
 */
function baselineRows(cache, type, baselineFrom) {
  const out = [];
  for (const it of cache[type]) {
    const area = Number(it.area), amount = Number(it.amount);
    if (!Number.isFinite(area) || area <= 0 || !Number.isFinite(amount)) continue;
    if (it.cdealType === 'O') continue;
    if (String(it.dealingGbn ?? '').includes('직거래')) continue;
    if (!(Number(it.buildYear) >= MIN_BUILD_YEAR)) continue;
    const ymd = ymdOf(it);
    if (ymd < baselineFrom) continue;
    out.push({ lawd: it._lawd, name: it.name, umd: it.umdNm,
               size: Math.floor(area), area, amount, floor: it.floor, ymd });
  }
  return out;
}

/**
 * 재수집 대상 월 두 개(직전 완료월 + 당월). 신고분(새로 들어온 거래)은 **반드시**
 * 이 두 달 안에 계약일이 있다 — 다른 달은 애초에 다시 받지 않으므로 새로 나타날 수 없다.
 * 선별 검증에서 "직전 기록" 판정의 예외를 이 범위로만 허용한다.
 */
function refetchMonths(rows) {
  const max = rows.reduce((a, r) => (r.ymd > a ? r.ymd : a), '');
  if (max.length !== 8) return new Set();
  const y = Number(max.slice(0, 4)), mo = Number(max.slice(4, 6));
  const prev = mo === 1 ? `${y - 1}12` : `${y}${String(mo - 1).padStart(2, '0')}`;
  return new Set([max.slice(0, 6), prev]);
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

// ════════════════════════════════════════════════
//  [값] 표시된 여섯 필드가 원본 거래 한 건과 같은가
// ════════════════════════════════════════════════
// 오염 검사는 다섯 필드로 후보를 찾을 뿐 층은 보지 않는다. 층이 어긋나면 같은 날
// 같은 값의 **다른 집**을 가리키게 되므로 여기서 여섯 번째 필드까지 맞춘다.
function checkValues(rep, cache) {
  for (const { label, row, types } of displayedRows(rep)) {
    const exact = findSource(cache, types, row).filter(it => String(it.floor) === String(row.floor));
    if (!exact.length) {
      const near = findSource(cache, types, row);
      fail('값', `${label} "${row.name}"(${row.umd}) — 원본에 일치하는 거래가 없다: ` +
                 `${row.amount}만원 / ${row.area}㎡ / ${row.floor}층 / ${row.date}` +
                 (near.length ? ` (층만 다른 후보 ${near.length}건: ${near.map(x => x.floor).join(',')}층)` : ''));
    }
  }
}

// ════════════════════════════════════════════════
//  [선별] 정말 기록을 깼는가 — 캐시에서 다시 계산해 댄다
// ════════════════════════════════════════════════
function checkSelection(rep, cache) {
  const from = rep.meta?.baselineFrom;
  if (!from) { fail('선별', 'meta.baselineFrom 이 없다'); return 0; }

  const lists = [
    ['① 신고가', rep.apt?.highs, 'apt', true],
    ['① 신저가', rep.apt?.lows, 'apt', false],
    ['③ 연립다세대 신고가', rep.nonApt?.rh?.highs, 'rh', true],
    ['③ 연립다세대 신저가', rep.nonApt?.rh?.lows, 'rh', false],
    ['③ 오피스텔 신고가', rep.nonApt?.offi?.highs, 'offi', true],
    ['③ 오피스텔 신저가', rep.nonApt?.offi?.lows, 'offi', false],
  ];

  const pop = {}, window = {};
  for (const t of ['apt', 'rh', 'offi']) {
    pop[t] = baselineRows(cache, t, from);
    window[t] = refetchMonths(pop[t]);
  }

  let checked = 0;
  for (const [label, list, type, up] of lists) {
    for (const row of (list ?? [])) {
      // 그룹은 시군구 + 단지명 + 법정동 + 평형(전용면적 정수부). 표시 행이 준 정보만 쓴다.
      const src = pop[type].find(r =>
        r.name === row.name && r.umd === row.umd && Math.floor(Number(row.area)) === r.size &&
        r.amount === Number(row.amount) && r.ymd === row.date && String(r.floor) === String(row.floor));
      if (!src) {
        fail('선별', `${label} "${row.name}"(${row.umd}) — 기준선 모집단에서 이 거래를 찾지 못했다`);
        continue;
      }
      const g = pop[type].filter(r =>
        r.lawd === src.lawd && r.name === src.name && r.umd === src.umd && r.size === src.size);
      checked++;

      // ① 표시된 금액이 그 그룹의 극값인가. 아니면 애초에 기록이 아니다.
      const extreme = up ? Math.max(...g.map(r => r.amount)) : Math.min(...g.map(r => r.amount));
      if (extreme !== Number(row.amount)) {
        fail('선별', `${label} "${row.name}"(${row.umd} ${row.size}㎡) — ` +
                     `표시 ${row.amount}만원이 그룹 ${up ? '최고' : '최저'} ${extreme}만원이 아니다`);
        continue;
      }
      // ② 직전 기록이 방향에 맞는가
      if (up ? !(Number(row.prev) < Number(row.amount)) : !(Number(row.prev) > Number(row.amount))) {
        fail('선별', `${label} "${row.name}" — 직전 기록 ${row.prev}가 이번 ${row.amount}과 방향이 맞지 않는다`);
        continue;
      }
      // ③ 직전 기록이 실재하는 거래 금액인가
      if (!g.some(r => r.amount === Number(row.prev))) {
        fail('선별', `${label} "${row.name}"(${row.umd} ${row.size}㎡) — ` +
                     `직전 기록 ${row.prev}만원에 해당하는 거래가 그룹에 없다`);
        continue;
      }
      // ④ 직전 기록과 이번 사이에 낀 거래는 **신고분일 수 있는 것만** 허용한다.
      //    재수집 범위 밖(=새로 나타날 수 없는 달)의 거래가 사이에 있으면
      //    그것이 진짜 직전 기록이므로 prev 가 틀린 것이다.
      const between = g.filter(r => up
        ? (r.amount > Number(row.prev) && r.amount < Number(row.amount))
        : (r.amount < Number(row.prev) && r.amount > Number(row.amount)));
      const stale = between.filter(r => !window[type].has(r.ymd.slice(0, 6)));
      if (stale.length) {
        const s = stale.sort((a, b) => (up ? b.amount - a.amount : a.amount - b.amount))[0];
        fail('선별', `${label} "${row.name}"(${row.umd} ${row.size}㎡) — 직전 기록이 ${row.prev}만원이 아니다: ` +
                     `재수집 범위 밖 ${s.ymd} 거래 ${s.amount}만원이 사이에 있다`);
      }
    }
  }
  return checked;
}

// ════════════════════════════════════════════════
//  [상승률] 화면 안에서 나눗셈이 맞는가
// ════════════════════════════════════════════════
// 변동폭과 같은 함정이다 — 원값으로 계산하면 화면의 두 숫자로는 그 비율이 안 나온다.
function checkPct(rep) {
  const eok = m => Number((Number(m) / 10000).toFixed(1));
  for (const { label, row } of displayedRows(rep)) {
    if (typeof row.pct !== 'number') { fail('상승률', `${label} "${row.name}" — pct 가 없다`); continue; }
    const want = Number(((eok(row.amount) - eok(row.prev)) / eok(row.prev) * 100).toFixed(1));
    if (Math.abs(want - row.pct) > 0.05) {
      fail('상승률', `${label} "${row.name}" — 표시 ${eok(row.prev)} → ${eok(row.amount)} 이면 ` +
                     `${want}% 인데 ${row.pct}% 로 적혀 있다`);
    }
  }
}

// ════════════════════════════════════════════════
//  [추이] 월별 건수를 캐시에서 다시 세어 원소 단위로 댄다
// ════════════════════════════════════════════════
function checkTrend(rep, cache) {
  const t = rep.trend;
  if (!t) { fail('추이', 'report.trend 가 없다'); return 0; }
  const from = rep.meta?.baselineFrom;

  let cells = 0;
  for (const key of ['apt', 'rh', 'offi']) {
    const mine = {};
    for (const r of baselineRows(cache, key, from)) {
      const ym = `${r.ymd.slice(0, 4)}-${r.ymd.slice(4, 6)}`;
      mine[ym] = (mine[ym] ?? 0) + 1;
    }
    // 진행 중인 당월은 리포트가 버린다 — 검증도 같은 달을 버리되, **버렸는지 확인한다**
    const all = Object.keys(mine).sort();
    const dropped = all.at(-1);
    if (t.months.includes(dropped)) {
      fail('추이', `${key} — 진행 중인 당월 ${dropped} 이 추이에 남아 있다(부분값)`);
    }
    const want = all.slice(0, -1);
    if (want.join() !== t.months.join()) {
      fail('추이', `${key} — 월 목록이 다르다: 리포트 ${t.months.length}개(${t.months[0]}~${t.months.at(-1)}) ` +
                   `vs 재계산 ${want.length}개(${want[0]}~${want.at(-1)})`);
      continue;
    }
    t.months.forEach((ym, i) => {
      cells++;
      if ((t[key] ?? [])[i] !== (mine[ym] ?? 0)) {
        fail('추이', `${key} ${ym} — 리포트 ${(t[key] ?? [])[i]}건 vs 재계산 ${mine[ym] ?? 0}건`);
      }
    });
  }

  // 장끼리 숫자가 맞는가 — 추이 합계 + 버린 당월 = ③ 의 거래량 / ② 의 기준선
  const totals = { apt: rep.rank?.baseline, rh: rep.nonApt?.rh?.volume, offi: rep.nonApt?.offi?.volume };
  for (const key of ['apt', 'rh', 'offi']) {
    const sum = (t[key] ?? []).reduce((a, b) => a + b, 0);
    if (!Number.isInteger(totals[key])) continue;
    if (sum > totals[key]) {
      fail('추이', `${key} — 추이 합계 ${sum}건이 집계 ${totals[key]}건보다 많다`);
    }
  }
  return cells;
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
  // 새 규칙 data.js(해제 짝 제거)면 검증 모집단에도 같은 짝 제거를 건다.
  // 표시된 행은 살아남은 행 중에만 있어야 하므로, 캐시 전체를 여기서 한 번 거른다 —
  // [오염]·[값]·[선별]·[추이] 전부가 같은 모집단을 본다.
  if (rep.meta?.cancelPairsRemoved === true) {
    for (const t of Object.keys(cache)) cache[t] = dropCancelledPairs(cache[t]);
  }
  checkContamination(rep, cache);
  checkCounts(rep);
  checkValues(rep, cache);
  const selected = checkSelection(rep, cache);
  checkPct(rep);
  const cells = checkTrend(rep, cache);

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
  console.log(`  [값]   표시 ${shown}건의 단지명·법정동·전용면적·층·금액·날짜가 원본 거래와 일치`);
  console.log(`  [선별] ${selected}건을 캐시에서 다시 계산 — 그룹 극값 일치, ` +
              `직전 기록 실재·방향 일치, 사이에 낀 재수집 범위 밖 거래 없음`);
  console.log(`  [상승률] 표시 ${shown}건의 상승률이 화면의 두 금액과 나눗셈으로 일치`);
  console.log(`  [추이] 월별 ${cells}칸을 캐시에서 다시 세어 원소 단위 일치, ` +
              `진행 중인 당월 미포함, 합계가 ②③ 집계 이내`);
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
