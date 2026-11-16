/**
 * "Stop the flow": the sewers of the whole district put together into one network – which pipe drains
 * into which, where each pump station pumps to – so that the page can tell where to plug a sewer or
 * which pumps to stop (src/util/sewerStop.js). The design, with what was measured on the real data
 * behind every rule and tolerance, is docs/designs/2026-11-15-shut-the-sewer.md.
 *
 * The council's data has no record of how pipes join, and its record of which way each one runs is
 * wrong or missing often enough that one bad trunk hides a town. So:
 *   - GEOMETRY SAYS WHAT JOINS. Ends that meet (`joinM`) are one junction, but never the two ends of
 *     one short main; an end on the middle of another main cuts it there, unless it only runs along
 *     it (a second record of the same pipe), is a sewer drawn onto a pumped main (the stubs to air
 *     and scour valves), or is the far end of a short pipe whose near end is already on that main;
 *     mains that only cross do not join. A manhole cuts the sewer it sits on, never a pumped main
 *     drawn through it. A pipe recorded twice counts once.
 *   - THE RECORD SAYS WHICH WAY (`flowFrom` of each main: 0 from its first point, 1 from its last,
 *     nothing when the council's record does not say).
 *   - A SEWER IS NOT ALWAYS WHAT ITS TYPE SAYS. Pumped ("p"): a rising main; a "gravity" pipe under
 *     100 mm, or polyethylene up to 125 mm (the pressure sewers of whole subdivisions); short "gravity"
 *     pipes that link two pumped mains, or a station to one. Short "gravity" stubs hanging on a pumped
 *     main (to a scour valve, a chamber) belong to it. Vent, outfall and bypass pipes carry no flow
 *     of the day and are not followed – only kept as a link when one is short and joins two junctions.
 *   - PUMP STATIONS AND THE TREATMENT PLANT ARE PLACES, NOT POINTS: every junction inside the outline,
 *     close to it where a pumped main starts or ends or a sewer ends, or a dead end of sewer beside
 *     it. Pipes between two junctions of one station – also by way of a point just outside it – are
 *     its own pipework and are not followed; nor is a sewer recorded as leaving a station by gravity
 *     (an overflow).
 *   - LINKS THE MAP DOES NOT DRAW are kept and counted, so that an answer can say it crossed one: a
 *     dead end a few metres from another main of its kind (a gap in the drawing; two pumped mains only
 *     when of like size or very close), a main the council records as removed or out of use that
 *     leads on from where the flow is stuck, a short vent or bypass pipe.
 *   - ONE WAY DOWN FOR EVERY JUNCTION OF SEWERS, found backwards from every place sewage can leave by
 *     (a station with a pumped main, the plant, a pump that is not on the map, a main that leaves the
 *     mapped area). Ways are compared in this order: fewest mains taken against their recorded
 *     direction, fewest links crossed, the larger pipe where the record lets sewage leave a manhole two
 *     ways, fewest mains with no recorded direction, shortest. What reaches none of them is then led
 *     to where it ends on the map, with the reason; such an end never wins over a real way on. A dead
 *     end that its one pipe is recorded as running into stays an end: the pipe is not turned round.
 *   - PRESSURE SYSTEMS: pumped pipes joined to each other outside the stations (links included). Each
 *     station (and each pump that is not on the map) gets one discharge: the nearest place its sewage
 *     can leave the system going with the record (same order of comparison: at a fork, the larger
 *     pipe), that does not lead back to itself. A way past a valve recorded closed – in line, about
 *     the main's size, not a scour valve – is the last one taken: only when the map shows no other,
 *     and then the valve is kept with the discharge, to be said. The record of a valve's position is
 *     not proof, so it never ends a way.
 *   - VALVES AND PROPERTY CONNECTIONS are put on the pipe they are on (a connection also through
 *     another connection; a boundary kit by its connection). At a joint a valve goes on the pipe of its
 *     size; with no size, where the pipes differ, on none in particular – and then it is no line valve.
 *
 * Pure: plain data in and out, no imports. `buildSewerNetwork` runs once for the district
 * (scripts/data/build-sewer-stop.mjs writes data/wastewater-stop.json, packed by `packSewerNetwork`);
 * the page reads it back with `unpackSewerNetwork`, and measures along a pipe with `measureLine` as
 * the build does. Everything is approximate: a proposal to check on site, never an instruction.
 */

/** The distances the network is put together with – metres unless said. One table: the design's "Tolerances". */
export const SEWER_DEFAULTS = {
  joinM: 0.5, // ends meet; an end meets the middle of a main; a manhole or a valve is on a main
  alongM: 0.2, // a main "runs along" another (a second record of it) when its point `alongInM` in is this close
  alongInM: 1,
  insideM: 0.5, // a junction this close to the outline of a station or plant is inside it
  stationNearM: 5, // …this close, where a pumped main starts or ends, or a sewer ends, it is the station's
  stationBesideM: 15, // …this close, a dead end of sewer with no other station nearer is its inlet ("beside the station")
  sameStationM: 10, // two station records of one name this close are one station
  tankM: 50, // a storage tank with a station's name, this close to it, is part of it
  gapM: 3, // a dead end this close to another main of its kind is taken as joined (3.5 m must stay open)
  gapEndM: 1, // …to a junction of that main when one is this close to the nearest point
  gapLikeSize: 0.5, // …and two pumped mains only when the smaller is this share of the larger,
  gapCloseM: 1.2, // or the gap is no more than this
  goneM: 0.5, // a removed or disused main is a link when each of its ends is this close to a junction
  shortLinkM: 10, // a vent or bypass pipe no longer than this, between two junctions, is a link
  pumpStartM: 5, // a dead end of sewer this close to the start of a pumped main with no station: a pump not on the map
  outsideM: 1, // a main the map leaves out touches an end
  connectionM: 1.5, // a property connection joins a main (or another connection)
  smallMm: 100, // a "gravity" pipe under this size is a pressure pipe…
  smallPeMm: 125, // …and so is a polyethylene one up to this size
  stubM: 20, // a gravity-typed link, or group of stubs, this long in all, on a pumped main, is part of it; and sewers no longer than this, with no property on them, bring nothing to a pump
  valveSizeRatio: 0.7, // a valve recorded closed counts as in line from this share of the main's size (a way past it is the last one taken)
  valveInsetM: 0.3, // a valve recorded at a joint is put this far in from the end of its main
  stationValveM: 15, // valves this close to a station outline are listed with the station
  nearEndM: 15, // "it ends x m from another main" is said up to this distance
};

/** How a piece is marked when it is not an ordinary pipe (the 9th value of a piece). */
export const PIECE_MARK = {
  pipework: 1, // between two junctions of one station (also round by a point just outside it), or inside the plant: not followed
  leavesStation: 2, // a sewer recorded as leaving a station by gravity (an overflow, a bypass): not followed
  stub: 3, // a short "gravity" pipe hanging on a pumped main: answered as that main
};

const PUMPED_TYPE = /^Rising main/;
/** Types that carry air or overflow, not the day's flow ('Main' is what is left of the council's catch-all). */
const NOT_FOLLOWED_TYPES = new Set(['Vent pipe', 'Outfall or bypass pipe', 'Main']);
/** Valves that are closed by hand; what each is for is in its `role` (scripts/data/lib/sewer-valves.mjs). */
const PLAIN_VALVES = new Set(['Valve', 'Stop valve', 'Knife valve']);
const GRID_M = 20;

const round1 = (value) => Math.round(value * 10) / 10;
const round6 = (value) => Math.round(value * 1e6) / 1e6;

// ---- Metres on the map ---------------------------------------------------------------------------

/** Metres in one degree of longitude and of latitude, at a latitude (WGS84). */
export function metresPerDegree(latitude) {
  const phi = (latitude * Math.PI) / 180;
  return [111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi), 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi)];
}

/** The distance in metres between two [lon, lat] points close to each other. */
export function metresBetween(a, b) {
  const [kx, ky] = metresPerDegree((a[1] + b[1]) / 2);
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * ky);
}

/** Metres east and north of an origin: good for what is near what; lengths are measured by `measureLine`. */
export function projector([lon0, lat0]) {
  const [kx, ky] = metresPerDegree(lat0);
  return {
    toXY: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLonLat: ([x, y]) => [lon0 + x / kx, lat0 + y / ky],
  };
}

/**
 * A [lon, lat] line with its points in metres and the distance along it at every point. The distances
 * are measured on the ground, point to point, so they do not depend on where the origin of the metres is:
 * the page measures the same pipe to the same length (the pieces of a main are kept by these distances).
 */
export function measureLine(line, projection) {
  const along = [0];
  for (let i = 1; i < line.length; i += 1) along.push(along[i - 1] + metresBetween(line[i - 1], line[i]));
  return { points: line.map(projection.toXY), along, length: along.at(-1) };
}

/** The nearest point of a measured line to `p` (in metres): { alongM, distance }. */
export function projectOnLine({ points, along }, p) {
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

/** The point (in metres) at a distance along a measured line. */
export function pointAt({ points, along }, alongM) {
  const found = along.findIndex((a) => a >= alongM);
  const i = found < 0 ? points.length - 1 : Math.max(1, found);
  const span = along[i] - along[i - 1] || 1;
  const t = Math.min(1, Math.max(0, (alongM - along[i - 1]) / span));
  return [points[i - 1][0] + t * (points[i][0] - points[i - 1][0]), points[i - 1][1] + t * (points[i][1] - points[i - 1][1])];
}

/** Finds the lines near a point: `near(p, r)` gives [{ line, alongM, distance }], nearest first. */
function lineGrid(lines) {
  const cells = new Map();
  lines.forEach(({ points }, index) => {
    for (let i = 1; i < points.length; i += 1) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      for (let gx = Math.floor(Math.min(ax, bx) / GRID_M); gx <= Math.floor(Math.max(ax, bx) / GRID_M); gx += 1) {
        for (let gy = Math.floor(Math.min(ay, by) / GRID_M); gy <= Math.floor(Math.max(ay, by) / GRID_M); gy += 1) {
          const key = `${gx},${gy}`;
          if (!cells.has(key)) cells.set(key, new Set());
          cells.get(key).add(index);
        }
      }
    }
  });
  return {
    near(p, r) {
      const seen = new Set();
      const found = [];
      for (let gx = Math.floor((p[0] - r) / GRID_M); gx <= Math.floor((p[0] + r) / GRID_M); gx += 1) {
        for (let gy = Math.floor((p[1] - r) / GRID_M); gy <= Math.floor((p[1] + r) / GRID_M); gy += 1) {
          for (const index of cells.get(`${gx},${gy}`) ?? []) {
            if (seen.has(index)) continue;
            seen.add(index);
            const near = projectOnLine(lines[index], p);
            if (near.distance <= r) found.push({ line: index, ...near });
          }
        }
      }
      return found.sort((a, b) => a.distance - b.distance || a.line - b.line);
    },
  };
}

/** Finds the points near a point: `near(p, r)` gives [{ item, distance }], nearest first. */
function pointGrid(cell = 5) {
  const cells = new Map();
  return {
    add(xy, item) {
      const key = `${Math.floor(xy[0] / cell)},${Math.floor(xy[1] / cell)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push({ xy, item });
    },
    near(p, r) {
      const found = [];
      for (let gx = Math.floor((p[0] - r) / cell); gx <= Math.floor((p[0] + r) / cell); gx += 1) {
        for (let gy = Math.floor((p[1] - r) / cell); gy <= Math.floor((p[1] + r) / cell); gy += 1) {
          for (const entry of cells.get(`${gx},${gy}`) ?? []) {
            const distance = Math.hypot(entry.xy[0] - p[0], entry.xy[1] - p[1]);
            if (distance <= r) found.push({ item: entry.item, distance });
          }
        }
      }
      return found.sort((a, b) => a.distance - b.distance);
    },
  };
}

function insideRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A place on the map – a station, a plant – as its outlines in metres (or its point, when it has none). */
function placeOf(outline, at, toXY) {
  const outlines = (outline ?? []).map((polygon) => polygon.map((ring) => ring.map(toXY)));
  return { outlines, xy: toXY(at) };
}

/** How far a point is from a place: 0 inside its outline. */
function awayFrom(p, { outlines, xy }) {
  if (!outlines.length) return Math.hypot(p[0] - xy[0], p[1] - xy[1]);
  let best = Infinity;
  for (const polygon of outlines) {
    if (insideRing(p, polygon[0]) && !polygon.slice(1).some((hole) => insideRing(p, hole))) return 0;
    for (const ring of polygon) {
      const along = ring.map(() => 0); // only the distance is wanted
      best = Math.min(best, projectOnLine({ points: ring, along }, p).distance);
    }
  }
  return best;
}

/** The box round a place, widened by a margin: a quick "is it anywhere near". */
function boxOf({ outlines, xy }, marginM) {
  const all = [...outlines.flat(2), xy];
  return [Math.min(...all.map((p) => p[0])) - marginM, Math.min(...all.map((p) => p[1])) - marginM, Math.max(...all.map((p) => p[0])) + marginM, Math.max(...all.map((p) => p[1])) + marginM];
}
const inBox = (p, [x0, y0, x1, y1]) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;

/** The closest two places come to each other (from the corners of one to the outline of the other). */
function apart(one, other) {
  const corners = (place) => (place.outlines.length ? place.outlines.flat(2) : [place.xy]);
  return Math.min(...corners(one).map((p) => awayFrom(p, other)), ...corners(other).map((p) => awayFrom(p, one)));
}

// ---- Comparing ways -----------------------------------------------------------------------------

// What a way costs: [mains against their record, links crossed, times the smaller pipe is taken where
// the record lets sewage leave two ways, mains with no direction, metres, valves recorded closed that
// are passed]. Compared in that order – but the closed valves before everything else: a way past one is
// taken only when the map shows no other. (That a valve is closed is the record, not proof: it may
// not end a way. And a way that needs one open is the last to believe.)
const NOTHING = [0, 0, 0, 0, 0, 0];
const COMPARED = [5, 0, 1, 2, 3, 4];
const cheaper = (a, b) => {
  for (const i of COMPARED) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};
const plus = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3], a[4] + b[4], a[5] + b[5]];

/** A queue of [cost, junction] that gives the cheapest first. */
function cheapestFirst() {
  const heap = [];
  return {
    get size() {
      return heap.length;
    },
    push(entry) {
      heap.push(entry);
      for (let i = heap.length - 1; i > 0; ) {
        const up = (i - 1) >> 1;
        if (!cheaper(heap[i][0], heap[up][0])) break;
        [heap[up], heap[i]] = [heap[i], heap[up]];
        i = up;
      }
    },
    pop() {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (let i = 0; ; ) {
          const left = 2 * i + 1;
          const right = left + 1;
          let least = i;
          if (left < heap.length && cheaper(heap[left][0], heap[least][0])) least = left;
          if (right < heap.length && cheaper(heap[right][0], heap[least][0])) least = right;
          if (least === i) break;
          [heap[least], heap[i]] = [heap[i], heap[least]];
          i = least;
        }
      }
      return top;
    },
  };
}

/** Sets of things that belong together: `join(a, b)`, `of(a)` gives the name of a's set. */
function groups(count) {
  const parent = Array.from({ length: count }, (_, i) => i);
  const of = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  return { of, join: (a, b) => (parent[of(a)] = of(b)) };
}

/**
 * What kind of pipe a main is by its record: 'p' pumped, 'g' gravity, 'v' not followed (air, overflow).
 * `small`: typed as a gravity sewer, but too small or of the wrong material to be one.
 */
function recordedKind({ type, diameter, material }, o) {
  if (PUMPED_TYPE.test(String(type))) return { kind: 'p' };
  if (NOT_FOLLOWED_TYPES.has(type)) return { kind: 'v' };
  const polyethylene = /polyeth|polythene/i.test(String(material ?? ''));
  if (diameter < o.smallMm || (polyethylene && diameter <= o.smallPeMm)) return { kind: 'p', small: true };
  return { kind: 'g' };
}

/**
 * Puts the sewers of the district together.
 *
 * @param {object} input  everything as [lon, lat]
 * @param {{ id, zone?, street?, diameter?, type, material?, owner?, inUse?, flowFrom?: 0 | 1, line: number[][] }[]} input.mains
 *   every main the map draws, in use or not (`inUse: false`: only a possible link); a main in several
 *   parts is given part by part; flowFrom: the end the council's record calls upstream
 * @param {{ id, status: 'removed' | 'notInUse' | 'inUse', type?, diameter?, line: number[][] }[]} [input.unseen]
 *   mains of the council's record that the map does not draw: removed ones (possible links) and ones in
 *   use that lie outside the mapped area (the network carries on there)
 * @param {{ id, type, inUse?, diameter?, depth?, depthFrom?, street?, at: number[] }[]} [input.manholes]
 * @param {{ id, type, role?, position?, diameter?, street?, depth?, depthFrom?, note?, at: number[] }[]} [input.valves]  in use
 *   (depthFrom: 'rec' when the council records the depth; else it is that of the pipe, or a typical one: an estimate)
 * @param {{ line: number[][], joins?: 0 | 1, pumped?: boolean }[]} [input.connections]  property connections in use
 *   (joins: the end on the main)
 * @param {{ id, name, owner?, at: number[], outline?: number[][][][] }[]} [input.stations]  pump stations in use
 * @param {{ name, at: number[], outline?: number[][][][] }[]} [input.tanks]  storage tanks (part of the station of their name)
 * @param {{ id, name, at: number[], outline?: number[][][][] }[]} [input.plants]  treatment plants in use
 * @param {{ name, note?, at: number[], outline?: number[][][][] }[]} [input.otherPlaces]  stations and plants out of
 *   use: they end nothing, but are named when a sewer ends inside one
 * @param {number[][]} [input.coverage]  the mapped area, as [west, south, east, north] boxes
 * @param {object} [options]  any of SEWER_DEFAULTS
 *
 * @returns {object} every index is a position in the list named:
 *   mains: [{ id, zone, street, type, kind: 'g' | 'p', diameter?, line, owner? (when not the council's),
 *     small? (its material: a "gravity" pipe taken as pumped by its size), link? (a short "gravity" link
 *     taken as pumped), twin? (this record is a second one of that main: it has no pieces of its own) }]
 *   pieces: [[main, fromM, toM, a, b, dir, system, run, mark]] – the stretches of each main between
 *     junctions a and b (fromM, toM: metres along the main as `measureLine` measures it); dir: the record
 *     (1 a→b, -1 b→a, 0 not recorded); system: its pressure system, -1 for a sewer; run: the way the tool
 *     takes it to run (against its record when run = -dir; 0: cannot be told); mark: PIECE_MARK or 0
 *   junctions: [{ down?, station?, plant?, outlet?, manholes?, beside? }] – down: the piece the sewage
 *     leaves by, or a link as -(index + 1); station, plant: the junction is that place's; outlet: where a
 *     way down ends otherwise; beside: metres from the outline, when a dead end was taken as the station's inlet
 *   links: [{ a, b, kind: 'gap' | 'removed' | 'notInUse' | 'short', pumped?, lengthM, id?, at }]
 *   manholes: [{ id, type, usable, at, street?, depth?, depthFrom?, diameter?, notInUse? }] – usable: can take a plug
 *   valves: [{ id, type, at, piece, alongM, street?, depth?, depthFrom?, role?, position?, diameter?, note?,
 *     line? (a line valve of a pumped main), drain? (a place to drain it), closedInLine? (recorded closed, in line
 *     and of the main's size: a pump's way to its discharge passes it only when the map shows no other), joint? (at a junction of three
 *     or more pipes), onConnection? (a boundary kit, placed by its property connection), pipeNotKnown? (a hand
 *     valve with no size at a joint of three or more pipes of different sizes: put on the nearest, taken as
 *     the line valve of none) }] – piece -1: on no pipe
 *   stations: [{ id, name, at, junctions, pumpsInto, receives, valves, owner?, discharge?, inferred?, noMain?, also? }]
 *     – pumpsInto, receives: systems; noMain: no pumped main in use leaves it; inferred: taken as the pump
 *     of a main whose record does not say so – 'noDirection' (the record gives that main no direction, and
 *     the station has no other pumped main) or 'againstRecord' (its one pumped main is recorded as running
 *     into it, and nothing else on the map feeds that main); also: ids of its other records
 *   plants: [{ id, name, at }]
 *   systems: [{ kind: 'stations' | 'lowPressure' | 'pump' | 'unknown', lengthM, sources, discharges, lineValves, connections, inflow? }]
 *     – kind: fed by stations; else by the pumps of the properties on it (it may have a pump with no
 *     record among its sources too); else only by a pump with no record; sources: [{ station } | { outlet }]; discharges: [{ junction, kind: 'gravity' | 'station' | 'plant'
 *     | 'leaves' | 'nowhere', station?, plant?, beyond? }]; inflow: junctions where a main comes in from outside the map
 *   outlets: [{ kind: 'pump' | 'joins' | 'leaves' | 'end', junction, … }] – pump: a pump that is not on the
 *     map ({ system, discharge?, from?, gapM? }: its pumped main starts gapM away at junction `from`);
 *     joins: the sewers end on a pumped main; leaves: the mapped area ({ id?, diameter?, lengthM? } of the
 *     council's main that carries on); end: no way on ({ reason: 'nothing' | 'near' | 'inside' | 'private'
 *     | 'pumpNowhere', nearM?, name?, note? })
 *   a discharge (of a station or outlet): { system, junction, kind, station?, plant?, beyond? (where it
 *     leaves the mapped area: { id, diameter, lengthM } of the council's main that carries on), lengthM,
 *     against, links, noDirection, closed? (valves recorded closed on the way: the map shows no way
 *     without them), via: the pieces (links as -(index + 1)) from the pump to it }
 *   connections: [[piece, alongM, pumped, through?]] – each property connection as a point on its pipe
 *     (pumped: 1 when recorded as pumped; through: 1 when it joins by way of another connection)
 *   splits: [{ junction, followed, other, otherEndsAt }] – the record lets sewage leave two ways, to two places
 *   stats: the figures of the build
 */
export function buildSewerNetwork(input, options = {}) {
  const o = { ...SEWER_DEFAULTS, ...options };
  const given = (input.mains ?? []).filter((main) => main.line?.length > 1);
  const middle = given.length ? [0, 1].map((k) => (Math.min(...given.map((m) => m.line[0][k])) + Math.max(...given.map((m) => m.line[0][k]))) / 2) : [0, 0];
  const projection = projector(middle);
  const { toXY } = projection;
  const lonLatOf = (xy) => projection.toLonLat(xy).map(round6);
  const stats = {};
  /** An object without what is not there (undefined) or not so (false). */
  const tidy = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== false));

  // ---- 1. What each main is: followed (a sewer or a pumped main in use), or only a possible link.
  const mains = []; // followed: the `mains` of the result, in this order
  const airPipes = []; // in use, but vent or overflow
  const gone = []; // out of use or removed
  const beyond = []; // in use, outside the mapped area
  const entryOf = (main) => ({ ...main, ...recordedKind(main, o), measured: measureLine(main.line, projection), dir: main.flowFrom === 0 ? 1 : main.flowFrom === 1 ? -1 : 0 });
  for (const main of given) {
    const entry = entryOf(main);
    if (main.inUse === false) gone.push({ ...entry, status: 'notInUse' });
    else if (entry.kind === 'v') airPipes.push(entry);
    else mains.push(entry);
  }
  for (const main of input.unseen ?? []) {
    if (!(main.line?.length > 1)) continue;
    if (main.status === 'inUse') beyond.push(entryOf(main));
    else gone.push(entryOf(main));
  }

  // The same pipe recorded twice (same two ends, same line): the better record is kept, the other points to it.
  const twinOf = mains.map(() => undefined);
  {
    const ends = pointGrid();
    mains.forEach((main, m) => ends.add(main.measured.points[0], m));
    mains.forEach((main, m) => ends.add(main.measured.points.at(-1), m));
    const meet = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= o.joinM;
    const onLine = (one, other) => one.points.every((p) => projectOnLine(other, p).distance <= o.joinM);
    const same = groups(mains.length);
    mains.forEach(({ measured, kind }, m) => {
      if (measured.length < 2 * o.joinM) return; // too short to tell two pipes from one
      const [first, last] = [measured.points[0], measured.points.at(-1)];
      for (const { item: other } of ends.near(first, o.joinM)) {
        if (other <= m || mains[other].kind !== kind) continue;
        const theirs = mains[other].measured;
        const sameEnds = (meet(first, theirs.points[0]) && meet(last, theirs.points.at(-1))) || (meet(first, theirs.points.at(-1)) && meet(last, theirs.points[0]));
        if (sameEnds && onLine(measured, theirs) && onLine(theirs, measured)) same.join(other, m);
      }
    });
    // The one kept: with a recorded direction, then the larger, then the first in the data.
    const better = (a, b) => (mains[a].dir !== 0) - (mains[b].dir !== 0) || (mains[a].diameter ?? 0) - (mains[b].diameter ?? 0) || b - a;
    const kept = new Map();
    mains.forEach((_, m) => {
      const group = same.of(m);
      if (!kept.has(group) || better(m, kept.get(group)) > 0) kept.set(group, m);
    });
    mains.forEach((_, m) => {
      if (kept.get(same.of(m)) !== m) twinOf[m] = kept.get(same.of(m));
    });
  }

  // The lines the network is made of: every followed main but the second records.
  // joins: 'p' for what does not open into manholes (pumped mains and their stubs), 'g' for sewers.
  const lines = [];
  mains.forEach((main, m) => {
    if (twinOf[m] === undefined) lines.push({ main: m, measured: main.measured, kind: main.kind, joins: main.kind, dir: main.dir, diameter: main.diameter ?? 0, stub: false });
  });
  const holes = (input.manholes ?? []).map((manhole) => ({ ...manhole, xy: toXY(manhole.at) }));

  // ---- 2. Junctions: where the lines meet, and where each is cut.
  function join() {
    const count = lines.length;
    const grid = lineGrid(lines.map((line) => line.measured));
    const endXY = (e) => (e % 2 ? lines[e >> 1].measured.points.at(-1) : lines[e >> 1].measured.points[0]);
    const counts = { endOnMiddle: 0, alongNotCut: 0, sewerOnPumpedNotJoined: 0, manholesCutting: 0, pumpedThroughManhole: 0, manholesOnNoMain: 0 };

    // Ends that meet: the nearest pairs first, and never the two ends of one main (30 mains are
    // shorter than the tolerance; one hides a valve between two branches).
    const sets = groups(2 * count);
    const members = Array.from({ length: 2 * count }, (_, e) => [e]);
    const endGrid = pointGrid();
    const pairs = [];
    for (let e = 0; e < 2 * count; e += 1) {
      for (const near of endGrid.near(endXY(e), o.joinM)) pairs.push([near.distance, near.item, e]);
      endGrid.add(endXY(e), e);
    }
    pairs.sort((p, q) => p[0] - q[0]);
    for (const [, e1, e2] of pairs) {
      let [small, big] = [sets.of(e1), sets.of(e2)];
      if (small === big) continue;
      if (members[small].length > members[big].length) [small, big] = [big, small];
      if (members[small].some((e) => sets.of(e ^ 1) === big)) continue; // e ^ 1: the other end of the same main
      sets.join(small, big);
      members[big].push(...members[small]);
    }
    const nodes = [];
    const nodePoints = pointGrid();
    const addNode = (xy) => {
      nodes.push({ xy, pieces: [], manholes: [], links: [] });
      nodePoints.add(xy, nodes.length - 1);
      return nodes.length - 1;
    };
    const nodeOfSet = new Map();
    const endNode = [];
    for (let e = 0; e < 2 * count; e += 1) {
      const set = sets.of(e);
      if (!nodeOfSet.has(set)) nodeOfSet.set(set, addNode(endXY(e)));
      else nodePoints.add(endXY(e), nodeOfSet.get(set));
      endNode.push(nodeOfSet.get(set));
    }
    const cuts = lines.map((line, l) => [
      { alongM: 0, node: endNode[2 * l] },
      { alongM: line.measured.length, node: endNode[2 * l + 1] },
    ]);
    const inMiddle = (near) => near.alongM > o.joinM && near.alongM < lines[near.line].measured.length - o.joinM;

    // A branch: the end of one main on the middle of another.
    const branches = new Map(); // 'line,junction' -> { line, node, alongM, distance }
    for (let e = 0; e < 2 * count; e += 1) {
      const own = lines[e >> 1];
      for (const near of grid.near(endXY(e), o.joinM)) {
        if (near.line === e >> 1 || !inMiddle(near) || cuts[near.line].some((cut) => cut.node === endNode[e])) continue;
        const other = lines[near.line];
        // A sewer drawn onto a pumped main does not open into it (the stubs to air and scour valves).
        if (own.joins === 'g' && other.joins === 'p') {
          counts.sewerOnPumpedNotJoined += 1;
          continue;
        }
        // A second record of the same pipe runs along it: one metre in, it is still on it.
        const inM = Math.min(o.alongInM, own.measured.length);
        const inside = pointAt(own.measured, e % 2 ? own.measured.length - inM : inM);
        if (projectOnLine(other.measured, inside).distance <= o.alongM) {
          counts.alongNotCut += 1;
          continue;
        }
        const key = `${near.line},${endNode[e]}`;
        if (!branches.has(key) || near.distance < branches.get(key).distance) branches.set(key, { line: near.line, node: endNode[e], alongM: near.alongM, distance: near.distance });
      }
    }
    // …but never the two ends of one short main onto the same main, side by side: the pipe between
    // them would be skipped (a 0.4 m pipe with a closed valve ties a passing main into Park St station).
    // The end nearer the main joins it; the other is joined only through its own pipe.
    const endsAt = nodes.map(() => []);
    endNode.forEach((n, e) => endsAt[n].push(e));
    const placeOn = (l, n) => (endNode[2 * l] === n ? { alongM: 0, distance: -1 } : endNode[2 * l + 1] === n ? { alongM: lines[l].measured.length, distance: -1 } : branches.get(`${l},${n}`));
    for (const branch of branches.values()) {
      const squeezed = endsAt[branch.node].some((e) => {
        const far = endNode[e ^ 1];
        const there = e >> 1 === branch.line || far === branch.node ? undefined : placeOn(branch.line, far);
        return there && Math.abs(there.alongM - branch.alongM) <= 2 * o.joinM && (there.distance < branch.distance || (there.distance === branch.distance && far < branch.node));
      });
      if (squeezed) continue;
      cuts[branch.line].push({ alongM: branch.alongM, node: branch.node });
      counts.endOnMiddle += 1;
    }

    // Manholes: on a junction, or cutting the sewer they sit on – never a pumped main drawn through one.
    // A manhole out of use cuts nothing: it is only named where a sewer ends on it.
    const nodeNear = (xy, r) => nodePoints.near(xy, r)[0]?.item;
    holes.forEach((hole, h) => {
      let node = nodeNear(hole.xy, o.joinM);
      let cutting = false;
      if (hole.inUse !== false) {
        for (const near of grid.near(hole.xy, o.joinM)) {
          if (!inMiddle(near)) continue;
          if (lines[near.line].joins === 'p') {
            counts.pumpedThroughManhole += 1;
            continue;
          }
          if (node !== undefined && cuts[near.line].some((cut) => cut.node === node)) continue;
          node ??= addNode(hole.xy);
          cuts[near.line].push({ alongM: near.alongM, node });
          cutting = true;
        }
      }
      if (node === undefined) counts.manholesOnNoMain += 1;
      else nodes[node].manholes.push(h);
      if (cutting) counts.manholesCutting += 1;
    });
    return { grid, nodes, cuts, addNode, nodeNear, endNode, endXY, counts };
  }

  /** The pieces of every line between its cuts; each junction learns which pieces end on it. */
  function cutUp(web) {
    const pieces = [];
    const piecesOfLine = lines.map(() => []);
    for (const node of web.nodes) node.pieces = [];
    web.cuts.forEach((list, l) => {
      list.sort((p, q) => p.alongM - q.alongM);
      for (let i = 1; i < list.length; i += 1) {
        const [from, to] = [list[i - 1], list[i]];
        if (from.node === to.node && to.alongM - from.alongM < 2 * o.joinM) continue; // nothing between two cuts at one junction
        pieces.push({ line: l, from: from.alongM, to: to.alongM, a: from.node, b: to.node, dir: lines[l].dir, mark: 0, system: -1, run: 0 });
        piecesOfLine[l].push(pieces.length - 1);
        web.nodes[from.node].pieces.push(pieces.length - 1);
        if (to.node !== from.node) web.nodes[to.node].pieces.push(pieces.length - 1);
      }
    });
    return { pieces, piecesOfLine };
  }

  /** How many pipes of a sort arrive at a junction, leave it, or touch it with no recorded direction. */
  function flowsAt(nodes, pieces, n, wanted) {
    const flows = { arrive: 0, leave: 0, unknown: 0, all: 0 };
    for (const i of nodes[n].pieces) {
      const piece = pieces[i];
      if (piece.a === piece.b || !wanted(piece)) continue;
      flows.all += 1;
      if (piece.dir === 0) flows.unknown += 1;
      else if ((piece.dir === 1) === (piece.a === n)) flows.leave += 1;
      else flows.arrive += 1;
    }
    return flows;
  }
  /** Sewage arrives and nothing carries on: every pipe arrives, or the one pipe has no direction. */
  const endsHere = (flows) => flows.leave === 0 && ((flows.arrive >= 1 && flows.unknown === 0) || (flows.arrive === 0 && flows.unknown === 1));
  /** A pumped main starts or ends here: it does not pass through. */
  const pumpedEndHere = (flows) => flows.all === 1 || (flows.all > 1 && flows.unknown === 0 && (flows.arrive === 0 || flows.leave === 0));
  /** A pumped main starts here: none arrives, and it does not just pass with no direction. */
  const startsHere = (flows) => flows.all > 0 && flows.arrive === 0 && (flows.all === 1 || flows.unknown === 0);
  const isSewer = (piece) => lines[piece.line].kind === 'g' && !lines[piece.line].stub && piece.mark === 0;
  const isPumped = (piece) => lines[piece.line].kind === 'p' && piece.mark !== PIECE_MARK.pipework;

  // ---- 3. Pump stations and treatment plants: places with an outline.
  const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
  const stationList = []; // { name, records: [{ …record, place }], outlines, xy, box }
  for (const record of input.stations ?? []) {
    const place = placeOf(record.outline, record.at, toXY);
    // Two records of one name close together are one station (a station recorded twice).
    const same = stationList.find((station) => sameName(station.name, record.name) && apart(station, place) <= o.sameStationM);
    if (same) {
      same.records.push({ ...record, place });
      same.outlines.push(...place.outlines);
    } else stationList.push({ name: record.name, records: [{ ...record, place }], outlines: [...place.outlines], xy: place.xy });
  }
  for (const tank of input.tanks ?? []) {
    const place = placeOf(tank.outline, tank.at, toXY);
    const station = stationList.find((candidate) => sameName(candidate.name, tank.name) && apart(candidate, place) <= o.tankM);
    if (station) station.outlines.push(...place.outlines);
  }
  for (const station of stationList) station.box = boxOf(station, o.stationBesideM);
  // One outline inside another is one plant (the ponds inside the delta site): the larger gives the name.
  const plantList = [];
  const extent = (place) => {
    const [x0, y0, x1, y1] = boxOf(place, 0);
    return (x1 - x0) * (y1 - y0);
  };
  for (const record of [...(input.plants ?? [])].map((plant) => ({ ...plant, ...placeOf(plant.outline, plant.at, toXY) })).sort((a, b) => extent(b) - extent(a))) {
    const around = plantList.find((plant) => awayFrom(record.outlines[0]?.[0]?.[0] ?? record.xy, plant) === 0);
    if (around) around.outlines.push(...record.outlines);
    else plantList.push({ id: record.id, name: record.name, at: record.at, outlines: [...record.outlines], xy: record.xy });
  }
  for (const plant of plantList) plant.box = boxOf(plant, o.insideM);
  const otherPlaces = (input.otherPlaces ?? []).map((place) => ({ name: place.name, note: place.note, ...placeOf(place.outline, place.at, toXY) }));
  for (const place of otherPlaces) place.box = boxOf(place, 0);

  /** Says of every junction whose it is: a station's (inside, near, or a dead end beside it), the plant's, or nobody's. */
  function placeJunctions(nodes, pieces) {
    const sewer = (piece) => lines[piece.line].kind === 'g' && !lines[piece.line].stub;
    const pumped = (piece) => lines[piece.line].kind === 'p';
    nodes.forEach((node, n) => {
      delete node.station;
      delete node.plant;
      delete node.beside;
      let nearest;
      stationList.forEach((station, s) => {
        if (!inBox(node.xy, station.box)) return;
        const distance = awayFrom(node.xy, station);
        if (!nearest || distance < nearest.distance) nearest = { station: s, distance };
      });
      if (nearest && nearest.distance <= o.insideM) {
        node.station = nearest.station;
        return;
      }
      const plant = plantList.findIndex((candidate) => inBox(node.xy, candidate.box) && awayFrom(node.xy, candidate) <= o.insideM);
      if (plant >= 0) {
        node.plant = plant;
        return;
      }
      if (!nearest || nearest.distance > o.stationBesideM) return;
      // Outside the outline only junctions count, and only where something starts or ends: a sewer
      // that passes beside a station and carries on is not the station's.
      const sewers = flowsAt(nodes, pieces, n, sewer);
      const pumpedHere = flowsAt(nodes, pieces, n, pumped);
      const sewersEnd = endsHere(sewers);
      const pumpedEnds = pumpedEndHere(pumpedHere);
      if (nearest.distance <= o.stationNearM && ((pumpedEnds && sewers.leave === 0) || (sewersEnd && pumpedHere.all === 0))) node.station = nearest.station;
      else if (sewersEnd && pumpedHere.all === 0) {
        node.station = nearest.station;
        node.beside = round1(nearest.distance);
      }
    });
  }

  // ---- 4. A first joining, to see what is part of a pumped main although typed as a sewer; then again.
  let web = join();
  let { pieces, piecesOfLine } = cutUp(web);
  placeJunctions(web.nodes, pieces);
  {
    const { nodes } = web;
    let changed = false;
    // Groups of sewers joined to each other outside the stations. A group of 20 m or less in all that
    // hangs on a pumped main is part of it: a link, when it joins two places of pumped main, or a
    // station to one (8.9 m at Park Street; the bypass pipework beside a station) – taken as pumped
    // pipe; otherwise stubs (to a scour valve, a chamber) – unless the sewers end where a pumped main
    // starts: that is a small sewer into a pump that is not on the map.
    const sewer = (piece) => lines[piece.line].kind === 'g';
    const pumped = (piece) => lines[piece.line].kind === 'p';
    const sets = groups(lines.length);
    const facility = (n) => nodes[n].station !== undefined || nodes[n].plant !== undefined;
    nodes.forEach((node, n) => {
      if (facility(n)) return;
      const here = node.pieces.filter((i) => sewer(pieces[i]));
      for (const i of here) sets.join(pieces[i].line, pieces[here[0]].line);
    });
    const found = new Map(); // group -> { lengthM, joined: junctions with a pumped main, drawnOn: ends on the middle of one, station, inlet }
    lines.forEach((line, l) => {
      if (line.kind !== 'g') return;
      const group = found.get(sets.of(l)) ?? { lengthM: 0, joined: new Set(), drawnOn: 0, station: false, inlet: false };
      found.set(sets.of(l), group);
      group.lengthM += line.measured.length;
      for (const e of [2 * l, 2 * l + 1]) {
        const n = web.endNode[e];
        if (facility(n)) {
          group.station = true;
          continue;
        }
        const pumpedHere = flowsAt(nodes, pieces, n, pumped);
        if (pumpedHere.all > 0) {
          group.joined.add(n);
          if (startsHere(pumpedHere) && endsHere(flowsAt(nodes, pieces, n, sewer))) group.inlet = true;
        } else if (web.grid.near(web.endXY(e), o.joinM).some((near) => lines[near.line].kind === 'p')) group.drawnOn += 1;
      }
    });
    lines.forEach((line, l) => {
      const group = found.get(sets.of(l));
      if (line.kind !== 'g' || !(group.joined.size || group.drawnOn) || group.lengthM > o.stubM) return;
      // A link only between ends that meet: a stub drawn onto the middle of a second main (the 280 mm
      // main beside the 500 mm one in Park Street) does not join the two.
      if (group.joined.size > 1 || (group.joined.size && group.station)) Object.assign(line, { kind: 'p', joins: 'p', link: true });
      else if (!group.inlet) Object.assign(line, { joins: 'p', stub: true });
      else return;
      changed = true;
    });
    if (changed) {
      web = join();
      ({ pieces, piecesOfLine } = cutUp(web));
      placeJunctions(web.nodes, pieces);
    }
  }
  const { nodes } = web;
  const facilityAt = (n) => nodes[n].station !== undefined || nodes[n].plant !== undefined;

  // ---- 5. Links the map does not draw.
  const links = [];
  function addLink(link) {
    if (link.a === link.b || links.some((known) => known.kind === link.kind && ((known.a === link.a && known.b === link.b) || (known.a === link.b && known.b === link.a)))) return;
    links.push({ ...link, lengthM: round1(link.lengthM), at: lonLatOf(nodes[link.a].xy) });
  }
  // A gap: a dead end within a few metres of another main of its kind is joined to its nearest point.
  // (Stubs are left alone: the valve at the end of one is often beside another main.)
  for (let n = 0, count = nodes.length; n < count; n += 1) {
    const node = nodes[n];
    if (node.pieces.length !== 1 || facilityAt(n)) continue;
    const piece = pieces[node.pieces[0]];
    const own = lines[piece.line];
    if (piece.a === piece.b || own.stub) continue;
    // Not back onto the main a short spur has just left: that is no gap.
    const start = piece.a === n ? piece.b : piece.a;
    const spur = piece.to - piece.from <= o.gapM + o.joinM;
    // Two pumped mains only when they are of like size, or very close: the 0.7 m branch to an air valve
    // of a small pressure sewer ends 1.7 m from the 355 mm main of two pump stations, and is not on it.
    const alike = (found) => own.kind !== 'p' || found.distance <= o.gapCloseM || !own.diameter || !lines[found.line].diameter || Math.min(own.diameter, lines[found.line].diameter) / Math.max(own.diameter, lines[found.line].diameter) >= o.gapLikeSize;
    const near = web.grid.near(node.xy, o.gapM).find((found) => found.line !== piece.line && lines[found.line].kind === own.kind && !lines[found.line].stub && alike(found) && !(spur && web.cuts[found.line].some((cut) => cut.node === start)));
    if (!near) continue;
    const closest = (best, cut) => (Math.abs(cut.alongM - near.alongM) <= o.gapEndM && (!best || Math.abs(cut.alongM - near.alongM) < Math.abs(best.alongM - near.alongM)) ? cut : best);
    let target = web.cuts[near.line].reduce(closest, undefined)?.node;
    if (target === undefined) {
      target = web.addNode(pointAt(lines[near.line].measured, near.alongM));
      web.cuts[near.line].push({ alongM: near.alongM, node: target });
    }
    addLink({ a: n, b: target, kind: 'gap', pumped: own.kind === 'p', lengthM: near.distance });
  }
  ({ pieces, piecesOfLine } = cutUp(web)); // the gaps cut the mains they reach
  placeJunctions(nodes, pieces);

  // What is not followed: a station's own pipework, and a sewer recorded as leaving a station by
  // gravity (an overflow, or an odd record: at a station the way on is its pumped main).
  for (const piece of pieces) {
    const [a, b] = [nodes[piece.a], nodes[piece.b]];
    const line = lines[piece.line];
    if ((a.station !== undefined && a.station === b.station) || (a.plant !== undefined && a.plant === b.plant)) piece.mark = PIECE_MARK.pipework;
    else if (line.stub) piece.mark = PIECE_MARK.stub;
    else if (line.kind === 'g' && piece.dir !== 0 && (piece.dir === 1 ? a : b).station !== undefined) piece.mark = PIECE_MARK.leavesStation;
  }
  const otherEnd = (piece, n) => (piece.a === n ? piece.b : piece.a);
  // …and pipes that leave a station and come back to it by way of a point just outside its outline (the
  // delivery pipe of a pump to the station's own valve chamber, drawn round the building): pipework too.
  // Only a plain chain – a point where another pipe branches off is on a main, not in the station.
  {
    const justOutside = (n, station) => !facilityAt(n) && nodes[n].pieces.length === 2 && !links.some((link) => link.a === n || link.b === n) && awayFrom(nodes[n].xy, stationList[station]) <= o.stationBesideM;
    nodes.forEach((node, n) => {
      if (node.station === undefined) return;
      for (const first of node.pieces) {
        if (pieces[first].mark === PIECE_MARK.pipework || pieces[first].a === pieces[first].b) continue;
        const chain = [first];
        let at = otherEnd(pieces[first], n);
        while (justOutside(at, node.station) && chain.length < 8) {
          chain.push(nodes[at].pieces.find((i) => i !== chain.at(-1)));
          at = otherEnd(pieces[chain.at(-1)], at);
        }
        if (chain.length > 1 && nodes[at].station === node.station) for (const i of chain) pieces[i].mark = PIECE_MARK.pipework;
      }
    });
  }
  const sewersAt = (n) => flowsAt(nodes, pieces, n, isSewer);
  const pumpedAt = (n) => flowsAt(nodes, pieces, n, isPumped);
  const leaves = (piece, n) => piece.dir !== 0 && (piece.dir === 1) === (piece.a === n);

  // A main recorded as removed, or out of use, between a junction where its kind of flow arrives
  // and nothing leaves, and another junction: the way the sewage went, and may still go.
  for (const main of gone) {
    if (main.kind === 'v') continue;
    const [a, b] = [web.nodeNear(main.measured.points[0], o.goneM), web.nodeNear(main.measured.points.at(-1), o.goneM)];
    if (a === undefined || b === undefined || a === b) continue;
    const stuck = (n) => !facilityAt(n) && endsHere(main.kind === 'p' ? pumpedAt(n) : sewersAt(n));
    const from = [a, b].find(stuck);
    if (from === undefined) continue;
    addLink({ a: from, b: from === a ? b : a, kind: main.status === 'removed' ? 'removed' : 'notInUse', pumped: main.kind === 'p', lengthM: main.measured.length, id: main.id });
  }
  // A short vent or bypass pipe between two junctions is real pipework (the inlet of a station, a
  // joint of a pumped main recorded as a vent).
  for (const main of airPipes) {
    if (main.measured.length > o.shortLinkM) continue;
    const [a, b] = [web.nodeNear(main.measured.points[0], o.joinM), web.nodeNear(main.measured.points.at(-1), o.joinM)];
    if (a === undefined || b === undefined || a === b) continue;
    const onlyPumped = (n) => sewersAt(n).all === 0 && pumpedAt(n).all > 0;
    addLink({ a, b, kind: 'short', pumped: onlyPumped(a) && onlyPumped(b), lengthM: main.measured.length, id: main.id });
  }
  links.forEach((link, k) => {
    nodes[link.a].links.push(k);
    nodes[link.b].links.push(k);
  });

  // Where the council's network carries on outside the mapped area.
  const beyondGrid = lineGrid(beyond.map((main) => main.measured));
  const inCoverage = ([lon, lat]) => !input.coverage || input.coverage.some(([west, south, east, north]) => lon >= west && lon <= east && lat >= south && lat <= north);
  nodes.forEach((node, n) => {
    if (facilityAt(n)) return;
    const touching = beyondGrid.near(node.xy, o.outsideM)[0];
    if (touching) {
      const main = beyond[touching.line];
      node.beyond = { id: main.id, diameter: main.diameter, lengthM: Math.round(main.measured.length) };
    } else if (!inCoverage(projection.toLonLat(node.xy))) node.beyond = {};
  });

  // ---- 6. Valves, each on the pipe it is on.
  const pieceAtLine = (l, alongM) => piecesOfLine[l].find((i) => pieces[i].from <= alongM && alongM <= pieces[i].to) ?? piecesOfLine[l].reduce((best, i) => (best === undefined || Math.abs(pieces[i].from - alongM) < Math.abs(pieces[best].from - alongM) ? i : best), undefined);
  const stationNear = (xy, withinM) => {
    let nearest;
    stationList.forEach((station, s) => {
      if (!inBox(xy, station.box)) return;
      const distance = awayFrom(xy, station);
      if (distance <= withinM && (!nearest || distance < nearest.distance)) nearest = { station: s, distance };
    });
    return nearest?.station;
  };
  const stationValves = stationList.map(() => []);
  const valves = [];
  const kits = []; // boundary kits on no main: placed by their property connection, further down
  for (const valve of input.valves ?? []) {
    const xy = toXY(valve.at);
    // The nearest main; at a joint, the one of its size (as the water tool does), a main before a stub.
    const fit = (near) => (valve.diameter && lines[near.line].diameter ? Math.min(1, Math.abs(1 - valve.diameter / lines[near.line].diameter)) : 0.2);
    const score = (near) => near.distance + 0.5 * fit(near) + (lines[near.line].stub ? 0.01 : 0);
    const near = web.grid.near(xy, o.joinM).reduce((best, found) => (!best || score(found) < score(best) ? found : best), undefined);
    const entry = { id: valve.id, type: valve.type, at: valve.at.map(round6), piece: -1, alongM: 0, street: valve.street, depth: valve.depth, depthFrom: valve.depthFrom, role: valve.role, position: valve.position, diameter: valve.diameter, note: valve.note };
    if (near) {
      const line = lines[near.line];
      const inset = Math.min(o.valveInsetM, line.measured.length / 2);
      const alongM = Math.min(line.measured.length - inset, Math.max(inset, near.alongM));
      const index = pieceAtLine(near.line, alongM);
      if (index !== undefined) {
        const piece = pieces[index];
        const byHand = PLAIN_VALVES.has(valve.type);
        // The joint it stands at, if any: a junction of three or more pipes.
        const joint = [piece.a, piece.b].find((n) => nodes[n].pieces.length >= 3 && Math.hypot(nodes[n].xy[0] - xy[0], nodes[n].xy[1] - xy[1]) <= o.joinM);
        if (joint !== undefined) entry.joint = true;
        // Where three or more pipes of different sizes meet, a valve with no size of its own – in the record
        // or in the council's words – may be on any of them. It is kept on the nearest and said, and is
        // never the line valve of that pipe: it ends no stretch (the 80 mm valve of a side branch is not
        // the valve of the 560 mm main beside it). Between two pipes in line it cuts the line either way.
        const pipeNotKnown = byHand && (valve.role === undefined || valve.role === 'line') && !valve.diameter && joint !== undefined && new Set(nodes[joint].pieces.map((i) => lines[pieces[i].line].diameter)).size > 1;
        if (pipeNotKnown) entry.pipeNotKnown = true;
        const cuts = byHand && (valve.role === undefined || valve.role === 'line') && !pipeNotKnown;
        const ofItsSize = !valve.diameter || !line.diameter || valve.diameter / line.diameter >= o.valveSizeRatio;
        Object.assign(entry, { piece: index, alongM: round1(alongM) });
        if (line.kind === 'p' && cuts) entry.line = true;
        // A scour by the council's words; or a hand valve on a stub off the main, whatever it is called.
        if (valve.role === 'scour' || valve.type === 'Scour valve' || (line.stub && cuts)) entry.drain = true;
        // Recorded closed, in line, about the main's size: a pump's sewage is taken past it only when the
        // map shows no other way (it is this valve's place in the result: no boundary kit comes here).
        if (line.kind === 'p' && byHand && (cuts || valve.role === 'bypass') && valve.position === 'closed' && ofItsSize && !pipeNotKnown && piece.mark !== PIECE_MARK.pipework) {
          entry.closedInLine = true;
          (piece.closed ??= []).push(valves.length);
        }
      }
    }
    if (entry.piece < 0 && /^Boundary kit/.test(String(valve.type))) {
      kits.push({ entry, xy });
      continue;
    }
    const station = stationNear(xy, o.stationValveM);
    if (station !== undefined) stationValves[station].push(valves.length);
    valves.push(entry);
  }

  // ---- 7. Property connections, each as a point on its pipe.
  const connections = [];
  const connectionStats = { given: 0, onAMain: 0, throughAnother: 0, notPlaced: 0, pumped: 0 };
  {
    const laterals = (input.connections ?? []).filter((connection) => connection.line?.length > 1).map((connection) => ({ ...connection, measured: measureLine(connection.line, projection) }));
    connectionStats.given = laterals.length;
    const lateralGrid = lineGrid(laterals.map((lateral) => lateral.measured));
    const joiningEnds = ({ measured, joins }) => (joins === 0 ? [measured.points[0]] : joins === 1 ? [measured.points.at(-1)] : [measured.points[0], measured.points.at(-1)]);
    const placed = laterals.map(() => undefined); // [piece, alongM]
    const nearest = (list) => list.reduce((best, found) => (found && (!best || found.distance < best.distance) ? found : best), undefined);
    const onMain = (near) => {
      const piece = near && pieceAtLine(near.line, near.alongM);
      return piece === undefined ? undefined : [piece, round1(near.alongM)];
    };
    const waiting = []; // [connection, the main to fall back on]
    laterals.forEach((lateral, c) => {
      const ends = joiningEnds(lateral);
      const main = nearest(ends.map((end) => web.grid.near(end, o.connectionM)[0]));
      const other = nearest(ends.map((end) => lateralGrid.near(end, o.connectionM).find((near) => near.line !== c)));
      // On the main – unless it touches another connection and only comes near a main: the short
      // piece at a boundary runs on through that connection, not into the pumped main beside it.
      if (onMain(main) && !(other && other.distance < main.distance - 0.1)) {
        placed[c] = onMain(main);
        connectionStats.onAMain += 1;
      } else waiting.push([c, onMain(main)]);
    });
    // …or through another connection (a shared drain), or a lamphole on one, until no more can be placed.
    const loneHoles = pointGrid();
    holes.forEach((hole) => loneHoles.add(hole.xy, hole));
    for (let again = true; again; ) {
      again = false;
      for (const [c] of waiting) {
        if (placed[c]) continue;
        const spots = joiningEnds(laterals[c]).flatMap((end) => [end, ...loneHoles.near(end, o.connectionM).map((found) => found.item.xy)]);
        const through = spots.flatMap((spot) => lateralGrid.near(spot, o.connectionM)).find((near) => near.line !== c && placed[near.line]);
        if (!through) continue;
        placed[c] = [placed[through.line][0], placed[through.line][1], 1];
        connectionStats.throughAnother += 1;
        again = true;
      }
    }
    for (const [c, main] of waiting) {
      if (placed[c] || !main) continue;
      placed[c] = main;
      connectionStats.onAMain += 1;
    }
    laterals.forEach((lateral, c) => {
      if (!placed[c]) return;
      connections.push(placed[c][2] ? [placed[c][0], placed[c][1], lateral.pumped ? 1 : 0, 1] : [placed[c][0], placed[c][1], lateral.pumped ? 1 : 0]);
      if (lateral.pumped) connectionStats.pumped += 1;
    });
    connectionStats.notPlaced = laterals.length - connections.length;
    // A boundary kit sits on its property connection, not on the main: it goes where the connection joins.
    for (const { entry, xy } of kits) {
      const on = lateralGrid.near(xy, o.connectionM).find((near) => placed[near.line]);
      if (on) Object.assign(entry, { piece: placed[on.line][0], alongM: placed[on.line][1], onConnection: true });
      valves.push(entry);
    }
  }

  // ---- 8. Pressure systems: pumped pipes (and their stubs) joined to each other outside the stations.
  const inSystem = (piece) => (lines[piece.line].kind === 'p' || lines[piece.line].stub) && piece.mark !== PIECE_MARK.pipework;
  const systems = [];
  {
    const sets = groups(pieces.length);
    nodes.forEach((node, n) => {
      if (facilityAt(n)) return;
      const here = node.pieces.filter((i) => inSystem(pieces[i]));
      for (const i of here) sets.join(i, here[0]);
      for (const k of node.links) {
        if (!links[k].pumped) continue;
        const far = otherEnd(links[k], n);
        const there = facilityAt(far) ? undefined : nodes[far].pieces.find((i) => inSystem(pieces[i]));
        if (here.length && there !== undefined) sets.join(there, here[0]);
      }
    });
    const systemOf = new Map();
    pieces.forEach((piece, i) => {
      if (!inSystem(piece)) return;
      if (!systemOf.has(sets.of(i))) {
        systemOf.set(sets.of(i), systems.length);
        systems.push({ kind: 'unknown', lengthM: 0, sources: [], discharges: [], lineValves: 0, connections: 0 });
      }
      piece.system = systemOf.get(sets.of(i));
      if (piece.mark !== PIECE_MARK.stub) systems[piece.system].lengthM += piece.to - piece.from;
    });
  }
  for (const valve of valves) if (valve.line && pieces[valve.piece].system >= 0) systems[pieces[valve.piece].system].lineValves += 1;
  for (const [piece] of connections) if (pieces[piece].system >= 0) systems[pieces[piece].system].connections += 1;
  const pumpedMain = (piece) => lines[piece.line].kind === 'p' && piece.mark === 0 && piece.a !== piece.b;
  // A pumped main that starts outside the mapped area brings in what the map cannot count.
  nodes.forEach((node, n) => {
    if (!node.beyond || node.links.length) return;
    const flows = pumpedAt(n);
    if (flows.all === 1 && flows.leave === 1 && !sewersAt(n).all) (systems[pieces[node.pieces.find((i) => pumpedMain(pieces[i]))].system].inflow ??= []).push(n);
  });

  // Each station: its junctions, and which systems it pumps into or receives, by the record of the
  // mains at it. With no direction, the station with no other pumped main is the pump.
  const stations = stationList.map((station) => ({ name: station.name, junctions: [], pumpsInto: [], receives: [] }));
  nodes.forEach((node, n) => {
    if (node.station !== undefined) stations[node.station].junctions.push(n);
  });
  stations.forEach((station) => {
    const seen = new Map(); // system -> { leave, arrive, unknown }
    for (const n of station.junctions) {
      for (const i of nodes[n].pieces) {
        const piece = pieces[i];
        if (!pumpedMain(piece)) continue;
        const flows = seen.get(piece.system) ?? { leave: 0, arrive: 0, unknown: 0 };
        seen.set(piece.system, flows);
        flows[piece.dir === 0 ? 'unknown' : leaves(piece, n) ? 'leave' : 'arrive'] += 1;
      }
    }
    for (const [system, flows] of seen) {
      if (flows.leave) station.pumpsInto.push(system);
      if (flows.arrive) station.receives.push(system);
    }
    // A main with no direction: the way out of a station that has no other; into one that has.
    const leavesByRecord = station.pumpsInto.length > 0;
    for (const [system, flows] of seen) {
      if (flows.leave || flows.arrive) continue;
      (leavesByRecord ? station.receives : station.pumpsInto).push(system);
      if (!leavesByRecord) station.inferred = 'noDirection';
    }
    if (!station.pumpsInto.length) station.noMain = true;
  });

  // ---- 9. Where the sewers can leave by, besides the stations and the plant.
  const outlets = [];
  const outletAt = nodes.map(() => -1);
  const nodeGrid = pointGrid();
  nodes.forEach((node, n) => nodeGrid.add(node.xy, n));
  // Whether the sewers joined to a junction bring anything: a property connection, or more pipe than a stub.
  const withConnection = new Set(connections.map(([piece]) => piece));
  const somethingDrainsTo = (n) => {
    const seen = new Set([n]);
    const counted = new Set();
    let lengthM = 0;
    for (const waiting = [n]; waiting.length; ) {
      const at = waiting.pop();
      for (const i of nodes[at].pieces) {
        if (counted.has(i) || !isSewer(pieces[i])) continue;
        counted.add(i);
        lengthM += pieces[i].to - pieces[i].from;
        if (withConnection.has(i) || lengthM > o.stubM) return true;
        const far = otherEnd(pieces[i], at);
        if (!seen.has(far)) {
          seen.add(far);
          waiting.push(far);
        }
      }
    }
    return false;
  };
  nodes.forEach((node, n) => {
    if (facilityAt(n)) return;
    const sewers = sewersAt(n);
    if (!sewers.all || !endsHere(sewers)) return;
    const pumpedHere = pumpedAt(n);
    let outlet;
    if (pumpedHere.all) {
      // The sewers end on a pumped main that goes on from here: a pump with no outline where no
      // pumped main arrives too; otherwise they join a pumped main on its way.
      const onward = node.pieces.find((i) => pumpedMain(pieces[i]) && (pieces[i].dir === 0 || leaves(pieces[i], n)));
      if (onward !== undefined) outlet = { kind: startsHere(pumpedHere) ? 'pump' : 'joins', junction: n, system: pieces[onward].system };
    } else if (node.beyond) {
      outlet = { kind: 'leaves', junction: n, ...node.beyond };
    } else {
      // …or a pumped main starts a few metres away, with no station: the pump is not on the map. Not where
      // the sewer brings nothing to pump – a few metres of pipe with no property on it (the emergency
      // discharge beside the Lake Hayes main at the Shotover bridge: every answer on that main said "a pump
      // with no record feeds this main").
      for (const { item: m, distance } of somethingDrainsTo(n) ? nodeGrid.near(node.xy, o.pumpStartM) : []) {
        if (m === n || facilityAt(m) || sewersAt(m).all) continue;
        const start = pumpedAt(m);
        if (start.all !== 1 || start.arrive) continue;
        outlet = { kind: 'pump', junction: n, system: pieces[nodes[m].pieces.find((i) => pumpedMain(pieces[i]))].system, from: m, gapM: round1(distance) };
        break;
      }
    }
    if (!outlet) return;
    outletAt[n] = outlets.length;
    outlets.push(outlet);
  });
  // A station with no way out, whose one pumped main is recorded as arriving – from nowhere: no
  // station or pump feeds that main, no property pumps into it, it does not come in from outside the
  // map. Its record is the wrong way round (a private line at Robertson Street): the station is taken
  // as the pump of that main, and that is said.
  {
    const fed = new Set(outlets.filter((outlet) => outlet.system !== undefined).map((outlet) => outlet.system));
    for (const station of stations) for (const system of station.pumpsInto) fed.add(system);
    systems.forEach((system, x) => {
      if (system.connections || system.inflow) fed.add(x);
    });
    for (const station of stations) {
      if (!station.noMain || station.receives.length !== 1 || fed.has(station.receives[0])) continue;
      Object.assign(station, { pumpsInto: station.receives, receives: [], inferred: 'againstRecord' });
      delete station.noMain;
    }
  }

  // ---- 10. One way down for every junction of sewers.
  // The larger pipe, where the record lets sewage leave a junction two ways.
  const largestLeaving = (sort) => nodes.map((node, n) => Math.max(0, ...node.pieces.filter((i) => sort(pieces[i]) && leaves(pieces[i], n)).map((i) => lines[pieces[i].line].diameter)));
  const largestSewer = largestLeaving(isSewer);
  const largestPumped = largestLeaving(pumpedMain);
  /** What it costs to go through a piece from junction `from` (largest: the largest pipe of its sort recorded as leaving each junction). */
  function stepThrough(piece, from, largest) {
    const withRecord = leaves(piece, from);
    return [piece.dir !== 0 && !withRecord ? 1 : 0, 0, withRecord && lines[piece.line].diameter < largest[from] ? 1 : 0, piece.dir === 0 ? 1 : 0, piece.to - piece.from, piece.closed?.length ?? 0];
  }
  const overLink = (link) => [0, 1, 0, 0, link.lengthM, 0];
  // A dead end that its one pipe is recorded as running into (a stub into an abandoned manhole, into
  // old ponds) is an end: sending it back up its own pipe would turn the pipe round for nothing.
  const deadEndOf = nodes.map((node, n) => {
    const here = node.pieces.filter((i) => isSewer(pieces[i]) && pieces[i].a !== pieces[i].b);
    return here.length === 1 && !node.links.length && pieces[here[0]].dir !== 0 && !leaves(pieces[here[0]], n) ? here[0] : -1;
  });
  let cost = nodes.map(() => undefined);
  let down = nodes.map(() => undefined); // a piece, or a link as -(index + 1)
  let endOf = nodes.map(() => -1); // the junction where the way down ends
  /** Leads every junction not yet led anywhere to the nearest of `ends`, backwards from them. */
  function leadTo(ends) {
    const queue = cheapestFirst();
    for (const n of ends) {
      if (cost[n]) continue;
      cost[n] = NOTHING;
      endOf[n] = n;
      queue.push([NOTHING, n]);
    }
    const offer = (n, from, wayCost, by) => {
      // What arrives at a station or at the plant stays there: also at a station with no pumped main
      // in use, where the sewers recorded as running into it end.
      if (facilityAt(n)) return;
      if (cost[n] && !cheaper(wayCost, cost[n])) return; // an end costs nothing: it stays an end
      cost[n] = wayCost;
      down[n] = by;
      endOf[n] = endOf[from];
      queue.push([wayCost, n]);
    };
    while (queue.size) {
      const [wayCost, n] = queue.pop();
      if (cost[n] !== wayCost) continue; // a cheaper way was found since
      for (const i of nodes[n].pieces) {
        const piece = pieces[i];
        if (!isSewer(piece) || piece.a === piece.b) continue;
        const from = otherEnd(piece, n);
        if (settled.has(from) || deadEndOf[from] === i) continue;
        offer(from, n, plus(wayCost, stepThrough(piece, from, largestSewer)), i);
      }
      for (const k of nodes[n].links) {
        const from = otherEnd(links[k], n);
        if (!links[k].pumped && !settled.has(from)) offer(from, n, plus(wayCost, overLink(links[k])), -(k + 1));
      }
    }
  }
  let settled = new Set(); // junctions led somewhere in an earlier round: never led again

  // The pumps: every station that pumps into a system, every pump that is not on the map.
  const sources = new Map(); // 'S' + station | 'O' + outlet -> { starts, station? }
  stations.forEach((station, s) => {
    if (!station.noMain) sources.set(`S${s}`, { starts: station.junctions, station: s });
  });
  outlets.forEach((outlet, k) => {
    if (outlet.kind === 'pump' || outlet.kind === 'joins') sources.set(`O${k}`, { starts: [outlet.from ?? outlet.junction] });
  });
  /**
   * Every place the sewage of a pump can leave its pumped mains, going forwards from it: the plant, the
   * well of another station, out of the mapped area, a junction where a sewer takes it on and no pumped
   * main is recorded as leaving – or, with nothing else, where the main just ends.
   */
  function dischargesOf({ starts, station }, source) {
    const best = new Map(starts.map((n) => [n, { cost: NOTHING }]));
    const queue = cheapestFirst();
    for (const n of starts) queue.push([NOTHING, n]);
    const done = new Set();
    const found = [];
    while (queue.size) {
      const [wayCost, n] = queue.pop();
      if (done.has(n) || best.get(n).cost !== wayCost) continue;
      done.add(n);
      const node = nodes[n];
      const cameBy = best.get(n).by;
      const started = starts.includes(n);
      if (!started && node.plant !== undefined) found.push({ junction: n, kind: 'plant', plant: node.plant, cost: wayCost });
      if (!started && node.station !== undefined) found.push({ junction: n, kind: 'station', station: node.station, cost: wayCost });
      if (!started && facilityAt(n)) continue;
      const onward = node.pieces.filter((i) => i !== cameBy && pumpedMain(pieces[i]));
      if (!started && outletAt[n] < 0) {
        // A sewer takes it on from here: recorded as leaving, with no direction, or the way down of this junction.
        const sewers = sewersAt(n);
        const takenOn = sewers.leave > 0 || sewers.unknown > 0 || (sewers.all > 0 && down[n] !== undefined);
        if (takenOn && !onward.some((i) => leaves(pieces[i], n))) {
          found.push({ junction: n, kind: 'gravity', cost: wayCost });
          continue;
        }
      }
      const offer = (to, wayTo, by) => {
        if (done.has(to) || (station !== undefined && nodes[to].station === station)) return;
        if (best.has(to) && !cheaper(wayTo, best.get(to).cost)) return;
        best.set(to, { cost: wayTo, by, from: n });
        queue.push([wayTo, to]);
      };
      let ways = 0;
      for (const i of node.pieces) {
        const piece = pieces[i];
        if (!pumpedMain(piece)) continue;
        if (i !== cameBy) ways += 1;
        offer(otherEnd(piece, n), plus(wayCost, stepThrough(piece, n, largestPumped)), i);
      }
      for (const k of node.links) {
        if (!links[k].pumped) continue;
        if (-(k + 1) !== cameBy) ways += 1;
        offer(otherEnd(links[k], n), plus(wayCost, overLink(links[k])), -(k + 1));
      }
      if (!started && ways === 0 && outletAt[n] < 0) found.push({ junction: n, kind: node.beyond ? 'leaves' : 'nowhere', beyond: carriesOn(node), cost: wayCost });
    }
    // The nearest first; a main that just ends only when there is nothing else.
    found.sort((a, b) => (a.kind === 'nowhere') - (b.kind === 'nowhere') || (cheaper(a.cost, b.cost) ? -1 : cheaper(b.cost, a.cost) ? 1 : 0));
    reachOf.set(source, best);
    return found.map((candidate) => {
      const via = [];
      for (let at = candidate.junction; best.get(at).by !== undefined; at = best.get(at).from) via.unshift(best.get(at).by);
      return { ...candidate, via };
    });
  }
  /** The council's main that carries on outside the mapped area from a junction: { id, diameter, lengthM }. */
  const carriesOn = (node) => (node.beyond?.id === undefined ? undefined : node.beyond);
  const candidates = new Map(); // source -> its possible discharges, nearest first
  const reachOf = new Map(); // source -> every junction its sewage can reach, with the pipe it came by
  const chosen = new Map(); // source -> the one taken
  /** Where a way that reaches the end junction `end` goes on to: a source ('S…', 'O…'), 'plant', 'leaves' or 'none'. */
  function onwardFrom(end) {
    if (end < 0) return 'none';
    const node = nodes[end];
    if (node.plant !== undefined) return 'plant';
    if (node.station !== undefined) return stations[node.station].noMain ? 'none' : `S${node.station}`;
    const outlet = outlets[outletAt[end]];
    if (!outlet || outlet.kind === 'end') return 'none';
    return outlet.kind === 'leaves' ? 'leaves' : `O${outletAt[end]}`;
  }
  /** Where the sewage of a discharge ends up: 'plant', 'leaves' (the mapped area), 'none', or 'loop' (back to a pump already passed). */
  function fateOf(candidate, passed) {
    let next;
    if (candidate.kind === 'plant' || candidate.kind === 'leaves') return candidate.kind;
    if (candidate.kind === 'nowhere') return 'none';
    if (candidate.kind === 'station') next = stations[candidate.station].noMain ? 'none' : `S${candidate.station}`;
    else next = onwardFrom(endOf[candidate.junction]);
    if (!sources.has(next)) return next;
    if (passed.has(next)) return 'loop';
    const taken = choose(next, new Set([...passed, next]));
    return taken ? taken.fate : 'none';
  }
  /** The discharge of a pump: the nearest that leads to the plant or out of the map; failing that, the nearest that does not come back to it. */
  function choose(source, passed) {
    if (passed.size === 1 && chosen.has(source)) return chosen.get(source);
    let fallback;
    let taken;
    for (const candidate of candidates.get(source)) {
      const fate = fateOf(candidate, passed);
      if (fate === 'plant' || fate === 'leaves') {
        taken = { ...candidate, fate };
        break;
      }
      if (fate !== 'loop' && !fallback) fallback = { ...candidate, fate };
    }
    taken ??= fallback;
    if (passed.size === 1) chosen.set(source, taken);
    return taken;
  }

  // The real ways on first. A pump whose main discharges nowhere is not one: found out by trying,
  // then the search is run again without it.
  const real = new Set(outlets.map((_, k) => k)); // outlets taken as a real way on
  stats.pumpsLeadingNowhere = 0;
  for (let round = 0; round < 8; round += 1) {
    cost = nodes.map(() => undefined);
    down = nodes.map(() => undefined);
    endOf = nodes.map(() => -1);
    settled = new Set();
    const ends = [];
    nodes.forEach((node, n) => {
      if (node.plant !== undefined || (node.station !== undefined && !stations[node.station].noMain) || (outletAt[n] >= 0 && real.has(outletAt[n]))) ends.push(n);
    });
    leadTo(ends);
    candidates.clear();
    chosen.clear();
    for (const [source, pump] of sources) candidates.set(source, dischargesOf(pump, source));
    for (const source of sources.keys()) choose(source, new Set([source]));
    const nowhere = [...real].filter((k) => sources.has(`O${k}`) && (!chosen.get(`O${k}`) || chosen.get(`O${k}`).kind === 'nowhere'));
    if (!nowhere.length) break;
    for (const k of nowhere) real.delete(k);
    stats.pumpsLeadingNowhere += nowhere.length;
  }

  // What reaches none of them is led to where it ends on the map, with the reason.
  const sewerGrid = lineGrid(lines.map((line) => line.measured));
  function whyItEnds(n) {
    const node = nodes[n];
    const inside = otherPlaces.find((place) => inBox(node.xy, place.box) && awayFrom(node.xy, place) === 0);
    if (inside) return { reason: 'inside', name: inside.name, note: inside.note };
    // Another main: not its own, nor the one its own pipe has just left.
    const own = new Set(node.pieces.flatMap((i) => [i, ...nodes[otherEnd(pieces[i], n)].pieces]).map((i) => pieces[i].line));
    const near = sewerGrid.near(node.xy, o.nearEndM).find((found) => !own.has(found.line));
    if (near) return { reason: 'near', nearM: round1(near.distance) };
    if (node.pieces.some((i) => mains[lines[pieces[i].line].main].owner === 'private')) return { reason: 'private' };
    return { reason: 'nothing' };
  }
  const reached = () => new Set(nodes.map((_, n) => n).filter((n) => cost[n]));
  const endHere = (n, more) => {
    if (outletAt[n] < 0) {
      outletAt[n] = outlets.length;
      outlets.push({ kind: 'end', junction: n, ...more });
    }
    return n;
  };
  // First the plain ends: a station with no pumped main in use, a pump whose main leads nowhere, a
  // junction where the sewers arrive and nothing – not even a link – leaves.
  settled = reached();
  {
    const ends = [];
    nodes.forEach((node, n) => {
      if (settled.has(n)) return;
      if (node.station !== undefined) ends.push(n);
      else if (outletAt[n] >= 0) ends.push(n); // a pump or a join that leads nowhere: still where these sewers end
      else if (node.plant === undefined && sewersAt(n).all && endsHere(sewersAt(n)) && !node.links.some((k) => !links[k].pumped)) ends.push(endHere(n, whyItEnds(n)));
    });
    leadTo(ends);
  }
  // Then what is still left: junctions that nothing is recorded as leaving.
  settled = reached();
  {
    const ends = [];
    nodes.forEach((node, n) => {
      if (!settled.has(n) && !facilityAt(n) && sewersAt(n).all && sewersAt(n).leave === 0) ends.push(endHere(n, whyItEnds(n)));
    });
    leadTo(ends);
  }

  // ---- 11. The way each piece is taken to run.
  for (const [i, piece] of pieces.entries()) {
    piece.run = piece.dir;
    if (!isSewer(piece) || piece.a === piece.b) continue;
    if (down[piece.a] === i) piece.run = 1;
    else if (down[piece.b] === i) piece.run = -1;
    else if (piece.dir === 0 && (cost[piece.a] || cost[piece.b])) {
      // On no junction's way down and with no record: towards the end with the better way on.
      if (!cost[piece.a]) piece.run = 1;
      else if (!cost[piece.b]) piece.run = -1;
      else piece.run = cheaper(cost[piece.b], cost[piece.a]) ? 1 : cheaper(cost[piece.a], cost[piece.b]) ? -1 : 0;
    }
  }
  // A pumped piece with no recorded direction runs the way the pumps send sewage through it (when
  // they all send it the same way).
  {
    const sent = new Map(); // piece -> 1 | -1 | 0 (both ways)
    for (const reach of reachOf.values()) {
      for (const { by, from } of reach.values()) {
        if (by === undefined || by < 0 || pieces[by].dir !== 0) continue;
        const way = pieces[by].a === from ? 1 : -1;
        sent.set(by, sent.has(by) && sent.get(by) !== way ? 0 : way);
      }
    }
    for (const [i, way] of sent) pieces[i].run = way;
  }
  const dischargeOf = (source) => {
    const taken = chosen.get(source);
    if (!taken) return undefined;
    const first = taken.via.find((step) => step >= 0);
    const system = first !== undefined ? pieces[first].system : (pieces[nodes[taken.junction].pieces.find((i) => pumpedMain(pieces[i]))]?.system ?? -1);
    const closed = taken.via.flatMap((step) => (step >= 0 ? (pieces[step].closed ?? []) : []));
    return { system, junction: taken.junction, kind: taken.kind, station: taken.station, plant: taken.plant, beyond: taken.beyond, lengthM: Math.round(taken.cost[4]), against: taken.cost[0], links: taken.cost[1], noDirection: taken.cost[3], closed: closed.length ? closed : undefined, via: taken.via };
  };
  for (const source of sources.keys()) {
    const taken = chosen.get(source);
    if (!taken) continue;
    let at = taken.junction;
    for (const step of [...taken.via].reverse()) {
      const from = step >= 0 ? otherEnd(pieces[step], at) : otherEnd(links[-step - 1], at);
      // …and one a pump's way to its discharge takes against its record, the other way.
      if (step >= 0 && (pieces[step].run === 0 || pieces[step].dir !== 0)) pieces[step].run = pieces[step].a === from ? 1 : -1;
      at = from;
    }
  }

  // ---- 12. What each system is fed by, and where it lets go.
  stations.forEach((station, s) => {
    for (const system of station.pumpsInto) systems[system].sources.push({ station: s });
    if (!station.noMain) station.discharge = dischargeOf(`S${s}`);
  });
  outlets.forEach((outlet, k) => {
    if (outlet.kind !== 'pump' && outlet.kind !== 'joins') return;
    systems[outlet.system].sources.push({ outlet: k });
    outlet.discharge = dischargeOf(`O${k}`);
    if (!real.has(k)) outlet.nowhere = true;
  });
  // Every end of a system, read with the strongest evidence first.
  nodes.forEach((node, n) => {
    const here = node.pieces.filter((i) => pumpedMain(pieces[i]));
    if (!here.length) return;
    const flows = pumpedAt(n);
    for (const system of new Set(here.map((i) => pieces[i].system))) {
      const add = (discharge) => systems[system].discharges.push({ junction: n, ...discharge });
      if (node.plant !== undefined) add({ kind: 'plant', plant: node.plant });
      else if (node.station !== undefined) {
        if (stations[node.station].receives.includes(system) && !systems[system].discharges.some((d) => d.station === node.station)) add({ kind: 'station', station: node.station });
      } else if (outletAt[n] >= 0 && outlets[outletAt[n]].kind !== 'end') {
        // the sewers end here: a way in, not a way out
      } else if (flows.leave === 0 && (sewersAt(n).leave > 0 || sewersAt(n).unknown > 0 || (sewersAt(n).all > 0 && down[n] !== undefined))) add({ kind: 'gravity' });
      else if (flows.all === 1 && flows.arrive && !node.links.some((k) => links[k].pumped)) add(tidy({ kind: node.beyond ? 'leaves' : 'nowhere', beyond: carriesOn(node) }));
    }
  });

  // What each system is: fed by stations, by a pump with no record, by the pumps of the properties, or unknown.
  for (const system of systems) {
    system.lengthM = Math.round(system.lengthM);
    system.kind = system.sources.some((source) => source.station !== undefined) ? 'stations' : system.connections ? 'lowPressure' : system.sources.length ? 'pump' : 'unknown';
  }

  // ---- 13. Where the record lets sewage leave a junction two ways, and the two end in different places.
  const firstStop = (n) => {
    const end = endOf[n];
    if (end < 0) return 'none';
    if (nodes[end].station !== undefined) return `station ${nodes[end].station}`;
    if (nodes[end].plant !== undefined) return `plant ${nodes[end].plant}`;
    return `outlet ${outletAt[end]}`;
  };
  const splits = [];
  stats.splits = { junctions: 0, toDifferentPlaces: 0 };
  nodes.forEach((node, n) => {
    if (facilityAt(n) || down[n] === undefined || down[n] < 0) return;
    const ways = node.pieces.filter((i) => isSewer(pieces[i]) && pieces[i].a !== pieces[i].b && leaves(pieces[i], n));
    if (ways.length < 2 || !ways.includes(down[n])) return;
    stats.splits.junctions += 1;
    for (const other of ways) {
      const far = otherEnd(pieces[other], n);
      const end = endOf[far];
      // A stub that leads nowhere is no second way.
      if (other === down[n] || firstStop(far) === firstStop(n) || end < 0 || (outletAt[end] >= 0 && outlets[outletAt[end]].kind === 'end')) continue;
      splits.push({ junction: n, followed: down[n], other, otherEndsAt: nodes[end].station !== undefined ? { station: nodes[end].station } : nodes[end].plant !== undefined ? { plant: nodes[end].plant } : { outlet: outletAt[end] } });
      stats.splits.toDifferentPlaces += 1;
    }
  });

  // ---- 14. The figures of the build.
  /** Where the sewage of a junction ends up in the end, pump after pump: 'plant', 'leaves' (the mapped area) or 'none'. */
  function fate(n) {
    const passed = new Set();
    for (let next = onwardFrom(endOf[n]); ; ) {
      if (!sources.has(next)) return next;
      if (passed.has(next)) return 'none';
      passed.add(next);
      const taken = chosen.get(next);
      if (!taken || taken.kind === 'nowhere') return 'none';
      if (taken.kind === 'plant' || taken.kind === 'leaves') return taken.kind;
      next = taken.kind === 'station' ? (stations[taken.station].noMain ? 'none' : `S${taken.station}`) : onwardFrom(endOf[taken.junction]);
    }
  }
  const tallyBy = (list, keyOf) => list.reduce((tally, item) => ({ ...tally, [keyOf(item)]: (tally[keyOf(item)] ?? 0) + 1 }), {});
  {
    const ways = { sewers: 0, firstStop: {}, wholeWay: {}, againstTheirRecord: 0, takingOneAgainst: 0, overALink: 0 };
    lines.forEach((line, l) => {
      if (line.kind !== 'g' || line.stub) return;
      const i = piecesOfLine[l].find((index) => isSewer(pieces[index]) && pieces[index].a !== pieces[index].b);
      if (i === undefined) return; // a station's own pipework, an overflow
      ways.sewers += 1;
      const piece = pieces[i];
      const against = piecesOfLine[l].some((index) => pieces[index].dir !== 0 && pieces[index].run === -pieces[index].dir);
      if (against) ways.againstTheirRecord += 1;
      const lower = piece.run === 1 ? piece.b : piece.run === -1 ? piece.a : undefined;
      const end = lower === undefined ? -1 : endOf[lower];
      const outlet = end < 0 ? undefined : outlets[outletAt[end]];
      const stop = end < 0 ? 'none' : nodes[end].station !== undefined ? (stations[nodes[end].station].noMain ? 'stationWithNoMain' : 'station') : nodes[end].plant !== undefined ? 'plant' : outlet.kind === 'end' ? 'none' : outlet.nowhere ? 'pumpLeadingNowhere' : outlet.kind;
      ways.firstStop[stop] = (ways.firstStop[stop] ?? 0) + 1;
      const whole = lower === undefined ? 'none' : fate(lower);
      ways.wholeWay[whole] = (ways.wholeWay[whole] ?? 0) + 1;
      if (lower !== undefined && cost[lower] && (cost[lower][0] > 0 || against)) ways.takingOneAgainst += 1;
      if (lower !== undefined && cost[lower]?.[1] > 0) ways.overALink += 1;
    });
    stats.ways = ways;
  }
  stats.mains = {
    followed: mains.length,
    sewers: lines.filter((line) => line.kind === 'g' && !line.stub).length,
    pumped: lines.filter((line) => line.kind === 'p').length,
    pumpedBySize: mains.filter((main, m) => main.small && twinOf[m] === undefined).length,
    pumpedLinks: lines.filter((line) => line.link).length,
    stubs: lines.filter((line) => line.stub).length,
    recordedTwice: twinOf.filter((twin) => twin !== undefined).length,
    notFollowed: airPipes.length,
  };
  stats.joins = { junctions: nodes.length, ...web.counts, manholes: nodes.reduce((total, node) => total + node.manholes.length, 0), stationJunctions: nodes.filter((node) => node.station !== undefined).length, besideAStation: nodes.filter((node) => node.beside !== undefined).length, atThePlant: nodes.filter((node) => node.plant !== undefined).length };
  stats.pieces = { all: pieces.length, pipework: pieces.filter((piece) => piece.mark === PIECE_MARK.pipework).length, leavingAStation: pieces.filter((piece) => piece.mark === PIECE_MARK.leavesStation).length, stubs: pieces.filter((piece) => piece.mark === PIECE_MARK.stub).length };
  stats.links = tallyBy(links, (link) => link.kind);
  stats.outlets = tallyBy(outlets, (outlet) => (outlet.kind === 'end' ? `end: ${outlet.reason}` : outlet.kind));
  stats.stations = { all: stations.length, withNoMain: stations.filter((station) => station.noMain).map((station) => station.name), inferred: stations.filter((station) => station.inferred === 'noDirection').map((station) => station.name), againstRecord: stations.filter((station) => station.inferred === 'againstRecord').map((station) => station.name), withNoDischarge: stations.filter((station) => !station.noMain && !station.discharge).map((station) => station.name) };
  stats.systems = { all: systems.length, ...tallyBy(systems, (system) => system.kind), withNoLineValve: systems.filter((system) => !system.lineValves).length, withNoDischarge: systems.filter((system) => !system.discharges.length).length };
  stats.valves = { all: valves.length, onAPipe: valves.filter((valve) => valve.piece >= 0).length, line: valves.filter((valve) => valve.line).length, drains: valves.filter((valve) => valve.drain).length, closedInLine: valves.filter((valve) => valve.closedInLine).length, pipeNotKnown: valves.filter((valve) => valve.pipeNotKnown).length, kitsByTheirConnection: valves.filter((valve) => valve.onConnection).length };
  stats.connections = connectionStats;

  // ---- 15. The result.
  const usedHoles = new Map(); // manhole of the input -> its place in the result
  const holeIndex = (h) => {
    if (!usedHoles.has(h)) usedHoles.set(h, usedHoles.size);
    return usedHoles.get(h);
  };
  const junctions = nodes.map((node, n) =>
    tidy({
      down: down[n],
      station: node.station,
      plant: node.plant,
      outlet: outletAt[n] >= 0 ? outletAt[n] : undefined,
      manholes: node.manholes.length ? node.manholes.map(holeIndex) : undefined,
      beside: node.beside,
    }),
  );
  const lineOfMain = new Map(lines.map((line, l) => [line.main, l]));
  const kept = mains.map((main, m) => (twinOf[m] === undefined ? m : twinOf[m]));
  stats.manholes = { atAJunction: usedHoles.size, usable: 0 };
  const manholes = [];
  for (const [h, index] of usedHoles) {
    const hole = holes[h];
    // Type is all there is to go by: only what the council calls a manhole can take a plug.
    const usable = hole.inUse !== false && /^Manhole/.test(String(hole.type));
    if (usable) stats.manholes.usable += 1;
    manholes[index] = tidy({ id: hole.id, type: hole.type, usable, at: hole.at.map(round6), street: hole.street, depth: hole.depth, depthFrom: hole.depthFrom, diameter: hole.diameter, notInUse: hole.inUse === false });
    manholes[index].usable = usable;
  }
  return {
    mains: mains.map((main, m) => {
      const line = lines[lineOfMain.get(m)];
      const kind = lines[lineOfMain.get(kept[m])].kind;
      return tidy({ id: main.id, zone: main.zone, street: main.street, type: main.type, kind, diameter: main.diameter, line: twinOf[m] === undefined ? main.line.map((p) => p.map(round6)) : undefined, owner: main.owner && main.owner !== 'council' ? main.owner : undefined, small: main.small && kind === 'p' ? (main.material ?? 'unknown') : undefined, link: line?.link, twin: twinOf[m] });
    }),
    pieces: pieces.map((piece) => [lines[piece.line].main, round1(piece.from), round1(piece.to), piece.a, piece.b, piece.dir, piece.system, piece.run, piece.mark]),
    junctions,
    links: links.map((link) => tidy(link)),
    manholes,
    valves: valves.map((valve) => tidy(valve)),
    stations: stations.map((station, s) => {
      // A station recorded twice goes by the record its junctions are at.
      const { records } = stationList[s];
      const nearest = (n) => records.reduce((best, record) => (awayFrom(nodes[n].xy, record.place) < awayFrom(nodes[n].xy, best.place) ? record : best));
      const count = records.map((record) => station.junctions.filter((n) => nearest(n) === record).length);
      const record = records[count.indexOf(Math.max(...count))];
      const others = records.filter((other) => other !== record).map((other) => other.id);
      return tidy({ id: record.id, name: record.name, at: record.at.map(round6), junctions: station.junctions, pumpsInto: station.pumpsInto, receives: station.receives, valves: stationValves[s], owner: record.owner && record.owner !== 'council' ? record.owner : undefined, discharge: station.discharge && tidy(station.discharge), inferred: station.inferred, noMain: station.noMain, also: others.length ? others : undefined });
    }),
    plants: plantList.map((plant) => ({ id: plant.id, name: plant.name, at: plant.at.map(round6) })),
    systems: systems.map((system) => tidy(system)),
    outlets: outlets.map((outlet) => tidy({ ...outlet, discharge: outlet.discharge && tidy(outlet.discharge) })),
    connections,
    splits,
    stats,
  };
}

// ---- The file ------------------------------------------------------------------------------------

// The long lists are written as rows of values, with the texts that repeat (streets, types) kept once:
// a third of the size of the same lists written as objects. `t`: a text, `b`: yes or no, `v`: as it is.
const ROWS = {
  mains: { id: 'v', zone: 't', street: 't', type: 't', kind: 't', diameter: 'v', line: 'v', owner: 't', small: 't', link: 'b', twin: 'v' },
  junctions: { down: 'v', manholes: 'v', station: 'v', plant: 'v', outlet: 'v', beside: 'v' },
  manholes: { id: 'v', type: 't', usable: 'b', at: 'v', street: 't', depth: 'v', depthFrom: 't', diameter: 'v', notInUse: 'b' },
  valves: { id: 'v', type: 't', at: 'v', piece: 'v', alongM: 'v', street: 't', depth: 'v', depthFrom: 't', role: 't', position: 't', diameter: 'v', note: 'v', line: 'b', drain: 'b', closedInLine: 'b', joint: 'b', onConnection: 'b', pipeNotKnown: 'b' },
};
/** Yes-or-no values that are always given (the others are only there when true). */
const ALWAYS = new Set(['usable']);

/** The network as it is written to data/wastewater-stop.json. */
export function packSewerNetwork(network) {
  const texts = [];
  const textIndex = new Map();
  const indexOf = (text) => {
    if (!textIndex.has(text)) {
      textIndex.set(text, texts.length);
      texts.push(text);
    }
    return textIndex.get(text);
  };
  const packed = { ...network };
  for (const [list, columns] of Object.entries(ROWS)) {
    packed[list] = network[list].map((item) => {
      const row = Object.entries(columns).map(([key, sort]) => (item[key] === undefined ? null : sort === 't' ? indexOf(item[key]) : sort === 'b' ? (item[key] ? 1 : 0) : item[key]));
      while (row.length && row.at(-1) === null) row.pop();
      return row;
    });
  }
  return { ...packed, texts };
}

/** The network as `buildSewerNetwork` gave it, from the file. */
export function unpackSewerNetwork(file) {
  const { texts, ...network } = file;
  for (const [list, columns] of Object.entries(ROWS)) {
    network[list] = file[list].map((row) => {
      const item = {};
      Object.entries(columns).forEach(([key, sort], i) => {
        const value = row[i];
        if (value === null || value === undefined) return;
        if (sort === 't') item[key] = texts[value];
        else if (sort !== 'b') item[key] = value;
        else if (value || ALWAYS.has(key)) item[key] = Boolean(value);
      });
      return item;
    });
  }
  return network;
}
