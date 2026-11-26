import { makeDefaultSetup } from '../src/setup.js';
import { renderImage, quadrature } from '../src/integrator.js';
import { trace } from '../src/scene.js';
import { add, mulScalar, length } from '../src/math.js';

const { scene, cam, controller } = makeDefaultSetup({ width: 96, height: 64 });
const exp = controller.exposureFor();

function shadingSum(rgb) {
  let s = 0;
  for (let i = 0; i < cam.width * cam.height; i++) {
    const px = i % cam.width, py = Math.floor(i / cam.width);
    const sx = ((px + 0.5) / cam.width) * 2 - 1;
    const sy = 1 - ((py + 0.5) / cam.height) * 2;
    const d = add(add(cam.forward, mulScalar(cam.right, sx * cam.halfW)), mulScalar(cam.up, sy * cam.halfH));
    const rd = mulScalar(d, 1 / length(d));
    const hit = trace(scene, cam.eye, rd, 1e-5);
    if (!hit || hit.obj === scene.board) continue;
    s += (rgb[i*3] + rgb[i*3+1] + rgb[i*3+2]) / 3;
  }
  return s;
}

const q = quadrature({ exposure: exp, cam, grid: 96 });
const qt = shadingSum(q.rgb);
console.log('quadrature shading sum (grid 96):', qt.toFixed(4));

const RUNS = 40;
for (const spp of [8, 32, 128]) {
  for (const strat of ['light', 'material', 'combined']) {
    const vals = [];
    for (let r = 0; r < RUNS; r++) {
      const res = renderImage({ exposure: exp, cam, spp, seed: 90000 + r * 2654435761 % 2147483647, strategy: strat });
      vals.push(shadingSum(res.rgb));
    }
    const mean = vals.reduce((a,b)=>a+b,0)/vals.length;
    const varr = vals.reduce((a,b)=>a+(b-mean)**2,0)/(vals.length-1);
    const sd = Math.sqrt(varr);
    console.log(`${strat.padEnd(9)} spp=${String(spp).padStart(3)} mean=${mean.toFixed(3)} bias=${((mean-qt)/qt*100).toFixed(2)}% sd=${sd.toFixed(3)}`);
  }
}
