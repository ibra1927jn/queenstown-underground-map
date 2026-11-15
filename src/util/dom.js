/**
 * Small DOM helpers. Text always goes in through `textContent`, never as
 * HTML, so values coming from data files cannot inject markup.
 */

/** Creates an element: el('li', { class: 'legend__item', text: 'Houses' }, child1, child2) */
export function el(tag, options = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style') Object.assign(node.style, value);
    else if (key === 'vars') for (const [name, v] of Object.entries(value)) node.style.setProperty(name, v);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...children.filter((child) => child !== undefined && child !== null && child !== false));
  return node;
}

/** Removes every child of a node. */
export function clear(node) {
  node.replaceChildren();
}

/** The element with this id – fails loudly when the page is missing it. */
export function byId(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Page element #${id} is missing`);
  return node;
}
