/**
 * Camera helpers shared by the 2D/3D switch, the zone navigation and the map controls.
 *
 * A "focus" describes what the camera is looking at, in a way that works in
 * both views:  { lon, lat, height, span }
 *   lon/lat  – the ground point at the centre of the screen (degrees)
 *   height   – ground height there (m), when known
 *   span     – width of ground visible across the screen (m)
 *
 * An "orientation" is the direction it is seen from (3D view only):
 *   { headingDegrees, pitchDegrees }   heading 0 = looking north, pitch -90 = straight down
 *
 * There are three ways to move, and each takes over from whatever was moving the camera before:
 *   lookAt – a jump      flyTo – a flight to another place      glide – a short step
 */
import { Cesium, toDegrees, toRadians } from './cesium.js';

/** Guard against a zero-width view. The real zoom limits are in CONFIG.controls. */
const MIN_SPAN_M = 10;

export const is2D = (viewer) => viewer.scene.mode === Cesium.SceneMode.SCENE2D;

/**
 * Width of ground visible across the screen, per metre of distance to it (3D view).
 * Cesium's field of view (60°) applies to the longer side of the screen, so an
 * upright phone sees a narrower strip than a wide monitor at the same distance.
 */
export function spanPerRange(viewer) {
  const { clientWidth, clientHeight } = viewer.scene.canvas;
  const aspect = clientHeight > 0 ? clientWidth / clientHeight : 1;
  return 2 * Math.tan(toRadians(30)) * Math.min(1, aspect);
}

/** A smooth stand-in for the ground at a given height, for when the real terrain is not loaded yet. */
function groundShell(height) {
  const { x, y, z } = Cesium.Ellipsoid.WGS84.radii;
  return new Cesium.Ellipsoid(x + height, y + height, z + height);
}

/**
 * No real ground lies this far below sea level. While terrain is still loading, Cesium can
 * draw a rough placeholder for a huge area for a frame or two; being flat, it cuts through
 * the globe many kilometres underground, and a hit down there must not be taken for the ground.
 */
const LOWEST_GROUND_M = -500;

/**
 * The ground under a point of the screen, or undefined for the sky.
 * @param {object} windowPosition  Cesium.Cartesian2, in CSS pixels from the top-left of the map
 * @param {number} [groundHint] roughly how high the ground is there (m) – used only while the
 *   terrain at that point has not loaded (e.g. right after jumping to a new place).
 * @returns {{ lon: number, lat: number, height: number, point: object } | undefined}
 *   degrees, metres, and the same place as a Cesium.Cartesian3
 */
export function groundAt(viewer, windowPosition, groundHint = 0) {
  const { scene, camera } = viewer;
  const describe = (point) => {
    const { longitude, latitude, height } = Cesium.Cartographic.fromCartesian(point);
    return { lon: toDegrees(longitude), lat: toDegrees(latitude), height, point };
  };

  const ray = camera.getPickRay(windowPosition);
  const onTerrain = ray && scene.globe.pick(ray, scene);
  if (onTerrain) {
    const ground = describe(onTerrain);
    if (ground.height > LOWEST_GROUND_M) return ground;
  }
  const onShell = camera.pickEllipsoid(windowPosition, groundShell(groundHint));
  return onShell ? describe(onShell) : undefined;
}

/**
 * What the camera is looking at right now, or undefined when it points at the sky.
 * @param {number} [groundHint] see groundAt
 */
export function currentFocus(viewer, groundHint = 0) {
  const { scene, camera } = viewer;

  if (is2D(viewer)) {
    const position = camera.positionCartographic;
    return {
      lon: toDegrees(position.longitude),
      lat: toDegrees(position.latitude),
      height: undefined,
      // The flat map is drawn in Web Mercator units, which are stretched by 1 / cos(latitude).
      span: (camera.frustum.right - camera.frustum.left) * Math.cos(position.latitude),
    };
  }

  const centre = new Cesium.Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);
  const ground = groundAt(viewer, centre, groundHint);
  if (!ground) return undefined;

  const { lon, lat, height, point } = ground;
  return { lon, lat, height, span: Cesium.Cartesian3.distance(camera.positionWC, point) * spanPerRange(viewer) };
}

/** The flat view always looks straight down with north at the top. */
const TOP_DOWN = { headingDegrees: 0, pitchDegrees: -90 };

/** Closer to straight down than this (as a share of the distance), the focus is not seen "from a side" any more. */
const NEARLY_VERTICAL = 1e-3;

/**
 * The view right now: what the camera looks at and the direction it is seen from, or
 * undefined when the camera points at the sky.
 *
 * The direction is measured at the focus, which is what lookAt, flyTo and glide work with.
 * Cesium's own camera.heading and camera.pitch are measured where the camera is; the two
 * drift apart as the camera gets further away (about a degree at 100 km), enough to make
 * the map jump if one were used for the other.
 *
 * @param {number} [groundHint] see groundAt
 * @returns {{ focus: object, orientation: object } | undefined}
 */
export function currentView(viewer, groundHint = 0) {
  const focus = currentFocus(viewer, groundHint);
  if (!focus) return undefined;
  if (is2D(viewer)) return { focus, orientation: TOP_DOWN };

  // Where the camera is, in metres east (x), north (y) and up (z) of the focus.
  const { camera } = viewer;
  const target = Cesium.Cartesian3.fromDegrees(focus.lon, focus.lat, focus.height);
  const toLocal = Cesium.Matrix4.inverseTransformation(Cesium.Transforms.eastNorthUpToFixedFrame(target), new Cesium.Matrix4());
  const eye = Cesium.Matrix4.multiplyByPoint(toLocal, camera.positionWC, new Cesium.Cartesian3());
  const range = Cesium.Cartesian3.magnitude(eye);
  const seenFromTheSide = Math.hypot(eye.x, eye.y) > range * NEARLY_VERTICAL;

  return {
    focus,
    orientation: {
      // Straight above the focus only the camera itself knows which way is up on the screen.
      headingDegrees: seenFromTheSide ? (toDegrees(Math.atan2(-eye.x, -eye.y)) + 360) % 360 : toDegrees(camera.heading),
      pitchDegrees: -toDegrees(Math.asin(Math.min(eye.z / range, 1))),
    },
  };
}

/**
 * From exactly overhead there is no side to see the focus from, and Cesium then turns the
 * view north-up. A tenth of a degree short of vertical looks the same and keeps the heading.
 */
const STEEPEST_PITCH_DEGREES = -89.9;

/** Where the camera should be to look at a focus from a given direction (3D view). */
function tiltedView(viewer, focus, { headingDegrees, pitchDegrees }) {
  const target = Cesium.Cartesian3.fromDegrees(focus.lon, focus.lat, focus.height ?? 0);
  const range = Math.max(focus.span, MIN_SPAN_M) / spanPerRange(viewer);
  const pitch = Math.max(pitchDegrees, STEEPEST_PITCH_DEGREES);
  return { target, offset: new Cesium.HeadingPitchRange(toRadians(headingDegrees), toRadians(pitch), range) };
}

/** Top-down destination for the 2D view: there the camera "height" is the visible width in map units. */
function topDownDestination(focus) {
  const widthInMapUnits = Math.max(focus.span, MIN_SPAN_M) / Math.cos(toRadians(focus.lat));
  return Cesium.Cartesian3.fromDegrees(focus.lon, focus.lat, widthInMapUnits);
}

/** Puts the camera where it sees a focus from a given direction. */
function place(viewer, focus, orientation) {
  const { camera } = viewer;
  if (is2D(viewer)) {
    camera.setView({ destination: topDownDestination(focus) });
  } else {
    const { target, offset } = tiltedView(viewer, focus, orientation);
    camera.lookAt(target, offset);
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY); // release the lock so the user can move freely
  }
  viewer.scene.requestRender();
}

/** The glide under way in each viewer, if any. */
const glides = new WeakMap();

/** Stops whatever is moving the camera on its own (a flight or a glide) and leaves it where it is. */
export function stopMoving(viewer) {
  viewer.camera.cancelFlight();
  glides.get(viewer)?.stop();
}

/** Jumps straight to a focus (no animation). */
export function lookAt(viewer, focus, orientation) {
  stopMoving(viewer);
  place(viewer, focus, orientation);
}

/**
 * Flies smoothly to a focus – for going to another place, such as a zone picked from the list.
 * @param {() => void} [onDone] called once when the flight ends, whether it arrived or was interrupted
 */
export function flyTo(viewer, focus, orientation, onDone, durationSeconds = 1.8) {
  stopMoving(viewer);
  const { camera } = viewer;
  const flight = { duration: durationSeconds, complete: onDone, cancel: onDone };
  if (is2D(viewer)) {
    camera.flyTo({ destination: topDownDestination(focus), ...flight });
  } else {
    const { target, offset } = tiltedView(viewer, focus, orientation);
    camera.flyToBoundingSphere(new Cesium.BoundingSphere(target, 0), { offset, ...flight });
  }
}

const mix = (from, to, share) => from + (to - from) * share;

/** Quick off the mark, soft on arrival (0 to 1 in, 0 to 1 out). */
const easeOut = (progress) => 1 - (1 - progress) ** 3;

/** The view a share (0 to 1) of the way from one view to another. */
function viewBetween(from, to, share) {
  return {
    focus: {
      lon: mix(from.focus.lon, to.focus.lon, share),
      lat: mix(from.focus.lat, to.focus.lat, share),
      height: mix(from.focus.height ?? 0, to.focus.height ?? 0, share),
      span: from.focus.span * (to.focus.span / from.focus.span) ** share, // zooming is a ratio, not a difference
    },
    orientation: {
      headingDegrees: mix(from.orientation.headingDegrees, to.orientation.headingDegrees, share),
      pitchDegrees: mix(from.orientation.pitchDegrees, to.orientation.pitchDegrees, share),
    },
  };
}

/**
 * Moves the camera from one view to another in a short step – for buttons and keys.
 * A "view" is { focus, orientation }.
 *
 * Unlike a flight, a glide turns around the place being looked at instead of cutting across
 * it, and takes headings as given: from 350° to 380° turns 30° to the right, not 330° back.
 *
 * @param {number} seconds how long the step takes
 * @returns {{ now: object, to: object, active: boolean }} the step: `now` is the view at the
 *   latest frame, `to` the view it ends at; `active` turns false once it has ended or been interrupted
 */
export function glide(viewer, from, to, seconds) {
  stopMoving(viewer);

  const { scene } = viewer;
  const startedAt = performance.now();
  const step = {
    now: from,
    to,
    active: true,
    stop() {
      if (!step.active) return;
      step.active = false;
      glides.delete(viewer);
      stopListening();
    },
  };

  // Cesium raises this on every frame of the page, whether or not it was going to draw one.
  const stopListening = scene.preUpdate.addEventListener(() => {
    const progress = seconds > 0 ? Math.min((performance.now() - startedAt) / (seconds * 1000), 1) : 1;
    step.now = progress < 1 ? viewBetween(from, to, easeOut(progress)) : to;
    place(viewer, step.now.focus, step.now.orientation);
    if (progress === 1) step.stop();
  });

  glides.set(viewer, step);
  scene.requestRender();
  return step;
}

/** Current camera heading in degrees (0 = looking north). */
export const headingDegrees = (viewer) => toDegrees(viewer.camera.heading);
