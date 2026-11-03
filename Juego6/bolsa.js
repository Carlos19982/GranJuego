/* ==========================================================================
   JUEGO 6 · BOLSA — motor único para:
     · juego6.html  (data-mode="pro")         → "Bolsa Pro" (1.000 / 5.000 / 10.000 €)
     · juego6b.html (data-mode="estrategia")  → "Estrategia avanzada" (100 €)

   ECONOMÍA (depósito en garantía):
     · Al empezar, la inversión elegida en el menú (sessionStorage
       "game6InitialInvestment") se COBRA del saldo global con AX.spend().
     · Al liquidar se ABONA el valor de liquidación (efectivo + acciones a
       precio de mercado) con AX.addBalance(). Resultado neto = valor − inversión,
       exactamente igual que antes.
     · La partida en curso vive en localStorage ("stockSimActiveGame_v3").
       Al salir / ocultar / recargar, la cartera se "aparca": su valor de
       liquidación se devuelve al saldo y queda una instantánea. Al volver se
       vuelve a cobrar ese mismo importe y se continúa exactamente donde estaba
       (vela en curso incluida). Así no se puede ganar ni perder dinero
       recargando o abandonando, y el menú siempre ve el saldo real.
   Requiere ../shared/arcade.js (objeto global AX).
   ========================================================================== */
(function () {
  "use strict";

  /* ------------------------------------------------------------ CONFIG */
  const MODE = document.body.dataset.mode === "estrategia" ? "estrategia" : "pro";
  const FILES = { pro: "juego6.html", estrategia: "juego6b.html" };
  const KEY_STATE = "stockSimActiveGame_v3"; // localStorage: partida en curso / aparcada
  const KEY_INV = "game6InitialInvestment"; // sessionStorage: lo escribe el menú
  const KEY_PREFS = "stockSimPrefs_v3"; // localStorage: preferencias de gráfico
  const LEGACY_KEYS = ["stockSimGameState_Pro", "stockSimGameState_v2"];
  const AMOUNTS = [100, 1000, 5000, 10000];
  const modeForAmount = (a) => (a === 100 ? "estrategia" : "pro");

  const SL_PCT = -4; // stop-loss  (igual que el original)
  const TP_PCT = 5; //  take-profit (igual que el original)
  const CANDLE_MS = 6000; // 1 vela = 1 "minuto" de mercado
  const STEPS = 30; // sub-pasos en directo por vela
  const STEP_MS = CANDLE_MS / STEPS;
  const HIST = 90; // velas guardadas por valor
  const PREGEN = 70; // velas de la sesión anterior
  const EVENT_P = 0.2; // prob. de noticia por vela
  const MAX_EVENTS = 2;
  const SHOCK_P = 0.025; // prob. de crash / rally por vela
  const SHOCK_COOLDOWN = 18;
  const ME = Math.random().toString(36).slice(2) + Date.now().toString(36);

  const CFG = {
    pro: {
      label: "Bolsa Pro",
      short: "Bolsa Pro",
      title: "Bolsa Pro",
      subtitle: "Suena la campana de apertura",
      icon: "🔔",
      color: "#22e4ff",
      accent: "rgba(34, 228, 255, 0.92)",
      cross: 0.005, // impulso de cruce dorado / de la muerte
      rsiRev: 0.004, // impulso de rebote RSI
      exhaust: 0.002, // presión por sobrecompra / sobreventa
      chart: "candles",
      cmp: false,
    },
    estrategia: {
      label: "Estrategia avanzada",
      short: "Estrategia 100",
      title: "Estrategia",
      subtitle: "Modo avanzado · señales más fuertes",
      icon: "♟️",
      color: "#ffcc33",
      accent: "rgba(255, 159, 28, 0.92)",
      cross: 0.006,
      rsiRev: 0.0044,
      exhaust: 0.002,
      chart: "area",
      cmp: true,
    },
  }[MODE];

  const INFO = {
    TECH: { name: "Tech Corp", sector: "Tecnología", icon: "💻", color: "#4f8bff" },
    FOOD: { name: "Foodies Inc", sector: "Alimentación", icon: "🍔", color: "#ffb020" },
    GAME: { name: "GameDev Co", sector: "Videojuegos", icon: "🎮", color: "#b07cff" },
    FIN: { name: "Finance Hub", sector: "Finanzas", icon: "🏦", color: "#18e0c0" },
    ECO: { name: "Eco Energy", sector: "Energía verde", icon: "🌿", color: "#9fe870" },
  };
  const BASE = [
    { sym: "TECH", price: 15.0, vol: 0.055, trend: 0.00002 },
    { sym: "FOOD", price: 5.0, vol: 0.03, trend: 0.00001 },
    { sym: "GAME", price: 8.0, vol: 0.07, trend: -0.00001 },
    { sym: "FIN", price: 20.0, vol: 0.045, trend: 0.000015 },
    { sym: "ECO", price: 7.0, vol: 0.065, trend: 0.00003 },
  ];

  // Noticias originales de cada versión (mismos modificadores de tendencia)
  const EVENTS_PRO = [
    { name: "Optimismo Global", icon: "🌍", message: "El mercado muestra optimismo. ¿Oportunidad o trampa?", target: "ALL", duration: 3, trend_modifier: 0.0001, volatility_modifier: 2.0 },
    { name: "Temor a Recesión", icon: "📉", message: "Aumentan los temores de recesión.", target: "ALL", duration: 3, trend_modifier: -0.00015, volatility_modifier: 2.2 },
    { name: "Anuncio Tecnológico", icon: "💻", message: "Tech Corp hará un anuncio importante.", target: "TECH", duration: 3, trend_modifier: 0.0004, volatility_modifier: 2.6 },
    { name: "Regulación Tecnológica", icon: "⚖️", message: "Nuevas regulaciones para el sector Tech.", target: "TECH", duration: 3, trend_modifier: -0.00025, volatility_modifier: 2.4 },
    { name: "Movimientos Banca", icon: "🏦", message: "Finance Hub reporta ingresos récord.", target: "FIN", duration: 3, trend_modifier: 0.0003, volatility_modifier: 2.2 },
    { name: "Caída del Petróleo", icon: "🛢️", message: "El petróleo se desploma. Bueno para Eco Energy.", target: "ECO", duration: 3, trend_modifier: 0.00035, volatility_modifier: 2.6 },
    { name: "Proyecto Secreto", icon: "🎮", message: "GameDev Co. anuncia un proyecto secreto.", target: "GAME", duration: 3, trend_modifier: 0.0005, volatility_modifier: 3.0 },
    { name: "Cadena de Suministro", icon: "🚚", message: "Foodies Inc tiene problemas de suministro.", target: "FOOD", duration: 3, trend_modifier: -0.0002, volatility_modifier: 2.4 },
  ];
  const EVENTS_ADV = [
    { name: "Optimismo Global Cauteloso", icon: "🌍", message: "El mercado muestra optimismo, pero los analistas piden cautela. ¿Oportunidad o trampa?", target: "ALL", duration: 3, volatility_modifier: 2.5, trend_modifier: -0.00005 },
    { name: "Temor a Recesión", icon: "📉", message: "Aumentan los temores de recesión, pero algunos ven oportunidades de compra.", target: "ALL", duration: 3, volatility_modifier: 2.8, trend_modifier: 0.00006 },
    { name: "Anuncio Tecnológico", icon: "💻", message: "Tech Corp hará un 'anuncio importante' esta semana. El mercado especula.", target: "TECH", duration: 3, volatility_modifier: 3.0, trend_modifier: 0.0003 },
    { name: "Regulación Tecnológica", icon: "⚖️", message: "Se anuncian nuevas regulaciones para el sector Tech. ¿Protegerán al consumidor o ahogarán la innovación?", target: "TECH", duration: 3, volatility_modifier: 2.9, trend_modifier: -0.00015 },
    { name: "Movimientos en la Banca", icon: "🏦", message: "Finance Hub reporta 'movimientos inesperados' en sus cuentas. ¿Bueno o malo?", target: "FIN", duration: 3, volatility_modifier: 2.5, trend_modifier: 0.00015 },
    { name: "Caída del Petróleo", icon: "🛢️", message: "El petróleo se desploma. Malo para las petroleras, ¿pero bueno para los costes de Eco Energy?", target: "ECO", duration: 3, volatility_modifier: 3.1, trend_modifier: 0.00018 },
    { name: "Nuevo Proyecto de GameDev", icon: "🎮", message: "GameDev Co. anuncia un proyecto secreto llamado 'Prometeo'. La comunidad está dividida.", target: "GAME", duration: 3, volatility_modifier: 3.5, trend_modifier: 0.0004 },
    { name: "Cadena de Suministro", icon: "🚚", message: "Foodies Inc reestructura su cadena de suministro. ¿Reducción de costes o señal de problemas?", target: "FOOD", duration: 3, volatility_modifier: 2.8, trend_modifier: -0.00009 },
    { name: "Datos de Inflación", icon: "📊", message: "¡Datos de inflación generan alta incertidumbre y volatilidad!", target: "ALL", duration: 3, volatility_modifier: 2.7, trend_modifier: -0.00003 },
    { name: "Desastre Natural", icon: "🌪️", message: "¡Desastre natural impacta la economía global!", target: "ALL", duration: 3, volatility_modifier: 2.9, trend_modifier: -0.0001 },
  ];
  // Eventos extremos (comunes a ambos modos, simétricos: crash y rally igual de probables)
  const SHOCKS = [
    { name: "CRASH", kind: "crash", icon: "💥", message: "Pánico vendedor: las bolsas de todo el mundo se desploman.", target: "ALL", duration: 2, trend_modifier: -0.012, volatility_modifier: 2.6, jolt: [-0.075, -0.035] },
    { name: "RALLY", kind: "rally", icon: "🚀", message: "Euforia compradora: los bancos centrales recortan tipos por sorpresa.", target: "ALL", duration: 2, trend_modifier: 0.012, volatility_modifier: 2.4, jolt: [0.035, 0.075] },
  ];
  const EVENTS = MODE === "estrategia" ? EVENTS_ADV : EVENTS_PRO;
  const EV_BY_NAME = {};
  EVENTS.concat(SHOCKS).forEach((e) => (EV_BY_NAME[e.name] = e));
  const evVolMul = (ev) => 1 + ((ev.volatility_modifier || 1) - 1) * 0.3; // volatilidad de noticia, atenuada

  const MILESTONES = [
    { id: "p10", r: 1.1, v: "+10 %", s: "¡Tu cartera despega!", tier: 1 },
    { id: "p25", r: 1.25, v: "+25 %", s: "¡Racha alcista!", tier: 1 },
    { id: "p50", r: 1.5, v: "+50 %", s: "¡Lobo de Wall Street!", tier: 2 },
    { id: "x2", r: 2, v: "×2", s: "¡Has duplicado tu inversión!", tier: 3 },
    { id: "x3", r: 3, v: "×3", s: "¡Triplicas tu dinero!", tier: 3 },
    { id: "x5", r: 5, v: "×5", s: "¡Leyenda del parqué!", tier: 4 },
    { id: "x10", r: 10, v: "×10", s: "¡Magnate de la bolsa!", tier: 4 },
  ];
  const DRAWDOWNS = [
    { id: "m25", r: 0.75, v: "−25 %", s: "Cuidado: tu cartera sangra" },
    { id: "m50", r: 0.5, v: "−50 %", s: "Alerta roja: medio capital perdido" },
  ];

  /* ------------------------------------------------------------ UTILIDADES */
  const $ = (s, r) => (r || document).querySelector(s);
  const r2 = (n) => Math.round(n * 100) / 100;
  const r4 = (n) => Math.round(n * 10000) / 10000;
  const money = (n) => AX.money(n, 2);
  const smoney = (n) => (n >= 0 ? "+" : "−") + AX.money(Math.abs(n), 2);
  const pct = (p) => (p >= 0 ? "+" : "−") + AX.fmt(Math.abs(p), 2) + "\u00a0%";
  const cls = (n) => (n > 0 ? "bx-up" : n < 0 ? "bx-down" : "");
  const gauss = () => {
    let u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function clockOf(t) {
    const k = t - PREGEN;
    const m = 570 + (((k % 390) + 390) % 390); // 09:30 → 16:00
    const hh = Math.floor(m / 60), mm = m % 60;
    return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
  }
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) {} };
  const ssGet = (k) => { try { return sessionStorage.getItem(k); } catch (e) { return null; } };
  const ssDel = (k) => { try { sessionStorage.removeItem(k); } catch (e) {} };
  const ssSet = (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) {} };

  const ring = (x, y, o) => AX.fx.shockwave(x, y, o);

  /* Cola de cinemáticas: noticias, crash/rally, SL/TP e hitos se suceden sin solaparse
     (el dinero se mueve al instante; sólo el espectáculo espera su turno). */
  let fxQ = Promise.resolve();
  function queueFx(fn) {
    fxQ = fxQ.then(() => (settled || locked ? null : fn())).catch((e) => console.error(e));
    return fxQ;
  }

  /* ------------------------------------------------------------ SONIDOS PROPIOS */
  const S = AX.sfx;
  S.register("bell", (delay = 0) => {
    const f = 660;
    [[1, 0.2, 2.4], [2.76, 0.09, 1.6], [5.4, 0.05, 1.1], [8.93, 0.025, 0.7], [0.5, 0.07, 2.6], [1.5, 0.04, 1.4]].forEach(([m, v, d]) =>
      S.tone(f * m, d, { type: "sine", vol: v, attack: 0.002, delay })
    );
    S.noise(0.06, { freq: 5000, q: 2, vol: 0.18, delay });
  });
  S.register("register", () => {
    S.noise(0.05, { type: "lowpass", freq: 700, vol: 0.4 });
    S.tone(180, 0.06, { type: "square", vol: 0.06 });
    S.noise(0.04, { freq: 3000, q: 3, vol: 0.25, delay: 0.06 });
    S.tone(S.note(96), 0.6, { type: "sine", vol: 0.13, delay: 0.1 });
    S.tone(S.note(100), 0.7, { type: "sine", vol: 0.11, delay: 0.16 });
    S.tone(S.note(103), 0.5, { type: "triangle", vol: 0.05, delay: 0.16 });
  });
  S.register("alert", () => {
    for (let i = 0; i < 3; i++) {
      S.tone(988, 0.11, { type: "square", vol: 0.07, delay: i * 0.24, filter: { freq: 3000 } });
      S.tone(740, 0.11, { type: "square", vol: 0.07, delay: i * 0.24 + 0.12, filter: { freq: 3000 } });
    }
    S.noise(0.5, { freq: 400, to: 4000, q: 2, vol: 0.12, attack: 0.3 });
  });
  S.register("crash", () => {
    S.play("boom");
    S.tone(600, 1.2, { type: "sawtooth", to: 60, vol: 0.08, filter: { freq: 1800 } });
    S.tone(420, 1.2, { type: "sawtooth", to: 45, vol: 0.06, delay: 0.1, filter: { freq: 1500 } });
  });
  S.register("rally", () => {
    S.play("powerup");
    [72, 76, 79, 84, 88].forEach((n, i) => S.tone(S.note(n), 0.3, { type: "square", vol: 0.06, delay: 0.2 + i * 0.07, filter: { freq: 3500 } }));
  });
  S.register("sell", () => {
    S.play("cash");
    S.noise(0.08, { freq: 2500, to: 6000, q: 2, vol: 0.15 });
  });

  /* ------------------------------------------------------------ ESTADO */
  let st = null; // partida en curso
  let busy = true; // cinemáticas / arranque: el mercado no avanza
  let settled = false; // partida liquidada en esta página
  let locked = false; // otra pestaña controla la partida
  let hud = null;
  let qty = 1;
  let pctSel = null;
  let lastSavedStep = -1;
  let prefs = Object.assign({ ma: true, rsi: null, type: CFG.chart, cmp: CFG.cmp }, (() => {
    try { return JSON.parse(lsGet(KEY_PREFS) + "") || {}; } catch (e) { return {}; }
  })()[MODE] || {});
  const savePrefs = () => {
    let all = {};
    try { all = JSON.parse(lsGet(KEY_PREFS) + "") || {}; } catch (e) {}
    all[MODE] = prefs;
    lsSet(KEY_PREFS, JSON.stringify(all));
  };

  const sel = () => st.stocks.find((s) => s.sym === st.selected) || st.stocks[0];
  const stockBy = (sym) => st.stocks.find((s) => s.sym === sym);
  const px = (s) => Math.max(0.01, r2(s.live)); // precio de ejecución (céntimos)
  const holdingsValue = () => Object.keys(st.portfolio).reduce((a, k) => a + st.portfolio[k].qty * px(stockBy(k)), 0);
  const equity = () => r2(st.cash + holdingsValue());
  const running = () => st && !busy && !settled && !locked && !st.paused && !st.parked;

  function readStored() {
    const raw = lsGet(KEY_STATE);
    if (!raw) return null;
    try {
      const o = JSON.parse(raw);
      if (!o || o.v !== 3 || !o.id || !Array.isArray(o.stocks) || typeof o.cash !== "number") return null;
      return o;
    } catch (e) {
      return null;
    }
  }
  /** Comprueba que seguimos siendo los dueños de la partida guardada. */
  function owns() {
    const o = readStored();
    return !!(o && st && o.id === st.id && o.owner === ME);
  }
  function save(force) {
    if (!st || settled || locked) return false;
    if (!force) {
      const o = readStored();
      if (!o || o.id !== st.id || o.owner !== ME) {
        lockOut(o && o.id === st.id ? "other" : "gone");
        return false;
      }
    }
    st.owner = ME;
    st.savedAt = Date.now();
    lastSavedStep = st.tick * STEPS + st.step;
    if (!lsSet(KEY_STATE, JSON.stringify(st))) {
      AX.toast("No se pudo guardar la partida (almacenamiento lleno)", "error");
      return false;
    }
    return true;
  }
  function clearStored() {
    lsDel(KEY_STATE);
  }

  /* ------------------------------------------------------------ MOTOR DE MERCADO */
  function makeStock(b) {
    return {
      sym: b.sym, price: b.price, vol: b.vol, trend: b.trend,
      candles: [], ma5: b.price, ma15: b.price, rsi: 50, avgGain: 0, avgLoss: 0,
      trendState: "neutral", trendTicks: 0, rsiRev: 0, wasOB: false, wasOS: false,
      open: b.price, hi: b.price, lo: b.price, live: b.price, path: null, dayOpen: b.price,
    };
  }

  /** Puente browniano de open → close con ruido intra-vela. */
  function bridge(o, c, amp, fast) {
    const w = [0];
    for (let i = 1; i <= STEPS; i++) w[i] = w[i - 1] + gauss() * amp;
    const p = [];
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      const shape = fast ? 1 - Math.pow(1 - t, 3) : t;
      const noise = (w[i] - t * w[STEPS]) * (fast ? 0.6 : 1);
      p.push(r4(Math.max(0.01, o + (c - o) * shape + noise)));
    }
    p[0] = r4(o);
    p[STEPS] = r4(c);
    return p;
  }

  /** Planifica la siguiente vela (misma fórmula que el original + volatilidad de noticias). */
  function planCandle(s) {
    const open = s.candles.length ? s.candles[s.candles.length - 1].c : s.price;
    let drift = s.trend, volMul = 1, jolt = 0;
    for (const ae of st.events) {
      const ev = EV_BY_NAME[ae.name];
      if (!ev || (ev.target !== "ALL" && ev.target !== s.sym)) continue;
      drift += ev.trend_modifier;
      volMul *= evVolMul(ev);
      if (ae.fresh) {
        if (ev.jolt) jolt += AX.rand(ev.jolt[0], ev.jolt[1]) * (0.7 + s.vol * 6);
        else jolt += Math.sign(ev.trend_modifier || 0) * AX.rand(0.012, 0.03) * evVolMul(ev);
      }
    }
    if (s.trendState === "bullish") drift += CFG.cross;
    else if (s.trendState === "bearish") drift -= CFG.cross;
    if (s.rsiRev > 0) { drift += CFG.rsiRev; s.rsiRev--; }
    else if (s.rsiRev < 0) { drift -= CFG.rsiRev; s.rsiRev++; }
    else {
      if (s.rsi > 70) drift -= CFG.exhaust;
      if (s.rsi < 30) drift += CFG.exhaust;
    }
    const shock = (Math.random() - 0.5) * 2 * s.vol * volMul;
    const close = Math.max(0.01, open * (1 + shock + drift + jolt));
    s.open = r4(open);
    s.path = bridge(open, close, open * s.vol * 0.12 * volMul, jolt !== 0);
    s.live = s.hi = s.lo = s.open;
  }

  /** Cierra la vela y actualiza medias móviles, tendencias y RSI. Devuelve la señal (si la hay). */
  function closeCandle(s) {
    const c = { t: st.tick, o: r4(s.open), h: r4(Math.max(s.hi, s.live)), l: r4(Math.min(s.lo, s.live)), c: r4(s.live) };
    s.candles.push(c);
    if (s.candles.length > HIST) s.candles.shift();
    s.price = c.c;
    const n = s.candles.length;
    let sig = null;
    if (n >= 15) {
      const wasAbove = s.ma5 > s.ma15;
      let a5 = 0, a15 = 0;
      for (let i = n - 15; i < n; i++) { a15 += s.candles[i].c; if (i >= n - 5) a5 += s.candles[i].c; }
      s.ma5 = a5 / 5;
      s.ma15 = a15 / 15;
      const isAbove = s.ma5 > s.ma15;
      if (s.trendTicks > 0) {
        s.trendTicks--;
        if (!s.trendTicks) s.trendState = "neutral";
      }
      if (!s.trendTicks) {
        if (!wasAbove && isAbove) { s.trendState = "bullish"; s.trendTicks = 6; sig = "gold"; }
        else if (wasAbove && !isAbove) { s.trendState = "bearish"; s.trendTicks = 6; sig = "death"; }
      }
      c.m5 = r4(s.ma5);
      c.m15 = r4(s.ma15);
    }
    if (n >= 2) {
      const ch = c.c - s.candles[n - 2].c;
      s.avgGain = (s.avgGain * 13 + (ch > 0 ? ch : 0)) / 14;
      s.avgLoss = (s.avgLoss * 13 + (ch < 0 ? -ch : 0)) / 14;
      s.rsi = s.avgLoss === 0 ? 100 : 100 - 100 / (1 + s.avgGain / s.avgLoss);
    }
    if (s.wasOB && s.rsi < 70) { s.rsiRev = -3; sig = sig || "rsiDown"; }
    if (s.wasOS && s.rsi > 30) { s.rsiRev = 3; sig = sig || "rsiUp"; }
    s.wasOB = s.rsi >= 70;
    s.wasOS = s.rsi <= 30;
    c.r = Math.round(s.rsi * 10) / 10;
    if (sig) c.s = sig;
    return sig;
  }

  /** Igual que el original: caducan noticias, y con cierta probabilidad entra una nueva. */
  function manageEvents() {
    st.events = st.events.filter((ae) => --ae.rem > 0);
    if (st.shockCool > 0) st.shockCool--;
    let fresh = null;
    const shockActive = st.events.some((ae) => EV_BY_NAME[ae.name] && EV_BY_NAME[ae.name].kind);
    if (!shockActive && !st.shockCool && Math.random() < SHOCK_P) {
      fresh = AX.pick(SHOCKS);
      st.shockCool = SHOCK_COOLDOWN;
    } else if (st.events.length < MAX_EVENTS && Math.random() < EVENT_P) {
      const avail = EVENTS.filter((e) => !st.events.some((ae) => ae.name === e.name));
      if (avail.length) fresh = AX.pick(avail);
    }
    if (fresh) {
      st.events.push({ name: fresh.name, rem: fresh.duration, fresh: true });
      st.news.unshift({ t: st.tick, name: fresh.name });
      if (st.news.length > 12) st.news.pop();
    }
    return fresh;
  }

  function freshState(inv) {
    st = {
      v: 3, id: rid(), owner: ME, mode: MODE, investment: inv, createdAt: Date.now(), savedAt: 0,
      cash: inv, portfolio: {}, stocks: BASE.map(makeStock), events: [], tick: 0, step: 0, shockCool: 6,
      history: [], marks: [], news: [], milestones: [], paused: false, parked: 0, selected: "TECH",
      stats: { trades: 0, best: null, worst: null, peak: inv, low: inv, realized: 0 },
    };
    // Historial previo (sesión anterior) para que el gráfico y los indicadores arranquen llenos
    for (let i = 0; i < PREGEN; i++) {
      for (const s of st.stocks) {
        planCandle(s);
        s.live = s.path[STEPS];
        for (const v of s.path) { s.hi = Math.max(s.hi, v); s.lo = Math.min(s.lo, v); }
        closeCandle(s);
      }
      st.tick++;
    }
    for (const s of st.stocks) {
      s.dayOpen = s.price;
      planCandle(s);
    }
    st.step = 0;
    return st;
  }

  /* ------------------------------------------------------------ BUCLE */
  function step() {
    if (!running()) return;
    st.step++;
    for (const s of st.stocks) {
      s.live = s.path[Math.min(STEPS, st.step)];
      if (s.live > s.hi) s.hi = s.live;
      if (s.live < s.lo) s.lo = s.live;
    }
    checkAutoOrders();
    if (st.step >= STEPS) endCandle();
    else if (st.step % 5 === 0) save();
    updateLive();
  }

  function endCandle() {
    const sigs = [];
    for (const s of st.stocks) {
      const sig = closeCandle(s);
      if (sig) sigs.push([s.sym, sig]);
    }
    st.tick++;
    st.step = 0;
    const ev = manageEvents();
    for (const s of st.stocks) planCandle(s);
    st.events.forEach((ae) => (ae.fresh = false));
    CH.slide += CH.spacing;
    // UI de cierre de vela
    chipsCandle();
    tickerBuild();
    sigs.forEach(([sym, sig]) => {
      if (sym !== st.selected) return;
      const T = {
        gold: ["✦ Cruce dorado en " + sym + ": posible tendencia alcista", "success"],
        death: ["✖ Cruce de la muerte en " + sym + ": posible tendencia bajista", "error"],
        rsiUp: ["Rebote alcista del RSI en " + sym, "success"],
        rsiDown: ["Rebote bajista del RSI en " + sym, "error"],
      }[sig];
      if (T) AX.toast(T[0], T[1], 2400);
    });
    const eq = equity();
    st.stats.peak = Math.max(st.stats.peak, eq);
    st.stats.low = Math.min(st.stats.low, eq);
    save();
    if (ev) queueFx(() => showEvent(ev));
    checkMilestones();
    checkBroke();
  }

  /* ------------------------------------------------------------ OPERACIONES */
  function maxBuy(s) {
    const p = px(s);
    let q = Math.floor(st.cash / p);
    while (q > 0 && r2(p * q) > st.cash + 1e-9) q--;
    return Math.max(0, q);
  }

  function buy(sym, q) {
    if (!st || settled || locked) return;
    if (st.paused || busy) return deny("buy", "Mercado en pausa. Reanúdalo para operar.");
    const s = stockBy(sym);
    q = Math.floor(q);
    if (!s || !(q > 0)) return deny("buy", "Cantidad inválida.");
    const p = px(s);
    const cost = r2(p * q);
    if (cost > st.cash + 1e-9) {
      const m = maxBuy(s);
      return deny("buy", m > 0 ? `Dinero insuficiente: como mucho ${m} acc.` : "No tienes dinero suficiente ni para una acción.");
    }
    st.cash = r2(st.cash - cost);
    const pos = st.portfolio[sym];
    if (pos) {
      pos.avg = (pos.avg * pos.qty + cost) / (pos.qty + q);
      pos.qty += q;
    } else {
      st.portfolio[sym] = { qty: q, avg: p, sl: false, tp: false };
    }
    logTrade("COMPRA", sym, q, p, null);
    save();
    // efectos
    S.play("register");
    AX.haptic("success");
    const b = AX.center($("#bx-buy"));
    AX.fx.floatText(b.x, b.y - 30, `+${q} ${sym}`, { color: "#2bff88", size: 24 });
    AX.fx.sparks(b.x, b.y, { colors: "green", count: 18, speed: 420 });
    AX.fx.coinsTo(b, AX.center($("#bx-pos")), { count: Math.min(10, 3 + Math.round(Math.log10(cost + 1) * 2)) });
    pulse($("#bx-pos"));
    updateLive(true);
  }

  /** Venta. kind: VENTA | SL | TP | LIQUIDACIÓN */
  function sell(sym, q, kind = "VENTA", quiet = false) {
    if (!st || settled || locked) return false;
    if (kind === "VENTA" && (st.paused || busy)) { deny("sell", "Mercado en pausa. Reanúdalo para operar."); return false; }
    const pos = st.portfolio[sym];
    const s = stockBy(sym);
    if (!pos || !s) { if (!quiet) deny("sell", `No tienes acciones de ${sym}.`); return false; }
    q = Math.min(Math.floor(q), pos.qty);
    if (!(q > 0)) { if (!quiet) deny("sell", "Cantidad inválida."); return false; }
    const p = px(s);
    const rev = r2(p * q);
    const pnl = r2((p - pos.avg) * q);
    st.cash = r2(st.cash + rev);
    pos.qty -= q;
    if (pos.qty <= 0) delete st.portfolio[sym];
    logTrade(kind, sym, q, p, pnl);
    if (!quiet) save();
    if (quiet) return true;
    // efectos
    const fromEl = kind === "VENTA" ? $("#bx-sell") : $("#bx-pos");
    const c = AX.center(fromEl);
    S.play("sell");
    AX.haptic(pnl >= 0 ? "success" : "medium");
    AX.fx.floatText(c.x, c.y - 34, "+" + money(rev), { color: "#ffe680", size: 22 });
    setTimeout(() => AX.fx.floatText(c.x, c.y - 4, (pnl >= 0 ? "Beneficio " : "Pérdida ") + smoney(pnl), { color: pnl >= 0 ? "#2bff88" : "#ff3b5c", size: 17 }), 220);
    AX.fx.coinBurst(c.x, c.y, { count: pnl > 0 ? 16 : 6 });
    if (pnl > 0) AX.fx.sparks(c.x, c.y, { colors: "gold", count: 26 });
    bumpEq();
    updateLive(true);
    return true;
  }

  function logTrade(k, sym, q, p, pnl) {
    st.history.unshift({ k, sym, q, p, pnl, t: st.tick });
    if (st.history.length > 80) st.history.pop();
    st.marks.push({ t: st.tick, sym, side: k === "COMPRA" ? "b" : "s" });
    if (st.marks.length > 160) st.marks.shift();
    st.stats.trades++;
    if (pnl != null) {
      st.stats.realized = r2(st.stats.realized + pnl);
      if (st.stats.best == null || pnl > st.stats.best.pnl) st.stats.best = { sym, pnl };
      if (st.stats.worst == null || pnl < st.stats.worst.pnl) st.stats.worst = { sym, pnl };
    }
    histDirty = true;
  }

  function checkAutoOrders() {
    for (const sym of Object.keys(st.portfolio)) {
      const pos = st.portfolio[sym];
      const s = stockBy(sym);
      if (!s || pos.qty <= 0 || pos.avg <= 0) continue;
      const g = ((px(s) - pos.avg) / pos.avg) * 100;
      if (pos.sl && g <= SL_PCT) autoSell(sym, "SL", g);
      else if (pos.tp && g >= TP_PCT) autoSell(sym, "TP", g);
    }
  }
  function autoSell(sym, kind, g) {
    const pos = st.portfolio[sym];
    const q = pos.qty;
    const p = px(stockBy(sym));
    const pnl = r2((p - pos.avg) * q);
    sell(sym, q, kind, true);
    save();
    bumpEq();
    updateLive(true);
    const sub = `${sym} · ${AX.fmt(q)} acc. a ${money(p)} · ${smoney(pnl)}`;
    queueFx(() => {
      const c = AX.center($("#bx-pos"));
      if (kind === "SL") {
        AX.haptic("error");
        AX.fx.shake(7, 380);
        AX.fx.flash("#ff0030", 300, 0.25);
        AX.fx.burst(c.x, c.y, { colors: "blood", count: 30 });
        return AX.cine.banner("STOP-LOSS", { sub, color: "rgba(255, 59, 92, 0.94)", sound: "error", duration: 1900 });
      }
      AX.haptic("win");
      S.play("sell");
      AX.fx.coinBurst(c.x, c.y, { count: 22 });
      AX.fx.stars(c.x, c.y, { count: 14 });
      return AX.cine.banner("TAKE-PROFIT", { sub, color: "rgba(10, 163, 88, 0.94)", sound: "win", duration: 1900 });
    });
  }

  function deny(which, msg) {
    S.play("error");
    AX.haptic("error");
    AX.toast(msg, "error", 2200);
    const b = $(which === "buy" ? "#bx-buy" : "#bx-sell");
    if (b) {
      b.classList.remove("bx-deny");
      void b.offsetWidth;
      b.classList.add("bx-deny");
    }
    return false;
  }
  function pulse(node) {
    if (!node) return;
    node.classList.remove("ax-pop");
    void node.offsetWidth;
    node.classList.add("ax-pop");
  }

  /* ------------------------------------------------------------ HITOS */
  function checkMilestones() {
    const r = equity() / st.investment;
    for (const m of MILESTONES) {
      if (r >= m.r && !st.milestones.includes(m.id)) {
        st.milestones.push(m.id);
        save();
        queueFx(() => celebrate(m));
        return;
      }
    }
    for (const m of DRAWDOWNS) {
      if (r <= m.r && !st.milestones.includes(m.id)) {
        st.milestones.push(m.id);
        save();
        queueFx(() => celebrate(m, true));
        return;
      }
    }
  }
  function celebrate(m, neg) {
    const l = AX.el("div", "bx-mile" + (neg ? " neg" : ""));
    l.innerHTML = `<div class="bx-mile-ring"></div><div class="bx-mile-k">${neg ? "Alerta de cartera" : "Hito de cartera"}</div><div class="bx-mile-v">${m.v}</div><div class="bx-mile-s">${m.s}</div>`;
    document.body.appendChild(l);
    const cx = innerWidth / 2, cy = innerHeight / 2;
    if (neg) {
      S.play("lose");
      AX.haptic("error");
      AX.fx.flash("#ff0030", 400, 0.3);
      AX.fx.shake(8, 400);
    } else {
      const tier = m.tier || 1;
      S.play(tier >= 3 ? "jackpot" : tier === 2 ? "bigwin" : "win");
      AX.haptic(tier >= 2 ? "bigwin" : "win");
      AX.fx.flash(tier >= 3 ? "#ffd23f" : "#2bff88", 450, 0.35);
      ring(cx, cy, { radius: Math.max(innerWidth, innerHeight) * 0.7, rings: tier, width: 14 });
      AX.fx.stars(cx, cy, { count: 24 });
      if (tier === 1) AX.fx.confetti({ count: 90 });
      if (tier >= 2) AX.fx.cannons({ count: 60 + tier * 15 });
      if (tier >= 3) { AX.fx.fireworks({ count: 6 + tier * 2, duration: 2400 }); AX.fx.coinRain({ count: 50 * (tier - 1), duration: 1800 }); }
    }
    return new Promise((resolve) =>
      setTimeout(() => { l.classList.add("out"); setTimeout(() => { l.remove(); resolve(); }, 450); }, neg ? 1500 : 2000)
    );
  }
  let brokeShown = false;
  function checkBroke() {
    if (brokeShown || Object.keys(st.portfolio).length) return;
    const cheapest = Math.min(...st.stocks.map(px));
    if (st.cash >= cheapest) return;
    brokeShown = true;
    AX.modal({
      title: "Sin liquidez",
      html: `<p class="bx-lock-msg">No te queda efectivo para comprar ni una acción.<br>Liquida para cerrar la partida y recuperar lo que queda (<b>${money(equity())}</b>).</p>`,
      buttons: [{ label: "Seguir mirando", kind: "ghost", value: false }, { label: "Liquidar", kind: "gold", value: true }],
    }).then((v) => v && cashOut());
  }

  /* ------------------------------------------------------------ CINEMÁTICAS */
  function tapeHTML() {
    const items = (st ? st.stocks : BASE.map((b) => ({ sym: b.sym, live: b.price, dayOpen: b.price }))).map((s) => {
      const ch = ((s.live - (s.candles && s.candles.length > 10 ? s.candles[s.candles.length - 10].c : s.dayOpen)) / s.dayOpen) * 100;
      return `<span>${INFO[s.sym].icon} ${s.sym} ${AX.fmt(s.live, 2)} ${ch >= 0 ? "▲" : "▼"} ${AX.fmt(Math.abs(ch), 2)}%</span>`;
    }).join("");
    return items + items + items + items;
  }
  /** Campana de apertura con cinta de cotizaciones y lluvia de serpentinas. */
  function bellCine(sub) {
    return new Promise((resolve) => {
      const l = AX.el("div", "bx-bell");
      const tape = tapeHTML();
      l.innerHTML = `
        <div class="bx-tape a"><div class="bx-tape-track">${tape}</div></div>
        <div class="bx-tape b"><div class="bx-tape-track">${tape}</div></div>
        <div class="bx-bell-core">
          <div class="bx-bell-icon">🔔</div>
          <div class="bx-bell-k">09:30 · ${CFG.label}</div>
          <div class="bx-bell-title">¡Mercado<br>abierto!</div>
          <div class="bx-bell-sub">${sub}</div>
        </div>`;
      document.body.appendChild(l);
      [0, 0.42, 0.84].forEach((d) => S.play("bell", d));
      AX.haptic([30, 380, 30, 380, 30]);
      setTimeout(() => {
        ring(innerWidth / 2, innerHeight * 0.42, { color: "#ffd23f", radius: Math.max(innerWidth, innerHeight) * 0.6, rings: 3, width: 10 });
        AX.fx.confetti({ count: 140, colors: ["#ffffff", "#fff3b0", "#ffd23f", "#d9fbff", "#ffffff"], duration: 900 });
      }, 120);
      const t0 = Date.now();
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        S.play("whoosh");
        l.classList.add("out");
        setTimeout(() => { l.remove(); resolve(); }, 430);
      };
      setTimeout(fin, 2700);
      l.addEventListener("pointerdown", () => { if (Date.now() - t0 > 500) fin(); });
    });
  }

  function showEvent(ev) {
    const chartRect = $("#bx-chart-wrap").getBoundingClientRect();
    const card = $("#bx-chart-card");
    if (ev.kind) {
      // CRASH / RALLY
      const crash = ev.kind === "crash";
      const l = AX.el("div", "bx-shock " + ev.kind);
      const t = crash ? "¡CRASH!" : "¡RALLY!";
      l.innerHTML = `<div class="bx-shock-arrow">${crash ? "▼▼▼" : "▲▲▲"}</div><div class="bx-shock-t bx-glitch" data-text="${t}">${t}</div><div class="bx-shock-s">${esc(ev.message)}</div>`;
      document.body.appendChild(l);
      S.play(crash ? "crash" : "rally");
      AX.haptic(crash ? [80, 40, 120, 40, 200] : "bigwin");
      AX.fx.flash(crash ? "#ff0030" : "#2bff88", 600, 0.55);
      AX.fx.shake(crash ? 18 : 10, 750);
      const cx = chartRect.left + chartRect.width / 2, cy = chartRect.top + chartRect.height / 2;
      AX.fx.burst(cx, cy, { colors: crash ? "blood" : "green", count: 70, speed: 700 });
      AX.fx.sparks(cx, cy, { colors: crash ? ["#ff3b5c", "#ffb3c0", "#fff"] : "green", count: 50, speed: 900 });
      ring(cx, cy, { color: crash ? "#ff3b5c" : "#2bff88", radius: Math.max(innerWidth, innerHeight) * 0.7, rings: 2 });
      if (!crash) AX.fx.confetti({ count: 70, colors: "green" });
      hitCard(crash ? "neg" : "pos");
      CH.shake = crash ? 1 : 0.6;
      return new Promise((resolve) => setTimeout(() => { l.classList.add("out"); setTimeout(() => { l.remove(); resolve(); }, 400); }, 1900));
    }
    // ÚLTIMA HORA
    const pos = ev.trend_modifier >= 0;
    const target = ev.target === "ALL" ? "TODO EL MERCADO" : ev.target;
    const l = AX.el("div", "bx-news " + (pos ? "pos" : "neg"));
    l.style.top = Math.max(0, chartRect.top - 8) + "px";
    l.innerHTML = `
      <div class="bx-news-bar"><span class="bx-news-dot"></span><span class="bx-news-tag bx-glitch" data-text="ÚLTIMA HORA">ÚLTIMA HORA</span><span class="bx-news-target">${target}</span></div>
      <div class="bx-news-head">${ev.icon} <span class="bx-type"></span><span class="bx-caret"></span></div>`;
    document.body.appendChild(l);
    const typeEl = l.querySelector(".bx-type");
    const text = ev.message;
    let i = 0;
    const typer = setInterval(() => {
      i += 2;
      typeEl.textContent = text.slice(0, i);
      if (i % 6 === 0) S.play("tick");
      if (i >= text.length) clearInterval(typer);
    }, 22);
    S.play("alert");
    AX.haptic([40, 60, 40]);
    AX.fx.flash(pos ? "#ffd23f" : "#ff2040", 260, 0.22);
    setTimeout(() => {
      hitCard(pos ? "pos" : "neg");
      CH.shake = 0.5;
      AX.fx.shake(5, 300, card);
    }, 350);
    const life = Math.min(5200, 2400 + text.length * 30);
    setTimeout(() => {
      clearInterval(typer);
      l.classList.add("out");
      setTimeout(() => l.remove(), 400);
    }, life);
    return AX.sleep(1100); // la noticia sigue en pantalla, pero deja pasar al siguiente efecto
  }
  function hitCard(kind) {
    const card = $("#bx-chart-card");
    card.classList.remove("bx-hit-pos", "bx-hit-neg");
    void card.offsetWidth;
    card.classList.add("bx-hit-" + kind);
  }

  /* ------------------------------------------------------------ DOM */
  const ICONS = {
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z"/></svg>',
    bag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M8 7V5.5A2.5 2.5 0 0 1 10.5 3h3A2.5 2.5 0 0 1 16 5.5V7M3 12h18"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor"/></svg>',
    coin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M15 8.5a4 4 0 1 0 0 7M7 10.5h6M7 13.5h6"/></svg>',
    candle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 3v4M7 15v6M17 2v5M17 13v4"/><rect x="4.5" y="7" width="5" height="8" rx="1" fill="currentColor" fill-opacity=".35"/><rect x="14.5" y="7" width="5" height="6" rx="1"/></svg>',
    area: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-6 4 3 4-7 5 5" /><path d="M3 21h18" opacity=".5"/></svg>',
  };

  function buildDOM() {
    document.body.insertAdjacentHTML("afterbegin", '<div class="bx-bg"></div>');
    const app = AX.el("div", "bx-app");
    app.id = "bx-app";
    app.innerHTML = `
      <div class="bx-ticker"><div class="bx-ticker-label" id="bx-clock"><i></i><span>09:30</span></div><div class="bx-ticker-view"><div class="bx-ticker-track" id="bx-tk"></div></div></div>
      <div class="bx-main">
        <div class="bx-chips" id="bx-chips" role="tablist" aria-label="Valores"></div>
        <div class="bx-chart-card" id="bx-chart-card">
          <div class="bx-chart-head">
            <div class="bx-quote">
              <div class="bx-q-name"><span id="q-icon"></span><b id="q-sym"></b><span class="bx-q-full" id="q-name"></span><span class="bx-badge" id="q-trend"></span><span class="bx-badge" id="q-rsi"></span></div>
              <div class="bx-q-row"><span class="bx-q-price" id="q-price">—</span><span class="bx-q-chg" id="q-chg"></span></div>
            </div>
            <div class="bx-toggles">
              <button class="bx-tg" data-tg="ma" aria-label="Medias móviles"><span>MA</span></button>
              <button class="bx-tg" data-tg="rsi" aria-label="Panel RSI"><span>RSI</span></button>
              <button class="bx-tg" data-tg="type" aria-label="Tipo de gráfico"><span>${ICONS.candle}</span></button>
              <button class="bx-tg" data-tg="cmp" aria-label="Comparar valores"><span>VS</span></button>
            </div>
          </div>
          <div class="bx-chart-wrap" id="bx-chart-wrap">
            <canvas id="bx-chart"></canvas>
            <div class="bx-paused" id="bx-paused"><div class="bx-paused-k">Mercado en pausa</div><div class="bx-paused-s" id="bx-paused-s">Las cotizaciones están congeladas.</div><button class="ax-btn ax-btn-green ax-btn-sm" id="bx-resume">${ICONS.play.replace("<svg", '<svg width="18" height="18"')} Reanudar mercado</button></div>
          </div>
        </div>
      </div>
      <div class="bx-side">
        <div class="bx-pos" id="bx-pos">
          <div class="bx-pos-info"><div class="bx-pos-l1" id="pos-l1"></div><div class="bx-pos-l2" id="pos-l2"></div></div>
          <div class="bx-pos-btns">
            <button class="bx-pbtn sl" id="bx-sl" aria-pressed="false"><span>SL<small>${SL_PCT}%</small></span></button>
            <button class="bx-pbtn tp" id="bx-tp" aria-pressed="false"><span>TP<small>+${TP_PCT}%</small></span></button>
            <button class="bx-pbtn close" id="bx-close"><span>TODO<small>vender</small></span></button>
          </div>
        </div>
        <div class="bx-qty">
          <div class="bx-step"><button id="q-minus" aria-label="Menos">−</button><output id="q-out">1<small>ACC.</small></output><button id="q-plus" aria-label="Más">+</button></div>
          <div class="bx-pcts">
            <button class="bx-pct" data-p="0.25">25%</button><button class="bx-pct" data-p="0.5">50%</button><button class="bx-pct" data-p="0.75">75%</button><button class="bx-pct max" data-p="1">MAX</button>
          </div>
        </div>
        <div class="bx-trade">
          <button class="ax-btn ax-btn-green" id="bx-buy">Comprar<small id="buy-sub"></small></button>
          <button class="ax-btn ax-btn-red" id="bx-sell">Vender<small id="sell-sub"></small></button>
        </div>
        <div class="bx-nav">
          <button class="bx-pause" id="bx-pause" aria-pressed="false">${ICONS.pause}<span>Pausa</span></button>
          <button id="bx-pf">${ICONS.bag}<span>Cartera</span></button>
          <button id="bx-hist">${ICONS.list}<span>Historial</span></button>
          <button class="bx-cash" id="bx-cashout">${ICONS.coin}<span>Liquidar</span></button>
        </div>
        <div class="bx-desk" id="bx-desk">
          <h3>Mi cartera</h3><div id="desk-pf"></div>
          <h3>Historial</h3><div id="desk-hist" class="bx-list"></div>
        </div>
      </div>`;
    document.body.appendChild(app);

    // chips de valores
    const chips = $("#bx-chips");
    BASE.forEach((b) => {
      const i = INFO[b.sym];
      const c = AX.el("button", "bx-chip");
      c.dataset.sym = b.sym;
      c.setAttribute("role", "tab");
      c.style.setProperty("--c", i.color);
      c.innerHTML = `<div class="bx-chip-sym"><span>${i.icon}</span>${b.sym}</div><div class="bx-chip-chg"></div><div class="bx-chip-px"></div><canvas width="80" height="36"></canvas><i class="bx-chip-own"></i>`;
      c.addEventListener("click", () => selectStock(b.sym));
      chips.appendChild(c);
    });

    // toggles del gráfico
    app.querySelectorAll(".bx-tg").forEach((b) =>
      b.addEventListener("click", () => {
        const k = b.dataset.tg;
        if (k === "type") prefs.type = prefs.type === "candles" ? "area" : "candles";
        else prefs[k] = !prefs[k];
        savePrefs();
        S.play("click");
        AX.haptic("light");
        syncToggles();
      })
    );

    // cantidad
    holdRepeat($("#q-minus"), (n) => setQty(qty - n));
    holdRepeat($("#q-plus"), (n) => setQty(qty + n));
    app.querySelectorAll(".bx-pct").forEach((b) =>
      b.addEventListener("click", () => {
        if (!st) return;
        const p = +b.dataset.p;
        const m = maxBuy(sel());
        S.play("tick");
        AX.haptic("light");
        if (m <= 0) {
          AX.toast("No te llega para ninguna acción de " + st.selected, "error", 1800);
          return;
        }
        setQty(Math.max(1, Math.floor(m * p)), p);
      })
    );

    $("#bx-buy").addEventListener("click", () => st && buy(st.selected, qty));
    $("#bx-sell").addEventListener("click", () => {
      if (!st) return;
      const pos = st.portfolio[st.selected];
      if (!pos) return deny("sell", `No tienes acciones de ${st.selected}.`);
      sell(st.selected, Math.min(qty, pos.qty));
    });
    $("#bx-close").addEventListener("click", () => {
      if (!st || !st.portfolio[st.selected]) return;
      sell(st.selected, st.portfolio[st.selected].qty);
    });
    $("#bx-sl").addEventListener("click", () => toggleOrder(st.selected, "sl"));
    $("#bx-tp").addEventListener("click", () => toggleOrder(st.selected, "tp"));
    $("#bx-pause").addEventListener("click", () => setPaused(!st.paused));
    $("#bx-resume").addEventListener("click", () => setPaused(false));
    $("#bx-pf").addEventListener("click", openPortfolio);
    $("#bx-hist").addEventListener("click", openHistory);
    $("#bx-cashout").addEventListener("click", confirmCashOut);

    // gráfico
    CH.cv = $("#bx-chart");
    CH.cx = CH.cv.getContext("2d");
    const wrap = $("#bx-chart-wrap");
    const onResize = () => chartResize();
    if (window.ResizeObserver) new ResizeObserver(onResize).observe(wrap);
    window.addEventListener("resize", onResize);
    chartResize();
    const setCross = (e) => {
      const r = CH.cv.getBoundingClientRect();
      CH.crossX = e.clientX - r.left;
      CH.crossUntil = Infinity;
    };
    wrap.addEventListener("pointerdown", (e) => { if (e.target === CH.cv) { setCross(e); wrap.setPointerCapture && wrap.setPointerCapture(e.pointerId); } });
    wrap.addEventListener("pointermove", (e) => { if (CH.crossUntil === Infinity) setCross(e); });
    const endCross = () => { if (CH.crossUntil === Infinity) CH.crossUntil = performance.now() + 1500; };
    wrap.addEventListener("pointerup", endCross);
    wrap.addEventListener("pointercancel", endCross);

    syncToggles();
  }

  function holdRepeat(btn, fn) {
    let t1 = 0, t2 = 0, n = 0;
    const stop = () => { clearTimeout(t1); clearInterval(t2); };
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      stop();
      n = 0;
      fn(1);
      t1 = setTimeout(() => { t2 = setInterval(() => fn(++n > 12 ? 5 : 1), 85); }, 380);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => btn.addEventListener(ev, stop));
    btn.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fn(1); });
  }
  function setQty(v, p) {
    qty = Math.max(1, Math.min(999999, Math.floor(v) || 1));
    pctSel = p || null;
    document.querySelectorAll(".bx-pct").forEach((b) => b.classList.toggle("on", pctSel != null && +b.dataset.p === pctSel));
    if (!p) S.play("tick");
    updateTradePanel();
  }
  function syncToggles() {
    if (prefs.rsi == null) prefs.rsi = ($("#bx-chart-wrap").clientHeight || 0) > 230;
    document.querySelectorAll(".bx-tg").forEach((b) => {
      const k = b.dataset.tg;
      if (k === "type") {
        b.setAttribute("aria-pressed", "false");
        b.querySelector("span").innerHTML = prefs.type === "candles" ? ICONS.candle : ICONS.area;
        b.setAttribute("aria-label", prefs.type === "candles" ? "Gráfico de velas (cambiar a área)" : "Gráfico de área (cambiar a velas)");
      } else b.setAttribute("aria-pressed", prefs[k] ? "true" : "false");
    });
  }
  function toggleOrder(sym, k) {
    const pos = st && st.portfolio[sym];
    if (!pos) return;
    pos[k] = !pos[k];
    save();
    S.play(pos[k] ? "powerup" : "click");
    AX.haptic("light");
    const name = k === "sl" ? `Stop-Loss (${SL_PCT}%)` : `Take-Profit (+${TP_PCT}%)`;
    AX.toast(`${name} de ${sym} ${pos[k] ? "ACTIVADO" : "desactivado"}`, pos[k] ? (k === "sl" ? "error" : "success") : "info", 1800);
    updateLive(true);
    refreshSheets(true);
  }
  function selectStock(sym) {
    if (!st || st.selected === sym) return;
    st.selected = sym;
    S.play("tap");
    AX.haptic("light");
    CH.snap = true;
    CH.crossUntil = 0;
    const chip = document.querySelector(`.bx-chip[data-sym="${sym}"]`);
    if (chip && chip.scrollIntoView) chip.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    pctSel = null;
    document.querySelectorAll(".bx-pct").forEach((b) => b.classList.remove("on"));
    updateLive(true);
  }
  function setPaused(p) {
    if (!st || settled || locked || busy) return;
    st.paused = !!p;
    save();
    if (st.paused) {
      $("#bx-paused-s").textContent = "Las cotizaciones están congeladas.";
      S.play("swoosh");
      AX.haptic("light");
    } else {
      S.play("bell");
      AX.haptic("medium");
      AX.cine.banner("¡Mercado abierto!", { sub: "Las cotizaciones vuelven a moverse", color: CFG.accent, sound: false, duration: 1300 });
    }
    updatePauseUI();
  }
  function updatePauseUI() {
    const p = !!(st && st.paused);
    const b = $("#bx-pause");
    b.setAttribute("aria-pressed", p ? "true" : "false");
    b.innerHTML = (p ? ICONS.play : ICONS.pause) + `<span>${p ? "Seguir" : "Pausa"}</span>`;
    $("#bx-paused").classList.toggle("on", p && !busy);
    $("#bx-clock").classList.toggle("bx-paused-l", p);
  }

  /* ------------------------------------------------------------ UI EN DIRECTO */
  let eqShown = null, eqTarget = 0, lastEqText = "";
  function bumpEq() { pulse($("#bx-eq")); }
  function updateLive(force) {
    if (!st) return;
    const s = sel();
    const info = INFO[s.sym];
    // cotización principal
    const p = px(s);
    const ch = ((p - s.dayOpen) / s.dayOpen) * 100;
    const qp = $("#q-price");
    const txt = money(p);
    if (qp._sym !== s.sym) {
      qp._sym = s.sym;
      qp._p = p;
      qp.classList.remove("up", "down");
    } else if (p !== qp._p) {
      qp.classList.toggle("up", p > qp._p);
      qp.classList.toggle("down", p < qp._p);
      qp._p = p;
    }
    if (qp.textContent !== txt) qp.textContent = txt;
    $("#q-icon").textContent = info.icon;
    $("#q-sym").textContent = s.sym;
    $("#q-name").textContent = info.name;
    const qc = $("#q-chg");
    qc.textContent = `${ch >= 0 ? "▲" : "▼"} ${pct(ch)}`;
    qc.className = "bx-q-chg " + cls(ch);
    const tr = $("#q-trend");
    tr.textContent = s.trendState === "bullish" ? "Alcista ↗" : s.trendState === "bearish" ? "Bajista ↘" : "Neutral";
    tr.className = "bx-badge " + (s.trendState === "bullish" ? "bull" : s.trendState === "bearish" ? "bear" : "");
    const rs = $("#q-rsi");
    rs.textContent = "RSI " + Math.round(s.rsi);
    rs.className = "bx-badge " + (s.rsi >= 70 ? "bear" : s.rsi <= 30 ? "bull" : "");
    $("#bx-clock span").textContent = clockOf(st.tick);
    // chips: precio en directo
    document.querySelectorAll(".bx-chip").forEach((c) => {
      const x = stockBy(c.dataset.sym);
      c.classList.toggle("on", x.sym === st.selected);
      c.classList.toggle("own", !!st.portfolio[x.sym]);
      c.setAttribute("aria-selected", x.sym === st.selected ? "true" : "false");
      const cp = ((x.live - x.dayOpen) / x.dayOpen) * 100;
      const pe = c.querySelector(".bx-chip-px");
      const t2 = AX.fmt(px(x), 2) + " €";
      if (pe.textContent !== t2) pe.textContent = t2;
      const ce = c.querySelector(".bx-chip-chg");
      ce.textContent = (cp >= 0 ? "+" : "−") + AX.fmt(Math.abs(cp), 1) + "%";
      ce.className = "bx-chip-chg " + cls(cp);
    });
    // patrimonio
    const eq = equity();
    eqTarget = eq;
    if (eqShown == null) eqShown = eq;
    const pnl = r2(eq - st.investment);
    const pr = (pnl / st.investment) * 100;
    const pe = $("#bx-pnl");
    pe.textContent = `${pnl >= 0 ? "▲" : "▼"} ${smoney(pnl)} · ${pct(pr)}`;
    pe.className = "bx-hud-pnl " + (pnl > 0 ? "bx-up" : pnl < 0 ? "bx-down" : "");
    updatePosition();
    updateTradePanel();
    if (force) refreshSheets();
  }
  function updatePosition() {
    const s = sel();
    const pos = st.portfolio[s.sym];
    const l1 = $("#pos-l1"), l2 = $("#pos-l2");
    const sl = $("#bx-sl"), tp = $("#bx-tp"), cl = $("#bx-close");
    if (pos) {
      const val = pos.qty * px(s);
      const pnl = val - pos.qty * pos.avg;
      const g = ((px(s) - pos.avg) / pos.avg) * 100;
      l1.innerHTML = `${AX.fmt(pos.qty)} ${s.sym} · <span class="${cls(pnl)}">${smoney(pnl)} · ${g >= 0 ? "+" : "−"}${AX.fmt(Math.abs(g), 1)}%</span>`;
      l2.innerHTML = `PM <b>${money(pos.avg)}</b> · Efectivo <b>${money(st.cash)}</b>`;
      sl.disabled = tp.disabled = cl.disabled = false;
      sl.setAttribute("aria-pressed", pos.sl ? "true" : "false");
      tp.setAttribute("aria-pressed", pos.tp ? "true" : "false");
    } else {
      l1.innerHTML = `<span style="color:var(--ax-muted)">Sin posición en ${s.sym}</span>`;
      l2.innerHTML = `Efectivo <b>${money(st.cash)}</b> · máx. <b>${maxBuy(s)}</b> acc.`;
      sl.disabled = tp.disabled = cl.disabled = true;
      sl.setAttribute("aria-pressed", "false");
      tp.setAttribute("aria-pressed", "false");
    }
  }
  function updateTradePanel() {
    if (!st) return;
    const s = sel();
    const p = px(s);
    const out = $("#q-out");
    out.innerHTML = `${AX.fmt(qty)}<small>ACC.</small>`;
    const pos = st.portfolio[s.sym];
    const mb = maxBuy(s);
    const bq = qty;
    $("#buy-sub").textContent = `×${AX.fmt(bq)} · ${money(p * bq)}`;
    $("#bx-buy").classList.toggle("bx-dim", bq > mb);
    if (pos) {
      const sq = Math.min(qty, pos.qty);
      $("#sell-sub").textContent = `×${AX.fmt(sq)} · ${money(p * sq)}`;
    } else $("#sell-sub").textContent = "Sin acciones";
    const dis = !!(st.paused || busy || settled || locked);
    $("#bx-buy").disabled = dis;
    $("#bx-sell").disabled = dis || !pos;
  }

  /* chips: cierre de vela (flash + minigráfico) */
  function chipsCandle() {
    document.querySelectorAll(".bx-chip").forEach((c) => {
      const s = stockBy(c.dataset.sym);
      const n = s.candles.length;
      const d = n > 1 ? s.candles[n - 1].c - s.candles[n - 2].c : 0;
      const pe = c.querySelector(".bx-chip-px");
      pe.classList.remove("bx-flash-up", "bx-flash-down");
      void pe.offsetWidth;
      if (d) pe.classList.add(d > 0 ? "bx-flash-up" : "bx-flash-down");
      drawSpark(c.querySelector("canvas"), s);
    });
    const qp = $("#q-price");
    const s = sel(), n = s.candles.length;
    if (n > 1) {
      const d = s.candles[n - 1].c - s.candles[n - 2].c;
      qp.classList.remove("bx-flash-up", "bx-flash-down");
      void qp.offsetWidth;
      qp.classList.add(d >= 0 ? "bx-flash-up" : "bx-flash-down");
    }
  }
  function drawSpark(cv, s) {
    const cx = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    cx.clearRect(0, 0, W, H);
    const pts = s.candles.slice(-24).map((c) => c.c);
    if (pts.length < 2) return;
    const lo = Math.min(...pts), hi = Math.max(...pts);
    const up = pts[pts.length - 1] >= pts[0];
    const col = up ? "#2bff88" : "#ff3b5c";
    cx.beginPath();
    pts.forEach((v, i) => {
      const x = (i / (pts.length - 1)) * (W - 4) + 2;
      const y = H - 4 - ((v - lo) / (hi - lo || 1)) * (H - 8);
      i ? cx.lineTo(x, y) : cx.moveTo(x, y);
    });
    cx.lineWidth = 3;
    cx.strokeStyle = col;
    cx.shadowColor = col;
    cx.shadowBlur = 6;
    cx.lineJoin = "round";
    cx.stroke();
  }

  /* ------------------------------------------------------------ CINTA */
  const TK = { x: 0, half: 0 };
  function tickerBuild() {
    if (!st) return;
    const items = st.stocks.map((s) => {
      const n = s.candles.length;
      const d = n > 1 ? ((s.candles[n - 1].c - s.candles[n - 2].c) / s.candles[n - 2].c) * 100 : 0;
      return `<span class="bx-tk-i"><span>${INFO[s.sym].icon}</span><b>${s.sym}</b>${AX.fmt(s.price, 2)}<em class="${cls(d)}">${d >= 0 ? "▲" : "▼"}${AX.fmt(Math.abs(d), 2)}%</em></span>`;
    });
    const news = st.events.map((ae) => EV_BY_NAME[ae.name]).filter(Boolean).map((ev) =>
      `<span class="bx-tk-n ${ev.trend_modifier < 0 ? "neg" : ""}"><b>${ev.kind ? (ev.kind === "crash" ? "CRASH" : "RALLY") : "ÚLTIMA HORA"}</b>${ev.icon} ${esc(ev.message)}</span>`
    );
    if (!news.length) news.push(`<span class="bx-tk-n"><b>MERCADO</b>Los mercados operan con normalidad. Atento a las noticias…</span>`);
    let html = items.slice(0, 3).join("") + news[0] + items.slice(3).join("") + (news[1] || "");
    const track = $("#bx-tk");
    const view = track.parentElement.clientWidth || 360;
    track.innerHTML = `<div class="bx-tk-seg">${html}</div>`;
    let seg = track.firstChild;
    let reps = 1;
    while (seg.offsetWidth < view && reps < 6) { seg.innerHTML += html; reps++; }
    track.innerHTML += track.innerHTML;
    TK.half = track.firstChild.offsetWidth || 1;
    TK.x = TK.x % TK.half;
  }

  /* ------------------------------------------------------------ GRÁFICO (canvas propio) */
  const CH = { cv: null, cx: null, w: 0, h: 0, dpr: 1, yMin: null, yMax: null, rMin: 0, slide: 0, spacing: 9, disp: null, snap: true, shake: 0, crossX: 0, crossUntil: 0 };
  function chartResize() {
    const wrap = $("#bx-chart-wrap");
    if (!wrap || !CH.cv) return;
    const r = wrap.getBoundingClientRect();
    CH.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    CH.w = Math.max(10, r.width);
    CH.h = Math.max(10, r.height);
    CH.cv.width = Math.round(CH.w * CH.dpr);
    CH.cv.height = Math.round(CH.h * CH.dpr);
    if (st) tickerBuild();
  }
  function niceStep(range, n) {
    const raw = range / n;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / mag;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  }
  function rr(cx, x, y, w, h, r) {
    cx.beginPath();
    cx.moveTo(x + r, y);
    cx.arcTo(x + w, y, x + w, y + h, r);
    cx.arcTo(x + w, y + h, x, y + h, r);
    cx.arcTo(x, y + h, x, y, r);
    cx.arcTo(x, y, x + w, y, r);
    cx.closePath();
  }
  function tag(cx, x, y, w, text, bg, fg) {
    const h = 17;
    rr(cx, x, y - h / 2, w, h, 5);
    cx.fillStyle = bg;
    cx.fill();
    cx.fillStyle = fg;
    cx.font = "800 10.5px Outfit, system-ui, sans-serif";
    cx.textAlign = "center";
    cx.textBaseline = "middle";
    cx.fillText(text, x + w / 2, y + 0.5);
  }
  const UP = "#2bff88", DOWN = "#ff3b5c";

  function drawChart(now, dt) {
    const { cx, w, h, dpr } = CH;
    if (!cx || !st || w < 20 || h < 20) return;
    const s = sel();
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, w, h);
    if (CH.shake > 0.01) {
      cx.translate(AX.rand(-1, 1) * 6 * CH.shake, AX.rand(-1, 1) * 4 * CH.shake);
      CH.shake *= Math.pow(0.02, dt);
    }
    const axisW = 52;
    const plotR = w - axisW;
    const timeH = 15;
    const rsiOn = !!prefs.rsi;
    const rsiH = rsiOn ? Math.max(44, Math.round(h * 0.22)) : 0;
    const mainT = 18;
    const mainB = h - timeH - (rsiOn ? rsiH + 8 : 0);
    const spacing = (CH.spacing = w < 420 ? 8.5 : w < 700 ? 10 : 11);
    const nVis = Math.max(5, Math.min(s.candles.length, Math.floor((plotR - 20) / spacing)));
    const vis = s.candles.slice(-nVis);

    // precio mostrado (suavizado)
    if (CH.snap || CH.disp == null) CH.disp = s.live;
    CH.disp += (s.live - CH.disp) * Math.min(1, dt * 14);
    const live = { o: s.open, h: Math.max(s.hi, CH.disp), l: Math.min(s.lo, CH.disp), c: CH.disp, t: st.tick, m5: null, m15: null, r: s.rsi, live: true };
    const all = vis.concat([live]);
    const n = all.length;
    CH.slide = CH.slide > 0.05 ? CH.slide * Math.pow(0.004, dt) : 0;
    const X = (i) => plotR - 16 - (n - 1 - i) * spacing + CH.slide;

    // comparación (normalizada al primer cierre visible)
    let cmpSeries = [];
    if (prefs.cmp) {
      const base = all[0].c;
      cmpSeries = st.stocks.filter((o) => o.sym !== s.sym).map((o) => {
        const ov = o.candles.slice(-nVis).map((c) => c.c).concat([o.live]);
        const ob = ov[0] || 1;
        const off = n - ov.length;
        return { sym: o.sym, color: INFO[o.sym].color, pts: ov.map((v, i) => [off + i, (v / ob) * base]) };
      });
    }
    // rango
    let lo = Infinity, hi = -Infinity;
    for (const c of all) {
      lo = Math.min(lo, c.l); hi = Math.max(hi, c.h);
      if (prefs.ma && c.m15) { lo = Math.min(lo, c.m5, c.m15); hi = Math.max(hi, c.m5, c.m15); }
    }
    for (const cs of cmpSeries) for (const [, v] of cs.pts) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const pos = st.portfolio[s.sym];
    const lines = [];
    if (pos) {
      lines.push({ v: pos.avg, label: "PM", color: "#ffcc33" });
      if (pos.sl) lines.push({ v: pos.avg * (1 + SL_PCT / 100), label: "SL", color: DOWN });
      if (pos.tp) lines.push({ v: pos.avg * (1 + TP_PCT / 100), label: "TP", color: UP });
      for (const l of lines) { lo = Math.min(lo, l.v); hi = Math.max(hi, l.v); }
    }
    const pad = (hi - lo) * 0.1 || hi * 0.02 || 0.1;
    const tMin = Math.max(0, lo - pad), tMax = hi + pad;
    if (CH.snap || CH.yMin == null) { CH.yMin = tMin; CH.yMax = tMax; }
    else {
      const k = Math.min(1, dt * 6);
      CH.yMin += (tMin - CH.yMin) * k;
      CH.yMax += (tMax - CH.yMax) * k;
    }
    CH.snap = false;
    const yMin = CH.yMin, yMax = CH.yMax;
    const Y = (v) => mainT + ((yMax - v) / (yMax - yMin || 1)) * (mainB - mainT);

    // rejilla + eje de precios
    const stepV = niceStep(yMax - yMin, Math.max(2, Math.round((mainB - mainT) / 46)));
    cx.font = "700 10px Outfit, system-ui, sans-serif";
    cx.textBaseline = "middle";
    cx.textAlign = "left";
    for (let v = Math.ceil(yMin / stepV) * stepV; v <= yMax; v += stepV) {
      const y = Math.round(Y(v)) + 0.5;
      if (y < mainT - 2 || y > mainB + 2) continue;
      cx.strokeStyle = "rgba(255,255,255,0.06)";
      cx.lineWidth = 1;
      cx.beginPath(); cx.moveTo(0, y); cx.lineTo(plotR, y); cx.stroke();
      cx.fillStyle = "rgba(200,194,235,0.55)";
      cx.fillText(AX.fmt(v, stepV < 0.1 ? 2 : stepV < 1 ? 2 : 1), plotR + 6, y);
    }
    // horas
    cx.textAlign = "center";
    cx.textBaseline = "alphabetic";
    for (let i = 0; i < n; i++) {
      const c = all[i];
      if (c.t % 10 !== 0 || c.live) continue;
      const x = X(i);
      if (x < 16 || x > plotR - 10) continue;
      cx.strokeStyle = "rgba(255,255,255,0.04)";
      cx.beginPath(); cx.moveTo(Math.round(x) + 0.5, mainT); cx.lineTo(Math.round(x) + 0.5, h - timeH); cx.stroke();
      cx.fillStyle = "rgba(200,194,235,0.45)";
      cx.fillText(clockOf(c.t), x, h - 3);
    }

    // noticias en el eje temporal
    for (const nw of st.news) {
      const ev = EV_BY_NAME[nw.name];
      if (!ev || (ev.target !== "ALL" && ev.target !== s.sym)) continue;
      const i = n - 1 - (st.tick - nw.t);
      if (i < 0) continue;
      const x = X(i);
      const col = ev.kind === "crash" ? DOWN : ev.kind === "rally" ? UP : "#ffcc33";
      cx.save();
      cx.setLineDash([3, 4]);
      cx.strokeStyle = col;
      cx.globalAlpha = 0.45;
      cx.beginPath(); cx.moveTo(x, mainT); cx.lineTo(x, mainB); cx.stroke();
      cx.restore();
      cx.font = "12px sans-serif";
      cx.textAlign = "center";
      cx.textBaseline = "middle";
      cx.fillText(ev.icon, x, mainT + 2);
    }

    // comparación
    for (const cs of cmpSeries) {
      cx.save();
      cx.globalAlpha = 0.55;
      cx.strokeStyle = cs.color;
      cx.lineWidth = 1.4;
      cx.beginPath();
      cs.pts.forEach(([i, v], k) => (k ? cx.lineTo(X(i), Y(v)) : cx.moveTo(X(i), Y(v))));
      cx.stroke();
      const last = cs.pts[cs.pts.length - 1];
      cx.globalAlpha = 0.85;
      cx.fillStyle = cs.color;
      cx.font = "800 8.5px Outfit, system-ui, sans-serif";
      cx.textAlign = "right";
      cx.textBaseline = "middle";
      cx.fillText(cs.sym, X(last[0]) - 6, Y(last[1]) - 6);
      cx.restore();
    }

    const liveUp = CH.disp >= s.open;
    const liveCol = liveUp ? UP : DOWN;
    if (prefs.type === "area") {
      const firstUp = CH.disp >= all[0].c;
      const col = firstUp ? UP : DOWN;
      const grad = cx.createLinearGradient(0, mainT, 0, mainB);
      grad.addColorStop(0, firstUp ? "rgba(43,255,136,0.32)" : "rgba(255,59,92,0.32)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      cx.beginPath();
      all.forEach((c, i) => (i ? cx.lineTo(X(i), Y(c.c)) : cx.moveTo(X(i), Y(c.c))));
      cx.lineTo(X(n - 1), mainB);
      cx.lineTo(X(0), mainB);
      cx.closePath();
      cx.fillStyle = grad;
      cx.fill();
      cx.save();
      cx.beginPath();
      all.forEach((c, i) => (i ? cx.lineTo(X(i), Y(c.c)) : cx.moveTo(X(i), Y(c.c))));
      cx.strokeStyle = col;
      cx.lineWidth = 2.4;
      cx.lineJoin = "round";
      cx.shadowColor = col;
      cx.shadowBlur = 12;
      cx.stroke();
      cx.restore();
    } else {
      const bw = Math.max(2, spacing * 0.62);
      for (let i = 0; i < n; i++) {
        const c = all[i];
        const x = X(i);
        if (x < -spacing) continue;
        const up = c.c >= c.o;
        const col = up ? UP : DOWN;
        cx.save();
        cx.strokeStyle = col;
        cx.fillStyle = up ? "rgba(43,255,136,0.85)" : "rgba(255,59,92,0.9)";
        if (c.live) {
          cx.shadowColor = col;
          cx.shadowBlur = 16;
        }
        cx.lineWidth = 1.2;
        cx.beginPath();
        cx.moveTo(Math.round(x) + 0.5, Y(c.h));
        cx.lineTo(Math.round(x) + 0.5, Y(c.l));
        cx.stroke();
        const yt = Y(Math.max(c.o, c.c)), yb = Y(Math.min(c.o, c.c));
        cx.fillRect(x - bw / 2, yt, bw, Math.max(1.2, yb - yt));
        cx.restore();
      }
    }

    // medias móviles
    if (prefs.ma) {
      [["m5", "#22e4ff"], ["m15", "#ff2fb3"]].forEach(([k, col]) => {
        cx.save();
        cx.strokeStyle = col;
        cx.globalAlpha = 0.85;
        cx.lineWidth = 1.6;
        cx.shadowColor = col;
        cx.shadowBlur = 6;
        cx.beginPath();
        let started = false;
        for (let i = 0; i < n - 1; i++) {
          const v = all[i][k];
          if (v == null) continue;
          started ? cx.lineTo(X(i), Y(v)) : cx.moveTo(X(i), Y(v));
          started = true;
        }
        cx.stroke();
        cx.restore();
      });
      cx.font = "800 9.5px Outfit, system-ui, sans-serif";
      cx.textAlign = "left";
      cx.textBaseline = "middle";
      cx.fillStyle = "#22e4ff";
      const t1 = "MA5 " + AX.fmt(s.ma5, 2);
      cx.fillText(t1, 8, 9);
      cx.fillStyle = "#ff2fb3";
      cx.fillText("MA15 " + AX.fmt(s.ma15, 2), 14 + cx.measureText(t1).width, 9);
    }

    // marcas de compra / venta y señales
    const marks = st.marks.filter((m) => m.sym === s.sym);
    for (let i = 0; i < n; i++) {
      const c = all[i];
      const x = X(i);
      if (x < 0) continue;
      for (const m of marks) {
        if (m.t !== c.t) continue;
        cx.save();
        cx.fillStyle = m.side === "b" ? UP : DOWN;
        cx.shadowColor = cx.fillStyle;
        cx.shadowBlur = 8;
        cx.beginPath();
        if (m.side === "b") {
          const y = Y(c.l) + 7;
          cx.moveTo(x, y); cx.lineTo(x - 5, y + 8); cx.lineTo(x + 5, y + 8);
        } else {
          const y = Y(c.h) - 7;
          cx.moveTo(x, y); cx.lineTo(x - 5, y - 8); cx.lineTo(x + 5, y - 8);
        }
        cx.closePath();
        cx.fill();
        cx.restore();
      }
      if (c.s === "gold" || c.s === "death") {
        cx.save();
        cx.fillStyle = c.s === "gold" ? "#ffcc33" : "#ff2fb3";
        cx.shadowColor = cx.fillStyle;
        cx.shadowBlur = 10;
        const y = c.s === "gold" ? Math.min(mainB - 4, Y(c.l) + 20) : Math.max(mainT + 4, Y(c.h) - 20);
        cx.translate(x, y);
        cx.rotate(Math.PI / 4);
        cx.fillRect(-3.5, -3.5, 7, 7);
        cx.restore();
      }
    }

    // líneas de precio medio / SL / TP
    cx.save();
    for (const l of lines) {
      const y = Math.round(Y(l.v)) + 0.5;
      cx.setLineDash(l.label === "PM" ? [6, 4] : [2, 4]);
      cx.strokeStyle = l.color;
      cx.globalAlpha = 0.9;
      cx.lineWidth = 1.2;
      cx.beginPath(); cx.moveTo(0, y); cx.lineTo(plotR, y); cx.stroke();
      cx.setLineDash([]);
      cx.globalAlpha = 1;
      cx.font = "900 9px Outfit, system-ui, sans-serif";
      const lw = cx.measureText(l.label).width + 10;
      rr(cx, 6, y - 7, lw, 14, 4);
      cx.fillStyle = l.color;
      cx.fill();
      cx.fillStyle = l.label === "SL" ? "#fff" : "#1a1000";
      cx.textAlign = "center";
      cx.textBaseline = "middle";
      cx.fillText(l.label, 6 + lw / 2, y + 0.5);
    }
    cx.restore();

    // línea del precio en directo + etiqueta
    const yl = Y(CH.disp);
    cx.save();
    cx.setLineDash([3, 3]);
    cx.strokeStyle = liveCol;
    cx.globalAlpha = 0.6;
    cx.beginPath(); cx.moveTo(0, Math.round(yl) + 0.5); cx.lineTo(plotR, Math.round(yl) + 0.5); cx.stroke();
    cx.restore();
    const lx = X(n - 1);
    const pulseR = 3 + ((now / 600) % 1) * 10;
    cx.save();
    cx.fillStyle = liveCol;
    cx.globalAlpha = 1 - ((now / 600) % 1);
    cx.beginPath(); cx.arc(lx, yl, pulseR, 0, Math.PI * 2); cx.fill();
    cx.globalAlpha = 1;
    cx.shadowColor = liveCol;
    cx.shadowBlur = 12;
    cx.beginPath(); cx.arc(lx, yl, 3.2, 0, Math.PI * 2); cx.fill();
    cx.restore();
    tag(cx, plotR + 2, Math.max(mainT, Math.min(mainB, yl)), axisW - 4, AX.fmt(CH.disp, 2), liveCol, liveUp ? "#00321a" : "#fff");
    // cuenta atrás de la vela
    const prog = Math.min(1, (st.step + (running() ? (now - lastStepAt) / STEP_MS : 0)) / STEPS);
    cx.fillStyle = "rgba(255,255,255,0.08)";
    cx.fillRect(plotR + 4, mainB + 3, axisW - 8, 3);
    cx.fillStyle = liveCol;
    cx.fillRect(plotR + 4, mainB + 3, (axisW - 8) * prog, 3);

    // RSI
    if (rsiOn) {
      const top = mainB + 8, bot = h - timeH - 2;
      const RY = (v) => top + ((100 - v) / 100) * (bot - top);
      cx.fillStyle = "rgba(139,92,255,0.08)";
      cx.fillRect(0, RY(70), plotR, RY(30) - RY(70));
      cx.strokeStyle = "rgba(255,255,255,0.08)";
      cx.beginPath(); cx.moveTo(0, top - 4 + 0.5); cx.lineTo(w, top - 4 + 0.5); cx.stroke();
      [[70, DOWN], [30, UP]].forEach(([v, col]) => {
        cx.save();
        cx.setLineDash([3, 3]);
        cx.strokeStyle = col;
        cx.globalAlpha = 0.5;
        cx.beginPath(); cx.moveTo(0, Math.round(RY(v)) + 0.5); cx.lineTo(plotR, Math.round(RY(v)) + 0.5); cx.stroke();
        cx.restore();
        cx.fillStyle = "rgba(200,194,235,0.5)";
        cx.font = "700 9px Outfit, system-ui, sans-serif";
        cx.textAlign = "left";
        cx.textBaseline = "middle";
        cx.fillText(String(v), plotR + 6, RY(v));
      });
      cx.save();
      cx.strokeStyle = "#a97bff";
      cx.lineWidth = 1.6;
      cx.shadowColor = "#8b5cff";
      cx.shadowBlur = 8;
      cx.beginPath();
      all.forEach((c, i) => (i ? cx.lineTo(X(i), RY(c.r)) : cx.moveTo(X(i), RY(c.r))));
      cx.stroke();
      cx.restore();
      cx.fillStyle = "#cbb6ff";
      cx.font = "800 9.5px Outfit, system-ui, sans-serif";
      cx.textAlign = "left";
      cx.textBaseline = "top";
      cx.fillText("RSI 14 · " + Math.round(s.rsi) + (s.rsi >= 70 ? " · SOBRECOMPRA" : s.rsi <= 30 ? " · SOBREVENTA" : ""), 8, top);
    }

    // retícula táctil
    if (CH.crossUntil > now) {
      const i = Math.max(0, Math.min(n - 1, Math.round((CH.crossX - X(0)) / spacing)));
      const c = all[i];
      const x = X(i);
      cx.save();
      cx.strokeStyle = "rgba(255,255,255,0.45)";
      cx.setLineDash([2, 3]);
      cx.beginPath(); cx.moveTo(Math.round(x) + 0.5, mainT); cx.lineTo(Math.round(x) + 0.5, h - timeH); cx.stroke();
      cx.beginPath(); cx.moveTo(0, Math.round(Y(c.c)) + 0.5); cx.lineTo(plotR, Math.round(Y(c.c)) + 0.5); cx.stroke();
      cx.restore();
      const txt = `${c.live ? "AHORA" : clockOf(c.t)}  A ${AX.fmt(c.o, 2)}  Máx ${AX.fmt(c.h, 2)}  Mín ${AX.fmt(c.l, 2)}  C ${AX.fmt(c.c, 2)}`;
      cx.font = "800 10px Outfit, system-ui, sans-serif";
      const tw = Math.min(plotR - 12, cx.measureText(txt).width + 14);
      rr(cx, 6, mainT + 4, tw, 20, 7);
      cx.fillStyle = "rgba(10,8,24,0.92)";
      cx.fill();
      cx.strokeStyle = "rgba(255,255,255,0.18)";
      cx.stroke();
      cx.fillStyle = "#fff";
      cx.textAlign = "left";
      cx.textBaseline = "middle";
      cx.fillText(txt, 13, mainT + 14.5, tw - 14);
      tag(cx, plotR + 2, Y(c.c), axisW - 4, AX.fmt(c.c, 2), "#e9e4ff", "#120e24");
    }
  }

  /* ------------------------------------------------------------ ANIMACIÓN */
  let lastFrame = performance.now();
  let lastStepAt = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (!document.hidden) {
      // cinta
      if (TK.half > 1) {
        TK.x -= (running() ? 46 : 18) * dt;
        if (TK.x <= -TK.half) TK.x += TK.half;
        $("#bx-tk").style.transform = `translate3d(${TK.x.toFixed(1)}px,0,0)`;
      }
      // patrimonio animado
      if (st && eqShown != null) {
        eqShown += (eqTarget - eqShown) * Math.min(1, dt * 7);
        if (Math.abs(eqTarget - eqShown) < 0.005) eqShown = eqTarget;
        const t = money(eqShown);
        if (t !== lastEqText) { $("#bx-eq").textContent = t; lastEqText = t; }
      }
      drawChart(now, dt);
    }
    requestAnimationFrame(frame);
  }
  setInterval(() => {
    if (running()) { lastStepAt = performance.now(); step(); }
  }, STEP_MS);
  // latido: mantiene viva la marca de tiempo aunque el mercado esté en pausa
  setInterval(() => {
    if (st && !settled && !locked && !st.parked && !busy && !document.hidden) save();
  }, 2000);

  /* ------------------------------------------------------------ HOJAS: CARTERA / HISTORIAL */
  let histDirty = true;
  const openSheets = new Set();
  function portfolioHTML(desk) {
    const eq = equity();
    const pnl = r2(eq - st.investment);
    const syms = Object.keys(st.portfolio);
    let h = desk ? "" : `<div class="bx-sum">
      <div class="wide"><small>Patrimonio</small><b data-v="eq">${money(eq)}</b></div>
      <div><small>Inversión</small><b>${money(st.investment)}</b></div>
      <div><small>Resultado</small><b data-v="pnl" class="${cls(pnl)}">${smoney(pnl)}</b></div>
      <div><small>Efectivo</small><b data-v="cash">${money(st.cash)}</b></div>
      <div><small>En acciones</small><b data-v="hold">${money(holdingsValue())}</b></div>
    </div>`;
    if (!syms.length) return h + `<div class="bx-empty">Cartera vacía. ¡Compra tu primera acción!</div>`;
    h += `<div class="bx-list">`;
    for (const sym of syms) {
      const pos = st.portfolio[sym];
      const i = INFO[sym];
      h += `<div class="bx-row" style="--c:${i.color}" data-sym="${sym}">
        <div class="bx-row-main">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="flex:1;min-width:0"><div class="bx-row-t">${i.icon} ${sym}<span>×${AX.fmt(pos.qty)}</span></div><div class="bx-row-s">PM ${money(pos.avg)} · <span data-v="px-${sym}"></span></div></div>
            <div class="bx-row-v"><span data-v="val-${sym}"></span><small data-v="pl-${sym}"></small></div>
          </div>
          <div class="bx-row-acts">
            <button class="sl" data-act="sl" data-sym="${sym}" aria-pressed="${pos.sl}">SL ${SL_PCT}%</button>
            <button class="tp" data-act="tp" data-sym="${sym}" aria-pressed="${pos.tp}">TP +${TP_PCT}%</button>
            <button class="sell" data-act="sellall" data-sym="${sym}">Vender todo</button>
          </div>
        </div></div>`;
    }
    return h + `</div>`;
  }
  function portfolioValues(root) {
    const set = (k, v, c) => {
      const e = root.querySelector(`[data-v="${k}"]`);
      if (e) { e.textContent = v; if (c != null) e.className = c; }
    };
    const eq = equity(), pnl = r2(eq - st.investment);
    set("eq", money(eq));
    set("pnl", smoney(pnl), cls(pnl));
    set("cash", money(st.cash));
    set("hold", money(holdingsValue()));
    for (const sym of Object.keys(st.portfolio)) {
      const pos = st.portfolio[sym];
      const p = px(stockBy(sym));
      const val = pos.qty * p;
      const pl = val - pos.qty * pos.avg;
      set("px-" + sym, "Ahora " + money(p));
      set("val-" + sym, money(val));
      set("pl-" + sym, `${smoney(pl)} (${pct(((p - pos.avg) / pos.avg) * 100)})`, cls(pl));
    }
  }
  const pfSig = () => Object.keys(st.portfolio).map((k) => k + st.portfolio[k].qty + st.portfolio[k].sl + st.portfolio[k].tp).join("|");
  function mountPortfolio(root, desk) {
    let sig = null;
    const render = (force) => {
      if (!st) return;
      const s2 = pfSig();
      if (force || s2 !== sig) { root.innerHTML = portfolioHTML(desk); sig = s2; }
      portfolioValues(root);
    };
    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b || !st) return;
      const sym = b.dataset.sym;
      if (b.dataset.act === "sellall") { if (st.portfolio[sym]) sell(sym, st.portfolio[sym].qty); }
      else toggleOrder(sym, b.dataset.act);
      render(true);
    });
    render(true);
    return render;
  }
  function historyHTML() {
    if (!st.history.length) return `<div class="bx-empty">Aún no hay operaciones.</div>`;
    const K = { COMPRA: "buy", VENTA: "sell", SL: "sl", TP: "tp", "LIQUIDACIÓN": "liq" };
    const L = { COMPRA: "COMPRA", VENTA: "VENTA", SL: "STOP-LOSS", TP: "TAKE-PROFIT", "LIQUIDACIÓN": "LIQUIDACIÓN" };
    return st.history.map((t) => `<div class="bx-h">
        <span class="bx-h-k ${K[t.k] || "sell"}">${L[t.k] || t.k}</span>
        <div class="bx-h-m">${INFO[t.sym].icon} ${t.sym} ×${AX.fmt(t.q)}<small>${clockOf(t.t)} · a ${money(t.p)}</small></div>
        <div class="bx-h-v">${t.k === "COMPRA" ? "−" : "+"}${money(t.p * t.q)}${t.pnl != null ? `<small class="${cls(t.pnl)}">${smoney(t.pnl)}</small>` : ""}</div>
      </div>`).join("");
  }
  function sheet(title, mount) {
    let unmount = null;
    AX.modal({
      title,
      html: `<div class="bx-sheet"></div>`,
      buttons: [{ label: "Cerrar", kind: "ghost", value: null }],
      onOpen: (m) => {
        const root = m.querySelector(".bx-sheet");
        const upd = mount(root);
        const entry = { upd };
        openSheets.add(entry);
        unmount = () => openSheets.delete(entry);
      },
    }).then(() => unmount && unmount());
  }
  function openPortfolio() {
    if (!st) return;
    sheet("Mi cartera", (root) => mountPortfolio(root, false));
  }
  function openHistory() {
    if (!st) return;
    sheet("Historial", (root) => {
      root.className = "bx-sheet bx-list";
      let len = -1;
      const upd = () => {
        if (st.history.length !== len) { root.innerHTML = historyHTML(); len = st.history.length; }
      };
      upd();
      return upd;
    });
  }
  let deskPf = null;
  function refreshSheets(force) {
    if (!st) return;
    openSheets.forEach((e) => e.upd(force));
    const desk = $("#bx-desk");
    if (desk && desk.getClientRects().length) {
      if (!deskPf) deskPf = mountPortfolio($("#desk-pf"), true);
      deskPf(force);
      if (histDirty) { $("#desk-hist").innerHTML = historyHTML(); histDirty = false; }
    }
  }
  setInterval(() => st && !settled && refreshSheets(), 500);

  /* ------------------------------------------------------------ APARCAR / RECUPERAR */
  /** Al salir u ocultar la página: devuelve el valor de liquidación al saldo y guarda una instantánea. */
  function park() {
    if (!st || settled || locked || st.parked) return;
    if (!owns()) return;
    const P = Math.max(0, Math.floor(equity()));
    st.paused = true;
    st.parked = P;
    if (!save(true)) { st.parked = 0; return; }
    AX.addBalance(P, { silent: true, achievements: false });
  }
  /** Al volver: vuelve a cobrar exactamente lo aparcado y continúa. */
  function unpark() {
    if (!st || settled || locked) return true;
    const o = readStored();
    if (!o || o.id !== st.id) { location.reload(); return false; }
    if (o.owner !== ME) { lockOut("other"); return false; }
    if (!o.parked) { st.parked = 0; return true; }
    if (!AX.spend(o.parked, { silent: true })) {
      clearStored();
      settled = true;
      AX.modal({
        title: "Partida cerrada",
        html: `<p class="bx-lock-msg">Al salir se liquidó tu cartera por <b>${money(o.parked)}</b> y ese dinero ya se ha usado.<br>Empieza una partida nueva cuando quieras.</p>`,
        buttons: [{ label: "Nueva partida", kind: "gold", value: true }],
        dismissable: false,
      }).then(() => pickInvestment());
      return false;
    }
    st.parked = 0;
    save(true);
    return true;
  }
  function onHide() {
    if (!st || settled || locked || busy === "boot") return;
    park();
    updatePauseUI();
  }
  function onShow() {
    if (!st || settled || locked || !st.parked) return;
    if (unpark()) {
      updatePauseUI();
      updateLive(true);
      $("#bx-paused-s").textContent = "Partida recuperada tal y como la dejaste.";
      AX.toast("Partida recuperada · mercado en pausa", "info", 2000);
    }
  }
  document.addEventListener("visibilitychange", () => (document.hidden ? onHide() : onShow()));
  window.addEventListener("pagehide", onHide);
  window.addEventListener("pageshow", (e) => { if (e.persisted) onShow(); });
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY_STATE || !st || settled || locked) return;
    const o = readStored();
    if (!o || o.id !== st.id) lockOut("gone");
    else if (o.owner !== ME) lockOut("other");
  });

  /** Otra pestaña ha tomado el control (o ha cerrado) esta partida. */
  function lockOut(why) {
    if (locked) return;
    locked = true;
    busy = true;
    updateTradePanel();
    AX.modal({
      title: why === "other" ? "Partida abierta en otra pestaña" : "Partida cerrada",
      html: `<p class="bx-lock-msg">${why === "other" ? "Esta cartera se está usando en otra pestaña o ventana. Solo una puede operar a la vez." : "Esta partida ya se liquidó o se cerró en otra pestaña."}</p>`,
      buttons: [{ label: "Menú", kind: "ghost", value: "menu" }, { label: why === "other" ? "Continuar aquí" : "Recargar", kind: "gold", value: "here" }],
      dismissable: false,
    }).then((v) => {
      if (v !== "here") return AX.go("../index.html");
      if (why === "other") ssSet("bx_takeover", "1");
      location.reload();
    });
  }

  /* ------------------------------------------------------------ LIQUIDAR */
  async function confirmCashOut() {
    if (!st || settled || locked) return;
    const eq = equity(), pnl = r2(eq - st.investment);
    const v = await AX.modal({
      title: "¿Liquidar cartera?",
      html: `<div class="bx-sum" style="margin:0">
        <div class="wide"><small>Recibirás</small><b>${money(eq)}</b></div>
        <div><small>Inversión</small><b>${money(st.investment)}</b></div>
        <div><small>Resultado</small><b class="${cls(pnl)}">${smoney(pnl)}</b></div>
      </div><p style="margin:10px 0 0;text-align:center;font-size:13px;color:var(--ax-muted)">Se venden todas tus acciones al precio actual y el dinero vuelve a tu saldo.</p>`,
      buttons: [{ label: "Seguir operando", kind: "ghost", value: false }, { label: "Liquidar", kind: "gold", value: true }],
    });
    if (v) await cashOut();
  }

  async function cashOut() {
    if (!st || settled || locked) return;
    if (!owns()) { lockOut("other"); return; }
    busy = true;
    document.querySelectorAll(".bx-news, .bx-shock, .bx-mile").forEach((n) => n.remove());
    // vender todo al precio actual
    const rows = [];
    for (const sym of Object.keys(st.portfolio)) {
      const pos = st.portfolio[sym];
      const p = px(stockBy(sym));
      rows.push({ sym, q: pos.qty, v: r2(pos.qty * p), pnl: r2((p - pos.avg) * pos.qty) });
      sell(sym, pos.qty, "LIQUIDACIÓN", true);
    }
    const V = r2(st.cash);
    const inv = st.investment;
    const pnl = r2(V - inv);
    const summary = { V, inv, pnl, rows, trades: st.stats.trades, best: st.stats.best, worst: st.stats.worst, peak: Math.max(st.stats.peak, V), candles: st.tick - PREGEN };
    // ---- LIQUIDACIÓN: se borra la partida y se abona el valor (una sola vez) ----
    clearStored();
    settled = true;
    const before = AX.getBalance();
    AX.addBalance(V, { silent: true, achievements: false });
    if (hud) hud.setBalance(before, false);
    updatePauseUI();
    updateTradePanel();
    // ---- cinemáticas ----
    await liquidationCine(summary);
    const p100 = (pnl / inv) * 100;
    if (pnl >= 1) {
      const tier = p100 >= 300 ? "epic" : p100 >= 100 ? "mega" : p100 >= 40 ? "big" : "win";
      await AX.cine.bigWin(Math.round(pnl), { tier, label: `Beneficio neto · ${pct(p100)}` });
    } else if (pnl <= -1) {
      await AX.cine.defeat({ title: p100 <= -50 ? "¡Desplome!" : "Pérdidas", subtitle: `${smoney(pnl)} · ${pct(p100)}`, duration: 2200 });
    } else {
      await AX.cine.banner("Tablas", { sub: "Sin ganancias ni pérdidas", color: CFG.accent });
    }
    // monedas volando al saldo
    if (hud) {
      S.play("cash");
      await AX.fx.coinsTo({ x: innerWidth / 2, y: innerHeight * 0.55 }, hud.center(), { count: AX.clamp(Math.round(4 + Math.log10(V + 1) * 4), 5, 26) });
      hud.setBalance(AX.getBalance());
      AX.haptic("success");
      const res = AX.checkAchievements();
      if (res.unlocked.length) setTimeout(() => hud.setBalance(AX.getBalance()), 300);
    }
    showSummary(summary);
  }

  function liquidationCine(sm) {
    return new Promise((resolve) => {
      const l = AX.el("div", "bx-liq");
      const rows = sm.rows.map((r, i) => `<div class="bx-liq-row" style="animation-delay:${0.15 + i * 0.12}s"><span>${INFO[r.sym].icon} ${r.sym} ×${AX.fmt(r.q)}</span><span>${money(r.v)} <span class="${cls(r.pnl)}">${smoney(r.pnl)}</span></span></div>`).join("");
      l.innerHTML = `<div class="bx-liq-k">Campana de cierre · liquidación</div><div class="bx-liq-v"><span id="liq-v">0</span> €</div><div class="bx-liq-rows">${rows || `<div class="bx-liq-row"><span>Sin acciones en cartera</span><span>—</span></div>`}<div class="bx-liq-row" style="animation-delay:${0.2 + sm.rows.length * 0.12}s"><span>Efectivo final</span><span>${money(sm.V)}</span></div></div>`;
      document.body.appendChild(l);
      S.play("bell");
      AX.haptic("medium");
      const ve = l.querySelector("#liq-v");
      const t0 = performance.now(), dur = 1100;
      const tick = setInterval(() => S.play("tick"), 80);
      const anim = (now) => {
        const t = Math.min(1, (now - t0) / dur);
        ve.textContent = AX.fmt(sm.V * AX.ease.outCubic(t), 2);
        if (t < 1) requestAnimationFrame(anim);
        else { clearInterval(tick); S.play("register"); pulse(ve.parentElement); }
      };
      requestAnimationFrame(anim);
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        clearInterval(tick);
        l.classList.add("out");
        setTimeout(() => { l.remove(); resolve(); }, 350);
      };
      setTimeout(fin, 2200 + sm.rows.length * 120);
      setTimeout(() => l.addEventListener("pointerdown", fin), 600);
    });
  }

  function showSummary(sm) {
    const p100 = (sm.pnl / sm.inv) * 100;
    AX.modal({
      title: sm.pnl >= 0 ? "Sesión cerrada" : "Sesión cerrada en rojo",
      html: `<div class="bx-sum">
        <div class="wide"><small>Resultado neto</small><b class="${cls(sm.pnl)}">${smoney(sm.pnl)}</b></div>
        <div><small>Inversión</small><b>${money(sm.inv)}</b></div>
        <div><small>Devuelto al saldo</small><b>${money(sm.V)}</b></div>
        <div><small>Rentabilidad</small><b class="${cls(sm.pnl)}">${pct(p100)}</b></div>
        <div><small>Operaciones</small><b>${sm.trades}</b></div>
        <div><small>Mejor venta</small><b class="${sm.best ? cls(sm.best.pnl) : ""}">${sm.best ? sm.best.sym + " " + smoney(sm.best.pnl) : "—"}</b></div>
        <div><small>Máx. patrimonio</small><b>${money(sm.peak)}</b></div>
      </div><p style="margin:4px 0 0;text-align:center;font-size:13px;color:var(--ax-muted)">Saldo global actual: <b style="color:#ffe9a6">${AX.money(AX.getBalance())}</b></p>`,
      buttons: [{ label: "Menú", kind: "ghost", value: "menu" }, { label: "Nueva partida", kind: "gold", value: "again" }],
      dismissable: false,
    }).then((v) => (v === "again" ? pickInvestment() : AX.go("../index.html")));
  }

  /* ------------------------------------------------------------ NUEVA PARTIDA */
  function pickInvestment() {
    const bal = AX.getBalance();
    AX.modal({
      title: "Elige tu inversión",
      html: `<p style="margin:0 0 6px;text-align:center">Saldo disponible: <b style="color:#ffe9a6">${AX.money(bal)}</b></p>
        <div class="bx-amounts">${AMOUNTS.map((a) => `<button class="bx-amt ${a === 100 ? "adv" : ""}" data-a="${a}" ${bal < a ? "disabled" : ""}><b>${AX.money(a)}</b><small>${a === 100 ? "Estrategia avanzada" : "Bolsa Pro"}</small></button>`).join("")}</div>`,
      buttons: [{ label: "Volver al menú", kind: "ghost", value: "menu" }],
      dismissable: false,
      onOpen: (m, close) => {
        m.querySelectorAll(".bx-amt").forEach((b) =>
          b.addEventListener("click", () => {
            if (b.disabled) return;
            S.play("chip");
            close(+b.dataset.a);
          })
        );
      },
    }).then((v) => {
      if (v === "menu" || v == null) return AX.go("../index.html");
      const target = modeForAmount(v);
      if (target !== MODE) {
        ssSet(KEY_INV, String(v));
        return AX.go(FILES[target]);
      }
      settled = false;
      brokeShown = false;
      if (!startNew(v)) return pickInvestment();
      openMarket(true);
    });
  }

  /** Cobra la inversión y crea la partida. */
  function startNew(inv) {
    if (!AMOUNTS.includes(inv) && !(inv > 0)) return false;
    if (AX.getBalance() < inv || !AX.spend(inv)) {
      AX.toast(`Saldo insuficiente para invertir ${AX.money(inv)}`, "error", 3000);
      return false;
    }
    freshState(inv);
    if (!save(true)) {
      // no se pudo guardar: devolvemos el dinero para no perderlo
      AX.addBalance(inv, { silent: true, achievements: false });
      st = null;
      return false;
    }
    settled = false;
    locked = false;
    return true;
  }

  /** Liquida en silencio una partida previa (al llegar con una inversión nueva desde el menú). */
  function settleStored(o) {
    clearStored();
    if (o.parked) return { amount: o.parked, already: true };
    let V = o.cash;
    for (const sym of Object.keys(o.portfolio || {})) {
      const s = o.stocks.find((x) => x.sym === sym);
      if (s) V += o.portfolio[sym].qty * Math.max(0.01, r2(s.live));
    }
    V = r2(V);
    AX.addBalance(V, { silent: true, achievements: false });
    return { amount: V, already: false };
  }

  /** Arranca la UI de una partida (nueva o reanudada). */
  async function openMarket(isNew, resumed) {
    busy = true;
    $("#bx-app").classList.add("bx-on");
    CH.snap = true;
    eqShown = null;
    deskPf = null;
    histDirty = true;
    chartResize();
    syncToggles();
    tickerBuild();
    chipsCandle();
    updateLive(true);
    updatePauseUI();
    if (isNew) {
      await AX.cine.intro({ title: CFG.title, subtitle: CFG.subtitle, icon: CFG.icon, color: CFG.color, once: true, key: "bolsa-" + MODE });
      await bellCine(`Inversión: <b style="color:#ffe9a6">${AX.money(st.investment)}</b>`);
      busy = false;
      st.paused = false;
      lastStepAt = performance.now();
      save();
    } else {
      busy = false;
      st.paused = true;
      $("#bx-paused-s").textContent = "Partida recuperada tal y como la dejaste. Tu dinero sigue invertido.";
      save();
      AX.cine.banner(resumed ? "Partida reanudada" : "De vuelta al parqué", { sub: "Pulsa reanudar para seguir operando", color: CFG.accent, duration: 1600 });
    }
    updatePauseUI();
    updateLive(true);
  }

  /* ------------------------------------------------------------ SALIR */
  async function onBack() {
    if (!st || settled || locked) return true;
    const eq = equity(), pnl = r2(eq - st.investment);
    const v = await AX.modal({
      title: "¿Salir del parqué?",
      html: `<p style="margin:0 0 8px;text-align:center">Patrimonio: <b>${money(eq)}</b> · <b class="${cls(pnl)}">${smoney(pnl)}</b></p>
        <p style="margin:0;text-align:center;font-size:13px;color:var(--ax-muted)"><b style="color:#fff">Guardar y salir</b>: tu cartera se congela y su valor vuelve a tu saldo mientras no juegas; al volver se recupera tal cual.<br><b style="color:#fff">Liquidar</b>: vendes todo y cierras la sesión.</p>`,
      buttons: [{ label: "Seguir", kind: "ghost", value: null }, { label: "Guardar y salir", kind: "cyan", value: "save" }, { label: "Liquidar", kind: "gold", value: "cash" }],
    });
    if (v === "save") { park(); return true; }
    if (v === "cash") { cashOut(); return false; }
    return false;
  }

  /* ------------------------------------------------------------ ARRANQUE */
  function boot() {
    busy = "boot";
    LEGACY_KEYS.forEach(ssDel); // estados del formato antiguo (no tenían dinero retenido)
    hud = AX.hud({
      title: `<div class="bx-hud-t"><span class="bx-hud-k">${CFG.short}</span><span class="bx-hud-eq" id="bx-eq">—</span><span class="bx-hud-pnl" id="bx-pnl"></span></div>`,
      back: "../index.html",
      onBack,
    });
    buildDOM();
    requestAnimationFrame(frame);

    const invRaw = ssGet(KEY_INV);
    ssDel(KEY_INV); // se consume: una recarga reanuda en lugar de empezar otra vez
    const stored = readStored();
    if (!stored) lsDel(KEY_STATE);

    if (invRaw != null) {
      // Llegada desde el menú con una inversión nueva
      const inv = parseInt(invRaw, 10);
      let note = null;
      if (stored) note = settleStored(stored);
      if (!(inv > 0) || !startNew(inv)) {
        busy = false;
        if (note) AX.toast(`Partida anterior liquidada: ${money(note.amount)} a tu saldo`, "gold", 3500);
        return pickInvestment();
      }
      if (note) setTimeout(() => AX.toast(`Partida anterior liquidada: ${money(note.amount)} devueltos a tu saldo`, "gold", 3500), 300);
      return openMarket(true);
    }
    if (stored) {
      if (stored.mode && stored.mode !== MODE && FILES[stored.mode]) {
        location.replace(FILES[stored.mode]);
        return;
      }
      const forced = ssGet("bx_takeover") === "1";
      ssDel("bx_takeover");
      const live = !forced && !stored.parked && stored.owner && stored.owner !== ME && Date.now() - (stored.savedAt || 0) < 6000;
      if (live) {
        busy = false;
        return AX.modal({
          title: "Partida abierta en otra pestaña",
          html: `<p class="bx-lock-msg">Tu cartera está activa en otra pestaña. ¿Quieres continuarla aquí?</p>`,
          buttons: [{ label: "Menú", kind: "ghost", value: false }, { label: "Continuar aquí", kind: "gold", value: true }],
          dismissable: false,
        }).then((v) => (v ? takeOver() : AX.go("../index.html")));
      }
      return takeOver();
    }
    busy = false;
    pickInvestment();
  }

  function takeOver() {
    const o = readStored();
    if (!o) return pickInvestment();
    st = o;
    st.owner = ME;
    if (st.parked) {
      const P = st.parked;
      if (!AX.spend(P, { silent: true })) {
        clearStored();
        st = null;
        busy = false;
        AX.toast(`Tu partida anterior se liquidó al salir (${money(P)})`, "gold", 3500);
        return pickInvestment();
      }
      st.parked = 0;
    }
    // compatibilidad: asegura campos
    st.stats = st.stats || { trades: 0, best: null, worst: null, peak: st.investment, low: st.investment, realized: 0 };
    st.marks = st.marks || [];
    st.news = st.news || [];
    st.milestones = st.milestones || [];
    st.history = st.history || [];
    st.stocks.forEach((s) => { if (!s.path) planCandle(s); });
    if (!save(true)) return;
    openMarket(false, true);
  }

  AX.ready(boot);
})();
