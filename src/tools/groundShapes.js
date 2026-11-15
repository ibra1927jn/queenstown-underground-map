/**
 * The shapes of what lies in the ground, shared by the excavation view (a pit, excavationView.js)
 * and the open-ground view (the whole map, openGroundView.js):
 *   pipes ........ tubes of their colour and diameter
 *   manholes ..... concrete shafts of their real diameter, from the lid in the street to the bottom
 *   valves ....... the valve body on its pipe, a spindle up to the valve box in the street
 *                  (a valve that is normally closed is white)
 *   hydrants ..... a riser from the pipe to a yellow head under its yellow lid
 *   tobies ....... the small shut-off valve of a property, under its lid
 *   fittings, meters, gullies, soakpits… and where each property connection joins its main
 *                  (see excavationFittings.js)
 *
 * Everything is found and placed in a "cut frame" (pipeGeometry.js): metres across (x) and along
 * (y) from a centre. Depths – and the sizes of pipes, which must keep their proportion to them –
 * are multiplied by `stretch`; sizes across stay true.
 */
import { Cesium, toDegrees, toRadians } from '../map/cesium.js';
import { cutFrame, depthAt, depthTag, diameterM, linesOf, piecesInCut } from '../layers/pipeGeometry.js';
import { createFittingShapes } from './excavationFittings.js';

/** What the street furniture and fittings look like. */
export const LOOK = {
  concrete: '#a8a39b',
  iron: '#2f3337',
  spindle: '#5c6b77',
  valve: '#0b2e59',
  valveClosed: '#f1f3f5',
  valveBox: '#495057',
  toby: '#74c0fc',
  hydrant: '#fcc419',
};

/** Illustrative soil layers of an earth wall (typical New Zealand road trench): down to `to` metres. */
export const SOIL = [
  { to: 0.3, color: '#a99f90' }, // seal and basecourse
  { to: 1.2, color: '#cdb994' }, // fill and gravel
  { to: Infinity, color: '#b9a27a' }, // natural ground
];
export const FLOOR_COLOR = '#8f7b59';
export const SURFACE_COLOR = '#3d5a2a';

/** Point assets above the ground (electricity): never in the pit or the open ground. */
const ABOVE_GROUND_KINDS = new Set(['substation', 'tower', 'transformer', 'streetlight']);

/** The small things (drawn by excavationFittings.js): left out far from where one looks. */
const SMALL_KINDS = new Set(['bore', 'instrument', 'machine', 'monitoring', 'fitting', 'meter', 'backflow', 'inlet', 'outlet', 'device']);

/**
 * The makers of single shapes. Boxes are turned to `headingDegrees`.
 * @param {{ tubeSides?: number, slices?: number }} [detail]  how round tubes and cylinders are drawn
 */
export function shapeKit(headingDegrees, { tubeSides = 16, slices = 28 } = {}) {
  /** A colour for a shape: a CSS colour or a Cesium colour, made see-through by `alpha` < 1. */
  const colour = (css, alpha = 1) =>
    Cesium.ColorGeometryInstanceAttribute.fromColor((typeof css === 'string' ? Cesium.Color.fromCssColorString(css) : css).withAlpha(alpha));
  const at = (lon, lat, height) => Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(lon, lat, height));

  /** A vertical cylinder standing between two heights. */
  function cylinder(id, lon, lat, bottom, top, radius, css, alpha) {
    const length = top - bottom;
    if (length <= 0.01) return undefined;
    return new Cesium.GeometryInstance({
      id: { ...id },
      geometry: new Cesium.CylinderGeometry({ length, topRadius: radius, bottomRadius: radius, slices, vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT }),
      modelMatrix: at(lon, lat, (bottom + top) / 2),
      attributes: { color: colour(css, alpha) },
    });
  }

  /** A box centred at a height, turned to the heading. */
  function box(id, lon, lat, centreHeight, [x, y, z], css, alpha) {
    const turn = Cesium.Matrix4.fromRotationTranslation(Cesium.Matrix3.fromRotationZ(-toRadians(headingDegrees)));
    return new Cesium.GeometryInstance({
      id: { ...id },
      geometry: Cesium.BoxGeometry.fromDimensions({ dimensions: new Cesium.Cartesian3(x, y, z), vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT }),
      modelMatrix: Cesium.Matrix4.multiply(at(lon, lat, centreHeight), turn, new Cesium.Matrix4()),
      attributes: { color: colour(css, alpha) },
    });
  }

  function circle(radius) {
    return Array.from({ length: tubeSides }, (_, i) => new Cesium.Cartesian2(radius * Math.cos((i / tubeSides) * Math.PI * 2), radius * Math.sin((i / tubeSides) * Math.PI * 2)));
  }

  /** A round tube along a few positions. */
  function tube(id, positions, radius, css, alpha) {
    return new Cesium.GeometryInstance({
      id: { ...id },
      geometry: new Cesium.PolylineVolumeGeometry({ polylinePositions: positions, shapePositions: circle(radius), cornerType: Cesium.CornerType.ROUNDED, vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT }),
      attributes: { color: colour(css, alpha) },
    });
  }

  return { colour, cylinder, box, tube, circle };
}

/** The direction in which most length of main runs within `withinM` of a place: the street. */
export function streetDirection(networks, around, viewHeading, withinM) {
  const frame = cutFrame(around, 0);
  const lengthByDirection = new Float64Array(18);
  for (const network of networks) {
    for (const { features } of network.cutSource()) {
      for (const feature of features) {
        if (feature.properties.kind !== 'main') continue;
        for (const line of linesOf(feature.geometry)) {
          for (let i = 1; i < line.length; i += 1) {
            const [px, py] = frame.toCut(line[i - 1]);
            const [qx, qy] = frame.toCut(line[i]);
            const dx = qx - px;
            const dy = qy - py;
            const lengthSquared = dx * dx + dy * dy;
            if (lengthSquared < 1) continue;
            const t = Math.max(0, Math.min(1, -(px * dx + py * dy) / lengthSquared));
            if (Math.hypot(px + t * dx, py + t * dy) > withinM) continue;
            lengthByDirection[Math.floor(((toDegrees(Math.atan2(dx, dy)) + 360) % 180) / 10) % 18] += Math.sqrt(lengthSquared);
          }
        }
      }
    }
  }
  let bestBin = -1;
  let bestLength = 0;
  for (let bin = 0; bin < 18; bin += 1) {
    const total = lengthByDirection[(bin + 17) % 18] / 2 + lengthByDirection[bin] + lengthByDirection[(bin + 1) % 18] / 2;
    if (total > bestLength) {
      bestLength = total;
      bestBin = bin;
    }
  }
  if (bestBin < 0) return viewHeading;
  const best = bestBin * 10 + 5;
  const difference = ((best - viewHeading + 540) % 360) - 180;
  return Math.abs(difference) <= 90 ? best : (best + 180) % 360;
}

/**
 * Everything inside a box of a cut frame, from every network on show.
 * @param {{ left: number, right: number, front: number, back: number }} inside  metres in the frame
 * @returns {{ pieces: object[], assets: object[] }}  pieces of pipe (see piecesInCut, with their network,
 *   zone and feature) and point assets ({ network, zone, asset, number })
 */
export function collectInBox(networks, frame, inside) {
  const isInside = ([lon, lat]) => {
    const [x, y] = frame.toCut([lon, lat]);
    return x >= inside.left && x <= inside.right && y >= inside.front && y <= inside.back;
  };
  const pieces = [];
  const assets = [];
  for (const network of networks) {
    for (const { zone, features, assets: points } of network.cutSource()) {
      // Open channels are at the surface, not in the ground: they are left out.
      // Open channels, overhead lines and pipes laid above ground are not in the ground either.
      const inGround = (feature) => network.isShown(feature) && feature.properties.kind !== 'channel' && !feature.properties.aboveGround;
      for (const piece of piecesInCut(features, frame, inside, inGround)) pieces.push({ network, zone, feature: features[piece.index], ...piece });
      (points ?? []).forEach((asset, number) => {
        if (network.isShown(asset) && !ABOVE_GROUND_KINDS.has(asset.properties.kind) && isInside(asset.geometry.coordinates)) assets.push({ network, zone, asset, number });
      });
    }
  }
  return { pieces, assets };
}

/**
 * The shapes of pieces of pipe and point assets (from collectInBox).
 * @param {object} options
 * @param {object} options.frame        the cut frame they were collected in
 * @param {object} options.kit          from shapeKit
 * @param {number} options.stretch      depths (and pipe sizes) are drawn this many times bigger
 * @param {(number: number, end: 0 | 1) => number} options.pieceGround  ground height at an end of piece `number`
 * @param {(number: number) => number} options.assetGround              ground height at asset `number`
 * @param {object} options.settings     minPipeRadiusM, manholeRadiusM, labelPiecesLongerThanM, fittingLabelsWithinM
 * @param {Function} options.label      (position, text, id, options) – adds a label
 * @param {boolean} [options.siteOutlines]  facilities with their outline and fence (see excavationFittings.js)
 * @param {(lonLat: number[]) => boolean} [options.isNear]  false for places far from where one looks:
 *   no labels there, and none of the small things (fittings, meters, tobies…)
 *   (a piece marked `quiet` gets no depth label either: one of several parts of the same pipe)
 * @returns {{ tubes: object[], solid: object[], seeThrough: object[] }}  geometry instances
 */
export function makeShapes({ pieces, assets, frame, kit, stretch, pieceGround, assetGround, settings, label, isNear = () => true, siteOutlines = false }) {
  const { cylinder, box, tube, circle } = kit;
  const tubes = [];
  const fittings = createFittingShapes({ frame, stretch, make: { cylinder, box, tube }, label, labelsWithinM: settings.fittingLabelsWithinM, siteOutlines });
  const joinings = []; // property connections that join their main here

  // ---- pipes: tubes of their size (stretched like the depths), with their depth on the longer pieces
  pieces.forEach((piece, number) => {
    const p = piece.feature.properties;
    const radius = stretch * Math.max(settings.minPipeRadiusM, diameterM(p) / 2);
    const heights = [piece.from, piece.to].map((end, k) => pieceGround(number, k) - stretch * depthAt(p, end.share).centre);
    const ends = [piece.from, piece.to].map((end, k) => Cesium.Cartesian3.fromDegrees(end.lon, end.lat, heights[k]));
    const length = Cesium.Cartesian3.distance(ends[0], ends[1]);
    if (length < 0.05) return;
    const near = isNear([piece.from.lon, piece.from.lat]);
    const id = { layer: piece.network.id, zone: piece.zone, index: piece.index, part: 'pit' };
    fittings.addPipe({ network: piece.network.id, kind: p.kind, a: frame.toCut([piece.from.lon, piece.from.lat]), b: frame.toCut([piece.to.lon, piece.to.lat]), heights, radius });
    if (near && p.kind === 'lateral' && p.joins !== undefined) {
      // The end of the connection that joins the main, if it is in this piece.
      const end = [piece.from, piece.to].find((e) => Math.abs(e.share - p.joins) < 1e-6);
      if (end) joinings.push({ id, end: frame.toCut([end.lon, end.lat]), network: piece.network.id, colour: piece.network.pipeColor(piece.feature) });
    }
    tubes.push(
      new Cesium.GeometryInstance({
        id,
        geometry: new Cesium.PolylineVolumeGeometry({ polylinePositions: ends, shapePositions: circle(radius), cornerType: Cesium.CornerType.ROUNDED, vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT }),
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(piece.network.pipeColor(piece.feature)) },
      }),
    );
    if (near && !piece.quiet && length >= settings.labelPiecesLongerThanM) {
      const share = (piece.from.share + piece.to.share) / 2;
      // On top of the tube, not inside it (the tube would hide it).
      const middle = Cesium.Cartographic.fromCartesian(Cesium.Cartesian3.midpoint(ends[0], ends[1], new Cesium.Cartesian3()));
      middle.height += radius + 0.05;
      // A pipe added by hand (src/util/addedPipes.js) says so: here it is a tube like the council's.
      const about = p.source === 'mine' ? ' · added by hand' : depthTag(p) === 'estimate' ? ' est.' : '';
      label(Cesium.Cartographic.toCartesian(middle), `${depthAt(p, share).measured.toFixed(1)} m${about}`, id);
    }
  });

  // ---- manholes, valves, hydrants, tobies
  const solid = [];
  const seeThrough = [];
  assets.forEach(({ network, zone, asset, number }, n) => {
    const p = asset.properties;
    const [lon, lat] = asset.geometry.coordinates;
    const g = assetGround(n);
    const depth = p.depth.at[0];
    const id = { layer: network.id, zone, asset: number };
    const add = (list, instance) => instance && list.push(instance);
    const near = isNear([lon, lat]);
    if (!near && (SMALL_KINDS.has(p.kind) || (p.kind === 'valve' && (network.id !== 'water' || p.type.startsWith('Toby'))))) return;
    if (fittings.addAsset({ id, asset, ground: g, network: network.id, colour: network.pipeColor(asset) })) return;

    if (p.kind === 'manhole') {
      const radius = p.diameter ? p.diameter / 2000 : settings.manholeRadiusM;
      add(seeThrough, cylinder(id, lon, lat, g - stretch * depth, g, radius, LOOK.concrete, 0.6));
      add(solid, cylinder(id, lon, lat, g, g + 0.08, Math.min(0.32, radius), LOOK.iron));
      if (near) label(Cesium.Cartesian3.fromDegrees(lon, lat, g + 0.3), `Manhole ${depth.toFixed(1)} m`, id);
      return;
    }
    const pipeSize = p.diameter ? p.diameter / 1000 : 0.1;
    const pipeCentre = g - stretch * Math.max(0.2, depth - pipeSize / 2);
    // The pipe it sits on is drawn this thick (stretched like the depths): the fitting must stand out of it.
    const thick = stretch * Math.max(2 * settings.minPipeRadiusM, pipeSize);
    if (p.kind === 'hydrant') {
      add(solid, cylinder(id, lon, lat, pipeCentre, g - 0.35, 0.075, LOOK.hydrant));
      add(solid, cylinder(id, lon, lat, g - 0.35, g - 0.1, 0.11, LOOK.hydrant));
      add(solid, box(id, lon, lat, g + 0.03, [0.42, 0.32, 0.06], LOOK.hydrant));
      if (near) label(Cesium.Cartesian3.fromDegrees(lon, lat, g + 0.3), 'Hydrant', id);
      return;
    }
    if (p.type.startsWith('Toby')) {
      const size = Math.max(0.14, thick * 1.25);
      add(solid, box(id, lon, lat, pipeCentre, [size, size, size], LOOK.toby));
      add(solid, cylinder(id, lon, lat, pipeCentre + size / 2, g - 0.02, 0.02, LOOK.spindle));
      add(solid, box(id, lon, lat, g + 0.02, [0.2, 0.2, 0.04], LOOK.toby));
      return;
    }
    // A valve on a main: a body wider than the pipe, a bonnet on top, the spindle up to the valve box in the street.
    const body = Math.max(0.3, thick * 1.6);
    const bodyColour = p.position === 'closed' ? LOOK.valveClosed : LOOK.valve;
    add(solid, box(id, lon, lat, pipeCentre, [body, body, body * 1.1], bodyColour));
    const bonnetTop = Math.min(g - 0.1, pipeCentre + body * 0.55 + body * 0.5);
    add(solid, cylinder(id, lon, lat, pipeCentre + body * 0.55, bonnetTop, body * 0.28, bodyColour));
    add(solid, cylinder(id, lon, lat, bonnetTop, g - 0.05, 0.035, LOOK.spindle));
    add(solid, box(id, lon, lat, g + 0.03, [0.3, 0.3, 0.06], LOOK.valveBox));
    if (near) label(Cesium.Cartesian3.fromDegrees(lon, lat, g + 0.3), p.position === 'closed' ? 'Valve (closed)' : 'Valve', id);
  });

  for (const joining of joinings) fittings.addConnection(joining);
  solid.push(...fittings.solid);
  seeThrough.push(...fittings.seeThrough);
  return { tubes, solid, seeThrough };
}
