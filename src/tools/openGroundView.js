/**
 * The open-ground view: the whole map with the ground opened up. Like the excavation view, but
 * not a pit: wherever you look, what lies in the ground round that place is drawn with its own
 * shape at its depth (groundShapes.js: pipes as tubes, manholes as shafts, valves, hydrants,
 * fittings…), under a ground turned see-through. Moving the map moves the place with it.
 *
 * It sits on top of the underground view (map/undergroundView.js), which stays as it is: that
 * view draws every pipe of the zone as a line at its depth; this one adds the real shapes round
 * where you look – the line of a pipe runs inside its tube – so far away the lines carry on.
 * Depths are drawn as many times deeper as the underground view is set to (×1 to ×5).
 *
 * The shapes are built in the background and swapped in when ready; small things (fittings,
 * meters, tobies) and labels only near the middle, to keep phones smooth.
 *
 * The camera goes round the place in the middle of the screen (360°, and below the ground to look
 * up at the pipes from underneath): drag to go round, pinch to get closer, double-tap to move.
 *
 * "Face-on" (one more button): the ground is cut straight across what you are looking at, as wide
 * as the screen, and you stand in front of the cut, looking straight at it: the earth wall behind
 * with its depth lines, and in front of it everything that lies within a chosen distance behind
 * the cut. The round buttons then slide the cut along, step it forward or back and make it wider
 * or narrower; dragging walks round it, as round the pit.
 */
import { Cesium, toDegrees, toRadians } from '../map/cesium.js';
import { currentView, groundAt, lookAt, spanPerRange, stopMoving } from '../map/camera.js';
import { renderUntil } from '../map/render.js';
import { cutFrame, depthAt, diameterM } from '../layers/pipeGeometry.js';
import { collectInBox, FLOOR_COLOR, makeShapes, shapeKit, SOIL, streetDirection, SURFACE_COLOR } from './groundShapes.js';
import { createLabelDeclutter } from '../map/labelDeclutter.js';

const INK = '#13232f';

/**
 * @param {object} options
 * @param {object} options.viewer
 * @param {(lonLat: number[]) => Promise<Float64Array>} options.sampleGround
 * @param {object[]} options.networks       the network layers (cutSource, isShown, pipeColor, setSuspended)
 * @param {object[]} options.suspendable    layers hidden meanwhile (the buildings: they would stand in the way)
 * @param {object} options.undergroundView  from createUndergroundView
 * @param {{ pause: (paused: boolean) => void }} options.controls
 * @param {object} options.settings         CONFIG.openGround
 * @param {object} options.shapeSettings    CONFIG.excavation (sizes and labels of the shapes)
 * @param {boolean} options.isPhone
 * @param {() => object} options.fallbackFocus
 * @param {string} options.highlightColor   the colour of the thing tapped
 * @param {(active: boolean) => void} [options.onChange]
 * @param {(faceOn: boolean) => void} [options.onFaceChange]
 * @param {(text: string) => void} [options.onNote]  what is drawn, in a few words
 */
export function createOpenGroundView({ viewer, sampleGround, networks, suspendable, undergroundView, controls, settings, shapeSettings, isPhone, fallbackFocus, highlightColor, onChange, onFaceChange, onNote }) {
  const { scene, camera } = viewer;
  const controller = scene.screenSpaceCameraController;
  const declutter = createLabelDeclutter(scene); // labels that would pile up give way to each other
  const highlightColour = Cesium.Color.fromCssColorString(highlightColor);
  const device = isPhone ? 'phone' : 'desktop';
  const reach = settings.radiusM[device];

  let active = false;
  let wasUnderground = false;
  let stretch = 1;
  let drawn; // { collection, labels, parts, centre, half }
  let run = 0;
  let selected; // the key of the thing tapped (see keyOf), shown highlighted
  let face; // face-on: { centre, heading, width, target, saved }
  let faceBack = settings.face.backM; // how far behind the cut things are drawn

  /** One key per pipe or asset, whichever piece or part of it was tapped. */
  const keyOf = (id) => id && `${id.layer}:${id.zone}:${id.asset !== undefined ? `asset ${id.asset}` : id.index}`;
  const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

  /** Long pieces of pipe are cut into shorter ones, so that each follows the ground it lies under. */
  function followGround(pieces, frame) {
    const shorter = [];
    for (const piece of pieces) {
      const [ax, ay] = frame.toCut([piece.from.lon, piece.from.lat]);
      const [bx, by] = frame.toCut([piece.to.lon, piece.to.lat]);
      const count = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / settings.followGroundEveryM));
      const at = (t) => ({
        lon: piece.from.lon + (piece.to.lon - piece.from.lon) * t,
        lat: piece.from.lat + (piece.to.lat - piece.from.lat) * t,
        share: piece.from.share + (piece.to.share - piece.from.share) * t,
      });
      // One depth label per piece, on its middle part.
      for (let i = 0; i < count; i += 1) shorter.push({ ...piece, from: at(i / count), to: at((i + 1) / count), quiet: i !== Math.floor(count / 2) });
    }
    return shorter;
  }

  /** A fresh set of shapes and labels being put together: what both ways of drawing share. */
  function startDrawing(labelsWithinM) {
    const collection = new Cesium.PrimitiveCollection();
    const labels = new Cesium.LabelCollection();
    const parts = new Map(); // key -> { shapes: [{ primitive, id, colour }], labels: [] }
    const waitFor = []; // primitives built in the background
    const partsOf = (id) => {
      const key = keyOf(id);
      if (!parts.has(key)) parts.set(key, { shapes: [], labels: [] });
      return parts.get(key);
    };
    // Labels are drawn over the shapes (the ground is see-through anyway): a manhole in front would cut
    // through the letters. Where they would pile up, they give way to each other (labelDeclutter.js).
    const label = (position, text, id, { size = 12, colour: css = INK, near = labelsWithinM, onTop = true } = {}) => {
      const made = labels.add({
        id,
        position,
        text,
        font: `700 ${size}px system-ui, sans-serif`,
        fillColor: Cesium.Color.fromCssColorString(css),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -8),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, near),
        disableDepthTestDistance: onTop ? Number.POSITIVE_INFINITY : 0,
      });
      if (id) partsOf(id).labels.push(made);
      return made;
    };
    /** Shapes that can be tapped and highlighted, built in the background. */
    const shapes = (instances, appearance) => {
      if (!instances.length) return;
      const primitive = collection.add(new Cesium.Primitive({ geometryInstances: instances, appearance, asynchronous: true }));
      waitFor.push(primitive);
      for (const instance of instances) partsOf(instance.id).shapes.push({ primitive, id: instance.id, colour: Uint8Array.from(instance.attributes.color.value) });
    };
    const things = ({ tubes, solid, seeThrough }) => {
      shapes([...tubes, ...solid], new Cesium.PerInstanceColorAppearance({ translucent: false, closed: true }));
      shapes(seeThrough, new Cesium.PerInstanceColorAppearance({ translucent: true, closed: true }));
    };
    return { collection, labels, parts, label, things, waitFor };
  }

  /**
   * Shows a finished drawing in place of the one before, once its shapes are ready.
   * @returns {Promise<boolean>} false when another drawing was asked for meanwhile
   */
  async function swapIn(thisRun, drawing, extra) {
    scene.primitives.add(drawing.collection); // under the old one, which stays until this one can be shown
    await renderUntil(scene, () => thisRun !== run || !active || drawing.waitFor.every((primitive) => primitive.ready), settings.buildTimeoutMs);
    if (thisRun !== run || !active) {
      scene.primitives.remove(drawing.collection);
      return false;
    }
    clear();
    scene.primitives.add(drawing.labels);
    declutter.watch(drawing.labels);
    drawn = { collection: drawing.collection, labels: drawing.labels, parts: drawing.parts, ...extra };
    if (selected) paint(selected, true);
    scene.requestRender();
    return true;
  }

  /** Ground heights for a list of [lon, lat, lon, lat…]; where one is not known, a typical one. */
  async function groundHeightsAt(lonLat) {
    const heights = await sampleGround(lonLat);
    const known = [...heights].filter(Number.isFinite);
    const typical = known.length ? known.reduce((sum, h) => sum + h, 0) / known.length : (fallbackFocus().height ?? 300);
    return (i) => (Number.isFinite(heights[i]) ? heights[i] : typical);
  }

  // ---------------------------------------------------------------- round where you look

  /** Builds the shapes round a place and swaps them in when they are ready to show. */
  async function build(centre, wanted) {
    const thisRun = (run += 1);
    const frame = cutFrame(centre, 0);

    // Everything round the place; a smaller square where there is too much for one go.
    let half = wanted;
    let found;
    for (;;) {
      found = collectInBox(networks, frame, { left: -half, right: half, front: -half, back: half });
      found.pieces = followGround(found.pieces, frame);
      if (found.pieces.length <= settings.maxPieces || half <= settings.minRadiusM) break;
      half = Math.max(settings.minRadiusM, half * 0.75);
    }
    const { pieces, assets } = found;

    // Ground heights at the ends of every piece and at every asset.
    const lonLat = [];
    for (const piece of pieces) lonLat.push(piece.from.lon, piece.from.lat, piece.to.lon, piece.to.lat);
    for (const { asset } of assets) lonLat.push(...asset.geometry.coordinates.slice(0, 2));
    const ground = await groundHeightsAt(lonLat);
    if (thisRun !== run || !active || face) return;

    // Small things and labels only near the middle.
    const detail = Math.min(settings.detailWithinM, half);
    const drawing = startDrawing(shapeSettings.labelsWithinM);
    drawing.things(
      makeShapes({
        pieces,
        assets,
        frame,
        kit: shapeKit(0, { tubeSides: settings.tubeSides, slices: settings.slices }),
        stretch,
        pieceGround: (number, end) => ground(2 * number + end),
        assetGround: (number) => ground(2 * pieces.length + number),
        settings: shapeSettings,
        label: drawing.label,
        siteOutlines: true, // pump stations, reservoirs…: their outline, a fence and their name
        isNear: (place) => Math.hypot(...frame.toCut(place)) <= detail,
      }),
    );
    if (!(await swapIn(thisRun, drawing, { centre, half }))) return;

    const pipes = new Set(pieces.map((piece) => `${piece.network.id}:${piece.index}`)).size;
    const manholes = assets.filter(({ asset }) => asset.properties.kind === 'manhole').length;
    onNote?.(
      `Real shapes within ${Math.round(half)} m: ${plural(pipes, 'pipe')}${manholes ? `, ${plural(manholes, 'manhole')}` : ''}` +
        (stretch > 1 ? ` · depths ×${stretch}` : '') +
        ' · drag to go round (also from below), double-tap to move there',
    );
  }

  /** Brings the shapes to where the camera looks now. `force`: also when it has hardly moved. */
  function update(force = false) {
    if (!active || face) return;
    const view = lookingAt();
    if (!view) return; // looking at the sky: what is drawn stays
    const { focus } = view;
    const range = focus.span / spanPerRange(viewer);
    if (range > settings.maxRangeM) {
      // From this far the shapes would be thinner than the lines: nothing to build.
      if (!drawn) onNote?.('Get closer to see the real shapes of what is in the ground.');
      return;
    }
    // As wide as what is in view, within limits.
    const half = Math.min(reach, Math.max(settings.minRadiusM, range * settings.radiusPerRange));
    if (!force && drawn) {
      const [x, y] = cutFrame(drawn.centre, 0).toCut([focus.lon, focus.lat]);
      if (Math.hypot(x, y) < drawn.half * settings.rebuildShare && half <= drawn.half * 1.3) return;
    }
    build({ lon: focus.lon, lat: focus.lat }, half);
  }

  camera.moveEnd.addEventListener(() => update());

  // ---------------------------------------------------------------- going round (360°)
  /*
   * In the open ground the camera goes round the place in the middle of the screen, as round the
   * pit: drag to go round it – all the way round, and down below the ground to look up at the pipes
   * from underneath – pinch or wheel to get closer, double-tap a place to go there. The round
   * buttons do the same in steps. (Face-on has its own camera; flights to a zone let go of it.)
   */
  let orbit; // { target: Cartesian3, height, saved: { closest, farthest } }
  let doubleTap; // the handler of double taps while going round
  let orbitMove; // a step or a move under way: { stop() }

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

  /** Where the camera is round the target: heading and pitch (radians, as for HeadingPitchRange) and range (m). */
  function offsetNow() {
    // While going round, the camera's position is in metres east, north and up of the target.
    const { x, y, z } = camera.position;
    const range = Math.hypot(x, y, z) || 1;
    return { heading: Math.atan2(-x, -y), pitch: -Math.asin(clamp(z / range, -1, 1)), range };
  }

  /** The place being gone round, as the open ground builds round it: { lon, lat, height, span }. */
  function orbitFocus() {
    const { longitude, latitude } = Cesium.Cartographic.fromCartesian(orbit.target);
    return { lon: toDegrees(longitude), lat: toDegrees(latitude), height: orbit.height, span: offsetNow().range * spanPerRange(viewer) };
  }

  /** What the camera looks at and from where: the place gone round, or else the middle of the screen. */
  function lookingAt() {
    if (orbit) {
      const { heading, pitch } = offsetNow();
      return { focus: orbitFocus(), orientation: { headingDegrees: toDegrees(heading), pitchDegrees: toDegrees(pitch) } };
    }
    return currentView(viewer, fallbackFocus().height);
  }

  /** Animates the camera round the target over `seconds`: `at(t)` gives { target, offset } for t from 0 to 1. */
  function animate(seconds, at, done) {
    orbitMove?.stop();
    const started = performance.now();
    const ease = (t) => 1 - (1 - t) ** 3;
    let stopped = false;
    const stopListening = scene.preUpdate.addEventListener(() => {
      if (stopped || !orbit) return;
      const t = Math.min(1, (performance.now() - started) / (seconds * 1000));
      const { target, offset } = at(ease(t));
      orbit.target = target;
      camera.lookAt(target, offset);
      if (t === 1) {
        move.stop();
        done?.();
      } else {
        scene.requestRender();
      }
    });
    const move = {
      stop() {
        if (stopped) return;
        stopped = true;
        stopListening();
        if (orbitMove === move) orbitMove = undefined;
      },
    };
    orbitMove = move;
    scene.requestRender();
  }

  function startOrbit() {
    if (!active || face || orbit) return;
    stopMoving(viewer);
    const fallback = fallbackFocus();
    const view = currentView(viewer, fallback.height);
    const focus = view?.focus ?? fallback;
    const height = Number.isFinite(focus.height) ? focus.height : (fallback.height ?? 300);
    const target = Cesium.Cartesian3.fromDegrees(focus.lon, focus.lat, height);
    const orientation = view?.orientation ?? { headingDegrees: toDegrees(camera.heading), pitchDegrees: -35 };
    const range = clamp(Cesium.Cartesian3.distance(camera.positionWC, target), settings.orbit.closestM, settings.orbit.farthestM);
    orbit = { target, height, saved: { closest: controller.minimumZoomDistance, farthest: controller.maximumZoomDistance } };
    controls.pause(true); // the map's own steps and keys would move the camera away from the place
    controller.minimumZoomDistance = settings.orbit.closestM;
    controller.maximumZoomDistance = settings.orbit.farthestM;
    camera.lookAt(target, new Cesium.HeadingPitchRange(toRadians(orientation.headingDegrees), toRadians(orientation.pitchDegrees), range));

    // A double tap on the ground: go round that place instead, from the same side and distance.
    doubleTap = new Cesium.ScreenSpaceEventHandler(scene.canvas);
    doubleTap.setInputAction(({ position }) => {
      if (!orbit) return;
      const ground = groundAt(viewer, position, orbit.height);
      if (ground) moveOrbitTo(ground);
    }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    scene.requestRender();
  }

  /**
   * Stops going round; the camera stays where it is.
   * @param {boolean} [backAbove]  a camera below the ground (looking up) comes back above it first
   */
  function stopOrbit(backAbove = false) {
    if (!orbit) return;
    orbitMove?.stop();
    const { heading, pitch } = offsetNow();
    const focus = orbitFocus();
    const { saved } = orbit;
    orbit = undefined;
    doubleTap?.destroy();
    doubleTap = undefined;
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    controller.minimumZoomDistance = saved.closest;
    controller.maximumZoomDistance = saved.farthest;
    controls.pause(false);
    if (backAbove && toDegrees(pitch) > settings.orbit.backAboveFromDegrees) {
      lookAt(viewer, focus, { headingDegrees: toDegrees(heading), pitchDegrees: settings.orbit.backAbovePitchDegrees });
    }
  }

  /** Goes round another place: the camera glides over, keeping its side and distance. */
  function moveOrbitTo({ lon, lat, height }) {
    const from = orbit.target;
    const to = Cesium.Cartesian3.fromDegrees(lon, lat, height);
    const { heading, pitch, range } = offsetNow();
    const offset = new Cesium.HeadingPitchRange(heading, pitch, range);
    orbit.height = height;
    animate(settings.orbit.moveSeconds, (t) => ({ target: Cesium.Cartesian3.lerp(from, to, t, new Cesium.Cartesian3()), offset }), () => update(true));
  }

  /** The round buttons while going round: turn (±1), lean over or under (±1), get closer (±1), north up. */
  function stepOrbit({ turn = 0, tilt = 0, zoom = 0, north = false }) {
    if (!orbit) return;
    const from = offsetNow();
    const heading = north ? 2 * Math.PI * Math.round(from.heading / (2 * Math.PI)) : from.heading + toRadians(turn * settings.orbit.turnStepDegrees);
    const pitch = clamp(from.pitch + toRadians(tilt * settings.orbit.tiltStepDegrees), toRadians(-89.5), toRadians(settings.orbit.highestPitchDegrees));
    const range = clamp(from.range * settings.orbit.zoomFactor ** -zoom, settings.orbit.closestM, settings.orbit.farthestM);
    const target = orbit.target;
    const mix = (a, b, t) => a + (b - a) * t;
    animate(
      settings.orbit.stepSeconds,
      (t) => ({ target, offset: new Cesium.HeadingPitchRange(mix(from.heading, heading, t), mix(from.pitch, pitch, t), mix(from.range, range, t)) }),
      () => update(),
    );
  }

  // After a flight to another zone (which let go of the camera), go round where it arrived.
  camera.moveEnd.addEventListener(() => {
    if (active && !face && !orbit) startOrbit();
  });

  // ---------------------------------------------------------------- face-on

  /**
   * Builds the cut: the slab of ground behind it with everything in it, the earth wall at its back.
   * @param {'first' | 'keep'} cameraMove  where the camera goes once it is drawn: to the first view,
   *   or it keeps the direction and distance it has (after sliding or stepping the cut)
   */
  async function buildFace(cameraMove) {
    const thisRun = (run += 1);
    const { centre, heading, width } = face;
    const back = faceBack;
    const frame = cutFrame(centre, heading);
    const halfWidth = width / 2;
    const found = collectInBox(networks, frame, { left: -halfWidth, right: halfWidth, front: 0, back });
    const pieces = followGround(found.pieces, frame);
    const { assets } = found;

    // How deep the wall goes: below the deepest thing in the slab (bores and facilities do not count).
    let deepest = 0;
    for (const piece of pieces) {
      const p = piece.feature.properties;
      deepest = Math.max(deepest, depthAt(p, piece.from.share).centre + diameterM(p) / 2, depthAt(p, piece.to.share).centre + diameterM(p) / 2);
    }
    for (const { asset } of assets) if (!['bore', 'facility'].includes(asset.properties.kind)) deepest = Math.max(deepest, asset.properties.depth.at[0]);
    const maxDepth = Math.min(shapeSettings.maxDepthM, Math.max(shapeSettings.minDepthM, Math.ceil(deepest + 0.4)));

    // Ground heights: along the back and the front of the slab, at every piece and asset.
    const steps = Math.max(2, Math.round(width / settings.face.wallStepM));
    const across = Array.from({ length: steps + 1 }, (_, i) => -halfWidth + (width * i) / steps);
    const lonLat = [];
    for (const x of across) lonLat.push(...frame.toLonLat([x, back]));
    for (const x of across) lonLat.push(...frame.toLonLat([x, 0]));
    const pieceBase = 2 * across.length;
    for (const piece of pieces) lonLat.push(piece.from.lon, piece.from.lat, piece.to.lon, piece.to.lat);
    const assetBase = pieceBase + 2 * pieces.length;
    for (const { asset } of assets) lonLat.push(...asset.geometry.coordinates.slice(0, 2));
    const ground = await groundHeightsAt(lonLat);
    if (thisRun !== run || !active || !face) return;
    const backGround = (i) => ground(i);
    const frontGround = (i) => ground(across.length + i);
    const last = across.length - 1;

    const range = cameraMove === 'keep' && face.target ? Cesium.Cartesian3.distance(camera.positionWC, face.target) : (width / spanPerRange(viewer)) * settings.face.rangeShare;
    // Labels show from where the camera stands, unless the cut is so wide that they would pile up.
    const drawing = startDrawing(width <= settings.face.labelsUpToWidthM ? Math.max(shapeSettings.labelsWithinM, range * 1.5) : shapeSettings.labelsWithinM);
    const kit = shapeKit(heading);
    const { colour } = kit;
    const place = (x, y, height) => Cesium.Cartesian3.fromDegrees(...frame.toLonLat([x, y]), height);

    // ---- the earth: the wall at the back and the two ends in layers, the floor (which runs on towards the viewer)
    const earth = [];
    const wall = (points, groundOf) => {
      let top = 0;
      for (const layer of SOIL) {
        const bottom = Math.min(layer.to, maxDepth);
        if (bottom <= top) continue;
        earth.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.WallGeometry({
              positions: points.map(([x, y]) => place(x, y, 0)),
              maximumHeights: points.map((_, i) => groundOf(i) - stretch * top),
              minimumHeights: points.map((_, i) => groundOf(i) - stretch * bottom),
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            attributes: { color: colour(layer.color) },
          }),
        );
        top = bottom;
      }
    };
    wall(across.map((x) => [x, back]), backGround);
    wall([[-halfWidth, 0], [-halfWidth, back]], (i) => (i === 0 ? frontGround(0) : backGround(0)));
    wall([[halfWidth, 0], [halfWidth, back]], (i) => (i === 0 ? frontGround(last) : backGround(last)));
    const apron = range * settings.face.apronShare; // the floor carries on this far in front of the cut
    const floorAt = (x, y, groundHere) => place(x, y, groundHere - stretch * maxDepth);
    earth.push(
      new Cesium.GeometryInstance({
        geometry: new Cesium.PolygonGeometry({
          polygonHierarchy: new Cesium.PolygonHierarchy([
            floorAt(-halfWidth, -apron, frontGround(0)),
            floorAt(halfWidth, -apron, frontGround(last)),
            floorAt(halfWidth, back, backGround(last)),
            floorAt(-halfWidth, back, backGround(0)),
          ]),
          perPositionHeight: true,
          vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        attributes: { color: colour(FLOOR_COLOR) },
      }),
    );
    drawing.collection.add(new Cesium.Primitive({ geometryInstances: earth, appearance: new Cesium.PerInstanceColorAppearance({ translucent: false, closed: false }), asynchronous: false }));

    // Depth lines a hair in front of the back wall, the edge of the street along its top, and the depth scale at one end.
    const depthLine = (depth, lineWidth, css, alpha) =>
      new Cesium.GeometryInstance({
        geometry: new Cesium.PolylineGeometry({
          positions: across.map((x, i) => place(x, back - 0.03, backGround(i) - stretch * depth)),
          width: lineWidth,
          arcType: Cesium.ArcType.NONE,
          vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
        }),
        attributes: { color: colour(css, alpha) },
      });
    const step = maxDepth <= 3 ? 0.5 : 1;
    const lines = [depthLine(0, 3, SURFACE_COLOR, 1)];
    for (let depth = step; depth <= maxDepth + 1e-9; depth += step) lines.push(depthLine(depth, 1, INK, 0.35));
    drawing.collection.add(new Cesium.Primitive({ geometryInstances: lines, appearance: new Cesium.PolylineColorAppearance({ translucent: true }), asynchronous: false }));
    for (let depth = 0; depth <= maxDepth + 1e-9; depth += step) {
      drawing.label(place(-halfWidth + width * 0.02, back - 0.1, backGround(0) - stretch * depth), depth === 0 ? 'Ground 0 m' : `${depth} m`, undefined, { size: 11, near: range * 6, onTop: true });
    }

    // ---- everything in the slab, with its own shape
    drawing.things(
      makeShapes({
        pieces,
        assets,
        frame,
        kit,
        stretch,
        pieceGround: (number, end) => ground(pieceBase + 2 * number + end),
        assetGround: (number) => ground(assetBase + number),
        settings: shapeSettings,
        label: drawing.label,
        siteOutlines: true, // pump stations, reservoirs…: their outline, a fence and their name
      }),
    );
    if (!(await swapIn(thisRun, drawing, { centre, half: halfWidth }))) return;

    // The ground over the slab – and in front of it, up to where the viewer stands – is taken away.
    const forward = new Cesium.Cartesian3(Math.sin(toRadians(heading)), Math.cos(toRadians(heading)), 0);
    const right = new Cesium.Cartesian3(Math.cos(toRadians(heading)), -Math.sin(toRadians(heading)), 0);
    const opposite = (direction) => Cesium.Cartesian3.negate(direction, new Cesium.Cartesian3());
    scene.globe.clippingPlanes = new Cesium.ClippingPlaneCollection({
      modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(centre.lon, centre.lat, 0)),
      planes: [
        new Cesium.ClippingPlane(forward, -back),
        new Cesium.ClippingPlane(opposite(forward), -apron),
        new Cesium.ClippingPlane(right, -halfWidth),
        new Cesium.ClippingPlane(opposite(right), -halfWidth),
      ],
      unionClippingRegions: false,
      edgeWidth: 1.5,
      edgeColor: Cesium.Color.fromCssColorString(SURFACE_COLOR),
    });

    // Stand in front of the cut, looking straight at the middle of the wall.
    const middle = Math.round(last / 2);
    face.target = place(0, back / 2, (frontGround(middle) + backGround(middle)) / 2 - (stretch * maxDepth) / 2);
    const turned = cameraMove === 'keep';
    camera.lookAt(face.target, new Cesium.HeadingPitchRange(turned ? camera.heading : toRadians(heading), turned ? camera.pitch : toRadians(settings.face.pitchDegrees), range));
    scene.requestRender();

    const pipes = new Set(pieces.map((piece) => `${piece.network.id}:${piece.index}`)).size;
    const manholes = assets.filter(({ asset }) => asset.properties.kind === 'manhole').length;
    onNote?.(
      `A cut ${Math.round(width)} m wide · ${plural(pipes, 'pipe')}${manholes ? `, ${plural(manholes, 'manhole')}` : ''}` +
        (stretch > 1 ? ` · depths ×${stretch}` : ' · true scale') +
        ' · buttons: turn = slide along, tilt = forward or back, + − = width',
    );
  }

  function enterFace() {
    if (!active || face) return;
    const view = lookingAt();
    stopOrbit();
    stopMoving(viewer);
    const fallback = fallbackFocus();
    const focus = view?.focus ?? { lon: fallback.lon, lat: fallback.lat, height: fallback.height, span: settings.face.widthM[device] };
    const looking = view?.orientation.headingDegrees ?? toDegrees(camera.heading);
    // Along the street or across it, whichever is nearer to the way one is looking.
    const street = streetDirection(networks, focus, looking, shapeSettings.alignWithinM);
    const turn = (direction) => Math.abs(((direction - looking + 540) % 360) - 180);
    const heading = [street, street + 90, street - 90].reduce((best, direction) => (turn(direction) < turn(best) ? direction : best));
    face = {
      centre: { lon: focus.lon, lat: focus.lat },
      heading: (heading + 360) % 360,
      width: Math.min(settings.face.maxWidthM[device], Math.max(settings.face.minWidthM, Math.min(focus.span * 0.8, settings.face.widthM[device]))),
      saved: { span: focus.span, orientation: view?.orientation ?? { headingDegrees: looking, pitchDegrees: -35 }, minimumZoom: controller.minimumZoomDistance },
    };
    controls.pause(true);
    controller.minimumZoomDistance = shapeSettings.closestM;
    for (const network of networks) network.setSuspended(true); // the lines of the zone would cross the view
    onNote?.('Cutting the ground…');
    onFaceChange?.(true);
    buildFace('first');
  }

  /** @param {boolean} [carryOn]  back to the shapes round where one looks (false when the whole view is being left) */
  function exitFace(carryOn = true) {
    if (!face) return;
    const { centre, saved, target } = face;
    face = undefined;
    run += 1;
    scene.globe.clippingPlanes = undefined;
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    controller.minimumZoomDistance = saved.minimumZoom;
    for (const network of networks) network.setSuspended(false);
    controls.pause(false);
    // Back to the kind of view there was before, over where the cut is now.
    const height = target ? Cesium.Cartographic.fromCartesian(target).height : fallbackFocus().height;
    lookAt(viewer, { lon: centre.lon, lat: centre.lat, height, span: saved.span }, saved.orientation);
    onFaceChange?.(false);
    if (carryOn) {
      clear();
      startOrbit();
      update(true);
    }
  }

  /** Moves the cut (in metres across and forward) or changes its width, and draws it again. */
  function moveFace(across, forward, widthFactor = 1) {
    if (!face) return;
    const [lon, lat] = cutFrame(face.centre, face.heading).toLonLat([across, forward]);
    face.centre = { lon, lat };
    face.width = Math.min(settings.face.maxWidthM[device], Math.max(settings.face.minWidthM, face.width * widthFactor));
    buildFace(widthFactor === 1 ? 'keep' : 'first');
  }

  // ---------------------------------------------------------------- shared

  function clear() {
    if (!drawn) return;
    scene.primitives.remove(drawn.collection);
    declutter.watch(undefined);
    scene.primitives.remove(drawn.labels);
    drawn = undefined;
  }

  /** Shows a thing highlighted (or back to its own colours): its shapes turn yellow, its label turns dark. */
  function paint(key, on) {
    const thing = drawn?.parts.get(key);
    if (!thing) return;
    for (const { primitive, id, colour } of thing.shapes) {
      const attributes = primitive.ready && primitive.getGeometryInstanceAttributes(id);
      if (attributes) attributes.color = on ? Cesium.ColorGeometryInstanceAttribute.toValue(highlightColour.withAlpha(colour[3] / 255)) : colour;
    }
    for (const made of thing.labels) {
      made.showBackground = on;
      made.backgroundColor = Cesium.Color.fromCssColorString(INK);
      made.fillColor = on ? highlightColour : Cesium.Color.fromCssColorString(INK);
      made.outlineWidth = on ? 0 : 3;
    }
    declutter.refresh(); // the label of the thing tapped always shows
  }

  function enter() {
    if (active) return;
    active = true;
    wasUnderground = undergroundView.on;
    undergroundView.set(true);
    for (const layer of suspendable) layer.setSuspended(true);
    onNote?.('Opening the ground…');
    onChange?.(true);
    startOrbit();
    update(true);
  }

  /** @param {boolean} [keepUnderground]  stay in the plain underground view (lines only) */
  function exit(keepUnderground = wasUnderground) {
    if (!active) return;
    exitFace(false);
    stopOrbit(true);
    active = false;
    run += 1;
    clear();
    for (const layer of suspendable) layer.setSuspended(false);
    if (!keepUnderground) undergroundView.set(false);
    scene.requestRender();
    onChange?.(false);
  }

  /** Draws again what is drawn now (the shapes round where one looks, or the cut). */
  const redraw = () => (face ? buildFace('keep') : update(true));

  return {
    enter,
    exit,
    toggle: () => (active ? exit() : enter()),
    get active() {
      return active;
    },
    /** Whether the camera is going round a place (the round buttons then step round it, see stepOrbit). */
    get orbiting() {
      return Boolean(orbit);
    },
    stepOrbit,
    /** Lets go of the camera for a flight elsewhere; once it arrives the camera goes round the new place. */
    releaseCamera: () => stopOrbit(),
    /** Draws again at the same place (a network switched on or off, a zone that finished loading, other years). */
    refresh: () => active && redraw(),
    /** Depths (and pipe sizes) drawn this many times deeper; the same figure the underground view uses. */
    setDepthScale(next) {
      if (next === stretch) return;
      stretch = next;
      if (active) redraw();
    },
    /** The thing tapped (an id from picking), or undefined: shown highlighted. */
    highlight(id) {
      const key = keyOf(id);
      if (key === selected) return;
      if (selected) paint(selected, false);
      selected = key;
      if (selected && active) paint(selected, true);
    },

    // ---- face-on
    get faceOn() {
      return Boolean(face);
    },
    setFace: (on) => (on ? enterFace() : exitFace()),
    /** How far behind the cut things are drawn (metres). */
    setBack(metres) {
      faceBack = metres;
      if (face) buildFace('keep');
    },
    /** The round buttons while face-on: slide the cut along (−1 left, 1 right)… */
    slide: (direction) => face && moveFace(direction * face.width * settings.face.slideShare, 0),
    /** …step it forward (1) or back (−1) by what is drawn behind it… */
    step: (direction) => moveFace(0, direction * faceBack),
    /** …make it narrower (1: closer) or wider (−1)… */
    zoom: (direction) => moveFace(0, 0, direction > 0 ? 1 / settings.face.zoomFactor : settings.face.zoomFactor),
    /** …and stand straight in front of it again. */
    straighten: () => face && buildFace('first'),
  };
}
