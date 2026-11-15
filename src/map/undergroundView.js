/**
 * The underground view (3D only): the ground becomes see-through, the camera may
 * go below it, and the network layers draw every pipe at its depth instead of
 * on the surface.
 *
 * The ground is not made fully transparent: a faint surface keeps streets and
 * buildings readable as landmarks above the pipes.
 */
import { Cesium } from './cesium.js';

/**
 * @param {object} viewer
 * @param {{ groundOpacityNear: number, groundOpacityFar: number, nearM: number, farM: number, terrainDetail: number, undersideColor: string }} settings
 *   how opaque the ground looks close to the camera and far from it; terrainDetail: Cesium's
 *   "maximum screen space error" while the view is on (higher = coarser, faster; Cesium's default is 2);
 *   undersideColor: the ground seen through or from below
 * @param {(on: boolean) => void} onChange  called after every switch
 */
export function createUndergroundView(viewer, settings, onChange) {
  const { scene } = viewer;
  const { globe } = scene;
  const controller = scene.screenSpaceCameraController;
  let on = false;

  globe.translucency.frontFaceAlphaByDistance = new Cesium.NearFarScalar(settings.nearM, settings.groundOpacityNear, settings.farM, settings.groundOpacityFar);
  // Seen from below, the underside of the ground: a soil colour rather than the sky.
  globe.undergroundColor = Cesium.Color.fromCssColorString(settings.undersideColor);
  globe.undergroundColorAlphaByDistance = new Cesium.NearFarScalar(settings.nearM, 0.4, settings.farM, 0.9);

  // A see-through ground is drawn twice (front and back), so it is drawn a little less detailed:
  // seen through, the difference does not show, and frames stay within 60 per second.
  const normalDetail = globe.maximumScreenSpaceError;

  function set(next) {
    on = Boolean(next);
    globe.translucency.enabled = on;
    globe.maximumScreenSpaceError = on ? settings.terrainDetail : normalDetail;
    // Normally the camera bumps into the ground; underground it has to pass through it.
    controller.enableCollisionDetection = !on;
    scene.requestRender();
    onChange?.(on);
  }

  return {
    set,
    toggle: () => set(!on),
    /** How solid the ground looks close to the camera (0: glass, 1: solid); further away it is more solid, so the landscape still reads. */
    setGroundOpacity(near) {
      const far = Math.min(1, near + (settings.groundOpacityFar - settings.groundOpacityNear));
      globe.translucency.frontFaceAlphaByDistance = new Cesium.NearFarScalar(settings.nearM, near, settings.farM, far);
      scene.requestRender();
    },
    /** The colour of the ground seen through or from below (undefined: the usual soil colour). */
    setUnderside(css = settings.undersideColor) {
      globe.undergroundColor = Cesium.Color.fromCssColorString(css);
      scene.requestRender();
    },
    get on() {
      return on;
    },
  };
}
