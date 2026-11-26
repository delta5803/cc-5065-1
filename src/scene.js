// Scene description. A rectangular emitter ("light board") split into an
// emitting zone and a black mask, a glossy sphere and a floor.
//
// Geometry is Y-up. The light board is a vertical rectangle in the plane
// z = -1.6 with normal +z (towards the camera). A control map resolves, per
// point on the board, whether it emits (inside the zone) or is a black,
// absorbing mask (outside it). The zone boundary can change between exposures.
//
// Everything is analytic: no ray-tracing library, no material preview shader.

import {
  add, cross, dot, length, mulScalar, normalize, sub, clamp,
} from './math.js';

export const BOARD_Z = -1.6;
export const FLOOR_Y = -1.1;
export const BOARD_COLOR = [26.0, 22.0, 17.0]; // linear HDR emitter radiance

export function makePlane({ name, origin, a, b, albedo, emissive = false, reflect = true, material = null }) {
  const n = normalize(cross(a, b));
  const area = length(a) * length(b);
  return {
    kind: 'plane',
    name,
    origin,
    a,
    b,
    n,
    area,
    albedo,
    emissive,
    reflect,
    material,
  };
}

export function planePoint(plane, u, v) {
  return add(plane.origin, add(mulScalar(plane.a, u), mulScalar(plane.b, v)));
}

// uv coordinates of a point that lies on the plane (ignores out-of-plane offset).
export function planeUV(plane, p) {
  const d = sub(p, plane.origin);
  const aLen2 = dot(plane.a, plane.a);
  const bLen2 = dot(plane.b, plane.b);
  const ab = dot(plane.a, plane.b);
  const ad = dot(plane.a, d);
  const bd = dot(plane.b, d);
  const det = aLen2 * bLen2 - ab * ab;
  if (Math.abs(det) < 1e-12) return null;
  const u = (ad * bLen2 - bd * ab) / det;
  const v = (bd * aLen2 - ad * ab) / det;
  return { u, v, inBounds: u >= 0 && u <= 1 && v >= 0 && v <= 1 };
}

export function intersectPlane(plane, ro, rd, eps) {
  const denom = dot(rd, plane.n);
  if (Math.abs(denom) < 1e-12) return Infinity;
  const t = dot(sub(plane.origin, ro), plane.n) / denom;
  if (!(t > eps)) return Infinity;
  const uv = planeUV(plane, add(ro, mulScalar(rd, t)));
  if (!uv || !uv.inBounds) return Infinity;
  return t;
}

export function intersectSphere(s, ro, rd, eps) {
  const oc = sub(ro, s.center);
  const b = dot(oc, rd);
  const c = dot(oc, oc) - s.radius * s.radius;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (!(t > eps)) t = -b + sq;
  if (!(t > eps)) return Infinity;
  return t;
}

export function trace(scene, ro, rd, eps = 1e-6) {
  let best = Infinity;
  let hitObj = null;
  for (const plane of scene.planes) {
    const t = intersectPlane(plane, ro, rd, eps);
    if (t < best) {
      best = t;
      hitObj = plane;
    }
  }
  for (const s of scene.spheres) {
    const t = intersectSphere(s, ro, rd, eps);
    if (t < best) {
      best = t;
      hitObj = s;
    }
  }
  if (!hitObj) return null;
  const p = add(ro, mulScalar(rd, best));
  return {
    t: best,
    obj: hitObj,
    p,
    isSphere: hitObj.kind === 'sphere',
    uv: hitObj.kind === 'plane' ? planeUV(hitObj, p) : null,
  };
}

export function visible(scene, from, to, eps = 1e-5) {
  const d = sub(to, from);
  const dist = length(d);
  if (!(dist > eps)) return false;
  const hit = trace(scene, from, mulScalar(d, 1 / dist), eps);
  return !hit || hit.t >= dist - 1e-4;
}

// Normal at a hit, oriented toward the viewer/wo.
export function hitNormal(hit, wo) {
  let n;
  if (hit.isSphere) {
    n = normalize(sub(hit.p, hit.obj.center));
  } else {
    n = hit.obj.n;
  }
  if (dot(n, wo) < 0) n = mulScalar(n, -1);
  return n;
}

// Build the scene for a given light-board scale and offset.
export function buildScene({ lightScale = 1, lightOffset = [0, 0], sphereMaterial }) {
  const w = 3.0 * lightScale;
  const h = 3.0 * lightScale;
  const board = makePlane({
    name: 'light',
    origin: [-w / 2 + lightOffset[0], 0.4 - h / 2 + lightOffset[1], BOARD_Z],
    a: [w, 0, 0],
    b: [0, h, 0],
    albedo: BOARD_COLOR,
    emissive: true,
    reflect: false,
  });
  const floor = makePlane({
    name: 'floor',
    origin: [-7, FLOOR_Y, -7],
    a: [14, 0, 0],
    b: [0, 0, -14],
    albedo: [0.42, 0.44, 0.47],
    material: { roughness: 0.85, metallic: 0.0 },
  });
  const sphere = {
    kind: 'sphere',
    name: 'sphere',
    center: [0.6, FLOOR_Y + 0.62, 0.35],
    radius: 0.62,
    material: sphereMaterial || { roughness: 0.18, metallic: 0.85 },
  };
  return {
    planes: [board, floor],
    spheres: [sphere],
    board,
    floor,
    sphere,
  };
}

export function makeCamera({ width, height, eye = [0, 0.35, 3.9], target = [0.05, 0.05, -0.7], fovDeg = 42 }) {
  const fov = (fovDeg * Math.PI) / 180;
  const forward = normalize(sub(target, eye));
  const worldUp = [0, 1, 0];
  const right = normalize(cross(forward, worldUp));
  const up = cross(right, forward);
  const halfH = Math.tan(fov / 2);
  const halfW = halfH * (width / height);
  return { width, height, eye, forward, right, up, halfW, halfH };
}

// Primary ray through the centre of pixel (px, py).
export function cameraRay(cam, px, py) {
  // Pixel (0,0) is top-left.
  const sx = ((px + 0.5) / cam.width) * 2 - 1;
  const sy = 1 - ((py + 0.5) / cam.height) * 2;
  const dir = normalize(add(
    add(cam.forward, mulScalar(cam.right, sx * cam.halfW)),
    mulScalar(cam.up, sy * cam.halfH),
  ));
  return { o: cam.eye, d: dir };
}

// ---- rectangle helpers in (u, v) space ----

export function rectAreaUV(r) {
  return Math.max(0, r.u1 - r.u0) * Math.max(0, r.v1 - r.v0);
}

export function inRect(uv, r, eps = 0) {
  return uv.u >= r.u0 - eps && uv.u <= r.u1 + eps && uv.v >= r.v0 - eps && uv.v <= r.v1 + eps;
}

export function clipRect(r) {
  return {
    u0: clamp(r.u0, 0, 1),
    u1: clamp(r.u1, 0, 1),
    v0: clamp(r.v0, 0, 1),
    v1: clamp(r.v1, 0, 1),
  };
}

export function rectContains(outer, inner, eps = 1e-9) {
  return (
    inner.u0 >= outer.u0 - eps && inner.u1 <= outer.u1 + eps &&
    inner.v0 >= outer.v0 - eps && inner.v1 <= outer.v1 + eps
  );
}

// Area of the part of `a` not covered by `b`, plus a list of covering rects.
export function subtractRects(a, b) {
  if (b.u1 <= a.u0 || b.u0 >= a.u1 || b.v1 <= a.v0 || b.v0 >= a.v1) return [a];
  const out = [];
  const midU0 = Math.max(a.u0, b.u0);
  const midU1 = Math.min(a.u1, b.u1);
  const midV0 = Math.max(a.v0, b.v0);
  const midV1 = Math.min(a.v1, b.v1);
  if (midV0 > a.v0) out.push({ u0: a.u0, u1: a.u1, v0: a.v0, v1: midV0 });
  if (midV1 < a.v1) out.push({ u0: a.u0, u1: a.u1, v0: midV1, v1: a.v1 });
  if (midU0 > a.u0) out.push({ u0: a.u0, u1: midU0, v0: midV0, v1: midV1 });
  if (midU1 < a.u1) out.push({ u0: midU1, u1: a.u1, v0: midV0, v1: midV1 });
  return out.filter(r => r.u1 - r.u0 > 1e-12 && r.v1 - r.v0 > 1e-12);
}

// Per-hit surface material record.
export function surfaceMaterial(scene, hit) {
  if (hit.isSphere) {
    return { base: [0.72, 0.74, 0.78], material: hit.obj.material };
  }
  const plane = hit.obj;
  if (plane.material) return { base: plane.albedo, material: plane.material };
  return { base: plane.albedo, material: { roughness: 0.9, metallic: 0 } };
}

export function isBoard(scene, obj) {
  return obj === scene.board;
}
