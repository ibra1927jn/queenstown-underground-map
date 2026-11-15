/**
 * "By year installed": the View menu (src/ui/viewMenu.js) opens a bar at the bottom of the map. While it is open the
 * pipes and assets are coloured by the decade they were laid in, and the bar picks which years
 * are shown:
 *   - the slider: everything laid up to that year (at the far right: all, also those without a year);
 *   - ▶: the slider moves on by itself, so the networks grow on screen year by year;
 *   - "Last 5 years" / "Last 2 years": only the newest work.
 * Closing the bar brings back the colours of the networks and every pipe.
 */
import { el } from '../util/dom.js';

/**
 * @param {object} options
 * @param {HTMLButtonElement} [options.button]  a button that opens and closes it (the View menu does that now)
 * @param {HTMLElement} options.bar
 * @param {object} options.settings      CONFIG.networks.years
 * @param {(years: { colour: boolean, from?: number, to?: number }) => void} options.onChange
 * @param {(open: boolean) => void} [options.onToggle]
 */
export function createYearsControl({ button, bar, settings, onChange, onToggle }) {
  const slider = bar.querySelector('.years-bar__slider');
  const label = bar.querySelector('.years-bar__label');
  const yearText = bar.querySelector('.years-bar__year');
  const play = bar.querySelector('.years-bar__play');
  const chips = [...bar.querySelectorAll('[data-range]')];
  const { first, last } = settings;

  slider.min = String(first);
  slider.max = String(last);
  slider.value = String(last);

  // The colours, once.
  bar.querySelector('.years-bar__legend').append(
    ...settings.bins.map((bin) => el('li', {}, el('span', { class: 'years-bar__swatch', style: { background: bin.color } }), bin.label)),
    el('li', {}, el('span', { class: 'years-bar__swatch', style: { background: settings.unknownColor } }), 'No year recorded'),
  );

  let open = false;
  let range = 'all'; // 'all' | 'upTo' | number of recent years
  let timer;
  let pending = false;

  function describe() {
    if (range === 'all') return ['All years', ''];
    if (typeof range === 'number') return ['Laid in', `${last - range + 1}–${last}`];
    return ['Laid up to', slider.value];
  }

  /** Tells the map, at most once a frame (the slider sends many changes while dragged). */
  function apply() {
    const [words, years] = describe();
    label.textContent = words;
    yearText.textContent = years;
    for (const chip of chips) chip.setAttribute('aria-pressed', String(chip.dataset.range === String(range)));
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (!open) return;
      if (range === 'all') onChange({ colour: true });
      else if (typeof range === 'number') onChange({ colour: true, from: last - range + 1, to: last });
      else onChange({ colour: true, to: Number(slider.value) });
    });
  }

  function stopPlaying() {
    clearInterval(timer);
    timer = undefined;
    play.setAttribute('aria-pressed', 'false');
    play.title = 'Play: watch the networks grow';
  }

  function setOpen(next) {
    open = next;
    stopPlaying();
    bar.hidden = !open;
    button?.setAttribute('aria-pressed', String(open));
    if (open) {
      range = 'all';
      slider.value = String(last);
      apply();
    } else {
      onChange({ colour: false });
    }
    onToggle?.(open);
  }

  button?.addEventListener('click', () => setOpen(!open));
  bar.querySelector('.years-bar__close').addEventListener('click', () => setOpen(false));

  slider.addEventListener('input', () => {
    stopPlaying();
    range = Number(slider.value) >= last ? 'all' : 'upTo';
    apply();
  });

  for (const chip of chips) {
    chip.addEventListener('click', () => {
      stopPlaying();
      range = chip.dataset.range === 'all' ? 'all' : Number(chip.dataset.range);
      slider.value = String(last);
      apply();
    });
  }

  play.addEventListener('click', () => {
    if (timer) {
      stopPlaying();
      return;
    }
    // From the start (or from where the slider is, if it was moved back).
    if (range !== 'upTo') slider.value = String(first);
    range = 'upTo';
    play.setAttribute('aria-pressed', 'true');
    play.title = 'Pause';
    apply();
    timer = setInterval(() => {
      const next = Number(slider.value) + 1;
      slider.value = String(Math.min(next, last));
      range = next >= last ? 'all' : 'upTo';
      apply();
      if (next >= last) stopPlaying();
    }, settings.playStepMs);
  });

  return {
    get open() {
      return open;
    },
    close: () => open && setOpen(false),
    toggle: () => setOpen(!open),
  };
}
