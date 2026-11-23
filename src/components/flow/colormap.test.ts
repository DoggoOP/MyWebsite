import { test, expect } from 'vitest';
import { bandOf, bandColor, buildLut } from './colormap';

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
