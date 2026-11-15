/**
 * The round navigation buttons on the map (zoom, turn, tilt, north, back to
 * the zone) and the compass needle.
 *
 * Buttons carry `data-nav="<action>"`; the actions come from src/map/controls.js.
 * Buttons marked `data-3d-only` are hidden in the flat 2D view, which is
 * always seen from above with north at the top.
 */
import { toDegrees } from '../map/cesium.js';

/**
 * @param {{ container: HTMLElement, viewer: object, actions: {[name: string]: () => void} }} options
 */
export function createNavButtons({ container, viewer, actions }) {
  container.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-nav]') : null;
    actions[button?.dataset.nav]?.();
  });

  // The compass needle turns with the map, so "up" on it always points north.
  const needle = container.querySelector('.compass__needle');
  let shownHeading;
  viewer.scene.postRender.addEventListener(() => {
    const heading = Math.round(toDegrees(viewer.camera.heading));
    if (heading === shownHeading) return;
    shownHeading = heading;
    needle.style.transform = `rotate(${-heading}deg)`;
  });

  return {
    /** Called when the map switches between '2d' and '3d'. */
    setViewMode(mode) {
      for (const element of container.querySelectorAll('[data-3d-only]')) element.hidden = mode === '2d';
    },
  };
}
