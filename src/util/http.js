/**
 * Loading of the JSON / GeoJSON data files.
 *
 * GeoJSON files are asked for in the compact "packed" layout (see packedGeojson.js): the demo's
 * own server sends them that way, at about half the size; any other server ignores the request
 * and sends the plain file, which works just the same.
 *
 * A data file the page knows the fingerprint of (scripts/lib/fingerprints.mjs) is asked for with it
 * ("?v=…"): the browser then keeps it and does not ask the server again until it changes.
 */
import { isPacked, unpack } from './packedGeojson.js';

/** The fingerprints of the data files, written into the page by the server: { "data/…": "3f9a1c20e4" }. */
const DATA_VERSIONS = (() => {
  try {
    return JSON.parse(document.getElementById('data-versions')?.textContent ?? '{}');
  } catch {
    return {}; // a page without them works the same, just without the long keeping
  }
})();

/**
 * Fetches and parses a JSON file.
 * @param {string} url
 * @param {{ optional?: boolean, signal?: AbortSignal }} [options]
 *   optional: resolve to `null` instead of failing when the file does not exist (HTTP 404).
 */
export async function fetchJson(url, { optional = false, signal } = {}) {
  let response;
  try {
    const query = [DATA_VERSIONS[url] && `v=${DATA_VERSIONS[url]}`, /\.geojson$/.test(url) && 'packed=1'].filter(Boolean).join('&');
    response = await fetch(query ? `${url}?${query}` : url, { signal });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(`Could not load ${url} (network problem)`);
  }
  if (response.status === 404 && optional) return null;
  if (!response.ok) throw new Error(`Could not load ${url} (HTTP ${response.status})`);
  try {
    const data = await response.json();
    return isPacked(data) ? unpack(data) : data;
  } catch {
    throw new Error(`${url} is not valid JSON`);
  }
}
