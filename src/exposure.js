// Exposure history controller.
//
// Each exposure has a current emitting zone and a light table. A retained
// table may join the proposal when it still assigns positive density to the
// whole current bright zone. Two legal move types:
//
//   reweight  - a retained table covers the new zone (possibly after clipping
//               to it); its rect weights are renormalised and it keeps a share
//               of the proposal. This is unbiased because evaluation always
//               uses the CURRENT exposure's emission and the MIXTURE density.
//   discard   - a retained table assigns zero probability to part of the new
//               bright zone; it cannot cover it alone, so it is either removed
//               or, if the caller asks, a covering component (the current
//               table) is added and both share the proposal.
//
// The controller records every decision so the UI and headless report can show
// exactly what changed between exposures.

import {
  buildLightTable, makeProposal, reweightTable, tableCoversZone, zoneCoveredBy,
} from './lighttable.js';
import { buildRegions } from './integrator.js';
import { subtractRects } from './scene.js';

export class ExposureController {
  constructor(scene, initialZone) {
    this.scene = scene;
    this.exposureIndex = 0;
    this.current = this._makeRecord(initialZone, 'initial');
    // The initial exposure must itself be retained, otherwise the first zone
    // change has no history to classify, reweight or discard.
    this.history = [{ table: this.current.table, zone: { ...initialZone }, index: 0 }];
    this.lastDecision = null;
  }

  _makeRecord(zone, source) {
    return {
      index: this.exposureIndex,
      zone: { ...zone },
      table: buildLightTable(this.scene.board, zone, source),
      zoneRecord: zone,
      proposal: null,
      regions: null,
      decisions: [],
      source,
    };
  }

  // Change the emitting zone.
  // policy: 'reweight' (default), 'discard', 'force-cover'
  advance(newZone, { policy = 'reweight' } = {}) {
    this.exposureIndex += 1;
    const current = this._makeRecord(newZone, `exposure ${this.exposureIndex}`);
    const decisions = [];

    // Classify retained tables against the new zone.
    const retained = this.history.map(h => h.table);
    const covering = retained.filter(t => tableCoversZone(t, newZone));
    const notCovering = retained.filter(t => !tableCoversZone(t, newZone));

    let components = [];
    // Original history zones that survive into this exposure's proposal. These
    // (not the clipped rects) define the shared/new-only region split.
    let keptHistoryZones = [];
    if (retained.length === 0) {
      decisions.push({
        action: 'current-only',
        reason: 'no retained history; the current exposure table is the only component',
      });
    } else if (notCovering.length === 0) {
      // Every retained table covers the new zone: reweight all of them.
      for (const t of retained) {
        components.push(reweightTable(t, newZone) || t);
      }
      keptHistoryZones = this.history.map(h => h.zone);
      decisions.push({
        action: 'reweight-all',
        reason: 'all retained tables still cover the new bright zone; their densities are re-normalised',
      });
    } else if (policy === 'force-cover' && covering.length > 0) {
      for (const t of covering) components.push(reweightTable(t, newZone) || t);
      keptHistoryZones = this.history.filter(h => covering.includes(h.table)).map(h => h.zone);
      decisions.push({
        action: 'reweight-covering-subset',
        reason: 'some retained tables give zero probability to part of the new zone; those are excluded',
        excluded: notCovering.length,
      });
    } else if (covering.length > 0) {
      // Drop only the tables that cannot cover the new zone (the "corresponding
      // history"), and reweight the ones that can. Discarding ALL history just
      // because one stale table is invalid would throw away good information
      // and needlessly change the estimator between exposures.
      for (const t of covering) components.push(reweightTable(t, newZone) || t);
      keptHistoryZones = this.history.filter(h => covering.includes(h.table)).map(h => h.zone);
      decisions.push({
        action: 'drop-uncovered',
        reason: 'retained table(s) that assign zero probability to part of the new bright zone ' +
          'are discarded; the tables that still cover the zone are re-weighted',
        discardedZones: notCovering.map(t => t.zone),
        uncovered: uncoveredArea(newZone, notCovering),
      });
    } else {
      decisions.push({
        action: 'discard-history',
        reason: 'no retained table covers the new bright zone; all history is discarded ' +
          '(changing weights could not give the new area any probability) and the ' +
          'current table becomes the proposal',
        discardedZones: retained.map(t => t.zone),
        uncovered: uncoveredArea(newZone, retained),
      });
      components = [];
      keptHistoryZones = [];
    }

    // Guarantee positive density over the entire new zone.
    if (!zoneCoveredBy(newZone, components.flatMap(t => t.rects))) {
      components.push(current.table);
      decisions.push({
        action: 'add-covering-component',
        reason: 'the retained proposal leaves part of the new zone at zero probability; ' +
          'the current exposure table is added so the proposal covers the whole zone',
      });
    }
    if (components.length === 0) components.push(current.table);
    const weights = components.map(() => 1);
    const proposal = makeProposal(components, weights);

    // Per-region partition: current emission split by overlap with retained
    // history zones, so whole-image agreement cannot hide per-region error.
    const regions = buildRegions(newZone, keptHistoryZones);

    current.proposal = proposal;
    current.regions = regions;
    current.decisions = decisions;

    const coverage = components.map((t, i) => ({
      weight: weights[i] / weights.reduce((a, b) => a + b, 0),
      isCurrent: t === current.table,
      rects: t.rects,
      coversNewZone: zoneCoveredBy(newZone, t.rects),
      uncoveredArea: uncoveredArea(newZone, [t]),
    }));

    this.lastDecision = { mode: modeFor(decisions), decisions, coverage, policy };
    this.history.push({ table: current.table, zone: { ...newZone }, index: current.index });
    if (this.history.length > 8) this.history = this.history.slice(-8);
    this.current = current;
    return { exposure: current, report: this.lastDecision };
  }

  exposureFor(record = this.current) {
    return {
      scene: this.scene,
      board: this.scene.board,
      zone: record.zone,
      proposal: record.proposal || makeProposal([record.table], [1]),
      regions: record.regions || buildRegions(record.zone, []),
      albedo: this.scene.board.albedo,
      decisions: record.decisions || [],
    };
  }
}

function modeFor(decisions) {
  const a = decisions.map(d => d.action);
  if (a.includes('discard-history')) return 'discard-history';
  if (a.includes('reweight-all')) return 'reweight-all';
  if (a.includes('reweight-covering-subset')) return 'reweight-covering-subset';
  if (a.includes('current-only')) return 'current-only';
  return a[0] || 'unknown';
}

// uv-area of `zone` not covered by any table's rects.
export function uncoveredArea(zone, tables) {
  let remaining = [{ ...zone }];
  for (const t of tables) {
    for (const r of t.rects || [t]) {
      remaining = remaining.flatMap(x => subtractRects(x, r));
    }
  }
  let a = 0;
  for (const r of remaining) a += Math.max(0, r.u1 - r.u0) * Math.max(0, r.v1 - r.v0);
  return a;
}

export function zoneFromRect(u0, v0, u1, v1) {
  return {
    u0: Math.max(0, Math.min(u0, u1)),
    u1: Math.min(1, Math.max(u0, u1)),
    v0: Math.max(0, Math.min(v0, v1)),
    v1: Math.min(1, Math.max(v0, v1)),
  };
}
