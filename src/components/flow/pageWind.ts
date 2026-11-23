import { SAIL_VIEWBOX, sailPolylines, type Pt } from '../../lib/sails';
import { pickBackend, type Backend } from './backend';
import { buildLut } from './colormap';
import { createCpuPainter } from './cpuRender';
import { GpuLbm, type RenderOpts } from './gpuLbm';
import { gridSize, toCell, type Grid } from './grid';
import { CpuLbm } from './lbmCpu';
import { solidCentroids } from './mask';
import {
  DRAG_RADIUS, buildMask, canStir, dragForce, readRef, sailsToPage, viewWindow,
} from './pageWindParts';

/** The solver surface the orchestrator drives; CpuLbm and GpuLbm both fit. */
export type SolverLike = {
  readonly cols: number;
  readonly rows: number;
  setMask(mask: Uint8Array): void;
  initUniform(): void;
  seedWake(col: number, row: number, radiusCells: number): void;
  addForce(col: number, row: number, fx: number, fy: number, radiusCells: number): void;
  step(n: number): void;
  vorticity?(): Float32Array;
  render?(opts: RenderOpts): void;
  dispose?(): void;
};

export type PageWindOptions = {
  canvas: HTMLCanvasElement;
  root: HTMLElement;
  sailsSvg: SVGSVGElement | null;
  pauseButton: HTMLButtonElement | null;
  /**
   * The scan wrapper, or a static host around a scan that mounts later. The viewer dispatches a
   * non-bubbling `scan-silhouette` (detail: page-space x,y pairs) on its `[data-scan]` wrapper; a
   * capture listener on the host hears that too.
   */
  scan: { element: HTMLElement } | null;
  /** Tests only: replaces CpuLbm / GpuLbm construction. */
  createSolver?: (backend: Backend, cols: number, rows: number) => SolverLike;
};

type DevHandle = { activeLoops: () => number; readonly backend: Backend; readonly grid: Grid };
declare global { interface Window { __wind?: DevHandle } }

const SUBSTEPS = 6;
const PHONE_FRAME_MS = 1000 / 30 - 3; // vsync jitter tolerance
const FROZEN_STEPS = 200;
const CPU_BUDGET = 40_000;
const CPU_MAX_TEXTURE = 1 << 15;
const STAT_FRAMES = 120;
/** The GPU draws contour lines at viewport resolution, capped at this many device px per CSS px. */
const MAX_PIXEL_RATIO = 1.5;
/** A software-rendered or blocklisted GPU fails the caveat check and falls back to the CPU solver. */
const GL_ATTRS: WebGLContextAttributes = {
  premultipliedAlpha: false, alpha: true, antialias: false, depth: false, stencil: false,
  failIfMajorPerformanceCaveat: true, powerPreference: 'low-power',
};

const running = new Set<object>();

/** Page winds whose frame loop is scheduled right now (a test and dev hook). */
export function activeLoops(): number {
  return running.size;
}

/**
 * Runs the page-wide wind tunnel behind the content: a lattice sized to the whole page, solids
 * from the sails and the scan silhouette, banded vorticity drawn for the rows in view on a fixed
 * canvas. Returns the cleanup, which is idempotent.
 */
export function startPageWind(opts: PageWindOptions): () => void {
  const { root, sailsSvg, pauseButton, scan } = opts;
  const original = opts.canvas;
  let canvas = original;
  const dev = import.meta.env.DEV;
  const ref = readRef(location.search, dev);
  const stats = new URLSearchParams(location.search).has('windstats');
  const media = (q: string) => (typeof matchMedia === 'function' ? matchMedia(q) : null);
  const darkMq = media('(prefers-color-scheme: dark)');
  const coarseMq = media('(pointer: coarse)');
  const reduced = !!media('(prefers-reduced-motion: reduce)')?.matches;
  const phone = () => !!coarseMq?.matches || innerWidth < 768;
  const themeLut = () => buildLut(darkMq?.matches ? 'dark' : 'light');
  let lut = themeLut();

  const token = {};
  let gl = canvas.getContext('webgl2', GL_ATTRS) as WebGL2RenderingContext | null;
  let backend: Backend = pickBackend(gl);
  let solver: SolverLike | null = null;
  let painter: ReturnType<typeof createCpuPainter> = null;
  let grid: Grid = { cell: 5, cols: 1, rows: 1 };
  let sailLines: Pt[][] = [];
  let sailsKey = '';
  let scanPts: Float32Array | null = null;
  let scanSeeded = false;
  let maskBuf: Uint8Array = new Uint8Array(0);
  let paused = reduced;
  let stopped = false;
  let lost = false;
  let raf = 0, layoutRaf = 0, drawRaf = 0;
  let lastFrame = -Infinity;
  let drawnX = NaN, drawnY = NaN;
  let drag: { id: number; x: number; y: number } | null = null;
  let statFrames = 0, statMs = 0;
  let styleKey = '';

  const create = opts.createSolver ?? ((b: Backend, cols: number, rows: number): SolverLike =>
    b === 'cpu' ? new CpuLbm(cols, rows) : new GpuLbm(gl!, cols, rows, b));

  function sizeGrid(): Grid {
    const w = root.scrollWidth || innerWidth, h = root.scrollHeight || innerHeight;
    if (backend === 'cpu') return gridSize(w, h, { phone: phone(), maxTexture: CPU_MAX_TEXTURE, budget: CPU_BUDGET });
    return gridSize(w, h, { phone: phone(), maxTexture: gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) : CPU_MAX_TEXTURE });
  }

  function measureSails() {
    if (!sailsSvg) return;
    const { main, jib } = sailPolylines();
    sailLines = sailsToPage(sailsSvg.getBoundingClientRect(), scrollX, scrollY, SAIL_VIEWBOX, [main, jib]);
    sailsKey = sailLines.map((l) => (l.length ? `${l[0]},${l[l.length - 1]}` : '')).join('|');
  }

  /** Sails + scan for the current grid, in a buffer reused between rebuilds. */
  function mask() {
    maskBuf = buildMask(grid, sailLines, scanPts, maskBuf);
    return maskBuf;
  }

  /** Swap a webgl canvas for a fresh clone, since a canvas holds only one context type. */
  function useCpu() {
    backend = 'cpu';
    if (!gl) return;
    gl = null;
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    const fresh = canvas.cloneNode(false) as HTMLCanvasElement;
    canvas.replaceWith(fresh);
    canvas = fresh;
    styleKey = '';
  }

  /** Fresh solver at the current page size, in the start state. Falls back GPU -> CPU -> none. */
  function build() {
    solver?.dispose?.();
    solver = null;
    grid = sizeGrid();
    try {
      solver = create(backend, grid.cols, grid.rows);
    } catch (err) {
      if (backend === 'cpu') { console.warn('[wind] no solver', err); return; }
      if (gl?.isContextLost()) {
        // A lost context, not a missing feature: webglcontextrestored rebuilds on the GPU.
        console.warn('[wind] GL context lost while building, waiting for restore', err);
        lost = true;
        return;
      }
      console.warn('[wind] GPU solver failed, using the CPU', err);
      useCpu();
      grid = sizeGrid();
      try { solver = create('cpu', grid.cols, grid.rows); } catch (e) { console.warn('[wind] no solver', e); return; }
    }
    if (backend === 'cpu' && !painter) painter = createCpuPainter(canvas);
    solver.initUniform();
    const solids = mask();
    solver.setMask(solids);
    for (const c of solidCentroids(solids, grid)) solver.seedWake(c.col, c.row, Math.max(2, c.radius));
    scanSeeded = !!scanPts;
    if (paused) solver.step(FROZEN_STEPS); // a frozen field still shows the start wakes
  }

  function draw() {
    if (!solver || lost) return;
    drawnX = scrollX;
    drawnY = scrollY;
    if (backend === 'cpu') {
      // Lattice-resolution fills, scaled up by CSS and shifted by the sub-cell scroll remainder.
      const { topRow, viewRows, offsetPx } = viewWindow(scrollY, innerHeight, grid.cell);
      if (canvas.width !== grid.cols || canvas.height !== viewRows) {
        canvas.width = grid.cols;
        canvas.height = viewRows;
      }
      const key = `cpu|${grid.cols * grid.cell}|${viewRows * grid.cell}|${scrollX}|${offsetPx}`;
      if (key !== styleKey) {
        styleKey = key;
        const s = canvas.style;
        s.width = `${grid.cols * grid.cell}px`;
        s.height = `${viewRows * grid.cell}px`;
        s.transformOrigin = '0 0';
        s.transform = `translate(${-scrollX}px, ${-offsetPx}px)`;
      }
      if (painter && solver.vorticity) painter.draw(solver.vorticity(), grid.cols, grid.rows, topRow, viewRows, lut, ref);
      return;
    }
    // GPU: a viewport-sized canvas; the shader maps each pixel to page space, scroll included.
    const viewW = document.documentElement.clientWidth || innerWidth, viewH = innerHeight;
    const ratio = Math.min(devicePixelRatio || 1, MAX_PIXEL_RATIO);
    const bw = Math.max(1, Math.round(viewW * ratio)), bh = Math.max(1, Math.round(viewH * ratio));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const key = `gpu|${viewW}|${viewH}`;
    if (key !== styleKey) {
      styleKey = key;
      const s = canvas.style;
      s.width = `${viewW}px`;
      s.height = `${viewH}px`;
      s.transform = '';
    }
    solver.render?.({ scrollX, scrollY, viewW, viewH, cell: grid.cell, pixelRatio: bw / viewW, lut, ref });
  }

  const canRun = () => !stopped && !paused && !lost && !!solver && document.visibilityState !== 'hidden';

  function frame(now: number) {
    raf = 0;
    if (!canRun()) { syncLoop(); return; }
    raf = requestAnimationFrame(frame);
    if (phone() && now - lastFrame < PHONE_FRAME_MS) {
      // The sim steps at 30 fps, but the fixed canvas follows the page scroll every frame.
      if (scrollX !== drawnX || scrollY !== drawnY) draw();
      return;
    }
    lastFrame = now;
    const t0 = performance.now();
    solver!.step(SUBSTEPS);
    draw();
    if (stats && statFrames < STAT_FRAMES) {
      statMs += performance.now() - t0;
      if (++statFrames === STAT_FRAMES) {
        console.log(`[wind] ${backend} ${grid.cols}x${grid.rows}: ${(statMs / STAT_FRAMES).toFixed(2)} ms main thread per frame over ${STAT_FRAMES} frames`);
      }
    }
  }

  /** Starts or stops the frame loop to match canRun(). */
  function syncLoop() {
    if (canRun()) {
      if (!raf) raf = requestAnimationFrame(frame);
      running.add(token);
    } else {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      running.delete(token);
    }
  }

  /** One draw on the next frame, for scroll and theme changes while the loop is off. */
  function scheduleDraw() {
    if (stopped || raf || drawRaf) return;
    drawRaf = requestAnimationFrame(() => {
      drawRaf = 0;
      if (!stopped && document.visibilityState !== 'hidden') draw();
    });
  }

  /** The viewer answers with a fresh `scan-silhouette`; layout shifts move the circle without a camera change. */
  function requestScan() {
    if (!scan) return;
    const target = scan.element.querySelector('[data-scan]') ?? scan.element;
    target.dispatchEvent(new CustomEvent('scan-silhouette-request'));
  }

  function relayout() {
    const g = sizeGrid();
    const oldKey = sailsKey;
    measureSails();
    // Ask first, so a rebuild masks and seeds the scan where the circle sits now, not where the
    // circle sat before the layout moved.
    requestScan();
    if (!solver || g.cols !== grid.cols || g.rows !== grid.rows || g.cell !== grid.cell) {
      if (!lost) build();
      syncLoop();
    } else if (sailsKey !== oldKey) {
      solver.setMask(mask());
    }
    scheduleDraw();
  }

  function scheduleLayout() {
    if (stopped || layoutRaf) return;
    layoutRaf = requestAnimationFrame(() => { layoutRaf = 0; if (!stopped) relayout(); });
  }

  function updateButton() {
    if (!pauseButton) return;
    pauseButton.toggleAttribute('data-paused', paused);
    pauseButton.textContent = paused ? 'Play air' : 'Pause air';
  }

  // Event handlers. Every one is removed in cleanup().
  function onPause() { paused = !paused; updateButton(); syncLoop(); scheduleDraw(); }
  function onVisibility() { syncLoop(); scheduleDraw(); }
  function onTheme() { lut = themeLut(); scheduleDraw(); }
  function onScroll() { scheduleDraw(); }

  function onScan(e: Event) {
    const pts = (e as CustomEvent).detail;
    if (!(pts instanceof Float32Array)) return;
    scanPts = pts;
    if (!solver || lost) return;
    solver.setMask(mask());
    if (!scanSeeded) {
      scanSeeded = true;
      for (const c of solidCentroids(buildMask(grid, [], scanPts), grid)) solver.seedWake(c.col, c.row, Math.max(2, c.radius));
      if (paused) solver.step(FROZEN_STEPS); // the frozen field shows the scan wake too
    }
    scheduleDraw();
  }

  function onPointerDown(e: PointerEvent) {
    if (!canStir(e.pointerType, e.target) || (e.pointerType === 'mouse' && e.button !== 0)) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }

  function onPointerMove(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    if (e.buttons === 0) { drag = null; return; } // the release landed outside the window
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!canRun() || (dx === 0 && dy === 0)) return;
    const [fx, fy] = dragForce(dx, dy);
    const [col, row] = toCell(grid, e.clientX + scrollX, e.clientY + scrollY);
    solver!.addForce(col, row, fx, fy, DRAG_RADIUS);
  }

  function onPointerEnd(e: PointerEvent) {
    if (drag && e.pointerId === drag.id) drag = null;
  }

  function onLost(e: Event) {
    e.preventDefault();
    lost = true;
    solver?.dispose?.();
    solver = null;
    syncLoop();
  }

  function onRestored() {
    lost = false;
    build();
    syncLoop();
    scheduleDraw();
  }

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleLayout) : null;
  const listeners: [EventTarget, string, EventListener, AddEventListenerOptions?][] = [
    [window, 'resize', scheduleLayout],
    [window, 'scroll', onScroll, { passive: true }],
    [window, 'pointerdown', onPointerDown as EventListener],
    [window, 'pointermove', onPointerMove as EventListener, { passive: true }],
    [window, 'pointerup', onPointerEnd as EventListener],
    [window, 'pointercancel', onPointerEnd as EventListener],
    [document, 'visibilitychange', onVisibility],
    [document, 'astro:before-swap', cleanup],
  ];
  if (pauseButton) listeners.push([pauseButton, 'click', onPause]);
  if (scan) listeners.push([scan.element, 'scan-silhouette', onScan, { capture: true }]);
  if (darkMq) listeners.push([darkMq, 'change', onTheme]);
  for (const [t, type, fn, o] of listeners) t.addEventListener(type, fn, o);
  requestScan(); // the viewer may have sent the model-ready silhouette before this listener existed
  if (backend === 'cpu') useCpu(); // a webgl2 canvas without float targets can't also paint 2D
  if (gl) {
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
  }

  const devHandle: DevHandle = {
    activeLoops, get backend() { return backend; }, get grid() { return grid; },
  };
  if (dev) window.__wind = devHandle;

  measureSails();
  build();
  updateButton();
  ro?.observe(root);
  if (paused) draw();
  syncLoop();

  function cleanup() {
    if (stopped) return;
    stopped = true;
    syncLoop();
    if (layoutRaf) cancelAnimationFrame(layoutRaf);
    if (drawRaf) cancelAnimationFrame(drawRaf);
    layoutRaf = drawRaf = 0;
    ro?.disconnect();
    for (const [t, type, fn, o] of listeners) t.removeEventListener(type, fn, o);
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    solver?.dispose?.();
    solver = null;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    gl = null;
    painter = null;
    drag = null;
    if (canvas !== original) canvas.replaceWith(original);
    if (window.__wind === devHandle) delete window.__wind;
  }
  return cleanup;
}
