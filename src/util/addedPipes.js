/**
 * Pipes and cables added by hand: things the person using the map knows are in the ground and the
 * council's records do not have yet.
 *
 * A pipe added is recorded in the same shape as the pipes of the data files (a GeoJSON line with a
 * `depth`, see src/layers/pipeGeometry.js), marked `source: 'mine'`, so every view draws it like any
 * other. They are kept on the device only, in a storage handed to `createAddedStore` (the browser's
 * own), and can be written to and read from a copy file – which is plain GeoJSON.
 *
 * Whatever is read back, from the storage or from a file, is checked and made again here: nothing
 * of it is trusted or copied as it comes.
 *
 * Pure: plain data in and out (src/tools/addedPipesTool.js is the drawing and the panel).
 */

const METRES_PER_DEGREE = 111_320;

/**
 * What can be added: the network that draws it, what it is called, and the usual cover (ground to
 * its top, metres) used when no depth is given.
 */
export const ADDED_KINDS = [
  { network: 'water', label: 'Water supply', title: 'Water main', kind: 'main', coverM: 0.9 },
  { network: 'wastewater', label: 'Wastewater', title: 'Wastewater pipe', kind: 'main', coverM: 1.5 },
  { network: 'stormwater', label: 'Stormwater', title: 'Stormwater pipe', kind: 'main', coverM: 1.2 },
  { network: 'power', label: 'Electricity', title: 'Electricity cable', kind: 'cable', coverM: 0.9 },
  { network: 'other', label: 'Other', title: 'Pipe or cable', kind: 'main', coverM: 0.8 },
];

const LIMITS = {
  sizeMm: [10, 3000],
  depthM: [0, 30],
  materialLetters: 60,
  noteLetters: 300,
  stepM: 0.2, // a point closer than this to the one before is the same point
  points: 2000,
  pipes: 5000,
};

const metresBetween = (a, b) => Math.hypot((b[0] - a[0]) * METRES_PER_DEGREE * Math.cos((b[1] * Math.PI) / 180), (b[1] - a[1]) * METRES_PER_DEGREE);

/** The length of a line of [lon, lat] points, in metres. */
export function lengthM(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += metresBetween(points[i - 1], points[i]);
  return total;
}

/** [lon, lat] points to the centimetre, without the ones that repeat the point before; [] if any is not a place. */
function tidyPoints(points) {
  if (!Array.isArray(points) || points.length > LIMITS.points) return [];
  const tidy = [];
  for (const point of points) {
    if (!Array.isArray(point)) return [];
    const [lon, lat] = point;
    if (typeof lon !== 'number' || typeof lat !== 'number' || !(Math.abs(lon) <= 180) || !(Math.abs(lat) <= 90)) return [];
    const next = [Math.round(lon * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7];
    if (tidy.length === 0 || metresBetween(tidy.at(-1), next) >= LIMITS.stepM) tidy.push(next);
  }
  return tidy;
}

/** A figure as typed ("250", " 1,2 ") if it lies in a range, else undefined. */
function figure(value, [low, high]) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const number = typeof value === 'number' ? value : Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(number) && number >= low && number <= high ? number : undefined;
}

const words = (value, letters) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, letters) : undefined);
const day = (value) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);
const safeId = (value) => (typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : undefined);
const copy = (value) => JSON.parse(JSON.stringify(value));

/**
 * A pipe or cable as the map draws it.
 * @param {object} details
 * @param {string} details.id        letters, figures, - and _ only
 * @param {string} details.network   one of ADDED_KINDS
 * @param {string} [details.zone]    the zone of the map it is drawn with
 * @param {number[][]} details.points  [lon, lat] along it, at least two different ones
 * @param {number|string} [details.size]   mm
 * @param {number|string} [details.depth]  ground to its top, m; none: the usual cover of its kind, marked as not given
 * @param {string} [details.material]
 * @param {string} [details.note]
 * @param {string} [details.added]   the day it was added, YYYY-MM-DD
 * @param {string} [details.edited]  the day it was last changed
 * @throws {Error} with words for the person, when it cannot be a pipe
 */
export function makePipe({ id, network, zone, points, size, depth, material, note, added, edited }) {
  if (!safeId(id)) throw new Error('A pipe needs an id of letters and figures.');
  const kind = ADDED_KINDS.find((candidate) => candidate.network === network);
  if (!kind) throw new Error('Say what it is first.');
  const coordinates = tidyPoints(points);
  if (coordinates.length < 2) throw new Error('A pipe needs at least two points.');

  const given = figure(depth, LIMITS.depthM);
  const cover = given === undefined ? kind.coverM : Math.round(given * 100) / 100;
  const from = given === undefined ? 'none' : 'mine';
  const diameter = figure(size, LIMITS.sizeMm);
  const properties = { id, source: 'mine', network, kind: kind.kind, type: kind.title, inUse: true, length: Math.max(1, Math.round(lengthM(coordinates))) };
  const optional = {
    zone: typeof zone === 'string' ? zone : undefined,
    diameter: diameter === undefined ? undefined : Math.round(diameter),
    material: words(material, LIMITS.materialLetters),
    note: words(note, LIMITS.noteLetters),
    added: day(added),
    edited: day(edited),
  };
  for (const [name, value] of Object.entries(optional)) if (value !== undefined) properties[name] = value;
  properties.depth = { measure: 'cover', at: [cover, cover], from: [from, from] };
  return { type: 'Feature', geometry: { type: 'LineString', coordinates }, properties };
}

/** What the form shows of a pipe: its kind, size, depth (only one given by hand), material and note. */
export function detailsOf(pipe) {
  const p = pipe.properties;
  return { network: p.network, size: p.diameter, depth: p.depth.from[0] === 'mine' ? p.depth.at[0] : undefined, material: p.material ?? '', note: p.note ?? '' };
}

/** The same line with other details; `edited` is the day of the change. The pipe handed in is left as it was. */
export function withDetails(pipe, { network, size, depth, material, note }, edited) {
  const p = pipe.properties;
  return makePipe({ id: p.id, zone: p.zone, points: pipe.geometry.coordinates, added: p.added, edited, network, size, depth, material, note });
}

/** The copy file: GeoJSON, with a few words on what it is. */
export function toFile(pipes, saved) {
  return {
    type: 'FeatureCollection',
    name: 'Pipes and cables added by hand – Underground Networks demo',
    note: "Drawn by hand on the demo map by the person using it. Not from the council's records, not surveyed: positions and depths are approximate.",
    version: 1,
    saved,
    features: pipes,
  };
}

/**
 * The pipes of a copy file, or of what the storage holds.
 * @param {unknown} data
 * @param {{ zoneOf: (points: number[][]) => string | undefined, newId: () => string }} options
 *   zoneOf: the zone of the map a line belongs to (what the file says is not used);
 *   newId: an id for a line whose own cannot be used
 * @returns {{ pipes: object[], skipped: number }}  skipped: entries that are not a line of a known kind
 * @throws {Error} when it is not such a file at all
 */
export function fromFile(data, { zoneOf, newId }) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.features)) throw new Error('This is not a copy of added pipes.');
  const byId = new Map();
  let skipped = 0;
  for (const feature of data.features.slice(0, LIMITS.pipes)) {
    try {
      const p = feature.properties ?? {};
      if (feature.geometry?.type !== 'LineString') throw new Error('not a line');
      const points = feature.geometry.coordinates;
      const pipe = makePipe({
        id: safeId(p.id) ?? newId(),
        network: p.network,
        zone: zoneOf(tidyPoints(points)),
        points,
        size: p.diameter,
        depth: p.depth?.from?.[0] === 'mine' ? p.depth.at?.[0] : undefined,
        material: p.material,
        note: p.note,
        added: p.added,
        edited: p.edited,
      });
      if (byId.has(pipe.properties.id)) skipped += 1; // the one before it with the same id gives way
      byId.set(pipe.properties.id, pipe);
    } catch {
      skipped += 1;
    }
  }
  skipped += Math.max(0, data.features.length - LIMITS.pipes);
  return { pipes: [...byId.values()], skipped };
}

/**
 * The zone of the map a line is drawn with: the one its first point is in, else the one any of its
 * points is in, else the nearest.
 * @param {{ id: string, bbox: number[] }[]} zones  bbox: [west, south, east, north]
 */
export function zoneFor(zones, points) {
  const holds = ({ bbox: [west, south, east, north] }, [lon, lat]) => lon >= west && lon < east && lat >= south && lat < north;
  for (const point of points) {
    const zone = zones.find((candidate) => holds(candidate, point));
    if (zone) return zone.id;
  }
  if (!points.length) return zones[0]?.id;
  const away = ({ bbox: [west, south, east, north] }) => metresBetween(points[0], [Math.min(Math.max(points[0][0], west), east), Math.min(Math.max(points[0][1], south), north)]);
  return zones.reduce((nearest, zone) => (!nearest || away(zone) < away(nearest) ? zone : nearest), undefined)?.id;
}

/**
 * The pipes added, kept in a storage (the browser's `localStorage`, or anything with getItem and
 * setItem). A storage that is missing or refuses (private windows, blocked site data, no room)
 * never breaks the map: the pipes then start empty, and a change that could not be kept says so.
 *
 * @param {object} options
 * @param {{ getItem: (key: string) => string | null, setItem: (key: string, value: string) => void } | undefined} options.storage
 * @param {string} options.key
 * @param {(points: number[][]) => string | undefined} options.zoneOf  see fromFile
 * @param {() => string} options.newId
 */
export function createAddedStore({ storage, key, zoneOf, newId }) {
  let pipes = [];
  try {
    const kept = storage?.getItem(key);
    if (kept) pipes = fromFile(JSON.parse(kept), { zoneOf, newId }).pipes;
  } catch {
    pipes = []; // unreadable: as if there were none
  }

  /** Keeps a new list; false (and the old list stays) when the storage will not take it. */
  function keep(next) {
    try {
      if (!storage) return false;
      storage.setItem(key, JSON.stringify(toFile(next)));
      pipes = next;
      return true;
    } catch {
      return false;
    }
  }
  const idOf = (pipe) => pipe.properties.id;

  return {
    /** Every pipe added, oldest first (copies). */
    all: () => copy(pipes),
    get(id) {
      const pipe = pipes.find((candidate) => idOf(candidate) === id);
      return pipe && copy(pipe);
    },
    /** The pipes of one zone drawn by one network (copies: the map changes what it is handed). */
    inZone: (zoneId, network) => copy(pipes.filter((pipe) => pipe.properties.zone === zoneId && pipe.properties.network === network)),
    /** Adds a pipe, or puts it in the place of the one with the same id. False: it could not be kept. */
    put(pipe) {
      const at = pipes.findIndex((candidate) => idOf(candidate) === idOf(pipe));
      return keep(at < 0 ? [...pipes, copy(pipe)] : pipes.map((candidate, i) => (i === at ? copy(pipe) : candidate)));
    },
    remove: (id) => keep(pipes.filter((pipe) => idOf(pipe) !== id)),
    /** The pipes of a copy: new ones are added, those with an id already here take its place. */
    merge(incoming) {
      const next = new Map(pipes.map((pipe) => [idOf(pipe), pipe]));
      let replaced = 0;
      for (const pipe of incoming) {
        if (next.has(idOf(pipe))) replaced += 1;
        next.set(idOf(pipe), copy(pipe));
      }
      const saved = keep([...next.values()]);
      return { saved, added: incoming.length - replaced, replaced };
    },
  };
}
