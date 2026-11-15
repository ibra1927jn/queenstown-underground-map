/**
 * The map only redraws when something changes (see requestRenderMode in
 * viewer.js). Shapes prepared in the background need a few extra frames to
 * appear, so this helper keeps asking for frames until a condition is met.
 */

/**
 * @param {object} scene      Cesium scene
 * @param {() => boolean} isDone
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>} true when the condition was met, false on timeout
 */
const CHECK_EVERY_MS = 50;

export function renderUntil(scene, isDone, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    function tick() {
      scene.requestRender();
      if (isDone()) resolve(true);
      else if (performance.now() - startedAt > timeoutMs) resolve(false);
      else setTimeout(tick, CHECK_EVERY_MS); // a timer (not an animation frame) so it also finishes in a background tab
    }
    tick();
  });
}
