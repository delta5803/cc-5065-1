// Web Worker: owns the scene, exposure controller and kernel. The UI posts
// commands; the worker streams progress and results back. Failures are
// reported as an 'error' message so they surface in the UI instead of being
// swallowed.

import { buildScene, makeCamera, cameraRay, trace } from '../src/scene.js';
import { ExposureController } from '../src/exposure.js';
import {
  renderImage, quadrature, meanLuminance, imageRMSE, auditMeasures,
} from '../src/integrator.js';

const state = {
  scene: null,
  cam: null,
  controller: null,
  width: 384,
  height: 256,
  sceneKey: '',
  running: false,
  cancelled: false,
  ref: null,
  refKey: '',
};

function sceneKey(cfg) {
  return JSON.stringify([cfg.width, cfg.height, cfg.lightScale, cfg.lightShift, cfg.roughness, cfg.metallic, cfg.deltaMix || 0, cfg.zone]);
}

// Rebuilds geometry when size/light/material change. When only the zone
// sequence changes the UI drives advance(); a geometry change resets history.
function ensureScene(cfg) {
  const key = sceneKey(cfg);
  if (state.sceneKey === key && state.scene) return;
  const geomKey = JSON.stringify([cfg.width, cfg.height, cfg.lightScale, cfg.lightShift, cfg.roughness, cfg.metallic, cfg.deltaMix || 0]);
  const prevGeom = state.geomKey;
  state.width = cfg.width;
  state.height = cfg.height;
  state.cam = makeCamera({ width: cfg.width, height: cfg.height });
  if (prevGeom !== geomKey || !state.scene) {
    state.scene = buildScene({
      lightScale: cfg.lightScale,
      lightOffset: [cfg.lightShift, 0],
      sphereMaterial: {
        roughness: cfg.roughness,
        metallic: cfg.metallic,
        deltaMix: cfg.deltaMix || 0,
      },
    });
    state.controller = new ExposureController(state.scene, cfg.zone);
    state.geomKey = geomKey;
    state.refKey = '';
  }
  state.sceneKey = key;
}

function currentExposure() {
  return state.controller.exposureFor();
}

self.onmessage = (ev) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'set-scene': {
        ensureScene(msg.cfg);
        const report = state.controller.lastDecision || {
          mode: 'initial',
          decisions: [{ action: 'initial-exposure', reason: 'the first exposure has no history; its table is the proposal' }],
          coverage: [{ weight: 1, isCurrent: true, coversNewZone: true, uncoveredArea: 0 }],
        };
        self.postMessage({ type: 'scene-ready', decision: report, exposureIndex: state.controller.exposureIndex });
        break;
      }
      case 'advance': {
        ensureScene(msg.cfg);
        const { report } = state.controller.advance(msg.zone, { policy: msg.policy || 'reweight' });
        state.refKey = '';
        self.postMessage({ type: 'decision', report, exposureIndex: state.controller.exposureIndex });
        break;
      }
      case 'start':
        startRun(msg);
        break;
      case 'stop':
        state.cancelled = true;
        break;
      case 'quadrature': {
        ensureScene(msg.cfg);
        const q = quadrature({ exposure: currentExposure(), cam: state.cam, grid: msg.grid || 72 });
        self.postMessage({ type: 'quadrature', rgb: q.rgb, regionEnergy: q.regionEnergy, width: state.width, height: state.height });
        break;
      }
      case 'audit': {
        ensureScene(msg.cfg);
        // 12 independent seeds so the pooled mean's standard error is honest for
        // these heavy-tailed estimators; 5 seeds showed occasional false z>4.
        const a = auditMeasures({
          exposure: currentExposure(), cam: state.cam,
          spp: msg.spp || 256, grid: 64, runsCount: 12,
        });
        self.postMessage({ type: 'audit', result: a });
        break;
      }
      case 'validate':
        validate(msg);
        break;
      default:
        throw new Error(`unknown message type: ${msg.type}`);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.stack ? err.stack : err) });
  }
};

function addInto(dst, src) { for (let i = 0; i < dst.length; i++) dst[i] += src[i]; }
function addSq(dst, src) { for (let i = 0; i < dst.length; i++) dst[i] += src[i] * src[i]; }
function add3(a, b) { a[0] += b[0]; a[1] += b[1]; a[2] += b[2]; }

function noiseAcrossPasses(accum, accumSq, n) {
  const px = accum.length / 3;
  let s = 0;
  for (let i = 0; i < px; i++) {
    let m = 0;
    let v = 0;
    for (let c = 0; c < 3; c++) {
      const a = accum[i * 3 + c] / n;
      const b = accumSq[i * 3 + c] / n;
      m += a;
      v += Math.max(0, b - a * a);
    }
    m /= 3;
    v /= 3;
    s += Math.sqrt(v) / Math.max(m, 0.02);
  }
  return s / px;
}

async function startRun(msg) {
  if (state.running) return;
  ensureScene(msg.cfg);
  state.running = true;
  state.cancelled = false;
  const { strategy, spp, passes, seed, recordPixel, cfg } = msg;
  const exposure = currentExposure();
  const ref = getReference(cfg, exposure);
  const accum = new Float64Array(state.width * state.height * 3);
  const accumSq = new Float64Array(state.width * state.height * 3);
  const regionAccum = { bright: [0, 0, 0], shared: [0, 0, 0], newOnly: [0, 0, 0], oldOnly: [0, 0, 0], dark: [0, 0, 0] };
  const lobeAccum = { continuous: [0, 0, 0], delta: [0, 0, 0] };
  const lobeCounts = { continuous: 0, delta: 0 };
  const stats = { lightSamples: 0, materialSamples: 0, lightZeroPdf: 0, materialZeroPdf: 0, occluded: 0, maskedHits: 0, escaped: 0 };
  let done = 0;
  let lastGood = null;
  for (let p = 0; p < passes; p++) {
    if (state.cancelled) break;
    const t0 = Date.now();
    const res = renderImage({
      exposure, cam: state.cam, spp, seed: (seed + p * 7919) >>> 0, strategy, recordPixel,
      recordLimit: 14,
    });
    addInto(accum, res.rgb);
    addSq(accumSq, res.rgb);
    for (const k of Object.keys(regionAccum)) add3(regionAccum[k], res.regionEnergy[k]);
    for (const k of Object.keys(lobeAccum)) add3(lobeAccum[k], res.lobeEnergy[k]);
    for (const k of Object.keys(lobeCounts)) lobeCounts[k] += res.counts[k] || 0;
    for (const k of Object.keys(stats)) stats[k] += res.stats[k] || 0;
    done++;
    const mean = new Float64Array(accum.length);
    for (let i = 0; i < mean.length; i++) mean[i] = accum[i] / done;
    // Cross-pass noise needs at least two independent passes; with one pass it
    // is undefined, so report null rather than a misleading 0.
    const noise = done >= 2 ? noiseAcrossPasses(accum, accumSq, done) : null;
    const regionEnergy = {};
    for (const k of Object.keys(regionAccum)) regionEnergy[k] = regionAccum[k].map(v => v / done);
    const lobeEnergy = {};
    for (const k of Object.keys(lobeAccum)) lobeEnergy[k] = lobeAccum[k].map(v => v / done);
    const meanL = meanLuminance(mean);
    // Run-health: make the "still rendering / image changing" state visible, and
    // flag the anomalies the task calls out — a blank image, a NaN in the buffer,
    // or a delta-lobe scene where no delta event could reach the emitter.
    const health = assessRunHealth({
      mean, meanL, done, noise, strategy, cfg,
      lobeCounts, stats,
    });
    lastGood = health;
    self.postMessage({
      type: 'progress',
      rgb: mean,
      passesDone: done,
      passesTotal: passes,
      spp,
      strategy,
      meanL,
      noise,
      rmseRef: ref ? imageRMSE(mean, ref.rgb) : null,
      ms: Date.now() - t0,
      regionEnergy,
      lobeEnergy,
      lobeCounts: { ...lobeCounts },
      health,
      stats: { ...stats },
      records: res.records,
      refRegionEnergy: ref ? ref.regionEnergy : null,
      width: state.width,
      height: state.height,
    });
    await new Promise(r => setTimeout(r, 0));
  }
  state.running = false;
  self.postMessage({ type: 'done', passesDone: done, health: lastGood });
}

// Classify the run's state so the UI can show "running / image changing" and
// surface lighting-image or noise anomalies rather than leaving them silent.
function assessRunHealth({ mean, meanL, done, noise, strategy, cfg, lobeCounts, stats }) {
  const issues = [];
  let finite = true;
  for (let i = 0; i < mean.length; i++) {
    if (!Number.isFinite(mean[i])) { finite = false; break; }
  }
  if (!finite) issues.push('non-finite pixel value in the image buffer');
  if (done >= 1 && !(meanL > 0)) issues.push('mean luminance is zero (blank lighting image)');
  if (noise != null && !(noise >= 0)) issues.push('relative noise could not be measured');
  const wantsDelta = (cfg.deltaMix || 0) > 0;
  const materials = strategy !== 'light';
  if (wantsDelta && materials && done >= 2 && lobeCounts.delta === 0) {
    issues.push('material has a delta lobe but no discrete event reached the emitter (mirror ray misses the small light)');
  }
  if (wantsDelta && strategy === 'light' && done >= 2) {
    issues.push('light-only cannot sample the delta lobe (point mass has zero area measure) — it is not part of this estimate');
  }
  return {
    running: true,
    lightingImage: done >= 1 && meanL > 0,
    noiseMeasured: noise != null,
    deltaActive: wantsDelta && lobeCounts.delta > 0,
    lobeCounts: { ...lobeCounts },
    finite,
    issues,
  };
}

function getReference(cfg, exposure) {
  const key = JSON.stringify([sceneKey(cfg), exposure.zone, exposure.proposal.components.map(c => c.weight)]);
  if (state.refKey === key && state.ref) return state.ref;
  const q = quadrature({ exposure, cam: state.cam, grid: 72 });
  state.ref = q;
  state.refKey = key;
  return q;
}

function validate(msg) {
  ensureScene(msg.cfg);
  const exposure = currentExposure();
  // Validate on a smaller camera so the deterministic reference actually
  // converges. At 384x256 the visibility step (the sphere occluding part of the
  // emitter) leaves the quadrature >1% off even at high grids — an error larger
  // than the bias under test — while at 96x64 it is converged to ~0.03%. The
  // kernel, scene and exposure are identical; only the sampling resolution
  // differs, which does not affect unbiasedness.
  const VCAM = makeCamera({ width: 96, height: 64 });
  const qHi = quadrature({ exposure, cam: VCAM, grid: 384 });
  const qLo = quadrature({ exposure, cam: VCAM, grid: 192 });
  const refMean = shadingMean(qHi.rgb, state.scene, VCAM);
  const refUncertainty = Math.abs(refMean - shadingMean(qLo.rgb, state.scene, VCAM)) / refMean;
  const rows = [];
  const RUNS = 16;
  for (const strat of ['light', 'material', 'combined']) {
    for (const spp of [8, 32]) {
      const means = [];
      const rmses = [];
      for (let r = 0; r < RUNS; r++) {
        const res = renderImage({ exposure, cam: VCAM, spp, seed: (4242 + r * 104729) >>> 0, strategy: strat });
        means.push(shadingMean(res.rgb, state.scene, VCAM));
        rmses.push(imageRMSE(res.rgb, qHi.rgb));
      }
      const m = means.reduce((a, b) => a + b, 0) / means.length;
      const sd = Math.sqrt(means.reduce((a, b) => a + (b - m) ** 2, 0) / (means.length - 1));
      const se = sd / Math.sqrt(RUNS);
      // Fold the reference's own convergence uncertainty into the test: a
      // deviation below the reference error proves nothing either way.
      const totalSe = Math.sqrt(se ** 2 + (refMean * refUncertainty) ** 2);
      const z = totalSe > 0 ? (m - refMean) / totalSe : 0;
      rows.push({
        strat, spp, mean: m, ref: refMean,
        biasPct: ((m - refMean) / refMean) * 100,
        sd, se, z,
        rmse: rmses.reduce((a, b) => a + b, 0) / rmses.length,
      });
    }
  }
  self.postMessage({ type: 'validate', rows, grid: 384, refUncertainty, runs: RUNS });
}

// Mean over pixels that hit a real surface (not background, not the board).
function shadingMean(rgb, scene, cam) {
  let s = 0;
  let n = 0;
  for (let py = 0; py < cam.height; py++) {
    for (let px = 0; px < cam.width; px++) {
      const ray = cameraRay(cam, px, py);
      const hit = trace(scene, ray.o, ray.d, 1e-5);
      if (!hit || hit.obj === scene.board) continue;
      const i = (py * cam.width + px) * 3;
      s += (rgb[i] + rgb[i + 1] + rgb[i + 2]) / 3;
      n++;
    }
  }
  return n ? s / n : 0;
}
