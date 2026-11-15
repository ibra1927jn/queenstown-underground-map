/**
 * The geometry behind the long section (src/tools/profileView.js): the "run" a picked pipe is part
 * of, points along it with their depths, and what meets or crosses it. Plain functions with no
 * map engine involved (they also run in Node for checks).
 *
 * A run: the picked main and the mains that carry on from each of its ends – at every joint the
 * pipe that goes on straightest – until the run is long enough or nothing carries on.
 */
import { depthAt, diameterM, linesOf, METRES_PER_DEGREE, pointsAlong } from '../layers/pipeGeometry.js';

/** Pipe ends are recorded to the same decimals where pipes meet (checked on the council's data). */
const keyOf = ([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`;

const metresBetween = (a, b) => Math.hypot((b[0] - a[0]) * METRES_PER_DEGREE * Math.cos((a[1] * Math.PI) / 180), (b[1] - a[1]) * METRES_PER_DEGREE);

/** Every point of a pipe, in order (the lines of a multi-part pipe one after the other). */
const pointsOf = (feature) => linesOf(feature.geometry).flat();

/** Length of a pipe as drawn, in metres. */
export function lengthM(feature) {
  let total = 0;
  for (const line of linesOf(feature.geometry)) for (let i = 1; i < line.length; i += 1) total += metresBetween(line[i - 1], line[i]);
  return total;
}

/** The direction (unit vector, east and north) in which a pipe leaves one of its ends (0: first point, 1: last). */
function leaving(feature, end) {
  const points = pointsOf(feature);
  const from = end === 0 ? points[0] : points.at(-1);
  // The first point that is not on top of the end.
  const order = end === 0 ? points : [...points].reverse();
  const to = order.find((point) => metresBetween(from, point) > 0.05) ?? from;
  const east = (to[0] - from[0]) * METRES_PER_DEGREE * Math.cos((from[1] * Math.PI) / 180);
  const north = (to[1] - from[1]) * METRES_PER_DEGREE;
  const length = Math.hypot(east, north) || 1;
  return [east / length, north / length];
}

/**
 * The run a pipe is part of.
 * @param {{ feature: object }[]} pipes   the pipes a run may use (the same network, mains, shown); other fields are kept
 * @param {{ feature: object }} start     the picked pipe (one of `pipes`, or not)
 * @param {{ maxRunM: number, maxPipes: number, maxTurnDegrees: number }} settings
 * @returns {object[]} the entries of the run in order, each with `reversed` (walked from its last point to its first)
 */
export function buildRun(pipes, start, settings) {
  const atEnd = new Map(); // key of an end -> [{ entry, end }]
  for (const entry of pipes) {
    if (entry.feature === start.feature) continue;
    const points = pointsOf(entry.feature);
    for (const [end, point] of [[0, points[0]], [1, points.at(-1)]]) {
      const key = keyOf(point);
      if (!atEnd.has(key)) atEnd.set(key, []);
      atEnd.get(key).push({ entry, end });
    }
  }

  const run = [{ ...start, reversed: false }];
  const used = new Set([start.feature]);
  let total = lengthM(start.feature);
  const minCos = Math.cos((settings.maxTurnDegrees * Math.PI) / 180);

  /** Adds the pipe that carries on straightest past one end of the run; false when none does. */
  function extend(forward) {
    const last = forward ? run.at(-1) : run[0];
    // The end the run leaves this pipe by, and the direction it was going there.
    const end = forward === last.reversed ? 0 : 1;
    const points = pointsOf(last.feature);
    const [east, north] = leaving(last.feature, end).map((value) => -value);
    let best;
    for (const candidate of atEnd.get(keyOf(end === 0 ? points[0] : points.at(-1))) ?? []) {
      if (used.has(candidate.entry.feature)) continue;
      const [e, n] = leaving(candidate.entry.feature, candidate.end);
      const cos = east * e + north * n;
      if (cos >= minCos && (!best || cos > best.cos)) best = { ...candidate, cos };
    }
    if (!best) return false;
    used.add(best.entry.feature);
    total += lengthM(best.entry.feature);
    // Walked from the end where it joins: going forward that is its start unless it joins by its last point.
    const item = { ...best.entry, reversed: forward ? best.end === 1 : best.end === 0 };
    if (forward) run.push(item);
    else run.unshift(item);
    return true;
  }

  // A fair share each way, then whatever is left the other way.
  const roomEachWay = total + (settings.maxRunM - total) / 2;
  const within = (limit) => total < limit && run.length < settings.maxPipes;
  while (within(roomEachWay) && extend(true));
  while (within(settings.maxRunM) && extend(false));
  while (within(settings.maxRunM) && extend(true));
  return run;
}

/**
 * Points along a run, about every `stepM`, with the pipe's depth at each.
 * @returns {{ stations: object[], pieces: object[], length: number }}
 *   stations: { lon, lat, chain, piece, top, bottom, measured } – chain: metres from the start of the run;
 *     top / bottom: of the pipe, metres below the ground; measured: the depth as the data gives it
 *   pieces: per pipe of the run { from, to } (chains) and the entry itself
 */
export function runStations(run, stepM) {
  const stations = [];
  const pieces = [];
  let chain = 0;
  run.forEach((entry, piece) => {
    const p = entry.feature.properties;
    const length = lengthM(entry.feature);
    const radius = diameterM(p) / 2;
    const points = [];
    for (const { lonLat, shares } of pointsAlong(entry.feature.geometry, stepM)) {
      shares.forEach((share, i) => points.push({ lon: lonLat[2 * i], lat: lonLat[2 * i + 1], share }));
    }
    if (entry.reversed) points.reverse();
    for (const { lon, lat, share } of points) {
      // A pipe recorded as laid above ground sits on the surface.
      const depth = p.aboveGround ? { measured: 0, centre: -radius } : depthAt(p, share);
      stations.push({
        lon,
        lat,
        chain: chain + (entry.reversed ? 1 - share : share) * length,
        piece,
        top: depth.centre - radius,
        bottom: depth.centre + radius,
        measured: depth.measured,
      });
    }
    pieces.push({ ...entry, from: chain, to: chain + length });
    chain += length;
  });
  return { stations, pieces, length: chain };
}

/** The stations as a line in metres (east, north of the first station), for the two functions below. */
function localLine(stations) {
  const origin = stations[0];
  const perDegreeLon = METRES_PER_DEGREE * Math.cos((origin.lat * Math.PI) / 180);
  const toLocal = ([lon, lat]) => [(lon - origin.lon) * perDegreeLon, (lat - origin.lat) * METRES_PER_DEGREE];
  const points = stations.map((station) => toLocal([station.lon, station.lat]));
  const box = points.reduce(
    (b, [x, y]) => ({ left: Math.min(b.left, x), right: Math.max(b.right, x), bottom: Math.min(b.bottom, y), top: Math.max(b.top, y) }),
    { left: Infinity, right: -Infinity, bottom: Infinity, top: -Infinity },
  );
  return { toLocal, points, box };
}

/**
 * Where other pipes meet or cross a run.
 * @param {object[]} stations  from runStations
 * @param {{ feature: object }[]} others  pipes that are not part of the run (other fields are kept)
 * @returns {object[]} per meeting { chain, share, atEnd, ...entry } – share: how far along the other pipe (0 to 1);
 *   atEnd: the other pipe ends there (it joins the run rather than crossing it)
 */
export function crossingsOf(stations, others, nearM = 0.3) {
  const { toLocal, points, box } = localLine(stations);
  const found = [];
  for (const entry of others) {
    const line = pointsOf(entry.feature).map(toLocal);
    if (line.every(([x]) => x < box.left - 1) || line.every(([x]) => x > box.right + 1)) continue;
    if (line.every(([, y]) => y < box.bottom - 1) || line.every(([, y]) => y > box.top + 1)) continue;
    let total = 0;
    for (let i = 1; i < line.length; i += 1) total += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
    if (total === 0) continue;

    let before = 0;
    const meetings = [];
    for (let i = 1; i < line.length; i += 1) {
      const [ax, ay] = line[i - 1];
      const [bx, by] = line[i];
      const length = Math.hypot(bx - ax, by - ay);
      for (let k = 1; k < points.length && length > 0; k += 1) {
        const [px, py] = points[k - 1];
        const [qx, qy] = points[k];
        const cross = (qx - px) * (by - ay) - (qy - py) * (bx - ax);
        if (Math.abs(cross) < 1e-9) continue; // parallel
        const t = ((ax - px) * (by - ay) - (ay - py) * (bx - ax)) / cross; // along the run's segment
        const u = ((ax - px) * (qy - py) - (ay - py) * (qx - px)) / cross; // along the other pipe's segment
        const runLength = Math.hypot(qx - px, qy - py);
        // A pipe that ends on the run may stop a hair short of it.
        if (t < -nearM / runLength || t > 1 + nearM / runLength || u < -nearM / length || u > 1 + nearM / length) continue;
        const share = Math.min(1, Math.max(0, (before + Math.min(1, Math.max(0, u)) * length) / total));
        const chain = stations[k - 1].chain + Math.min(1, Math.max(0, t)) * (stations[k].chain - stations[k - 1].chain);
        meetings.push({ chain, share, atEnd: share * total < nearM + 0.2 || (1 - share) * total < nearM + 0.2 });
      }
      before += length;
    }
    // The same meeting found on two neighbouring segments counts once.
    meetings.sort((a, b) => a.chain - b.chain);
    meetings.forEach((meeting, i) => {
      if (i === 0 || meeting.chain - meetings[i - 1].chain > 1) found.push({ ...entry, ...meeting });
    });
  }
  return found.sort((a, b) => a.chain - b.chain);
}

/**
 * The point assets (manholes, valves…) that sit on a run.
 * @returns {object[]} per asset { chain, ...entry }
 */
export function assetsOn(stations, assets, withinM) {
  const { toLocal, points, box } = localLine(stations);
  const found = [];
  for (const entry of assets) {
    const [x, y] = toLocal(entry.feature.geometry.coordinates);
    if (x < box.left - withinM || x > box.right + withinM || y < box.bottom - withinM || y > box.top + withinM) continue;
    let best;
    for (let k = 1; k < points.length; k += 1) {
      const [px, py] = points[k - 1];
      const [qx, qy] = points[k];
      const lengthSquared = (qx - px) ** 2 + (qy - py) ** 2;
      const t = lengthSquared > 0 ? Math.min(1, Math.max(0, ((x - px) * (qx - px) + (y - py) * (qy - py)) / lengthSquared)) : 0;
      const distance = Math.hypot(x - (px + (qx - px) * t), y - (py + (qy - py) * t));
      if (distance <= withinM && (!best || distance < best.distance)) best = { distance, chain: stations[k - 1].chain + t * (stations[k].chain - stations[k - 1].chain) };
    }
    if (best) found.push({ ...entry, chain: best.chain });
  }
  return found.sort((a, b) => a.chain - b.chain);
}
