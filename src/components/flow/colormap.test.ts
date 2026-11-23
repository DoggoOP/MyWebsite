import { test, expect } from 'vitest';
import { bandOf, bandColor, buildLut, FILL_ALPHA, LINE_WIDTH_PX } from './colormap';

test('below the first contour is transparent', () => {
  expect(bandOf(0.05, 1)).toBe(0);
  expect(bandColor(0, 'light')[3]).toBe(0);
});
test('band index grows on a log scale and saturates', () => {
  expect(bandOf(0.081, 1)).toBe(1);
  expect(bandOf(-0.081, 1)).toBe(-1);
  expect(bandOf(50, 1)).toBe(8);
});
test('hues follow the Wolfram figure', () => {
  const [r1, g1, b1] = bandColor(1, 'light');
  const [r8, , b8] = bandColor(8, 'light');
  const [rN, , bN] = bandColor(-8, 'light');
  expect(g1).toBeGreaterThan(r1);
  expect(g1).toBeGreaterThan(b1);
  expect(r8).toBeGreaterThan(b8 + 80);
  expect(bN).toBeGreaterThan(rN);
});
test('lut is 17 entries', () => {
  expect(buildLut('dark')).toHaveLength(68);
});
test('a zero or negative reference yields no band', () => {
  expect(bandOf(0, 1)).toBe(0);
  expect(bandOf(1, 0)).toBe(0);
  expect(bandOf(-1, -1)).toBe(0);
});
test('band-edge lines are near opaque and fills stay faint', () => {
  for (let band = 1; band <= 8; band++) expect(bandColor(band, 'dark')[3]).toBeGreaterThanOrEqual(210);
  expect(FILL_ALPHA).toBeGreaterThan(0);
  expect(FILL_ALPHA).toBeLessThanOrEqual(0.12);
  expect(LINE_WIDTH_PX).toBeCloseTo(1.25);
});
