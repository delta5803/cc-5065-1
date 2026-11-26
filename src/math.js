// Deterministic vector math. Scene coordinates are Y-up, camera looks down -Z.

export function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function length(a) {
  return Math.hypot(a[0], a[1], a[2]);
}
export function normalize(a) {
  const l = length(a);
  if (!(l > 0)) throw new Error('normalize: zero-length vector');
  const inv = 1 / l;
  return [a[0] * inv, a[1] * inv, a[2] * inv];
}
export function neg(a) {
  return [-a[0], -a[1], -a[2]];
}
export function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function mulScalar(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function mulVec(a, b) {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}
export function reflect(d, n) {
  // d points toward the surface; n is the outward-facing normal (dot(d,n) < 0).
  return sub(d, mulScalar(n, 2 * dot(d, n)));
}

// Build an orthonormal basis (x, y) perpendicular to unit n.
export function tangentBasis(n) {
  const sign = n[1] >= 0 ? 1 : -1;
  const a = -1 / (sign + n[1]);
  const b = n[0] * n[2] * a;
  const x = [1 + sign * n[0] * n[0] * a, sign * b, -sign * n[0]];
  const z = [b, n[1] + sign * n[2] * n[2] * a, -n[2]];
  return { x, z };
}

// Orthonormal frame with n as the third axis.
export function orthonormalFrame(n) {
  const t = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  const b1 = normalize(cross(t, n));
  const b2 = cross(n, b1);
  return [b1, b2, n];
}
export function toLocal(v, frame) {
  return [dot(v, frame[0]), dot(v, frame[1]), dot(v, frame[2])];
}
export function fromLocal(l, frame) {
  return [
    l[0] * frame[0][0] + l[1] * frame[1][0] + l[2] * frame[2][0],
    l[0] * frame[0][1] + l[1] * frame[1][1] + l[2] * frame[2][1],
    l[0] * frame[0][2] + l[1] * frame[1][2] + l[2] * frame[2][2],
  ];
}
export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}
export function reflectDirAround(n, d) {
  return normalize(sub(mulScalar(n, 2 * dot(n, d)), d));
}
