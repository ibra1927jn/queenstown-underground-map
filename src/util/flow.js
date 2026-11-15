/**
 * Which way the water runs in a pipe: where its arrows go and where they point.
 *
 * For the gravity networks (wastewater, stormwater) the council records the level of each end of a
 * pipe, and the conversion works out from them which end the water runs from (`flow.from`: 0 the
 * first point, 1 the last – scripts/data/lib/pipe-depth.mjs): from the higher level to the lower one;
 * without both levels, from the end the record calls upstream; a pumped main, from its pump end. A
 * pipe whose direction nothing in the data supports gets no arrow.
 *
 * Pure: plain numbers in and out (src/layers/networkLayer.js draws the arrows).
 */

const METRES_PER_DEGREE = 110540;

/**
 * @param {number[]} lonLat        the pipe as the page draws it: [lon, lat, lon, lat…]
 * @param {ArrayLike<number>} heights  the height of each of those points
 * @param {0 | 1 | undefined} upstream  which end the water runs from (0: the first point, 1: the last)
 * @param {number} everyM          one arrow per this length of pipe (at least one)
 * @param {number} [minM]          a pipe shorter than this carries no arrow
 * @returns {{ at: number[], towards: number[] }[]}  [lon, lat, height] of each arrow and of a point
 *   further along the flow, to aim it
 */
export function flowArrows(lonLat, heights, upstream, everyM, minM = 0) {
  if (upstream !== 0 && upstream !== 1) return [];
  const count = lonLat.length / 2;
  if (count < 2) return [];
  const point = (i) => [lonLat[2 * i], lonLat[2 * i + 1], heights[i]];
  const kx = METRES_PER_DEGREE * Math.cos((lonLat[1] * Math.PI) / 180);
  const along = [0];
  for (let i = 1; i < count; i += 1) along.push(along[i - 1] + Math.hypot((lonLat[2 * i] - lonLat[2 * i - 2]) * kx, (lonLat[2 * i + 1] - lonLat[2 * i - 1]) * METRES_PER_DEGREE));
  const length = along[count - 1];
  if (length <= 0 || length < minM) return [];

  /** The point at a distance along the pipe, and the piece of pipe it is on. */
  function at(distance) {
    let i = 1;
    while (i < count - 1 && along[i] < distance) i += 1;
    const span = along[i] - along[i - 1] || 1;
    const t = Math.min(1, Math.max(0, (distance - along[i - 1]) / span));
    const [a, b] = [point(i - 1), point(i)];
    return { place: a.map((value, k) => value + t * (b[k] - value)), from: a, to: b };
  }

  const arrows = [];
  const number = Math.max(1, Math.round(length / everyM));
  for (let n = 0; n < number; n += 1) {
    const { place, from, to } = at(((n + 0.5) * length) / number);
    arrows.push({ at: place, towards: upstream === 0 ? to : from });
  }
  return arrows;
}
