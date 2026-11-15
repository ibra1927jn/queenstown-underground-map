/**
 * The details panel: shows the information of whatever was tapped on the map.
 *
 * A "description" is plain data, so every layer can describe its features the
 * same way:
 *   { title: 'Skyline Gondola', subtitle: 'Building · commercial',
 *     rows: [{ label: 'Height', value: '9 m', estimate: true }] }
 * A row can carry a small label after its value: `tag: 'estimate' | 'recorded' | 'measured' | 'nominal'`
 * (`estimate: true` is short for `tag: 'estimate'`).
 * `actions: [{ label, title, run }]` adds buttons under the rows.
 */
import { clear, el } from '../util/dom.js';

export function createInfoPanel(element, { onClose } = {}) {
  const title = element.querySelector('.info__name');
  const subtitle = element.querySelector('.info__kind');
  const list = element.querySelector('.info__list');
  const note = element.querySelector('.panel__note');
  const actions = element.querySelector('.info__actions');

  function hide() {
    element.hidden = true;
  }

  element.querySelector('.panel__close').addEventListener('click', () => {
    hide();
    onClose?.();
  });

  return {
    show(description) {
      title.textContent = description.title;
      subtitle.textContent = description.subtitle ?? '';
      subtitle.hidden = !description.subtitle;

      clear(list);
      for (const row of description.rows ?? []) {
        if (row.value === undefined || row.value === null || row.value === '') continue;
        const value = el('dd', { text: String(row.value) });
        const tag = row.tag ?? (row.estimate ? 'estimate' : undefined);
        if (tag) value.append(el('span', { class: `tag tag--${tag.split(' ')[0]}`, text: tag }));
        list.append(el('dt', { text: row.label }), value);
      }

      actions.replaceChildren(
        ...(description.actions ?? []).map((action) => {
          const button = el('button', { type: 'button', class: 'info__action', title: action.title, text: action.label });
          button.addEventListener('click', action.run);
          return button;
        }),
      );
      actions.hidden = !description.actions?.length;

      note.textContent = description.note ?? '';
      note.hidden = !description.note;
      element.hidden = false;
    },
    hide,
    get isOpen() {
      return !element.hidden;
    },
  };
}
