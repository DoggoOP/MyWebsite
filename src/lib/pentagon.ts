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
