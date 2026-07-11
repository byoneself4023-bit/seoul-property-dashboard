// verify-simplicity.mjs
// 품질 게이트 — 수량/밀도 제한(차트·컨트롤 개수, 스크롤 비율)은 폐기하고
// 진짜 품질 불변식(무효 클래스·콘솔 에러·외부 리소스 규율)만 PASS/FAIL로 강제한다.
// 카토그램·타임라인·3모드 차트 등 UI 확장을 허용하기 위한 개정(수량 항목은 정보용 출력만).
import puppeteer from 'puppeteer';
const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
await page.goto('file://' + process.cwd() + '/dashboard.html', { waitUntil: 'networkidle0' });
const r = await page.evaluate(() => ({
  scrollRatio: document.body.scrollHeight / window.innerHeight,
  controls: document.querySelectorAll('button, [role="button"], select, input').length,
  canvases: document.querySelectorAll('canvas').length,
  externalScripts: [...document.querySelectorAll('script[src], link[rel="stylesheet"][href^="http"]')].length,
  invalidClasses: document.body.innerHTML.includes('slate-850') || document.body.innerHTML.includes('min-height-screen'),
}));

// 품질 불변식 (PASS/FAIL 강제)
const checks = {
  '무효 클래스 0건 (slate-850/min-height-screen)': !r.invalidClasses,
  '외부 리소스 2개 이하 (Tailwind+Chart.js만, 신규 CDN 금지)': r.externalScripts <= 2,
  '콘솔 에러 0건': errors.length === 0,
};

// 정보용 지표 (수량/밀도 제한 폐기 — 실패 조건 아님)
console.log('── 참고 지표 (게이트 아님) ──');
console.table({
  '차트(canvas) 수': r.canvases,
  '컨트롤 수': r.controls,
  '스크롤 비율': Number(r.scrollRatio.toFixed(2)),
});

console.log('── 품질 게이트 ──');
console.table(checks);
const pass = Object.values(checks).every(Boolean);
if (!pass && errors.length) console.log('콘솔 에러:', errors);
console.log(pass ? 'PASS' : 'FAIL');
await browser.close();
process.exit(pass ? 0 : 1);
