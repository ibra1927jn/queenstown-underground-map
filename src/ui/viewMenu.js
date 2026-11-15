/**
 * The "View" menu: one button in the top bar that says how the map is being looked at, and opens a
 * list with a name and a line about each way:
 *   Map · Underground · Open ground · Excavation   – one at a time (items with data-view)
 *   By year · Flow direction                       – each on or off, with any of them (items with data-toggle)
 * It took the place of a column of round buttons that had only pictures on them.
 *
 * The list is in index.html (#view-menu); this file opens and closes it, marks what is on, and
 * passes on what is picked. It works with the keyboard too: arrows move, Escape closes.
 */

/**
 * @param {object} options
 * @param {HTMLElement} options.container       #view-menu
 * @param {(view: string) => void} options.onPick
 * @param {(name: string) => void} options.onToggle  told which switch was pressed (its data-toggle)
 */
export function createViewMenu({ container, onPick, onToggle }) {
  const button = container.querySelector('.view-menu__button');
  const current = container.querySelector('.view-menu__current');
  const list = container.querySelector('.view-menu__list');
  const views = [...list.querySelectorAll('[data-view]')];
  const toggles = [...list.querySelectorAll('[data-toggle]')];
  const items = [...views, ...toggles];

  function setOpen(open) {
    list.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    container.classList.toggle('is-open', open);
  }

  function close({ focusButton = false } = {}) {
    if (list.hidden) return;
    setOpen(false);
    if (focusButton) button.focus();
  }

  button.addEventListener('click', () => {
    const opening = list.hidden;
    setOpen(opening);
    // From the keyboard the list is ready to walk through; with a finger nothing is highlighted.
    if (opening && button.matches(':focus-visible')) (items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0]).focus();
  });

  for (const item of views) {
    item.addEventListener('click', () => {
      close();
      onPick(item.dataset.view);
    });
  }
  for (const toggle of toggles) {
    toggle.addEventListener('click', () => {
      close();
      onToggle(toggle.dataset.toggle);
    });
  }

  list.addEventListener('keydown', (event) => {
    const at = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length].focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      items[event.key === 'Home' ? 0 : items.length - 1].focus();
    } else if (event.key === 'Escape') {
      // Only the menu closes: the excavation, say, stays open (it also listens for Escape).
      event.stopPropagation();
      close({ focusButton: true });
    } else if (event.key === 'Tab') {
      close();
    }
  });

  // A tap or click anywhere else closes it.
  document.addEventListener('pointerdown', (event) => {
    if (!container.contains(event.target)) close();
  });

  return {
    /** Marks what is on: `view` one of the data-view names, `toggled` the switches that are on ({ years: true, flow: false }). */
    show({ view, toggled }) {
      let name = '';
      for (const item of views) {
        const on = item.dataset.view === view;
        item.setAttribute('aria-checked', String(on));
        if (on) name = item.querySelector('strong').textContent;
      }
      const on = toggles.filter((toggle) => Boolean(toggled[toggle.dataset.toggle]));
      for (const toggle of toggles) toggle.setAttribute('aria-checked', String(on.includes(toggle)));
      current.textContent = [name, ...on.map((toggle) => toggle.querySelector('strong').textContent.toLowerCase())].join(' · ');
      // Anything but the plain map: the button is coloured, so it shows from afar that a special view is on.
      container.classList.toggle('is-special', view !== 'map' || on.length > 0);
    },
    close,
  };
}
