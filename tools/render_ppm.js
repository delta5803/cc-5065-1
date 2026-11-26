// Renders a clean combined-strategy image plus the deterministic reference to
// PNG-ish PPM files so I can inspect the actual pixels (no browser needed).
import { buildScene, makeCamera } from '../src/scene.js';
import { ExposureController } from '../src/exposure.js';
import { renderImage, quadrature, meanLuminance } from '../src/integrator.js';
import { tonemap } from '../src/display.js';
import fs from 'node:fs';

const W = 384, H = 256;
const scene = buildScene({ lightScale: 1, sphereMaterial: { roughness: 0.18, metallic: 0.85 } });
const cam = makeCamera({ width: W, height: H });
const ctrl = new ExposureController(scene, { u0: 0.12, u1: 0.62, v0: 0.10, v1: 0.92 });
const exp = ctrl.exposureFor();

function writePPM(path, rgb, exposure = 1.1) {
  const buf = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const t = tonemap([rgb[i*3], rgb[i*3+1], rgb[i*3+2]], exposure);
    buf[i*3] = Math.round(t[0]*255);
    buf[i*3+1] = Math.round(t[1]*255);
    buf[i*3+2] = Math.round(t[2]*255);
  }
  const header = Buffer.from(`P6\n${W} ${H}\n255\n`);
  fs.writeFileSync(path, Buffer.concat([header, buf]));
}

const res = renderImage({ exposure: exp, cam, spp: 128, seed: 20261126, strategy: 'combined' });
console.log('combined 128spp meanL', meanLuminance(res.rgb).toFixed(4));
writePPM('/tmp/combined.ppm', res.rgb);

const q = quadrature({ exposure: exp, cam, grid: 128 });
console.log('quadrature meanL', meanLuminance(q.rgb).toFixed(4));
writePPM('/tmp/ref.ppm', q.rgb);

// Convert PPM to PNG via canvas-less: write structural stats of the image.
let minL = 1e9, maxL = -1e9, sumL = 0;
for (let i = 0; i < W*H; i++) {
  const l = 0.2126*res.rgb[i*3]+0.7152*res.rgb[i*3+1]+0.0722*res.rgb[i*3+2];
  minL = Math.min(minL, l); maxL = Math.max(maxL, l); sumL += l;
}
console.log('render luminance range', minL.toFixed(3), '..', maxL.toFixed(3), 'avg', (sumL/(W*H)).toFixed(3));
console.log('wrote /tmp/combined.ppm and /tmp/ref.ppm');
