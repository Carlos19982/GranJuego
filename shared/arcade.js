/* ==========================================================================
   GRAN JUEGO · Arcade Kit (motor compartido de efectos)
   Expone el objeto global `AX`:
     - Saldo y logros compartidos (mismas claves de localStorage de siempre)
     - Sonido sintetizado (WebAudio, sin ficheros)
     - Vibración háptica
     - Partículas a pantalla completa (confeti, monedas, fuegos artificiales…)
     - Cinemáticas: intro, gran premio, derrota, banner, cuenta atrás
     - HUD móvil (volver, título, saldo animado, silencio)
     - Transiciones entre páginas
   ========================================================================== */
(function (global) {
  "use strict";

  const AX = {};
  global.AX = AX;

  /* ------------------------------------------------------------ CLAVES */
  AX.KEYS = {
    BALANCE: "cardGamePlayerBalance_v3",
    ACHIEVEMENTS: "rouletteAchievements_v1",
    LAST_SEEN: "rouletteLastSeenAchievements_v1",
    FLAPPY_HS: "flappyHighScore",
    MUTED: "granjuego_muted_v1",
    INTRO_SEEN: "granjuego_intro_seen_v1", // sessionStorage
  };
  AX.DEFAULT_BALANCE = 5000;

  AX.ACHIEVEMENTS = [
    { id: "bal1", name: "Primeros Pasos", target: 5500, reward: 100 },
    { id: "bal2", name: "Racha Creciente", target: 7500, reward: 150 },
    { id: "bal3", name: "Diez Mil", target: 10000, reward: 250 },
    { id: "bal4", name: "Buen Ritmo", target: 15000, reward: 400 },
    { id: "bal5", name: "Veinticinco Mil", target: 25000, reward: 600 },
    { id: "bal6", name: "Cincuenta Mil", target: 50000, reward: 1250 },
    { id: "bal7", name: "Setenta y Cinco Mil", target: 75000, reward: 2000 },
    { id: "bal8", name: "Cien Mil!", target: 100000, reward: 3000 },
    { id: "bal9", name: "Cuarto de Millón", target: 250000, reward: 7500 },
    { id: "bal10", name: "Medio Millón", target: 500000, reward: 15000 },
    { id: "bal11", name: "Millonario!", target: 1000000, reward: 30000 },
    { id: "bal12", name: "Dos Millones y Medio", target: 2500000, reward: 75000 },
    { id: "bal13", name: "Cinco Millones", target: 5000000, reward: 150000 },
    { id: "bal14", name: "Decamillonario!", target: 10000000, reward: 300000 },
    { id: "bal15", name: "Veinticinco Millones", target: 25000000, reward: 750000 },
    { id: "bal16", name: "Cincuenta Millones", target: 50000000, reward: 1500000 },
    { id: "bal17", name: "Centimillonario!", target: 100000000, reward: 3000000 },
    { id: "bal18", name: "Doscientos Cincuenta Millones", target: 250000000, reward: 7500000 },
    { id: "bal19", name: "Quinientos Millones", target: 500000000, reward: 15000000 },
    { id: "bal20", name: "Billonario!!!", target: 1000000000, reward: 50000000 },
  ];

  AX.reducedMotion = !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);

  /* ------------------------------------------------------- UTILIDADES */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  AX.el = el;
  AX.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  AX.rand = (a, b) => a + Math.random() * (b - a);
  AX.randInt = (a, b) => Math.floor(AX.rand(a, b + 1));
  AX.pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  AX.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  AX.lerp = (a, b, t) => a + (b - a) * t;
  AX.ease = {
    outCubic: (t) => 1 - Math.pow(1 - t, 3),
    inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    outBack: (t) => {
      const c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    },
    outExpo: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  };
  /** 12345 -> "12.345" */
  AX.fmt = (n, decimals = 0) => {
    const v = Number(n) || 0;
    const neg = v < 0;
    const [int, dec] = Math.abs(v).toFixed(decimals).split(".");
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return (neg ? "-" : "") + grouped + (dec ? "," + dec : "");
  };
  /** 12345 -> "12.345 €" */
  AX.money = (n, decimals = 0) => AX.fmt(n, decimals) + " €";
  /** Centro de un elemento en coordenadas de viewport */
  AX.center = (node) => {
    if (!node) return { x: innerWidth / 2, y: innerHeight / 2 };
    const r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  AX.ready = (fn) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn());

  /** Anima un número dentro de un elemento. */
  AX.countUp = (node, from, to, ms = 900, fmt = AX.fmt) =>
    new Promise((resolve) => {
      if (!node) return resolve();
      const t0 = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - t0) / ms);
        node.textContent = fmt(Math.round(AX.lerp(from, to, AX.ease.outCubic(t))));
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });

  /* -------------------------------------------------- SALDO Y LOGROS */
  const balanceListeners = new Set();

  AX.getBalance = function () {
    try {
      const raw = localStorage.getItem(AX.KEYS.BALANCE);
      if (raw !== null) {
        const v = Math.floor(parseFloat(raw));
        if (!isNaN(v) && v >= 0) return v;
      }
    } catch (e) {}
    return AX.DEFAULT_BALANCE;
  };

  /**
   * Guarda el saldo. Por defecto también comprueba logros (sumando sus premios)
   * y muestra la notificación. Devuelve el saldo final.
   * opts: { silent: bool (no anima HUD), achievements: bool (default true) }
   */
  AX.setBalance = function (value, opts = {}) {
    const prev = AX.getBalance();
    let v = Math.max(0, Math.round(Number(value) || 0));
    try {
      localStorage.setItem(AX.KEYS.BALANCE, String(v));
    } catch (e) {}
    if (opts.achievements !== false) {
      const res = AX.checkAchievements({ notify: opts.notify !== false });
      if (res.unlocked.length) v = AX.getBalance();
    }
    balanceListeners.forEach((fn) => {
      try { fn(v, prev, opts); } catch (e) { console.error(e); }
    });
    return v;
  };

  /** Suma (o resta, con delta negativo) al saldo. Devuelve el nuevo saldo. */
  AX.addBalance = (delta, opts) => AX.setBalance(AX.getBalance() + delta, opts);

  /** Intenta cobrar `amount`. Devuelve true si había saldo suficiente. */
  AX.spend = (amount, opts) => {
    const b = AX.getBalance();
    if (amount > b) return false;
    AX.setBalance(b - amount, Object.assign({ achievements: false }, opts));
    return true;
  };

  AX.onBalance = (fn) => {
    balanceListeners.add(fn);
    return () => balanceListeners.delete(fn);
  };

  AX.getUnlocked = function () {
    try {
      const arr = JSON.parse(localStorage.getItem(AX.KEYS.ACHIEVEMENTS) || "[]");
      return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
    } catch (e) {
      return [];
    }
  };

  /**
   * Desbloquea logros alcanzados por el saldo actual y suma su recompensa.
   * Devuelve { unlocked: [ach], reward }.
   */
  AX.checkAchievements = function (opts = {}) {
    const unlocked = AX.getUnlocked();
    const fresh = [];
    let reward = 0;
    let bal;
    try {
      bal = Math.floor(parseFloat(localStorage.getItem(AX.KEYS.BALANCE)));
    } catch (e) {}
    if (isNaN(bal)) bal = AX.DEFAULT_BALANCE;
    // Bucle: una recompensa puede desbloquear el siguiente logro
    let changed = true;
    while (changed) {
      changed = false;
      for (const a of AX.ACHIEVEMENTS) {
        if (bal + reward >= a.target && !unlocked.includes(a.id)) {
          unlocked.push(a.id);
          fresh.push(a);
          reward += a.reward;
          changed = true;
        }
      }
    }
    if (fresh.length) {
      try {
        localStorage.setItem(AX.KEYS.ACHIEVEMENTS, JSON.stringify(unlocked));
        localStorage.setItem(AX.KEYS.BALANCE, String(bal + reward));
        localStorage.setItem(AX.KEYS.LAST_SEEN, JSON.stringify(unlocked));
      } catch (e) {}
      if (opts.notify !== false) AX.achievementQueue(fresh);
    }
    return { unlocked: fresh, reward };
  };

  /* ------------------------------------------------------------ SONIDO */
  const sfx = {};
  AX.sfx = sfx;
  let actx = null;
  let master = null;
  let muted = false;
  try {
    muted = localStorage.getItem(AX.KEYS.MUTED) === "1";
  } catch (e) {}

  sfx.ctx = function () {
    if (!actx) {
      // No crear el AudioContext antes del primer gesto (evita avisos de autoplay)
      const ua = navigator.userActivation;
      if (ua && !ua.hasBeenActive) return null;
      const C = global.AudioContext || global.webkitAudioContext;
      if (!C) return null;
      actx = new C();
      const comp = actx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      master = actx.createGain();
      master.gain.value = muted ? 0 : 0.7;
      master.connect(comp);
      comp.connect(actx.destination);
      sfx.master = master;
    }
    if (actx.state === "suspended") actx.resume();
    return actx;
  };
  sfx.isMuted = () => muted;
  sfx.setMuted = function (m) {
    muted = !!m;
    try { localStorage.setItem(AX.KEYS.MUTED, muted ? "1" : "0"); } catch (e) {}
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.7, actx.currentTime, 0.02);
    document.querySelectorAll("[data-ax-mute]").forEach((b) => (b.innerHTML = muteIcon()));
  };
  sfx.toggleMute = () => sfx.setMuted(!muted);

  // Desbloquear audio en iOS / Android con el primer toque
  const unlock = () => {
    const c = sfx.ctx();
    if (c) {
      const b = c.createBuffer(1, 1, 22050);
      const s = c.createBufferSource();
      s.buffer = b;
      s.connect(c.destination);
      s.start(0);
    }
    global.removeEventListener("pointerdown", unlock, true);
    global.removeEventListener("touchend", unlock, true);
    global.removeEventListener("keydown", unlock, true);
  };
  global.addEventListener("pointerdown", unlock, true);
  global.addEventListener("touchend", unlock, true);
  global.addEventListener("keydown", unlock, true);

  /** Oscilador básico. type: sine|square|sawtooth|triangle */
  sfx.tone = function (freq, dur = 0.15, opts = {}) {
    const c = sfx.ctx();
    if (!c || muted) return;
    const t = c.currentTime + (opts.delay || 0);
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = opts.type || "sine";
    o.frequency.setValueAtTime(freq, t);
    if (opts.to) o.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), t + dur);
    if (opts.detune) o.detune.value = opts.detune;
    const vol = opts.vol == null ? 0.25 : opts.vol;
    const atk = opts.attack || 0.005;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o;
    if (opts.filter) {
      const f = c.createBiquadFilter();
      f.type = opts.filter.type || "lowpass";
      f.frequency.value = opts.filter.freq || 2000;
      f.Q.value = opts.filter.q || 1;
      o.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(opts.out || master);
    o.start(t);
    o.stop(t + dur + 0.05);
  };

  let noiseBuf = null;
  function getNoise(c) {
    if (!noiseBuf) {
      noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }
  /** Ruido filtrado. opts: {type, freq, to, q, vol, delay} */
  sfx.noise = function (dur = 0.2, opts = {}) {
    const c = sfx.ctx();
    if (!c || muted) return;
    const t = c.currentTime + (opts.delay || 0);
    const s = c.createBufferSource();
    s.buffer = getNoise(c);
    const f = c.createBiquadFilter();
    f.type = opts.type || "bandpass";
    f.frequency.setValueAtTime(opts.freq || 1500, t);
    if (opts.to) f.frequency.exponentialRampToValueAtTime(opts.to, t + dur);
    f.Q.value = opts.q || 1;
    const g = c.createGain();
    const vol = opts.vol == null ? 0.3 : opts.vol;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + (opts.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f);
    f.connect(g);
    g.connect(opts.out || master);
    s.start(t, Math.random());
    s.stop(t + dur + 0.05);
  };

  const N = (n) => 440 * Math.pow(2, (n - 69) / 12); // MIDI -> Hz
  sfx.note = N;

  const SOUNDS = {
    tap: () => sfx.tone(700, 0.06, { type: "triangle", to: 1000, vol: 0.15 }),
    click: () => { sfx.tone(1800, 0.03, { type: "square", vol: 0.06 }); sfx.noise(0.03, { freq: 4000, vol: 0.1 }); },
    tick: () => sfx.tone(2200, 0.025, { type: "square", vol: 0.05, filter: { freq: 3000 } }),
    coin: () => { sfx.tone(N(83), 0.08, { type: "square", vol: 0.1 }); sfx.tone(N(88), 0.35, { type: "square", vol: 0.1, delay: 0.07 }); },
    chip: () => { sfx.noise(0.05, { freq: 3500, q: 4, vol: 0.35 }); sfx.tone(2600, 0.05, { type: "triangle", vol: 0.12, delay: 0.01 }); sfx.noise(0.04, { freq: 5000, q: 6, vol: 0.2, delay: 0.05 }); },
    card: () => sfx.noise(0.12, { type: "highpass", freq: 2500, to: 6000, vol: 0.28 }),
    flip: () => { sfx.noise(0.15, { freq: 900, to: 3500, q: 2, vol: 0.3 }); sfx.tone(500, 0.08, { type: "triangle", to: 900, vol: 0.06, delay: 0.08 }); },
    whoosh: () => sfx.noise(0.45, { freq: 300, to: 3000, q: 1.5, vol: 0.35, attack: 0.15 }),
    swoosh: () => sfx.noise(0.3, { freq: 3000, to: 400, q: 1.5, vol: 0.3, attack: 0.05 }),
    impact: () => { sfx.tone(140, 0.35, { type: "sine", to: 40, vol: 0.5 }); sfx.noise(0.2, { type: "lowpass", freq: 900, vol: 0.4 }); },
    boom: () => { sfx.tone(110, 0.8, { type: "sine", to: 25, vol: 0.6 }); sfx.noise(0.9, { type: "lowpass", freq: 1200, to: 100, vol: 0.5 }); },
    win: () => [60, 64, 67, 72].forEach((n, i) => sfx.tone(N(n + 12), 0.25, { type: "triangle", vol: 0.18, delay: i * 0.08 })),
    bigwin: () => {
      [60, 64, 67, 72, 76, 79, 84].forEach((n, i) => sfx.tone(N(n + 12), 0.3, { type: "square", vol: 0.07, delay: i * 0.06, filter: { freq: 3500 } }));
      [72, 76, 79, 84].forEach((n) => sfx.tone(N(n), 1.6, { type: "sawtooth", vol: 0.05, delay: 0.45, attack: 0.05, filter: { freq: 2500 } }));
      sfx.tone(N(48), 1.6, { type: "triangle", vol: 0.25, delay: 0.45 });
      for (let i = 0; i < 10; i++) sfx.tone(N(96 + (i % 5) * 2), 0.12, { type: "sine", vol: 0.05, delay: 0.5 + i * 0.09 });
    },
    jackpot: () => {
      for (let r = 0; r < 3; r++) [72, 76, 79, 84].forEach((n, i) => sfx.tone(N(n + r * 2), 0.14, { type: "square", vol: 0.06, delay: r * 0.36 + i * 0.07, filter: { freq: 4000 } }));
      [60, 67, 72, 76].forEach((n) => sfx.tone(N(n), 2.2, { type: "sawtooth", vol: 0.05, delay: 1.1, attack: 0.08, filter: { freq: 2200 } }));
      sfx.tone(N(36), 2, { type: "triangle", vol: 0.3, delay: 1.1 });
    },
    lose: () => { [67, 63, 60, 55].forEach((n, i) => sfx.tone(N(n), 0.32, { type: "sawtooth", vol: 0.07, delay: i * 0.16, filter: { freq: 1200 } })); sfx.tone(N(43), 1, { type: "triangle", vol: 0.2, delay: 0.5 }); },
    error: () => { sfx.tone(220, 0.12, { type: "square", vol: 0.08 }); sfx.tone(180, 0.18, { type: "square", vol: 0.08, delay: 0.12 }); },
    powerup: () => sfx.tone(300, 0.4, { type: "square", to: 1400, vol: 0.08, filter: { freq: 3000 } }),
    count: () => sfx.tone(N(69), 0.18, { type: "square", vol: 0.1, filter: { freq: 2500 } }),
    go: () => { sfx.tone(N(81), 0.5, { type: "square", vol: 0.1, filter: { freq: 3000 } }); sfx.tone(N(76), 0.5, { type: "square", vol: 0.06, filter: { freq: 3000 } }); },
    shimmer: () => { for (let i = 0; i < 8; i++) sfx.tone(N(84 + [0, 4, 7, 12, 16, 19, 24, 28][i]), 0.25, { type: "sine", vol: 0.06, delay: i * 0.04 }); },
    riser: () => { sfx.noise(1.2, { freq: 200, to: 6000, q: 2, vol: 0.25, attack: 1 }); sfx.tone(100, 1.2, { type: "sawtooth", to: 800, vol: 0.05, attack: 1, filter: { freq: 1500 } }); },
    achievement: () => { [72, 79, 84, 88, 91].forEach((n, i) => sfx.tone(N(n), 0.5, { type: "triangle", vol: 0.12, delay: i * 0.09 })); SOUNDS.shimmer(); },
    cash: () => { sfx.noise(0.05, { freq: 4000, vol: 0.2 }); sfx.tone(N(96), 0.5, { type: "sine", vol: 0.12, delay: 0.04 }); sfx.tone(N(100), 0.5, { type: "sine", vol: 0.1, delay: 0.1 }); },
  };
  /** AX.sfx.play('coin'). Nombres: tap click tick coin chip card flip whoosh swoosh impact boom win bigwin jackpot lose error powerup count go shimmer riser achievement cash */
  sfx.play = function (name) {
    try {
      if (SOUNDS[name]) SOUNDS[name]();
    } catch (e) {}
  };
  sfx.register = (name, fn) => (SOUNDS[name] = fn);

  /* ------------------------------------------------------------ HÁPTICA */
  const HAPTICS = { light: 8, tap: 12, medium: 25, heavy: 50, success: [20, 40, 30], error: [60, 40, 60], win: [30, 50, 30, 50, 80], bigwin: [40, 40, 40, 40, 120, 60, 200] };
  AX.haptic = function (p = "tap") {
    try {
      const ua = navigator.userActivation;
      if (ua && !ua.hasBeenActive) return;
      if (navigator.vibrate) navigator.vibrate(HAPTICS[p] != null ? HAPTICS[p] : p);
    } catch (e) {}
  };

  /* -------------------------------------------------------- PARTÍCULAS */
  const fx = {};
  AX.fx = fx;
  let cv = null, cx = null, parts = [], running = false, dpr = 1;
  const MAX_PARTS = 700;

  function ensureCanvas() {
    if (cv) return;
    cv = el("canvas", "ax-fx-canvas");
    document.body.appendChild(cv);
    cx = cv.getContext("2d");
    resize();
    global.addEventListener("resize", resize);
  }
  function resize() {
    if (!cv) return;
    dpr = Math.min(2, global.devicePixelRatio || 1);
    cv.width = Math.round(innerWidth * dpr);
    cv.height = Math.round(innerHeight * dpr);
  }

  const PALETTES = {
    party: ["#ffcc33", "#22e4ff", "#ff2fb3", "#2bff88", "#8b5cff", "#ffffff"],
    gold: ["#fff3b0", "#ffd23f", "#ffb020", "#ff9f1c", "#ffe680"],
    fire: ["#fff3b0", "#ffcc33", "#ff7a1a", "#ff3b5c"],
    ice: ["#ffffff", "#b8f7ff", "#22e4ff", "#8b5cff"],
    blood: ["#ff3b5c", "#b0002a", "#ff8095"],
    green: ["#2bff88", "#b6ffd5", "#0aa358", "#ffffff"],
  };
  fx.PALETTES = PALETTES;
  const pal = (c) => (Array.isArray(c) ? c : PALETTES[c] || PALETTES.party);

  function add(p) {
    if (parts.length >= MAX_PARTS) parts.shift();
    parts.push(p);
    if (!running) {
      running = true;
      last = performance.now();
      requestAnimationFrame(loop);
    }
  }
  let last = 0;
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, innerWidth, innerHeight);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.age += dt;
      if (p.age >= p.life) {
        parts.splice(i, 1);
        continue;
      }
      p.vx *= Math.pow(p.drag, dt * 60);
      p.vy = p.vy * Math.pow(p.drag, dt * 60) + p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      const k = p.age / p.life;
      const alpha = p.fade ? Math.min(1, (1 - k) * 2.2) : 1;
      draw(p, alpha, k, now);
    }
    if (parts.length) requestAnimationFrame(loop);
    else {
      running = false;
      cx.clearRect(0, 0, innerWidth, innerHeight);
    }
  }
  function draw(p, a, k, now) {
    cx.globalAlpha = a;
    const s = p.size * (p.grow ? 1 + k * p.grow : 1) * (p.shrink ? 1 - k * 0.9 : 1);
    switch (p.shape) {
      case "spark": {
        cx.globalCompositeOperation = "lighter";
        cx.strokeStyle = p.color;
        cx.lineWidth = s;
        cx.lineCap = "round";
        cx.beginPath();
        cx.moveTo(p.x, p.y);
        cx.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04);
        cx.stroke();
        cx.globalCompositeOperation = "source-over";
        break;
      }
      case "glow": {
        cx.globalCompositeOperation = "lighter";
        const gr = cx.createRadialGradient(p.x, p.y, 0, p.x, p.y, s);
        gr.addColorStop(0, p.color);
        gr.addColorStop(1, "rgba(0,0,0,0)");
        cx.fillStyle = gr;
        cx.beginPath();
        cx.arc(p.x, p.y, s, 0, Math.PI * 2);
        cx.fill();
        cx.globalCompositeOperation = "source-over";
        break;
      }
      case "confetti": {
        cx.save();
        cx.translate(p.x, p.y);
        cx.rotate(p.rot);
        cx.scale(1, Math.cos(p.age * p.flip));
        cx.fillStyle = p.color;
        cx.fillRect(-s / 2, -s / 4, s, s / 2);
        cx.restore();
        break;
      }
      case "coin": {
        cx.save();
        cx.translate(p.x, p.y);
        cx.rotate(p.rot * 0.2);
        const sx = Math.cos(p.age * p.flip);
        cx.scale(Math.abs(sx) < 0.08 ? 0.08 : sx, 1);
        const gr = cx.createLinearGradient(-s, -s, s, s);
        gr.addColorStop(0, "#fff7c2");
        gr.addColorStop(0.35, "#ffd23f");
        gr.addColorStop(0.75, "#f29a00");
        gr.addColorStop(1, "#9a5400");
        cx.fillStyle = gr;
        cx.beginPath();
        cx.arc(0, 0, s, 0, Math.PI * 2);
        cx.fill();
        cx.strokeStyle = "rgba(140,70,0,0.8)";
        cx.lineWidth = Math.max(1, s * 0.14);
        cx.beginPath();
        cx.arc(0, 0, s * 0.72, 0, Math.PI * 2);
        cx.stroke();
        if (sx > 0) {
          cx.fillStyle = "rgba(140,70,0,0.85)";
          cx.font = `900 ${s * 1.15}px Arial, sans-serif`;
          cx.textAlign = "center";
          cx.textBaseline = "middle";
          cx.fillText("€", 0, s * 0.06);
        }
        cx.restore();
        break;
      }
      case "star": {
        cx.save();
        cx.translate(p.x, p.y);
        cx.rotate(p.rot);
        cx.globalCompositeOperation = "lighter";
        cx.fillStyle = p.color;
        cx.beginPath();
        for (let i = 0; i < 10; i++) {
          const r = i % 2 ? s * 0.42 : s;
          const an = (i * Math.PI) / 5 - Math.PI / 2;
          cx.lineTo(Math.cos(an) * r, Math.sin(an) * r);
        }
        cx.closePath();
        cx.fill();
        cx.restore();
        cx.globalCompositeOperation = "source-over";
        break;
      }
      case "ring": {
        cx.globalCompositeOperation = "lighter";
        const r = p.size + (p.maxR - p.size) * AX.ease.outCubic(k);
        cx.strokeStyle = p.color;
        cx.lineWidth = Math.max(0.5, p.width * (1 - k));
        cx.beginPath();
        cx.arc(p.x, p.y, r, 0, Math.PI * 2);
        cx.stroke();
        cx.globalCompositeOperation = "source-over";
        break;
      }
      case "emoji": {
        cx.save();
        cx.translate(p.x, p.y);
        cx.rotate(p.rot);
        cx.font = `${s}px sans-serif`;
        cx.textAlign = "center";
        cx.textBaseline = "middle";
        cx.fillText(p.text, 0, 0);
        cx.restore();
        break;
      }
      default: {
        cx.fillStyle = p.color;
        cx.beginPath();
        cx.arc(p.x, p.y, s, 0, Math.PI * 2);
        cx.fill();
      }
    }
    cx.globalAlpha = 1;
  }

  function P(o) {
    return Object.assign(
      { x: 0, y: 0, vx: 0, vy: 0, g: 0, drag: 0.99, size: 4, color: "#fff", life: 1, age: 0, rot: 0, vr: 0, flip: 8, shape: "circle", fade: true, shrink: false, grow: 0 },
      o
    );
  }

  /** Explosión radial de partículas. */
  fx.burst = function (x, y, o = {}) {
    ensureCanvas();
    const n = o.count || 40;
    const colors = pal(o.colors);
    const sp = o.speed || 420;
    for (let i = 0; i < n; i++) {
      const an = o.angle != null ? o.angle + AX.rand(-(o.spread || 0.6), o.spread || 0.6) : Math.random() * Math.PI * 2;
      const v = sp * AX.rand(0.35, 1);
      add(P({
        x, y,
        vx: Math.cos(an) * v,
        vy: Math.sin(an) * v,
        g: o.gravity != null ? o.gravity : 600,
        drag: o.drag || 0.96,
        size: o.size ? AX.rand(o.size * 0.6, o.size * 1.3) : AX.rand(2, 5),
        color: AX.pick(colors),
        life: AX.rand(0.6, 1.2) * (o.life || 1),
        shape: o.shape || "circle",
        vr: AX.rand(-10, 10),
        flip: AX.rand(4, 14),
        shrink: o.shrink !== false && (o.shape || "circle") === "circle",
        text: o.text ? AX.pick([].concat(o.text)) : undefined,
      }));
    }
  };
  /** Chispas brillantes (estelas). */
  fx.sparks = (x, y, o = {}) => fx.burst(x, y, Object.assign({ count: 30, shape: "spark", speed: 650, gravity: 500, size: 2.5, colors: "gold", life: 0.6 }, o));
  /** Estrellas brillantes. */
  fx.stars = (x, y, o = {}) => fx.burst(x, y, Object.assign({ count: 16, shape: "star", speed: 300, gravity: 120, size: 9, colors: "gold" }, o));
  /** Onda expansiva. */
  fx.shockwave = function (x, y, o = {}) {
    ensureCanvas();
    const n = o.rings || 1;
    for (let i = 0; i < n; i++)
      setTimeout(() => add(P({ x, y, shape: "ring", size: o.from || 10, maxR: o.radius || 220, width: o.width || 10, color: o.color || "#ffd23f", life: o.life || 0.7, drag: 1, fade: true })), i * 110);
  };
  /** Destello radial luminoso. */
  fx.glow = function (x, y, o = {}) {
    ensureCanvas();
    add(P({ x, y, shape: "glow", size: o.size || 160, color: o.color || "rgba(255,210,63,0.9)", life: o.life || 0.6, grow: o.grow == null ? 0.6 : o.grow, drag: 1 }));
  };
  /** Lluvia de confeti desde arriba. */
  fx.confetti = function (o = {}) {
    ensureCanvas();
    const n = o.count || 160;
    const colors = pal(o.colors);
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        add(P({
          x: AX.rand(0, innerWidth), y: AX.rand(-80, -10),
          vx: AX.rand(-80, 80), vy: AX.rand(120, 380),
          g: 160, drag: 0.995, size: AX.rand(7, 13), color: AX.pick(colors),
          life: AX.rand(2.4, 4), shape: "confetti", vr: AX.rand(-6, 6), flip: AX.rand(5, 12),
        }));
      }, (i / n) * (o.duration || 600));
    }
  };
  /** Cañones de confeti desde las esquinas inferiores. */
  fx.cannons = function (o = {}) {
    ensureCanvas();
    const n = o.count || 90;
    const colors = pal(o.colors);
    [[0, innerHeight, -Math.PI / 3], [innerWidth, innerHeight, -2 * Math.PI / 3]].forEach(([x, y, an]) => {
      for (let i = 0; i < n; i++) {
        const a = an + AX.rand(-0.35, 0.35);
        const v = AX.rand(700, 1300);
        add(P({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 900, drag: 0.965, size: AX.rand(7, 12), color: AX.pick(colors), life: AX.rand(2, 3.4), shape: AX.pick(["confetti", "confetti", "star"]), vr: AX.rand(-8, 8), flip: AX.rand(5, 12) }));
      }
    });
  };
  /** Lluvia de monedas doradas. */
  fx.coinRain = function (o = {}) {
    ensureCanvas();
    const n = o.count || 60;
    const dur = o.duration || 1500;
    for (let i = 0; i < n; i++)
      setTimeout(() => {
        add(P({ x: AX.rand(10, innerWidth - 10), y: AX.rand(-60, -20), vx: AX.rand(-40, 40), vy: AX.rand(200, 500), g: 900, drag: 0.995, size: AX.rand(10, 17), life: AX.rand(1.8, 2.6), shape: "coin", flip: AX.rand(6, 14), fade: false }));
      }, (i / n) * dur);
  };
  /** Fuente de monedas desde un punto (p.ej. al cobrar). */
  fx.coinBurst = function (x, y, o = {}) {
    ensureCanvas();
    const n = o.count || 24;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + AX.rand(-0.9, 0.9);
      const v = AX.rand(400, 900);
      add(P({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 1600, drag: 0.985, size: AX.rand(9, 15), life: AX.rand(1.1, 1.8), shape: "coin", flip: AX.rand(6, 14) }));
    }
  };
  /** Monedas que vuelan de un punto a otro (p.ej. a la cartera del HUD). */
  fx.coinsTo = function (from, to, o = {}) {
    ensureCanvas();
    const n = o.count || 14;
    return new Promise((resolve) => {
      let done = 0;
      for (let i = 0; i < n; i++) {
        setTimeout(() => {
          const sx = from.x + AX.rand(-30, 30), sy = from.y + AX.rand(-30, 30);
          const node = el("div", "ax-coin");
          node.style.cssText = `position:fixed;left:0;top:0;z-index:2600;pointer-events:none;width:24px;height:24px;font-size:12px;`;
          document.body.appendChild(node);
          const midX = (sx + to.x) / 2 + AX.rand(-120, 120), midY = Math.min(sy, to.y) - AX.rand(60, 180);
          const t0 = performance.now(), dur = AX.rand(550, 800);
          const step = (now) => {
            const t = Math.min(1, (now - t0) / dur);
            const e = AX.ease.inOutCubic(t);
            const x = (1 - e) * (1 - e) * sx + 2 * (1 - e) * e * midX + e * e * to.x;
            const y = (1 - e) * (1 - e) * sy + 2 * (1 - e) * e * midY + e * e * to.y;
            node.style.transform = `translate(${x - 12}px,${y - 12}px) scale(${1 - t * 0.4})`;
            if (t < 1) requestAnimationFrame(step);
            else {
              node.remove();
              sfx.play("tick");
              if (++done === n) resolve();
            }
          };
          requestAnimationFrame(step);
        }, i * 45);
      }
    });
  };
  /** Fuegos artificiales durante `duration` ms. */
  fx.fireworks = function (o = {}) {
    ensureCanvas();
    const dur = o.duration || 2500;
    const count = o.count || 8;
    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        const x = AX.rand(innerWidth * 0.15, innerWidth * 0.85);
        const y = AX.rand(innerHeight * 0.12, innerHeight * 0.5);
        const colors = AX.pick([PALETTES.gold, PALETTES.ice, ["#ff2fb3", "#ffc2ec", "#fff"], ["#2bff88", "#b6ffd5", "#fff"], PALETTES.party]);
        // estela de subida
        add(P({ x, y: innerHeight + 10, vx: 0, vy: -(innerHeight + 10 - y) / 0.45, g: 0, drag: 1, life: 0.45, shape: "spark", size: 3, color: "#fff3b0" }));
        setTimeout(() => {
          fx.burst(x, y, { count: 70, speed: 380, gravity: 220, drag: 0.955, shape: "spark", size: 2.6, colors, life: 1.3 });
          fx.burst(x, y, { count: 18, speed: 160, gravity: 120, shape: "star", size: 5, colors, life: 1 });
          fx.glow(x, y, { size: 120, color: colors[0], life: 0.4 });
          sfx.noise(0.5, { type: "lowpass", freq: 1500, to: 200, vol: 0.25 });
        }, 450);
      }, (i / count) * dur + AX.rand(0, 200));
    }
  };
  /** Texto flotante (+500 €). */
  fx.floatText = function (x, y, text, o = {}) {
    const node = el("div", "", text);
    node.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:2550;pointer-events:none;transform:translate(-50%,-50%);font-family:var(--ax-display);font-size:${o.size || 28}px;color:${o.color || "#2bff88"};text-shadow:0 0 12px ${o.color || "#2bff88"},0 3px 0 rgba(0,0,0,.6);white-space:nowrap;`;
    document.body.appendChild(node);
    const anim = node.animate(
      [
        { opacity: 0, transform: "translate(-50%,-30%) scale(.5)" },
        { opacity: 1, transform: "translate(-50%,-60%) scale(1.15)", offset: 0.2 },
        { opacity: 1, transform: "translate(-50%,-110%) scale(1)", offset: 0.7 },
        { opacity: 0, transform: "translate(-50%,-170%) scale(.95)" },
      ],
      { duration: o.duration || 1300, easing: "ease-out" }
    );
    anim.onfinish = () => node.remove();
  };
  /** Sacudida de pantalla (o de un elemento). */
  fx.shake = function (intensity = 10, duration = 450, target) {
    if (AX.reducedMotion) return;
    const node = target || document.body;
    const frames = [];
    const steps = 10;
    for (let i = 0; i <= steps; i++) {
      const k = 1 - i / steps;
      frames.push({ transform: i === steps ? "translate(0,0)" : `translate(${AX.rand(-1, 1) * intensity * k}px,${AX.rand(-1, 1) * intensity * k}px) rotate(${AX.rand(-1, 1) * intensity * 0.08 * k}deg)` });
    }
    node.animate(frames, { duration, easing: "linear" });
  };
  /** Destello a pantalla completa. */
  fx.flash = function (color = "#fff", duration = 350, opacity = 0.8) {
    const node = el("div");
    node.style.cssText = `position:fixed;inset:0;z-index:2450;pointer-events:none;background:${color};`;
    document.body.appendChild(node);
    node.animate([{ opacity }, { opacity: 0 }], { duration, easing: "ease-out" }).onfinish = () => node.remove();
  };
  /** Cámara lenta visual: viñeta + zoom suave sobre el body durante ms. */
  fx.slowmo = function (ms = 1200) {
    const v = el("div");
    v.style.cssText = "position:fixed;inset:0;z-index:2400;pointer-events:none;box-shadow:inset 0 0 160px 60px rgba(0,0,0,.85);";
    document.body.appendChild(v);
    v.animate([{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: ms }).onfinish = () => v.remove();
  };
  /** Limpia todas las partículas. */
  fx.clear = () => (parts.length = 0);

  /* -------------------------------------------------------- CINEMÁTICAS */
  const cine = {};
  AX.cine = cine;

  function layer(cls) {
    const l = el("div", "ax-layer " + cls);
    document.body.appendChild(l);
    return l;
  }
  function closeLayer(l, ms = 450) {
    return new Promise((r) => {
      l.classList.add("ax-out");
      setTimeout(() => {
        l.remove();
        r();
      }, ms);
    });
  }

  /**
   * Cinemática de entrada a un juego.
   * opts: { title, subtitle, icon (emoji o HTML), color, duration (ms), once (bool: solo 1 vez por sesión), key }
   */
  cine.intro = function (opts = {}) {
    const key = opts.key || opts.title;
    if (opts.once) {
      try {
        const seen = JSON.parse(sessionStorage.getItem(AX.KEYS.INTRO_SEEN) || "[]");
        if (seen.includes(key)) return Promise.resolve();
        seen.push(key);
        sessionStorage.setItem(AX.KEYS.INTRO_SEEN, JSON.stringify(seen));
      } catch (e) {}
    }
    return new Promise((resolve) => {
      const l = layer("ax-cine");
      l.style.setProperty("--cine-color", opts.color || "#8b5cff");
      const letters = String(opts.title || "")
        .split("")
        .map((ch, i) => `<span style="animation-delay:${0.55 + i * 0.04}s">${ch === " " ? "&nbsp;" : ch}</span>`)
        .join("");
      l.innerHTML = `
        <div class="ax-cine-bg"></div>
        <div class="ax-bar top"></div><div class="ax-bar bot"></div>
        ${opts.icon ? `<div class="ax-cine-icon">${opts.icon}</div>` : ""}
        <div class="ax-cine-title">${letters}</div>
        ${opts.subtitle ? `<div class="ax-cine-sub">${opts.subtitle}</div>` : ""}
        <div class="ax-cine-sweep"></div>
        <div class="ax-cine-skip">Toca para continuar</div>`;
      sfx.play("riser");
      let ended = false;
      const timers = [];
      timers.push(setTimeout(() => {
        sfx.play("impact");
        AX.haptic("medium");
        const c = { x: innerWidth / 2, y: innerHeight / 2 };
        fx.shockwave(c.x, c.y, { color: opts.color || "#ffd23f", radius: Math.max(innerWidth, innerHeight) * 0.7, width: 14, rings: 2 });
        fx.sparks(c.x, c.y, { count: 60, colors: "gold", speed: 900 });
        fx.shake(8, 400, l);
      }, 900));
      timers.push(setTimeout(() => sfx.play("shimmer"), 1200));
      const finish = () => {
        if (ended) return;
        ended = true;
        timers.forEach(clearTimeout);
        sfx.play("whoosh");
        closeLayer(l, 600).then(resolve);
      };
      timers.push(setTimeout(finish, opts.duration || 2900));
      l.addEventListener("pointerdown", () => setTimeout(finish, 0));
    });
  };

  function tierFor(amount, bet) {
    if (bet && bet > 0) {
      const m = amount / bet;
      if (m >= 25) return "epic";
      if (m >= 8) return "mega";
      if (m >= 3) return "big";
      return "win";
    }
    if (amount >= 100000) return "epic";
    if (amount >= 20000) return "mega";
    if (amount >= 3000) return "big";
    return "win";
  }
  const TIER_TEXT = { win: "¡Ganaste!", big: "¡Gran premio!", mega: "¡Mega premio!", epic: "¡Épico!" };

  /**
   * Celebración de victoria a pantalla completa con contador de dinero.
   * opts: { bet (para calcular nivel), tier ('win'|'big'|'mega'|'epic'), title, label, minDuration }
   * Devuelve una promesa que se resuelve al cerrar (toque o automático).
   */
  cine.bigWin = function (amount, opts = {}) {
    const tier = opts.tier || tierFor(amount, opts.bet);
    return new Promise((resolve) => {
      const l = layer("ax-win");
      l.dataset.tier = tier;
      l.innerHTML = `
        <div class="ax-rays"></div>
        <div class="ax-win-tier">${opts.title || TIER_TEXT[tier]}</div>
        ${opts.label ? `<div class="ax-win-label">${opts.label}</div>` : ""}
        <div class="ax-win-amount">+<span>0</span> €</div>
        <div class="ax-win-hint">Toca para continuar</div>`;
      const amountEl = l.querySelector(".ax-win-amount span");
      const heavy = tier !== "win";
      sfx.play(tier === "epic" || tier === "mega" ? "jackpot" : heavy ? "bigwin" : "win");
      AX.haptic(heavy ? "bigwin" : "win");
      fx.flash(tier === "epic" ? "#ff2fb3" : tier === "mega" ? "#22e4ff" : "#ffd23f", 500, 0.55);
      fx.shake(heavy ? 14 : 6, 500);
      const c = { x: innerWidth / 2, y: innerHeight * 0.45 };
      fx.shockwave(c.x, c.y, { radius: Math.max(innerWidth, innerHeight) * 0.8, rings: heavy ? 3 : 1, width: 16 });
      fx.sparks(c.x, c.y, { count: heavy ? 90 : 40, speed: 1000 });
      fx.coinRain({ count: { win: 30, big: 70, mega: 110, epic: 160 }[tier], duration: heavy ? 2200 : 1200 });
      if (heavy) fx.cannons({ count: tier === "big" ? 50 : 90 });
      if (tier === "mega" || tier === "epic") fx.fireworks({ count: tier === "epic" ? 12 : 7, duration: 2600 });
      const countMs = { win: 900, big: 1600, mega: 2200, epic: 2800 }[tier];
      let ticker = setInterval(() => sfx.play("tick"), 70);
      AX.countUp(amountEl, 0, amount, countMs).then(() => {
        clearInterval(ticker);
        ticker = null;
        sfx.play("cash");
        l.classList.add("ax-done");
        amountEl.parentElement.classList.add("ax-pop");
      });
      let ended = false;
      const t0 = Date.now();
      const minDur = opts.minDuration || 700;
      const finish = () => {
        if (ended || Date.now() - t0 < minDur) return;
        ended = true;
        if (ticker) clearInterval(ticker);
        amountEl.textContent = AX.fmt(amount);
        closeLayer(l, 450).then(resolve);
      };
      setTimeout(finish, opts.duration || countMs + 2200);
      l.addEventListener("pointerdown", finish);
    });
  };

  /**
   * Pantalla de derrota con efecto glitch.
   * opts: { title, subtitle, duration }
   */
  cine.defeat = function (opts = {}) {
    return new Promise((resolve) => {
      const l = layer("ax-lose");
      const t = opts.title || "¡Perdiste!";
      l.innerHTML = `<div class="ax-vignette-red"></div>
        <div class="ax-lose-title" data-text="${t}">${t}</div>
        ${opts.subtitle ? `<div class="ax-lose-sub">${opts.subtitle}</div>` : ""}`;
      sfx.play("lose");
      sfx.play("impact");
      AX.haptic("error");
      fx.shake(16, 550);
      fx.flash("#ff0030", 400, 0.45);
      let ended = false;
      const t0 = Date.now();
      const finish = () => {
        if (ended || Date.now() - t0 < 500) return;
        ended = true;
        closeLayer(l, 400).then(resolve);
      };
      setTimeout(finish, opts.duration || 2000);
      l.addEventListener("pointerdown", finish);
    });
  };

  /**
   * Banner barrido a media pantalla (no bloquea la interacción).
   * opts: { sub, color (css), duration, sound }
   */
  cine.banner = function (text, opts = {}) {
    return new Promise((resolve) => {
      const l = layer("ax-banner");
      l.style.setProperty("--banner-color", opts.color || "rgba(139, 92, 255, 0.92)");
      l.innerHTML = `<div class="ax-banner-strip"><div class="ax-banner-text">${text}</div>${opts.sub ? `<div class="ax-banner-sub">${opts.sub}</div>` : ""}</div>`;
      if (opts.sound !== false) sfx.play(opts.sound || "whoosh");
      AX.haptic("light");
      setTimeout(() => {
        l.remove();
        resolve();
      }, opts.duration || 1800);
    });
  };

  /** Cuenta atrás 3-2-1-¡YA! */
  cine.countdown = async function (n = 3, goText = "¡YA!") {
    const l = layer("ax-count");
    for (let i = n; i >= 1; i--) {
      l.innerHTML = `<div class="ax-count-num">${i}</div>`;
      sfx.play("count");
      AX.haptic("light");
      await AX.sleep(800);
    }
    l.innerHTML = `<div class="ax-count-num go">${goText}</div>`;
    sfx.play("go");
    AX.haptic("medium");
    fx.shockwave(innerWidth / 2, innerHeight / 2, { color: "#22e4ff", radius: innerWidth, width: 12 });
    await AX.sleep(650);
    l.remove();
  };

  /* ------------------------------------------------------------ TOASTS */
  let toastBox = null;
  /** type: info|success|error|gold */
  AX.toast = function (msg, type = "info", ms = 2600) {
    if (!toastBox) {
      toastBox = el("div", "ax-toasts");
      document.body.appendChild(toastBox);
    }
    const icon = { success: "✅", error: "⛔", gold: "⭐", info: "💬" }[type] || "";
    const t = el("div", "ax-toast " + type, `<span>${icon}</span><span>${msg}</span>`);
    toastBox.appendChild(t);
    while (toastBox.children.length > 3) toastBox.firstChild.remove();
    setTimeout(() => {
      t.classList.add("out");
      setTimeout(() => t.remove(), 300);
    }, ms);
  };

  /* ------------------------------------------------- AVISO DE LOGROS */
  let achQ = [], achBusy = false;
  AX.achievementQueue = function (list) {
    achQ.push(...list);
    if (!achBusy) nextAch();
  };
  function nextAch() {
    const a = achQ.shift();
    if (!a) return (achBusy = false);
    achBusy = true;
    const n = el("div", "ax-ach", `<div class="ax-ach-icon">🏆</div><div><div class="ax-ach-k">Logro desbloqueado</div><div class="ax-ach-n">${a.name}</div><div class="ax-ach-r">+${AX.fmt(a.reward)} € de recompensa</div></div>`);
    document.body.appendChild(n);
    sfx.play("achievement");
    AX.haptic("success");
    const c = AX.center(n);
    setTimeout(() => fx.stars(c.x, c.y + 20, { count: 20 }), 300);
    setTimeout(() => {
      n.classList.add("out");
      setTimeout(() => {
        n.remove();
        nextAch();
      }, 450);
    }, 3200);
  }

  /* ------------------------------------------------------------- MODAL */
  /**
   * Hoja modal. Devuelve una promesa con el `value` del botón pulsado (o null).
   * opts: { title, html, buttons: [{label, kind:'gold'|'green'|'red'|'cyan'|'ghost', value}], dismissable }
   */
  AX.modal = function (opts = {}) {
    return new Promise((resolve) => {
      const wrap = el("div", "ax-modal-wrap");
      const btns = (opts.buttons || [{ label: "Aceptar", kind: "gold", value: true }])
        .map((b, i) => `<button class="ax-btn ax-btn-${b.kind || "ghost"}" data-i="${i}">${b.label}</button>`)
        .join("");
      wrap.innerHTML = `<div class="ax-modal" role="dialog">${opts.title ? `<h2>${opts.title}</h2>` : ""}<div class="ax-modal-body">${opts.html || ""}</div><div class="ax-modal-actions">${btns}</div></div>`;
      document.body.appendChild(wrap);
      sfx.play("swoosh");
      const close = (v) => {
        wrap.classList.add("ax-out");
        setTimeout(() => wrap.remove(), 260);
        resolve(v);
      };
      wrap.querySelectorAll(".ax-modal-actions button").forEach((b) =>
        b.addEventListener("click", () => {
          sfx.play("tap");
          const def = opts.buttons ? opts.buttons[+b.dataset.i] : { value: true };
          close(def.value);
        })
      );
      if (opts.dismissable !== false)
        wrap.addEventListener("click", (e) => {
          if (e.target === wrap) close(null);
        });
      if (opts.onOpen) opts.onOpen(wrap.querySelector(".ax-modal"), close);
    });
  };
  AX.confirm = (title, html, yes = "Sí", no = "Cancelar") =>
    AX.modal({ title, html, buttons: [{ label: no, kind: "ghost", value: false }, { label: yes, kind: "gold", value: true }] });

  /* --------------------------------------------------------------- HUD */
  function muteIcon() {
    return muted
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m23 9-6 6M17 9l6 6"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>`;
  }
  AX.muteIcon = muteIcon;

  /**
   * Monta la barra superior.
   * opts: { title, back: url|false, balance: true, onBack: fn (si devuelve false cancela), right: HTMLElement }
   * Devuelve { root, balanceEl, setBalance(n), refresh() }
   */
  AX.hud = function (opts = {}) {
    const root = el("div", "ax-hud");
    const back = opts.back === false ? "" : `<button class="ax-icon-btn" data-ax-back aria-label="Volver"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>`;
    root.innerHTML = `${back}
      <div class="ax-hud-title">${opts.title || ""}</div>
      ${opts.balance === false ? "" : `<div class="ax-balance"><div class="ax-coin"></div><span data-ax-bal>${AX.fmt(AX.getBalance())}</span></div>`}
      <button class="ax-icon-btn" data-ax-mute aria-label="Sonido">${muteIcon()}</button>`;
    document.body.appendChild(root);
    if (opts.right) root.insertBefore(opts.right, root.querySelector("[data-ax-mute]"));
    const balWrap = root.querySelector(".ax-balance");
    const balEl = root.querySelector("[data-ax-bal]");
    let shown = AX.getBalance();
    const show = (v, animate = true) => {
      if (!balEl) return;
      const prev = shown;
      shown = v;
      if (!animate || prev === v) {
        balEl.textContent = AX.fmt(v);
        return;
      }
      AX.countUp(balEl, prev, v, 700);
      balWrap.classList.remove("ax-up", "ax-down");
      void balWrap.offsetWidth;
      balWrap.classList.add(v > prev ? "ax-up" : "ax-down");
      const d = el("div", "ax-delta " + (v > prev ? "pos" : "neg"), (v > prev ? "+" : "−") + AX.fmt(Math.abs(v - prev)));
      balWrap.appendChild(d);
      setTimeout(() => d.remove(), 1400);
    };
    AX.onBalance((v, prev, o) => show(v, !(o && o.silent)));
    global.addEventListener("storage", (e) => {
      if (e.key === AX.KEYS.BALANCE) show(AX.getBalance());
    });
    global.addEventListener("pageshow", () => show(AX.getBalance(), false));
    root.querySelector("[data-ax-mute]").addEventListener("click", () => {
      sfx.toggleMute();
      sfx.play("tap");
    });
    const b = root.querySelector("[data-ax-back]");
    if (b)
      b.addEventListener("click", async () => {
        sfx.play("tap");
        AX.haptic("light");
        if (opts.onBack) {
          const r = await opts.onBack();
          if (r === false) return;
        }
        AX.go(opts.back || "../index.html", b);
      });
    return {
      root,
      balanceEl: balWrap,
      /** Muestra un valor sin tocar el saldo guardado (útil durante una partida) */
      setBalance: (v, animate = true) => show(v, animate),
      refresh: () => show(AX.getBalance(), false),
      center: () => AX.center(balWrap),
    };
  };

  /* -------------------------------------------------------- TRANSICIÓN */
  let curtain = null;
  function mountCurtain() {
    curtain = el("div", "ax-curtain");
    document.body.appendChild(curtain);
    setTimeout(() => {
      if (curtain && !curtain.classList.contains("ax-leaving")) curtain.style.display = "none";
    }, 900);
  }
  /** Navega con transición en iris desde `fromEl` (opcional). */
  AX.go = function (url, fromEl) {
    if (!curtain) mountCurtain();
    const c = fromEl ? AX.center(fromEl) : { x: innerWidth / 2, y: innerHeight / 2 };
    curtain.style.display = "block";
    curtain.style.setProperty("--cx", c.x + "px");
    curtain.style.setProperty("--cy", c.y + "px");
    curtain.classList.add("ax-leaving");
    sfx.play("whoosh");
    setTimeout(() => (global.location.href = url), 430);
  };
  // Al volver con el botón "atrás" del navegador (bfcache) ocultar cortina
  global.addEventListener("pageshow", (e) => {
    if (e.persisted && curtain) {
      curtain.classList.remove("ax-leaving");
      curtain.style.display = "none";
    }
  });

  AX.ready(() => {
    document.body.classList.add("ax-body");
    mountCurtain();
  });
})(window);
