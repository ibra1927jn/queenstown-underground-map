/**
 * "Find a street or address": a search box (the magnifier in the top bar). Typing lists streets and
 * addresses as they match; picking one flies the map there and drops a pin with its name. The pin
 * stays until another place is picked or it is removed from the panel.
 *
 * The addresses (Toitū Te Whenua LINZ, CC BY 4.0) are in data/addresses.json, loaded the first time
 * the box is opened and searched on the device itself (src/util/addressSearch.js): it works without
 * the internet once the page is open.
 */
import { Cesium, toDegrees } from '../map/cesium.js';
import { flyTo } from '../map/camera.js';
import { clear, el } from '../util/dom.js';
import { fetchJson } from '../util/http.js';
import { createAddressSearch } from '../util/addressSearch.js';

/**
 * @param {object} options
 * @param {object} options.viewer
 * @param {HTMLButtonElement} options.button   the magnifier in the top bar
 * @param {HTMLElement} options.panel          #search-panel
 * @param {string} options.dataPath
 * @param {(lonLat: number[]) => Promise<Float64Array>} options.sampleGround
 * @param {object} options.settings            CONFIG.search
 * @param {() => void} [options.beforeFlight]  lets go of the camera, leaves views that hold it
 * @param {() => void} [options.onOpen]        other panels make room
 */
export function createAddressFinder({ viewer, button, panel, dataPath, sampleGround, settings, beforeFlight, onOpen }) {
  const { scene, camera } = viewer;
  const input = panel.querySelector('.search__input');
  const list = panel.querySelector('.search__results');
  const hint = panel.querySelector('.search__hint');
  const removePin = panel.querySelector('.search__remove');

  let finder; // the search, once the addresses are loaded
  let loading;
  let shown = []; // the results on show
  const marks = scene.primitives.add(new Cesium.PrimitiveCollection());

  async function load() {
    if (finder) return finder;
    loading ??= fetchJson(`${dataPath}/addresses.json`);
    finder = createAddressSearch(await loading);
    return finder;
  }

  /** A pin, drawn once: a drop with a white dot, its point at the bottom. */
  let pinImage;
  function pin() {
    if (pinImage) return pinImage;
    const canvas = document.createElement('canvas');
    canvas.width = 56;
    canvas.height = 76;
    const g = canvas.getContext('2d');
    g.beginPath();
    g.moveTo(28, 74);
    g.bezierCurveTo(10, 48, 4, 40, 4, 28);
    g.arc(28, 28, 24, Math.PI, 0);
    g.bezierCurveTo(52, 40, 46, 48, 28, 74);
    g.closePath();
    g.fillStyle = settings.pinColor;
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = '#ffffff';
    g.stroke();
    g.beginPath();
    g.arc(28, 28, 9, 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();
    pinImage = canvas;
    return pinImage;
  }

  function showPin(result) {
    marks.removeAll();
    const position = Cesium.Cartesian3.fromDegrees(result.at[0], result.at[1]);
    const billboards = marks.add(new Cesium.BillboardCollection({ scene }));
    billboards.add({
      position,
      image: pin(),
      width: 28,
      height: 38,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    const labels = marks.add(new Cesium.LabelCollection({ scene }));
    labels.add({
      position,
      text: result.title,
      font: '700 14px system-ui, sans-serif',
      fillColor: Cesium.Color.fromCssColorString('#13232f'),
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 4,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -44),
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    removePin.hidden = false;
    scene.requestRender();
  }

  async function goTo(result) {
    close();
    showPin(result);
    const [height] = await sampleGround(result.at);
    beforeFlight?.();
    flyTo(
      viewer,
      { lon: result.at[0], lat: result.at[1], height: Number.isFinite(height) ? height : 350, span: result.street ? settings.streetSpanM : settings.addressSpanM },
      { headingDegrees: toDegrees(camera.heading), pitchDegrees: settings.viewPitchDegrees },
      undefined,
      1.5,
    );
  }

  function render() {
    clear(list);
    const query = input.value.trim();
    shown = finder && query ? finder.search(query, settings.results) : [];
    for (const result of shown) {
      const item = el('li', {}, el('button', { type: 'button', class: 'search__result' }, el('strong', { text: result.title }), el('span', { text: result.subtitle })));
      item.firstChild.addEventListener('click', () => goTo(result));
      list.append(item);
    }
    hint.textContent = !finder ? 'Loading the addresses…' : !query ? 'Type a street, or a number and a street: “12 Camp St”.' : shown.length ? '' : 'No street like that in the zones of this map.';
    hint.hidden = !hint.textContent;
  }

  async function open() {
    onOpen?.();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    // On a phone the panel sits under the top bar, however tall that is (the keyboard takes the bottom).
    document.documentElement.style.setProperty('--search-top', `${Math.round(button.closest('.topbar').getBoundingClientRect().bottom + 8)}px`);
    input.focus();
    input.select();
    render();
    try {
      await load();
    } catch (error) {
      hint.textContent = `Could not load the addresses (${error.message}).`;
      hint.hidden = false;
      return;
    }
    render();
  }

  function close() {
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  button.addEventListener('click', () => (panel.hidden ? open() : close()));
  panel.querySelector('.panel__close').addEventListener('click', close);
  input.addEventListener('input', render);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && shown.length) goTo(shown[0]);
    else if (event.key === 'Escape') close();
  });
  removePin.addEventListener('click', () => {
    marks.removeAll();
    removePin.hidden = true;
    scene.requestRender();
  });

  return {
    close,
    get open() {
      return !panel.hidden;
    },
    /** For the browser console and tests: the results for a text, once the addresses are loaded. */
    search: async (text) => (await load()).search(text, settings.results),
    goTo,
  };
}
