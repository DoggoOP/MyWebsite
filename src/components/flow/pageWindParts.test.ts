// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { canStir, dragForce, sailsToPage, viewWindow, readRef, buildMask } from './pageWindParts';
import { paintBands } from './cpuRender';
import { buildLut, FILL_ALPHA, LEVELS } from './colormap';

test('only mouse or pen drags that start off controls stir the air', () => {
  document.body.innerHTML = `
    <p id="text">words <a id="link" href="#"><span id="inner">x</span></a></p>
    <button id="btn">b</button><div data-scan><canvas id="scan"></canvas></div>`;
  const el = (id: string) => document.getElementById(id);
  expect(canStir('mouse', el('text'))).toBe(true);
  expect(canStir('pen', el('text'))).toBe(true);
  expect(canStir('touch', el('text'))).toBe(false);
  expect(canStir('mouse', el('inner'))).toBe(false);
  expect(canStir('mouse', el('btn'))).toBe(false);
  expect(canStir('mouse', el('scan'))).toBe(false);
  expect(canStir('mouse', null)).toBe(true);
});

test('drag force follows airflow scaling and clamps', () => {
  const [fx, fy] = dragForce(9, -18);
  expect(fx).toBeCloseTo(0.012);
  expect(fy).toBeCloseTo(-0.024);
  expect(dragForce(5000, -5000)).toEqual([0.12, -0.12]);
  expect(dragForce(NaN, 0)).toEqual([0, 0]);
});

test('sail points map through a uniformly scaled, centred viewBox', () => {
  const vb = { x: -200, y: -170, w: 360, h: 340 };
  // 720 x 340 box: height limits the scale to 1, so the drawing centres with 180 px each side.
  const rect = { left: 10, top: 20, width: 720, height: 340 };
  const [line] = sailsToPage(rect, 0, 1000, vb, [[[-200, -170], [160, 170]]]);
  expect(line[0][0]).toBeCloseTo(10 + 180);
  expect(line[0][1]).toBeCloseTo(1020);
  expect(line[1][0]).toBeCloseTo(10 + 180 + 360);
  expect(line[1][1]).toBeCloseTo(1020 + 340);
  // Half-size box halves every offset.
  const [half] = sailsToPage({ left: 0, top: 0, width: 180, height: 170 }, 0, 0, vb, [[[-20, 0]]]);
  expect(half[0]).toEqual([90, 85]);
  expect(sailsToPage({ left: 0, top: 0, width: 0, height: 0 }, 0, 0, vb, [[[0, 0]]])).toEqual([]);
});

test('the view window starts at the scrolled row and carries the fractional offset', () => {
  expect(viewWindow(0, 800, 5)).toEqual({ topRow: 0, viewRows: 161, offsetPx: 0 });
  const w = viewWindow(1003, 800, 5);
  expect(w.topRow).toBe(200);
  expect(w.offsetPx).toBeCloseTo(3);
  expect(w.viewRows).toBe(161);
  expect(viewWindow(-40, 800, 5).topRow).toBe(0);
});

test('windref overrides the colour scale only in dev', () => {
  expect(readRef('?windref=0.05', true)).toBe(0.05);
  expect(readRef('?windref=0.05', false)).not.toBe(0.05);
  expect(readRef('?windref=nope', true)).toBe(readRef('', true));
  expect(readRef('?windref=-1', true)).toBe(readRef('', true));
});

test('the mask ORs sails and the scan circle', () => {
  const g = { cell: 5, cols: 40, rows: 40 };
  const mask = buildMask(g, [[[10, 10], [60, 10]]], { cx: 140, cy: 140, r: 20 });
  expect(mask[2 * 40 + 5]).toBe(1); // sail at y = 10 px -> row 2
  expect(mask[28 * 40 + 28]).toBe(1); // circle centre at 140 px -> cell 28
  expect(mask[35 * 40 + 5]).toBe(0);
  expect(buildMask(g, [], null).every((v) => v === 0)).toBe(true);
});

test('paintBands colours visible rows through the LUT and clamps past the last row', () => {
  const cols = 2, rows = 3;
  const vort = new Float32Array([0, 1, 0, -1, 0.5, 0]);
  const lut = buildLut('light');
  const out = new Uint8ClampedArray(cols * 3 * 4);
  paintBands(vort, cols, rows, 1, 3, lut, 0.02, out);
  const px = (i: number) => Array.from(out.slice(4 * i, 4 * i + 4));
  const entry = (band: number) => {
    const [r, g, b, a] = Array.from(lut.slice(4 * (band + LEVELS), 4 * (band + LEVELS) + 4));
    return [r, g, b, a ? Math.round(FILL_ALPHA * 255) : 0];
  };
  expect(px(0)).toEqual(entry(0)); // row 1 col 0: w = 0
  expect(px(1)).toEqual(entry(-LEVELS)); // row 1 col 1: strong negative
  expect(px(2)).toEqual(entry(LEVELS)); // row 2 col 0
  expect(px(4)).toEqual(px(2)); // row 3 clamps to row 2
});

test('buildMask reuses and clears a caller buffer', () => {
  const g = { cell: 5, cols: 40, rows: 40 };
  const buf = new Uint8Array(40 * 40).fill(1);
  const mask = buildMask(g, [], null, buf);
  expect(mask).toBe(buf);
  expect(mask.every((v) => v === 0)).toBe(true);
});
