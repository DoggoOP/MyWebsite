export function initHeroAnimation(type: string, canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};

  let _rafId = -1;

  const resize = () => {
    canvas.width = canvas.offsetWidth * window.devicePixelRatio;
    canvas.height = canvas.offsetHeight * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  };
  resize();
  window.addEventListener('resize', resize);

  const W = () => canvas.offsetWidth;
  const H = () => canvas.offsetHeight;

  const animators: Record<string, () => void> = {
    'tempo': animateTempo,
    'ion-thruster': animatePlasmaPlume,
    'sailing-rl': animateCFD,
    'solar-car': animateSolarCar,
    '3d-plane': animatePlane,
    'skrunners': animateDelivery,
    'light-switch': animateCircuit,
    'rocketry': animateRocket,
    'polymarket': animateCandlestick,
  };

  const animator = animators[type];
  if (animator) animator();

  return () => {
    cancelAnimationFrame(_rafId);
    window.removeEventListener('resize', resize);
  };

  function animateTempo() {
    const particles = Array.from({ length: 600 }, () => ({
      x: Math.random() * W(), y: Math.random() * H(), z: Math.random(),
      r: Math.floor(Math.random() * 80 + 120),
      g: Math.floor(Math.random() * 80 + 140),
      b: Math.floor(Math.random() * 150 + 100),
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
    }));
    let t = 0;
    const draw = () => {
      ctx.fillStyle = 'rgba(5,5,10,0.15)';
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
      ctx.fillStyle = 'rgba(5,5,15,0.25)';
      ctx.fillRect(0, 0, W(), H());
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx; p.y += p.vy; p.life++;
        if (p.life > p.maxLife) { particles.splice(i, 1); continue; }
        const t = p.life / p.maxLife;
        const alpha = (1 - t) * 0.8;
        const size = (1 - t) * 8 + 1;
        const r = Math.floor(80 + (1 - t) * 175);
        const g = Math.floor(t < 0.5 ? 200 + t * 55 : 255 - (t - 0.5) * 200);
        const b = 255;
        ctx.shadowBlur = 12; ctx.shadowColor = `rgba(${r},${g},${b},0.6)`;
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
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
      ctx.fillStyle = 'rgba(5,8,18,0.12)';
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
        ctx.strokeStyle = `rgba(0,${Math.floor(180 + line.speed * 40)},${Math.floor(200 + line.speed * 55)},0.35)`;
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
      ctx.fillStyle = 'rgba(0,212,255,0.7)';
      ctx.fill();
      ctx.fillStyle = 'rgba(123,47,247,0.6)';
      ctx.fillRect(x + 78, y - 16, 49, 10);
      ctx.fillStyle = 'rgba(200,200,220,0.5)';
      ctx.beginPath(); ctx.arc(x + 35, y + 14, 12, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + 125, y + 14, 12, 0, Math.PI * 2); ctx.fill();
    };
    const drawGround = () => {
      const grad = ctx.createLinearGradient(0, H() * 0.65, 0, H());
      grad.addColorStop(0, 'rgba(20,20,35,0.8)');
      grad.addColorStop(1, 'rgba(5,5,15,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, H() * 0.65 + 26, W(), H());
    };
    const draw = () => {
      ctx.fillStyle = 'rgba(5,5,15,0.2)';
      ctx.fillRect(0, 0, W(), H());
      drawGround();
      const grad = ctx.createLinearGradient(carX - 80, 0, carX, 0);
      grad.addColorStop(0, 'rgba(0,212,255,0)');
      grad.addColorStop(1, 'rgba(0,212,255,0.08)');
      ctx.fillStyle = grad;
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
      ctx.fillStyle = 'rgba(180,210,255,0.85)';
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
      ctx.fillStyle = 'rgba(5,5,15,0.15)';
      ctx.fillRect(0, 0, W(), H());
      t += 0.02;
      targetY = H() * 0.4 + Math.sin(t * 0.7) * H() * 0.15;
      vy += (targetY - planeY) * 0.02;
      vy *= 0.95;
      planeY += vy;
      const tilt = vy * 0.015;
      ctx.strokeStyle = 'rgba(200,220,255,0.15)';
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

  function animateDelivery() {
    const drawCity = () => {
      ctx.strokeStyle = 'rgba(0,212,255,0.08)';
      ctx.lineWidth = 1;
      for (let x = 0; x < W(); x += 60) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H()); ctx.stroke();
      }
      for (let y = 0; y < H(); y += 60) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W(), y); ctx.stroke();
      }
    };
    const waypoints = [
      { x: W() * 0.1, y: H() * 0.8 },
      { x: W() * 0.3, y: H() * 0.8 },
      { x: W() * 0.3, y: H() * 0.4 },
      { x: W() * 0.6, y: H() * 0.4 },
      { x: W() * 0.6, y: H() * 0.6 },
      { x: W() * 0.8, y: H() * 0.6 },
    ];
    let progress = 0;
    const draw = () => {
      ctx.fillStyle = 'rgba(5,8,18,0.2)';
      ctx.fillRect(0, 0, W(), H());
      drawCity();
      progress = (progress + 0.003) % 1;
      const totalPoints = waypoints.length - 1;
      const seg = Math.floor(progress * totalPoints);
      const t = (progress * totalPoints) % 1;
      const from = waypoints[Math.min(seg, waypoints.length - 1)];
      const to = waypoints[Math.min(seg + 1, waypoints.length - 1)];
      const rx = from.x + (to.x - from.x) * t;
      const ry = from.y + (to.y - from.y) * t;
      ctx.strokeStyle = 'rgba(0,212,255,0.5)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(waypoints[0].x, waypoints[0].y);
      for (const wp of waypoints.slice(1)) ctx.lineTo(wp.x, wp.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(0,255,170,0.9)';
      ctx.shadowBlur = 12; ctx.shadowColor = '#00ffaa';
      ctx.beginPath(); ctx.arc(rx, ry, 6, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      for (const wp of [waypoints[0], waypoints[waypoints.length - 1]]) {
        ctx.fillStyle = 'rgba(123,47,247,0.7)';
        ctx.beginPath(); ctx.arc(wp.x, wp.y, 5, 0, Math.PI * 2); ctx.fill();
      }
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
      ctx.fillStyle = 'rgba(5,5,15,0.2)';
      ctx.fillRect(0, 0, W(), H());
      for (const [a, b] of edges) {
        ctx.strokeStyle = 'rgba(0,212,255,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(nodes[a].x, nodes[a].y);
        ctx.lineTo(nodes[b].x, nodes[b].y);
        ctx.stroke();
      }
      for (const n of nodes) {
        ctx.fillStyle = 'rgba(0,212,255,0.4)';
        ctx.beginPath(); ctx.arc(n.x, n.y, 4, 0, Math.PI * 2); ctx.fill();
      }
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i];
        p.t += p.speed;
        if (p.t > 1) { pulses.splice(i, 1); continue; }
        const [a, b] = edges[p.edge];
        const px = nodes[a].x + (nodes[b].x - nodes[a].x) * p.t;
        const py = nodes[a].y + (nodes[b].y - nodes[a].y) * p.t;
        ctx.fillStyle = 'rgba(0,255,170,0.9)';
        ctx.shadowBlur = 10; ctx.shadowColor = '#00ffaa';
        ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
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
        const grad = ctx.createLinearGradient(x + spread * 0.2, y, x + spread, y + length);
        grad.addColorStop(0, 'rgba(255,220,80,0.8)');
        grad.addColorStop(0.5, 'rgba(255,100,20,0.4)');
        grad.addColorStop(1, 'rgba(123,47,247,0)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2 + Math.random() * 3;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + spread * 0.5, y + length * 0.6, x + spread, y + length);
        ctx.stroke();
      }
    };
    const drawRocket = (x: number, y: number) => {
      ctx.fillStyle = 'rgba(200,210,255,0.9)';
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
      ctx.fillStyle = 'rgba(5,5,15,0.2)';
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

  function animateCandlestick() {
    const candles: { open: number; close: number; high: number; low: number }[] = [];
    const maxCandles = Math.floor(W() / 22);
    let price = 0.5;
    const addCandle = () => {
      const open = price;
      const change = (Math.random() - 0.48) * 0.08;
      price = Math.max(0.05, Math.min(0.95, price + change));
      const close = price;
      const high = Math.max(open, close) + Math.random() * 0.03;
      const low = Math.min(open, close) - Math.random() * 0.03;
      candles.push({ open, close, high, low });
      if (candles.length > maxCandles) candles.shift();
    };
    for (let i = 0; i < maxCandles; i++) addCandle();
    let frame = 0;
    const draw = () => {
      frame++;
      if (frame % 45 === 0) addCandle();
      ctx.fillStyle = 'rgba(5,8,18,0.25)';
      ctx.fillRect(0, 0, W(), H());
      ctx.strokeStyle = 'rgba(0,212,255,0.06)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 5; i++) {
        const y = H() * 0.1 + (H() * 0.8 / 5) * i;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W(), y); ctx.stroke();
      }
      const cw = W() / maxCandles;
      const toY = (v: number) => H() * 0.1 + (1 - v) * H() * 0.8;
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const x = i * cw + cw / 2;
        const isUp = c.close >= c.open;
        const color = isUp ? 'rgba(0,255,170,0.8)' : 'rgba(255,70,90,0.8)';
        ctx.strokeStyle = color; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, toY(c.high)); ctx.lineTo(x, toY(c.low)); ctx.stroke();
        ctx.fillStyle = color;
        const top = toY(Math.max(c.open, c.close));
        const bodyH = Math.max(2, Math.abs(toY(c.open) - toY(c.close)));
        ctx.fillRect(x - cw * 0.3, top, cw * 0.6, bodyH);
      }
      ctx.strokeStyle = 'rgba(0,212,255,0.5)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      const py = toY(price);
      ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W(), py); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(0,212,255,0.9)';
      ctx.font = '12px monospace';
      ctx.fillText(price.toFixed(3), W() - 55, py - 5);
      _rafId = requestAnimationFrame(draw);
    };
    draw();
  }
}
