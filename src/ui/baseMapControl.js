/**
 * The background switch: "Street map" or "Aerial photo" in the Layers panel, the same switch as a
 * chip in the years bar, and a line in both places that says which photos are shown.
 *
 * Without a key for the photos (see src/map/baseMap.js) none of this is shown.
 */

/**
 * @param {object} options
 * @param {object} options.baseMap         from createBaseMap
 * @param {HTMLElement} options.panel      the block in the Layers panel (buttons with data-base, .base-map__words)
 * @param {HTMLButtonElement} options.chip the chip in the years bar
 * @param {HTMLElement} options.caption    the line in the years bar
 * @param {() => string} options.side      the side of the district being looked at (see CONFIG.aerial.sides)
 * @param {(photo: boolean) => void} [options.onChange]
 */
export function createBaseMapControl({ baseMap, panel, chip, caption, side, onChange }) {
  if (!baseMap.available) return { refresh() {}, setYear() {}, setMode() {} };

  const buttons = [...panel.querySelectorAll('[data-base]')];
  const words = panel.querySelector('.base-map__words');
  panel.hidden = false;
  chip.hidden = false;

  function refresh() {
    const photo = baseMap.mode === 'photo';
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.base === baseMap.mode));
    chip.setAttribute('aria-pressed', String(photo));
    const text = baseMap.describe(side());
    for (const node of [words, caption]) {
      node.textContent = text;
      node.hidden = !text;
    }
  }

  function setMode(mode) {
    baseMap.setMode(mode);
    refresh();
    onChange?.(baseMap.mode === 'photo');
  }

  for (const button of buttons) button.addEventListener('click', () => setMode(button.dataset.base));
  chip.addEventListener('click', () => setMode(baseMap.mode === 'photo' ? 'map' : 'photo'));
  refresh();

  return {
    /** After the place being looked at changed. */
    refresh,
    /** 'map' or 'photo', as if picked in the panel. */
    setMode,
    /** The photos of a year (undefined: the latest). */
    setYear(year) {
      baseMap.setYear(year);
      refresh();
    },
  };
}
