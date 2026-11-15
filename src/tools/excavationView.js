/**
 * The excavation view: a block of ground is dug out where you are looking, like a pit on a
 * building site, and you can walk all the way round it (360°), lean over it and get closer.
 *
 * Inside the pit everything is drawn with its own shape, at its depth: pipes as tubes, manholes as
 * shafts, valves, hydrants, tobies, fittings… (the shapes are in groundShapes.js and excavationFittings.js).
 * The walls of the pit show the ground layers (illustrative), depth lines and a depth scale.
 * Tap anything for its details.
 *
 * One button in and out; nothing to pick. Near a street the pit lines up with the street.
 * Depths are stretched when the pit would otherwise look too shallow to read (the stretch is
 * always shown); sizes across stay true.
 *
 * What is drawn is built once for the place dug; the normal drawings of the networks and the
 * buildings are hidden meanwhile, and the ground inside the pit is cut away.
 */
import { Cesium, toDegrees, toRadians } from '../map/cesium.js';
import { currentView, stopMoving } from '../map/camera.js';
import { cutFrame, depthAt, diameterM } from '../layers/pipeGeometry.js';
import { collectInBox, FLOOR_COLOR, makeShapes, shapeKit, SOIL, streetDirection, SURFACE_COLOR } from './groundShapes.js';
import { createLabelDeclutter } from '../map/labelDeclutter.js';

const INK = '#13232f';

/**
 * @param {object} options
 * @param {object} options.viewer
 * @param {(lonLat: number[]) => Promise<Float64Array>} options.sampleGround
 * @param {object[]} options.networks     the network layers (cutSource, isShown, pipeColor, setSuspended)
 * @param {object[]} options.suspendable  other layers hidden meanwhile (setSuspended)
 * @param {{ pause: (paused: boolean) => void }} options.controls
 * @param {HTMLElement} options.badge
 * @param {object} options.settings       CONFIG.excavation
 * @param {boolean} options.isPhone
 * @param {() => object} options.fallbackFocus
 * @param {string} options.highlightColor  the colour of the thing tapped
 * @param {(active: boolean) => void} [options.onChange]
 */
export function createExcavationView({ viewer, sampleGround, networks, suspendable, controls, badge, settings, isPhone, fallbackFocus, highlightColor, onChange }) {
  const { scene, camera } = viewer;
  const controller = scene.screenSpaceCameraController;
  const declutter = createLabelDeclutter(scene); // labels that would pile up give way to each other

  let active = false;
  let saved;
  let centre;
  let heading = 0;
  let side = settings.sideM.desktop;
  let drawn; // { collection, labels, target, range, parts }
  let run = 0;
  let firstView = false; // the camera still has to be put at the first view of the pit
  let selected; // the key of the thing tapped (see keyOf), shown highlighted
  const highlightColour = Cesium.Color.fromCssColorString(highlightColor);

  /** One key per pipe or asset, whichever piece or part of it was tapped. */
  const keyOf = (id) => id && `${id.layer}:${id.zone}:${id.asset !== undefined ? `asset ${id.asset}` : id.index}`;

  // ---------------------------------------------------------------- digging

  /** Digs the pit (again, after a network was switched on or a zone finished loading). */
  async function build() {
    const thisRun = (run += 1);
    const frame = cutFrame(centre, heading);
    const half = side / 2;
    const inside = { left: -half, right: half, front: -half, back: half };
    const kit = shapeKit(heading);
    const { colour } = kit;

    // Everything in the pit, from every network on show.
    const { pieces, assets } = collectInBox(networks, frame, inside);

    // How deep to dig, and how much to stretch depths so the pit reads well from above.
    let deepest = 0;
    for (const piece of pieces) {
      const p = piece.feature.properties;
      deepest = Math.max(deepest, depthAt(p, piece.from.share).centre + diameterM(p) / 2, depthAt(p, piece.to.share).centre + diameterM(p) / 2);
    }
    // Bores (tens of metres) and facilities (at the surface) do not decide how deep to dig.
    for (const { asset } of assets) if (!['bore', 'facility'].includes(asset.properties.kind)) deepest = Math.max(deepest, asset.properties.depth.at[0]);
    const maxDepth = Math.min(settings.maxDepthM, Math.max(settings.minDepthM, Math.ceil(deepest + 0.4)));
    const stretch = Math.max(1, Math.min(settings.maxStretch, Math.floor((2 * side * settings.depthShareOfSide) / maxDepth) / 2));

    // Ground heights: around the rim every metre, at the ends of every piece, at every fitting.
    const rim = [];
    const corners = [
      [-half, -half],
      [half, -half],
      [half, half],
      [-half, half],
    ];
    for (let c = 0; c < 4; c += 1) {
      const [ax, ay] = corners[c];
      const [bx, by] = corners[(c + 1) % 4];
      const steps = Math.max(2, Math.round(side));
      for (let i = 0; i < steps; i += 1) rim.push([ax + ((bx - ax) * i) / steps, ay + ((by - ay) * i) / steps]);
    }
    rim.push(rim[0]);
    const lonLat = [];
    for (const point of rim) lonLat.push(...frame.toLonLat(point));
    for (const piece of pieces) lonLat.push(piece.from.lon, piece.from.lat, piece.to.lon, piece.to.lat);
    for (const { asset } of assets) lonLat.push(...asset.geometry.coordinates.slice(0, 2));
    lonLat.push(centre.lon, centre.lat);
    const heights = await sampleGround(lonLat);
    if (thisRun !== run || !active) return;
    const known = [...heights].filter(Number.isFinite);
    const typical = known.length ? known.reduce((sum, h) => sum + h, 0) / known.length : (fallbackFocus().height ?? 300);
    const ground = (i) => (Number.isFinite(heights[i]) ? heights[i] : typical);
    const pieceBase = rim.length;
    const assetBase = pieceBase + 2 * pieces.length;
    const centreGround = ground(assetBase + assets.length);

    const collection = new Cesium.PrimitiveCollection();
    const labels = new Cesium.LabelCollection();
    const parts = new Map(); // key -> { shapes: [{ primitive, id, colour }], labels: [] }
    const partsOf = (id) => {
      const key = keyOf(id);
      if (!parts.has(key)) parts.set(key, { shapes: [], labels: [] });
      return parts.get(key);
    };
    const label = (position, text, id, options) => {
      const made = addLabel(position, text, id, options);
      if (id) partsOf(id).labels.push(made);
      return made;
    };
    const addLabel = (position, text, id, { size = 12, colour: css = INK, near = settings.labelsWithinM, onTop = false, throughWithinM = settings.labelsThroughWallsM } = {}) =>
      labels.add({
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
        disableDepthTestDistance: onTop ? Number.POSITIVE_INFINITY : throughWithinM,
      });

    // ---- the pit: walls in layers, depth lines, floor
    const rimPositions = rim.map((point) => Cesium.Cartesian3.fromDegrees(...frame.toLonLat(point)));
    const rimGround = rim.map((_, i) => ground(i));
    const walls = [];
    let top = 0;
    for (const layer of SOIL) {
      const bottom = Math.min(layer.to, maxDepth);
      if (bottom <= top) continue;
      walls.push(
        new Cesium.GeometryInstance({
          geometry: new Cesium.WallGeometry({
            positions: rimPositions,
            maximumHeights: rimGround.map((h) => h - stretch * top),
            minimumHeights: rimGround.map((h) => h - stretch * bottom),
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: { color: colour(layer.color) },
        }),
      );
      top = bottom;
    }
    const floorCorners = [0, rim.length / 4, rim.length / 2, (3 * rim.length) / 4].map(Math.round);
    walls.push(
      new Cesium.GeometryInstance({
        geometry: new Cesium.PolygonGeometry({
          polygonHierarchy: new Cesium.PolygonHierarchy(
            floorCorners.map((i) => Cesium.Cartesian3.fromDegrees(...frame.toLonLat(rim[i]), ground(i) - stretch * maxDepth)),
          ),
          perPositionHeight: true,
          vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        attributes: { color: colour(FLOOR_COLOR) },
      }),
    );
    collection.add(new Cesium.Primitive({ geometryInstances: walls, appearance: new Cesium.PerInstanceColorAppearance({ translucent: false, closed: false }), asynchronous: false }));

    // Depth lines a hair inside the walls, and the edge of the street along the top.
    const inward = (point, by) => {
      const scale = (half - by) / half;
      return [point[0] * scale, point[1] * scale];
    };
    const ring = (depth, width, css, alpha) =>
      new Cesium.GeometryInstance({
        geometry: new Cesium.PolylineGeometry({
          positions: rim.map((point, i) => Cesium.Cartesian3.fromDegrees(...frame.toLonLat(inward(point, 0.03)), ground(i) - stretch * depth)),
          width,
          arcType: Cesium.ArcType.NONE,
          vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
        }),
        attributes: { color: colour(css, alpha) },
      });
    const step = maxDepth <= 3 ? 0.5 : 1;
    const rings = [ring(0, 3, SURFACE_COLOR, 1)];
    for (let depth = step; depth <= maxDepth + 1e-9; depth += step) rings.push(ring(depth, 1, INK, 0.35));
    collection.add(new Cesium.Primitive({ geometryInstances: rings, appearance: new Cesium.PolylineColorAppearance({ translucent: true }), asynchronous: false }));

    // The depth scale down one corner.
    const scaleCorner = inward(corners[3], 0.15);
    for (let depth = 0; depth <= maxDepth + 1e-9; depth += step) {
      label(Cesium.Cartesian3.fromDegrees(...frame.toLonLat(scaleCorner), ground(Math.round((3 * rim.length) / 4)) - stretch * depth), depth === 0 ? 'Ground 0 m' : `${depth} m`, undefined, {
        size: 11,
        near: settings.sideM.desktop * 6,
        onTop: true, // in the corner, the wall would cut the figures in half
      });
    }

    // ---- pipes, manholes, valves, hydrants, tobies, fittings: each with its own shape (groundShapes.js)
    const { tubes, solid, seeThrough } = makeShapes({
      pieces,
      assets,
      frame,
      kit,
      stretch,
      pieceGround: (number, end) => ground(pieceBase + 2 * number + end),
      assetGround: (number) => ground(assetBase + number),
      settings,
      label,
    });

    const lit = new Cesium.PerInstanceColorAppearance({ translucent: false, closed: true });
    const shapes = (instances, appearance) => {
      if (!instances.length) return;
      const primitive = collection.add(new Cesium.Primitive({ geometryInstances: instances, appearance, asynchronous: false }));
      for (const instance of instances) partsOf(instance.id).shapes.push({ primitive, id: instance.id, colour: Uint8Array.from(instance.attributes.color.value) });
    };
    shapes([...tubes, ...solid], lit);
    shapes(seeThrough, new Cesium.PerInstanceColorAppearance({ translucent: true, closed: true }));

    clear();
    scene.primitives.add(collection);
    scene.primitives.add(labels);
    declutter.watch(labels);
    setClipping(half);

    // Look into the pit from the side the viewer came from, a little above the street.
    const device = isPhone ? 'phone' : 'desktop';
    const target = Cesium.Cartesian3.fromDegrees(...frame.toLonLat([0, side * settings.viewAimPastShare[device]]), centreGround - (stretch * maxDepth) / 2);
    const range = side * settings.viewRangeShare[device];
    drawn = { collection, labels, target, range, parts };
    if (selected) paintWhenReady(selected);
    // The camera goes to the first view once; digging again round the same place leaves it where it is.
    if (firstView) camera.lookAt(target, new Cesium.HeadingPitchRange(toRadians(heading), toRadians(settings.viewPitchDegrees), range));
    firstView = false;
    scene.requestRender();

    const counts = { pipes: new Set(pieces.map((piece) => `${piece.network.id}:${piece.index}`)).size };
    for (const { asset } of assets) counts[asset.properties.kind] = (counts[asset.properties.kind] ?? 0) + 1;
    showBadge(stretch, counts);
  }

  /** Shows a thing highlighted (or back to its own colours): its shapes turn yellow, its label turns dark. */
  function paint(key, on) {
    const thing = drawn?.parts.get(key);
    if (!thing) return true;
    for (const { primitive, id, colour } of thing.shapes) {
      if (!primitive.ready) return false;
      primitive.getGeometryInstanceAttributes(id).color = on
        ? Cesium.ColorGeometryInstanceAttribute.toValue(highlightColour.withAlpha(colour[3] / 255))
        : colour;
    }
    for (const made of thing.labels) {
      made.showBackground = on;
      made.backgroundColor = Cesium.Color.fromCssColorString(INK);
      made.fillColor = on ? highlightColour : Cesium.Color.fromCssColorString(INK);
      made.outlineWidth = on ? 0 : 3;
    }
    declutter.refresh(); // the label of the thing tapped always shows
    return true;
  }

  /** A pit just dug draws its shapes on the next frame; the highlight waits for them. */
  function paintWhenReady(key) {
    if (paint(key, true)) return;
    const stop = scene.postRender.addEventListener(() => {
      if (!drawn || selected !== key || paint(key, true)) stop();
      else scene.requestRender();
    });
    scene.requestRender();
  }

  function setClipping(half) {
    // The ground inside the pit is taken away: four planes facing out, clipped where outside of all four.
    const forward = new Cesium.Cartesian3(Math.sin(toRadians(heading)), Math.cos(toRadians(heading)), 0);
    const right = new Cesium.Cartesian3(Math.cos(toRadians(heading)), -Math.sin(toRadians(heading)), 0);
    const planes = [forward, right].flatMap((normal) => [
      new Cesium.ClippingPlane(Cesium.Cartesian3.clone(normal), -half),
      new Cesium.ClippingPlane(Cesium.Cartesian3.negate(normal, new Cesium.Cartesian3()), -half),
    ]);
    scene.globe.clippingPlanes = new Cesium.ClippingPlaneCollection({
      modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(centre.lon, centre.lat, 0)),
      planes,
      unionClippingRegions: false,
      edgeWidth: 1.5,
      edgeColor: Cesium.Color.fromCssColorString(SURFACE_COLOR),
    });
  }

  function clear() {
    if (!drawn) return;
    scene.primitives.remove(drawn.collection);
    declutter.watch(undefined);
    scene.primitives.remove(drawn.labels);
    drawn = undefined;
  }

  /** What the message on top counts, in this order (the rest are left to the labels). */
  const COUNTED = [
    ['manhole', 'manhole', 'manholes'],
    ['valve', 'valve', 'valves'],
    ['hydrant', 'hydrant', 'hydrants'],
    ['fitting', 'fitting', 'fittings'],
    ['inlet', 'gully', 'gullies'],
    ['device', 'soakpit or chamber', 'soakpits and chambers'],
    ['facility', 'facility', 'facilities'],
    ['bore', 'bore', 'bores'],
  ];

  function showBadge(stretch, counts) {
    const parts = [`${counts.pipes} pipe${counts.pipes === 1 ? '' : 's'}`];
    for (const [kind, one, many] of COUNTED) if (counts[kind]) parts.push(`${counts[kind]} ${counts[kind] === 1 ? one : many}`);
    badge.querySelector('.dig-badge__text').textContent =
      `Excavation ${Math.round(side)} × ${Math.round(side)} m · ${parts.join(', ')} · ` + (stretch > 1 ? `depth shown ×${stretch}` : 'true scale');
    badge.hidden = false;
  }

  // ---------------------------------------------------------------- in and out

  function enter() {
    if (active) return;
    stopMoving(viewer);
    const fallback = fallbackFocus();
    const view = currentView(viewer, fallback.height);
    centre = view ? { lon: view.focus.lon, lat: view.focus.lat } : { lon: fallback.lon, lat: fallback.lat };
    saved = {
      position: Cesium.Cartesian3.clone(camera.positionWC),
      heading: camera.heading,
      pitch: camera.pitch,
      roll: camera.roll,
      collision: controller.enableCollisionDetection,
      minimumZoom: controller.minimumZoomDistance,
    };
    side = isPhone ? settings.sideM.phone : settings.sideM.desktop;
    heading = streetDirection(networks, centre, view?.orientation.headingDegrees ?? toDegrees(camera.heading), settings.alignWithinM);

    active = true;
    controls.pause(true);
    controller.enableCollisionDetection = false; // the camera may go down into the pit
    controller.minimumZoomDistance = settings.closestM;
    for (const layer of [...networks, ...suspendable]) layer.setSuspended(true);
    onChange?.(true);
    firstView = true;
    build();
  }

  function exit() {
    if (!active) return;
    active = false;
    run += 1;
    clear();
    scene.globe.clippingPlanes = undefined;
    badge.hidden = true;
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    controller.enableCollisionDetection = saved.collision;
    controller.minimumZoomDistance = saved.minimumZoom;
    for (const layer of [...networks, ...suspendable]) layer.setSuspended(false);
    controls.pause(false);
    camera.setView({ destination: saved.position, orientation: { heading: saved.heading, pitch: saved.pitch, roll: saved.roll } });
    scene.requestRender();
    onChange?.(false);
  }

  window.addEventListener('keydown', (event) => {
    if (active && event.key === 'Escape') exit();
  });

  // The round buttons while the pit is shown: turn round it, lean over it, get closer.
  const nudge = (move) => {
    if (!active) return;
    move();
    scene.requestRender();
  };

  return {
    toggle: () => (active ? exit() : enter()),
    enter,
    exit,
    /** Digs again at the same place (after a network was switched on or off). */
    refresh: () => active && build(),
    get active() {
      return active;
    },
    zoom: (steps) => nudge(() => (steps > 0 ? camera.zoomIn(drawn.range * 0.25) : camera.zoomOut(drawn.range * 0.25))),
    turn: (quarters) => nudge(() => camera.rotateRight(toRadians(30) * quarters)),
    tilt: (steps) => nudge(() => camera.rotateDown(toRadians(10) * steps)),
    /** The thing tapped (an id from picking), or undefined: shown highlighted while the pit is open. */
    highlight(id) {
      const key = keyOf(id);
      if (key === selected) return;
      if (selected) paint(selected, false);
      selected = key;
      if (selected && active) paintWhenReady(selected);
    },
    /** Back to the first view of the pit. */
    reset: () => nudge(() => camera.lookAt(drawn.target, new Cesium.HeadingPitchRange(toRadians(heading), toRadians(settings.viewPitchDegrees), drawn.range))),
  };
}
