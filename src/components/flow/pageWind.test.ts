// @vitest-environment jsdom
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { startPageWind, activeLoops, type SolverLike } from './pageWind';

type Fake = SolverLike & { calls: string[]; steps: number; masks: Uint8Array[]; forces: number[][]; renders: number[]; disposed: boolean };

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
    cols, rows, calls: [], steps: 0, masks: [], forces: [], renders: [], disposed: false,
    setMask(m) { s.calls.push('setMask'); s.masks.push(m.slice()); },
    initUniform() { s.calls.push('initUniform'); },
    seedWake() { s.calls.push('seedWake'); },
    addForce(col, row, fx, fy, r) { s.forces.push([col, row, fx, fy, r]); },
    step(n) { s.steps += n; },
    vorticity: () => new Float32Array(cols * rows),
    render(o) { s.renders.push(o.scrollY); },
    dispose() { s.disposed = true; },
  };
  solvers.push(s);
  return s;
}

function setup() {
  document.body.innerHTML = `
    <canvas data-wind></canvas>
    <p id="text">words</p><a id="link" href="#">link</a>
    <button id="pause">Pause air</button>
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
  const stepped = s.steps;
  expect(stepped).toBeGreaterThan(0);
  stop();
  stop();
  flush(3);
  expect(s.steps).toBe(stepped);
  expect(frames.size).toBe(0);
});

test('the start state seeds a uniform field with a mask', () => {
  const stop = startPageWind(setup());
  expect(solvers[0].calls.slice(0, 2)).toEqual(['initUniform', 'setMask']);
  stop();
});

test('Pause swaps the label and toggles the loop, with no aria-pressed', () => {
  const opts = setup();
  const stop = startPageWind(opts);
  const btn = opts.pauseButton;
  btn.click();
  expect(btn.hasAttribute('aria-pressed')).toBe(false);
  expect(btn.textContent).toBe('Play air');
  expect(activeLoops()).toBe(0);
  const before = solvers[0].steps;
  flush(3);
  expect(solvers[0].steps).toBe(before);
  btn.click();
  expect(btn.hasAttribute('aria-pressed')).toBe(false);
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

function placeScan(el: HTMLElement, left: number, top: number, size: number) {
  el.getBoundingClientRect = () => ({ left, top, width: size, height: size, right: left + size, bottom: top + size, x: left, y: top, toJSON() {} });
}

test('the circle inscribed in the scan box is a solid in the start mask, with a seeded wake', () => {
  const opts = setup();
  placeScan(opts.scan.element, 400, 200, 60); // centre (430, 230), radius 30
  const stop = startPageWind(opts);
  const s = solvers[0];
  const mask = s.masks[0];
  expect(mask[46 * s.cols + 86]).toBe(1); // the centre at 5 px cells
  expect(mask[46 * s.cols + 91]).toBe(1); // 27.5 px right of the centre
  expect(mask[40 * s.cols + 80]).toBe(0); // the box corner lies outside the circle
  expect(s.calls.filter((c) => c === 'seedWake').length).toBe(1);
  stop();
});

function pointer(type: string, target: Element, init: { pointerType: string; x: number; y: number; buttons?: number }) {
  const e = new MouseEvent(type, { bubbles: true, clientX: init.x, clientY: init.y, buttons: init.buttons ?? 1 });
  Object.defineProperty(e, 'pointerType', { value: init.pointerType });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  target.dispatchEvent(e);
}

function drag(target: Element, pointerType: string) {
  pointer('pointerdown', target, { pointerType, x: 100, y: 100 });
  pointer('pointermove', target, { pointerType, x: 118, y: 100 });
  pointer('pointerup', target, { pointerType, x: 118, y: 100 });
}

test('a relayout that moves the scan circle masks it where it sits now', () => {
  const opts = setup();
  placeScan(opts.scan.element, 400, 200, 60);
  const stop = startPageWind(opts);
  const s = solvers[0];
  placeScan(opts.scan.element, 400, 400, 60);
  window.dispatchEvent(new Event('resize'));
  flush();
  expect(solvers.length).toBe(1); // same page size: the lattice stays, only the mask changes
  const mask = s.masks.at(-1)!;
  expect(mask[86 * s.cols + 86]).toBe(1); // (430, 430) px, the new spot
  expect(mask[46 * s.cols + 86]).toBe(0); // (430, 230) px, the old spot
  stop();
});

test('a circle wide for the page pads the tunnel, and the mask, drawing and drags all shift with it', () => {
  withGl();
  const opts = setup();
  placeScan(opts.scan.element, 312, 200, 400); // 1024 px page, 400 px circle: a 1200 px tunnel, 88 px pad
  const xs: number[] = [];
  const stop = startPageWind({
    ...opts,
    createSolver: (_b, cols, rows) => {
      const f = fake(cols, rows);
      f.render = (o) => { xs.push(o.scrollX); };
      return f;
    },
  });
  const s = solvers[0];
  expect(s.cols).toBe(240);
  expect(s.masks[0][80 * s.cols + Math.floor((512 + 88) / 5)]).toBe(1); // the circle centre, shifted
  expect(s.masks[0][80 * s.cols + 2]).toBe(0); // the off-screen margin is open air
  flush();
  expect(xs.at(-1)).toBe(88);
  drag(document.getElementById('text')!, 'mouse');
  expect(s.forces[0][0]).toBe(Math.floor((118 + 88) / 5));
  stop();
});

test('an unmeasured scan box adds no circle', () => {
  const stop = startPageWind(setup());
  expect(solvers[0].masks[0].every((v) => v === 0)).toBe(true);
  stop();
});

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

test('a move with no buttons down ends a drag whose release the page missed', () => {
  const stop = startPageWind(setup());
  const s = solvers[0];
  const text = document.getElementById('text')!;
  pointer('pointerdown', text, { pointerType: 'mouse', x: 100, y: 100 });
  pointer('pointermove', text, { pointerType: 'mouse', x: 118, y: 100, buttons: 0 });
  pointer('pointermove', text, { pointerType: 'mouse', x: 136, y: 100 });
  expect(s.forces).toEqual([]);
  stop();
});

test('the air advances by elapsed time, not by frame count', () => {
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const stop = startPageWind(setup());
  const s = solvers[0];
  flush(); // the first frame has no previous one: one 60 fps frame's worth
  expect(s.steps).toBe(6);
  now += 1000 / 120; // a 120 Hz screen steps half as much per frame
  flush();
  expect(s.steps).toBe(9);
  stop();
});

test('reduced motion still runs the air; Pause is the way to stop it', () => {
  media['(prefers-reduced-motion: reduce)'] = true;
  const opts = setup();
  const stop = startPageWind(opts);
  expect(activeLoops()).toBe(1);
  expect(opts.pauseButton.textContent).toBe('Pause air');
  flush(2);
  expect(solvers[0].steps).toBeGreaterThan(0);
  stop();
});

function withGl(state = { lost: false }) {
  const loseContext = vi.fn();
  const gl = {
    getExtension: (name: string) => (name === 'EXT_color_buffer_float' ? {} : name === 'WEBGL_lose_context' ? { loseContext } : null),
    getParameter: () => 4096,
    isContextLost: () => state.lost,
  };
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(
    ((type: string) => (type === 'webgl2' ? gl : null)) as never,
  );
  return { loseContext };
}

test('the GL context asks for a low-power GPU and refuses a software one', () => {
  withGl();
  const stop = startPageWind(setup());
  const attrs = (vi.mocked(HTMLCanvasElement.prototype.getContext).mock.calls[0] as unknown[])[1] as WebGLContextAttributes;
  expect(attrs).toMatchObject({
    failIfMajorPerformanceCaveat: true, powerPreference: 'low-power',
    premultipliedAlpha: false, alpha: true, antialias: false,
  });
  stop();
});

test('stop releases the GL context after disposing the solver', () => {
  const { loseContext } = withGl();
  const stop = startPageWind(setup());
  expect(loseContext).not.toHaveBeenCalled();
  stop();
  expect(solvers[0].disposed).toBe(true);
  expect(loseContext).toHaveBeenCalledTimes(1);
  stop();
  expect(loseContext).toHaveBeenCalledTimes(1);
});

test('on a phone, a scroll during a skipped 30 fps frame redraws without stepping', () => {
  media['(pointer: coarse)'] = true;
  withGl();
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const stop = startPageWind(setup());
  const s = solvers[0];
  flush(); // steps and draws at t = 1000
  expect(s.steps).toBe(6);
  const draws = s.renders.length;
  now += 8; // inside the 30 fps window: the frame skips the step
  flush();
  expect(s.steps).toBe(6);
  expect(s.renders.length).toBe(draws); // no scroll, no redraw
  vi.stubGlobal('scrollY', 240);
  now += 8;
  flush();
  expect(s.steps).toBe(6);
  expect(s.renders.length).toBe(draws + 1);
  expect(s.renders.at(-1)).toBe(240);
  now += 40; // past the window: 56 ms of air since the last step, capped at 16 steps
  flush();
  expect(s.steps).toBe(22);
  stop();
});

test('a GPU solver that throws on a lost context waits for restore instead of using the CPU', () => {
  const state = { lost: true };
  withGl(state);
  const opts = setup();
  const backends: string[] = [];
  let fail = true;
  const stop = startPageWind({
    ...opts,
    createSolver: (b, cols, rows) => {
      backends.push(b);
      if (fail) throw new Error('context lost mid-build');
      return fake(cols, rows);
    },
  });
  expect(backends).toEqual(['f32']);
  expect(opts.canvas.isConnected).toBe(true);
  expect(activeLoops()).toBe(0);
  state.lost = false;
  fail = false;
  opts.canvas.dispatchEvent(new Event('webglcontextrestored'));
  expect(backends).toEqual(['f32', 'f32']);
  expect(solvers.length).toBe(1);
  expect(activeLoops()).toBe(1);
  stop();
});

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
