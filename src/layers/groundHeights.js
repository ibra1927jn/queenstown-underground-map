/**
 * The height of the ground under the things on the map – pipes, point assets, buildings.
 *
 * The page needs it to draw them where the ground is. Looking it up while the page loads means
 * downloading two or three megabytes of elevation tiles per zone, so the data files carry it
 * instead: scripts/data/bake-ground.mjs works it out once and stores it with every feature
 * (`properties.ground`). This file is what the script and the page share, so both mean the same
 * positions and the same numbers. A feature without a stored height (a data file made again and
 * not baked yet) is simply looked up from the terrain, as before.
 *
 * Stored heights are whole decimetres above sea level: one number for a point; for a pipe the
 * first height followed by the step to each next position (small numbers pack well); for a
 * building the three figures it is drawn from – the lowest ground under its outline, then how
 * much higher the average and the highest are.
 *
 * Works in Node and in the browser.
 */
import { pointsAlong } from './pipeGeometry.js';

/**
 * The positions a feature needs the ground at, as [lon, lat, lon, lat…]:
 *   a pipe – points along it, at least every `everyM` (the same ones the page draws it through);
 *   a point asset – itself; a building – the corners of its outline.
 * @returns {number[] | undefined}  undefined for a shape that needs none
 */
export function groundPositions(geometry, everyM) {
  if (geometry.type === 'Point') return geometry.coordinates.slice(0, 2);
  if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') return pointsAlong(geometry, everyM).flatMap((path) => path.lonLat);
  if (geometry.type === 'Polygon') return geometry.coordinates[0].flatMap((position) => [position[0], position[1]]);
  return undefined;
}

/** Heights in metres -> what is stored with the feature. */
export function encodeHeights(heights) {
  const tenths = Array.from(heights, (height) => Math.round(height * 10));
  if (tenths.length === 1) return tenths[0];
  return tenths.map((value, i) => (i === 0 ? value : value - tenths[i - 1]));
}

/** Writes the stored heights of one feature into `heights` from `offset`; false when they do not fit `count` positions. */
function decodeInto(stored, heights, offset, count) {
  if (count === 0) return true;
  if (typeof stored === 'number') {
    if (count !== 1) return false;
    heights[offset] = stored / 10;
    return true;
  }
  if (!Array.isArray(stored) || stored.length !== count) return false;
  let tenths = 0;
  for (let i = 0; i < count; i += 1) {
    tenths += stored[i];
    heights[offset + i] = tenths / 10;
  }
  return true;
}

/** The ground under an outline, in metres -> what is stored with a building: [lowest, average − lowest, highest − lowest]. */
export function encodeGroundRange(heights) {
  const tenths = Array.from(heights, (height) => Math.round(height * 10));
  const lowest = Math.min(...tenths);
  const average = Math.round(tenths.reduce((sum, value) => sum + value, 0) / tenths.length);
  return [lowest, average - lowest, Math.max(...tenths) - lowest];
}

/**
 * The stored heights of the pipes in a file only hold for the spacing they were worked out for:
 * with another spacing they are dropped (and looked up from the terrain instead).
 */
export function dropStaleHeights(collection, everyM) {
  if (!collection?.features || collection.groundHeights?.everyM === everyM) return;
  for (const { geometry, properties } of collection.features) if (geometry?.type !== 'Point' && geometry?.type !== 'Polygon') delete properties.ground;
}

/**
 * The ground under each outline of a list (buildings): the lowest, the average and the highest
 * height – stored with it, or else worked out from a look-up at its corners.
 * @param {{ stored: number[] | undefined, lonLat: number[] }[]} things
 * @param {(lonLat: number[]) => Promise<Float64Array>} sampleGround
 * @returns {Promise<({ lowest: number, mean: number, highest: number } | undefined)[]>}  undefined where unknown
 */
export async function groundRanges(things, sampleGround) {
  const ranges = things.map(({ stored }) =>
    Array.isArray(stored) && stored.length === 3 ? { lowest: stored[0] / 10, mean: (stored[0] + stored[1]) / 10, highest: (stored[0] + stored[2]) / 10 } : undefined,
  );
  const missing = things.flatMap((thing, i) => (ranges[i] ? [] : thing.lonLat));
  if (missing.length > 0) {
    const looked = await sampleGround(missing);
    let next = 0;
    things.forEach((thing, i) => {
      if (ranges[i]) return;
      const heights = looked.subarray(next, (next += thing.lonLat.length / 2));
      // A corner whose height could not be found: the whole outline counts as unknown.
      if (heights.length === 0 || !heights.every(Number.isFinite)) return;
      ranges[i] = { lowest: Math.min(...heights), mean: heights.reduce((sum, h) => sum + h, 0) / heights.length, highest: Math.max(...heights) };
    });
  }
  return ranges;
}

/**
 * Ground heights for a list of things: those stored with them, and a look-up from the terrain
 * only for the ones that have none.
 * @param {{ stored: number | number[] | undefined, lonLat: number[] }[]} things  per thing, what its
 *   file stored and the positions wanted ([lon, lat, …])
 * @param {(lonLat: number[]) => Promise<Float64Array>} sampleGround
 * @returns {Promise<Float64Array>}  the height at every position, thing after thing (NaN where unknown)
 */
export async function groundHeights(things, sampleGround) {
  const total = things.reduce((sum, thing) => sum + thing.lonLat.length / 2, 0);
  const heights = new Float64Array(total);
  const missing = []; // positions with no stored height…
  const gaps = []; // …and where their heights go: [offset, count]
  let offset = 0;
  for (const { stored, lonLat } of things) {
    const count = lonLat.length / 2;
    if (!decodeInto(stored, heights, offset, count)) {
      gaps.push([offset, count]);
      for (const value of lonLat) missing.push(value);
    }
    offset += count;
  }
  if (missing.length > 0) {
    const looked = await sampleGround(missing);
    let next = 0;
    for (const [at, count] of gaps) for (let i = 0; i < count; i += 1) heights[at + i] = looked[next++];
  }
  return heights;
}
