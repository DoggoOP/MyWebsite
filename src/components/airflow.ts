import * as THREE from 'three';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export type FlowMode = 'pressure' | 'vorticity' | 'speed';

/** A small incompressible 2D flow solve over the viewport. The obstacle is
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
  private uNext = new Float32Array(0);
  private vNext = new Float32Array(0);
  private pressure = new Float32Array(0);
  private pNext = new Float32Array(0);
  private divergence = new Float32Array(0);
  private curl = new Float32Array(0);
  private dye = new Float32Array(0);
  private dyeNext = new Float32Array(0);
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
  private mouse: { x: number; y: number; dx: number; dy: number } | null = null;
  private lastMouse: { x: number; y: number } | null = null;

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
    this.w = clamp(Math.round(width / 5.5), 140, 270);
    this.h = clamp(Math.round(this.w * height / width), 70, 180);
    const n = this.w * this.h;
    this.u = new Float32Array(n).fill(this.vertical ? 0 : 1.45 * this.flowSpeed * this.direction);
    this.v = new Float32Array(n).fill(this.vertical ? 1.45 * this.flowSpeed * this.direction : 0);
    this.uNext = new Float32Array(n);
    this.vNext = new Float32Array(n);
    this.pressure = new Float32Array(n);
    this.pNext = new Float32Array(n);
    this.divergence = new Float32Array(n);
    this.curl = new Float32Array(n);
    this.dye = new Float32Array(n);
    this.dyeNext = new Float32Array(n);
    this.solid = new Uint8Array(n);
    this.off.width = this.w; this.off.height = this.h;
    this.image = this.offCtx.createImageData(this.w, this.h);
    this.tracers = Array.from({ length: clamp(Math.round(width * 0.9), 500, 1400) }, () => {
      const x = 1 + Math.random() * (this.w - 2), y = 1 + Math.random() * (this.h - 2);
      return { x, y, previousX: x, previousY: y };
    });

  }

  pointerMove(clientX: number, clientY: number) {
    if (this.lastMouse) {
      this.mouse = {
        x: clientX / this.screenW * this.w,
        y: clientY / this.screenH * this.h,
        dx: clamp((clientX - this.lastMouse.x) / 9, -6, 6),
        dy: clamp((clientY - this.lastMouse.y) / 9, -6, 6),
      };
    }
    this.lastMouse = { x: clientX, y: clientY };
  }

  pointerLeave() { this.lastMouse = null; }

  setMode(mode: FlowMode) { this.mode = mode; }

  isVertical() { return this.vertical; }

  setFlow(speed: number, direction: 1 | -1) {
    const previousSpeed = this.flowSpeed;
    this.flowSpeed = clamp(speed, 0.4, 2);
    if (direction !== this.direction) {
      this.direction = direction;
      this.u.fill(this.vertical ? 0 : 1.45 * this.flowSpeed * direction);
      this.v.fill(this.vertical ? 1.45 * this.flowSpeed * direction : 0);
      this.dye.fill(0);
    } else if (previousSpeed !== this.flowSpeed) {
      const ratio = this.flowSpeed / previousSpeed;
      for (let i = 0; i < this.u.length; i++) {
        this.u[i] *= ratio;
        this.v[i] *= ratio;
      }
    }
  }

  updateObstacles(positions: Float32Array | null, camera: THREE.PerspectiveCamera,
    viewerRect: DOMRect, cardRect: DOMRect | null) {
    const { w, h } = this;
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
    for (let i = 0; i < this.solid.length; i++) if (this.solid[i]) {
      this.u[i] = 0; this.v[i] = 0; this.dye[i] = 0;
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

  private boundaries() {
    const { w, h, u, v, solid } = this;
    if (this.vertical) {
      for (let x = 0; x < w; x++) {
        const top = x, bottom = (h - 1) * w + x;
        if (this.direction === 1) {
          v[top] = v[top + w] = 1.45 * this.flowSpeed;
          u[top] = u[top + w] = this.flowSpeed * (0.12 * Math.sin(x * 0.075 + this.tick * 0.025)
            + 0.035 * Math.sin(x * 0.17 - this.tick * 0.045));
          v[bottom] = v[bottom - w]; u[bottom] = u[bottom - w];
        } else {
          v[bottom] = v[bottom - w] = -1.45 * this.flowSpeed;
          u[bottom] = u[bottom - w] = this.flowSpeed * (0.12 * Math.sin(x * 0.075 + this.tick * 0.025)
            + 0.035 * Math.sin(x * 0.17 - this.tick * 0.045));
          v[top] = v[top + w]; u[top] = u[top + w];
        }
      }
      for (let y = 0; y < h; y++) {
        u[y * w] = 0; u[y * w + w - 1] = 0;
      }
      for (let i = 0; i < solid.length; i++) if (solid[i]) { u[i] = 0; v[i] = 0; }
      return;
    }
    for (let y = 0; y < h; y++) {
      const left = y * w, right = left + w - 1;
      if (this.direction === 1) {
        u[left] = u[left + 1] = 1.45 * this.flowSpeed;
        v[left] = v[left + 1] = this.flowSpeed * (0.12 * Math.sin(y * 0.075 + this.tick * 0.025)
          + 0.035 * Math.sin(y * 0.17 - this.tick * 0.045));
        u[right] = u[right - 1]; v[right] = v[right - 1];
      } else {
        u[right] = u[right - 1] = -1.45 * this.flowSpeed;
        v[right] = v[right - 1] = this.flowSpeed * (0.12 * Math.sin(y * 0.075 + this.tick * 0.025)
          + 0.035 * Math.sin(y * 0.17 - this.tick * 0.045));
        u[left] = u[left + 1]; v[left] = v[left + 1];
      }
    }
    for (let x = 0; x < w; x++) {
      v[x] = 0; v[(h - 1) * w + x] = 0;
    }
    for (let i = 0; i < solid.length; i++) if (solid[i]) { u[i] = 0; v[i] = 0; }
  }

  private project() {
    const { w, h, u, v, solid, divergence } = this;
    const p = this.pressure;
    p.fill(0);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (solid[i]) { divergence[i] = 0; continue; }
      const r = solid[i + 1] ? 0 : u[i + 1], l = solid[i - 1] ? 0 : u[i - 1];
      const d = solid[i + w] ? 0 : v[i + w], up = solid[i - w] ? 0 : v[i - w];
      divergence[i] = 0.5 * (r - l + d - up);
    }
    let current = p, next = this.pNext;
    for (let iteration = 0; iteration < 24; iteration++) {
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (solid[i]) { next[i] = 0; continue; }
        const center = current[i];
        const left = solid[i - 1] ? center : current[i - 1];
        const right = solid[i + 1] ? center : current[i + 1];
        const up = solid[i - w] ? center : current[i - w];
        const down = solid[i + w] ? center : current[i + w];
        next[i] = (left + right + up + down - divergence[i]) * 0.25;
      }
      [current, next] = [next, current];
    }
    this.pressure = current; this.pNext = next;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (solid[i]) continue;
      u[i] -= 0.5 * ((solid[i + 1] ? current[i] : current[i + 1]) - (solid[i - 1] ? current[i] : current[i - 1]));
      v[i] -= 0.5 * ((solid[i + w] ? current[i] : current[i + w]) - (solid[i - w] ? current[i] : current[i - w]));
      if (solid[i - 1] || solid[i + 1]) u[i] = 0;
      if (solid[i - w] || solid[i + w]) v[i] = 0;
    }
    this.boundaries();
  }

  step() {
    const { w, h, solid } = this;
    if (this.mouse) {
      const { x, y, dx, dy } = this.mouse;
      const radius = 7;
      for (let gy = Math.max(1, Math.floor(y - radius)); gy < Math.min(h - 1, y + radius); gy++)
        for (let gx = Math.max(1, Math.floor(x - radius)); gx < Math.min(w - 1, x + radius); gx++) {
          const i = gy * w + gx;
          if (solid[i]) continue;
          const d2 = (gx - x) ** 2 + (gy - y) ** 2;
          const weight = Math.exp(-d2 / 18);
          this.u[i] += dx * weight * 0.65;
          this.v[i] += dy * weight * 0.65;
          this.dye[i] = Math.min(1.5, this.dye[i] + 0.65 * weight);
        }
      this.mouse = null;
    }
    // Semi-Lagrangian transport of velocity, then incompressible pressure solve.
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (solid[i]) { this.uNext[i] = this.vNext[i] = 0; continue; }
      const bx = x - this.u[i] * 0.9, by = y - this.v[i] * 0.9;
      const back = clamp(Math.round(by), 0, h - 1) * w + clamp(Math.round(bx), 0, w - 1);
      this.uNext[i] = (solid[back] ? this.u[i] : this.sample(this.u, bx, by)) * 0.996
        + (this.vertical ? 0 : 0.006 * this.direction * this.flowSpeed);
      this.vNext[i] = (solid[back] ? this.v[i] : this.sample(this.v, bx, by)) * 0.996
        + (this.vertical ? 0.006 * this.direction * this.flowSpeed : 0);
    }
    [this.u, this.uNext] = [this.uNext, this.u];
    [this.v, this.vNext] = [this.vNext, this.v];
    this.boundaries();
    // Vorticity confinement keeps the wake responsive despite grid diffusion.
    const { curl } = this;
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      curl[i] = solid[i] ? 0 : 0.5 * (this.v[i + 1] - this.v[i - 1] - this.u[i + w] + this.u[i - w]);
    }
    for (let y = 3; y < h - 3; y++) for (let x = 3; x < w - 3; x++) {
      const i = y * w + x;
      if (solid[i]) continue;
      const gx = Math.abs(curl[i + 1]) - Math.abs(curl[i - 1]);
      const gy = Math.abs(curl[i + w]) - Math.abs(curl[i - w]);
      const norm = Math.hypot(gx, gy) + 0.0001;
      this.u[i] += clamp(gy / norm * curl[i] * 0.11, -0.12, 0.12);
      this.v[i] -= clamp(gx / norm * curl[i] * 0.11, -0.12, 0.12);
    }
    this.project();
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      curl[i] = solid[i] ? 0 : 0.5 * (this.v[i + 1] - this.v[i - 1] - this.u[i + w] + this.u[i - w]);
    }

    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (solid[i]) { this.dyeNext[i] = 0; continue; }
      const bx = x - this.u[i] * 0.9, by = y - this.v[i] * 0.9;
      this.dyeNext[i] = this.sample(this.dye, bx, by) * 0.996;
    }
    [this.dye, this.dyeNext] = [this.dyeNext, this.dye];
    const crossSize = this.vertical ? w : h;
    for (let cross = 1; cross < crossSize - 1; cross++) {
      const i = this.vertical
        ? (this.direction === 1 ? w : (h - 2) * w) + cross
        : cross * w + (this.direction === 1 ? 1 : w - 2);
      const ribbon = Math.pow(Math.max(0, Math.sin(cross * 0.19 + this.tick * 0.052)), 8);
      const pulse = 0.6 + 0.4 * Math.sin(cross * 0.11 - this.tick * 0.09);
      this.dye[i] = 0.12 + 0.85 * ribbon * pulse;
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
    const { w, h, solid, pressure, curl, dye, u, v, ctx } = this;
    let maxPressure = 0;
    for (let i = 0; i < pressure.length; i++) if (!solid[i]) maxPressure = Math.max(maxPressure, Math.abs(pressure[i]));
    this.pressureScale = this.pressureScale * 0.94 + Math.max(0.045, maxPressure * 0.28) * 0.06;
    let maxCurl = 0;
    for (let i = 0; i < curl.length; i++) if (!solid[i]) maxCurl = Math.max(maxCurl, Math.abs(curl[i]));
    this.vorticityScale = this.vorticityScale * 0.94 + Math.max(0.035, maxCurl * 0.35) * 0.06;
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
    const inletSpeed = 1.45 * this.flowSpeed;
    const fieldValue = (i: number) => {
      if (this.mode === 'vorticity') return 0.5 + curl[i] / this.vorticityScale * 0.47;
      if (this.mode === 'speed') return Math.hypot(u[i], v[i]) / (inletSpeed * 1.8);
      return 0.5 + pressure[i] / this.pressureScale * 0.47;
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
