/**
 * The long section: a face-on drawing of a picked pipe and the pipes that carry on from it
 * (src/tools/pipeRun.js), with the ground above, the manholes and fittings on it and the pipes
 * that cross it (src/ui/profileDrawing.js). Moving along the drawing reads the depth at each
 * point and shows that point on the map.
 */
import { Cesium } from '../map/cesium.js';
import { depthAt, depthTag, diameterM } from '../layers/pipeGeometry.js';
import { assetsOn, buildRun, crossingsOf, runStations } from './pipeRun.js';
import { drawProfile } from '../ui/profileDrawing.js';

const FITTING_LETTERS = { valve: 'V', hydrant: 'H', meter: 'M', backflow: 'B', inlet: 'G', outlet: 'O', device: 'S', facility: 'P' };
const metres = (value, digits = 2) => `${value.toFixed(digits)} m`;

/**
 * @param {object} options
 * @param {object} options.viewer
 * @param {object[]} options.networks       the network layers (src/layers/networkLayer.js)
 * @param {(lonLat: number[]) => Promise<Float64Array>} options.sampleGround
 * @param {HTMLElement} options.panel       the panel in index.html (#profile)
 * @param {object} options.settings         CONFIG.profile
 * @param {string} options.highlightColor
 * @param {(open: boolean) => void} [options.onToggle]
 */
export function createProfileView({ viewer, networks, sampleGround, panel, settings, highlightColor, onToggle }) {
  const { scene } = viewer;
  const svg = panel.querySelector('.profile__svg');
  const drawing = panel.querySelector('.profile__drawing');
  const name = panel.querySelector('.profile__name');
  const summary = panel.querySelector('.profile__summary');
  const readout = panel.querySelector('.profile__readout');
  const modeButtons = [...panel.querySelectorAll('[data-profile-mode]')];
  const highlight = Cesium.Color.fromCssColorString(highlightColor);

  // On the map: the point being read, and a glow along the run.
  const points = scene.primitives.add(new Cesium.PointPrimitiveCollection());
  const dot = points.add({ show: false, pixelSize: 13, color: highlight, outlineColor: Cesium.Color.fromCssColorString('#13232f'), outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY });
  let glow;

  let open = false;
  let mode = 'depth';
  let model; // what is drawn
  let drawn; // the handle drawProfile returns
  let readAt; // the chain being read, if any
  let request = 0;

  /** The pipes of a network in every loaded zone, each with the id the map knows it by. */
  const pipesOf = (network) => network.cutSource().flatMap(({ zone, features }) => features.map((feature, index) => ({ feature, network, id: { layer: network.id, zone, index } })));
  const pipeAt = (id) => networks.find((network) => network.id === id?.layer)?.cutSource().find((source) => source.zone === id.zone)?.features[id.index];

  /** Whether a picked thing is a pipe a long section can be drawn of. */
  function accepts(id) {
    if (!id || id.asset !== undefined) return false;
    const kind = pipeAt(id)?.properties.kind;
    return kind === 'main' || kind === 'lateral';
  }

  function removeGlow() {
    if (glow) scene.primitives.remove(glow);
    glow = undefined;
  }

  function addGlow(stations) {
    removeGlow();
    glow = scene.primitives.add(
      new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({
          geometry: new Cesium.PolylineGeometry({
            positions: Cesium.Cartesian3.fromDegreesArrayHeights(stations.flatMap((s) => [s.lon, s.lat, s.ground + settings.glowLiftM])),
            width: settings.glowPx,
            arcType: Cesium.ArcType.NONE,
            vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
          }),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(highlight.withAlpha(0.6)) },
        }),
        appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
        asynchronous: false,
      }),
    );
  }

  /** Everything the drawing needs, from the picked pipe. */
  async function build(id) {
    const network = networks.find((candidate) => candidate.id === id.layer);
    const feature = pipeAt(id);
    const start = { feature, network, id };
    const usable = (entry) => entry.network.isShown(entry.feature) && entry.feature.properties.kind !== 'channel' && !entry.feature.properties.aboveGround;
    const mains = pipesOf(network).filter((entry) => entry.feature.properties.kind === 'main' && usable(entry));
    const run = feature.properties.kind === 'main' ? buildRun(mains, start, settings) : [{ ...start, reversed: false }];
    const { stations, pieces, length } = runStations(run, settings.stepM);
    if (stations.length < 2 || !(length > 0)) return undefined;

    // The ground along the run; where a height is not known, the nearest known one.
    const ground = await sampleGround(stations.flatMap((station) => [station.lon, station.lat]));
    const known = [...ground.keys()].filter((i) => Number.isFinite(ground[i]));
    if (known.length === 0) return undefined;
    stations.forEach((station, i) => {
      station.ground = Number.isFinite(ground[i]) ? ground[i] : ground[known.reduce((best, k) => (Math.abs(k - i) < Math.abs(best - i) ? k : best))];
    });

    const inRun = new Set(run.map((entry) => entry.feature));
    const others = networks.flatMap(pipesOf).filter((entry) => !inRun.has(entry.feature) && usable(entry) && !entry.feature.properties.aboveGround);
    const onRun = assetsOn(
      stations,
      network.cutSource().flatMap(({ assets }) => assets.filter((asset) => network.isShown(asset)).map((asset) => ({ feature: asset }))),
      settings.assetWithinM,
    );

    const gravity = feature.properties.depth.measure === 'invert';
    return {
      length,
      stations,
      gravity,
      label: network.label,
      pieces: pieces.map((piece, number) => {
        const p = piece.feature.properties;
        const own = stations.filter((station) => station.piece === number);
        // How far the bottom of the pipe drops from one end to the other.
        const fall = own.length > 1 ? Math.abs(own[0].ground - own[0].bottom - (own.at(-1).ground - own.at(-1).bottom)) : 0;
        const slope = (fall / (piece.to - piece.from)) * 100;
        const size = p.diameter ? `${p.diameter} mm` : 'size not recorded';
        const tag = p.aboveGround ? 'above ground' : p.source === 'mine' ? 'added by hand' : depthTag(p);
        return {
          from: piece.from,
          to: piece.to,
          id: piece.id,
          color: network.pipeColor(piece.feature).toCssColorString(),
          selected: piece.feature === feature,
          estimated: tag !== 'recorded',
          tag,
          what: [p.type, size, p.material, p.year ? `laid ${p.year}` : undefined].filter(Boolean).join(' · '),
          // Gravity pipes: how steeply they fall. Pressure pipes follow the ground: their size only.
          text: gravity ? `${size} · ${slope < 0.05 ? 'flat' : `${slope.toFixed(slope < 10 ? 1 : 0)} %`}` : size,
          title: `${p.type}, ${size}${p.material ? `, ${p.material}` : ''} – depth ${tag}`,
        };
      }),
      manholes: onRun
        .filter((entry) => entry.feature.properties.kind === 'manhole')
        .map((entry) => {
          const p = entry.feature.properties;
          return { chain: entry.chain, depth: p.depth.at[0], widthM: (p.diameter ?? 1050) / 1000, title: `${p.type}: ${metres(p.depth.at[0])} deep` };
        }),
      fittings: onRun
        .filter((entry) => entry.feature.properties.kind !== 'manhole')
        .map((entry) => {
          const p = entry.feature.properties;
          return { chain: entry.chain, letter: FITTING_LETTERS[p.kind], color: network.pipeColor(entry.feature).toCssColorString(), title: p.type };
        }),
      crossings: crossingsOf(stations, others).map((entry) => {
        const p = entry.feature.properties;
        const depth = depthAt(p, entry.share).centre;
        return {
          chain: entry.chain,
          depth,
          radiusM: diameterM(p) / 2,
          color: entry.network.pipeColor(entry.feature).toCssColorString(),
          joins: entry.atEnd && entry.network === network,
          small: p.kind === 'lateral',
          title: `${entry.network.label}: ${p.type}${p.diameter ? `, ${p.diameter} mm` : ''}, about ${metres(depth, 1)} down`,
        };
      }),
    };
  }

  function draw() {
    if (!open || !model) return;
    const width = drawing.clientWidth;
    const height = drawing.clientHeight;
    if (width < 120 || height < 80) return;
    drawn = drawProfile(svg, model, { mode, width, height, highlight: highlightColor });
    drawn.setCursor(readAt);
  }

  /** What is at a chain of the run: the station values between the two stations either side, on the same pipe. */
  function at(chain) {
    const { stations } = model;
    let k = stations.findIndex((station) => station.chain >= chain);
    if (k < 0) k = stations.length - 1;
    const b = stations[k];
    const a = k > 0 && stations[k - 1].piece === b.piece ? stations[k - 1] : b;
    const t = b.chain > a.chain ? (chain - a.chain) / (b.chain - a.chain) : 0;
    const mix = (key) => a[key] + (b[key] - a[key]) * t;
    return { piece: model.pieces[b.piece], lon: mix('lon'), lat: mix('lat'), ground: mix('ground'), top: mix('top'), bottom: mix('bottom'), measured: mix('measured') };
  }

  function read(chain) {
    const here = at(chain);
    readAt = chain;
    drawn?.setCursor(chain);
    const depth = model.gravity ? `bottom of the pipe ${metres(here.bottom)} down` : `top of the pipe ${metres(here.top)} down`;
    // A manhole, a fitting or a crossing pipe right here is named too.
    const reach = Math.max(1, model.length * 0.012);
    const near = [...model.manholes, ...model.fittings.filter((fitting) => fitting.letter), ...model.crossings.filter((crossing) => !crossing.joins)]
      .filter((thing) => Math.abs(thing.chain - chain) <= reach)
      .sort((a, b) => Math.abs(a.chain - chain) - Math.abs(b.chain - chain))[0];
    readout.textContent =
      `${Math.round(chain)} m along · ground ${here.ground.toFixed(1)} m above sea level · ${depth} (${here.piece.tag}) · ${here.piece.what}` + (near ? ` — here: ${near.title}` : '');
    dot.position = Cesium.Cartesian3.fromDegrees(here.lon, here.lat, here.ground + settings.glowLiftM);
    dot.show = true;
    scene.requestRender();
  }

  function setOpen(next) {
    if (open === next) return;
    open = next;
    panel.hidden = !open;
    if (!open) {
      request += 1;
      model = undefined;
      dot.show = false;
      removeGlow();
      scene.requestRender();
    }
    onToggle?.(open);
  }

  /** Draws the long section of a picked pipe. Resolves to false when there is nothing to draw. */
  async function show(id) {
    if (!accepts(id)) return false;
    const mine = (request += 1);
    const built = await build(id);
    if (mine !== request) return false; // another pipe was picked meanwhile
    if (!built) return false;
    model = built;
    setOpen(true);

    const depths = model.stations.map((station) => (model.gravity ? station.bottom : station.top));
    name.textContent = `${model.label} · long section`;
    summary.textContent = `${model.pieces.length === 1 ? '1 pipe' : `${model.pieces.length} pipes`} · ${Math.round(model.length)} m · ${model.gravity ? 'depth' : 'cover'} ${Math.min(...depths).toFixed(1)}–${Math.max(...depths).toFixed(1)} m`;
    readout.textContent = 'Move along the drawing to read the depth at any point. Rings: pipes that cross. Paler pipe: its depth is an estimate.';
    dot.show = false;
    readAt = undefined;
    addGlow(model.stations);
    draw();
    scene.requestRender();
    return true;
  }

  for (const button of modeButtons) {
    button.addEventListener('click', () => {
      mode = button.dataset.profileMode;
      for (const other of modeButtons) other.setAttribute('aria-pressed', String(other === button));
      draw();
    });
  }
  panel.querySelector('.profile__close').addEventListener('click', () => setOpen(false));
  for (const type of ['pointerdown', 'pointermove']) {
    svg.addEventListener(type, (event) => {
      if (model && drawn) read(drawn.chainAt(event.clientX));
    });
  }
  new ResizeObserver(draw).observe(drawing);

  return {
    accepts,
    show,
    close: () => setOpen(false),
    get open() {
      return open;
    },
  };
}
