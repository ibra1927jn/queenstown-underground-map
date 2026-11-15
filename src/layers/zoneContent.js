/**
 * Per-zone bookkeeping shared by the map layers.
 *
 * Every layer shows "content" (shapes on the map plus the data behind them)
 * for one zone at a time. This helper makes sure that
 *   - a zone's content is loaded once, and repeated requests wait for that same load;
 *   - a zone unloaded while its data is still on the way is discarded when it arrives;
 *   - a failed load can simply be tried again later.
 *
 * @param {object} hooks
 * @param {(zone: object, isWanted: () => boolean) => Promise<object|undefined>} hooks.load
 *   Loads a zone and returns its content. `isWanted()` turns false if the zone
 *   was unloaded meanwhile – check it after slow steps and stop early.
 * @param {(content: object) => void} hooks.dispose  removes a content's shapes from the map
 */
export function createZoneContent({ load, dispose }) {
  /** zoneId -> { promise, content } ; `content` is set once the load has finished. */
  const entries = new Map();

  return {
    /** Loads the zone unless that is already done or under way. Resolves when its content is on the map. */
    load(zone) {
      let entry = entries.get(zone.id);
      if (!entry) {
        entry = {};
        entries.set(zone.id, entry);
        const isWanted = () => entries.get(zone.id) === entry;

        entry.promise = load(zone, isWanted).then(
          (content) => {
            if (isWanted()) entry.content = content;
            else if (content) dispose(content);
          },
          (error) => {
            if (isWanted()) entries.delete(zone.id); // so the zone can be tried again
            throw error;
          },
        );
      }
      return entry.promise;
    },

    unload(zoneId) {
      const entry = entries.get(zoneId);
      if (!entry) return;
      entries.delete(zoneId);
      if (entry.content) dispose(entry.content);
    },

    /** The loaded content of a zone, or undefined while it is absent or still loading. */
    get: (zoneId) => entries.get(zoneId)?.content,

    /** Every loaded content. */
    all: () => [...entries.values()].map((entry) => entry.content).filter(Boolean),
  };
}
