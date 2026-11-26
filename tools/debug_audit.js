import { makeDefaultSetup } from '../src/setup.js';
import { auditMeasures, quadrature } from '../src/integrator.js';
import { trace } from '../src/scene.js';
import { add, mulScalar, length } from '../src/math.js';

const { cam, controller, scene } = makeDefaultSetup({ width: 48, height: 32 });
const exp = controller.exposureFor();

function camRay(px, py) {
  const sx = ((px + 0.5) / cam.width) * 2 - 1;
  const sy = 1 - ((py + 0.5) / cam.height) * 2;
  const d = add(add(cam.forward, mulScalar(cam.right, sx * cam.halfW)), mulScalar(cam.up, sy * cam.halfH));
  return mulScalar(d, 1 / length(d));
}

// Reproduce audit's pixel list.
const { width, height } = cam;
const pixelBudget = 64, grid = 64, spp = 256, seed = 987654;
const step = Math.max(1, Math.floor(Math.sqrt((width * height) / pixelBudget)));
const pixList = [];
for (let y = Math.floor(step / 2); y < height; y += step) for (let x = Math.floor(step / 2); x < width; x += step) pixList.push(y * width + x);
console.log('step', step, 'pixels', pixList.length);

const q = quadrature({ exposure: exp, cam, grid, pixels: pixList });
let ref = 0, nonBoard = 0;
for (const pix of pixList) {
  const rd = camRay(pix % width, (pix / width) | 0);
  const hit = trace(scene, cam.eye, rd, 1e-5);
  if (hit && hit.obj === scene.board) continue;
  nonBoard++;
  ref += (q.rgb[pix*3]+q.rgb[pix*3+1]+q.rgb[pix*3+2])/3;
}
console.log('nonBoard', nonBoard, 'ref', ref.toFixed(5));

// Full-image quadrature luminance restricted to non-board, non-bg via full q.
const qAll = quadrature({ exposure: exp, cam, grid: 64 });
let refAll = 0, countAll = 0;
for (let pix = 0; pix < width*height; pix++) {
  const rd = camRay(pix % width, (pix / width) | 0);
  const hit = trace(scene, cam.eye, rd, 1e-5);
  if (!hit || hit.obj === scene.board) continue;
  countAll++;
  refAll += (qAll.rgb[pix*3]+qAll.rgb[pix*3+1]+qAll.rgb[pix*3+2])/3;
}
console.log('ALL nonBoard', countAll, 'refAll', refAll.toFixed(5));

// One Monte Carlo estimate by hand over the SAME pixList, material strategy.
import { lightSample, materialSample, makeShading } from '../src/integrator.js';
import { Rng } from '../src/rng.js';
import { streamSeed } from '../src/rng.js';
let mcL = 0, mcM = 0, used = 0;
for (let k = 0; k < pixList.length; k++) {
  const pix = pixList[k];
  const rd = camRay(pix % width, (pix / width) | 0);
  const hit = trace(scene, cam.eye, rd, 1e-5);
  if (!hit || hit.obj === scene.board) continue;
  const sh = makeShading(scene, hit, rd);
  const rA = new Rng(streamSeed(seed, k*2));
  const rB = new Rng(streamSeed(seed, k*2+1));
  let a = 0, m = 0;
  for (let i = 0; i < spp; i++) {
    let r = lightSample(exp, sh, rA, { mis: false });
    a += (r.contribution[0]+r.contribution[1]+r.contribution[2])/3;
    r = materialSample(exp, sh, rB, { mis: false });
    m += (r.contribution[0]+r.contribution[1]+r.contribution[2])/3;
  }
  mcL += a/spp; mcM += m/spp; used++;
}
console.log('manual used', used, 'mcL', mcL.toFixed(5), 'mcM', mcM.toFixed(5), 'ratio L/ref', (mcL/ref).toFixed(3), 'M/ref', (mcM/ref).toFixed(3));
