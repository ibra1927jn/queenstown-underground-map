/**
 * CesiumJS is loaded by a <script> tag in index.html and lives on
 * `window.Cesium`. Every module imports it from here, so there is a single
 * place that knows how the library gets into the page.
 */
export const Cesium = window.Cesium;

export const toRadians = (degrees) => (degrees * Math.PI) / 180;
export const toDegrees = (radians) => (radians * 180) / Math.PI;
