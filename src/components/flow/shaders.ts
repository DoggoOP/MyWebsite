import { DX, DY, OPP, WT, OMEGA, LATTICE_SPEED, RHO_MIN, RHO_MAX, VELOCITY_LIMIT } from './constants';

/**
 * GLSL ES 3.00 sources for GpuLbm.
 *
 * State layout (one ping-pong set = three textures, cols x rows, texel (col, row)):
 *   A = (f0, f1, f2, f3), B = (f4, f5, f6, f7), C = (f8, rho - 1, ux, uy)
 * The f values are post-collision distributions. C.yzw hold the moments of the
 * pre-collision (post-stream) state: raw rho - 1 (99 when the rho guard fired) and
 * raw ux, uy (clamped to +-1). Solid cells hold zero moments. With `#define F16`
 * the textures store f minus the inlet equilibrium feq_k(1, 0, SPEED), and every
 * read adds that back.
 */

/** Float literal for GLSL: always carries a decimal point. */
const glf = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));

const PRELUDE = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

const LATTICE = `
const float W0 = ${glf(WT[0])};
const float W1 = ${glf(WT[1])};
const float W5 = ${glf(WT[5])};
const float OMEGA = ${glf(OMEGA)};
const float SPEED = ${glf(LATTICE_SPEED)};
const float RHO_MIN = ${glf(RHO_MIN)};
const float RHO_MAX = ${glf(RHO_MAX)};
const float VLIM = ${glf(VELOCITY_LIMIT)};
#ifdef F16
const float BIAS = 1.0;
#else
const float BIAS = 0.0;
#endif
// F16 stores f - feq_k(rho 1, u (0, SPEED)), the inlet equilibrium, so the stored
// deviations stay small and keep more half-float precision.
const float EQ_BASE = 1.0 - 1.5 * SPEED * SPEED;
const float EQ_DOWN = EQ_BASE + 3.0 * SPEED + 4.5 * SPEED * SPEED;
const float EQ_UP = EQ_BASE - 3.0 * SPEED + 4.5 * SPEED * SPEED;
const vec4 BA = BIAS * vec4(W0 * EQ_BASE, W1 * EQ_BASE, W1 * EQ_DOWN, W1 * EQ_BASE);
const vec4 BB = BIAS * vec4(W1 * EQ_UP, W5 * EQ_DOWN, W5 * EQ_DOWN, W5 * EQ_UP);
const vec4 BC = BIAS * vec4(W5 * EQ_UP, 0.0, 0.0, 0.0);

uniform ivec2 uSize;
uniform sampler2D uMask;

bool isSolid(ivec2 s) { return texelFetch(uMask, s, 0).r > 0.5; }

bool rhoOk(float rho) {
  return rho >= RHO_MIN && rho <= RHO_MAX && !isnan(rho) && !isinf(rho);
}

/** Equilibrium at density rho and velocity u, in the same form as CpuLbm.collide. */
void feq(float rho, vec2 u, out vec4 a, out vec4 b, out float e8) {
  float base = 1.0 - 1.5 * (u.x * u.x + u.y * u.y);
  float p = u.x + u.y, m = u.y - u.x;
  float r1 = W1 * rho, r5 = W5 * rho;
  a = vec4(
    W0 * rho * base,
    r1 * (base + 3.0 * u.x + 4.5 * u.x * u.x),
    r1 * (base + 3.0 * u.y + 4.5 * u.y * u.y),
    r1 * (base - 3.0 * u.x + 4.5 * u.x * u.x));
  b = vec4(
    r1 * (base - 3.0 * u.y + 4.5 * u.y * u.y),
    r5 * (base + 3.0 * p + 4.5 * p * p),
    r5 * (base + 3.0 * m + 4.5 * m * m),
    r5 * (base - 3.0 * p + 4.5 * p * p));
  e8 = r5 * (base - 3.0 * m + 4.5 * m * m);
}
`;

const STATE_IN = `
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uC;
`;

const STATE_OUT = `
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
layout(location = 2) out vec4 oC;

/** Writes decoded post-collision values plus moments, encoding for F16. */
void writeState(vec4 a, vec4 b, float f8, vec3 moments) {
  oA = a - BA;
  oB = b - BB;
  oC = vec4(f8 - BC.x, moments);
}

void copyState(ivec2 p) {
  oA = texelFetch(uA, p, 0);
  oB = texelFetch(uB, p, 0);
  oC = texelFetch(uC, p, 0);
}

/** Equilibrium at rho 1 and velocity u, with matching moments. */
void writeEq(vec2 u) {
  vec4 a, b; float e8;
  feq(1.0, u, a, b, e8);
  writeState(a, b, e8, vec3(0.0, u));
}

void writeZero() { writeState(vec4(0.0), vec4(0.0), 0.0, vec3(0.0)); }
`;

/** Full-screen triangle; no vertex buffers. */
export const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const TEX = ['uA', 'uB', 'uC'];
const CH = 'xyzw';
const BIAS_VEC = ['BA', 'BB', 'BC'];
/** Decoded direction k of the own cell (vectors a, b, c below already carry the bias). */
const own = (k: number) => `${'abc'[k >> 2]}.${CH[k & 3]}`;
/** Decoded direction k fetched at texel `s`. */
const fetch = (k: number, s: string) =>
  `(texelFetch(${TEX[k >> 2]}, ${s}, 0).${CH[k & 3]} + ${BIAS_VEC[k >> 2]}.${CH[k & 3]})`;

const pullLines = [1, 2, 3, 4, 5, 6, 7, 8].map((k) =>
  `    ivec2 s${k} = ivec2(wrapX(q.x - (${DX[k]})), q.y - (${DY[k]}));\n` +
  `    f${k} = isSolid(s${k}) ? ${own(OPP[k])} : ${fetch(k, `s${k}`)};`,
).join('\n');

/**
 * One lattice step: pull-stream post-collision values (bounce-back off solid
 * sources, periodic columns), inlet row 0 at the rippled equilibrium, outlet row
 * copying row rows-2, then the rho guard and BGK collision. Mirrors CpuLbm's
 * stream() followed by the next collide(); uPhase = (tick*0.025, tick*0.031) mod 2pi.
 */
export const STEP_FS = `${STATE_IN}${LATTICE}${STATE_OUT}
uniform vec2 uPhase;

int wrapX(int x) { return x < 0 ? x + uSize.x : (x >= uSize.x ? x - uSize.x : x); }

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (isSolid(p)) { writeZero(); return; }
  float f0, f1, f2, f3, f4, f5, f6, f7, f8;
  if (p.y == 0) {
    float x = float(p.x);
    float ripple = 0.0035 * sin(x * 0.085 + uPhase.x) + 0.0015 * sin(x * 0.21 - uPhase.y);
    vec4 a, b; float e8;
    feq(1.0, vec2(ripple, SPEED), a, b, e8);
    f0 = a.x; f1 = a.y; f2 = a.z; f3 = a.w;
    f4 = b.x; f5 = b.y; f6 = b.z; f7 = b.w; f8 = e8;
  } else {
    // The outlet row copies the post-stream values of the row above.
    ivec2 q = ivec2(p.x, p.y == uSize.y - 1 ? uSize.y - 2 : p.y);
    if (isSolid(q)) {
      f0 = 0.0; f1 = 0.0; f2 = 0.0; f3 = 0.0; f4 = 0.0; f5 = 0.0; f6 = 0.0; f7 = 0.0; f8 = 0.0;
    } else {
      vec4 a = texelFetch(uA, q, 0) + BA;
      vec4 b = texelFetch(uB, q, 0) + BB;
      vec4 c = texelFetch(uC, q, 0) + BC;
      f0 = a.x;
${pullLines}
    }
  }

  float rho = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
  float ux, uy;
  vec3 moments;
  if (!rhoOk(rho)) {
    // Reset to the inlet equilibrium (0, SPEED) at rho 1, as CpuLbm.collide does.
    rho = 1.0; ux = 0.0; uy = SPEED;
    vec4 a, b; float e8;
    feq(1.0, vec2(0.0, SPEED), a, b, e8);
    f0 = a.x; f1 = a.y; f2 = a.z; f3 = a.w;
    f4 = b.x; f5 = b.y; f6 = b.z; f7 = b.w; f8 = e8;
    moments = vec3(99.0, 0.0, 0.0);
  } else {
    ux = (f1 - f3 + f5 - f6 - f7 + f8) / rho;
    uy = (f2 - f4 + f5 + f6 - f7 - f8) / rho;
    moments = vec3(rho - 1.0, clamp(ux, -1.0, 1.0), clamp(uy, -1.0, 1.0));
  }
  vec2 u = clamp(vec2(ux, uy), -VLIM, VLIM);
  vec4 ea, eb; float e8;
  feq(rho, u, ea, eb, e8);
  vec4 fa = vec4(f0, f1, f2, f3), fb = vec4(f4, f5, f6, f7);
  writeState(fa + OMEGA * (ea - fa), fb + OMEGA * (eb - fb), f8 + OMEGA * (e8 - f8), moments);
}
`;

/**
 * Applies a pending addForce to the stored post-collision state. The stored values
 * came from collide(F, u); with the force CpuLbm would have produced
 * collide(F, u + force), which differs by OMEGA * (feq(u + force) - feq(u)).
 */
export const FORCE_FS = `${STATE_IN}${LATTICE}${STATE_OUT}
uniform sampler2D uForce;
uniform ivec2 uRowRange;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  copyState(p);
  if (p.y < uRowRange.x || p.y > uRowRange.y || isSolid(p)) return;
  vec2 force = texelFetch(uForce, p, 0).xy;
  if (force.x == 0.0 && force.y == 0.0) return;
  vec4 c = texelFetch(uC, p, 0);
  float rho = c.y + 1.0;
  vec2 u = c.zw;
  if (!rhoOk(rho)) { rho = 1.0; u = vec2(0.0, SPEED); }
  vec4 a0, b0, a1, b1; float e0, e1;
  feq(rho, clamp(u, -VLIM, VLIM), a0, b0, e0);
  feq(rho, clamp(u + force, -VLIM, VLIM), a1, b1, e1);
  oA = texelFetch(uA, p, 0) + OMEGA * (a1 - a0);
  oB = texelFetch(uB, p, 0) + OMEGA * (b1 - b0);
  oC = vec4(c.x + OMEGA * (e1 - e0), c.yzw);
}
`;

/** Every fluid cell at the inlet equilibrium (0, SPEED); solids zero. */
export const INIT_FS = `${STATE_IN}${LATTICE}${STATE_OUT}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (isSolid(p)) writeZero(); else writeEq(vec2(0.0, SPEED));
}
`;

/** CpuLbm.seedWake: equilibrium with a sinusoidal cross-stream kick in rows radius..3*radius downstream. */
export const SEED_FS = `${STATE_IN}${LATTICE}${STATE_OUT}
uniform vec3 uSeed; // col, row, radius

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  copyState(p);
  if (p.y < 2 || p.y >= uSize.y - 2 || p.x < 2 || p.x >= uSize.x - 2 || isSolid(p)) return;
  float r = uSeed.z;
  float along = float(p.y) - uSeed.y, across = float(p.x) - uSeed.x;
  if (along < r || along > r * 3.0) return;
  float t = across / (r * 0.8);
  float kick = 0.018 * sin((along - r) * 0.19) * cos(across * 0.13) * exp(-(t * t));
  writeEq(vec2(kick, SPEED));
}
`;

/** setMask: cells turning fluid restart at (0, SPEED); solid cells zero. uMask is the new mask. */
export const MASK_FS = `${STATE_IN}${LATTICE}${STATE_OUT}
uniform sampler2D uOldMask;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (isSolid(p)) { writeZero(); return; }
  if (texelFetch(uOldMask, p, 0).r > 0.5) { writeEq(vec2(0.0, SPEED)); return; }
  copyState(p);
}
`;

/**
 * Curl 0.5*(dv/dcol - du/drow) from the stored moments, periodic across columns,
 * 0 in solids and on the inlet and outlet rows. Velocity follows CpuLbm.velocity:
 * 0 when rho fails the guard, else clamped to VLIM.
 */
export const VORTICITY_FS = `${LATTICE}
uniform sampler2D uC;
out vec4 oW;

vec2 vel(ivec2 s) {
  vec4 c = texelFetch(uC, s, 0);
  return rhoOk(c.y + 1.0) ? clamp(c.zw, -VLIM, VLIM) : vec2(0.0);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (p.y == 0 || p.y >= uSize.y - 1 || isSolid(p)) { oW = vec4(0.0, 0.0, 0.0, 1.0); return; }
  int right = p.x == uSize.x - 1 ? 0 : p.x + 1;
  int left = p.x == 0 ? uSize.x - 1 : p.x - 1;
  float w = 0.5 * (vel(ivec2(right, p.y)).y - vel(ivec2(left, p.y)).y
    - vel(ivec2(p.x, p.y + 1)).x + vel(ivec2(p.x, p.y - 1)).x);
  oW = vec4(w, 0.0, 0.0, 1.0);
}
`;

/**
 * Draws vorticity rows uTop..uTop+uViewRows over the whole viewport, banded as
 * colormap.bandOf does (uThr[k] = ref*0.08*1.45^k) and colored from the 17x1 LUT.
 */
export const RENDER_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uVort;
uniform sampler2D uLut;
uniform ivec2 uSize;
uniform vec2 uCanvas;
uniform float uTop;
uniform float uViewRows;
uniform float uRef;
uniform float uThr[8];
out vec4 oColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uCanvas;
  int col = clamp(int(floor(uv.x * float(uSize.x))), 0, uSize.x - 1);
  int row = clamp(int(floor(uTop + (1.0 - uv.y) * uViewRows)), 0, uSize.y - 1);
  float w = texelFetch(uVort, ivec2(col, row), 0).r;
  int band = 0;
  if (uRef > 0.0 && w != 0.0) {
    float a = abs(w);
    for (int k = 0; k < 8; k++) {
      if (a >= uThr[k]) band = k + 1; else break;
    }
    if (w < 0.0) band = -band;
  }
  oColor = texelFetch(uLut, ivec2(band + 8, 0), 0);
}
`;

/** Prefixes a fragment body with the version line, precision and the F16 switch. */
export function fragment(body: string, f16: boolean): string {
  return PRELUDE + (f16 ? '#define F16 1\n' : '') + body;
}
