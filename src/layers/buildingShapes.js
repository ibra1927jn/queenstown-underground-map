/**
 * The 3D shape of one building: walls up to the eaves and a flat, gable or hip roof up to the
 * ridge, built from its outline and the heights the council measured (see buildingsLayer.js).
 *
 * How the roof is made: the smallest rectangle around the outline gives the ridge (along its long
 * side). A gable roof has two planes sloping down from the ridge to the long sides; a hip roof
 * four (two down to the long sides, two down to the short ends). Each plane is cut to the real
 * outline, so L-shaped and irregular buildings get a roof that covers exactly their footprint.
 * The walls follow the roof: up to the eaves along the eaves, up to the ridge at a gable end.
 *
 * Everything is worked out in metres around the building's middle (x east, y north, z height),
 * then placed on the globe.
 */
import { Cesium } from '../map/cesium.js';

const METRES_PER_DEGREE_LAT = 110574;
const FAR = 1e4; // "infinitely" far, for the half-planes that cut the roof

const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

function signedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** Convex hull (Andrew's monotone chain), counter-clockwise. */
function convexHull(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of sorted.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The smallest rectangle around the points: its middle, the direction of its long side, half length and half width. */
function smallestRectangle(points) {
  const hull = convexHull(points);
  let best;
  for (let i = 0; i < hull.length; i += 1) {
    const [x1, y1] = hull[i];
    const [x2, y2] = hull[(i + 1) % hull.length];
    const length = Math.hypot(x2 - x1, y2 - y1);
    if (length < 1e-9) continue;
    const u = [(x2 - x1) / length, (y2 - y1) / length];
    const v = [-u[1], u[0]];
    let [minU, maxU, minV, maxV] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const p of hull) {
      minU = Math.min(minU, dot(p, u));
      maxU = Math.max(maxU, dot(p, u));
      minV = Math.min(minV, dot(p, v));
      maxV = Math.max(maxV, dot(p, v));
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) best = { area, u, v, minU, maxU, minV, maxV };
  }
  if (!best) return undefined;
  const { u, v, minU, maxU, minV, maxV } = best;
  const centreU = (minU + maxU) / 2;
  const centreV = (minV + maxV) / 2;
  const centre = [u[0] * centreU + v[0] * centreV, u[1] * centreU + v[1] * centreV];
  const alongU = maxU - minU >= maxV - minV;
  return {
    centre,
    along: alongU ? u : v, // the ridge runs this way
    across: alongU ? v : [-u[0], -u[1]],
    halfLength: (alongU ? maxU - minU : maxV - minV) / 2,
    halfWidth: (alongU ? maxV - minV : maxU - minU) / 2,
  };
}

/** Clips a polygon (any shape) to a convex polygon (Sutherland–Hodgman). */
function clipToConvex(subject, clip) {
  let output = subject;
  for (let i = 0; i < clip.length && output.length; i += 1) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const inside = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
    const crossing = (p, q) => {
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const t = (ex * (p[1] - a[1]) - ey * (p[0] - a[0])) / (ey * dx - ex * dy);
      return [p[0] + t * dx, p[1] + t * dy];
    };
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j += 1) {
      const p = input[j];
      const q = input[(j + 1) % input.length];
      if (inside(q)) {
        if (!inside(p)) output.push(crossing(p, q));
        output.push(q);
      } else if (inside(p)) {
        output.push(crossing(p, q));
      }
    }
  }
  return output;
}

/**
 * The roof of a building as planes: [{ region (convex polygon in metres, or undefined for all),
 * z(x, y) }], plus `top(x, y)` (the roof height anywhere) and the lines where the planes meet
 * (as [a, b, c] for a·x + b·y + c = 0), where the walls need a corner.
 */
function roofPlanes(roof, outer, eave, ridge) {
  if (roof === 'flat' || ridge - eave < 0.2) return { planes: [{ z: () => ridge }], top: () => ridge, lines: [] };
  const box = smallestRectangle(outer);
  if (!box || box.halfWidth < 0.5) return { planes: [{ z: () => ridge }], top: () => ridge, lines: [] };
  const { centre, along, across, halfLength: hl, halfWidth: hw } = box;
  const slope = (ridge - eave) / hw;
  const s = ([x, y]) => (x - centre[0]) * along[0] + (y - centre[1]) * along[1];
  const d = ([x, y]) => (x - centre[0]) * across[0] + (y - centre[1]) * across[1];
  const toXY = ([si, di]) => [centre[0] + si * along[0] + di * across[0], centre[1] + si * along[1] + di * across[1]];
  // A line s·α + d·β + γ = 0 written in x, y.
  const line = (alpha, beta, gamma) => {
    const a = alpha * along[0] + beta * across[0];
    const b = alpha * along[1] + beta * across[1];
    return [a, b, gamma - a * centre[0] - b * centre[1]];
  };

  if (roof === 'gable') {
    return {
      planes: [
        { region: [[-FAR, 0], [FAR, 0], [FAR, FAR], [-FAR, FAR]].map(toXY), z: (p) => eave + slope * (hw - d(p)) },
        { region: [[FAR, 0], [-FAR, 0], [-FAR, -FAR], [FAR, -FAR]].map(toXY), z: (p) => eave + slope * (hw + d(p)) },
      ],
      top: (p) => eave + slope * Math.max(0, hw - Math.abs(d(p))),
      lines: [line(0, 1, 0)],
    };
  }
  // Hip: the ridge is shorter than the building by the width at each end.
  const r = Math.max(0, hl - hw);
  return {
    planes: [
      { region: [[-r, 0], [r, 0], [r + FAR, FAR], [-r - FAR, FAR]].map(toXY), z: (p) => eave + slope * (hw - d(p)) },
      { region: [[r, 0], [-r, 0], [-r - FAR, -FAR], [r + FAR, -FAR]].map(toXY), z: (p) => eave + slope * (hw + d(p)) },
      { region: [[r, 0], [r + FAR, -FAR], [r + FAR, FAR]].map(toXY), z: (p) => eave + slope * (hl - s(p)) },
      { region: [[-r, 0], [-r - FAR, FAR], [-r - FAR, -FAR]].map(toXY), z: (p) => eave + slope * (hl + s(p)) },
    ],
    top: (p) => eave + slope * Math.max(0, Math.min(hw - Math.abs(d(p)), hl - Math.abs(s(p)))),
    lines: [line(0, 1, 0), line(-1, 1, r), line(1, 1, r), line(1, 1, -r), line(-1, 1, -r)],
  };
}

/** A ring with a corner added wherever an edge crosses one of the lines. */
function withCorners(ring, lines) {
  if (!lines.length) return ring;
  const out = [];
  for (let i = 0; i < ring.length; i += 1) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    out.push(p);
    const cuts = [];
    for (const [a, b, c] of lines) {
      const fp = a * p[0] + b * p[1] + c;
      const fq = a * q[0] + b * q[1] + c;
      if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) cuts.push(fp / (fp - fq));
    }
    cuts.sort((x, y) => x - y);
    for (const t of cuts) if (t > 1e-6 && t < 1 - 1e-6) out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
  }
  return out;
}

function triangulate(ring, holes = []) {
  const points = [...ring, ...holes.flat()].map(([x, y]) => new Cesium.Cartesian2(x, y));
  const holeStarts = [];
  let start = ring.length;
  for (const hole of holes) {
    holeStarts.push(start);
    start += hole.length;
  }
  return { points, indices: Cesium.PolygonPipeline.triangulate(points, holeStarts) };
}

/**
 * The walls and the roof of one building, as two Cesium geometries.
 * @param {number[][][]} rings  GeoJSON polygon rings (lon, lat; the first is the outline)
 * @param {{ base: number, eave: number, ridge: number, roof: 'flat'|'gable'|'hip' }} heights  absolute heights (m)
 * @returns {{ walls: Cesium.Geometry, roof: Cesium.Geometry } | undefined}
 */
export function buildingGeometry(rings, { base, eave, ridge, roof }) {
  const outerLonLat = rings[0].slice(0, -1);
  if (outerLonLat.length < 3) return undefined;
  const lon0 = outerLonLat.reduce((sum, p) => sum + p[0], 0) / outerLonLat.length;
  const lat0 = outerLonLat.reduce((sum, p) => sum + p[1], 0) / outerLonLat.length;
  const kx = METRES_PER_DEGREE_LAT * 1.0068 * Math.cos((lat0 * Math.PI) / 180);
  const local = (ring) => ring.slice(0, -1).map(([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * METRES_PER_DEGREE_LAT]);

  let outer = local(rings[0]);
  if (signedArea(outer) < 0) outer = outer.reverse(); // counter-clockwise
  const holes = rings.slice(1).map(local).map((hole) => (signedArea(hole) > 0 ? hole.reverse() : hole)); // clockwise
  const pitched = roof !== 'flat' && holes.length === 0;
  const { planes, top, lines } = roofPlanes(pitched ? roof : 'flat', outer, eave, ridge);

  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(lon0, lat0, 0));
  const scratch = new Cesium.Cartesian3();
  const wallPositions = [];
  const wallNormals = [];
  const roofPositions = [];
  const roofNormals = [];
  const put = (positions, normals, points, normal) => {
    const n = Cesium.Matrix4.multiplyByPointAsVector(enu, new Cesium.Cartesian3(...normal), scratch);
    Cesium.Cartesian3.normalize(n, n);
    for (const [x, y, z] of points) {
      const p = Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(x, y, z), new Cesium.Cartesian3());
      positions.push(p.x, p.y, p.z);
      normals.push(n.x, n.y, n.z);
    }
  };

  // Walls: every edge from the foundations up to the roof above it.
  for (const ring of [outer, ...holes]) {
    const cornered = withCorners(ring, lines);
    for (let i = 0; i < cornered.length; i += 1) {
      const a = cornered[i];
      const b = cornered[(i + 1) % cornered.length];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (length < 1e-3) continue;
      const ta = top(a);
      const tb = top(b);
      const normal = [dy / length, -dx / length, 0];
      put(wallPositions, wallNormals, [[a[0], a[1], base], [b[0], b[1], base], [b[0], b[1], tb]], normal);
      put(wallPositions, wallNormals, [[a[0], a[1], base], [b[0], b[1], tb], [a[0], a[1], ta]], normal);
    }
  }

  // Roof: each plane cut to the outline, in triangles facing up.
  for (const plane of planes) {
    const piece = plane.region ? clipToConvex(outer, plane.region) : outer;
    if (piece.length < 3) continue;
    const { points, indices } = plane.region ? triangulate(piece) : triangulate(piece, holes);
    for (let i = 0; i < indices.length; i += 3) {
      const corners = [indices[i], indices[i + 1], indices[i + 2]].map((k) => [points[k].x, points[k].y, plane.z([points[k].x, points[k].y])]);
      const [p, q, r] = corners;
      const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
      let normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const size = Math.hypot(...normal);
      if (size < 1e-9) continue;
      if (normal[2] < 0) {
        corners.reverse();
        normal = normal.map((value) => -value);
      }
      put(roofPositions, roofNormals, corners, normal.map((value) => value / size));
    }
  }

  const geometry = (positions, normals) => {
    if (!positions.length) return undefined;
    const values = new Float64Array(positions);
    return new Cesium.Geometry({
      attributes: {
        position: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values }),
        normal: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: new Float32Array(normals) }),
      },
      indices: Cesium.IndexDatatype.createTypedArray(values.length / 3, Array.from({ length: values.length / 3 }, (_, i) => i)),
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      boundingSphere: Cesium.BoundingSphere.fromVertices(values),
    });
  };
  return { walls: geometry(wallPositions, wallNormals), roof: geometry(roofPositions, roofNormals) };
}
