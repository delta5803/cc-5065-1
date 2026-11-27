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

// Resolve puppeteer from the usual places: an in-repo install, or an external
// install passed via PUPPETEER_DIR (used when the repo has no node_modules).
let puppeteer;
try {
  puppeteer = (await import('puppeteer')).default;
} catch {
  const ext = process.env.PUPPETEER_DIR || '/tmp/uitest/node_modules/puppeteer';
  puppeteer = (await import(path.join(ext, 'lib/puppeteer/puppeteer.js'))).default;
}

const server = spawn(process.execPath, [path.join(root, 'tools/serve.js'), String(PORT)], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
server.stderr.on('data', d => process.stderr.write(`[server!] ${d}`));

await delay(600);

// CHROME_PATH wins; otherwise ask puppeteer where it installed Chrome.
const CHROME = process.env.CHROME_PATH ||
  (typeof puppeteer.executablePath === 'function'
    ? await puppeteer.executablePath()
    : '/tmp/chrome-arm/chrome-linux-arm64/chrome');

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

// Wait until the worker has fully finished the previous run: the UI keeps Start
// disabled until the worker posts 'done' after a cancel, so this guarantees the
// next Start click will not be dropped by the worker's running guard.
async function waitIdle(page, timeout = 60000) {
  await page.waitForFunction(() => {
    const s = document.querySelector('#start');
    const t = document.querySelector('#stop');
    return s && !s.disabled && t && t.disabled;
  }, { timeout });
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
  await waitIdle(page);

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
  await waitIdle(page);
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
  await waitIdle(page);
  check(true, 're-ran with a larger light board');

  // ---- Discrete mirror lobe through the real UI ----
  // Small light + grazing angle, deltaMix = 0.5: the event-split panel must show
  // that the same shading point carries BOTH a continuous density and a discrete
  // (point-mass) event, and run-health must report a lighting image + measured
  // noise. This drives the refactored probability interface via the browser.
  await page.evaluate(() => {
    const set = (id, v) => {
      const el = document.querySelector(id);
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('#light-scale', 0.4);
    set('#light-shift', 0.2);
    set('#sphere-delta', 0.5);
  });
  await page.click('#apply-scene');
  await delay(800);
  await page.click('[data-strategy="combined"]');
  await page.evaluate(() => {
    const spp = document.querySelector('#spp');
    spp.value = '8';
    spp.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => !document.querySelector('#start').disabled, { timeout: 15000 });
  await page.click('#start');
  await page.waitForFunction(() => document.querySelector('#start').disabled, { timeout: 10000 });
  console.log('   delta run started (start button engaged)');
  await page.waitForFunction(() => {
    const h = document.querySelector('#health-out');
    const l = document.querySelector('#lobe-out');
    return h && /noise measured:\s*yes/i.test(h.textContent) &&
           l && /discrete/i.test(l.textContent);
  }, { timeout: 90000 });
  const split = await page.evaluate(() => ({
    lobe: document.querySelector('#lobe-out').textContent,
    health: document.querySelector('#health-out').textContent,
    noise: document.querySelector('#m-noise').textContent,
    mean: document.querySelector('#m-mean').textContent,
  }));
  console.log('   event split:', split.lobe.replace(/\s+/g, ' ').trim());
  console.log('   run health :', split.health.replace(/\s+/g, ' ').trim());
  const contM = split.lobe.match(/continuous energy\s*([-\d.eE]+)/);
  const deltaM = split.lobe.match(/discrete.*?energy\s*([-\d.eE]+)/);
  const contE = contM ? parseFloat(contM[1]) : NaN;
  const deltaE = deltaM ? parseFloat(deltaM[1]) : NaN;
  check(Number.isFinite(contE) && contE > 0, `continuous density carries energy (${contE})`);
  check(Number.isFinite(deltaE) && deltaE > 0, `discrete point-mass event carries energy (${deltaE})`);
  check(/discrete lobe active/i.test(split.health), 'run-health reports the discrete lobe active');
  check(/lighting image:\s*yes/i.test(split.health), 'run-health reports a lighting image');
  check(/noise measured:\s*yes/i.test(split.health), 'run-health reports measured noise');
  check(parseFloat(split.noise) > 0, `relative noise is a positive percentage (${split.noise})`);
  check(!/⚠/.test(split.health), 'run-health flags no anomalies for the delta scene');
  await page.click('#stop');
  await waitIdle(page);

  // ---- Moving the area light changes image AND noise ----
  const imageSignature = () => page.evaluate(() => {
    const c = document.querySelector('#view-image');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 97) s += d[i] * ((i % 251) + 1);
    return s;
  });
  const sigMovedA = await imageSignature();
  const meanMovedA = await page.evaluate(() => document.querySelector('#m-mean').textContent);

  await page.evaluate(() => {
    const el = document.querySelector('#light-shift');
    el.value = '-0.4';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#apply-scene');
  await delay(800);
  await page.waitForFunction(() => !document.querySelector('#start').disabled, { timeout: 15000 });
  await page.click('#start');
  // Wait until the canvas shows the moved-light image AND the new run has
  // emitted at least two passes (noise is measured from independent passes).
  // Pass 1 resets #m-noise to '—' when it redraws the image, so a positive '%'
  // here can only come from this run, not the previous one.
  await page.waitForFunction((prev) => {
    const c = document.querySelector('#view-image');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 97) s += d[i] * ((i % 251) + 1);
    const m = document.querySelector('#m-noise');
    return s !== prev && m && /^\d+(\.\d+)?%$/.test(m.textContent);
  }, { timeout: 90000 }, sigMovedA);
  const sigMovedB = await imageSignature();
  const noiseMoved = await page.evaluate(() => document.querySelector('#m-noise').textContent);
  const meanMovedB = await page.evaluate(() => document.querySelector('#m-mean').textContent);
  await page.click('#stop');
  await waitIdle(page);
  console.log(`   moved light: mean ${meanMovedA} -> ${meanMovedB}, noise ${split.noise} -> ${noiseMoved}`);
  check(sigMovedA > 0 && sigMovedB > 0, 'both lighting images are non-blank after moving the light');
  check(sigMovedA !== sigMovedB, 'moving the area light changes the rendered image');
  check(/^\d+(\.\d+)?%$/.test(noiseMoved) && parseFloat(noiseMoved) > 0,
    'moving the light still reports measured noise');

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
