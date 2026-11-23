import { expect, test } from 'vitest';
import { CLASSES } from '../data/classes';
import { layoutClasses, placeLabels, labelBox, type Box } from './pentagon';

const L = layoutClasses(CLASSES, 200, 300, 290);

test('totals match the transcript', () => {
  expect(L.totalUnits).toBe(73);
  [18.5, 13.45, 13.55, 14.95, 12.55].forEach((u, k) => expect(L.unitsPerAxis[k]).toBeCloseTo(u, 2));
});

test('a single-axis class sits within jitter of 0.86 R on its axis', () => {
  const m51 = L.dots.find((d) => d.code === 'MATH 51')!;
  expect(Math.hypot(m51.x - 300, m51.y - (290 - 0.86 * 200))).toBeLessThanOrEqual(18.01);
});

test('dot size and quarter flag', () => {
  const cs103 = L.dots.find((d) => d.code === 'CS 103')!;
  expect(cs103.d).toBeCloseTo(16);
  expect(cs103.now).toBe(true);
});

test('five contours, innermost first, groups by dominant axis', () => {
  expect(L.contours).toHaveLength(5);
  expect(L.contours[0]).toHaveLength(5);
  expect(L.groups.find((g) => g.axis === 4)!.rows.map((r) => r.code)).toEqual([
    'COLLEGE 101', 'PWR 1HK', 'COLLEGE 102', 'BUSGEN 112',
  ]);
});

const overlaps = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

test('a lone dot keeps its label on the right', () => {
  const [spot] = placeLabels([{ code: 'AA 100', x: 100, y: 100, d: 10 }], []);
  expect(spot).toEqual({ x: 108, y: 103.5, anchor: 'start' });
});

test('crowded labels never overlap each other or another dot', () => {
  const dots = L.dots;
  const spots = placeLabels(dots, []);
  const boxes = spots.map((s, i) => labelBox(s, dots[i].code));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j]), `${dots[i].code} / ${dots[j].code}`).toBe(false);
    dots.forEach((d, j) => {
      if (j === i) return;
      const r = d.d / 2;
      expect(overlaps(boxes[i], [d.x - r, d.y - r, d.x + r, d.y + r]), `${dots[i].code} on dot ${d.code}`).toBe(false);
    });
  }
});

test('labels stay clear of obstacles such as axis labels', () => {
  const block: Box = [105, 90, 200, 110];
  const [spot] = placeLabels([{ code: 'AA 100', x: 100, y: 100, d: 10 }], [block]);
  expect(overlaps(labelBox(spot, 'AA 100'), block)).toBe(false);
});
