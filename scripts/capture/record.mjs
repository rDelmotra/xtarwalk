// Scripted demo capture: drives the real app in headless Chrome (GPU, Metal) on a FAKE clock, so every frame
// is rendered at an exact time and the motion is perfectly smooth no matter how slow the capture is.
// Usage: dev server on :5180, then `node scripts/capture/record.mjs` -> /tmp/xw-capture/frames/*.jpg
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const FPS = 30;
const STRIDE = Number(process.env.STRIDE ?? 1); // >1: quick preview, screenshot every Nth frame
const OUT = '/tmp/xw-capture/frames';
const START_SHIFT_H = Number(process.env.SHIFT_H ?? -2.5); // start the sky this many hours from now
fs.rmSync('/tmp/xw-capture', { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ---- fake clock: performance.now, Date, rAF and timers all advance only in __step(ms) ----
const SHIM = `(() => {
  const RD = Date, base = RD.now() + ${START_SHIFT_H} * 3600e3;
  let t = 0;
  performance.now = () => t;
  class FD extends RD { constructor(...a) { if (a.length) super(...a); else super(base + t); } static now() { return base + t; } }
  FD.UTC = RD.UTC; FD.parse = RD.parse; window.Date = FD;
  let raf = [], rid = 0;
  window.requestAnimationFrame = (cb) => { raf.push([++rid, cb]); return rid; };
  window.cancelAnimationFrame = (id) => { raf = raf.filter((r) => r[0] !== id); };
  let timers = [], tid = 0;
  window.setTimeout = (fn, ms = 0, ...args) => { timers.push({ id: ++tid, at: t + ms, fn, args }); return tid; };
  window.setInterval = (fn, ms = 0, ...args) => { timers.push({ id: ++tid, at: t + ms, fn, args, every: Math.max(1, ms) }); return tid; };
  window.clearTimeout = window.clearInterval = (id) => { timers = timers.filter((x) => x.id !== id); };
  window.__step = (ms) => {
    t += ms;
    for (;;) {
      const due = timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      if (due.every) due.at += due.every; else timers = timers.filter((x) => x !== due);
      try { typeof due.fn === 'function' ? due.fn(...due.args) : 0; } catch (e) { console.error(e); }
    }
    const cbs = raf; raf = [];
    for (const [, cb] of cbs) { try { cb(t); } catch (e) { console.error(e); } }
    return t;
  };
})();`;

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1920,1080', '--hide-scrollbars'],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 }
});
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.evaluateOnNewDocument(SHIM);
// serve a static dev-mode build straight from disk (no Vite client: its reconnect logic reloads under a fake clock)
// build it with: NODE_ENV=development npx vite build --mode development --outDir /tmp/xw-devbuild
const ROOT = process.env.BUILD_DIR ?? '/tmp/xw-devbuild';
const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', jpg: 'image/jpeg', png: 'image/png', exr: 'application/octet-stream', svg: 'image/svg+xml', woff2: 'font/woff2' };
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = new URL(req.url());
  if (u.host !== 'xtarwalk.local') return req.abort(); // offline capture (CelesTrak etc. are skipped)
  let p = decodeURIComponent(u.pathname); if (p.endsWith('/')) p += 'index.html';
  const file = ROOT + p;
  if (!fs.existsSync(file)) return req.respond({ status: 404, body: '' });
  req.respond({ status: 200, contentType: MIME[p.split('.').pop()] ?? 'application/octet-stream', body: fs.readFileSync(file) });
});
await page.goto('http://xtarwalk.local/', { waitUntil: 'domcontentloaded', timeout: 90000 });

// warm up: pump frames while the catalogue, sky tables, Moon map and satellites load (real network time)
for (let i = 0; i < 400; i++) {
  await page.evaluate(() => window.__step(33));
  const ready = await page.evaluate(() => !!(window.__xw?.skyScene?.domeSky?.atmosphere && window.__xw?.satellites?.points));
  if (ready && i > 60) break;
  await new Promise((r) => setTimeout(r, 40));
}

await page.addStyleTag({ path: new URL('./tour.css', import.meta.url).pathname });
await page.addScriptTag({ path: new URL('./tour.js', import.meta.url).pathname });
const total = await page.evaluate(() => window.__tour.init());
const frames = Math.round(total * FPS);
console.log(`tour ${total}s -> ${frames} frames`);
// settle the first view without recording
for (let i = 0; i < 45; i++) await page.evaluate((dt) => { window.__tour.at(0); window.__step(dt); }, 1000 / FPS);

for (let f = 0; f < frames; f++) {
  const tSec = f / FPS;
  await page.evaluate((s, dt) => { window.__tour.at(s); window.__step(dt); }, tSec, 1000 / FPS);
  if (f % STRIDE) continue;
  await page.screenshot({ path: `${OUT}/${String(f).padStart(5, '0')}.jpg`, type: 'jpeg', quality: 92 });
  if (f % 150 === 0) console.log(`frame ${f}/${frames}`);
}
await browser.close();
console.log('done');
