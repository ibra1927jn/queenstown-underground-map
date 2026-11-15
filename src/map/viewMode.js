/**
 * The 2D / 3D switch.
 *
 *   2D – a flat, north-up map seen from directly above
 *   3D – terrain relief and buildings, free camera
 *
 * Switching keeps the same place in the middle of the screen at the same
 * zoom, and coming back to 3D restores the previous viewing direction.
 */
import { Cesium, toDegrees } from './cesium.js';
import { currentFocus, headingDegrees, lookAt } from './camera.js';

/** Flattest tilt restored when returning to 3D (a horizon-level view would show almost no ground). */
const MAX_RESTORED_PITCH_DEGREES = -15;

/**
 * @param {object} viewer
 * @param {{ defaultOrientation: {headingDegrees:number, pitchDegrees:number},
 *           fallbackFocus: () => object, onChange?: (mode: string) => void }} options
 *   fallbackFocus: focus to use when the camera is not pointing at the ground (e.g. the active zone centre).
 */
export function createViewMode(viewer, { defaultOrientation, fallbackFocus, onChange }) {
  const { scene } = viewer;
  let mode = '3d';
  let orientation3D = { ...defaultOrientation };

  function set(next) {
    if (next === mode || (next !== '2d' && next !== '3d')) return mode;

    // A flight planned for the old view must not keep steering the new one: finish it first.
    viewer.camera.completeFlight();

    const fallback = fallbackFocus();
    const focus = { ...(currentFocus(viewer, fallback.height) ?? fallback) };

    if (next === '2d') {
      orientation3D = {
        headingDegrees: headingDegrees(viewer),
        pitchDegrees: Math.min(toDegrees(viewer.camera.pitch), MAX_RESTORED_PITCH_DEGREES),
      };
      scene.morphTo2D(0);
    } else {
      // The map may have been moved while flat: aim at the ground height of where it is now.
      const groundHere = scene.globe.getHeight(Cesium.Cartographic.fromDegrees(focus.lon, focus.lat));
      scene.morphTo3D(0);
      focus.height = groundHere ?? fallback.height ?? 0;
    }

    mode = next;
    lookAt(viewer, focus, orientation3D);
    onChange?.(mode);
    return mode;
  }

  return {
    set,
    get mode() {
      return mode;
    },
  };
}
