import type { Pt } from '../../lib/sails';
import type { Grid } from './grid';
import { rasterizePolyline, rasterizeScan } from './mask';

/** A drag that starts on one of these never stirs the air. */
export const NO_STIR = 'a, button, input, select, textarea, label, [data-scan]';
/** Default colour scale for vorticity bands, in lattice units. */
export const DEFAULT_REF = 0.02;
/** Sail stroke thickness in cells. */
export const SAIL_CELLS = 2;
/** Radius of a drag's force, in cells. */
export const DRAG_RADIUS = 9;

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/** Mouse and pen drags stir the air; touch never does, nor a drag that starts on a control or the scan. */
export function canStir(pointerType: string, target: EventTarget | null): boolean {
  if (pointerType === 'touch') return false;
  return !(target instanceof Element && target.closest(NO_STIR));
}

/** Lattice velocity increment for one pointer move of (dx, dy) CSS px, scaled as in airflow.ts. */
export function dragForce(dxPx: number, dyPx: number): [number, number] {
  const f = (d: number) => (Number.isFinite(d) ? clamp((d / 9) * 0.012, -0.12, 0.12) : 0);
  return [f(dxPx), f(dyPx)];
}

type Rect = { left: number; top: number; width: number; height: number };
type ViewBox = { x: number; y: number; w: number; h: number };

/**
 * Maps polylines in viewBox units to page CSS px for an svg drawn in `rect` (viewport px) with
 * the default preserveAspectRatio (xMidYMid meet). An empty rect gives no lines.
 */
export function sailsToPage(rect: Rect, scrollX: number, scrollY: number, vb: ViewBox, lines: Pt[][]): Pt[][] {
  if (!(rect.width > 0 && rect.height > 0 && vb.w > 0 && vb.h > 0)) return [];
  const scale = Math.min(rect.width / vb.w, rect.height / vb.h);
  const x0 = rect.left + scrollX + (rect.width - vb.w * scale) / 2;
  const y0 = rect.top + scrollY + (rect.height - vb.h * scale) / 2;
  return lines.map((line) => line.map(([x, y]): Pt => [x0 + (x - vb.x) * scale, y0 + (y - vb.y) * scale]));
}

/** Rows to draw for a scroll position: the first visible row, one extra row, and the sub-cell offset. */
export function viewWindow(scrollY: number, viewportH: number, cell: number) {
  const y = Math.max(0, scrollY);
  const topRow = Math.floor(y / cell);
  return { topRow, viewRows: Math.ceil(viewportH / cell) + 1, offsetPx: y - topRow * cell };
}

/** Colour scale: DEFAULT_REF, or a positive `?windref=<n>` in dev. */
export function readRef(search: string, dev: boolean): number {
  if (!dev) return DEFAULT_REF;
  const v = Number(new URLSearchParams(search).get('windref') ?? NaN);
  return v > 0 && Number.isFinite(v) ? v : DEFAULT_REF;
}

/**
 * Solid mask from sail polylines (page px) and scan points (page-space x,y pairs).
 * Clears and fills `out` when the caller passes a buffer of the right size.
 */
export function buildMask(g: Grid, sails: Pt[][], scan: Float32Array | null, out?: Uint8Array): Uint8Array {
  const n = g.cols * g.rows;
  const mask = out && out.length === n ? out.fill(0) : new Uint8Array(n);
  for (const line of sails) if (line.length) rasterizePolyline(line, g, SAIL_CELLS, mask);
  if (scan && scan.length) rasterizeScan(scan, g, mask);
  return mask;
}
