import { makeDefaultSetup } from '../src/setup.js';
import { lightSample, materialSample, makeShading, renderImage } from '../src/integrator.js';
import { trace, planePoint, inRect } from '../src/scene.js';
import { evalBrdf } from '../src/brdf.js';
import { add, sub, dot, mulScalar, length } from '../src/math.js';
import { Rng } from '../src/rng.js';

const { scene, cam, controller } = makeDefaultSetup({ width: 96, height: 64 });
const exp = controller.exposureFor();
const board = scene.board;

function pixelShading(px, py) {
  const sx = ((px + 0.5) / cam.width) * 2 - 1;
  const sy = 1 - ((py + 0.5) / cam.height) * 2;
  const d = add(add(cam.forward, mulScalar(cam.right, sx * cam.halfW)), mulScalar(cam.up, sy * cam.halfH));
  const rd = mulScalar(d, 1 / length(d));
  const hit = trace(scene, cam.eye, rd, 1e-5);
  if (!hit || hit.obj === board) return null;
  return makeShading(scene, hit, rd);
}

function quad(sh, grid = 128) {
  const cellArea = board.area / (grid * grid);
  const acc = [0, 0, 0];
  for (let j = 0; j < grid; j++) for (let i = 0; i < grid; i++) {
    const u = (i + 0.5) / grid, v = (j + 0.5) / grid;
    if (!inRect({ u, v }, exp.zone)) continue;
    const y = planePoint(board, u, v);
    const d = sub(y, sh.p); const dist2 = dot(d, d); const dist = Math.sqrt(dist2);
    const wi = mulScalar(d, 1 / dist);
    const cosX = dot(sh.n, wi), cosY = Math.abs(dot(board.n, wi));
    if (!(cosX > 0) || !(cosY > 0)) continue;
    const h = trace(scene, sh.p, wi, 1e-5);
    if (h && h.t < dist - 1e-3) continue;
    const e = evalBrdf(sh.material, sh.base, sh.n, sh.wo, wi);
    if (!e) continue;
    const c = (cosX * cosY / dist2) * cellArea;
    acc[0] += exp.albedo[0] * e.fr[0] * c;
    acc[1] += exp.albedo[1] * e.fr[1] * c;
    acc[2] += exp.albedo[2] * e.fr[2] * c;
  }
  return (acc[0] + acc[1] + acc[2]) / 3;
}

function est(sh, kind, N = 200000) {
  const rng = new Rng(999);
  let s = 0;
  for (let i = 0; i < N; i++) {
    const r = kind === 'light' ? lightSample(exp, sh, rng, { mis: false }) : materialSample(exp, sh, rng, { mis: false });
    s += (r.contribution[0] + r.contribution[1] + r.contribution[2]) / 3;
  }
  return s / N;
}

const pts = [
  [23, 31, 'far floor'], [48, 52, 'floor center'], [48, 40, 'floor near'],
  [52, 30, 'sphere?'], [60, 32, 'sphere?'], [30, 20, 'upper left'],
];
for (const [px, py, label] of pts) {
  const sh = pixelShading(px, py);
  if (!sh) { console.log(px, py, label, 'no shading'); continue; }
  const q = quad(sh);
  const l = est(sh, 'light');
  const m = est(sh, 'material');
  console.log(`${label.padEnd(12)} (${px},${py}) quad=${q.toFixed(5)} light=${l.toFixed(5)} (${((l-q)/Math.max(q,1e-9)*100).toFixed(1)}%) material=${m.toFixed(5)} (${((m-q)/Math.max(q,1e-9)*100).toFixed(1)}%)`);
}
