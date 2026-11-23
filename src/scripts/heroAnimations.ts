export function initHeroAnimation(type: string, canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d')!;
  if (!ctx) return () => {};

  let _rafId = -1;
  /** Setting canvas.width wipes the bitmap, so a finished still frame must paint again. */
  let wiped = false;

  const resize = () => {
    canvas.width = canvas.offsetWidth * window.devicePixelRatio;
    canvas.height = canvas.offsetHeight * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    wiped = true;
  };
  resize();
  window.addEventListener('resize', resize);

  const W = () => canvas.offsetWidth;
  const H = () => canvas.offsetHeight;

  const animators: Record<string, () => void> = {
    'lattice': animateLattice,
    'ion-thruster': animatePlasmaPlume,
    'sailing-rl': animateCFD,
    'solar-car': animateSolarCar,
    '3d-plane': animatePlane,
    'light-switch': animateCircuit,
    'rocketry': animateRocket,
    'polymarket': animateDistributions,
  };

  const animator = animators[type];
  if (animator) animator();

  return () => {
    cancelAnimationFrame(_rafId);
    window.removeEventListener('resize', resize);
  };

  function animateLattice() {
    const particles = Array.from({ length: 600 }, () => ({
      x: Math.random() * W(), y: Math.random() * H(), z: Math.random(),
      r: Math.floor(Math.random() * 45 + 125),
      g: Math.floor(Math.random() * 55 + 165),
      b: Math.floor(Math.random() * 45 + 165),
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
    }));
    let t = 0;
    const draw = () => {
      ctx.fillStyle = 'rgba(13,25,31,0.15)';
      ctx.fillRect(0, 0, W(), H());
      t += 0.005;
      for (const p of particles) {
        p.x += p.vx + Math.sin(t + p.z * 3) * 0.2;
        p.y += p.vy + Math.cos(t + p.z * 2) * 0.15;
        if (p.x < 0) p.x = W(); if (p.x > W()) p.x = 0;
        if (p.y < 0) p.y = H(); if (p.y > H()) p.y = 0;
        const alpha = 0.4 + p.z * 0.6;
        const size = 1 + p.z * 2;
        ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${alpha})`;
        ctx.fillRect(p.x, p.y, size, size);
      }
      _rafId = requestAnimationFrame(draw);
    };
    draw();
  }

  function animatePlasmaPlume() {
    interface Particle { x:number; y:number; vx:number; vy:number; life:number; maxLife:number; }
    const particles: Particle[] = [];
    const spawn = () => {
      const cx = W() * 0.15, cy = H() * 0.5;
      for (let i = 0; i < 4; i++) {
        particles.push({
          x: cx, y: cy + (Math.random() - 0.5) * 20,
          vx: 3 + Math.random() * 4,
          vy: (Math.random() - 0.5) * 1.5,
          life: 0, maxLife: 80 + Math.random() * 60,
        });
      }
    };
    let frame = 0;
    const draw = () => {
      frame++;
      if (frame % 2 === 0) spawn();
      ctx.fillStyle = 'rgba(13,25,31,0.25)';
      ctx.fillRect(0, 0, W(), H());
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx; p.y += p.vy; p.life++;
        if (p.life > p.maxLife) { particles.splice(i, 1); continue; }
        const t = p.life / p.maxLife;
        const alpha = (1 - t) * 0.8;
        const size = (1 - t) * 8 + 1;
        const r = 150, g = 191, b = 191;
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        ctx.fill();
      }

      _rafId = requestAnimationFrame(draw);
    };
    draw();
  }

  function animateCFD() {
    const lines = Array.from({ length: 30 }, (_, i) => ({
      y: (H() / 31) * (i + 1),
      phase: Math.random() * Math.PI * 2,
      speed: 0.5 + Math.random() * 0.8,
      amp: 5 + Math.random() * 20,
    }));
    let t = 0;
    const draw = () => {
      ctx.fillStyle = 'rgba(13,25,31,0.12)';
      ctx.fillRect(0, 0, W(), H());
      t += 0.01;
      for (const line of lines) {
        ctx.beginPath();
        for (let x = 0; x < W(); x += 4) {
          const foilX = W() * 0.4, foilY = H() / 2;
          const dx = x - foilX, dy = line.y - foilY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const deflect = dist < 80 ? (dy / dist) * (80 - dist) * 0.3 : 0;
          const wave = Math.sin(x * 0.02 + t * line.speed + line.phase) * line.amp;
          const y = line.y + wave + deflect;
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `rgba(130,190,192,0.35)`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      _rafId = requestAnimationFrame(draw);
    };
    draw();
  }

  function animateSolarCar() {
    let carX = -200;
    const carY = H() * 0.65;
    const drawCar = (x: number, y: number) => {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 60, y);
      ctx.lineTo(x + 75, y - 18);
      ctx.lineTo(x + 130, y - 18);
      ctx.lineTo(x + 145, y);
      ctx.lineTo(x + 160, y);
      ctx.lineTo(x + 160, y + 10);
      ctx.lineTo(x, y + 10);
      ctx.closePath();
      ctx.fillStyle = 'rgba(130,190,192,0.7)';
      ctx.fill();
      ctx.fillStyle = 'rgba(129,153,156,0.6)';
      ctx.fillRect(x + 78, y - 16, 49, 10);
      ctx.fillStyle = 'rgba(200,200,220,0.5)';
      ctx.beginPath(); ctx.arc(x + 35, y + 14, 12, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + 125, y + 14, 12, 0, Math.PI * 2); ctx.fill();
    };
    const drawGround = () => {
      ctx.fillStyle = 'rgba(26,43,49,0.7)';
      ctx.fillRect(0, H() * 0.65 + 26, W(), H());
    };
    const draw = () => {
      ctx.fillStyle = 'rgba(13,25,31,0.2)';
      ctx.fillRect(0, 0, W(), H());
      drawGround();
      ctx.fillStyle = 'rgba(130,190,192,0.06)';
      ctx.fillRect(carX - 80, carY - 20, 80, 50);
      drawCar(carX, carY);
      carX += 1.2;
      if (carX > W() + 200) carX = -200;
      _rafId = requestAnimationFrame(draw);
    };
    draw();
  }

  function animatePlane() {
    let planeX = -150, planeY = H() * 0.4;
    let targetY = H() * 0.4;
    let vy = 0;
    const drawPlane = (x: number, y: number, tilt: number) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(tilt);
      ctx.fillStyle = 'rgba(185,208,207,0.85)';
      ctx.beginPath();
      ctx.moveTo(-60, -5); ctx.lineTo(60, -5);
      ctx.lineTo(70, 0); ctx.lineTo(60, 5);
      ctx.lineTo(-60, 5); ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, -5); ctx.lineTo(-20, -40);
      ctx.lineTo(-5, -40); ctx.lineTo(20, -5);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, 5); ctx.lineTo(-20, 40);
      ctx.lineTo(-5, 40); ctx.lineTo(20, 5);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-50, -5); ctx.lineTo(-65, -22);
      ctx.lineTo(-55, -22); ctx.lineTo(-40, -5);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    };
    let t = 0;
    const draw = () => {
      ctx.fillStyle = 'rgba(13,25,31,0.15)';
      ctx.fillRect(0, 0, W(), H());
      t += 0.02;
      targetY = H() * 0.4 + Math.sin(t * 0.7) * H() * 0.15;
      vy += (targetY - planeY) * 0.02;
      vy *= 0.95;
      planeY += vy;
      const tilt = vy * 0.015;
      ctx.strokeStyle = 'rgba(185,208,207,0.15)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(planeX - 60, planeY);
      ctx.lineTo(planeX - 200, planeY - vy * 5);
      ctx.stroke();
      drawPlane(planeX, planeY, tilt);
      planeX += 1.5;
      if (planeX > W() + 150) planeX = -150;
      _rafId = requestAnimationFrame(draw);
    };
    draw();
  }

  function animateCircuit() {
    const nodes = [
      { x: 0.1, y: 0.5 }, { x: 0.3, y: 0.3 }, { x: 0.3, y: 0.7 },
      { x: 0.5, y: 0.5 }, { x: 0.7, y: 0.3 }, { x: 0.7, y: 0.7 }, { x: 0.9, y: 0.5 }
    ].map(n => ({ x: W() * n.x, y: H() * n.y }));
    const edges: [number, number][] = [[0,1],[0,2],[1,3],[2,3],[3,4],[3,5],[4,6],[5,6]];
    const pulses: { edge: number; t: number; speed: number }[] = [];
    setInterval(() => {
      pulses.push({ edge: Math.floor(Math.random() * edges.length), t: 0, speed: 0.015 + Math.random() * 0.01 });
    }, 300);
    const draw = () => {
      ctx.fillStyle = 'rgba(13,25,31,0.2)';
      ctx.fillRect(0, 0, W(), H());
      for (const [a, b] of edges) {
        ctx.strokeStyle = 'rgba(130,190,192,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(nodes[a].x, nodes[a].y);
        ctx.lineTo(nodes[b].x, nodes[b].y);
        ctx.stroke();
      }
      for (const n of nodes) {
        ctx.fillStyle = 'rgba(130,190,192,0.4)';
        ctx.beginPath(); ctx.arc(n.x, n.y, 4, 0, Math.PI * 2); ctx.fill();
      }
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i];
        p.t += p.speed;
        if (p.t > 1) { pulses.splice(i, 1); continue; }
        const [a, b] = edges[p.edge];
        const px = nodes[a].x + (nodes[b].x - nodes[a].x) * p.t;
        const py = nodes[a].y + (nodes[b].y - nodes[a].y) * p.t;
        ctx.fillStyle = 'rgba(153,190,169,0.9)';

        ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();

      }
      _rafId = requestAnimationFrame(draw);
    };
    draw();
  }

  function animateRocket() {
    let rocketY = H() + 80;
    let vy = -1;
    const drawExhaust = (x: number, y: number) => {
      for (let i = 0; i < 5; i++) {
        const spread = (Math.random() - 0.5) * 30;
        const length = 20 + Math.random() * 40;
        ctx.strokeStyle = 'rgba(213,167,117,0.55)';
        ctx.lineWidth = 2 + Math.random() * 3;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + spread * 0.5, y + length * 0.6, x + spread, y + length);
        ctx.stroke();
      }
    };
    const drawRocket = (x: number, y: number) => {
      ctx.fillStyle = 'rgba(185,208,207,0.9)';
      ctx.beginPath();
      ctx.moveTo(x, y - 40); ctx.lineTo(x - 10, y); ctx.lineTo(x + 10, y);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x - 10, y); ctx.lineTo(x - 20, y + 20); ctx.lineTo(x - 10, y + 10);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x + 10, y); ctx.lineTo(x + 20, y + 20); ctx.lineTo(x + 10, y + 10);
      ctx.closePath(); ctx.fill();
    };
    const draw = () => {
      ctx.fillStyle = 'rgba(13,25,31,0.2)';
      ctx.fillRect(0, 0, W(), H());
      vy -= 0.003;
      rocketY += vy;
      const rx = W() * 0.5;
      if (rocketY < -100) { rocketY = H() + 80; vy = -1; }
      drawExhaust(rx, rocketY + 10);
      drawRocket(rx, rocketY);
      _rafId = requestAnimationFrame(draw);
    };
    draw();
  }

  // A real snapshot from the bot, 84 h before the "Elon Musk # tweets
  // Oct 30 - Nov 6, 2026" market closed. Market: bracket mid prices,
  // normalised, plus the normal with their mean and sd. Model: the bot's
  // normal (truncated at 174 tweets so far, far below the plotted range).
  // The market resolved at 315. Colours follow the bot's Railway dashboard.
  function animateDistributions() {
    const MODEL = { mu: 345.6, sd: 32.1 };
    const MARKET = { mu: 352.4, sd: 56.9 };
    const RESULT = 315;
    const PRICE_SUM = 0.934;
    // [bracket lower bound, mid price]; 440-459 had no quote, so no bar.
    const BRACKETS: [number, number][] = [
      [180, 0.001], [200, 0.0154], [220, 0.0175], [240, 0.018], [260, 0.03],
      [280, 0.0695], [300, 0.105], [320, 0.115], [340, 0.135], [360, 0.125],
      [380, 0.122], [400, 0.0992], [420, 0.0488], [460, 0.019], [500, 0.008],
      [520, 0.004],
    ];
    const X0 = 200, X1 = 500;
    const pdf = (x: number, mu: number, sd: number) =>
      Math.exp(-0.5 * ((x - mu) / sd) ** 2) / (sd * Math.sqrt(2 * Math.PI));
    const ease = (k: number) => 1 - (1 - k) ** 3;
    const start = performance.now();
    let done = false, lastW = 0, lastH = 0;

    const draw = () => {
      const w = W(), h = H();
      const k = ease(Math.min(1, (performance.now() - start) / 900));
      if (done && !wiped && w === lastW && h === lastH) { _rafId = requestAnimationFrame(draw); return; }
      done = k === 1; lastW = w; lastH = h; wiped = false;

      ctx.fillStyle = '#0b1120';
      ctx.fillRect(0, 0, w, h);

      const padX = w * 0.07, top = h * 0.24, base = h * 0.8;
      const plotW = w - padX * 2;
      const px = (x: number) => padX + ((x - X0) / (X1 - X0)) * plotW;
      const peak = pdf(0, 0, MODEL.sd);
      const py = (d: number) => base - (d / peak) * (base - top) * 0.95 * k;
      const fs = Math.max(10, Math.min(13, w / 32));

      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      for (let i = 1; i < 4; i++) {
        const y = top + ((base - top) / 4) * i;
        ctx.beginPath(); ctx.moveTo(padX, y); ctx.lineTo(w - padX, y); ctx.stroke();
      }
      for (let x = 250; x < X1; x += 50) {
        ctx.beginPath(); ctx.moveTo(px(x), top); ctx.lineTo(px(x), base); ctx.stroke();
      }
      ctx.setLineDash([]);

      // Market prices as bars (probability per tweet, same units as the curves).
      ctx.fillStyle = 'rgba(148, 163, 184, 0.16)';
      for (const [lo, price] of BRACKETS) {
        if (lo < X0 || lo >= X1) continue;
        const y = py(price / PRICE_SUM / 20);
        ctx.fillRect(px(lo) + 1, y, px(lo + 20) - px(lo) - 2, base - y);
      }

      const N = 200;
      const xs = Array.from({ length: N + 1 }, (_, i) => X0 + ((X1 - X0) * i) / N);

      // Edge: where the model puts more weight than the market does.
      ctx.fillStyle = 'rgba(52, 211, 153, 0.32)';
      ctx.beginPath();
      xs.forEach(x => ctx.lineTo(px(x), py(Math.max(pdf(x, MODEL.mu, MODEL.sd), pdf(x, MARKET.mu, MARKET.sd)))));
      [...xs].reverse().forEach(x => ctx.lineTo(px(x), py(pdf(x, MARKET.mu, MARKET.sd))));
      ctx.closePath();
      ctx.fill();

      const curve = (mu: number, sd: number) => {
        ctx.beginPath();
        xs.forEach((x, i) => {
          const y = py(pdf(x, mu, sd));
          if (i === 0) ctx.moveTo(px(x), y); else ctx.lineTo(px(x), y);
        });
      };
      curve(MARKET.mu, MARKET.sd);
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      curve(MODEL.mu, MODEL.sd);
      ctx.strokeStyle = '#818cf8';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Where the market actually resolved.
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(px(RESULT), top - fs * 0.2); ctx.lineTo(px(RESULT), base); ctx.stroke();
      ctx.setLineDash([]);

      ctx.strokeStyle = '#334155';
      ctx.beginPath(); ctx.moveTo(padX, base); ctx.lineTo(w - padX, base); ctx.stroke();

      ctx.font = `500 ${fs}px Inter, system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#64748b';
      for (let x = 250; x < X1; x += 50) ctx.fillText(String(x), px(x), base + fs * 1.2);
      ctx.fillStyle = '#fbbf24';
      ctx.textAlign = 'right';
      ctx.fillText(`Result ${RESULT}`, px(RESULT) - fs * 0.4, top);
      ctx.textAlign = 'left';

      // Legend
      const ly = h * 0.11;
      let lx = padX;
      const key = (label: string, color: string, dashed: boolean) => {
        ctx.strokeStyle = color; ctx.lineWidth = 2;
        ctx.setLineDash(dashed ? [4, 3] : []);
        ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + fs * 1.4, ly); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#cbd5e1';
        ctx.fillText(label, lx + fs * 1.9, ly);
        lx += fs * 1.9 + ctx.measureText(label).width + fs * 1.6;
      };
      key('Market', '#94a3b8', true);
      key('Model', '#818cf8', false);
      ctx.fillStyle = 'rgba(52, 211, 153, 0.55)';
      ctx.fillRect(lx, ly - fs * 0.4, fs * 0.8, fs * 0.8);
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText('Edge', lx + fs * 1.3, ly);

      _rafId = requestAnimationFrame(draw);
    };
    draw();
  }
}
