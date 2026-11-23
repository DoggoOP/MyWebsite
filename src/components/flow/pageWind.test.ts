// @vitest-environment jsdom
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { startPageWind, activeLoops, type SolverLike } from './pageWind';

type Fake = SolverLike & { calls: string[]; steps: number; masks: Uint8Array[]; forces: number[][]; disposed: boolean };

let frames = new Map<number, FrameRequestCallback>();
let nextId = 1;
let solvers: Fake[] = [];
let media: Record<string, boolean> = {};

function flush(n = 1) {
  for (let i = 0; i < n; i++) {
    const due = [...frames.entries()];
    frames = new Map();
    for (const [, cb] of due) cb(performance.now() + i * 20);
  }
}

function fake(cols: number, rows: number): Fake {
  const s: Fake = {
    cols, rows, calls: [], steps: 0, masks: [], forces: [], disposed: false,
    setMask(m) { s.calls.push('setMask'); s.masks.push(m.slice()); },
    initUniform() { s.calls.push('initUniform'); },
    seedWake() { s.calls.push('seedWake'); },
    addForce(col, row, fx, fy, r) { s.forces.push([col, row, fx, fy, r]); },
    step(n) { s.steps += n; },
    vorticity: () => new Float32Array(cols * rows),
    dispose() { s.disposed = true; },
  };
  solvers.push(s);
  return s;
}

function setup() {
  document.body.innerHTML = `
    <canvas data-wind></canvas>
    <p id="text">words</p><a id="link" href="#">link</a>
    <button id="pause" aria-pressed="false">Pause air</button>
    <div data-scan id="scan"></div>`;
  const q = <T extends Element>(s: string) => document.querySelector(s) as T;
  return {
    canvas: q<HTMLCanvasElement>('canvas'),
    root: document.documentElement,
    sailsSvg: null,
    pauseButton: q<HTMLButtonElement>('#pause'),
    scan: { element: q<HTMLElement>('#scan') },
    createSolver: (_b: string, cols: number, rows: number) => fake(cols, rows),
  };
}

beforeEach(() => {
  frames = new Map();
  solvers = [];
  media = {};
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(nextId, cb); return nextId++; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: !!media[q], media: q, addEventListener() {}, removeEventListener() {},
  }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('stop then start leaves exactly one loop, and the final stop leaves none', () => {
  const opts = setup();
  const stop1 = startPageWind(opts);
  expect(activeLoops()).toBe(1);
  stop1();
  expect(activeLoops()).toBe(0);
  const stop2 = startPageWind(opts);
  expect(activeLoops()).toBe(1);
  stop2();
  expect(activeLoops()).toBe(0);
  expect(solvers.every((s) => s.disposed)).toBe(true);
});

test('a stopped wind never steps again', () => {
  const stop = startPageWind(setup());
  flush(3);
  const s = solvers[0];
  expect(s.steps).toBe(18);
  stop();
  stop();
  flush(3);
  expect(s.steps).toBe(18);
  expect(frames.size).toBe(0);
});

test('the start state seeds a uniform field with a mask', () => {
  const stop = startPageWind(setup());
  expect(solvers[0].calls.slice(0, 2)).toEqual(['initUniform', 'setMask']);
  stop();
});

test('Pause toggles the label, aria-pressed and the loop', () => {
  const opts = setup();
  const stop = startPageWind(opts);
  const btn = opts.pauseButton;
  btn.click();
  expect(btn.getAttribute('aria-pressed')).toBe('true');
  expect(btn.textContent).toBe('Play air');
  expect(activeLoops()).toBe(0);
  const before = solvers[0].steps;
  flush(3);
  expect(solvers[0].steps).toBe(before);
  btn.click();
  expect(btn.getAttribute('aria-pressed')).toBe('false');
  expect(btn.textContent).toBe('Pause air');
  expect(activeLoops()).toBe(1);
  stop();
  btn.click();
  expect(activeLoops()).toBe(0);
});

test('a hidden page stops the loop and a visible one resumes', () => {
  const stop = startPageWind(setup());
  const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  expect(activeLoops()).toBe(0);
  hidden.mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange'));
  expect(activeLoops()).toBe(1);
  stop();
  document.dispatchEvent(new Event('visibilitychange'));
  expect(activeLoops()).toBe(0);
});

test('astro:before-swap stops everything', () => {
  startPageWind(setup());
  document.dispatchEvent(new Event('astro:before-swap'));
  expect(activeLoops()).toBe(0);
  expect(solvers[0].disposed).toBe(true);
});

test('a scan silhouette merges into the mask', () => {
  const opts = setup();
  const stop = startPageWind(opts);
  const s = solvers[0];
  const pts: number[] = [];
  for (let y = 200; y < 260; y++) for (let x = 400; x < 460; x++) pts.push(x, y);
  opts.scan.element.dispatchEvent(new CustomEvent('scan-silhouette', { detail: new Float32Array(pts) }));
  const mask = s.masks.at(-1)!;
  expect(mask[46 * s.cols + 86]).toBe(1); // (430, 230) px at 5 px cells
  expect(s.calls.filter((c) => c === 'seedWake').length).toBeGreaterThan(0);
  stop();
  const count = s.masks.length;
  opts.scan.element.dispatchEvent(new CustomEvent('scan-silhouette', { detail: new Float32Array(pts) }));
  expect(s.masks.length).toBe(count);
});

function pointer(type: string, target: Element, init: { pointerType: string; x: number; y: number }) {
  const e = new MouseEvent(type, { bubbles: true, clientX: init.x, clientY: init.y, buttons: 1 });
  Object.defineProperty(e, 'pointerType', { value: init.pointerType });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  target.dispatchEvent(e);
}

function drag(target: Element, pointerType: string) {
  pointer('pointerdown', target, { pointerType, x: 100, y: 100 });
  pointer('pointermove', target, { pointerType, x: 118, y: 100 });
  pointer('pointerup', target, { pointerType, x: 118, y: 100 });
}

test('mouse drags on text stir the air; touch and drags from links do not', () => {
  const stop = startPageWind(setup());
  const s = solvers[0];
  drag(document.getElementById('text')!, 'touch');
  drag(document.getElementById('link')!, 'mouse');
  expect(s.forces).toEqual([]);
  drag(document.getElementById('text')!, 'mouse');
  expect(s.forces.length).toBe(1);
  const [col, row, fx, fy, r] = s.forces[0];
  expect([col, row]).toEqual([23, 20]);
  expect(fx).toBeCloseTo(0.024);
  expect(fy).toBe(0);
  expect(r).toBeGreaterThan(0);
  stop();
  drag(document.getElementById('text')!, 'mouse');
  expect(s.forces.length).toBe(1);
});

test('reduced motion runs 200 steps, draws once and waits on Play', () => {
  media['(prefers-reduced-motion: reduce)'] = true;
  const opts = setup();
  const stop = startPageWind(opts);
  expect(solvers[0].steps).toBe(200);
  expect(activeLoops()).toBe(0);
  expect(opts.pauseButton.textContent).toBe('Play air');
  flush(2);
  expect(solvers[0].steps).toBe(200);
  stop();
});

function withGl() {
  const gl = { getExtension: (name: string) => (name === 'EXT_color_buffer_float' ? {} : null), getParameter: () => 4096 };
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(
    ((type: string) => (type === 'webgl2' ? gl : null)) as never,
  );
}

test('a GPU solver that throws falls back to the CPU on a fresh canvas, restored on stop', () => {
  withGl();
  const opts = setup();
  const backends: string[] = [];
  const stop = startPageWind({
    ...opts,
    createSolver: (b, cols, rows) => {
      backends.push(b);
      if (b !== 'cpu') throw new Error('no float targets after all');
      return fake(cols, rows);
    },
  });
  expect(backends).toEqual(['f32', 'cpu']);
  expect(opts.canvas.isConnected).toBe(false);
  expect(document.querySelector('canvas[data-wind]')).not.toBeNull();
  expect(activeLoops()).toBe(1);
  stop();
  expect(opts.canvas.isConnected).toBe(true);
  expect(document.querySelectorAll('canvas').length).toBe(1);
});

test('a lost context stops the loop; a restored one rebuilds from the start state', () => {
  withGl();
  const opts = setup();
  const stop = startPageWind(opts);
  const lost = new Event('webglcontextlost', { cancelable: true });
  opts.canvas.dispatchEvent(lost);
  expect(lost.defaultPrevented).toBe(true);
  expect(activeLoops()).toBe(0);
  expect(solvers[0].disposed).toBe(true);
  opts.canvas.dispatchEvent(new Event('webglcontextrestored'));
  expect(solvers.length).toBe(2);
  expect(solvers[1].calls[0]).toBe('initUniform');
  expect(activeLoops()).toBe(1);
  stop();
  opts.canvas.dispatchEvent(new Event('webglcontextrestored'));
  expect(solvers.length).toBe(2);
  expect(activeLoops()).toBe(0);
});

test('under reduced motion the first scan silhouette steps the frozen field once', () => {
  media['(prefers-reduced-motion: reduce)'] = true;
  const opts = setup();
  const stop = startPageWind(opts);
  const pts: number[] = [];
  for (let y = 200; y < 260; y++) for (let x = 400; x < 460; x++) pts.push(x, y);
  const send = () => opts.scan.element.dispatchEvent(new CustomEvent('scan-silhouette', { detail: new Float32Array(pts) }));
  send();
  expect(solvers[0].steps).toBe(400);
  send();
  expect(solvers[0].steps).toBe(400);
  stop();
});

test('webgl2 without float targets paints with Canvas2D on a fresh canvas', () => {
  const gl = { getExtension: () => null, getParameter: () => 4096 };
  const asked: [string, boolean][] = [];
  const opts = setup();
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(function (this: HTMLCanvasElement, type: string) {
    asked.push([type, this === opts.canvas]);
    return (type === 'webgl2' ? gl : null) as never;
  } as never);
  const backends: string[] = [];
  const stop = startPageWind({ ...opts, createSolver: (b, c, r) => { backends.push(b); return fake(c, r); } });
  expect(backends).toEqual(['cpu']);
  expect(asked).toEqual([['webgl2', true], ['2d', false]]);
  stop();
  expect(opts.canvas.isConnected).toBe(true);
});
