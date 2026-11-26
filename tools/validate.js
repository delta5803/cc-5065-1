#!/usr/bin/env node
// Headless validation harness for the multi-strategy lighting kernel.
//
//   node tools/validate.js
//
// It uses the SAME kernel the browser window imports. It reports:
//   1. deterministic reference (per-region quadrature)
//   2. measure audit: each technique vs that reference on the same domain
//   3. independent runs: mean / bias / variance / RMSE / cost per strategy
//   4. per-region sampler-vs-quadrature (whole-image agreement cannot hide this)
//   5. an exposure transition that forces the coverage policy
//   6. a cancellation guard (two exposures whose means nearly cancel)

import { buildScene, makeCamera } from '../src/scene.js';
import { ExposureController } from '../src/exposure.js';
import {
  renderImage, quadrature, meanLuminance, imageRMSE, auditMeasures,
} from '../src/integrator.js';
import { trace } from '../src/scene.js';
import { add, mulScalar, normalize } from '../src/math.js';

const W = 96;
const H = 64;
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(4) : String(x));

function makeScene() {
  const scene = buildScene({ lightScale: 1, sphereMaterial: { roughness: 0.18, metallic: 0.85 } });
  const cam = makeCamera({ width: W, height: H });
  return { scene, cam };
}

// Shading-only luminance sum: excludes background and the light board, so a
// mean over it cannot be dominated by constant emitter pixels.
function shadingLuminanceSum(rgb, scene, cam) {
  let s = 0;
  for (let py = 0; py < cam.height; py++) {
    for (let px = 0; px < cam.width; px++) {
      const dir = camRay(cam, px, py);
      const hit = trace(scene, cam.eye, dir, 1e-5);
      if (!hit || hit.obj === scene.board) continue;
      const i = (py * cam.width + px) * 3;
      s += (rgb[i] + rgb[i + 1] + rgb[i + 2]) / 3;
    }
  }
  return s;
}

// The reference must itself be converged, or a correct sampler gets flagged as
// biased against an under-resolved grid. Compute the shading sum at 128/192/256
// and use 256; the printed 192->256 change is the reference's own uncertainty.
function convergedReference(label, exposure, scene, cam) {
  const sums = {};
  let rgb256 = null;
  for (const grid of [128, 192, 256]) {
    const q = quadrature({ exposure, cam, grid });
    sums[grid] = shadingLuminanceSum(q.rgb, scene, cam);
    if (grid === 256) rgb256 = q;
  }
  const rel = Math.abs(sums[256] - sums[192]) / sums[256];
  console.log(`  ${label} reference grid 128/192/256 = ` +
    `${sums[128].toFixed(2)} / ${sums[192].toFixed(2)} / ${sums[256].toFixed(2)}` +
    `  (192->256 change ${(rel * 100).toFixed(2)}%)`);
  return { grid: 256, shading: sums[256], rgb: rgb256.rgb, regionEnergy: rgb256.regionEnergy };
}

function camRay(cam, px, py) {
  const sx = ((px + 0.5) / cam.width) * 2 - 1;
  const sy = 1 - ((py + 0.5) / cam.height) * 2;
  return normalize(add(add(cam.forward, mulScalar(cam.right, sx * cam.halfW)), mulScalar(cam.up, sy * cam.halfH)));
}

function runConvergence(label, exposure, scene, cam, refShading) {
  console.log(`\n### ${label}: independent runs vs deterministic quadrature`);
  const RUNS = 20;
  const rows = [];
  for (const strat of ['light', 'material', 'combined']) {
    for (const spp of [4, 16, 64]) {
      const means = [];
      let ms = 0;
      for (let r = 0; r < RUNS; r++) {
        const res = renderImage({ exposure, cam, spp, seed: (9001 + r * 2654435) >>> 0, strategy: strat });
        ms += res.ms;
        means.push(shadingLuminanceSum(res.rgb, scene, cam));
      }
      const m = means.reduce((a, b) => a + b, 0) / means.length;
      const v = means.reduce((a, b) => a + (b - m) ** 2, 0) / (means.length - 1);
      const se = Math.sqrt(v / means.length);
      const bias = (m - refShading) / refShading;
      const sigmas = Math.abs(m - refShading) / Math.max(se, 1e-9);
      rows.push({ strat, spp, m, bias, v, se, sigmas, ms: ms / RUNS });
      console.log(
        `  ${strat.padEnd(8)} spp=${String(spp).padStart(2)}  L=${fmt(m)}  ` +
        `bias=${(bias * 100).toFixed(2).padStart(7)}%  se=${se.toFixed(2)}  ` +
        `${sigmas < 2 ? 'consistent' : sigmas < 3 ? 'marginal' : 'OUTLIER'}(${sigmas.toFixed(1)}σ)  ` +
        `var=${v.toExponential(2)}  ms/run=${(ms / RUNS).toFixed(1)}`,
      );
    }
  }
  console.log('  cost-normalised (bias^2 + variance) at spp=16:');
  for (const strat of ['light', 'material', 'combined']) {
    const r = rows.find(x => x.strat === strat && x.spp === 16);
    console.log(`    ${strat.padEnd(8)} err=${(r.bias ** 2 + r.v).toExponential(2)}  cost=${r.ms.toFixed(1)}ms`);
  }
  return rows;
}

function compareRegions(label, exposure, scene, cam) {
  const q = quadrature({ exposure, cam, grid: 256 });
  // Average several independent runs so the per-region relative error reflects
  // bias rather than single-run variance.
  const RUNS = 8;
  const regionAccum = {};
  for (let r = 0; r < RUNS; r++) {
    const res = renderImage({ exposure, cam, spp: 64, seed: (424242 + r * 104729) >>> 0, strategy: 'combined' });
    for (const k of ['bright', 'shared', 'newOnly', 'oldOnly', 'dark']) {
      if (!regionAccum[k]) regionAccum[k] = [0, 0, 0];
      for (let c = 0; c < 3; c++) regionAccum[k][c] += res.regionEnergy[k][c] / RUNS;
    }
  }
  console.log(`\n${label}: per-region sampler (${RUNS}×spp64) vs quadrature (grid 256)`);
  let qTot = 0;
  let sTot = 0;
  for (const k of ['bright', 'shared', 'newOnly', 'oldOnly', 'dark']) {
    const qq = q.regionEnergy[k];
    const ss = regionAccum[k];
    const qm = (qq[0] + qq[1] + qq[2]) / 3;
    const sm = (ss[0] + ss[1] + ss[2]) / 3;
    if (qm < 1e-6 && sm < 1e-6) continue;
    qTot += qm;
    sTot += sm;
    const rel = qm > 1e-6 ? (sm - qm) / qm : 0;
    console.log(`  ${k.padEnd(8)} quad=${qm.toFixed(3).padStart(10)} sampler=${sm.toFixed(3).padStart(10)} rel=${(rel * 100).toFixed(2)}%`);
  }
  console.log(`  TOTAL    quad=${qTot.toFixed(3).padStart(10)} sampler=${sTot.toFixed(3).padStart(10)} rel=${((sTot - qTot) / qTot * 100).toFixed(2)}%`);
  return { q, res: regionAccum };
}

function main() {
  const { scene, cam } = makeScene();

  // ---- Exposure A ----
  const ctrl = new ExposureController(scene, { u0: 0.12, u1: 0.62, v0: 0.10, v1: 0.92 });
  const expA = ctrl.exposureFor();
  console.log('=== Reference (exposure A, converged deterministic quadrature) ===');
  const refA = convergedReference('A', expA, scene, cam);
  const refAShading = refA.shading;
  console.log('shading luminance sum:', fmt(refAShading), ' whole-image mean:', fmt(meanLuminance(refA.rgb)));

  // ---- measure audit ----
  const audit = auditMeasures({ exposure: expA, cam, spp: 512, grid: 128, runsCount: 12 });
  console.log('\n=== Measure audit (same domain, both measures → area) ===');
  console.log(`  reference=${fmt(audit.reference)}`);
  console.log(`  area-measure (light)    =${fmt(audit.areaEstimate)}  (${(audit.areaRelVsRef * 100).toFixed(2)}% from ref, z=${audit.areaZ.toFixed(2)})`);
  console.log(`  solid-angle (material)  =${fmt(audit.solidAngleEstimate)}  (${(audit.solidRelVsRef * 100).toFixed(2)}% from ref, z=${audit.solidZ.toFixed(2)})`);
  console.log(`  Jacobian: ${audit.jacobianForm}`);

  runConvergence('Exposure A', expA, scene, cam, refAShading);

  // ---- exposure transitions ----
  console.log('\n=== Exposure transitions ===');
  let r = ctrl.advance({ u0: 0.20, u1: 0.80, v0: 0.20, v1: 0.90 });
  console.log(`- grow zone  -> ${r.report.mode} :: ${r.report.decisions.map(d => d.action).join(', ')}`);
  console.log(`  ${r.report.decisions.map(d => d.reason).join('\n  ')}`);
  const expB = ctrl.exposureFor();
  const refB = convergedReference('B', expB, scene, cam);
  const refBShading = refB.shading;
  console.log(`  reference shading L (B) = ${fmt(refBShading)}`);
  compareRegions('Exposure B (after grow / discard)', expB, scene, cam);
  runConvergence('Exposure B (after grow / discard)', expB, scene, cam, refBShading);

  r = ctrl.advance({ u0: 0.30, u1: 0.70, v0: 0.30, v1: 0.80 });
  console.log(`\n- shrink zone -> ${r.report.mode} :: ${r.report.decisions.map(d => d.action).join(', ')}`);
  console.log(`  ${r.report.decisions.map(d => d.reason).join('\n  ')}`);
  console.log('  coverage:', JSON.stringify(r.report.coverage.map(c => ({
    weight: +c.weight.toFixed(3), current: c.isCurrent, covers: c.coversNewZone, uncovered: +c.uncoveredArea.toFixed(4),
  }))));
  const expC = ctrl.exposureFor();
  const refC = convergedReference('C', expC, scene, cam);
  const refCShading = refC.shading;
  compareRegions('Exposure C (after shrink / reweight)', expC, scene, cam);
  runConvergence('Exposure C (after shrink / reweight)', expC, scene, cam, refCShading);

  // ---- cancellation guard ----
  console.log('\n=== Cancellation guard ===');
  const mA = meanLuminance(refA.rgb);
  const mC = meanLuminance(refC.rgb);
  console.log(`  whole-image mean A=${fmt(mA)}  C=${fmt(mC)}  |A−C|/A=${(Math.abs(mA - mC) / mA * 100).toFixed(2)}%`);
  console.log(`  shading sums A=${fmt(refAShading)}  C=${fmt(refCShading)}`);
  console.log('  (per-region rows above are the real check; a matching total is not sufficient)');

  console.log('\nOK');
}

main();
