/**
 * Which labels show when some would cover others: the most important first (lowest rank), then the
 * nearest; a label shows unless it would cover one already chosen. Pure: boxes in, choices out
 * (src/map/labelDeclutter.js measures the boxes on the screen and applies the choices).
 */

/**
 * @param {{ x: number, y: number, width: number, height: number, rank: number, distance: number }[]} boxes
 *   on the screen in pixels (x, y: top left); rank: lower = more important; distance: from the camera
 * @param {number} [gapPx]  labels closer to each other than this count as covering each other
 * @returns {boolean[]} for each box, in the same order, whether its label shows
 */
export function pickShown(boxes, gapPx = 2) {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a].rank - boxes[b].rank || boxes[a].distance - boxes[b].distance);
  const shown = new Array(boxes.length).fill(false);
  const kept = [];
  for (const i of order) {
    const box = boxes[i];
    const covers = kept.some(
      (other) =>
        box.x < other.x + other.width + gapPx &&
        other.x < box.x + box.width + gapPx &&
        box.y < other.y + other.height + gapPx &&
        other.y < box.y + box.height + gapPx,
    );
    if (covers) continue;
    kept.push(box);
    shown[i] = true;
  }
  return shown;
}
