/* Original deterministic Canvas film. No application state or network access. */
'use strict';
(() => {
  const W = 1920,
    H = 1080;
  const canvas = document.querySelector('canvas'),
    c = canvas.getContext('2d', { alpha: false });
  const S = window.FILM,
    G = '#92dfbd',
    GOLD = '#ebca86',
    WHITE = '#f5f2e8',
    RED = '#d58b75';
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const ease = (x) => {
    x = clamp(x);
    return x * x * (3 - 2 * x);
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  const fade = (t, a, b, d = 0.65) => ease((t - a) / d) * ease((b - t) / d);
  const rng = (n) => {
    let s = n;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  };
  const rand = rng(119077),
    stars = Array.from({ length: 1100 }, () => [rand() * W, rand() * H, rand(), rand() * 6.28]);
  const motes = Array.from({ length: 2400 }, () => [rand(), rand(), rand(), rand()]);
  const imageCache = new Map();
  const sparks = {};
  const rgb = (hex, a = 1) =>
    `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${clamp(a)})`;
  function image(id) {
    if (!imageCache.has(id))
      imageCache.set(
        id,
        new Promise((resolve, reject) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = () => reject(new Error('Cannot load ' + id));
          im.src = id;
        }),
      );
    return imageCache.get(id);
  }
  function text(str, x, y, size = 32, color = WHITE, alpha = 1, align = 'center', serif = false) {
    if (alpha <= 0) return;
    c.save();
    c.globalAlpha *= clamp(alpha);
    c.fillStyle = color;
    c.textAlign = align;
    c.textBaseline = 'middle';
    c.font = `${serif ? '400' : '500'} ${size}px ${serif ? 'KaiTi, STKaiti, serif' : '"Microsoft YaHei", sans-serif'}`;
    c.fillText(str, x, y);
    c.restore();
  }
  function glow(x, y, r, color = G, alpha = 0.3) {
    if (r <= 0 || alpha <= 0) return;
    c.save();
    c.globalCompositeOperation = 'lighter';
    const q = c.createRadialGradient(x, y, 0, x, y, r);
    q.addColorStop(0, rgb(color, alpha));
    q.addColorStop(0.15, rgb(color, alpha * 0.4));
    q.addColorStop(1, rgb(color, 0));
    c.fillStyle = q;
    c.fillRect(x - r, y - r, r * 2, r * 2);
    c.restore();
  }
  function dot(x, y, r = 3, color = G, alpha = 1) {
    c.save();
    c.fillStyle = rgb(color, alpha);
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }
  function spark(x, y, r = 2, color = G, alpha = 1) {
    if (!sparks[color]) {
      const s = document.createElement('canvas');
      s.width = s.height = 40;
      const q = s.getContext('2d'),
        g = q.createRadialGradient(20, 20, 0, 20, 20, 20);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.12, rgb(color, 0.95));
      g.addColorStop(0.35, rgb(color, 0.18));
      g.addColorStop(1, rgb(color, 0));
      q.fillStyle = g;
      q.fillRect(0, 0, 40, 40);
      sparks[color] = s;
    }
    c.save();
    c.globalAlpha *= alpha;
    c.globalCompositeOperation = 'lighter';
    c.drawImage(sparks[color], x - r * 4, y - r * 4, r * 8, r * 8);
    c.restore();
  }
  function path(pts, color = G, alpha = 0.6, width = 2, progress = 1) {
    if (pts.length < 2 || progress <= 0) return;
    c.save();
    c.strokeStyle = rgb(color, alpha);
    c.lineWidth = width;
    c.lineJoin = 'round';
    c.lineCap = 'round';
    if (width > 1.6) {
      c.shadowColor = rgb(color, 0.6);
      c.shadowBlur = 7;
    }
    c.beginPath();
    c.moveTo(...pts[0]);
    const n = clamp(progress) * (pts.length - 1),
      last = Math.floor(n);
    for (let i = 1; i <= last; i++) c.lineTo(...pts[i]);
    if (last < pts.length - 1)
      c.lineTo(
        lerp(pts[last][0], pts[last + 1][0], n - last),
        lerp(pts[last][1], pts[last + 1][1], n - last),
      );
    c.stroke();
    c.restore();
  }
  function line(a, b, color = G, alpha = 0.6, width = 2, progress = 1) {
    path([a, b], color, alpha, width, progress);
  }
  function curve(a, b, bend = 100) {
    return Array.from({ length: 61 }, (_, i) => {
      const u = i / 60;
      return [lerp(a[0], b[0], u), lerp(a[1], b[1], u) - Math.sin(u * Math.PI) * bend];
    });
  }
  function trace(points, t, color = G, alpha = 1) {
    const u = clamp(t);
    path(points, color, alpha * 0.65, 2.2, u);
    const p = points[Math.min(points.length - 1, Math.floor(u * (points.length - 1)))];
    glow(...p, 40, color, alpha * 0.5);
    dot(...p, 3.5, color, alpha);
  }
  function project(x, y, z, angle = 0.2, tilt = 0.1, zoom = 1, cx = 960, cy = 460) {
    let a = x * Math.cos(angle) + z * Math.sin(angle),
      b = -x * Math.sin(angle) + z * Math.cos(angle);
    let yy = y * Math.cos(tilt) - b * Math.sin(tilt),
      zz = y * Math.sin(tilt) + b * Math.cos(tilt);
    const k = (1100 / (1100 + zz)) * zoom;
    return [cx + a * k, cy + yy * k, k, zz];
  }
  function sphere(t, cx, cy, r, alpha = 1) {
    for (let i = 0; i < 720; i++) {
      const q = motes[i],
        y = 1 - q[0] * 2,
        a = q[1] * 6.28 + t * 0.13,
        rr = Math.sqrt(1 - y * y);
      const p = project(Math.cos(a) * rr * r, y * r, Math.sin(a) * rr * r, 0, 0.08, 1, cx, cy);
      spark(p[0], p[1], 0.7 + p[2] * 0.65, G, alpha * (0.3 + 0.65 * (1 - q[2])));
    }
  }
  function ribbon(t, cx, cy, r, alpha = 1, tilt = 0.4) {
    for (let j = 0; j < 3; j++) {
      const pts = Array.from({ length: 100 }, (_, i) => {
        const a = (i / 99) * Math.PI * 2 + t * 0.16 + j * 2.1;
        return project(Math.cos(a) * r, Math.sin(a) * r * 0.26, Math.sin(a) * r, 0.2, tilt, 1, cx, cy);
      });
      path(pts, j === 1 ? GOLD : G, alpha * 0.24, 1.7);
    }
    for (let i = 0; i < 180; i++) {
      const q = motes[i],
        a = q[0] * 6.28 + t * 0.3,
        r1 = r + Math.sin(q[1] * 6.28) * 25;
      const p = project(Math.cos(a) * r1, Math.sin(a) * r1 * 0.26, Math.sin(a) * r1, 0.2, tilt, 1, cx, cy);
      spark(p[0], p[1], 1 + q[2], i % 4 ? G : GOLD, alpha * 0.5);
    }
  }
  function background(t) {
    c.fillStyle = '#030806';
    c.fillRect(0, 0, W, H);
    glow(860, 420, 820, G, 0.035);
    glow(1420, 620, 520, GOLD, 0.018);
    for (const [x, y, z, p] of stars) {
      const xx = (x + t * (0.5 + z) * 2) % W,
        yy = y + Math.sin(t * 0.16 + p) * 8;
      dot(xx, yy, 0.5 + z * 0.8, '#b4d7c6', (0.14 + 0.2 * Math.sin(p + t * 0.4) ** 2) * (0.3 + z));
    }
    // Subtle drifting contours keep the depth continuous across scenes.
    for (let k = 0; k < 6; k++) {
      const pts = Array.from({ length: 80 }, (_, i) => {
        const x = i * 25;
        return [x, 770 + k * 24 + Math.sin(x * 0.003 + k * 0.8 + t * 0.08) * 45];
      });
      path(pts, G, 0.025, 1);
    }
  }
  function scene(t, a, b, fn) {
    const alpha = fade(t, a - 0.65, b + 0.65, 0.85);
    if (alpha > 0) {
      c.save();
      c.globalAlpha *= alpha;
      fn(t - a);
      c.restore();
    }
  }
  function labelNode(x, y, name, color = G, alpha = 1) {
    glow(x, y, 35, color, 0.3 * alpha);
    dot(x, y, 5, color, alpha);
    c.save();
    c.globalAlpha *= alpha;
    c.strokeStyle = rgb(color, 0.5);
    c.lineWidth = 1;
    c.beginPath();
    c.arc(x, y, 15, 0, 6.28);
    c.stroke();
    c.restore();
    text(name, x, y + 42, 28, WHITE, alpha);
  }
  function book(t, cx, cy, size, alpha = 1) {
    const ang = 0.18 + Math.sin(t * 0.21) * 0.07;
    for (let k = 8; k >= 0; k--) {
      const z = k * 8,
        pts = [
          [-0.8, -0.7],
          [-0.04, -0.5],
          [0, 0.85],
          [-0.8, 0.66],
          [-0.8, -0.7],
        ].map(([x, y]) => project(x * size, y * size, z, ang, -0.1, 1, cx, cy));
      path(pts, G, alpha * (k === 0 ? 0.9 : 0.1), k === 0 ? 2.4 : 1);
      const right = [
        [0.8, -0.7],
        [0.04, -0.5],
        [0, 0.85],
        [0.8, 0.66],
        [0.8, -0.7],
      ].map(([x, y]) => project(x * size, y * size, z, ang, -0.1, 1, cx, cy));
      path(right, GOLD, alpha * (k === 0 ? 0.9 : 0.1), k === 0 ? 2.4 : 1);
    }
    for (let k = 0; k < 5; k++) {
      line(
        [cx - size * 0.64, cy + size * (-0.32 + k * 0.17)],
        [cx - size * 0.15, cy + size * (-0.2 + k * 0.17)],
        G,
        0.18 * alpha,
        1.5,
      );
      line(
        [cx + size * 0.15, cy + size * (-0.2 + k * 0.17)],
        [cx + size * 0.64, cy + size * (-0.32 + k * 0.17)],
        GOLD,
        0.18 * alpha,
        1.5,
      );
    }
    glow(cx, cy + size * 0.8, size * 0.8, G, alpha * 0.11);
  }
  function panel(im, x, y, w, h, { crop = null, alpha = 1, tilt = 0 } = {}) {
    if (!im || alpha <= 0) return;
    c.save();
    c.globalAlpha *= alpha;
    c.translate(x, y);
    c.transform(1, tilt, -tilt * 0.3, 1, 0, 0);
    c.shadowColor = rgb(G, 0.22);
    c.shadowBlur = 35;
    c.fillStyle = '#10231d';
    c.beginPath();
    c.roundRect(-w / 2 - 2, -h / 2 - 2, w + 4, h + 4, 15);
    c.fill();
    c.shadowBlur = 0;
    c.beginPath();
    c.roundRect(-w / 2, -h / 2, w, h, 12);
    c.clip();
    if (crop) c.drawImage(im, ...crop.map((v) => (v * im.width) / 1238), -w / 2, -h / 2, w, h);
    else c.drawImage(im, -w / 2, -h / 2, w, h);
    c.restore();
  }
  function uiFrameAt(source) {
    const f = S.frames;
    let lo = 0,
      hi = f.length;
    while (lo < hi) {
      let m = (lo + hi) >> 1;
      if (f[m].time <= source) lo = m + 1;
      else hi = m;
    }
    return f[Math.max(0, lo - 1)];
  }
  function sourceTime(kind, progress) {
    return lerp(...S.segments[kind], clamp(progress));
  }
  async function ui(kind, progress) {
    return image(uiFrameAt(sourceTime(kind, progress)).url);
  }
  const game = document.createElement('video');
  game.muted = true;
  game.preload = 'auto';
  game.src = S.game;
  async function seekGame(t) {
    if (game.readyState < 2)
      await new Promise((resolve, reject) => {
        game.onloadeddata = resolve;
        game.onerror = () => reject(new Error('Game clip unavailable'));
      });
    if (Math.abs(game.currentTime - t) > 0.012)
      await new Promise((resolve, reject) => {
        game.onseeked = resolve;
        game.onerror = reject;
        game.currentTime = t;
      });
    return game;
  }

  async function render(t) {
    t = clamp(t, 0, S.script.duration);
    background(t);
    let flow = null,
      map = null,
      item = null,
      duel = null,
      save = null,
      companion = null,
      video = null;
    if (t > 15.5 && t < 23.8) flow = await ui('flow', lerp(0.35, 0.95, clamp((t - 16) / 7)));
    if (t > 39 && t < 44.8) map = await ui('map', clamp((t - 39) / 5.5));
    if (t > 44 && t < 50.8) item = await ui('catalog', lerp(0.15, 0.95, clamp((t - 44) / 4)));
    if (t > 53.5 && t < 64.8)
      duel = await ui(
        t < 58 ? 'duels' : 'learning',
        t < 58 ? lerp(0.1, 0.84, clamp((t - 54) / 4)) : lerp(0.21, 0.95, clamp((t - 58) / 6)),
      );
    if (t > 67.5 && t < 74.8)
      save = await ui('saves', t < 71.35 ? lerp(0.42, 0.74, clamp((t - 68) / 3.35)) : 0.94);
    if (t > 73.2 && t < 84.8) {
      video = await seekGame(clamp(t - 74, 0, 10));
      companion = await ui(
        t < 80.7 ? 'now' : 'tuck',
        t < 80.7 ? lerp(0.02, 0.94, clamp((t - 74) / 7)) : clamp((t - 80.7) / 2),
      );
    }
    const portrait = t > 44 && t < 64.8 ? await image(S.portrait) : null;
    const equipment = t > 44 && t < 50.8 ? await image(S.equipment) : null;

    scene(t, 0, 11, (u) => {
      const focus = ease((u - 0.1) / 2),
        angle = 0.22 + u * 0.025;
      for (let i = 0; i < 2400; i++) {
        const q = motes[i],
          blade = q[0] < 0.72;
        let yy, xx;
        if (blade) {
          yy = lerp(-340, 155, q[1]);
          xx = (q[2] - 0.5) * 54 * Math.min(1, q[1] * 6);
        } else if (q[0] < 0.88) {
          yy = 165 + (q[1] - 0.5) * 20;
          xx = (q[2] - 0.5) * 230;
        } else if (q[0] < 0.97) {
          yy = lerp(180, 295, q[1]);
          xx = (q[2] - 0.5) * 27;
        } else {
          yy = 310 + Math.sin(q[1] * 6.28) * 20;
          xx = Math.cos(q[1] * 6.28) * 20;
        }
        const rot = -0.24;
        [xx, yy] = [xx * Math.cos(rot) - yy * Math.sin(rot), xx * Math.sin(rot) + yy * Math.cos(rot)];
        const scattered = [(q[2] - 0.5) * 1650, (q[1] - 0.5) * 1100, (q[3] - 0.5) * 650];
        const p = project(
          lerp(scattered[0], xx, focus),
          lerp(scattered[1], yy, focus),
          lerp(scattered[2], (q[3] - 0.5) * 28, focus),
          angle,
          -0.15,
          1.12,
          960,
          460,
        );
        spark(p[0], p[1], 0.8 + q[3] * 1.5, blade ? G : GOLD, 0.45 + q[2] * 0.5);
      }
      ribbon(u, 960, 460, 330, 0.7, -0.6);
      glow(960, 390, 230, G, 0.13);
      const branches = [
        [
          [946, 410],
          [700, 420],
          [520, 280],
          [300, 330],
        ],
        [
          [974, 420],
          [1200, 450],
          [1390, 270],
          [1650, 320],
        ],
        [
          [960, 530],
          [1250, 640],
          [1460, 560],
          [1660, 690],
        ],
        [
          [950, 520],
          [730, 650],
          [460, 580],
          [260, 710],
        ],
      ];
      branches.forEach((pts, i) => {
        const a = i === 1 ? 1 - ease((u - 6) / 2) : 1;
        trace(pts, ease((u - 1 - i * 0.3) / 2.5), i === 1 ? RED : G, a * 0.7);
      });
      const a = ease((u - 2.5) / 1);
      labelNode(300, 330, '相逢', G, a);
      labelNode(1650, 320, u > 7 ? '错过' : '支线', u > 6 ? RED : G, a);
      labelNode(1660, 690, '抉择', GOLD, a);
      labelNode(260, 710, '机缘', G, a);
      if (u > 6) {
        const p = clamp((u - 6) / 2);
        for (let i = 0; i < 160; i++) {
          const q = motes[i];
          dot(
            1400 + q[0] * 260 + p * (q[2] - 0.5) * 500,
            290 + q[1] * 45 - p * q[3] * 200,
            1.4,
            RED,
            (1 - p) * 0.6,
          );
        }
      }
    });

    scene(t, 11, 23, (u) => {
      const compress = ease((u - 4.5) / 2),
        cx = 950,
        cy = 440;
      c.save();
      c.globalAlpha *= 1 - compress * 0.92;
      const a = [cx - 310, cy + 120],
        b = [cx + 80, cy - 90],
        d = [cx + 350, cy + 120];
      trace(curve(a, b, 80), ease(u / 2), G);
      trace(curve(b, d, -50), ease((u - 2) / 2), GOLD, 0.5);
      labelNode(...a, '现在');
      labelNode(...b, '莲湖会晤', GOLD, ease((u - 0.7) / 1));
      labelNode(...d, '拜入武当', G, 0.8);
      const pulse = 0.6 + 0.4 * Math.sin(u * 2.5) ** 2;
      glow(...b, 100, GOLD, 0.15 * pulse);
      text('先赴莲心湖', cx + 80, cy - 190, 40, GOLD, ease((u - 1.5) / 1), 'center', true);
      text(
        '正式拜师后 · 接取窗口关闭',
        cx,
        cy + 270,
        26,
        WHITE,
        ease((u - 2.5) / 1) * (0.75 - compress * 0.1),
      );
      c.restore();
      if (flow) {
        const k = ease((u - 4.5) / 2),
          settle = ease((u - 7) / 4);
        panel(
          flow,
          lerp(1030, 960, k),
          lerp(350, 455, k),
          lerp(80, 1370, k) + settle * 45,
          lerp(50, 715, k) + settle * 24,
          {
            crop: [0, 80, 1238, 646],
            alpha: compress,
            tilt: -0.08 * (1 - settle),
          },
        );
      }
    });

    scene(t, 23, 33, (u) => {
      const angle = -0.28 + u * 0.033;
      for (let k = 0; k < 32; k++) {
        const pts = Array.from({ length: 90 }, (_, i) => {
          const x = -860 + i * 20,
            z = -500 + k * 36,
            y = 140 - 95 * Math.sin(x * 0.005 + k * 0.19) * Math.cos(k * 0.2) - 55 * Math.cos(x * 0.009);
          return project(x, y, z, angle, 0.65, 1.03, 960, 470);
        });
        path(pts, G, 0.11 + k / 300, 1.2);
      }
      const nodes = [
        [-580, 30, -80, '梧桐村'],
        [-130, -45, -130, '野猪林'],
        [430, 0, 80, '莲心湖'],
      ].map(([x, y, z, n]) => [...project(x, y, z, angle, 0.65, 1.03, 960, 470), n]);
      nodes.forEach((p, i) => {
        const a = ease((u - i * 1.7) / 1);
        labelNode(p[0], p[1], p[4], i === 2 ? GOLD : G, a);
        if (i > 0) trace(curve(nodes[i - 1], p, 80), ease((u - (i - 1) * 2 - 1) / 2), i === 2 ? GOLD : G);
      });
      text('卫霍同行 · 顺路探索', 960, 190, 42, WHITE, ease((u - 4) / 1), 'center', true);
      const p = nodes[1];
      for (let i = 0; i < 50; i++) {
        const q = motes[i];
        const f = (u * 0.13 + q[0]) % 1;
        dot(
          lerp(nodes[0][0], p[0], f),
          lerp(nodes[0][1], p[1], f) - Math.sin(f * Math.PI) * 80,
          1.5,
          GOLD,
          0.8,
        );
      }
    });

    scene(t, 33, 50, (u) => {
      const compact = ease((u - 6) / 1.6),
        cx = 960,
        cy = 440,
        sz = 235 + compact * 45;
      c.save();
      c.globalAlpha *= 1 - compact;
      ribbon(u, cx, cy, lerp(390, 285, compact), 0.65, 0.4);
      book(u, cx, cy, sz);
      const names = ['养生秘术', '郎中 · 魏老', '地黄', '野猪林'],
        colors = [GOLD, G, GOLD, G];
      const centers = [
        [-380, -150],
        [370, -160],
        [-365, 190],
        [380, 185],
      ];
      centers.forEach(([dx, dy], i) => {
        const a = ease((u - 0.5 - i * 0.45) / 1),
          x = cx + dx * (1 - compact * 0.15),
          y = cy + dy;
        trace(curve([cx + (dx < 0 ? -80 : 80), cy], [x, y], dy < 0 ? 70 : -60), a, colors[i], 0.7);
        labelNode(x, y, names[i], colors[i], a);
      });
      for (let i = 0; i < 150; i++) {
        const q = motes[i],
          a = u * 0.15 + q[0] * 6.28;
        const p = project(
          Math.cos(a) * (300 + q[1] * 220),
          (q[2] - 0.5) * 500,
          Math.sin(a) * (300 + q[1] * 220),
          0.3,
          0.1,
          1,
          cx,
          cy,
        );
        dot(p[0], p[1], 1.2, G, 0.25);
      }
      c.restore();
      if (map) {
        const a = fade(u, 6, 11.9, 0.7);
        const k = ease((u - 6) / 1.5),
          s = ease((u - 8) / 3);
        panel(
          map,
          lerp(1340, 960, k),
          lerp(625, 460, k),
          lerp(100, 1320, k) + s * 90,
          lerp(85, 720, k) + s * 49,
          {
            crop: [0, 180, 1238, 675],
            alpha: a,
            tilt: 0.07 * (1 - s),
          },
        );
      }
      if (item) {
        const a = ease((u - 11) / 0.8),
          p = ease((u - 12) / 4),
          leave = 1 - ease((u - 16) / 0.55);
        panel(item, lerp(1340, 1260, p), 455, 825 + p * 40, 760 + p * 37, {
          crop: [0, 0, 1238, 1140],
          alpha: a * leave,
          tilt: -0.035 * (1 - p),
        });
        const handoff = ease((t - 48.7) / 2.3),
          person = [lerp(460, 960, handoff), lerp(315, 415, handoff)],
          blueprint = [470, 615];
        c.save();
        c.globalAlpha *= a * leave;
        if (equipment) {
          c.imageSmoothingEnabled = false;
          c.drawImage(equipment, person[0] - 75, person[1] - 115, 150, 150);
        }
        text('寒铁指套', person[0], person[1] + 100, 48, WHITE, 1, 'center', true);
        trace(curve(person, blueprint, 60), ease((u - 11.5) / 1), GOLD, a);
        text('锻造配方', 470, 665, 34, GOLD, a);
        trace(curve(blueprint, [850, 570], 60), ease((u - 12.5) / 1), GOLD, a);
        text('查看', 700, 610, 25, GOLD, a);
        c.restore();
      }
    });

    scene(t, 50, 64, (u) => {
      const compact = ease((u - 3) / 1.8),
        cx = lerp(lerp(460, 960, ease((t - 48.7) / 2.3)), 475, compact),
        cy = lerp(315, 415, ease((t - 48.7) / 2.3));
      sphere(u, cx, cy, 200, 1 - compact * 0.3);
      ribbon(u, cx, cy, 275, 0.65, -0.7);
      glow(cx, cy, 270, G, 0.12);
      if (portrait) {
        c.save();
        c.imageSmoothingEnabled = false;
        c.drawImage(portrait, cx - 75, cy - 115, 150, 150);
        c.restore();
      }
      text('江吟风', cx, cy + 100, 55, WHITE, 1, 'center', true);
      const nodes = [
        [-310, -180, '剩余私物'],
        [300, -130, '未学武学'],
        [-280, 220, '更高技艺'],
        [310, 225, '交互条件'],
      ];
      nodes.forEach(([x, y, n], i) => {
        const target = [cx + x * (1 - compact * 0.23), cy + y],
          p = ease((u - 0.4 - i * 0.5) / 1.3);
        trace(curve([cx, cy], target, i % 2 ? 70 : -70), p, i % 2 ? G : GOLD, 0.55);
        text(n, ...target, 30, i % 2 ? G : GOLD, p);
      });
      if (duel) {
        const shift = 420 * ease((u - 8) / 1.2);
        panel(duel, 1370, 450, 820, 690, {
          crop: [0, 40 + shift, 1238, 1042],
          alpha: compact,
          tilt: 0.015 * Math.sin(u * 0.3),
        });
        text(u < 8 ? '比武 · 私物还剩什么' : '请教 · 还能学些什么', 1370, 80, 29, GOLD, compact);
      }
    });

    scene(t, 64, 74, (u) => {
      const compact = ease((u - 3.4) / 1.4),
        cx = 960,
        cy = 450;
      c.save();
      c.globalAlpha *= 1 - compact * 0.93;
      const road = curve([cx - 350, cy + 150], [cx + 350, cy - 90], 80);
      path(road, G, 0.65, 3);
      const at = clamp(u / 4);
      trace(road, at, G);
      const anchor = [cx - 100, cy - 15];
      glow(...anchor, 120, GOLD, 0.3);
      labelNode(...anchor, '拜师前', GOLD, ease((u - 1) / 0.8));
      for (let i = 0; i < 5; i++) {
        const s = 40 + i * 18 + Math.sin(u * 0.8) * 4;
        c.save();
        c.translate(...anchor);
        c.rotate(Math.PI / 4 + u * 0.04);
        c.strokeStyle = rgb(GOLD, 0.5 - i * 0.07);
        c.lineWidth = 1.4;
        c.strokeRect(-s / 2, -s / 2, s, s);
        c.restore();
      }
      if (u > 2) {
        const q = curve(anchor, [cx + 320, cy + 200], -70);
        trace(q, ease((u - 2) / 2), G, 0.45);
        const r = 1 - clamp((u - 4) / 2);
        if (u > 4 && u < 6) trace(q, r, GOLD, 0.85);
      }
      text('留住这一刻', cx, cy - 210, 46, WHITE, ease((u - 1.5) / 1), 'center', true);
      c.restore();
      if (save) {
        const completed = u >= 7.35;
        panel(save, lerp(860, 960, compact), 460, lerp(80, 1120, compact), lerp(60, 720, compact), {
          crop: [0, completed ? 0 : 660, 1238, 796],
          alpha: compact,
          tilt: 0.05 * (1 - compact),
        });
        if (completed)
          panel(save, 960, 858, 570, 150, { crop: [428, 1735, 380, 100], alpha: ease((u - 7.35) / 0.3) });
      }
    });

    scene(t, 74, 84, (u) => {
      if (video) {
        const a = ease(u / 0.8);
        c.save();
        c.globalAlpha *= a;
        c.drawImage(video, 0, 0, W, H);
        const grad = c.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, 'rgba(2,10,7,.25)');
        grad.addColorStop(0.72, 'rgba(2,10,7,.02)');
        grad.addColorStop(1, 'rgba(2,10,7,.85)');
        c.fillStyle = grad;
        c.fillRect(0, 0, W, H);
        c.restore();
      }
      if (companion) {
        const small =
          uiFrameAt(
            sourceTime(
              u < 6.7 ? 'now' : 'tuck',
              u < 6.7 ? lerp(0.02, 0.94, clamp(u / 7)) : clamp((u - 6.7) / 2),
            ),
          ).width < 100;
        const a = ease(u / 0.7);
        if (small) {
          panel(companion, 1890, 485, companion.width * 0.55, companion.height * 0.55, { alpha: a });
        } else panel(companion, 1620, 470, 560, 850, { alpha: a });
      }
    });

    scene(t, 84, 94, (u) => {
      const f = ease(u / 2.7);
      for (let i = 0; i < 1800; i++) {
        const q = motes[i],
          ang = q[0] * 6.28 + u * 0.1;
        const x = Math.cos(ang) * (380 + q[1] * 300),
          y = (q[2] - 0.5) * 650,
          z = Math.sin(ang) * 400;
        const targetx = (q[0] < 0.5 ? -1 : 1) * (25 + q[1] * 170),
          targety = (q[2] - 0.5) * 220 + q[1] * 25;
        const p = project(
          lerp(x, targetx, f),
          lerp(y, targety, f),
          lerp(z, (q[3] - 0.5) * 20, f),
          0.1,
          0.1,
          1,
          960,
          320,
        );
        spark(p[0], p[1], 0.6 + q[3], q[0] > 0.5 ? GOLD : G, 0.3 + q[1] * 0.5);
      }
      ribbon(u, 960, 320, 340, 0.5, 0.3);
      book(u, 960, 320, 225, f * 0.7);
      glow(960, 320, 300, G, 0.12);
      text('逸剑手札', 960, 610, 108, WHITE, ease((u - 0.5) / 1), 'center', true);
      text('《逸剑风云决》随行助手', 960, 705, 33, G, ease((u - 1) / 1));
      const a = ease((u - 4) / 1);
      text('免费开源  ·  Windows', 960, 803, 32, GOLD, a);
      text('github.com/Legender134/yijian-journal', 960, 865, 32, WHITE, a);
      text('非官方玩家工具', 960, 1020, 22, '#8ca79a', ease((u - 5) / 1));
    });
    // A visible travelling clue survives the scene changes instead of cutting to a new page.
    for (const [a, b, from, to, label] of [
      [21.8, 24.4, [1030, 350], [350, 475], ''],
      [31.5, 34.8, [820, 505], [960, 440], '野猪林'],
      [49, 51, [460, 315], [960, 415], ''],
      [62.5, 65.5, [1370, 760], [860, 435], ''],
    ]) {
      if (t < a || t > b) continue;
      const u = ease((t - a) / (b - a)),
        pts = curve(from, to, 100),
        idx = Math.min(60, Math.round(u * 60)),
        p = pts[idx],
        a1 = fade(t, a, b, 0.4);
      path(pts.slice(Math.max(0, idx - 10), idx + 1), GOLD, a1 * 0.9, 3);
      spark(p[0], p[1], 6, GOLD, a1);
      glow(p[0], p[1], 80, GOLD, a1 * 0.25);
      if (label) text(label, p[0], p[1] + 38, 27, GOLD, a1);
    }
    if (t < 74) text('逸剑手札', 80, 62, 31, G, 0.64, 'left', true);
    const cap = S.script.captions.find(([a, b]) => t >= a && t <= b);
    if (cap) {
      const a = fade(t, cap[0], cap[1], 0.4);
      c.save();
      c.shadowColor = '#000';
      c.shadowBlur = 14;
      text(cap[2], 960, t >= 84 ? 966 : 985, 40, WHITE, a);
      c.restore();
    }
    if (
      (t > 16 && t < 23) ||
      (t > 39 && t < 50) ||
      (t > 54 && t < 64) ||
      (t > 68 && t < 74) ||
      (t > 74 && t < 84)
    )
      text('软件实录 · 示例进度', 1835, 1040, 20, '#a9bbb0', 0.75, 'right');
    // End on a held, legible identity rather than a black frame.
    return { time: t };
  }
  window.render = render;
})();
