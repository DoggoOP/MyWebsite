import { test, expect } from 'vitest';
import { gridSize, toCell } from './grid';

test('desktop page uses 5 px cells inside the budget', () => {
  const g = gridSize(1440, 4600, { phone: false, maxTexture: 16384 });
  expect(g.cell).toBeGreaterThanOrEqual(5);
  expect(g.cols * g.rows).toBeLessThanOrEqual(300_000);
});

test('a very tall phone page grows the cell to fit the texture limit', () => {
  const g = gridSize(390, 30_000, { phone: true, maxTexture: 4096 });
  expect(g.rows).toBeLessThanOrEqual(4096);
  expect(g.cols * g.rows).toBeLessThanOrEqual(150_000);
});

test('mapping follows a new page height', () => {
  const a = gridSize(1440, 4600, { phone: false, maxTexture: 16384 });
  const b = gridSize(1440, 5200, { phone: false, maxTexture: 16384 });
  expect(toCell(b, 700, 5000)[1]).toBeLessThan(b.rows);
  expect(toCell(a, 700, 4500)[1]).toBeLessThan(a.rows);
});

test('toCell clamps to the grid', () => {
  const g = { cell: 5, cols: 10, rows: 20 };
  expect(toCell(g, -50, -50)).toEqual([0, 0]);
  expect(toCell(g, 9999, 9999)).toEqual([9, 19]);
  expect(toCell(g, 12, 27)).toEqual([2, 5]);
});

test('bad sizes give a 1x1 grid', () => {
  for (const [w, h] of [[0, 100], [-5, 100], [NaN, 100], [100, NaN]]) {
    const g = gridSize(w, h, { phone: false, maxTexture: 4096 });
    expect(g.cols).toBeGreaterThanOrEqual(1);
    expect(g.rows).toBeGreaterThanOrEqual(1);
  }
});

test('a budget override caps the cells for the CPU fallback', () => {
  const g = gridSize(1440, 4600, { phone: false, maxTexture: 16384, budget: 40_000 });
  expect(g.cols * g.rows).toBeLessThanOrEqual(40_000);
  expect(g.cell).toBeGreaterThan(5);
  expect(g.cols * g.cell).toBeGreaterThanOrEqual(1440);
  expect(g.rows * g.cell).toBeGreaterThanOrEqual(4600);
});
