/**
 * One water network (water supply, wastewater or stormwater) from the council's data:
 * every pipe drawn as a line, coloured by network, tap for details.
 *
 * Data: data/<zone>/<network>.geojson (the mains, manholes, valves, hydrants…) and, loaded once the
 * rest of the zone is on screen, <network>-detail.geojson (property connections and small fittings) –
 * made by scripts/data/convert-qldc-networks.mjs
 *
 * Two ways of drawing, one batched Cesium primitive per file of a zone for each:
 *   - on the surface (normal view): just above the ground, so the pipes read like a map;
 *   - at their depth (underground view): at "ground − depth".
 * Point assets – manholes, valves and hydrants, and close up the fittings (tees, bends, junctions,
 * end caps…), meters, backflow preventers, road gullies, outlets and soakpits – are dots on the
 * surface, tap for details; in the underground view the ones with a chamber or a box at the
 * surface (CONFIG.networks.shaftKinds) also have a shaft from the surface down to their depth.
 * How the lines follow the ground: the ground height is looked up along every pipe
 * (every few metres, so long straight pipes follow dips and rises too). Cesium can also
 * drape lines over the terrain by itself, but with thousands of pipes that made every
 * frame three to five times slower.
 *
 * The depth of every pipe end is in the data, with where it comes from (recorded or which
 * kind of estimate); the details panel and the excavation view show both.
 */
import { Cesium } from '../map/cesium.js';
import { renderUntil } from '../map/render.js';
import { fetchJson } from '../util/http.js';
import { createZoneContent } from './zoneContent.js';
import { iconImage, iconPixels, symbolOf } from './assetIcons.js';
import { depthAt, pointsAlong } from './pipeGeometry.js';
import { dropStaleHeights, groundHeights } from './groundHeights.js';
import { describePowerAsset, describePowerLine } from './powerCards.js';
import { flowArrows } from '../util/flow.js';

/** Where a depth comes from, in words (codes written by scripts/data/lib/pipe-depth.mjs). */
const DEPTH_SOURCE = {
  rec: { text: "from the council's manhole and pipe levels", tag: 'recorded' },
  nom: { text: "the council's nominal figure for the job, not surveyed", tag: 'nominal' },
  mh: { text: 'depth of the manhole at this end (the pipe may enter it higher up)', tag: 'estimate' },
  nbr: { text: 'another pipe at the same manhole', tag: 'estimate' },
  end: { text: 'copied from the other end of the pipe', tag: 'estimate' },
  main: { text: 'depth of the main it joins', tag: 'estimate' },
  open: { text: 'the pipe comes out of the ground at an outlet', tag: 'estimate' },
  typ: { text: 'typical for this kind of pipe in the district', tag: 'estimate' },
  // Pipes added by hand (src/util/addedPipes.js):
  mine: { text: 'the figure you gave when you added it', tag: 'your figure' },
  none: { text: 'no depth was given when it was added: a usual figure for this kind of pipe', tag: 'estimate' },
};

/** Where the depth of a manhole comes from. */
const MANHOLE_DEPTH_SOURCE = {
  rec: { text: "from the council's lid and bottom levels", tag: 'recorded' },
  pipes: { text: 'the deepest pipe that enters it', tag: 'estimate' },
  typ: { text: 'typical manhole depth in the district', tag: 'estimate' },
};

/** Where the depth of a valve, hydrant, fitting, gully… comes from. */
const FITTING_DEPTH_SOURCE = {
  rec: { text: "from the council's cover and invert levels", tag: 'recorded' },
  pipe: { text: 'depth of the pipe it sits on', tag: 'estimate' },
  typ: { text: 'typical for this kind of asset in the district', tag: 'estimate' },
};

/** What each kind of point asset is called in the details panel. */
const KIND_WORD = { valve: 'valve', hydrant: 'hydrant', fitting: 'fitting', meter: 'meter', backflow: 'backflow preventer', inlet: 'inlet', outlet: 'outlet', device: 'stormwater device' };

const OWNER = { council: 'Council (QLDC)', private: 'Private (property owner)', unknown: 'Not recorded' };

/**
 * How the direction of the water in a pipe is known (scripts/data/lib/pipe-depth.mjs). 'ids': the
 * upstream and downstream nodes of the council's record – what decides for every sewer, and for a
 * stormwater pipe without two levels.
 */
const FLOW_BASIS = {
  levels: 'from its two recorded levels',
  ids: "from the end the council's record calls upstream",
  gully: 'a lead runs from its road gully',
  pumped: 'a pumped main: as the record says, not checked against levels',
  estimate: 'an estimate: away from the nearest reservoir, treatment plant or bore along the pipes. Under pressure the real direction changes with demand',
  'estimate-pumped': 'an estimate: a pumped main, away from the nearest pump station',
};

/** What the council says a valve is for, where it says so (scripts/data/convert-qldc-networks.mjs). */
const VALVE_ROLE = {
  line: 'Shutting the main (the council calls it a sluice, in-line or isolating valve)',
  scour: 'Draining or flushing the main (a scour valve): it shuts nothing',
  irrigation: 'An irrigation supply',
  service: 'A service to a property (a manifold)',
  notLine: 'Not a line valve (found by the council in a trial shutdown)',
};

/** "2026-11-14" as "14 November 2026". */
const dayWords = (day) => new Date(`${day}T00:00:00`).toLocaleDateString('en-NZ', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * An appearance like `plain` (lines in the colour of each pipe) that leaves gaps: `dashPx` drawn,
 * `gapPx` not, measured on screen along the line. Cesium's own dashed lines take one colour for all
 * of them; these keep the colour of each pipe, so selecting a pipe and colouring by year work as for
 * any other line. Falls back to `plain` if Cesium's line shader is not the one this was written for.
 */
function dashedLines(plain, dashPx, gapPx) {
  const DECLARED = 'out vec4 v_color;';
  const SET = 'v_color = color;';
  const vertex = plain.vertexShaderSource;
  if (!vertex.includes(DECLARED) || !vertex.includes(SET) || !vertex.includes('float angle;')) return plain;
  return new Cesium.PolylineColorAppearance({
    translucent: false,
    vertexShaderSource: vertex.replace(DECLARED, `${DECLARED}\nout float v_polylineAngle;`).replace(SET, `${SET}\n    v_polylineAngle = angle;`),
    fragmentShaderSource: `
in vec4 v_color;
in float v_polylineAngle;

void main()
{
    // How far along the line this pixel is, on screen (the way Cesium's own dashed lines work it out).
    float along = cos(v_polylineAngle) * gl_FragCoord.x - sin(v_polylineAngle) * gl_FragCoord.y;
    if (mod(along, ${(dashPx + gapPx).toFixed(1)} * czm_pixelRatio) > ${dashPx.toFixed(1)} * czm_pixelRatio) {
        discard;
    }
    out_FragColor = czm_gammaCorrect(v_color);
}
`,
  });
}

const metres = (value) => `${value.toLocaleString('en-NZ', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} m`;
const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * @param {object} options
 * @param {object} options.viewer
 * @param {(lonLat: number[]) => Promise<Float64Array>} options.sampleGround  ground heights (see src/map/terrain.js)
 * @param {string} options.dataPath
 * @param {{ id: string, label: string, color: string }} options.network   one entry of CONFIG.networks.list
 * @param {number} options.liftM  how far above the ground this network's lines are drawn on the surface
 * @param {object} options.settings   CONFIG.networks (widths, colours shared by all networks)
 * @param {(zoneId: string) => object[]} [options.added]  the pipes and cables added by hand on this device that
 *   this network draws in a zone (src/util/addedPipes.js); asked for whenever the zone is loaded
 */
export function createNetworkLayer({ viewer, sampleGround, dataPath, network, liftM, settings, added = () => [] }) {
  const { scene } = viewer;
  const LAYER_ID = network.id;
  const baseColor = Cesium.Color.fromCssColorString(network.color);
  const privateColor = Cesium.Color.lerp(baseColor, Cesium.Color.WHITE, settings.privateLighten, new Cesium.Color());
  const disusedColor = Cesium.Color.fromCssColorString(settings.disusedColor);
  const highlightColor = Cesium.Color.fromCssColorString(settings.highlightColor);
  const shaftColor = Cesium.Color.fromCssColorString(settings.shaftColor);
  // Opaque: see-through lines are drawn in a later pass that ignores which network is on top.
  const appearance = new Cesium.PolylineColorAppearance({ translucent: false });
  // Pipes added by hand are drawn dashed: nobody should take them for a council record.
  const dashedAppearance = dashedLines(appearance, settings.added.dashPx, settings.added.gapPx);

  // All zones of this network share one group on the map, which is shown or hidden as a whole.
  const group = scene.primitives.add(new Cesium.PrimitiveCollection());
  const symbolScale = new Cesium.NearFarScalar(settings.symbolScale.nearM, 1, settings.symbolScale.farM, settings.symbolScale.far);

  let visible = true;
  let suspended = false; // hidden for a while by the excavation view, whatever the layers panel says
  let showDisused = false;
  let underground = false;
  let depthScale = 1; // underground view: depths are drawn this many times deeper, to tell them apart
  let symbolsShown = true; // the symbols of the point assets (hidden while the open-ground view draws their real shapes)
  // …except those of facilities (pump stations, reservoirs…): few, and they show from afar where one is.
  const symbolShown = (asset) => shown(asset) && (symbolsShown || asset.properties.kind === 'facility');
  let highlighted; // { zone, index } of the selected pipe
  // By year installed (setYears): colour by decade, and/or only the pipes laid between two years.
  let years = { colour: false, from: -Infinity, to: Infinity };
  // Bumped whenever what is shown or its colour changes; each drawing remembers the one it shows.
  let filterVersion = 0;
  const yearBins = settings.years.bins.map((bin) => ({ ...bin, color: Cesium.Color.fromCssColorString(bin.color) }));
  const unknownYearColor = Cesium.Color.fromCssColorString(settings.years.unknownColor);
  const yearColorOf = (year) => (year ? (yearBins.find((bin) => year <= bin.to) ?? yearBins.at(-1)).color : unknownYearColor);
  const inYears = ({ properties: p }) => (years.from === -Infinity && years.to === Infinity) || (p.year !== undefined && p.year >= years.from && p.year <= years.to);

  // Instruments and pumps say which network they belong to: they take its colour.
  const networkColors = new Map(settings.list.map((entry) => [entry.id, Cesium.Color.fromCssColorString(entry.color)]));
  // Electricity: overhead lines, cables and routes each in a colour of their own.
  const kindColors = new Map(Object.entries(network.colors ?? {}).map(([kind, css]) => [kind, Cesium.Color.fromCssColorString(css)]));
  const colorOf = ({ properties: p }) =>
    !p.inUse
      ? disusedColor
      : years.colour
        ? yearColorOf(p.year)
        : p.owner === 'private'
          ? privateColor
          : kindColors.get(p.kind) || (network.pointsOnly && networkColors.get(p.network)) || baseColor;
  const widthOf = ({ properties: p }) => {
    if (p.kind === 'lateral') return settings.widthPx.lateral;
    if (p.kind === 'channel') return settings.widthPx.main;
    if (p.voltage !== undefined) return p.voltage >= 110 ? settings.widthPx.largeMain : p.voltage < 1 ? settings.widthPx.lateral : settings.widthPx.main;
    return p.diameter >= settings.largeMainMm ? settings.widthPx.largeMain : settings.widthPx.main;
  };
  const shown = (feature) => (feature.properties.inUse || showDisused) && inYears(feature);
  const farthest = (feature) => (feature.properties.kind === 'lateral' ? settings.lateralsWithinM : Number.MAX_VALUE);

  /** The per-pipe settings every line of a pipe carries (colour, shown, how far away it is still drawn). */
  function attributesOf(feature, color = colorOf(feature)) {
    return {
      color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
      show: new Cesium.ShowGeometryInstanceAttribute(shown(feature)),
      // Property connections only appear close up; from further away they would bury the mains.
      distanceDisplayCondition: new Cesium.DistanceDisplayConditionGeometryInstanceAttribute(0, farthest(feature)),
    };
  }

  function line(id, positionsWithHeights, width, attributes) {
    return new Cesium.GeometryInstance({
      id,
      geometry: new Cesium.PolylineGeometry({
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(positionsWithHeights),
        width,
        arcType: Cesium.ArcType.NONE, // straight between the points: they already follow the ground
        vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
      }),
      attributes,
    });
  }

  /*
   * A zone is drawn in batches: the main file first, then the detail file (property connections and
   * small fittings, see scripts/data/lib/detail-split.mjs), once the rest of the zone is on screen.
   * Pipes and assets are numbered across the whole zone (`id.index`, `id.asset`), whichever batch
   * they came in; each batch has its own lines, outlines and symbols:
   *   { paths, ground, assetFrom, assetTo, assetGround, drawings: { surface, depth }, outlines, dots }
   */

  /**
   * The lines of every pipe of a batch, at a height worked out per point.
   * @param {(feature: object, groundM: number, share: number) => number} heightAt
   */
  function buildInstances(zone, content, batch, heightAt) {
    const instances = [];
    let cursor = 0; // position of the current line's first point in `batch.ground`
    for (const { index, part, lonLat, shares } of batch.paths) {
      const count = shares.length;
      const ground = batch.ground.subarray(cursor, cursor + count);
      cursor += count;
      // Ground still unknown (see fillGroundGaps): better missing than floating or buried.
      if (!ground.every(Number.isFinite)) continue;

      const feature = content.features[index];
      const withHeights = [];
      for (let i = 0; i < count; i += 1) withHeights.push(lonLat[2 * i], lonLat[2 * i + 1], heightAt(feature, ground[i], shares[i]));
      instances.push(line({ layer: LAYER_ID, zone: zone.id, index, part }, withHeights, widthOf(feature), attributesOf(feature)));
    }
    return instances;
  }

  /**
   * Where an elevation tile failed to download, the ground height of some points is unknown.
   * Points between known ones on the same pipe get a height in between; a pipe with no known
   * point at all cannot be placed and is left out.
   * @returns {number} how many pipes are left out
   */
  function fillGroundGaps(batch) {
    const missing = new Set();
    let cursor = 0;
    for (const { index, shares } of batch.paths) {
      const ground = batch.ground.subarray(cursor, cursor + shares.length);
      cursor += shares.length;
      if (ground.every(Number.isFinite)) continue;
      const known = [...ground.keys()].filter((i) => Number.isFinite(ground[i]));
      if (known.length === 0) {
        missing.add(index);
        continue;
      }
      for (let i = 0; i < ground.length; i += 1) {
        if (Number.isFinite(ground[i])) continue;
        const before = known.findLast((k) => k < i);
        const after = known.find((k) => k > i);
        if (before === undefined) ground[i] = ground[after];
        else if (after === undefined) ground[i] = ground[before];
        else ground[i] = ground[before] + ((ground[after] - ground[before]) * (i - before)) / (after - before);
      }
    }
    return missing.size;
  }

  /** The point assets of a batch: each with its number in the zone and the ground under it. */
  function* assetsOf(content, batch) {
    for (let number = batch.assetFrom; number < batch.assetTo; number += 1) {
      yield { asset: content.assets[number], number, ground: batch.assetGround[number - batch.assetFrom] };
    }
  }

  /** A shaft for every point asset of a batch, from the surface down to its depth (underground view). */
  function buildShafts(zone, content, batch) {
    const shafts = [];
    for (const { asset, number, ground } of assetsOf(content, batch)) {
      if (!Number.isFinite(ground) || !settings.shaftKinds.includes(asset.properties.kind)) continue;
      const [lon, lat] = asset.geometry.coordinates;
      const bottom = ground - asset.properties.depth.at[0] * depthScale;
      const width = asset.properties.kind === 'manhole' ? settings.widthPx.shaft : settings.widthPx.fittingShaft;
      shafts.push(line({ layer: LAYER_ID, zone: zone.id, asset: number }, [lon, lat, ground, lon, lat, bottom], width, attributesOf(asset, shaftColor)));
    }
    return shafts;
  }

  /** How a point asset is drawn: { symbol, fill, ink, size, within } (see CONFIG.networks.assets). */
  function iconStyle(asset) {
    const p = asset.properties;
    const look = settings.assets[p.kind === 'valve' ? (network.id !== 'water' ? 'networkValve' : p.type.startsWith('Toby') ? 'toby' : 'valve') : p.kind] ?? settings.assets.manhole;
    const ownColour = look.color && !years.colour && p.inUse;
    const fill = ownColour ? look.color : colorOf(asset).toCssColorString();
    const symbol = symbolOf(p); // a normally closed valve (the edge of a supply zone) has a hollow symbol
    return { symbol, fill, ink: ownColour ? (look.ink ?? '#ffffff') : '#ffffff', size: iconPixels(symbol), within: look.withinM };
  }
  const iconOf = (style, selected = false) => iconImage(style.symbol, style.fill, { ink: style.ink, selected });

  /** Where the symbol of slot i of n at one place sits, in screen pixels from the place. */
  function ringOffset({ slot, slots }) {
    if (!(slots > 1)) return Cesium.Cartesian2.ZERO;
    const angle = (slot / slots) * Math.PI * 2 - Math.PI / 2;
    const radius = settings.stackedIconRingPx * (slots > 6 ? 1.4 : 1);
    return new Cesium.Cartesian2(Math.cos(angle) * radius, Math.sin(angle) * radius);
  }

  // ---- which way the water runs (the View menu's "Flow direction")
  let flowShown = false;
  let flat = false; // the 2D map: north-up, seen from straight above
  const arrowImages = new Map();
  /**
   * An arrowhead with a dark edge, pointing up: white where the direction comes from the council's
   * records, pale blue where it is an estimate (the water supply).
   */
  function arrowHead(estimate = false) {
    if (arrowImages.has(estimate)) return arrowImages.get(estimate);
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const g = canvas.getContext('2d');
    g.beginPath();
    g.moveTo(size / 2, 3);
    g.lineTo(size - 6, size - 6);
    g.lineTo(size / 2, size - 12);
    g.lineTo(6, size - 6);
    g.closePath();
    g.fillStyle = estimate ? '#a5d8ff' : '#ffffff';
    g.fill();
    g.lineWidth = 3;
    g.lineJoin = 'round';
    g.strokeStyle = '#13232f';
    g.stroke();
    arrowImages.set(estimate, canvas);
    return canvas;
  }
  const arrowShown = (feature) => flowShown && symbolsShown && shown(feature);

  /**
   * Arrows on the mains of a batch whose direction the data supports (`flow`, worked out by the
   * conversion: the gravity networks and their pumped mains), on the surface like the symbols, each
   * turned the way the water runs. Made the first time they are shown.
   */
  function addFlowArrows(zone, content, batch) {
    if (batch.arrows || !flowShown) return;
    const arrows = new Cesium.BillboardCollection();
    let cursor = 0;
    for (const { index, lonLat, shares } of batch.paths) {
      const ground = batch.ground.subarray(cursor, cursor + shares.length);
      cursor += shares.length;
      const feature = content.features[index];
      if (feature.properties.kind !== 'main' || !ground.every(Number.isFinite)) continue;
      for (const arrow of flowArrows(lonLat, ground, feature.properties.flow?.from, settings.flow.everyM, settings.flow.minPipeM)) {
        const position = Cesium.Cartesian3.fromDegrees(arrow.at[0], arrow.at[1], arrow.at[2] + liftM + settings.assetLiftM);
        const ahead = Cesium.Cartesian3.fromDegrees(arrow.towards[0], arrow.towards[1], arrow.towards[2] + liftM + settings.assetLiftM);
        const axis = Cesium.Cartesian3.subtract(ahead, position, new Cesium.Cartesian3());
        if (Cesium.Cartesian3.magnitudeSquared(axis) < 1e-6) continue;
        const made = arrows.add({
          id: { layer: LAYER_ID, zone: zone.id, index },
          position,
          image: arrowHead(String(feature.properties.flow?.basis).startsWith('estimate')),
          width: settings.flow.sizePx,
          height: settings.flow.sizePx,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, settings.flow.withinM),
          scaleByDistance: symbolScale,
          show: arrowShown(feature),
        });
        // How to turn it: in 3D its "up" lies along the pipe; on the flat map by the pipe's bearing.
        const east = (arrow.towards[0] - arrow.at[0]) * Math.cos((arrow.at[1] * Math.PI) / 180);
        const north = arrow.towards[1] - arrow.at[1];
        aims.set(made, { axis: Cesium.Cartesian3.normalize(axis, axis), bearing: Math.atan2(east, north) });
        aim(made);
      }
    }
    batch.arrows = group.add(arrows);
  }

  /** Arrow -> { axis, bearing }: which way it points. */
  const aims = new WeakMap();
  function aim(arrow) {
    const { axis, bearing } = aims.get(arrow);
    arrow.alignedAxis = flat ? Cesium.Cartesian3.ZERO : axis;
    arrow.rotation = flat ? -bearing : 0; // the flat map is north-up: turned clockwise by the bearing
    arrow.scaleByDistance = flat ? undefined : symbolScale; // seen from straight above they are small enough as they are
  }

  /** Called when the map switches between '2d' and '3d': the arrows are turned the other way of working. */
  function setViewMode(mode) {
    flat = mode === '2d';
    for (const content of zones.all()) {
      for (const { arrows } of content.batches) {
        if (!arrows) continue;
        for (let i = 0; i < arrows.length; i += 1) aim(arrows.get(i));
      }
    }
    scene.requestRender();
  }

  /** Shows or hides the arrows of the flow direction (only the gravity networks have any). */
  function setFlowShown(next) {
    flowShown = Boolean(next);
    for (const content of zones.all()) {
      for (const batch of content.batches) {
        if (flowShown) addFlowArrows(content.zone, content, batch);
        refreshArrows(content, batch);
      }
    }
    scene.requestRender();
  }
  function refreshArrows(content, batch) {
    if (!batch.arrows) return;
    for (let i = 0; i < batch.arrows.length; i += 1) batch.arrows.get(i).show = arrowShown(content.features[batch.arrows.get(i).id.index]);
  }

  /** The point assets of a batch as symbols on the surface, in both views. */
  function addAssetDots(zone, content, batch) {
    if (batch.assetTo === batch.assetFrom) return;
    const dots = group.add(new Cesium.BillboardCollection());
    batch.dots = dots;
    for (const { asset, number, ground } of assetsOf(content, batch)) {
      if (!Number.isFinite(ground)) continue;
      const [lon, lat] = asset.geometry.coordinates;
      const style = iconStyle(asset);
      dots.add({
        id: { layer: LAYER_ID, zone: zone.id, asset: number },
        position: Cesium.Cartesian3.fromDegrees(lon, lat, ground + liftM + settings.assetLiftM),
        image: iconOf(style),
        width: style.size,
        height: style.size,
        // Several kinds recorded at the same place (a pump station's instruments): fanned out round it.
        pixelOffset: ringOffset(asset.properties),
        disableDepthTestDistance: settings.throughBuildings.kinds.includes(asset.properties.kind) ? settings.throughBuildings.withinM : 0,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, style.within),
        scaleByDistance: symbolScale, // smaller further away, so they do not pile up
        show: symbolShown(asset),
      });
    }
  }

  /** The outline of every facility of a batch (pump station, reservoir…), filled see-through, draped on the ground. */
  function addFacilityOutlines(zone, content, batch) {
    const instances = [];
    for (const { asset, number } of assetsOf(content, batch)) {
      const outline = asset.properties.outline;
      if (!outline) continue;
      for (const polygon of outline) {
        const [outer, ...holes] = polygon.map((ring) => Cesium.Cartesian3.fromDegreesArray(ring.slice(0, -1).flat()));
        if (outer.length < 3) continue;
        instances.push(
          new Cesium.GeometryInstance({
            id: { layer: LAYER_ID, zone: zone.id, asset: number },
            geometry: new Cesium.PolygonGeometry({ polygonHierarchy: new Cesium.PolygonHierarchy(outer, holes.map((hole) => new Cesium.PolygonHierarchy(hole))) }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(colorOf(asset).withAlpha(settings.facilityFillAlpha)),
              show: new Cesium.ShowGeometryInstanceAttribute(shown(asset)),
            },
          }),
        );
      }
    }
    if (!instances.length) return;
    const primitive = group.add(new Cesium.GroundPrimitive({ geometryInstances: instances, classificationType: Cesium.ClassificationType.TERRAIN }));
    batch.outlines.push({ primitive, ids: instances.map((instance) => instance.id), version: filterVersion, fill: true });
  }

  /** Builds one of the two drawings of a batch and waits until it is on screen. */
  async function addDrawing(zone, content, batch, which) {
    if (!content.isWanted() || batch.drawings[which]) return; // zone unloaded meanwhile, or already drawn
    const instances =
      which === 'surface'
        ? buildInstances(zone, content, batch, (feature, ground) => ground + (feature.properties.aboveGroundM ?? liftM))
        : [
            ...buildInstances(zone, content, batch, (feature, ground, share) =>
              // A few pipes are recorded as laid above ground: they stay on the surface.
              feature.properties.aboveGround ? ground + (feature.properties.aboveGroundM ?? liftM) : ground - depthAt(feature.properties, share).centre * depthScale,
            ),
            ...buildShafts(zone, content, batch),
          ];
    if (instances.length === 0) return;
    const primitive = group.add(new Cesium.Primitive({ geometryInstances: instances, appearance: batch.dashed ? dashedAppearance : appearance, show: (which === 'depth') === underground }));
    batch.drawings[which] = { primitive, ids: instances.map((instance) => instance.id), version: filterVersion };
    // The lines are built in the background; wait until they are on screen. A hidden drawing
    // (or a hidden network) is only built once it is shown, so there is nothing to wait for then.
    await renderUntil(scene, () => primitive.ready || !content.isWanted() || !primitive.show || !group.show);
  }

  const SHOW = Cesium.ShowGeometryInstanceAttribute.toValue(true);
  const HIDE = Cesium.ShowGeometryInstanceAttribute.toValue(false);

  /** Every drawing of a zone: the lines of each batch (surface and depth) and the facility outlines. */
  const drawingsOf = (content) => content.batches.flatMap((batch) => [...Object.values(batch.drawings), ...batch.outlines]);

  /**
   * Brings a zone up to date with the switches ("Disused pipes", years), also when they changed
   * while a drawing was being made. Ids are visited in the order the lines were made, which keeps
   * Cesium's look-up of each line instant.
   */
  function applyFilters(content) {
    const colours = new Map(); // colour -> its attribute value, made once
    const valueOf = (color) => {
      if (!colours.has(color)) colours.set(color, Cesium.ColorGeometryInstanceAttribute.toValue(color));
      return colours.get(color);
    };
    for (const drawing of drawingsOf(content)) {
      if (drawing.version === filterVersion || !drawing.primitive.ready) continue;
      for (const id of drawing.ids) {
        const thing = thingOf(content, id);
        const attributes = drawing.primitive.getGeometryInstanceAttributes(id);
        if (!attributes) continue;
        attributes.show = shown(thing) ? SHOW : HIDE;
        if (drawing.fill) attributes.color = valueOf(colorOf(thing).withAlpha(settings.facilityFillAlpha));
        else if (id.asset === undefined) attributes.color = valueOf(colorOf(thing)); // shafts keep their grey
      }
      drawing.version = filterVersion;
    }
    for (const { dots } of content.batches) {
      if (!dots) continue;
      for (let i = 0; i < dots.length; i += 1) {
        const point = dots.get(i);
        const thing = thingOf(content, point.id);
        point.show = symbolShown(thing);
        point.image = iconOf(iconStyle(thing));
      }
    }
    for (const batch of content.batches) refreshArrows(content, batch);
    if (highlighted?.zone === content.zone.id) highlight(highlighted);
  }

  /**
   * Shows the drawings that match the current view (surface or underground) and brings them up to
   * date with the switches – also those flipped while they were being made or while they were hidden
   * (a hidden drawing is not built, so its per-pipe settings cannot be changed until it is shown).
   */
  async function catchUp(content) {
    if (!content.isWanted()) return; // taken off the map meanwhile: its drawings are gone
    await Promise.all(
      content.batches.map(async (batch) => {
        if (underground) await addDrawing(content.zone, content, batch, 'depth');
        const { surface, depth } = batch.drawings;
        if (surface) surface.primitive.show = !underground;
        if (depth) depth.primitive.show = underground;
        const onShow = underground ? depth : surface;
        if (onShow && !onShow.primitive.ready && group.show) {
          await renderUntil(scene, () => onShow.primitive.ready || !content.isWanted() || !group.show);
        }
      }),
    );
    if (!content.isWanted()) return; // …or while its lines were being built
    // Flow direction switched on while this zone was loading: its arrows are made now.
    for (const batch of content.batches) addFlowArrows(content.zone, content, batch);
    applyFilters(content);
  }

  /**
   * Adds the features of one file to a zone and draws them as a new batch.
   * @param {object[]} official  features of the council's official dataset: the newer database's
   *   statuses apply to them (pipes since removed are left out, abandoned ones marked)
   * @param {object[]} [newer]   pipes only the newer database has – or pipes added by hand
   * @param {{ dashed?: boolean }} [look]  dashed: its lines are drawn with gaps (pipes added by hand)
   */
  async function addBatch(zone, content, official, newer = [], look = {}) {
    const status = content.newerStatus;
    const all = official.filter((f) => f.geometry && (f.geometry.type === 'Point' || status[f.properties.id] !== 'Removed'));
    for (const { properties: p } of all) {
      const newerStatus = p.kind === 'main' || p.kind === 'lateral' ? status[p.id] : undefined;
      if (!newerStatus) continue;
      p.inUse = false;
      p.status = newerStatus;
      p.statusFrom = 'newer';
    }
    all.push(...newer);
    const features = all.filter((f) => f.geometry?.type === 'LineString' || f.geometry?.type === 'MultiLineString');
    const assets = all.filter((f) => f.geometry?.type === 'Point');
    if (features.length === 0 && assets.length === 0) return;

    const featureFrom = content.features.length;
    content.features.push(...features);
    const batch = { paths: [], ground: new Float64Array(0), assetFrom: content.assets.length, assetTo: 0, assetGround: new Float64Array(0), drawings: {}, outlines: [], dots: undefined, dashed: Boolean(look.dashed) };
    content.assets.push(...assets);
    batch.assetTo = content.assets.length;

    features.forEach((feature, n) => {
      for (const path of pointsAlong(feature.geometry, settings.followGroundEveryM)) batch.paths.push({ index: featureFrom + n, ...path });
    });
    // The ground under every point: stored in the files (scripts/data/bake-ground.mjs), or else looked up
    // from the terrain. Per pipe, the points of its lines one after the other – the order they are stored in.
    const alongPipe = features.map(() => []);
    for (const path of batch.paths) for (const value of path.lonLat) alongPipe[path.index - featureFrom].push(value);
    [batch.ground, batch.assetGround] = await Promise.all([
      groundHeights(features.map((feature, n) => ({ stored: feature.properties.ground, lonLat: alongPipe[n] })), sampleGround),
      groundHeights(assets.map((asset) => ({ stored: asset.properties.ground, lonLat: asset.geometry.coordinates.slice(0, 2) })), sampleGround),
    ]);
    for (const { properties } of all) delete properties.ground; // only needed to get here
    if (!content.isWanted()) return;
    content.missingPipes += fillGroundGaps(batch);

    // On the map from here: recorded first, so a zone unloaded meanwhile takes all of it away.
    content.batches.push(batch);
    addAssetDots(zone, content, batch);
    addFlowArrows(zone, content, batch);
    addFacilityOutlines(zone, content, batch);
    await addDrawing(zone, content, batch, 'surface');
    await catchUp(content);
  }

  /** Loads one zone's main file: returns its content once on the map (see zoneContent.js). */
  async function loadZone(zone, isWanted) {
    // The official dataset, and – for the pipe networks – what the council's newer (test) database
    // adds to it: pipes it does not have yet, and pipes since marked abandoned or removed.
    // (A network with no files of its own only draws what is added by hand.)
    const [collection, updates] = await Promise.all([
      network.noFiles ? null : fetchJson(`${dataPath}/${zone.id}/${network.id}.geojson`, { optional: true }),
      network.noFiles || network.pointsOnly || network.updates === false ? null : fetchJson(`${dataPath}/${zone.id}/${network.id}-updates.geojson`, { optional: true }),
    ]);
    // Ground heights stored for another spacing of points along the pipes are of no use.
    dropStaleHeights(collection, settings.followGroundEveryM);
    dropStaleHeights(updates, settings.followGroundEveryM);
    const content = {
      zone,
      hasData: collection !== null,
      features: [], // the pipes; `id.index` points into this list
      assets: [], // manholes, valves, hydrants…; `id.asset` points into this list
      batches: [],
      newerStatus: updates?.statuses ?? {},
      missingPipes: 0,
      details: undefined, // the loading of the detail file, once asked for
      isWanted,
    };
    if (isWanted()) await addBatch(zone, content, collection?.features ?? [], updates?.features ?? []);
    // The pipes and cables added by hand on this device: one more batch, drawn dashed.
    if (isWanted()) await addBatch(zone, content, [], added(zone.id), { dashed: true });
    return content;
  }

  /**
   * Draws a zone again, from its main file and what is added by hand – after a pipe was added,
   * changed or deleted. Its detail file is to be asked for again afterwards (loadZoneDetails).
   */
  async function reloadZone(zone) {
    zones.unload(zone.id);
    await zones.load(zone);
  }

  /**
   * Loads the detail file of a zone already on the map (property connections, tobies, fittings,
   * meters, gullies…) and draws it. Resolves once it is on the map; asking again waits for the same load.
   */
  function loadZoneDetails(zone) {
    const content = zones.get(zone.id);
    if (!content || network.pointsOnly || network.noFiles) return Promise.resolve();
    content.details ??= (async () => {
      const collection = await fetchJson(`${dataPath}/${zone.id}/${network.id}-detail.geojson`, { optional: true });
      if (!collection || !content.isWanted()) return;
      dropStaleHeights(collection, settings.followGroundEveryM);
      await addBatch(zone, content, collection.features ?? []);
    })().catch((error) => {
      content.details = undefined; // so it can be tried again
      throw error;
    });
    return content.details;
  }

  function disposeZone(content) {
    if (highlighted?.zone === content.zone.id) highlighted = undefined;
    for (const batch of content.batches) {
      for (const { primitive } of [...Object.values(batch.drawings), ...batch.outlines]) group.remove(primitive); // also frees its GPU memory
      if (batch.dots) group.remove(batch.dots);
      if (batch.arrows) group.remove(batch.arrows);
    }
    scene.requestRender();
  }

  const zones = createZoneContent({ load: loadZone, dispose: disposeZone });

  /** The pipe or point asset an id points at. */
  const thingOf = (content, id) => (id.asset !== undefined ? content.assets[id.asset] : content.features[id.index]);
  const sameThing = (a, b) => (a.asset !== undefined ? a.asset === b.asset : b.asset === undefined && a.index === b.index);

  /** Changes the per-line attributes (colour, show) of every line of one pipe or point asset, in both drawings. */
  function updateLines(content, target, change) {
    for (const batch of content.batches) {
      for (const { primitive, ids } of Object.values(batch.drawings)) {
        if (!primitive.ready) continue;
        for (const id of ids) {
          if (!sameThing(id, target)) continue;
          const attributes = primitive.getGeometryInstanceAttributes(id);
          if (attributes) change(attributes, id);
        }
      }
    }
  }

  /** The symbol of a point asset on the surface, if it has one. */
  function dotOf(content, number) {
    const dots = content.batches.find((batch) => number >= batch.assetFrom && number < batch.assetTo)?.dots;
    if (!dots) return undefined;
    for (let i = 0; i < dots.length; i += 1) {
      const point = dots.get(i);
      if (point.id.asset === number) return point;
    }
    return undefined;
  }

  function setVisible(next) {
    visible = next;
    group.show = visible && !suspended;
    scene.requestRender();
    if (group.show) for (const content of zones.all()) catchUp(content);
  }

  /** Hides the network for a while (the excavation view draws its own pipes), without touching the layers panel. */
  function setSuspended(next) {
    suspended = next;
    setVisible(visible);
  }

  /** Applies a change of the switches to every loaded zone; a selected pipe that is now hidden is let go. */
  function refilter() {
    filterVersion += 1;
    const selected = highlighted && zones.get(highlighted.zone);
    if (selected && !shown(thingOf(selected, highlighted))) highlight(undefined);
    for (const content of zones.all()) applyFilters(content);
    scene.requestRender();
  }

  /** Shows or hides the pipes that are abandoned or not in use. */
  function setShowDisused(next) {
    showDisused = next;
    refilter();
  }

  /**
   * By year installed: `colour` colours pipes and assets by decade (CONFIG.networks.years); only
   * those laid from `from` to `to` are shown (things without a year only when no range is set).
   */
  function setYears(next) {
    years = { colour: Boolean(next.colour), from: next.from ?? -Infinity, to: next.to ?? Infinity };
    refilter();
  }

  /** Switches between pipes on the surface and pipes at their depth. */
  async function setUnderground(next) {
    underground = next;
    await Promise.all(zones.all().map((content) => catchUp(content)));
    scene.requestRender();
  }

  /** Shows or hides the symbols of the point assets (the lines of the pipes stay). */
  function setSymbolsShown(next) {
    symbolsShown = next;
    for (const content of zones.all()) {
      for (const { dots } of content.batches) {
        if (!dots) continue;
        for (let i = 0; i < dots.length; i += 1) dots.get(i).show = symbolShown(thingOf(content, dots.get(i).id));
      }
      for (const batch of content.batches) refreshArrows(content, batch);
    }
    scene.requestRender();
  }

  /** Underground view: draws every depth `next` times deeper (1: to scale). The drawings at depth are made again. */
  async function setDepthScale(next) {
    if (next === depthScale) return;
    depthScale = next;
    for (const content of zones.all()) {
      for (const batch of content.batches) {
        if (!batch.drawings.depth) continue;
        group.remove(batch.drawings.depth.primitive);
        delete batch.drawings.depth;
      }
    }
    await Promise.all(zones.all().map((content) => catchUp(content)));
    scene.requestRender();
  }

  /** Colours one pipe or point asset as "selected", or clears the selection with `undefined`. */
  function highlight(id) {
    const paint = (content, target, selected) => {
      const thing = thingOf(content, target);
      const lineColor = selected ? highlightColor : target.asset !== undefined ? shaftColor : colorOf(thing);
      updateLines(content, target, (attributes) => (attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(lineColor)));
      if (target.asset !== undefined) {
        const dot = dotOf(content, target.asset);
        if (dot) {
          // Bigger as well as yellow: hydrants are yellow already.
          const style = iconStyle(thing);
          dot.image = iconOf(style, selected);
          dot.width = dot.height = selected ? style.size * settings.selectedIconGrow : style.size;
        }
      }
    };

    const previous = highlighted && zones.get(highlighted.zone);
    if (previous && thingOf(previous, highlighted)) paint(previous, highlighted, false);
    highlighted = undefined;

    const content = id && zones.get(id.zone);
    if (content && thingOf(content, id)) {
      highlighted = { zone: id.zone, index: id.index, asset: id.asset };
      paint(content, highlighted, true);
    }
    scene.requestRender();
  }

  /** The depth rows of the details panel. */
  function depthRows({ kind, depth, flow, inUse, source }) {
    const gravity = depth.measure === 'invert';
    const [first, last] = [0, 1].map((end) => ({ value: depth.at[end], from: depth.from[end] }));
    const word = gravity ? 'Depth' : 'Cover';
    // About one in ten recorded sewer depths is exactly 1.00 m – more likely a stand-in than a survey.
    const basis = (end) => `${DEPTH_SOURCE[end.from]?.text}${end.from === 'rec' && end.value === 1 ? ' (a round 1.00 m, possibly assumed)' : ''}`;

    // Pipes whose flow direction the data supports: the ends are named by the way the water runs (the
    // arrows of "Flow direction" point the same way). A pumped main runs from its pump end, uphill or not.
    // A main has that direction or none (`flow`): the end its "upstream" level was paired with
    // (`depth.upstream`) places the depths and says nothing of the flow. A gravity property connection
    // has no `flow`; it runs from the property to the main, and there `depth.upstream` is that end.
    const from = flow?.from ?? (kind === 'lateral' && gravity ? depth.upstream : undefined);
    const names = flow?.basis === 'pumped' ? ['pump end', 'far end'] : String(flow?.basis).startsWith('estimate') ? ['end nearer the source', 'far end'] : ['upper end', 'lower end'];
    // A sewer keeps the direction of the council's record even when its two levels rise that way: said here.
    const levelsAgainst = flow?.levelsAgainst === undefined ? '' : `. Its two recorded levels say the opposite (by ${metres(flow.levelsAgainst)}): one of them is probably wrong`;
    // A sewer in use with no direction says why it has no arrow (the council's newer pipes are not read for it).
    const noDirection = network.id === 'wastewater' && kind === 'main' && inUse && source !== 'newer' ? "Not recorded – the council's record does not say which end is upstream" : undefined;
    const runs = { label: 'Water runs', value: flow ? `From the ${names[0]} to the ${names[1]} – ${FLOW_BASIS[flow.basis]}${levelsAgainst}` : noDirection };

    if (first.value === last.value && first.from === last.from) {
      return [
        { label: word, value: metres(first.value), tag: DEPTH_SOURCE[first.from]?.tag },
        { label: `${word} basis`, value: basis(first) },
        runs,
      ];
    }
    const ends =
      from !== undefined
        ? [
            { name: names[0], ...(from === 0 ? first : last) },
            { name: names[1], ...(from === 0 ? last : first) },
          ]
        : [
            { name: 'one end', ...first },
            { name: 'other end', ...last },
          ];
    return [
      ...ends.map((end) => ({ label: `${word}, ${end.name}`, value: metres(end.value), tag: DEPTH_SOURCE[end.from]?.tag })),
      { label: `${word} basis`, value: ends.map((end) => `${capitalise(end.name)}: ${basis(end)}`).join('. ') },
      runs,
    ];
  }

  /** Plain-language description of a picked manhole for the details panel. */
  function describeManhole(manhole) {
    const p = manhole.properties;
    const from = MANHOLE_DEPTH_SOURCE[p.depth.from[0]];
    return {
      title: p.type,
      subtitle: `${network.label} · manhole${p.owner === 'private' ? ' · private' : ''}`,
      rows: [
        { label: 'Depth', value: metres(p.depth.at[0]), tag: from?.tag },
        { label: 'Depth basis', value: `${from?.text}${p.depth.from[0] === 'rec' && p.depth.at[0] === 1 ? ' (a round 1.00 m, possibly assumed)' : ''}` },
        { label: 'Chamber', value: [p.diameter ? `${p.diameter} mm` : undefined, p.material].filter(Boolean).join(', ') || undefined },
        { label: 'Lid', value: p.cover },
        { label: 'Installed', value: p.year },
        { label: 'Status', value: p.inUse ? (p.status ?? 'In use') : p.status },
        { label: 'Owner', value: OWNER[p.owner] ?? 'Other' },
        { label: 'Street', value: [p.street, p.suburb].filter(Boolean).join(', ') || undefined },
        { label: 'Council confidence', value: p.confidence },
        { label: 'Source', value: `QLDC asset ${p.id}` },
      ],
      note: 'Depth: from the lid down to the bottom of the manhole. Approximate – never dig based on this map; always check beforeUdig.',
    };
  }

  /** Plain-language description of a picked valve, hydrant, fitting, meter, gully… for the details panel. */
  function describeFitting(fitting) {
    const p = fitting.properties;
    const from = FITTING_DEPTH_SOURCE[p.depth.from[0]];
    // Gullies, soakpits and the like are chambers: their depth is to their own bottom.
    const chamber = p.kind === 'inlet' || p.kind === 'device';
    return {
      title: p.type,
      subtitle: `${network.label} · ${KIND_WORD[p.kind] ?? 'asset'}${p.owner === 'private' ? ' · private' : ''}`,
      rows: [
        { label: 'Position', value: p.position ? `Normally ${p.position}` : undefined },
        { label: 'Used for', value: VALVE_ROLE[p.role] },
        { label: 'Size on record', value: p.sizeDoubt ? 'doubtful: every valve of its as-built job has the same' : undefined },
        { label: "Council's note", value: p.note },
        { label: 'Size', value: p.diameter ? `${p.diameter} mm` : undefined },
        { label: chamber ? 'Depth' : 'Depth to the pipe', value: metres(p.depth.at[0]), tag: from?.tag },
        { label: 'Depth basis', value: from?.text },
        { label: 'Make', value: p.make },
        { label: 'Installed', value: p.year },
        { label: 'Status', value: p.inUse ? (p.status ?? 'In use') : p.status },
        { label: 'Owner', value: OWNER[p.owner] ?? 'Other' },
        { label: 'Street', value: [p.street, p.suburb].filter(Boolean).join(', ') || undefined },
        { label: 'Council confidence', value: p.confidence },
        { label: 'Source', value: `QLDC asset ${p.id}` },
      ],
      note: `Depth: from the surface down to the bottom of ${chamber ? 'it' : 'the pipe at this point'}. Approximate – never dig based on this map; always check beforeUdig.`,
    };
  }

  /** A facility: pump station, reservoir, treatment plant… */
  function describeFacility(facility) {
    const p = facility.properties;
    return {
      title: p.name ?? p.type,
      subtitle: `${network.label} · ${p.type.toLowerCase()}${p.owner === 'private' ? ' · private' : ''}`,
      rows: [
        { label: 'Kind', value: p.name ? p.type : undefined },
        { label: 'Installed', value: p.year },
        { label: 'Status', value: p.inUse ? (p.status ?? 'In use') : p.status },
        { label: 'Owner', value: OWNER[p.owner] ?? 'Other' },
        { label: 'Street', value: [p.street, p.suburb].filter(Boolean).join(', ') || undefined },
        { label: 'Source', value: `QLDC asset ${p.id}` },
      ],
      note: 'The outline on the map is the site as the council records it.',
    };
  }

  /** A groundwater bore or well of the regional council. */
  function describeBore(bore) {
    const p = bore.properties;
    return {
      title: `Bore ${p.id ?? ''}`.trim(),
      subtitle: `Groundwater · ${(p.type ?? 'bore').toLowerCase()}${p.inUse ? '' : ' · not in use'}`,
      rows: [
        { label: 'Depth', value: p.depth.from[0] === 'rec' ? metres(p.depth.at[0]) : 'Not recorded', tag: p.depth.from[0] === 'rec' ? 'recorded' : undefined },
        { label: 'Water found at', value: p.waterDepth !== undefined ? `${metres(p.waterDepth)} below ground` : undefined },
        { label: 'Screen (where water enters)', value: p.screen ? `${metres(p.screen[0])} to ${metres(p.screen[1])}` : undefined },
        { label: 'Diameter', value: p.diameter ? `${p.diameter} mm` : undefined },
        { label: 'Use', value: p.uses?.join(', ') },
        { label: 'Aquifer', value: p.aquifer },
        { label: 'Drilled', value: [p.year, p.method].filter(Boolean).join(', ') || undefined },
        { label: 'Status', value: p.status },
        { label: 'Monitored', value: p.monitored ? [p.monitored, p.siteName].filter(Boolean).join(' – ') : undefined },
        { label: 'Measured here', value: p.measures?.map((m) => m.what + (m.since ? ` (since ${m.since})` : '')).join('; ') },
        { label: 'Static water level', value: p.staticWater !== undefined ? `${metres(p.staticWater)} below ground` : undefined },
        { label: 'Position accurate to', value: p.accuracy },
        { label: 'Source', value: `Otago Regional Council, well ${p.id}` },
      ],
      note: 'Depths are below the ground at the bore, as the regional council records them.',
    };
  }

  /** A monitoring site or sampling point of the regional council. */
  function describeMonitoring(site) {
    const p = site.properties;
    return {
      title: p.name ?? p.type,
      subtitle: `Regional council · ${p.type.toLowerCase()}`,
      rows: [
        ...(p.measures ?? []).map((m, i) => ({ label: i === 0 ? 'Measured here' : '', value: m.what + (m.since ? ` – since ${m.since}` : '') })),
        { label: 'Catchment', value: p.catchment },
        { label: 'Height above sea level', value: p.elevation !== undefined ? `${p.elevation} m` : undefined },
        { label: 'Source', value: `Otago Regional Council${p.id ? `, site ${p.id}` : ''}` },
      ],
      note: 'What the regional council measures at this place (the readings themselves are on lawa.org.nz and the council\'s website).',
    };
  }

  /** Instruments or machinery of the council at one place (its test dataset): what is there, as a list. */
  function describeEquipment(group) {
    const p = group.properties;
    const NETWORK_NAME = { water: 'Water supply', wastewater: 'Wastewater', stormwater: 'Stormwater' };
    const line = (item) =>
      // The kind in brackets only when the title does not already say it (a flow switch among the flow meters).
      [item.times ? `${item.times} ×` : undefined, item.about ?? item.what, item.about && !item.what.toLowerCase().startsWith(p.type.toLowerCase().replace(/s$/, '')) ? `(${item.what.toLowerCase()})` : undefined, item.year, item.make, item.status]
        .filter(Boolean)
        .join(' · ');
    return {
      title: p.count > 1 ? `${p.count} ${p.type.toLowerCase()}` : (p.items[0]?.what ?? p.type),
      subtitle: `${NETWORK_NAME[p.network] ?? 'Three waters'} · ${p.kind === 'machine' ? 'machinery' : 'instruments'} · council test data`,
      rows: [
        { label: 'At', value: p.site },
        ...p.items.map((item, i) => ({ label: p.count > 1 ? String(i + 1) : 'What', value: line(item) })),
        { label: '', value: p.more ? `…and ${p.more} more` : undefined },
        { label: 'First installed', value: p.year },
        { label: 'Status', value: p.inUse ? undefined : p.status },
        { label: 'Street', value: [p.street, p.suburb].filter(Boolean).join(', ') || undefined },
        { label: 'Source', value: `QLDC test dataset${p.id ? `, asset ${p.id}` : ''}` },
      ],
      note: 'From the council\'s test dataset ("QLDC 3W Schema Test"): no licence stated, and it may change. The position is where the council records it – often the middle of the site, not the exact spot.',
    };
  }

  /** An open stormwater channel (drain, swale…). */
  function describeChannel(feature) {
    const p = feature.properties;
    const from = p.depth.from[0];
    return {
      title: p.type,
      subtitle: `${network.label} · open channel${p.owner === 'private' ? ' · private' : ''}`,
      rows: [
        { label: 'Depth of the channel', value: metres(p.depth.at[0]), tag: from === 'rec' ? 'recorded' : 'estimate' },
        { label: 'Width at the top', value: p.width ? metres(p.width) : undefined },
        { label: 'Lining', value: p.material },
        { label: 'Installed', value: p.year },
        { label: 'Status', value: p.inUse ? (p.status ?? 'In use') : p.status },
        { label: 'Owner', value: OWNER[p.owner] ?? 'Other' },
        { label: 'Street', value: [p.street, p.suburb].filter(Boolean).join(', ') || undefined },
        { label: 'Length', value: p.length ? `${p.length.toLocaleString('en-NZ')} m` : undefined },
        { label: 'Source', value: `QLDC asset ${p.id}` },
      ],
      note: 'Open to the sky: drawn on the surface in every view.',
    };
  }

  /** A pipe or cable added by hand on this device (src/util/addedPipes.js). */
  function describeAdded(feature) {
    const p = feature.properties;
    const from = DEPTH_SOURCE[p.depth.from[0]];
    return {
      title: p.type,
      subtitle: `${network.label} · added by you`,
      rows: [
        { label: 'Record', value: `Added by you${p.added ? ` on ${dayWords(p.added)}` : ''}${p.edited ? `, changed on ${dayWords(p.edited)}` : ''} – not in the council's records`, tag: 'added by hand' },
        { label: 'Size', value: p.diameter ? `${p.diameter} mm` : 'Not given' },
        { label: 'Material', value: p.material },
        { label: 'Length', value: `${p.length.toLocaleString('en-NZ')} m` },
        { label: 'Cover', value: metres(p.depth.at[0]), tag: from?.tag },
        { label: 'Cover basis', value: from ? capitalise(from.text) : undefined },
        { label: 'Note', value: p.note },
      ],
      note: 'Drawn by hand and kept on this device only: its place and depth are as good as the hand that drew it. Cover: ground to the top of the pipe. Approximate – never dig based on this map; always check beforeUdig.',
    };
  }

  /** Plain-language description of a picked pipe or point asset for the details panel. */
  function describe(id) {
    const content = zones.get(id.zone);
    if (id.asset !== undefined) {
      const asset = content?.assets[id.asset];
      if (!asset) return undefined;
      if (network.kind === 'power') return describePowerAsset(asset.properties);
      if (asset.properties.kind === 'manhole') return describeManhole(asset);
      if (asset.properties.kind === 'facility') return describeFacility(asset);
      if (asset.properties.kind === 'bore') return describeBore(asset);
      if (asset.properties.kind === 'monitoring') return describeMonitoring(asset);
      if (asset.properties.kind === 'instrument' || asset.properties.kind === 'machine') return describeEquipment(asset);
      return describeFitting(asset);
    }
    const feature = content?.features[id.index];
    if (!feature) return undefined;
    const p = feature.properties;
    if (p.source === 'mine') return describeAdded(feature);
    if (network.kind === 'power') return describePowerLine(p);
    if (p.kind === 'channel') return describeChannel(feature);
    const kind = p.kind === 'main' ? 'main' : 'property connection';
    const newer = p.source === 'newer';

    return {
      title: p.type,
      subtitle: `${network.label} · ${kind}${p.owner === 'private' ? ' · private' : ''}`,
      rows: [
        { label: 'Diameter', value: p.diameter ? `${p.diameter} mm` : undefined },
        { label: 'Material', value: p.material },
        { label: 'Installed', value: p.year },
        { label: 'Status', value: (p.inUse ? (p.status ?? 'In use') : p.status) + (p.statusFrom === 'newer' ? " (council's newer database)" : '') },
        { label: 'Owner', value: OWNER[p.owner] ?? p.ownerName ?? 'Other' },
        { label: 'Street', value: [p.street, p.suburb].filter(Boolean).join(', ') || undefined },
        { label: 'Length', value: p.length ? `${p.length.toLocaleString('en-NZ')} m` : undefined },
        ...(p.aboveGround ? [{ label: 'Laid', value: 'Above ground' }] : depthRows(p)),
        { label: 'Council confidence', value: p.confidence },
        { label: 'Record', value: newer ? `Only in the council's newer database${p.recorded ? `, added ${p.recorded}` : ''}` : undefined, tag: newer ? 'test data' : undefined },
        { label: 'Source', value: `QLDC asset ${p.id}` },
      ],
      note:
        (newer
          ? "Not yet in the council's official open dataset (last edited May 2026): taken from its newer test database – no licence stated, may change. Its depth is a typical value, not a recorded one. "
          : p.depth.measure === 'invert'
            ? 'Depth: ground to the bottom inside of the pipe (invert). '
            : 'Cover: ground to the top of the pipe. ') + 'Approximate – never dig based on this map; always check beforeUdig.',
    };
  }

  /** The symbols of this network in the layers panel (only the ones it has). */
  function legendSymbols() {
    const a = settings.assets;
    const symbol = (label, name, fill, ink) => ({ label, icon: iconImage(name, fill, { ink }) });
    if (network.noFiles) return [];
    if (network.kind === 'power') {
      return [
        { label: 'Overhead line (in the air in 3D)', color: network.colors.overhead },
        { label: 'Cable in the ground (typical depth)', color: network.colors.cable },
        { label: 'District Plan route', color: network.colors.route },
        symbol('Substation', 'substation', a.substation.color),
        symbol('National grid tower', 'tower', a.tower.color),
        symbol('Transformer', 'transformer', a.transformer.color),
        symbol('Streetlight (close up)', 'streetlight', a.streetlight.color, a.streetlight.ink),
      ];
    }
    if (network.id === 'bores') return [symbol('Bore or well', 'bore', a.bore.color), symbol('Monitoring site (river, lake, groundwater)', 'waves', a.monitoring.color), symbol('Sampling point', 'sample', a.monitoring.color)];
    if (network.id === 'instruments') {
      const neutral = '#495057';
      return [
        symbol('Flow meter', 'flow', neutral),
        symbol('Level sensor', 'level', neutral),
        symbol('Pressure sensor', 'meter', neutral),
        symbol('Water quality analyser', 'sample', neutral),
        symbol('Rain gauge, other sensor', 'rain', neutral),
        symbol('Pump, machinery', 'pump', neutral),
        { label: 'Disc: blue water supply, red wastewater', color: networkColors.get('water').toCssColorString() },
      ];
    }
    if (network.id === 'water') {
      return [
        symbol('Pump station, reservoir, treatment plant', 'reservoir', network.color),
        symbol('Valve (hollow: normally closed)', 'valve', a.valve.color),
        symbol('Toby (property valve)', 'toby', a.toby.color, a.toby.ink),
        symbol('Hydrant', 'hydrant', a.hydrant.color, a.hydrant.ink),
        symbol('Tee, bend, junction… (close up)', 'tee', network.color),
        symbol('Meter', 'meter', a.meter.color, a.meter.ink),
        symbol('Backflow preventer', 'backflow', a.backflow.color),
      ];
    }
    return [
      symbol('Manhole', 'manhole', network.color),
      symbol('Junction, end, bend… (close up)', 'junction', network.color),
      ...(network.id === 'wastewater'
        ? [symbol('Valve', 'valve', network.color), symbol('Pump station, treatment plant', 'pumpstation', network.color)]
        : [
            symbol('Road gully', 'gully', a.inlet.color),
            symbol('Outlet', 'outlet', network.color),
            symbol('Soakpit, interceptor', 'soakpit', a.device.color, a.device.ink),
            { label: 'Open channel, swale (line)', color: network.color },
          ]),
    ];
  }

  return {
    id: LAYER_ID,
    label: network.label,
    legend: [
      ...(network.noFiles
        ? [{ label: 'Added by you – drawn dashed, like every pipe you add', color: baseColor.toCssColorString() }]
        : network.pointsOnly || network.kind === 'power'
          ? []
          : [
            { label: 'Council / other', color: baseColor.toCssColorString() }, // pipes whose owner is not recorded too
            { label: 'Private', color: privateColor.toCssColorString() },
          ]),
      ...legendSymbols(),
    ],
    get visible() {
      return visible;
    },
    loadZone: zones.load,
    loadZoneDetails,
    unloadZone: zones.unload,
    reloadZone,
    setVisible,
    setSuspended,
    setShowDisused,
    setYears,
    setUnderground,
    setDepthScale,
    setSymbolsShown,
    /** Arrows showing which way the water runs (wastewater and stormwater: the council's levels say). */
    setFlowShown,
    setViewMode,
    highlight,
    describe,
    /** For the excavation view: the pipes and point assets of every loaded zone, while the network is switched on. */
    cutSource: () => (visible ? zones.all().map((content) => ({ zone: content.zone.id, features: content.features, assets: content.assets })) : []),
    isShown: shown,
    pipeColor: colorOf,
    summary: () => undefined, // the page shows one total for all networks (see lengthKm)
    /** Kilometres of pipe in use in a loaded zone, or undefined. */
    lengthKm(zoneId) {
      const content = zones.get(zoneId);
      if (!content?.hasData || network.kind === 'power') return undefined; // power lines are not pipes
      // Open channels are not pipes; pipes added by hand are not the council's.
      return content.features.reduce((sum, f) => sum + (f.properties.inUse && f.properties.kind !== 'channel' && f.properties.source !== 'mine' ? (f.properties.length ?? 0) : 0), 0) / 1000;
    },
    /** Pipes of a loaded zone left off the map because the ground height there could not be downloaded. */
    missingPipes: (zoneId) => zones.get(zoneId)?.missingPipes ?? 0,
  };
}

/**
 * A switch in the layers panel for the pipes that are abandoned or not in use,
 * in every network at once. It loads nothing itself.
 */
export function createDisusedPipesSwitch({ networks, settings }) {
  let visible = false;
  return {
    id: 'disused-pipes',
    label: 'Disused pipes',
    legend: [{ label: 'Abandoned, not in use', color: settings.disusedColor }],
    get visible() {
      return visible;
    },
    loadZone: async () => {},
    unloadZone: () => {},
    setVisible(next) {
      visible = next;
      for (const layer of networks) layer.setShowDisused(next);
    },
    highlight: () => {},
    describe: () => undefined,
    summary: () => undefined,
  };
}
