import type { ClassRow } from '../data/classes';
import type { Pt } from './sails';

const GOLDEN = 2.39996;
const SCALES = [0.2, 0.4, 0.6, 0.8, 1.0];

export function layoutClasses(rows: ClassRow[], R: number, cx: number, cy: number) {
  const angle = (k: number) => ((-90 + 72 * k) * Math.PI) / 180;
  const vertex = (k: number, r: number): Pt => [cx + r * Math.cos(angle(k)), cy + r * Math.sin(angle(k))];

  const dots = rows.map((row, idx) => {
    const sq = row.weights.map((w) => w * w);
    const total = sq.reduce((a, b) => a + b, 0);
    let x = 0;
    let y = 0;
    sq.forEach((s, k) => {
      const [vx, vy] = vertex(k, 0.86 * R);
      x += (s / total) * vx;
      y += (s / total) * vy;
    });
    const jitter = Math.max(...row.weights) >= 0.85 ? 18 : 6;
    x += jitter * Math.cos(idx * GOLDEN);
    y += jitter * Math.sin(idx * GOLDEN);
    return {
      code: row.code,
      x,
      y,
      d: 8 + 1.6 * row.units,
      axis: row.weights.indexOf(Math.max(...row.weights)),
      now: !!row.now,
    };
  });

  const unitsPerAxis = [0, 1, 2, 3, 4].map((k) => rows.reduce((s, r) => s + r.units * r.weights[k], 0));
  const totalUnits = rows.reduce((s, r) => s + r.units, 0);
  const maxUnits = Math.max(...unitsPerAxis);
  const shape = unitsPerAxis.map((u) => 0.12 + 0.88 * (u / maxUnits));
  const contours = SCALES.map((scale) => shape.map((r, k) => vertex(k, R * scale * r)));

  const groups = [0, 1, 2, 3, 4].map((axis) => {
    const inGroup = rows.filter((_, i) => dots[i].axis === axis);
    return { axis, units: inGroup.reduce((s, r) => s + r.units, 0), rows: inGroup };
  });

  return { dots, unitsPerAxis, totalUnits, contours, groups };
}

/** Axis-aligned box: x0, y0, x1, y1 in viewBox units. */
export type Box = [number, number, number, number];
export type LabelSpot = { x: number; y: number; anchor: 'start' | 'middle' | 'end' };
type LabelDot = { code: string; x: number; y: number; d: number };

/** Approximate glyph width and cap box for the 10.5 px code labels. */
const CHAR_W = 6.7;
const ASC = 9.5;
const DESC = 2.5;
const PAD = 1;

/** The box a code label covers when drawn at `spot` (baseline y). */
export function labelBox(spot: LabelSpot, code: string): Box {
  const w = code.length * CHAR_W;
  const x0 = spot.anchor === 'start' ? spot.x : spot.anchor === 'end' ? spot.x - w : spot.x - w / 2;
  return [x0, spot.y - ASC, x0 + w, spot.y + DESC];
}

const hits = (a: Box, b: Box) =>
  a[0] < b[2] + PAD && b[0] < a[2] + PAD && a[1] < b[3] + PAD && b[1] < a[3] + PAD;

/**
 * Greedy label placement: each code label takes the first spot (right, left, above, below, then
 * right or left nudged up and down) that clears every dot, every earlier label and the obstacles.
 * A label with no clear spot falls back to the right side.
 */
export function placeLabels(dots: LabelDot[], obstacles: Box[]): LabelSpot[] {
  const dotBoxes: Box[] = dots.map((d) => [d.x - d.d / 2, d.y - d.d / 2, d.x + d.d / 2, d.y + d.d / 2]);
  const placed: Box[] = [];
  return dots.map((d, i) => {
    const r = d.d / 2;
    const candidates: LabelSpot[] = [
      { x: d.x + r + 3, y: d.y + 3.5, anchor: 'start' },
      { x: d.x - r - 3, y: d.y + 3.5, anchor: 'end' },
      { x: d.x, y: d.y - r - DESC - 3, anchor: 'middle' },
      { x: d.x, y: d.y + r + ASC + 3, anchor: 'middle' },
    ];
    for (const dy of [-11, 11, -22, 22, -33, 33]) {
      candidates.push({ x: d.x + r + 3, y: d.y + 3.5 + dy, anchor: 'start' });
      candidates.push({ x: d.x - r - 3, y: d.y + 3.5 + dy, anchor: 'end' });
    }
    const clear = (s: LabelSpot) => {
      const b = labelBox(s, d.code);
      return !placed.some((p) => hits(b, p)) && !obstacles.some((o) => hits(b, o)) &&
        !dotBoxes.some((o, j) => j !== i && hits(b, o));
    };
    const spot = candidates.find(clear) ?? candidates[0];
    placed.push(labelBox(spot, d.code));
    return spot;
  });
}
