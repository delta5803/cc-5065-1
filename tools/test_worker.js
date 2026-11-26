// Exercises ui/worker.js in Node by shimming `self`. This runs the exact
// message path the browser uses (set-scene, advance, quadrature, start,
// validate) so we can catch wiring errors without a browser.

const messages = [];
let doneResolve = null;

globalThis.self = {
  postMessage(m) {
    messages.push(m);
    if (m.type === 'done' || m.type === 'validate' || m.type === 'error') {
      if (doneResolve) doneResolve(m);
    }
  },
  onmessage: null,
};

await import('../ui/worker.js');

const send = (m) => self.onmessage({ data: m });
const waitType = (type, timeout = 120000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeout);
  const check = () => {
    const idx = messages.findIndex(mm => mm.type === type);
    if (idx >= 0) {
      clearTimeout(t);
      const m = messages.splice(idx, 1)[0];
      resolve(m);
    } else {
      setTimeout(check, 20);
    }
  };
  check();
});

const cfg = {
  width: 96, height: 64,
  lightScale: 1, lightShift: 0,
  roughness: 0.18, metallic: 0.85,
  zone: { u0: 0.12, u1: 0.62, v0: 0.10, v1: 0.92 },
};

send({ type: 'set-scene', cfg });
const ready = await waitType('scene-ready');
console.log('scene-ready:', JSON.stringify(ready.decision?.mode ?? 'ok'));

send({ type: 'quadrature', cfg, grid: 48 });
const q = await waitType('quadrature');
console.log('quadrature rgb length:', q.rgb.length, 'expected', 96 * 64 * 3);

send({ type: 'advance', cfg, zone: { u0: 0.2, u1: 0.75, v0: 0.2, v1: 0.85 }, policy: 'reweight' });
const dec = await waitType('decision');
console.log('decision:', dec.report.mode, dec.report.decisions.map(d => d.action));

const cfg2 = { ...cfg, zone: { u0: 0.2, u1: 0.75, v0: 0.2, v1: 0.85 } };
send({ type: 'quadrature', cfg: cfg2, grid: 40 });
await waitType('quadrature');

// Start a short run and confirm progress + done.
send({ type: 'start', cfg: cfg2, strategy: 'combined', spp: 4, passes: 3, seed: 777, recordPixel: 30 * 96 + 50 });
const p1 = await waitType('progress');
console.log('progress #1: passes', p1.passesDone, 'meanL', p1.meanL.toFixed(4), 'noise', (p1.noise * 100).toFixed(1) + '%', 'rgb', p1.rgb.length);
const done = await waitType('done');
console.log('done: passes', done.passesDone);

// Validate path (small RUNS/spp internally; may take a few seconds).
send({ type: 'validate', cfg: cfg2 });
const val = await waitType('validate', 180000);
console.log('validate rows:', val.rows.length);
for (const r of val.rows) console.log(`  ${r.strat} spp=${r.spp} mean=${r.mean.toFixed(4)} bias=${r.biasPct.toFixed(2)}% z=${r.z.toFixed(2)} sd=${r.sd.toExponential(2)}`);

// Error path: advance with an empty zone must be reported, not thrown silently.
send({ type: 'advance', cfg: cfg2, zone: { u0: 0.5, u1: 0.5, v0: 0.5, v1: 0.5 }, policy: 'reweight' });
const err = await waitType('error');
console.log('error path surfaced:', err.message.split('\n')[0]);

console.log('\nWORKER OK');
process.exit(0);
