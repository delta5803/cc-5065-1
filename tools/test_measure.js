// Checks the measure audit and the material estimator for bias vs variance
// with explicit standard errors across independent seeds.

import { makeDefaultSetup } from '../src/setup.js';
import { auditMeasures, lightSample, materialSample, makeShading } from '../src/integrator.js';
import { trace } from '../src/scene.js';
import { add, mulScalar, length } from '../src/math.js';
import { Rng } from '../src/rng.js';

const { scene, cam, controller } = makeDefaultSetup({ width: 48, height: 32 });
const exp = controller.exposureFor();

function camRay(px, py) {
  const sx = ((px + 0.5) / cam.width) * 2 - 1;
  const sy = 1 - ((py + 0.5) / cam.height) * 2;
  const d = add(add(cam.forward, mulScalar(cam.right, sx * cam.halfW)), mulScalar(cam.up, sy * cam.halfH));
  return mulScalar(d, 1 / length(d));
}

// Per-pixel material estimate with batch standard error.
function pointSE(px, py, kind, boot, nPerBoot) {
  const rd = camRay(px, py);
  const hit = trace(scene, cam.eye, rd, 1e-5);
  if (!hit || hit.obj === scene.board) return null;
  const sh = makeShading(scene, hit, rd);
  const means = [];
  for (let b = 0; b < boot; b++) {
    const rng = new Rng(7000 + b * 1013904223);
    let s = 0;
    for (let i = 0; i < nPerBoot; i++) {
      const r = kind === 'light' ? lightSample(exp, sh, rng, { mis: false }) : materialSample(exp, sh, rng, { mis: false });
      s += (r.contribution[0] + r.contribution[1] + r.contribution[2]) / 3;
    }
    means.push(s / nPerBoot);
  }
  const m = means.reduce((a, b) => a + b, 0) / means.length;
  const sd = Math.sqrt(means.reduce((a, b) => a + (b - m) ** 2, 0) / (means.length - 1));
  return { mean: m, se: sd / Math.sqrt(means.length) };
}

console.log('point (px,py)   light(mean ± se)          material(mean ± se)');
for (const [px, py] of [[23, 20], [24, 16], [30, 18], [20, 10]]) {
  const l = pointSE(px, py, 'light', 24, 20000);
  const m = pointSE(px, py, 'material', 24, 20000);
  if (!l) { console.log(px, py, 'no shading'); continue; }
  const z = Math.abs(l.mean - m.mean) / Math.sqrt(l.se ** 2 + m.se ** 2);
  console.log(
    `(${px},${py})  light=${l.mean.toExponential(3)}±${l.se.toExponential(2)}  ` +
    `mat=${m.mean.toExponential(3)}±${m.se.toExponential(2)}  z=${z.toFixed(2)}`,
  );
}

// Audit convergence across sample counts.
console.log('\nAudit relDiff vs spp (16 pixels, glossy sphere present):');
for (const spp of [16, 64, 256, 1024]) {
  const a = auditMeasures({ exposure: exp, cam, spp });
  console.log(`  spp=${String(spp).padStart(4)} area=${a.areaEstimate.toFixed(4)} solid=${a.solidAngleEstimate.toFixed(4)} relDiff=${(a.relDiff * 100).toFixed(2)}%`);
}
