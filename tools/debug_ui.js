import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = 8221;
const puppeteer = (await import('puppeteer')).default;
const server = spawn(process.execPath, [path.join(root, 'tools/serve.js'), String(PORT)], { cwd: root, stdio: 'ignore' });
await delay(500);
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/tmp/chrome-arm/chrome-linux-arm64/chrome', args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu'] });
const page = await browser.newPage();
page.on('console', m => console.log(`[console.${m.type()}]`, m.text()));
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('requestfailed', r => console.log('[reqfail]', r.url(), r.failure()?.errorText));
page.on('response', r => { if (r.status() >= 400) console.log('[http]', r.status(), r.url()); });
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0', timeout: 30000 });
await delay(2500);
const diag = await page.evaluate(() => ({
  decision: document.querySelector('#decision')?.textContent,
  status: document.querySelector('#engine-status')?.textContent,
  hasWorkerSupport: typeof Worker !== 'undefined',
}));
console.log('DIAG', JSON.stringify(diag, null, 1));
await browser.close();
server.kill('SIGTERM');
process.exit(0);
