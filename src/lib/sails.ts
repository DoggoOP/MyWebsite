export type Pt = [number, number];

export const SAIL_VIEWBOX = { x: -200, y: -170, w: 360, h: 340 };

type SailName = 'main' | 'jib';

const rad = (deg: number) => (deg * Math.PI) / 180;
const rotate = ([x, y]: Pt, a: number): Pt => [
  Math.cos(a) * x - Math.sin(a) * y,
  Math.sin(a) * x + Math.cos(a) * y,
];

// Local sail curves in cm, luff at the origin, bulging toward +y.
const curve = (sail: SailName, t: number): Pt => {
  const u = 1 - t;
  if (sail === 'main') {
    const P = [[0, 0], [50, 20], [150, 30], [194, 0]];
    const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    return [0, 1].map((k) => P.reduce((s, p, i) => s + w[i] * p[k], 0)) as Pt;
  }
  const P = [[0, 0], [50, 37.5], [163, 30]];
  const w = [u * u, 2 * u * t, t * t];
  return [0, 1].map((k) => P.reduce((s, p, i) => s + w[i] * p[k], 0)) as Pt;
};

type Opts = { boatAngle?: number; sailAngle?: number; samples?: number };

// Metres in the sail frame, rotated and offset into the world frame.
const place = (sail: SailName, t: number, boatAngle: number, sailAngle: number): Pt => {
  const [lx, ly] = curve(sail, t);
  const turn = rad(sailAngle - boatAngle + (sail === 'jib' ? 10 : 0));
  const [x, y] = rotate([lx * 0.01, ly * 0.01], turn);
  if (sail === 'main') return [x, y];
  const b = rad(boatAngle);
  return [x - Math.cos(b) * 1.83, y + Math.sin(b) * 1.83];
};

// Output is [100*y, 100*x] so the viewer sees x across and y down.
const out = ([x, y]: Pt): Pt => [100 * y, 100 * x];

export function sailPolylines(opts: Opts = {}): { main: Pt[]; jib: Pt[] } {
  const { boatAngle = 45, sailAngle = 0, samples = 40 } = opts;
  const build = (sail: SailName) =>
    Array.from({ length: samples + 1 }, (_, i) => out(place(sail, i / samples, boatAngle, sailAngle)));
  return { main: build('main'), jib: build('jib') };
}

// A point 10 output units off the sail at t = 0.5, on the convex (+y local) side.
export function leewardPoint(sail: SailName, opts: Opts = {}): Pt {
  const { boatAngle = 45, sailAngle = 0 } = opts;
  const e = 0.01;
  const at = (t: number) => place(sail, t, boatAngle, sailAngle);
  const [x0, y0] = at(0.5 - e);
  const [x1, y1] = at(0.5 + e);
  const [mx, my] = at(0.5);
  // Local +y normal is the tangent turned a quarter turn left; the same turn holds after rotation.
  const len = Math.hypot(x1 - x0, y1 - y0);
  const nx = -(y1 - y0) / len;
  const ny = (x1 - x0) / len;
  const [ox, oy] = out([mx, my]);
  const [dx, dy] = out([nx, ny]);
  return [ox + dx * 10, oy + dy * 10];
}
