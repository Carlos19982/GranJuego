/* ==========================================================================
   JUEGO 6 · BOLSA — motor único para:
     · juego6.html  (data-mode="pro")         → "Bolsa Pro" (1.000 / 5.000 / 10.000 €)
     · juego6b.html (data-mode="estrategia")  → "Estrategia avanzada" (100 €)

   MERCADO
     · 16 activos: 11 acciones ficticias, 2 índices (calculados como media
       ponderada de sus componentes) y 3 materias primas (petróleo, oro, gas).
     · 1 vela = 40 s a velocidad ×1 (×2 / ×4 opcionales), 80 sub-pasos en directo.
     · Dinámica: factor de mercado + regímenes persistentes (sesiones tranquilas
       o volátiles, tendencias por valor) + transmisión del petróleo a los
       sectores sensibles + noticias por valor / sector + crash / rally raros.

   OPERATIVA
     · Largos (comprar / vender) y cortos (vender en corto / cubrir) a la vez,
       incluso sobre el mismo activo. Sin apalancamiento:
         garantía del corto = 100 % del valor a la entrada (sale del efectivo),
         P&L del corto = (entrada − precio) × cantidad,
         comisión de préstamo = 0,05 % del valor actual del corto por vela,
         llamada de margen (cierre forzoso) si la pérdida llega al 90 % de la garantía.
       Nunca se puede perder más que la garantía.

   ECONOMÍA (depósito en garantía):
     · Al empezar, la inversión elegida en el menú (sessionStorage
       "game6InitialInvestment") se COBRA del saldo global con AX.spend().
     · Al liquidar se ABONA el valor de liquidación (efectivo + largos a precio
       de mercado + garantía ± P&L de los cortos) con AX.addBalance().
     · La partida en curso vive en localStorage ("stockSimActiveGame_v3").
       Al salir / ocultar / recargar, la cartera se "aparca": su valor de
       liquidación (euros enteros) se devuelve al saldo y queda una instantánea.
       Al volver se vuelve a cobrar ese mismo importe y se continúa exactamente
       donde estaba (vela en curso incluida). Así no se puede ganar ni perder
       dinero recargando o abandonando, y el menú siempre ve el saldo real.
   Requiere ../shared/arcade.js (objeto global AX).
   ========================================================================== */
(function () {
  "use strict";

  /* ------------------------------------------------------------ CONFIG */
  const MODE = document.body.dataset.mode === "estrategia" ? "estrategia" : "pro";
  const FILES = { pro: "juego6.html", estrategia: "juego6b.html" };
  const KEY_STATE = "stockSimActiveGame_v3"; // localStorage: partida en curso / aparcada
  const KEY_INV = "game6InitialInvestment"; // sessionStorage: lo escribe el menú
  const KEY_PREFS = "stockSimPrefs_v3"; // localStorage: preferencias de gráfico y velocidad
  const LEGACY_KEYS = ["stockSimGameState_Pro", "stockSimGameState_v2"];
  const AMOUNTS = [100, 1000, 5000, 10000];
  const modeForAmount = (a) => (a === 100 ? "estrategia" : "pro");

  const ENGINE = 4; // versión del motor guardada en la partida (migración de partidas v3 antiguas)
  const SL_PCT = -4; // stop-loss  (rentabilidad de la posición)
  const TP_PCT = 5; //  take-profit
  const CANDLE_MS = 40000; // 1 vela = 40 s a velocidad ×1 (×2 = 20 s, ×4 = 10 s)
  const STEPS = 80; // sub-pasos en directo por vela (500 ms a ×1)
  const STEP_MS = CANDLE_MS / STEPS;
  const SPEEDS = [1, 2, 4];
  const HIST = 90; // velas guardadas por activo
  const PREGEN = 70; // velas de la sesión anterior
  const EVENT_P = 0.3; // prob. de noticia por vela (≈ 1 cada 2 min a ×1)
  const MAX_EVENTS = 2;
  const SHOCK_P = 0.016; // prob. de crash / rally por vela (≈ 1 cada 40 min a ×1)
  const SHOCK_COOLDOWN = 45;
  const MKT_SIG = 0.004; // volatilidad del factor de mercado por vela
  const SIG_K = 0.85; // escala global del ruido propio de cada activo
  const MEAN_REV = 0.003; // ligera vuelta a la media a largo plazo
  const SHORT_FEE = 0.0005; // comisión de préstamo: 0,05 % del valor actual por vela
  const MARGIN_CALL = 0.9; // pérdida / garantía que fuerza el cierre
  const MARGIN_WARN = 0.5; // aviso previo
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
      mom: 0.05, // momento: deriva por vela = mom · (MA5/MA15 − 1)
      rsiTurn: 0.003, // giro por vela durante 4 velas cuando el RSI sale de 70 / 30
      rsiK: 0.007, // corrección por vela con RSI en 100 / 0 (proporcional fuera de 30–70)
      chart: "candles",
      cmp: false,
      arrows: true, // las noticias muestran a quién benefician / perjudican
    },
    estrategia: {
      label: "Estrategia avanzada",
      short: "Estrategia 100",
      title: "Estrategia",
      subtitle: "Modo avanzado · señales más fuertes",
      icon: "♟️",
      color: "#ffcc33",
      accent: "rgba(255, 159, 28, 0.92)",
      mom: 0.065,
      rsiTurn: 0.0036,
      rsiK: 0.0085,
      chart: "area",
      cmp: true,
      arrows: false, // noticias ambiguas: se dice a quién afectan, no hacia dónde
    },
  }[MODE];

  /* ------------------------------------------------------------ ACTIVOS (todos ficticios) */
  const CATS = [
    { id: "stock", label: "Acciones" },
    { id: "index", label: "Índices" },
    { id: "comm", label: "Materias primas" },
  ];
  const SECTORS = {
    tech: "Tecnología", food: "Alimentación", games: "Videojuegos", bank: "Banca", green: "Energía verde",
    energy: "Petróleo y gas", air: "Aerolíneas", pharma: "Farmacia", telecom: "Telecomunicaciones", auto: "Automoción",
    oil: "Petróleo", gold: "Metales preciosos", gas: "Gas natural", index: "Índice",
  };
  /* sig: volatilidad propia por vela · beta: sensibilidad al mercado · oil: sensibilidad al petróleo */
  const ASSETS = [
    { sym: "TECH", name: "Tech Corp", cat: "stock", sec: "tech", icon: "💻", color: "#4f8bff", price: 15.0, sig: 0.012, beta: 1.2, peers: ["IBX", "INNO", "AURA"] },
    { sym: "FOOD", name: "Foodies Inc", cat: "stock", sec: "food", icon: "🍔", color: "#ffb020", price: 5.0, sig: 0.007, beta: 0.6, oil: -0.06, peers: ["IBX", "GALE", "CRUDO"] },
    { sym: "GAME", name: "GameDev Co", cat: "stock", sec: "games", icon: "🎮", color: "#b07cff", price: 8.0, sig: 0.015, beta: 1.1, peers: ["INNO", "TECH", "IBX"] },
    { sym: "FIN", name: "Finance Hub", cat: "stock", sec: "bank", icon: "🏦", color: "#18e0c0", price: 20.0, sig: 0.009, beta: 1.1, peers: ["BMER", "IBX", "ORO"] },
    { sym: "ECO", name: "Eco Energy", cat: "stock", sec: "green", icon: "🌿", color: "#9fe870", price: 7.0, sig: 0.013, beta: 0.9, oil: 0.15, peers: ["CANT", "CRUDO", "IBX"] },
    { sym: "CANT", name: "Petrolera Cantábrica", cat: "stock", sec: "energy", icon: "⛽", color: "#ff7a1a", price: 12.4, sig: 0.01, beta: 0.8, oil: 0.55, peers: ["CRUDO", "ECO", "IBX"] },
    { sym: "BMER", name: "Banco Meridiano", cat: "stock", sec: "bank", icon: "🏛️", color: "#e8c872", price: 6.8, sig: 0.011, beta: 1.25, peers: ["FIN", "IBX", "ORO"] },
    { sym: "ALBA", name: "Albatros Airlines", cat: "stock", sec: "air", icon: "✈️", color: "#7fd4ff", price: 4.2, sig: 0.015, beta: 1.3, oil: -0.45, peers: ["CRUDO", "IBX", "HISP"] },
    { sym: "GALE", name: "Galeno Farma", cat: "stock", sec: "pharma", icon: "💊", color: "#ff6fa8", price: 18.5, sig: 0.011, beta: 0.5, peers: ["IBX", "INNO", "FOOD"] },
    { sym: "AURA", name: "Aurora Telecom", cat: "stock", sec: "telecom", icon: "📡", color: "#ff4fd8", price: 3.6, sig: 0.008, beta: 0.7, peers: ["TECH", "INNO", "IBX"] },
    { sym: "HISP", name: "Hispania Motor", cat: "stock", sec: "auto", icon: "🚗", color: "#c9c9de", price: 9.9, sig: 0.012, beta: 1.2, oil: -0.15, peers: ["CRUDO", "ECO", "IBX"] },
    {
      sym: "IBX", name: "IBX 11 · índice general", cat: "index", sec: "index", icon: "📊", color: "#e9e4ff", level: 40, unit: "uds.",
      w: { FIN: 0.14, TECH: 0.14, BMER: 0.1, CANT: 0.1, GALE: 0.1, AURA: 0.08, HISP: 0.08, FOOD: 0.07, ECO: 0.07, GAME: 0.06, ALBA: 0.06 },
      peers: ["INNO", "ORO", "CRUDO"],
    },
    {
      sym: "INNO", name: "Índice Innova · tecnológicas", cat: "index", sec: "index", icon: "🚀", color: "#22e4ff", level: 25, unit: "uds.",
      w: { TECH: 0.35, GAME: 0.25, AURA: 0.2, GALE: 0.2 },
      peers: ["IBX", "TECH", "GAME"],
    },
    { sym: "CRUDO", name: "Petróleo · barril", cat: "comm", sec: "oil", icon: "🛢️", color: "#c8a070", price: 78.0, sig: 0.014, beta: 0.35, unit: "barr.", peers: ["GAS", "CANT", "ALBA"] },
    { sym: "ORO", name: "Oro · gramo", cat: "comm", sec: "gold", icon: "🥇", color: "#ffd23f", price: 62.0, sig: 0.006, beta: -0.25, unit: "g", peers: ["IBX", "CRUDO", "FIN"] },
    { sym: "GAS", name: "Gas natural · MWh", cat: "comm", sec: "gas", icon: "🔥", color: "#6fb6ff", price: 34.0, sig: 0.017, beta: 0.2, oil: 0.35, unit: "MWh", peers: ["CRUDO", "ECO", "CANT"] },
  ];
  const DEF = {};
  const ORD = {};
  ASSETS.forEach((d, i) => {
    DEF[d.sym] = d;
    ORD[d.sym] = i;
  });
  const INFO = DEF;
  const unitOf = (sym) => (DEF[sym] && DEF[sym].unit) || "acc.";
  const fmtQ = (q, sym) => AX.fmt(q) + " " + unitOf(sym);
  const isIdx = (sym) => DEF[sym] && DEF[sym].cat === "index";

  /* ------------------------------------------------------------ NOTICIAS
     eff: deriva por vela. "ALL" = mercado (cada activo según su beta),
     "S:sector" = un sector, "SYM" = un activo. Lo que mueve el petróleo
     (CRUDO) se transmite solo a los sectores sensibles (oil beta).
     Al publicarse, cada efecto da además un salto inicial (× 3,5..6).          */
  const EVENTS_PRO = [
    { name: "Optimismo Global", icon: "🌍", message: "El mercado muestra optimismo: los inversores vuelven a comprar.", duration: 3, vol: 1.6, eff: { ALL: 0.0016 } },
    { name: "Temor a Recesión", icon: "📉", message: "Aumentan los temores de recesión. El oro brilla como refugio.", duration: 3, vol: 1.8, eff: { ALL: -0.0018, ORO: 0.0025 } },
    { name: "Anuncio Tecnológico", icon: "💻", message: "Tech Corp hará un anuncio importante.", duration: 3, vol: 2, eff: { TECH: 0.0045 } },
    { name: "Regulación Tecnológica", icon: "⚖️", message: "Nuevas regulaciones para el sector tecnológico.", duration: 3, vol: 1.8, eff: { "S:tech": -0.0035, GAME: -0.0015, AURA: -0.001 } },
    { name: "Movimientos Banca", icon: "🏦", message: "La banca reporta ingresos récord: Finance Hub y Banco Meridiano, al alza.", duration: 3, vol: 1.6, eff: { "S:bank": 0.003 } },
    { name: "Caída del Petróleo", icon: "🛢️", message: "El petróleo se desploma: alivio para aerolíneas, golpe a las petroleras.", duration: 3, vol: 2, tone: 1, eff: { CRUDO: -0.0055, ECO: 0.0012 } },
    { name: "Proyecto Secreto", icon: "🎮", message: "GameDev Co. anuncia un proyecto secreto.", duration: 3, vol: 2.2, eff: { GAME: 0.0055 } },
    { name: "Cadena de Suministro", icon: "🚚", message: "Foodies Inc tiene problemas de suministro.", duration: 3, vol: 1.8, eff: { FOOD: -0.0035 } },
    { name: "El Crudo se Dispara", icon: "🛢️", message: "Los productores recortan la producción: el barril se dispara. Petroleras al alza, aerolíneas a la baja.", duration: 3, vol: 2, tone: -1, eff: { CRUDO: 0.006 } },
    { name: "Huelga Aérea", icon: "✈️", message: "Huelga de controladores aéreos: cancelaciones masivas.", duration: 3, vol: 1.8, eff: { "S:air": -0.0045 } },
    { name: "Subida de Tipos", icon: "🏛️", message: "El banco central sube los tipos: gana la banca, sufren automoción y tecnológicas.", duration: 3, vol: 1.6, tone: -1, eff: { "S:bank": 0.0025, "S:auto": -0.002, "S:tech": -0.0015, ORO: -0.0015, ALL: -0.0006 } },
    { name: "Ensayo Clínico", icon: "💊", message: "Galeno Farma supera con éxito la fase final de su ensayo clínico.", duration: 3, vol: 2, eff: { GALE: 0.0055 } },
    { name: "Licencia 6G", icon: "📡", message: "Aurora Telecom se adjudica la licencia 6G nacional.", duration: 3, vol: 1.8, eff: { AURA: 0.0045 } },
    { name: "Plan Coche Eléctrico", icon: "🚗", message: "Ayudas públicas al coche eléctrico: Hispania Motor y Eco Energy, al alza.", duration: 3, vol: 1.6, eff: { HISP: 0.0035, ECO: 0.002, CRUDO: -0.0015 } },
    { name: "Ola de Frío", icon: "❄️", message: "Una ola de frío dispara la demanda de gas natural.", duration: 3, vol: 2, eff: { GAS: 0.007 } },
    { name: "Huida al Oro", icon: "🥇", message: "Los grandes fondos buscan refugio: el oro marca máximos.", duration: 3, vol: 1.6, eff: { ORO: 0.0045, ALL: -0.0006 } },
    { name: "Recogida de Beneficios en el Oro", icon: "🥇", message: "Los fondos recogen beneficios: el oro cae con fuerza.", duration: 3, vol: 1.6, eff: { ORO: -0.0045 } },
  ];
  const EVENTS_ADV = [
    { name: "Optimismo Global Cauteloso", icon: "🌍", message: "El mercado muestra optimismo, pero los analistas piden cautela. ¿Oportunidad o trampa?", duration: 3, vol: 2, eff: { ALL: -0.0008 } },
    { name: "Temor a Recesión", icon: "📉", message: "Aumentan los temores de recesión, pero algunos ven oportunidades de compra.", duration: 3, vol: 2.2, eff: { ALL: 0.001, ORO: 0.0015 } },
    { name: "Anuncio Tecnológico", icon: "💻", message: "Tech Corp hará un 'anuncio importante' esta semana. El mercado especula.", duration: 3, vol: 2.4, eff: { TECH: 0.0035 } },
    { name: "Regulación Tecnológica", icon: "⚖️", message: "Se anuncian nuevas regulaciones para el sector Tech. ¿Protegerán al consumidor o ahogarán la innovación?", duration: 3, vol: 2.2, eff: { "S:tech": -0.002, AURA: -0.001 } },
    { name: "Movimientos en la Banca", icon: "🏦", message: "Finance Hub reporta 'movimientos inesperados' en sus cuentas. ¿Bueno o malo?", duration: 3, vol: 2, eff: { FIN: 0.0025, BMER: 0.001 } },
    { name: "Caída del Petróleo", icon: "🛢️", message: "El petróleo se desploma. Malo para las petroleras, ¿pero bueno para los costes de Eco Energy?", duration: 3, vol: 2.4, eff: { CRUDO: -0.004, ECO: 0.002 } },
    { name: "Nuevo Proyecto de GameDev", icon: "🎮", message: "GameDev Co. anuncia un proyecto secreto llamado 'Prometeo'. La comunidad está dividida.", duration: 3, vol: 2.6, eff: { GAME: 0.0045 } },
    { name: "Cadena de Suministro", icon: "🚚", message: "Foodies Inc reestructura su cadena de suministro. ¿Reducción de costes o señal de problemas?", duration: 3, vol: 2.2, eff: { FOOD: -0.0015 } },
    { name: "Datos de Inflación", icon: "📊", message: "¡Datos de inflación generan alta incertidumbre y volatilidad!", duration: 3, vol: 2.2, eff: { ALL: -0.0005, ORO: 0.002 } },
    { name: "Desastre Natural", icon: "🌪️", message: "¡Desastre natural impacta la economía global!", duration: 3, vol: 2.3, eff: { ALL: -0.0012, GAS: 0.003 } },
    { name: "Rumores de Fusión", icon: "🤝", message: "Rumores de fusión en Banco Meridiano. ¿Sinergias o dilución para el accionista?", duration: 3, vol: 2.4, eff: { BMER: -0.002, FIN: 0.001 } },
    { name: "Coberturas de Combustible", icon: "✈️", message: "Albatros Airlines fija el precio de su combustible a dos años. ¿Blindaje o apuesta arriesgada?", duration: 3, vol: 2.2, eff: { ALBA: 0.003 } },
    { name: "Ensayo en Pausa", icon: "💊", message: "Galeno Farma retrasa los resultados de su ensayo estrella. ¿Prudencia o malas noticias?", duration: 3, vol: 2.4, eff: { GALE: -0.0035 } },
    { name: "Tensión Geopolítica", icon: "🌐", message: "Tensión en las zonas productoras: el crudo oscila con fuerza. ¿Quién gana y quién pierde?", duration: 3, vol: 2.6, eff: { CRUDO: 0.0045, ORO: 0.002 } },
    { name: "Inversión Récord en Redes", icon: "📡", message: "Aurora Telecom anuncia un plan de inversión récord en fibra. ¿Futuro o despilfarro?", duration: 3, vol: 2, eff: { AURA: -0.002 } },
    { name: "Nuevo Eléctrico", icon: "🚗", message: "Hispania Motor presenta su nuevo eléctrico. Críticas mixtas en la prensa especializada.", duration: 3, vol: 2.4, eff: { HISP: 0.0015 } },
    { name: "Venta de Reservas de Oro", icon: "🥇", message: "Un banco central anuncia que venderá parte de sus reservas de oro. ¿Señal de confianza o de apuros?", duration: 3, vol: 2.2, eff: { ORO: -0.003, ALL: 0.0004 } },
  ];
  // Eventos extremos (comunes a ambos modos, simétricos). jolt: saltos [mín, máx] (ALL × beta de cada activo)
  const SHOCKS = [
    { name: "CRASH", kind: "crash", icon: "💥", message: "Pánico vendedor: las bolsas de todo el mundo se desploman. El oro actúa de refugio.", duration: 2, vol: 2.4, eff: { ALL: -0.004, ORO: 0.003 }, jolt: { ALL: [-0.06, -0.035], ORO: [0.02, 0.035], CRUDO: [-0.03, -0.012] } },
    { name: "RALLY", kind: "rally", icon: "🚀", message: "Euforia compradora: los bancos centrales recortan tipos por sorpresa.", duration: 2, vol: 2.2, eff: { ALL: 0.004, ORO: -0.002 }, jolt: { ALL: [0.035, 0.06], ORO: [-0.015, -0.005] } },
  ];
  const EVENTS = MODE === "estrategia" ? EVENTS_ADV : EVENTS_PRO;
  const EV_BY_NAME = {};
  EVENTS.concat(SHOCKS).forEach((e) => (EV_BY_NAME[e.name] = e));
  const evVolMul = (ev) => 1 + ((ev.vol || 1) - 1) * 0.3; // volatilidad extra de una noticia, atenuada
  const evDirect = (ev, d) => ((ev.eff || {})["S:" + d.sec] || 0) + ((ev.eff || {})[d.sym] || 0);
  /** Efecto total esperado de una noticia sobre un activo (para mostrarlo y marcarlo en el gráfico). */
  function evImpact(ev, d) {
    if (d.cat === "index") return Object.keys(d.w).reduce((a, k) => a + d.w[k] * evImpact(ev, DEF[k]), 0);
    const e = ev.eff || {};
    let v = (e.ALL || 0) * d.beta + evDirect(ev, d);
    if (d.oil) v += d.oil * ((e.CRUDO || 0) + (e.ALL || 0) * DEF.CRUDO.beta);
    return v;
  }
  const evTone = (ev) => (ev.tone != null ? ev.tone : Object.values(ev.eff || {}).reduce((a, b) => a + b, 0) >= 0 ? 1 : -1);

  const REGIMES = [
    { id: "calm", vm: 0.65, p: 0.35 },
    { id: "normal", vm: 1, p: 0.45 },
    { id: "wild", vm: 1.6, p: 0.2 },
  ];

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
  const pct = (p) => (p >= 0 ? "+" : "−") + AX.fmt(Math.abs(p), 2) + " %";
  const pct1 = (p) => (p >= 0 ? "+" : "−") + AX.fmt(Math.abs(p), 1) + " %";
  const cls = (n) => (n > 0 ? "bx-up" : n < 0 ? "bx-down" : "");
  const gauss = () => {
    let u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
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

  /* Cola de cinemáticas: noticias, crash/rally, SL/TP, márgenes e hitos se suceden sin solaparse
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
  // gruñido del oso: abrir un corto
  S.register("bear", () => {
    S.tone(140, 0.55, { type: "sawtooth", to: 55, vol: 0.12, filter: { freq: 700 } });
    S.noise(0.45, { type: "lowpass", freq: 600, to: 150, vol: 0.32 });
    [67, 63, 58].forEach((n, i) => S.tone(S.note(n), 0.16, { type: "square", vol: 0.06, delay: 0.08 + i * 0.1, filter: { freq: 2200 } }));
  });
  // sirena: llamada de margen
  S.register("siren", () => {
    for (let i = 0; i < 4; i++) {
      S.tone(620, 0.32, { type: "sawtooth", to: 1240, vol: 0.07, delay: i * 0.36, filter: { freq: 2600 } });
    }
    S.tone(90, 1.2, { type: "sine", to: 40, vol: 0.4 });
  });

  /* ------------------------------------------------------------ ESTADO */
  let st = null; // partida en curso
  let busy = true; // cinemáticas / arranque: el mercado no avanza
  let settled = false; // partida liquidada en esta página
  let locked = false; // otra pestaña controla la partida
  let hud = null;
  let qty = 1;
  let pctSel = null;
  let curCat = "stock";
  let lastSaveAt = 0;
  let prefs = Object.assign({ ma: true, rsi: null, type: CFG.chart, cmp: CFG.cmp, speed: 1 }, (() => {
    try { return JSON.parse(lsGet(KEY_PREFS) + "") || {}; } catch (e) { return {}; }
  })()[MODE] || {});
  const savePrefs = () => {
    let all = {};
    try { all = JSON.parse(lsGet(KEY_PREFS) + "") || {}; } catch (e) {}
    all[MODE] = prefs;
    lsSet(KEY_PREFS, JSON.stringify(all));
  };
  const speed = () => (SPEEDS.includes(prefs.speed) ? prefs.speed : 1);

  const sel = () => st.stocks.find((s) => s.sym === st.selected) || st.stocks[0];
  const stockBy = (sym) => st.stocks.find((s) => s.sym === sym);
  const px = (s) => Math.max(0.01, r2(s.live)); // precio de ejecución (céntimos)
  const pxOf = (sym) => px(stockBy(sym));
  /** Valor de un corto = garantía + P&L (nunca negativo: no se puede perder más que la garantía). */
  const shortValue = (pos, p) => Math.max(0, pos.col + pos.basis - p * pos.qty);
  const longsValue = () => Object.keys(st.portfolio).reduce((a, k) => a + st.portfolio[k].qty * pxOf(k), 0);
  const shortsValue = () => Object.keys(st.shorts).reduce((a, k) => a + shortValue(st.shorts[k], pxOf(k)), 0);
  const collateral = () => r2(Object.keys(st.shorts).reduce((a, k) => a + st.shorts[k].col, 0));
  const equity = () => r2(st.cash + longsValue() + shortsValue());
  function openPL() {
    let v = 0;
    for (const k of Object.keys(st.portfolio)) v += (pxOf(k) - st.portfolio[k].avg) * st.portfolio[k].qty;
    for (const k of Object.keys(st.shorts)) v += posStats(k, "S").pl;
    return r2(v);
  }
  const hasPositions = () => Object.keys(st.portfolio).length > 0 || Object.keys(st.shorts).length > 0;
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
    lastSaveAt = performance.now();
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
  function newReg(d) {
    return { d: gauss() * 0.0012 * (d.sig / 0.012), rem: randInt(8, 30) };
  }
  function newMkt() {
    let x = Math.random(), r = REGIMES[0];
    for (const g of REGIMES) { r = g; if ((x -= g.p) < 0) break; }
    return { id: r.id, vm: r.vm, d: gauss() * 0.0006, rem: randInt(15, 40) };
  }
  function makeStock(d) {
    const p = d.cat === "index" ? d.level : d.price;
    const s = {
      sym: d.sym, price: p,
      candles: [], ma5: p, ma15: p, rsi: 50, avgGain: 0, avgLoss: 0,
      trendState: "neutral", trendTicks: 0, rsiRev: 0, wasOB: false, wasOS: false,
      open: p, hi: p, lo: p, live: p, path: null, dayOpen: p,
    };
    if (d.cat === "index") {
      s.base = d.level;
      s.ref = {};
      Object.keys(d.w).forEach((k) => (s.ref[k] = DEF[k].price));
    } else s.reg = newReg(d);
    return s;
  }
  /** Nivel de un índice: media ponderada de los precios relativos de sus componentes. */
  function idxLevel(s, get) {
    const w = DEF[s.sym].w;
    let v = 0;
    for (const k of Object.keys(w)) {
      const c = stockBy(k);
      if (c) v += (w[k] * get(c)) / (s.ref[k] || 1);
    }
    return s.base * v;
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

  /** Efecto real (y moderado) de los indicadores, como en los mercados de verdad:
   *  - Medias móviles: el momento persiste un poco. Si MA5 va por encima de MA15 la
   *    tendencia tiende a continuar, en proporción a la separación entre ambas
   *    (cruce dorado = empieza el empuje alcista; cruce de la muerte = el bajista).
   *  - RSI: por encima de 70 (sobrecompra) aparece una corrección gradual, más fuerte
   *    cuanto más extremo; por debajo de 30 (sobreventa), un rebote gradual.
   *  Son ventajas pequeñas frente al ruido de cada vela: ayudan a la larga, no aciertan siempre. */
  function signalDrift(s) {
    if (s.candles.length < 15 || !(s.ma15 > 0)) return 0;
    const spread = AX.clamp(s.ma5 / s.ma15 - 1, -0.06, 0.06);
    let d = CFG.mom * spread;
    if (s.rsi > 70) d -= (CFG.rsiK * (s.rsi - 70)) / 30;
    else if (s.rsi < 30) d += (CFG.rsiK * (30 - s.rsi)) / 30;
    // señal clásica: el RSI sale de la zona extrema → giro durante unas velas
    if (s.rsiRev > 0) { d += CFG.rsiTurn; s.rsiRev--; }
    else if (s.rsiRev < 0) { d -= CFG.rsiTurn; s.rsiRev++; }
    return d;
  }

  /** Suma los efectos de las noticias activas para la vela que se va a planificar. */
  function evState() {
    const A = { M: 0, MJ: 0, MV: 1, d: {}, j: {}, v: {} };
    for (const ae of st.events) {
      const ev = EV_BY_NAME[ae.name];
      if (!ev) continue;
      const e = ev.eff || {};
      const vm = evVolMul(ev);
      const J = ae.fresh && !ev.jolt ? ae.J || (ae.J = AX.rand(3.5, 6)) : 0;
      if (e.ALL) {
        A.M += e.ALL;
        A.MJ += e.ALL * J;
        A.MV *= vm;
      }
      if (ae.fresh && ev.jolt && ev.jolt.ALL) A.MJ += AX.rand(ev.jolt.ALL[0], ev.jolt.ALL[1]);
      for (const d of ASSETS) {
        if (d.cat === "index") continue;
        const dd = evDirect(ev, d);
        if (dd) {
          A.d[d.sym] = (A.d[d.sym] || 0) + dd;
          A.j[d.sym] = (A.j[d.sym] || 0) + dd * J;
        }
        if (ae.fresh && ev.jolt && ev.jolt[d.sym]) A.j[d.sym] = (A.j[d.sym] || 0) + AX.rand(ev.jolt[d.sym][0], ev.jolt[d.sym][1]);
        if (dd || e.ALL || (d.oil && e.CRUDO)) A.v[d.sym] = (A.v[d.sym] || 1) * vm;
      }
    }
    return A;
  }

  /** Planifica la siguiente vela de cada activo (y la de los índices a partir de sus componentes). */
  function planAll(list, withIdx = true) {
    list = (list || st.stocks.filter((s) => !isIdx(s.sym))).slice().sort((a, b) => (a.sym === "CRUDO" ? -1 : b.sym === "CRUDO" ? 1 : 0));
    const mk = st.mkt;
    const A = evState();
    const mret = mk.d + A.M + gauss() * MKT_SIG * mk.vm * A.MV;
    let oilR = 0;
    for (const s of list) {
      const d = DEF[s.sym];
      const open = s.candles.length ? s.candles[s.candles.length - 1].c : s.price;
      const vm = mk.vm * (A.v[s.sym] || 1);
      const drift = (s.reg ? s.reg.d : 0) + (A.d[s.sym] || 0) + signalDrift(s) - MEAN_REV * Math.log(open / d.price);
      const jolt = (A.j[s.sym] || 0) + d.beta * A.MJ;
      let r = d.beta * mret + drift + jolt + d.sig * SIG_K * vm * gauss();
      if (d.oil) r += d.oil * oilR;
      r = AX.clamp(r, -0.3, 0.3);
      if (s.sym === "CRUDO") oilR = r;
      const close = Math.max(0.01, open * (1 + r));
      s.open = r4(open);
      s.path = bridge(open, close, (open * d.sig * SIG_K * vm * 0.7) / Math.sqrt(STEPS), Math.abs(jolt) > 0.004);
      s.live = s.hi = s.lo = s.open;
    }
    if (withIdx) for (const s of st.stocks) if (isIdx(s.sym)) planIndex(s);
  }
  function planIndex(s) {
    const open = s.candles.length ? s.candles[s.candles.length - 1].c : s.price;
    s.path = [];
    for (let k = 0; k <= STEPS; k++) s.path.push(r4(idxLevel(s, (c) => (c.path ? c.path[k] : c.live))));
    s.path[0] = r4(open);
    s.open = r4(open);
    s.live = s.hi = s.lo = s.open;
  }

  /** Avanza los regímenes (sesión tranquila / normal / volátil y tendencias por valor). Devuelve el nuevo régimen si cambia. */
  function advanceRegimes() {
    let changed = null;
    if (!st.mkt || --st.mkt.rem <= 0) {
      const prev = st.mkt && st.mkt.id;
      st.mkt = newMkt();
      if (prev && st.mkt.id !== prev) changed = st.mkt.id;
    }
    for (const s of st.stocks) if (!isIdx(s.sym) && (!s.reg || --s.reg.rem <= 0)) s.reg = newReg(DEF[s.sym]);
    return changed;
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
    if (s.wasOB && s.rsi < 70) { s.rsiRev = -4; sig = sig || "rsiDown"; }
    if (s.wasOS && s.rsi > 30) { s.rsiRev = 4; sig = sig || "rsiUp"; }
    s.wasOB = s.rsi >= 70;
    s.wasOS = s.rsi <= 30;
    c.r = Math.round(s.rsi * 10) / 10;
    if (sig) c.s = sig;
    return sig;
  }
  function advanceCandle(list) {
    for (const s of list) {
      s.live = s.path[STEPS];
      for (const v of s.path) { if (v > s.hi) s.hi = v; if (v < s.lo) s.lo = v; }
      closeCandle(s);
    }
  }

  /** Caducan noticias y, con cierta probabilidad, entra una nueva. */
  function manageEvents() {
    st.events = st.events.filter((ae) => --ae.rem > 0);
    if (st.shockCool > 0) st.shockCool--;
    let fresh = null;
    const shockActive = st.events.some((ae) => EV_BY_NAME[ae.name] && EV_BY_NAME[ae.name].kind);
    if (!shockActive && !st.shockCool && Math.random() < SHOCK_P) {
      fresh = AX.pick(SHOCKS);
      st.shockCool = SHOCK_COOLDOWN;
    } else if (st.events.length < MAX_EVENTS && Math.random() < EVENT_P) {
      const recent = st.news.slice(0, 4).map((n) => n.name);
      const avail = EVENTS.filter((e) => !st.events.some((ae) => ae.name === e.name) && !recent.includes(e.name));
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
      v: 3, ver: ENGINE, id: rid(), owner: ME, mode: MODE, investment: inv, createdAt: Date.now(), savedAt: 0,
      cash: inv, portfolio: {}, shorts: {}, stocks: ASSETS.map(makeStock), events: [], tick: 0, step: 0, shockCool: 10, mkt: null,
      history: [], marks: [], news: [], milestones: [], paused: false, parked: 0, selected: "TECH",
      stats: { trades: 0, best: null, worst: null, peak: inv, low: inv, realized: 0 },
    };
    // Historial previo (sesión anterior) para que el gráfico y los indicadores arranquen llenos
    for (let i = 0; i < PREGEN; i++) {
      advanceRegimes();
      planAll();
      advanceCandle(st.stocks);
      st.tick++;
    }
    for (const s of st.stocks) s.dayOpen = s.price;
    advanceRegimes();
    planAll();
    st.step = 0;
    return st;
  }

  /** Re-muestrea la ruta intra-vela de una partida antigua (30 sub-pasos) a STEPS. */
  function resample(path, n) {
    const m = path.length - 1;
    const out = [];
    for (let k = 0; k <= n; k++) {
      const x = (k * m) / n, i = Math.floor(x), f = x - i;
      out.push(r4(i >= m ? path[m] : path[i] + (path[i + 1] - path[i]) * f));
    }
    return out;
  }
  /** Partidas guardadas por la versión anterior: 5 valores, 30 sub-pasos, sin cortos. */
  function migrate() {
    if (st.ver >= ENGINE) return;
    st.stocks = st.stocks.filter((s) => DEF[s.sym]);
    // 1) sub-pasos
    const refS = st.stocks.find((s) => s.path && s.path.length > 1);
    const m = refS ? refS.path.length - 1 : STEPS;
    let newStep = st.step;
    if (m !== STEPS) newStep = Math.max(0, Math.min(STEPS - 1, Math.round((st.step * STEPS) / m)));
    for (const s of st.stocks) {
      if (s.path && s.path.length - 1 !== STEPS) {
        s.path = resample(s.path, STEPS);
        s.path[newStep] = r4(s.live);
      }
    }
    st.step = newStep;
    // 2) campos nuevos
    st.shorts = st.shorts || {};
    st.mkt = st.mkt || newMkt();
    st.events = (st.events || []).filter((ae) => EV_BY_NAME[ae.name]);
    for (const s of st.stocks) if (!isIdx(s.sym) && !s.reg) s.reg = newReg(DEF[s.sym]);
    // 3) activos nuevos con historial propio, alineado con el reloj de la partida
    const missing = ASSETS.filter((d) => !stockBy(d.sym));
    const fresh = missing.filter((d) => d.cat !== "index").map(makeStock);
    const dayOpenOf = (s) => (s.candles.find((c) => c.t === PREGEN) || s.candles[0] || { o: s.price }).o;
    const rangeOf = (s) => {
      s.live = s.path[st.step];
      s.hi = s.lo = s.path[0];
      for (let k = 0; k <= st.step; k++) { s.hi = Math.max(s.hi, s.path[k]); s.lo = Math.min(s.lo, s.path[k]); }
    };
    if (fresh.length) {
      const n = Math.max(20, Math.min(HIST, ...st.stocks.map((s) => s.candles.length)));
      const tick0 = st.tick, evs = st.events, mk = st.mkt;
      st.events = [];
      st.mkt = newMkt();
      for (let k = 0; k < n; k++) {
        st.tick = tick0 - n + k;
        planAll(fresh, false);
        advanceCandle(fresh);
        fresh.forEach((s) => { if (--s.reg.rem <= 0) s.reg = newReg(DEF[s.sym]); });
      }
      st.tick = tick0;
      st.events = evs;
      st.mkt = mk;
      planAll(fresh, false);
      for (const s of fresh) {
        s.dayOpen = dayOpenOf(s);
        rangeOf(s);
      }
      st.stocks.push(...fresh);
    }
    for (const d of missing.filter((d) => d.cat === "index")) {
      const s = makeStock(d);
      const cons = Object.keys(d.w).map(stockBy).filter(Boolean);
      const at = (c, t) => c.candles.find((x) => x.t === t);
      const ts = cons.length ? cons[0].candles.map((c) => c.t).filter((t) => cons.every((c) => at(c, t))) : [];
      if (ts.length) {
        cons.forEach((c) => (s.ref[c.sym] = at(c, ts[0]).o));
        const tick0 = st.tick;
        for (const t of ts) {
          st.tick = t;
          s.open = r4(idxLevel(s, (c) => at(c, t).o));
          s.live = r4(idxLevel(s, (c) => at(c, t).c));
          s.hi = r4(idxLevel(s, (c) => at(c, t).h));
          s.lo = r4(idxLevel(s, (c) => at(c, t).l));
          closeCandle(s);
        }
        st.tick = tick0;
        s.dayOpen = dayOpenOf(s);
      }
      st.stocks.push(s);
      planIndex(s);
      rangeOf(s);
    }
    st.stocks.sort((a, b) => ORD[a.sym] - ORD[b.sym]);
    if (!stockBy(st.selected)) st.selected = "TECH";
    st.ver = ENGINE;
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
    else if (performance.now() - lastSaveAt > 1000) save();
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
    chargeFees();
    const ev = manageEvents();
    const reg = advanceRegimes();
    planAll();
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
    if (reg) regimeToast(reg);
    checkMilestones();
    checkBroke();
  }
  function regimeToast(id) {
    const T = {
      calm: ["😌 Sesión tranquila: las oscilaciones se suavizan", "info"],
      normal: ["📈 El mercado vuelve a su ritmo normal", "info"],
      wild: ["⚡ Sesión volátil: los precios oscilan con más fuerza", "error"],
    }[id];
    if (T) AX.toast(T[0], T[1], 2600);
  }

  /** Comisión de préstamo de los cortos: 0,05 % del valor actual por vela, en céntimos enteros. */
  function chargeFees() {
    for (const sym of Object.keys(st.shorts)) {
      const pos = st.shorts[sym];
      pos.feeDue = (pos.feeDue || 0) + SHORT_FEE * pxOf(sym) * pos.qty;
      const c = Math.floor(pos.feeDue * 100 + 1e-7) / 100;
      if (c <= 0) continue;
      pos.feeDue = Math.max(0, pos.feeDue - c);
      const fromCash = Math.min(c, Math.max(0, st.cash));
      st.cash = r2(st.cash - fromCash);
      const rest = r2(c - fromCash);
      if (rest > 0) pos.col = Math.max(0, r2(pos.col - rest)); // sin efectivo: sale de la garantía
      pos.fees = r2((pos.fees || 0) + c);
    }
  }

  /* ------------------------------------------------------------ OPERACIONES */
  /** Máximo que se puede abrir (largo o corto) con el efectivo disponible. */
  function maxOpen(s) {
    const p = px(s);
    let q = Math.floor(st.cash / p);
    while (q > 0 && r2(p * q) > st.cash + 1e-9) q--;
    return Math.max(0, q);
  }
  function tradeGate(which) {
    if (!st || settled || locked) return false;
    if (st.paused || busy) { deny(which, "Mercado en pausa. Reanúdalo para operar."); return false; }
    return true;
  }

  function buy(sym, q) {
    if (!tradeGate("buy")) return false;
    const s = stockBy(sym);
    q = Math.floor(q);
    if (!s || !(q > 0)) return deny("buy", "Cantidad inválida.");
    const p = px(s);
    const cost = r2(p * q);
    if (cost > st.cash + 1e-9) {
      const m = maxOpen(s);
      return deny("buy", m > 0 ? `Efectivo insuficiente: como mucho ${fmtQ(m, sym)}` : "No tienes efectivo suficiente ni para una unidad.");
    }
    st.cash = r2(st.cash - cost);
    const pos = st.portfolio[sym];
    if (pos) {
      pos.avg = (pos.avg * pos.qty + cost) / (pos.qty + q);
      pos.qty += q;
    } else {
      st.portfolio[sym] = { qty: q, avg: p, sl: false, tp: false };
    }
    logTrade("COMPRA", sym, q, p, null, "L", -cost);
    save();
    // efectos
    S.play("register");
    AX.haptic("success");
    const b = AX.center($("#bx-buy"));
    AX.fx.floatText(b.x, b.y - 30, `▲ +${AX.fmt(q)} ${sym}`, { color: "#2bff88", size: 22 });
    AX.fx.sparks(b.x, b.y, { colors: "green", count: 18, speed: 420 });
    AX.fx.coinsTo(b, AX.center($("#bx-posl")), { count: Math.min(10, 3 + Math.round(Math.log10(cost + 1) * 2)) });
    pulse($("#bx-posl"));
    updateLive(true);
    return true;
  }

  /** Vender en corto: bloquea como garantía el 100 % del valor a precio actual. */
  function openShort(sym, q) {
    if (!tradeGate("short")) return false;
    const s = stockBy(sym);
    q = Math.floor(q);
    if (!s || !(q > 0)) return deny("short", "Cantidad inválida.");
    const p = px(s);
    const col = r2(p * q);
    if (col > st.cash + 1e-9) {
      const m = maxOpen(s);
      return deny("short", m > 0 ? `Garantía insuficiente: como mucho ${fmtQ(m, sym)} en corto` : "No tienes efectivo para la garantía del corto.");
    }
    st.cash = r2(st.cash - col);
    const pos = st.shorts[sym];
    if (pos) {
      pos.avg = (pos.avg * pos.qty + col) / (pos.qty + q);
      pos.qty += q;
      pos.col = r2(pos.col + col);
      pos.basis = r2(pos.basis + col);
    } else {
      st.shorts[sym] = { qty: q, avg: p, col, basis: col, fees: 0, feeDue: 0, sl: false, tp: false, warn: false };
    }
    logTrade("CORTO", sym, q, p, null, "S", -col);
    save();
    // efectos: el oso
    S.play("bear");
    AX.haptic([30, 30, 60]);
    const b = AX.center($("#bx-short"));
    AX.fx.floatText(b.x, b.y - 30, `▼ −${AX.fmt(q)} ${sym}`, { color: "#ff3b5c", size: 22 });
    setTimeout(() => AX.fx.floatText(b.x + 34, b.y - 54, "🐻", { size: 34, color: "#ff3b5c", duration: 1100 }), 120);
    AX.fx.sparks(b.x, b.y, { colors: ["#ff3b5c", "#ff8095", "#fff"], count: 20, speed: 440 });
    AX.fx.flash("#ff0030", 220, 0.14);
    AX.fx.coinsTo(b, AX.center($("#bx-posl")), { count: Math.min(10, 3 + Math.round(Math.log10(col + 1) * 2)) });
    hitCard("neg");
    pulse($("#bx-posl"));
    updateLive(true);
    return true;
  }

  /** Venta de un largo. kind: VENTA | SL | TP | LIQUIDACIÓN. Devuelve {q,p,pnl,amt} o false. */
  function sell(sym, q, kind = "VENTA", quiet = false, from) {
    if (!st || settled || locked) return false;
    if (kind === "VENTA" && !tradeGate("sell")) return false;
    const pos = st.portfolio[sym];
    const s = stockBy(sym);
    if (!pos || !s) { if (!quiet) deny("sell", `No tienes ${sym} en largo.`); return false; }
    q = Math.min(Math.floor(q), pos.qty);
    if (!(q > 0)) { if (!quiet) deny("sell", "Cantidad inválida."); return false; }
    const p = px(s);
    const rev = r2(p * q);
    const pnl = r2((p - pos.avg) * q);
    st.cash = r2(st.cash + rev);
    pos.qty -= q;
    if (pos.qty <= 0) delete st.portfolio[sym];
    logTrade(kind, sym, q, p, pnl, "L", rev);
    const res = { q, p, pnl, amt: rev };
    if (quiet) return res;
    save();
    closeFx(from || $("#bx-sell"), rev, pnl);
    return res;
  }

  /** Cubrir (recomprar) un corto. kind: CUBRIR | SL | TP | MARGEN | LIQUIDACIÓN. Devuelve {q,p,pnl,amt} o false. */
  function cover(sym, q, kind = "CUBRIR", quiet = false, from) {
    if (!st || settled || locked) return false;
    if (kind === "CUBRIR" && !tradeGate("cover")) return false;
    const pos = st.shorts[sym];
    const s = stockBy(sym);
    if (!pos || !s) { if (!quiet) deny("cover", `No tienes ${sym} en corto.`); return false; }
    q = Math.min(Math.floor(q), pos.qty);
    if (!(q > 0)) { if (!quiet) deny("cover", "Cantidad inválida."); return false; }
    const p = px(s);
    const full = q === pos.qty;
    const f = q / pos.qty;
    const colPart = full ? pos.col : r2(pos.col * f);
    const basisPart = full ? pos.basis : r2(pos.basis * f);
    const feesPart = full ? pos.fees || 0 : r2((pos.fees || 0) * f);
    const credit = Math.max(0, r2(colPart + basisPart - p * q)); // garantía + P&L, nunca negativo
    const pnl = r2(credit - colPart - feesPart); // P&L neto realizado (incluye comisiones)
    st.cash = r2(st.cash + credit);
    pos.qty -= q;
    pos.col = r2(pos.col - colPart);
    pos.basis = r2(pos.basis - basisPart);
    pos.fees = r2((pos.fees || 0) - feesPart);
    if (pos.qty <= 0) delete st.shorts[sym];
    logTrade(kind, sym, q, p, pnl, "S", credit);
    const res = { q, p, pnl, amt: credit };
    if (quiet) return res;
    save();
    closeFx(from || $("#bx-cover"), credit, pnl);
    return res;
  }

  function closeFx(fromEl, amt, pnl) {
    const c = AX.center(fromEl && fromEl.getClientRects().length ? fromEl : $("#bx-posl"));
    S.play("sell");
    AX.haptic(pnl >= 0 ? "success" : "medium");
    AX.fx.floatText(c.x, c.y - 34, "+" + money(amt), { color: "#ffe680", size: 22 });
    setTimeout(() => AX.fx.floatText(c.x, c.y - 4, (pnl >= 0 ? "Beneficio " : "Pérdida ") + smoney(pnl), { color: pnl >= 0 ? "#2bff88" : "#ff3b5c", size: 17 }), 220);
    AX.fx.coinBurst(c.x, c.y, { count: pnl > 0 ? 16 : 6 });
    if (pnl > 0) AX.fx.sparks(c.x, c.y, { colors: "gold", count: 26 });
    bumpEq();
    updateLive(true);
  }
  function closePos(sym, sd, from) {
    if (sd === "S") return cover(sym, Infinity, "CUBRIR", false, from);
    return sell(sym, Infinity, "VENTA", false, from);
  }

  function logTrade(k, sym, q, p, pnl, sd, a) {
    st.history.unshift({ k, sym, q, p, pnl, t: st.tick, sd, a });
    if (st.history.length > 80) st.history.pop();
    const side = sd === "S" ? (k === "CORTO" ? "so" : "sc") : k === "COMPRA" ? "b" : "s";
    st.marks.push({ t: st.tick, sym, side });
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
      if (pos.sl && g <= SL_PCT) autoClose(sym, "L", "SL");
      else if (pos.tp && g >= TP_PCT) autoClose(sym, "L", "TP");
    }
    for (const sym of Object.keys(st.shorts)) {
      const pos = st.shorts[sym];
      const s = stockBy(sym);
      if (!s || pos.qty <= 0 || pos.avg <= 0) continue;
      const p = px(s);
      const loss = p * pos.qty - pos.basis;
      if (loss >= MARGIN_CALL * pos.col) { autoClose(sym, "S", "MARGEN"); continue; }
      if (!pos.warn && loss >= MARGIN_WARN * pos.col) {
        pos.warn = true;
        S.play("alert");
        AX.haptic("error");
        AX.toast(`⚠ Aviso de margen: tu corto en ${sym} pierde el ${Math.round((loss / pos.col) * 100)} % de la garantía. Al 90 % se cierra solo.`, "error", 3600);
      }
      const g = ((pos.avg - p) / pos.avg) * 100; // rentabilidad del corto
      if (pos.sl && g <= SL_PCT) autoClose(sym, "S", "SL");
      else if (pos.tp && g >= TP_PCT) autoClose(sym, "S", "TP");
    }
  }
  function autoClose(sym, sd, kind) {
    const res = sd === "S" ? cover(sym, Infinity, kind, true) : sell(sym, Infinity, kind, true);
    if (!res) return;
    save();
    bumpEq();
    updateLive(true);
    const sub = `${sym} ${sd === "S" ? "▼ corto" : "▲ largo"} · ${fmtQ(res.q, sym)} a ${money(res.p)} · ${smoney(res.pnl)}`;
    if (kind === "MARGEN") {
      // golpe inmediato; la cinemática completa entra en la cola
      AX.fx.flash("#ff0030", 500, 0.45);
      AX.haptic([100, 50, 100, 50, 300]);
      return queueFx(() => marginCine(sym, res, sub));
    }
    queueFx(() => {
      const c = AX.center($("#bx-posl"));
      if (kind === "SL") {
        AX.haptic("error");
        AX.fx.shake(7, 380);
        AX.fx.flash("#ff0030", 300, 0.25);
        AX.fx.burst(c.x, c.y, { colors: "blood", count: 30 });
        return AX.cine.banner(sd === "S" ? "STOP-LOSS ▼" : "STOP-LOSS", { sub, color: "rgba(255, 59, 92, 0.94)", sound: "error", duration: 1900 });
      }
      AX.haptic("win");
      S.play("sell");
      AX.fx.coinBurst(c.x, c.y, { count: 22 });
      AX.fx.stars(c.x, c.y, { count: 14 });
      return AX.cine.banner(sd === "S" ? "TAKE-PROFIT ▼" : "TAKE-PROFIT", { sub, color: "rgba(10, 163, 88, 0.94)", sound: "win", duration: 1900 });
    });
  }

  function deny(which, msg) {
    S.play("error");
    AX.haptic("error");
    AX.toast(msg, "error", 2200);
    const b = $("#bx-" + which);
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
    if (brokeShown || hasPositions()) return;
    const cheapest = Math.min(...st.stocks.map(px));
    if (st.cash >= cheapest) return;
    brokeShown = true;
    AX.modal({
      title: "Sin liquidez",
      html: `<p class="bx-lock-msg">No te queda efectivo para abrir ninguna posición.<br>Liquida para cerrar la partida y recuperar lo que queda (<b>${money(equity())}</b>).</p>`,
      buttons: [{ label: "Seguir mirando", kind: "ghost", value: false }, { label: "Liquidar", kind: "gold", value: true }],
    }).then((v) => v && cashOut());
  }

  /* ------------------------------------------------------------ CINEMÁTICAS */
  function tapeHTML() {
    const items = (st ? st.stocks : ASSETS.map((d) => ({ sym: d.sym, live: d.price || d.level, dayOpen: d.price || d.level }))).map((s) => {
      const ch = ((s.live - (s.candles && s.candles.length > 10 ? s.candles[s.candles.length - 10].c : s.dayOpen)) / s.dayOpen) * 100;
      return `<span>${INFO[s.sym].icon} ${s.sym} ${AX.fmt(s.live, 2)} ${ch >= 0 ? "▲" : "▼"} ${AX.fmt(Math.abs(ch), 2)}%</span>`;
    }).join("");
    return items + items;
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

  /** A quién afecta una noticia: etiqueta del titular y lista de activos (con signo). */
  function newsTarget(ev) {
    const e = ev.eff || {};
    const keys = Object.keys(e).filter((k) => k !== "ALL");
    if (e.ALL && keys.every((k) => DEF[k] && DEF[k].cat === "comm")) return "TODO EL MERCADO";
    const secs = keys.filter((k) => k.startsWith("S:"));
    if (secs.length === 1) return "SECTOR " + SECTORS[secs[0].slice(2)].toUpperCase();
    return keys.slice(0, 3).map((k) => (k.startsWith("S:") ? SECTORS[k.slice(2)].toUpperCase() : k)).join(" · ");
  }
  function newsImpacts(ev) {
    const e = ev.eff || {};
    let list = ASSETS.map((d) => ({ d, v: evImpact(ev, d) })).filter((x) => Math.abs(x.v) >= 0.0009);
    if (e.ALL) list = list.filter((x) => x.d.sym === "IBX" || Math.sign(x.v) !== Math.sign(e.ALL) || (DEF[x.d.sym].cat !== "stock" && x.d.sym in e));
    return list.sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 6);
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
      flashImpacts(ev);
      return new Promise((resolve) => setTimeout(() => { l.classList.add("out"); setTimeout(() => { l.remove(); resolve(); }, 400); }, 1900));
    }
    // ÚLTIMA HORA
    const pos = evTone(ev) >= 0;
    const target = newsTarget(ev);
    const imp = newsImpacts(ev);
    const tags = imp.length
      ? `<div class="bx-news-fx">${imp.map((x) => `<span class="${CFG.arrows ? (x.v > 0 ? "up" : "down") : "neu"}" style="--c:${x.d.color}">${CFG.arrows ? (x.v > 0 ? "▲" : "▼") : "⚡"} ${x.d.icon} ${x.d.sym}</span>`).join("")}</div>`
      : "";
    const l = AX.el("div", "bx-news " + (pos ? "pos" : "neg"));
    l.style.top = Math.max(0, chartRect.top - 8) + "px";
    l.innerHTML = `
      <div class="bx-news-bar"><span class="bx-news-dot"></span><span class="bx-news-tag bx-glitch" data-text="ÚLTIMA HORA">ÚLTIMA HORA</span><span class="bx-news-target">${esc(target)}</span></div>
      <div class="bx-news-head">${ev.icon} <span class="bx-type"></span><span class="bx-caret"></span>${tags}</div>`;
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
      flashImpacts(ev);
    }, 350);
    const life = Math.min(5600, 2600 + text.length * 30);
    setTimeout(() => {
      clearInterval(typer);
      l.classList.add("out");
      setTimeout(() => l.remove(), 400);
    }, life);
    return AX.sleep(1100); // la noticia sigue en pantalla, pero deja pasar al siguiente efecto
  }
  /** Ilumina los chips y pestañas de los activos afectados por una noticia (efectos cruzados incluidos). */
  function flashImpacts(ev) {
    const hits = {};
    ASSETS.forEach((d) => {
      const v = evImpact(ev, d);
      if (Math.abs(v) >= 0.0008) hits[d.sym] = v;
    });
    document.querySelectorAll(".bx-chip").forEach((c) => {
      const v = hits[c.dataset.sym];
      c.classList.remove("bx-chip-hit", "pos", "neg", "neu");
      if (v == null) return;
      void c.offsetWidth;
      c.classList.add("bx-chip-hit", CFG.arrows || ev.kind ? (v > 0 ? "pos" : "neg") : "neu");
    });
    document.querySelectorAll(".bx-cat").forEach((b) => {
      if (b.dataset.cat === curCat) return;
      if (!ASSETS.some((d) => d.cat === b.dataset.cat && hits[d.sym] != null)) return;
      b.classList.remove("bx-cat-hit");
      void b.offsetWidth;
      b.classList.add("bx-cat-hit");
    });
  }
  function hitCard(kind) {
    const card = $("#bx-chart-card");
    card.classList.remove("bx-hit-pos", "bx-hit-neg");
    void card.offsetWidth;
    card.classList.add("bx-hit-" + kind);
  }
  /** ¡LLAMADA DE MARGEN! — cierre forzoso de un corto. */
  function marginCine(sym, res, sub) {
    const l = AX.el("div", "bx-shock margin");
    const t = "¡LLAMADA DE MARGEN!";
    l.innerHTML = `<div class="bx-margin-bars"></div><div class="bx-shock-arrow">⚠</div><div class="bx-shock-t bx-glitch" data-text="${t}">${t}</div><div class="bx-shock-s">Tu corto en <b>${INFO[sym].icon} ${sym}</b> ha perdido el 90&nbsp;% de la garantía y se ha cerrado a la fuerza.<br><span class="bx-down">${esc(sub)}</span></div>`;
    document.body.appendChild(l);
    S.play("siren");
    setTimeout(() => S.play("crash"), 250);
    AX.fx.flash("#ff0030", 700, 0.6);
    AX.fx.shake(18, 800);
    const c = AX.center($("#bx-posl"));
    AX.fx.burst(c.x, c.y, { colors: "blood", count: 60, speed: 650 });
    ring(innerWidth / 2, innerHeight / 2, { color: "#ff3b5c", radius: Math.max(innerWidth, innerHeight) * 0.7, rings: 3, width: 12 });
    hitCard("neg");
    CH.shake = 1;
    return new Promise((resolve) => setTimeout(() => { l.classList.add("out"); setTimeout(() => { l.remove(); resolve(); }, 400); }, 2600));
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
    fast: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6.2v11.6a.8.8 0 0 0 1.25.66L12 13.2v4.6a.8.8 0 0 0 1.25.66l8.4-5.8a.8.8 0 0 0 0-1.32l-8.4-5.8A.8.8 0 0 0 12 6.2v4.6L4.25 5.54A.8.8 0 0 0 3 6.2z"/></svg>',
  };

  function buildDOM() {
    document.body.insertAdjacentHTML("afterbegin", '<div class="bx-bg"></div>');
    const app = AX.el("div", "bx-app");
    app.id = "bx-app";
    app.innerHTML = `
      <div class="bx-ticker"><div class="bx-ticker-label" id="bx-clock"><i></i><span>09:30</span><em id="bx-spd-tag"></em></div><div class="bx-ticker-view"><div class="bx-ticker-track" id="bx-tk"></div></div></div>
      <div class="bx-main">
        <div class="bx-cats" id="bx-cats" role="tablist" aria-label="Tipo de activo">
          ${CATS.map((c) => `<button class="bx-cat" data-cat="${c.id}" role="tab"><span>${c.label}</span><i class="bx-mk"><b class="l"></b><b class="s"></b></i></button>`).join("")}
        </div>
        <div class="bx-chips" id="bx-chips" role="tablist" aria-label="Activos"></div>
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
              <button class="bx-tg" data-tg="cmp" aria-label="Comparar con activos relacionados"><span>VS</span></button>
            </div>
          </div>
          <div class="bx-chart-wrap" id="bx-chart-wrap">
            <canvas id="bx-chart"></canvas>
            <div class="bx-paused" id="bx-paused"><div class="bx-paused-k">Mercado en pausa</div><div class="bx-paused-s" id="bx-paused-s">Las cotizaciones están congeladas.</div><button class="ax-btn ax-btn-green ax-btn-sm" id="bx-resume">${ICONS.play.replace("<svg", '<svg width="18" height="18"')} Reanudar mercado</button></div>
          </div>
        </div>
      </div>
      <div class="bx-side">
        <div class="bx-posl" id="bx-posl">
          <div class="bx-posl-h">
            <div class="bx-posl-t">Posiciones<b id="posl-n">0</b></div>
            <div class="bx-posl-st"><small>Efectivo</small><b id="posl-cash">—</b></div>
            <div class="bx-posl-st"><small>Garantía</small><b id="posl-col">—</b></div>
            <div class="bx-posl-st opl"><small>P&amp;L abierto</small><b id="posl-pl">—</b></div>
          </div>
          <div class="bx-posl-list" id="posl-list"></div>
        </div>
        <div class="bx-qty">
          <div class="bx-step"><button id="q-minus" aria-label="Menos">−</button><output id="q-out">1<small>ACC.</small></output><button id="q-plus" aria-label="Más">+</button></div>
          <div class="bx-pcts">
            <button class="bx-pct" data-p="0.25">25%</button><button class="bx-pct" data-p="0.5">50%</button><button class="bx-pct" data-p="0.75">75%</button><button class="bx-pct max" data-p="1">MAX</button>
          </div>
        </div>
        <div class="bx-trade">
          <button class="ax-btn ax-btn-green bx-open" id="bx-buy" aria-label="Comprar: abrir o ampliar posición larga"><span>▲ Comprar</span><small id="buy-sub"></small></button>
          <button class="ax-btn ax-btn-red bx-open" id="bx-short" aria-label="Vender en corto: abrir o ampliar posición corta"><span>▼ Corto</span><small id="short-sub"></small></button>
          <button class="ax-btn bx-shut long" id="bx-sell" aria-label="Vender: cerrar posición larga"><span>Vender</span><small id="sell-sub"></small></button>
          <button class="ax-btn bx-shut short" id="bx-cover" aria-label="Cubrir: cerrar posición corta"><span>Cubrir</span><small id="cover-sub"></small></button>
        </div>
        <div class="bx-nav">
          <button class="bx-pause" id="bx-pause" aria-pressed="false">${ICONS.pause}<span>Pausa</span></button>
          <button class="bx-speed" id="bx-speed" aria-label="Velocidad del mercado"><b>×1</b><span>Velocidad</span></button>
          <button id="bx-pf">${ICONS.bag}<span>Cartera</span></button>
          <button id="bx-hist">${ICONS.list}<span>Historial</span></button>
          <button class="bx-cash" id="bx-cashout">${ICONS.coin}<span>Liquidar</span></button>
        </div>
        <div class="bx-desk" id="bx-desk">
          <h3>Resumen</h3><div id="desk-pf"></div>
          <h3>Historial</h3><div id="desk-hist" class="bx-list"></div>
        </div>
      </div>`;
    document.body.appendChild(app);

    // categorías y chips
    app.querySelectorAll(".bx-cat").forEach((b) => b.addEventListener("click", () => setCat(b.dataset.cat, true)));
    $("#bx-chips").addEventListener("click", (e) => {
      const c = e.target.closest(".bx-chip");
      if (c) selectStock(c.dataset.sym);
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
        S.play("tick");
        AX.haptic("light");
        const base = pctBase(sel());
        if (base <= 0) {
          AX.toast("No te llega para ninguna unidad de " + st.selected, "error", 1800);
          return;
        }
        setQty(Math.max(1, Math.floor(base * p)), p);
      })
    );

    $("#bx-buy").addEventListener("click", () => st && buy(st.selected, qty));
    $("#bx-short").addEventListener("click", () => st && openShort(st.selected, qty));
    $("#bx-sell").addEventListener("click", () => {
      if (!st) return;
      const pos = st.portfolio[st.selected];
      if (!pos) return deny("sell", `No tienes ${st.selected} en largo.`);
      sell(st.selected, Math.min(qty, pos.qty));
    });
    $("#bx-cover").addEventListener("click", () => {
      if (!st) return;
      const pos = st.shorts[st.selected];
      if (!pos) return deny("cover", `No tienes ${st.selected} en corto.`);
      cover(st.selected, Math.min(qty, pos.qty));
    });
    $("#bx-pause").addEventListener("click", () => setPaused(!st.paused));
    $("#bx-resume").addEventListener("click", () => setPaused(false));
    $("#bx-speed").addEventListener("click", cycleSpeed);
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
    updateSpeedUI();
    renderChips();
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
  /** Base de los botones 25/50/75/MAX: lo que se puede abrir con el efectivo (o, sin efectivo, la mayor posición). */
  function pctBase(s) {
    const m = maxOpen(s);
    if (m > 0) return m;
    return Math.max(st.portfolio[s.sym] ? st.portfolio[s.sym].qty : 0, st.shorts[s.sym] ? st.shorts[s.sym].qty : 0);
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
  function cycleSpeed() {
    const i = SPEEDS.indexOf(speed());
    prefs.speed = SPEEDS[(i + 1) % SPEEDS.length];
    savePrefs();
    S.play(prefs.speed > 1 ? "powerup" : "swoosh");
    AX.haptic("light");
    updateSpeedUI();
    AX.toast(`Velocidad ×${prefs.speed} · 1 vela cada ${CANDLE_MS / 1000 / prefs.speed} s`, "info", 1600);
  }
  function updateSpeedUI() {
    const v = speed();
    const b = $("#bx-speed");
    b.querySelector("b").innerHTML = `${ICONS.fast}×${v}`;
    b.classList.toggle("fast", v > 1);
    b.setAttribute("aria-label", `Velocidad ×${v} (cambiar)`);
    $("#bx-spd-tag").textContent = v > 1 ? "×" + v : "";
  }
  function toggleOrder(sym, sd, k) {
    const pos = st && (sd === "S" ? st.shorts : st.portfolio)[sym];
    if (!pos) return;
    pos[k] = !pos[k];
    save();
    S.play(pos[k] ? "powerup" : "click");
    AX.haptic("light");
    const short = sd === "S";
    const when = k === "sl" ? (short ? "sube +" + -SL_PCT : "cae −" + -SL_PCT) : short ? "cae −" + TP_PCT : "sube +" + TP_PCT;
    AX.toast(pos[k]
      ? `${k === "sl" ? "Stop-Loss" : "Take-Profit"} ${short ? "▼" : "▲"} ${sym}: se cierra si ${when}\u00a0%`
      : `${k === "sl" ? "Stop-Loss" : "Take-Profit"} ${short ? "▼" : "▲"} ${sym} desactivado`, pos[k] ? (k === "sl" ? "error" : "success") : "info", 1900);
    updateLive(true);
    refreshSheets(true);
  }
  function selectStock(sym) {
    if (!st || st.selected === sym || !stockBy(sym)) return;
    st.selected = sym;
    S.play("tap");
    AX.haptic("light");
    CH.snap = true;
    CH.crossUntil = 0;
    if (DEF[sym].cat !== curCat) setCat(DEF[sym].cat);
    const chip = document.querySelector(`.bx-chip[data-sym="${sym}"]`);
    if (chip && chip.scrollIntoView) chip.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    if (pctSel != null) {
      const base = pctBase(sel());
      if (base > 0) qty = Math.max(1, Math.floor(base * pctSel));
      else pctSel = null;
    }
    document.querySelectorAll(".bx-pct").forEach((b) => b.classList.toggle("on", pctSel != null && +b.dataset.p === pctSel));
    updateLive(true);
  }
  function setCat(c, user) {
    if (c === curCat) return;
    curCat = c;
    if (user) {
      S.play("tap");
      AX.haptic("light");
    }
    renderChips();
    const chip = document.querySelector(`.bx-chip[data-sym="${st && st.selected}"]`);
    $("#bx-chips").scrollLeft = 0;
    if (chip && chip.scrollIntoView) chip.scrollIntoView({ inline: "center", block: "nearest" });
  }
  function renderChips() {
    const chips = $("#bx-chips");
    chips.innerHTML = "";
    ASSETS.filter((d) => d.cat === curCat).forEach((d) => {
      const c = AX.el("button", "bx-chip");
      c.dataset.sym = d.sym;
      c.setAttribute("role", "tab");
      c.setAttribute("aria-label", d.name);
      c.style.setProperty("--c", d.color);
      c.innerHTML = `<div class="bx-chip-sym"><span>${d.icon}</span>${d.sym}</div><div class="bx-chip-chg"></div><div class="bx-chip-px"></div><canvas width="80" height="36"></canvas><i class="bx-chip-own"><b class="l"></b><b class="s"></b></i>`;
      chips.appendChild(c);
    });
    document.querySelectorAll(".bx-cat").forEach((b) => {
      b.classList.toggle("on", b.dataset.cat === curCat);
      b.setAttribute("aria-selected", b.dataset.cat === curCat ? "true" : "false");
    });
    if (st) {
      chips.querySelectorAll(".bx-chip").forEach((c) => drawSpark(c.querySelector("canvas"), stockBy(c.dataset.sym)));
      updateLive();
    }
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
  let posStrip = null;
  function bumpEq() { pulse($("#bx-eq")); }
  function setText(node, t) { if (node && node.textContent !== t) node.textContent = t; }
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
    setText(qp, txt);
    setText($("#q-icon"), info.icon);
    setText($("#q-sym"), s.sym);
    setText($("#q-name"), info.name);
    const qc = $("#q-chg");
    setText(qc, `${ch >= 0 ? "▲" : "▼"} ${pct(ch)}`);
    qc.className = "bx-q-chg " + cls(ch);
    const tr = $("#q-trend");
    setText(tr, s.trendState === "bullish" ? "Alcista ↗" : s.trendState === "bearish" ? "Bajista ↘" : "Neutral");
    tr.className = "bx-badge " + (s.trendState === "bullish" ? "bull" : s.trendState === "bearish" ? "bear" : "");
    const rs = $("#q-rsi");
    setText(rs, "RSI " + Math.round(s.rsi));
    rs.className = "bx-badge " + (s.rsi >= 70 ? "bear" : s.rsi <= 30 ? "bull" : "");
    setText($("#bx-clock span"), clockOf(st.tick));
    // chips visibles: precio en directo + marcas de posición
    document.querySelectorAll(".bx-chip").forEach((c) => {
      const x = stockBy(c.dataset.sym);
      if (!x) return;
      c.classList.toggle("on", x.sym === st.selected);
      c.classList.toggle("own-l", !!st.portfolio[x.sym]);
      c.classList.toggle("own-s", !!st.shorts[x.sym]);
      c.setAttribute("aria-selected", x.sym === st.selected ? "true" : "false");
      const cp = ((x.live - x.dayOpen) / x.dayOpen) * 100;
      setText(c.querySelector(".bx-chip-px"), AX.fmt(px(x), 2) + " €");
      const ce = c.querySelector(".bx-chip-chg");
      setText(ce, (cp >= 0 ? "+" : "−") + AX.fmt(Math.abs(cp), 1) + "%");
      ce.className = "bx-chip-chg " + cls(cp);
    });
    document.querySelectorAll(".bx-cat").forEach((b) => {
      const syms = ASSETS.filter((d) => d.cat === b.dataset.cat).map((d) => d.sym);
      b.classList.toggle("own-l", syms.some((k) => st.portfolio[k]));
      b.classList.toggle("own-s", syms.some((k) => st.shorts[k]));
    });
    // patrimonio
    const eq = equity();
    eqTarget = eq;
    if (eqShown == null) eqShown = eq;
    const pnl = r2(eq - st.investment);
    const pr = (pnl / st.investment) * 100;
    const pe = $("#bx-pnl");
    setText(pe, `${pnl >= 0 ? "▲" : "▼"} ${smoney(pnl)} · ${pct(pr)}`);
    pe.className = "bx-hud-pnl " + (pnl > 0 ? "bx-up" : pnl < 0 ? "bx-down" : "");
    // posiciones abiertas
    const n = Object.keys(st.portfolio).length + Object.keys(st.shorts).length;
    setText($("#posl-n"), String(n));
    setText($("#posl-cash"), money(st.cash));
    const col = collateral();
    setText($("#posl-col"), money(col));
    $("#posl-col").className = col > 0 ? "bx-col-on" : "";
    const opl = openPL();
    const pl = $("#posl-pl");
    setText(pl, n ? smoney(opl) : "—");
    pl.className = n ? cls(opl) : "";
    if (posStrip) posStrip(force);
    updateTradePanel();
    if (force) refreshSheets();
  }

  /** Datos en directo de una posición. sd: "L" largo / "S" corto. */
  function posStats(sym, sd) {
    const p = pxOf(sym);
    if (sd === "S") {
      const pos = st.shorts[sym];
      const price = r2(pos.basis - p * pos.qty);
      const pl = r2(price - (pos.fees || 0));
      const loss = p * pos.qty - pos.basis;
      return { p, pos, pl, pp: (pl / pos.basis) * 100, g: ((pos.avg - p) / pos.avg) * 100, val: shortValue(pos, p), margin: pos.col > 0 ? Math.max(0, loss / pos.col) : 1 };
    }
    const pos = st.portfolio[sym];
    const pl = r2((p - pos.avg) * pos.qty);
    return { p, pos, pl, pp: ((p - pos.avg) / pos.avg) * 100, g: ((p - pos.avg) / pos.avg) * 100, val: p * pos.qty, margin: 0 };
  }
  function posList() {
    const a = [];
    for (const sym of Object.keys(st.portfolio)) a.push({ sym, sd: "L" });
    for (const sym of Object.keys(st.shorts)) a.push({ sym, sd: "S" });
    const selSym = st.selected;
    return a.sort((x, y) => (y.sym === selSym) - (x.sym === selSym) || ORD[x.sym] - ORD[y.sym] || (x.sd === "L" ? -1 : 1));
  }
  function posRowHTML(x, big) {
    const d = DEF[x.sym];
    const short = x.sd === "S";
    const pos = (short ? st.shorts : st.portfolio)[x.sym];
    return `<div class="bx-pr ${short ? "short" : "long"}${x.sym === st.selected ? " sel" : ""}" data-sym="${x.sym}" data-sd="${x.sd}" style="--c:${d.color}">
      <div class="bx-pr-i">
        <div class="bx-pr-t"><em>${short ? "▼ CORTO" : "▲ LARGO"}</em><b>${d.icon} ${x.sym}</b></div>
        <div class="bx-pr-s" data-f="px"></div>
      </div>
      <div class="bx-pr-v"><b data-f="pl"></b><small data-f="pp"></small></div>
      <button class="bx-pr-b sl" data-act="sl" aria-pressed="${!!pos.sl}" aria-label="Stop-loss ${short ? "corto" : "largo"} ${x.sym}">SL<small>${short ? "+" + -SL_PCT : SL_PCT}%</small></button>
      <button class="bx-pr-b tp" data-act="tp" aria-pressed="${!!pos.tp}" aria-label="Take-profit ${short ? "corto" : "largo"} ${x.sym}">TP<small>${short ? "−" + TP_PCT : "+" + TP_PCT}%</small></button>
      <button class="bx-pr-b cl" data-act="close" aria-label="Cerrar ${short ? "corto" : "largo"} ${x.sym}">Cerrar</button>
      ${big ? `<div class="bx-pr-x" data-f="x"></div>` : ""}
    </div>`;
  }
  /** Lista de posiciones (tira siempre visible y hoja "Cartera"). Devuelve render(force). */
  function mountPositions(root, big) {
    let sig = null;
    root.addEventListener("click", (e) => {
      if (!st) return;
      const row = e.target.closest(".bx-pr");
      if (!row) return;
      const b = e.target.closest("[data-act]");
      const sym = row.dataset.sym, sd = row.dataset.sd;
      if (b) {
        if (b.dataset.act === "close") closePos(sym, sd, b);
        else toggleOrder(sym, sd, b.dataset.act);
      } else selectStock(sym);
      render(true);
    });
    const moreHint = () => {
      const left = root.scrollHeight - root.clientHeight - root.scrollTop;
      root.classList.toggle("bx-more", left > 6);
    };
    root.addEventListener("scroll", moreHint, { passive: true });
    function render(force) {
      if (!st) return;
      const list = posList();
      const s2 = list.map((x) => {
        const pos = (x.sd === "S" ? st.shorts : st.portfolio)[x.sym];
        return x.sym + x.sd + pos.qty + pos.sl + pos.tp;
      }).join("|") + "#" + st.selected;
      if (force || s2 !== sig) {
        sig = s2;
        root.innerHTML = list.length
          ? list.map((x) => posRowHTML(x, big)).join("")
          : `<div class="bx-posl-empty">Sin posiciones abiertas.<br><b class="bx-up">▲ Comprar</b> si crees que subirá · <b class="bx-down">▼ Corto</b> si crees que bajará</div>`;
        moreHint();
      }
      root.querySelectorAll(".bx-pr").forEach((row) => {
        const sym = row.dataset.sym, sd = row.dataset.sd;
        if (!(sd === "S" ? st.shorts : st.portfolio)[sym]) return;
        const k = posStats(sym, sd);
        const f = (n) => row.querySelector(`[data-f="${n}"]`);
        setText(f("px"), `${AX.fmt(k.pos.qty)} · ${AX.fmt(k.pos.avg, 2)} → ${AX.fmt(k.p, 2)}`);
        const plE = f("pl");
        setText(plE, smoney(k.pl));
        plE.className = cls(k.pl);
        const ppE = f("pp");
        setText(ppE, pct1(k.pp));
        ppE.className = cls(k.pl);
        row.classList.toggle("warn", k.margin >= MARGIN_WARN);
        const xE = f("x");
        if (xE) {
          setText(xE, sd === "S"
            ? `Garantía ${money(k.pos.col)} · comisión pagada ${money(k.pos.fees || 0)} · margen usado ${Math.round(k.margin * 100)} % (cierre al ${MARGIN_CALL * 100} %)`
            : `Valor ${money(k.val)} · coste ${money(k.pos.avg * k.pos.qty)}`);
        }
      });
    }
    render(true);
    return render;
  }

  function updateTradePanel() {
    if (!st) return;
    const s = sel();
    const p = px(s);
    $("#q-out").innerHTML = `${AX.fmt(qty)}<small>${unitOf(s.sym)}</small>`;
    const lp = st.portfolio[s.sym], sp = st.shorts[s.sym];
    const mo = maxOpen(s);
    setText($("#buy-sub"), `×${AX.fmt(qty)} · ${money(p * qty)}`);
    setText($("#short-sub"), `×${AX.fmt(qty)} · garantía ${money(p * qty)}`);
    $("#bx-buy").classList.toggle("bx-dim", qty > mo);
    $("#bx-short").classList.toggle("bx-dim", qty > mo);
    if (lp) {
      const q = Math.min(qty, lp.qty);
      setText($("#sell-sub"), `×${AX.fmt(q)} de ${AX.fmt(lp.qty)} · ${money(p * q)}`);
    } else setText($("#sell-sub"), "Sin largo abierto");
    if (sp) {
      const q = Math.min(qty, sp.qty);
      const pl = (sp.avg - p) * q;
      setText($("#cover-sub"), `×${AX.fmt(q)} de ${AX.fmt(sp.qty)} · ${smoney(pl)}`);
    } else setText($("#cover-sub"), "Sin corto abierto");
    const dis = !!(st.paused || busy || settled || locked);
    $("#bx-buy").disabled = dis;
    $("#bx-short").disabled = dis;
    $("#bx-sell").disabled = dis || !lp;
    $("#bx-cover").disabled = dis || !sp;
  }

  /* chips: cierre de vela (flash + minigráfico) */
  function chipsCandle() {
    document.querySelectorAll(".bx-chip").forEach((c) => {
      const s = stockBy(c.dataset.sym);
      if (!s) return;
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
    if (!cv || !s) return;
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
      `<span class="bx-tk-n ${evTone(ev) < 0 ? "neg" : ""}"><b>${ev.kind ? (ev.kind === "crash" ? "CRASH" : "RALLY") : "ÚLTIMA HORA"}</b>${ev.icon} ${esc(ev.message)}</span>`
    );
    if (!news.length) news.push(`<span class="bx-tk-n"><b>MERCADO</b>Los mercados operan con normalidad. Atento a las noticias…</span>`);
    const html = items.slice(0, 4).join("") + news[0] + items.slice(4, 10).join("") + (news[1] || "") + items.slice(10).join("");
    const track = $("#bx-tk");
    const view = track.parentElement.clientWidth || 360;
    track.innerHTML = `<div class="bx-tk-seg">${html}</div>`;
    const seg = track.firstChild;
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

    // precio mostrado (suavizado entre sub-pasos)
    if (CH.snap || CH.disp == null) CH.disp = s.live;
    CH.disp += (s.live - CH.disp) * Math.min(1, dt * 8);
    const live = { o: s.open, h: Math.max(s.hi, CH.disp), l: Math.min(s.lo, CH.disp), c: CH.disp, t: st.tick, m5: null, m15: null, r: s.rsi, live: true };
    const all = vis.concat([live]);
    const n = all.length;
    CH.slide = CH.slide > 0.05 ? CH.slide * Math.pow(0.004, dt) : 0;
    const X = (i) => plotR - 16 - (n - 1 - i) * spacing + CH.slide;

    // comparación con activos relacionados (normalizada al primer cierre visible)
    let cmpSeries = [];
    if (prefs.cmp) {
      const base = all[0].c;
      cmpSeries = (DEF[s.sym].peers || []).map(stockBy).filter(Boolean).map((o) => {
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
    // líneas de entrada (verde largo / rojo corto) y niveles SL / TP
    const lines = [];
    const lp = st.portfolio[s.sym], sp = st.shorts[s.sym];
    if (lp) {
      lines.push({ v: lp.avg, label: "▲ LARGO " + AX.fmt(lp.avg, 2), color: UP, dash: [6, 4] });
      if (lp.sl) lines.push({ v: lp.avg * (1 + SL_PCT / 100), label: "▲ SL", color: DOWN, dash: [2, 4] });
      if (lp.tp) lines.push({ v: lp.avg * (1 + TP_PCT / 100), label: "▲ TP", color: UP, dash: [2, 4] });
    }
    if (sp) {
      lines.push({ v: sp.avg, label: "▼ CORTO " + AX.fmt(sp.avg, 2), color: DOWN, dash: [6, 4] });
      if (sp.sl) lines.push({ v: sp.avg * (1 - SL_PCT / 100), label: "▼ SL", color: DOWN, dash: [2, 4] });
      if (sp.tp) lines.push({ v: sp.avg * (1 - TP_PCT / 100), label: "▼ TP", color: UP, dash: [2, 4] });
    }
    for (const l of lines) { lo = Math.min(lo, l.v); hi = Math.max(hi, l.v); }
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
      cx.fillText(AX.fmt(v, stepV < 1 ? 2 : 1), plotR + 6, y);
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

    // noticias en el eje temporal (también las que afectan de rebote: sector, petróleo, mercado)
    for (const nw of st.news) {
      const ev = EV_BY_NAME[nw.name];
      if (!ev || Math.abs(evImpact(ev, DEF[s.sym])) < 0.0005) continue;
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

    // marcas de operaciones y señales
    const marks = st.marks.filter((m) => m.sym === s.sym);
    for (let i = 0; i < n; i++) {
      const c = all[i];
      const x = X(i);
      if (x < 0) continue;
      let below = 0, above = 0;
      for (const m of marks) {
        if (m.t !== c.t) continue;
        const isBelow = m.side === "b" || m.side === "sc";
        const col = m.side === "b" || m.side === "sc" ? UP : DOWN;
        const ring2 = m.side === "so" || m.side === "sc";
        cx.save();
        cx.fillStyle = col;
        cx.shadowColor = col;
        cx.shadowBlur = 8;
        cx.beginPath();
        if (isBelow) {
          const y = Y(c.l) + 7 + below * 11;
          below++;
          cx.moveTo(x, y); cx.lineTo(x - 5, y + 8); cx.lineTo(x + 5, y + 8);
        } else {
          const y = Y(c.h) - 7 - above * 11;
          above++;
          cx.moveTo(x, y); cx.lineTo(x - 5, y - 8); cx.lineTo(x + 5, y - 8);
        }
        cx.closePath();
        if (ring2) {
          // cortos: triángulo hueco con contorno (oso)
          cx.lineWidth = 2;
          cx.strokeStyle = col;
          cx.fillStyle = "rgba(10,8,24,0.9)";
          cx.fill();
          cx.stroke();
        } else cx.fill();
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

    // líneas de entrada / SL / TP
    cx.save();
    let lastLabelY = -Infinity;
    lines.map((l) => Object.assign({ y: Math.round(Y(l.v)) + 0.5 }, l)).sort((a, b) => a.y - b.y).forEach((l) => {
      cx.setLineDash(l.dash);
      cx.strokeStyle = l.color;
      cx.globalAlpha = 0.9;
      cx.lineWidth = l.dash[0] > 3 ? 1.4 : 1.2;
      cx.beginPath(); cx.moveTo(0, l.y); cx.lineTo(plotR, l.y); cx.stroke();
      cx.setLineDash([]);
      cx.globalAlpha = 1;
      cx.font = "900 9px Outfit, system-ui, sans-serif";
      const lw = cx.measureText(l.label).width + 10;
      const ly = Math.max(l.y, lastLabelY + 15);
      lastLabelY = ly;
      rr(cx, 6, ly - 7, lw, 14, 4);
      cx.fillStyle = l.color;
      cx.fill();
      cx.fillStyle = l.color === UP ? "#00321a" : "#fff";
      cx.textAlign = "center";
      cx.textBaseline = "middle";
      cx.fillText(l.label, 6 + lw / 2, ly + 0.5);
    });
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
    const prog = Math.min(1, (st.step + (running() ? (acc + Math.min(STEP_MS, (now - lastTickAt) * speed())) / STEP_MS : 0)) / STEPS);
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

  /* ------------------------------------------------------------ ANIMACIÓN Y RELOJ */
  let lastFrame = performance.now();
  let lastTickAt = performance.now();
  let acc = 0; // ms de mercado acumulados hacia el siguiente sub-paso
  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (!document.hidden) {
      // cinta
      if (TK.half > 1) {
        TK.x -= (running() ? 40 : 18) * dt;
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
  // reloj del mercado: 1 vela = CANDLE_MS / velocidad
  setInterval(() => {
    const now = performance.now();
    const el = Math.min(500, now - lastTickAt);
    lastTickAt = now;
    if (!running()) return;
    acc += el * speed();
    let n = 0;
    while (acc >= STEP_MS && n < 8 && running()) {
      acc -= STEP_MS;
      step();
      n++;
    }
    if (acc >= STEP_MS) acc = 0;
  }, 40);
  // latido: mantiene viva la marca de tiempo aunque el mercado esté en pausa
  setInterval(() => {
    if (st && !settled && !locked && !st.parked && !busy && !document.hidden) save();
  }, 2000);

  /* ------------------------------------------------------------ HOJAS: CARTERA / HISTORIAL */
  let histDirty = true;
  const openSheets = new Set();
  function summaryHTML() {
    return `<div class="bx-sum">
      <div class="wide"><small>Valor de la cartera</small><b data-v="eq"></b></div>
      <div><small>Inversión</small><b>${money(st.investment)}</b></div>
      <div><small>Resultado</small><b data-v="pnl"></b></div>
      <div><small>Efectivo libre</small><b data-v="cash"></b></div>
      <div><small>En largos ▲</small><b data-v="long"></b></div>
      <div><small>Garantía cortos ▼</small><b data-v="col"></b></div>
      <div><small>P&amp;L abierto</small><b data-v="opl"></b></div>
    </div>`;
  }
  function summaryValues(root) {
    const set = (k, v, c) => {
      const e = root.querySelector(`[data-v="${k}"]`);
      if (e) { setText(e, v); if (c != null) e.className = c; }
    };
    const eq = equity(), pnl = r2(eq - st.investment), opl = openPL();
    set("eq", money(eq));
    set("pnl", smoney(pnl), cls(pnl));
    set("cash", money(st.cash));
    set("long", money(longsValue()));
    set("col", money(collateral()));
    set("opl", smoney(opl), cls(opl));
  }
  function mountPortfolio(root, desk) {
    root.innerHTML = summaryHTML() + (desk ? "" : `<p class="bx-sheet-note">Largos ▲ ganan si el precio sube; cortos ▼ ganan si baja. Garantía del corto: 100&nbsp;% del valor a la entrada · comisión de préstamo ${AX.fmt(SHORT_FEE * 100, 2)}&nbsp;% por vela · cierre forzoso si la pérdida llega al ${MARGIN_CALL * 100}&nbsp;% de la garantía.</p><div class="bx-list bx-pf-list"></div>`);
    const list = desk ? null : mountPositions(root.querySelector(".bx-pf-list"), true);
    const render = (force) => {
      if (!st) return;
      summaryValues(root);
      if (list) list(force);
    };
    render(true);
    return render;
  }
  function historyHTML() {
    if (!st.history.length) return `<div class="bx-empty">Aún no hay operaciones.</div>`;
    const K = { COMPRA: "buy", VENTA: "sell", SL: "sl", TP: "tp", "LIQUIDACIÓN": "liq", CORTO: "short", CUBRIR: "cover", MARGEN: "margin" };
    const L = { COMPRA: "COMPRA ▲", VENTA: "VENTA", SL: "STOP-LOSS", TP: "TAKE-PROFIT", "LIQUIDACIÓN": "LIQUIDACIÓN", CORTO: "CORTO ▼", CUBRIR: "CUBRIR", MARGEN: "MARGEN ⚠" };
    return st.history.map((t) => {
      const short = t.sd === "S";
      const a = t.a != null ? t.a : t.k === "COMPRA" ? -t.p * t.q : t.p * t.q;
      const lbl = (L[t.k] || t.k) + (short && (t.k === "SL" || t.k === "TP" || t.k === "LIQUIDACIÓN") ? " ▼" : "");
      const note = t.k === "CORTO" ? " · garantía" : short && t.k !== "CORTO" ? " · cierre corto" : "";
      return `<div class="bx-h">
        <span class="bx-h-k ${K[t.k] || "sell"}">${lbl}</span>
        <div class="bx-h-m">${INFO[t.sym] ? INFO[t.sym].icon : ""} ${t.sym} ×${AX.fmt(t.q)}<small>${clockOf(t.t)} · a ${money(t.p)}${note}</small></div>
        <div class="bx-h-v">${a < 0 ? "−" : "+"}${money(Math.abs(a))}${t.pnl != null ? `<small class="${cls(t.pnl)}">${smoney(t.pnl)}</small>` : ""}</div>
      </div>`;
    }).join("");
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
      </div><p style="margin:10px 0 0;text-align:center;font-size:13px;color:var(--ax-muted)">Se cierran todas tus posiciones (largos y cortos) al precio actual y el dinero vuelve a tu saldo.</p>`,
      buttons: [{ label: "Seguir operando", kind: "ghost", value: false }, { label: "Liquidar", kind: "gold", value: true }],
    });
    if (v) await cashOut();
  }

  async function cashOut() {
    if (!st || settled || locked) return;
    if (!owns()) { lockOut("other"); return; }
    busy = true;
    document.querySelectorAll(".bx-news, .bx-shock, .bx-mile").forEach((n) => n.remove());
    // cerrar todo al precio actual
    const rows = [];
    for (const sym of Object.keys(st.portfolio)) {
      const r = sell(sym, st.portfolio[sym].qty, "LIQUIDACIÓN", true);
      if (r) rows.push({ sym, sd: "L", q: r.q, v: r.amt, pnl: r.pnl });
    }
    for (const sym of Object.keys(st.shorts)) {
      const r = cover(sym, st.shorts[sym].qty, "LIQUIDACIÓN", true);
      if (r) rows.push({ sym, sd: "S", q: r.q, v: r.amt, pnl: r.pnl });
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
      const rows = sm.rows.map((r, i) => `<div class="bx-liq-row" style="animation-delay:${0.15 + i * 0.12}s"><span>${r.sd === "S" ? '<em class="bx-down">▼</em>' : '<em class="bx-up">▲</em>'} ${INFO[r.sym].icon} ${r.sym} ×${AX.fmt(r.q)}</span><span>${money(r.v)} <span class="${cls(r.pnl)}">${smoney(r.pnl)}</span></span></div>`).join("");
      l.innerHTML = `<div class="bx-liq-k">Campana de cierre · liquidación</div><div class="bx-liq-v"><span id="liq-v">0</span> €</div><div class="bx-liq-rows">${rows || `<div class="bx-liq-row"><span>Sin posiciones abiertas</span><span>—</span></div>`}<div class="bx-liq-row" style="animation-delay:${0.2 + sm.rows.length * 0.12}s"><span>Efectivo final</span><span>${money(sm.V)}</span></div></div>`;
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
      setTimeout(fin, 2200 + Math.min(10, sm.rows.length) * 120);
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
        <div><small>Mejor operación</small><b class="${sm.best ? cls(sm.best.pnl) : ""}">${sm.best ? sm.best.sym + " " + smoney(sm.best.pnl) : "—"}</b></div>
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
    const pOf = (sym) => {
      const s = o.stocks.find((x) => x.sym === sym);
      return s ? Math.max(0.01, r2(s.live)) : null;
    };
    let V = o.cash;
    for (const sym of Object.keys(o.portfolio || {})) {
      const p = pOf(sym);
      if (p != null) V += o.portfolio[sym].qty * p;
    }
    for (const sym of Object.keys(o.shorts || {})) {
      const pos = o.shorts[sym];
      const p = pOf(sym);
      V += p != null ? shortValue(pos, p) : pos.col || 0;
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
    acc = 0;
    curCat = "";
    setCat(DEF[st.selected] ? DEF[st.selected].cat : "stock");
    if (!posStrip) posStrip = mountPositions($("#posl-list"), false);
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
        <p style="margin:0;text-align:center;font-size:13px;color:var(--ax-muted)"><b style="color:#fff">Guardar y salir</b>: tu cartera se congela y su valor vuelve a tu saldo mientras no juegas; al volver se recupera tal cual.<br><b style="color:#fff">Liquidar</b>: cierras todas las posiciones y la sesión.</p>`,
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
    // compatibilidad: asegura campos y migra partidas del motor anterior
    st.stats = st.stats || { trades: 0, best: null, worst: null, peak: st.investment, low: st.investment, realized: 0 };
    st.marks = st.marks || [];
    st.news = st.news || [];
    st.milestones = st.milestones || [];
    st.history = st.history || [];
    st.portfolio = st.portfolio || {};
    st.shorts = st.shorts || {};
    try {
      migrate();
    } catch (e) {
      console.error(e);
    }
    st.stocks.forEach((s) => { if (!s.path || s.path.length !== STEPS + 1) { if (isIdx(s.sym)) planIndex(s); else planAll([s], false); } });
    if (!save(true)) return;
    openMarket(false, true);
  }

  /* ------------------------------------------------------------ DEPURACIÓN (solo pruebas automáticas) */
  if (ssGet("bx_debug") === "1") {
    window.__bx = {
      get st() { return st; },
      get running() { return !!running(); },
      equity, maxOpen: (sym) => maxOpen(stockBy(sym)), openPL, collateral,
      setPrice(sym, p) {
        const s = stockBy(sym);
        for (let k = st.step; k <= STEPS; k++) s.path[k] = p;
        s.live = p;
        s.hi = Math.max(s.hi, p);
        s.lo = Math.min(s.lo, p);
        updateLive(true);
      },
      step: (n = 1) => { for (let i = 0; i < n; i++) step(); },
      buy, sell, openShort, cover, closePos, toggleOrder, selectStock, setCat, cashOut,
      forceEvent(name) {
        const ev = EV_BY_NAME[name];
        if (!ev) return false;
        st.events.push({ name, rem: ev.duration, fresh: true });
        st.news.unshift({ t: st.tick, name });
        queueFx(() => showEvent(ev));
        return true;
      },
      consts: { CANDLE_MS, STEPS, STEP_MS, SHORT_FEE, MARGIN_CALL, EVENT_P, SHOCK_P },
    };
  }

  AX.ready(boot);
})();
