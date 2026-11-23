import { test, expect } from 'vitest';
import { CpuLbm } from './lbmCpu';
import { DX, DY, OPP, WT, OMEGA, LATTICE_SPEED, RHO_MIN, RHO_MAX, inletRipple } from './constants';

test('uniform flow with no solids stays uniform away from the ripple', () => {
  const s = new CpuLbm(40, 60); s.initUniform(); s.step(50);
  const { u, v } = s.velocity();
  for (let r = 10; r < 50; r++) for (let c = 0; c < 40; c++) {
    expect(Math.abs(v[r * 40 + c] - LATTICE_SPEED)).toBeLessThan(0.01);
    expect(Math.abs(u[r * 40 + c])).toBeLessThan(0.01);
  }
});
test('solid cells carry no velocity and the wake has signed vorticity', () => {
  const s = new CpuLbm(80, 160), m = new Uint8Array(80 * 160);
  for (let r = 0; r < 160; r++) for (let c = 0; c < 80; c++) if ((c - 40) ** 2 + (r - 40) ** 2 < 64) m[r * 80 + c] = 1;
  s.setMask(m); s.initUniform(); s.seedWake(40, 40, 8); s.step(600);
  const { v } = s.velocity(); expect(v[40 * 80 + 40]).toBe(0);
  const w = s.vorticity();
  const right = w[56 * 80 + 50], left = w[56 * 80 + 30];
  expect(Math.sign(right)).toBe(-Math.sign(left)); expect(Math.abs(right)).toBeGreaterThan(1e-4);
});
test('a hard drag near a solid never produces NaN', () => {
  const s = new CpuLbm(60, 60); s.initUniform();
  for (let i = 0; i < 40; i++) { s.addForce(30, 30, 0.5, -0.5, 6); s.step(1); }
  expect(s.vorticity().every(Number.isFinite)).toBe(true);
});

// A literal port of the vertical branch of airflow.ts advanceLbm (push streaming,
// AoS layout, flowSpeed 1, direction +1), kept here as the parity oracle.
class PushReference {
  f: Float32Array; next: Float32Array; tick = 0;
  constructor(public w: number, public h: number, public solid: Uint8Array) {
    this.f = new Float32Array(w * h * 9); this.next = new Float32Array(w * h * 9);
    for (let i = 0; i < w * h; i++) this.eq(this.f, i, 0, LATTICE_SPEED);
  }
  eq(t: Float32Array, cell: number, vx: number, vy: number, rho = 1) {
    const v2 = vx * vx + vy * vy;
    for (let k = 0; k < 9; k++) {
      const dot = DX[k] * vx + DY[k] * vy;
      t[cell * 9 + k] = WT[k] * rho * (1 + 3 * dot + 4.5 * dot * dot - 1.5 * v2);
    }
  }
  advance(fx: Float32Array | null, fy: Float32Array | null) {
    const { w, h, solid } = this, cur = this.f, next = this.next;
    next.fill(0);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const cell = y * w + x;
      if (solid[cell]) continue;
      const base = cell * 9;
      let rho = 0, vx = 0, vy = 0;
      for (let k = 0; k < 9; k++) { const q = cur[base + k]; rho += q; vx += q * DX[k]; vy += q * DY[k]; }
      if (!Number.isFinite(rho) || rho < RHO_MIN || rho > RHO_MAX) {
        rho = 1; vx = 0; vy = LATTICE_SPEED; this.eq(cur, cell, vx, vy);
      }
      vx = Math.max(-0.19, Math.min(0.19, vx / rho + (fx ? fx[cell] : 0)));
      vy = Math.max(-0.19, Math.min(0.19, vy / rho + (fy ? fy[cell] : 0)));
      const v2 = vx * vx + vy * vy;
      for (let k = 0; k < 9; k++) {
        const dot = DX[k] * vx + DY[k] * vy;
        const e = WT[k] * rho * (1 + 3 * dot + 4.5 * dot * dot - 1.5 * v2);
        const post = cur[base + k] + OMEGA * (e - cur[base + k]);
        const ny = y + DY[k];
        if (ny < 0 || ny >= h) continue;
        const nx = (x + DX[k] + w) % w, d = ny * w + nx;
        if (solid[d]) next[base + OPP[k]] += post; else next[d * 9 + k] += post;
      }
    }
    for (let x = 0; x < w; x++) {
      this.eq(next, x, inletRipple(x, this.tick), LATTICE_SPEED);
      const o = ((h - 1) * w + x) * 9, a = ((h - 2) * w + x) * 9;
      for (let k = 0; k < 9; k++) next[o + k] = next[a + k];
    }
    this.f = next; this.next = cur; this.tick++;
  }
}

test('pull streaming matches the push solver from airflow.ts', () => {
  const w = 48, h = 72, m = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    if ((c - 20) ** 2 + (r - 24) ** 2 < 30) m[r * w + c] = 1;
    if (c === 47 && r > 40 && r < 50) m[r * w + c] = 1; // straddles the periodic seam
  }
  const s = new CpuLbm(w, h); s.setMask(m); s.initUniform();
  const ref = new PushReference(w, h, m);
  s.addForce(30, 50, 0.08, -0.05, 5);
  const fx = new Float32Array(w * h), fy = new Float32Array(w * h);
  for (let r = 1; r < h - 1; r++) for (let c = 0; c < w; c++) {
    if (m[r * w + c]) continue;
    const dc = Math.min(Math.abs(c - 30), w - Math.abs(c - 30)), d2 = dc * dc + (r - 50) ** 2;
    if (d2 > 25) continue;
    const g = Math.exp(-d2 / 12.5);
    fx[r * w + c] = Math.max(-0.12, Math.min(0.12, 0.08 * g));
    fy[r * w + c] = Math.max(-0.12, Math.min(0.12, -0.05 * g));
  }
  s.step(3);
  ref.advance(fx, fy); ref.advance(null, null); ref.advance(null, null);
  s.step(37);
  for (let i = 0; i < 37; i++) ref.advance(null, null);
  expect(s.tick).toBe(40);
  const { u, v } = s.velocity();
  let maxDiff = 0;
  for (let cell = 0; cell < w * h; cell++) {
    if (m[cell]) { expect(u[cell]).toBe(0); expect(v[cell]).toBe(0); continue; }
    let rho = 0, jx = 0, jy = 0;
    for (let k = 0; k < 9; k++) { const q = ref.f[cell * 9 + k]; rho += q; jx += q * DX[k]; jy += q * DY[k]; }
    maxDiff = Math.max(maxDiff, Math.abs(u[cell] - jx / rho), Math.abs(v[cell] - jy / rho));
  }
  expect(maxDiff).toBeLessThan(1e-5);
});

test('force applies once, and batching sub-steps changes nothing', () => {
  const a = new CpuLbm(30, 40), b = new CpuLbm(30, 40), c = new CpuLbm(30, 40);
  for (const s of [a, b, c]) s.initUniform();
  a.addForce(15, 20, 0.05, 0, 4); a.step(6);
  b.addForce(15, 20, 0.05, 0, 4); b.step(1); b.step(2); b.step(3);
  c.step(6);
  const ua = a.velocity().u.slice(), ub = b.velocity().u, uc = c.velocity().u;
  for (let i = 0; i < ua.length; i++) expect(ua[i]).toBe(ub[i]);
  expect(Math.abs(ua[20 * 30 + 15] - uc[20 * 30 + 15])).toBeGreaterThan(1e-3);
});
