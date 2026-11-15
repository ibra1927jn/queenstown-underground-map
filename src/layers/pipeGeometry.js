/**
 * Geometry of the pipes in the network files: points along them, the depth at any
 * point, and where a line drawn on the map crosses them. Plain functions with no
 * map engine involved (they also run in Node for checks).
 *
 * A pipe's `depth` (written by scripts/data/convert-qldc-networks.mjs) holds one
 * figure per end – `at[0]` at the first point of its coordinates, `at[1]` at the
 * last – measured to the pipe's bottom ("invert", wastewater and stormwater) or to
 * its top ("cover", water supply). In between, the depth is taken to change
 * evenly along the pipe.
 */

export const METRES_PER_DEGREE = 111_320;

/** Pipes of unknown size are drawn as 100 mm pipes. */
const DEFAULT_DIAMETER_M = 0.1;

/** The lines of a LineString or MultiLineString. */
export const linesOf = (geometry) => (geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates);

/** A converter from [lon, lat] to metres [east, north] of an origin { lon, lat } (fine for a few km). */
export function toLocalMetres(origin) {
  const perDegreeLon = METRES_PER_DEGREE * Math.cos((origin.lat * Math.PI) / 180);
  return ([lon, lat]) => [(lon - origin.lon) * perDegreeLon, (lat - origin.lat) * METRES_PER_DEGREE];
}

export const diameterM = (properties) => (properties.diameter > 0 ? properties.diameter / 1000 : DEFAULT_DIAMETER_M);

/**
 * The depth of a pipe at a share of the way along it (0 = first point, 1 = last).
 * @returns {{ measured: number, centre: number }} metres below the ground surface:
 *   `measured` in the pipe's own terms (to the invert or the top), `centre` to the middle of the pipe
 */
export function depthAt(properties, share) {
  const [first, last] = properties.depth.at;
  const measured = first + (last - first) * share;
  const radius = diameterM(properties) / 2;
  const centre = properties.depth.measure === 'invert' ? Math.max(radius, measured - radius) : measured + radius;
  return { measured, centre };
}

/** How sure the depth of a pipe is: 'recorded' or 'nominal' only when both ends are; otherwise 'estimate'. */
export function depthTag(properties) {
  const [first, last] = properties.depth.from;
  if (first === 'rec' && last === 'rec') return 'recorded';
  if (first === 'nom' && last === 'nom') return 'nominal';
  return 'estimate';
}

/**
 * Points along every line of a pipe, with extra points on long straight stretches so a line
 * drawn through them can follow the ground; repeated points are dropped.
 * @returns {{ part: number, lonLat: number[], shares: number[] }[]}  per line: [lon, lat, lon, lat, …]
 *   and, for every point, the share of the whole pipe's length from its first point (for depths)
 */
export function pointsAlong(geometry, stepM) {
  const lines = linesOf(geometry);
  const metres = (a, b) =>
    Math.hypot((b[0] - a[0]) * METRES_PER_DEGREE * Math.cos((b[1] * Math.PI) / 180), (b[1] - a[1]) * METRES_PER_DEGREE);

  let total = 0;
  for (const line of lines) for (let i = 1; i < line.length; i += 1) total += metres(line[i - 1], line[i]);

  const result = [];
  let travelled = 0;
  lines.forEach((line, part) => {
    const lonLat = [];
    const shares = [];
    const add = (lon, lat, along) => {
      lonLat.push(lon, lat);
      shares.push(total > 0 ? Math.min(1, along / total) : 0);
    };
    let previous;
    for (const point of line) {
      if (previous) {
        if (previous[0] === point[0] && previous[1] === point[1]) continue;
        const length = metres(previous, point);
        const pieces = Math.ceil(length / stepM);
        for (let i = 1; i < pieces; i += 1) {
          add(previous[0] + ((point[0] - previous[0]) * i) / pieces, previous[1] + ((point[1] - previous[1]) * i) / pieces, travelled + (length * i) / pieces);
        }
        travelled += length;
      }
      add(point[0], point[1], travelled);
      previous = point;
    }
    if (lonLat.length >= 4) result.push({ part, lonLat, shares });
  });
  return result;
}

/**
 * A "cut" through the ground: a vertical plane through `centre`, facing `headingDegrees`
 * (the direction the viewer looks in). Positions near it are described in metres:
 *   x – across the screen, to the right of the centre
 *   y – forward: away from the viewer; the plane of the cut is y = 0
 */
export function cutFrame(centre, headingDegrees) {
  const heading = (headingDegrees * Math.PI) / 180;
  const project = toLocalMetres(centre);
  const forward = [Math.sin(heading), Math.cos(heading)];
  const right = [Math.cos(heading), -Math.sin(heading)];
  const perDegreeLon = METRES_PER_DEGREE * Math.cos((centre.lat * Math.PI) / 180);
  return {
    /** [lon, lat] -> [x, y] */
    toCut(lonLat) {
      const [east, north] = project(lonLat);
      return [east * right[0] + north * right[1], east * forward[0] + north * forward[1]];
    },
    /** [x, y] -> [lon, lat] */
    toLonLat([x, y]) {
      const east = x * right[0] + y * forward[0];
      const north = x * right[1] + y * forward[1];
      return [centre.lon + east / perDegreeLon, centre.lat + north / METRES_PER_DEGREE];
    },
  };
}

/** The part of a segment p–q inside a box, as shares of the segment (Liang–Barsky), or undefined. */
function clipToBox([px, py], [qx, qy], { left, right, front, back }) {
  let t0 = 0;
  let t1 = 1;
  const dx = qx - px;
  const dy = qy - py;
  for (const [p, q] of [
    [-dx, px - left],
    [dx, right - px],
    [-dy, py - front],
    [dy, back - py],
  ]) {
    if (p === 0) {
      if (q < 0) return undefined;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  return t0 < t1 ? [t0, t1] : undefined;
}

/**
 * The pieces of pipe inside a box around a cut (see cutFrame): `box` = { left, right, front, back }
 * in metres (front < 0: in front of the cut, towards the viewer; back > 0: behind it).
 * @returns {{ index: number, from: object, to: object }[]}  each end as { lon, lat, share } – share of
 *   the pipe's length from its first point, for depthAt
 */
export function piecesInCut(features, frame, box, include) {
  const pieces = [];
  features.forEach((feature, index) => {
    if (!include(feature)) return;
    const segments = [];
    let total = 0;
    for (const line of linesOf(feature.geometry)) {
      for (let i = 1; i < line.length; i += 1) {
        const p = frame.toCut(line[i - 1]);
        const q = frame.toCut(line[i]);
        const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
        segments.push({ p, q, from: total, length });
        total += length;
      }
    }
    for (const { p, q, from, length } of segments) {
      const inside = clipToBox(p, q, box);
      if (!inside) continue;
      const end = (t) => {
        const [lon, lat] = frame.toLonLat([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
        return { lon, lat, share: total > 0 ? (from + length * t) / total : 0 };
      };
      if ((inside[1] - inside[0]) * length < 0.05) continue; // a touch, not a piece
      pieces.push({ index, from: end(inside[0]), to: end(inside[1]) });
    }
  });
  return pieces;
}
