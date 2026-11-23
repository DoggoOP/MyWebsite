export type Grid = { cell: number; cols: number; rows: number };

const START_CELL = 5;
const STEP = 0.25;
const BUDGET_DESKTOP = 300_000;
const BUDGET_PHONE = 150_000;

/**
 * Pick a lattice for a page: 5 CSS px cells, grown until the cell budget and texture limit fit.
 * `budget` overrides the desktop and phone budgets (the CPU fallback passes a smaller one).
 */
export function gridSize(
  pageW: number, pageH: number, opts: { phone: boolean; maxTexture: number; budget?: number },
): Grid {
  if (!(pageW > 0) || !(pageH > 0) || !Number.isFinite(pageW) || !Number.isFinite(pageH)) {
    return { cell: START_CELL, cols: 1, rows: 1 };
  }
  const budget = opts.budget ?? (opts.phone ? BUDGET_PHONE : BUDGET_DESKTOP);
  const maxTex = Math.max(1, opts.maxTexture);
  let cell = START_CELL;
  for (;;) {
    const cols = Math.max(1, Math.ceil(pageW / cell));
    const rows = Math.max(1, Math.ceil(pageH / cell));
    if ((cols * rows <= budget && rows <= maxTex && cols <= maxTex) || (cols === 1 && rows === 1)) {
      return { cell, cols, rows };
    }
    cell += STEP;
  }
}

/** Map page CSS px to an integer [col, row], clamped to the grid. Row 0 is the page top. */
export function toCell(g: Grid, pageX: number, pageY: number): [number, number] {
  const col = Math.floor(pageX / g.cell);
  const row = Math.floor(pageY / g.cell);
  return [
    Math.min(g.cols - 1, Math.max(0, Number.isFinite(col) ? col : 0)),
    Math.min(g.rows - 1, Math.max(0, Number.isFinite(row) ? row : 0)),
  ];
}
