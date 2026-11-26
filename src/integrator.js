// Multi-strategy direct-lighting kernel.
//
// Both techniques estimate the same integral over the CURRENT exposure's
// emitting zone:
//
//   I = ∫_zone  L_e(y) · fr(x, wo, wi) · V(x,y) · G(x,y)  dA(y)
//   wi = (y - x)/|y - x|,  G = |cosθ_x| |cosθ_y| / |y - x|²
//
// Light technique  : sample y from the light proposal in AREA measure.
// Material technique: sample ω from the BRDF mixture in SOLID-ANGLE measure,
//                     trace to y, then convert its density to AREA measure
//                     (p_area = p_ω · cosθ_y / |y-x|²) before combining.
//
// MIS weights are evaluated in that shared AREA measure. Densities of zero are
// handled explicitly (the other technique receives the full weight). Emission
// is always resolved against the CURRENT exposure, never a retained table.

import {
  add, dot, length, mulScalar, normalize, sub,
} from './math.js';
import {
  trace, hitNormal, surfaceMaterial, inRect, subtractRects, planePoint, planeUV,
} from './scene.js';
import { pdfBrdf, sampleMaterial, evalBrdf } from './brdf.js';
import { streamSeed, Rng } from './rng.js';

const ZERO = [0, 0, 0];
const BG = [0.0008, 0.0009, 0.0012];

const v3add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const v3scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const v3mul = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const lum = (c) => (c[0] + c[1] + c[2]) / 3;

// ---- explicit measure conversion ----

// Solid angle pdf -> area pdf on the emitter.
export function pdfOmegaToArea(pdfOmega, cosY, dist2) {
  if (!(dist2 > 0) || !(cosY > 0) || !(pdfOmega > 0)) return 0;
  return (pdfOmega * cosY) / dist2;
}
// Area pdf -> solid angle pdf (the Jacobian is dist²/cosY).
export function pdfAreaToOmega(pdfArea, cosY, dist2) {
  if (!(dist2 > 0) || !(cosY > 0) || !(pdfArea > 0)) return 0;
  return (pdfArea * dist2) / cosY;
}
export function jacobianCosOverDist2(cosY, dist2) {
  return dist2 > 0 && cosY > 0 ? cosY / dist2 : 0;
}

// ---- region partition (diagnostics) ----

export function intersectRect(a, b) {
  return {
    u0: Math.max(a.u0, b.u0), u1: Math.min(a.u1, b.u1),
    v0: Math.max(a.v0, b.v0), v1: Math.min(a.v1, b.v1),
  };
}
const rectNonEmpty = (r) => r.u1 - r.u0 > 1e-9 && r.v1 - r.v0 > 1e-9;

export function buildRegions(zone, historyZones) {
  const shared = [];
  const oldOnly = [];
  if (!historyZones || historyZones.length === 0) {
    // No retained history: everything that emits is simply "bright".
    return { bright: [{ ...zone }], shared, newOnly: [], oldOnly };
  }
  let newOnly = [{ ...zone }];
  for (const old of historyZones) {
    const inter = intersectRect(zone, old);
    if (rectNonEmpty(inter)) shared.push(inter);
    newOnly = newOnly.flatMap(r => subtractRects(r, old));
    for (const piece of subtractRects(old, zone)) if (rectNonEmpty(piece)) oldOnly.push(piece);
  }
  newOnly = newOnly.filter(rectNonEmpty);
  return { bright: [{ ...zone }], shared, newOnly, oldOnly };
}

export function overlapRegionOf(uv, regions) {
  for (const r of regions.newOnly) if (inRect(uv, r)) return 'newOnly';
  for (const r of regions.shared) if (inRect(uv, r)) return 'shared';
  for (const r of regions.oldOnly) if (inRect(uv, r)) return 'oldOnly';
  if (regions.bright.some(r => inRect(uv, r))) return 'bright';
  return 'dark';
}

// ---- shading context ----

export function makeShading(scene, hit, rd) {
  const wo = mulScalar(rd, -1);
  const n = hitNormal(hit, wo);
  const sm = surfaceMaterial(scene, hit);
  return { p: hit.p, wo, n, base: sm.base, material: sm.material, isSphere: hit.isSphere, obj: hit.obj };
}

function emitterCos(board, wi) {
  return Math.abs(dot(board.n, wi));
}

// Resolve the CURRENT exposure's emission at point y. Returns null when y is
// not on the emitting zone of this exposure.
function currentEmission(exposure, y) {
  const uv = planeUV(exposure.board, y);
  if (!uv || !uv.inBounds) return null;
  if (!inRect(uv, exposure.zone)) return null;
  return { uv, emission: exposure.albedo };
}

function emitterVisible(scene, x, y, board) {
  const d = sub(y, x);
  const dist = length(d);
  if (!(dist > 1e-9)) return false;
  const hit = trace(scene, x, mulScalar(d, 1 / dist), 1e-5);
  if (!hit) return true;
  if (hit.obj === board && Math.abs(hit.t - dist) < 1e-3) return true;
  return hit.t >= dist - 1e-3;
}

// A contribution record carries everything needed to audit a sampled path.
function makeRecord(technique, extra) {
  return {
    technique,
    y: null, uv: null,
    pL_area: 0, pM_area: 0, pOmega: 0,
    dist: 0, cosX: 0, cosY: 0, G: 0, jacobian: 0,
    visible: false, emission: ZERO, fr: ZERO, f: ZERO,
    weight: 0, contribution: ZERO, region: 'none', reason: '',
    ...extra,
  };
}

// Light-strategy sample at shading point sh.
export function lightSample(exposure, sh, rng, { mis = true } = {}) {
  const { scene, board, zone, proposal, albedo } = exposure;
  const s = proposal.sample(rng);
  const rec = makeRecord('light', { y: s.p, uv: s.uv, pL_area: s.pdfArea });
  const d = sub(s.p, sh.p);
  const dist2 = dot(d, d);
  if (!(dist2 > 1e-18)) { rec.reason = 'degenerate distance'; return rec; }
  const dist = Math.sqrt(dist2);
  const wi = mulScalar(d, 1 / dist);
  const cosX = dot(sh.n, wi);
  if (!(cosX > 0)) { rec.reason = 'shading cosine <= 0'; return rec; }
  rec.dist = dist;
  rec.cosX = cosX;
  rec.cosY = emitterCos(board, wi);
  rec.jacobian = jacobianCosOverDist2(rec.cosY, dist2);
  const em = currentEmission(exposure, s.p);
  if (!em) { rec.reason = 'sampled masked/out-of-zone point (this exposure)'; return rec; }
  rec.emission = em.emission;
  rec.visible = emitterVisible(scene, sh.p, s.p, board);
  if (!rec.visible) { rec.reason = 'occluded'; return rec; }
  const e = evalBrdf(sh.material, sh.base, sh.n, sh.wo, wi);
  if (!e) { rec.reason = 'brdf rejected direction'; return rec; }
  rec.fr = e.fr;
  rec.G = (cosX * rec.cosY) / dist2;
  rec.f = v3scale(v3mul(albedo, e.fr), rec.G);
  const pOmega = pdfBrdf(sh.material, sh.n, sh.wo, wi);
  rec.pOmega = pOmega;
  rec.pM_area = pdfOmegaToArea(pOmega, rec.cosY, dist2);
  let w = 1;
  if (mis) {
    const denom = rec.pL_area + rec.pM_area;
    w = denom > 0 ? rec.pL_area / denom : 1;
    if (!(rec.pM_area > 0)) rec.reason = 'material pdf = 0 -> full weight';
  }
  rec.weight = w;
  rec.contribution = v3scale(rec.f, w / rec.pL_area);
  rec.region = overlapRegionOf(em.uv, exposure.regions);
  return rec;
}

// Material-strategy sample at shading point sh.
export function materialSample(exposure, sh, rng, { mis = true } = {}) {
  const { scene, board, zone, proposal, albedo } = exposure;
  const rec = makeRecord('material', { visible: true });
  const smp = sampleMaterial(sh.material, sh.base, sh.n, sh.wo, rng);
  if (!smp) { rec.reason = 'material sample failed'; rec.visible = false; return rec; }
  rec.lobe = smp.sampledLobe;
  rec.pOmega = smp.pdf;
  const origin = add(sh.p, mulScalar(sh.n, 1e-4));
  const hit = trace(scene, origin, smp.wi, 1e-5);
  if (!hit) { rec.reason = 'escaped'; rec.visible = false; return rec; }
  if (hit.obj !== board) { rec.reason = 'hit non-emitter'; rec.visible = false; return rec; }
  const y = hit.p;
  rec.y = y;
  const uv = planeUV(board, y);
  rec.uv = uv;
  const d = sub(y, sh.p);
  const dist2 = dot(d, d);
  if (!(dist2 > 1e-18)) { rec.reason = 'degenerate distance'; return rec; }
  const dist = Math.sqrt(dist2);
  rec.dist = dist;
  rec.cosX = dot(sh.n, smp.wi);
  rec.cosY = emitterCos(board, smp.wi);
  rec.jacobian = jacobianCosOverDist2(rec.cosY, dist2);
  const em = currentEmission(exposure, y);
  rec.region = uv ? overlapRegionOf(uv, exposure.regions) : 'none';
  if (!em) { rec.reason = 'hit masked/out-of-zone point (this exposure)'; return rec; }
  if (!(rec.cosX > 0) || !(rec.cosY > 0)) { rec.reason = 'cosine <= 0'; return rec; }
  rec.emission = em.emission;
  rec.fr = smp.eval.fr;
  rec.G = (rec.cosX * rec.cosY) / dist2;
  rec.f = v3scale(v3mul(albedo, smp.eval.fr), rec.G);
  // Material density converted to the common area measure.
  rec.pM_area = pdfOmegaToArea(smp.pdf, rec.cosY, dist2);
  if (!(rec.pM_area > 0)) { rec.reason = 'area pdf = 0'; return rec; }
  // Light density MUST come from this exposure's proposal, not from history.
  rec.pL_area = proposal.pdfAreaAt(uv);
  let w = 1;
  if (mis) {
    const denom = rec.pL_area + rec.pM_area;
    w = denom > 0 ? rec.pM_area / denom : 1;
    if (!(rec.pL_area > 0)) rec.reason = 'light pdf = 0 -> full weight';
  }
  rec.weight = w;
  rec.contribution = v3scale(rec.f, w / rec.pM_area);
  return rec;
}

// ---- image rendering ----

function camRay(cam, px, py) {
  const sx = ((px + 0.5) / cam.width) * 2 - 1;
  const sy = 1 - ((py + 0.5) / cam.height) * 2;
  const dir = add(
    add(cam.forward, mulScalar(cam.right, sx * cam.halfW)),
    mulScalar(cam.up, sy * cam.halfH),
  );
  return { o: cam.eye, d: normalize(dir) };
}

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

export function renderImage({
  exposure, cam, spp, seed, strategy = 'combined', recordPixel = -1, recordLimit = 40,
  rowFactory = null,
}) {
  const { scene } = exposure;
  const { width, height } = cam;
  const rgb = new Float64Array(width * height * 3);
  const regionEnergy = { bright: [0, 0, 0], shared: [0, 0, 0], newOnly: [0, 0, 0], oldOnly: [0, 0, 0], dark: [0, 0, 0] };
  const stats = {
    lightSamples: 0, materialSamples: 0,
    lightNonzero: 0, materialNonzero: 0,
    lightZeroPdf: 0, materialZeroPdf: 0,
    occluded: 0, maskedHits: 0, escaped: 0,
  };
  const records = [];
  const nLight = strategy === 'light' ? spp : strategy === 'material' ? 0 : Math.ceil(spp / 2);
  const nMat = spp - nLight;
  const t0 = now();
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const pix = py * width + px;
      const rng = new Rng(streamSeed(seed, pix));
      const ray = camRay(cam, px, py);
      const hit = trace(scene, ray.o, ray.d, 1e-5);
      let color;
      if (!hit) color = BG.slice();
      else if (hit.obj === scene.board) {
        const uv = planeUV(scene.board, hit.p);
        color = inRect(uv, exposure.zone) ? exposure.albedo.slice() : ZERO.slice();
      } else {
        const sh = makeShading(scene, hit, ray.d);
        // Accumulate each technique separately and normalise by its OWN sample
        // count. Under MIS with balance weights, E[Σ_L w_L f/p_L] alone is only
        // the light technique's share of the integral; the two shares add to the
        // full integral. Summing then dividing by the combined spp would halve
        // the result.
        const accL = [0, 0, 0];
        const accM = [0, 0, 0];
        const recWanted = { light: [], material: [] };
        for (let i = 0; i < nLight; i++) {
          const rec = lightSample(exposure, sh, rng, { mis: strategy === 'combined' });
          stats.lightSamples++;
          if (rec.reason.includes('material pdf = 0')) stats.lightZeroPdf++;
          if (rec.reason === 'occluded') stats.occluded++;
          if (rec.reason.includes('masked')) stats.maskedHits++;
          if (pix === recordPixel) collectRecord(recWanted.light, rec, recordLimit);
          if (lum(rec.contribution) > 0) {
            stats.lightNonzero++;
            add3(accL, rec.contribution);
            addRegion(regionEnergy, rec.region, rec.contribution, nLight);
          }
        }
        for (let i = 0; i < nMat; i++) {
          const rec = materialSample(exposure, sh, rng, { mis: strategy === 'combined' });
          stats.materialSamples++;
          if (rec.reason.includes('light pdf = 0')) stats.materialZeroPdf++;
          if (rec.reason === 'escaped') stats.escaped++;
          if (rec.reason.includes('masked')) stats.maskedHits++;
          if (pix === recordPixel) collectRecord(recWanted.material, rec, recordLimit);
          if (lum(rec.contribution) > 0) {
            stats.materialNonzero++;
            add3(accM, rec.contribution);
            addRegion(regionEnergy, rec.region, rec.contribution, nMat);
          }
        }
        if (pix === recordPixel) {
          // Show successful paths first, then a few rejected ones for diagnosis.
          records.push(...recWanted.light.slice(0, Math.ceil(recordLimit / 2)));
          records.push(...recWanted.material.slice(0, Math.floor(recordLimit / 2)));
        }
        const cL = nLight > 0 ? v3scale(accL, 1 / nLight) : ZERO;
        const cM = nMat > 0 ? v3scale(accM, 1 / nMat) : ZERO;
        color = [cL[0] + cM[0], cL[1] + cM[1], cL[2] + cM[2]];
      }
      rgb[pix * 3] = color[0];
      rgb[pix * 3 + 1] = color[1];
      rgb[pix * 3 + 2] = color[2];
    }
    if (rowFactory) rowFactory(py + 1, height);
  }
  return { rgb, width, height, regionEnergy, stats, records, ms: now() - t0, spp, strategy, seed };
}

function add3(a, b) { a[0] += b[0]; a[1] += b[1]; a[2] += b[2]; }

// Keep a successful path preferentially so the inspector shows real weights;
// fall back to rejected paths when every sample failed.
function collectRecord(bucket, rec, limit) {
  const ok = lum(rec.contribution) > 0;
  if (ok) bucket.unshift(rec);
  else if (bucket.length < limit) bucket.push(rec);
  while (bucket.length > limit) bucket.pop();
}

// Each technique's per-region sum is normalised by its own sample count, so
// aggregating across techniques is a plain addition of estimates.
function addRegion(regionEnergy, region, c, count) {
  const key = regionEnergy[region] ? region : 'dark';
  const inv = count > 0 ? 1 / count : 0;
  regionEnergy[key][0] += c[0] * inv;
  regionEnergy[key][1] += c[1] * inv;
  regionEnergy[key][2] += c[2] * inv;
}

// ---- deterministic regional quadrature reference ----

export function quadrature({ exposure, cam, grid = 32, pixels = null }) {
  const { scene, board } = exposure;
  const zone = exposure.zone;
  const regions = exposure.regions;
  const names = ['bright', 'shared', 'newOnly', 'oldOnly', 'dark'];
  const regionEnergy = {};
  for (const nm of names) regionEnergy[nm] = [0, 0, 0];
  const { width, height } = cam;
  const img = new Float64Array(width * height * 3);
  const list = pixels || Array.from({ length: width * height }, (_, i) => i);
  const cellArea = board.area / (grid * grid);
  for (const pix of list) {
    const px = pix % width;
    const py = Math.floor(pix / width);
    const ray = camRay(cam, px, py);
    const hit = trace(scene, ray.o, ray.d, 1e-5);
    let color;
    if (!hit) color = BG.slice();
    else if (hit.obj === board) {
      const uv = planeUV(board, hit.p);
      color = inRect(uv, zone) ? exposure.albedo.slice() : ZERO.slice();
    } else {
      const sh = makeShading(scene, hit, ray.d);
      const acc = [0, 0, 0];
      for (let j = 0; j < grid; j++) {
        for (let i = 0; i < grid; i++) {
          const u = (i + 0.5) / grid;
          const v = (j + 0.5) / grid;
          if (!inRect({ u, v }, zone)) continue;
          const y = planePoint(board, u, v);
          const d = sub(y, sh.p);
          const dist2 = dot(d, d);
          if (!(dist2 > 1e-12)) continue;
          const dist = Math.sqrt(dist2);
          const wi = mulScalar(d, 1 / dist);
          const cosX = dot(sh.n, wi);
          const cosY = emitterCos(board, wi);
          if (!(cosX > 0) || !(cosY > 0)) continue;
          if (!emitterVisible(scene, sh.p, y, board)) continue;
          const e = evalBrdf(sh.material, sh.base, sh.n, sh.wo, wi);
          if (!e) continue;
          const contrib = v3scale(v3mul(exposure.albedo, e.fr), (cosX * cosY / dist2) * cellArea);
          add3(acc, contrib);
          const reg = overlapRegionOf({ u, v }, regions);
          add3(regionEnergy[regionEnergy[reg] ? reg : 'bright'], contrib);
        }
      }
      color = acc;
    }
    img[pix * 3] = color[0];
    img[pix * 3 + 1] = color[1];
    img[pix * 3 + 2] = color[2];
  }
  return { rgb: img, width, height, regionEnergy, grid };
}

// Full deterministic image for every pixel, including board pixels.
export function quadratureImage({ exposure, cam, grid = 32 }) {
  return quadrature({ exposure, cam, grid });
}

// Mean linear luminance of an image buffer.
export function meanLuminance(img) {
  let s = 0;
  const n = img.length / 3;
  for (let i = 0; i < n; i++) s += (img[i * 3] + img[i * 3 + 1] + img[i * 3 + 2]) / 3;
  return s / n;
}

export function imageRMSE(a, b) {
  let s = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s / n);
}

// ---- measure audit ----
// Both techniques estimate the SAME integral over the CURRENT zone, but they
// live in different measures (area vs solid angle). This audit converts both
// to the common area measure and compares each against a deterministic
// quadrature of the same domain, with a standard error for the samplers. A
// large gap between the two Monte Carlo estimates alone proves nothing (their
// variances differ); agreement with the deterministic reference does.

export function auditMeasures({ exposure, cam, spp = 256, seed = 987654, pixelBudget = 64, grid = 64, runsCount = 5 }) {
  const { scene, board } = exposure;
  const { width, height } = cam;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / pixelBudget)));
  const pixList = [];
  for (let y = Math.floor(step / 2); y < height; y += step) {
    for (let x = Math.floor(step / 2); x < width; x += step) pixList.push(y * width + x);
  }
  // Deterministic quadrature on the same pixels/domain. Compute it at two grids
  // and use the finer one; the coarse/fine gap is the reference's own
  // convergence error and is folded into the z-test below, so sparse-pixel
  // sampling near geometry edges cannot be mistaken for sampler bias.
  const qFine = quadrature({ exposure, cam, grid, pixels: pixList });
  const qCoarse = quadrature({ exposure, cam, grid: Math.max(16, Math.floor(grid / 2)), pixels: pixList });
  let ref = 0;
  let refCoarse = 0;
  for (const pix of pixList) {
    if (!isShadingPixel(scene, cam, pix)) continue;
    ref += lumColor(qFine.rgb, pix);
    refCoarse += lumColor(qCoarse.rgb, pix);
  }
  const refUncertainty = Math.abs(ref - refCoarse) / Math.max(1e-9, Math.abs(ref));

  // Run each technique over several INDEPENDENT seeds. Within one run the
  // per-sample variance cannot estimate the true spread of these heavy-tailed
  // estimators (a single firefly makes a run's own SE tiny while that run is far
  // off), so the honest uncertainty is the cross-run standard deviation of the
  // run totals. Only the cross-run SE is used to judge agreement.
  const runs = Math.max(2, runsCount);
  const areaRuns = [];
  const solidRuns = [];
  let used = 0;
  for (let r = 0; r < runs; r++) {
    let areaSum = 0;
    let solidSum = 0;
    let usedRun = 0;
    for (let k = 0; k < pixList.length; k++) {
      const pix = pixList[k];
      const ray = camRay(cam, pix % width, Math.floor(pix / width));
      const hit = trace(scene, ray.o, ray.d, 1e-5);
      if (!hit || hit.obj === board) continue;
      const sh = makeShading(scene, hit, ray.d);
      const rngA = new Rng(streamSeed(seed + r * 7919, k * 2));
      const rngB = new Rng(streamSeed(seed + r * 7919, k * 2 + 1));
      let a = 0;
      let s = 0;
      for (let i = 0; i < spp; i++) {
        a += lum(lightSample(exposure, sh, rngA, { mis: false }).contribution);
        s += lum(materialSample(exposure, sh, rngB, { mis: false }).contribution);
      }
      areaSum += a / spp;
      solidSum += s / spp;
      usedRun++;
    }
    areaRuns.push(areaSum);
    solidRuns.push(solidSum);
    used = usedRun;
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = (xs) => {
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
  };
  const areaEstimate = mean(areaRuns);
  const solidEstimate = mean(solidRuns);
  // Standard error OF THE MEAN, so a bias is what survives averaging many runs;
  // variance is what the SE band covers.
  const areaSe = sd(areaRuns) / Math.sqrt(runs);
  const solidSe = sd(solidRuns) / Math.sqrt(runs);
  const areaRelVsRef = Math.abs(areaEstimate - ref) / Math.max(1e-9, Math.abs(ref));
  const solidRelVsRef = Math.abs(solidEstimate - ref) / Math.max(1e-9, Math.abs(ref));
  // Deviation in combined uncertainty. Sampling error is the cross-run SE of the
  // pooled mean; the reference's own grid-convergence error is added in
  // quadrature so a deviation smaller than the reference's accuracy proves
  // nothing. Bias -> z grows with runs/spp; variance and reference error do not.
  const areaTotSe = Math.sqrt(areaSe ** 2 + (Math.abs(ref) * refUncertainty) ** 2);
  const solidTotSe = Math.sqrt(solidSe ** 2 + (Math.abs(ref) * refUncertainty) ** 2);
  const areaZ = areaTotSe > 1e-9 ? (areaEstimate - ref) / areaTotSe : 0;
  const solidZ = solidTotSe > 1e-9 ? (solidEstimate - ref) / solidTotSe : 0;
  return {
    pixels: used,
    spp,
    runs,
    reference: ref,
    referenceUncertainty: refUncertainty,
    areaEstimate,
    solidAngleEstimate: solidEstimate,
    areaSd: sd(areaRuns),
    solidSd: sd(solidRuns),
    areaSe,
    solidSe,
    areaZ,
    solidZ,
    areaRelVsRef,
    solidRelVsRef,
    jacobianForm: 'p_area = p_ω · cosθ_y / |y−x|²',
    note: 'each strategy is compared to deterministic quadrature over the same zone; ' +
      'separation is judged on the pooled mean over independent seeds, ' +
      'so heavy-tailed variance is not mistaken for bias',
  };
}

function lumColor(rgb, pix) {
  return (rgb[pix * 3] + rgb[pix * 3 + 1] + rgb[pix * 3 + 2]) / 3;
}
function isShadingPixel(scene, cam, pix) {
  const ray = camRay(cam, pix % cam.width, Math.floor(pix / cam.width));
  const hit = trace(scene, ray.o, ray.d, 1e-5);
  return hit && hit.obj !== scene.board;
}
