import { expect, test } from 'vitest';
import { CLASSES } from '../data/classes';
import { layoutClasses } from './pentagon';

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
