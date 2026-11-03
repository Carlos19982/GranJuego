/* =========================================================================
   GRAN PREMIO NEÓN · coches-movimiento.js
   Capa de presentación: dinámica visual del coche a partir del simulador.

   El simulador (carrera-sim.js) decide DÓNDE está cada coche (dist, lateral)
   y a qué velocidad. Este módulo decide CÓMO se mueve: rumbo según la
   trayectoria real, deriva, dirección Ackermann con contravolante,
   suspensión de 4 esquinas (muelle-amortiguador), transferencias de peso,
   pianos, peralte, giro de ruedas con patinaje y bloqueos.

   API
     createCarMotion({ track: T, sampleTrack?, lateralToMetres?, count = 6 }) → {
       reset(i, dist, lateral) → pose,          // teletransporte (parrilla, podio, coche de seguridad)
       update(i, rc, dt, simDt, dims) → pose,   // rc = coche del simulador { dist, lateral, v, throttle,
                                                //   brake, slip, rpm, error (0..4), state ('run'|'dnf'|'fin') }
       apply(pose, model),                      // escribe en el modelo (contrato de coches-modelo.js)
       pose(i), tuning (= MOTION_TUNING)
     }
     Llamar a update UNA vez por coche y fotograma, después de race.step(), con
     simDt = dt · escala de tiempo (0 = pausa: la pose no cambia). dims = model.dims.
     El índice i puede crecer (p. ej. 6 = coche de seguridad); el estado se crea una vez.

   Convenciones (contrato): metros, segundos (tiempo de SIMULACIÓN), radianes.
   Mundo Y arriba. Coche: origen en el suelo entre ejes, +Z delante, +X izquierda.
   Ruedas [FL, FR, RL, RR].
     pose.x/y/z      punto del suelo bajo el coche (centro + n·m, y + m·tan(peralte))
     pose.yaw        rumbo (root.rotation.y), envuelto a (-π, π]; fwdX/fwdZ = (sin, cos)
     pose.rootPitch  cabeceo del plano de la carretera (rotation.x, + = morro abajo)
     pose.rootRoll   balanceo del plano de la carretera (rotation.z, + = lado izq. arriba)
     pose.pitch      cabeceo de la CARROCERÍA sobre las ruedas (+ = morro ARRIBA)
     pose.roll       balanceo de la carrocería (+ = lado izquierdo arriba)
     pose.heave      altura de la carrocería sobre su reposo (m, + = arriba)
     pose.steer      ángulo de la bici equivalente (+ = izquierda); steerW[4] por rueda (Ackermann parcial)
     pose.spin[4]    ángulo de rodadura (rad, + = adelante); spinRate (rad/s, traseras)
     pose.susp[4]    compresión de cada esquina (m, + = comprimida); wheelY[4] subida de la rueda (pianos)
     pose.slipAngle  rumbo − dirección de la velocidad (rad); yawRate (rad/s)
     pose.latG/lonG  aceleraciones percibidas (g); speed (m/s reales sobre la trayectoria)
     pose.onKerb 0..1, kerbSide ±1, offTrack 0..1 (fracción de ruedas fuera)
     pose.smoke/smokeF/smokeR/skid/dust/sparks/engineSmoke 0..1  → pistas para partículas
     pose.brake 0..1 (luces de freno), velX/velY/velZ (m/s de simulación, para heredar en partículas)

   Sin asignaciones de memoria por fotograma. Todo se integra en sub-pasos de
   ≤ 1/200 s de tiempo de simulación → mismo resultado a 30, 60 o 120 fps y con
   cualquier escala de tiempo (×1/×2/×4, cámara lenta; pausa = simDt 0).
   ========================================================================= */

const TAU = Math.PI * 2;
const G0 = 9.81;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const wrapPi = (a) => a - TAU * Math.round(a / TAU);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const sat = (x, a) => a * Math.tanh(x / a);
const CAR_HALF = 1.2; // ADDENDUM B: lateralToMetres = lateral · (w − 1.2)

export const DEFAULT_DIMS = {
  length: 4.7, width: 2.0, height: 1.1, wheelbase: 2.8, track: 1.92, wheelRadius: 0.34,
  frontAxleZ: 1.42, rearAxleZ: -1.38, rideHeight: 0.12,
};

/** Ajustes de la presentación (exportados para afinar desde fuera). */
export const MOTION_TUNING = {
  hMax: 1 / 200,          // sub-paso máximo (s de simulación)
  nMax: 24,               // sub-pasos máximos por fotograma (×4 a 30 fps → 1/180 s)
  chordMax: 0.75,         // m de recorrido máximo por sub-paso
  // Rumbo
  vFloor: 4.5,            // m/s: por debajo, el movimiento lateral casi no gira el coche (parrilla/salida)
  latAngMax0: 0.10,       // rad: ángulo máximo de la trayectoria respecto a la pista parado…
  latAngMax: 0.60,        // …y lanzado (> 25 m/s) (en horquillas la trazada corta ~25°)
  latAngMaxErr: 0.70,
  phiW: 18,               // 1/s: filtro 2º orden (crítico) del ángulo lateral de la trayectoria (quita quiebros del sim)
  // Suspensión (por unidad de masa): 4 esquinas iguales
  kCorner: 46,            // 1/s²  → bote ≈ 2.2 Hz
  cCorner: 3.7,           // 1/s   → ζ ≈ 0.55–0.6
  rp2: 1.45,              // m² radio de giro en cabeceo (≈ 2.5 Hz)
  rr2: 0.75,              // m² radio de giro en balanceo (≈ 2.4 Hz)
  gRoll: 0.0011,          // rad por m/s² lateral (≈ 2.8° a 5 g, saturado)
  gDive: 0.00076,         // rad por m/s² de frenada
  gSquat: 0.0011,         // rad por m/s² de aceleración
  aSat: 55,               // m/s²: saturación suave de las aceleraciones percibidas
  aero: 4.2e-4,           // m/s² por (m/s)²: carga aerodinámica (aplasta ≈ 1.8 cm a 90 m/s)
  travel: 0.065,          // m: compresión hasta el tope
  bottom: 0.06,           // m: caída del fondo plano (morro/cola) a la que roza el suelo (chispas)
  // Carretera
  road: 0.0024,           // m: rugosidad del asfalto (suma de senos espaciales)
  joints: 0.007,          // m: juntas/parches transversales (aleatorios, fijos por pista)
  kerbIn: 1.0,            // m: el piano empieza a w - kerbIn (T.kerbIn lo sustituye)
  kerbOut: 0.6,           // m: y termina a w + kerbOut (T.kerbOut)
  kerbRumble: 0.016,      // m: amplitud de los dientes del piano de salida (pista.js: 2.6–5.8 cm)
  kerbPeriod: 0.8,        // m: periodo de los dientes
  // Deriva / guiñada dinámica
  betaW: 7.5, betaZ: 0.55,       // dinámica normal de la deriva
  betaWErr: 6.0, betaZErr: 0.3,  // durante errores: péndulo con coleteo
  alphaR: 0.03,           // rad: deriva trasera extra al límite (morro hacia dentro)
  neutral: 0.9,           // fracción del ángulo geométrico L_r/R que la deriva trasera compensa al límite
  slipBeta: 0.17,         // rad por unidad de slip del simulador en curva
  errOver: 0.22,          // rad: sobreviraje típico en un error
  // Dirección
  usK0: 0.00035, usK1: 0.00045,  // subviraje (rad por m/s²) a baja / alta velocidad
  ackermann: 0.6,         // fracción de Ackermann (1 = geometría pura; los de carreras usan menos)
  steerW: 16, steerRate: 2.6, steerRateErr: 6, steerMax: 0.62,
  steerNoise: 0.0035,
  vib: 1,                 // multiplicador de vibración fina / ruido (0 = apagado, para medir)
  // Ruedas
  spinTau: 0.06, lockTau: 0.03,
  launchSpin: 18,         // m/s de patinaje por unidad de slip (> 0.35) en la salida
};

/* ------------------------------------------------------------- utilidades */
function hash01(a, b) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
/** Ruido suave determinista ~[-1, 1] (suma de senos inconmensurables). */
function sn(t, p) {
  return 0.5 * Math.sin(t + p) + 0.3 * Math.sin(t * 1.618 + p * 2.3 + 1.1) + 0.2 * Math.sin(t * 2.71 + p * 0.7 + 2.3);
}

/* ---------------------------------------------- muestreo de pista (respaldo)
   Para el circuito antiguo (buildCircuit() sin sampleTrack): Hermite en x/z
   con las tangentes (C1), resto lineal. Rellena el contrato de sampleTrack. */
const _fb = new WeakMap();
function fallbackArrays(T) {
  let A = _fb.get(T);
  if (A) return A;
  const N = T.N, ds = T.ds || T.L / N;
  const KL = new Float32Array(N), KR = new Float32Array(N);
  if (T.corners) {
    // como en el decorado antiguo: interior desde la entrada hasta la salida, exterior a la salida
    for (const c of T.corners) {
      const mark = (arr, a, b) => { for (let s = Math.floor(a); s <= Math.ceil(b); s++) { const i = (((Math.round(s / ds)) % N) + N) % N; arr[i] = 1; } };
      if (c.dir > 0) { mark(KL, c.s0 - 12, c.s1 + 8); mark(KR, c.apex - 5, c.s1 + 30); }
      else { mark(KR, c.s0 - 12, c.s1 + 8); mark(KL, c.apex - 5, c.s1 + 30); }
    }
  }
  A = { KL, KR, W: null, halfW: T.halfW || 9 };
  _fb.set(T, A);
  return A;
}
export function fallbackSampleTrack(T, s, out = {}) {
  const N = T.N, ds = T.ds || T.L / N;
  let u = s / ds; u -= Math.floor(u / N) * N;
  let i = u | 0; if (i >= N) i = 0;
  const f = u - i, j = i + 1 < N ? i + 1 : 0;
  const f2 = f * f, f3 = f2 * f;
  const h00 = 2 * f3 - 3 * f2 + 1, h10 = f3 - 2 * f2 + f, h01 = 3 * f2 - 2 * f3, h11 = f3 - f2;
  const X = T.x, Z = T.z, TX = T.tx, TZ = T.tz;
  out.x = h00 * X[i] + h10 * TX[i] * ds + h01 * X[j] + h11 * TX[j] * ds;
  out.z = h00 * Z[i] + h10 * TZ[i] * ds + h01 * Z[j] + h11 * TZ[j] * ds;
  out.y = T.y[i] + (T.y[j] - T.y[i]) * f;
  let tx = TX[i] + (TX[j] - TX[i]) * f, tz = TZ[i] + (TZ[j] - TZ[i]) * f;
  const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
  out.tx = tx; out.tz = tz; out.nx = tz; out.nz = -tx;
  out.k = T.k[i] + (T.k[j] - T.k[i]) * f;
  out.slope = T.slope ? T.slope[i] + (T.slope[j] - T.slope[i]) * f : 0;
  out.bank = T.bank ? T.bank[i] + (T.bank[j] - T.bank[i]) * f : 0;
  const A = fallbackArrays(T);
  out.w = T.w ? T.w[i] + (T.w[j] - T.w[i]) * f : A.halfW;
  const kl = T.kerbL || A.KL, kr = T.kerbR || A.KR;
  out.kerbL = kl[i] + (kl[j] - kl[i]) * f; out.kerbR = kr[i] + (kr[j] - kr[i]) * f;
  out.line = T.line ? (T.line[i] + (T.line[j] - T.line[i]) * f) / (T.w ? 1 : 7.2) : 0;
  out.i = i;
  return out;
}

function makeSample() {
  return { x: 0, y: 0, z: 0, tx: 0, tz: 1, nx: 1, nz: 0, k: 0, slope: 0, bank: 0, w: 9, line: 0, kerbL: 0, kerbR: 0, i: 0 };
}
function makePose(i) {
  return {
    i, x: 0, y: 0, z: 0, yaw: 0, rootPitch: 0, rootRoll: 0,
    pitch: 0, roll: 0, heave: 0, steer: 0, steerW: [0, 0, 0, 0], slipAngle: 0,
    spin: [0, 0, 0, 0], susp: [0, 0, 0, 0], wheelY: [0, 0, 0, 0], spinRate: 0,
    latG: 0, lonG: 0, onKerb: 0, kerbSide: 0, offTrack: 0, speed: 0, yawRate: 0,
    smoke: 0, smokeF: 0, smokeR: 0, sparks: 0, dust: 0, skid: 0, engineSmoke: 0, brake: 0,
    fwdX: 0, fwdZ: 1, velX: 0, velY: 0, velZ: 0,
  };
}
function makeState(i) {
  const r = (k) => hash01(i * 7919 + 17, k);
  return {
    i, init: false, dimsRef: null,
    // geometría (de dims)
    lf: 1.42, lr: 1.38, wb: 2.8, tw: 1.92, rad: 0.34,
    xw: new Float64Array(4), zw: new Float64Array(4), Hp: 0, Hr: 0, Hs: 0,
    // trayectoria
    s: 0, m: 0, mf: 0, phi: 0, phiV: 0, v: 0, psi: 0, kap: 0, psiDot: 0, thTraj: 0, vr: 0,
    px: 0, py: 0, pz: 0,
    ax: 0, ay: 0, ayS: 0, axS: 0, t: r(1) * 100, goT: -1,
    // carrocería: bote h, cabeceo th (+ morro arriba), balanceo ph (+ izq. arriba)
    h: 0, hv: 0, th: 0, thv: 0, ph: 0, phv: 0,
    u: new Float64Array(4), uPrev: new Float64Array(4), wy: new Float64Array(4), comp: new Float64Array(4),
    kerbW: new Float64Array(4), offW: new Float64Array(4), dustW: new Float64Array(4), fDust: 0,
    // deriva
    beta: 0, bv: 0, bss: 0,
    // dirección
    del: 0, delV: 0,
    // ruedas
    wx: new Float64Array(4), ang: new Float64Array([r(2) * TAU, r(3) * TAU, r(4) * TAU, r(5) * TAU]), vspin: 0, lock: 0,
    // errores
    prevErr: 0, errKind: 0, errOn: false, errAge: 9, errOff: 9, errDir: 1, errType: 0, errAmp: 1, errCount: 0, wob: 1,
    spinOn: false, spinAge: 0, spinBase: 0,
    dnfAge: -1,
    // fases de ruido
    ph1: r(6) * 50, ph2: r(7) * 50, ph3: r(8) * 50,
    // máximos por fotograma
    fMaxComp: 0, fKerb: 0, fOff: 0, fSlide: 0, fScrub: 0,
    pose: makePose(i),
  };
}

/* =================================================================== API */
export function createCarMotion({ track: T, sampleTrack, lateralToMetres, count = 6 } = {}) {
  const TU = MOTION_TUNING;
  const sample = typeof sampleTrack === 'function' ? sampleTrack : fallbackSampleTrack;
  const N = T.N, ds = T.ds || T.L / N, invDs = 1 / ds;
  const FB = fallbackArrays(T);
  const KL = T.kerbL || FB.KL, KR = T.kerbR || FB.KR;
  const WA = T.w || null, W0 = T.halfW || 9;
  const KIN = T.kerbIn != null ? T.kerbIn : TU.kerbIn, KOUT = T.kerbOut != null ? T.kerbOut : TU.kerbOut;
  const KK = T.k;
  const KDL = T.kerbKindL || null, KDR = T.kerbKindR || null;
  // dientes por tipo de piano: 1 vértice (plano), 2 salida (sierra), 3 entrada
  const RKL = T.runoffKindL || null, RKR = T.runoffKindR || null, RWL = T.runoffL || null, RWR = T.runoffR || null;
  // escapatoria: 0 asfalto, 1 arena, 2 hierba, 3 grava → rugosidad (m) y polvo
  const RUN_ROUGH = [0.003, 0.012, 0.014, 0.02], RUN_DUST = [0.1, 1, 0.55, 0.9];
  const kindAt = (A, s) => { let u = Math.round(s * invDs); u -= Math.floor(u / N) * N; return A[u >= N ? 0 : u]; };
  // curvatura vertical y'' (1/m) suavizada: crestas (−) y compresiones (+)
  const YC = new Float32Array(N);
  {
    const raw = new Float32Array(N);
    if (T.slope) for (let i = 0; i < N; i++) raw[i] = (T.slope[(i + 3) % N] - T.slope[(i - 3 + N) % N]) / (6 * ds);
    else for (let i = 0; i < N; i++) raw[i] = (T.y[(i + 4) % N] - 2 * T.y[i] + T.y[(i - 4 + N) % N]) / (16 * ds * ds);
    for (let i = 0; i < N; i++) { let a = 0; for (let k = -4; k <= 4; k++) a += raw[(i + k + N) % N]; YC[i] = a / 9; }
  }
  // peralte variable: la superficie a m metros del eje sube m·tan(b) → pendiente m·BD y curvatura m·BC
  const BD = new Float32Array(N), BC = new Float32Array(N);
  if (T.bank) {
    const tb = new Float32Array(N);
    for (let i = 0; i < N; i++) tb[i] = Math.tan(T.bank[i]);
    const raw = new Float32Array(N);
    for (let i = 0; i < N; i++) BD[i] = (tb[(i + 3) % N] - tb[(i - 3 + N) % N]) / (6 * ds);
    for (let i = 0; i < N; i++) raw[i] = (BD[(i + 3) % N] - BD[(i - 3 + N) % N]) / (6 * ds);
    for (let i = 0; i < N; i++) { let a = 0; for (let k = -4; k <= 4; k++) a += raw[(i + k + N) % N]; BC[i] = a / 9; }
  }
  // juntas / parches transversales fijos (mismo bache para todos los coches)
  const JT = new Float32Array(N);
  {
    const tmp = new Float32Array(N);
    for (let i = 0; i < N; i++) { const r = hash01(i, 911); if (r < 0.035) tmp[i] = (hash01(i, 37) < 0.5 ? -1 : 1) * (0.4 + 0.6 * hash01(i, 53)); }
    for (let i = 0; i < N; i++) { let a = 0; a += tmp[(i - 1 + N) % N] * 0.5 + tmp[i] + tmp[(i + 1) % N] * 0.5; JT[i] = a * TU.joints * 0.5; }
  }
  const lerpA = (A, s) => {
    let u = s * invDs; u -= Math.floor(u / N) * N;
    let i = u | 0; if (i >= N) i = 0;
    const j = i + 1 < N ? i + 1 : 0;
    return A[i] + (A[j] - A[i]) * (u - i);
  };
  const wAt = (s) => (WA ? lerpA(WA, s) : W0);
  const toMetres = lateralToMetres
    ? (s, lat) => lateralToMetres(T, s, lat)
    : (s, lat, smp) => lat * ((smp ? smp.w : wAt(s)) - CAR_HALF);

  const states = [];
  for (let i = 0; i < count; i++) states.push(makeState(i));
  const getState = (i) => { while (states.length <= i) states.push(makeState(states.length)); return states[i]; };
  const SA = makeSample(), SB = makeSample();

  function setDims(st, d) {
    st.dimsRef = d;
    const D = DEFAULT_DIMS;
    const fz = d && d.frontAxleZ != null ? d.frontAxleZ : D.frontAxleZ;
    const rz = d && d.rearAxleZ != null ? d.rearAxleZ : D.rearAxleZ;
    st.lf = fz; st.lr = -rz; st.wb = fz - rz;
    st.tw = d && d.track ? d.track : D.track;
    st.rad = d && d.wheelRadius ? d.wheelRadius : D.wheelRadius;
    const hx = st.tw / 2;
    st.xw[0] = hx; st.xw[1] = -hx; st.xw[2] = hx; st.xw[3] = -hx;
    st.zw[0] = fz; st.zw[1] = fz; st.zw[2] = rz; st.zw[3] = rz;
    let sz = 0, sx = 0;
    for (let w = 0; w < 4; w++) { sz += TU.kCorner * st.zw[w] * st.zw[w]; sx += TU.kCorner * st.xw[w] * st.xw[w]; }
    // brazos efectivos: ganancia estática = H / Σ k·r²
    st.Hs = TU.gSquat * sz; st.Hp = TU.gDive * sz; st.Hr = TU.gRoll * sx;
  }

  function resetState(st, s, m, smp) {
    st.init = true; st.s = s; st.m = m; st.mf = m; st.phi = 0; st.phiV = 0; st.v = 0;
    st.psi = Math.atan2(smp.tx, smp.tz); st.thTraj = st.psi; st.kap = 0; st.psiDot = 0; st.vr = 0;
    st.px = smp.x + smp.nx * m; st.pz = smp.z + smp.nz * m; st.py = smp.y + m * Math.tan(smp.bank || 0);
    st.ax = st.ay = st.ayS = st.axS = 0; st.goT = -1;
    st.h = st.hv = st.th = st.thv = st.ph = st.phv = 0;
    st.u.fill(0); st.uPrev.fill(0); st.wy.fill(0); st.comp.fill(0); st.kerbW.fill(0); st.offW.fill(0); st.wx.fill(0);
    st.beta = st.bv = st.bss = 0; st.del = st.delV = 0; st.vspin = 0; st.lock = 0;
    st.prevErr = 0; st.errKind = 0; st.errOn = false; st.errAge = 9; st.errOff = 9; st.spinOn = false; st.dnfAge = -1;
    st.fMaxComp = st.fKerb = st.fOff = st.fSlide = st.fScrub = 0;
    st.pose.velX = st.pose.velY = st.pose.velZ = 0;
    // carretera bajo cada rueda (p. ej. aparcado sobre un piano): sin golpe en el primer paso
    for (let w = 0; w < 4; w++) { const u = roadInput(st, w, s + st.zw[w], m + st.xw[w], 0, TU.hMax); st.u[w] = st.uPrev[w] = st.wy[w] = u; }
  }

  function reset(i, dist, lateral = 0) {
    const st = getState(i);
    if (!st.dimsRef) setDims(st, DEFAULT_DIMS);
    sample(T, dist, SA);
    const m = toMetres(dist, clamp(lateral, -1.6, 1.6), SA);
    resetState(st, dist, m, SA);
    writePose(st, SA, null, 0);
    return st.pose;
  }

  /* --------------------------------------------- carretera bajo una rueda */
  function roadInput(st, w, sw, mw, vr, hs) {
    const W = wAt(sw), left = mw > 0, am = left ? mw : -mw, e = am - W;
    let amp = TU.road, kerb = 0, off = 0, dust = 0, u = 0;
    if (e > -KIN) {
      const pres = left ? lerpA(KL, sw) : lerpA(KR, sw);
      if (pres > 0.02 && e < KOUT + 0.02) {
        // perfil del piano igual que pista.js: 1 vértice (plano, 3 cm), 2 salida (sierra 2.6–5.8 cm), 3 entrada (2 cm);
        // sube en rampa desde el interior y cae en el borde exterior
        const kd = left ? (KDL ? kindAt(KDL, sw) : 1) : (KDR ? kindAt(KDR, sw) : 1);
        let hk = kd === 3 ? 0.02 : 0.03;
        if (kd === 2) {
          const ph = sw / TU.kerbPeriod, tri = 1 - 2 * Math.abs(ph - Math.floor(ph) - 0.5);
          // anti-aliasing: los dientes se atenúan si el sub-paso es largo frente al periodo
          const aa = clamp(1.6 - 3 * (vr * hs) / TU.kerbPeriod, 0.15, 1);
          hk = 0.042 + TU.kerbRumble * aa * (2 * tri - 1);
        }
        hk *= pres > 1 ? 1 : pres;
        const e0 = -KIN + 0.2, e1 = KOUT - 0.12;
        if (e < e0) u += 0.006 + 0.6 * hk * (e + KIN) / 0.2;
        else if (e < e1) u += 0.006 + hk * (0.6 + 0.4 * (e - e0) / (e1 - e0));
        else u += (hk + 0.006) * (1 - (e - e1) / 0.14) - 0.04 * ((e - e1) / 0.14);
        kerb = pres > 1 ? 1 : pres;
      }
      // escapatoria (a ras de la pista, según pista.js): arcén de asfalto y luego arena/hierba/grava
      const offE = pres > 0.02 ? KOUT + 0.02 : 0.05;
      if (e > offE) {
        off = sstep(offE, offE + 0.25, e);
        const R = RWL ? (left ? lerpA(RWL, sw) : lerpA(RWR, sw)) : 6;
        const verge = Math.min(1.6, R * 0.5);
        const rk = e - offE > verge ? (RKL ? (left ? kindAt(RKL, sw) : kindAt(RKR, sw)) : 2) : 0;
        amp += (RUN_ROUGH[rk] - TU.road) * off;
        dust = off * RUN_DUST[rk];
      }
    }
    u += TU.vib * amp * (0.42 * Math.sin(sw * 0.861 + mw * 0.9) + 0.33 * Math.sin(sw * 0.402 - mw * 0.63 + 1.7) +
      0.25 * Math.sin(sw * 1.71 + mw * 1.3 + 4.1)) + lerpA(JT, sw) * (1 + 2 * off);
    st.kerbW[w] = kerb; st.offW[w] = off; st.dustW[w] = dust;
    return u;
  }

  /* ----------------------------------------------------------- update */
  function update(i, rc, dt, simDt, dims) {
    const st = getState(i);
    if (dims ? dims !== st.dimsRef : !st.dimsRef) setDims(st, dims || DEFAULT_DIMS);
    const s1 = +rc.dist || 0, lat1 = clamp(+rc.lateral || 0, -1.6, 1.6);
    sample(T, s1, SA);
    const m1 = toMetres(s1, lat1, SA);
    const v1 = rc.v > 0 ? +rc.v : 0;
    const dsF = s1 - st.s;
    if (!st.init || dsF < -1 || dsF > 60 + v1 * (simDt > 0 ? simDt : 0) * 3) {
      resetState(st, s1, m1, SA);
      st.v = v1;
      writePose(st, SA, rc, 0);
      return st.pose;
    }
    if (!(simDt > 0)) return st.pose;
    if (simDt > 0.5) simDt = 0.5;

    const errNow = rc.error | 0;
    const state = rc.state || (rc.finished ? 'fin' : 'run');
    const thr = clamp(rc.throttle || 0, 0, 1), slip = clamp(rc.slip || 0, 0, 1);
    // inicio de un error / trompo
    if (errNow && errNow !== st.prevErr && (!st.errOn || st.errKind !== errNow)) {
      st.errCount++;
      st.errKind = errNow; st.errOn = true; st.errAge = 0; st.errOff = 0;
      // sentido de la curva que viene (continuo: no salta de signo con el instante exacto del aviso)
      const kAv = (lerpA(KK, s1 + 5) + lerpA(KK, s1 + 15) + lerpA(KK, s1 + 25) + lerpA(KK, s1 + 35)) * 0.25;
      st.errDir = clamp(kAv / 0.008, -1, 1);
      if (st.errDir < 0.15 && st.errDir > -0.15) st.errDir += 0.5 * Math.tanh(st.ay / 8);
      const r1 = hash01(i * 131 + st.errCount, 7), r2 = hash01(i * 131 + st.errCount, 8);
      st.errType = errNow === 1 ? (r1 < 0.62 ? 0 : 1) : 0; // 0 sobreviraje, 1 subviraje
      st.errAmp = 0.8 + 0.45 * r2;
      st.wob = r1 < 0.5 ? -1 : 1;
      if (errNow === 3 && !st.spinOn) { st.spinOn = true; st.spinAge = 0; st.spinBase = st.beta; }
    } else if (!errNow && st.errOn) { st.errOn = false; st.errOff = 0; }
    st.prevErr = errNow;
    if (state === 'dnf') { if (st.dnfAge < 0) st.dnfAge = 0; } else st.dnfAge = -1;

    // sub-pasos
    const dmF = m1 - st.m, dvF = v1 - st.v;
    const chord = Math.hypot(dsF, dmF);
    let n = Math.ceil(simDt / TU.hMax);
    const nC = Math.ceil(chord / TU.chordMax);
    if (nC > n) n = nC;
    if (n > TU.nMax) n = TU.nMax;
    const hs = simDt / n, invN = 1 / n;
    const axRaw = clamp(dvF / simDt, -80, 40);
    const s0 = st.s, m0 = st.m, v0 = st.v;
    const lr = st.lr, lf = st.lf, wb = st.wb, rad = st.rad;
    const kC = TU.kCorner, cC = TU.cCorner, rp2 = TU.rp2, rr2 = TU.rr2;
    const aTau = 1 - Math.exp(-hs / 0.045), ayTau = 1 - Math.exp(-hs / 0.03);
    const spinK = 1 - Math.exp(-hs / TU.spinTau), lockK = 1 - Math.exp(-hs / TU.lockTau), tyreK = 1 - Math.exp(-hs / 0.008);
    const inErr = st.errOn || st.errAge < 1.6 || st.spinOn;
    const latMax = inErr ? TU.latAngMaxErr : TU.latAngMax0 + (TU.latAngMax - TU.latAngMax0) * clamp((v1 - 3) / 22, 0, 1);
    // a baja velocidad el filtro es más lento (curvatura del camino ∝ φ̇ / v): salida limpia
    const PW = Math.min(TU.phiW, 3 + v1 / 1.2);
    st.fMaxComp = 0; st.fKerb = 0; st.fDust = 0; st.fOff = 0; st.fSlide = 0; st.fScrub = 0;
    if (st.goT < 0 && v1 > 0.05) st.goT = 0;

    for (let j = 0; j < n; j++) {
      const fm = (j + 0.5) * invN;
      const sm = s0 + dsF * fm, mm = m0 + dmF * fm;
      const vj = v0 + dvF * (j + 1) * invN;
      sample(T, sm, SB);
      // ---- rumbo cinemático: eje trasero remolcado por el origen (tractriz) ----
      const psiC = Math.atan2(SB.tx, SB.tz);
      let dsp = dsF * invN * (1 - SB.k * mm); if (dsp < 0) dsp = 0;
      const dmp = dmF * invN;
      const vh = TU.vFloor * hs;
      let latA = Math.atan2(dmp, dsp > vh ? dsp : vh);
      latA = sat(latA, latMax);
      // ángulo lateral filtrado (2º orden crítico): sin quiebros aunque el lateral del sim los tenga
      st.phiV += (PW * PW * (latA - st.phi) - 2 * PW * st.phiV) * hs;
      st.phi += st.phiV * hs;
      let th = psiC + st.phi;
      th = st.psi + wrapPi(th - st.psi);
      st.thTraj = th;
      const d = Math.sqrt(dsp * dsp + dmp * dmp);
      const psiOld = st.psi;
      if (d > 1e-7) {
        let e = st.psi - th;
        if (e > 3.1) e = 3.1; else if (e < -3.1) e = -3.1;
        const e2 = 2 * Math.atan(Math.tan(e * 0.5) * Math.exp(-d / lr));
        st.psi = th + e2;
        st.kap = clamp((st.psi - psiOld) / d, -0.3, 0.3);
      }
      const psiDot = (st.psi - psiOld) / hs;
      st.psiDot = psiDot;
      const vr = d / hs; st.vr = vr;
      // ---- aceleraciones percibidas ----
      st.ax += (axRaw - st.ax) * aTau;
      const ayRaw = vr * psiDot;
      st.ay += (ayRaw - st.ay) * ayTau;
      const tb = Math.tan(SB.bank || 0);
      const relC = st.psi + st.beta - psiC;
      const cr = Math.cos(relC), sr = Math.sin(relC);
      const grade = (SB.slope || 0) * cr + tb * sr;
      const ayF = sat(st.ay + G0 * tb * cr, TU.aSat);   // + peralte: el lado alto "empuja" hacia el bajo
      const axF = sat(st.ax + G0 * grade, TU.aSat);
      st.ayS = ayF; st.axS = axF;
      const vv = vj * (1 - SB.k * mm);                 // velocidad real sobre la trayectoria (sin la deriva lateral)
      const av = vv * vv * (lerpA(YC, sm) + mm * lerpA(BC, sm));
      // ---- entradas de carretera en cada rueda ----
      for (let w = 0; w < 4; w++) {
        const xw = st.xw[w], zw = st.zw[w];
        const sw = sm + zw * cr - xw * sr, mw = mm + xw * cr + zw * sr;
        const u = roadInput(st, w, sw, mw, vr, hs);
        st.uPrev[w] = st.u[w]; st.u[w] = u;
        st.wy[w] += (u - st.wy[w]) * tyreK;
      }
      // ---- carrocería: 4 muelles-amortiguadores (sólido rígido: bote, cabeceo, balanceo) ----
      let F = 0, Fz = 0, Fx = 0;
      for (let w = 0; w < 4; w++) {
        const xw = st.xw[w], zw = st.zw[w];
        const zi = st.h + st.th * zw + st.ph * xw;
        const zd = st.hv + st.thv * zw + st.phv * xw;
        const ud = (st.u[w] - st.uPrev[w]) / hs;
        const c = st.u[w] - zi;                       // compresión (+)
        let f = kC * c + cC * (ud - zd);
        if (c > TU.travel) f += kC * 9 * (c - TU.travel); // tope de suspensión
        F += f; Fz += f * zw; Fx += f * xw;
        st.comp[w] = c;
      }
      // fondo plano: caída del morro (splitter) / cola respecto al reposo → chispas
      const drop = -(st.h + st.th * (lf + 0.55)), dropR = -(st.h - st.th * (lr + 0.45));
      const fd = drop > dropR ? drop : dropR;
      if (fd > st.fMaxComp) st.fMaxComp = fd;
      const go = st.goT >= 0 ? st.goT : 0;
      const launch = st.goT >= 0 && go < 3.5 && vj < 35 ? 1 : 0;
      const fh = -av - TU.aero * vv * vv;
      const Mth = axF * (axF > 0 ? st.Hs : st.Hp);
      // reacción del par motor (salida / acelerones a baja velocidad)
      const Mtr = -2.5 * thr * clamp(1 - vj / 25, 0, 1) * (rc.rpm || 0.5);
      const Mph = ayF * st.Hr + Mtr;
      st.hv += (F + fh) * hs; st.thv += ((Fz + Mth) / rp2) * hs; st.phv += ((Fx + Mph) / rr2) * hs;
      st.h += st.hv * hs; st.th += st.thv * hs; st.ph += st.phv * hs;

      // ---- deriva (guiñada de la carrocería sobre la trayectoria) ----
      const lat01 = clamp(Math.abs(ayF) / 20, 0, 1);
      // deriva estable: al límite la trasera desliza lo justo para anular el morro-fuera geométrico (L_r/R)
      // y quedar ligeramente morro-dentro; despacio (sin carga) se ve la cinemática pura
      const load = Math.tanh(ayF / 35);
      const bss = TU.alphaR * load + TU.neutral * (load < 0 ? -load : load) * Math.atan(lr * st.kap);
      st.bss = bss;
      let bt = bss, dErr = 0, lock = 0, scrub = 0;
      // deriva extra cuando el sim dice que va al límite (slip en curva); se apaga durante los errores
      if (!st.errOn && vj > 12) bt += sstep(1.2, 2.2, st.errAge) * Math.sign(ayF) * TU.slipBeta * Math.max(0, slip - 0.12) * lat01;
      const ea = st.errAge;
      if (ea < 2.6 || st.errOn) {
        // envolvente: sube en 0.25 s, baja en 0.45 s al terminar el aviso; los episodios 1/2 duran ≤ 2.6 s
        const env = sstep(0, 0.25, ea) * (st.errOn ? 1 : 1 - sstep(0, 0.45, st.errOff)) * (st.errKind === 4 ? 1 : 1 - sstep(2.0, 2.6, ea));
        const dir = st.errDir, A = st.errAmp;
        if (st.errKind === 1) {
          if (st.errType === 0) bt += dir * TU.errOver * A * env * (1 - 0.45 * sstep(0.3, 1.2, ea));
          else { bt -= dir * 0.035 * A * env; dErr = dir * 0.13 * A * env; scrub = env; }
        } else if (st.errKind === 4) {
          // pasado de trazada / fuera de pista: un poco más de volante (subviraje); polvo y baches los da la geometría
          dErr = dir * 0.04 * env;
        } else if (st.errKind === 2) {
          lock = ea < 0.5 ? 1 : 1 - sstep(0.5, 0.72, ea);
          bt += st.wob * 0.045 * A * Math.sin(ea * 8.8) * env;
          scrub = 0.4 * env;
        }
      }
      if (launch) bt += 0.02 * slip * sn(st.t * 7.1, st.ph2);
      if (vj > 5) bt += TU.vib * 0.0015 * clamp(vj / 50, 0, 1) * sn(st.t * 4.3, st.ph3);
      const errMode = (ea < 2.6 || st.errOn) && st.errKind !== 0;
      const bw = errMode ? TU.betaWErr : TU.betaW, bz = errMode ? TU.betaZErr : TU.betaZ;
      if (st.spinOn) {
        st.spinAge += hs;
        const k = clamp(st.spinAge / 1.5, 0, 1), e3 = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        const sd = st.errDir >= 0 ? 1 : -1;
        const nb = st.spinBase + sd * TAU * e3;
        st.bv = (nb - st.beta) / hs; st.beta = nb;
        if (k >= 1) { st.spinOn = false; st.beta -= sd * TAU; st.bv = 0; }
      } else {
        st.bv += (bw * bw * (bt - st.beta) - 2 * bz * bw * st.bv) * hs;
        st.beta += st.bv * hs;
      }
      const slide = Math.abs(st.beta - bss);
      if (slide > st.fSlide) st.fSlide = slide;
      if (scrub > st.fScrub) st.fScrub = scrub;

      // ---- dirección: Ackermann (bici) + subviraje + contravolante + correcciones ----
      const us = TU.usK0 + TU.usK1 * clamp((vv - 40) / 40, 0, 1);
      let dt_ = Math.atan(wb * st.kap) + us * ayF - (st.beta - bss) - 0.6 * lf * st.bv / (vr > 8 ? vr : 8) + dErr;
      dt_ += TU.vib * (TU.steerNoise * clamp(vv / 50, 0, 1) + 0.004 * lat01) * sn(st.t * 5.3, st.ph1);
      if (st.spinOn) dt_ = st.errDir >= 0 ? -0.5 : 0.5;
      if (dt_ > TU.steerMax) dt_ = TU.steerMax; else if (dt_ < -TU.steerMax) dt_ = -TU.steerMax;
      const sw2 = TU.steerW;
      st.delV += (sw2 * sw2 * (dt_ - st.del) - 2 * sw2 * st.delV) * hs;
      const rmax = errMode || st.spinOn ? TU.steerRateErr : TU.steerRate;
      if (st.delV > rmax) st.delV = rmax; else if (st.delV < -rmax) st.delV = -rmax;
      st.del += st.delV * hs;

      // ---- ruedas: rodadura exacta + patinaje (salida) / bloqueo ----
      let vspin = 0;
      if (launch) vspin = TU.launchSpin * thr * Math.max(0, slip - 0.35) * clamp(1 - vj / 30, 0, 1);
      if (slide > 0.06 && thr > 0.4) vspin += 6 * (slide - 0.06) * thr;
      if (st.spinOn) vspin = 14;
      st.vspin = vspin; st.lock = lock;
      const kp = st.kap;
      for (let w = 0; w < 4; w++) {
        const a = 1 - kp * st.xw[w];
        const vg = w < 2 ? vr * Math.sqrt(a * a + kp * kp * wb * wb) : vr * a;
        const roll = vg / rad;
        let tgt, kk;
        if (w < 2) { tgt = -lock * roll; kk = lock > 0.5 ? lockK : spinK; }
        else { tgt = vspin / rad; kk = spinK; }
        st.wx[w] += (tgt - st.wx[w]) * kk;
        let om = roll + st.wx[w]; if (om < 0) om = 0;
        let ang = st.ang[w] + om * hs;
        if (ang > TAU) ang -= TAU * Math.floor(ang / TAU);
        st.ang[w] = ang;
      }
      st.t += hs;
      if (st.goT >= 0) st.goT += hs;
      if (st.errAge < 9) st.errAge += hs;
      if (!st.errOn && st.errOff < 9) st.errOff += hs;
      if (st.dnfAge >= 0) st.dnfAge += hs;
      if (!st.spinOn && ea > 2.6 && !st.errOn) st.errKind = 0;
    }
    // métricas de rueda (máximos del fotograma)
    for (let w = 0; w < 4; w++) {
      if (st.kerbW[w] > st.fKerb) st.fKerb = st.kerbW[w];
      st.fOff += st.offW[w] * 0.25;
      st.fDust += st.dustW[w] * 0.25;
    }
    st.s = s1; st.m = m1; st.mf = m1; st.v = v1;
    writePose(st, SA, rc, simDt);
    return st.pose;
  }

  /* --------------------------------------------------- salida (pose) */
  function writePose(st, smp, rc, simDt) {
    const P = st.pose, m = st.mf;
    const tb = Math.tan(smp.bank || 0);
    const x = smp.x + smp.nx * m, z = smp.z + smp.nz * m, y = smp.y + m * tb;
    if (simDt > 0) { const iv = 1 / simDt; P.velX = (x - st.px) * iv; P.velY = (y - st.py) * iv; P.velZ = (z - st.pz) * iv; }
    else if (!rc) { P.velX = P.velY = P.velZ = 0; }
    st.px = x; st.py = y; st.pz = z;
    P.x = x; P.y = y; P.z = z;
    const yaw = st.psi + st.beta;
    // orientación del plano de la carretera bajo el coche (pendiente + peralte)
    const sl = (smp.slope || 0) + m * lerpA(BD, st.s);
    const t3x = smp.tx, t3y = sl, t3z = smp.tz, l3x = smp.nx, l3y = tb, l3z = smp.nz;
    const nX = t3y * l3z - t3z * l3y, nY = t3z * l3x - t3x * l3z, nZ = t3x * l3y - t3y * l3x;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const nn = nX * nX + nY * nY + nZ * nZ, fd = (fx * nX + fz * nZ) / nn;
    const fpx = fx - fd * nX, fpy = -fd * nY, fpz = fz - fd * nZ;
    const fl = Math.sqrt(fpx * fpx + fpy * fpy + fpz * fpz) || 1;
    const rp = -Math.asin(clamp(fpy / fl, -1, 1));
    const lx = nY * fpz - nZ * fpy, ly = nZ * fpx - nX * fpz, lz = nX * fpy - nY * fpx;
    const ll = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
    const rr = Math.asin(clamp(ly / ll / Math.cos(rp), -1, 1));
    P.yaw = wrapPi(yaw); P.rootPitch = rp; P.rootRoll = rr;
    P.fwdX = fx; P.fwdZ = fz;
    // vibración fina (motor / velocidad) sumada a la salida
    const v = st.vr, t = st.t;
    const idle = rc ? clamp(1 - v / 20, 0, 1) * (0.4 + 0.6 * (rc.rpm || 0.3)) : 0;
    const fast = clamp(v / 70, 0, 1);
    const VB = TU.vib;
    const vib = VB * 0.00045 * idle * sn(t * 71, st.ph2) + 0.0007 * fast * sn(t * 83, st.ph3);
    P.heave = st.h + vib;
    P.pitch = st.th + VB * 0.0004 * fast * sn(t * 67, st.ph1);
    P.roll = st.ph + VB * (0.0005 * idle * sn(t * 59, st.ph1) + 0.0003 * fast * sn(t * 61, st.ph2));
    // dirección por rueda (Ackermann a partir del ángulo de la bici)
    const del = st.del;
    let ke = Math.tan(del) / st.wb; ke = clamp(ke, -0.35, 0.35);
    const hw = st.tw / 2;
    P.steer = del;
    const AK = TU.ackermann;
    P.steerW[0] = del + AK * (Math.atan(st.wb * ke / (1 - ke * hw)) - del);
    P.steerW[1] = del + AK * (Math.atan(st.wb * ke / (1 + ke * hw)) - del);
    P.steerW[2] = 0; P.steerW[3] = 0;
    for (let w = 0; w < 4; w++) {
      P.spin[w] = st.ang[w];
      P.susp[w] = st.comp[w];
      P.wheelY[w] = st.wy[w];
    }
    P.spinRate = (v + st.vspin) / st.rad;
    P.slipAngle = wrapPi(yaw - st.thTraj);
    P.yawRate = st.psiDot + st.bv;
    P.latG = st.ayS / G0; P.lonG = st.axS / G0;
    P.speed = v;
    P.onKerb = st.fKerb; P.kerbSide = st.fKerb > 0 ? (st.m >= 0 ? 1 : -1) : 0;
    P.offTrack = st.fOff;
    // indicaciones para partículas
    const slideS = clamp((st.fSlide - 0.075) / 0.12, 0, 1) * clamp(v / 15, 0, 1);
    const spinS = clamp(st.vspin / 7, 0, 1);
    P.smokeR = Math.max(slideS, spinS);
    P.smokeF = Math.max(st.lock * clamp(v / 8, 0, 1), st.fScrub * 0.6 * clamp(v / 15, 0, 1));
    P.smoke = Math.max(P.smokeR, P.smokeF);
    P.skid = Math.max(P.smoke, st.lock);
    P.sparks = clamp((st.fMaxComp - TU.bottom) / 0.015, 0, 1) * clamp((v - 45) / 25, 0, 1);
    P.dust = clamp(st.fDust * 1.6, 0, 1) * clamp(v / 12, 0, 1);
    P.engineSmoke = st.dnfAge >= 0 ? 0.2 + 0.8 * (1 - sstep(0, 10, st.dnfAge)) : 0;
    let b = rc ? clamp((rc.brake || 0) * 1.3 - 0.05, 0, 1) : 0;
    if (st.lock > 0) b = 1;
    P.brake = b;
    return P;
  }

  /* ------------------------------------------------------------ apply */
  const REST = new WeakMap();
  function apply(P, model) {
    if (!model || !P) return;
    let R = REST.get(model);
    if (!R) {
      R = { bodyY: model.body ? model.body.position.y : 0, wy: [0, 0, 0, 0] };
      if (model.wheels) for (let w = 0; w < 4 && w < model.wheels.length; w++) R.wy[w] = model.wheels[w].steer.position.y;
      if (model.root) model.root.rotation.order = 'YXZ';
      REST.set(model, R);
    }
    const root = model.root;
    root.position.set(P.x, P.y, P.z);
    root.rotation.set(P.rootPitch, P.yaw, P.rootRoll);
    const body = model.body;
    if (body) {
      body.position.y = R.bodyY + P.heave;
      body.rotation.set(-P.pitch, 0, P.roll);
    }
    const W = model.wheels;
    if (W) {
      for (let w = 0; w < 4 && w < W.length; w++) {
        const wh = W[w];
        wh.steer.rotation.y = P.steerW[w];
        wh.steer.position.y = R.wy[w] + P.wheelY[w];
        if (wh.spin) wh.spin.rotation.x = P.spin[w];
      }
    }
    if (model.setBrake) model.setBrake(P.brake);
  }

  return {
    reset, update, apply,
    pose: (i) => getState(i).pose,
    tuning: TU,
    /** depuración: estado interno de un coche */
    _state: (i) => getState(i),
  };
}
