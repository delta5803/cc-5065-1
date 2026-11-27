// Unified measure / event vocabulary for the multi-strategy lighting kernel.
//
// A sampling event can live in one of two measures:
//
//   AREA / SOLID_ANGLE  a *continuous* density. Converting between them is a
//                       Jacobian:  p_area = p_omega * cosY / dist².
//   POINT_MASS          a *discrete* event (a delta lobe). It has a selection
//                       probability q (a number in [0,1]), NOT a density. It
//                       must never be converted with the Jacobian and never be
//                       divided by an ordinary density.
//
// Keeping the vocabulary in one place lets the material sampler hand back
// {eventType, measure, selectionProb, density} and lets the combiner decide
// which contributions are comparable, instead of every call site guessing.

export const MEASURE = Object.freeze({
  AREA: 'area',
  SOLID_ANGLE: 'solidAngle',
  POINT_MASS: 'pointMass',
});

export const EVENT = Object.freeze({
  CONTINUOUS: 'continuous',
  DELTA: 'delta',
});

// Solid-angle pdf -> area pdf on the emitter.
export function pdfOmegaToArea(pdfOmega, cosY, dist2) {
  if (!(dist2 > 0) || !(cosY > 0) || !(pdfOmega > 0)) return 0;
  return (pdfOmega * cosY) / dist2;
}

// Area pdf -> solid-angle pdf (the Jacobian is dist²/cosY).
export function pdfAreaToOmega(pdfArea, cosY, dist2) {
  if (!(dist2 > 0) || !(cosY > 0) || !(pdfArea > 0)) return 0;
  return (pdfArea * dist2) / cosY;
}

export function jacobianCosOverDist2(cosY, dist2) {
  return dist2 > 0 && cosY > 0 ? cosY / dist2 : 0;
}

// Two sampling events may be combined by a density ratio only when both carry
// a continuous density in the same measure. A point mass is never comparable
// that way: the other strategy gives it zero probability.
export function comparableByDensity(a, b) {
  return (
    a != null && b != null &&
    a.eventType === EVENT.CONTINUOUS &&
    b.eventType === EVENT.CONTINUOUS &&
    a.measure === b.measure &&
    a.measure !== MEASURE.POINT_MASS &&
    a.density > 0 && b.density > 0
  );
}
