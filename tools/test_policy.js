// Tests the exposure-history policy on a sequence that exercises all branches:
//   1. grow      -> old table cannot cover new zone -> discard history
//   2. shrink    -> old table covers new zone        -> reweight history
//   3. disjoint  -> old table cannot cover            -> discard history
// and, for each exposure, checks the combined estimator against quadrature
// (both whole-image and per-region) so a whole-image cancellation cannot pass.

import { buildScene } from '../src/scene.js';
import { ExposureController } from '../src/exposure.js';
import { makeCamera } from '../src/scene.js';
import { renderImage, quadrature, meanLuminance, imageRMSE, overlapRegionOf } from '../src/integrator.js';

const scene = buildScene({ lightScale: 1, sphereMaterial: { roughness: 0.18, metallic: 0.85 } });
const cam = makeCamera({ width: 64, height: 48 });
const ctrl = new ExposureController(scene, { u0: 0.30, u1: 0.55, v0: 0.30, v1: 0.70 });

function compare(label, exposure) {
  const q = quadrature({ exposure, cam, grid: 64 });
  let regionsSampled = {};
  let totalQ = 0;
  let totalS = 0;
  const runs = 8;
  const imgs = [];
  for (let r = 0; r < runs; r++) {
    const res = renderImage({ exposure, cam, spp: 24, seed: 321 + r * 7919, strategy: 'combined' });
    imgs.push(res);
  }
  for (const k of Object.keys(q.regionEnergy)) {
    const qv = q.regionEnergy[k];
    const qm = (qv[0] + qv[1] + qv[2]) / 3;
    let sm = 0;
    for (const im of imgs) { const s = im.regionEnergy[k]; sm += (s[0] + s[1] + s[2]) / 3; }
    sm /= imgs.length;
    regionsSampled[k] = { q: qm, s: sm, rel: qm > 1e-9 ? Math.abs(sm - qm) / qm : 0 };
    totalQ += qm;
    totalS += sm;
  }
  const rmse = imgs.reduce((a, im) => a + imageRMSE(im.rgb, q.rgb), 0) / imgs.length;
  console.log(`\n[${label}]`);
  console.log(`  exposure zone: ${JSON.stringify(exposure.zone)}`);
  console.log(`  whole image mean: quadrature=${meanLuminance(q.rgb).toFixed(4)} rmse=${rmse.toFixed(4)}`);
  for (const k of Object.keys(regionsSampled)) {
    const r = regionsSampled[k];
    if (r.q < 1e-9 && r.s < 1e-9) continue;
    console.log(`    ${k.padEnd(8)} quad=${r.q.toFixed(3).padStart(10)} sampler=${r.s.toFixed(3).padStart(10)} rel=${(r.rel * 100).toFixed(2)}%`);
  }
  console.log(`  region-sum: quad=${totalQ.toFixed(3)} sampler=${totalS.toFixed(3)} rel=${(Math.abs(totalS - totalQ) / totalQ * 100).toFixed(2)}%`);
  return totalQ;
}

console.log('=== Exposure sequence ===');
let exp = ctrl.exposureFor();
compare('1 initial', exp);

let rep = ctrl.advance({ u0: 0.20, u1: 0.75, v0: 0.20, v1: 0.85 });
console.log('\n-> grow:', rep.report.mode, rep.report.decisions.map(d => d.action));
exp = ctrl.exposureFor();
compare('2 grow', exp);

rep = ctrl.advance({ u0: 0.30, u1: 0.65, v0: 0.30, v1: 0.75 });
console.log('\n-> shrink:', rep.report.mode, rep.report.decisions.map(d => d.action));
console.log('   coverage:', rep.report.coverage.map(c => ({ w: +c.weight.toFixed(3), cur: c.isCurrent, covers: c.coversNewZone, uncovered: +c.uncoveredArea.toFixed(4) })));
exp = ctrl.exposureFor();
compare('3 shrink', exp);

rep = ctrl.advance({ u0: 0.70, u1: 0.95, v0: 0.05, v1: 0.30 });
console.log('\n-> disjoint:', rep.report.mode, rep.report.decisions.map(d => d.action));
exp = ctrl.exposureFor();
compare('4 disjoint', exp);

// Second reweight should now be possible (shrink of the disjoint zone).
rep = ctrl.advance({ u0: 0.72, u1: 0.90, v0: 0.10, v1: 0.25 });
console.log('\n-> shrink-again:', rep.report.mode, rep.report.decisions.map(d => d.action));
exp = ctrl.exposureFor();
compare('5 shrink-again', exp);
