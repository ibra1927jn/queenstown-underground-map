/**
 * The "Layers" panel: one switch per map layer, each with its colour legend.
 *
 * Layers are described with plain data:
 *   { id: 'buildings', label: 'Buildings', visible: true,
 *     legend: [{ label: 'Residential', color: '#e9e2d6' }, { label: 'Valve', icon: 'data:image/png…' }], note: '…' }
 */
import { clear, el } from '../util/dom.js';

export function createLayersPanel({ panel, list, toggleButton, onToggle, onOpen }) {
  /** On phones the panel is a bottom sheet opened with the toggle button. */
  function setOpen(open) {
    panel.hidden = !open;
    toggleButton.setAttribute('aria-expanded', String(open));
    if (open) onOpen?.();
  }

  toggleButton.addEventListener('click', () => setOpen(panel.hidden));
  setOpen(false);

  function render(layers) {
    clear(list);
    for (const layer of layers) {
      const checkbox = el('input', { type: 'checkbox' });
      checkbox.checked = layer.visible;
      checkbox.addEventListener('change', () => onToggle(layer.id, checkbox.checked));

      const item = el('li', {}, el('label', { class: 'layer' }, checkbox, el('span', { class: 'layer__name', text: layer.label })));

      if (layer.legend?.length) {
        item.append(
          el(
            'ul',
            { class: 'legend' },
            ...layer.legend.map((entry) =>
              el(
                'li',
                {},
                entry.icon ? el('img', { class: 'legend__icon', src: entry.icon, alt: '' }) : el('span', { class: 'swatch', vars: { '--swatch': entry.color } }),
                el('span', { text: entry.label }),
              ),
            ),
          ),
        );
      }
      if (layer.note) item.append(el('p', { class: 'panel__note', text: layer.note }));
      list.append(item);
    }
  }

  return { render, close: () => setOpen(false) };
}
