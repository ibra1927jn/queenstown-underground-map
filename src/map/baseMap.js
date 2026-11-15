/**
 * What is drawn on the ground: the street map (OpenStreetMap, the default) or aerial photos of
 * Toitū Te Whenua LINZ.
 *
 * Photos: the latest mosaic, or – when a year is given (the timeline of "by year installed") –
 * the photos that existed by that year. The district has two sides with their own surveys
 * (Queenstown and Wanaka), so each side gets the newest survey taken there by that year; a survey
 * with gaps is drawn on top of the one before it. A survey used for one side only is asked for
 * that side only, so nothing is downloaded twice.
 *
 * The photos need a LINZ Basemaps key (see README, "Keys"); without one the street map stays.
 */
import { Cesium } from './cesium.js';

/**
 * @param {object} options
 * @param {object} options.viewer
 * @param {object} options.settings   CONFIG.aerial
 * @param {string} [options.key]      LINZ Basemaps key; without it `available` is false
 * @param {number} [options.anisotropy]
 */
export function createBaseMap({ viewer, settings, key, anisotropy = 1 }) {
  const layers = viewer.imageryLayers;
  const streetMap = layers.get(0);
  const photos = [...settings.photos].sort((a, b) => a.year - b.year);
  const sides = Object.keys(settings.sides);
  const credit = new Cesium.Credit(settings.credit, true);

  let mode = 'map';
  let year; // undefined: the latest photos
  let shown = []; // { id, layer } bottom to top
  const leaving = new Map(); // id -> { layer, timer }: replaced, kept below the new ones until those have arrived
  let streetMapTimer;

  /** The surveys drawn on one side for the year, newest first (more than one when the newest has gaps). */
  function photosFor(side) {
    if (year === undefined || year >= settings.latestFromYear) return [settings.latest];
    const taken = photos.filter((photo) => photo.year <= year && (photo.covers === 'all' || photo.covers === side)).reverse();
    if (taken.length === 0) return [photos.find((photo) => photo.covers === 'all' || photo.covers === side)]; // before the first photo
    const stack = [];
    for (const photo of taken) {
      stack.push(photo);
      if (!photo.partial) break;
    }
    return stack;
  }

  /** Every survey to draw, oldest first, each with the sides it is needed on. */
  function plan() {
    const where = new Map();
    for (const side of sides) {
      for (const photo of photosFor(side)) where.set(photo, [...(where.get(photo) ?? []), side]);
    }
    return [...where]
      .sort(([a], [b]) => (a.year ?? Infinity) - (b.year ?? Infinity))
      .map(([photo, on]) => ({ photo, on, id: `${photo.layer}|${on.join('+')}` }));
  }

  function addLayer({ photo, on }) {
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: settings.tiles.replace('{layer}', photo.layer).replace('{key}', encodeURIComponent(key)),
      maximumLevel: photo.maximumLevel,
      // Needed on one side only: ask for the tiles of that side only.
      rectangle: on.length < sides.length ? Cesium.Rectangle.fromDegrees(...settings.sides[on[0]]) : undefined,
      credit,
    });
    return layers.addImageryProvider(provider);
  }

  function remove(layer) {
    layers.remove(layer, true);
    viewer.scene.requestRender();
  }

  function apply() {
    const wanted = mode === 'photo' ? plan() : [];
    const before = new Map(shown.map((entry) => [entry.id, entry.layer]));

    shown = wanted.map((item) => {
      let layer = before.get(item.id);
      before.delete(item.id);
      if (!layer && leaving.has(item.id)) {
        // Asked for again before it was gone.
        clearTimeout(leaving.get(item.id).timer);
        layer = leaving.get(item.id).layer;
        leaving.delete(item.id);
      }
      layer ??= addLayer(item);
      Object.assign(layer, settings.look, { maximumAnisotropy: anisotropy });
      layers.raiseToTop(layer);
      return { id: item.id, layer };
    });

    // What is no longer wanted stays underneath for a moment, so the ground is never blank while
    // the new photos arrive – except when going back to the street map, which is there already.
    clearTimeout(streetMapTimer);
    if (mode === 'photo') {
      for (const [id, layer] of before) leaving.set(id, { layer, timer: setTimeout(() => (leaving.delete(id), remove(layer)), settings.swapMs) });
      // The street map is not downloaded while photos cover it.
      streetMapTimer = setTimeout(() => ((streetMap.show = false), viewer.scene.requestRender()), settings.swapMs);
    } else {
      streetMap.show = true;
      for (const layer of before.values()) remove(layer);
      for (const { layer, timer } of leaving.values()) (clearTimeout(timer), remove(layer));
      leaving.clear();
    }
    viewer.scene.requestRender();
  }

  return {
    /** Whether photos can be shown at all (a key is needed). */
    available: Boolean(key),
    get mode() {
      return mode;
    },
    /** 'map' or 'photo'. */
    setMode(next) {
      const wanted = next === 'photo' && key ? 'photo' : 'map';
      if (wanted === mode) return;
      mode = wanted;
      apply();
    },
    /** The photos of a year (undefined: the latest). */
    setYear(next) {
      if (next === year) return;
      const before = plan().map((item) => item.id).join();
      year = next;
      if (mode === 'photo' && plan().map((item) => item.id).join() !== before) apply();
    },
    /** In words, the photos shown on a side (one of the names in settings.sides); '' with the street map. */
    describe(side) {
      if (mode !== 'photo') return '';
      const [top, ...under] = photosFor(side);
      if (top === settings.latest) return `Aerial photo: ${top.label}`;
      if (year < top.year) return `Aerial photo: ${top.label} (the oldest there is)`;
      return `Aerial photo: ${top.label}${under.length ? ` (${under.map((photo) => photo.label).join(', ')} where it has none)` : ''}`;
    },
  };
}
