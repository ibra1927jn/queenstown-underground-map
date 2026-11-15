/**
 * How the map is moved: mouse, trackpad, touch, keyboard and the on-screen buttons.
 *
 * Cesium's defaults suit a globe viewer (right-drag zooms, tilting needs the
 * middle button). These follow the habits of everyday map apps instead:
 *
 *   drag ............................ move the map
 *   wheel / pinch ................... zoom (towards the pointer)
 *   right-drag, Ctrl- or Shift-drag . rotate and tilt (around the point under the pointer when close in)
 *   double-click .................... zoom in on that point
 *   arrow keys, + and - ............. move and zoom;  Shift + arrows: rotate and tilt;  N: north up
 *
 * Every button and key works around the point in the middle of the screen,
 * with a short glide so the eye can follow the change.
 */
import { Cesium, toDegrees, toRadians } from './cesium.js';
import { currentView, glide, groundAt, headingDegrees, is2D, spanPerRange, stopMoving } from './camera.js';

const METRES_PER_DEGREE = 111_320;

/** A held key repeats every 30 ms or so; the first repeat comes after a longer pause and counts as one of these. */
const LONGEST_REPEAT_MS = 100;

/** Keeps the closest-view sum finite should the camera ever look almost level with the ground. */
const SMALLEST_SINE = 0.1;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** True when the pressed key belongs to a control that uses arrows and letters itself (the zone list, a text field). */
const usesKeysItself = (target) =>
  target instanceof Element && target.closest('select, textarea, [contenteditable], input:not([type="checkbox"])') !== null;

/**
 * @param {object} viewer
 * @param {object} settings        CONFIG.controls
 * @param {{ isPhone: boolean, fallbackFocus: () => object }} options
 *   fallbackFocus: what to treat as "the place being looked at" when the camera points at the sky
 * @returns {{ [action: string]: () => void }} the actions the on-screen buttons call
 */
export function createControls(viewer, settings, { isPhone, fallbackFocus }) {
  const { scene, camera } = viewer;
  const controller = scene.screenSpaceCameraController;
  const { CameraEventType: Gesture, KeyboardEventModifier: Key } = Cesium;

  // ---- Gestures ----
  // Browsers report a trackpad pinch as Ctrl + wheel.
  controller.zoomEventTypes = [Gesture.WHEEL, Gesture.PINCH, { eventType: Gesture.WHEEL, modifier: Key.CTRL }];
  controller.tiltEventTypes = [
    Gesture.RIGHT_DRAG,
    Gesture.MIDDLE_DRAG,
    { eventType: Gesture.LEFT_DRAG, modifier: Key.CTRL },
    { eventType: Gesture.LEFT_DRAG, modifier: Key.SHIFT },
    // Cesium reads zoom, rotation and tilt from the same two-finger gesture, so on a small
    // screen a pinch also turns and tilts the view a little. Phones therefore pinch to zoom
    // only, and rotate and tilt with the on-screen buttons.
    ...(isPhone ? [] : [Gesture.PINCH]),
  ];
  controller.enableLook = false; // "look around from the spot" is disorienting on a map
  controller.maximumTiltAngle = toRadians(settings.maxTiltDegrees);
  controller.minimumZoomDistance = settings.minDistanceM;
  controller.maximumZoomDistance = settings.maxDistanceM;

  // A flick of the map keeps it gliding for a moment ("inertia"). A button or key step must not be
  // carried on by the drift of an earlier flick, so steps switch the drift off until the map is
  // touched again (Cesium only lets it drift while these settings are below 1).
  const inertiaOn = (on) => {
    controller.inertiaSpin = on ? settings.inertia : 1;
    controller.inertiaTranslate = on ? settings.inertia : 1;
    controller.inertiaZoom = on ? settings.zoomInertia : 1;
  };
  inertiaOn(true);

  // Touching the map during a glide or a flight takes control back immediately.
  const takeOver = () => {
    stopMoving(viewer);
    inertiaOn(true);
  };
  scene.canvas.addEventListener('pointerdown', takeOver);
  scene.canvas.addEventListener('wheel', takeOver, { passive: true });

  // ---- Steps: what the buttons and keys do ----
  const flattestPitch = -(90 - settings.maxTiltDegrees);
  const viewNow = () => {
    const fallback = fallbackFocus();
    return (
      currentView(viewer, fallback.height) ?? {
        // Looking at the sky: work around the selected zone, seen from no flatter than the tilt limit.
        focus: fallback,
        orientation: { headingDegrees: headingDegrees(viewer), pitchDegrees: clamp(toDegrees(camera.pitch), -90, flattestPitch) },
      }
    );
  };

  // While a step is under way, the next press builds on where that step is going, so quick
  // taps add up (three taps on "+" zoom in three steps) and a held key keeps moving smoothly.
  let step; // the latest glide; `step.active` tells whether it is still under way
  let paused = false; // another view (the cut) has the camera for a while
  const whereNow = () => (step?.active ? step.now : viewNow());
  const whereTo = () => (step?.active ? step.to : whereNow());

  function glideTo(focus, orientation) {
    if (paused) return;
    inertiaOn(false);
    step = glide(viewer, whereNow(), { focus, orientation }, settings.stepSeconds);
  }

  // The buttons and keys stop zooming where the mouse wheel does. In 3D, Cesium keeps the camera
  // at least minDistanceM above the ground, so the closest view depends on how steeply the map is
  // seen: looking straight down the camera can be 25 m from what it looks at, at a flat angle it
  // has to stay further back. In the flat 2D view the limits apply to the width of the view, in
  // map units, which are stretched by 1 / cos(latitude).
  const mapUnitsToMetres = (lat) => Math.cos(toRadians(lat));
  const closestSpan = (pitchDegrees, lat) =>
    is2D(viewer)
      ? settings.minDistanceM * mapUnitsToMetres(lat)
      : (settings.minDistanceM / Math.max(Math.sin(toRadians(-pitchDegrees)), SMALLEST_SINE)) * spanPerRange(viewer);
  const widestSpan = (lat) => (is2D(viewer) ? settings.maxDistanceM * mapUnitsToMetres(lat) : settings.maxDistanceM * spanPerRange(viewer));

  // In the functions below `amount` is the size of the step: 1 for one press of a button or
  // a key, a fraction of that for each repeat a held-down key sends (see "Keyboard").

  /** Zooms in (positive amount) or out, optionally bringing another place to the middle of the screen. */
  function zoom(amount, around) {
    const { focus, orientation } = whereTo();
    const wanted = focus.span * settings.zoomStep ** -amount;
    // A view that is already beyond a limit stays where it is rather than being pulled back.
    const span = clamp(
      wanted,
      Math.min(closestSpan(orientation.pitchDegrees, focus.lat), focus.span),
      Math.max(widestSpan(focus.lat), focus.span),
    );
    glideTo({ ...(around ?? focus), span }, orientation);
  }

  /** Moves the map; `right` and `forward` are steps as seen on screen. */
  function pan(right, forward) {
    const { focus, orientation } = whereTo();
    const distance = focus.span * settings.keyboardPanShare;
    const heading = toRadians(orientation.headingDegrees);
    const east = right * Math.cos(heading) + forward * Math.sin(heading);
    const north = forward * Math.cos(heading) - right * Math.sin(heading);
    const lon = focus.lon + (east * distance) / (METRES_PER_DEGREE * Math.cos(toRadians(focus.lat)));
    const lat = focus.lat + (north * distance) / METRES_PER_DEGREE;
    // The ground there may be higher or lower: look at it, not at the height of the starting point
    // (a camera close to a hillside would otherwise end up inside it after a few steps uphill).
    const ground = is2D(viewer) ? undefined : scene.globe.getHeight(Cesium.Cartographic.fromDegrees(lon, lat));
    glideTo({ ...focus, lon, lat, height: ground ?? focus.height }, orientation);
  }

  /** Changes the direction the map is seen from; the place in the middle of the screen stays put. */
  function reorient(change) {
    if (is2D(viewer)) return;
    const { focus, orientation } = whereTo();
    const next = change(orientation);
    // Seen from a flatter angle at the same distance the camera would end up too low: back off as far as needed.
    const span = next.pitchDegrees > orientation.pitchDegrees ? Math.max(focus.span, closestSpan(next.pitchDegrees, focus.lat)) : focus.span;
    glideTo({ ...focus, span }, next);
  }

  const turn = (amount) => reorient((from) => ({ ...from, headingDegrees: from.headingDegrees + amount * settings.turnStepDegrees }));
  const tilt = (amount) =>
    reorient((from) => ({ ...from, pitchDegrees: clamp(from.pitchDegrees + amount * settings.tiltStepDegrees, -90, flattestPitch) }));

  /** Turns to north the short way round from where the camera is right now. */
  function northUp() {
    const north = 360 * Math.round(whereNow().orientation.headingDegrees / 360);
    reorient((from) => ({ ...from, headingDegrees: north }));
  }

  const actions = {
    zoomIn: () => zoom(1),
    zoomOut: () => zoom(-1),
    turnLeft: () => turn(-1),
    turnRight: () => turn(1),
    tiltFlatter: () => tilt(1),
    tiltSteeper: () => tilt(-1),
    northUp,
  };

  // ---- Double-click: zoom in on the clicked point ----
  viewer.cesiumWidget.screenSpaceEventHandler.setInputAction(({ position }) => {
    if (paused) return;
    const clicked = groundAt(viewer, position, fallbackFocus().height);
    if (!clicked) return;
    const { lon, lat, height } = clicked;
    zoom(1, { lon, lat, height });
  }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

  // ---- Keyboard ----
  const keys = {
    ArrowLeft: (amount, shift) => (shift ? turn(-amount) : pan(-amount, 0)),
    ArrowRight: (amount, shift) => (shift ? turn(amount) : pan(amount, 0)),
    ArrowUp: (amount, shift) => (shift ? tilt(amount) : pan(0, amount)),
    ArrowDown: (amount, shift) => (shift ? tilt(-amount) : pan(0, -amount)),
    '+': (amount) => zoom(amount),
    '=': (amount) => zoom(amount), // the "+" key without Shift on many keyboards
    '-': (amount) => zoom(-amount),
    n: northUp,
    N: northUp,
  };

  // A key held down repeats many times a second. The first press moves one full step; every
  // repeat then moves by the time since the one before, so a held key travels at a steady
  // pace whatever the repeat rate of the keyboard.
  let lastKeyAt = 0;
  window.addEventListener('keydown', (event) => {
    const handle = keys[event.key];
    if (paused || !handle || event.ctrlKey || event.altKey || event.metaKey || usesKeysItself(event.target)) return;
    event.preventDefault();

    const now = performance.now();
    const amount = event.repeat ? (settings.heldKeyStepsPerSecond * Math.min(now - lastKeyAt, LONGEST_REPEAT_MS)) / 1000 : 1;
    lastKeyAt = now;
    handle(amount, event.shiftKey);
  });

  return {
    ...actions,
    /** Stops (or restarts) the buttons, keys and double-click from moving the camera. */
    pause(next) {
      paused = next;
      if (paused) stopMoving(viewer);
    },
  };
}
