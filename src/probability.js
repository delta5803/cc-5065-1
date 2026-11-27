// Explicit sampling-probability interface.
//
// This module is the single place that answers, for a sampled event:
//   * does it belong to a CONTINUOUS density or a POINT-MASS (delta) event?
//   * which MEASURE is its density expressed in (area / solid angle / none)?
//   * how much probability mass did the sampler assign to that event type?
//
// Splitting these out is the point of the refactor: a delta lobe has a
// *selection probability* and no density, so it must never be divided by a
// continuous density or converted with the area<->solid-angle Jacobian. The
// multi-strategy combiner asks this interface which contributions are
// comparable instead of assuming every technique speaks the same measure.

import { materialEventProbabilities, continuousPdfBrdf } from './brdf.js';
import { pdfOmegaToArea, MEASURE, EVENT } from './measure.js';

// Light strategy: a continuous density in AREA measure from the current
// exposure's proposal. Never stale history.
export function lightEvent(exposure, uv) {
  const density = exposure.proposal.pdfAreaAt(uv);
  return { eventType: EVENT.CONTINUOUS, measure: MEASURE.AREA, density };
}

// Material strategy: the discrete selection probability of each event type.
export function materialEventProbabilitiesAt(sh) {
  return materialEventProbabilities(sh.material);
}

// Material *continuous* event, expressed in the common AREA measure. The
// continuous selection probability is folded in, because the material strategy
// only emits a continuous direction that often; a delta lobe contributes
// nothing to this density. `selectionProbOverride` lets a caller (e.g. a
// forced-single-lobe render) state the probability actually used instead of
// the material's default split.
export function materialContinuousEvent(sh, wi, cosY, dist2, pdfOmegaOverride, selectionProbOverride) {
  const probs = materialEventProbabilities(sh.material);
  const pdfOmega = pdfOmegaOverride != null
    ? pdfOmegaOverride
    : continuousPdfBrdf(sh.material, sh.n, sh.wo, wi);
  const sel = selectionProbOverride != null ? selectionProbOverride : probs.continuous;
  const density = pdfOmegaToArea(pdfOmega * sel, cosY, dist2);
  return { eventType: EVENT.CONTINUOUS, measure: MEASURE.AREA, density, pdfOmega };
}

// Material *delta* event: a point mass with a selection probability and no
// density. `density` is deliberately absent/zero so no caller can divide by it.
export function materialDeltaEvent(sh) {
  const probs = materialEventProbabilities(sh.material);
  return {
    eventType: EVENT.DELTA,
    measure: MEASURE.POINT_MASS,
    density: 0,
    selectionProb: probs.delta,
  };
}

// The multi-strategy combiner. Given the event a strategy actually sampled
// (`own`) and the competing strategy's event at the SAME direction (`other`),
// decide whether the two are comparable as densities and, if so, the balance
// weight. Returns the reason so callers can record *why* a weight is 1 instead
// of silently dividing by a mismatched quantity.
export function misCombine(own, other) {
  if (!own) return { weight: 0, comparable: false, reason: 'no own event' };
  if (own.eventType === EVENT.DELTA) {
    return {
      weight: 1, comparable: false,
      reason: 'discrete event: other strategy assigns it zero probability -> full weight',
    };
  }
  if (!other) return { weight: 1, comparable: false, reason: 'no competing event -> full weight' };
  if (other.eventType === EVENT.DELTA) {
    return {
      weight: 1, comparable: false,
      reason: 'competing event is discrete (zero continuous density) -> full weight',
    };
  }
  if (own.measure !== other.measure || own.measure === MEASURE.POINT_MASS) {
    return {
      weight: 1, comparable: false,
      reason: `incomparable measures (${own.measure} vs ${other.measure}) -> full weight`,
    };
  }
  const denom = own.density + other.density;
  if (!(denom > 0)) return { weight: 1, comparable: false, reason: 'zero combined density -> full weight' };
  return {
    weight: own.density / denom,
    comparable: own.density > 0,
    reason: !(own.density > 0)
      ? 'own density = 0 -> weight 0 (zero-probability event reported, not divided)'
      : other.density > 0 ? '' : 'competing density = 0 -> full weight',
  };
}

export function balanceWeight(own, other) {
  return misCombine(own, other).weight;
}

// Which contributions may be compared (density ratio) in a combined strategy?
export function comparable(own, other) {
  return misCombine(own, other).comparable;
}
