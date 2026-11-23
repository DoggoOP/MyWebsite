import { test, expect } from 'vitest';
import { rasterizePolyline, rasterizeScan, solidCentroids } from './mask';

test('a sail polyline becomes a connected solid stroke', () => {
  const g = { cell: 5, cols: 100, rows: 100 }, m = new Uint8Array(10_000);
  rasterizePolyline([[50, 50], [400, 400]], g, 2, m);
  for (let i = 12; i < 78; i++) expect(m[i * 100 + i]).toBe(1);
});

test('a single stray scan point does not become solid', () => {
  const g = { cell: 5, cols: 20, rows: 20 }, m = new Uint8Array(400);
  rasterizeScan(new Float32Array([52, 52]), g, m);
  expect(m.some(x => x === 1)).toBe(false);
});

test('a dense blob of scan points becomes solid and ORs into out', () => {
  const g = { cell: 5, cols: 20, rows: 20 }, m = new Uint8Array(400);
  m[0] = 1;
  const pts: number[] = [];
  for (let y = 30; y < 70; y += 2) for (let x = 30; x < 70; x += 2) pts.push(x, y);
  rasterizeScan(new Float32Array(pts), g, m);
  expect(m[10 * 20 + 10]).toBe(1);
  expect(m[0]).toBe(1);
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
