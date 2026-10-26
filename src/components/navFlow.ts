// Small D2Q9 lattice-Boltzmann wake behind the EK obstacle.
const W = 148, H = 96, N = W * H;
const VIEW_X = 4, VIEW_W = 96, VIEW_Y = 20, VIEW_H = 56;
const CX = 37, CY = 48, R = 17;
const DX = [0, 1, 0, -1, 0, 1, -1, -1, 1];
const DY = [0, 0, 1, 0, -1, 1, 1, -1, -1];
const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6];
const WT = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
const U = 0.085, OMEGA = 1.85;

export function startNavFlow(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  const image = ctx.createImageData(VIEW_W, VIEW_H);
  const obstacle = new Uint8Array(N);
  const f = new Float32Array(N * 9);
  const next = new Float32Array(N * 9);
  const ux = new Float32Array(N);
  const uy = new Float32Array(N);
  const particles = Array.from({ length: 400 }, (_, i) => ({
    x: (i * 37 % (W - 4)) + 2,
    y: (i * 29 % (H - 6)) + 3 + (i % 7) * 0.11,
    px: 0,
    py: 0,
  }));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    obstacle[p] = ((x - CX) ** 2 + (y - CY) ** 2 < R ** 2) ? 1 : 0;
    const kick = x > CX + R && x < CX + 3 * R
      ? 0.018 * Math.sin((x - CX) * 0.19) * Math.cos((y - CY) * 0.13)
        * Math.exp(-(((y - CY) / 15) ** 2)) : 0;
    for (let k = 0; k < 9; k++) {
      const cu = DX[k] * U + DY[k] * kick;
      f[p * 9 + k] = WT[k] * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * (U * U + kick * kick));
    }
  }
  let step = 0;
  function advance() {
    next.fill(0);
    step++;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (obstacle[p]) continue;
      let rho = 0, vx = 0, vy = 0;
      for (let k = 0; k < 9; k++) {
        const value = f[p * 9 + k];
        rho += value; vx += value * DX[k]; vy += value * DY[k];
      }
      if (!Number.isFinite(rho) || rho < 0.5 || rho > 1.5) rho = 1;
      vx = Math.max(-0.2, Math.min(0.2, vx / rho));
      vy = Math.max(-0.2, Math.min(0.2, vy / rho));
      ux[p] = vx; uy[p] = vy;
      const v2 = vx * vx + vy * vy;
      for (let k = 0; k < 9; k++) {
        const dot = DX[k] * vx + DY[k] * vy;
        const eq = WT[k] * rho * (1 + 3 * dot + 4.5 * dot * dot - 1.5 * v2);
        const post = f[p * 9 + k] + OMEGA * (eq - f[p * 9 + k]);
        const nx = x + DX[k];
        if (nx < 0 || nx >= W) continue;
        const ny = (y + DY[k] + H) % H;
        const q = ny * W + nx;
        if (obstacle[q]) next[p * 9 + OPP[k]] += post;
        else next[q * 9 + k] += post;
      }
    }
    for (let y = 0; y < H; y++) {
      const p = y * W;
      const inflow = U;
      const crossflow = 0.004 * Math.sin(step * 0.035 + y * 0.11);
      for (let k = 0; k < 9; k++) {
        const dot = DX[k] * inflow + DY[k] * crossflow;
        next[p * 9 + k] = WT[k] * (1 + 3 * dot + 4.5 * dot * dot - 1.5 * (inflow * inflow + crossflow * crossflow));
        next[(p + W - 1) * 9 + k] = next[(p + W - 2) * 9 + k];
      }
    }
    f.set(next);
  }
  function draw() {
    const data = image.data;
    for (let y = 0; y < VIEW_H; y++) for (let x = 0; x < VIEW_W; x++) {
      const simX = x + VIEW_X;
      const simY = y + VIEW_Y;
      const p = simY * W + simX, a = (y * VIEW_W + x) * 4;
      if (obstacle[p]) {
        data[a + 3] = 0; continue;
      }
      const up = (simY - 1) * W + simX;
      const down = (simY + 1) * W + simX;
      const curl = (uy[p + 1] - uy[p - 1] - ux[down] + ux[up]) * 0.5;
      const magnitude = Math.min(1, Math.abs(curl) * 38);
      if (curl >= 0) { data[a] = 195; data[a + 1] = 140; data[a + 2] = 105; }
      else { data[a] = 77; data[a + 1] = 134; data[a + 2] = 162; }
      data[a + 3] = Math.round(180 * magnitude);
    }
    ctx!.putImageData(image, 0, 0);
    ctx!.lineWidth = 0.9;
    ctx!.lineCap = 'round';
    for (const particle of particles) {
      if (particle.x < VIEW_X || particle.x >= VIEW_X + VIEW_W || particle.y < VIEW_Y || particle.y >= VIEW_Y + VIEW_H) continue;
      const p = Math.floor(particle.y) * W + Math.floor(particle.x);
      const up = ((Math.floor(particle.y) + H - 1) % H) * W + Math.floor(particle.x);
      const down = ((Math.floor(particle.y) + 1) % H) * W + Math.floor(particle.x);
      const curl = (uy[p + 1] - uy[p - 1] - ux[down] + ux[up]) * 0.5;
      ctx!.strokeStyle = curl >= 0 ? 'rgba(223,171,130,.58)' : 'rgba(135,181,193,.58)';
      ctx!.beginPath();
      ctx!.moveTo(particle.px - VIEW_X, particle.py - VIEW_Y);
      ctx!.lineTo(particle.x - VIEW_X, particle.y - VIEW_Y);
      ctx!.stroke();
    }
  }
  function moveParticles() {
    for (const particle of particles) {
      const x = Math.floor(particle.x), y = Math.floor(particle.y);
      const p = y * W + x;
      if (x < 2 || x >= W - 2 || y < 2 || y >= H - 2 || obstacle[p]) {
        particle.x = 2;
        particle.y = 3 + Math.random() * (H - 6);
        particle.px = particle.x;
        particle.py = particle.y;
        continue;
      }
      particle.x += ux[p];
      particle.y += uy[p];
    }
  }
  let frame = 0;
  let last = 0;
  let stopped = false;
  function tick(time: number) {
    if (stopped) return;
    if (time - last > 32) {
      if (step % 28 === 0) {
        for (const particle of particles) { particle.px = particle.x; particle.py = particle.y; }
      }
      for (let i = 0; i < 7; i++) { advance(); moveParticles(); }
      draw();
      last = time;
    }
    frame = requestAnimationFrame(tick);
  }
  frame = requestAnimationFrame(tick);
  return () => { stopped = true; cancelAnimationFrame(frame); };
}
