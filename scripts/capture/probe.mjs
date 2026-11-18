import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1920,1080'],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 }
});
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') console.log('[page]', m.text().slice(0, 200)); });
await page.goto('http://localhost:5180/', { waitUntil: 'networkidle0', timeout: 90000 });
await new Promise((r) => setTimeout(r, 4000));
const info = await page.evaluate(() => ({ atmo: !!window.__xw?.skyScene?.domeSky?.atmosphere, gl: (() => { const c = document.createElement('canvas').getContext('webgl2'); const d = c.getExtension('WEBGL_debug_renderer_info'); return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a'; })() }));
console.log(info);
const t0 = Date.now(); await page.screenshot({ path: '/tmp/xwframes/probe.png' }); console.log('shot ms', Date.now() - t0);
await browser.close();
