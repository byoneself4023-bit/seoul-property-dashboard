// verify-simplicity.mjs
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
const checks = {
  '5-b 차트 2개': r.canvases === 2,
  '5-c 컨트롤 6개 이하': r.controls <= 6,
  '5-e 스크롤 1.5배 이하': r.scrollRatio <= 1.5,
  '5-f 외부 리소스 2개 이하': r.externalScripts <= 2,
  '무효 클래스 0건': !r.invalidClasses,
  '콘솔 에러 0건': errors.length === 0,
};
console.table(checks);
const pass = Object.values(checks).every(Boolean);
console.log(pass ? 'PASS' : 'FAIL');
await browser.close();
process.exit(pass ? 0 : 1);
