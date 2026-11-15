/**
 * "Cut the water": which valves have to be closed so that a water main is left without water.
 *
 * The council's data has no record of how pipes join, so it is worked out here from where they are:
 *   - two mains join where their ends meet (closer than `joinM`), or where the end of one meets the
 *     middle of another (a branch taken off a main);
 *   - mains that only cross each other do not join;
 *   - each shut-off valve is put on a main it can shut: the nearest one (within `valveM`) of about its
 *     own size (`minSizeRatio`: a 100 mm valve shuts a 125 mm plastic main, not a 200 mm one) – at a
 *     junction the main of its size, and a little in from that main's end, so that it shuts that branch
 *     only; a main of exactly its size may be up to `sameSizeM` away (the map is not that exact). A
 *     valve on a property connection of its size, or far smaller than any main near it (a service, scour
 *     or branch valve), cuts no main and is kept aside with the reason. What the council says of a valve
 *     counts for more than its recorded size: a scour, irrigation or service valve (`role`) shuts nothing;
 *     a valve it calls a sluice, in-line or isolating valve, drawn on a main, shuts that main; and a size
 *     that is a blanket value of the as-built job (`sizeDoubt`: whole subdivisions have every valve at
 *     50 mm, on 100 and 150 mm mains) does not rule a main out, only makes a main of that size preferred.
 *     Air, non-return and pressure-reducing valves shut nothing and are left out.
 * The mains are then cut at every valve into stretches ("segments") that only valves separate.
 *
 * To cut the water at a place, as real isolation tools do (Esri's isolation trace, the segment-valve
 * graph of the literature – docs/research/reports/Cortes de agua en redes potables.md): the search
 * starts from its stretch and goes outwards through valves that "will not close", to the valves round
 * it. Of those, only a valve with a source of water beyond it has to be closed: a reservoir, a treatment
 * plant, a bore, a pump station, or a main that leaves the mapped area. A valve on a branch that only
 * leads to houses can stay open – that branch loses its water too, and is counted. A pump station or
 * reservoir on the cut stretch itself is named: its own valves are inside it, not on the council's map.
 * Mains that almost meet (`gapM`) count as joined when looking for the water (the safe side), and so
 * does an area beyond a valve too big to be fed only through the cut (`bigAreaM`, `bigAreaConnections`:
 * QLDC's code keeps a DN150 shutdown to 40 connections) – the map just does not show its source. A
 * valve that is normally closed already stops the water. If the map shows no source at all for the
 * stretch, every valve round it is listed.
 *
 * The same picture of the network gives an estimate of which way the water runs in each main
 * (`flowFrom`): away from where it comes in – a reservoir, treatment plant or bore – by the shortest
 * way along the pipes, through valves that are open; a pumped ("rising") main, away from its pump
 * station. A main that water reaches from both ends, one that both fills and empties a reservoir, and
 * one no source reaches get none. It is an estimate: under pressure the real direction changes with
 * demand.
 *
 * Pure: plain data in and out, no imports. `buildShutoffNetwork` runs once for the whole district
 * (scripts/data/build-shutoff.mjs writes data/water-shutoff.json); `segmentAt` and `isolate` run in the
 * page (src/tools/shutoffView.js).
 */

/** What the council says a valve is for, when that is not shutting a main (see scripts/data/convert-qldc-networks.mjs). */
const NOT_SHUT_OFF_ROLES = new Set(['scour', 'irrigation', 'service', 'notLine']);

/** Valves that can be closed by hand to shut a main. */
export const SHUT_OFF_TYPES = new Set(['Valve on the main', 'Valve', 'Zone valve', 'Sluice valve', 'Gate valve', 'Ball valve']);

const DEFAULTS = {
  joinM: 0.5, // ends (or an end and the middle of a main) this close meet
  valveM: 1.5, // a valve this close to a main is on it…
  minSizeRatio: 0.7, // …if it is at least this share of the main's size (plastic mains go by outer size: 100 mm valve, 125 mm pipe)
  sameSizeM: 3, // a main of the valve's own size may be this far away
  connectionValveM: 0.5, // a valve this close to a property connection of its size is that connection's
  onMainM: 0.3, // a valve the council calls a line valve, drawn this close to a main, is on it whatever its size
  endInsetM: 0.3, // a valve recorded at a junction is put this far in from the end of its main
  connectionM: 1.5, // a property connection whose joining end is this close to a main joins it
  hydrantM: 3, // a hydrant this close to a main is fed by it
  sourceM: 5, // a main this close to the outline of a reservoir, pump station… is fed by it
  gapM: 3, // a main's end this close to another main may be joined to it (the map is not that exact)
  edgeM: 30, // a main's end whose way on leaves the mapped area within this distance leaves it
  flowShare: 0.8, // a piece of main has a direction when the water reaches one end this share of its length sooner
  unplacedNearM: 15, // valves on no main, this close to a stretch, are shown with it
  endMarkM: 3, // an end cap or a hydrant this close to the end of a main confirms it as an end
};

const GRID_M = 20;

/** Metres east and north of an origin, close enough over the district. */
function projector([lon0, lat0]) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  return {
    toXY: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLonLat: ([x, y]) => [lon0 + x / kx, lat0 + y / ky],
  };
}

/** A line in metres with the distance along it at every vertex. */
function measureLine(points) {
  const along = [0];
  for (let i = 1; i < points.length; i += 1) along.push(along[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  return { points, along, length: along.at(-1) };
}

/** The nearest point of a measured line to `p`: { alongM, distance }. */
function projectOnLine({ points, along }, p) {
  let best = { alongM: 0, distance: Infinity };
  for (let i = 1; i < points.length; i += 1) {
    const [ax, ay] = points[i - 1];
    const dx = points[i][0] - ax;
    const dy = points[i][1] - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / lengthSquared)) : 0;
    const distance = Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy);
    if (distance < best.distance) best = { alongM: along[i - 1] + t * (along[i] - along[i - 1]), distance };
  }
  return best;
}

/**
 * Works out how the mains join and where the valves cut them.
 * @param {object} input
 * @param {{ id, zone, street, diameter, type?, line: number[][] }[]} input.mains  in use, [lon, lat] lines
 *   (type: "Rising main (pumped)" and "Rising and falling main" matter for the flow estimate)
 * @param {{ id, zone, type, position, diameter, street, depth, at: number[], role?, sizeDoubt?, note? }[]} input.valves  every valve
 *   of the water supply (role: what the council says it is for; sizeDoubt: its size is a blanket value)
 * @param {{ line: number[][], joins?: 0 | 1, diameter?: number }[]} [input.laterals]  property connections (joins: the end on the main)
 * @param {number[][]} [input.hydrants]  [lon, lat] of each hydrant
 * @param {number[][]} [input.endCaps]   [lon, lat] of each end cap recorded on a main
 * @param {{ kind, type, name, at: number[], outline?: number[][][][] }[]} [input.sources]  where water comes
 *   from: reservoirs, treatment plants, bores, pump stations (outline: polygons of [lon, lat] rings)
 * @param {number[][]} [input.coverage]  the mapped area, as [west, south, east, north] boxes
 * @returns {{ mains, pieces: number[][], segments: object[], valves: object[], sources: object[], gaps: object[], unplacedValves: object[], unplaced: number }}
 *   mains: as given, each with flowFrom where the water probably runs from one end to the other (0: from
 *   its first point, 1: from its last);
 *   pieces: [main, fromM, toM, segment] – the stretches of each main between valves and junctions;
 *   segments: { lengthM, connections, hydrants, valves: number[], and when there are any: sources (index
 *   in sources), edges (where a main leaves the mapped area), deadEnds, gaps (index in gaps), unplaced };
 *   valves: the shut-off valves put on a main, with { main, alongM, segments };
 *   gaps: { segments: [a, b], distanceM, at } – a main's end near another main, not joined;
 *   unplacedValves: shut-off valves that cut no main, with why: 'far' (no main near), 'small' (far smaller
 *   than the main it is on: it cannot shut it), 'connection' (on a property connection), or the council's
 *   word for it: 'scour', 'irrigation', 'service', 'notLine'; unplaced: how many
 */
export function buildShutoffNetwork({ mains, valves, laterals = [], hydrants = [], endCaps = [], sources = [], coverage }, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const projection = projector(mains[0]?.line[0] ?? [0, 0]);
  const lines = mains.map((m) => measureLine(m.line.map(projection.toXY)));

  // Where the mains run, for finding them near a point.
  const grid = new Map();
  const cellKey = (x, y) => `${Math.floor(x / GRID_M)},${Math.floor(y / GRID_M)}`;
  lines.forEach(({ points }, m) => {
    for (let i = 1; i < points.length; i += 1) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      for (let gx = Math.floor(Math.min(ax, bx) / GRID_M); gx <= Math.floor(Math.max(ax, bx) / GRID_M); gx += 1) {
        for (let gy = Math.floor(Math.min(ay, by) / GRID_M); gy <= Math.floor(Math.max(ay, by) / GRID_M); gy += 1) {
          const key = `${gx},${gy}`;
          if (!grid.has(key)) grid.set(key, new Set());
          grid.get(key).add(m);
        }
      }
    }
  });
  /** Every main within `withinM` of p: [{ main, alongM, distance }], nearest first. */
  function mainsNear(p, withinM) {
    const seen = new Set();
    const found = [];
    const gx = Math.floor(p[0] / GRID_M);
    const gy = Math.floor(p[1] / GRID_M);
    for (let x = gx - 1; x <= gx + 1; x += 1) {
      for (let y = gy - 1; y <= gy + 1; y += 1) {
        for (const m of grid.get(`${x},${y}`) ?? []) {
          if (seen.has(m)) continue;
          seen.add(m);
          const near = projectOnLine(lines[m], p);
          if (near.distance <= withinM) found.push({ main: m, ...near });
        }
      }
    }
    return found.sort((a, b) => a.distance - b.distance);
  }

  /** Every main passing through a box [minX, minY, maxX, maxY] (by grid cell: a few more is fine). */
  function mainsInBox([x0, y0, x1, y1]) {
    const found = new Set();
    for (let gx = Math.floor(x0 / GRID_M); gx <= Math.floor(x1 / GRID_M); gx += 1) {
      for (let gy = Math.floor(y0 / GRID_M); gy <= Math.floor(y1 / GRID_M); gy += 1) for (const m of grid.get(`${gx},${gy}`) ?? []) found.add(m);
    }
    return found;
  }

  // Junctions: the ends of mains, those that meet merged into one.
  const nodes = []; // { xy, valve?: number, pieces: number[] }
  const nodeGrid = new Map();
  const cuts = lines.map(() => []); // per main: { alongM, node }
  function endNode(xy) {
    const gx = Math.floor(xy[0] / GRID_M);
    const gy = Math.floor(xy[1] / GRID_M);
    for (let x = gx - 1; x <= gx + 1; x += 1) {
      for (let y = gy - 1; y <= gy + 1; y += 1) {
        for (const n of nodeGrid.get(`${x},${y}`) ?? []) if (Math.hypot(nodes[n].xy[0] - xy[0], nodes[n].xy[1] - xy[1]) <= o.joinM) return n;
      }
    }
    nodes.push({ xy, pieces: [] });
    const key = cellKey(...xy);
    if (!nodeGrid.has(key)) nodeGrid.set(key, []);
    nodeGrid.get(key).push(nodes.length - 1);
    return nodes.length - 1;
  }
  lines.forEach(({ points, length }, m) => {
    cuts[m].push({ alongM: 0, node: endNode(points[0]) }, { alongM: length, node: endNode(points.at(-1)) });
  });
  // A branch: the end of one main on the middle of another.
  const junctionCount = nodes.length;
  for (let n = 0; n < junctionCount; n += 1) {
    for (const near of mainsNear(nodes[n].xy, o.joinM)) {
      const { length } = lines[near.main];
      if (near.alongM <= o.joinM || near.alongM >= length - o.joinM) continue; // at its end: met already, or a near miss
      if (cuts[near.main].some((c) => c.node === n)) continue;
      cuts[near.main].push({ alongM: near.alongM, node: n });
    }
  }

  // Shut-off valves, each on its nearest main.
  // Property connections, to tell their valves from those of the mains.
  const connectionGrid = new Map();
  const connectionLines = laterals.map(({ line, diameter }) => ({ diameter, line: measureLine(line.map(projection.toXY)) }));
  connectionLines.forEach(({ line }, n) => {
    for (const [x, y] of line.points) {
      const key = cellKey(x, y);
      if (!connectionGrid.has(key)) connectionGrid.set(key, new Set());
      connectionGrid.get(key).add(n);
    }
  });
  /** Whether a valve of this size sits on a property connection of about its size. */
  function onConnection(p, valveDiameter) {
    const gx = Math.floor(p[0] / GRID_M);
    const gy = Math.floor(p[1] / GRID_M);
    for (let x = gx - 1; x <= gx + 1; x += 1) {
      for (let y = gy - 1; y <= gy + 1; y += 1) {
        for (const n of connectionGrid.get(`${x},${y}`) ?? []) {
          const { diameter, line } = connectionLines[n];
          if (diameter && Math.abs(1 - valveDiameter / diameter) > 0.3) continue;
          if (projectOnLine(line, p).distance <= o.connectionValveM) return true;
        }
      }
    }
    return false;
  }

  const placed = [];
  const unplacedValves = [];
  for (const valve of valves) {
    if (!SHUT_OFF_TYPES.has(valve.type)) continue;
    if (NOT_SHUT_OFF_ROLES.has(valve.role)) {
      unplacedValves.push({ ...valve, why: valve.role });
      continue;
    }
    const p = projection.toXY(valve.at);
    const candidates = mainsNear(p, o.sameSizeM).map((c) => ({ ...c, ratio: valve.diameter && mains[c.main].diameter ? valve.diameter / mains[c.main].diameter : undefined }));
    const within = candidates.filter((c) => c.distance <= o.valveM);
    // The nearest main it can shut; between mains about as near (a junction), the one of its size.
    const mismatch = (c) => (c.ratio === undefined ? 0.2 : Math.min(1, Math.abs(1 - c.ratio)));
    const score = (c) => c.distance + 0.5 * mismatch(c);
    const canShut = (c) => c.ratio === undefined || c.ratio >= o.minSizeRatio || valve.sizeDoubt === true || (valve.role === 'line' && c.distance <= o.onMainM);
    let near = within.filter(canShut).reduce((best, c) => (!best || score(c) < score(best) ? c : best), undefined);
    // A valve on a property connection of its size is that connection's – unless a main is exactly its size.
    const connection = Boolean(valve.diameter) && onConnection(p, valve.diameter);
    if (near && connection && mismatch(near) > 0.05) near = undefined;
    // A main of its own size a little further away: the valve was drawn off its pipe.
    if (!near && !connection) near = candidates.find((c) => c.ratio !== undefined && Math.abs(1 - c.ratio) <= 0.26);
    if (!near) {
      unplacedValves.push({ ...valve, why: connection ? 'connection' : within.length ? 'small' : 'far' });
      continue;
    }
    const { length } = lines[near.main];
    const inset = Math.min(o.endInsetM, length / 2);
    const alongM = Math.min(length - inset, Math.max(inset, near.alongM));
    nodes.push({ xy: null, valve: placed.length, pieces: [] });
    cuts[near.main].push({ alongM, node: nodes.length - 1 });
    placed.push({ ...valve, main: near.main, alongM: round1(alongM), segments: [] });
  }

  // The stretches between cuts, and which of them water flows between freely (not through a valve).
  const pieces = []; // { main, from, to, a, b }
  cuts.forEach((list, m) => {
    list.sort((p, q) => p.alongM - q.alongM);
    for (let i = 1; i < list.length; i += 1) {
      pieces.push({ main: m, from: list[i - 1].alongM, to: list[i].alongM, a: list[i - 1].node, b: list[i].node });
      nodes[list[i - 1].node].pieces.push(pieces.length - 1);
      nodes[list[i].node].pieces.push(pieces.length - 1);
    }
  });
  const parent = pieces.map((_, i) => i);
  const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (const node of nodes) {
    if (node.valve !== undefined) continue;
    for (let k = 1; k < node.pieces.length; k += 1) parent[root(node.pieces[k])] = root(node.pieces[0]);
  }
  const segmentOf = new Map();
  const segments = [];
  const pieceSegment = pieces.map((_, i) => {
    const r = root(i);
    if (!segmentOf.has(r)) {
      segmentOf.set(r, segments.length);
      segments.push({ lengthM: 0, connections: 0, hydrants: 0, valves: [] });
    }
    return segmentOf.get(r);
  });
  pieces.forEach((piece, i) => (segments[pieceSegment[i]].lengthM += piece.to - piece.from));
  const deadEndNodes = [];
  nodes.forEach((node, n) => {
    if (node.valve !== undefined) {
      const valve = placed[node.valve];
      valve.segments = [...new Set(node.pieces.map((p) => pieceSegment[p]))];
      for (const s of valve.segments) segments[s].valves.push(node.valve);
    } else if (node.pieces.length === 1) {
      deadEndNodes.push(n);
    }
  });
  const addTo = (s, key, value) => (segments[s][key] ??= []).push(value);
  const lonLatOf = (xy) => projection.toLonLat(xy).map(round6);

  // What each stretch feeds: property connections and hydrants.
  const piecesOfMain = lines.map(() => []);
  pieces.forEach((piece, i) => piecesOfMain[piece.main].push(i));
  const segmentNear = (xy, withinM) => {
    const [near] = mainsNear(xy, withinM);
    if (!near) return undefined;
    const piece = piecesOfMain[near.main].find((p) => pieces[p].from <= near.alongM && near.alongM <= pieces[p].to);
    return piece === undefined ? undefined : pieceSegment[piece];
  };
  for (const { line, joins } of laterals) {
    const ends = joins === 0 ? [line[0]] : joins === 1 ? [line.at(-1)] : [line[0], line.at(-1)];
    const s = ends.map((end) => segmentNear(projection.toXY(end), o.connectionM)).find((found) => found !== undefined);
    if (s !== undefined) segments[s].connections += 1;
  }
  for (const hydrant of hydrants) {
    const s = segmentNear(projection.toXY(hydrant), o.hydrantM);
    if (s !== undefined) segments[s].hydrants += 1;
  }
  const segmentOnMain = (m, alongM) => {
    const piece = piecesOfMain[m].find((p) => pieces[p].from <= alongM && alongM <= pieces[p].to);
    return piece === undefined ? undefined : pieceSegment[piece];
  };

  // Where water comes from: the stretches that pass through or close to a reservoir, pump station…
  const sourceList = [];
  const entries = []; // where water comes in: { kind, node, offsetM }
  for (const source of sources) {
    const rings = (source.outline ?? []).map((polygon) => polygon[0].map(projection.toXY));
    const centre = projection.toXY(source.at);
    const isFedPoint = (p) =>
      rings.length ? rings.some((ring) => insideRing(p, ring) || distanceToRing(p, ring) <= o.sourceM) : Math.hypot(p[0] - centre[0], p[1] - centre[1]) <= o.sourceM;
    const all = [...rings.flat(), centre];
    const box = [Math.min(...all.map((p) => p[0])) - o.sourceM, Math.min(...all.map((p) => p[1])) - o.sourceM, Math.max(...all.map((p) => p[0])) + o.sourceM, Math.max(...all.map((p) => p[1])) + o.sourceM];
    const fed = new Set();
    for (const m of mainsInBox(box)) {
      for (const p of piecesOfMain[m]) {
        const { from, to } = pieces[p];
        const steps = Math.max(1, Math.ceil((to - from) / 2));
        for (let k = 0; k <= steps; k += 1) {
          const alongM = from + ((to - from) * k) / steps;
          if (isFedPoint(pointAt(lines[m], alongM))) {
            fed.add(pieceSegment[p]);
            const nearA = alongM - from <= to - alongM;
            entries.push({ kind: source.kind, node: nearA ? pieces[p].a : pieces[p].b, offsetM: nearA ? alongM - from : to - alongM });
            break;
          }
        }
      }
    }
    if (!fed.size) continue;
    for (const s of fed) addTo(s, 'sources', sourceList.length);
    sourceList.push({ kind: source.kind, type: source.type, name: source.name, at: source.at.map(round6) });
  }

  // The ends of mains that join nothing: leaving the mapped area (water may come from there), near
  // another main (perhaps joined to it: the map is not that exact), or plain dead ends.
  const inCoverage = (lonLat) => !coverage || coverage.some(([w, s, e, n]) => lonLat[0] >= w && lonLat[0] <= e && lonLat[1] >= s && lonLat[1] <= n);
  const gaps = [];
  const confirmedEnds = [...endCaps, ...hydrants].map(projection.toXY);
  for (const n of deadEndNodes) {
    const p = nodes[n].xy;
    const pieceIndex = nodes[n].pieces[0];
    const piece = pieces[pieceIndex];
    const s = pieceSegment[pieceIndex];
    const inward = pointAt(lines[piece.main], piece.a === n ? Math.min(piece.to, piece.from + 5) : Math.max(piece.from, piece.to - 5));
    const dx = p[0] - inward[0];
    const dy = p[1] - inward[1];
    const length = Math.hypot(dx, dy) || 1;
    const beyond = [p[0] + (dx / length) * o.edgeM, p[1] + (dy / length) * o.edgeM];
    if (coverage && !inCoverage(projection.toLonLat(beyond))) addTo(s, 'edges', lonLatOf(p));
    else {
      addTo(s, 'deadEnds', lonLatOf(p));
      // A real end has an end cap or a hydrant on it; without either, the pipe may carry on unmapped.
      if (!confirmedEnds.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= o.endMarkM)) segments[s].unconfirmedEnds = (segments[s].unconfirmedEnds ?? 0) + 1;
    }
    const near = mainsNear(p, o.gapM).find((m) => m.main !== piece.main);
    const other = near && segmentOnMain(near.main, near.alongM);
    if (other === undefined || other === s) continue;
    addTo(s, 'gaps', gaps.length);
    addTo(other, 'gaps', gaps.length);
    gaps.push({ segments: [s, other], distanceM: round1(near.distance), at: lonLatOf(p) });
  }

  // Valves on no main: shown with the stretch they are near (they may be the ones to close) – not
  // those of property connections, which shut one property only.
  unplacedValves.forEach((valve, u) => {
    if (!['far', 'small', 'scour'].includes(valve.why)) return; // a scour valve is where to drain the stretch
    const [near] = mainsNear(projection.toXY(valve.at), o.unplacedNearM);
    const s = near && segmentOnMain(near.main, near.alongM);
    if (s !== undefined) addTo(s, 'unplaced', u);
  });
  for (const segment of segments) segment.lengthM = round1(segment.lengthM);

  // ---- Which way the water probably runs: how far each junction is from where water comes in.
  /** The distance along the pipes from the nearest source of the given kinds to every node (closed valves let nothing through). */
  function distancesFrom(kinds) {
    const distance = new Float64Array(nodes.length).fill(Infinity);
    const heap = []; // [distance, node], smallest first
    const push = (d, n) => {
      heap.push([d, n]);
      for (let i = heap.length - 1; i > 0; ) {
        const up = (i - 1) >> 1;
        if (heap[up][0] <= heap[i][0]) break;
        [heap[up], heap[i]] = [heap[i], heap[up]];
        i = up;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (let i = 0; ; ) {
          const left = 2 * i + 1;
          const right = left + 1;
          let least = i;
          if (left < heap.length && heap[left][0] < heap[least][0]) least = left;
          if (right < heap.length && heap[right][0] < heap[least][0]) least = right;
          if (least === i) break;
          [heap[least], heap[i]] = [heap[i], heap[least]];
          i = least;
        }
      }
      return top;
    };
    for (const entry of entries) if (kinds.includes(entry.kind)) push(entry.offsetM, entry.node);
    while (heap.length) {
      const [d, n] = pop();
      if (d >= distance[n]) continue;
      distance[n] = d;
      const node = nodes[n];
      if (node.valve !== undefined && placed[node.valve].position === 'closed') continue;
      for (const p of node.pieces) {
        const other = pieces[p].a === n ? pieces[p].b : pieces[p].a;
        const further = d + (pieces[p].to - pieces[p].from);
        if (further < distance[other]) push(further, other);
      }
    }
    return distance;
  }
  const fromSupply = distancesFrom(['reservoir', 'treatment', 'bore']);
  const fromPumps = distancesFrom(['pumpstation']);
  const flowOfMain = new Map(); // main -> 0 | 1 | 'none'
  for (const piece of pieces) {
    const length = piece.to - piece.from;
    if (length < 1) continue; // too short to say anything (the stub beside a valve)
    const type = String(mains[piece.main].type ?? '');
    let from = 'none';
    if (!/rising and falling/i.test(type)) {
      const distance = /rising/i.test(type) ? fromPumps : fromSupply;
      const [a, b] = [distance[piece.a], distance[piece.b]];
      if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) >= o.flowShare * length) from = a < b ? 0 : 1;
    }
    const known = flowOfMain.get(piece.main);
    flowOfMain.set(piece.main, known === undefined || known === from ? from : 'none');
  }
  const flowFrom = (m) => (flowOfMain.get(m) === 0 || flowOfMain.get(m) === 1 ? flowOfMain.get(m) : undefined);

  return {
    mains: mains.map(({ id, zone, street, diameter, line }, m) => ({ id, zone, street, diameter, line: line.map((p) => p.map(round6)), flowFrom: flowFrom(m) })),
    pieces: pieces.map((piece, i) => [piece.main, round1(piece.from), round1(piece.to), pieceSegment[i]]),
    segments,
    valves: placed,
    sources: sourceList,
    gaps,
    unplacedValves,
    unplaced: unplacedValves.length,
  };
}

/**
 * The stretch of a main at a place (a tap on the map), or in its middle without one.
 * @param {object} network     from buildShutoffNetwork
 * @param {number} mainIndex
 * @param {number[]} [lonLat]
 */
export function segmentAt(network, mainIndex, lonLat) {
  const main = network.mains[mainIndex];
  const projection = projector(main.line[0]);
  const line = measureLine(main.line.map(projection.toXY));
  const alongM = lonLat ? projectOnLine(line, projection.toXY(lonLat)).alongM : line.length / 2;
  let best;
  let bestGap = Infinity;
  for (const [m, from, to, segment] of network.pieces) {
    if (m !== mainIndex) continue;
    const gap = alongM < from ? from - alongM : alongM > to ? alongM - to : 0;
    if (gap < bestGap) {
      bestGap = gap;
      best = segment;
    }
  }
  return best;
}

/**
 * Which valves to close to leave a stretch without water.
 * @param {object} network            from buildShutoffNetwork
 * @param {number} start              the stretch (from segmentAt)
 * @param {Set<number>} [failed]      valves (index in network.valves) that will not close
 * @param {{ maxSegments?: number, bigAreaM?: number, bigAreaConnections?: number }} [options]
 *   maxSegments: the search gives up beyond this many stretches; an area beyond a valve with no source on
 *   the map but longer than bigAreaM or with more connections than bigAreaConnections is taken as fed
 * @returns {object} segments: the stretches cut; close: valves to close (index in network.valves), in the
 *   order met; assumedFed: those of them closed only because the area beyond is big; notNeeded: valves round the cut with no water beyond them (they can stay open);
 *   alsoSegments: what loses water through the cut without being shut; alreadyClosed: closed valves with
 *   water beyond (keep them closed); failed: valves that will not close, met; stations: sources on the
 *   cut stretch (index in sources); edges: where the cut leaves the mapped area; gaps: mains near the cut
 *   that may be joined to it; unplacedNear: valves on no main near the cut (index in unplacedValves);
 *   lengthM, connections, hydrants (the cut) and alsoLengthM, alsoConnections, alsoHydrants; deadEnds;
 *   limited; noSourceKnown: the map has no sources at all; noSourceFound: none for this stretch
 */
export function isolate(network, start, failed = new Set(), { maxSegments = 400, bigAreaM = 500, bigAreaConnections = 40 } = {}) {
  const segmentAtIndex = (s) => network.segments[s];
  const sources = network.sources ?? [];
  const gaps = network.gaps ?? [];
  const unplacedValves = network.unplacedValves ?? [];

  // The stretch cut: the start, and on through valves that will not close.
  const visited = new Set([start]);
  const queue = [start];
  const roundOpen = [];
  const roundClosed = [];
  const failedMet = [];
  const met = new Set();
  let limited = false;
  while (queue.length) {
    const s = queue.shift();
    for (const v of segmentAtIndex(s).valves) {
      if (met.has(v)) continue;
      met.add(v);
      const valve = network.valves[v];
      if (!failed.has(v)) {
        (valve.position === 'closed' ? roundClosed : roundOpen).push(v);
        continue;
      }
      failedMet.push(v);
      for (const next of valve.segments) {
        if (visited.has(next)) continue;
        if (visited.size >= maxSegments) {
          limited = true;
          continue;
        }
        visited.add(next);
        queue.push(next);
      }
    }
  }

  const sum = (list, key) => list.reduce((total, s) => total + segmentAtIndex(s)[key], 0);

  // Beyond each valve round the cut: is there water? (through open valves and mains that almost meet)
  const fedHere = (s) => Boolean(segmentAtIndex(s).sources?.length || segmentAtIndex(s).edges?.length);
  const sourceKnown = sources.length > 0 || network.segments.some((segment) => segment.edges?.length);
  function reach(from) {
    const seen = new Set(from);
    const waiting = [...from];
    while (waiting.length) {
      if (seen.size > 20000) return { found: true, segments: seen }; // too far to tell: the safe side
      const s = waiting.shift();
      if (fedHere(s)) return { found: true, segments: seen };
      const onward = [];
      for (const v of segmentAtIndex(s).valves) {
        if (network.valves[v].position !== 'closed' || failed.has(v)) onward.push(...network.valves[v].segments);
      }
      for (const g of segmentAtIndex(s).gaps ?? []) onward.push(...gaps[g].segments);
      for (const t of onward) {
        if (visited.has(t) || seen.has(t)) continue;
        seen.add(t);
        waiting.push(t);
      }
    }
    return { found: false, segments: seen };
  }

  const close = [];
  const assumedFed = [];
  const notNeeded = [];
  const also = new Set();
  const isBig = (list) => sum(list, 'lengthM') > bigAreaM || sum(list, 'connections') > bigAreaConnections;
  for (const v of roundOpen) {
    const beyond = network.valves[v].segments.filter((s) => !visited.has(s));
    if (!beyond.length && network.valves[v].segments.length > 1) continue; // the cut on every side: a loop
    if (!beyond.length || !sourceKnown) {
      close.push(v); // nothing mapped beyond it: water could come from there
      continue;
    }
    const found = reach(beyond);
    if (found.found) close.push(v);
    else if (isBig([...found.segments])) {
      close.push(v);
      assumedFed.push(v);
    } else {
      notNeeded.push(v);
      for (const s of found.segments) also.add(s);
    }
  }
  const alreadyClosed = roundClosed.filter((v) => {
    const beyond = network.valves[v].segments.filter((s) => !visited.has(s));
    return beyond.length > 0 && (!sourceKnown || reach(beyond).found);
  });

  const segments = [...visited];
  const unique = (list) => [...new Set(list)];
  const stations = unique(segments.flatMap((s) => segmentAtIndex(s).sources ?? []));
  const edges = segments.flatMap((s) => segmentAtIndex(s).edges ?? []);
  let noSourceFound = false;
  if (sourceKnown && !close.length && !stations.length && !edges.length && notNeeded.length) {
    // The map shows no way for water to reach this stretch (a gap in the map): every valve round it.
    close.push(...notNeeded.splice(0));
    also.clear();
    noSourceFound = true;
  }
  const alsoSegments = [...also];
  return {
    segments,
    close,
    assumedFed,
    notNeeded,
    alsoSegments,
    alreadyClosed,
    failed: failedMet,
    stations,
    sources,
    edges,
    gaps: unique(segments.flatMap((s) => segmentAtIndex(s).gaps ?? [])).filter((g) => gaps[g].segments.some((t) => !visited.has(t))),
    unplacedNear: unique(segments.flatMap((s) => segmentAtIndex(s).unplaced ?? [])),
    unplacedValves,
    lengthM: round1(sum(segments, 'lengthM')),
    connections: sum(segments, 'connections'),
    hydrants: sum(segments, 'hydrants'),
    alsoLengthM: round1(sum(alsoSegments, 'lengthM')),
    alsoConnections: sum(alsoSegments, 'connections'),
    alsoHydrants: sum(alsoSegments, 'hydrants'),
    deadEnds: segments.flatMap((s) => segmentAtIndex(s).deadEnds ?? []),
    // Ends of the branches left open that the map does not confirm as ends (no end cap, no hydrant there).
    openEnds: alsoSegments.reduce((total, s) => total + (segmentAtIndex(s).unconfirmedEnds ?? 0), 0),
    limited,
    noSourceKnown: !sourceKnown,
    noSourceFound,
  };
}

/**
 * The lines of the stretches cut, to draw them: each piece of main from where it starts to where it
 * ends (a main can carry on beyond a valve, outside the cut).
 * @returns {{ main: number, segment: number, line: number[][] }[]}  [lon, lat] lines
 */
export function stretchLines(network, segments) {
  const wanted = new Set(segments);
  const measured = new Map();
  const lines = [];
  for (const [m, from, to, segment] of network.pieces) {
    if (!wanted.has(segment) || to - from < 0.05) continue;
    if (!measured.has(m)) {
      const projection = projector(network.mains[m].line[0]);
      measured.set(m, { projection, line: measureLine(network.mains[m].line.map(projection.toXY)) });
    }
    const { projection, line } = measured.get(m);
    const pointAt = (alongM) => {
      const i = Math.max(1, line.along.findIndex((a) => a >= alongM));
      const span = line.along[i] - line.along[i - 1] || 1;
      const t = Math.min(1, Math.max(0, (alongM - line.along[i - 1]) / span));
      const [ax, ay] = line.points[i - 1];
      const [bx, by] = line.points[i];
      return projection.toLonLat([ax + t * (bx - ax), ay + t * (by - ay)]);
    };
    const inside = line.points.filter((_, i) => line.along[i] > from && line.along[i] < to).map(projection.toLonLat);
    lines.push({ main: m, segment, line: [pointAt(from), ...inside, pointAt(to)] });
  }
  return lines;
}

/** The point at a distance along a measured line. */
function pointAt({ points, along }, alongM) {
  const found = along.findIndex((a) => a >= alongM);
  const i = found < 0 ? points.length - 1 : Math.max(1, found);
  const span = along[i] - along[i - 1] || 1;
  const t = Math.min(1, Math.max(0, (alongM - along[i - 1]) / span));
  return [points[i - 1][0] + t * (points[i][0] - points[i - 1][0]), points[i - 1][1] + t * (points[i][1] - points[i - 1][1])];
}

/** Whether a point is inside a ring (even-odd rule). */
function insideRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The distance from a point to the edges of a ring. */
function distanceToRing(p, ring) {
  return projectOnLine(measureLine(ring), p).distance;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}
