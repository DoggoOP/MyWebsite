import { bandOf, FILL_ALPHA, LEVELS } from './colormap';

const FILL_A = Math.round(FILL_ALPHA * 255);

/**
 * Writes RGBA for rows topRow..topRow+viewRows-1 of a cols-wide vorticity field into `out`,
 * one pixel per cell, as a faint fill in the band's `lut` colour (index band + LEVELS) with no
 * band-edge lines. Rows past the grid repeat the last row.
 */
export function paintBands(
  vort: Float32Array, cols: number, rows: number, topRow: number, viewRows: number,
  lut: Uint8Array, ref: number, out: Uint8ClampedArray,
): void {
  for (let r = 0; r < viewRows; r++) {
    const src = Math.min(rows - 1, Math.max(0, topRow + r)) * cols;
    const dst = r * cols * 4;
    for (let c = 0; c < cols; c++) {
      const k = (bandOf(vort[src + c], ref) + LEVELS) * 4, o = dst + c * 4;
      out[o] = lut[k]; out[o + 1] = lut[k + 1]; out[o + 2] = lut[k + 2]; out[o + 3] = lut[k + 3] ? FILL_A : 0;
    }
  }
}

/**
 * Canvas2D painter for the CPU fallback. The canvas backing store holds one pixel per cell;
 * CSS scales the canvas up to the viewport with smoothing. Returns null without a 2D context.
 */
export function createCpuPainter(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  let img: ImageData | null = null;
  return {
    draw(vort: Float32Array, cols: number, rows: number, topRow: number, viewRows: number, lut: Uint8Array, ref: number) {
      if (!img || img.width !== cols || img.height !== viewRows) img = ctx.createImageData(cols, viewRows);
      paintBands(vort, cols, rows, topRow, viewRows, lut, ref, img.data);
      ctx.putImageData(img, 0, 0);
    },
  };
}
