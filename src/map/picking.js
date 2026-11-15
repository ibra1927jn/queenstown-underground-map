/**
 * Tap / click selection: finds what is under the pointer, highlights it and
 * reports a description for the details panel.
 *
 * Every drawable thing carries an id of the form { layer: 'buildings', … };
 * the layer with that id knows how to highlight and describe it.
 */
import { Cesium } from './cesium.js';

/** Size (CSS px) of the square searched around the pointer – generous, so thin lines are easy to hit with a finger. */
const PICK_BOX_PX = 10;

/**
 * @param {object} viewer
 * @param {{ layers: object[], onSelect: (description: object, id: object, tappedAt?: number[]) => void, onClear: () => void, onHighlight?: (id: object | undefined) => void }} options
 *   onSelect: tappedAt is the [lon, lat] of the ground under the tap (undefined when selected otherwise);
 *   onHighlight: told what is highlighted, for views that draw things their own way (the excavation)
 */
export function createPicking(viewer, { layers, onSelect, onClear, onHighlight }) {
  const { scene } = viewer;
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  let selectedLayer;
  let enabled = true;

  function clear() {
    selectedLayer?.highlight(undefined);
    selectedLayer = undefined;
    onHighlight?.(undefined);
  }

  /** Highlights a thing by its id and shows its details; returns false if no layer knows it. */
  function select(id, tappedAt) {
    const layer = id && typeof id === 'object' ? byId.get(id.layer) : undefined;
    const description = layer?.describe(id);
    clear();
    if (!description) {
      onClear();
      return false;
    }
    selectedLayer = layer;
    layer.highlight(id);
    onHighlight?.(id);
    onSelect(description, id, tappedAt);
    return true;
  }

  /** Where on the ground a tap is ([lon, lat]), if it is on the ground. */
  function groundUnder(position) {
    const ray = scene.camera.getPickRay(position);
    const point = ray && scene.globe.pick(ray, scene);
    if (!point) return undefined;
    const { longitude, latitude } = Cesium.Cartographic.fromCartesian(point);
    return [Cesium.Math.toDegrees(longitude), Cesium.Math.toDegrees(latitude)];
  }

  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction(({ position }) => {
    if (!enabled) return;
    // Cesium measures the search square in screen (device) pixels, which are smaller than CSS pixels on sharp screens.
    const box = Math.max(3, Math.round((PICK_BOX_PX * scene.drawingBufferWidth) / scene.canvas.clientWidth));
    select(scene.pick(position, box, box)?.id, groundUnder(position));
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  return {
    clear,
    select,
    /** Taps can be used by a tool for a while instead of selecting things. */
    setEnabled(next) {
      enabled = next;
    },
  };
}
