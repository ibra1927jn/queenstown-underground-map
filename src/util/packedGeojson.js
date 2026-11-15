/**
 * A compact layout for the demo's GeoJSON files, used only on the way from the server to the
 * page: the files on disk stay plain GeoJSON (scripts/serve.mjs packs them when the page asks
 * with "?packed=1"; the page unpacks them back into the same features).
 *
 * Why: GeoJSON repeats every field name for every feature and writes every coordinate in full.
 * Packed, the same data is
 *   - one column per field (values that repeat are written once, in a dictionary), and
 *   - coordinates as whole numbers (millionths of a degree) written as the step from the
 *     previous point.
 * Compressed for the network that is about half the size.
 *
 * Works in Node and in the browser (no imports).
 */

const TYPES = ['Point', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'];
const SCALE = 1e6;

/** One line of [lon, lat] as [count, dx, dy, dx, dy, …] in millionths of a degree. */
function encodeLine(line) {
  const out = [line.length];
  let previousX = 0;
  let previousY = 0;
  for (const [lon, lat] of line) {
    const x = Math.round(lon * SCALE);
    const y = Math.round(lat * SCALE);
    out.push(x - previousX, y - previousY);
    previousX = x;
    previousY = y;
  }
  return out;
}

function decodeLine(encoded) {
  const line = new Array(encoded[0]);
  let x = 0;
  let y = 0;
  for (let i = 0; i < line.length; i += 1) {
    x += encoded[1 + 2 * i];
    y += encoded[2 + 2 * i];
    line[i] = [x / SCALE, y / SCALE];
  }
  return line;
}

const encodeGeometry = {
  Point: (c) => [Math.round(c[0] * SCALE), Math.round(c[1] * SCALE)],
  LineString: encodeLine,
  MultiLineString: (c) => c.map(encodeLine),
  Polygon: (c) => c.map(encodeLine),
  MultiPolygon: (c) => c.map((polygon) => polygon.map(encodeLine)),
};
const decodeGeometry = {
  Point: (c) => [c[0] / SCALE, c[1] / SCALE],
  LineString: decodeLine,
  MultiLineString: (c) => c.map(decodeLine),
  Polygon: (c) => c.map(decodeLine),
  MultiPolygon: (c) => c.map((polygon) => polygon.map(decodeLine)),
};

/**
 * Packs a GeoJSON FeatureCollection. Returns undefined when it holds something this layout does
 * not cover (the caller then sends the plain file).
 */
export function pack(collection) {
  const features = collection?.features;
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(features)) return undefined;
  if (features.some((f) => !f.geometry || !encodeGeometry[f.geometry.type] || f.properties === null || typeof f.properties !== 'object')) return undefined;

  const keys = [...new Set(features.flatMap((f) => Object.keys(f.properties)))];
  const columns = {};
  for (const key of keys) {
    const values = features.map((f) => (f.properties[key] === undefined ? null : f.properties[key]));
    if (values.every((v) => v === null || typeof v === 'number' || typeof v === 'boolean')) {
      columns[key] = { v: values };
      continue;
    }
    // Texts and small objects (the depth of a pipe, for one): each distinct value once.
    const dictionary = [];
    const numberOf = new Map();
    const codes = values.map((value) => {
      if (value === null) return -1;
      const text = JSON.stringify(value);
      if (!numberOf.has(text)) {
        numberOf.set(text, dictionary.length);
        dictionary.push(value);
      }
      return numberOf.get(text);
    });
    columns[key] = dictionary.length < values.length * 0.7 ? { d: dictionary, c: codes } : { v: values };
  }

  const { features: _features, ...head } = collection;
  return {
    packed: 1,
    head,
    count: features.length,
    columns,
    types: features.map((f) => TYPES.indexOf(f.geometry.type)),
    coordinates: features.map((f) => encodeGeometry[f.geometry.type](f.geometry.coordinates)),
  };
}

/** Whether a parsed file is in the packed layout. */
export const isPacked = (data) => data?.packed === 1 && Array.isArray(data.types);

/** The GeoJSON FeatureCollection a packed file stands for. */
export function unpack(packed) {
  const features = new Array(packed.count);
  for (let i = 0; i < packed.count; i += 1) {
    const type = TYPES[packed.types[i]];
    features[i] = { type: 'Feature', properties: {}, geometry: { type, coordinates: decodeGeometry[type](packed.coordinates[i]) } };
  }
  for (const [key, column] of Object.entries(packed.columns)) {
    if (column.v) {
      for (let i = 0; i < packed.count; i += 1) if (column.v[i] !== null) features[i].properties[key] = column.v[i];
      continue;
    }
    // Objects are copied per feature: two features must never share one (the page edits some).
    const isObject = column.d.map((value) => value !== null && typeof value === 'object');
    const texts = column.d.map((value, n) => (isObject[n] ? JSON.stringify(value) : undefined));
    for (let i = 0; i < packed.count; i += 1) {
      const code = column.c[i];
      if (code < 0) continue;
      features[i].properties[key] = isObject[code] ? JSON.parse(texts[code]) : column.d[code];
    }
  }
  return { ...packed.head, features };
}
