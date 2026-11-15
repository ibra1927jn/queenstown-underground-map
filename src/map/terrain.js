/**
 * Terrain (the relief of the ground) and ground-height lookups.
 *
 * The relief comes from open "terrarium" elevation tiles: ordinary image tiles
 * whose colours encode a height,
 *
 *     height in metres = red × 256 + green + blue ÷ 256 − 32768
 *
 * The same decoded tiles feed both the 3D relief (through Cesium) and the
 * height lookups used to place buildings – and, later, pipes at "ground minus
 * depth". Everything therefore sits on the ground that is actually displayed,
 * whichever source is in use and whatever vertical datum it has.
 *
 * No account or key is needed. Sources are listed in src/config.js and tried
 * in order; if none answers, the map is simply flat.
 */
import { Cesium } from './cesium.js';

/** Heights along each edge of a terrain tile handed to Cesium (64 intervals). */
const SAMPLES_PER_EDGE = 65;
const PROBE_TIMEOUT_MS = 8000;
const PARALLEL_DOWNLOADS = 6;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * Downloads and decodes elevation tiles of one source, remembering the most
 * recently used ones. A decoded tile is { size, heights } with one height per
 * pixel, rows from north to south.
 */
function createTileStore(source, cacheLimit) {
  const cache = new Map(); // "zoom/x/y" -> Promise<tile>, least recently used first

  async function download(zoom, x, y) {
    const url = source.url.replace('{z}', zoom).replace('{x}', x).replace('{y}', y);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Terrain tile ${zoom}/${x}/${y}: HTTP ${response.status}`);

    // 'none' keeps the colour values exactly as stored: any colour correction would corrupt the heights.
    const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const size = bitmap.width;
    const canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(size, size)
        : Object.assign(document.createElement('canvas'), { width: size, height: size });
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    bitmap.close?.();

    const rgba = context.getImageData(0, 0, size, size).data;
    const heights = new Float32Array(size * size);
    for (let i = 0, p = 0; i < heights.length; i += 1, p += 4) {
      heights[i] = rgba[p] * 256 + rgba[p + 1] + rgba[p + 2] / 256 - 32768;
    }
    return { size, heights };
  }

  function load(zoom, x, y) {
    const key = `${zoom}/${x}/${y}`;
    let tile = cache.get(key);
    if (tile) {
      cache.delete(key); // re-inserted below, so it counts as recently used
    } else {
      tile = download(zoom, x, y);
      tile.catch(() => cache.delete(key)); // a failed download may be retried later
    }
    cache.set(key, tile);
    while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
    return tile;
  }

  return { load };
}

/** Height at a pixel position of a tile, blended between the four nearest pixel centres. */
function heightAtPixel(tile, pixelX, pixelY) {
  const { size, heights } = tile;
  const x = clamp(pixelX - 0.5, 0, size - 1); // pixel centres sit at +0.5
  const y = clamp(pixelY - 0.5, 0, size - 1);
  const x0 = Math.min(size - 2, Math.floor(x));
  const y0 = Math.min(size - 2, Math.floor(y));
  const wx = x - x0;
  const wy = y - y0;
  const i = y0 * size + x0;
  return (
    (heights[i] * (1 - wx) + heights[i + 1] * wx) * (1 - wy) +
    (heights[i + size] * (1 - wx) + heights[i + size + 1] * wx) * wy
  );
}

/**
 * Height of the displayed ground surface at a pixel position.
 * At its most detailed level Cesium draws a mesh with one corner per pixel
 * edge (see createProvider); this reproduces that mesh, so looked-up heights
 * match what is on screen when zoomed in.
 */
function surfaceHeight(tile, pixelX, pixelY) {
  const x0 = Math.min(tile.size - 1, Math.floor(pixelX));
  const y0 = Math.min(tile.size - 1, Math.floor(pixelY));
  const wx = pixelX - x0;
  const wy = pixelY - y0;
  return (
    (heightAtPixel(tile, x0, y0) * (1 - wx) + heightAtPixel(tile, x0 + 1, y0) * wx) * (1 - wy) +
    (heightAtPixel(tile, x0, y0 + 1) * (1 - wx) + heightAtPixel(tile, x0 + 1, y0 + 1) * wx) * wy
  );
}

/** The Cesium terrain provider that draws the relief from the decoded tiles. */
function createProvider(source, tiles) {
  // A Cesium terrain tile has 64 intervals per edge. Using source tiles a few zoom levels
  // up makes one source pixel match one interval (512-px tiles: 3 levels up).
  const levelsUp = Math.round(Math.log2(source.tileSize / (SAMPLES_PER_EDGE - 1)));
  const mostDetailedLevel = source.maxZoom + levelsUp;

  const provider = new Cesium.CustomHeightmapTerrainProvider({
    width: SAMPLES_PER_EDGE,
    height: SAMPLES_PER_EDGE,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    credit: new Cesium.Credit(source.credit, false),
    callback: async (x, y, level) => {
      const zoom = clamp(level - levelsUp, 0, source.maxZoom);
      const tilesPerSourceTile = 2 ** (level - zoom);
      const sourceX = Math.floor(x / tilesPerSourceTile);
      const sourceY = Math.floor(y / tilesPerSourceTile);
      const tile = await tiles.load(zoom, sourceX, sourceY);

      const left = ((x - sourceX * tilesPerSourceTile) / tilesPerSourceTile) * tile.size;
      const top = ((y - sourceY * tilesPerSourceTile) / tilesPerSourceTile) * tile.size;
      const step = tile.size / tilesPerSourceTile / (SAMPLES_PER_EDGE - 1);

      const heights = new Float32Array(SAMPLES_PER_EDGE * SAMPLES_PER_EDGE); // rows from north to south
      for (let row = 0; row < SAMPLES_PER_EDGE; row += 1) {
        for (let column = 0; column < SAMPLES_PER_EDGE; column += 1) {
          heights[row * SAMPLES_PER_EDGE + column] = heightAtPixel(tile, left + column * step, top + row * step);
        }
      }
      return heights;
    },
  });

  // Beyond the source's own detail there is nothing new to download: Cesium refines the tiles it has.
  provider.getTileDataAvailable = (x, y, level) => level <= mostDetailedLevel;
  return provider;
}

/** Runs `worker` over the items, a few at a time. */
async function inParallel(items, limit, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(lanes);
}

/**
 * Ground-height lookup for a source:
 *
 *   const heights = await sampleGround([lon0, lat0, lon1, lat1, …]);   // degrees in, metres out
 *
 * A height is NaN when it could not be found (its elevation tile did not download).
 */
function createGroundSampler(source, tiles) {
  const zoom = source.maxZoom;
  const tilesAcross = 2 ** zoom;

  return async function sampleGround(lonLat) {
    const count = lonLat.length / 2;
    const heights = new Float64Array(count).fill(Number.NaN);
    const acrossTile = new Float64Array(count); // position inside its tile, 0..1 from the west edge
    const downTile = new Float64Array(count); //   and 0..1 from the north edge
    const groups = new Map(); // tile -> { x, y, positions: [index, …] }

    // 1. Which tile (Web Mercator grid) and where inside it each position falls.
    for (let i = 0; i < count; i += 1) {
      const latitude = (lonLat[2 * i + 1] * Math.PI) / 180;
      const worldX = ((lonLat[2 * i] + 180) / 360) * tilesAcross;
      const worldY = ((1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) / 2) * tilesAcross;
      const x = Math.floor(worldX);
      const y = Math.floor(worldY);
      acrossTile[i] = worldX - x;
      downTile[i] = worldY - y;

      const key = x * tilesAcross + y;
      let group = groups.get(key);
      if (!group) groups.set(key, (group = { x, y, positions: [] }));
      group.positions.push(i);
    }

    // 2. Download the tiles needed (a few at a time) and read the heights off them.
    //    A tile that fails is tried once more; positions on a tile that still fails stay NaN
    //    ("unknown") – callers skip those rather than draw something at a made-up height.
    let pending = [...groups.values()];
    for (let attempt = 0; attempt < 2 && pending.length > 0; attempt += 1) {
      const failed = [];
      await inParallel(pending, PARALLEL_DOWNLOADS, async (group) => {
        let tile;
        try {
          tile = await tiles.load(zoom, group.x, group.y);
        } catch (error) {
          failed.push(group);
          if (attempt > 0) console.warn(error.message);
          return;
        }
        for (const i of group.positions) heights[i] = surfaceHeight(tile, acrossTile[i] * tile.size, downTile[i] * tile.size);
      });
      pending = failed;
    }
    return heights;
  };
}

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms))]);

/**
 * Picks the first elevation source that answers.
 * @param {{ sources: object[], probeTile: number[], cachedTiles: number }} settings  see src/config.js
 * @returns {Promise<{ name: string, hasRelief: boolean, provider: object, sampleGround: (lonLat: number[]) => Promise<Float64Array> }>}
 */
export async function createTerrain({ sources, probeTile, cachedTiles }) {
  for (const source of sources) {
    const tiles = createTileStore(source, cachedTiles);
    try {
      await withTimeout(tiles.load(...probeTile), PROBE_TIMEOUT_MS);
      return {
        name: source.name,
        hasRelief: true,
        provider: createProvider(source, tiles),
        sampleGround: createGroundSampler(source, tiles),
      };
    } catch (error) {
      console.warn(`Terrain source "${source.name}" is not available (${error.message}); trying the next one.`);
    }
  }

  return {
    name: 'Flat (no terrain available)',
    hasRelief: false,
    provider: new Cesium.EllipsoidTerrainProvider(),
    sampleGround: async (lonLat) => new Float64Array(lonLat.length / 2),
  };
}
