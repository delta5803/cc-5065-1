// Material sampling: a diffuse + GGX microfacet mixture. Both lobes are
// sampled in the projected-solid-angle measure and combined with a
// 50/50 lobe mixture. Every strategy returns {wi, weight = fr*cos/pdf, pdf}
// where pdf is the mixture density in the same measure.
//
// An OPTIONAL perfect-mirror *delta* lobe can be added with `deltaMix > 0`.
// That lobe is a discrete event: it has a selection probability, not a density,
// and lives in the point-mass measure. The default (deltaMix = 0) reproduces the
// original continuous-only sampler exactly, including its RNG consumption, so
// existing scenes are unchanged.

import {
  dot, normalize, orthonormalFrame, toLocal, fromLocal,
  add, sub, mulScalar, length, reflectDirAround,
} from './math.js';
import { MEASURE, EVENT } from './measure.js';

export function makeMaterial({ albedo, roughness, metallic = 0.0, deltaMix = 0.0 }) {
  return {
    albedo,
    roughness: Math.max(0.02, roughness),
    metallic,
    deltaMix: Math.max(0, Math.min(1, deltaMix)),
  };
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

// ---- inspectable probability interfaces ----
//
// The task is to keep the *discrete selection probability* (a point mass) and
// the *continuous direction density* (a solid-angle pdf) as separate, checkable
// things. These three helpers make that split explicit; callers must not read a
// continuous density on behalf of a delta event, nor divide a delta by one.

// Selection probability of each material event type. Sums to 1. For the
// original continuous-only material, delta = 0 and continuous = 1.
export function materialEventProbabilities(mat) {
  const delta = Math.max(0, Math.min(1, mat.deltaMix || 0));
  return { continuous: 1 - delta, delta };
}

// Continuous direction density in SOLID ANGLE (no delta). This is what a light
// technique's density comparison may use.
export function continuousPdfBrdf(mat, n, wo, wi) {
  return pdfBrdf(mat, n, wo, wi);
}

// Reflectance of the discrete mirror lobe: the fraction of radiance reflected
// into the exact mirror direction. This is a *weight*, not a density; it is the
// value the delta event contributes (L_e · R) and must never be divided by a
// continuous pdf.
export function evalMirrorReflectance(mat, baseColor, n, wo) {
  const NoV = dot(n, wo);
  if (!(NoV > 0)) return null;
  const F0 = f0For(baseColor, mat.metallic);
  return fresnelSchlick(NoV, F0);
}

export function sampleMaterial(mat, baseColor, n, wo, rng, { forceEvent = null } = {}) {
  const alpha = mat.roughness * mat.roughness;
  // An opt-in discrete mirror event. Only when deltaMix > 0 do we draw the type
  // selector, so the default material consumes RNG exactly as before.
  // `forceEvent` renders one lobe in isolation (for the additivity check):
  //   'delta'      -> only the mirror lobe, with selection probability 1
  //   'continuous' -> only the continuous lobes, with selection probability 1
  const deltaMix = mat.deltaMix || 0;
  // The delta lobe exists only when deltaMix > 0. Forcing 'delta' on a material
  // that has no delta lobe must produce nothing, not a fabricated mirror event.
  const hasDelta = deltaMix > 0;
  const wantsDelta = hasDelta && forceEvent === 'delta';
  const wantsContinuous = forceEvent === 'continuous';
  const deltaProb = wantsDelta ? 1 : wantsContinuous ? 0 : deltaMix;
  const continuousProb = wantsContinuous ? 1 : wantsDelta ? 0 : (1 - deltaMix);
  if (deltaProb > 0 && (wantsDelta || rng.next() < deltaProb)) {
    const wi = reflectDirAround(n, wo);
    if (dot(n, wi) <= 0) return null;
    const mirrorReflectance = evalMirrorReflectance(mat, baseColor, n, wo);
    if (!mirrorReflectance) return null;
    return {
      wi,
      eventType: EVENT.DELTA,
      measure: MEASURE.POINT_MASS,
      selectionProb: deltaProb,
      density: 0,
      pdf: 0,
      weight: null,
      mirrorReflectance,
      sampledLobe: 'mirror-delta',
      eval: null,
    };
  }
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
  // material strategy and every MIS weight built on it. `selectionProb` is the
  // probability this sampler actually used for the continuous branch, so a
  // forced-single-lobe render (continuousProb = 1) is normalised consistently.
  const pdf = pdfBrdf(mat, n, wo, wi);
  if (!(pdf > 1e-12)) return null;
  const e = evalBrdf(mat, baseColor, n, wo, wi);
  if (!e) return null;
  const weight = e.fr.map(f => (f * e.NoL) / pdf);
  return {
    wi,
    weight,
    pdf,
    eventType: EVENT.CONTINUOUS,
    measure: MEASURE.SOLID_ANGLE,
    selectionProb: continuousProb,
    density: pdf,
    sampledLobe: pickDiffuse ? 'diffuse' : 'ggx',
    eval: e,
  };
}
