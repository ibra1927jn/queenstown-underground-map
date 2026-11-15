/**
 * Drawing resolution: sharp when the map is still, lighter while it moves.
 *
 * Screens today have 2 or 3 physical pixels per "CSS pixel". Drawing every frame
 * at that full density costs 4 to 9 times the work. So while the map moves it is
 * drawn at a lower density (the first value of `pixelRatios` in src/config.js,
 * stepping down to the next ones if frames still arrive late), and as soon as it
 * stands still it is drawn once more at the full density of the screen
 * (`stillPixelRatio`) – one frame, so the cost does not matter.
 */

import { Cesium } from './cesium.js';

/** Two renders further apart than this are not part of the same movement. */
const MOVEMENT_GAP_MS = 250;

/** A frame counts as late when it takes this many screen refreshes or more (1.5: it missed one). */
const LATE_AFTER_REFRESHES = 1.5;

/** The camera counts as still once it has not moved for this long. */
const STILL_AFTER_MS = 350;

/**
 * @param {object} viewer
 * @param {{ pixelRatios: number[], stillPixelRatio: number }} preset  densities while moving (best first) and when still
 * @param {{ slowFrameMs: number, slowShare: number, sampleFrames: number }} governor
 */
export function createQualityControl(viewer, preset, governor) {
  const { scene, camera } = viewer;
  const screenRatio = () => window.devicePixelRatio || 1;
  // Never draw more pixels than the screen has. Worked out afresh every time, because the
  // screen density changes with the page zoom and when the window moves to another monitor.
  const densityAt = (level) => Math.min(preset.pixelRatios[level], screenRatio());
  let level = 0;
  let still = true;
  const density = () => (still ? Math.min(preset.stillPixelRatio, screenRatio()) : densityAt(level));

  function apply() {
    viewer.useBrowserRecommendedResolution = false;
    const scale = density() / screenRatio();
    if (viewer.resolutionScale !== scale) viewer.resolutionScale = scale;
    scene.requestRender();
  }

  /** The next lower density that actually draws fewer pixels on this screen, if any. */
  function stepDown() {
    const current = densityAt(level);
    for (let next = level + 1; next < preset.pixelRatios.length; next += 1) {
      if (densityAt(next) < current) {
        level = next;
        apply();
        return;
      }
    }
  }

  // Whether the camera moves is told from where it is and where it looks, frame by frame.
  // (Cesium's own "camera moved" events also fire when the drawing size changes – which is
  // what this module does – and the two would keep setting each other off.)
  let moving = false;
  const lastPosition = new Cesium.Cartesian3();
  const lastDirection = new Cesium.Cartesian3();
  let lastMovedAt = -Infinity;
  let stillTimer;

  function watchForStill() {
    clearTimeout(stillTimer);
    stillTimer = setTimeout(() => {
      if (performance.now() - lastMovedAt < STILL_AFTER_MS) return watchForStill();
      moving = false;
      still = true;
      apply(); // one sharp frame
    }, STILL_AFTER_MS);
  }

  function noticeMovement() {
    const position = camera.positionWC;
    const direction = camera.directionWC;
    const moved =
      Cesium.Cartesian3.distanceSquared(position, lastPosition) > 1e-6 || Cesium.Cartesian3.distanceSquared(direction, lastDirection) > 1e-12;
    Cesium.Cartesian3.clone(position, lastPosition);
    Cesium.Cartesian3.clone(direction, lastDirection);
    if (!moved) return;
    lastMovedAt = performance.now();
    moving = true;
    if (still) {
      still = false;
      apply();
    }
    watchForStill();
  }

  // How often the screen refreshes, from the shortest gap between two frames seen so far
  // (16.7 ms at 60 Hz; 33 ms where the browser or the device limits pages to 30 frames a second).
  let refreshMs = Infinity;

  // Watch how long frames take while the map moves; one bad stretch can be a download or a
  // zone loading, so only two bad stretches in a row – within one movement – count.
  let lastFrameAt = 0;
  let frames = 0;
  let slowFrames = 0;
  let badStretches = 0;

  scene.postRender.addEventListener(() => {
    noticeMovement();
    const now = performance.now();
    const gap = now - lastFrameAt;
    lastFrameAt = now;
    if (!moving || gap > MOVEMENT_GAP_MS) {
      frames = 0;
      slowFrames = 0;
      if (gap > MOVEMENT_GAP_MS) badStretches = 0;
      return;
    }

    refreshMs = Math.min(refreshMs, gap);
    frames += 1;
    if (gap > Math.max(governor.slowFrameMs, LATE_AFTER_REFRESHES * refreshMs)) slowFrames += 1;
    if (frames < governor.sampleFrames) return;

    badStretches = slowFrames / frames > governor.slowShare ? badStretches + 1 : 0;
    frames = 0;
    slowFrames = 0;
    if (badStretches >= 2) {
      badStretches = 0;
      stepDown();
    }
  });

  window.addEventListener('resize', apply);
  apply();

  return {
    /** Device pixels per CSS pixel currently used for the map. */
    get pixelRatio() {
      return density();
    },
  };
}
