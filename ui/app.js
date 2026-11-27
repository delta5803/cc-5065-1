// UI controller. Owns no lighting math: every image and number comes from the
// worker running the same kernel that tools/validate.js exercises headlessly.
// The worker's messages drive the result area, the region table, the decision
// log and the selected-path inspector. Worker errors are surfaced in the status
// bar and the decision panel.

import { imageToRGBA } from '../src/display.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const W = 384;
const H = 256;

const state = {
  strategy: 'combined',
  spp: 24,
  passes: 24,
  seed: 20261126,
  exposureIndex: 0,
  zone: { u0: 0.12, u1: 0.62, v0: 0.10, v1: 0.92 },
  cfg: {
    width: W,
    height: H,
    lightScale: 1,
    lightShift: 0,
    roughness: 0.18,
    metallic: 0.85,
    deltaMix: 0,
    zone: { u0: 0.12, u1: 0.62, v0: 0.10, v1: 0.92 },
  },
  running: false,
  overlay: false,
  refRGBA: null,
  lastMeanRGBA: null,
  probe: { x: 80, y: 150 },
  history: [],
};

let worker = null;
let pendingQuadrature = false;

function initWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onWorker;
  worker.onerror = (e) => {
    setEngineStatus(`Worker error: ${e.message}`, 'bad');
    stopRun();
  };
  // Kick off the first scene build with the initial exposure.
  send({ type: 'set-scene', cfg: state.cfg });
}

function send(msg) {
  if (!worker) return;
  worker.postMessage(msg);
}

function cfgSnapshot() {
  return {
    ...state.cfg,
    zone: { ...state.zone },
    lightScale: state.cfg.lightScale,
    lightShift: state.cfg.lightShift,
    roughness: state.cfg.roughness,
    metallic: state.cfg.metallic,
    deltaMix: state.cfg.deltaMix,
    width: W,
    height: H,
  };
}

// ---------- worker message handling ----------

function onWorker(ev) {
  const msg = ev.data;
  switch (msg.type) {
    case 'scene-ready':
      setEngineStatus(`Scene ready. Exposure ${msg.exposureIndex}.`, 'good');
      renderDecision(msg.decision);
      requestQuadrature();
      break;
    case 'decision':
      state.exposureIndex = msg.exposureIndex;
      renderDecision(msg.report);
      setEngineStatus(`Exposure ${msg.exposureIndex}: ${msg.report.mode}`, 'good');
      requestQuadrature();
      break;
    case 'progress':
      renderProgress(msg);
      break;
    case 'done':
      state.running = false;
      setRunningUI(false);
      setEngineStatus(`Finished ${msg.passesDone} pass(es).`, 'good');
      break;
    case 'quadrature':
      state.quadrature = msg;
      renderEnergyTable(state.lastRegionEnergy, msg.regionEnergy);
      break;
    case 'audit':
      renderAudit(msg.result);
      break;
    case 'validate':
      renderValidate(msg.rows, msg);
      break;
    case 'error':
      setEngineStatus('Engine error', 'bad');
      renderError(msg.message);
      // An error can abort a run without the worker posting 'done'; recover the
      // controls directly so Start is not left disabled forever.
      send({ type: 'stop' });
      state.running = false;
      setRunningUI(false);
      break;
    default:
      break;
  }
}

// ---------- rendering ----------

const imageCanvas = $('#view-image');
const overlayCanvas = $('#view-overlay');
const imageCtx = imageCanvas.getContext('2d');
const overlayCtx = overlayCanvas.getContext('2d');

function drawRGB(rgb, ctx) {
  const rgba = imageToRGBA(rgb, W, H, 1.1);
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), W, H), 0, 0);
}

function renderProgress(msg) {
  state.lastRegionEnergy = msg.regionEnergy;
  if (msg.records && msg.records.length) state.records = msg.records;
  drawRGB(msg.rgb, imageCtx);
  state.lastMeanRGBA = msg.rgb;
  $('#img-spp').textContent = `${msg.passesDone * msg.spp * 1} spp · pass ${msg.passesDone}/${msg.passesTotal}`;
  $('#m-mean').textContent = msg.meanL.toFixed(4);
  $('#m-noise').textContent = msg.noise == null ? '—' : `${(msg.noise * 100).toFixed(1)}%`;
  $('#m-ms').textContent = msg.ms.toFixed(0);
  $('#m-spp').textContent = String(msg.passesDone * msg.spp);
  $('#progress-bar').style.width = `${(msg.passesDone / msg.passesTotal) * 100}%`;
  if (state.quadrature) renderEnergyTable(msg.regionEnergy, state.quadrature.regionEnergy);
  renderLobes(msg.lobeEnergy, msg.lobeCounts);
  renderHealth(msg.health);
  renderPaths(msg.records, msg.stats);
  if (state.overlay) requestOverlay();
}

function renderLobes(lobeEnergy, counts) {
  const el = $('#lobe-out');
  if (!el || !lobeEnergy) return;
  const mean = (v) => (v[0] + v[1] + v[2]) / 3;
  const c = mean(lobeEnergy.continuous);
  const d = mean(lobeEnergy.delta);
  el.innerHTML =
    `continuous energy <b>${c.toFixed(3)}</b> (${counts ? counts.continuous : 0} hits) · ` +
    `discrete Δ energy <b>${d.toFixed(3)}</b> (${counts ? counts.delta : 0} hits)`;
}

function renderHealth(health) {
  const el = $('#health-out');
  if (!el || !health) return;
  const im = health.lightingImage ? 'yes' : 'no';
  const nm = health.noiseMeasured ? 'yes' : 'no';
  const lines = [
    `lighting image: <b>${im}</b> · noise measured: <b>${nm}</b>` +
    (health.deltaActive ? ' · discrete lobe active' : ''),
  ];
  if (health.issues && health.issues.length) {
    for (const issue of health.issues) {
      const cls = health.finite ? 'warn' : 'bad';
      lines.push(`<span class="${cls}">⚠ ${escapeHtml(issue)}</span>`);
    }
  }
  el.innerHTML = lines.join('<br>');
}

function renderEnergyTable(sampler, quad) {
  const tbody = $('#energy-table tbody');
  if (!sampler || !quad) {
    tbody.innerHTML = '<tr><td colspan="4" class="hint">Run sampling to compare regions.</td></tr>';
    return;
  }
  const rows = [];
  for (const k of ['bright', 'shared', 'newOnly', 'oldOnly', 'dark']) {
    const q = quad[k];
    const s = sampler[k];
    if (!q || !s) continue;
    const qm = (q[0] + q[1] + q[2]) / 3;
    const sm = (s[0] + s[1] + s[2]) / 3;
    if (qm < 1e-7 && sm < 1e-7) continue;
    const rel = qm > 1e-7 ? (sm - qm) / qm : 0;
    const cls = Math.abs(rel) < 0.06 ? 'good' : 'bad';
    rows.push(
      `<tr><td>${k}</td><td>${qm.toFixed(3)}</td><td>${sm.toFixed(3)}</td>` +
      `<td class="delta ${cls}">${(rel * 100).toFixed(1)}%</td></tr>`,
    );
  }
  // A whole-image agreement can hide a compensating per-region pair; if any
  // region is off while the total is fine, say so explicitly.
  let totalQ = 0;
  let totalS = 0;
  for (const k of ['bright', 'shared', 'newOnly', 'oldOnly', 'dark']) {
    const q = quad[k];
    const s = sampler[k];
    if (!q || !s) continue;
    totalQ += (q[0] + q[1] + q[2]) / 3;
    totalS += (s[0] + s[1] + s[2]) / 3;
  }
  const totalRel = totalQ > 1e-7 ? Math.abs(totalS - totalQ) / totalQ : 0;
  const anyRegionBad = rows.some(r => r.includes('delta bad'));
  const note = anyRegionBad && totalRel < 0.05
    ? '<tr><td colspan="4" class="hint bad">Regions disagree while the total agrees — a cancellation; inspect per-region rows.</td></tr>'
    : '';
  tbody.innerHTML = rows.join('') + note;
}

function renderDecision(report) {
  if (!report) { $('#decision').textContent = '—'; return; }
  const parts = [];
  parts.push(`<div><span class="act">mode: ${report.mode}</span></div>`);
  for (const d of report.decisions) {
    parts.push(`<div><span class="act">${d.action}</span><span class="why">${d.reason || ''}</span></div>`);
  }
  if (report.coverage) {
    const cov = report.coverage.map(c =>
      `  · w=${c.weight.toFixed(2)}${c.isCurrent ? ' current' : ' history'} covers=${c.coversNewZone} uncovered=${c.uncoveredArea.toFixed(4)}`,
    ).join('\n');
    parts.push(`<div class="why" style="white-space:pre-wrap">${cov}</div>`);
  }
  $('#decision').innerHTML = parts.join('');
}

function renderPaths(records, stats) {
  const el = $('#path-list');
  if (!records || records.length === 0) {
    el.textContent = 'No paths recorded at the probe pixel yet (it may be background or on the light board).';
    return;
  }
  const html = records.map((r) => {
    const tag = `<span class="tag ${r.technique}">${r.technique}</span>`;
    const wsum = (r.contribution[0] + r.contribution[1] + r.contribution[2]) / 3;
    const pill = r.reason ? `<span class="why">${r.reason}</span>` : '';
    return (
      `<div class="path">${tag} <span class="kv">region <b>${r.region}</b> · ` +
      `w <b>${r.weight.toFixed(3)}</b> · pL <b>${r.pL_area.toExponential(2)}</b> · ` +
      `pΩ <b>${r.pOmega.toExponential(2)}</b> · pM(area) <b>${r.pM_area.toExponential(2)}</b> · ` +
      `cosY <b>${r.cosY.toFixed(2)}</b> · dist <b>${r.dist.toFixed(2)}</b> · ` +
      `contrib <b>${wsum.toExponential(2)}</b></span>${pill}</div>`
    );
  }).join('');
  el.innerHTML = html;
}

function renderAudit(a) {
  const el = $('#audit-out');
  el.classList.remove('good', 'bad', 'warn');
  // Judge each estimator on its POOLED mean over independent seeds, counted in
  // standard errors of that mean. A heavy-tailed technique's single run can be
  // far off from variance alone; only a deviation that survives averaging runs
  // indicates bias. z<2 consistent, 2..3 inconclusive, >=3 evidence of bias.
  const tone = (z) => (Math.abs(z) < 2 ? 'good' : Math.abs(z) < 3 ? 'warn' : 'bad');
  const zMsg = (z) =>
    Math.abs(z) < 2 ? 'consistent with reference'
      : Math.abs(z) < 3 ? 'inconclusive — increase spp/runs'
        : 'exceeds sampling error — investigate bias';
  const worst = Math.abs(a.areaZ) >= Math.abs(a.solidZ) ? tone(a.areaZ) : tone(a.solidZ);
  el.innerHTML =
    `reference (quadrature) L=<b>${a.reference.toFixed(4)}</b> · ${a.pixels} px · ` +
    `${a.runs} independent seeds × ${a.spp} spp<br>` +
    `area-measure (light) ↦ L=<b>${a.areaEstimate.toFixed(4)}</b> · ` +
    `${(a.areaRelVsRef * 100).toFixed(2)}% off · sd ${a.areaSd.toFixed(3)} · z=<b>${a.areaZ.toFixed(2)}</b><br>` +
    `solid-angle (material) ↦ L=<b>${a.solidAngleEstimate.toFixed(4)}</b> · ` +
    `${(a.solidRelVsRef * 100).toFixed(2)}% off · sd ${a.solidSd.toFixed(3)} · z=<b>${a.solidZ.toFixed(2)}</b><br>` +
    `<span class="${worst}">light: ${zMsg(a.areaZ)}; material: ${zMsg(a.solidZ)}</span><br>` +
    `Jacobian: ${a.jacobianForm}`;
  el.classList.add(worst);
}

function renderValidate(rows, meta) {
  const el = $('#validate-out');
  const lines = rows.map(r =>
    `${r.strat.padEnd(8)} spp=${String(r.spp).padStart(3)} bias=${r.biasPct.toFixed(2).padStart(6)}% ` +
    `z=${r.z.toFixed(2).padStart(5)} sd=${r.sd.toExponential(2)} rmse=${r.rmse.toExponential(2)}`,
  );
  const flagged = rows.some(r => Math.abs(r.z) >= 3);
  const ref = meta || {};
  el.innerHTML =
    `<pre style="margin:0;font-size:10px;color:var(--text)">${lines.join('\n')}</pre>` +
    `<div class="hint ${flagged ? 'warn' : 'good'}">` +
    (flagged
      ? 'At least one row is >3σ from the quadrature; raise spp before concluding bias.'
      : 'All rows within 3σ — consistent with unbiased at this sample count.') +
    ` ${ref.runs != null ? `${ref.runs} seeds × 96×64; ` : ''}` +
    `reference quadrature grid ${ref.grid ?? '—'}, own uncertainty ±` +
    `${ref.refUncertainty != null ? (ref.refUncertainty * 100).toFixed(3) + '%' : '—'}` +
    ' (folded into z). A bias survives more seeds; variance does not.</div>';
}

function renderError(message) {
  const el = $('#decision');
  el.innerHTML = `<div><span class="act" style="color:var(--bad)">engine error</span>` +
    `<span class="why" style="white-space:pre-wrap">${escapeHtml(message)}</span></div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- overlay (error vs fixed-seed reference) ----------

function requestOverlay() {
  if (!state.quadrature || !state.lastMeanRGBA) return;
  const ref = state.quadrature.rgb;
  const mean = state.lastMeanRGBA;
  const img = overlayCtx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const a = (mean[i * 3] + mean[i * 3 + 1] + mean[i * 3 + 2]) / 3;
    const b = (ref[i * 3] + ref[i * 3 + 1] + ref[i * 3 + 2]) / 3;
    const rel = Math.abs(a - b) / Math.max(1e-6, Math.abs(b) + 1e-3);
    const t = Math.min(1, rel / 0.5);
    // blue (agree) -> red (disagree)
    img.data[i * 4] = 40 + t * 215;
    img.data[i * 4 + 1] = 60 + (1 - t) * 120;
    img.data[i * 4 + 2] = 200 * (1 - t) + 30;
    img.data[i * 4 + 3] = 210;
  }
  overlayCtx.putImageData(img, 0, 0);
}

function requestQuadrature() {
  if (pendingQuadrature) return;
  pendingQuadrature = true;
  send({ type: 'quadrature', cfg: cfgSnapshot(), grid: 72 });
  setTimeout(() => { pendingQuadrature = false; }, 200);
}

// ---------- controls ----------

function setEngineStatus(text, tone) {
  const el = $('#engine-status');
  el.textContent = text;
  el.style.color = tone === 'bad' ? 'var(--bad)' : tone === 'good' ? 'var(--good)' : '';
  $('#status-readout').textContent = text;
}

function setRunningUI(running) {
  state.running = running;
  $('#start').disabled = running;
  $('#stop').disabled = !running;
}

function stopRun() {
  // The worker finishes its current pass before it honours 'stop' (renderImage
  // is synchronous). Re-enabling Start here would let a click land while the
  // worker still has state.running = true, where it is silently dropped. Keep
  // Start disabled until the worker posts 'done'; there is no ordering hazard
  // because 'done' always follows a cancel.
  send({ type: 'stop' });
  $('#stop').disabled = true;
}

const RANGE_FORMAT = {
  'light-scale': (n) => `${n.toFixed(2)}×`,
  'light-shift': (n) => n.toFixed(2),
  'sphere-rough': (n) => n.toFixed(2),
  'sphere-metal': (n) => n.toFixed(2),
  'sphere-delta': (n) => n.toFixed(2),
  'boundary-u0': (n) => n.toFixed(2),
  'boundary-u1': (n) => n.toFixed(2),
  'boundary-v1': (n) => n.toFixed(2),
  spp: (n) => String(Math.round(n)),
  'probe-x': (n) => String(Math.round(n)),
  'probe-y': (n) => String(Math.round(n)),
};

function bindRange(id, onChange) {
  const el = $(`#${id}`);
  const out = $(`#${id}-out`);
  const fmt = RANGE_FORMAT[id] || ((n) => String(n));
  const update = () => {
    const n = parseFloat(el.value);
    out.textContent = fmt(n);
    if (onChange) onChange(n);
  };
  el.addEventListener('input', update);
  update();
  return el;
}

function startSampling() {
  if (state.running) return;
  const cfg = cfgSnapshot();
  state.passes = Math.max(1, Math.round(256 / Math.max(1, state.spp)));
  setRunningUI(true);
  setEngineStatus('Sampling…', '');
  const probePix = state.probe.y * W + state.probe.x;
  send({
    type: 'start',
    cfg,
    strategy: state.strategy,
    spp: state.spp,
    passes: state.passes,
    seed: state.seed,
    recordPixel: probePix,
  });
}

function applyScene() {
  state.cfg.lightScale = parseFloat($('#light-scale').value);
  state.cfg.lightShift = parseFloat($('#light-shift').value);
  state.cfg.roughness = parseFloat($('#sphere-rough').value);
  state.cfg.metallic = parseFloat($('#sphere-metal').value);
  const dm = $('#sphere-delta');
  if (dm) state.cfg.deltaMix = parseFloat(dm.value);
  send({ type: 'set-scene', cfg: cfgSnapshot() });
  setEngineStatus('Rebuilding scene…', '');
}

function setNewExposure() {
  const u0 = Math.min(parseFloat($('#boundary-u0').value), parseFloat($('#boundary-u1').value) - 0.02);
  const u1 = Math.max(parseFloat($('#boundary-u1').value), u0 + 0.02);
  const v1 = parseFloat($('#boundary-v1').value);
  const zone = {
    u0: Math.max(0.01, Math.min(u0, 0.98)),
    u1: Math.min(0.99, u1),
    v0: Math.max(0.01, Math.min(state.zone.v0, v1 - 0.02)),
    v1: Math.min(0.99, v1),
  };
  state.zone = zone;
  state.cfg.zone = zone;
  send({ type: 'advance', cfg: cfgSnapshot(), zone, policy: 'reweight' });
  setEngineStatus('New exposure boundary applied.', '');
}

function bindControls() {
  bindRange('boundary-u0', null);
  bindRange('boundary-u1', null);
  bindRange('boundary-v1', null);
  bindRange('light-scale', null);
  bindRange('light-shift', null);
  bindRange('sphere-rough', null);
  bindRange('sphere-metal', null);
  bindRange('sphere-delta', (v) => { state.cfg.deltaMix = v; });
  bindRange('spp', (v) => { state.spp = Math.max(1, Math.round(v)); });
  bindRange('probe-x', (v) => { state.probe.x = Math.round(v); });
  bindRange('probe-y', (v) => { state.probe.y = Math.round(v); });

  $$('.seg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.seg button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.strategy = btn.dataset.strategy;
    });
  });

  $('#new-exposure').addEventListener('click', setNewExposure);
  $('#apply-scene').addEventListener('click', applyScene);
  $('#start').addEventListener('click', startSampling);
  $('#stop').addEventListener('click', stopRun);

  $('#show-ref').addEventListener('click', () => {
    state.overlay = !state.overlay;
    overlayCanvas.classList.toggle('hidden', !state.overlay);
    if (state.overlay) requestOverlay();
  });

  $('#run-audit').addEventListener('click', () => {
    $('#audit-out').textContent = 'Auditing measures…';
    $('#audit-out').classList.remove('good', 'bad');
    send({ type: 'audit', cfg: cfgSnapshot(), spp: 256 });
  });

  $('#validate').addEventListener('click', () => {
    $('#validate-out').textContent = 'Running independent seeds…';
    setEngineStatus('Validating unbiasedness…', '');
    send({ type: 'validate', cfg: cfgSnapshot() });
  });
}

function boot() {
  bindControls();
  initWorker();
}

boot();
