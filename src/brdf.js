// Material sampling: a diffuse + GGX microfacet mixture. Both lobes are
// sampled in the projected-solid-angle measure and combined with a
// 50/50 lobe mixture. Every strategy returns {wi, weight = fr*cos/pdf, pdf}
// where pdf is the mixture density in the same measure.

import {
  dot, normalize, orthonormalFrame, toLocal, fromLocal,
  add, sub, mulScalar, length,
} from './math.js';

export function makeMaterial({ albedo, roughness, metallic = 0.0 }) {
  return { albedo, roughness: Math.max(0.02, roughness), metallic };
}

function fresnelSchlick(cosTheta, F0) {
  const m = Math.max(0, 1 - cosTheta);
  const m2 = m * m;
  const m5 = m2 * m2 * m;
  return [
    F0[0] + (1 - F0[0]) * m5,
    F0[1] + (1 - F0[1]) * m5,
    F0[2] + (1 - F0[2]) * m5,
  ];
}

function D_GGX(NoH, alpha) {
  const a2 = alpha * alpha;
  const d = NoH * NoH * (a2 - 1) + 1;
  return a2 / (Math.PI * d * d);
}

function G_SchlickGGX(NoV, alpha) {
  const k = alpha / 2;
  return NoV / (NoV * (1 - k) + k);
}

function G_Smith(NoV, NoL, alpha) {
  return G_SchlickGGX(NoV, alpha) * G_SchlickGGX(NoL, alpha);
}

function sampleGGXHalfVector(alpha, rng) {
  const u1 = rng.next();
  const u2 = rng.next();
  const phi = 2 * Math.PI * u1;
  const cosTheta = Math.sqrt((1 - u2) / (1 + (alpha * alpha - 1) * u2));
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  return [Math.cos(phi) * sinTheta, Math.sin(phi) * sinTheta, cosTheta];
}

// Reflect wo about half-vector h: wi = 2 (wo.h) h - wo.
function reflectAbout(h, wo) {
  const s = 2 * dot(wo, h);
  return normalize([s * h[0] - wo[0], s * h[1] - wo[1], s * h[2] - wo[2]]);
}

export function f0For(baseColor, metallic) {
  return baseColor.map(c => 0.04 + (c - 0.04) * metallic);
}

// Full BRDF value fr (diffuse + specular, NOT multiplied by cosine).
export function evalBrdf(mat, baseColor, n, wo, wi) {
  const NoL = dot(n, wi);
  const NoV = dot(n, wo);
  if (NoL <= 0 || NoV <= 0) return null;
  const alpha = mat.roughness * mat.roughness;
  const F0 = f0For(baseColor, mat.metallic);
  const diffuseColor = baseColor.map(x => x * (1 - mat.metallic));
  // Energy-normalised diffuse (Fdez-Aguera style gain). Keeps a black albedo
  // black, and keeps rough metals from losing all their diffuse energy.
  const E = 1 - 0.028 * mat.roughness;
  const diffuseGain = (1 - 0.04) * (1 - 0.04 * E);
  const frDiff = diffuseColor.map(c => (c * diffuseGain) / Math.PI);
  const total = add(wi, wo);
  const hLen = length(total);
  const h = hLen > 1e-12 ? mulScalar(total, 1 / hLen) : [0, 0, 1];
  const NoH = Math.max(1e-6, dot(n, h));
  const VoH = Math.max(0, dot(wo, h));
  const D = D_GGX(NoH, alpha);
  const G = G_Smith(NoV, NoL, alpha);
  const F = fresnelSchlick(VoH, F0);
  const frSpec = F.map(f => (f * D * G) / (4 * NoV * NoL));
  const fr = [0, 1, 2].map(i => frDiff[i] + frSpec[i]);
  return { fr, frDiff, frSpec, D, G, F, NoL, NoV, NoH, VoH, alpha };
}

// Mixture pdf used by sampleMaterial. Must stay in sync with that function.
export function pdfBrdf(mat, n, wo, wi) {
  const NoL = dot(n, wi);
  const NoV = dot(n, wo);
  if (NoL <= 0 || NoV <= 0) return 0;
  const alpha = mat.roughness * mat.roughness;
  const total = add(wi, wo);
  const hLen = length(total);
  if (!(hLen > 1e-12)) return 0;
  const h = mulScalar(total, 1 / hLen);
  const NoH = Math.max(1e-6, dot(n, h));
  const VoH = Math.max(1e-6, dot(wo, h));
  const pSpec = (D_GGX(NoH, alpha) * NoH) / (4 * VoH);
  const pDiff = NoL / Math.PI;
  return 0.5 * pSpec + 0.5 * pDiff;
}

export function sampleMaterial(mat, baseColor, n, wo, rng) {
  const alpha = mat.roughness * mat.roughness;
  const pickDiffuse = rng.next() < 0.5;
  const frame = orthonormalFrame(n);
  let wi;
  if (pickDiffuse) {
    const u1 = rng.next();
    const u2 = rng.next();
    const r = Math.sqrt(u1);
    const phi = 2 * Math.PI * u2;
    const local = [r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(Math.max(0, 1 - u1))];
    wi = normalize(fromLocal(local, frame));
    if (dot(n, wi) <= 0) return null;
  } else {
    const hm = sampleGGXHalfVector(alpha, rng);
    const h = normalize(fromLocal(hm, frame));
    wi = reflectAbout(h, wo);
    if (dot(n, wi) <= 0) return null;
  }
  // The actual sampling density is the 50/50 MIXTURE density, not the density
  // of the chosen lobe. Using the lobe density here would bias both the
  // material strategy and every MIS weight built on it.
  const pdf = pdfBrdf(mat, n, wo, wi);
  if (!(pdf > 1e-12)) return null;
  const e = evalBrdf(mat, baseColor, n, wo, wi);
  if (!e) return null;
  const weight = e.fr.map(f => (f * e.NoL) / pdf);
  return { wi, weight, pdf, sampledLobe: pickDiffuse ? 'diffuse' : 'ggx', eval: e };
}
