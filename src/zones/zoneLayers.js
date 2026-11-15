/**
 * Keeps the per-zone data of every layer in step with the zones being viewed:
 * loads a zone's files when it is shown and unloads the least recently used
 * zones so memory stays low (important on phones).
 *
 * A zone loads in this order, so that what reads from afar is on screen first:
 *   1. the layers of wave 1: the networks (their mains, manholes, valves, hydrants…), bores, instruments;
 *   2. the layers of wave 2: the buildings;
 *   3. what the layers load last (details): the networks' property connections and small fittings.
 * On a fast connection the three follow each other within a second; on a slow one the networks
 * no longer wait behind the buildings and the thousands of small things.
 *
 * A layer is any object with:
 *   loadZone(zone)         -> Promise  (does nothing if that zone is already loaded)
 *   unloadZone(zoneId)
 *   wave                   optional: 2 to load after the others
 *   loadZoneDetails(zone)  optional -> Promise: what the layer loads last
 */
export function createZoneLayers({ layers, maxLoadedZones }) {
  /** Zone ids, least recently used first. */
  const recent = [];

  function markUsed(zoneId) {
    const index = recent.indexOf(zoneId);
    if (index >= 0) recent.splice(index, 1);
    recent.push(zoneId);
  }

  function unloadOldZones() {
    while (recent.length > maxLoadedZones) {
      const zoneId = recent.shift();
      for (const layer of layers) layer.unloadZone(zoneId);
    }
  }

  /** Waits for every promise; rejects with the first error, after all have finished. */
  async function allOf(promises) {
    const results = await Promise.allSettled(promises);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  /**
   * Loads every layer for the zone, wave after wave (a wave that fails does not stop the next).
   * Rejects with the first error, after trying all layers.
   * @param {(done: number, total: number) => void} [onProgress] called as each layer finishes
   */
  async function show(zone, onProgress) {
    markUsed(zone.id);
    unloadOldZones();
    let done = 0;
    const tick = () => onProgress?.((done += 1), layers.length);
    let failure;
    for (const wave of [1, 2]) {
      const inWave = layers.filter((layer) => (layer.wave ?? 1) === wave);
      await allOf(inWave.map((layer) => Promise.resolve(layer.loadZone(zone)).finally(tick))).catch((error) => (failure ??= error));
    }
    if (failure) throw failure;
  }

  /** Loads what the layers load last for a zone already shown (see show). Rejects with the first error. */
  const details = (zone) => allOf(layers.map((layer) => layer.loadZoneDetails?.(zone)));

  return { show, details, isLoaded: (zoneId) => recent.includes(zoneId) };
}
