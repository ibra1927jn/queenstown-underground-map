/**
 * "Stop the flow": from a wastewater main tapped on the map, what it takes to work on it – the sewer's
 * counterpart of "Cut the water".
 *
 * A gravity sewer has no valves: the panel lists the manholes to plug so that nothing arrives at the
 * stretch (numbered on the map), the manhole to pump round to (P), the stretch between them (orange, with
 * a dot where each property connection joins it), what keeps arriving and where it all drains to (the way
 * on, in a darker line). A manhole the crew "can't use" makes the search go on to the next one beyond it.
 * A pumped main is taken out by stopping the pumps that feed it: the panel lists them (S), then the valves
 * recorded either side (numbered; one that "won't close" is passed), the places to drain it (D) and where
 * it discharges (→). Every doubt the data holds about the answer is said, and marked "?" on the map.
 *
 * The sewers of the district, already put together into one network, come from data/wastewater-stop.json
 * (scripts/data/build-sewer-stop.mjs), loaded the first time the tool is used. The answers are worked
 * out by src/util/sewerStop.js and put into words by src/util/sewerWords.js; this file only draws them.
 * Everything comes from the council's map, so the panel keeps saying: approximate – a proposal, not an
 * instruction.
 */
import { Cesium } from '../map/cesium.js';
import { el } from '../util/dom.js';
import { fetchJson } from '../util/http.js';
import { unpackSewerNetwork } from '../util/sewerNetwork.js';
import { pieceAt, stopGravity, stopPressure, stretchLines } from '../util/sewerStop.js';
import { answerPanel, notFollowedPanel } from '../util/sewerWords.js';
import { badgeImage, createPlaceFlight, lineList, listLine, onMarkTap, pillButton, section, showLine } from './toolParts.js';

const LAYER_ID = 'sewerStop';

/**
 * @param {object} options
 * @param {object} options.viewer
 * @param {HTMLElement} options.panel          #sewer-panel
 * @param {string} options.dataPath
 * @param {(lonLat: number[]) => Promise<Float64Array>} options.sampleGround
 * @param {object} options.settings            CONFIG.sewerStop
 * @param {() => boolean} [options.isSheet]    true while the panel is a sheet over the bottom of the screen (a phone)
 * @param {() => boolean} [options.canFly]     false while a view holds the camera (the excavation)
 * @param {() => void} [options.beforeFlight]  lets go of the camera (the open ground goes round a place)
 * @param {(open: boolean) => void} [options.onToggle]
 */
export function createSewerStopView({ viewer, panel, dataPath, sampleGround, settings, isSheet, canFly, beforeFlight, onToggle }) {
  const { scene } = viewer;
  const title = panel.querySelector('.shutoff__title');
  const summary = panel.querySelector('.shutoff__summary');
  const notes = panel.querySelector('.sewer__notes');
  const list = panel.querySelector('.shutoff__valves');
  const more = panel.querySelector('.shutoff__more');
  const foot = panel.querySelector('.panel__note');

  const overlay = scene.primitives.add(new Cesium.PrimitiveCollection());
  const flyToPlaces = createPlaceFlight({ viewer, sampleGround, pitchDegrees: settings.viewPitchDegrees, sheetShiftShare: settings.sheetShiftShare, isSheet, canFly, beforeFlight });
  let network; // data/wastewater-stop.json, once loaded and unpacked
  let loading;
  let current; // { tap, pipe: { type, source }, cannotUse: Set<manhole>, wontClose: Set<valve> }
  let run = 0;
  let dot; // the mark of a property connection

  panel.querySelector('.panel__close').addEventListener('click', () => close());

  async function load() {
    if (network) return network;
    loading ??= fetchJson(`${dataPath}/wastewater-stop.json`).then(unpackSewerNetwork);
    try {
      network = await loading;
    } finally {
      loading = undefined; // after a failure, the next tap asks again
    }
    return network;
  }

  /** What the answers are worked out with: QLDC's design figures and limits (CONFIG.sewerStop). */
  const rules = () => {
    const { litresPerConnectionDay, peakFactor, bigPipeMm, blockProperties, maxPlugs } = settings;
    return { litresPerConnectionDay, peakFactor, bigPipeMm, blockProperties, maxPlugs };
  };

  // ---- The panel ----

  const lookOf = (line) => settings.badges[line.look] ?? settings.badges.plug;
  const paragraph = ({ text, flag, soft }) => el('p', { class: flag ? 'shutoff__flag' : soft ? 'shutoff__hint' : 'sewer__text', text });
  /**
   * After the reader's word on a manhole or a valve the answer is worked out again – and the next place to
   * plug, pump round to or close can lie where the map is not looking (145 m further down a trunk; under
   * the panel). Then the view follows, as it did for the first answer; while everything to act on is in
   * sight, the map stays as the reader left it.
   */
  const again = (change) => async () => {
    change();
    const thisRun = run;
    const shown = render();
    if (!shown.answer || (await allInSight(placesToActOn(shown.words))) || thisRun !== run) return;
    flyToPlaces(cornersOf(shown), settings.minViewSpanM, widen());
  };

  /** One line of a list, with the buttons its words ask for. */
  function lineElement(line) {
    const look = lookOf(line);
    const buttons = [];
    if (line.at) {
      buttons.push(
        pillButton('Show', 'Go to it on the map', () => {
          flyToPlaces([line.at], settings.markViewSpanM);
          showLine(panel, line.key);
        }),
      );
    }
    if (line.cannotUse) buttons.push(pillButton("Can't use", 'This manhole cannot be found, opened or plugged: find the next one beyond it', again(() => line.cannotUse.forEach((h) => current.cannotUse.add(h)))));
    if (line.canUse !== undefined) buttons.push(pillButton('It can be used', 'Back to using this manhole', again(() => current.cannotUse.delete(line.canUse))));
    if (line.wontClose !== undefined) buttons.push(pillButton("Won't close", 'This valve cannot be found or will not close: find the next one beyond it', again(() => current.wontClose.add(line.wontClose))));
    if (line.closes !== undefined) buttons.push(pillButton('It closes', 'Back to closing this valve', again(() => current.wontClose.delete(line.closes))));
    return listLine({ key: line.key, badge: line.badge, colors: { background: look.fill, color: look.ink ?? '#ffffff' }, title: line.title, words: line.words, flags: line.flags, note: line.note, buttons });
  }

  function drawPanel(words) {
    summary.textContent = words.summary;
    notes.replaceChildren(...words.notes.map(paragraph));
    list.replaceChildren(...words.lines.map(lineElement));
    // What the reader had unfolded stays unfolded when the answer is worked out again.
    const unfolded = new Set([...more.querySelectorAll('details[open] > summary')].map((heading) => heading.textContent));
    more.replaceChildren(
      ...words.sections.map((part) =>
        section(
          part.heading,
          [
            part.hint ? el('p', { class: 'shutoff__hint', text: part.hint }) : undefined,
            ...(part.notes ?? []).map(paragraph),
            part.lines?.length ? lineList(part.lines.map(lineElement)) : undefined,
            part.steps?.length ? el('ol', { class: 'shutoff__steps' }, ...part.steps.map((text) => el('li', { text }))) : undefined,
          ],
          { open: part.open },
        ),
      ),
    );
    for (const folded of more.querySelectorAll('details')) folded.open = unfolded.has(folded.querySelector('summary').textContent);
    foot.textContent = words.foot;
  }

  // ---- The map ----

  const drawn = (parts, color, width) => stretchLines(network, parts).map(({ line }) => ({ line, color, width }));

  /** The way on of an answer as lines to draw: sewer after sewer, and the pumped mains between. */
  function wayLines(answer) {
    const ways = answer.kind === 'gravity' ? [answer.way] : answer.discharges.map((discharge) => discharge.way);
    return ways.flatMap((way) => way?.steps ?? []).flatMap((step) => drawn(step.kind === 'sewer' ? step.by : (step.discharge?.via ?? []), settings.wayColor, settings.wayWidthPx));
  }

  /** The stretch of an answer as lines to draw, the tapped pipe last (on top) in its own colour. */
  function stretchOf(answer) {
    // Which way the pipe runs cannot be told: there is no stretch, only the pipe itself.
    if (!answer.stretch) return drawn([answer.piece], settings.tappedColor, settings.lineWidthPx);
    const parts = answer.kind === 'gravity' ? answer.stretch.pieces : answer.stretch.parts;
    const tapped = (part) => (Array.isArray(part) ? part[0] : part) === answer.piece;
    const links = answer.stretch.links.map((k) => -(k + 1));
    return [...drawn([...parts.filter((part) => !tapped(part)), ...links], settings.stretchColor, settings.lineWidthPx), ...drawn(parts.filter(tapped), settings.tappedColor, settings.lineWidthPx)];
  }

  /** A small dot: where a property connection joins the stretch. */
  function dotImage() {
    if (!dot) {
      dot = document.createElement('canvas');
      dot.width = dot.height = 24;
      const g = dot.getContext('2d');
      g.beginPath();
      g.arc(12, 12, 8, 0, Math.PI * 2);
      g.fillStyle = settings.connectionColor;
      g.fill();
      g.lineWidth = 4;
      g.strokeStyle = '#ffffff';
      g.stroke();
    }
    return dot;
  }

  /** Every line of the panel that has a place, in the order to draw the marks: the ones to look for last, on top. */
  function marksOf(words) {
    const lines = [...words.lines, ...words.sections.flatMap((part) => part.lines ?? [])].filter((line) => line.at);
    const order = (line) => lookOf(line).order ?? 0;
    return lines.sort((p, q) => order(p) - order(q));
  }

  function drawOverlay(answer, words) {
    overlay.removeAll();
    const lines = answer ? [...wayLines(answer), ...stretchOf(answer)] : [];
    if (lines.length) {
      overlay.add(
        new Cesium.GroundPolylinePrimitive({
          geometryInstances: lines.map(
            ({ line, color, width }) =>
              new Cesium.GeometryInstance({
                geometry: new Cesium.GroundPolylineGeometry({ positions: Cesium.Cartesian3.fromDegreesArray(line.flat()), width }),
                attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString(color)) },
              }),
          ),
          appearance: new Cesium.PolylineColorAppearance(),
        }),
      );
    }
    const marks = overlay.add(new Cesium.BillboardCollection({ scene }));
    const mark = (lonLat, image, size, id) =>
      marks.add({
        id,
        position: Cesium.Cartesian3.fromDegrees(...lonLat),
        image,
        width: size,
        height: size,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY, // always on top: they are what to look for
      });
    for (const at of answer?.stretch?.connectionsAt ?? []) mark(at, dotImage(), settings.connectionDotPx);
    for (const line of marksOf(words)) {
      const look = lookOf(line);
      mark(line.at, badgeImage(line.badge, look.fill, look.ink, look.ring), settings.badgePx * (look.scale ?? 1), { layer: LAYER_ID, mark: line.key });
    }
    scene.requestRender();
  }

  /** Works the answer out again (a manhole that cannot be used, a valve that will not close) and shows it. */
  function render() {
    const { tap } = current;
    const options = { alongM: tap?.alongM, ...rules() };
    const answer = tap?.kind === 'gravity' ? stopGravity(network, tap.piece, current.cannotUse, options) : tap?.kind === 'pumped' ? stopPressure(network, tap.piece, current.wontClose, options) : undefined;
    const words = answer ? answerPanel(network, answer, current, settings) : notFollowedPanel(network, tap, current.pipe);
    drawPanel(words);
    drawOverlay(answer, words);
    return { answer, words };
  }

  /** Where the reader has something to do: the manholes to plug and to pump round to, the valves to close. */
  const placesToActOn = (words) => [...words.lines, ...words.sections.flatMap((part) => part.lines ?? [])].filter((line) => line.cannotUse || line.wontClose !== undefined).map((line) => line.at);

  /**
   * Whether some places all show on the map as it stands: their marks whole on the screen (a badge's width
   * in from its edge), with nothing over them – this panel, the card of the pipe, a bar.
   */
  async function allInSight(places) {
    const map = scene.canvas.getBoundingClientRect();
    const edge = settings.badgePx;
    for (const lonLat of places) {
      const [height] = await sampleGround(lonLat);
      const at = Cesium.SceneTransforms.worldToWindowCoordinates(scene, Cesium.Cartesian3.fromDegrees(lonLat[0], lonLat[1], Number.isFinite(height) ? height : 0));
      if (!at || at.x < edge || at.y < edge || at.x > map.width - edge || at.y > map.height - edge) return false;
      if (document.elementFromPoint(map.left + at.x, map.top + at.y) !== scene.canvas) return false;
    }
    return true;
  }

  /** The two corners of what a view has to show: the stretch, and where to plug, pump round to or close. */
  function cornersOf({ answer, words }) {
    const places = [...stretchOf(answer).flatMap(({ line }) => line), ...placesToActOn(words)];
    if (!places.length) return [];
    let [west, south] = places[0];
    let [east, north] = places[0];
    for (const [lon, lat] of places) {
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
    return [
      [west, south],
      [east, north],
    ];
  }

  /**
   * On a wide screen the panel covers the left of the map, and the card of the pipe may cover as much of
   * its right: how many times wider the first view has to be for the stretch to show between them.
   */
  function widen() {
    if (isSheet?.()) return 1; // a sheet over the bottom of the screen: the flight moves the view up instead
    const width = scene.canvas.clientWidth;
    const covered = Math.max(0, panel.getBoundingClientRect().right - scene.canvas.getBoundingClientRect().left);
    return Math.min(settings.maxWiden, width / Math.max(1, width - 2 * covered));
  }

  function say(text) {
    summary.textContent = text;
    notes.replaceChildren();
    list.replaceChildren();
    more.replaceChildren();
    foot.textContent = '';
  }

  /**
   * Shows what it takes to stop the flow at a wastewater main.
   * @param {{ pipeId: number, title: string, tappedAt?: number[], type?: string, source?: string }} what
   *   type and source: of the pipe as the map knows it (source 'newer': from the council's newer test data)
   * @returns {Promise<boolean>} false when the tool has no answer for this pipe (and the panel says why)
   */
  async function show({ pipeId, title: heading, tappedAt, type, source }) {
    const thisRun = (run += 1);
    current = undefined;
    overlay.removeAll();
    scene.requestRender();
    panel.hidden = false;
    onToggle?.(true);
    title.textContent = heading;
    say('Working out the sewers…');
    try {
      await load();
    } catch (error) {
      if (thisRun === run) say(`Could not load the sewer network (${error.message}).`);
      return false;
    }
    if (thisRun !== run) return false;
    // A pipe of the council's newer test data is not in the network, whatever its id.
    current = { tap: source === 'newer' ? undefined : pieceAt(network, pipeId, tappedAt), pipe: { type, source }, cannotUse: new Set(), wontClose: new Set() };
    const shown = render();
    if (!shown.answer) return false;
    flyToPlaces(cornersOf(shown), settings.minViewSpanM, widen());
    return true;
  }

  function close() {
    run += 1;
    current = undefined;
    overlay.removeAll();
    panel.hidden = true;
    onToggle?.(false);
    scene.requestRender();
  }

  onMarkTap({ scene, panel, layerId: LAYER_ID, isOpen: () => Boolean(current) });

  return {
    show,
    close,
    get open() {
      return !panel.hidden;
    },
  };
}
