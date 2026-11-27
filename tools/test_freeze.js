// Freeze test: the probability-interface refactor must not change the EXTERNAL
// behaviour of multi-strategy lighting for the default (deltaMix = 0) scene.
//
//   node tools/test_freeze.js
//
// The golden numbers below were produced by the pre-refactor kernel (commit
// 065d082) with deltaMix absent. Rendering is deterministic per (seed, spp), so
// any change to sampling order, density, MIS weight or normalisation moves these
// sums. The check compares against them to a tight relative tolerance; a
// mismatch means the refactor leaked into external behaviour.

import { buildScene, makeCamera } from '../src/scene.js';
import { ExposureController } from '../src/exposure.js';
import {
  renderImage, quadrature, auditMeasures,
} from '../src/integrator.js';

// Golden values: pre-refactor kernel, deltaMix = 0.
const GOLDEN = {
  light: { rgbSum: 13095.356253372607 },
  material: { rgbSum: 13306.780000299876 },
  combined: { rgbSum: 13320.483503474179 },
  quad: { rgbSum: 13261.14403691134 },
  audit: { ref: 0.20359985848558498, area: 0.20506386048096795 },
};
const TOL = 1e-9;

let failures = 0;
function close(actual, expected, label) {
  const rel = Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-12);
  const ok = rel <= TOL;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  actual=${actual} expected=${expected} rel=${rel.toExponential(2)}`);
  if (!ok) failures++;
}

const scene = buildScene({ lightScale: 1, sphereMaterial: { roughness: 0.18, metallic: 0.85 } });
const cam = makeCamera({ width: 48, height: 32 });
const ctrl = new ExposureController(scene, { u0: 0.12, u1: 0.62, v0: 0.10, v1: 0.92 });
const exp = ctrl.exposureFor();

for (const strat of ['light', 'material', 'combined']) {
  const res = renderImage({ exposure: exp, cam, spp: 16, seed: 123456, strategy: strat });
  let sum = 0;
  for (let i = 0; i < res.rgb.length; i++) sum += res.rgb[i];
  close(sum, GOLDEN[strat].rgbSum, `renderImage(${strat}, spp=16, seed=123456) rgb sum`);
}

{
  const q = quadrature({ exposure: exp, cam, grid: 40 });
  let sum = 0;
  for (let i = 0; i < q.rgb.length; i++) sum += q.rgb[i];
  close(sum, GOLDEN.quad.rgbSum, 'quadrature(grid=40) rgb sum');
}

{
  const a = auditMeasures({ exposure: exp, cam, spp: 64, grid: 32, runsCount: 3, seed: 42 });
  close(a.reference, GOLDEN.audit.ref, 'audit reference');
  close(a.areaEstimate, GOLDEN.audit.area, 'audit area estimate');
  // The discrete lobe must be absent by default, so a delta event never occurs.
  const res = renderImage({ exposure: exp, cam, spp: 16, seed: 123456, strategy: 'combined' });
  const okDelta = res.counts.delta === 0 && res.lobeEnergy.delta.every(v => v === 0);
  console.log(`${okDelta ? 'PASS' : 'FAIL'}  default material emits no discrete events (delta lobe off)`);
  if (!okDelta) failures++;
}

console.log(`\n${failures === 0 ? 'FREEZE OK' : `FREEZE BROKEN: ${failures}`}`);
process.exit(failures === 0 ? 0 : 1);
