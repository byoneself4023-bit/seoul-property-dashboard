/**
 * render-report.mjs — 리포트 블록 4장을 PNG 파일로 저장한다.
 *
 *   npm run report
 *
 * 사람이 브라우저를 열어 손으로 캡처하던 것을 대체한다.
 * **verify-report.mjs 를 먼저 부르고, 실패하면 PNG 를 쓰지 않고 종료한다.**
 * 대표에게 나가는 이미지라 검증을 통과하지 못한 그림은 아예 만들지 않는다.
 *
 * Playwright 를 새로 들이지 않고 puppeteer 를 재사용한다 — 이미 devDependency 이고
 * verify-quality.mjs 가 같은 방식(file:// + networkidle0)을 쓴다. CI 도 그쪽 크롬을 깐다.
 */
import puppeteer from 'puppeteer';
import { mkdirSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyReport } from './verify-report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = pathToFileURL(join(__dirname, 'dashboard.html')).href;
const OUT_DIR = join(__dirname, 'out');

// 발행 주기로 폴더를 가른다. 매주 네 장은 늘 나가고, 정비사업은 **새 지정이나
// 해제가 실제로 생긴 달에만** 다섯 번째로 붙는다(report.rebuild.changed).
// 고시 수집은 월 1회라 대부분의 주에는 바뀔 것이 없고, 안 바뀐 그림을 매주
// 다시 내면 받는 쪽이 "이번 주에 뭔가 생겼다"로 읽는다.
// 파일명 앞 번호는 폴더 안에서 정렬하면 리포트 순서 그대로 선다.
const WEEKLY_BLOCKS = [
  { id: 'rptBlock1', file: '매주/01-신고가신저가.png', slot: '01' },
  { id: 'rptBlock2', file: '매주/02-거래1위.png',      slot: '02' },
  { id: 'rptBlock3', file: '매주/03-비아파트.png',     slot: '03' },
  { id: 'rptBlock5', file: '매주/04-거래량추이.png',   slot: '04' },
  // 06 = 가격 변동률(한국부동산원). **매주 고정**이고 05 와 번호가 겹치지 않는다 —
  // 05 는 정비사업 전용이고 외부 사이트가 01~05 를 하드코딩으로 걸고 있어
  // 재배치할 수 없다. 그래서 새 그림은 05 가 아니라 06 이다.
  { id: 'rptBlock6', file: '매주/06-가격변동률.png',   slot: '06' },
];
const REBUILD_BLOCK = { id: 'rptBlock4', file: '월간/정비사업.png', slot: '05' };

async function render() {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  // deviceScaleFactor 2 — 블로그에 올렸을 때 글자가 뭉개지지 않게 2배로 찍는다.
  await page.setViewport({ width: 1240, height: 1400, deviceScaleFactor: 2 });

  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(DASHBOARD, { waitUntil: 'networkidle0' });

  // 데이터가 실렸는지 먼저 확인한다. 없으면 빈 칸이 찍힌다.
  const hasReport = await page.evaluate(() => !!(window.__DASHBOARD_DATA__?.report?.meta));
  if (!hasReport) throw new Error('data.js 에 report 가 없다 — 수집을 먼저 실행하라');

  // ⑤ 정비사업을 이번에 낼지. 판정은 ingest.mjs 가 직전 data.js 와 대조해 남긴다.
  // ⑥ 가격 — 매주 고정이지만 캐시가 없으면 블록이 비어 있다. 그때는 렌더하지 않는다
  // (빈 그림을 내보내느니 그 주는 빠지는 편이 낫다). manifest 가 사실을 알린다.
  const price = await page.evaluate(() => {
    const p = window.__DASHBOARD_DATA__?.report?.price;
    return p ? { asOf: p.asOf, prevAsOf: p.prevAsOf, sourceLabel: p.sourceLabel,
                 stale: !!p.stale, seoulPct: p.seoul?.pct ?? null } : null;
  });

  const rebuild = await page.evaluate(() => {
    const r = window.__DASHBOARD_DATA__?.report?.rebuild;
    return r ? { changed: !!r.changed, news: r.counts?.news ?? 0, cancels: r.counts?.cancels ?? 0,
                 signature: r.signature ?? null } : null;
  });
  const includeRebuild = !!(rebuild && rebuild.changed);
  const weekly = price ? WEEKLY_BLOCKS : WEEKLY_BLOCKS.filter(b => b.slot !== '06');
  if (!price) console.log('  ⑥ 가격 생략 — 가격 캐시가 없다');
  else console.log(`  ⑥ 가격 포함 — ${price.asOf} 기준 · 서울 ${price.seoulPct >= 0 ? '+' : ''}${price.seoulPct}%`
                   + (price.stale ? ' (이번 주 발표 없음 — 직전 기준 유지)' : ''));
  const BLOCKS = includeRebuild ? [...weekly, REBUILD_BLOCK] : weekly;
  console.log(includeRebuild
    ? `  ⑤ 정비사업 포함 — 신규 ${rebuild.news} / 해제 ${rebuild.cancels} (직전 수집 대비 변경 있음)`
    : `  ⑤ 정비사업 생략 — ${rebuild ? '직전 수집 대비 변경 없음' : '정비사업 데이터 없음'}`);

  await page.click('#btnReport');

  // 폰트가 붙기 전에 찍으면 글자가 대체 글꼴로 남는다. 폰트와 렌더를 모두 기다린다.
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

  mkdirSync(OUT_DIR, { recursive: true });
  const saved = [];
  for (const { id, file, slot } of BLOCKS) {
    const el = await page.$(`#${id}`);
    if (!el) throw new Error(`블록을 찾지 못했다: #${id}`);
    const box = await el.boundingBox();
    if (!box || box.width < 100 || box.height < 100) {
      throw new Error(`블록이 그려지지 않았다: #${id} (${box?.width}×${box?.height})`);
    }
    const path = join(OUT_DIR, file);
    mkdirSync(dirname(path), { recursive: true });
    await el.screenshot({ path });
    saved.push({ file, slot, w: Math.round(box.width), h: Math.round(box.height), path });
  }

  await browser.close();

  // 이번 발행에 무엇이 들어갔는지 기계가 읽을 수 있게 남긴다.
  // 뒤따르는 작업(블로그 글·알림·쇼츠)이 "이번 주에 정비사업이 있었나"를
  // 사람 눈으로 세지 않고 이 파일 하나로 판정한다.
  const generatedAt = await readGeneratedAt();
  // **다음 수집의 기준선.** "직전 data.js" 가 아니라 "마지막으로 05 를 실제로
  // 발행했을 때의 지문" 을 남긴다. 직전 data.js 를 기준으로 삼으면, 수집이
  // changed=true 인 data.js 를 커밋한 뒤 이 렌더가 실패했을 때 — 다음 수집이
  // 같은 지문끼리 비교해 changed=false 가 되고 그 변경분은 영영 나가지 못한다.
  // 발행된 것만 기준선으로 올리면 실패한 회차는 자동으로 다시 잡힌다.
  //
  // 05 를 내지 않은 회차는 직전 manifest 값을 그대로 이어받는다. 직전 manifest 가
  // 없으면(이 기능이 처음 도는 회차) 지금 지문으로 씨를 뿌린다 — 그 시점의
  // "변경 없음" 은 곧 지금 지문이 이미 발행돼 있다는 뜻이기 때문이다.
  const prevManifest = readLatestManifest();
  const curSig = rebuild ? rebuild.signature : null;
  const lastPublishedRebuildSignature = includeRebuild
    ? curSig
    : (prevManifest?.lastPublishedRebuildSignature ?? curSig);

  const manifest = {
    date: generatedAt,
    rebuildIncluded: includeRebuild,
    rebuild: rebuild ? { news: rebuild.news, cancels: rebuild.cancels } : null,
    slots: saved.map(s => s.slot).sort(),
    // 뒤따르는 작업(블로그 글·알림·쇼츠)이 읽는 창구는 이 파일 하나다.
    // 별도 알림 시스템을 두지 않는다 — 여기에 사실을 다 적는다.
    price: price ? {
      asOf: price.asOf, prevAsOf: price.prevAsOf, sourceLabel: price.sourceLabel,
      stale: price.stale, seoulPct: price.seoulPct, slot: '06',
    } : null,
    // ingest.mjs 의 readLastPublishedRebuildSignature() 가 읽는다. 사람이 보는 값이 아니다.
    lastPublishedRebuildSignature,
    note: includeRebuild
      ? '05 는 이번 수집에서 신규 지정·해제가 생겨 새로 만든 것이다'
      : '05 는 이번 주 산출물이 아니다 — 직전에 만든 것이 그대로 남아 있다',
  };
  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { saved, errors, manifest };
}

/** 직전 발행의 manifest. 없으면 null (첫 발행이거나 구버전). */
function readLatestManifest() {
  try {
    return JSON.parse(readFileSync(join(__dirname, 'reports', 'latest', 'manifest.json'), 'utf8'));
  } catch { return null; }
}

/** data.js 의 수집일. manifest 에 박아 두면 받는 쪽이 신선도를 스스로 판정한다. */
async function readGeneratedAt() {
  const src = readFileSync(join(__dirname, 'data.js'), 'utf8');
  return src.match(/"generatedAt"\s*:\s*"(\d{4}-\d{2}-\d{2})"/)?.[1] ?? null;
}

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(entry)).href; }
  catch { return false; }
})();

if (isDirectRun) {
  console.log('── 검증 ──');
  if (!verifyReport()) {
    console.error('\n검증에 실패해 이미지를 만들지 않았다. 위 항목을 고친 뒤 다시 실행하라.');
    process.exit(1);
  }

  console.log('\n── 렌더 ──');
  const { saved, errors, manifest } = await render();
  for (const s of saved) {
    console.log(`  ${s.file}  ${s.w}×${s.h} (실제 ${s.w * 2}×${s.h * 2}px, 2배)`);
  }
  console.log(`\n저장 위치: ${OUT_DIR}`);
  console.log(`manifest: ${manifest.slots.join(',')} · 정비사업 ${manifest.rebuildIncluded ? '포함' : '미포함'}`);
  if (errors.length) {
    console.error('\n페이지 오류가 있었다:');
    errors.forEach(e => console.error('  ' + e));
    process.exit(1);
  }
  console.log('콘솔 오류 0건');
}
