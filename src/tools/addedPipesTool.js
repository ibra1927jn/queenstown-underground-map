/**
 * Pipes and cables added by hand: the pencil button of the top bar, its panel, the drawing and the form.
 *
 * Drawing: a cross stays in the middle of the map. The map is moved under it and "Add point" drops
 * a point where the cross is – no aiming with a finger. "Undo" takes the last point away, "Done"
 * opens a short form (what it is, size, depth, material, a note). The line being drawn lies over
 * the map as an SVG drawing, so buildings and slopes never hide it.
 *
 * What is added is kept by the store (src/util/addedPipes.js) in the browser of this device only;
 * the panel lists it and writes or reads a copy file. The network layers draw the pipes themselves
 * (dashed, src/layers/networkLayer.js): after every change `onChange` says which zones and networks
 * to draw again.
 */
import { Cesium, toDegrees } from '../map/cesium.js';
import { flyTo, groundAt } from '../map/camera.js';
import { clear, el } from '../util/dom.js';
import { ADDED_KINDS, detailsOf, fromFile, lengthM, makePipe, toFile, withDetails } from '../util/addedPipes.js';

const SVG = 'http://www.w3.org/2000/svg';
const CANNOT_KEEP = 'It could not be kept on this device: the browser refused (a private window, or no room left).';

/** Today as YYYY-MM-DD, by this device's clock. */
function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

const many = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * @param {object} options
 * @param {object} options.viewer
 * @param {object} options.store               createAddedStore(…) of src/util/addedPipes.js
 * @param {(points: number[][]) => string | undefined} options.zoneOf  the zone a line is drawn with
 * @param {(zoneId: string) => string | undefined} options.zoneName
 * @param {() => string} options.newId
 * @param {(network: string) => string | undefined} options.colorOf    the colour of a network (CSS)
 * @param {HTMLButtonElement} options.button   the pencil in the top bar
 * @param {HTMLElement} options.panel          #added-panel
 * @param {HTMLElement} options.overlay        #draw: the cross, the line being drawn, the bar
 * @param {HTMLElement} options.form           #added-form
 * @param {object} options.settings            CONFIG.added
 * @param {(lonLat: number[]) => Promise<Float64Array>} options.sampleGround
 * @param {() => number} options.groundHint    roughly how high the ground is here (see groundAt)
 * @param {() => void} [options.onOpen]        other panels make room
 * @param {() => void} options.beforeDrawing   the map is made ready: plain map view, nothing selected, taps select nothing
 * @param {() => void} options.afterDrawing
 * @param {() => void} [options.beforeFlight]  lets go of the camera, leaves views that hold it
 * @param {(changes: { zone: string, network: string }[], shown?: object) => Promise<void>} options.onChange
 *   draws those zones of those networks again; `shown`: the pipe to select once they are
 */
export function createAddedPipesTool({ viewer, store, zoneOf, zoneName, newId, colorOf, button, panel, overlay, form, settings, sampleGround, groundHint, onOpen, beforeDrawing, afterDrawing, beforeFlight, onChange }) {
  const { scene, camera } = viewer;
  const find = (root, selector) => root.querySelector(selector);

  const list = find(panel, '.added__list');
  const empty = find(panel, '.added__empty');
  const status = find(panel, '.added__status');
  const fileInput = find(panel, '.added__file');

  const svg = find(overlay, '.draw__svg');
  const lines = [...overlay.querySelectorAll('.draw__line')];
  const next = find(overlay, '.draw__next');
  const dots = find(overlay, '.draw__dots');
  const lengthChip = find(overlay, '.draw__length');
  const words = find(overlay, '.draw__words');
  const undoButton = find(overlay, '.draw__undo');
  const finishButton = find(overlay, '.draw__finish');

  const formElement = find(form, 'form');
  const kinds = find(form, '.form__kinds');
  const problem = find(form, '.form__problem');
  const deleteButton = find(form, '.form__delete');
  const field = (name) => formElement.elements[name];

  let drawing = false;
  let points = []; // the points dropped so far: { lon, lat, point } (point: a Cesium.Cartesian3 on the ground)
  let editing; // the pipe the form is changing; undefined: the form is for the line just drawn
  let lastKind; // the kind picked last: most likely the next pipe is of the same
  let sureTimer;

  // The kinds as chips: one can be picked, each in the colour of its network.
  for (const kind of ADDED_KINDS) {
    kinds.append(el('label', { class: 'form__kind', vars: { '--swatch': colorOf(kind.network) ?? '#495057' } }, el('input', { type: 'radio', name: 'network', value: kind.network }), el('span', { text: kind.label })));
  }

  // ---------- The panel: the list of what was added, and the copy ----------

  function say(text) {
    status.textContent = text ?? '';
    status.hidden = !text;
  }

  function renderList() {
    const pipes = store.all();
    clear(list);
    for (const pipe of pipes.reverse()) {
      const p = pipe.properties;
      const item = el(
        'button',
        { type: 'button', class: 'added__item', vars: { '--swatch': colorOf(p.network) ?? '#495057' } },
        el('strong', { text: [p.type, p.diameter ? `${p.diameter} mm` : undefined].filter(Boolean).join(' · ') }),
        el('span', { text: [`${p.length.toLocaleString('en-NZ')} m`, zoneName(p.zone), p.note].filter(Boolean).join(' · ') }),
      );
      item.addEventListener('click', () => goTo(pipe));
      list.append(el('li', {}, item));
    }
    empty.hidden = pipes.length > 0;
    find(panel, '.added__save').disabled = pipes.length === 0;
  }

  function open() {
    onOpen?.();
    say();
    renderList();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
  }

  function close() {
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  /** Flies to a pipe of the list, the whole of it in view, and selects it there. */
  async function goTo(pipe) {
    close();
    const coordinates = pipe.geometry.coordinates;
    const lons = coordinates.map(([lon]) => lon);
    const lats = coordinates.map(([, lat]) => lat);
    const middle = [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
    const [height] = await sampleGround(middle);
    beforeFlight?.();
    const [least, most] = settings.viewSpanM;
    flyTo(
      viewer,
      { lon: middle[0], lat: middle[1], height: Number.isFinite(height) ? height : groundHint(), span: Math.min(most, Math.max(least, pipe.properties.length * 1.8)) },
      { headingDegrees: toDegrees(camera.heading), pitchDegrees: settings.viewPitchDegrees },
      () => onChange([], pipe),
      1.5,
    );
  }

  /** The zones and networks that draw any of these pipes, each once. */
  const drawnBy = (pipes) => [...new Map(pipes.map(({ properties: p }) => [`${p.zone} ${p.network}`, { zone: p.zone, network: p.network }])).values()];

  function saveCopy() {
    const pipes = store.all();
    if (!pipes.length) return;
    const name = `added-pipes-${today()}.geojson`;
    const url = URL.createObjectURL(new Blob([JSON.stringify(toFile(pipes, today()), null, 1)], { type: 'application/geo+json' }));
    const link = el('a', { href: url, download: name, hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    say(`A copy of ${many(pipes.length, 'pipe')} was saved as ${name} – look in the downloads of this device.`);
  }

  async function loadCopy(file) {
    if (!file) return;
    if (file.size > settings.fileLimitBytes) return say('That file is too big to be a copy of added pipes.');
    let read;
    try {
      read = fromFile(JSON.parse(await file.text()), { zoneOf, newId });
    } catch {
      return say('That file is not a copy of added pipes.');
    }
    if (!read.pipes.length) return say('There are no pipes in that file.');
    const before = store.all();
    const result = store.merge(read.pipes);
    if (!result.saved) return say(CANNOT_KEEP);
    renderList();
    say([`${result.added} added`, result.replaced ? `${result.replaced} replaced` : undefined, read.skipped ? `${read.skipped} left out (not a line of a known kind)` : undefined].filter(Boolean).join(', ') + '.');
    await onChange(drawnBy([...before, ...read.pipes]));
  }

  // ---------- Drawing ----------

  /** The middle of the map, where the cross is. */
  const centre = () => new Cesium.Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);
  const lonLats = () => points.map(({ lon, lat }) => [lon, lat]);

  function refreshBar() {
    undoButton.disabled = points.length === 0;
    finishButton.disabled = points.length < 2;
    words.textContent =
      points.length === 0
        ? 'Move the map until the cross is where it starts, then tap “Add point”.'
        : points.length === 1
          ? 'Now move the map to the next bend, or to the end, and add a point there.'
          : 'Add a point at every bend. At the end, tap “Done”.';
  }

  /** Lays the line drawn so far over the map as it is on screen right now. */
  function redraw() {
    if (!drawing) return;
    svg.setAttribute('viewBox', `0 0 ${scene.canvas.clientWidth} ${scene.canvas.clientHeight}`);
    const onScreen = points.map(({ point }) => Cesium.SceneTransforms.worldToWindowCoordinates(scene, point)).filter(Boolean);
    const path = onScreen.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    for (const line of lines) line.setAttribute('points', path);
    while (dots.childElementCount > onScreen.length) dots.lastChild.remove();
    while (dots.childElementCount < onScreen.length) dots.append(document.createElementNS(SVG, 'circle'));
    onScreen.forEach(({ x, y }, i) => {
      dots.children[i].setAttribute('cx', x.toFixed(1));
      dots.children[i].setAttribute('cy', y.toFixed(1));
      dots.children[i].setAttribute('r', 6);
    });

    // From the last point to the cross: the piece the next point would add, and how long the line would be.
    const last = points.at(-1) && Cesium.SceneTransforms.worldToWindowCoordinates(scene, points.at(-1).point);
    const middle = centre();
    const under = points.length ? groundAt(viewer, middle, groundHint()) : undefined;
    next.toggleAttribute('hidden', !last || form.hidden === false);
    if (last) {
      next.setAttribute('x1', last.x.toFixed(1));
      next.setAttribute('y1', last.y.toFixed(1));
      next.setAttribute('x2', middle.x.toFixed(1));
      next.setAttribute('y2', middle.y.toFixed(1));
    }
    lengthChip.hidden = !under;
    if (under) lengthChip.textContent = `${Math.round(lengthM([...lonLats(), [under.lon, under.lat]])).toLocaleString('en-NZ')} m`;
  }

  function addPoint() {
    const ground = groundAt(viewer, centre(), groundHint());
    if (!ground) {
      words.textContent = 'The cross is not on the ground: move the map and try again.';
      return;
    }
    const last = points.at(-1);
    if (last && lengthM([[last.lon, last.lat], [ground.lon, ground.lat]]) < 0.2) {
      words.textContent = 'The cross is still on the last point: move the map first.';
      return;
    }
    points.push(ground);
    refreshBar();
    redraw();
  }

  function undo() {
    points.pop();
    refreshBar();
    redraw();
  }

  function startDrawing() {
    if (drawing) return;
    close();
    closeForm();
    beforeDrawing();
    drawing = true;
    points = [];
    overlay.classList.remove('is-form');
    overlay.hidden = false;
    refreshBar();
    redraw();
    scene.requestRender();
  }

  function stopDrawing() {
    if (!drawing) return;
    drawing = false;
    points = [];
    overlay.hidden = true;
    if (!editing) closeForm();
    afterDrawing();
  }

  // ---------- The form: what the pipe is ----------

  function showProblem(text) {
    problem.textContent = text ?? '';
    problem.hidden = !text;
  }

  function resetDelete() {
    clearTimeout(sureTimer);
    deleteButton.textContent = 'Delete';
    deleteButton.classList.remove('is-sure');
  }

  /** Opens the form: for the line just drawn, or to change `pipe`. */
  function openForm(pipe) {
    editing = pipe;
    const details = pipe ? detailsOf(pipe) : { network: lastKind, size: undefined, depth: undefined, material: '', note: '' };
    const length = pipe ? pipe.properties.length : Math.max(1, Math.round(lengthM(lonLats())));
    find(form, '.form__title').textContent = `${pipe ? pipe.properties.type : 'New pipe or cable'} – ${length.toLocaleString('en-NZ')} m`;
    for (const input of formElement.elements.network) input.checked = input.value === details.network;
    field('size').value = details.size ?? '';
    field('depth').value = details.depth ?? '';
    field('material').value = details.material;
    field('note').value = details.note;
    find(form, '.form__back').textContent = pipe ? 'Cancel' : 'Back';
    deleteButton.hidden = !pipe;
    resetDelete();
    showProblem();
    overlay.classList.add('is-form'); // the bar and the cross make room for the form
    form.hidden = false;
    redraw();
  }

  function closeForm() {
    form.hidden = true;
    editing = undefined;
    overlay.classList.remove('is-form');
    resetDelete();
  }

  async function save() {
    const details = { network: formElement.elements.network.value, size: field('size').value, depth: field('depth').value, material: field('material').value, note: field('note').value };
    let pipe;
    try {
      pipe = editing ? withDetails(editing, details, today()) : makePipe({ id: newId(), zone: zoneOf(lonLats()), points: lonLats(), added: today(), ...details });
    } catch (error) {
      return showProblem(error.message);
    }
    // A figure typed that is not one is said, not dropped in silence.
    if (details.size.trim() && pipe.properties.diameter === undefined) return showProblem('Size: a figure in millimetres, from 10 to 3000 – or leave it empty.');
    if (details.depth.trim() && pipe.properties.depth.from[0] !== 'mine') return showProblem('Depth: a figure in metres, from 0 to 30 – or leave it empty.');
    if (!store.put(pipe)) return showProblem(CANNOT_KEEP);

    const changed = drawnBy(editing ? [pipe, editing] : [pipe]);
    lastKind = details.network;
    closeForm();
    stopDrawing();
    renderList();
    await onChange(changed, pipe);
  }

  async function remove() {
    if (!editing) return;
    // Two taps: the first asks.
    if (!deleteButton.classList.contains('is-sure')) {
      deleteButton.textContent = 'Tap again to delete';
      deleteButton.classList.add('is-sure');
      sureTimer = setTimeout(resetDelete, 4000);
      return;
    }
    const gone = editing;
    if (!store.remove(gone.properties.id)) return showProblem(CANNOT_KEEP);
    closeForm();
    renderList();
    await onChange(drawnBy([gone]));
  }

  // ---------- Buttons ----------

  button.addEventListener('click', () => (panel.hidden ? open() : close()));
  find(panel, '.panel__close').addEventListener('click', close);
  find(panel, '.added__draw').addEventListener('click', startDrawing);
  find(panel, '.added__save').addEventListener('click', saveCopy);
  find(panel, '.added__load').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const [file] = fileInput.files;
    fileInput.value = ''; // the same file can be picked again
    loadCopy(file);
  });

  find(overlay, '.draw__add').addEventListener('click', addPoint);
  undoButton.addEventListener('click', undo);
  finishButton.addEventListener('click', () => points.length >= 2 && openForm());
  find(overlay, '.draw__cancel').addEventListener('click', stopDrawing);
  scene.postRender.addEventListener(redraw);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drawing && form.hidden) stopDrawing();
  });

  formElement.addEventListener('submit', (event) => {
    event.preventDefault();
    save();
  });
  find(form, '.form__back').addEventListener('click', () => {
    const wasEditing = Boolean(editing);
    closeForm();
    if (!wasEditing) redraw(); // back to the drawing, the points still there
  });
  deleteButton.addEventListener('click', remove);

  renderList();

  return {
    close,
    get open() {
      return !panel.hidden;
    },
    get drawing() {
      return drawing;
    },
    startDrawing,
    stopDrawing,
    /** Opens the form to change or delete a pipe added before. */
    edit(id) {
      const pipe = store.get(id);
      if (!pipe) return;
      stopDrawing();
      close();
      openForm(pipe);
    },
  };
}
