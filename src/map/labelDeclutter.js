/**
 * Labels that give way to each other: where several would pile up on the screen (a manhole, a valve and
 * a pipe depth at one junction), only the most important shows – the thing tapped, then the depth scale,
 * then manholes, valves and hydrants, then pipe depths; between equals, the nearest. Worked out again a
 * few times a second while the camera moves, and once it stops (choices: src/util/declutter.js).
 */
import { Cesium } from './cesium.js';
import { pickShown } from '../util/declutter.js';

// A label is drawn from its left edge, its bottom at its point plus its pixel offset (see the views).
/** The white outline round the letters reaches this far beyond them. */
const OUTLINE_PX = 2;
/** A line of text is this many times as tall as its font size. */
const LINE_HEIGHT = 1.25;

/**
 * @param {object} scene
 * @param {{ everyMs?: number, gapPx?: number }} [options]  at most one pass every `everyMs` while moving
 * @returns {{ watch: (labels?: object) => void, refresh: () => void }}
 *   watch: the LabelCollection now on the map (undefined: none); refresh: after a label changed (highlighted)
 */
export function createLabelDeclutter(scene, { everyMs = 150, gapPx = 2 } = {}) {
  const { camera } = scene;
  const measure = createTextMeasure();
  let labels;
  let dirty = false;
  let lastRun = -Infinity;
  let timer;
  const lastView = new Cesium.Matrix4();
  const onScreen = new Cesium.Cartesian2();

  /** Lower is more important. */
  function rankOf(label) {
    if (label.showBackground) return -1; // the thing tapped
    const { id } = label;
    if (!id) return 0; // the depth scale and other notes of the view itself
    return id.asset !== undefined ? 1 : 2; // manholes, valves… before pipe depths
  }

  function run() {
    lastRun = performance.now();
    dirty = false;
    Cesium.Matrix4.clone(camera.viewMatrix, lastView);
    const width = scene.canvas.clientWidth;
    const height = scene.canvas.clientHeight;
    const placed = [];
    const boxes = [];
    const wanted = new Map(); // label -> show
    for (let i = 0; i < labels.length; i += 1) {
      const label = labels.get(i);
      // Too far to be drawn at all, behind the camera or off the screen: it takes no room.
      wanted.set(label, true);
      const distance = Cesium.Cartesian3.distance(camera.positionWC, label.position);
      if (distance > (label.distanceDisplayCondition?.far ?? Infinity)) continue;
      const at = Cesium.SceneTransforms.worldToWindowCoordinates(scene, label.position, onScreen);
      if (!at || at.x < -width || at.x > 2 * width || at.y < -height || at.y > 2 * height) continue;
      const { textWidth, size } = measure(label);
      const boxHeight = size * LINE_HEIGHT;
      boxes.push({
        x: at.x + label.pixelOffset.x - OUTLINE_PX,
        y: at.y + label.pixelOffset.y - boxHeight,
        width: textWidth + 2 * OUTLINE_PX,
        height: boxHeight,
        rank: rankOf(label),
        distance,
      });
      placed.push(label);
    }
    pickShown(boxes, gapPx).forEach((show, i) => wanted.set(placed[i], show));
    let changed = false;
    for (const [label, show] of wanted) {
      if (label.show === show) continue;
      label.show = show;
      changed = true;
    }
    if (changed) scene.requestRender();
  }

  scene.postRender.addEventListener(() => {
    if (!labels || labels.isDestroyed?.()) return;
    if (!dirty && Cesium.Matrix4.equals(camera.viewMatrix, lastView)) return;
    const since = performance.now() - lastRun;
    if (since >= everyMs) return run();
    // Too soon after the last pass: one more frame once the time is up, so the last position is done too.
    timer ??= setTimeout(() => {
      timer = undefined;
      scene.requestRender();
    }, everyMs - since);
  });
  window.addEventListener('resize', () => (dirty = true));

  return {
    watch(next) {
      labels = next;
      dirty = true;
      if (labels) scene.requestRender();
    },
    refresh() {
      dirty = true;
      scene.requestRender();
    },
  };
}

/** The width of a label's text and its font size in pixels, measured once per font and text. */
function createTextMeasure() {
  const context = document.createElement('canvas').getContext('2d');
  const known = new Map();
  return (label) => {
    const key = `${label.font}|${label.text}`;
    let found = known.get(key);
    if (!found) {
      context.font = label.font;
      found = { textWidth: context.measureText(label.text).width, size: Number(/(\d+(?:\.\d+)?)px/.exec(label.font)?.[1] ?? 12) };
      if (known.size > 2000) known.clear();
      known.set(key, found);
    }
    return found;
  };
}
