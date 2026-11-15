/**
 * The shapes of the fittings and smaller assets inside the excavation pit (see excavationView.js):
 * tees, junctions, bends, reducers, end caps, thrust blocks, meters, backflow preventers,
 * road gullies, outlets, soakpits, interceptors, valves of the gravity networks – and a collar
 * where a property connection joins its main, wherever the council has no fitting recorded there.
 *
 * Everything is placed on the tube of the pipe it sits on (found within a metre or so in plan),
 * at the height that tube is drawn, so fittings and pipes meet; an asset with no pipe near it in
 * the pit is drawn at its own depth. All sizes follow the pipe's, stretched like the depths.
 *
 * Works in the pit's own frame: x across, y along the pit, in metres from its middle.
 */
import { Cesium } from '../map/cesium.js';

/** Short names on the labels in the pit. */
const SHORT_NAME = {
  tee: 'Tee',
  junction: 'Junction',
  bend: 'Bend',
  reducer: 'Reducer',
  end: 'End cap',
  thrust: 'Thrust block',
  sample: 'Sample point',
  pump: 'Pump',
  inspection: 'Inspection eye',
  meter: 'Meter',
  flow: 'Flow meter',
  backflow: 'Backflow',
  gully: 'Gully',
  bubble: 'Bubble-up',
  outlet: 'Outlet',
  intake: 'Intake',
  soakpit: 'Soakpit',
  chamber: 'Detention chamber',
  interceptor: 'Interceptor',
  valve: 'Valve',
  boundary: 'Boundary kit',
};

/** Chambers dug into the ground: their label gives their depth. */
const CHAMBERS = new Set(['gully', 'soakpit', 'chamber', 'interceptor']);

const LOOK = {
  concrete: '#a8a39b',
  iron: '#2f3337',
  meter: '#ced4da',
  backflow: '#0ca678',
  pump: '#495057',
  sample: '#74c0fc',
  bore: '#868e96', // steel casing
  fitting: '#3d454d', // tees, bends, junctions…: dark iron, so they stand out on the coloured pipe
  connection: '#6c757d', // a collar where a connection joins its main (no fitting recorded there)
};

/** A facility drawn with its outline (the open ground): the pad, the fence and the name above it. */
const SITE = { padBelowM: 0.1, padAboveM: 0.15, padAlpha: 0.45, fenceM: 1.1, railRadiusM: 0.06, postRadiusM: 0.05, nameAboveM: 4, nameWithinM: 700 };

/** How far (in plan) a fitting may be from a pipe to be drawn on it. */
const ON_PIPE_M = 1.5;
/** A connection collar is not drawn where the council has a fitting this close. */
const FITTING_NEAR_M = 0.6;
/** The council often records one junction per connection at the same spot: drawn once. */
const SAME_SPOT_M = 0.3;
/** Fittings that sit on a main (others, such as meters, on the property connection). */
const ON_MAINS = new Set(['tee', 'junction', 'bend', 'reducer', 'end', 'thrust', 'flow', 'pump', 'valve']);
/** A pipe of the other kind counts as this much farther away. */
const OTHER_KIND_PENALTY_M = 0.5;

/**
 * @param {object} pit
 * @param {object} pit.frame      cutFrame of the pit (toCut, toLonLat)
 * @param {number} pit.stretch    how much depths (and sizes) are stretched
 * @param {object} pit.make       { cylinder, box, tube, colour } shape makers of the excavation view
 * @param {(position, text, id, options) => void} pit.label
 * @param {number} pit.labelsWithinM
 * @param {boolean} [pit.siteOutlines]  facilities with their real outline, a fence round it and their name
 *   high above (the open ground); otherwise a small pad with their name (the pit, which is smaller than most sites)
 */
export function createFittingShapes({ frame, stretch, make, label, labelsWithinM, siteOutlines = false }) {
  /** Pieces of pipe in the pit: { network, kind, a: [x, y], b: [x, y], heights: [ha, hb], radius, joins } */
  const pipes = [];
  const solid = [];
  const seeThrough = [];
  const fittingsAt = []; // { at: [x, y], shape } of the fittings drawn

  const position = ([x, y], height) => Cesium.Cartesian3.fromDegrees(...frame.toLonLat([x, y]), height);
  /** Valves of the gravity networks in a darker shade of their network's colour. */
  const darker = (colour) => (typeof colour === 'string' ? Cesium.Color.fromCssColorString(colour) : colour).darken(0.35, new Cesium.Color());
  const plus = (p, d, by) => [p[0] + d[0] * by, p[1] + d[1] * by];
  const across = (d) => [-d[1], d[0]];

  /** The nearest piece of pipe of the network to a point (in plan): where on it, which way, how high. */
  function pipeAt(point, networkId, { kind, prefer, within = ON_PIPE_M } = {}) {
    let best;
    let bestDistance = within;
    for (const pipe of pipes) {
      if (pipe.network !== networkId || (kind && pipe.kind !== kind)) continue;
      const dx = pipe.b[0] - pipe.a[0];
      const dy = pipe.b[1] - pipe.a[1];
      const lengthSquared = dx * dx + dy * dy;
      if (lengthSquared < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((point[0] - pipe.a[0]) * dx + (point[1] - pipe.a[1]) * dy) / lengthSquared));
      const on = [pipe.a[0] + t * dx, pipe.a[1] + t * dy];
      const distance = Math.hypot(point[0] - on[0], point[1] - on[1]) + (prefer && pipe.kind !== prefer ? OTHER_KIND_PENALTY_M : 0);
      if (distance > bestDistance) continue;
      const length = Math.sqrt(lengthSquared);
      best = { pipe, at: on, direction: [dx / length, dy / length], height: pipe.heights[0] + t * (pipe.heights[1] - pipe.heights[0]), radius: pipe.radius };
      bestDistance = distance;
    }
    return best;
  }

  /** Which way a branch leaves a point on a pipe: along another pipe ending there, else square to it. */
  function branchDirection(on, networkId) {
    for (const pipe of pipes) {
      if (pipe.network !== networkId || pipe === on.pipe) continue;
      for (const [end, other] of [
        [pipe.a, pipe.b],
        [pipe.b, pipe.a],
      ]) {
        if (Math.hypot(end[0] - on.at[0], end[1] - on.at[1]) > 0.6) continue;
        const length = Math.hypot(other[0] - end[0], other[1] - end[1]);
        if (length < 0.05) continue;
        const d = [(other[0] - end[0]) / length, (other[1] - end[1]) / length];
        if (Math.abs(d[0] * on.direction[0] + d[1] * on.direction[1]) < 0.87) return d; // more than 30° off the pipe
      }
    }
    return across(on.direction);
  }

  /** A short tube along a direction, centred on a point. */
  function sleeve(id, centre, direction, height, length, radius, colour) {
    const ends = [plus(centre, direction, -length / 2), plus(centre, direction, length / 2)].map((p) => position(p, height));
    solid.push(make.tube(id, ends, radius, colour));
  }

  function stub(id, from, direction, height, length, radius, colour) {
    solid.push(make.tube(id, [position(from, height), position(plus(from, direction, length), height)], radius, colour));
  }

  /** Remembers a piece of pipe drawn in the pit. */
  function addPipe(piece) {
    pipes.push(piece);
  }

  /**
   * Draws one asset of `network`. `ground` is the ground height there; `colour` its network colour.
   * @returns {boolean} whether it was drawn here (false: not a kind this module draws)
   */
  function addAsset({ id, asset, ground, network, colour }) {
    const p = asset.properties;
    const AT_SURFACE = ['facility', 'bore', 'instrument', 'machine', 'monitoring'];
    if (![...AT_SURFACE, 'fitting', 'meter', 'backflow', 'inlet', 'outlet', 'device'].includes(p.kind) && !(p.kind === 'valve' && network !== 'water')) return false;
    if (AT_SURFACE.includes(p.kind)) return addSite({ id, asset, ground, colour });
    const [lon, lat] = asset.geometry.coordinates;
    const point = frame.toCut([lon, lat]);
    const depth = p.depth.at[0];
    const dark = darker(colour);
    const shape = p.shape ?? p.kind;
    const on = pipeAt(point, network, { prefer: ON_MAINS.has(shape) ? 'main' : 'lateral' });
    const spot = on ? on.at : point;
    if (fittingsAt.some((f) => f.shape === shape && Math.hypot(f.at[0] - spot[0], f.at[1] - spot[1]) < SAME_SPOT_M)) return true;
    // Without a pipe in the pit: at its own depth (the depth is to the bottom of the pipe there).
    const r = on ? on.radius : stretch * 0.05;
    const centre = on ? on.at : point;
    const height = on ? on.height : ground - stretch * Math.max(0.2, depth - 0.05);
    const lonLat = frame.toLonLat(centre);
    let labelHeight = ground + 0.3;

    switch (shape) {
      case 'tee':
        sleeve(id, centre, on ? on.direction : [1, 0], height, Math.max(0.35, 4 * r), 1.3 * r, LOOK.fitting);
        stub(id, centre, on ? branchDirection(on, network) : [0, 1], height, Math.max(0.25, 3 * r), 1.15 * r, LOOK.fitting);
        break;
      case 'junction':
        sleeve(id, centre, on ? on.direction : [1, 0], height, Math.max(0.25, 2.5 * r), 1.35 * r, LOOK.fitting);
        if (on) stub(id, centre, branchDirection(on, network), height, Math.max(0.2, 2 * r), 0.9 * r, LOOK.fitting);
        break;
      case 'bend':
        sleeve(id, centre, on ? on.direction : [1, 0], height, Math.max(0.25, 3 * r), 1.3 * r, LOOK.fitting);
        break;
      case 'reducer': {
        const d = on ? on.direction : [1, 0];
        sleeve(id, plus(centre, d, -r), d, height, 2 * r, 1.4 * r, LOOK.fitting);
        sleeve(id, plus(centre, d, r), d, height, 2 * r, 1.12 * r, LOOK.fitting);
        break;
      }
      case 'end':
        sleeve(id, centre, on ? on.direction : [1, 0], height, Math.max(0.08, 0.7 * r), 1.35 * r, LOOK.fitting);
        break;
      case 'thrust':
        seeThrough.push(make.box(id, ...lonLat, height, [Math.max(0.5, 5 * r), Math.max(0.5, 5 * r), Math.max(0.4, 4 * r)], LOOK.concrete, 0.75));
        sleeve(id, centre, on ? on.direction : [1, 0], height, Math.max(0.25, 3 * r), 1.2 * r, LOOK.fitting);
        break;
      case 'sample':
      case 'inspection':
        add(make.cylinder(id, ...lonLat, height, ground - 0.05, 0.04, shape === 'sample' ? LOOK.sample : dark));
        add(make.box(id, ...lonLat, ground + 0.03, [0.25, 0.25, 0.06], shape === 'sample' ? LOOK.sample : LOOK.iron));
        break;
      case 'pump':
        solid.push(make.box(id, ...lonLat, height, [Math.max(0.6, 5 * r), Math.max(0.5, 4 * r), Math.max(0.5, 4 * r)], LOOK.pump));
        break;
      case 'meter':
        solid.push(make.box(id, ...lonLat, height, [Math.max(0.22, 3 * r), Math.max(0.16, 2.2 * r), Math.max(0.16, 2.2 * r)], LOOK.meter));
        solid.push(make.box(id, ...lonLat, ground + 0.02, [0.42, 0.3, 0.04], LOOK.iron));
        add(make.cylinder(id, ...lonLat, height, ground, 0.02, LOOK.meter));
        break;
      case 'flow':
        sleeve(id, centre, on ? on.direction : [1, 0], height, Math.max(0.4, 4 * r), 1.45 * r, LOOK.meter);
        break;
      case 'backflow':
        // Usually above ground, in a box by the boundary, on a riser from the pipe.
        add(make.cylinder(id, ...lonLat, height, ground + 0.2, 0.05, dark));
        solid.push(make.box(id, ...lonLat, ground + 0.32, [0.7, 0.32, 0.36], LOOK.backflow));
        labelHeight = ground + 0.8;
        break;
      case 'gully': {
        const bottom = ground - stretch * depth;
        seeThrough.push(make.box(id, ...lonLat, (bottom + ground) / 2, [0.65, 0.45, ground - bottom], LOOK.concrete, 0.6));
        solid.push(make.box(id, ...lonLat, ground + 0.02, [0.62, 0.42, 0.04], LOOK.iron));
        break;
      }
      case 'bubble':
        solid.push(make.box(id, ...lonLat, ground + 0.03, [0.35, 0.35, 0.06], dark));
        add(make.cylinder(id, ...lonLat, height, ground, Math.max(0.05, r), dark));
        break;
      case 'outlet':
      case 'intake':
        // A concrete headwall where the pipe meets the open drain.
        seeThrough.push(make.box(id, ...lonLat, height + 0.1, [Math.max(1.2, 6 * r), 0.3, Math.max(0.8, 4 * r)], LOOK.concrete, 0.8));
        break;
      case 'soakpit': {
        const radius = p.diameter ? p.diameter / 2000 : 0.6;
        add(make.cylinder(id, ...lonLat, ground - stretch * depth, ground, radius, LOOK.concrete, 0.55), seeThrough);
        add(make.cylinder(id, ...lonLat, ground, ground + 0.06, Math.min(0.32, radius), LOOK.iron));
        break;
      }
      case 'chamber':
      case 'interceptor': {
        const bottom = ground - stretch * depth;
        const [x, y] = shape === 'chamber' ? [2.0, 1.2] : [1.2, 0.8];
        seeThrough.push(make.box(id, ...lonLat, (bottom + ground) / 2, [x, y, ground - bottom], LOOK.concrete, 0.55));
        solid.push(make.box(id, ...lonLat, ground + 0.03, [0.6, 0.6, 0.06], LOOK.iron));
        break;
      }
      case 'valve':
      case 'boundary': {
        // A valve of the wastewater or stormwater network: body on the pipe, spindle up to a box in the street.
        const body = shape === 'boundary' ? Math.max(0.2, 2.5 * r) : Math.max(0.3, 3.2 * r);
        solid.push(make.box(id, ...lonLat, height, [body, body, body * 1.1], dark));
        add(make.cylinder(id, ...lonLat, height + body / 2, ground - 0.05, 0.035, LOOK.iron));
        solid.push(make.box(id, ...lonLat, ground + 0.03, shape === 'boundary' ? [0.35, 0.35, 0.06] : [0.3, 0.3, 0.06], LOOK.iron));
        break;
      }
      default:
        solid.push(make.box(id, ...lonLat, height, [0.25, 0.25, 0.25], dark));
    }
    fittingsAt.push({ at: centre, shape });

    const name = SHORT_NAME[shape] ?? p.type;
    const text = CHAMBERS.has(shape) ? `${name} ${depth.toFixed(1)} m` : name;
    // Buried fittings get their label just above them, things at the surface above the street.
    const atSurface = CHAMBERS.has(shape) || ['meter', 'backflow', 'sample', 'inspection', 'valve', 'boundary', 'bubble'].includes(shape);
    // Close up, a buried fitting's label shows even when a tube is in front of it.
    label(position(centre, atSurface ? labelHeight : height + r + 0.1), text, id, { size: 11, near: labelsWithinM, throughWithinM: atSurface ? 0 : 15 });
    return true;
  }

  /**
   * A facility (pump station, reservoir…: a site at the surface, drawn as a concrete pad with its name)
   * or a groundwater bore (its steel casing going down through the floor of the pit).
   */
  function addSite({ id, asset, ground, colour }) {
    const p = asset.properties;
    let [lon, lat] = asset.geometry.coordinates;
    if (['instrument', 'machine', 'monitoring'].includes(p.kind)) {
      // A marker post at the surface (the council records these at a point of the site, not where each one is).
      // Several kinds at the same place stand in a small ring, so their labels do not sit on each other.
      if (p.slots > 1) {
        const angle = (p.slot / p.slots) * Math.PI * 2;
        [lon, lat] = frame.toLonLat(plus(frame.toCut([lon, lat]), [Math.cos(angle), Math.sin(angle)], 0.9));
      }
      add(make.cylinder(id, lon, lat, ground, ground + 0.9, 0.04, LOOK.iron));
      solid.push(make.box(id, lon, lat, ground + 1.0, [0.32, 0.32, 0.2], colour));
      const text = p.kind === 'monitoring' ? (p.name ?? p.type) : p.count > 1 ? `${p.count} ${p.type.toLowerCase()}` : (p.items?.[0]?.what ?? p.type);
      label(Cesium.Cartesian3.fromDegrees(lon, lat, ground + 1.25), text, id, { size: 11, near: labelsWithinM * 2 });
      return true;
    }
    if (p.kind === 'bore') {
      const radius = Math.max(0.06, (p.diameter ?? 150) / 2000) * stretch;
      const depth = p.depth.from[0] === 'rec' ? p.depth.at[0] : 3;
      add(make.cylinder(id, lon, lat, ground - stretch * Math.min(depth, 12), ground + 0.4, radius, LOOK.bore));
      add(make.cylinder(id, lon, lat, ground + 0.4, ground + 0.5, radius * 1.6, LOOK.iron));
      const words = [`Bore ${p.depth.from[0] === 'rec' ? `${depth.toFixed(0)} m deep` : ''}`.trim(), p.waterDepth !== undefined ? `water at ${p.waterDepth.toFixed(1)} m` : undefined];
      label(Cesium.Cartesian3.fromDegrees(lon, lat, ground + 0.9), words.filter(Boolean).join(', '), id, { size: 11, near: labelsWithinM * 2 });
      return true;
    }
    if (siteOutlines && p.outline?.length) return addSiteOutline({ id, asset, ground, colour });
    solid.push(make.box(id, lon, lat, ground + 0.1, [2, 2, 0.2], LOOK.concrete));
    label(Cesium.Cartesian3.fromDegrees(lon, lat, ground + 0.6), p.name ? `${p.type}: ${p.name}` : p.type, id, { size: 11, near: labelsWithinM * 2 });
    return true;
  }

  /**
   * A facility with its real outline (from the council): the ground inside it in its network's colour, a
   * fence round it, and its name high above, readable from afar. Its depth and what is inside are not
   * recorded, so nothing is drawn below the ground.
   */
  function addSiteOutline({ id, asset, ground, colour }) {
    const p = asset.properties;
    const tint = typeof colour === 'string' ? Cesium.Color.fromCssColorString(colour) : colour;
    for (const polygon of p.outline) {
      const ring = polygon[0].slice(0, -1);
      if (ring.length < 3) continue;
      const holes = polygon.slice(1).map((hole) => new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(hole.slice(0, -1).flat())));
      seeThrough.push(
        new Cesium.GeometryInstance({
          id: { ...id },
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(ring.flat()), holes),
            height: ground - SITE.padBelowM,
            extrudedHeight: ground + SITE.padAboveM,
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(tint.withAlpha(SITE.padAlpha)) },
        }),
      );
      // The fence: a rail all the way round, on posts at the corners.
      const rail = [...ring, ring[0]].map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, ground + SITE.fenceM));
      add(make.tube(id, rail, SITE.railRadiusM, darker(tint)));
      for (const [lon, lat] of ring) add(make.cylinder(id, lon, lat, ground, ground + SITE.fenceM, SITE.postRadiusM, LOOK.iron));
    }
    const [lon, lat] = asset.geometry.coordinates;
    label(Cesium.Cartesian3.fromDegrees(lon, lat, ground + SITE.nameAboveM), p.name ? `${p.type} · ${p.name}` : p.type, id, { size: 14, near: SITE.nameWithinM });
    return true;
  }

  function add(instance, list = solid) {
    if (instance) list.push(instance);
  }

  /**
   * Where a property connection joins its main, a collar on the main (unless the council has a
   * fitting there): `end` is the joining end of the connection, in the pit's frame.
   */
  function addConnection({ id, end, network, colour }) {
    if (fittingsAt.some((f) => Math.hypot(f.at[0] - end[0], f.at[1] - end[1]) < FITTING_NEAR_M)) return;
    const on = pipeAt(end, network, { kind: 'main', within: 1.2 });
    if (!on) return;
    sleeve(id, on.at, on.direction, on.height, Math.max(0.2, 2.2 * on.radius), 1.3 * on.radius, LOOK.connection);
  }

  return { addPipe, addAsset, addConnection, solid, seeThrough };
}
