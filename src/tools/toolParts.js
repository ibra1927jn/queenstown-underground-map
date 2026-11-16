/**
 * What the panels of "Cut the water" and "Stop the flow" are made of, whatever their answer means: the
 * round badge of a mark on the map, the pill button, one line of a list (badge, words, cautions, the
 * council's own note, buttons), a headed or folded section, the flight that shows a few places at once
 * (moved up on a phone, where the panel covers the bottom of the screen) and the tap on a mark that finds
 * its line in the list. They use the .shutoff__* styles as they are (styles/main.css).
 *
 * What a result means – the words, which marks go where – is not here: each tool keeps that.
 *
 * Used by src/tools/sewerStopView.js. The water panel (src/tools/shutoffView.js) still carries its own
 * copies, from which these were taken without changing what they do; switching it over is left for later.
 */
import { Cesium, toDegrees } from '../map/cesium.js';
import { flyTo } from '../map/camera.js';
import { el } from '../util/dom.js';

const badges = new Map(); // colours + text -> canvas

/** A round badge with a number (or a sign) on it, for a mark on the map: drawn once per colour and text. */
export function badgeImage(text, fill, ink = '#ffffff', ring = '#ffffff') {
  const key = `${fill}|${ink}|${ring}|${text}`;
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

/** A small rounded button of a list line ("Show", "Won't close"…). */
export function pillButton(text, titleText, onClick) {
  const made = el('button', { type: 'button', class: 'shutoff__button', title: titleText, text });
  made.addEventListener('click', onClick);
  return made;
}

/**
 * One line of a list: a badge, a title, plain lines of words, cautions, the council's own note, buttons.
 * @param {object} line
 * @param {string} line.key  names the line: the mark on the map that carries the same key finds it (`showLine`)
 * @param {string} [line.badge]  what stands in the badge: a number, a letter, a sign
 * @param {string} [line.look]  the look of the badge: one of the .shutoff__badge--… styles ('plain', 'station', 'open', 'check')
 * @param {{ background: string, color?: string }} [line.colors]  …or its colours, for a badge with no style of its own
 * @param {string} line.title
 * @param {string[]} [line.words]
 * @param {string[]} [line.flags]
 * @param {string} [line.note]
 * @param {HTMLElement[]} [line.buttons]
 */
export function listLine({ key, badge = '', look, colors, title, words = [], flags = [], note, buttons = [] }) {
  return el(
    'li',
    { class: 'shutoff__valve', 'data-mark': key },
    el('span', { class: `shutoff__badge${look ? ` shutoff__badge--${look}` : ''}`, style: colors, text: badge }),
    el(
      'span',
      { class: 'shutoff__words' },
      el('strong', { text: title }),
      ...words.map((text) => el('span', { text })),
      ...flags.map((text) => el('span', { class: 'shutoff__flag', text })),
      note ? el('span', { class: 'shutoff__note', text: `Council's note: ${note}` }) : undefined,
    ),
    el('span', { class: 'shutoff__buttons' }, ...buttons),
  );
}

/** Lines as a list. */
export const lineList = (items) => el('ul', { class: 'shutoff__list' }, ...items);

/**
 * A part of a panel under a heading: in view, or folded away under its heading.
 * @param {string} heading
 * @param {(HTMLElement | undefined)[]} body
 * @param {{ open?: boolean }} [options]  open: false folds it
 * @returns {HTMLElement | undefined}  nothing when there is nothing to put under the heading
 */
export function section(heading, body, { open = true } = {}) {
  const parts = body.filter(Boolean);
  if (!parts.length) return undefined;
  return open ? el('div', {}, el('h4', { class: 'shutoff__heading', text: heading }), ...parts) : el('details', { class: 'shutoff__details' }, el('summary', { text: heading }), ...parts);
}

/**
 * Marks one line of a panel as the one being looked at; `reveal` also unfolds its section and scrolls to it.
 * @returns {boolean} false when the panel has no line of that key
 */
export function showLine(panel, key, { reveal = false } = {}) {
  const item = [...panel.querySelectorAll('.shutoff__valve')].find((candidate) => candidate.dataset.mark === key);
  if (!item) return false;
  for (const other of panel.querySelectorAll('.shutoff__valve')) other.classList.toggle('is-current', other === item);
  if (reveal) {
    item.closest('details')?.setAttribute('open', '');
    item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  return true;
}

/**
 * A tap on a mark of a tool on the map finds its line in the list. The marks carry the id
 * { layer: layerId, mark: key }.
 * @param {object} options
 * @param {object} options.scene
 * @param {HTMLElement} options.panel
 * @param {string} options.layerId
 * @param {() => boolean} options.isOpen  whether the tool is showing an answer
 */
export function onMarkTap({ scene, panel, layerId, isOpen }) {
  new Cesium.ScreenSpaceEventHandler(scene.canvas).setInputAction(({ position }) => {
    const id = scene.pick(position)?.id;
    if (!isOpen() || id?.layer !== layerId || id.mark === undefined) return;
    showLine(panel, id.mark, { reveal: true });
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

/**
 * The flight that shows a few places at once.
 * @param {object} options
 * @param {object} options.viewer
 * @param {(lonLat: number[]) => Promise<Float64Array>} options.sampleGround
 * @param {number} options.pitchDegrees
 * @param {number} options.sheetShiftShare  on a phone the panel covers the bottom: the view moves up by this share of its width
 * @param {() => boolean} [options.isSheet]  true while the panel is a sheet over the bottom of the screen
 * @param {() => boolean} [options.canFly]  false while a view holds the camera (the excavation)
 * @param {() => void} [options.beforeFlight]  lets go of the camera (the open ground goes round a place)
 * @returns {(lonLats: number[][], minSpanM: number, widen?: number) => Promise<void>}  shows at least minSpanM of
 *   ground round the places; widen: this many times more, for a view whose sides are covered (by panels)
 */
export function createPlaceFlight({ viewer, sampleGround, pitchDegrees, sheetShiftShare, isSheet = () => false, canFly = () => true, beforeFlight }) {
  const { camera } = viewer;
  return async function flyToPlaces(lonLats, minSpanM, widen = 1) {
    if (!canFly() || !lonLats.length) return;
    const lons = lonLats.map((p) => p[0]);
    const lats = lonLats.map((p) => p[1]);
    let lon = (Math.min(...lons) + Math.max(...lons)) / 2;
    let lat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const span = widen * Math.max(minSpanM, 1.4 * Math.max((Math.max(...lons) - Math.min(...lons)) * 78800, (Math.max(...lats) - Math.min(...lats)) * 110540));
    if (isSheet()) {
      // The panel covers the bottom of the screen: look at a point nearer the viewer, so the places show above it.
      const back = span * sheetShiftShare;
      lon -= (Math.sin(camera.heading) * back) / 78800;
      lat -= (Math.cos(camera.heading) * back) / 110540;
    }
    const [height] = await sampleGround([lon, lat]);
    beforeFlight?.();
    flyTo(viewer, { lon, lat, height: Number.isFinite(height) ? height : 400, span }, { headingDegrees: toDegrees(camera.heading), pitchDegrees }, undefined, 1.2);
  };
}
