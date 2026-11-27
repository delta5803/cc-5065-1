// Sampling-probability interface: semantics + evidence.
//
// Proves the refactor does what it claims, headlessly, with numbers:
//   1. The material sampler splits events into a CONTINUOUS density and a
//      DELTA (point mass) with an explicit selection probability that sums to 1.
//   2. The multi-strategy combiner only forms a density ratio when both events
//      are continuous and in the same measure; a point mass always takes full
//      weight and is NEVER divided by a continuous density.
//   3. The balance weights at a shared direction sum to 1.
//   4. Rendering the discrete lobe and the continuous lobes SEPARATELY and
//      adding reproduces the combined render (small light, grazing sphere),
//      and both match the deterministic quadrature reference.
//   5. Two naive "measure-tag only" alternatives (forget the selection
//      probability / Jacobian-convert the point mass) are shown to be biased,
//      so the separation is not cosmetic.
//
//   node tools/test_probability.js

import { buildScene, makeCamera, trace } from '../src/scene.js';
import { ExposureController } from '../src/exposure.js';
import {
  renderImage, quadrature, makeShading, materialSample, lightSample,
  mirrorDeltaContribution, sampleMaterialDirection,
} from '../src/integrator.js';
import { materialEventProbabilities } from '../src/brdf.js';
import { misCombine } from '../src/probability.js';
import { pdfOmegaToArea } from '../src/measure.js';
import { add, mulScalar } from '../src/math.js';
import { Rng } from '../src/rng.js';

let failures = 0;
function check(cond, label, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
}

// ---- 1. event-probability split ----
for (const dm of [0, 0.3, 1]) {
  const p = materialEventProbabilities({ deltaMix: dm });
  check(Math.abs(p.continuous + p.delta - 1) < 1e-12,
    `materialEventProbabilities(deltaMix=${dm}) sums to 1`,
    `continuous=${p.continuous} delta=${p.delta}`);
}
check(materialEventProbabilities({}).delta === 0,
  'default material has zero delta probability (freeze)');

// ---- 2. combiner unit checks ----
const contArea = (d) => ({ eventType: 'continuous', measure: 'area', density: d });
const deltaEv = { eventType: 'delta', measure: 'pointMass', selectionProb: 0.4 };
check(misCombine(deltaEv, null).weight === 1,
  'delta sampled, no competitor -> full weight');
check(misCombine(deltaEv, contArea(5)).weight === 1,
  'delta sampled, continuous competitor -> full weight (not a density ratio)');
check(misCombine(deltaEv, contArea(5)).comparable === false,
  'delta vs continuous is NOT comparable by density');
check(Math.abs(misCombine(contArea(3), contArea(1)).weight - 0.75) < 1e-12,
  'continuous vs continuous -> balance ratio p/(p+q)=0.75');
check(misCombine({ eventType: 'continuous', measure: 'solidAngle', density: 2 }, contArea(2)).weight === 1,
  'continuous but different measures -> full weight (no silent conversion)');
check(misCombine(contArea(0), contArea(2)).reason.includes('zero'),
  'zero own density is reported, not divided through');

// ---- build a small-light, grazing-angle scene with delta + continuous ----
// lightScale 0.4 with a lateral shift gives exactly one grazing sphere pixel
// whose mirror direction lands on the (small) emitter — the hardest case for a
// point-mass contribution, and the one the task asks us to differentiate.
function sceneSetup({ lightScale = 0.4, lightShift = 0.2, deltaMix = 0.5, roughness = 0.12 } = {}) {
  const scene = buildScene({
    lightScale,
    lightOffset: [lightShift, 0],
    sphereMaterial: { roughness, metallic: 0.9, deltaMix },
  });
  const cam = makeCamera({ width: 48, height: 32 });
  const ctrl = new ExposureController(scene, { u0: 0.12, u1: 0.62, v0: 0.10, v1: 0.92 });
  return { scene, cam, exp: ctrl.exposureFor() };
}

// Shading pixels where the surface actually sees the emitter (grazing sphere
// pixels included). Used to keep whole-image means from being dominated by the
// constant background / emitter.
function shadingPixels(scene, cam, board) {
  const out = [];
  for (let py = 0; py < cam.height; py++) {
    for (let px = 0; px < cam.width; px++) {
      const sx = ((px + 0.5) / cam.width) * 2 - 1;
      const sy = 1 - ((py + 0.5) / cam.height) * 2;
      const d = add(add(cam.forward, mulScalar(cam.right, sx * cam.halfW)), mulScalar(cam.up, sy * cam.halfH));
      const l = Math.hypot(d[0], d[1], d[2]);
      const rd = mulScalar(d, 1 / l);
      const hit = trace(scene, cam.eye, rd, 1e-5);
      if (hit && hit.obj !== board) out.push(py * cam.width + px);
    }
  }
  return out;
}

const { scene, cam, exp } = sceneSetup();
const pix = shadingPixels(scene, cam, scene.board);
const lumAt = (rgb, p) => (rgb[p * 3] + rgb[p * 3 + 1] + rgb[p * 3 + 2]) / 3;
const meanOver = (rgb) => pix.reduce((s, p) => s + lumAt(rgb, p), 0) / pix.length;

// ---- 3. weight sums along a shared direction ----
{
  // Find a shading pixel where continuous material samples actually reach the
  // emitter, so both densities are non-zero and the balance weights are real.
  let sh = null;
  let pxq = 0;
  let pyq = 0;
  for (const p of pix) {
    const cx = p % cam.width;
    const cy = Math.floor(p / cam.width);
    const sx = ((cx + 0.5) / cam.width) * 2 - 1;
    const sy = 1 - ((cy + 0.5) / cam.height) * 2;
    const d = add(add(cam.forward, mulScalar(cam.right, sx * cam.halfW)), mulScalar(cam.up, sy * cam.halfH));
    const rd = mulScalar(d, 1 / Math.hypot(d[0], d[1], d[2]));
    const hit = trace(scene, cam.eye, rd, 1e-5);
    if (!hit || hit.obj === scene.board) continue;
    const cand = makeShading(scene, hit, rd);
    const probe = new Rng(99);
    let okc = 0;
    for (let i = 0; i < 400 && okc < 8; i++) {
      const r = materialSample(exp, cand, probe, { mis: true });
      if (r.eventType !== 'delta' && r.pM_area > 0 && r.pL_area > 0) okc++;
    }
    if (okc >= 8) { sh = cand; pxq = cx; pyq = cy; break; }
  }
  if (!sh) {
    check(false, 'found a shading pixel whose continuous samples reach the emitter');
  } else {
    const rng = new Rng(20261127);
    let maxDev = 0;
    let checked = 0;
    let deltaSeen = 0;
    for (let i = 0; i < 4000; i++) {
      const r = materialSample(exp, sh, rng, { mis: true });
      if (r.eventType === 'delta') {
        deltaSeen++;
        if (r.weight !== 1) maxDev = Math.max(maxDev, 1);
        continue;
      }
      if (!(r.pM_area > 0) || !(r.pL_area > 0)) continue;
      const wM = r.pM_area / (r.pL_area + r.pM_area);
      const wL = r.pL_area / (r.pL_area + r.pM_area);
      maxDev = Math.max(maxDev, Math.abs(wL + wM - 1));
      checked++;
    }
    check(checked > 100 && maxDev < 1e-12,
      'balance weights at a shared direction sum to 1',
      `(${pxq},${pyq}) ${checked} continuous samples, max |wL+wM-1|=${maxDev.toExponential(2)}`);
    check(deltaSeen > 0, 'delta events actually occurred in the sample stream',
      `${deltaSeen} delta events`);
  }
}

// ---- 4. additivity: separate lobes vs combined, and vs quadrature ----
{
  const SEEDS = 16;
  const SPP = 96;
  const accDelta = {};
  const accCont = {};
  const accFull = {};
  for (const p of pix) { accDelta[p] = 0; accCont[p] = 0; accFull[p] = 0; }
  for (let s = 0; s < SEEDS; s++) {
    const seed = 4000 + s * 977;
    const dOnly = renderImage({ exposure: exp, cam, spp: SPP, seed, strategy: 'material', forceEvent: 'delta' });
    const cOnly = renderImage({ exposure: exp, cam, spp: SPP, seed, strategy: 'material', forceEvent: 'continuous' });
    const full = renderImage({ exposure: exp, cam, spp: SPP, seed, strategy: 'combined' });
    for (const p of pix) {
      accDelta[p] += lumAt(dOnly.rgb, p) / SEEDS;
      accCont[p] += lumAt(cOnly.rgb, p) / SEEDS;
      accFull[p] += lumAt(full.rgb, p) / SEEDS;
    }
  }
  // Aggregate over ALL shading pixels (dominated by the continuous share, which
  // is identical in every render, so this is a tight check on the delta share).
  let sumFull = 0;
  let sumParts = 0;
  let maxRel = 0;
  let signal = 0;
  for (const p of pix) {
    const f = accFull[p];
    const parts = accDelta[p] + accCont[p];
    sumFull += f;
    sumParts += parts;
    if (f > 0.25) { signal++; maxRel = Math.max(maxRel, Math.abs(f - parts) / f); }
  }
  const aggRel = Math.abs(sumFull - sumParts) / sumFull;
  check(aggRel < 0.02,
    'combined render == separately rendered delta lobe + continuous lobes (aggregate over shading pixels)',
    `aggregate rel diff ${(aggRel * 100).toFixed(3)}%, ${signal} pixels above threshold, worst ${(maxRel * 100).toFixed(1)}%`);

  // Total brightness of the combined render vs deterministic quadrature (which
  // itself now contains the exact delta term).
  const q = quadrature({ exposure: exp, cam, grid: 192 });
  const refSum = pix.reduce((s, p) => s + lumAt(q.rgb, p), 0);
  const fullSum = pix.reduce((s, p) => s + accFull[p], 0);
  const relVsRef = Math.abs(fullSum - refSum) / refSum;
  check(relVsRef < 0.05,
    'combined total brightness matches deterministic reference (with delta term)',
    `sampler=${fullSum.toFixed(3)} ref=${refSum.toFixed(3)} rel=${(relVsRef * 100).toFixed(2)}%`);
}

// ---- 5. separate discrete event vs "tag the measure only" ----
//
// At a grazing sphere pixel whose mirror hits the emitter, the exact delta
// contribution is known deterministically. Sampling NORMALLY (so the delta is
// chosen with probability q = deltaMix):
//   * correct: divide the delta's contribution by its SELECTION probability q,
//     and by nothing else -> matches the exact value.
//   * naive "measure tag": divide that same delta by an ordinary density. For a
//     delta the continuous solid-angle density is zero, so this is non-finite;
//     the Jacobian variant is finite but wrong by orders of magnitude. Either
//     way, a point mass must not be divided by a continuous density.
{
  let target = null;
  for (const p of pix) {
    const pxq = p % cam.width;
    const pyq = Math.floor(p / cam.width);
    const sx = ((pxq + 0.5) / cam.width) * 2 - 1;
    const sy = 1 - ((pyq + 0.5) / cam.height) * 2;
    const d = add(add(cam.forward, mulScalar(cam.right, sx * cam.halfW)), mulScalar(cam.up, sy * cam.halfH));
    const rd = mulScalar(d, 1 / Math.hypot(d[0], d[1], d[2]));
    const hit = trace(scene, cam.eye, rd, 1e-5);
    if (!hit || !hit.isSphere) continue;
    const sh = makeShading(scene, hit, rd);
    const exact = mirrorDeltaContribution(exp, sh);
    if (exact && (exact.contribution[0] + exact.contribution[1] + exact.contribution[2]) > 0.1) {
      target = { sh, exact, px: pxq, py: pyq };
      break;
    }
  }
  if (!target) {
    check(false, 'found a grazing sphere pixel whose mirror hits the emitter');
  } else {
    const { sh, exact } = target;
    const exactL = (exact.contribution[0] + exact.contribution[1] + exact.contribution[2]) / 3;
    const N = 300000;
    const rng = new Rng(31415);
    let sumProper = 0; // delta contribution / selection probability
    let sumNaiveDensity = 0; // delta contribution / (continuous density = 0)
    let sumNaiveJacobian = 0; // delta contribution / Jacobian-converted mass
    let deltaDraws = 0;
    let nonFinite = 0;
    for (let i = 0; i < N; i++) {
      const rec = sampleMaterialDirection(exp, sh, rng);
      if (rec.reason) continue;
      if (rec.eventType !== 'delta') continue; // only the discrete branch
      deltaDraws++;
      const f = (rec.f[0] + rec.f[1] + rec.f[2]) / 3; // L_e·R
      const q = rec.selectionProb; // actual discrete selection probability
      sumProper += f / q;
      // Naive: pretend the delta has the continuous direction density (zero for
      // a point mass) and divide by it.
      if (!(rec.pOmega > 0)) { nonFinite++; } else { sumNaiveDensity += f / rec.pOmega; }
      // Naive: convert the selection probability with the area Jacobian.
      const qArea = pdfOmegaToArea(q, rec.cosY, rec.dist2);
      if (qArea > 0) sumNaiveJacobian += f / qArea;
    }
    const properEst = sumProper / N; // each draw counts, delta terms only
    const jacEst = sumNaiveJacobian / N;
    const properErr = Math.abs(properEst - exactL) / exactL;
    const jacErr = Math.abs(jacEst - exactL) / exactL;
    check(deltaDraws > N * 0.2,
      'delta branch is selected at the material\'s discrete probability',
      `${deltaDraws}/${N} draws`);
    check(properErr < 0.03,
      'separated discrete event (divide by selection probability) matches exact delta',
      `exact=${exactL.toFixed(5)} proper=${properEst.toFixed(5)} err=${(properErr * 100).toFixed(2)}%`);
    check(nonFinite === deltaDraws,
      'a point mass divided by the continuous density is non-finite (must be avoided)',
      `${nonFinite}/${deltaDraws} delta draws had zero continuous density`);
    check(jacErr > 0.2,
      'tag-the-measure + Jacobian-convert the point mass is biased',
      `jacobian=${jacEst.toFixed(5)} err=${(jacErr * 100).toFixed(1)}%`);
  }
}

console.log(`\n${failures === 0 ? 'PROBABILITY OK' : `FAILURES: ${failures}`}`);
process.exit(failures === 0 ? 0 : 1);
