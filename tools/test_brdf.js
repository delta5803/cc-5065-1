// White-furnace / unbiasedness test for the BRDF sampler.
// Estimates ∫ fr(wo,wi) cosθi dωi by the sampler's own weight, and compares to
// a fine deterministic hemisphere quadrature. Also checks that the mixture pdf
// integrates to one.

import { sampleMaterial, evalBrdf, pdfBrdf } from '../src/brdf.js';
import { dot } from '../src/math.js';
import { Rng } from '../src/rng.js';

function testOne(mat, base, wo, label) {
  const n = [0, 0, 1];
  // Deterministic quadrature of ∫ fr cos dω.
  const N = 400;
  let fsum = [0, 0, 0];
  let pdfInt = 0;
  const domega = (2 * Math.PI) * (1 / N) * (Math.PI / 2 / N); // dphi * dtheta sin? do explicit
  let exact = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const th = (i + 0.5) / N * (Math.PI / 2);
    for (let j = 0; j < N * 2; j++) {
      const ph = (j + 0.5) / (N * 2) * 2 * Math.PI;
      const wi = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
      const dw = Math.sin(th) * (Math.PI / 2 / N) * (2 * Math.PI / (N * 2));
      const e = evalBrdf(mat, base, n, wo, wi);
      if (e) for (let k = 0; k < 3; k++) exact[k] += e.fr[k] * Math.cos(th) * dw;
      pdfInt += pdfBrdf(mat, n, wo, wi) * dw;
    }
  }
  // Monte Carlo estimate via the sampler.
  const rng = new Rng(12345);
  const M = 400000;
  let est = [0, 0, 0];
  let used = 0;
  for (let i = 0; i < M; i++) {
    const s = sampleMaterial(mat, base, n, wo, rng);
    if (!s) continue;
    used++;
    for (let k = 0; k < 3; k++) est[k] += s.weight[k];
  }
  for (let k = 0; k < 3; k++) est[k] /= M;
  const rel = exact.map((e, k) => Math.abs(est[k] - e) / Math.max(1e-9, e));
  console.log(
    `${label.padEnd(34)} wo=${wo.map(x=>x.toFixed(2)).join(',')} ` +
    `exact=${exact.map(x=>x.toFixed(4)).join(',')} ` +
    `est=${est.map(x=>x.toFixed(4)).join(',')} ` +
    `rel=${rel.map(x=>(x*100).toFixed(2)+'%').join(',')} ` +
    `pdfIntegral=${pdfInt.toFixed(3)} used=${(used/M*100).toFixed(1)}%`,
  );
}

const wo = [0, Math.sin(0.6), Math.cos(0.6)];
const cases = [
  ['rough dielectric white', { albedo: [0.8,0.8,0.8], roughness: 0.5, metallic: 0 }, [0.8,0.8,0.8]],
  ['smooth dielectric white', { albedo: [0.8,0.8,0.8], roughness: 0.08, metallic: 0 }, [0.8,0.8,0.8]],
  ['rough metal', { albedo: [0.9,0.7,0.4], roughness: 0.35, metallic: 1 }, [0.9,0.7,0.4]],
  ['smooth metal', { albedo: [0.9,0.9,0.9], roughness: 0.1, metallic: 1 }, [0.9,0.9,0.9]],
  ['black diffuse', { albedo: [0,0,0], roughness: 0.9, metallic: 0 }, [0,0,0]],
];
for (const [label, mat, base] of cases) testOne(mat, base, wo, label);
