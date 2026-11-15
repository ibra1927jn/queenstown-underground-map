/**
 * "Cut the water": from a water main tapped on the map, which valves to close so that it is left
 * without water – only those with a source of water beyond them, as real isolation tools do – drawn on
 * the map (the stretch cut in orange, what loses water through it in light orange, the valves to close
 * as numbered badges, the valves that can stay open in grey) and listed in a panel: a pump station or
 * reservoir on the stretch first (its own valves are not on the council's map), then each valve (kind,
 * size, street, depth), what is left without water, valves on the map near the cut but on no pipe, and
 * a short list of what to do before closing (New Zealand practice). A valve that "won't close" makes
 * the search go on to the next ones beyond it.
 *
 * The district's mains and valves, already cut into stretches between valves, come from
 * data/water-shutoff.json (scripts/data/build-shutoff.mjs), loaded the first time the tool is used;
 * the search itself is src/util/shutoff.js. Everything is worked out from where pipes and valves are
 * on the council's map, so the panel always says: approximate – check before closing anything.
 */
import { Cesium, toDegrees } from '../map/cesium.js';
import { flyTo } from '../map/camera.js';
import { clear, el } from '../util/dom.js';
import { fetchJson } from '../util/http.js';
import { isolate, segmentAt, stretchLines } from '../util/shutoff.js';

const LAYER_ID = 'shutoff';

/**
 * @param {object} options
 * @param {object} options.viewer
 * @param {HTMLElement} options.panel          #shutoff-panel
 * @param {string} options.dataPath
 * @param {(lonLat: number[]) => Promise<Float64Array>} options.sampleGround
 * @param {object} options.settings            CONFIG.shutoff
 * @param {() => boolean} [options.isSheet]    true while the panel is a sheet over the bottom of the screen (a phone)
 * @param {() => boolean} [options.canFly]     false while a view holds the camera (the excavation)
 * @param {() => void} [options.beforeFlight]  lets go of the camera (the open ground goes round a place)
 * @param {(open: boolean) => void} [options.onToggle]
 */
export function createShutoffView({ viewer, panel, dataPath, sampleGround, settings, isSheet = () => false, canFly = () => true, beforeFlight, onToggle }) {
  const { scene, camera } = viewer;
  const title = panel.querySelector('.shutoff__title');
  const summary = panel.querySelector('.shutoff__summary');
  const list = panel.querySelector('.shutoff__valves');
  const more = panel.querySelector('.shutoff__more');
  const note = panel.querySelector('.panel__note');

  const overlay = scene.primitives.add(new Cesium.PrimitiveCollection());
  let network; // data/water-shutoff.json, once loaded
  let loading;
  let mainsById; // pipe id -> indexes in network.mains (a main in several parts has several)
  let current; // { title, segment, failed: Set<number> }
  let run = 0;
  const badges = new Map(); // css colour + text -> canvas

  panel.querySelector('.panel__close').addEventListener('click', () => close());

  async function load() {
    if (network) return network;
    loading ??= fetchJson(`${dataPath}/water-shutoff.json`);
    network = await loading;
    mainsById = new Map();
    network.mains.forEach((main, index) => mainsById.set(main.id, [...(mainsById.get(main.id) ?? []), index]));
    return network;
  }

  /** A round badge with a number (or a sign) on it, drawn once per colour and text. */
  function badge(text, fill, ink = '#ffffff', ring = '#ffffff') {
    const key = `${fill}|${ink}|${text}`;
    if (!badges.has(key)) {
      const size = 34;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size * 2;
      const g = canvas.getContext('2d');
      g.scale(2, 2);
      g.beginPath();
      g.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
      g.fillStyle = fill;
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = ring;
      g.stroke();
      g.fillStyle = ink;
      g.font = `700 ${text.length > 1 ? 14 : 17}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, size / 2, size / 2 + 1);
      badges.set(key, canvas);
    }
    return badges.get(key);
  }

  function drawOverlay(result) {
    overlay.removeAll();
    const also = new Set(result.alsoSegments);
    const lines = stretchLines(network, [...result.segments, ...result.alsoSegments]);
    const colourOf = (segment) => (segment === current.segment ? settings.startColor : also.has(segment) ? settings.alsoColor : settings.cutColor);
    if (lines.length) {
      overlay.add(
        new Cesium.GroundPolylinePrimitive({
          geometryInstances: lines.map(
            ({ line, segment }) =>
              new Cesium.GeometryInstance({
                geometry: new Cesium.GroundPolylineGeometry({ positions: Cesium.Cartesian3.fromDegreesArray(line.flat()), width: settings.lineWidthPx }),
                attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString(colourOf(segment))) },
              }),
          ),
          appearance: new Cesium.PolylineColorAppearance(),
        }),
      );
    }
    const marks = overlay.add(new Cesium.BillboardCollection({ scene }));
    const mark = (lonLat, image, id, size = settings.badgePx) =>
      marks.add({
        id,
        position: Cesium.Cartesian3.fromDegrees(...lonLat),
        image,
        width: size,
        height: size,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY, // always on top: they are what to look for
      });
    const check = badge('?', '#fcc419', '#13232f', '#13232f');
    for (const at of result.edges) mark(at, check, { layer: LAYER_ID, check: true }, settings.badgePx * 0.75);
    for (const g of result.gaps) mark(network.gaps[g].at, check, { layer: LAYER_ID, check: true }, settings.badgePx * 0.75);
    for (const u of result.unplacedNear) {
      const scour = network.unplacedValves[u].why === 'scour';
      mark(network.unplacedValves[u].at, scour ? badge('D', '#adb5bd') : badge('V', '#fcc419', '#13232f', '#13232f'), { layer: LAYER_ID, valve: `u${u}` }, settings.badgePx * 0.8);
    }
    result.notNeeded.forEach((v) => mark(network.valves[v].at, badge('–', '#adb5bd'), { layer: LAYER_ID, valve: `p${v}` }, settings.badgePx * 0.75));
    result.alreadyClosed.forEach((v) => mark(network.valves[v].at, badge('×', '#868e96'), { layer: LAYER_ID, valve: `p${v}` }));
    result.failed.forEach((v) => mark(network.valves[v].at, badge('!', '#13232f', '#ffd43b', '#ffd43b'), { layer: LAYER_ID, valve: `p${v}` }));
    result.close.forEach((v, n) => mark(network.valves[v].at, badge(String(n + 1), settings.valveColor), { layer: LAYER_ID, valve: `p${v}` }));
    scene.requestRender();
  }

  const metres = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
  const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-NZ')} ${n === 1 ? one : many}`;

  /**
   * One valve as a line of the list.
   * @param {object} valve  from network.valves or network.unplacedValves
   * @param {string} key    'p' + index of a valve on a main, 'u' + index of one on no pipe
   */
  function valveItem(valve, key, { number, look = number ? '' : 'plain', buttons, flag }) {
    const words = [valve.type, valve.diameter ? `${valve.diameter} mm` : undefined].filter(Boolean).join(' · ');
    const where = [valve.street, Number.isFinite(valve.depth) ? `${valve.depth.toFixed(1)} m deep` : undefined].filter(Boolean).join(' · ');
    return el(
      'li',
      { class: 'shutoff__valve', 'data-valve': key },
      el('span', { class: `shutoff__badge${look ? ` shutoff__badge--${look}` : ''}`, text: number ?? '' }),
      el(
        'span',
        { class: 'shutoff__words' },
        el('strong', { text: words }),
        el('span', { text: where || 'Street not recorded' }),
        valve.position ? undefined : el('span', { class: 'shutoff__flag', text: 'Open or closed: not recorded' }),
        sizeDoubt(valve) ? el('span', { class: 'shutoff__flag', text: sizeDoubt(valve) }) : undefined,
        flag ? el('span', { class: 'shutoff__flag', text: flag }) : undefined,
        valve.note ? el('span', { class: 'shutoff__note', text: `Council's note: ${valve.note}` }) : undefined,
      ),
      el('span', { class: 'shutoff__buttons' }, ...buttons),
    );
  }
  const placedItem = (v, options) => valveItem(network.valves[v], `p${v}`, options);
  /** A valve on a main far bigger than its recorded size: kept, as the size is doubtful – and said. */
  function sizeDoubt(valve) {
    const main = valve.main === undefined ? undefined : network.mains[valve.main];
    if (!main?.diameter || !valve.diameter || valve.diameter / main.diameter >= 0.7) return undefined;
    return `Recorded as ${valve.diameter} mm on a ${main.diameter} mm main: ${valve.sizeDoubt ? 'every valve of its as-built job has that size, so it is not relied on' : 'the council calls it a line valve'} – check on site.`;
  }
  /** Why a valve near the cut is not one the search can use. */
  const WHY = {
    far: 'More than 1.5 m from any main on the map',
    small: 'Far smaller than the main it is on: it cannot shut it (a branch or service valve)',
  };

  const button = (text, titleText, onClick) => {
    const made = el('button', { type: 'button', class: 'shutoff__button', title: titleText, text });
    made.addEventListener('click', onClick);
    return made;
  };

  /** Goes to a valve ('p' + index on a main, 'u' + index on no pipe) and marks its line. */
  function showValve(key) {
    const valve = key.startsWith('u') ? network.unplacedValves[Number(key.slice(1))] : network.valves[Number(key.slice(1))];
    flyToPlace([valve.at], settings.valveViewSpanM);
    for (const item of panel.querySelectorAll('.shutoff__valve')) item.classList.toggle('is-current', item.dataset.valve === key);
  }
  const showButton = (key) => button('Show', 'Go to this valve on the map', () => showValve(key));

  /** A heading and a list, under the valves to close. */
  function section(heading, items, { open = true, hint } = {}) {
    if (!items.length) return;
    const body = [hint ? el('p', { class: 'shutoff__hint', text: hint }) : undefined, el('ul', { class: 'shutoff__list' }, ...items)];
    more.append(open ? el('div', {}, el('h4', { class: 'shutoff__heading', text: heading }), ...body) : el('details', { class: 'shutoff__details' }, el('summary', { text: heading }), ...body));
  }

  function render() {
    const result = isolate(network, current.segment, current.failed);
    drawOverlay(result);
    const stations = result.stations.map((s) => network.sources[s]);
    // Tapped right by a station on the cut: the work is most likely at the station (a meter, a pump).
    const here = current.tappedAt ?? network.mains[network.pieces.find((piece) => piece[3] === current.segment)[0]].line[0];
    const atStation = stations
      .map((station) => ({ station, distance: Math.hypot((station.at[0] - here[0]) * 78800, (station.at[1] - here[1]) * 110540) }))
      .filter(({ distance }) => distance <= settings.atStationM)
      .sort((a, b) => a.distance - b.distance)[0]?.station;

    title.textContent = current.title;
    const lost = [
      `${metres(result.lengthM + result.alsoLengthM)} of main`,
      plural(result.connections + result.alsoConnections, 'property connection'),
      plural(result.hydrants + result.alsoHydrants, 'hydrant'),
    ].join(', ');
    const through = result.alsoLengthM ? ` – ${metres(result.alsoLengthM)} and ${plural(result.alsoConnections, 'connection')} of it on branches fed only through here (light orange)` : '';
    const what = [result.close.length ? plural(result.close.length, 'valve') : undefined, stations.length ? `the valves of ${stations.map((s) => `${s.type.toLowerCase()} ${s.name}`).join(' and ')}` : undefined].filter(Boolean).join(' and ');
    summary.textContent = [
      atStation
        ? `Work at the ${atStation.type.toLowerCase()} ${atStation.name}? Use its own valves (and the bypass round its meter): they are inside it, not on the council’s map, and usually nobody has to lose water. Only if they cannot be used:`
        : undefined,
      result.noSourceFound ? 'The map shows no way for water to reach this stretch, so every valve round it is listed.' : undefined,
      what ? `Close ${what}. Left without water: ${lost}${through}.` : `No valve on the map shuts this stretch (${lost}). It may be fed through a pipe the map does not join: check with the network controller.`,
    ]
      .filter(Boolean)
      .join(' ');

    clear(list);
    // A pump station or reservoir on the stretch: its own valves are inside it.
    for (const station of stations) {
      list.append(
        el(
          'li',
          { class: 'shutoff__valve' },
          el('span', { class: 'shutoff__badge shutoff__badge--station', text: 'S' }),
          el('span', { class: 'shutoff__words' }, el('strong', { text: `${station.type} · ${station.name}` }), el('span', { text: 'Close its valves on this main: they are inside it, not on the council’s map.' })),
          el('span', { class: 'shutoff__buttons' }, button('Show', 'Go to it on the map', () => flyToPlace([station.at], settings.valveViewSpanM))),
        ),
      );
    }
    const bigArea = new Set(result.assumedFed);
    result.close.forEach((v, n) =>
      list.append(
        placedItem(v, {
          number: String(n + 1),
          flag: bigArea.has(v) ? 'Beyond it: a large area with no source on the map – closed to be on the safe side.' : undefined,
          buttons: [
            showButton(`p${v}`),
            button("Won't close", 'This valve cannot be found or will not close: find the next ones beyond it', () => {
              current.failed.add(v);
              render();
            }),
          ],
        }),
      ),
    );

    clear(more);
    if (stations.length && !atStation) {
      more.append(el('p', { class: 'shutoff__hint', text: 'Work at the station itself – a pump, its flow meter? Stations have their own valves, and usually a bypass round the meter: often nobody has to lose water. Check the station’s drawings.' }));
    }
    section(
      "Won't close",
      result.failed.map((v) =>
        placedItem(v, {
          buttons: [
            showButton(`p${v}`),
            button('It closes', 'Back to closing this valve', () => {
              current.failed.delete(v);
              render();
            }),
          ],
        }),
      ),
    );
    section('Already closed – keep them closed', result.alreadyClosed.map((v) => placedItem(v, { buttons: [showButton(`p${v}`)] })));
    section(
      `${plural(result.notNeeded.length, 'valve')} can stay open`,
      result.notNeeded.map((v) => placedItem(v, { look: 'open', buttons: [showButton(`p${v}`)] })),
      { open: false, hint: 'On branches with no other supply (grey – on the map): closing them would not stop any water. Those branches lose water too.' },
    );
    const near = (reasons) => result.unplacedNear.filter((u) => reasons.includes(network.unplacedValves[u].why));
    section(
      'On the map near here, but not used',
      near(['far', 'small']).map((u) => valveItem(network.unplacedValves[u], `u${u}`, { number: 'V', look: 'check', flag: WHY[network.unplacedValves[u].why], buttons: [showButton(`u${u}`)] })),
      { hint: 'The search cannot tell what these valves shut – one of them may be the one to close.' },
    );
    section(
      'To drain the stretch: scour valves on it',
      near(['scour']).map((u) => valveItem(network.unplacedValves[u], `u${u}`, { number: 'D', look: 'open', buttons: [showButton(`u${u}`)] })),
      { open: false },
    );
    if (result.notNeeded.length && result.openEnds > 0) {
      more.append(
        el('p', {
          class: 'shutoff__flag',
          text: `${plural(result.openEnds, 'branch')} left open ${result.openEnds === 1 ? 'ends' : 'end'} on the map with no end cap or hydrant recorded: if such a pipe carries on in reality, water could come back through it – prove the main is dead before working.`,
        }),
      );
    }
    if (result.edges.length) more.append(el('p', { class: 'shutoff__flag', text: `This stretch leaves the mapped area (? on the map): water may come from there.` }));
    if (result.gaps.length) more.append(el('p', { class: 'shutoff__flag', text: `${plural(result.gaps.length, 'main')} ${result.gaps.length === 1 ? 'ends' : 'end'} within 3 m of this stretch without joining it on the map (? on the map): ${result.gaps.length === 1 ? 'it' : 'they'} may be joined, and bring water.` }));
    if (result.limited) more.append(el('p', { class: 'shutoff__flag', text: 'Very large: the search stopped. Check the valves with the network controller.' }));
    // QLDC's code keeps a shut-off area to this many connections, by the size of the main (Table 6-6).
    const limit = settings.connectionLimits.find((row) => (current.diameter ?? 0) <= row.upToMm) ?? settings.connectionLimits.at(-1);
    const connections = result.connections + result.alsoConnections;
    if (connections > limit.connections) {
      more.append(el('p', { class: 'shutoff__flag', text: `${plural(connections, 'connection')} without water: QLDC’s code aims for at most ${limit.connections} on a main this size – the map may be missing valves here.` }));
    }
    more.append(
      el(
        'details',
        { class: 'shutoff__details' },
        el('summary', { text: 'Before you close' }),
        el(
          'ol',
          { class: 'shutoff__steps' },
          el('li', { text: 'Only the council and its agents (its network operator) may work on the network (QLDC Water Supply Bylaw).' }),
          el('li', { text: 'Tell the customers first – the vulnerable ones (home dialysis, medical needs), schools and businesses that need water before the rest. A planned cut longer than 8 hours: tell Taumata Arowai beforehand (its guidance also speaks of prior approval) and arrange another supply.' }),
          el('li', { text: 'Hydrants out of service, or the supply at risk: tell Fire and Emergency NZ.' }),
          el('li', { text: 'Close slowly – QLDC’s valves close anti-clockwise, its 50 mm peet valves clockwise – count the turns, and prove the main is dead at a hydrant or a tap.' }),
          el('li', { text: 'After the work: disinfect and flush as the council’s code says, open slowly, check the chlorine, and record any valve that would not close.' }),
        ),
      ),
    );
    note.textContent = `Sources of water: the reservoirs, treatment plants, bores and pump stations on the council's map, and mains leaving the mapped area. Not included: pipes laid since May 2026 (the council's test data).`;
    return result;
  }

  /** Flies to show a few places at once (no flight while a view holds the camera). */
  async function flyToPlace(lonLats, minSpanM) {
    if (!canFly() || !lonLats.length) return;
    const lons = lonLats.map((p) => p[0]);
    const lats = lonLats.map((p) => p[1]);
    let lon = (Math.min(...lons) + Math.max(...lons)) / 2;
    let lat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const span = Math.max(minSpanM, 1.4 * Math.max((Math.max(...lons) - Math.min(...lons)) * 78800, (Math.max(...lats) - Math.min(...lats)) * 110540));
    if (isSheet()) {
      // The panel covers the bottom of the screen: look at a point nearer the viewer, so the cut shows above it.
      const back = span * settings.sheetShiftShare;
      lon -= (Math.sin(camera.heading) * back) / 78800;
      lat -= (Math.cos(camera.heading) * back) / 110540;
    }
    const [height] = await sampleGround([lon, lat]);
    beforeFlight?.();
    flyTo(viewer, { lon, lat, height: Number.isFinite(height) ? height : 400, span }, { headingDegrees: toDegrees(camera.heading), pitchDegrees: settings.viewPitchDegrees }, undefined, 1.2);
  }

  /**
   * Shows what to close to cut the water at a main.
   * @param {{ pipeId: number, title: string, tappedAt?: number[], diameter?: number }} what
   * @returns {Promise<boolean>} false when the main is not in the data (the council's newer test data)
   */
  async function show({ pipeId, title: heading, tappedAt, diameter }) {
    const thisRun = (run += 1);
    panel.hidden = false;
    onToggle?.(true);
    title.textContent = heading;
    summary.textContent = 'Finding the valves…';
    clear(list);
    clear(more);
    try {
      await load();
    } catch (error) {
      summary.textContent = `Could not load the valves (${error.message}).`;
      return false;
    }
    if (thisRun !== run) return false;
    const parts = mainsById.get(pipeId) ?? [];
    if (!parts.length) {
      summary.textContent = 'This main is not in the council’s official data yet (it is in its newer test data), so its valves cannot be worked out.';
      overlay.removeAll();
      scene.requestRender();
      return false;
    }
    // The part of the main nearest to where it was tapped (most mains have one part).
    const part = tappedAt && parts.length > 1 ? nearestPart(parts, tappedAt) : parts[0];
    current = { title: heading, diameter, tappedAt, segment: segmentAt(network, part, tappedAt), failed: new Set() };
    const result = render();
    const places = [...stretchLines(network, result.segments).flatMap(({ line }) => line), ...result.close.map((v) => network.valves[v].at), ...result.stations.map((s) => network.sources[s].at)];
    flyToPlace(places, settings.minViewSpanM);
    return true;
  }

  function nearestPart(parts, [lon, lat]) {
    let best = parts[0];
    let bestDistance = Infinity;
    for (const index of parts) {
      for (const [x, y] of network.mains[index].line) {
        const distance = Math.hypot((x - lon) * 78800, (y - lat) * 110540);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
    }
    return best;
  }

  function close() {
    run += 1;
    current = undefined;
    overlay.removeAll();
    panel.hidden = true;
    onToggle?.(false);
    scene.requestRender();
  }

  // A tap on a numbered valve: its line in the list.
  new Cesium.ScreenSpaceEventHandler(scene.canvas).setInputAction(({ position }) => {
    const id = scene.pick(position)?.id;
    if (!current || id?.layer !== LAYER_ID || id.valve === undefined) return;
    const item = panel.querySelector(`[data-valve="${id.valve}"]`);
    if (!item) return;
    item.closest('details')?.setAttribute('open', '');
    for (const other of panel.querySelectorAll('.shutoff__valve')) other.classList.toggle('is-current', other === item);
    item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  return {
    show,
    close,
    get open() {
      return !panel.hidden;
    },
  };
}
