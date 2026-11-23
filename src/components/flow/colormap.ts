export const LEVELS = 8;

export type Theme = 'light' | 'dark';

/** Fill opacity inside a band (|band| >= 1); the band-edge lines carry the LUT colour at its own alpha. */
export const FILL_ALPHA = 0.1;
/** Band-edge line width in CSS px. */
export const LINE_WIDTH_PX = 1.25;
export type Rgba = [number, number, number, number];

/** Signed band index in -LEVELS..LEVELS; 0 sits below the first threshold. */
export function bandOf(w: number, ref: number): number {
  if (!(ref > 0) || w === 0) return 0;
  const a = Math.abs(w);
  let band = 0;
  for (let k = 0; k < LEVELS; k++) {
    if (a >= ref * 0.08 * Math.pow(1.45, k)) band = k + 1;
    else break;
  }
  return w < 0 ? -band : band;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return [channel(hh + 1 / 3), channel(hh), channel(hh - 1 / 3)].map((v) =>
    Math.round(v * 255),
  ) as [number, number, number];
}

export function bandColor(band: number, theme: Theme): Rgba {
  if (band === 0) return [0, 0, 0, 0];
  const t = Math.min(Math.abs(band), LEVELS) / LEVELS;
  const hue = band > 0 ? 120 - 125 * t : 120 + 160 * t;
  const lightness = theme === 'light' ? 48 - 20 * t * t : 58 - 14 * t * t;
  const [r, g, b] = hslToRgb(hue, 0.85, lightness / 100);
  return [r, g, b, 210 + 5 * Math.abs(band)];
}

/** 2 * LEVELS + 1 RGBA entries (band-edge line colours); index = band + LEVELS. */
export function buildLut(theme: Theme): Uint8Array {
  const lut = new Uint8Array((2 * LEVELS + 1) * 4);
  for (let band = -LEVELS; band <= LEVELS; band++) {
    lut.set(bandColor(band, theme), (band + LEVELS) * 4);
  }
  return lut;
}
