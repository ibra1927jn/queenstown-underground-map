/**
 * Creates the Cesium viewer: an OpenStreetMap base map with every built-in
 * Cesium widget switched off (the page has its own controls) and every
 * rendering extra this street-map demo does not need switched off too.
 *
 * Why so much is "off": measured on an integrated-graphics laptop, Cesium's
 * defaults plus double-resolution drawing with 4x anti-aliasing gave 29 frames
 * per second in a full-screen window. The settings below give a steady 60
 * (see docs/PERFORMANCE.md).
 */
import { Cesium } from './cesium.js';
import { applyLook } from './look.js';

const OSM_TILES_URL = 'https://tile.openstreetmap.org/';
const OSM_CREDIT =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
const CESIUM_CREDIT = '<a href="https://cesium.com/platform/cesiumjs/" target="_blank" rel="noopener">CesiumJS</a>';

/** A fixed time, so nothing in the scene depends on when the demo is opened. (The light is set in look.js.) */
const FIXED_SUN_TIME = '2026-01-15T01:00:00Z';

/** Colour behind the map (above the sky's glow, and the whole background in 2D). */
const SKY_COLOR = '#dbe7ef';

/**
 * @param {{ container: HTMLElement, creditContainer: HTMLElement, quality: object, look: object }} options
 *   quality: one of the presets in src/config.js (antialiasSamples, imageryAnisotropy, outlines…);
 *   look: CONFIG.look (sky, light, outlines – see look.js)
 */
export function createViewer({ container, creditContainer, quality, look }) {
  // No Cesium ion service is used, so credit the open-source engine by name instead of the ion logo.
  Cesium.CreditDisplay.cesiumCredit = new Cesium.Credit(CESIUM_CREDIT, true);

  const baseLayer = new Cesium.ImageryLayer(
    new Cesium.OpenStreetMapImageryProvider({
      url: OSM_TILES_URL,
      maximumLevel: 19,
      credit: new Cesium.Credit(OSM_CREDIT, true),
    }),
    // A calmer base map (muted colours, a touch lighter): the pipes and buildings stand out on it.
    { maximumAnisotropy: quality.imageryAnisotropy, saturation: 0.35, brightness: 1.04, contrast: 0.95 },
  );

  const viewer = new Cesium.Viewer(container, {
    baseLayer,
    creditContainer,
    // The page provides its own controls.
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    // A real map projection, so the 2D view looks like a normal web map.
    mapProjection: new Cesium.WebMercatorProjection(),
    // Draw only when something changes: saves battery on laptops and phones.
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,

    // --- Rendering extras the demo does not need (each one costs time or memory every frame) ---
    msaaSamples: quality.antialiasSamples,
    // Exact sorting of see-through shapes: the few there are (the ground in the underground views, glass
    // buildings, see-through shafts) look right without it, and it would cost time every frame.
    orderIndependentTranslucency: false,
    // Stars, and the glow of the atmosphere around the globe (look.js adds a sky of its own).
    skyBox: false,
    skyAtmosphere: false,
    // Cesium draws into its own buffers, so the page canvas needs no anti-aliasing of its own.
    contextOptions: { webgl: { antialias: false } },
  });

  const { scene } = viewer;

  // A still clock (see FIXED_SUN_TIME); the sun and moon are not drawn.
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(FIXED_SUN_TIME);
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  scene.backgroundColor = Cesium.Color.fromCssColorString(SKY_COLOR);

  // Hills hide what is behind them, and buildings sit in the ground rather than on top of it.
  scene.globe.depthTestAgainstTerrain = true;
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#cfdbe2');
  // The bluish haze Cesium adds to ground seen from far away.
  scene.globe.showGroundAtmosphere = false;

  // Smooth jagged edges (lines, tubes, building corners) – cheap, unlike multisample anti-aliasing.
  scene.postProcessStages.fxaa.enabled = Boolean(quality.smoothEdges);

  // Sky, light over the viewer's shoulder, outlines.
  applyLook(viewer, look, quality);

  return viewer;
}
