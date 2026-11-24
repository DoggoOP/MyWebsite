import { test, expect } from 'vitest';
import { rasterizeDisc, rasterizePolyline, solidCentroids } from './mask';

test('a sail polyline becomes a connected solid stroke', () => {
  const g = { cell: 5, cols: 100, rows: 100 }, m = new Uint8Array(10_000);
  rasterizePolyline([[50, 50], [400, 400]], g, 2, m);
  for (let i = 12; i < 78; i++) expect(m[i * 100 + i]).toBe(1);
});

test('a disc fills the cells whose centres lie inside and ORs into out', () => {
  const g = { cell: 5, cols: 20, rows: 20 }, m = new Uint8Array(400);
  m[0] = 1;
  rasterizeDisc({ cx: 50, cy: 50, r: 20 }, g, m);
  expect(m[10 * 20 + 10]).toBe(1); // centre
  expect(m[10 * 20 + 13]).toBe(1); // 17.5 px from centre
  expect(m[10 * 20 + 14]).toBe(0); // 22.5 px from centre
  expect(m[0]).toBe(1);
  const c = solidCentroids(m.fill(0, 0, 1), g);
  expect(c).toHaveLength(1);
  expect(c[0].radius).toBeCloseTo(4, 0);
});

test('a disc past the grid edge is clipped, and r <= 0 marks nothing', () => {
  const g = { cell: 5, cols: 20, rows: 20 }, m = new Uint8Array(400);
  rasterizeDisc({ cx: 0, cy: 0, r: 30 }, g, m);
  expect(m[0]).toBe(1);
  const empty = new Uint8Array(400);
  rasterizeDisc({ cx: 50, cy: 50, r: 0 }, g, empty);
  expect(empty.some((v) => v === 1)).toBe(false);
});

test('solidCentroids finds components and drops tiny ones', () => {
  const g = { cell: 5, cols: 30, rows: 30 }, m = new Uint8Array(900);
  for (let y = 5; y < 11; y++) for (let x = 5; x < 11; x++) m[y * 30 + x] = 1;
  m[25 * 30 + 25] = 1;
  const c = solidCentroids(m, g);
  expect(c).toHaveLength(1);
  expect(c[0].col).toBeCloseTo(7.5, 1);
  expect(c[0].row).toBeCloseTo(7.5, 1);
  expect(c[0].radius).toBeCloseTo(Math.sqrt(36 / Math.PI), 3);
});
