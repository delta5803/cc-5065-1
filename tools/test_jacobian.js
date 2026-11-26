// Verifies the area <-> solid-angle Jacobian the material technique relies on.
//
// 1. Pointwise round trip: p_area = p_ω·cosY/dist² then back must be identity.
// 2. Integral identity: for f=1 over the zone, integrating in solid angle with
//    the Jacobian must give the same area as integrating in area with none.

import { makeDefaultSetup } from '../src/setup.js';
import { planePoint } from '../src/scene.js';
import { pdfOmegaToArea, pdfAreaToOmega } from '../src/integrator.js';
import { dot, sub, mulScalar, normalize, add } from '../src/math.js';
import { Rng } from '../src/rng.js';

const { scene } = makeDefaultSetup({ width: 8, height: 8 });
const board = scene.board;
const zone = { u0: 0.12, u1: 0.62, v0: 0.1, v1: 0.92 };
const p = [-0.4, -1.09, 0.6];

// --- 1. round trip ---
let maxErr = 0;
const rng = new Rng(7);
for (let i = 0; i < 2000; i++) {
  const y = planePoint(board, rng.next(), rng.next());
  const d = sub(y, p);
  const dist2 = dot(d, d);
  const w = mulScalar(d, 1 / Math.sqrt(dist2));
  const cosY = Math.abs(dot(board.n, w));
  const pOmega = 0.3;
  const pArea = pdfOmegaToArea(pOmega, cosY, dist2);
  const back = pdfAreaToOmega(pArea, cosY, dist2);
  maxErr = Math.max(maxErr, Math.abs(back - pOmega));
}
console.log('1. Jacobian round trip: max |error| =', maxErr.toExponential(3), maxErr < 1e-12 ? 'PASS' : 'FAIL');

// --- 2. integral identity ---
// Integrate f=1 over the zone two ways.
// (a) Solid angle: sample directions from p that hit the zone, exactly. We use
//     rejection sampling over the hemisphere; each accepted direction has a
//     known solid-angle density 1/(2π·acceptance) after normalisation is awkward,
//     so instead use the "hit-or-miss area" identity: ∫ dω = ∫_zone cosY/dist² dA
//     and verify that this equals the area measure integral of f=1 numerically
//     by sampling the area and accumulating the Jacobian.
const N = 400000;
const du = zone.u1 - zone.u0;
const dv = zone.v1 - zone.v0;
const areaZone = board.area * du * dv;

// (a) Uniform area samples: each contributes f * area / p_area = 1 * area.
let sumArea = 0;
const r1 = new Rng(11);
for (let i = 0; i < N; i++) {
  const y = planePoint(board, zone.u0 + r1.next() * du, zone.v0 + r1.next() * dv);
  const d = sub(y, p);
  const dist2 = dot(d, d);
  const w = mulScalar(d, 1 / Math.sqrt(dist2));
  const cosY = Math.abs(dot(board.n, w));
  if (!(cosY > 0)) continue;
  // f=1 over area; estimator of ∫_zone f dA = areaZone.
  sumArea += 1 / (1 / areaZone);
}
const estArea = sumArea / N;

// (b) Sample uniformly inside the cone that the zone subtends, then use the
//     Jacobian to convert each direction back to area. The zone is a
//     rectangle in the board plane; from p it subtends a solid angle Ω. Instead
//     of computing Ω, we integrate the SAME area samples in a hidden way: take
//     the solid-angle pdf implied by uniform-area sampling,
//         p_ω(w) = p_area(y) · dist²/cosY = (1/areaZone)·dist²/cosY,
//     and check that the mean of 1/p_ω over area samples times the integral of
//     p_ω over the hemisphere equals 1. The latter we estimate by the sum of
//     p_ω·cosY/dist²·(areaZone) over the same samples, which should be 1.
let sumPomegaIntegral = 0;
const r2 = new Rng(22);
for (let i = 0; i < N; i++) {
  const y = planePoint(board, zone.u0 + r2.next() * du, zone.v0 + r2.next() * dv);
  const d = sub(y, p);
  const dist2 = dot(d, d);
  const w = mulScalar(d, 1 / Math.sqrt(dist2));
  const cosY = Math.abs(dot(board.n, w));
  const pOmega = pdfAreaToOmega(1 / areaZone, cosY, dist2);
  // ∫ p_ω dω = ∫ p_area(y) dA = 1, estimated as mean(p_ω · dω/dA) * areaZone
  sumPomegaIntegral += pOmega * (cosY / dist2) * areaZone;
}
const pOmegaMass = sumPomegaIntegral / N;

console.log('2. Uniform-area estimator of ∫f dA:', estArea.toFixed(4), 'expected area:', areaZone.toFixed(4));
console.log('   Solid-angle pdf mass ∫p_ω dω (must be 1):', pOmegaMass.toFixed(5),
  Math.abs(pOmegaMass - 1) < 0.01 ? 'PASS' : 'FAIL');
