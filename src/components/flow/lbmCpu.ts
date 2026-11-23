import {
  DX, DY, OPP, WT, OMEGA, LATTICE_SPEED, RHO_MIN, RHO_MAX, VELOCITY_LIMIT, FORCE_LIMIT, inletRipple,
} from './constants';

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/**
 * D2Q9 lattice-Boltzmann solver on the CPU: the physics reference for the WebGL
 * solver and the fallback when the GPU lacks float render targets. The physics
 * follows the vertical branch of airflow.ts: BGK collision with OMEGA, velocity
 * clamp, rho guard, bounce-back at solids, periodic side columns, an inlet row 0
 * at LATTICE_SPEED along +row with a cross-stream ripple, and an outlet row that
 * copies the row above.
 *
 * Layout: each buffer holds nine planes of `cols * rows` floats (plane k is
 * direction k), plus one trailing slot that always reads 0. A precomputed table
 * maps every (k, cell) to the slot that streams into the cell: the upstream
 * neighbour, the cell's own opposite direction when that neighbour is solid, or
 * the zero slot (solid cells and sources past the top or bottom edge). One step
 * collides in place, then pulls through the table into the second buffer.
 */
export class CpuLbm {
  readonly cols: number;
  readonly rows: number;
  /** Lattice steps taken since initUniform; drives the inlet ripple. */
  tick = 0;

  private readonly n: number;
  private f: Float32Array;
  private g: Float32Array;
  private readonly src: Int32Array;
  private readonly solid: Uint8Array;
  private forceX: Float32Array | null = null;
  private forceY: Float32Array | null = null;
  private forcePending = false;
  private readonly u: Float32Array;
  private readonly v: Float32Array;
  private readonly curl: Float32Array;

  constructor(cols: number, rows: number) {
    if (!(cols >= 2 && rows >= 3)) throw new Error(`CpuLbm needs at least 2x3 cells, got ${cols}x${rows}`);
    this.cols = cols;
    this.rows = rows;
    const n = (this.n = cols * rows);
    this.f = new Float32Array(9 * n + 1);
    this.g = new Float32Array(9 * n + 1);
    this.src = new Int32Array(9 * n);
    this.solid = new Uint8Array(n);
    this.u = new Float32Array(n);
    this.v = new Float32Array(n);
    this.curl = new Float32Array(n);
    this.buildStreamTable();
    this.initUniform();
  }

  /** Replaces the solid mask (1 = solid). Cells that change state restart at equilibrium. */
  setMask(mask: Uint8Array): void {
    if (mask.length !== this.n) throw new Error(`mask length ${mask.length} != ${this.n}`);
    for (let c = 0; c < this.n; c++) {
      const s = mask[c] ? 1 : 0;
      if (s === this.solid[c]) continue;
      this.solid[c] = s;
      this.equilibrium(this.f, c, 0, s ? 0 : LATTICE_SPEED, 1);
    }
    this.buildStreamTable();
  }

  /** Puts every cell at inlet equilibrium, resets tick and drops any pending force. */
  initUniform(): void {
    for (let c = 0; c < this.n; c++) this.equilibrium(this.f, c, 0, LATTICE_SPEED, 1);
    this.tick = 0;
    this.clearForce();
  }

  /** The start-up kick from airflow.ts: a sinusoidal cross-stream nudge in rows
   * radius..3*radius downstream of (col, row), Gaussian across the stream. */
  seedWake(col: number, row: number, radiusCells: number): void {
    const { cols, rows, solid } = this;
    for (let y = 2; y < rows - 2; y++) for (let x = 2; x < cols - 2; x++) {
      const along = y - row, across = x - col, cell = y * cols + x;
      if (along < radiusCells || along > radiusCells * 3 || solid[cell]) continue;
      const kick = 0.018 * Math.sin((along - radiusCells) * 0.19) * Math.cos(across * 0.13)
        * Math.exp(-((across / (radiusCells * 0.8)) ** 2));
      this.equilibrium(this.f, cell, kick, LATTICE_SPEED, 1);
    }
  }

  /** Adds a Gaussian velocity increment (fx, fy) around (col, row), clamped to
   * FORCE_LIMIT per cell. The collision of the next step's first sub-step applies
   * the sum of all pending calls, then the force clears. */
  addForce(col: number, row: number, fx: number, fy: number, radiusCells: number): void {
    if (!(radiusCells > 0) || !Number.isFinite(fx) || !Number.isFinite(fy)) return;
    const { cols, rows, solid, n } = this;
    const forceX = (this.forceX ??= new Float32Array(n));
    const forceY = (this.forceY ??= new Float32Array(n));
    const r2 = radiusCells * radiusCells, spread = r2 / 2;
    const x0 = Math.ceil(col - radiusCells), x1 = Math.min(Math.floor(col + radiusCells), x0 + cols - 1);
    const y0 = Math.max(1, Math.ceil(row - radiusCells)), y1 = Math.min(rows - 2, Math.floor(row + radiusCells));
    for (let y = y0; y <= y1; y++) for (let gx = x0; gx <= x1; gx++) {
      const d2 = (gx - col) ** 2 + (y - row) ** 2;
      if (d2 > r2) continue;
      const cell = y * cols + (((gx % cols) + cols) % cols);
      if (solid[cell]) continue;
      const weight = Math.exp(-d2 / spread);
      forceX[cell] = clamp(forceX[cell] + fx * weight, -FORCE_LIMIT, FORCE_LIMIT);
      forceY[cell] = clamp(forceY[cell] + fy * weight, -FORCE_LIMIT, FORCE_LIMIT);
    }
    this.forcePending = true;
  }

  /** Advances n lattice steps. */
  step(n: number): void {
    for (let i = 0; i < n; i++) {
      this.collide(i === 0 && this.forcePending);
      this.stream();
      this.tick++;
    }
    if (n > 0 && this.forcePending) this.clearForce();
  }

  /** Lattice velocity per cell; 0 in solids. The arrays are reused across calls. */
  velocity(): { u: Float32Array; v: Float32Array } {
    const { n, f, solid, u, v } = this;
    const rhoMin = RHO_MIN, rhoMax = RHO_MAX, lim = VELOCITY_LIMIT;
    const n2 = 2 * n, n3 = 3 * n, n4 = 4 * n, n5 = 5 * n, n6 = 6 * n, n7 = 7 * n, n8 = 8 * n;
    for (let c = 0; c < n; c++) {
      if (solid[c]) { u[c] = 0; v[c] = 0; continue; }
      const f1 = f[c + n], f2 = f[c + n2], f3 = f[c + n3], f4 = f[c + n4];
      const f5 = f[c + n5], f6 = f[c + n6], f7 = f[c + n7], f8 = f[c + n8];
      const rho = f[c] + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
      if (!(rho >= rhoMin && rho <= rhoMax)) { u[c] = 0; v[c] = 0; continue; }
      u[c] = clamp((f1 - f3 + f5 - f6 - f7 + f8) / rho, -lim, lim);
      v[c] = clamp((f2 - f4 + f5 + f6 - f7 - f8) / rho, -lim, lim);
    }
    return { u, v };
  }

  /** Curl 0.5*(dv/dcol - du/drow) by central differences, periodic across columns;
   * 0 in solids and on the inlet and outlet rows. The array is reused across calls. */
  vorticity(): Float32Array {
    const { cols, rows, solid, curl } = this;
    const { u, v } = this.velocity();
    curl.fill(0, 0, cols);
    curl.fill(0, (rows - 1) * cols);
    for (let y = 1; y < rows - 1; y++) {
      const rowStart = y * cols;
      for (let x = 0; x < cols; x++) {
        const c = rowStart + x;
        if (solid[c]) { curl[c] = 0; continue; }
        const right = x === cols - 1 ? rowStart : c + 1;
        const left = x === 0 ? rowStart + cols - 1 : c - 1;
        curl[c] = 0.5 * (v[right] - v[left] - u[c + cols] + u[c - cols]);
      }
    }
    return curl;
  }

  private clearForce() {
    if (this.forceX) this.forceX.fill(0);
    if (this.forceY) this.forceY.fill(0);
    this.forcePending = false;
  }

  private equilibrium(target: Float32Array, cell: number, vx: number, vy: number, rho: number) {
    const v2 = vx * vx + vy * vy;
    for (let k = 0; k < 9; k++) {
      const dot = DX[k] * vx + DY[k] * vy;
      target[k * this.n + cell] = WT[k] * rho * (1 + 3 * dot + 4.5 * dot * dot - 1.5 * v2);
    }
  }

  private buildStreamTable() {
    const { cols, rows, n, solid, src } = this;
    const zero = 9 * n;
    for (let k = 0; k < 9; k++) {
      const plane = k * n, oppPlane = OPP[k] * n;
      for (let y = 0; y < rows; y++) {
        const sy = y - DY[k];
        for (let x = 0; x < cols; x++) {
          const c = y * cols + x;
          let from = zero;
          if (!solid[c] && sy >= 0 && sy < rows) {
            const s = sy * cols + ((x - DX[k] + cols) % cols);
            from = solid[s] ? oppPlane + c : plane + s;
          }
          src[plane + c] = from;
        }
      }
    }
  }

  /** BGK collision in place on every fluid cell, with the rho guard and clamp. */
  private collide(withForce: boolean) {
    const { n, f, solid } = this;
    const fx = withForce ? this.forceX : null, fy = withForce ? this.forceY : null;
    const n2 = 2 * n, n3 = 3 * n, n4 = 4 * n, n5 = 5 * n, n6 = 6 * n, n7 = 7 * n, n8 = 8 * n;
    // Imported bindings go into locals: test runners and some bundlers turn module
    // imports into property reads, which cost real time inside this loop.
    const w0 = WT[0], w1 = WT[1], w5 = WT[5], omega = OMEGA, speed = LATTICE_SPEED;
    const rhoMin = RHO_MIN, rhoMax = RHO_MAX, lim = VELOCITY_LIMIT;
    const s2 = speed * speed;
    // Inlet equilibrium (0, LATTICE_SPEED) at rho 1, for the rho guard reset.
    const r0 = w0 * (1 - 1.5 * s2), rSide = w1 * (1 - 1.5 * s2);
    const rDown = w1 * (1 + 3 * speed + 3 * s2), rUp = w1 * (1 - 3 * speed + 3 * s2);
    const rDiagDown = w5 * (1 + 3 * speed + 3 * s2), rDiagUp = w5 * (1 - 3 * speed + 3 * s2);
    for (let c = 0; c < n; c++) {
      if (solid[c]) continue;
      let f0 = f[c], f1 = f[c + n], f2 = f[c + n2], f3 = f[c + n3], f4 = f[c + n4];
      let f5 = f[c + n5], f6 = f[c + n6], f7 = f[c + n7], f8 = f[c + n8];
      let rho = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
      let ux: number, uy: number;
      if (!(rho >= rhoMin && rho <= rhoMax)) {
        rho = 1; ux = 0; uy = speed;
        f0 = r0; f1 = rSide; f3 = rSide; f2 = rDown; f4 = rUp;
        f5 = rDiagDown; f6 = rDiagDown; f7 = rDiagUp; f8 = rDiagUp;
      } else {
        ux = (f1 - f3 + f5 - f6 - f7 + f8) / rho;
        uy = (f2 - f4 + f5 + f6 - f7 - f8) / rho;
      }
      if (fx !== null && fy !== null) { ux += fx[c]; uy += fy[c]; }
      ux = ux < -lim ? -lim : ux > lim ? lim : ux;
      uy = uy < -lim ? -lim : uy > lim ? lim : uy;
      const base = 1 - 1.5 * (ux * ux + uy * uy);
      const a = ux + uy, b = uy - ux;
      const r1 = w1 * rho, r5 = w5 * rho;
      f[c] = f0 + omega * (w0 * rho * base - f0);
      f[c + n] = f1 + omega * (r1 * (base + 3 * ux + 4.5 * ux * ux) - f1);
      f[c + n2] = f2 + omega * (r1 * (base + 3 * uy + 4.5 * uy * uy) - f2);
      f[c + n3] = f3 + omega * (r1 * (base - 3 * ux + 4.5 * ux * ux) - f3);
      f[c + n4] = f4 + omega * (r1 * (base - 3 * uy + 4.5 * uy * uy) - f4);
      f[c + n5] = f5 + omega * (r5 * (base + 3 * a + 4.5 * a * a) - f5);
      f[c + n6] = f6 + omega * (r5 * (base + 3 * b + 4.5 * b * b) - f6);
      f[c + n7] = f7 + omega * (r5 * (base - 3 * a + 4.5 * a * a) - f7);
      f[c + n8] = f8 + omega * (r5 * (base - 3 * b + 4.5 * b * b) - f8);
    }
  }

  /** Pull streaming into the second buffer, then the inlet and outlet rows, then swap. */
  private stream() {
    const { n, cols, rows, src } = this;
    const from = this.f, to = this.g;
    for (let i = 0, end = 9 * n; i < end; i++) to[i] = from[src[i]];
    for (let x = 0; x < cols; x++) this.equilibrium(to, x, inletRipple(x, this.tick), LATTICE_SPEED, 1);
    const outlet = (rows - 1) * cols, adjacent = (rows - 2) * cols;
    for (let k = 0; k < 9; k++) to.copyWithin(k * n + outlet, k * n + adjacent, k * n + outlet);
    this.f = to;
    this.g = from;
  }
}
