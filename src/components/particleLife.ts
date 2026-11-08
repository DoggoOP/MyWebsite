export const SPECIES = [
  { name: 'Cyan', color: '#67d9df' },
  { name: 'Copper', color: '#e79b70' },
  { name: 'Lime', color: '#d7e972' },
  { name: 'Violet', color: '#af9df1' },
  { name: 'Rose', color: '#ed84b7' },
  { name: 'Mint', color: '#8cdbad' },
] as const;

export const DEFAULT_FORCES = [
  [0.12, 0.78, -0.42, 0.28, -0.50, 0.14],
  [-0.35, 0.10, 0.74, -0.45, 0.30, -0.25],
  [0.28, -0.48, 0.12, 0.80, -0.40, 0.24],
  [-0.40, 0.22, -0.46, 0.10, 0.76, -0.32],
  [0.22, -0.39, 0.12, -0.52, 0.12, 0.76],
  [0.78, -0.33, -0.36, 0.18, -0.50, 0.10],
];

type Particle = { x: number; y: number; px: number; py: number; vx: number; vy: number; type: number };
type ObstacleMask = { solid: Uint8Array; w: number; h: number };
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** Local pair forces make the patterns. No paths, clusters or vortices are prescribed. */
export class ParticleLife {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private particles: Particle[] = [];
  private mask: ObstacleMask | null = null;
  private forces = DEFAULT_FORCES.map(row => [...row]);
  private count = 1300;
  private requestedCount = 1300;
  private radius = 58;
  private strength = 1;
  private friction = 0.08;
  private pointer: { x: number; y: number; dx: number; dy: number } | null = null;
  private lastPointer: { x: number; y: number } | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize() {
    const oldW = this.width, oldH = this.height;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    if (oldW && oldH) for (const particle of this.particles) {
      particle.x *= this.width / oldW;
      particle.y *= this.height / oldH;
      particle.px = particle.x;
      particle.py = particle.y;
    }
    this.applyCount();
  }

  setObstacles(mask: ObstacleMask) {
    this.mask = mask;
    for (const particle of this.particles) if (this.isSolid(particle.x, particle.y)) {
      const point = this.freePoint();
      particle.x = particle.px = point.x;
      particle.y = particle.py = point.y;
    }
  }

  setCount(count: number) {
    this.requestedCount = Math.round(clamp(count, 300, 3000));
    this.applyCount();
  }

  private applyCount() {
    this.count = this.width < 700 ? Math.min(this.requestedCount, 760) : this.requestedCount;
    while (this.particles.length > this.count) this.particles.pop();
    while (this.particles.length < this.count) {
      const point = this.freePoint();
      const type = this.particles.length % SPECIES.length;
      this.particles.push({ x: point.x, y: point.y, px: point.x, py: point.y,
        vx: (Math.random() - 0.5) * 0.7, vy: (Math.random() - 0.5) * 0.7, type });
    }
  }

  setRadius(radius: number) { this.radius = clamp(radius, 25, 100); }
  setStrength(strength: number) { this.strength = clamp(strength, 0.2, 2); }
  setFriction(friction: number) { this.friction = clamp(friction, 0.02, 0.4); }
  setForce(from: number, to: number, value: number) {
    this.forces[from][to] = clamp(value, -1, 1);
  }

  pointerMove(x: number, y: number) {
    const dx = this.lastPointer ? clamp(x - this.lastPointer.x, -45, 45) : 0;
    const dy = this.lastPointer ? clamp(y - this.lastPointer.y, -45, 45) : 0;
    if (this.pointer) {
      this.pointer.x = x; this.pointer.y = y;
      this.pointer.dx = clamp(this.pointer.dx + dx, -65, 65);
      this.pointer.dy = clamp(this.pointer.dy + dy, -65, 65);
    } else this.pointer = { x, y, dx, dy };
    this.lastPointer = { x, y };
  }

  pointerLeave() { this.pointer = null; this.lastPointer = null; }

  private isSolid(x: number, y: number) {
    const mask = this.mask;
    if (!mask) return false;
    const gx = clamp(Math.floor(x / this.width * mask.w), 0, mask.w - 1);
    const gy = clamp(Math.floor(y / this.height * mask.h), 0, mask.h - 1);
    return mask.solid[gy * mask.w + gx] !== 0;
  }

  private freePoint() {
    for (let attempt = 0; attempt < 80; attempt++) {
      const x = 8 + Math.random() * Math.max(1, this.width - 16);
      const y = 64 + Math.random() * Math.max(1, this.height - 128);
      if (!this.isSolid(x, y)) return { x, y };
    }
    return { x: this.width * 0.5, y: this.height * 0.5 };
  }

  step() {
    const particles = this.particles;
    const radius = this.radius;
    const columns = Math.ceil(this.width / radius);
    const rows = Math.ceil(this.height / radius);
    const heads = new Int32Array(columns * rows).fill(-1);
    const next = new Int32Array(particles.length);
    const ax = new Float32Array(particles.length);
    const ay = new Float32Array(particles.length);
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const col = clamp(Math.floor(p.x / radius), 0, columns - 1);
      const row = clamp(Math.floor(p.y / radius), 0, rows - 1);
      const cell = row * columns + col;
      next[i] = heads[cell];
      heads[cell] = i;
    }
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const col = clamp(Math.floor(p.x / radius), 0, columns - 1);
      const row = clamp(Math.floor(p.y / radius), 0, rows - 1);
      let fx = 0, fy = 0;
      for (let cy = Math.max(0, row - 1); cy <= Math.min(rows - 1, row + 1); cy++)
        for (let cx = Math.max(0, col - 1); cx <= Math.min(columns - 1, col + 1); cx++)
          for (let j = heads[cy * columns + cx]; j !== -1; j = next[j]) {
            if (i === j) continue;
            const other = particles[j];
            const dx = other.x - p.x, dy = other.y - p.y;
            const d2 = dx * dx + dy * dy;
            // Species pairs interact over different ranges. This keeps the
            // default state from settling into one regularly spaced ring.
            const reach = radius * (0.82 + ((p.type * 7 + other.type * 11) % 7) * 0.03);
            if (d2 < 0.01 || d2 >= reach * reach) continue;
            const d = Math.sqrt(d2);
            const near = Math.min(15, reach * 0.32);
            const magnitude = d < near
              ? -2.1 * (1 - d / near)
              : this.forces[p.type][other.type] * Math.sin(Math.PI * (d - near) / (reach - near));
            fx += dx / d * magnitude;
            fy += dy / d * magnitude;
          }
      ax[i] = fx * this.strength * 0.11;
      ay[i] = fy * this.strength * 0.11;
    }
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.px = p.x; p.py = p.y;
      let fx = ax[i], fy = ay[i];
      if (this.pointer) {
        const dx = p.x - this.pointer.x, dy = p.y - this.pointer.y;
        const distance = Math.hypot(dx, dy);
        if (distance < 130) {
          const weight = (1 - distance / 130) ** 2;
          fx += (dx / (distance + 1) * 0.9 + this.pointer.dx * 0.065) * weight;
          fy += (dy / (distance + 1) * 0.9 + this.pointer.dy * 0.065) * weight;
        }
      }
      p.vx = clamp((p.vx + fx) * (1 - this.friction), -6, 6);
      p.vy = clamp((p.vy + fy) * (1 - this.friction), -6, 6);
      let nx = p.x + p.vx, ny = p.y + p.vy;
      if (nx < 3 || nx > this.width - 3) { p.vx *= -0.65; nx = clamp(nx, 3, this.width - 3); }
      if (ny < 57 || ny > this.height - 55) { p.vy *= -0.65; ny = clamp(ny, 57, this.height - 55); }
      if (this.isSolid(nx, ny)) {
        // Try the two slide directions before reflecting from the silhouette.
        if (!this.isSolid(nx, p.y)) { ny = p.y; p.vy *= -0.45; }
        else if (!this.isSolid(p.x, ny)) { nx = p.x; p.vx *= -0.45; }
        else { nx = p.x; ny = p.y; p.vx *= -0.6; p.vy *= -0.6; }
      }
      p.x = nx; p.y = ny;
    }
    if (this.pointer) { this.pointer.dx *= 0.35; this.pointer.dy *= 0.35; }
    this.draw();
  }

  private draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.lineCap = 'round';
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      const color = SPECIES[p.type].color;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.35, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
