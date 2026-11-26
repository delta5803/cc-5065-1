import { makeDefaultSetup, defaultZoneA, defaultZoneB } from '../src/setup.js';
import { renderImage, quadrature } from '../src/integrator.js';
import { trace, planeUV, inRect } from '../src/scene.js';

const { scene, cam, controller } = makeDefaultSetup({ width: 96, height: 64 });
const exp = controller.exposureFor();

function shadingTotal(rgb, scale) {
  // Sum linear rgb over shading pixels only (not board, not background).
  let s = 0;
  let count = 0;
  for (let i = 0; i < cam.width * cam.height; i++) {
    const px = i % cam.width, py = Math.floor(i / cam.width);
    const sx = ((px + 0.5) / cam.width) * 2 - 1;
    const sy = 1 - ((py + 0.5) / cam.height) * 2;
    const d = [
      cam.forward[0] + cam.right[0]*sx*cam.halfW + cam.up[0]*sy*cam.halfH,
      cam.forward[1] + cam.right[1]*sx*cam.halfW + cam.up[1]*sy*cam.halfH,
      cam.forward[2] + cam.right[2]*sx*cam.halfW + cam.up[2]*sy*cam.halfH,
    ];
    const L = Math.hypot(...d);
    const rd = [d[0]/L, d[1]/L, d[2]/L];
    const hit = trace(scene, cam.eye, rd, 1e-5);
    if (!hit || hit.obj === scene.board) continue;
    count++;
    s += (rgb[i*3] + rgb[i*3+1] + rgb[i*3+2]) / 3 * scale;
  }
  return { sum: s, count };
}

const q = quadrature({ exposure: exp, cam, grid: 64 });
const qt = shadingTotal(q.rgb, 1);
for (const strat of ['light', 'material', 'combined']) {
  const r = renderImage({ exposure: exp, cam, spp: 16, seed: 2024, strategy: strat });
  const st = shadingTotal(r.rgb, 1);
  console.log(strat, 'shading sum', st.sum.toFixed(4), 'count', st.count, 'quad', qt.sum.toFixed(4), 'rel', ((st.sum - qt.sum) / qt.sum * 100).toFixed(3) + '%');
  const rg = r.regionEnergy;
  const tot = (rg.bright[0]+rg.bright[1]+rg.bright[2]+rg.shared[0]+rg.shared[1]+rg.shared[2]+rg.newOnly[0]+rg.newOnly[1]+rg.newOnly[2]+rg.oldOnly[0]+rg.oldOnly[1]+rg.oldOnly[2]+rg.dark[0]+rg.dark[1]+rg.dark[2]) / 3;
  console.log('   region total', tot.toFixed(4));
}
const qr = q.regionEnergy;
console.log('quad region total', ((qr.bright[0]+qr.bright[1]+qr.bright[2]+qr.shared[0]+qr.shared[1]+qr.shared[2]+qr.newOnly[0]+qr.newOnly[1]+qr.newOnly[2]+qr.oldOnly[0]+qr.oldOnly[1]+qr.oldOnly[2]+qr.dark[0]+qr.dark[1]+qr.dark[2]) / 3).toFixed(4));
