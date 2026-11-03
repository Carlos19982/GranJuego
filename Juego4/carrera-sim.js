/* =========================================================================
   GRAN PREMIO NEÓN · carrera-sim.js
   Simulación de carrera determinista (semilla) + mercado de apuestas justo.

   - El resultado EMERGE de la simulación: nadie elige ganador.
   - Las cuotas salen de un Monte Carlo del MISMO modelo (misma clase Core y
     mismo paso fijo TUNING.simDt): la carrera en pantalla es una muestra más
     de la distribución con la que se calcularon las cuotas.
   - rtp = 1 → sin margen de la casa (solo el redondeo al paso más cercano).

   API
     makeRng(seed) → () => [0,1)
     buildTrack({ length, k, step, speedScale })      pista (k con signo, 1/m)
     rollConditions(rng) → { weather, label, desc, gripMul, speedMul, ... }
     rollForm(rng, cars, history) → [1..5] por coche (history[i] = posiciones, la más antigua primero)
     createMarket({ cars, track, laps, grid, gridOffsets, cond, form, sims, rtp, onProgress, seed })
        → Promise<{ pWin, pPodium, oddsWin, oddsPodium, rtpWin, rtpPodium, bookWin, ... }>
     computeMarket(mismo objeto) → igual, síncrono (Web Worker / tests)
     createRace({ cars, track, laps, grid, gridOffsets, cond, form, seed }) → race
        race.step(dt)  ·  race.cars[i]  ·  race.events  ·  race.order  ·  race.done
        race.t  ·  race.leaderGap(i)  ·  race.results  ·  race.finishOrder
     simulateRace(opts, seed) → { order, times }   (sin pantalla; mismo resultado que createRace)
     analyzeTrack(track, cars, cond) → vuelta ideal de cada coche en solitario

   Convenciones
   - Unidades: metros y segundos. `speedScale` (en buildTrack) es una pura
     compresión de tiempo aplicada por Race: velocidades ×s, tiempos ÷s.
     La física interna y por tanto las probabilidades NO cambian con s.
   - k > 0 = la pista gira hacia +lateral (izquierda). lateral ∈ [-1, 1].
   - dist = metros recorridos desde la línea de salida/meta (negativo en
     parrilla). Meta en dist = laps · length.
   - t = 0 es el apagado de semáforos.
   ========================================================================= */

const G0 = 9.81;
export let DBG = null; export function setDebug(o) { DBG = o; }

/* --------------------------------------------------------------- AJUSTES */
export const TUNING = {
  simDt: 0.1,           // paso fijo interno (s). La carrera en pantalla y el Monte Carlo usan EL MISMO (Race interpola para pintar).
  // Prestaciones (a speedScale 1). r = (stat - 80) / 100
  vTop0: 90,            // velocidad punta base (m/s)
  kSpd: 0.12,           // punta: +1.2 % por cada 10 pts de "spd"
  mu0: 5.0,             // agarre lateral arcade (× g)
  kGrip: 0.15,          // agarre: +1.5 % por cada 10 pts de "grip" (curva ≈ +0.75 % velocidad)
  brakeK: 0.80,         // deceleración de frenada = brakeK · mu · g
  power0: 1050,         // potencia específica P (m²/s³): a = P / v
  kAcc: 0.30,           // potencia: +3 % por cada 10 pts de "acc"
  trac0: 17,            // aceleración máxima limitada por tracción (m/s²)
  // Pista
  kSmoothM: 12,         // suavizado de curvatura (± m)
  lineFactor: 0.78,     // la trazada abre las curvas: k efectiva = |k| · lineFactor
  // Tráfico
  carLen: 5,            // m
  gapMin: 6.5,          // distancia mínima morro-morro siguiendo a otro coche (m)
  followTau: 0.45,      // s: cuánto se permite cerrar el hueco
  laneW: 0.42,          // separación lateral mínima entre coches (unidades de lateral)
  latMax: 0.9,          // |lateral| máximo del centro del coche
  latOmega: 3.0,        // rigidez del movimiento lateral (1/s)
  latRateStraight: 0.9, // velocidad lateral máx. en recta (u/s)
  latRateCorner: 0.35,  // ídem en curva
  latPush: 1.5,         // u/s: separación de emergencia si dos coches se solapan
  draft: 0.08,          // rebufo (arcade): hasta +8 % de punta pegado, se diluye linealmente hasta draftMax
  draftMin: 0.0, draftMax: 2.0, // s detrás
  dirtyMargin: 0.6,     // m/s: en curva, el que va detrás (<0.8 s, mismo carril) no puede ir más rápido que esto sobre el de delante
  dirtyPen: 0.0,        // aire sucio extra: pérdida de velocidad en curva pegado al de delante
  offLinePen: 0.03,     // pérdida de velocidad en curva por ir por fuera de la trazada
  offLineIn: 0.3,       // fracción de esa pérdida si se va por dentro
  // Adelantamientos
  passCost: 1.5,        // presión media (m/s · s de ventaja de ritmo) para consumar un adelantamiento
  pressGap: 0.7,        // s: hay que ir a menos de esto del de delante para presionar
  pressDecay: 4,        // s: la presión se disipa si se pierde el contacto
  yieldDecel: 5,        // m/s²: el adelantado levanta así mientras el otro le supera
  passRange: 20,        // m: distancia máxima (morro-morro) para iniciar un adelantamiento
  passMargin: 2.0,      // m/s de ventaja instantánea para intentarlo sin presión previa (p. ej. tras un error)
  passInCorner: false,  // permitir iniciar adelantamientos dentro de una curva
  passRoom: 12,         // m: hueco libre (±) que exige el lado elegido
  passTimeout: 8,       // s: abandona el intento si no lo culmina
  passFree: 0.22,       // desplazamiento lateral a partir del cual el que adelanta ya no va "detrás"
  passLane: 0.5,        // carril (±) por el que se adelanta; el adelantado se aparta al contrario
  passInsideBias: 0.6,  // preferencia por el interior de la siguiente curva
  finalAttack: 400,     // m: en los últimos metros todo el que va pegado sale de la estela a por la meta
  // Aleatoriedad (todo sale de la semilla)
  lapSigma: 0.005,      // ritmo por vuelta (σ relativo)
  daySigma: 0.009,      // ritmo del día (σ relativo)
  formPace: 0.004,      // ±0.4 % de ritmo por punto de forma (forma 1..5, 3 = neutra → ±0.8 %)
  reactMin: 0.15, reactMax: 0.35, // reacción al semáforo (s, uniforme)
  launchBase: 0.90, launchAccK: 0.4, launchSigma: 0.06, // calidad de salida (multiplica la tracción ~3 s)
  errBase: 0.009,       // prob. de error por curva de riesgo 1 (seco); la horquilla ≈ 1.5, las rápidas 0.2
  errGripK: 2.5,        // más agarre → menos errores
  errPressure: 1.4,     // ×prob si va presionado (<1 s del de delante)
  errLossMin: 0.2, errLossMax: 0.8, // s perdidos (aprox.)
  errSeverity: 0.75,
  // Parrilla por defecto: dist = -8 - 6.5·puesto, lateral -0.38 / +0.38 alternando (pole a -0.38)
  gridFront: 8, gridGap: 6.5, gridLat: 0.38,
  // Después de la meta
  coolDown: 0.6,        // ritmo de la vuelta de enfriamiento
  photoGap: 0.05,       // s: evento 'photo' si 1º-2º < esto
};

export const CONDITIONS = {
  seco: {
    weather: 'seco', label: 'Seco', desc: 'Asfalto seco: manda la velocidad punta.',
    gripMul: 1.0, speedMul: 1.0, gripSens: 1.0, spdSens: 1.0, accSens: 1.0,
    errMul: 1.0, varMul: 1.0, draftMul: 1.0, launchMul: 1.0,
  },
  humedo: {
    weather: 'humedo', label: 'Pista mojada', desc: 'Menos agarre para todos: premia a los coches con buen agarre.',
    gripMul: 0.80, speedMul: 0.975, gripSens: 1.35, spdSens: 0.8, accSens: 0.7,
    errMul: 2.3, varMul: 1.3, draftMul: 0.8, launchMul: 1.6,
  },
  viento: {
    weather: 'viento', label: 'Viento', desc: 'Rachas en las rectas: punta irregular y más imprevisible.',
    gripMul: 0.98, speedMul: 0.985, gripSens: 1.1, spdSens: 0.6, accSens: 1.1,
    errMul: 1.3, varMul: 1.7, draftMul: 0.7, launchMul: 1.0,
  },
};

/* ------------------------------------------------------------------- RNG */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// mulberry32 sin cierre (estado en Uint32Array) para el bucle caliente
function mbNext(st, i) {
  const a = (st[i] = (st[i] + 0x6d2b79f5) | 0);
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function fmix(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
export function hashSeed(a, b = 0) {
  const ha = fmix((a ^ 0x9e3779b9) >>> 0);
  return fmix((ha ^ fmix((Math.imul(b | 0, 0x27d4eb2f) + 0x165667b1) >>> 0)) + 0x632be5ab >>> 0);
}
function gauss(r) {
  let u = r();
  if (u < 1e-12) u = 1e-12;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307179586 * r());
}
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/* ----------------------------------------------------------------- PISTA */
function cyclicSmooth(src, w) {
  const N = src.length, out = new Float32Array(N);
  if (w < 1) { out.set(src); return out; }
  let acc = 0;
  for (let j = -w; j <= w; j++) acc += src[((j % N) + N) % N];
  const inv = 1 / (2 * w + 1);
  for (let i = 0; i < N; i++) {
    out[i] = acc * inv;
    acc += src[(i + w + 1) % N] - src[(((i - w) % N) + N) % N];
  }
  return out;
}

/**
 * buildTrack({ length, k, step, speedScale })
 * k: Float32Array con la curvatura con signo (1/m) cada `step` m desde la meta.
 */
export function buildTrack({ length, k, step, speedScale = 1 } = {}) {
  const N = k.length;
  if (!step) step = length / N;
  if (!length) length = N * step;
  const s = speedScale;
  const ks = cyclicSmooth(k, Math.round(TUNING.kSmoothM / step));
  const kEff = new Float32Array(N);
  for (let i = 0; i < N; i++) kEff[i] = Math.abs(ks[i]) * TUNING.lineFactor;

  // Trazada ideal: exterior antes de la curva, vértice interior, exterior a la salida.
  const kw = cyclicSmooth(ks, Math.round(22 / step));
  const D = Math.round(55 / step);
  const raw = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const v = kw[i] - 0.5 * kw[(i + D) % N] - 0.5 * kw[(i - D + N) % N];
    raw[i] = clamp(v * 85, -0.62, 0.62);
  }
  const line = cyclicSmooth(raw, Math.round(18 / step));

  // Umbrales (invariantes con speedScale)
  const refG = TUNING.mu0 * G0;
  const cornerK = refG / (0.95 * TUNING.vTop0) ** 2;   // por encima limita la velocidad
  const straightK = cornerK * 0.5;

  // Curvas: tramos con kEff > cornerK
  const isC = (i) => kEff[i] > cornerK;
  let i0 = 0;
  while (i0 < N && isC(i0)) i0++;
  const corners = [];
  if (i0 < N) {
    let i = 0;
    while (i < N) {
      const a = (i0 + i) % N;
      if (isC(a)) {
        let j = i, kMax = 0, apex = a;
        while (j < N && isC((i0 + j) % N)) {
          const b = (i0 + j) % N;
          if (kEff[b] > kMax) { kMax = kEff[b]; apex = b; }
          j++;
        }
        const len = (j - i) * step;
        if (len >= 8) {
          corners.push({
            start: a * step, end: ((i0 + j) % N) * step, apex: apex * step, length: len,
            dir: ks[apex] >= 0 ? 1 : -1, kMax: kMax / TUNING.lineFactor,
            vRef: Math.sqrt(refG / kMax) * s, // m/s del coche de referencia (ya escalado)
            // riesgo de error: las curvas lentas castigan más (0.2 rápida … 1.5 horquilla)
            risk: clamp((1 - Math.sqrt(refG / kMax) / TUNING.vTop0) * 2.5, 0.2, 1.5),
          });
        }
        i = j;
      } else i++;
    }
    corners.sort((p, q) => p.start - q.start);
  }
  const sectors = [];
  for (let c = 0; c < corners.length; c++) {
    const cur = corners[c], nxt = corners[(c + 1) % corners.length];
    sectors.push({ type: 'curva', start: cur.start, end: cur.end, length: cur.length, dir: cur.dir, kMax: cur.kMax, corner: c });
    let sl = nxt.start - cur.end;
    if (sl <= 0) sl += length;
    if (corners.length === 1) sl = length - cur.length;
    sectors.push({ type: 'recta', start: cur.end, end: nxt.start, length: sl });
  }
  // recta más larga
  let longest = null;
  for (const sc of sectors) if (sc.type === 'recta' && (!longest || sc.length > longest.length)) longest = sc;

  return {
    length, step, N, k, kSmooth: ks, kEff, line, corners, sectors, longestStraight: longest,
    speedScale: s, cornerK, straightK, _prof: new Map(),
  };
}

function carProfile(track, cornerG, brakeD) {
  const key = cornerG.toFixed(5) + '|' + brakeD.toFixed(5);
  let p = track._prof.get(key);
  if (p) return p;
  const { N, kEff, step } = track;
  p = new Float32Array(N);
  const vcap = TUNING.vTop0 * 1.6;
  for (let i = 0; i < N; i++) p[i] = Math.min(vcap, Math.sqrt(cornerG / Math.max(kEff[i], 1e-7)));
  const b2 = 2 * brakeD * step;
  for (let it = 0; it < 2; it++) {
    for (let i = N - 1; i >= 0; i--) {
      const j = i + 1 === N ? 0 : i + 1;
      const lim = Math.sqrt(p[j] * p[j] + b2);
      if (p[i] > lim) p[i] = lim;
    }
  }
  track._prof.set(key, p);
  return p;
}

/** Velocidad de vuelta ideal en solitario (perfil de frenada + pasada hacia delante con aceleración). */
function idealProfile(track, prof, vTop, P, aTrac) {
  const key = 'i' + prof.length + '|' + vTop.toFixed(4) + '|' + P.toFixed(3) + '|' + aTrac.toFixed(4) + '|' + prof[0] + '|' + prof[prof.length >> 1];
  let o = track._prof.get(key);
  if (o) return o;
  const { N, step } = track;
  o = new Float32Array(N);
  const iv3 = 1 / (vTop * vTop * vTop);
  let vc = Math.min(prof[0], vTop);
  for (let it = 0; it < 2; it++) {
    for (let i = 0; i < N; i++) {
      let a = P / (vc > 2 ? vc : 2); if (a > aTrac) a = aTrac;
      a -= P * vc * vc * iv3;
      const j = i + 1 === N ? 0 : i + 1;
      let vn = Math.sqrt(Math.max(0, vc * vc + 2 * a * step));
      const lim = Math.min(prof[j], vTop);
      if (vn > lim) vn = lim;
      o[j] = vn; vc = vn;
    }
  }
  track._prof.set(key, o);
  return o;
}

/* ------------------------------------------------- CONDICIONES Y FORMA */
export function rollConditions(rng) {
  const r = rng();
  const w = r < 0.55 ? 'seco' : r < 0.8 ? 'humedo' : 'viento';
  return { ...CONDITIONS[w] };
}

/** Efecto de la forma sobre el ritmo (multiplicador de velocidad objetivo). */
export function formPace(f) { return 1 + TUNING.formPace * ((f == null ? 3 : f) - 3); }

/**
 * Forma 1..5 (3 = normal). history[i] = posiciones recientes del coche i (1 = ganó),
 * la última al final. Las 3 últimas dan algo de "racha" (±1 punto como mucho).
 */
export function rollForm(rng, cars, history) {
  const n = cars.length, out = new Array(n);
  for (let i = 0; i < n; i++) {
    let mom = 0;
    const h = history && history[i];
    if (h && h.length) {
      const rec = h.slice(-3);
      let wsum = 0, acc = 0;
      rec.forEach((p, j) => { const w = j + 1; wsum += w; acc += w * p; });
      const avg = acc / wsum;
      mom = clamp((((n + 1) / 2) - avg) / ((n - 1) / 2), -1, 1); // +1 = siempre gana
    }
    out[i] = clamp(Math.round(3 + 0.9 * mom + 0.85 * gauss(rng)), 1, 5);
  }
  return out;
}

/* ---------------------------------------------------- PARÁMETROS DE COCHE */
export function carParams(car, track, cond = CONDITIONS.seco, form = 3) {
  const T = TUNING, s = 1; // la física va siempre a escala 1; speedScale solo comprime el tiempo en Race
  const rs = (car.spd - 80) / 100, ra = (car.acc - 80) / 100, rg = (car.grip - 80) / 100;
  const vTop = T.vTop0 * s * (1 + T.kSpd * cond.spdSens * rs) * cond.speedMul;
  const mu = T.mu0 * cond.gripMul * (1 + T.kGrip * cond.gripSens * rg);
  const cornerG = mu * G0 * s * s;
  const brakeD = T.brakeK * cornerG;
  const P = T.power0 * s * s * s * (1 + T.kAcc * cond.accSens * ra);
  const aTrac = T.trac0 * s * s * Math.min(1, 0.35 + 0.65 * cond.gripMul) * (1 + T.kAcc * cond.accSens * ra + 0.5 * T.kGrip * (cond.gripSens - 1) * rg);
  const errP = T.errBase * cond.errMul * Math.max(0.25, 1 - T.errGripK * rg * cond.gripSens);
  const launchMean = T.launchBase + T.launchAccK * ra * cond.accSens - 0.02 * (cond.launchMul - 1);
  return {
    vTop, mu, cornerG, brakeD, P, aTrac, errP, launchMean,
    launchSigma: T.launchSigma * cond.launchMul,
    form: formPace(form),
    prof: carProfile(track, cornerG, brakeD),
    ideal: idealProfile(track, carProfile(track, cornerG, brakeD), vTop, P, aTrac),
  };
}

/* =================================================================== CORE
   Un solo modelo para la carrera en pantalla y para el Monte Carlo.
   ======================================================================== */
class Core {
  constructor({ cars, track, laps = 2, grid, gridOffsets, cond = CONDITIONS.seco, form, fast = false, dt }) {
    const n = cars.length;
    this.n = n; this.track = track; this.laps = laps; this.cond = cond; this.fast = fast;
    this.L = track.length; this.raceLen = laps * track.length;
    this.h = dt || TUNING.simDt;
    this.grid = grid ? grid.slice() : cars.map((_, i) => i);
    this.par = cars.map((c, i) => carParams(c, track, cond, form ? form[i] : 3));
    const F = (m = 1) => new Float64Array(n * m);
    this.pV = Float64Array.from(this.par, (p) => p.vTop); this.pB = Float64Array.from(this.par, (p) => p.brakeD);
    this.pP = Float64Array.from(this.par, (p) => p.P); this.pA = Float64Array.from(this.par, (p) => p.aTrac);
    this.pE = Float64Array.from(this.par, (p) => p.errP); this.profs = this.par.map((p) => p.prof);
    this.pv = F(); this.plv = F(); this.pthr = F(); this.pbrk = F(); this.pslip = F(); this.prpm = F();
    this.near = new Int32Array(n);
    this.press = F(); this.pressThr = F(); this.pressOn = new Int32Array(n); this.yieldTo = new Int32Array(n);
    this.ideal = this.par.map((p) => p.ideal);
    this.dist = F(); this.v = F(); this.lat = F(); this.latV = F(); this.pd = F(); this.pl = F();
    this.react = F(); this.launchQ = F(); this.pm = F(); this.lapN = F(laps + 1);
    this.finT = F(); this.fin = new Uint8Array(n);
    this.errT = F(); this.errF = F(); this.errDir = F(); this.errKind = new Uint8Array(n); this.errAge = F();
    this.nextC = F(); this.cIdx = new Int32Array(n);
    this.passT = new Int32Array(n); this.passSide = F(); this.passTime = F();
    this.draft = F();
    this.est = new Uint32Array(n);
    this.ord = new Int32Array(n); this.finOrd = new Int32Array(n);
    // cosmética (solo carrera en pantalla)
    this.thr = F(); this.brk = F(); this.slip = F(); this.gear = new Int32Array(n); this.rpm = F();
    this.rank = new Int32Array(n); this.lastDraftEv = F();
    const ns = Math.ceil(this.raceLen / 5) + 2;
    this.reach = fast ? null : new Float64Array(ns);
    this.events = fast ? null : [];
    // puestos de parrilla [{ dist, lateral }] (pole primero)
    this.gridOffsets = [];
    for (let g = 0; g < n; g++) {
      const go = gridOffsets && gridOffsets[g];
      this.gridOffsets.push(go ? { dist: go.dist, lateral: go.lateral }
        : { dist: -(TUNING.gridFront + TUNING.gridGap * g), lateral: (g % 2 === 0 ? -1 : 1) * TUNING.gridLat });
    }
    // vTop de referencia para marchas
    this.gearTop = [0.30, 0.45, 0.59, 0.72, 0.86, 1.0];
  }

  reset(seed) {
    const T = TUNING, n = this.n, cond = this.cond, laps = this.laps, L = this.L;
    const r = makeRng(seed);
    this.t = 0; this.nFin = 0; this.seed = seed >>> 0;
    // sorteos en orden fijo (independientes de la dinámica)
    for (let c = 0; c < n; c++) {
      const p = this.par[c];
      this.react[c] = T.reactMin + (T.reactMax - T.reactMin) * r();
      this.launchQ[c] = clamp(p.launchMean + p.launchSigma * gauss(r), 0.7, 1.06);
      this.pm[c] = p.form * (1 + T.daySigma * gauss(r));
      for (let l = 0; l <= laps; l++) this.lapN[c * (laps + 1) + l] = 1 + T.lapSigma * cond.varMul * gauss(r);
      this.est[c] = hashSeed(seed, c + 101);
    }
    const corners = this.track.corners, nc = corners.length;
    for (let g = 0; g < n; g++) {
      const c = this.grid[g];
      const d = this.gridOffsets[g].dist;
      this.dist[c] = d; this.pd[c] = d;
      const lat = this.gridOffsets[g].lateral;
      this.lat[c] = lat; this.pl[c] = lat; this.latV[c] = 0;
      this.v[c] = 0; this.fin[c] = 0; this.finT[c] = 0;
      this.errT[c] = 0; this.errF[c] = 1; this.errKind[c] = 0; this.errAge[c] = 9;
      this.passT[c] = -1; this.passTime[c] = 0; this.draft[c] = 0;
      this.press[c] = 0; this.pressOn[c] = -1; this.yieldTo[c] = -1;
      this.pressThr[c] = -Math.log(1 - mbNext(this.est, c)) * T.passCost;
      this.thr[c] = 0; this.brk[c] = 0; this.slip[c] = 0; this.gear[c] = 1; this.rpm[c] = 0.18;
      this.lastDraftEv[c] = -99;
      this.ord[g] = c; this.rank[g] = c;
      // próxima curva en distancia absoluta
      if (nc) {
        const lp = d - L * Math.floor(d / L);
        let j = 0;
        while (j < nc && corners[j].start <= lp) j++;
        const base = d - lp;
        if (j === nc) { this.cIdx[c] = 0; this.nextC[c] = base + L + corners[0].start; }
        else { this.cIdx[c] = j; this.nextC[c] = base + corners[j].start; }
      } else this.nextC[c] = Infinity;
    }
    if (this.reach) { this.reach.fill(-1); this.reachI = 0; }
    if (this.events) this.events.length = 0;
  }

  _ev(type, car, other, extra) {
    const e = { type, car, other, t: this.t };
    if (extra) Object.assign(e, extra);
    this.events.push(e);
  }

  step() {
    const T = TUNING, n = this.n, tr = this.track, L = this.L, N = tr.N, step = tr.step, invStep = 1 / step;
    const dist = this.dist, v = this.v, lat = this.lat, latV = this.latV, ord = this.ord;
    const react = this.react, fin = this.fin, errT = this.errT, passT = this.passT;
    const pV = this.pV, pB = this.pB, pP = this.pP, pA = this.pA, profs = this.profs;
    const h = this.h, t = this.t + h, fast = this.fast, cond = this.cond;
    const kEff = tr.kEff, line = tr.line, cornerK = tr.cornerK, straightK = tr.straightK;
    const W = T.laneW, carLen = T.carLen, latMax = T.latMax, laps = this.laps, laps1 = laps + 1;
    const draftK = T.draft * cond.draftMul, dMin = T.draftMin, dSpan = T.draftMax - T.draftMin;
    const gapMin = T.gapMin, invTau = 1 / T.followTau, passRange = T.passRange, passMargin = T.passMargin;
    const om = T.latOmega, om2 = om * om, rateS = T.latRateStraight, rateC = T.latRateCorner;
    const sepD = carLen + 0.5, near = this.near;
    this.t = t;

    // orden por distancia (inserción: n pequeño, casi ordenado)
    for (let i = 1; i < n; i++) {
      const c = ord[i], d = dist[c];
      let j = i - 1;
      while (j >= 0 && dist[ord[j]] < d) { ord[j + 1] = ord[j]; j--; }
      ord[j + 1] = c;
    }
    // instantánea al inicio del paso: todas las interacciones longitudinales se miden
    // en el mismo instante (independiente del orden y de dt)
    const pd = this.pd, pl = this.pl;
    for (let c = 0; c < n; c++) { pd[c] = dist[c]; pl[c] = lat[c]; }
    if (!fast) { this.pv.set(v); this.plv.set(latV); this.pthr.set(this.thr); this.pbrk.set(this.brk); this.pslip.set(this.slip); this.prpm.set(this.rpm); }

    for (let k = 0; k < n; k++) {
      const c = ord[k];
      const rc = react[c];
      if (t <= rc) continue;
      const hc = t - rc < h ? t - rc : h;
      const s = dist[c], vc = v[c], latc = lat[c], finc = fin[c];
      const lapF = Math.floor(s / L);
      const lp = s - L * lapF;
      let i0 = (lp * invStep) | 0; if (i0 >= N) i0 = N - 1;
      const kHere = kEff[i0];
      const inCorner = kHere > cornerK;

      // ritmo
      const lapNo = lapF < 0 ? 0 : lapF > laps ? laps : lapF;
      let pm = this.pm[c] * this.lapN[c * laps1 + lapNo];
      if (finc) pm *= T.coolDown;
      let ef = 1;
      const et = errT[c];
      if (et > 0) { ef = this.errF[c]; errT[c] = et - hc; }

      // coche delante en mi carril (seguimiento) y casi en mi carril (rebufo)
      let aL = -1, gL = 1e9, aD = -1, gD = 1e9, nNear = 0;
      for (let o = 0; o < n; o++) {
        if (o === c) continue;
        const g = pd[o] - s;
        if (g < sepD && g > -sepD - 4) near[nNear++] = o; // a la par (o justo detrás: no cerrarle la puerta)
        if (g <= 0) continue;
        let dl = pl[o] - latc; if (dl < 0) dl = -dl;
        if (dl < 0.62) {
          if (g < gD) { gD = g; aD = o; }
          if (dl < W && g < gL) { gL = g; aL = o; }
        }
      }
      const vs = vc > 10 ? vc : 10;

      // rebufo
      let draft = 0;
      if (aD >= 0 && !finc && kHere < straightK) {
        const tg = gD / vs - dMin;
        if (tg > 0 && tg < dSpan) draft = draftK * (1 - tg / dSpan);
      }
      if (!fast) {
        if (draft > 0.01 && this.draft[c] <= 0.01 && t - this.lastDraftEv[c] > 10 && t > 4) {
          this._ev('drafting', c, aD); this.lastDraftEv[c] = t;
        }
        this.draft[c] = draft;
      }
      const vTopE = pV[c] * pm * (1 + draft) * ef;

      // velocidad objetivo (perfil curva + frenada) en el punto donde estaré
      let la = (lp + vc * hc) * invStep; if (la >= N) la -= N;
      let j0 = la | 0; const fr = la - j0; if (j0 >= N) j0 = N - 1;
      const j1 = j0 + 1 >= N ? 0 : j0 + 1;
      const prof = profs[c];
      let vtC = (prof[j0] + (prof[j1] - prof[j0]) * fr) * pm * ef;
      // cede ante un adelantamiento ya "ganado" por presión: levanta hasta que el otro pase
      const yt = this.yieldTo[c];
      if (yt >= 0) {
        if (passT[yt] !== c) this.yieldTo[c] = -1;
        else {
          const dl = pl[yt] - latc;
          if ((dl > 0.3 || dl < -0.3) && pd[yt] - s > -(carLen + 1.5) && vc > 0.4 * pV[c]) {
            const cap = vc - T.yieldDecel * hc; if (vtC > cap) vtC = cap > 0 ? cap : 0;
            if (DBG) DBG.yields++;
          }
        }
      }
      if (inCorner) {
        // fuera de trazada: por fuera se pierde mucho, por dentro poco (y se gana la posición)
        let dev = (line[i0] - latc) * (tr.kSmooth[i0] >= 0 ? 1 : -1);
        if (dev < 0) dev = -dev * T.offLineIn;
        dev -= 0.25;
        if (dev > 0) vtC *= 1 - T.offLinePen * (dev > 0.5 ? 1 : dev * 2);
        if (aL >= 0 && gL < vs * 0.8) {
          // aire sucio: menos agarre pegado al de delante, y no se le puede "atravesar"
          vtC *= 1 - T.dirtyPen * (1 - gL / (vs * 0.8));
          const cap = v[aL] + T.dirtyMargin; if (vtC > cap) vtC = cap;
        }
      }

      // dinámica longitudinal
      let vn, braking = 0;
      if (vc > vtC) {
        const bd = pB[c] * hc;
        vn = vc - bd;
        if (vn < vtC) vn = vtC;
        braking = (vc - vn) / bd;
      } else {
        // aceleración: potencia (P/v) limitada por tracción, menos resistencia; RK2
        const P = pP[c], iv3 = 1 / (vTopE * vTopE * vTopE);
        let tl = pA[c];
        if (t - rc < 3.5 && vc < 0.5 * pV[c]) tl *= this.launchQ[c];
        let a = P / (vc > 2 ? vc : 2);
        if (a > tl) a = tl;
        a -= P * vc * vc * iv3;
        const vm = vc + a * hc * 0.5;
        a = P / (vm > 2 ? vm : 2);
        if (a > tl) a = tl;
        a -= P * vm * vm * iv3;
        vn = vc + a * hc;
        if (vn > vtC) vn = vtC;
        if (vn < 0) vn = 0;
      }
      const vDes = vn;
      // no atravesar al de delante
      let held = false;
      // (si ya está saliendo de la estela para adelantar, deja de estar "detrás")
      if (aL >= 0 && gL < 60 && !(passT[c] === aL && Math.abs(pl[aL] - latc) > T.passFree)) {
        let vmax = v[aL] + (gL - gapMin) * invTau;
        if (vmax < 0) vmax = 0;
        if (vmax < vc - 1.3 * pB[c] * hc) vmax = vc - 1.3 * pB[c] * hc; // frenada físicamente posible
        if (vn > vmax) { vn = vmax; held = true; if (DBG) DBG.heldSteps++; }
      }
      v[c] = vn;
      const d1 = s + (vc + vn) * 0.5 * hc;
      dist[c] = d1;

      // presión: pegado a un coche más lento (según el ritmo ideal de cada uno en ESTE punto
      // de la pista: punta en recta, agarre en curva, aceleración a la salida), se acumula
      // ventaja·tiempo; al superar un umbral aleatorio el adelantamiento se consuma.
      let pt = passT[c];
      let grant = false;
      if (pt < 0) {
        const press = this.press;
        if (aL >= 0 && !finc && gL < vs * T.pressGap && vc > 0.5 * pV[c]) {
          if (this.pressOn[c] !== aL) { this.pressOn[c] = aL; press[c] = 0; }
          const lfA = Math.floor(pd[aL] / L);
          let pmA = this.pm[aL] * this.lapN[aL * laps1 + (lfA < 0 ? 0 : lfA > laps ? laps : lfA)];
          if (errT[aL] > 0) pmA *= this.errF[aL];
          if (fin[aL]) pmA *= T.coolDown;
          const adv = this.ideal[c][i0] * pm * ef * (1 + draft) - this.ideal[aL][i0] * pmA;
          if (adv > 0) press[c] += adv * hc;
          if (press[c] >= this.pressThr[c]) grant = true;
        } else if (press[c] > 0) press[c] *= 1 - hc / T.pressDecay;
      }
      if (pt < 0 && aL >= 0 && !finc && gL < passRange &&
          (grant || ((T.passInCorner || !inCorner) && (vDes > v[aL] + passMargin || this.raceLen - s < T.finalAttack)))) {
        const kNext = tr.kSmooth[(i0 + Math.round(120 * invStep)) % N];
        let best = 0, bestScore = -1e9;
        for (let sd = -1; sd <= 1; sd += 2) {
          const target = sd * T.passLane;
          if ((pl[aL] - target) * sd > -W * 0.8 && !grant) continue; // el rival ya ocupa ese lado
          let ok = true;
          for (let o = 0; o < n; o++) {
            if (o === c || o === aL) continue;
            const dd = pd[o] - s;
            if (dd < T.passRoom && dd > -T.passRoom && Math.abs(pl[o] - target) < W) { ok = false; break; }
          }
          if (!ok) continue;
          const score = -Math.abs(target - latc) + (kNext * sd > 0 ? T.passInsideBias : 0);
          if (score > bestScore) { bestScore = score; best = sd; }
        }
        if (best) {
          pt = passT[c] = aL; this.passSide[c] = best; this.passTime[c] = 0; if (DBG) DBG.start++;
          if (passT[aL] === c) passT[aL] = -1; // nunca dos adelantándose mutuamente
          if (grant) {
            this.yieldTo[aL] = c; this.press[c] = 0; this.pressOn[c] = -1;
            this.pressThr[c] = -Math.log(1 - mbNext(this.est, c)) * T.passCost;
            if (DBG) DBG.grants++;
          }
        }
        else if (DBG) DBG.noRoom++;
      }
      if (pt >= 0) {
        const ptm = (this.passTime[c] += hc);
        const gp = pd[pt] - s;
        if (gp < -(carLen + 1) || ptm > T.passTimeout || gp > passRange + 6) {
          if (DBG) { if (gp < 0) DBG.done++; else if (ptm > T.passTimeout) DBG.timeout++; else DBG.fellBack++; }
          pt = passT[c] = -1;
        }
      }

      // lateral
      let latT;
      if (errT[c] > 0) latT = this.errDir[c] * 0.85;
      else if (pt >= 0) latT = this.passSide[c] * T.passLane;
      else if (this.yieldTo[c] >= 0) latT = -this.passSide[this.yieldTo[c]] * T.passLane; // deja el hueco
      else {
        let qi = ((lp + vc * 0.6) * invStep) | 0; if (qi >= N) qi -= N; if (qi >= N) qi = N - 1;
        latT = line[qi];
      }
      let rate = inCorner ? rateC : rateS;
      const rateV = 0.03 * vc + 0.05; if (rate > rateV) rate = rateV; // parado no se mueve de lado
      let lv = latV[c] + (om2 * (latT - latc) - 2 * om * latV[c]) * hc;
      if (lv > rate) lv = rate; else if (lv < -rate) lv = -rate;
      let nl = latc + lv * hc;
      if (nl > latMax) { nl = latMax; lv = 0; } else if (nl < -latMax) { nl = -latMax; lv = 0; }
      // nunca solapados lateralmente con un coche a la par (o justo detrás): no se invade su
      // carril; si ya hay solape (p. ej. el otro se ha movido), se separa a ritmo limitado
      for (let q = 0; q < nNear; q++) {
        const o = near[q];
        const lo = lat[o];
        const d0 = latc - lo;
        const side = d0 > 0 ? 1 : d0 < 0 ? -1 : (c < o ? 1 : -1);
        if (d0 * side >= W) {
          if ((nl - lo) * side < W) { nl = lo + side * W; lv = 0; }
        } else {
          let q2 = latc + side * Math.min(T.latPush, 0.05 * vc + 0.1) * hc;
          if (q2 > latMax || q2 < -latMax) q2 = latc;
          if ((nl - lo) * side < (q2 - lo) * side) { nl = q2; lv = (q2 - latc) / hc; }
        }
      }
      lat[c] = nl; latV[c] = lv;

      // meta
      if (!finc && d1 >= this.raceLen) {
        const ft = t - hc + ((this.raceLen - s) / (d1 - s)) * hc;
        this.finT[c] = ft; fin[c] = 1;
        const fo = this.finOrd, fT = this.finT;
        let q = this.nFin++;
        while (q > 0 && fT[fo[q - 1]] > ft) { fo[q] = fo[q - 1]; q--; }
        fo[q] = c;
      }

      // errores al entrar en curva
      if (d1 >= this.nextC[c]) {
        const corners = tr.corners, ci = this.cIdx[c], cr = corners[ci];
        const u = mbNext(this.est, c);
        let pe = this.pE[c] * cr.risk;
        if (aL >= 0 && gL < vs) pe *= T.errPressure;
        if (!finc && errT[c] <= 0 && u < pe) {
          const loss = T.errLossMin + (T.errLossMax - T.errLossMin) * mbNext(this.est, c);
          const lock = mbNext(this.est, c) < 0.45;
          const dur = 0.8 + 1.5 * loss;
          errT[c] = dur; this.errF[c] = 1 - T.errSeverity * loss / dur;
          this.errDir[c] = -cr.dir; this.errKind[c] = lock ? 2 : 1; this.errAge[c] = 0;
          if (!fast) this._ev(lock ? 'lockup' : 'error', c, -1, { loss, lap: lapNo + 1 });
        }
        const nj = ci + 1;
        if (nj >= corners.length) { this.cIdx[c] = 0; this.nextC[c] += corners[0].start + L - cr.start; }
        else { this.cIdx[c] = nj; this.nextC[c] += corners[nj].start - cr.start; }
      }

      if (!fast) this._cosmetic(c, hc, t, vn, vtC, vTopE, braking, held, kEff[i0]);
    }

    if (!fast) this._timing(t);
  }

  _cosmetic(c, hc, t, vn, vtC, vTopE, braking, held, kHere) {
    const p = this.par[c];
    this.errAge[c] += hc;
    const thrT = braking > 0 ? 0 : (vn < vtC - 0.05 || vn < vTopE * 0.995 ? (held ? 0.55 : 1) : 0.6);
    this.thr[c] += (thrT - this.thr[c]) * Math.min(1, hc * 12);
    let bT = braking > 0 ? 0.35 + 0.65 * braking : 0;
    let sl = 0;
    const load = vn * vn * kHere / p.cornerG;
    if (load > 0.8) sl = (load - 0.8) * 2.5;
    const sinceGo = t - this.react[c];
    if (sinceGo < 1.6) sl = Math.max(sl, (1.06 - this.launchQ[c]) * 3 * (1 - sinceGo / 1.6) + 0.15);
    if (this.errT[c] > 0) {
      if (this.errKind[c] === 2 && this.errAge[c] < 0.6) { bT = 1; sl = Math.max(sl, 0.9); }
      else sl = Math.max(sl, 0.55);
    }
    this.brk[c] += (bT - this.brk[c]) * Math.min(1, hc * 15);
    this.slip[c] += (clamp(sl, 0, 1) - this.slip[c]) * Math.min(1, hc * 8);
    const gt = this.gearTop, vt = p.vTop * 1.04;
    let g = this.gear[c];
    if (g < 6 && vn > gt[g - 1] * vt * 0.97) g++;
    else if (g > 1 && vn < gt[g - 2] * vt * 0.78) g--;
    this.gear[c] = g;
    const lo = g > 1 ? gt[g - 2] * vt * 0.7 : 0;
    let rpm = 0.25 + 0.75 * clamp((vn - lo) / (gt[g - 1] * vt - lo), 0, 1);
    if (sinceGo < 1.2 && g === 1) rpm = Math.max(rpm, 0.75);
    this.rpm[c] = rpm;
  }

  _timing(t) {
    const n = this.n, dist = this.dist, L = this.L;
    // tiempos de paso del primero cada 5 m (para diferencias)
    let dmax = -1e9;
    for (let c = 0; c < n; c++) if (dist[c] > dmax) dmax = dist[c];
    const reach = this.reach;
    while (this.reachI < reach.length && dmax >= this.reachI * 5) { reach[this.reachI++] = t; }
    // posiciones con histéresis + eventos de adelantamiento
    const rank = this.rank, fin = this.fin, finT = this.finT;
    let sw = true, guard = 0;
    while (sw && guard++ < 10) {
      sw = false;
      for (let i = 1; i < n; i++) {
        const a = rank[i - 1], b = rank[i];
        let swap = false, ev = false;
        if (fin[a] && fin[b]) swap = finT[b] < finT[a];
        else if (fin[b] && !fin[a]) swap = true;
        else if (!fin[a] && !fin[b] && dist[b] > dist[a] + 1.5) { swap = true; ev = true; }
        if (swap) {
          rank[i - 1] = b; rank[i] = a; sw = true;
          if (ev) this._ev('overtake', b, a, { pos: i, lap: Math.max(1, Math.min(this.laps, Math.floor(dist[b] / L) + 1)) });
        }
      }
    }
  }

  /** Corre hasta que haya `k` coches en meta (Monte Carlo). */
  runUntil(k) {
    const tMax = 900;
    while (this.nFin < k && this.t < tMax) this.step();
  }
}

/* ============================================================= CARRERA */
const PUB_KEYS = ['dist', 'lap', 'lateral', 'v', 'rpm', 'gear', 'throttle', 'brake', 'slip', 'finished', 'finishTime', 'pos'];

class Race {
  constructor(o) {
    const core = (this.core = new Core({ ...o, fast: false }));
    this.seed = (o.seed >>> 0) || 1;
    core.reset(this.seed);
    this.track = o.track; this.laps = core.laps; this.n = core.n;
    this.cond = core.cond; this.form = o.form ? o.form.slice() : new Array(core.n).fill(3);
    this.grid = core.grid.slice();
    this.t = 0; this.done = false; this.events = [];
    this.ts = o.track.speedScale || 1;     // compresión de tiempo (física idéntica → mismas probabilidades)
    this.lights = { out: 0 };              // t = 0 → apagado de semáforos
    this.reaction = Array.from(core.react, (x) => x / this.ts); // s
    this.launch = Array.from(core.launchQ);
    this.raceLength = core.raceLen;
    this.cars = [];
    for (let i = 0; i < core.n; i++) {
      this.cars.push({ dist: 0, lap: 1, lateral: 0, v: 0, rpm: 0.18, gear: 1, throttle: 0, brake: 0, slip: 0,
        finished: false, finishTime: 0, pos: 0, draft: 0, error: 0 });
    }
    this.order = this.grid.slice();
    this.results = null;
    this._pending = [{ type: 'start', car: -1, other: -1, t: 0, reaction: this.reaction.slice() }];
    this._sync();
  }

  step(dt) {
    if (!(dt > 0)) return this;
    if (dt > 0.5) dt = 0.5;
    const core = this.core;
    this.t += dt;
    const tc = this.t * this.ts;
    while (core.t < tc) {
      core.step();
      if (core.events.length) {
        for (const e of core.events) { e.t /= this.ts; this._pending.push(e); }
        core.events.length = 0;
      }
    }
    this._sync();
    return this;
  }

  _sync() {
    const core = this.core, n = this.n, t = this.t, h = core.h, ts = this.ts, tc = t * ts;
    let al = 1 - (core.t - tc) / h;
    if (al < 0) al = 0; else if (al > 1) al = 1;
    if (core.t === 0) al = 1;
    const L = core.L;
    let nf = 0;
    for (let i = 0; i < n; i++) {
      const c = this.cars[i];
      // Hermite cúbica (posición y velocidad continuas entre pasos fijos)
      const d0 = core.pd[i], d1 = core.dist[i], v0 = core.pv[i], v1 = core.v[i];
      const a2 = al * al, a3 = a2 * al;
      let d = (2 * a3 - 3 * a2 + 1) * d0 + (a3 - 2 * a2 + al) * h * v0 + (3 * a2 - 2 * a3) * d1 + (a3 - a2) * h * v1;
      if (d < d0) d = d0; else if (d > d1) d = d1;
      c.dist = d;
      const l0 = core.pl[i], l1 = core.lat[i];
      c.lateral = (2 * a3 - 3 * a2 + 1) * l0 + (a3 - 2 * a2 + al) * h * core.plv[i] + (3 * a2 - 2 * a3) * l1 + (a3 - a2) * h * core.latV[i];
      c.v = (v0 + (v1 - v0) * al) * ts;
      c.lap = Math.max(1, Math.min(this.laps, Math.floor(d / L) + 1));
      c.rpm = core.prpm[i] + (core.rpm[i] - core.prpm[i]) * al; c.gear = core.gear[i];
      c.throttle = core.pthr[i] + (core.thr[i] - core.pthr[i]) * al;
      c.brake = core.pbrk[i] + (core.brk[i] - core.pbrk[i]) * al;
      c.slip = core.pslip[i] + (core.slip[i] - core.pslip[i]) * al;
      c.draft = core.draft[i]; c.error = core.errT[i] > 0 ? core.errKind[i] : 0;
      if (core.fin[i] && core.finT[i] <= tc) { c.finished = true; c.finishTime = core.finT[i] / ts; nf++; }
    }
    for (let r = 0; r < n; r++) { const ci = core.rank[r]; this.order[r] = ci; this.cars[ci].pos = r + 1; }
    // eventos con t <= tiempo visible
    const pend = this._pending;
    let k = 0;
    while (k < pend.length && pend[k].t <= t + 1e-9) k++;
    if (k) {
      for (let q = 0; q < k; q++) this.events.push(pend[q]);
      pend.splice(0, k);
    }
    // meta: eventos 'finish' / 'photo' en orden
    if (!this._finEmitted) this._finEmitted = 0;
    while (this._finEmitted < core.nFin) {
      const ci = core.finOrd[this._finEmitted];
      if (core.finT[ci] > tc) break;
      const pos = ++this._finEmitted;
      const gap = (core.finT[ci] - core.finT[core.finOrd[0]]) / ts;
      this.events.push({ type: 'finish', car: ci, other: -1, t: core.finT[ci] / ts, pos, gap });
      // foto-finish: decidido en tiempo de modelo (no depende de speedScale)
      if (pos === 2 && gap * ts < TUNING.photoGap) this.events.push({ type: 'photo', car: core.finOrd[0], other: ci, t: core.finT[ci] / ts, gap });
    }
    if (!this.done && nf === n) {
      this.done = true;
      this.results = Array.from(core.finOrd).map((ci) => ({ car: ci, time: core.finT[ci] / ts }));
    }
  }

  /** Segundos detrás del líder (estimado como en el cronometraje real). */
  leaderGap(i) {
    const core = this.core, c = this.cars[i];
    const lead = this.order[0];
    if (i === lead) return 0;
    if (c.finished && this.cars[lead].finished) return c.finishTime - this.cars[lead].finishTime;
    const d = c.dist;
    if (d <= 0) {
      const dl = this.cars[lead].dist;
      return Math.max(0, (dl - d) / Math.max(20 * this.ts, this.cars[lead].v || 20));
    }
    const reach = core.reach, x = d / 5, i0 = Math.floor(x);
    if (i0 + 1 >= core.reachI) {
      return Math.max(0, (this.cars[lead].dist - d) / Math.max(20 * this.ts, c.v));
    }
    const tr = reach[i0] + (reach[i0 + 1] - reach[i0]) * (x - i0);
    return Math.max(0, this.t - tr / this.ts);
  }

  /** Orden final (array de índices) — solo cuando done. */
  get finishOrder() { return this.done ? this.results.map((r) => r.car) : null; }
}

export function createRace(opts) { return new Race(opts); }

/** Resultado de una carrera sin pantalla (mismo modelo). */
export function simulateRace(opts, seed, untilPodium = false) {
  const core = new Core({ ...opts, fast: true });
  core.reset(seed >>> 0);
  core.runUntil(untilPodium ? Math.min(3, core.n) : core.n);
  return { order: Array.from(core.finOrd).slice(0, core.nFin), times: Array.from(core.finT) };
}

/* ============================================================== MERCADO */
/** Cuota redondeada al paso MÁS CERCANO (0.05 < 5, 0.1 < 10, 0.5 después), en [ODDS_MIN, ODDS_MAX]. */
export const ODDS_MIN = 1.05, ODDS_MAX = 100;
export function roundOdds(o) {
  if (!(o > 0) || !isFinite(o)) return ODDS_MAX;
  const stepO = o < 5 ? 0.05 : o < 10 ? 0.1 : 0.5;
  let r = Math.round(o / stepO) * stepO;
  r = Math.round(r * 100) / 100;
  return clamp(r, ODDS_MIN, ODDS_MAX);
}

function finalizeMarket(n, sims, wins, pods, rtp, extra) {
  const aW = 1, aP = 0.5;
  const pWin = [], pPodium = [], oddsWin = [], oddsPodium = [], rtpWin = [], rtpPodium = [];
  for (let i = 0; i < n; i++) {
    const pw = (wins[i] + aW) / (sims + n * aW);
    const pp = Math.min(0.999, (pods[i] + aP) / (sims + (n * aP) / 3));
    pWin.push(pw); pPodium.push(pp);
    const ow = roundOdds(rtp / pw), op = roundOdds(rtp / pp);
    oddsWin.push(ow); oddsPodium.push(op);
    rtpWin.push(ow * pw); rtpPodium.push(op * pp);
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const sumInv = (a) => a.reduce((x, y) => x + 1 / y, 0);
  return { pWin, pPodium, oddsWin, oddsPodium, rtpWin, rtpPodium,
    rtpWinMean: mean(rtpWin), rtpPodiumMean: mean(rtpPodium),
    bookWin: sumInv(oddsWin), bookPodium: sumInv(oddsPodium) / 3, // 1 = libro justo
    sims, wins: Array.from(wins), podiums: Array.from(pods), ...extra };
}

function marketSeed(o) {
  let h = hashSeed(o.laps || 2, Math.round(o.track.length));
  (o.grid || []).forEach((g, i) => { h = hashSeed(h, g * 7 + i); });
  (o.form || []).forEach((f, i) => { h = hashSeed(h, f * 13 + i); });
  h = hashSeed(h, (o.cond && o.cond.weather || 'seco').charCodeAt(0));
  return h;
}

/** Versión síncrona (tests / Web Worker). */
export function computeMarket(o) {
  const { sims = 1500, rtp = 1 } = o;
  const core = new Core({ ...o, fast: true });
  const n = core.n, wins = new Float64Array(n), pods = new Float64Array(n);
  const base = o.seed != null ? o.seed >>> 0 : marketSeed(o);
  const k3 = Math.min(3, n);
  const t0 = now();
  for (let s = 0; s < sims; s++) {
    core.reset(hashSeed(base, s));
    core.runUntil(k3);
    wins[core.finOrd[0]]++;
    for (let q = 0; q < k3; q++) pods[core.finOrd[q]]++;
  }
  return finalizeMarket(n, sims, wins, pods, rtp, { ms: now() - t0 });
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const yieldUI = () => new Promise((r) => setTimeout(r, 0));

/**
 * createMarket(opts) → Promise<{ pWin, pPodium, oddsWin, oddsPodium, ... }>
 * Monte Carlo troceado: nunca bloquea más de `chunkMs` (12 ms por defecto).
 */
export async function createMarket(o) {
  const { sims = 1500, rtp = 1, onProgress, chunkMs = 12, maxMs = Infinity } = o;
  const core = new Core({ ...o, fast: true });
  const n = core.n, wins = new Float64Array(n), pods = new Float64Array(n);
  const base = o.seed != null ? o.seed >>> 0 : marketSeed(o);
  const k3 = Math.min(3, n);
  const t0 = now();
  let tc = t0, maxChunk = 0, done = 0;
  for (let s = 0; s < sims; s++) {
    if (s >= 300 && now() - t0 > maxMs) break; // presupuesto de tiempo (mínimo 300 simulaciones)
    done++;
    core.reset(hashSeed(base, s));
    core.runUntil(k3);
    wins[core.finOrd[0]]++;
    for (let q = 0; q < k3; q++) pods[core.finOrd[q]]++;
    const tn = now();
    if (tn - tc > chunkMs && s < sims - 1) {
      if (tn - tc > maxChunk) maxChunk = tn - tc;
      if (onProgress) onProgress((s + 1) / sims);
      await yieldUI();
      tc = now();
    }
  }
  if (now() - tc > maxChunk) maxChunk = now() - tc;
  if (onProgress) onProgress(1);
  return finalizeMarket(n, done, wins, pods, rtp, { ms: now() - t0, maxChunkMs: maxChunk });
}

/**
 * Vuelta ideal de cada coche en solitario (diagnóstico / ficha técnica).
 * Devuelve { lapTime[], vMax[], vMinCorner[] } a ritmo de forma neutra.
 */
export function analyzeTrack(track, cars, cond = CONDITIONS.seco, laps = 2, dt) {
  return cars.map((car) => {
    const core = new Core({ cars: [car], track, laps, cond, fast: true, dt });
    core.reset(1);
    core.react[0] = 0; core.launchQ[0] = 1; core.pm[0] = 1;
    for (let l = 0; l <= laps; l++) core.lapN[l] = 1;
    core.pE[0] = 0;
    let tLap1 = 0, vMax = 0;
    while (!core.nFin) {
      const d0 = core.dist[0];
      core.step();
      if (core.v[0] > vMax) vMax = core.v[0];
      if (!tLap1 && d0 < track.length && core.dist[0] >= track.length) tLap1 = core.t;
    }
    return { name: car.name, raceTime: core.finT[0], lap2: core.finT[0] - tLap1, vMax };
  });
}
