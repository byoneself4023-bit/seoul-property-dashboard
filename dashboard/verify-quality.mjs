// verify-quality.mjs
// 품질 게이트 — 수량/밀도 제한(차트·컨트롤 개수, 스크롤 비율)은 요구 갱신으로 폐기하고
// 진짜 품질 불변식(무효 클래스·콘솔 에러·원격 리소스 규율·모바일 폭 미깨짐)만 PASS/FAIL로 강제한다.
// (구 verify-simplicity.mjs에서 개정: 카토그램·타임라인·3모드 등 UI 확장을 허용하기 위함)
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// dashboard.html은 이 스크립트와 같은 dashboard/ 폴더에 위치 (CWD 무관)
const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = 'file://' + join(__dirname, 'dashboard.html');
const browser = await puppeteer.launch();

// ── 데스크톱(1280) 검사 ──
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
await page.goto(DASHBOARD, { waitUntil: 'networkidle0' });
const r = await page.evaluate(() => ({
  scrollRatio: document.body.scrollHeight / window.innerHeight,
  controls: document.querySelectorAll('button, [role="button"], select, input').length,
  canvases: document.querySelectorAll('canvas').length,
  // 외부(원격) 리소스만 센다 — 로컬 상대경로(data.js 등)는 CDN 의존이 아니므로 제외.
  // 2026-08-12 데이터 분리로 <script src="data.js"> 가 생겼는데, 이걸 CDN으로 세면
  // 게이트의 의도("신규 CDN 금지")와 어긋난다.
  remoteResources: [...document.querySelectorAll('script[src], link[rel="stylesheet"][href]')]
    .map(el => el.getAttribute('src') || el.getAttribute('href') || '')
    .filter(v => /^(https?:)?\/\//.test(v)).length,
  localScripts: [...document.querySelectorAll('script[src]')]
    .map(el => el.getAttribute('src') || '')
    .filter(v => !/^(https?:)?\/\//.test(v)),
  invalidClasses: document.body.innerHTML.includes('slate-850') || document.body.innerHTML.includes('min-height-screen'),
}));

// ── 모바일(390) 검사: 가로 오버플로(레이아웃 깨짐) 감지 ──
const mobile = await browser.newPage();
await mobile.setViewport({ width: 390, height: 780 });
await mobile.goto(DASHBOARD, { waitUntil: 'networkidle0' });
const m = await mobile.evaluate(() => ({
  overflowX: document.documentElement.scrollWidth - window.innerWidth,
}));
const mobileOk = m.overflowX <= 2; // 2px 반올림 허용

// 품질 불변식 (PASS/FAIL 강제)
const checks = {
  '무효 클래스 0건 (slate-850/min-height-screen)': !r.invalidClasses,
  '원격 리소스 0건 (CDN 의존 금지 — Tailwind·Chart.js는 인라인 유지)': r.remoteResources === 0,
  '콘솔 에러 0건': errors.length === 0,
  '모바일 폭(≤400px) 가로 미깨짐': mobileOk,
};

// 정보용 지표 (수량/밀도 제한 폐기 — 실패 조건 아님)
console.log('── 참고 지표 (게이트 아님) ──');
console.table({
  '차트(canvas) 수': r.canvases,
  '컨트롤 수': r.controls,
  '스크롤 비율': Number(r.scrollRatio.toFixed(2)),
  '모바일 가로 오버플로(px)': m.overflowX,
  '로컬 스크립트': r.localScripts.join(', ') || '(없음)',
});

console.log('── 품질 게이트 ──');
console.table(checks);
const pass = Object.values(checks).every(Boolean);
if (!pass && errors.length) console.log('콘솔 에러:', errors);
console.log(pass ? 'PASS' : 'FAIL');
await browser.close();
process.exit(pass ? 0 : 1);
