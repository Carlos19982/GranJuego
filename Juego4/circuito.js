/* =========================================================================
   GRAN PREMIO NEÓN · Geometría del circuito
   Spline cerrada (x, z, altura) muestreada cada metro desde la línea de meta:
   posición, tangente, normal izquierda, curvatura con signo (+ = izquierda),
   pendiente, trazada ideal, curvas y zonas notables para el decorado.
   Sin dependencias: lo usa la página (render) y se exporta la curvatura al
   simulador de carrera (carrera-sim.js · buildTrack({ length, k, step })).
   ========================================================================= */

export const HALF_W = 9;      // semiancho de pista (m)
export const LAT_MAX = 7.2;   // desplazamiento lateral máximo del centro del coche (lateral = ±1)
export const GRID_STEP = 6.5; // metros entre puestos de parrilla
export const LAPS = 2;

/* ---------------------------------------------------------- CIRCUITO */
// Puntos de control [x, z, y]. Recta principal hacia +x; línea de meta en s = 0.
const CTRL = [
  [-60, 0, 0],
  [80, 0, 0],
  [200, 0, 0],
  [267.5, 18.1, 0.5],
  [316.9, 67.5, 1.5],
  [335.0, 135.0, 2.5],
  [335, 215, 3.5],
  [320, 262, 4.5],
  [338, 310, 5.5],
  [334, 352, 6],
  [329.6, 394.2, 6],
  [318.0, 410.8, 6],
  [297.8, 412.6, 6],
  [283.4, 398.2, 6],
  [268, 350, 6],
  [238, 328, 6.3],
  [190, 314, 7],
  [110, 290, 9],
  [10, 266, 6],
  [-90, 248, 1.5],
  [-138, 246, 0.5],
  [-160, 236, 0],
  [-182, 236, 0],
  [-205, 246, 0],
  [-240, 240, 0],
  [-330.4, 228.9, 0],
  [-392.2, 177.0, 0],
  [-408.0, 118.0, 0],
  [-392.2, 59.0, 0],
  [-330.4, 7.1, 0],
  [-200, 0, 0],
];

function catmull(p0, p1, p2, p3, t, out) {
  // centrípeta
  const d = (a, b) => Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), 0.5) || 1e-4;
  const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
  const tt = t1 + (t2 - t1) * t;
  for (let k = 0; k < 3; k++) {
    const A1 = ((t1 - tt) / (t1 - t0)) * p0[k] + ((tt - t0) / (t1 - t0)) * p1[k];
    const A2 = ((t2 - tt) / (t2 - t1)) * p1[k] + ((tt - t1) / (t2 - t1)) * p2[k];
    const A3 = ((t3 - tt) / (t3 - t2)) * p2[k] + ((tt - t2) / (t3 - t2)) * p3[k];
    const B1 = ((t2 - tt) / (t2 - t0)) * A1 + ((tt - t0) / (t2 - t0)) * A2;
    const B2 = ((t3 - tt) / (t3 - t1)) * A2 + ((tt - t1) / (t3 - t1)) * A3;
    out[k] = ((t2 - tt) / (t2 - t1)) * B1 + ((tt - t1) / (t2 - t1)) * B2;
  }
  return out;
}
function resampleClosed(px, py, pz, ds) {
  const n = px.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    cum[i + 1] = cum[i] + Math.hypot(px[j] - px[i], pz[j] - pz[i]);
  }
  const L = cum[n];
  const m = Math.round(L / ds);
  const step = L / m;
  const ox = new Float64Array(m), oy = new Float64Array(m), oz = new Float64Array(m);
  let k = 0;
  for (let i = 0; i < m; i++) {
    const s = i * step;
    while (k < n - 1 && cum[k + 1] < s) k++;
    const j = (k + 1) % n, f = (s - cum[k]) / (cum[k + 1] - cum[k] || 1);
    ox[i] = px[k] + (px[j] - px[k]) * f; oy[i] = py[k] + (py[j] - py[k]) * f; oz[i] = pz[k] + (pz[j] - pz[k]) * f;
  }
  return { x: ox, y: oy, z: oz, L, step };
}
function smoothClosed(a, radius, iters) {
  const n = a.length; let src = Float64Array.from(a), dst = new Float64Array(n);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += src[(i + k + n) % n];
      dst[i] = acc / (2 * radius + 1);
    }
    const t = src; src = dst; dst = t;
  }
  return src;
}
function gaussSmoothClosed(a, sigma) {
  const n = a.length, R = Math.ceil(sigma * 2.5), w = [];
  let ws = 0;
  for (let k = -R; k <= R; k++) { const v = Math.exp(-(k * k) / (2 * sigma * sigma)); w.push(v); ws += v; }
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -R; k <= R; k++) acc += a[(i + k + n) % n] * w[k + R];
    o[i] = acc / ws;
  }
  return o;
}

let _track = null;
export function buildCircuit() {
  if (_track) return _track;
  // 1) spline densa
  const P = CTRL, n = P.length, SUB = 40;
  const dx = [], dy = [], dz = [], tmp = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
    for (let j = 0; j < SUB; j++) {
      catmull(p0, p1, p2, p3, j / SUB, tmp);
      dx.push(tmp[0]); dz.push(tmp[1]); dy.push(tmp[2]);
    }
  }
  // 2) remuestreo uniforme + suavizado (curvatura continua)
  let r = resampleClosed(dx, dy, dz, 1);
  let sx = smoothClosed(r.x, 6, 3), sz = smoothClosed(r.z, 6, 3), sy = smoothClosed(r.y, 12, 4);
  r = resampleClosed(sx, sy, sz, 1);
  // empezar en la línea de meta: punto más cercano a (0,0)
  let best = 0, bd = 1e18;
  for (let i = 0; i < r.x.length; i++) { const d = r.x[i] * r.x[i] + r.z[i] * r.z[i]; if (d < bd) { bd = d; best = i; } }
  const N = r.x.length;
  const X = new Float32Array(N), Y = new Float32Array(N), Z = new Float32Array(N);
  for (let i = 0; i < N; i++) { const j = (i + best) % N; X[i] = r.x[j]; Y[i] = r.y[j]; Z[i] = r.z[j]; }
  const L = r.L, ds = L / N;
  const TX = new Float32Array(N), TZ = new Float32Array(N), NX = new Float32Array(N), NZ = new Float32Array(N), HD = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i - 2 + N) % N, b = (i + 2) % N;
    let tx = X[b] - X[a], tz = Z[b] - Z[a]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    TX[i] = tx; TZ[i] = tz; NX[i] = tz; NZ[i] = -tx; // normal izquierda
    HD[i] = Math.atan2(tz, tx);
  }
  const kRaw = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i - 3 + N) % N, b = (i + 3) % N;
    let d = HD[b] - HD[a];
    while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    kRaw[i] = -d / (6 * ds); // + = curva a izquierdas
  }
  const K = gaussSmoothClosed(kRaw, 4);
  const KN = gaussSmoothClosed(kRaw, 14), KW = gaussSmoothClosed(kRaw, 46);
  const SL = new Float32Array(N), LINE = new Float32Array(N), KEFF = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i - 4 + N) % N, b = (i + 4) % N;
    SL[i] = (Y[b] - Y[a]) / (8 * ds);
    const v = (KN[i] - 0.62 * KW[i]) / 0.0042;
    LINE[i] = 6.2 * Math.tanh(v);
    KEFF[i] = Math.abs(K[i]) * 0.78; // la trazada abre la curva
  }
  // curvas
  const corners = [];
  const TH = 1 / 260;
  let i0 = -1;
  for (let i = 0; i <= N; i++) {
    const on = i < N && Math.abs(K[i]) > TH;
    if (on && i0 < 0) i0 = i;
    if (!on && i0 >= 0) {
      let ap = i0, km = 0;
      for (let k = i0; k < i; k++) if (Math.abs(K[k]) > km) { km = Math.abs(K[k]); ap = k; }
      if (i - i0 > 6) {
        const prev = corners[corners.length - 1];
        if (prev && i0 - prev.s1 < 25 && Math.sign(K[ap]) === prev.dir) { prev.s1 = i; if (km > 1 / prev.R) { prev.R = 1 / km; prev.apex = ap; } }
        else corners.push({ s0: i0, s1: i, apex: ap, dir: Math.sign(K[ap]), R: 1 / km });
      }
      i0 = -1;
    }
  }
  corners.forEach((c) => { c.s0 *= ds; c.s1 *= ds; c.apex *= ds; c.entry = Math.max(5, c.s0 - 25); });
  // dirección de la siguiente curva (para elegir el lado del adelantamiento)
  const NEXT = new Int8Array(N);
  for (let i = 0; i < N; i++) {
    let d = 0;
    for (let k = 20; k < 220; k += 10) { const kk = K[(i + k) % N]; if (Math.abs(kk) > TH) { d = Math.sign(kk); break; } }
    NEXT[i] = d;
  }
  const grid = [];
  for (let k = 0; k < 6; k++) grid.push({ s: -8 - GRID_STEP * k, lat: k % 2 === 0 ? -2.7 : 2.7 });
  _track = {
    N, L, ds, x: X, y: Y, z: Z, tx: TX, tz: TZ, nx: NX, nz: NZ, hd: HD, k: K, kEff: KEFF, slope: SL, line: LINE, next: NEXT,
    corners, grid, sectors: [Math.round(N * 0.36), Math.round(N * 0.7)],
    raceD: L * LAPS,
    /** Curvatura para el simulador (paso de 1 m). */
    sim: { length: L, k: Float32Array.from(K), step: ds },
  };
  _track.meta = trackMeta(_track);
  return _track;
}
function trackMeta(T) {
  // zonas notables para el decorado (por distancia)
  const nearest = (x, z) => { let b = 0, bd = 1e18; for (let i = 0; i < T.N; i++) { const d = (T.x[i] - x) ** 2 + (T.z[i] - z) ** 2; if (d < bd) { bd = d; b = i; } } return b * T.ds; };
  return {
    tunnel: [nearest(160, 302), nearest(70, 276)],
    bridge: nearest(-40, 254),
    hairpin: nearest(286, 404),
    chicane: nearest(-168, 232),
    t1: nearest(325, 70),
  };
}

