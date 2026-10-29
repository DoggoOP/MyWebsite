import * as THREE from 'three';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const DX = [0, 1, 0, -1, 0, 1, -1, -1, 1];
const DY = [0, 0, 1, 0, -1, 1, 1, -1, -1];
const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6];
const WT = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
const OMEGA = 1.84;
const LATTICE_SPEED = 0.085;
const FLOW_STEPS = 6;
export type FlowMode = 'pressure' | 'vorticity' | 'speed';

/** A 2D D2Q9 lattice-Boltzmann flow over the viewport. The obstacle is
 * rasterized from the point cloud's current camera projection and the bio card. */
export class Airflow {
  private ctx: CanvasRenderingContext2D;
  private off = document.createElement('canvas');
  private offCtx = this.off.getContext('2d')!;
  private image!: ImageData;
  private w = 0;
  private h = 0;
  private screenW = 0;
  private screenH = 0;
  private u = new Float32Array(0);
  private v = new Float32Array(0);
  private f = new Float32Array(0);
  private fNext = new Float32Array(0);
  private pressure = new Float32Array(0);
  private pressureMean = new Float32Array(0);
  private curl = new Float32Array(0);
  private dye = new Float32Array(0);
  private dyeNext = new Float32Array(0);
  private mouseForceX = new Float32Array(0);
  private mouseForceY = new Float32Array(0);
  private solid = new Uint8Array(0);
  private projected = new THREE.Vector3();
  private pressureScale = 0.2;
  private flowSpeed = 1.25;
  private direction: 1 | -1 = 1;
  private vertical = false;
  private mode: FlowMode = 'vorticity';
  private vorticityScale = 0.1;
  private tracers: Array<{ x: number; y: number; previousX: number; previousY: number }> = [];
  private tick = 0;
  private mouse: { x: number; y: number; startX: number; startY: number; dx: number; dy: number } | null = null;
  private lastMouse: { x: number; y: number } | null = null;
  private wakeSeeded = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize() {
    const width = window.innerWidth, height = window.innerHeight;
    if (width === this.screenW && height === this.screenH) return;
    this.screenW = width; this.screenH = height;
    this.vertical = width <= 900 && height > width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = clamp(Math.round(width / 6.5), 110, 220);
    this.h = clamp(Math.round(this.w * height / width), 70, 170);
    const n = this.w * this.h;
    this.u = new Float32Array(n);
    this.v = new Float32Array(n);
    this.f = new Float32Array(n * 9);
    this.fNext = new Float32Array(n * 9);
    this.pressure = new Float32Array(n);
    this.pressureMean = new Float32Array(n);
    this.curl = new Float32Array(n);
    this.dye = new Float32Array(n);
    this.dyeNext = new Float32Array(n);
    this.mouseForceX = new Float32Array(n);
    this.mouseForceY = new Float32Array(n);
    this.solid = new Uint8Array(n);
    this.off.width = this.w; this.off.height = this.h;
    this.image = this.offCtx.createImageData(this.w, this.h);
    this.initializeFlow();
    this.wakeSeeded = false;
    this.tracers = Array.from({ length: clamp(Math.round(width * 0.9), 500, 1400) }, () => {
      const x = 1 + Math.random() * (this.w - 2), y = 1 + Math.random() * (this.h - 2);
      return { x, y, previousX: x, previousY: y };
    });

  }

  pointerMove(clientX: number, clientY: number) {
    if (this.lastMouse) {
      const x = clientX / this.screenW * this.w;
      const y = clientY / this.screenH * this.h;
      const previousX = this.lastMouse.x / this.screenW * this.w;
      const previousY = this.lastMouse.y / this.screenH * this.h;
      const dx = (clientX - this.lastMouse.x) / 9;
      const dy = (clientY - this.lastMouse.y) / 9;
      // Several pointer events can arrive between solver steps. Preserve the
      // whole stroke instead of replacing it with just the final tiny delta.
      if (this.mouse) {
        this.mouse.x = x;
        this.mouse.y = y;
        this.mouse.dx = clamp(this.mouse.dx + dx, -12, 12);
        this.mouse.dy = clamp(this.mouse.dy + dy, -12, 12);
      } else {
        this.mouse = { x, y, startX: previousX, startY: previousY, dx: clamp(dx, -12, 12), dy: clamp(dy, -12, 12) };
      }
    }
    this.lastMouse = { x: clientX, y: clientY };
  }

  pointerLeave() { this.lastMouse = null; this.mouse = null; }

  setMode(mode: FlowMode) { this.mode = mode; }

  isVertical() { return this.vertical; }

  setFlow(speed: number, direction: 1 | -1) {
    const previousSpeed = this.flowSpeed;
    this.flowSpeed = clamp(speed, 0.4, 2);
    if (direction !== this.direction) {
      this.direction = direction;
      this.initializeFlow();
      this.wakeSeeded = false;
      this.dye.fill(0);
      this.pressureMean.fill(0);
    } else if (previousSpeed !== this.flowSpeed) {
      // Re-equilibrate when the inlet speed changes, avoiding a mismatch
      // between the distribution functions and the new boundary condition.
      this.initializeFlow();
      this.wakeSeeded = false;
      this.pressureMean.fill(0);
      this.dye.fill(0);
    }
  }

  private equilibrium(target: Float32Array, cell: number, vx: number, vy: number, rho = 1) {
    const v2 = vx * vx + vy * vy;
    for (let k = 0; k < 9; k++) {
      const dot = DX[k] * vx + DY[k] * vy;
      target[cell * 9 + k] = WT[k] * rho * (1 + 3 * dot + 4.5 * dot * dot - 1.5 * v2);
    }
  }

  private initializeFlow() {
    const speed = LATTICE_SPEED * this.flowSpeed * this.direction;
    for (let i = 0; i < this.w * this.h; i++) {
      this.equilibrium(this.f, i, this.vertical ? 0 : speed, this.vertical ? speed : 0);
      this.u[i] = this.vertical ? 0 : speed * FLOW_STEPS;
      this.v[i] = this.vertical ? speed * FLOW_STEPS : 0;
      this.pressure[i] = 0;
    }
  }

  updateObstacles(positions: Float32Array | null, camera: THREE.PerspectiveCamera,
    viewerRect: DOMRect, cardRect: DOMRect | null) {
    const { w, h } = this;
    const previousSolid = this.solid.slice();
    const hits = new Uint16Array(w * h);
    if (positions) {
      camera.updateMatrixWorld();
      // Dense projected points become a silhouette; no bounding-box shortcut.
      for (let i = 0; i < positions.length; i += 9) {
        this.projected.set(positions[i], positions[i + 1], positions[i + 2]).project(camera);
        if (this.projected.z < -1 || this.projected.z > 1) continue;
        const px = viewerRect.left + (this.projected.x + 1) * 0.5 * viewerRect.width;
        const py = viewerRect.top + (1 - this.projected.y) * 0.5 * viewerRect.height;
        const gx = Math.floor(px / this.screenW * w);
        const gy = Math.floor(py / this.screenH * h);
        if (gx < 1 || gx >= w - 1 || gy < 1 || gy >= h - 1) continue;
        hits[gy * w + gx]++;
      }
    }
    const occupied = new Uint8Array(w * h);
    for (let i = 0; i < hits.length; i++) occupied[i] = hits[i] >= 2 ? 1 : 0;
    // Close sub-cell gaps in the scan without turning it into a rectangle.
    const grown = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (occupied[i]) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
        grown[i + dy * w + dx] = 1;
    }
    const closed = new Uint8Array(w * h);
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      let full = true;
      for (let dy = -1; dy <= 1 && full; dy++) for (let dx = -1; dx <= 1; dx++)
        if (!grown[i + dy * w + dx]) { full = false; break; }
      if (full) closed[i] = 1;
    }
    this.solid.set(closed);
    if (cardRect) {
      const margin = 0;
      const left = cardRect.left - margin, top = cardRect.top - margin;
      const width = cardRect.width + margin * 2, height = cardRect.height + margin * 2;
      const x0 = clamp(Math.floor(left / this.screenW * w), 0, w - 1);
      const x1 = clamp(Math.ceil((left + width) / this.screenW * w), 0, w - 1);
      const y0 = clamp(Math.floor(top / this.screenH * h), 0, h - 1);
      const y1 = clamp(Math.ceil((top + height) / this.screenH * h), 0, h - 1);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const nx = ((x + .5) / w * this.screenW - left) / width;
        const ny = ((y + .5) / h * this.screenH - top) / height;
        const roundedObstacle = (nx - 0.5) ** 2 + (ny - 0.5) ** 2 <= 0.25;
        if (roundedObstacle) this.solid[y * w + x] = 1;
      }
    }
    const speed = LATTICE_SPEED * this.flowSpeed * this.direction;
    for (let i = 0; i < this.solid.length; i++) {
      if (this.solid[i]) {
        this.u[i] = 0; this.v[i] = 0; this.dye[i] = 0;
      }
      if (this.solid[i] !== previousSolid[i])
        this.equilibrium(this.f, i, this.solid[i] ? 0 : this.vertical ? 0 : speed,
          this.solid[i] ? 0 : this.vertical ? speed : 0);
    }
    if (cardRect && !this.wakeSeeded) {
      // The navbar tunnel begins with a slight downstream disturbance. Seed
      // the same kind of transient here; subsequent vortices evolve only
      // through collision, streaming and bounce-back at the actual mask.
      const centerX = (cardRect.left + cardRect.width / 2) / this.screenW * w;
      const centerY = (cardRect.top + cardRect.height / 2) / this.screenH * h;
      const radius = this.vertical
        ? cardRect.height / this.screenH * h / 2
        : cardRect.width / this.screenW * w / 2;
      for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
        const along = (this.vertical ? y - centerY : x - centerX) * this.direction;
        const across = this.vertical ? x - centerX : y - centerY;
        if (along < radius || along > radius * 3 || this.solid[y * w + x]) continue;
        const kick = 0.018 * Math.sin((along - radius) * 0.19) * Math.cos(across * 0.13)
          * Math.exp(-((across / (radius * 0.8)) ** 2));
        this.equilibrium(this.f, y * w + x,
          this.vertical ? kick : speed, this.vertical ? speed : kick);
      }
      this.wakeSeeded = true;
    }
  }

  private sample(field: Float32Array, x: number, y: number) {
    const { w, h } = this;
    x = clamp(x, 0, w - 1.001); y = clamp(y, 0, h - 1.001);
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return field[i] * (1 - fx) * (1 - fy) + field[i + 1] * fx * (1 - fy)
      + field[i + w] * (1 - fx) * fy + field[i + w + 1] * fx * fy;
  }

  private advanceLbm(applyMouse: boolean) {
    const { w, h, solid, mouseForceX, mouseForceY } = this;
    const current = this.f, next = this.fNext;
    next.fill(0);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const cell = y * w + x;
      if (solid[cell]) continue;
      const base = cell * 9;
      let rho = 0, vx = 0, vy = 0;
      for (let k = 0; k < 9; k++) {
        const value = current[base + k];
        rho += value;
        vx += value * DX[k];
        vy += value * DY[k];
      }
      if (!Number.isFinite(rho) || rho < 0.65 || rho > 1.45) {
        rho = 1;
        vx = this.vertical ? 0 : LATTICE_SPEED * this.flowSpeed * this.direction;
        vy = this.vertical ? LATTICE_SPEED * this.flowSpeed * this.direction : 0;
        this.equilibrium(current, cell, vx, vy);
        vx *= rho; vy *= rho;
      }
      vx = clamp(vx / rho + (applyMouse ? mouseForceX[cell] : 0), -0.19, 0.19);
      vy = clamp(vy / rho + (applyMouse ? mouseForceY[cell] : 0), -0.19, 0.19);
      const v2 = vx * vx + vy * vy;
      for (let k = 0; k < 9; k++) {
        const dot = DX[k] * vx + DY[k] * vy;
        const eq = WT[k] * rho * (1 + 3 * dot + 4.5 * dot * dot - 1.5 * v2);
        const post = current[base + k] + OMEGA * (eq - current[base + k]);
        let nx = x + DX[k], ny = y + DY[k];
        // Periodic cross-stream edges avoid artificial wall flashes. The
        // streamwise edges remain an inlet and an open outlet.
        if (this.vertical) {
          if (ny < 0 || ny >= h) continue;
          nx = (nx + w) % w;
        } else {
          if (nx < 0 || nx >= w) continue;
          ny = (ny + h) % h;
        }
        const destination = ny * w + nx;
        if (solid[destination]) next[base + OPP[k]] += post;
        else next[destination * 9 + k] += post;
      }
    }
    const inlet = LATTICE_SPEED * this.flowSpeed * this.direction;
    if (this.vertical) {
      const inletY = this.direction === 1 ? 0 : h - 1;
      const outletY = this.direction === 1 ? h - 1 : 0;
      const adjacentY = outletY + (this.direction === 1 ? -1 : 1);
      for (let x = 0; x < w; x++) {
        const cross = 0.0035 * Math.sin(x * 0.085 + this.tick * 0.025)
          + 0.0015 * Math.sin(x * 0.21 - this.tick * 0.031);
        this.equilibrium(next, inletY * w + x, cross, inlet);
        const outlet = (outletY * w + x) * 9;
        const adjacent = (adjacentY * w + x) * 9;
        for (let k = 0; k < 9; k++) next[outlet + k] = next[adjacent + k];
      }
    } else {
      const inletX = this.direction === 1 ? 0 : w - 1;
      const outletX = this.direction === 1 ? w - 1 : 0;
      const adjacentX = outletX + (this.direction === 1 ? -1 : 1);
      for (let y = 0; y < h; y++) {
        const cross = 0.0035 * Math.sin(y * 0.085 + this.tick * 0.025)
          + 0.0015 * Math.sin(y * 0.21 - this.tick * 0.031);
        this.equilibrium(next, y * w + inletX, inlet, cross);
        const outlet = (y * w + outletX) * 9;
        const adjacent = (y * w + adjacentX) * 9;
        for (let k = 0; k < 9; k++) next[outlet + k] = next[adjacent + k];
      }
    }
    this.f = next;
    this.fNext = current;
  }

  step() {
    const { w, h, solid, mouseForceX, mouseForceY } = this;
    mouseForceX.fill(0);
    mouseForceY.fill(0);
    if (this.mouse) {
      const { x, y, startX, startY, dx, dy } = this.mouse;
      const samples = clamp(Math.ceil(Math.hypot(x - startX, y - startY) / 3), 1, 20);
      const radius = 9;
      for (let sample = 0; sample < samples; sample++) {
        const fraction = (sample + 0.5) / samples;
        const cx = startX + (x - startX) * fraction;
        const cy = startY + (y - startY) * fraction;
        for (let gy = Math.max(1, Math.floor(cy - radius)); gy < Math.min(h - 1, cy + radius); gy++)
          for (let gx = Math.max(1, Math.floor(cx - radius)); gx < Math.min(w - 1, cx + radius); gx++) {
            const cell = gy * w + gx;
            if (solid[cell]) continue;
            const d2 = (gx - cx) ** 2 + (gy - cy) ** 2;
            const weight = Math.exp(-d2 / 24) / Math.sqrt(samples);
            mouseForceX[cell] = clamp(mouseForceX[cell] + dx * weight * 0.012, -0.12, 0.12);
            mouseForceY[cell] = clamp(mouseForceY[cell] + dy * weight * 0.012, -0.12, 0.12);
            this.dye[cell] = Math.min(1.5, this.dye[cell] + 0.7 * weight);
          }
      }
      this.mouse = null;
    }
    for (let substep = 0; substep < FLOW_STEPS; substep++) this.advanceLbm(substep === 0);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const cell = y * w + x;
      if (solid[cell]) {
        this.u[cell] = this.v[cell] = this.pressure[cell] = this.curl[cell] = 0;
        continue;
      }
      const base = cell * 9;
      let rho = 0, vx = 0, vy = 0;
      for (let k = 0; k < 9; k++) {
        const value = this.f[base + k];
        rho += value;
        vx += value * DX[k];
        vy += value * DY[k];
      }
      if (!Number.isFinite(rho) || rho < 0.65 || rho > 1.45) {
        this.equilibrium(this.f, cell, 0, 0);
        rho = 1; vx = 0; vy = 0;
      }
      this.u[cell] = clamp(vx / rho, -0.19, 0.19) * FLOW_STEPS;
      this.v[cell] = clamp(vy / rho, -0.19, 0.19) * FLOW_STEPS;
      this.pressure[cell] = rho - 1;
    }
    // Use the far-field fluid at each streamwise station as the pressure
    // reference. Smooth that reference along the tunnel so small turbulent
    // fluctuations do not become full-height color bands.
    const alongSize = this.vertical ? h : w;
    const crossSize = this.vertical ? w : h;
    const edgeBand = Math.max(3, Math.floor(crossSize * 0.11));
    const farField = new Float32Array(alongSize);
    const farCount = new Uint16Array(alongSize);
    for (let along = 1; along < alongSize - 1; along++)
      for (let cross = 1; cross < crossSize - 1; cross++) {
        if (cross >= edgeBand && cross < crossSize - edgeBand) continue;
        const cell = this.vertical ? along * w + cross : cross * w + along;
        if (solid[cell]) continue;
        farField[along] += this.pressure[cell];
        farCount[along]++;
      }
    for (let along = 1; along < alongSize - 1; along++)
      if (farCount[along]) farField[along] /= farCount[along];
    const reference = new Float32Array(alongSize);
    const referenceRadius = Math.max(8, Math.floor(alongSize * 0.075));
    for (let along = 1; along < alongSize - 1; along++) {
      let total = 0, samples = 0;
      for (let offset = -referenceRadius; offset <= referenceRadius; offset++) {
        const neighbor = clamp(along + offset, 1, alongSize - 2);
        if (farCount[neighbor]) { total += farField[neighbor]; samples++; }
      }
      reference[along] = samples ? total / samples : 0;
    }
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const cell = y * w + x;
      if (!solid[cell]) {
        this.pressure[cell] -= reference[this.vertical ? y : x];
        this.pressureMean[cell] = this.pressureMean[cell] * 0.95 + this.pressure[cell] * 0.05;
      } else this.pressureMean[cell] = 0;
    }
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      const cell = y * w + x;
      this.curl[cell] = solid[cell] ? 0 : 0.5 * (this.v[cell + 1] - this.v[cell - 1]
        - this.u[cell + w] + this.u[cell - w]);
    }
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const cell = y * w + x;
      if (solid[cell]) { this.dyeNext[cell] = 0; continue; }
      const bx = x - this.u[cell] * 0.9, by = y - this.v[cell] * 0.9;
      this.dyeNext[cell] = this.sample(this.dye, bx, by) * 0.996;
    }
    [this.dye, this.dyeNext] = [this.dyeNext, this.dye];
    for (let cross = 1; cross < crossSize - 1; cross++) {
      const cell = this.vertical
        ? (this.direction === 1 ? w : (h - 2) * w) + cross
        : cross * w + (this.direction === 1 ? 1 : w - 2);
      const ribbon = Math.pow(Math.max(0, Math.sin(cross * 0.19 + this.tick * 0.052)), 8);
      const pulse = 0.6 + 0.4 * Math.sin(cross * 0.11 - this.tick * 0.09);
      this.dye[cell] = 0.12 + 0.85 * ribbon * pulse;
    }
    this.tick++;
    this.moveTracers();
    this.draw();
  }

  private moveTracers() {
    const { w, h, solid } = this;
    for (const tracer of this.tracers) {
      const vx = this.sample(this.u, tracer.x, tracer.y);
      const vy = this.sample(this.v, tracer.x, tracer.y);
      const midX = tracer.x + vx * 0.45, midY = tracer.y + vy * 0.45;
      let nextX = tracer.x + this.sample(this.u, midX, midY) * 0.9;
      let nextY = tracer.y + this.sample(this.v, midX, midY) * 0.9;
      tracer.previousX = tracer.x;
      tracer.previousY = tracer.y;
      if (nextX < 1 || nextX >= w - 2 || nextY < 1 || nextY >= h - 2) {
        // Fluid parcels leave the domain and new parcels enter at the inlet.
        tracer.x = this.vertical ? 1 + Math.random() * (w - 3) : this.direction === 1 ? 1 : w - 2;
        tracer.y = this.vertical ? (this.direction === 1 ? 1 : h - 2) : 1 + Math.random() * (h - 3);
        tracer.previousX = tracer.x;
        tracer.previousY = tracer.y;
        continue;
      }
      if (solid[Math.round(nextY) * w + Math.round(nextX)]) {
        // Slide along the projected surface until the local flow clears it.
        if (this.vertical) {
          let left = 1, right = 1;
          while (left < 14 && solid[Math.round(nextY) * w + clamp(Math.round(nextX - left), 1, w - 2)]) left++;
          while (right < 14 && solid[Math.round(nextY) * w + clamp(Math.round(nextX + right), 1, w - 2)]) right++;
          const side = left === right ? (tracer.x < w * 0.5 ? -1 : 1) : (left < right ? -1 : 1);
          nextX = clamp(tracer.x + side * 1.15, 1, w - 2);
          nextY = tracer.y - this.direction * 0.2;
        } else {
          let above = 1, below = 1;
          while (above < 14 && solid[clamp(Math.round(nextY - above), 1, h - 2) * w + Math.round(nextX)]) above++;
          while (below < 14 && solid[clamp(Math.round(nextY + below), 1, h - 2) * w + Math.round(nextX)]) below++;
          const side = above === below ? (tracer.y < h * 0.5 ? -1 : 1) : (above < below ? -1 : 1);
          nextX = tracer.x - this.direction * 0.2;
          nextY = clamp(tracer.y + side * 1.15, 1, h - 2);
        }
        if (solid[Math.round(nextY) * w + Math.round(nextX)]) {
          nextX = tracer.x;
          nextY = tracer.y;
        }
      }
      tracer.x = nextX;
      tracer.y = nextY;
    }
  }

  private draw() {
    const { w, h, solid, pressureMean, curl, dye, u, v, ctx } = this;
    let maxPressure = 0;
    for (let i = 0; i < pressureMean.length; i++) if (!solid[i]) maxPressure = Math.max(maxPressure, Math.abs(pressureMean[i]));
    this.pressureScale = this.pressureScale * 0.94 + Math.max(0.035, maxPressure * 0.55) * 0.06;
    let maxCurl = 0;
    for (let i = 0; i < curl.length; i++) if (!solid[i]) maxCurl = Math.max(maxCurl, Math.abs(curl[i]));
    this.vorticityScale = this.vorticityScale * 0.94 + Math.max(0.014, maxCurl * 0.24) * 0.06;
    const pixels = this.image.data;
    const palette = this.mode === 'speed'
      ? [[25, 38, 40], [55, 83, 85], [112, 150, 145], [188, 202, 185]]
      : [[43, 83, 106], [94, 141, 157], [28, 41, 43], [158, 111, 83], [203, 145, 103]];
    const colorAt = (value: number) => {
      const scaled = clamp(value, 0, 1) * (palette.length - 1);
      const index = Math.min(palette.length - 2, Math.floor(scaled));
      const blend = scaled - index;
      return palette[index].map((channel, axis) => channel * (1 - blend) + palette[index + 1][axis] * blend);
    };
    const inletSpeed = LATTICE_SPEED * FLOW_STEPS * this.flowSpeed;
    const fieldValue = (i: number) => {
      if (this.mode === 'vorticity') return 0.5 + curl[i] / this.vorticityScale * 0.47;
      if (this.mode === 'speed') return Math.hypot(u[i], v[i]) / (inletSpeed * 1.8);
      return 0.5 + pressureMean[i] / this.pressureScale * 0.47;
    };
    for (let i = 0; i < solid.length; i++) {
      const scale = clamp(fieldValue(i), 0, 1);
      const color = colorAt(scale);
      pixels[4 * i] = color[0];
      pixels[4 * i + 1] = color[1];
      pixels[4 * i + 2] = color[2];
      const intensity = Math.abs(scale - 0.5);
      pixels[4 * i + 3] = solid[i] ? 0 : this.mode === 'speed'
        ? clamp(26 + 105 * scale + 10 * dye[i], 0, 145)
        : this.mode === 'pressure'
          ? clamp(18 + 220 * intensity + 6 * dye[i], 0, 140)
          : clamp(24 + 245 * intensity + 14 * dye[i], 0, 180);
    }
    this.offCtx.putImageData(this.image, 0, 0);
    ctx.clearRect(0, 0, this.screenW, this.screenH);
    ctx.imageSmoothingEnabled = true;
    ctx.filter = 'blur(2px)';
    ctx.drawImage(this.off, 0, 0, this.screenW, this.screenH);
    ctx.filter = 'none';
    ctx.lineCap = 'round';
    const sx = this.screenW / w, sy = this.screenH / h;
    ctx.lineWidth = 1.25;
    for (const tracer of this.tracers) {
      const i = Math.round(tracer.y) * w + Math.round(tracer.x);
      if (solid[i] || (tracer.x === tracer.previousX && tracer.y === tracer.previousY)) continue;
      const color = colorAt(fieldValue(i));
      const edgeFade = this.vertical
        ? Math.min(1, tracer.y / 8, (h - 1 - tracer.y) / 8)
        : Math.min(1, tracer.x / 8, (w - 1 - tracer.x) / 8);
      ctx.strokeStyle = `rgba(${Math.round(color[0] * 0.6 + 230 * 0.4)},${Math.round(color[1] * 0.6 + 232 * 0.4)},${Math.round(color[2] * 0.6 + 225 * 0.4)},${0.58 * edgeFade})`;
      ctx.beginPath();
      ctx.moveTo(tracer.previousX * sx, tracer.previousY * sy);
      ctx.lineTo(tracer.x * sx, tracer.y * sy);
      ctx.stroke();
    }
  }
}
