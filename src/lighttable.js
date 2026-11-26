// Light tables and proposals.
//
// A table is a weighted union of rectangles in the board's (u,v) space. Its
// density in AREA measure at a point is
//     p_table(uv) = Σ_{rects containing uv}  weight_i / (board.area · uvArea_i)
// Sampling a table picks a rect by weight and a point uniformly inside it.
//
// Using rect unions (rather than a single rect) makes reweighting a real
// operation: a retained table can be clipped to a new zone and its rect weights
// renormalised. If a retained table does not cover part of the new zone, that
// part has zero table density and reweighting alone can never give it positive
// probability — the caller must add a covering component or discard the table.

import { inRect, subtractRects } from './scene.js';

const uvRectArea = (r) => Math.max(0, r.u1 - r.u0) * Math.max(0, r.v1 - r.v0);

export function intersectZone(a, b) {
  return {
    u0: Math.max(a.u0, b.u0), u1: Math.min(a.u1, b.u1),
    v0: Math.max(a.v0, b.v0), v1: Math.min(a.v1, b.v1),
  };
}
const zoneNonEmpty = (r) => r.u1 - r.u0 > 1e-12 && r.v1 - r.v0 > 1e-12;

// Is `zone` fully covered by the union of `coverZones`?
export function zoneCoveredBy(zone, coverZones) {
  let remaining = [{ ...zone }];
  for (const cz of coverZones) {
    remaining = remaining.flatMap(r => subtractRects(r, cz));
    if (remaining.length === 0) return true;
  }
  return remaining.length === 0;
}

export function uncoveredParts(zone, coverZones) {
  let remaining = [{ ...zone }];
  for (const cz of coverZones) {
    remaining = remaining.flatMap(r => subtractRects(r, cz));
    if (remaining.length === 0) break;
  }
  return remaining.filter(zoneNonEmpty);
}

function normalizeRects(rects) {
  let sum = 0;
  for (const r of rects) sum += r.weight;
  if (!(sum > 0)) return [];
  return rects.map(r => ({ ...r, weight: r.weight / sum }));
}

export function buildLightTable(board, zone, name = '') {
  if (!zoneNonEmpty(zone)) throw new Error(`light table ${name}: empty emitting zone`);
  const rects = normalizeRects([{ ...zone, weight: 1 }]);
  return {
    board,
    name,
    rects,
    emittingArea: board.area * uvRectArea(zone),
    zone: { ...zone },
  };
}

// Density in AREA measure at a uv point.
export function tablePdfArea(table, uv) {
  let p = 0;
  for (const r of table.rects) {
    if (inRect(uv, r, 1e-12)) {
      p += r.weight / (table.board.area * uvRectArea(r));
    }
  }
  return p;
}

export function tableCoversZone(table, zone) {
  return zoneCoveredBy(zone, table.rects);
}

// Clip a table to `zone` and renormalise rect weights by clipped overlap area.
// Returns null when the table has no support inside the zone.
export function reweightTable(table, zone) {
  const rects = [];
  for (const r of table.rects) {
    const inter = intersectZone(r, zone);
    if (!zoneNonEmpty(inter)) continue;
    const overlapArea = uvRectArea(inter);
    rects.push({ ...inter, weight: r.weight * overlapArea });
  }
  if (rects.length === 0) return null;
  const norm = normalizeRects(rects);
  return {
    board: table.board,
    name: `${table.name} (reweighted)`,
    rects: norm,
    emittingArea: table.emittingArea,
    zone,
    reweighted: true,
  };
}

export function sampleTable(table, rng) {
  let r = rng.next();
  let chosen = table.rects[table.rects.length - 1];
  for (const rect of table.rects) {
    if (r < rect.weight || rect === table.rects[table.rects.length - 1]) {
      chosen = rect;
      break;
    }
    r -= rect.weight;
  }
  const u = chosen.u0 + rng.next() * (chosen.u1 - chosen.u0);
  const v = chosen.v0 + rng.next() * (chosen.v1 - chosen.v0);
  const { origin, a, b } = table.board;
  const p = [
    origin[0] + a[0] * u + b[0] * v,
    origin[1] + a[1] * u + b[1] * v,
    origin[2] + a[2] * u + b[2] * v,
  ];
  return { p, uv: { u, v }, table };
}

// A proposal is a weighted mixture of tables. MIS must use the MIXTURE density.
export function makeProposal(tables, weights) {
  if (tables.length === 0) throw new Error('proposal: no tables');
  let sum = 0;
  for (const w of weights) {
    if (!(w > 0)) throw new Error('proposal: non-positive weight');
    sum += w;
  }
  const components = tables.map((t, i) => ({ table: t, weight: weights[i] / sum }));
  return {
    components,
    tables: tables.slice(),
    weights: components.map(c => c.weight),
    pdfAreaAt(uv) {
      let p = 0;
      for (const c of components) p += c.weight * tablePdfArea(c.table, uv);
      return p;
    },
    sample(rng) {
      let r = rng.next();
      let chosen = components[components.length - 1];
      for (const c of components) {
        if (r < c.weight || c === components[components.length - 1]) {
          chosen = c;
          break;
        }
        r -= c.weight;
      }
      const s = sampleTable(chosen.table, rng);
      s.pdfArea = this.pdfAreaAt(s.uv);
      s.componentWeight = chosen.weight;
      s.component = chosen.table;
      return s;
    },
    supportsZone(zone) {
      return zoneCoveredBy(zone, components.flatMap(c => c.table.rects));
    },
  };
}

export function zoneContains(outerZone, innerZone) {
  return (
    innerZone.u0 >= outerZone.u0 - 1e-12 && innerZone.u1 <= outerZone.u1 + 1e-12 &&
    innerZone.v0 >= outerZone.v0 - 1e-12 && innerZone.v1 <= outerZone.v1 + 1e-12
  );
}

export { uvRectArea };
