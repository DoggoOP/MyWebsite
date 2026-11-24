import type { Pt } from '../../lib/sails';
import type { Grid } from './grid';

// Mask layout: Uint8Array of cols*rows, index row*cols + col, row 0 at the page top, 1 = solid.

/** A circle in page CSS px. */
export type Disc = { cx: number; cy: number; r: number };

/** Mark every cell whose centre lies inside the disc. ORs into `out`. */
export function rasterizeDisc(d: Disc, g: Grid, out: Uint8Array): void {
  const { cols, rows, cell } = g;
  if (!(d.r > 0)) return;
  const r2 = d.r * d.r;
  const r0 = Math.max(0, Math.floor((d.cy - d.r) / cell)), r1 = Math.min(rows - 1, Math.floor((d.cy + d.r) / cell));
  const c0 = Math.max(0, Math.floor((d.cx - d.r) / cell)), c1 = Math.min(cols - 1, Math.floor((d.cx + d.r) / cell));
  for (let row = r0; row <= r1; row++) {
    const dy = (row + 0.5) * cell - d.cy;
    for (let col = c0; col <= c1; col++) {
      const dx = (col + 0.5) * cell - d.cx;
      if (dx * dx + dy * dy <= r2) out[row * cols + col] = 1;
    }
  }
}

/**
 * Mark every cell whose centre lies within thicknessCells*cell/2 page px of any segment.
 * ORs into `out`.
 */
export function rasterizePolyline(pts: Pt[], g: Grid, thicknessCells: number, out: Uint8Array): void {
  const { cols, rows, cell } = g;
  const r = thicknessCells * cell / 2;
  const r2 = r * r;
  const seg = (ax: number, ay: number, bx: number, by: number) => {
    const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - r) / cell));
    const c1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx) + r) / cell));
    const r0 = Math.max(0, Math.floor((Math.min(ay, by) - r) / cell));
    const r1 = Math.min(rows - 1, Math.floor((Math.max(ay, by) + r) / cell));
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let row = r0; row <= r1; row++) {
      const py = (row + 0.5) * cell;
      for (let col = c0; col <= c1; col++) {
        const px = (col + 0.5) * cell;
        const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
        const ex = px - (ax + t * dx), ey = py - (ay + t * dy);
        if (ex * ex + ey * ey <= r2) out[row * cols + col] = 1;
      }
    }
  };
  if (pts.length === 1) seg(pts[0][0], pts[0][1], pts[0][0], pts[0][1]);
  for (let i = 0; i + 1 < pts.length; i++) seg(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
}

/**
 * Centroid (in cells) and approximate radius sqrt(area/pi) of each solid component.
 * Uses 4-connectivity; components under 4 cells are ignored.
 */
export function solidCentroids(mask: Uint8Array, g: Grid): { col: number; row: number; radius: number }[] {
  const { cols, rows } = g;
  const seen = new Uint8Array(cols * rows);
  const stack: number[] = [];
  const result: { col: number; row: number; radius: number }[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let area = 0, sc = 0, sr = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      const c = i % cols, r = (i - c) / cols;
      area++; sc += c; sr += r;
      if (c > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (c < cols - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (r > 0 && mask[i - cols] && !seen[i - cols]) { seen[i - cols] = 1; stack.push(i - cols); }
      if (r < rows - 1 && mask[i + cols] && !seen[i + cols]) { seen[i + cols] = 1; stack.push(i + cols); }
    }
    if (area >= 4) result.push({ col: sc / area, row: sr / area, radius: Math.sqrt(area / Math.PI) });
  }
  return result;
}
