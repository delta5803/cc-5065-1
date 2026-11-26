// Browser smoke test for the experiment window. Launches the static server,
// opens the page with Puppeteer, drives the real controls, and fails on any
// console error or on missing results. This is how the UI is verified without a
// human clicking through it.
//
//   node tools/browser_test.js
//
// Requires a Puppeteer-managed Chrome (npx puppeteer browsers install chrome).

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8213);

const puppeteer = (await import('puppeteer')).default;

const server = spawn(process.execPath, [path.join(root, 'tools/serve.js'), String(PORT)], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
server.stderr.on('data', d => process.stderr.write(`[server!] ${d}`));

await delay(600);

const CHROME =
  process.env.CHROME_PATH ||
  '/tmp/chrome-arm/chrome-linux-arm64/chrome';

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

let failed = false;
function check(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed = true;
}

try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForSelector('#start', { timeout: 10000 });

  // Wait for the initial decision to render.
  await page.waitForFunction(() => {
    const t = document.querySelector('#decision');
    return t && /initial|current|mode/i.test(t.textContent);
  }, { timeout: 15000 });
  check(true, 'initial decision rendered');

  // Set a small sample count and start sampling.
  await page.evaluate(() => {
    const spp = document.querySelector('#spp');
    spp.value = '4';
    spp.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#start');

  // Wait for non-trivial image: metric mean changes from dash and img badge updates.
  await page.waitForFunction(() => {
    const m = document.querySelector('#m-mean');
    const badge = document.querySelector('#img-spp');
    return m && m.textContent !== '—' && badge && /\d/.test(badge.textContent);
  }, { timeout: 60000 });
  check(true, 'sampling produced an image and metrics');

  const metrics = await page.evaluate(() => ({
    mean: document.querySelector('#m-mean').textContent,
    noise: document.querySelector('#m-noise').textContent,
    spp: document.querySelector('#m-spp').textContent,
    img: document.querySelector('#img-spp').textContent,
    energyRows: document.querySelectorAll('#energy-table tbody tr').length,
    paths: document.querySelector('#path-list').textContent,
  }));
  console.log('   metrics:', JSON.stringify(metrics));
  check(parseFloat(metrics.mean) > 0, 'mean luminance is positive (HDR image drawn)');
  check(metrics.energyRows > 0, 'per-region energy table populated');

  // The probe should show at least one successful path with a real MIS weight.
  const pathInfo = await page.evaluate(() => {
    const paths = Array.from(document.querySelectorAll('#path-list .path'));
    return paths.map(p => p.textContent.trim());
  });
  const hasGoodPath = pathInfo.some(t => /contrib [1-9]/.test(t) || /region (bright|shared|newOnly)/.test(t));
  check(pathInfo.length > 0, `probe recorded ${pathInfo.length} paths`);
  check(hasGoodPath, 'probe shows a successful light path with a region/weight');

  // Stop.
  await page.click('#stop');
  await delay(200);

  // Move the bright-zone boundary to force a discard, then shrink to force a
  // reweight. Watch the decision panel change mode.
  await page.evaluate(() => {
    const u1 = document.querySelector('#boundary-u1');
    u1.value = '0.90';
    u1.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#new-exposure');
  await page.waitForFunction(
    () => /mode:\s*discard/.test(document.querySelector('#decision').textContent),
    { timeout: 10000 },
  );
  const decGrowing = await page.evaluate(() => document.querySelector('#decision').textContent);
  console.log('   growing decision:', decGrowing.slice(0, 120));
  check(/discard|drop/i.test(decGrowing), 'growing the zone reports discard/drop of stale history');

  await page.evaluate(() => {
    const u1 = document.querySelector('#boundary-u1');
    u1.value = '0.60';
    u1.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#new-exposure');
  await page.waitForFunction(
    () => /mode:\s*(reweight|drop)[\w-]*/.test(document.querySelector('#decision').textContent),
    { timeout: 10000 },
  );
  const decShrink = await page.evaluate(() => document.querySelector('#decision').textContent);
  console.log('   shrink decision:', decShrink.slice(0, 120));
  check(/reweight|drop/i.test(decShrink), 'shrinking reports reweight/drop');

  // Switch strategy and run a couple of passes.
  await page.evaluate(() => {
    const spp = document.querySelector('#spp');
    spp.value = '4';
    spp.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('[data-strategy="material"]');
  await page.click('#start');
  await page.waitForFunction(() => {
    const badge = document.querySelector('#img-spp');
    return badge && /\d/.test(badge.textContent);
  }, { timeout: 60000 });
  await page.click('#stop');
  check(true, 'material-only strategy runs');

  // Audit + validate buttons produce text without console errors.
  await page.click('#run-audit');
  await page.waitForFunction(() => /reference/.test(document.querySelector('#audit-out').textContent), { timeout: 60000 });
  check(true, 'measure audit produced a result');

  await page.click('#validate');
  await page.waitForFunction(() => /bias/.test(document.querySelector('#validate-out').textContent), { timeout: 120000 });
  check(true, 'unbiasedness check produced rows');

  // Change scene geometry (light size) and re-run.
  await page.evaluate(() => {
    const ls = document.querySelector('#light-scale');
    ls.value = '1.4';
    ls.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#apply-scene');
  await delay(500);
  await page.click('#start');
  await page.waitForFunction(() => {
    const badge = document.querySelector('#img-spp');
    return badge && /\d/.test(badge.textContent);
  }, { timeout: 60000 });
  await page.click('#stop');
  check(true, 're-ran with a larger light board');

  const finalErrors = consoleErrors.filter(e => !/favicon/i.test(e));
  check(finalErrors.length === 0, `no console errors (${finalErrors.length})`);
  if (finalErrors.length) console.log(finalErrors.join('\n'));

  await page.screenshot({ path: path.join(root, 'tools/ui-screenshot.png'), fullPage: true });
  console.log('screenshot: tools/ui-screenshot.png');
} catch (err) {
  console.error('TEST ERROR:', err.message);
  try { await page.screenshot({ path: path.join(root, 'tools/ui-failure.png'), fullPage: true }); } catch {}
  failed = true;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}

process.exit(failed ? 1 : 0);
