// Demonstrates that the area-measure (light) estimator is UNBIASED but
// high-variance on glossy surfaces, while the solid-angle (material) estimator
// is low-variance. Uses independent seeds and reports mean ± standard error
// against deterministic quadrature.

import { makeDefaultSetup } from '../src/setup.js';
import { auditMeasures } from '../src/integrator.js';

const { cam, controller } = makeDefaultSetup({ width: 48, height: 32 });
const exp = controller.exposureFor();

for (const spp of [64, 256]) {
  const runs = 40;
  const area = [];
  const solid = [];
  let ref = 0;
  for (let r = 0; r < runs; r++) {
    const a = auditMeasures({ exposure: exp, cam, spp, seed: 100 + r * 2654435761 % 2147483647, grid: 64 });
    area.push(a.areaEstimate);
    solid.push(a.solidAngleEstimate);
    ref = a.reference;
  }
  const stat = (xs) => {
    const m = xs.reduce((p, c) => p + c, 0) / xs.length;
    const v = xs.reduce((p, c) => p + (c - m) ** 2, 0) / (xs.length - 1);
    return { m, se: Math.sqrt(v / xs.length), sd: Math.sqrt(v) };
  };
  const A = stat(area);
  const S = stat(solid);
  console.log(
    `spp=${String(spp).padStart(3)}  ref=${ref.toFixed(4)}  ` +
    `AREA(light) mean=${A.m.toFixed(4)} se=${A.se.toFixed(4)} sd=${A.sd.toFixed(4)} bias=${((A.m - ref) / ref * 100).toFixed(2)}%  |  ` +
    `SOLID(mat) mean=${S.m.toFixed(4)} se=${S.se.toFixed(4)} sd=${S.sd.toFixed(4)} bias=${((S.m - ref) / ref * 100).toFixed(2)}%`,
  );
}
