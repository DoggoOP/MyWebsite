import { FORCE_LIMIT } from './constants';
import {
  FULLSCREEN_VS, STEP_FS, FORCE_FS, INIT_FS, SEED_FS, MASK_FS, VORTICITY_FS, RENDER_FS, fragment,
} from './shaders';

export type Precision = 'f32' | 'f16';

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const TWO_PI = 2 * Math.PI;
const LUT_ENTRIES = 17;

type Program = { prog: WebGLProgram; loc: (name: string) => WebGLUniformLocation | null };
type StateSet = { tex: [WebGLTexture, WebGLTexture, WebGLTexture]; fbo: WebGLFramebuffer };

// Texture units: 0..2 state A/B/C, 3 mask, 4 force / old mask / LUT, 5 vorticity.
const UNIT_MASK = 3, UNIT_AUX = 4, UNIT_VORT = 5;

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/**
 * D2Q9 lattice-Boltzmann solver in WebGL2 with the same methods and physics as
 * CpuLbm. The textures hold post-collision distributions plus the moments of the
 * post-stream state (see shaders.ts), so one MRT draw per lattice step streams,
 * applies the boundaries and collides. A pending addForce runs one extra pass
 * before the first sub-step that turns the stored collision into the forced one.
 */
export class GpuLbm {
  readonly cols: number;
  readonly rows: number;
  readonly precision: Precision;
  /** Lattice steps taken since initUniform; drives the inlet ripple. */
  tick = 0;

  private readonly gl: WebGL2RenderingContext;
  private readonly n: number;
  private readonly vao: WebGLVertexArrayObject;
  private readonly programs: Program[] = [];
  private readonly pStep: Program;
  private readonly pForce: Program;
  private readonly pInit: Program;
  private readonly pSeed: Program;
  private readonly pMask: Program;
  private readonly pVort: Program;
  private readonly pRender: Program;
  private cur: StateSet;
  private next: StateSet;
  private maskTex: WebGLTexture;
  private spareMaskTex: WebGLTexture;
  private readonly forceTex: WebGLTexture;
  private readonly lutTex: WebGLTexture;
  private readonly vortTex: WebGLTexture;
  private readonly vortFbo: WebGLFramebuffer;
  private readTex: WebGLTexture | null = null;
  private readFbo: WebGLFramebuffer | null = null;

  private readonly solid: Uint8Array;
  private readonly maskBytes: Uint8Array;
  private readonly force: Float32Array;
  private readonly thresholds = new Float32Array(8);
  private forcePending = false;
  private forceRow0 = Infinity;
  private forceRow1 = -Infinity;

  constructor(gl: WebGL2RenderingContext, cols: number, rows: number, precision: Precision) {
    if (!(cols >= 2 && rows >= 3)) throw new Error(`GpuLbm needs at least 2x3 cells, got ${cols}x${rows}`);
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (cols > maxTex || rows > maxTex) throw new Error(`GpuLbm grid ${cols}x${rows} exceeds MAX_TEXTURE_SIZE ${maxTex}`);
    const hasFloat = !!gl.getExtension('EXT_color_buffer_float');
    const hasHalf = precision === 'f16' && (!!gl.getExtension('EXT_color_buffer_half_float') || hasFloat);
    if (precision === 'f32' ? !hasFloat : !hasHalf) throw new Error(`GpuLbm: no ${precision} render targets`);

    this.gl = gl;
    this.cols = cols;
    this.rows = rows;
    this.precision = precision;
    const n = (this.n = cols * rows);
    this.solid = new Uint8Array(n);
    this.maskBytes = new Uint8Array(n);
    this.force = new Float32Array(2 * n);

    const f16 = precision === 'f16';
    const make = (src: string, samplers: Record<string, number>) => {
      const p = this.program(src, samplers);
      this.programs.push(p);
      return p;
    };
    const state = { uA: 0, uB: 1, uC: 2, uMask: UNIT_MASK };
    this.pStep = make(fragment(STEP_FS, f16), state);
    this.pForce = make(fragment(FORCE_FS, f16), { ...state, uForce: UNIT_AUX });
    this.pInit = make(fragment(INIT_FS, f16), state);
    this.pSeed = make(fragment(SEED_FS, f16), state);
    this.pMask = make(fragment(MASK_FS, f16), { ...state, uOldMask: UNIT_AUX });
    this.pVort = make(fragment(VORTICITY_FS, f16), { uC: 2, uMask: UNIT_MASK });
    this.pRender = make(RENDER_FS, { uVort: UNIT_VORT, uLut: UNIT_AUX });

    this.vao = gl.createVertexArray()!;
    const stateFormat = f16 ? gl.RGBA16F : gl.RGBA32F;
    this.cur = this.stateSet(stateFormat);
    this.next = this.stateSet(stateFormat);
    this.maskTex = this.texture(gl.R8, cols, rows);
    this.spareMaskTex = this.texture(gl.R8, cols, rows);
    this.uploadMask(this.maskTex);
    this.forceTex = this.texture(gl.RG32F, cols, rows);
    this.lutTex = this.texture(gl.RGBA8, LUT_ENTRIES, 1);
    this.vortTex = this.texture(f16 ? gl.R16F : gl.R32F, cols, rows);
    this.vortFbo = this.framebuffer([this.vortTex]);

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    this.initUniform();
  }

  /** Replaces the solid mask (1 = solid). Cells that turn fluid restart at inlet equilibrium. */
  setMask(mask: Uint8Array): void {
    if (mask.length !== this.n) throw new Error(`mask length ${mask.length} != ${this.n}`);
    let changed = false;
    for (let c = 0; c < this.n; c++) {
      const s = mask[c] ? 1 : 0;
      if (s !== this.solid[c]) { this.solid[c] = s; changed = true; }
    }
    if (!changed) return;
    const old = this.maskTex;
    this.maskTex = this.spareMaskTex;
    this.spareMaskTex = old;
    this.uploadMask(this.maskTex);
    this.statePass(this.pMask, () => this.bind(UNIT_AUX, old));
  }

  /** Puts every cell at inlet equilibrium, resets tick and drops any pending force. */
  initUniform(): void {
    this.statePass(this.pInit);
    this.tick = 0;
    this.clearForce();
  }

  /** The start-up kick of CpuLbm.seedWake, computed per cell in a shader. */
  seedWake(col: number, row: number, radiusCells: number): void {
    if (!(radiusCells > 0)) return;
    this.statePass(this.pSeed, () => this.gl.uniform3f(this.pSeed.loc('uSeed'), col, row, radiusCells));
  }

  /** Same accumulation and clamps as CpuLbm.addForce; uploaded on the next step(). */
  addForce(col: number, row: number, fx: number, fy: number, radiusCells: number): void {
    if (!(radiusCells > 0) || !Number.isFinite(fx) || !Number.isFinite(fy)) return;
    const { cols, rows, solid, force } = this;
    const r2 = radiusCells * radiusCells, spread = r2 / 2;
    const x0 = Math.ceil(col - radiusCells), x1 = Math.min(Math.floor(col + radiusCells), x0 + cols - 1);
    const y0 = Math.max(1, Math.ceil(row - radiusCells)), y1 = Math.min(rows - 2, Math.floor(row + radiusCells));
    for (let y = y0; y <= y1; y++) for (let gx = x0; gx <= x1; gx++) {
      const d2 = (gx - col) ** 2 + (y - row) ** 2;
      if (d2 > r2) continue;
      const cell = y * cols + (((gx % cols) + cols) % cols);
      if (solid[cell]) continue;
      const weight = Math.exp(-d2 / spread);
      force[2 * cell] = clamp(force[2 * cell] + fx * weight, -FORCE_LIMIT, FORCE_LIMIT);
      force[2 * cell + 1] = clamp(force[2 * cell + 1] + fy * weight, -FORCE_LIMIT, FORCE_LIMIT);
    }
    if (y0 <= y1) {
      this.forceRow0 = Math.min(this.forceRow0, y0);
      this.forceRow1 = Math.max(this.forceRow1, y1);
    }
    this.forcePending = true;
  }

  /** Advances n lattice steps. */
  step(n: number): void {
    const { gl } = this;
    for (let i = 0; i < n; i++) {
      if (i === 0 && this.forcePending) this.applyForce();
      const tick = this.tick;
      this.statePass(this.pStep, () => {
        gl.uniform2f(this.pStep.loc('uPhase'), (tick * 0.025) % TWO_PI, (tick * 0.031) % TWO_PI);
      });
      this.tick++;
    }
    if (n > 0 && this.forcePending) this.clearForce();
  }

  /** Vorticity per cell, read back to the CPU. Debug only: stalls the GPU. */
  readVorticity(): Float32Array {
    const { gl, cols, rows, n } = this;
    if (!this.readTex) {
      this.readTex = this.texture(this.precision === 'f16' ? gl.RGBA16F : gl.RGBA32F, cols, rows);
      this.readFbo = this.framebuffer([this.readTex]);
    }
    this.vorticityPass(this.readFbo!, 0, rows);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.readFbo);
    while (gl.getError() !== gl.NO_ERROR) { /* drain stale errors */ }
    const out = new Float32Array(n);
    const rgba = new Float32Array(4 * n);
    gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.FLOAT, rgba);
    if (gl.getError() === gl.NO_ERROR) {
      for (let i = 0; i < n; i++) out[i] = rgba[4 * i];
    } else {
      const half = new Uint16Array(4 * n);
      gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.HALF_FLOAT, half);
      for (let i = 0; i < n; i++) out[i] = halfToFloat(half[4 * i]);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** Draws vorticity rows topRow..topRow+viewRows over the whole canvas, banded through the LUT. */
  render(opts: { topRow: number; viewRows: number; lut: Uint8Array; ref: number }): void {
    const { gl, cols, rows } = this;
    const { topRow, viewRows, lut, ref } = opts;
    const first = clamp(Math.floor(topRow), 0, rows - 1);
    const last = clamp(Math.ceil(topRow + viewRows), first, rows - 1);
    this.vorticityPass(this.vortFbo, first, last - first + 1);

    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LUT_ENTRIES, 1, gl.RGBA, gl.UNSIGNED_BYTE, lut, 0);

    const p = this.pRender;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.useProgram(p.prog);
    this.bind(UNIT_VORT, this.vortTex);
    this.bind(UNIT_AUX, this.lutTex);
    gl.uniform2i(p.loc('uSize'), cols, rows);
    gl.uniform2f(p.loc('uCanvas'), w, h);
    gl.uniform1f(p.loc('uTop'), topRow);
    gl.uniform1f(p.loc('uViewRows'), viewRows);
    gl.uniform1f(p.loc('uRef'), ref);
    const thr = this.thresholds;
    for (let k = 0; k < 8; k++) thr[k] = ref * 0.08 * Math.pow(1.45, k);
    gl.uniform1fv(p.loc('uThr'), thr);
    this.draw();
  }

  dispose(): void {
    const { gl } = this;
    for (const p of this.programs) gl.deleteProgram(p.prog);
    for (const s of [this.cur, this.next]) {
      for (const t of s.tex) gl.deleteTexture(t);
      gl.deleteFramebuffer(s.fbo);
    }
    for (const t of [this.maskTex, this.spareMaskTex, this.forceTex, this.lutTex, this.vortTex, this.readTex]) {
      if (t) gl.deleteTexture(t);
    }
    gl.deleteFramebuffer(this.vortFbo);
    if (this.readFbo) gl.deleteFramebuffer(this.readFbo);
    gl.deleteVertexArray(this.vao);
  }

  private applyForce() {
    const { gl, cols } = this;
    const y0 = this.forceRow0, y1 = this.forceRow1;
    if (y0 <= y1) {
      gl.bindTexture(gl.TEXTURE_2D, this.forceTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y0, cols, y1 - y0 + 1, gl.RG, gl.FLOAT, this.force, 2 * y0 * cols);
    }
    this.statePass(this.pForce, () => {
      this.bind(UNIT_AUX, this.forceTex);
      gl.uniform2i(this.pForce.loc('uRowRange'), y0 <= y1 ? y0 : 1, y0 <= y1 ? y1 : 0);
    });
  }

  private clearForce() {
    if (this.forceRow0 <= this.forceRow1) {
      this.force.fill(0, 2 * this.forceRow0 * this.cols, 2 * (this.forceRow1 + 1) * this.cols);
    }
    this.forceRow0 = Infinity;
    this.forceRow1 = -Infinity;
    this.forcePending = false;
  }

  /** Runs a state-to-state pass from cur into next, then swaps them. */
  private statePass(p: Program, setup?: () => void) {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.next.fbo);
    gl.viewport(0, 0, this.cols, this.rows);
    gl.useProgram(p.prog);
    for (let i = 0; i < 3; i++) this.bind(i, this.cur.tex[i]);
    this.bind(UNIT_MASK, this.maskTex);
    gl.uniform2i(p.loc('uSize'), this.cols, this.rows);
    setup?.();
    this.draw();
    const done = this.cur;
    this.cur = this.next;
    this.next = done;
  }

  /** Writes vorticity for rows first..first+count-1 into the target's red channel. */
  private vorticityPass(target: WebGLFramebuffer, first: number, count: number) {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, first, this.cols, count);
    gl.useProgram(this.pVort.prog);
    this.bind(2, this.cur.tex[2]);
    this.bind(UNIT_MASK, this.maskTex);
    gl.uniform2i(this.pVort.loc('uSize'), this.cols, this.rows);
    this.draw();
  }

  private draw() {
    const { gl } = this;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  private bind(unit: number, tex: WebGLTexture) {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  private uploadMask(tex: WebGLTexture) {
    const { gl, solid, maskBytes } = this;
    for (let c = 0; c < this.n; c++) maskBytes[c] = solid[c] ? 255 : 0;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.cols, this.rows, gl.RED, gl.UNSIGNED_BYTE, maskBytes, 0);
  }

  private texture(format: number, w: number, h: number): WebGLTexture {
    const { gl } = this;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, format, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private stateSet(format: number): StateSet {
    const tex: StateSet['tex'] = [
      this.texture(format, this.cols, this.rows),
      this.texture(format, this.cols, this.rows),
      this.texture(format, this.cols, this.rows),
    ];
    return { tex, fbo: this.framebuffer(tex) };
  }

  private framebuffer(textures: WebGLTexture[]): WebGLFramebuffer {
    const { gl } = this;
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const attachments = textures.map((t, i) => {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
      return gl.COLOR_ATTACHMENT0 + i;
    });
    gl.drawBuffers(attachments);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`GpuLbm: framebuffer incomplete (0x${status.toString(16)})`);
    return fbo;
  }

  private program(fs: string, samplers: Record<string, number>): Program {
    const { gl } = this;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(`GpuLbm shader: ${log}`);
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, FULLSCREEN_VS);
    const frag = compile(gl.FRAGMENT_SHADER, fs);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`GpuLbm link: ${gl.getProgramInfoLog(prog)}`);
    const cache = new Map<string, WebGLUniformLocation | null>();
    const loc = (name: string) => {
      if (!cache.has(name)) cache.set(name, gl.getUniformLocation(prog, name));
      return cache.get(name)!;
    };
    gl.useProgram(prog);
    for (const [name, unit] of Object.entries(samplers)) gl.uniform1i(loc(name), unit);
    return { prog, loc };
  }
}
