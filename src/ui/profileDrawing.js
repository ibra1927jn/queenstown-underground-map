/**
 * Draws a long section as an SVG: the ground, the pipes of a run under it, the manholes and
 * fittings on it and the pipes that cross it. Two ways of drawing the heights:
 *   'depth'  – the ground drawn flat, everything at its depth below it (how deep is it?)
 *   'levels' – true heights above sea level (how do the ground and the pipe rise and fall?)
 *
 * The model is plain data (see src/tools/profileView.js):
 *   { length, stations: [{ chain, piece, top, bottom, ground }],
 *     pieces: [{ from, to, color, selected, estimated, text }],
 *     manholes: [{ chain, depth, widthM, title }], fittings: [{ chain, letter, title }],
 *     crossings: [{ chain, depth, radiusM, color, joins, small, title }] }
 * chain: metres from the start of the run; depths in metres below the ground; ground in metres above sea level.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

function node(tag, attributes = {}, text) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}

/** A round step (1, 2, 5 × a power of ten) that gives about `count` steps over `span`. */
function niceStep(span, count) {
  const rough = span / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  return [1, 2, 5, 10].map((m) => m * power).find((step) => step >= rough);
}

const MARGIN = { left: 46, right: 14, top: 30, bottom: 22 };
const SOIL = '#efe6d8';
const SOIL_LINE = '#6b5a48';
const INK = '#13232f';
const INK_SOFT = '#536573';

/**
 * @param {SVGSVGElement} svg
 * @param {object} model
 * @param {{ mode: 'depth' | 'levels', width: number, height: number, highlight: string }} options  size in CSS pixels
 * @returns {{ chainAt: (clientX: number) => number, setCursor: (chain?: number) => void, groundAt: (chain: number) => number }}
 */
export function drawProfile(svg, model, { mode, width, height, highlight }) {
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const plot = { left: MARGIN.left, right: width - MARGIN.right, top: MARGIN.top, bottom: height - MARGIN.bottom };
  const { stations } = model;
  const xOf = (chain) => plot.left + (chain / model.length) * (plot.right - plot.left);
  const sx = (plot.right - plot.left) / model.length; // pixels per metre along

  /** The ground height at a chain, between the stations either side. */
  function groundAt(chain) {
    let k = stations.findIndex((station) => station.chain >= chain);
    if (k <= 0) return stations[k === 0 ? 0 : stations.length - 1].ground;
    const a = stations[k - 1];
    const b = stations[k];
    return b.chain === a.chain ? b.ground : a.ground + ((b.ground - a.ground) * (chain - a.chain)) / (b.chain - a.chain);
  }

  // ---- The vertical scale ----
  const deepest = Math.max(1.5, ...stations.map((s) => s.bottom), ...model.manholes.map((m) => m.depth), ...model.crossings.map((c) => Math.min(c.depth + c.radiusM, 8)));
  let yOf; // (ground height, depth below it) -> y
  let sy; // pixels per metre of height
  const ticks = []; // { y, label }
  if (mode === 'depth') {
    const span = deepest * 1.15;
    sy = (plot.bottom - plot.top) / span;
    yOf = (ground, depth) => plot.top + depth * sy;
    const step = niceStep(span, 4);
    for (let depth = 0; depth <= span; depth += step) ticks.push({ y: plot.top + depth * sy, label: depth === 0 ? 'Ground' : `${Number(depth.toFixed(2))} m` });
  } else {
    const high = Math.max(...stations.map((s) => s.ground));
    const low = Math.min(...stations.map((s) => s.ground - s.bottom), ...model.manholes.map((m) => groundAt(m.chain) - m.depth));
    const pad = Math.max(0.4, (high - low) * 0.08);
    const span = high - low + 2 * pad;
    sy = (plot.bottom - plot.top) / span;
    yOf = (ground, depth) => plot.top + (high + pad - (ground - depth)) * sy;
    const step = niceStep(span, 4);
    for (let level = Math.ceil((low - pad) / step) * step; level <= high + pad; level += step) ticks.push({ y: plot.top + (high + pad - level) * sy, label: `${Number(level.toFixed(2))} m` });
  }

  // ---- Soil under the ground line ----
  const groundPoints = stations.map((s) => `${xOf(s.chain).toFixed(1)},${yOf(s.ground, 0).toFixed(1)}`);
  svg.append(
    node('polygon', { points: [...groundPoints, `${plot.right},${plot.bottom}`, `${plot.left},${plot.bottom}`].join(' '), fill: SOIL }),
    ...ticks.map(({ y }) => node('line', { x1: plot.left, x2: plot.right, y1: y, y2: y, stroke: 'rgba(19,35,47,0.12)', 'stroke-width': 1 })),
    ...ticks.map(({ y, label }) => node('text', { x: plot.left - 6, y: y + 3.5, 'text-anchor': 'end', 'font-size': 10.5, fill: INK_SOFT }, label)),
    node('polyline', { points: groundPoints.join(' '), fill: 'none', stroke: SOIL_LINE, 'stroke-width': 2, 'stroke-linejoin': 'round' }),
  );

  // ---- Distance along the run ----
  const chainStep = niceStep(model.length, Math.max(2, Math.floor((plot.right - plot.left) / 70)));
  for (let chain = 0; chain <= model.length + 0.01; chain += chainStep) {
    const x = xOf(chain);
    svg.append(
      node('line', { x1: x, x2: x, y1: plot.bottom, y2: plot.bottom + 4, stroke: INK_SOFT, 'stroke-width': 1 }),
      node('text', { x, y: plot.bottom + 15, 'text-anchor': chain === 0 ? 'start' : 'middle', 'font-size': 10.5, fill: INK_SOFT }, chain === 0 ? '0' : `${chain} m`),
    );
  }

  // ---- Pipes that cross (behind the run) ----
  for (const crossing of model.crossings) {
    const x = xOf(crossing.chain);
    const y = yOf(groundAt(crossing.chain), crossing.depth);
    const circle = crossing.joins
      ? node('circle', { cx: x, cy: y, r: 2.6, fill: crossing.color })
      : node('circle', { cx: x, cy: y, r: Math.min(9, Math.max(crossing.small ? 2.6 : 4, crossing.radiusM * sy)), fill: '#fff', stroke: crossing.color, 'stroke-width': crossing.small ? 1.4 : 2.2 });
    circle.append(node('title', {}, crossing.title));
    svg.append(circle);
  }

  // ---- The pipes of the run ----
  model.pieces.forEach((piece, number) => {
    const own = stations.filter((s) => s.piece === number);
    if (own.length < 2) return;
    // Never thinner than 3 pixels, whatever the scale.
    const grow = Math.max(0, 3 - (own[0].bottom - own[0].top) * sy) / 2;
    const along = (key, sign) => own.map((s) => `${xOf(s.chain).toFixed(1)},${(yOf(s.ground, s[key]) + sign * grow).toFixed(1)}`);
    const shape = node('polygon', {
      points: [...along('top', -1), ...along('bottom', 1).reverse()].join(' '),
      fill: piece.color,
      'fill-opacity': piece.estimated ? 0.55 : 1,
      stroke: piece.selected ? highlight : INK,
      'stroke-width': piece.selected ? 5 : 0.8,
      'stroke-linejoin': 'round',
      'paint-order': 'stroke',
    });
    shape.append(node('title', {}, piece.title));
    svg.append(shape);

    const widthPx = (piece.to - piece.from) * sx;
    if (piece.text && widthPx >= 66) {
      const middle = own[Math.floor(own.length / 2)];
      svg.append(
        node(
          'text',
          { x: xOf(middle.chain), y: Math.min(plot.bottom - 3, yOf(middle.ground, middle.bottom) + grow + 13), 'text-anchor': 'middle', 'font-size': 10.5, fill: INK, stroke: SOIL, 'stroke-width': 3, 'paint-order': 'stroke' },
          piece.text,
        ),
      );
    }
  });

  // ---- Manholes: from the lid down to their bottom ----
  for (const manhole of model.manholes) {
    const x = xOf(manhole.chain);
    const ground = groundAt(manhole.chain);
    const top = yOf(ground, 0);
    const w = Math.max(7, manhole.widthM * sx);
    const shaft = node('rect', { x: x - w / 2, y: top, width: w, height: Math.max(3, yOf(ground, manhole.depth) - top), fill: '#f8f9fa', 'fill-opacity': 0.92, stroke: '#495057', 'stroke-width': 1.2 });
    shaft.append(node('title', {}, manhole.title));
    svg.append(shaft, node('rect', { x: x - w / 2 - 2, y: top - 2.5, width: w + 4, height: 3.5, rx: 1, fill: '#495057' }));
  }

  // ---- Valves, hydrants and other fittings: a mark above the ground ----
  let lastMarkX = -Infinity;
  for (const fitting of model.fittings) {
    const x = xOf(fitting.chain);
    const ground = yOf(groundAt(fitting.chain), 0);
    if (!fitting.letter) {
      svg.append(node('line', { x1: x, x2: x, y1: ground - 5, y2: ground, stroke: INK_SOFT, 'stroke-width': 1.5 }));
      continue;
    }
    if (x - lastMarkX < 15) continue; // on top of the one before
    lastMarkX = x;
    const mark = node('g');
    mark.append(
      node('line', { x1: x, x2: x, y1: ground - 8, y2: ground, stroke: INK_SOFT, 'stroke-width': 1 }),
      node('circle', { cx: x, cy: ground - 15, r: 7, fill: '#fff', stroke: fitting.color, 'stroke-width': 1.6 }),
      node('text', { x, y: ground - 11.6, 'text-anchor': 'middle', 'font-size': 9.5, 'font-weight': 700, fill: INK }, fitting.letter),
      node('title', {}, fitting.title),
    );
    svg.append(mark);
  }

  // ---- How much taller than wide heights are drawn ----
  const stretch = sy / sx;
  svg.append(
    node('text', { x: plot.right, y: 11, 'text-anchor': 'end', 'font-size': 10.5, fill: INK_SOFT }, stretch >= 1.15 ? `Heights drawn ×${stretch >= 10 ? Math.round(stretch) : stretch.toFixed(1)} taller` : 'Heights to scale'),
  );

  // ---- The cursor ----
  const cursor = node('line', { y1: plot.top - 6, y2: plot.bottom, stroke: INK, 'stroke-width': 1.2, 'stroke-dasharray': '3 3', visibility: 'hidden', 'pointer-events': 'none' });
  svg.append(cursor);

  return {
    groundAt,
    /** The chain under a position of the pointer (clientX), kept inside the run. */
    chainAt(clientX) {
      const box = svg.getBoundingClientRect();
      const x = ((clientX - box.left) / box.width) * width;
      return Math.min(model.length, Math.max(0, ((x - plot.left) / (plot.right - plot.left)) * model.length));
    },
    setCursor(chain) {
      if (chain === undefined) {
        cursor.setAttribute('visibility', 'hidden');
        return;
      }
      cursor.setAttribute('x1', xOf(chain));
      cursor.setAttribute('x2', xOf(chain));
      cursor.setAttribute('visibility', 'visible');
    },
  };
}
