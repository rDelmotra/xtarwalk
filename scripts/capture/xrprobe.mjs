import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const ROOT = '/tmp/xw-devbuild';
const IWER = fs.readFileSync(new URL('../../node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1920,1080'], defaultViewport: { width: 1920, height: 1080 } });
const page = await browser.newPage();
page.on('console', (m) => { if (['error', 'warn'].includes(m.type())) console.log('[page]', m.text().slice(0, 200)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message)); page.on('requestfailed', (r) => console.log('[fail]', r.url().slice(0, 160), r.failure()?.errorText)); page.on('response', (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.url().slice(0, 160)); });
await page.evaluateOnNewDocument(IWER + `;window.__dev = new IWER.XRDevice(IWER.metaQuest3, { stereoEnabled: false }); __dev.primaryInputMode = 'hand'; __dev.installRuntime(); const rs = XRSystem.prototype.requestSession; navigator.xr.requestSession = async function(...a){ const s = await rs.apply(this, a); window.__xrSession = s; return s; };`);
await page.setRequestInterception(true);
page.on('request', (req) => { const u = new URL(req.url());
  if (u.host !== 'xtarwalk.local') return u.host.includes('celestrak') ? req.abort() : req.continue();
  let p = u.pathname.endsWith('/') ? u.pathname + 'index.html' : u.pathname; const f = ROOT + decodeURIComponent(p);
  if (!fs.existsSync(f)) return req.respond({ status: 404, body: '' });
  const ext = p.split('.').pop(); req.respond({ status: 200, contentType: { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', jpg: 'image/jpeg' }[ext] ?? 'application/octet-stream', body: fs.readFileSync(f) }); });
await page.goto('http://xtarwalk.local/', { waitUntil: 'networkidle2', timeout: 90000 });
await new Promise((r) => setTimeout(r, 3000));
console.log(await page.evaluate(async () => { try { await window.__xw.startXR('immersive-vr'); } catch (e) { return 'ERR ' + e.message; }
  const d = window.__dev; d.quaternion.set(0.2588, 0, 0, 0.9659); // look up 30deg
  const r = d.hands.right; r.position.set(0.18, 1.35, -0.35); r.updatePinchValue(0);
  const l = d.hands.left; l.position.set(-0.2, 1.3, -0.35);
  return { inXR: window.__xw.state.inXR, pos: [d.position.x, d.position.y, d.position.z], hands: Object.keys(d.hands) }; }));
await new Promise((r) => setTimeout(r, 4000));
console.log(await page.evaluate(() => { const s = window.__xw; const sess = s && navigator.xr; const srcs = [...(window.__xrSession?.inputSources ?? [])]; return { srcs: srcs.map((x) => [x.handedness, !!x.hand, x.profiles]), primary: window.__dev.primaryInputMode }; }));
await page.screenshot({ path: '/tmp/xwframes/xrprobe.png' });
await browser.close();
