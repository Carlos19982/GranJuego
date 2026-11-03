/* =========================================================================
   GRAN PREMIO NEÓN · carrera-sim.js  (v3)
   Simulación de carrera determinista (semilla) + mercado de apuestas justo.

   - El resultado EMERGE de la simulación: nadie elige ganador.
   - Las cuotas salen de un Monte Carlo del MISMO modelo (misma clase Core y
     mismo paso fijo TUNING.simDt): la carrera en pantalla es una muestra más
     de la distribución con la que se calcularon las cuotas. Averías, coche
     de seguridad y trompos forman parte del modelo (también en el MC).
   - rtp = 1 → sin margen de la casa (solo el redondeo al paso más cercano).

   API
     makeRng(seed) → () => [0,1)
     buildTrack({ length, k, step, speedScale, line, halfW, w, laps, pit })
        k con signo (1/m); line = trazada (unidades laterales, se sigue en marcha libre; si falta se deriva de k);
        w = semiancho por muestra (m) o halfW escalar → separación entre coches; pit = T.pit (el SC entra en boxes).
        Uso típico: buildTrack({ ...T.sim, laps: T.laps, pit: T.pit }).
     rollConditions(rng, weatherOdds?) → { weather, label, desc, gripMul, ... }   (weatherOdds = T.weatherOdds)
     rollForm(rng, cars, history) → [1..5] por coche
     rollEstado(rng, prevEstado, lastResults) → { estado: [0..1], notes: [{ car, text, effect, tone }] }
        lastResults = race.results (o finishOrder). estadoPace(e), dnfProbability(e) para la ficha / el comentarista.
     createMarket({ cars, track, laps, grid, gridOffsets, cond, form, estado, sims, rtp, onProgress, seed, maxMs })
        → Promise<{ pWin, pPodium, pExacta (Float32Array n·n, [i*n+j] = i 1º y j 2º), oddsWin, oddsPodium,
                    oddsExacta (Array n·n, 0 en la diagonal), rtpWin/Podium/Exacta, bookWin/Podium/Exacta, pDnf, pSC, ... }>
     computeMarket(mismo objeto) → igual, síncrono (Web Worker / tests). Reparto entre workers:
        computeMarket({ ...o, range: [a, b], raw: true }) en cada uno → mergeMarket(partes) (idéntico a una sola llamada).
     createRace({ cars, track, laps, grid, gridOffsets, cond, form, estado, seed }) → race
        race.step(dt) · race.cars[i] · race.events · race.order · race.done · race.sc · race.results · race.finishOrder
        race.t · race.leaderGap(i) (Infinity si abandonó)
     simulateRace(opts, seed) → { order, times, dnf, reasons, sc, nDnf, t }   (sin pantalla; mismo resultado que createRace)
     analyzeTrack(track, cars, cond) → vuelta ideal de cada coche en solitario

   race.cars[i]: { dist, lap, lateral, v, rpm, gear, throttle, brake, slip, finished, finishTime, pos, draft,
                   error (0 nada, 1 se abre, 2 bloqueo, 3 trompo, 4 fuera de pista: error que se sale o |lateral| > 1.15),
                   state ('run'|'dnf'|'fin'), cond (estado 0..1), dnfReason, sc (rodando tras el coche de seguridad) }
   race.sc = { active, phase ('out' luces encendidas | 'in' luces apagadas / entrando en boxes | 'off'), dist, lateral, v, leaving, lights }
   race.results = [{ car, time (null si DNF), pos, dnf, reason, dist }]  (los que terminan por tiempo; después los DNF por distancia)
   Eventos: start, overtake, drafting, error, lockup, spin, offtrack, dnf {reason}, sc_start {reason: 'dnf'|'spin'},
            sc_in {pit}, sc_end (relanzamiento), finish, photo.

   Lateral: cada coche sigue un "carril" δ (estado suave): δ = 0 es la trazada; ±0.5 son copias comprimidas de la
   trazada para adelantar / defenderse (los dos coches a la par se mueven en paralelo). Velocidad lateral continua,
   aceleración lateral limitada, ángulo de trayectoria ≤ 3° por debajo de 20 m/s (salida recta, cada coche mantiene su
   fila los primeros TUNING.fanOut m), nunca solapados con un coche a la par, dentro de ±1 (±1.3 en errores, ~±1.3–1.45
   aparcado tras una avería).

   Convenciones
   - Unidades: metros y segundos. `speedScale` (en buildTrack) es una pura
     compresión de tiempo aplicada por Race: velocidades ×s, tiempos ÷s.
     La física interna y por tanto las probabilidades NO cambian con s.
   - k > 0 = la pista gira hacia +lateral (izquierda). lateral ±1 = w − 1.2 m.
   - dist = metros recorridos desde la línea de salida/meta (negativo en
     parrilla). Meta en dist = laps · length.
   - t = 0 es el apagado de semáforos.
   - Clasificación: los que terminan por tiempo; después los abandonos (DNF)
     por distancia recorrida. Un coche DNF nunca gana ni sube al podio.
   ========================================================================= */

const G0 = 9.81;
export let DBG = null; export function setDebug(o) { DBG = o; }

/* --------------------------------------------------------------- AJUSTES */
export const TUNING = {
  simDt: 0.1,           // paso fijo interno (s). La carrera en pantalla y el Monte Carlo usan EL MISMO (Race interpola para pintar).
  // Prestaciones (a speedScale 1). r = (stat - 80) / 100
  vTop0: 90,            // velocidad punta base (m/s)
  kSpd: 0.14,           // punta: +1.4 % por cada 10 pts de "spd"
  mu0: 5.0,             // agarre lateral arcade (× g)
  kGrip: 0.10,          // agarre: +1 % por cada 10 pts de "grip" (curva ≈ +0.5 % velocidad); en mojado × gripSens
  brakeK: 0.80,         // deceleración de frenada = brakeK · mu · g
  power0: 1050,         // potencia específica P (m²/s³): a = P / v
  kAcc: 0.27,           // potencia: +2.7 % por cada 10 pts de "acc"
  trac0: 17,            // aceleración máxima limitada por tracción (m/s²)
  kTracAcc: 1.0,        // peso de "acc" en la tracción (× kAcc)
  kTracGripWet: 0.5,    // en mojado la tracción depende del agarre (× kGrip · (gripSens − 1))
  // Pista
  kSmoothM: 12,         // suavizado de curvatura (± m)
  lineFactor: 0.78,     // la trazada abre las curvas: k efectiva = |k| · lineFactor
  // Tráfico
  carLen: 5,            // m
  gapMin: 6.5,          // distancia mínima morro-morro siguiendo a otro coche (m)
  followTau: 0.45,      // s: cuánto se permite cerrar el hueco
  laneM: 2.9,           // separación lateral mínima entre centros (m) → laneW por muestra = laneM / (w − 1.2)
  laneMinU: 0.3, laneMaxU: 0.7, // límites de laneW (unidades laterales)
  latMax: 0.95,         // |lateral| máximo del objetivo en marcha libre
  latLimit: 1.0,        // borde en marcha normal
  latErrMax: 1.3,       // borde en errores / fuera de pista (las averías aparcan algo más allá: parkLat)
  latKp: 1.6,           // 1/s: ganancia hacia el objetivo lateral (respecto a la trazada)
  latAcc: 0.8,          // u/s²: aceleración lateral máx. respecto a la trazada (giros de volante suaves)
  latAccAbs: 1.6,       // u/s²: cambio de carril en errores / avería
  latAccDev: 2.0,       // u/s²: corrección de la desviación respecto al camino del carril (la crean las restricciones)
  latAccEm: 4.0,        // u/s²: ídem en emergencia (no cerrar a un coche a la par / pared)
  latRateStraight: 0.7, // u/s: velocidad lateral máx. (respecto a la trazada) en recta
  latRateCorner: 0.35,  // ídem en curva
  latAngLow: 3, latAngHigh: 10, latAngV0: 20, latAngV1: 45, // ángulo máx. de la trayectoria respecto al eje (°): 3° por debajo de 20 m/s → 10° a 45 m/s
  fanOut: 60,           // m tras la salida: cada coche mantiene su fila de parrilla y luego se abre progresivamente
  latPush: 0.45,        // u/s: separación si dos coches se solapan
  draft: 0.08,          // rebufo (arcade): hasta +8 % de punta pegado, se diluye linealmente hasta draftMax
  draftMin: 0.0, draftMax: 2.0, // s detrás
  dirtyMargin: 0.6,     // m/s: en curva, el que va detrás (<0.8 s, mismo carril) no puede ir más rápido que esto sobre el de delante
  dirtyPen: 0.0,
  offLinePen: 0.03,     // pérdida de velocidad en curva por ir por fuera de la trazada
  offLineIn: 0.3,       // fracción de esa pérdida si se va por dentro
  // Adelantamientos
  passCost: 1.5,        // presión media (m/s · s de ventaja de ritmo) para consumar un adelantamiento
  pressGap: 0.7,        // s: hay que ir a menos de esto del de delante para presionar
  pressDecay: 4,
  yieldDecel: 5,        // m/s²: el adelantado levanta así mientras el otro le supera
  passRange: 20,        // m
  passMargin: 2.0,      // m/s de ventaja instantánea para intentarlo sin presión previa
  passInCorner: false,
  passRoom: 12,         // m: hueco libre (±) que exige el lado elegido
  passTimeout: 8,
  passFree: 0.22,       // desplazamiento lateral a partir del cual el que adelanta ya no va "detrás"
  passLane: 0.5,        // carril (±) por el que se adelanta; el adelantado se aparta al contrario
  passInsideBias: 0.6,
  finalAttack: 400,     // m: en los últimos metros todo el que va pegado sale de la estela a por la meta
  // Aleatoriedad (todo sale de la semilla)
  lapSigma: 0.005,      // ritmo por vuelta (σ relativo)
  daySigma: 0.009,      // ritmo del día (σ relativo)
  formPace: 0.004,      // ±0.4 % de ritmo por punto de forma
  reactMin: 0.15, reactMax: 0.35,
  launchBase: 0.90, launchAccK: 0.4, launchSigma: 0.06,
  errBase: 0.009,       // prob. de error por curva de riesgo 1 (seco)
  errGripK: 1.5,        // más agarre → menos errores
  errPressure: 1.4,
  errLossMin: 0.2, errLossMax: 0.8,
  errSeverity: 0.75,
  offTrackLoss: 0.62,   // un "se abre" con pérdida > esto se sale de la pista (error 4)
  errWide: 0.8,         // se abre: carril exterior (unidades laterales)
  spinShare: 0.1,       // fracción de errores que son trompo (error 3)
  spinDurMin: 2.2, spinDurMax: 3.4, spinF: 0.3, // trompo: s a ritmo × spinF
  // Parrilla por defecto
  gridFront: 8, gridGap: 6.5, gridLat: 0.38,
  coolDown: 0.6,
  photoGap: 0.05,
  // Estado del coche (0..1)
  estDefault: 0.88,     // si no se pasa estado
  estPace: 0.015,       // pérdida de ritmo máxima (estado ≤ estLow)
  estFull: 0.95, estLow: 0.4,
  haz0: 0.02, haz1: 1.6, haz2: 7, hazKnee: 0.62, // riesgo integrado de avería por carrera H(e) = h0 + h1(1−e)² + h2·max(0, knee−e)²
  dnfMinD: 250,         // m: ninguna avería antes de esto
  dnfEndGuard: 700,     // m: ni en los últimos metros
  dnfReasonP: [0.35, 0.25, 0.2, 0.2], // motor, caja, suspension, pinchazo
  dnfDecel: [3.2, 4.2, 5.0, 5.5],     // m/s² al quedarse sin empuje
  dnfVmin: 9,           // m/s: sigue rodando hasta llegar al borde
  dnfStopDecel: 7,      // m/s²: ya en el borde, frena hasta pararse
  dnfParkM: 1.0,        // m más allá del borde donde se aparca
  // Coche de seguridad
  scProbDnf: 0.6,       // prob. de SC tras una avería
  scProbSpin: 0.32,     // prob. de SC tras un trompo
  scDelay: 2.5,         // s entre el incidente y la salida del SC
  scMinRemain: 1.15,    // vueltas: el líder debe tener al menos esto por delante
  scSpawnAhead: 230,    // m por delante del líder (sale desde el lateral)
  scV0: 30, scVmax: 50, scCornerF: 0.8, scAcc: 5, scBrake: 12,
  scGapMin: 0.5, scGapMax: 0.8, // s entre coches en la fila
  scTau: 1.1,           // s: suavidad al cerrar el hueco en la fila
  scPace: 0.9,          // ritmo de "bandera amarilla" hasta alcanzar la fila
  scOutMin: 12, scOutMax: 38, // s con luces encendidas (hasta agrupar)
  scInMin: 5, scInMax: 22,    // s con luces apagadas antes de retirarse
  scPitAhead: 0.55,     // vueltas: entra en boxes si la entrada está a menos de esto; si no, se aparta en la siguiente recta
  scStraight: 220,      // m de recta por delante para apartarse
  scNoPass: 150,        // m tras el relanzamiento sin adelantar
  scPitV: 22, scPitT: 4.5, scPitLat: 1.45,
  // Mercado
  exTau2Min: 0.02,      // exacta: discrepancia relativa mínima supuesta entre modelo y MC (más alto = más peso al MC)
};

export const CONDITIONS = {
  seco: {
    weather: 'seco', label: 'Seco', desc: 'Asfalto seco: manda la velocidad punta.',
    gripMul: 1.0, speedMul: 1.0, gripSens: 1.0, spdSens: 1.0, accSens: 1.0,
    errMul: 1.0, varMul: 1.0, draftMul: 1.0, launchMul: 1.0,
  },
  humedo: {
    weather: 'humedo', label: 'Pista mojada', desc: 'Menos agarre para todos: premia a los coches con buen agarre.',
    gripMul: 0.80, speedMul: 0.975, gripSens: 2.0, spdSens: 0.8, accSens: 0.55,
    errMul: 2.3, varMul: 1.3, draftMul: 0.8, launchMul: 1.6,
  },
  viento: {
    weather: 'viento', label: 'Viento', desc: 'Rachas en las rectas: premia la potencia para recuperar velocidad; más imprevisible.',
    gripMul: 0.98, speedMul: 0.985, gripSens: 0.8, spdSens: 1.0, accSens: 1.3,
    errMul: 1.3, varMul: 1.7, draftMul: 0.7, launchMul: 1.0,
  },
};
export const DEFAULT_WEATHER_ODDS = { seco: 0.55, humedo: 0.25, viento: 0.2 };
export const DNF_REASONS = ['motor', 'caja', 'suspension', 'pinchazo'];
export const DNF_LABELS = { motor: 'Avería de motor', caja: 'Caja de cambios', suspension: 'Suspensión rota', pinchazo: 'Pinchazo' };

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

/* ------------------------------------------------- CARRILES LATERALES */
// P(δ, ℓ) = δ + ℓ · g(δ), g = 1 − (|δ|ε − 0)/|LM|ε, con |x|ε = √(x² + ε²) − ε (sin pico en δ = 0)
const LM = 0.95, EPS = 0.06, EPS2 = EPS * EPS, INVQ = 1 / (Math.sqrt(LM * LM + EPS2) - EPS);
function lanePath(d, l) { return d + l * (1 - (Math.sqrt(d * d + EPS2) - EPS) * INVQ); }
/** Carril δ cuyo camino pasa por `lat` cuando la trazada vale `l` (bisección; solo en la parrilla). */
function laneOf(lat, l) {
  let a = -LM, b = LM;
  if (lat <= lanePath(a, l)) return a;
  if (lat >= lanePath(b, l)) return b;
  for (let i = 0; i < 40; i++) { const m = 0.5 * (a + b); if (lanePath(m, l) < lat) a = m; else b = m; }
  return 0.5 * (a + b);
}
function lineAtS(tr, d) {
  const L = tr.length, lp = d - L * Math.floor(d / L);
  let i = (lp / tr.step) | 0; if (i >= tr.N) i = tr.N - 1;
  return tr.line[i];
}

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
/** Remuestreo cíclico lineal de un array a N muestras. */
function resampleCyclic(a, N) {
  const M = a.length, out = new Float32Array(N);
  if (M === N) { out.set(a); return out; }
  for (let i = 0; i < N; i++) {
    const x = (i * M) / N, j = Math.floor(x), f = x - j;
    out[i] = a[j % M] * (1 - f) + a[(j + 1) % M] * f;
  }
  return out;
}

/**
 * buildTrack({ length, k, step, speedScale, line, halfW, w, laps, pit })
 * k: Float32Array con la curvatura con signo (1/m) cada `step` m desde la meta.
 * line: trazada preferida (unidades laterales, + = izquierda). Si falta se deriva de k.
 * w: semiancho por muestra (m) o halfW escalar (m): solo para la separación entre coches.
 * pit: { s0, s1, side } (boxes; opcional) → el coche de seguridad entra en boxes.
 */
export function buildTrack({ length, k, step, speedScale = 1, line, halfW, w, laps, pit } = {}) {
  const T = TUNING, N = k.length;
  if (!step) step = length / N;
  if (!length) length = N * step;
  const s = speedScale;
  const ks = cyclicSmooth(k, Math.round(T.kSmoothM / step));
  const kEff = new Float32Array(N);
  for (let i = 0; i < N; i++) kEff[i] = Math.abs(ks[i]) * T.lineFactor;

  // Trazada: la del circuito si viene; si no, exterior–vértice–exterior derivada de k.
  let ln;
  if (line && line.length) {
    ln = resampleCyclic(line, N);
    for (let i = 0; i < N; i++) ln[i] = clamp(ln[i], -T.latMax, T.latMax);
    ln = cyclicSmooth(ln, Math.max(1, Math.round(2 / step)));
  } else {
    const kw = cyclicSmooth(ks, Math.round(22 / step));
    const D = Math.round(55 / step);
    const raw = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const v = kw[i] - 0.5 * kw[(i + D) % N] - 0.5 * kw[(i - D + N) % N];
      raw[i] = 0.9 * Math.tanh(v * 120);
    }
    ln = cyclicSmooth(cyclicSmooth(raw, Math.round(14 / step)), Math.round(8 / step));
  }
  const lineD = new Float32Array(N); // d(line)/ds (1/m)
  for (let i = 0; i < N; i++) lineD[i] = (ln[(i + 1) % N] - ln[(i - 1 + N) % N]) / (2 * step);
  const lineDs = cyclicSmooth(lineD, Math.max(1, Math.round(2 / step)));

  // Semiancho → separación lateral mínima y lateral de aparcamiento por muestra
  let hw;
  if (w && w.length) hw = resampleCyclic(w, N);
  else hw = new Float32Array(N).fill(typeof halfW === 'number' && halfW > 3 ? halfW : 9);
  const laneW = new Float32Array(N), parkLat = new Float32Array(N), invLatM = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const u = Math.max(hw[i] - 1.2, 2.5);
    invLatM[i] = 1 / u;
    laneW[i] = clamp(T.laneM / u, T.laneMinU, T.laneMaxU);
    parkLat[i] = clamp((hw[i] + T.dnfParkM) / u, 1.15, 1.45);
  }

  // Umbrales (invariantes con speedScale)
  const refG = T.mu0 * G0;
  const cornerK = refG / (0.95 * T.vTop0) ** 2;   // por encima limita la velocidad
  const straightK = cornerK * 0.5;

  // Metros de recta por delante (para que el coche de seguridad se aparte en recta)
  const straightAhead = new Float32Array(N);
  for (let it = 0; it < 2; it++) {
    for (let i = N - 1; i >= 0; i--) {
      const j = i + 1 === N ? 0 : i + 1;
      straightAhead[i] = kEff[i] < straightK ? Math.min(2000, straightAhead[j] + step) : 0;
    }
  }

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
            dir: ks[apex] >= 0 ? 1 : -1, kMax: kMax / T.lineFactor,
            vRef: Math.sqrt(refG / kMax) * s,
            risk: clamp((1 - Math.sqrt(refG / kMax) / T.vTop0) * 2.5, 0.2, 1.5),
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
  let longest = null;
  for (const sc of sectors) if (sc.type === 'recta' && (!longest || sc.length > longest.length)) longest = sc;

  let pitInfo = null;
  if (pit && isFinite(pit.s0)) {
    const s0 = ((pit.s0 % length) + length) % length;
    pitInfo = { s0, s1: pit.s1 != null ? ((pit.s1 % length) + length) % length : null, side: pit.side || -1 };
  }

  return {
    length, step, N, k, kSmooth: ks, kEff, line: ln, lineD: lineDs, halfW: hw, laneW, parkLat, invLatM, straightAhead,
    corners, sectors, longestStraight: longest, laps: laps || 4, pit: pitInfo,
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
/** weatherOdds = { seco, humedo, viento } (se normaliza; por defecto 0.55 / 0.25 / 0.20). */
export function rollConditions(rng, weatherOdds) {
  const o = weatherOdds || DEFAULT_WEATHER_ODDS;
  const ws = ['seco', 'humedo', 'viento'];
  let tot = 0;
  for (const w of ws) tot += Math.max(0, +o[w] || 0);
  if (!(tot > 0)) return rollConditions(rng, DEFAULT_WEATHER_ODDS);
  const r = rng() * tot;
  let acc = 0, pick = 'seco';
  for (const w of ws) { const p = Math.max(0, +o[w] || 0); if (p <= 0) continue; acc += p; pick = w; if (r < acc) break; }
  return { ...CONDITIONS[pick] };
}

/** Efecto de la forma sobre el ritmo (multiplicador de velocidad objetivo). */
export function formPace(f) { return 1 + TUNING.formPace * ((f == null ? 3 : f) - 3); }

/** Efecto del estado (0..1) sobre el ritmo: 0 % con el coche perfecto, −1.5 % muy tocado. */
export function estadoPace(e) {
  const T = TUNING;
  if (e == null) e = T.estDefault;
  return 1 - T.estPace * clamp((T.estFull - e) / (T.estFull - T.estLow), 0, 1);
}
function hazard(e) {
  const T = TUNING, a = 1 - e, b = Math.max(0, T.hazKnee - e);
  return T.haz0 + T.haz1 * a * a + T.haz2 * b * b;
}
/** Probabilidad de avería mecánica en una carrera según el estado. */
export function dnfProbability(e) { return 1 - Math.exp(-hazard(e == null ? TUNING.estDefault : clamp(e, 0, 1))); }

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
      mom = clamp((((n + 1) / 2) - avg) / ((n - 1) / 2), -1, 1);
    }
    out[i] = clamp(Math.round(3 + 0.9 * mom + 0.85 * gauss(rng)), 1, 5);
  }
  return out;
}

/* ----------------------------------------------------- ESTADO DEL COCHE */
const EST_TXT = {
  repaired: { motor: 'Motor reparado tras la avería', caja: 'Caja de cambios nueva', suspension: 'Suspensión reconstruida', pinchazo: 'Neumáticos y llantas nuevos' },
  damaged: { motor: 'Motor tocado tras la avería', caja: 'Caja de cambios tocada', suspension: 'Suspensión dañada', pinchazo: 'Llanta dañada en el pinchazo' },
};
/**
 * Estado (0..1) de cada coche para la próxima carrera.
 * prevEstado: array del estado anterior (o null en la primera carrera).
 * lastResults: resultados de la última carrera en cualquiera de estas formas:
 *   race.results ([{ car, dnf, reason }] en orden de clasificación) · finishOrder ([car, ...]) ·
 *   por coche ([{ pos, dnf, reason }]).
 * → { estado: [..], notes: [{ car, text, effect (Δ estado con signo), tone: 'bueno'|'malo' }] }
 */
export function rollEstado(rng, prevEstado, lastResults, nCars) {
  const n = nCars || (prevEstado && prevEstado.length) || (lastResults && lastResults.length) || 6;
  const info = [];
  for (let i = 0; i < n; i++) info.push({ pos: 0, dnf: false, reason: null });
  if (Array.isArray(lastResults) && lastResults.length) {
    if (typeof lastResults[0] === 'number') lastResults.forEach((c, p) => { if (info[c]) info[c].pos = p + 1; });
    else if (lastResults[0] && lastResults[0].car != null) {
      lastResults.forEach((r, p) => { const o = info[r.car]; if (o) { o.pos = r.pos || p + 1; o.dnf = !!r.dnf; o.reason = r.reason || null; } });
    } else lastResults.forEach((r, i) => { if (info[i] && r) { info[i].pos = r.pos || 0; info[i].dnf = !!r.dnf; info[i].reason = r.reason || null; } });
  }
  const estado = new Array(n), notes = [];
  const note = (car, text, effect, tone) => notes.push({ car, text, effect: Math.round(effect * 100) / 100, tone: tone || (effect >= 0 ? 'bueno' : 'malo') });
  for (let i = 0; i < n; i++) {
    const prev = prevEstado && prevEstado[i] != null ? clamp(+prevEstado[i], 0, 1) : null;
    const u1 = rng(), u2 = rng(), u3 = rng(), g = gauss(rng);
    let e;
    if (prev == null) {
      e = clamp(0.84 + 0.075 * g, 0.55, 1);
      if (u1 < 0.08) { e = 0.97 + 0.03 * u2; note(i, 'Motor nuevo', e - 0.84); }
      else if (e < 0.66) note(i, 'Llega con el coche tocado', e - 0.84);
      estado[i] = Math.round(e * 100) / 100;
      continue;
    }
    const o = info[i];
    // desgaste de la carrera + mantenimiento del equipo (vuelve hacia 0.86) + ruido
    e = prev - (0.02 + 0.025 * u3) + 0.35 * (0.86 - prev) + 0.03 * g;
    let noted = false;
    if (o.dnf) {
      const why = o.reason && EST_TXT.repaired[o.reason] ? o.reason : 'motor';
      const fixP = why === 'pinchazo' ? 0.85 : 0.55;
      if (u1 < fixP) { e = Math.max(0.86 + 0.1 * u2, prev + 0.02); note(i, EST_TXT.repaired[why], e - prev, 'bueno'); }
      else { e = Math.min(0.46 + 0.18 * u2, prev - 0.05); note(i, EST_TXT.damaged[why], e - prev, 'malo'); }
      noted = true;
    } else if (u1 < 0.07) {
      e = 0.97 + 0.03 * u2; note(i, 'Motor nuevo', e - prev); noted = true;
    } else if (o.pos >= n - 1 && u1 < 0.25) {
      e -= 0.07 + 0.08 * u2; note(i, u2 < 0.5 ? 'Problemas de fiabilidad' : 'Golpe en el alerón', e - prev); noted = true;
    } else if (u1 > 0.94) {
      e += 0.06 + 0.05 * u2; note(i, u2 < 0.5 ? 'Alerón reparado' : 'Revisión a fondo en el taller', e - prev); noted = true;
    }
    e = clamp(e, 0.38, 1);
    if (!noted) {
      if (e - prev <= -0.1) note(i, 'Desgaste acusado', e - prev);
      else if (e - prev >= 0.1) note(i, 'Puesta a punto completa', e - prev);
      else if (e < 0.6) note(i, 'Sigue con problemas mecánicos', e - prev);
    }
    estado[i] = Math.round(e * 100) / 100;
  }
  return { estado, notes };
}

/* ---------------------------------------------------- PARÁMETROS DE COCHE */
export function carParams(car, track, cond = CONDITIONS.seco, form = 3, estado) {
  const T = TUNING, s = 1; // la física va siempre a escala 1; speedScale solo comprime el tiempo en Race
  const rs = (car.spd - 80) / 100, ra = (car.acc - 80) / 100, rg = (car.grip - 80) / 100;
  const vTop = T.vTop0 * s * (1 + T.kSpd * cond.spdSens * rs) * cond.speedMul;
  const mu = T.mu0 * cond.gripMul * (1 + T.kGrip * cond.gripSens * rg);
  const cornerG = mu * G0 * s * s;
  const brakeD = T.brakeK * cornerG;
  const P = T.power0 * s * s * s * (1 + T.kAcc * cond.accSens * ra);
  const aTrac = T.trac0 * s * s * Math.min(1, 0.35 + 0.65 * cond.gripMul) *
    (1 + T.kTracAcc * T.kAcc * cond.accSens * ra + T.kTracGripWet * T.kGrip * (cond.gripSens - 1) * rg);
  const errP = T.errBase * cond.errMul * Math.max(0.25, 1 - T.errGripK * rg * cond.gripSens);
  const launchMean = T.launchBase + T.launchAccK * ra * cond.accSens - 0.02 * (cond.launchMul - 1);
  const prof = carProfile(track, cornerG, brakeD);
  return {
    vTop, mu, cornerG, brakeD, P, aTrac, errP, launchMean,
    launchSigma: T.launchSigma * cond.launchMul,
    form: formPace(form) * estadoPace(estado),
    prof,
    ideal: idealProfile(track, prof, vTop, P, aTrac),
  };
}

/* =================================================================== CORE
   Un solo modelo para la carrera en pantalla y para el Monte Carlo.
   ======================================================================== */
class Core {
  constructor({ cars, track, laps, grid, gridOffsets, cond = CONDITIONS.seco, form, estado, fast = false, dt, incidents = true }) {
    const n = cars.length;
    laps = laps || track.laps || 4;
    this.n = n; this.track = track; this.laps = laps; this.cond = cond; this.fast = fast; this.incidents = incidents;
    this.L = track.length; this.raceLen = laps * track.length;
    this.h = dt || TUNING.simDt;
    this.grid = grid ? grid.slice() : cars.map((_, i) => i);
    const est = (this.estado = new Float64Array(n));
    for (let i = 0; i < n; i++) est[i] = clamp(estado && estado[i] != null ? +estado[i] : TUNING.estDefault, 0, 1);
    this.par = cars.map((c, i) => carParams(c, track, cond, form ? form[i] : 3, est[i]));
    const F = (m = 1) => new Float64Array(n * m);
    this.pV = Float64Array.from(this.par, (p) => p.vTop); this.pB = Float64Array.from(this.par, (p) => p.brakeD);
    this.pP = Float64Array.from(this.par, (p) => p.P); this.pA = Float64Array.from(this.par, (p) => p.aTrac);
    this.pE = Float64Array.from(this.par, (p) => p.errP); this.profs = this.par.map((p) => p.prof);
    this.haz = Float64Array.from(est, (e) => hazard(e));
    this.pv = F(); this.plv = F(); this.pthr = F(); this.pbrk = F(); this.pslip = F(); this.prpm = F();
    this.near = new Int32Array(n + 1);
    this.press = F(); this.pressThr = F(); this.pressOn = new Int32Array(n); this.yieldTo = new Int32Array(n);
    this.ideal = this.par.map((p) => p.ideal);
    this.dist = F(); this.v = F(); this.lat = F(); this.latV = F(); this.pd = F(); this.pl = F();
    this.lane = F(); this.laneV = F(); this.passedBy = new Int32Array(n); this.gridLane = F();
    this.react = F(); this.launchQ = F(); this.pm = F(); this.lapN = F(laps + 1);
    this.finT = F(); this.fin = new Uint8Array(n);
    this.errT = F(); this.errF = F(); this.errDir = F(); this.errKind = new Uint8Array(n); this.errAge = F(); this.errLat = F();
    this.nextC = F(); this.cIdx = new Int32Array(n);
    this.passT = new Int32Array(n); this.passSide = F(); this.passTime = F();
    this.draft = F();
    this.est = new Uint32Array(n + 1);   // flujos aleatorios por coche (+1 de carrera: coche de seguridad)
    this.ord = new Int32Array(n); this.finOrd = new Int32Array(n);
    // averías
    this.state = new Uint8Array(n);      // 0 en carrera, 1 averiado (rodando hacia el borde), 2 aparcado
    this.dFail = F(); this.reason = new Uint8Array(n); this.dnfT = F(); this.dnfD = F(); this.parkS = F();
    this.dnfOrd = new Int32Array(n); this.scGapT = F();
    // cosmética (solo carrera en pantalla)
    this.thr = F(); this.brk = F(); this.slip = F(); this.gear = new Int32Array(n); this.rpm = F();
    this.rank = new Int32Array(n); this.lastDraftEv = F();
    const ns = Math.ceil(this.raceLen / 5) + 2;
    this.reach = fast ? null : new Float64Array(ns);
    this.events = fast ? null : [];
    this.gridOffsets = [];
    for (let g = 0; g < n; g++) {
      const go = gridOffsets && gridOffsets[g];
      this.gridOffsets.push(go ? { dist: go.dist != null ? go.dist : go.s, lateral: go.lateral != null ? go.lateral : go.lat }
        : { dist: -(TUNING.gridFront + TUNING.gridGap * g), lateral: (g % 2 === 0 ? -1 : 1) * TUNING.gridLat });
    }
    this.gearTop = [0.30, 0.45, 0.59, 0.72, 0.86, 1.0];
    // perfil de referencia del coche de seguridad
    const refG = TUNING.mu0 * cond.gripMul * G0;
    this.scProf = carProfile(track, refG, TUNING.brakeK * refG * 0.55);
  }

  reset(seed) {
    const T = TUNING, n = this.n, cond = this.cond, laps = this.laps, L = this.L;
    const r = makeRng(seed);
    this.t = 0; this.nFin = 0; this.nDnf = 0; this.seed = seed >>> 0;
    for (let c = 0; c < n; c++) {
      const p = this.par[c];
      this.react[c] = T.reactMin + (T.reactMax - T.reactMin) * r();
      this.launchQ[c] = clamp(p.launchMean + p.launchSigma * gauss(r), 0.7, 1.06);
      this.pm[c] = p.form * (1 + T.daySigma * gauss(r));
      for (let l = 0; l <= laps; l++) this.lapN[c * (laps + 1) + l] = 1 + T.lapSigma * cond.varMul * gauss(r);
      this.est[c] = hashSeed(seed, c + 101);
    }
    // averías (distancia a la que falla cada coche), motivo y hueco en la fila del SC
    const dMax = Math.max(T.dnfMinD, this.raceLen - T.dnfEndGuard);
    for (let c = 0; c < n; c++) {
      const u = r(), ur = r(), ug = r();
      let df = Infinity;
      if (this.incidents) {
        const x = -Math.log(1 - u) / this.haz[c];  // en fracciones de carrera (riesgo uniforme en distancia)
        if (x < 1) df = clamp(x * this.raceLen, T.dnfMinD, dMax);
      }
      this.dFail[c] = df;
      let q = 0, acc = T.dnfReasonP[0];
      while (ur > acc && q < 3) acc += T.dnfReasonP[++q];
      this.reason[c] = q;
      this.scGapT[c] = T.scGapMin + (T.scGapMax - T.scGapMin) * ug;
    }
    this.est[n] = hashSeed(seed, 977);
    this.state.fill(0);
    // coche de seguridad
    this.scPh = 0; this.scReq = 0; this.scUsed = 0; this.scCause = 0; this.scCar = -1; this.scSide = -1;
    this.scD = this.scV = this.scL = this.scLV = this.scT = 0; this.scPD = this.scPL = this.scPV = this.scPLV = 0;
    this.scRestarted = 0; this.scOff = 0; this.scOffT = 0; this.scPit = -1; this.noPassD = -1e9; this.scCount = 0;
    const corners = this.track.corners, nc = corners.length;
    for (let g = 0; g < n; g++) {
      const c = this.grid[g];
      const d = this.gridOffsets[g].dist;
      this.dist[c] = d; this.pd[c] = d;
      const lat = this.gridOffsets[g].lateral;
      this.lat[c] = lat; this.pl[c] = lat; this.latV[c] = 0;
      this.lane[c] = laneOf(lat, lineAtS(this.track, d)); this.laneV[c] = 0; this.gridLane[c] = this.lane[c];
      this.v[c] = 0; this.fin[c] = 0; this.finT[c] = 0;
      this.errT[c] = 0; this.errF[c] = 1; this.errKind[c] = 0; this.errAge[c] = 9; this.errLat[c] = 0.85;
      this.passT[c] = -1; this.passTime[c] = 0; this.draft[c] = 0;
      this.press[c] = 0; this.pressOn[c] = -1; this.yieldTo[c] = -1;
      this.pressThr[c] = -Math.log(1 - mbNext(this.est, c)) * T.passCost;
      this.thr[c] = 0; this.brk[c] = 0; this.slip[c] = 0; this.gear[c] = 1; this.rpm[c] = 0.18;
      this.lastDraftEv[c] = -99; this.dnfT[c] = 0; this.dnfD[c] = 0; this.parkS[c] = 0;
      this.ord[g] = c; this.rank[g] = c;
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

  _lapOf(d) { return Math.max(1, Math.min(this.laps, Math.floor(d / this.L) + 1)); }

  /** Avería mecánica: el coche se queda sin empuje y busca el borde más cercano. */
  _fail(c, i0) {
    const T = TUNING, tr = this.track;
    this.state[c] = 1; this.dnfOrd[this.nDnf++] = c;
    this.dnfT[c] = this.t; this.dnfD[c] = this.dist[c];
    const side = this.lat[c] >= 0 ? 1 : -1;
    this.parkS[c] = side * tr.parkLat[i0];
    this.passT[c] = -1; this.errT[c] = 0; this.yieldTo[c] = -1;
    if (!this.fast) this._ev('dnf', c, -1, { reason: DNF_REASONS[this.reason[c]], lap: this._lapOf(this.dist[c]) });
    this._scRequest(T.scProbDnf, 1, c, -side);
  }

  _scRequest(p, cause, c, side) {
    if (!this.incidents || this.scUsed || this.scPh || this.scReq) return;
    if (mbNext(this.est, this.n) < p) {
      this.scUsed = 1; this.scReq = this.t + TUNING.scDelay; this.scCause = cause; this.scCar = c; this.scSide = side;
    }
  }

  /** Coche de seguridad: salida, fila, luces apagadas, retirada y relanzamiento. */
  _scStep(h, t) {
    const T = TUNING, n = this.n, tr = this.track, L = this.L, N = tr.N, invStep = 1 / tr.step;
    const dist = this.dist, state = this.state, fin = this.fin;
    let ld = -1, lD = -1e9;
    for (let c = 0; c < n; c++) if (state[c] === 0 && !fin[c] && dist[c] > lD) { lD = dist[c]; ld = c; }
    this.scPD = this.scD; this.scPL = this.scL; this.scPV = this.scV; this.scPLV = this.scLV;
    if (this.scPh === 0) {
      if (this.scReq > 0 && t >= this.scReq) {
        this.scReq = 0;
        if (ld < 0 || this.nFin > 0 || this.raceLen - lD < T.scMinRemain * L) { this.scUsed = 0; return; }
        this.scPh = 1; this.scT = 0; this.scCount++;
        if (tr.pit) this.scSide = tr.pit.side < 0 ? -1 : 1;  // sale por el lado de boxes
        this.scD = lD + T.scSpawnAhead; this.scV = T.scV0; this.scL = this.scSide * 1.25; this.scLV = 0;
        this.scRestarted = 0; this.scOff = 0; this.scPit = -1;
        this.scPD = this.scD; this.scPL = this.scL; this.scPV = this.scV; this.scPLV = 0;
        if (!this.fast) this._ev('sc_start', this.scCar, -1, { reason: this.scCause === 1 ? 'dnf' : 'spin', lap: this._lapOf(lD) });
      }
      return;
    }
    if (this.scPh >= 4) return;
    this.scT += h;
    const s = this.scD, vc = this.scV;
    const lp = s - L * Math.floor(s / L);
    let i = (lp * invStep) | 0; if (i >= N) i = N - 1;
    // velocidad objetivo
    let vt;
    if (this.scOff) vt = T.scPitV;
    else {
      let il = ((lp + vc * 0.6) * invStep) | 0; if (il >= N) il -= N; if (il >= N) il = N - 1;
      vt = Math.min(T.scVmax, this.scProf[il] * T.scCornerF);
      if (ld >= 0 && this.scPh < 3) { const gl = s - lD; if (gl > 150) vt *= clamp(1 - (gl - 150) / 300, 0.55, 1); }
    }
    let vn = vc;
    if (vn < vt) { vn += T.scAcc * h; if (vn > vt) vn = vt; } else { vn -= T.scBrake * h; if (vn < vt) vn = vt; }
    const d1 = s + 0.5 * (vc + vn) * h;
    // lateral: trazada; al retirarse, hacia el lado de boxes
    let lp1 = lp + (d1 - s); if (lp1 >= L) lp1 -= L;
    let x = lp1 * invStep, j0 = x | 0; if (j0 >= N) j0 = N - 1; const fr = x - j0, j1 = j0 + 1 >= N ? 0 : j0 + 1;
    const lineN = tr.line[j0] + (tr.line[j1] - tr.line[j0]) * fr, ff = tr.lineD[j0] * vn;
    const latT = this.scPh === 3 ? this.scSide * T.scPitLat : lineN;
    const lineO = tr.line[i], ffO = tr.lineD[i] * vc;
    const dl0 = this.scL - lineO, dv0 = this.scLV - ffO, e = latT - lineN - dl0, ae = e < 0 ? -e : e;
    let dvd = ae > 1e-6 ? Math.min(T.latKp * ae, Math.sqrt(1.8 * T.latAcc * ae)) * (e < 0 ? -1 : 1) : 0;
    const rt = Math.min(T.latRateStraight, 0.15 * vn * tr.invLatM[i]);
    if (dvd > rt) dvd = rt; else if (dvd < -rt) dvd = -rt;
    let dv1 = dv0 + clamp(dvd - dv0, -T.latAcc * h, T.latAcc * h);
    const dl1 = dl0 + 0.5 * (dv0 + dv1) * h;
    this.scD = d1; this.scV = vn; this.scL = lineN + dl1; this.scLV = ff + dv1;
    // fases
    const remain = this.raceLen - lD;
    if (this.scPh === 1) {
      if ((this.scT >= T.scOutMin && this._bunched()) || this.scT >= T.scOutMax || remain < 0.5 * L) {
        this.scPh = 2; this.scT = 0;
        // ¿boxes cerca? si no, se aparta en la siguiente recta
        if (tr.pit) {
          let g = tr.pit.s0 - lp; if (g < 60) g += L;
          this.scPit = g < T.scPitAhead * L ? s + g : -1;
          if (this.scPit > 0) this.scSide = tr.pit.side < 0 ? -1 : 1;
        }
        if (!this.fast) this._ev('sc_in', -1, -1, { lap: this._lapOf(lD), pit: this.scPit > 0 });
      }
    } else if (this.scPh === 2) {
      const ready = this.scT >= T.scInMin;
      let go;
      if (this.scPit > 0) go = d1 >= this.scPit - 40 || this.scT >= T.scInMax + 25;
      else go = ready && (tr.straightAhead[i] >= T.scStraight || this.scT >= T.scInMax);
      if (go || remain < 400) { this.scPh = 3; this.scT = 0; }
    } else if (this.scPh === 3) {
      const al = this.scL < 0 ? -this.scL : this.scL;
      if (!this.scRestarted && al >= 1.05) {
        this.scRestarted = 1; this.noPassD = lD + T.scNoPass;
        if (!this.fast) this._ev('sc_end', ld, -1, { lap: this._lapOf(lD) });
      }
      if (this.scRestarted && !this.scOff && al >= 1.3) { this.scOff = 1; this.scOffT = this.scT; }
      if (this.scOff && this.scT - this.scOffT >= T.scPitT) this.scPh = 4;
    }
  }

  /** ¿Fila agrupada detrás del SC? */
  _bunched() {
    const T = TUNING, n = this.n, ord = this.ord, dist = this.dist, v = this.v;
    let pD = this.scD, pV = this.scV;
    for (let k = 0; k < n; k++) {
      const c = ord[k];
      if (this.state[c] !== 0 || this.fin[c]) continue;
      const g = pD - dist[c];
      if (g > Math.max(this.scGapT[c] * pV, T.carLen + 3) + 16) return false;
      pD = dist[c]; pV = v[c];
    }
    return true;
  }

  step() {
    const T = TUNING, n = this.n, tr = this.track, L = this.L, N = tr.N, step = tr.step, invStep = 1 / step;
    const dist = this.dist, v = this.v, lat = this.lat, latV = this.latV, ord = this.ord, state = this.state;
    const react = this.react, fin = this.fin, errT = this.errT, passT = this.passT;
    const pV = this.pV, pB = this.pB, pP = this.pP, pA = this.pA, profs = this.profs;
    const h = this.h, t = this.t + h, fast = this.fast, cond = this.cond;
    const kEff = tr.kEff, line = tr.line, lineD = tr.lineD, laneW = tr.laneW, cornerK = tr.cornerK, straightK = tr.straightK;
    const carLen = T.carLen, laps = this.laps, laps1 = laps + 1;
    const draftK = T.draft * cond.draftMul, dMin = T.draftMin, dSpan = T.draftMax - T.draftMin;
    const gapMin = T.gapMin, invTau = 1 / T.followTau, passRange = T.passRange, passMargin = T.passMargin;
    const sepD = carLen + 0.6, near = this.near;
    const Kp = T.latKp, aLat = T.latAcc, aKnee = (1.8 * aLat) / (Kp * Kp); // por debajo de aKnee manda Kp·e
    const aDev = T.latAccDev, dKnee = (1.8 * aDev) / (Kp * Kp);
    const angLo = Math.tan(T.latAngLow * Math.PI / 180), angHi = Math.tan(T.latAngHigh * Math.PI / 180), angInvDv = 1 / (T.latAngV1 - T.latAngV0);
    const invLatM = tr.invLatM;
    const pmA_ = this.pm, lapN = this.lapN, errF = this.errF, yieldTo = this.yieldTo, passSide = this.passSide;
    const kSmooth = tr.kSmooth, ideal = this.ideal, press = this.press, launchQ = this.launchQ;
    const lane = this.lane, laneV = this.laneV, passedBy = this.passedBy;
    this.t = t;

    // orden por distancia (inserción: n pequeño, casi ordenado)
    for (let i = 1; i < n; i++) {
      const c = ord[i], d = dist[c];
      let j = i - 1;
      while (j >= 0 && dist[ord[j]] < d) { ord[j + 1] = ord[j]; j--; }
      ord[j + 1] = c;
    }
    // instantánea al inicio del paso
    const pd = this.pd, pl = this.pl;
    for (let c = 0; c < n; c++) { pd[c] = dist[c]; pl[c] = lat[c]; }
    if (!fast) { this.pv.set(v); this.plv.set(latV); this.pthr.set(this.thr); this.pbrk.set(this.brk); this.pslip.set(this.slip); this.prpm.set(this.rpm); }
    // ¿a quién están adelantando? (el adelantado se aparta al carril contrario mientras van a la par)
    passedBy.fill(-1);
    for (let o = 0; o < n; o++) {
      const tg = passT[o];
      if (tg < 0 || state[tg]) continue;
      const dd = pd[o] - pd[tg];
      if (dd > -(T.carLen + 7) && dd < T.carLen + 2) { const cur = passedBy[tg]; if (cur < 0 || Math.abs(pd[cur] - pd[tg]) > Math.abs(dd)) passedBy[tg] = o; }
    }

    // coche de seguridad
    if (this.scPh > 0 || this.scReq > 0) this._scStep(h, t);
    const scPh = this.scPh;
    const scQueue = scPh >= 1 && scPh <= 3 && !this.scRestarted;
    const scObs = scPh >= 1 && scPh <= 3;
    let qD = this.scPD, qV = this.scV;     // predecesor en la fila (empieza por el SC)
    const noPassD = this.noPassD;

    for (let k = 0; k < n; k++) {
      const c = ord[k];
      const st = state[c];
      if (st === 2) continue;
      const rc = react[c];
      if (t <= rc) continue;
      const hc = t - rc < h ? t - rc : h;
      const s = dist[c], vc = v[c], latc = lat[c], finc = fin[c];
      const lapF = Math.floor(s / L);
      const lp = s - L * lapF;
      let i0 = (lp * invStep) | 0; if (i0 >= N) i0 = N - 1;
      const kHere = kEff[i0];
      const inCorner = kHere > cornerK;
      const W = laneW[i0];

      // ritmo
      const lapNo = lapF < 0 ? 0 : lapF > laps ? laps : lapF;
      let pm = pmA_[c] * lapN[c * laps1 + lapNo];
      if (finc) pm *= T.coolDown;
      let ef = 1;
      const et = errT[c];
      if (et > 0) { ef = errF[c]; errT[c] = et - hc; }

      // vecinos (lista ordenada por distancia): delante en mi carril, rebufo, a la par, obstáculos
      let aL = -1, gL = 1e9, aD = -1, gD = 1e9, nNear = 0;
      let bLo = -T.latMax, bHi = T.latMax;
      for (let j = k - 1; j >= 0; j--) {
        const o = ord[j], g = pd[o] - s;
        if (g > 200) break;
        if (g < sepD) near[nNear++] = o;
        const so = state[o], lo = pl[o];
        if (so === 2 || (so === 1 && (lo > 1.02 || lo < -1.02))) {
          // coche averiado fuera de la trazada: limita el lado por el que se pasa
          if (g < 90 && g > -sepD) {
            if (lo > 0) { const b = lo - W * 1.1; if (b < bHi) bHi = b; } else { const b = lo + W * 1.1; if (b > bLo) bLo = b; }
          }
          continue;
        }
        if (g <= 0) continue;
        let dl = lo - latc; if (dl < 0) dl = -dl;
        if (dl < 1.5 * W) {
          if (g < gD && so === 0) { gD = g; aD = o; }
          if (dl < W && g < gL) { gL = g; aL = o; }
        }
      }
      for (let j = k + 1; j < n; j++) {
        const o = ord[j], g = pd[o] - s;
        if (g <= -sepD) break;
        near[nNear++] = o;
        if (state[o] === 2 && g > -sepD) { const lo = pl[o]; if (lo > 0) { const b = lo - W * 1.1; if (b < bHi) bHi = b; } else { const b = lo + W * 1.1; if (b > bLo) bLo = b; } }
      }
      if (scObs && this.scL * this.scL > 0.81) {
        // el SC apartándose hacia boxes también es un obstáculo lateral
        const g = this.scPD - s;
        if (g < 90 && g > -sepD) { const lo = this.scPL; if (lo > 0) { const b = lo - W * 1.1; if (b < bHi) bHi = b; } else { const b = lo + W * 1.1; if (b > bLo) bLo = b; } }
      }
      const vs = vc > 10 ? vc : 10;

      // velocidad objetivo (perfil curva + frenada) en el punto donde estaré
      let la = (lp + vc * hc) * invStep; if (la >= N) la -= N;
      let j0 = la | 0; const fr = la - j0; if (j0 >= N) j0 = N - 1;
      const j1 = j0 + 1 >= N ? 0 : j0 + 1;
      const prof = profs[c];
      let vtC = (prof[j0] + (prof[j1] - prof[j0]) * fr) * pm * ef;

      let vn, braking = 0, held = false, vDes = 0, draft = 0, vTopE = pV[c];
      let pt = passT[c];
      const passOK = !scQueue && s > noPassD;
      if (st === 1) {
        // ---- avería: sin empuje, rueda hasta el borde y se para
        const tgt = this.parkS[c];
        const atEdge = tgt > 0 ? latc >= tgt - 0.05 : latc <= tgt + 0.05;
        const dec = atEdge ? T.dnfStopDecel : T.dnfDecel[this.reason[c]];
        let vt = vc - dec * hc;
        if (!atEdge && vt < T.dnfVmin) vt = vc < T.dnfVmin ? vc : T.dnfVmin;
        if (vt > vtC * 0.95) vt = Math.max(vtC * 0.95, vc - pB[c] * hc);
        if (aL >= 0 && gL < 60) {
          let vmax = v[aL] + (gL - gapMin) * invTau;
          if (vmax < vc - 1.3 * pB[c] * hc) vmax = vc - 1.3 * pB[c] * hc;
          if (vt > vmax) vt = vmax;
        }
        if (vt < 0) vt = 0;
        vn = vt;
        braking = vc > vn ? Math.min(1, (vc - vn) / (pB[c] * hc)) : 0;
        pt = passT[c] = -1;
      } else {
        // rebufo
        if (!scQueue && aD >= 0 && !finc && kHere < straightK) {
          const tg = gD / vs - dMin;
          if (tg > 0 && tg < dSpan) draft = draftK * (1 - tg / dSpan);
        }
        if (!fast) {
          if (draft > 0.01 && this.draft[c] <= 0.01 && t - this.lastDraftEv[c] > 10 && t > 4) {
            this._ev('drafting', c, aD); this.lastDraftEv[c] = t;
          }
          this.draft[c] = draft;
        }
        vTopE = pV[c] * pm * (1 + draft) * ef;
        // cede ante un adelantamiento ya "ganado" por presión
        const yt = this.yieldTo[c];
        if (yt >= 0) {
          if (passT[yt] !== c || scQueue) this.yieldTo[c] = -1;
          else {
            const dl = pl[yt] - latc;
            if ((dl > 0.3 || dl < -0.3) && pd[yt] - s > -(carLen + 1.5) && vc > 0.4 * pV[c]) {
              const cap = vc - T.yieldDecel * hc; if (vtC > cap) vtC = cap > 0 ? cap : 0;
              if (DBG) DBG.yields++;
            }
          }
        }
        if (inCorner) {
          let dev = (line[i0] - latc) * (tr.kSmooth[i0] >= 0 ? 1 : -1);
          if (dev < 0) dev = -dev * T.offLineIn;
          dev -= 0.25;
          if (dev > 0) vtC *= 1 - T.offLinePen * (dev > 0.5 ? 1 : dev * 2);
          if (aL >= 0 && gL < vs * 0.8) {
            vtC *= 1 - T.dirtyPen * (1 - gL / (vs * 0.8));
            const cap = v[aL] + T.dirtyMargin; if (vtC > cap) vtC = cap;
          }
        }
        if (scQueue && !finc) vtC *= T.scPace;

        // dinámica longitudinal
        if (vc > vtC) {
          const bd = pB[c] * hc;
          vn = vc - bd;
          if (vn < vtC) vn = vtC;
          braking = (vc - vn) / bd;
        } else {
          const P = pP[c], iv3 = 1 / (vTopE * vTopE * vTopE);
          let tl = pA[c];
          if (t - rc < 3.5 && vc < 0.5 * pV[c]) tl *= launchQ[c];
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
        vDes = vn;
        // no atravesar al de delante
        if (aL >= 0 && gL < 60 && !(pt === aL && Math.abs(pl[aL] - latc) > T.passFree)) {
          let vmax = v[aL] + (gL - gapMin) * invTau;
          if (vmax < 0) vmax = 0;
          if (vmax < vc - 1.3 * pB[c] * hc) vmax = vc - 1.3 * pB[c] * hc;
          if (vn > vmax) { vn = vmax; held = true; if (DBG) DBG.heldSteps++; }
        }
        // fila detrás del coche de seguridad: hueco de 0.5–0.8 s con el de delante
        if (scQueue && !finc) {
          const gq = qD - s;
          if (gq > 0) {
            let want = this.scGapT[c] * qV; if (want < carLen + 3) want = carLen + 3; // hueco morro-morro 0.5–0.8 s
            let vmax = qV + (gq - want) / T.scTau;
            if (vmax < 0) vmax = 0;
            if (vmax < vc - 1.3 * pB[c] * hc) vmax = vc - 1.3 * pB[c] * hc;
            if (vn > vmax) { vn = vmax; held = true; }
          }
          qD = s; qV = vn;
          pt = passT[c] = -1;
        }
      }
      v[c] = vn;
      const d1 = s + (vc + vn) * 0.5 * hc;
      dist[c] = d1;

      // presión y adelantamientos (no bajo coche de seguridad ni nada más relanzar)
      if (st === 0) {
        let grant = false;
        if (pt < 0 && passOK) {
          const press = this.press;
          if (aL >= 0 && !finc && gL < vs * T.pressGap && vc > 0.5 * pV[c]) {
            if (this.pressOn[c] !== aL) { this.pressOn[c] = aL; press[c] = 0; }
            const lfA = Math.floor(pd[aL] / L);
            let pmA = this.pm[aL] * this.lapN[aL * laps1 + (lfA < 0 ? 0 : lfA > laps ? laps : lfA)];
            if (errT[aL] > 0) pmA *= this.errF[aL];
            if (fin[aL]) pmA *= T.coolDown;
            const adv = this.ideal[c][i0] * pm * ef * (1 + draft) - (state[aL] ? 0 : this.ideal[aL][i0] * pmA);
            if (adv > 0) press[c] += adv * hc;
            if (press[c] >= this.pressThr[c]) grant = true;
          } else if (press[c] > 0) press[c] *= 1 - hc / T.pressDecay;
        } else if (!passOK) { this.press[c] = 0; this.pressOn[c] = -1; }
        const canPass = passOK || (aL >= 0 && state[aL] === 1);
        if (pt < 0 && canPass && aL >= 0 && !finc && gL < passRange &&
            (grant || ((T.passInCorner || !inCorner) && (vDes > v[aL] + passMargin || this.raceLen - s < T.finalAttack)))) {
          const kNext = tr.kSmooth[(i0 + Math.round(120 * invStep)) % N];
          let best = 0, bestScore = -1e9;
          for (let sd = -1; sd <= 1; sd += 2) {
            const target = sd * T.passLane;
            if ((target - bLo) * (bHi - target) < 0) continue;  // lado bloqueado por un coche parado
            if ((pl[aL] - target) * sd > -W * 0.8 && !grant) continue;
            let ok = true;
            for (let o = 0; o < n; o++) {
              if (o === c || o === aL || state[o] === 2) continue;
              const dd = pd[o] - s;
              if (dd < T.passRoom && dd > -T.passRoom && Math.abs(pl[o] - target) < W) { ok = false; break; }
            }
            if (!ok) continue;
            const score = -Math.abs(target - latc) + (kNext * sd > 0 ? T.passInsideBias : 0);
            if (score > bestScore) { bestScore = score; best = sd; }
          }
          if (best) {
            pt = passT[c] = aL; this.passSide[c] = best; this.passTime[c] = 0; if (DBG) DBG.start++;
            if (passT[aL] === c) passT[aL] = -1;
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
          if (gp < -(carLen + 1) || ptm > T.passTimeout || gp > passRange + 6 || (scQueue && state[pt] === 0)) {
            if (DBG) { if (gp < 0) DBG.done++; else if (ptm > T.passTimeout) DBG.timeout++; else DBG.fellBack++; }
            pt = passT[c] = -1;
          }
        }
      }

      // ---- lateral. Cada coche lleva un "carril" δ ∈ [−0.95, 0.95] (estado suave de 2º orden):
      // camino P(δ, s) = δ + trazada(s) · g(δ), g = 1 − |δ|ε/|0.95|ε → δ = 0 es la trazada; δ = ±0.5 son dos
      // copias comprimidas de la trazada que se mueven en paralelo (el que adelanta y el adelantado);
      // ±0.95 son los bordes. Lo que queda fuera de pista (trompos, averías) es una desviación extra.
      // Posición y velocidad lateral continuas (aceleración limitada en δ y en la desviación).
      const inErr = errT[c] > 0;
      let tgtL = s < T.fanOut ? this.gridLane[c] : 0;  // objetivo en "carril" (puede pasar de ±0.95: el resto es desviación)
      if (st === 1) tgtL = this.parkS[c];
      else if (inErr) tgtL = this.errDir[c] * this.errLat[c];
      else if (pt >= 0) tgtL = this.passSide[c] * T.passLane;
      else if (!scQueue && this.yieldTo[c] >= 0) tgtL = -this.passSide[this.yieldTo[c]] * T.passLane;
      else if (!scQueue && passedBy[c] >= 0) tgtL = -this.passSide[passedBy[c]] * T.passLane; // le adelantan: deja el otro carril
      const dTl = tgtL > LM ? LM : tgtL < -LM ? -LM : tgtL;
      let devT = tgtL - dTl;
      const outside = latc > T.latLimit || latc < -T.latLimit;
      let rt = inCorner ? T.latRateCorner : T.latRateStraight;
      if (st === 1 || inErr || outside) rt *= 1.3;
      // ángulo máximo de la trayectoria según la velocidad (salida recta; en errores/averías se permite el doble)
      const angT = vn <= T.latAngV0 ? angLo : vn >= T.latAngV1 ? angHi : angLo + (angHi - angLo) * (vn - T.latAngV0) * angInvDv;
      const rv = angT * vn * invLatM[i0] * (st === 1 || inErr ? 2 : 1);
      if (rt > rv) rt = rv;
      const aL0 = st === 1 || inErr ? T.latAccAbs : aLat;
      // atajo exacto: coche libre y solo, ya sobre la trazada → sigue la trazada (mismo código en MC y en pantalla)
      if (tgtL === 0 && nNear === 0 && st === 0 && !inErr && bLo <= -T.latMax && bHi >= T.latMax && !scObs) {
        const l0 = lane[c], l0v = laneV[c];
        if (l0 < 2e-3 && l0 > -2e-3 && l0v < 0.02 && l0v > -0.02) {
          let lpq = lp + (d1 - s); if (lpq >= L) lpq -= L;
          let xq = lpq * invStep, kq = xq | 0; if (kq >= N) kq = N - 1;
          const kq1 = kq + 1 >= N ? 0 : kq + 1, lnq = line[kq] + (line[kq1] - line[kq]) * (xq - kq), fq = lineD[kq] * vn;
          const dv = latV[c] - lineD[i0] * vc, dd = latc - (line[i0] + (line[i0 + 1 >= N ? 0 : i0 + 1] - line[i0]) * (lp * invStep - i0));
          if (dd < 2e-3 && dd > -2e-3 && dv < 0.02 && dv > -0.02) {
            lane[c] = 0; laneV[c] = 0; lat[c] = lnq; latV[c] = fq; if (DBG) DBG.short = (DBG.short || 0) + 1;
            if (!finc && d1 >= this.raceLen) this._finish(c, s, d1, t, hc);
            if (!finc && !fin[c] && d1 >= this.dFail[c]) { this._fail(c, i0); continue; }
            if (d1 >= this.nextC[c]) this._cornerErr(c, d1, aL, gL, vs, finc, scQueue, lapNo);
            if (!fast) this._cosmetic(c, hc, t, vn, vtC, vTopE, braking, held, kHere);
            continue;
          }
        }
      }
      // carril δ (frenada anticipada → sin pasarse)
      const ln0 = lane[c], lv0 = laneV[c];
      const eL = dTl - ln0, aeL = eL < 0 ? -eL : eL;
      let lvd = aeL < aKnee ? Kp * eL : Math.sqrt(1.8 * aL0 * aeL) * (eL < 0 ? -1 : 1);
      if (lvd > rt) lvd = rt; else if (lvd < -rt) lvd = -rt;
      const dlL = aL0 * hc;
      const lv1 = lv0 + (lvd - lv0 > dlL ? dlL : lvd - lv0 < -dlL ? -dlL : lvd - lv0);
      let ln1 = ln0 + 0.5 * (lv0 + lv1) * hc;
      if (ln1 > LM) ln1 = LM; else if (ln1 < -LM) ln1 = -LM;
      lane[c] = ln1; laneV[c] = lv1;
      // camino de referencia y su velocidad (al principio y al final del paso)
      let lp1 = lp + (d1 - s); if (lp1 >= L) lp1 -= L;
      let x1 = lp1 * invStep, k0 = x1 | 0; if (k0 >= N) k0 = N - 1;
      const f1 = x1 - k0, k1 = k0 + 1 >= N ? 0 : k0 + 1;
      const lineN = line[k0] + (line[k1] - line[k0]) * f1;
      const x0 = lp * invStep, f0 = x0 - i0, i1 = i0 + 1 >= N ? 0 : i0 + 1, lineO = line[i0] + (line[i1] - line[i0]) * f0;
      const q0 = Math.sqrt(ln0 * ln0 + EPS2), q1 = Math.sqrt(ln1 * ln1 + EPS2);
      const g0 = 1 - (q0 - EPS) * INVQ, g1 = 1 - (q1 - EPS) * INVQ;
      const ref0 = ln0 + lineO * g0, refN = ln1 + lineN * g1;
      const ff0 = (1 - lineO * (ln0 / q0) * INVQ) * lv0 + g0 * lineD[i0] * vc;
      const ffN = (1 - lineN * (ln1 / q1) * INVQ) * lv1 + g1 * lineD[k0] * vn;
      const gL0 = g1;
      // obstáculos (coches parados en el borde, SC entrando en boxes): limitan el objetivo
      if (st === 0 && !inErr) { const tg = refN + devT; if (tg > bHi) devT = bHi - refN; else if (tg < bLo) devT = bLo - refN; }
      const wall = st === 1 ? 1.45 : inErr ? T.latErrMax : T.latLimit;
      const dl0 = latc - ref0, dv0 = latV[c] - ff0;
      // desviación respecto al camino (solo la crean las restricciones y lo que queda fuera de pista): se corrige más deprisa
      const e = devT - dl0, ae = e < 0 ? -e : e;
      let dvd0 = ae < dKnee ? Kp * e : Math.sqrt(1.8 * aDev * ae) * (e < 0 ? -1 : 1);
      const rtD = rt * 1.5 < rv ? rt * 1.5 : rv;
      if (dvd0 > rtD) dvd0 = rtD; else if (dvd0 < -rtD) dvd0 = -rtD;
      let va = ffN + dvd0;
      // velocidad alcanzable con la aceleración normal…
      const dlim0 = aDev * hc;
      let dv1 = dv0 + (va - ffN - dv0 > dlim0 ? dlim0 : va - ffN - dv0 < -dlim0 ? -dlim0 : va - ffN - dv0);
      let vA = ffN + dv1, con = false;
      // …y restricciones sobre ESA velocidad: nunca solapados con un coche a la par (no cerrar más de lo
      // que se puede frenar; separarse si ya hay solape) ni contra el borde. Si hace falta, aceleración de emergencia.
      for (let q = 0; q < nNear; q++) {
        const o = near[q];
        const lo = lat[o], vo = state[o] === 2 ? 0 : latV[o];
        const d0 = latc - lo;
        const side = d0 > 0 ? 1 : d0 < 0 ? -1 : (c < o ? 1 : -1);
        const gap = d0 * side - W;
        const rel = (vA - vo) * side;
        if (gap > 0) { const mc = Math.sqrt(2 * aDev * gap); if (rel < -mc) { vA = vo - side * mc; con = true; } }
        else if (rel < T.latPush) { vA = vo + side * T.latPush; con = true; }
      }
      if (scObs) {
        const g = this.scPD - s;
        if (g < sepD && g > -sepD) {
          const d0 = latc - this.scPL, side = d0 >= 0 ? 1 : -1, gap = d0 * side - W, rel = (vA - this.scPLV) * side;
          if (gap > 0) { const mc = Math.sqrt(2 * aDev * gap); if (rel < -mc) { vA = this.scPLV - side * mc; con = true; } }
          else if (rel < T.latPush) { vA = this.scPLV + side * T.latPush; con = true; }
        }
      }
      // borde de la pista (pared blanda)
      if (latc > 0) { const r = wall - latc, mo = r > 0 ? Math.sqrt(2 * aDev * r) : 0; if (vA > mo) { vA = mo; con = true; } }
      else { const r = wall + latc, mo = r > 0 ? Math.sqrt(2 * aDev * r) : 0; if (vA < -mo) { vA = -mo; con = true; } }
      if (con) { const de = T.latAccEm * hc, d = vA - ffN - dv0; dv1 = dv0 + (d > de ? de : d < -de ? -de : d); }
      // integración trapezoidal de la posición ABSOLUTA (posición y velocidad siempre coherentes)
      let nlv = ffN + dv1, nl = latc + 0.5 * (latV[c] + nlv) * hc;
      if (nl > 1.5) nl = 1.5; else if (nl < -1.5) nl = -1.5; // salvaguarda (la pared blanda frena antes)
      if (DBG && DBG.latHook) DBG.latHook(this, c, latc, latV[c], nl, nlv, ff0, ffN, con, gL0, st, inErr, vc, vn, hc);
      lat[c] = nl; latV[c] = nlv;

      if (st === 1) {
        if (vn <= 0.25 && Math.abs(nl - this.parkS[c]) < 0.06) { state[c] = 2; v[c] = 0; latV[c] = 0; }
        if (!fast) this._cosmetic(c, hc, t, vn, 0, vTopE, braking, false, kHere);
        continue;
      }

      // meta
      if (!finc && d1 >= this.raceLen) this._finish(c, s, d1, t, hc);
      // avería mecánica
      if (!finc && !fin[c] && d1 >= this.dFail[c]) { this._fail(c, i0); continue; }
      // errores al entrar en curva
      if (d1 >= this.nextC[c]) this._cornerErr(c, d1, aL, gL, vs, finc, scQueue, lapNo);

      if (!fast) this._cosmetic(c, hc, t, vn, vtC, vTopE, braking, held, kHere);
    }

    if (!fast) this._timing(t);
  }

  _finish(c, s, d1, t, hc) {
    const ft = t - hc + ((this.raceLen - s) / (d1 - s)) * hc;
    this.finT[c] = ft; this.fin[c] = 1;
    const fo = this.finOrd, fT = this.finT;
    let q = this.nFin++;
    while (q > 0 && fT[fo[q - 1]] > ft) { fo[q] = fo[q - 1]; q--; }
    fo[q] = c;
  }

  /** Errores al entrar en curva (se sortea en cada curva con el flujo aleatorio del coche). */
  _cornerErr(c, d1, aL, gL, vs, finc, scQueue, lapNo) {
    const T = TUNING, tr = this.track, L = this.L, errT = this.errT, fast = this.fast;
    {
      if (d1 >= this.nextC[c]) {
        const corners = tr.corners, ci = this.cIdx[c], cr = corners[ci];
        const u = mbNext(this.est, c);
        let pe = this.pE[c] * cr.risk;
        if (aL >= 0 && gL < vs) pe *= T.errPressure;
        if (!finc && errT[c] <= 0 && !scQueue && u < pe) {
          const u2 = mbNext(this.est, c);
          const lock = mbNext(this.est, c) < 0.45;
          const spin = this.incidents && mbNext(this.est, c) < T.spinShare;
          let dur, kind;
          if (spin) {
            dur = T.spinDurMin + (T.spinDurMax - T.spinDurMin) * u2;
            this.errF[c] = T.spinF; kind = 3; this.errLat[c] = 1.05;
          } else {
            const loss = T.errLossMin + (T.errLossMax - T.errLossMin) * u2;
            dur = 0.8 + 1.5 * loss; this.errF[c] = 1 - T.errSeverity * loss / dur;
            kind = lock ? 2 : loss > T.offTrackLoss ? 4 : 1;
            this.errLat[c] = kind === 4 ? 1.1 : T.errWide;
          }
          errT[c] = dur; this.errDir[c] = -cr.dir; this.errKind[c] = kind; this.errAge[c] = 0;
          if (!fast) this._ev(kind === 3 ? 'spin' : kind === 2 ? 'lockup' : kind === 4 ? 'offtrack' : 'error', c, -1, { kind, lap: lapNo + 1, loss: kind === 3 ? dur * (1 - T.spinF) : (1 - this.errF[c]) * dur / T.errSeverity });
          if (spin) this._scRequest(T.scProbSpin, 2, c, cr.dir);
        }
        const nj = ci + 1;
        if (nj >= corners.length) { this.cIdx[c] = 0; this.nextC[c] += corners[0].start + L - cr.start; }
        else { this.cIdx[c] = nj; this.nextC[c] += corners[nj].start - cr.start; }
      }
    }
  }

  _cosmetic(c, hc, t, vn, vtC, vTopE, braking, held, kHere) {
    const p = this.par[c];
    this.errAge[c] += hc;
    let thrT, bT, sl = 0;
    if (this.state[c]) {
      // averiado: sin gas, frenando suave; el pinchazo hace bailar el coche
      thrT = 0; bT = braking > 0 ? 0.25 + 0.4 * braking : 0;
      if (this.reason[c] === 3) sl = 0.35;
    } else {
      thrT = braking > 0 ? 0 : (vn < vtC - 0.05 || vn < vTopE * 0.995 ? (held ? 0.55 : 1) : 0.6);
      bT = braking > 0 ? 0.35 + 0.65 * braking : 0;
      const load = vn * vn * kHere / p.cornerG;
      if (load > 0.8) sl = (load - 0.8) * 2.5;
      const sinceGo = t - this.react[c];
      if (sinceGo < 1.6) sl = Math.max(sl, (1.06 - this.launchQ[c]) * 3 * (1 - sinceGo / 1.6) + 0.15);
      if (this.errT[c] > 0) {
        const kd = this.errKind[c];
        if (kd === 3) { if (this.errAge[c] < 1.4) { bT = 1; sl = 1; } else sl = Math.max(sl, 0.6); }
        else if (kd === 2 && this.errAge[c] < 0.6) { bT = 1; sl = Math.max(sl, 0.9); }
        else sl = Math.max(sl, kd === 4 ? 0.7 : 0.55);
      }
    }
    this.thr[c] += (thrT - this.thr[c]) * Math.min(1, hc * 12);
    this.brk[c] += (bT - this.brk[c]) * Math.min(1, hc * 15);
    this.slip[c] += (clamp(sl, 0, 1) - this.slip[c]) * Math.min(1, hc * 8);
    const gt = this.gearTop, vt = p.vTop * 1.04;
    let g = this.gear[c];
    if (g < 6 && vn > gt[g - 1] * vt * 0.97) g++;
    else if (g > 1 && vn < gt[g - 2] * vt * 0.78) g--;
    this.gear[c] = g;
    const lo = g > 1 ? gt[g - 2] * vt * 0.7 : 0;
    let rpm = 0.25 + 0.75 * clamp((vn - lo) / (gt[g - 1] * vt - lo), 0, 1);
    if (t - this.react[c] < 1.2 && g === 1 && !this.state[c]) rpm = Math.max(rpm, 0.75);
    if (this.state[c] && this.reason[c] === 0) rpm = Math.min(rpm, 0.15); // motor roto: al ralentí / apagado
    this.rpm[c] = rpm;
  }

  _timing(t) {
    const n = this.n, dist = this.dist, L = this.L, state = this.state;
    let dmax = -1e9;
    for (let c = 0; c < n; c++) if (dist[c] > dmax) dmax = dist[c];
    const reach = this.reach;
    while (this.reachI < reach.length && dmax >= this.reachI * 5) { reach[this.reachI++] = t; }
    // posiciones con histéresis + eventos de adelantamiento (los averiados, al final)
    const rank = this.rank, fin = this.fin, finT = this.finT;
    let sw = true, guard = 0;
    while (sw && guard++ < 12) {
      sw = false;
      for (let i = 1; i < n; i++) {
        const a = rank[i - 1], b = rank[i];
        let swap = false, ev = false;
        const sa = state[a] > 0, sb = state[b] > 0;
        if (sa || sb) swap = sa && sb ? dist[b] > dist[a] + 0.01 : sa;
        else if (fin[a] && fin[b]) swap = finT[b] < finT[a];
        else if (fin[b] && !fin[a]) swap = true;
        else if (!fin[a] && !fin[b] && dist[b] > dist[a] + 1.5) { swap = true; ev = true; }
        if (swap) {
          rank[i - 1] = b; rank[i] = a; sw = true;
          if (ev) this._ev('overtake', b, a, { pos: i, lap: Math.max(1, Math.min(this.laps, Math.floor(dist[b] / L) + 1)) });
        }
      }
    }
  }

  /** Corre hasta que haya `k` coches en meta (o no queden más que puedan llegar). */
  runUntil(k) {
    const tMax = 1500, n = this.n;
    while (this.nFin < k && this.nFin + this.nDnf < n && this.t < tMax) this.step();
  }
}

/* ============================================================= CARRERA */
const SC_PHASES = ['off', 'out', 'in', 'in', 'off'];

class Race {
  constructor(o) {
    const core = (this.core = new Core({ ...o, fast: false }));
    this.seed = (o.seed >>> 0) || 1;
    core.reset(this.seed);
    this.track = o.track; this.laps = core.laps; this.n = core.n;
    this.cond = core.cond; this.form = o.form ? o.form.slice() : new Array(core.n).fill(3);
    this.estado = Array.from(core.estado);
    this.grid = core.grid.slice();
    this.t = 0; this.done = false; this.events = [];
    this.ts = o.track.speedScale || 1;
    this.lights = { out: 0 };
    this.reaction = Array.from(core.react, (x) => x / this.ts);
    this.launch = Array.from(core.launchQ);
    this.raceLength = core.raceLen;
    this.cars = [];
    for (let i = 0; i < core.n; i++) {
      this.cars.push({ dist: 0, lap: 1, lateral: 0, v: 0, rpm: 0.18, gear: 1, throttle: 0, brake: 0, slip: 0,
        finished: false, finishTime: 0, pos: 0, draft: 0, error: 0, state: 'run', cond: this.estado[i], dnfReason: null, sc: false });
    }
    this.sc = { active: false, phase: 'off', dist: 0, lateral: 0, v: 0, leaving: false, lights: false };
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
    const a2 = al * al, a3 = a2 * al;
    const H0 = 2 * a3 - 3 * a2 + 1, H1 = (a3 - 2 * a2 + al) * h, H2 = 3 * a2 - 2 * a3, H3 = (a3 - a2) * h;
    const scq = core.scPh >= 1 && core.scPh <= 3 && !core.scRestarted;
    let nf = 0, nd = 0;
    for (let i = 0; i < n; i++) {
      const c = this.cars[i];
      // Hermite cúbica (posición y velocidad continuas entre pasos fijos)
      const d0 = core.pd[i], d1 = core.dist[i], v0 = core.pv[i], v1 = core.v[i];
      let d = H0 * d0 + H1 * v0 + H2 * d1 + H3 * v1;
      if (d < d0) d = d0; else if (d > d1) d = d1;
      c.dist = d;
      c.lateral = H0 * core.pl[i] + H1 * core.plv[i] + H2 * core.lat[i] + H3 * core.latV[i];
      c.v = (v0 + (v1 - v0) * al) * ts;
      c.lap = Math.max(1, Math.min(this.laps, Math.floor(d / L) + 1));
      c.rpm = core.prpm[i] + (core.rpm[i] - core.prpm[i]) * al; c.gear = core.gear[i];
      c.throttle = core.pthr[i] + (core.thr[i] - core.pthr[i]) * al;
      c.brake = core.pbrk[i] + (core.brk[i] - core.pbrk[i]) * al;
      c.slip = core.pslip[i] + (core.slip[i] - core.pslip[i]) * al;
      const la = core.lat[i], lb = core.pl[i];
      c.draft = core.draft[i];
      // 4 = fuera de pista de verdad (error que se sale o |lateral| > 1.15); pisar el piano no cuenta
      c.error = core.errT[i] > 0 ? core.errKind[i] : (!core.state[i] && (la > 1.15 || la < -1.15 || lb > 1.15 || lb < -1.15)) ? 4 : 0;
      c.sc = scq && !core.fin[i] && !core.state[i];
      if (core.fin[i] && core.finT[i] <= tc) { c.finished = true; c.finishTime = core.finT[i] / ts; c.state = 'fin'; nf++; }
      else if (core.state[i] && core.dnfT[i] <= tc + 1e-9) { c.state = 'dnf'; c.dnfReason = DNF_REASONS[core.reason[i]]; c.error = 0; nd++; }
      else c.state = 'run';
    }
    // coche de seguridad
    const sc = this.sc, ph = core.scPh;
    sc.active = ph >= 1 && ph <= 3; sc.phase = SC_PHASES[ph] || 'off';
    sc.leaving = ph === 3; sc.lights = ph === 1;
    if (sc.active) {
      sc.dist = H0 * core.scPD + H1 * core.scPV + H2 * core.scD + H3 * core.scV;
      sc.lateral = H0 * core.scPL + H1 * core.scPLV + H2 * core.scL + H3 * core.scLV;
      sc.v = (core.scPV + (core.scV - core.scPV) * al) * ts;
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
      if (pos === 2 && gap * ts < TUNING.photoGap) this.events.push({ type: 'photo', car: core.finOrd[0], other: ci, t: core.finT[ci] / ts, gap });
    }
    if (!this.done && nf + nd === n && nf === core.nFin && nd === core.nDnf) {
      this.done = true;
      const res = Array.from(core.finOrd).slice(0, core.nFin).map((ci, p) => ({ car: ci, time: core.finT[ci] / ts, pos: p + 1, dnf: false, reason: null, dist: core.raceLen }));
      const dn = Array.from(core.dnfOrd).slice(0, core.nDnf).sort((a, b) => core.dist[b] - core.dist[a]);
      dn.forEach((ci) => res.push({ car: ci, time: null, pos: res.length + 1, dnf: true, reason: DNF_REASONS[core.reason[ci]], dist: core.dist[ci] }));
      this.results = res;
    }
  }

  /** Segundos detrás del líder (estimado como en el cronometraje real). Infinity si abandonó. */
  leaderGap(i) {
    const core = this.core, c = this.cars[i];
    if (c.state === 'dnf') return Infinity;
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

  /** Orden final (array de índices: los que terminan y después los DNF) — solo cuando done. */
  get finishOrder() { return this.done ? this.results.map((r) => r.car) : null; }
}

export function createRace(opts) { return new Race(opts); }

/** Resultado de una carrera sin pantalla (mismo modelo). */
export function simulateRace(opts, seed, untilPodium = false) {
  const core = new Core({ ...opts, fast: true });
  core.reset(seed >>> 0);
  core.runUntil(untilPodium ? Math.min(3, core.n) : core.n);
  const order = Array.from(core.finOrd).slice(0, core.nFin);
  const dnf = Array.from(core.state, (s) => s > 0);
  if (!untilPodium) Array.from(core.dnfOrd).slice(0, core.nDnf).sort((a, b) => core.dist[b] - core.dist[a]).forEach((c) => order.push(c));
  return { order, times: Array.from(core.finT), dnf, reasons: Array.from(core.reason, (r, i) => (dnf[i] ? DNF_REASONS[r] : null)),
    sc: core.scCount > 0, nDnf: core.nDnf, t: core.t };
}

/* ============================================================== MERCADO */
/** Cuota redondeada al paso MÁS CERCANO (0.05 < 5, 0.1 < 10, 0.5 < 100, 5 después), en [ODDS_MIN, max]. */
export const ODDS_MIN = 1.05, ODDS_MAX = 100, EXACTA_MAX = 500;
export function roundOdds(o, max = ODDS_MAX) {
  if (!(o > 0) || !isFinite(o)) return max;
  const stepO = o < 5 ? 0.05 : o < 10 ? 0.1 : o < 100 ? 0.5 : 5;
  let r = Math.round(o / stepO) * stepO;
  r = Math.round(r * 100) / 100;
  return clamp(r, ODDS_MIN, max);
}

/**
 * Exacta (1º y 2º en orden). Recuentos del MC suavizados por pares con un
 * Bayes empírico: modelo tipo Harville con "fuerzas de segundo puesto"
 * ajustadas a los marginales del MC; cada par pesa más el dato cuanto más
 * frecuente es (varianza de Poisson frente a la discrepancia media modelo-dato).
 */
export function exactaProbs(n, sims, pairs, seconds, pWin, nTwo, tau2Min = TUNING.exTau2Min) {
  const pS = new Float64Array(n);
  let tot = 0;
  for (let j = 0; j < n; j++) { pS[j] = seconds[j] + 0.5; tot += pS[j]; }
  for (let j = 0; j < n; j++) pS[j] /= tot;
  const s = Float64Array.from(pS), pred = new Float64Array(n);
  for (let it = 0; it < 80; it++) {
    let S = 0;
    for (let j = 0; j < n; j++) S += s[j];
    pred.fill(0);
    for (let i = 0; i < n; i++) {
      const den = S - s[i];
      if (den <= 0) continue;
      for (let j = 0; j < n; j++) if (j !== i) pred[j] += pWin[i] * s[j] / den;
    }
    for (let j = 0; j < n; j++) s[j] *= clamp(pS[j] / Math.max(pred[j], 1e-12), 0.5, 2);
  }
  let S = 0;
  for (let j = 0; j < n; j++) S += s[j];
  const m = new Float64Array(n * n);
  let mt = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) { const x = pWin[i] * s[j] / (S - s[i]); m[i * n + j] = x; mt += x; }
  for (let q = 0; q < n * n; q++) m[q] /= mt;
  // discrepancia relativa modelo-dato (τ²) más allá del ruido de Poisson
  let num = 0, den = 0;
  for (let q = 0; q < n * n; q++) {
    const mu = sims * m[q];
    if (mu <= 0) continue;
    const d = pairs[q] - mu;
    num += d * d - mu; den += mu * mu;
  }
  const tau2 = clamp(den > 0 ? num / den : 0.05, tau2Min, 1);
  const p = new Float32Array(n * n);
  let pt = 0;
  for (let q = 0; q < n * n; q++) {
    if (m[q] <= 0) continue;
    const w = (tau2 * sims * m[q]) / (tau2 * sims * m[q] + 1);
    const x = w * (pairs[q] / sims) + (1 - w) * m[q];
    p[q] = x; pt += x;
  }
  const target = nTwo / sims;
  for (let q = 0; q < n * n; q++) p[q] *= target / pt;
  return { p, tau2 };
}

function finalizeMarket(n, sims, acc, rtp, extra) {
  const { wins, pods, pairs, seconds, nTwo, dnfs, scs } = acc;
  const aW = 1, aP = 0.5;
  const pWin = [], pPodium = [], oddsWin = [], oddsPodium = [], rtpWin = [], rtpPodium = [], pDnf = [];
  for (let i = 0; i < n; i++) {
    const pw = (wins[i] + aW) / (sims + n * aW);
    const pp = Math.min(0.999, (pods[i] + aP) / (sims + (n * aP) / 3));
    pWin.push(pw); pPodium.push(pp);
    const ow = roundOdds(rtp / pw), op = roundOdds(rtp / pp);
    oddsWin.push(ow); oddsPodium.push(op);
    rtpWin.push(ow * pw); rtpPodium.push(op * pp);
    pDnf.push(dnfs[i] / sims);
  }
  const ex = exactaProbs(n, sims, pairs, seconds, pWin, nTwo);
  const pExactaMC = new Float32Array(n * n);
  for (let q = 0; q < n * n; q++) pExactaMC[q] = pairs[q] / sims;
  const pExacta = ex.p, oddsExacta = new Array(n * n).fill(0), rtpExacta = new Array(n * n).fill(0);
  let bookExacta = 0, rtpExSum = 0;
  for (let q = 0; q < n * n; q++) {
    if (!(pExacta[q] > 0)) continue;
    const o = roundOdds(rtp / pExacta[q], EXACTA_MAX);
    oddsExacta[q] = o; rtpExacta[q] = o * pExacta[q]; bookExacta += 1 / o; rtpExSum += rtpExacta[q];
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const sumInv = (a) => a.reduce((x, y) => x + 1 / y, 0);
  return { pWin, pPodium, pExacta, oddsWin, oddsPodium, oddsExacta, rtpWin, rtpPodium, rtpExacta,
    rtpWinMean: mean(rtpWin), rtpPodiumMean: mean(rtpPodium), rtpExactaMean: rtpExSum / (n * (n - 1)),
    bookWin: sumInv(oddsWin), bookPodium: sumInv(oddsPodium) / 3, bookExacta, // 1 = libro justo
    pDnf, pSC: scs / sims, exactaTau2: ex.tau2, pExactaMC, counts: { pairs: Array.from(pairs), seconds: Array.from(seconds), nTwo },
    sims, wins: Array.from(wins), podiums: Array.from(pods), ...extra };
}

function marketSeed(o) {
  let h = hashSeed(o.laps || o.track.laps || 4, Math.round(o.track.length));
  (o.grid || []).forEach((g, i) => { h = hashSeed(h, g * 7 + i); });
  (o.form || []).forEach((f, i) => { h = hashSeed(h, f * 13 + i); });
  (o.estado || []).forEach((e, i) => { h = hashSeed(h, Math.round(e * 1000) * 17 + i); });
  h = hashSeed(h, (o.cond && o.cond.weather || 'seco').charCodeAt(0));
  return h;
}

function newAcc(n) {
  return { wins: new Float64Array(n), pods: new Float64Array(n), pairs: new Float64Array(n * n), seconds: new Float64Array(n),
    dnfs: new Float64Array(n), nTwo: 0, scs: 0 };
}
function runOne(core, seed, k3, acc) {
  core.reset(seed);
  core.runUntil(k3);
  const fo = core.finOrd, nf = core.nFin, n = core.n;
  if (nf > 0) acc.wins[fo[0]]++;
  for (let q = 0; q < k3 && q < nf; q++) acc.pods[fo[q]]++;
  if (nf >= 2) { acc.pairs[fo[0] * n + fo[1]]++; acc.seconds[fo[1]]++; acc.nTwo++; }
  for (let c = 0; c < n; c++) if (core.state[c]) acc.dnfs[c]++;
  if (core.scCount) acc.scs++;
}

/**
 * Versión síncrona (tests / Web Worker).
 * Reparto entre varios workers: cada uno llama con `range: [desde, hasta)` y `raw: true`
 * (devuelve recuentos); después `mergeMarket([...partes], rtp)` da el mercado completo,
 * idéntico al de una sola llamada con sims = total.
 */
export function computeMarket(o) {
  const { sims = 1500, rtp = 1, maxMs = Infinity } = o;
  const core = new Core({ ...o, fast: true });
  const n = core.n, acc = newAcc(n);
  const base = o.seed != null ? o.seed >>> 0 : marketSeed(o);
  const k3 = Math.min(3, n);
  const t0 = now();
  const s0 = o.range ? o.range[0] : 0, s1 = o.range ? o.range[1] : sims;
  let done = 0;
  for (let s = s0; s < s1; s++) {
    if (!o.range && done >= 400 && (done & 31) === 0 && now() - t0 > maxMs) break;
    runOne(core, hashSeed(base, s), k3, acc);
    done++;
  }
  if (o.raw) return { n, sims: done, acc: rawAcc(acc), ms: now() - t0 };
  return finalizeMarket(n, done, acc, rtp, { ms: now() - t0 });
}
function rawAcc(a) { const o = {}; for (const k in a) o[k] = typeof a[k] === 'number' ? a[k] : Array.from(a[k]); return o; }
/** Une recuentos de computeMarket({ raw: true, range }) y calcula el mercado. */
export function mergeMarket(parts, rtp = 1) {
  const n = parts[0].n, acc = newAcc(n);
  let sims = 0, ms = 0;
  for (const p of parts) {
    sims += p.sims; ms = Math.max(ms, p.ms || 0);
    for (const k in acc) {
      if (typeof acc[k] === 'number') acc[k] += p.acc[k];
      else for (let i = 0; i < acc[k].length; i++) acc[k][i] += p.acc[k][i];
    }
  }
  return finalizeMarket(n, sims, acc, rtp, { ms, parts: parts.length });
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const yieldUI = () => new Promise((r) => setTimeout(r, 0));

/**
 * createMarket(opts) → Promise<{ pWin, pPodium, pExacta, oddsWin, oddsPodium, oddsExacta, ... }>
 * Monte Carlo troceado: nunca bloquea más de `chunkMs` (12 ms por defecto).
 */
export async function createMarket(o) {
  const { sims = 1500, rtp = 1, onProgress, chunkMs = 12, maxMs = Infinity } = o;
  const core = new Core({ ...o, fast: true });
  const n = core.n, acc = newAcc(n);
  const base = o.seed != null ? o.seed >>> 0 : marketSeed(o);
  const k3 = Math.min(3, n);
  const t0 = now();
  let tc = t0, maxChunk = 0, done = 0;
  for (let s = 0; s < sims; s++) {
    if (s >= 400 && now() - t0 > maxMs) break;
    done++;
    runOne(core, hashSeed(base, s), k3, acc);
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
  return finalizeMarket(n, done, acc, rtp, { ms: now() - t0, maxChunkMs: maxChunk });
}

/**
 * Vuelta ideal de cada coche en solitario (diagnóstico / ficha técnica).
 * Devuelve [{ raceTime, lap2 (tiempo de las vueltas 2..N), vMax }] a ritmo de forma neutra, sin incidentes.
 */
export function analyzeTrack(track, cars, cond = CONDITIONS.seco, laps, dt) {
  laps = laps || track.laps || 4;
  return cars.map((car) => {
    const core = new Core({ cars: [car], track, laps, cond, fast: true, dt, incidents: false, estado: [1] });
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
