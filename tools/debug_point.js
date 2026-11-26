import { makeDefaultSetup, defaultZoneA } from '../src/setup.js';
import { lightSample, materialSample, makeShading } from '../src/integrator.js';
import { trace, planePoint, planeUV, inRect } from '../src/scene.js';
import { evalBrdf } from '../src/brdf.js';
import { add, sub, dot, mulScalar, length } from '../src/math.js';
import { Rng } from '../src/rng.js';

const { scene, cam, controller } = makeDefaultSetup({ width: 96, height: 64 });
const exp = controller.exposureFor();

// Pick the first non-board pixel.
let sh = null;
for (let py = 0; py < cam.height && !sh; py++) {
  for (let px = 0; px < cam.width; px++) {
    const sx = ((px + 0.5) / cam.width) * 2 - 1;
    const sy = 1 - ((py + 0.5) / cam.height) * 2;
    const d = add(add(cam.forward, mulScalar(cam.right, sx * cam.halfW)), mulScalar(cam.up, sy * cam.halfH));
    const ray = { o: cam.eye, d: mulScalar(d, 1 / length(d)) };
    const hit = trace(scene, ray.o, ray.d, 1e-5);
    if (!hit || hit.obj === scene.board) continue;
    sh = makeShading(scene, hit, ray.d);
    console.log('pixel', px, py, 'p=', sh.p, 'n=', sh.n);
    break;
  }
}

// Deterministic fine quadrature of the same integral.
function quad(grid) {
  const zone = exp.zone;
  const board = scene.board;
  const cellArea = board.area / (grid * grid);
  const acc = [0, 0, 0];
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const u = (i + 0.5) / grid;
      const v = (j + 0.5) / grid;
      if (!inRect({ u, v }, zone)) continue;
      const y = planePoint(board, u, v);
      const d = sub(y, sh.p);
      const dist2 = dot(d, d);
      const dist = Math.sqrt(dist2);
      const wi = mulScalar(d, 1 / dist);
      const cosX = dot(sh.n, wi);
      const cosY = Math.abs(dot(board.n, wi));
      if (!(cosX > 0) || !(cosY > 0)) continue;
      const rd = wi;
      const hit = trace(scene, sh.p, rd, 1e-5);
      if (hit && hit.t < dist - 1e-3) continue;
      const e = evalBrdf(sh.material, sh.base, sh.n, sh.wo, wi);
      if (!e) continue;
      const c = (cosX * cosY / dist2) * cellArea;
      acc[0] += exp.albedo[0] * e.fr[0] * c;
      acc[1] += exp.albedo[1] * e.fr[1] * c;
      acc[2] += exp.albedo[2] * e.fr[2] * c;
    }
  }
  return acc;
}

for (const g of [64, 128, 256, 512]) console.log('quad', g, quad(g).map(x => x.toFixed(5)));

// Light estimator.
{
  const rng = new Rng(12345);
  const N = 400000;
  const acc = [0, 0, 0];
  let used = 0;
  for (let i = 0; i < N; i++) {
    const r = lightSample(exp, sh, rng, { mis: false });
    if (r.contribution.some(x => x !== 0)) used++;
    acc[0] += r.contribution[0];
    acc[1] += r.contribution[1];
    acc[2] += r.contribution[2];
  }
  console.log('light', (acc[0] / N).toFixed(5), (acc[1] / N).toFixed(5), (acc[2] / N).toFixed(5), 'used', used, '/', N);
}

// Material estimator.
{
  const rng = new Rng(54321);
  const N = 400000;
  const acc = [0, 0, 0];
  let used = 0;
  for (let i = 0; i < N; i++) {
    const r = materialSample(exp, sh, rng, { mis: false });
    if (r.contribution.some(x => x !== 0)) used++;
    acc[0] += r.contribution[0];
    acc[1] += r.contribution[1];
    acc[2] += r.contribution[2];
  }
  console.log('material', (acc[0] / N).toFixed(5), (acc[1] / N).toFixed(5), (acc[2] / N).toFixed(5), 'used', used, '/', N);
}
