/**
 * Small map symbols for the point assets of the networks, drawn once on a canvas each and reused:
 *   manhole ........ a lid: a circle with a cross
 *   valve, toby .... the usual valve sign: two triangles point to point (hollow when normally closed)
 *   hydrant ........ a yellow disc with an H
 *   tee, bend, reducer, end cap, junction … the shape of the fitting
 *   meter .......... a dial; backflow preventer: a non-return arrow; road gully: a grate;
 *   outlet ......... an arrow out of a wall; soakpit: dots soaking away
 * Each symbol sits on a disc of its colour with a white rim, so it reads on any background.
 */

const SIZE = 48; // drawn at this size and shown at half: sharp on high-density screens
const cache = new Map();

/** Which symbol an asset gets. */
export function symbolOf(properties) {
  const p = properties;
  if (p.kind === 'manhole') return 'manhole';
  if (p.kind === 'hydrant') return 'hydrant';
  if (p.kind === 'valve') return p.shape === 'boundary' ? 'boundary' : String(p.type).startsWith('Toby') ? 'toby' : p.position === 'closed' ? 'valveClosed' : 'valve';
  if (p.kind === 'fitting') return ['tee', 'bend', 'reducer', 'end', 'junction', 'thrust', 'sample', 'pump', 'inspection'].includes(p.shape) ? p.shape : 'junction';
  if (p.kind === 'meter') return 'meter';
  if (p.kind === 'backflow') return 'backflow';
  if (p.kind === 'inlet') return 'gully';
  if (p.kind === 'outlet') return 'outlet';
  if (p.kind === 'device') return 'soakpit';
  if (p.kind === 'bore') return 'bore';
  if (p.kind === 'monitoring') return { groundwater: 'bore', sampling: 'sample', rain: 'rain' }[p.shape] ?? 'waves';
  if (p.kind === 'instrument') return { flow: 'flow', level: 'level', pressure: 'meter', analyser: 'sample', temperature: 'thermo', rain: 'rain' }[p.shape] ?? 'sensor';
  if (p.kind === 'machine') return p.shape === 'pump' ? 'pump' : 'gear';
  if (p.kind === 'substation') return 'substation';
  if (p.kind === 'tower') return 'tower';
  if (p.kind === 'transformer') return 'transformer';
  if (p.kind === 'streetlight') return 'streetlight';
  if (p.kind === 'facility') return { pumpstation: 'pumpstation', reservoir: 'reservoir', treatment: 'treatment', bore: 'bore', intake: 'outlet', chamber: 'manhole', cabinet: 'cabinet' }[p.shape] ?? 'pumpstation';
  return 'junction';
}

/** Symbols on a smaller disc (there are many of them, close together). */
const SMALL = new Set(['toby', 'meter', 'junction', 'end', 'bend', 'tee', 'reducer', 'inspection', 'streetlight', 'transformer', 'tower']);

/**
 * The image of a symbol, as a data URL (cached). Cesium keeps one copy of each URL on the
 * graphics card however many symbols use it; the legend shows the same URL.
 * @param {string} symbol    see symbolOf
 * @param {string} fill      CSS colour of the disc
 * @param {object} [options] { ink: colour of the drawing on the disc, selected: draw it highlighted }
 */
export function iconImage(symbol, fill, { ink = '#ffffff', selected = false } = {}) {
  const key = `${symbol}|${fill}|${ink}|${selected}`;
  if (cache.has(key)) return cache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const c = canvas.getContext('2d');
  const mid = SIZE / 2;
  const radius = (SMALL.has(symbol) ? 15 : 19) * (selected ? 1.12 : 1);

  // The disc, with a white rim (a dark one when selected, around a yellow disc).
  c.beginPath();
  c.arc(mid, mid, radius, 0, Math.PI * 2);
  c.fillStyle = selected ? '#ffd43b' : fill;
  c.fill();
  c.lineWidth = 4;
  c.strokeStyle = selected ? '#13232f' : '#ffffff';
  c.stroke();

  c.fillStyle = selected ? '#13232f' : ink;
  c.strokeStyle = selected ? '#13232f' : ink;
  c.lineWidth = 3.5;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  const s = radius * 0.55; // half the size of the drawing inside the disc
  const path = (points, close = false) => {
    c.beginPath();
    points.forEach(([x, y], i) => (i ? c.lineTo(mid + x * s, mid + y * s) : c.moveTo(mid + x * s, mid + y * s)));
    if (close) c.closePath();
  };

  switch (symbol) {
    case 'manhole':
      c.beginPath();
      c.arc(mid, mid, s * 0.95, 0, Math.PI * 2);
      c.stroke();
      path([[-0.65, 0], [0.65, 0]]);
      c.stroke();
      path([[0, -0.65], [0, 0.65]]);
      c.stroke();
      break;
    case 'valve':
    case 'toby':
    case 'boundary':
      path([[-1, -0.75], [1, 0.75], [1, -0.75], [-1, 0.75]], true);
      c.fill();
      break;
    case 'valveClosed':
      path([[-1, -0.75], [1, 0.75], [1, -0.75], [-1, 0.75]], true);
      c.stroke();
      break;
    case 'hydrant':
      path([[-0.6, -0.85], [-0.6, 0.85]]);
      c.stroke();
      path([[0.6, -0.85], [0.6, 0.85]]);
      c.stroke();
      path([[-0.6, 0], [0.6, 0]]);
      c.stroke();
      break;
    case 'tee':
      path([[-1, -0.55], [1, -0.55]]);
      c.stroke();
      path([[0, -0.55], [0, 1]]);
      c.stroke();
      break;
    case 'bend':
      c.beginPath();
      c.arc(mid + s, mid + s, s * 1.6, Math.PI, Math.PI * 1.5);
      c.stroke();
      break;
    case 'reducer':
      path([[-1, -0.8], [1, -0.4], [1, 0.4], [-1, 0.8]], true);
      c.fill();
      break;
    case 'end':
      path([[-1, 0], [0.4, 0]]);
      c.stroke();
      path([[0.45, -0.85], [0.45, 0.85]]);
      c.stroke();
      break;
    case 'junction':
      path([[-1, 0.2], [1, 0.2]]);
      c.stroke();
      path([[0, 0.2], [-0.7, -0.9]]);
      c.stroke();
      break;
    case 'thrust':
      path([[-0.8, -0.8], [0.8, -0.8], [0.8, 0.8], [-0.8, 0.8]], true);
      c.fill();
      break;
    case 'sample':
      c.beginPath();
      c.moveTo(mid, mid - s);
      c.quadraticCurveTo(mid + s, mid + 0.1 * s, mid, mid + s * 0.9);
      c.quadraticCurveTo(mid - s, mid + 0.1 * s, mid, mid - s);
      c.fill();
      break;
    case 'pump':
      path([[-0.6, -0.85], [0.95, 0], [-0.6, 0.85]], true);
      c.fill();
      break;
    case 'inspection':
      c.beginPath();
      c.arc(mid, mid, s * 0.45, 0, Math.PI * 2);
      c.fill();
      break;
    case 'meter':
      c.beginPath();
      c.arc(mid, mid, s * 0.85, Math.PI * 0.85, Math.PI * 2.15);
      c.stroke();
      path([[0, 0.25], [0.55, -0.45]]);
      c.stroke();
      break;
    case 'backflow':
      path([[-0.9, 0], [0.4, 0]]);
      c.stroke();
      path([[0.05, -0.55], [0.75, 0], [0.05, 0.55]]);
      c.stroke();
      path([[0.95, -0.7], [0.95, 0.7]]);
      c.stroke();
      break;
    case 'gully':
      path([[-0.85, -0.85], [0.85, -0.85], [0.85, 0.85], [-0.85, 0.85]], true);
      c.stroke();
      for (const x of [-0.35, 0.05, 0.45]) {
        path([[x, -0.85], [x, 0.85]]);
        c.stroke();
      }
      break;
    case 'outlet':
      path([[-0.85, -0.9], [-0.85, 0.9]]);
      c.stroke();
      path([[-0.5, 0], [0.9, 0]]);
      c.stroke();
      path([[0.35, -0.5], [0.9, 0], [0.35, 0.5]]);
      c.stroke();
      break;
    case 'pumpstation':
      c.beginPath();
      c.arc(mid, mid, s * 0.9, 0, Math.PI * 2);
      c.stroke();
      path([[-0.35, -0.5], [0.55, 0], [-0.35, 0.5]], true);
      c.fill();
      break;
    case 'reservoir':
      path([[-0.85, -0.55], [-0.85, 0.8], [0.85, 0.8], [0.85, -0.55]]);
      c.stroke();
      c.beginPath();
      c.ellipse(mid, mid - 0.55 * s, 0.85 * s, 0.3 * s, 0, 0, Math.PI * 2);
      c.stroke();
      path([[-0.85, 0.2], [0.85, 0.2]]);
      c.stroke();
      break;
    case 'treatment':
      c.beginPath();
      c.moveTo(mid, mid - s);
      c.quadraticCurveTo(mid + s, mid + 0.1 * s, mid, mid + s * 0.9);
      c.quadraticCurveTo(mid - s, mid + 0.1 * s, mid, mid - s);
      c.stroke();
      path([[-0.35, 0.3], [0.35, 0.3]]);
      c.stroke();
      break;
    case 'cabinet':
      path([[-0.6, -0.85], [0.6, -0.85], [0.6, 0.85], [-0.6, 0.85]], true);
      c.stroke();
      path([[0.2, -0.1], [0.2, 0.15]]);
      c.stroke();
      break;
    case 'flow':
      // A meter on a pipe: the pipe, a dial on it, the way the water goes.
      path([[-1, 0.45], [1, 0.45]]);
      c.stroke();
      c.beginPath();
      c.arc(mid, mid - 0.2 * s, s * 0.5, 0, Math.PI * 2);
      c.stroke();
      path([[0.45, 0.1], [1, 0.45], [0.45, 0.8]]);
      c.stroke();
      break;
    case 'level':
      // A tank with its water line.
      path([[-0.8, -0.85], [-0.8, 0.85], [0.8, 0.85], [0.8, -0.85]]);
      c.stroke();
      path([[-0.8, 0.05], [-0.3, -0.15], [0.3, 0.2], [0.8, 0]]);
      c.stroke();
      break;
    case 'thermo':
      path([[0, -0.9], [0, 0.35]]);
      c.stroke();
      c.beginPath();
      c.arc(mid, mid + 0.6 * s, s * 0.35, 0, Math.PI * 2);
      c.fill();
      break;
    case 'rain':
      for (const x of [-0.6, 0, 0.6]) {
        path([[x + 0.15, -0.6], [x - 0.15, 0.6]]);
        c.stroke();
      }
      break;
    case 'waves':
      for (const y of [-0.4, 0.4]) {
        c.beginPath();
        c.moveTo(mid - s, mid + y * s);
        c.quadraticCurveTo(mid - 0.5 * s, mid + (y - 0.5) * s, mid, mid + y * s);
        c.quadraticCurveTo(mid + 0.5 * s, mid + (y + 0.5) * s, mid + s, mid + y * s);
        c.stroke();
      }
      break;
    case 'sensor':
      c.beginPath();
      c.arc(mid, mid, s * 0.85, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.arc(mid, mid, s * 0.3, 0, Math.PI * 2);
      c.fill();
      break;
    case 'gear':
      c.beginPath();
      c.arc(mid, mid, s * 0.5, 0, Math.PI * 2);
      c.stroke();
      for (let i = 0; i < 6; i += 1) {
        const angle = (i / 6) * Math.PI * 2;
        path([[Math.cos(angle) * 0.55, Math.sin(angle) * 0.55], [Math.cos(angle) * 1, Math.sin(angle) * 1]]);
        c.stroke();
      }
      break;
    case 'bore':
      path([[-0.8, -0.75], [0.8, -0.75]]);
      c.stroke();
      path([[0, -0.75], [0, 0.95]]);
      c.stroke();
      c.beginPath();
      c.arc(mid, mid + 0.95 * s, s * 0.22, 0, Math.PI * 2);
      c.fill();
      break;
    case 'soakpit':
      c.beginPath();
      c.arc(mid, mid, s * 0.9, 0, Math.PI * 2);
      c.stroke();
      for (const [x, y] of [[-0.35, -0.3], [0.35, -0.3], [0, 0.35]]) {
        c.beginPath();
        c.arc(mid + x * s, mid + y * s, s * 0.17, 0, Math.PI * 2);
        c.fill();
      }
      break;
    case 'substation': // a lightning bolt
      path([[0.2, -1], [-0.55, 0.12], [0.02, 0.12], [-0.2, 1], [0.55, -0.12], [-0.02, -0.12]], true);
      c.fill();
      break;
    case 'tower': // a pylon
      path([[-0.7, 1], [0, -1], [0.7, 1]]);
      c.stroke();
      path([[-0.75, -0.45], [0.75, -0.45]]);
      c.stroke();
      path([[-0.38, 0.15], [0.38, 0.15]]);
      c.stroke();
      break;
    case 'transformer': // two coils
      c.beginPath();
      c.arc(mid - 0.32 * s, mid, s * 0.5, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.arc(mid + 0.32 * s, mid, s * 0.5, 0, Math.PI * 2);
      c.stroke();
      break;
    case 'streetlight': // a lamp post with its lamp
      path([[-0.35, 1], [-0.35, -0.75], [0.45, -0.75]]);
      c.stroke();
      c.beginPath();
      c.arc(mid + 0.5 * s, mid - 0.35 * s, s * 0.32, 0, Math.PI * 2);
      c.fill();
      break;
    default:
      break;
  }

  const url = canvas.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

/** How big a symbol is shown on screen, in CSS pixels. */
export const iconPixels = (symbol) => (SMALL.has(symbol) ? 17 : 22);
