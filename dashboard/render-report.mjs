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
import { mkdirSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyReport } from './verify-report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = pathToFileURL(join(__dirname, 'dashboard.html')).href;
const OUT_DIR = join(__dirname, 'out');

// 파일명 앞에 항목 번호를 둔다 — 폴더에서 정렬하면 리포트 순서 그대로 선다.
const BLOCKS = [
  { id: 'rptBlock1', file: '01-신고가신저가.png' },
  { id: 'rptBlock2', file: '02-거래1위.png' },
  { id: 'rptBlock3', file: '03-비아파트.png' },
  { id: 'rptBlock4', file: '04-정비사업.png' },
];

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

  await page.click('#btnReport');

  // 폰트가 붙기 전에 찍으면 글자가 대체 글꼴로 남는다. 폰트와 렌더를 모두 기다린다.
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

  mkdirSync(OUT_DIR, { recursive: true });
  const saved = [];
  for (const { id, file } of BLOCKS) {
    const el = await page.$(`#${id}`);
    if (!el) throw new Error(`블록을 찾지 못했다: #${id}`);
    const box = await el.boundingBox();
    if (!box || box.width < 100 || box.height < 100) {
      throw new Error(`블록이 그려지지 않았다: #${id} (${box?.width}×${box?.height})`);
    }
    const path = join(OUT_DIR, file);
    await el.screenshot({ path });
    saved.push({ file, w: Math.round(box.width), h: Math.round(box.height), path });
  }

  await browser.close();
  return { saved, errors };
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
  const { saved, errors } = await render();
  for (const s of saved) {
    console.log(`  ${s.file}  ${s.w}×${s.h} (실제 ${s.w * 2}×${s.h * 2}px, 2배)`);
  }
  console.log(`\n저장 위치: ${OUT_DIR}`);
  if (errors.length) {
    console.error('\n페이지 오류가 있었다:');
    errors.forEach(e => console.error('  ' + e));
    process.exit(1);
  }
  console.log('콘솔 오류 0건');
}
