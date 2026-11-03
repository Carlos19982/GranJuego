/* =========================================================================
   GRAN PREMIO NEÓN · Geometría de los circuitos (sin three.js, probado en node)

   Cada trazado vive en `pistas/<id>.js` (puntos de control Catmull-Rom
   centrípetos [x, z, y], anchos, peraltes, escapatorias, hitos…). Aquí se
   convierte en una pista muestreada cada ~1 m desde la línea de meta:
   posición, tangente, normal izquierda, curvatura con signo (+ = izquierda),
   pendiente, peralte, semiancho, trazada ideal (curvatura mínima con vértice
   tardío), pianos, escapatorias, curvas con nombre, hitos resueltos a
   distancia, boxes, parrilla y una rejilla espacial para `distToTrack`.

   API
     CIRCUITS                       [{ id, name, short, desc, favours, laps }] (solo los trazados que existen)
     buildCircuit(id = 'neon') → T  (en caché por id)
     sampleTrack(T, s, out)         interpolado en cualquier s (se envuelve): x,y,z, tx,tz, nx,nz, k, slope,
                                    bank, w, line, kerbL, kerbR, i
     lateralToMetres(T, s, lat)     = lat · (w(s) − 1.2)
     metresToLateral(T, s, m)
     distToTrack(T, x, z, out?, y?) → { d, s, side, lat, i }  (rejilla espacial; y desempata puentes)
     registerLayout(layout)         añade/reemplaza un trazado (pruebas, validador)
     buildFromLayout(layout)        sin caché · getLayout(id)

   T (Float32Array por muestra de ~1 m salvo indicación):
     id name short desc favours laps weatherOdds theme{asphalt,kerbA,kerbB,line,glow,…,runoff,barrier,night}
     N L ds x y z tx tz nx nz hd k slope bank w halfWidth line kLine
     kerbL kerbR (0..1) kerbKindL/R (Uint8: 1 vértice plano · 2 salida dientes de sierra · 3 entrada)
     kerbIn = 1.0, kerbOut = 0.6 (m: el piano va de w − kerbIn a w + kerbOut)
     runoffL runoffR (m desde el borde hasta la barrera) runoffW (= máx) wallL wallR (= w + runoff)
     runoffKindL/R (índices de RUNOFF_KINDS) barrierKindL/R (índices de BARRIER_KINDS)
     corners [{ s0, s1, apex, entry, dir, R, angle, kind, num, name, label, chicane? }]
     landmarks [{ type, name, side, s, s0, s1, x, z, cross?: { sTop, sBottom, dy } }]
     pit { s0, s1, side, lat0, lat1, wall, ramp, name } (lat en m con signo; s0 < 0 si cruza la meta)
     grid [{ s, lat, latM }] · sectors [i1, i2] (índices) · raceD
     sim { length, k, step, line, halfW, w, kLine } · compat: meta, kEff, next
   ========================================================================= */

export const HALF_W = 9;      // (compat) semiancho de pista por defecto (m)
export const CAR_HALF = 1.2;  // margen lateral: lateral ±1 ⇒ centro del coche a w − 1.2 m del eje (ADDENDUM B)
export const LAT_MAX = HALF_W - CAR_HALF; // (compat) 7.8 m
export const KERB_IN = 1.0, KERB_OUT = 0.6; // pianos de w − 1.0 a w + 0.6 m
export const GRID_STEP = 6.5; // metros entre puestos de parrilla
export const LAPS = 4;
export const RUNOFF_KINDS = ['asfalto', 'arena', 'hierba', 'grava'];
export const BARRIER_KINDS = ['muro', 'neumaticos', 'guardarrail'];
export const KERB_KINDS = ['', 'vertice', 'salida', 'entrada']; // 1 plano en el vértice · 2 dientes de sierra a la salida · 3 entrada

/* ------------------------------------------------------- trazados */
const IDS = ['neon', 'desierto', 'puerto'];
const LAYOUTS = {};
await Promise.all(IDS.map(async (id) => {
  try {
    const m = await import(`./pistas/${id}.js`);
    if (m && m.default && Array.isArray(m.default.points)) LAYOUTS[id] = m.default;
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (!/Cannot find module|Failed to fetch|ERR_MODULE_NOT_FOUND|404|error loading dynamically imported/i.test(msg)) console.warn('[circuito] pistas/' + id + '.js:', msg);
  }
}));
export const CIRCUITS = [];
function refreshList() {
  CIRCUITS.length = 0;
  const ids = IDS.filter((id) => LAYOUTS[id]).concat(Object.keys(LAYOUTS).filter((id) => !IDS.includes(id)));
  for (const id of ids) {
    const l = LAYOUTS[id];
    CIRCUITS.push({ id, name: l.name || id, short: l.short || (l.name || id).toUpperCase(), desc: l.desc || '', favours: l.favours || 'equilibrado', laps: l.laps || LAPS });
  }
}
refreshList();
const _cache = new Map();
export function registerLayout(layout) {
  LAYOUTS[layout.id] = layout;
  _cache.delete(layout.id);
  refreshList();
}
export function getLayout(id) { return LAYOUTS[id] || null; }
export function buildCircuit(id = 'neon') {
  if (_cache.has(id)) return _cache.get(id);
  let L = LAYOUTS[id];
  if (!L) {
    console.warn('[circuito] trazado desconocido', id, '→ neon');
    L = LAYOUTS.neon || LAYOUTS[Object.keys(LAYOUTS)[0]];
    if (!L) throw new Error('No hay trazados en pistas/');
    if (_cache.has(L.id)) { _cache.set(id, _cache.get(L.id)); return _cache.get(id); }
  }
  const T = buildFromLayout(L);
  _cache.set(id, T); _cache.set(L.id, T);
  return T;
}

/* ------------------------------------------------------- utilidades */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth01 = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
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
function gauss(a, sigma) {
  const n = a.length, o = new Float32Array(n);
  if (sigma <= 0.3) { o.set(a); return o; }
  const R = Math.ceil(sigma * 2.5), w = [];
  let ws = 0;
  for (let k = -R; k <= R; k++) { const v = Math.exp(-(k * k) / (2 * sigma * sigma)); w.push(v); ws += v; }
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -R; k <= R; k++) acc += a[(((i + k) % n) + n) % n] * w[k + R];
    o[i] = acc / ws;
  }
  return o;
}
function minFilter(a, r) {
  const n = a.length, o = new Float32Array(n);
  for (let i = 0; i < n; i++) { let m = Infinity; for (let k = -r; k <= r; k++) { const v = a[(((i + k) % n) + n) % n]; if (v < m) m = v; } o[i] = m; }
  return o;
}
const wrapS = (s, L) => s - Math.floor(s / L) * L;
/** Recorre las muestras de [s0, s1] (s1 ≥ s0, se envuelve). */
function forRange(N, ds, s0, s1, fn) {
  const a = Math.round(s0 / ds), b = Math.round(s1 / ds);
  for (let k = a; k <= b; k++) fn((((k % N) + N) % N), k * ds);
}
/** Diferencia s1 − s0 llevada a (−L/2, L/2]. */
const dS = (a, b, L) => { let d = b - a; d -= Math.round(d / L) * L; return d; };

/* ------------------------------------------------------- muestreo */
export function sampleTrack(T, s, out = {}) {
  const N = T.N;
  let u = s / T.ds; u -= Math.floor(u / N) * N;
  let i = u | 0; if (i >= N) i = 0;
  const f = u - i, j = i + 1 < N ? i + 1 : 0, g = 1 - f;
  out.x = T.x[i] * g + T.x[j] * f; out.y = T.y[i] * g + T.y[j] * f; out.z = T.z[i] * g + T.z[j] * f;
  let tx = T.tx[i] * g + T.tx[j] * f, tz = T.tz[i] * g + T.tz[j] * f;
  const l = Math.sqrt(tx * tx + tz * tz) || 1; tx /= l; tz /= l;
  out.tx = tx; out.tz = tz; out.nx = tz; out.nz = -tx;
  out.k = T.k[i] * g + T.k[j] * f;
  out.slope = T.slope[i] * g + T.slope[j] * f;
  out.bank = T.bank[i] * g + T.bank[j] * f;
  out.w = T.w[i] * g + T.w[j] * f;
  out.line = T.line[i] * g + T.line[j] * f;
  out.kerbL = T.kerbL[i] * g + T.kerbL[j] * f;
  out.kerbR = T.kerbR[i] * g + T.kerbR[j] * f;
  out.i = i;
  return out;
}
function wAt(T, s) { const N = T.N; let u = s / T.ds; u -= Math.floor(u / N) * N; let i = u | 0; if (i >= N) i = 0; const f = u - i, j = i + 1 < N ? i + 1 : 0; return T.w[i] + (T.w[j] - T.w[i]) * f; }
export function lateralToMetres(T, s, lateral) { return lateral * (wAt(T, s) - CAR_HALF); }
export function metresToLateral(T, s, m) { return m / (wAt(T, s) - CAR_HALF); }

/* ------------------------------------------------------- rejilla espacial */
const CELL = 12;
function buildGrid(T) {
  const { N, x, z } = T;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < N; i++) { if (x[i] < x0) x0 = x[i]; if (x[i] > x1) x1 = x[i]; if (z[i] < z0) z0 = z[i]; if (z[i] > z1) z1 = z[i]; }
  const gw = Math.floor((x1 - x0) / CELL) + 1, gh = Math.floor((z1 - z0) / CELL) + 1;
  const cnt = new Int32Array(gw * gh + 1);
  const cellOf = (i) => clamp(Math.floor((x[i] - x0) / CELL), 0, gw - 1) + gw * clamp(Math.floor((z[i] - z0) / CELL), 0, gh - 1);
  for (let i = 0; i < N; i++) cnt[cellOf(i) + 1]++;
  for (let c = 0; c < gw * gh; c++) cnt[c + 1] += cnt[c];
  const fill = cnt.slice(0, gw * gh), items = new Int32Array(N);
  for (let i = 0; i < N; i++) items[fill[cellOf(i)]++] = i;
  return { x0, z0, gw, gh, start: cnt, items };
}
const _dq = { d: 0, s: 0, side: 1, lat: 0, i: 0 };
/**
 * Distancia (xz) desde (x, z) a la línea central. `y` opcional desempata
 * cruces a distinto nivel (puentes). side: +1 izquierda / −1 derecha.
 */
export function distToTrack(T, x, z, out = { d: 0, s: 0, side: 1, lat: 0, i: 0 }, y) {
  const G = T._grid, N = T.N, X = T.x, Z = T.z, Y = T.y;
  const useY = typeof y === 'number';
  let best = Infinity, bi = 0, bf = 0;
  const test = (i) => {
    const j = i + 1 < N ? i + 1 : 0;
    const ax = X[i], az = Z[i], ex = X[j] - ax, ez = Z[j] - az;
    let f = ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1); f = f < 0 ? 0 : f > 1 ? 1 : f;
    const px = ax + ex * f - x, pz = az + ez * f - z;
    let sc = px * px + pz * pz;
    if (useY) { const dy = (Y[i] + (Y[j] - Y[i]) * f - y) * 3; sc += dy * dy; }
    if (sc < best) { best = sc; bi = i; bf = f; }
  };
  const cx = Math.floor((x - G.x0) / CELL), cz = Math.floor((z - G.z0) / CELL);
  const ccx = clamp(cx, 0, G.gw - 1), ccz = clamp(cz, 0, G.gh - 1);
  const outside = Math.max(Math.abs(cx - ccx), Math.abs(cz - ccz));
  const maxR = Math.max(G.gw, G.gh);
  for (let r = 0; r <= maxR; r++) {
    // cota inferior de distancia para el anillo r
    const lb = Math.max(0, r - 1, outside - 1) * CELL;
    if (lb * lb > best) break;
    for (let gz = ccz - r; gz <= ccz + r; gz++) {
      if (gz < 0 || gz >= G.gh) continue;
      const edge = gz === ccz - r || gz === ccz + r;
      for (let gx = ccx - r; gx <= ccx + r; gx += edge ? 1 : 2 * r || 1) {
        if (gx < 0 || gx >= G.gw) continue;
        const c = gx + gz * G.gw;
        for (let k = G.start[c], e = G.start[c + 1]; k < e; k++) { const i = G.items[k]; test(i); test(i ? i - 1 : N - 1); }
      }
    }
  }
  const j = bi + 1 < N ? bi + 1 : 0;
  const cxp = X[bi] + (X[j] - X[bi]) * bf, czp = Z[bi] + (Z[j] - Z[bi]) * bf;
  const nx = T.nx[bi], nz = T.nz[bi];
  const lat = (x - cxp) * nx + (z - czp) * nz;
  out.d = Math.hypot(x - cxp, z - czp);
  out.s = (bi + bf) * T.ds;
  out.side = lat >= 0 ? 1 : -1;
  out.lat = lat;
  out.i = bf < 0.5 ? bi : j;
  return out;
}

/* ------------------------------------------------------- construcción */
const DEF_SURFACE = { asphalt: '#2a2a33', kerbA: '#e8173a', kerbB: '#f4f1ff', line: '#ffffff', glow: null };

export function buildFromLayout(Lay) {
  /* 1) spline densa → remuestreo uniforme → suavizado */
  const P = Lay.points.map((p) => [p[0], p[1], p[2] || 0]), n = P.length, SUB = 40;
  const dx = [], dy = [], dz = [], tmp = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
    for (let j = 0; j < SUB; j++) {
      catmull(p0, p1, p2, p3, j / SUB, tmp);
      dx.push(tmp[0]); dz.push(tmp[1]); dy.push(tmp[2]);
    }
  }
  let r = resampleClosed(dx, dy, dz, 1);
  const sm = Lay.smooth || 6;
  let sx = smoothClosed(r.x, sm, 3), sz = smoothClosed(r.z, sm, 3), sy = smoothClosed(r.y, 12, 4);
  r = resampleClosed(sx, sy, sz, 1);
  // empezar en la línea de meta: punto más cercano a (0,0) (a nivel del suelo si hay cruces)
  let best = 0, bd = 1e18;
  for (let i = 0; i < r.x.length; i++) { const d = r.x[i] * r.x[i] + r.z[i] * r.z[i] + r.y[i] * r.y[i] * 4; if (d < bd) { bd = d; best = i; } }
  const N = r.x.length;
  const X = new Float32Array(N), Y = new Float32Array(N), Z = new Float32Array(N);
  for (let i = 0; i < N; i++) { const j = (i + best) % N; X[i] = r.x[j]; Y[i] = r.y[j]; Z[i] = r.z[j]; }
  const L = r.L, ds = L / N;

  /* 2) tangente, normal izquierda, rumbo, curvatura, pendiente */
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
  const K = gauss(kRaw, 4);
  const KN = gauss(kRaw, 14), KW = gauss(kRaw, 46);
  const SL = new Float32Array(N);
  for (let i = 0; i < N; i++) { const a = (i - 4 + N) % N, b = (i + 4) % N; SL[i] = (Y[b] - Y[a]) / (8 * ds); }

  const T = {
    id: Lay.id, name: Lay.name || Lay.id, short: Lay.short || '', desc: Lay.desc || '', favours: Lay.favours || 'equilibrado',
    laps: Lay.laps || LAPS, weatherOdds: { seco: 0.6, humedo: 0.25, viento: 0.15, ...(Lay.weatherOdds || {}) },
    N, L, ds, x: X, y: Y, z: Z, tx: TX, tz: TZ, nx: NX, nz: NZ, hd: HD, k: K, slope: SL,
  };
  T.theme = { ...DEF_SURFACE, ...(Lay.surface || {}), runoff: Lay.runoff || 'asfalto', barrier: Lay.barrier || 'muro', night: Lay.night != null ? !!Lay.night : !!(Lay.surface && Lay.surface.glow) };
  T._grid = buildGrid(T);
  const nearestS = (x, z, y) => distToTrack(T, x, z, {}, y).s;
  /** zona de un override: { s0, s1 } o { x, z, r } → peso por muestra (0..1) */
  const zoneWeights = (zn, feather = 12) => {
    const wv = new Float32Array(N);
    if (zn.s0 != null && zn.s1 != null) {
      let s0 = zn.s0, s1 = zn.s1; if (s1 < s0) s1 += L;
      forRange(N, ds, s0, s1, (i) => { wv[i] = 1; });
    } else if (zn.x != null) {
      const rr = zn.r || 40;
      for (let i = 0; i < N; i++) {
        const d = Math.hypot(X[i] - zn.x, Z[i] - zn.z);
        if (d < rr + feather) wv[i] = smooth01((rr + feather - d) / (2 * feather));
        if (zn.y != null && Math.abs(Y[i] - zn.y) > 5) wv[i] = 0;
      }
    }
    return wv;
  };

  /* 3) semiancho */
  const W0 = Lay.halfWidth || HALF_W;
  let Wr = new Float32Array(N).fill(W0);
  for (const zn of Lay.widths || []) { const wv = zoneWeights(zn); for (let i = 0; i < N; i++) if (wv[i] > 0) Wr[i] = Wr[i] + (zn.w - Wr[i]) * wv[i]; }
  const W = gauss(Wr, 12);
  T.w = W; T.halfWidth = W0; T.halfW = W0;

  /* 4) peralte (+ = lado izquierdo arriba; por defecto, exterior de la curva arriba) */
  const BK = new Float32Array(N);
  for (const zn of Lay.banking || []) {
    const wv = zoneWeights(zn, (zn.r || 40) * 0.5);
    let acc = 0; for (let i = 0; i < N; i++) acc += wv[i] * KN[i];
    const sgn = zn.side ? zn.side : acc > 0 ? -1 : 1; // exterior de la curva dominante arriba
    for (let i = 0; i < N; i++) if (wv[i] > 0) {
      BK[i] += sgn * Math.abs(zn.deg || 0) * (Math.PI / 180) * wv[i];
    }
  }
  T.bank = gauss(BK, 10);

  /* 5) curvas */
  const corners = [];
  const TH = 1 / 260;
  {
    let i0 = -1;
    // empezar el barrido en una recta para no partir una curva por la meta
    let st = 0; for (let i = 0; i < N; i++) if (Math.abs(K[i]) < TH * 0.5) { st = i; break; }
    for (let q = 0; q <= N; q++) {
      const i = q + st;
      const on = q < N && Math.abs(K[i % N]) > TH;
      if (on && i0 < 0) i0 = i;
      if (!on && i0 >= 0) {
        let ap = i0, km = 0, ang = 0;
        for (let k = i0; k < i; k++) { const kk = Math.abs(K[k % N]); ang += kk * ds; if (kk > km) { km = kk; ap = k; } }
        if (i - i0 > 6) {
          const prev = corners[corners.length - 1];
          const dir = Math.sign(K[ap % N]);
          if (prev && i0 - prev._i1 < 25 && dir === prev.dir) { prev._i1 = i; prev.angle += ang; if (km > 1 / prev.R) { prev.R = 1 / km; prev._ap = ap; } }
          else corners.push({ _i0: i0, _i1: i, _ap: ap, dir, R: 1 / km, angle: ang });
        }
        i0 = -1;
      }
    }
  }
  for (const c of corners) { c.s0 = c._i0 * ds; c.s1 = c._i1 * ds; c.apex = c._ap * ds; delete c._i0; delete c._i1; delete c._ap; }
  // normaliza a [0, L) para s0 (s1/apex pueden pasar de L) y quita los "codos" sin entidad
  for (let q = corners.length - 1; q >= 0; q--) {
    const c = corners[q];
    if (c.angle < 0.2) { corners.splice(q, 1); continue; }
    if (c.s0 >= L) { c.s0 -= L; c.s1 -= L; c.apex -= L; }
  }
  corners.sort((a, b) => a.s0 - b.s0);
  corners.forEach((c, q) => {
    c.entry = c.s0 - 25;
    c.kind = c.angle > 2.1 && c.R < 40 ? 'horquilla' : c.R < 45 ? 'lenta' : c.R < 110 ? 'media' : 'rapida';
    c.num = q + 1;
  });
  // chicanes: dos curvas cortas encadenadas de signo contrario
  for (let q = 0; q < corners.length; q++) {
    const a = corners[q], b = corners[(q + 1) % corners.length];
    if (a === b) break;
    let gap = b.s0 - a.s1; if (gap < -L / 2) gap += L;
    if (a.dir !== b.dir && gap < 30 && a.angle < 1.7 && b.angle < 1.7 && a.R < 90 && b.R < 90 && !a.chicane) { a.chicane = 1; b.chicane = 2; }
  }
  // nombres: overrides del trazado (cornerNames) → hitos con nombre → pareja de chicane → por tipo → "Curva N"
  const LM = Lay.landmarks || [];
  for (const c of corners) {
    const ia = Math.round(c.apex / ds) % N, ax = X[ia], az = Z[ia];
    let nm = null, bd = Infinity;
    for (const cn of Lay.cornerNames || []) { const d = Math.hypot(cn.x - ax, cn.z - az); if (d < (cn.r || 70) && d < bd) { bd = d; nm = cn.name; } }
    if (!nm) for (const lm of LM) {
      if ((lm.type === 'hairpin' && c.kind === 'horquilla') || (lm.type === 'chicane' && c.chicane)) {
        if (lm.name && Math.hypot(lm.x - ax, lm.z - az) < 90) nm = lm.name;
      }
    }
    c.name = nm;
  }
  corners.forEach((c, q) => {
    if (c.name || !c.chicane) return;
    const mate = corners[(q + (c.chicane === 1 ? 1 : -1) + corners.length) % corners.length];
    if (mate.name) c.name = mate.name;
  });
  for (const c of corners) {
    if (!c.name) c.name = c.kind === 'horquilla' ? 'Horquilla' : c.chicane ? 'Chicane' : 'Curva ' + c.num;
    c.label = /^Curva \d+$/.test(c.name) ? c.name : `${c.name} (C${c.num})`;
  }
  T.corners = corners;
  const cornerAt = (s) => { for (const c of corners) { if (dS(c.s0 - 8, s, L) >= 0 && dS(s, c.s1 + 8, L) >= 0) return c; } return null; };

  /* 6) trazada ideal (curvatura mínima por descenso proyectado multinivel + vértice tardío) */
  const LINE = racingLine(T, corners);
  T.line = LINE;
  // curvatura de la trazada (para el simulador / presentación)
  T.kLine = lineCurvature(T, LINE);

  /* 7) pianos: plano en el vértice (interior), dientes de sierra a la salida (exterior), entrada en las lentas */
  const kerbL = new Float32Array(N), kerbR = new Float32Array(N), kindL = new Uint8Array(N), kindR = new Uint8Array(N);
  const putKerb = (side, s0, s1, kind) => {
    const A = side > 0 ? kerbL : kerbR, Kd = side > 0 ? kindL : kindR;
    forRange(N, ds, s0, s1, (i, s) => {
      const p = Math.min(1, (s - s0) / 2.5, (s1 - s) / 2.5);
      if (p > A[i]) A[i] = p;
      if (!Kd[i] || kind === 2) Kd[i] = kind;
    });
  };
  for (const c of corners) {
    if (c.R > 260 && c.angle < 0.5) continue;
    const inside = c.dir, outside = -c.dir, half0 = c.apex - c.s0, half1 = c.s1 - c.apex;
    putKerb(inside, c.apex - Math.max(10, 0.55 * half0) - 4, c.apex + Math.max(10, 0.55 * half1) + 4, 1);
    const exLen = clamp(12 + 1200 / Math.max(c.R, 20), 18, 55);
    putKerb(outside, c.apex + 0.25 * half1, c.s1 + exLen, 2);
    if (c.R < 120) putKerb(outside, c.s0 - 22, c.s0 + 6, 3);
  }
  T.kerbL = kerbL; T.kerbR = kerbR; T.kerbKindL = kindL; T.kerbKindR = kindR; T.kerbIn = KERB_IN; T.kerbOut = KERB_OUT;

  /* 8) hitos resueltos a distancia */
  const landmarks = [];
  for (const lm of LM) {
    const o = { type: lm.type, name: lm.name || '', side: lm.side || 0, x: lm.x, z: lm.z };
    if (lm.x2 != null) {
      let a = nearestS(lm.x, lm.z, lm.y), b = nearestS(lm.x2, lm.z2, lm.y2 != null ? lm.y2 : lm.y);
      if (b < a) { if (a - b > L / 2) a -= L; else { const t = a; a = b; b = t; } }
      o.s0 = a; o.s1 = b; o.s = (a + b) / 2; o.x2 = lm.x2; o.z2 = lm.z2;
    } else {
      const s = nearestS(lm.x, lm.z, lm.y);
      const half = { stand: 50, tunnel: 40, pits: 180, jump: 10, bridge: 4, hairpin: 30, chicane: 30, custom: 20 }[lm.type] || 20;
      o.s = s; o.s0 = s - half; o.s1 = s + half;
      const c = cornerAt(s);
      if ((lm.type === 'hairpin' || lm.type === 'chicane') && c) {
        let c0 = c.s0, c1 = c.s1;
        if (lm.type === 'chicane' && c.chicane) { const q = corners.indexOf(c); const mate = corners[(q + (c.chicane === 1 ? 1 : -1) + corners.length) % corners.length]; c0 = Math.min(c0, mate.s0); c1 = Math.max(c1, mate.s1); }
        o.s0 = c0 - 10; o.s1 = c1 + 10; o.s = (o.s0 + o.s1) / 2;
      }
      if (!o.side && c && lm.type === 'stand') o.side = -c.dir;
    }
    if (o.s0 >= L) { o.s0 -= L; o.s1 -= L; o.s -= L; }
    if (o.s1 > L && o.s0 > L / 2) { o.s0 -= L; o.s1 -= L; o.s -= L; }
    if (!o.side) o.side = lm.type === 'pits' ? -1 : 1;
    if (lm.type === 'bridge') {
      // ¿cruce a distinto nivel? busca otra pasada en el mismo xz
      const iA = Math.round(wrapS(o.s, L) / ds) % N;
      let bj = -1, bdd = Infinity;
      for (let j = 0; j < N; j++) {
        if (Math.abs(dS(j * ds, iA * ds, L)) < 60) continue;
        const d = Math.hypot(X[j] - X[iA], Z[j] - Z[iA]);
        if (d < bdd) { bdd = d; bj = j; }
      }
      if (bj >= 0 && bdd < W[iA] + W[bj] + 6) {
        const up = Y[iA] >= Y[bj] ? iA : bj, lo = up === iA ? bj : iA;
        o.cross = { sTop: up * ds, sBottom: lo * ds, dy: Y[up] - Y[lo] };
        o.s = up * ds; o.s0 = o.s - (W[lo] + 14); o.s1 = o.s + (W[lo] + 14);
      }
    }
    landmarks.push(o);
  }
  T.landmarks = landmarks;
  const inLm = (type, s, pad = 0) => landmarks.some((l) => l.type === type && dS(l.s0 - pad, s, L) >= 0 && dS(s, l.s1 + pad, L) >= 0);
  T.inLandmark = (type, s, pad = 0) => inLm(type, s, pad);

  /* 9) calle de boxes */
  {
    const lp = landmarks.find((l) => l.type === 'pits');
    let s0, s1, side;
    if (lp) { s0 = lp.s0; s1 = lp.s1; side = lp.side || -1; }
    else {
      // por defecto: recta de meta
      let a = 0, b = 0;
      while (a > -L / 2 && Math.abs(K[Math.round(wrapS(a - 1, L) / ds) % N]) < TH) a -= 1;
      while (b < L / 2 && Math.abs(K[Math.round(b / ds) % N]) < TH) b += 1;
      s0 = Math.max(a + 30, -260); s1 = Math.min(b - 30, 200); side = -1;
    }
    const wp = Math.max(W[Math.round(wrapS(s0 + 60, L) / ds) % N], W[Math.round(wrapS(s1 - 60, L) / ds) % N], W[0]);
    const lpL = Lay.landmarks && Lay.landmarks.find((l) => l.type === 'pits');
    const in0 = (lpL && lpL.lat0 != null) ? Math.abs(lpL.lat0) : wp + 2.2;
    const in1 = (lpL && lpL.lat1 != null) ? Math.abs(lpL.lat1) : in0 + 12;
    T.pit = { s0, s1, side, lat0: side * in0, lat1: side * in1, wall: side * (in0 - 0.6), ramp: Math.min(60, (s1 - s0) * 0.18), name: (lp && lp.name) || 'Boxes' };
  }
  const inPit = (s, pad = 0) => dS(T.pit.s0 - pad, s, L) >= 0 && dS(s, T.pit.s1 + pad, L) >= 0;

  /* 10) escapatorias (metros desde el borde hasta la barrera), por lado */
  const base = { muro: 3.2, neumaticos: 4, guardarrail: 3.6 }[T.theme.barrier] || 3.5;
  const KS = gauss(K, 10);
  const rawL = new Float32Array(N).fill(base), rawR = new Float32Array(N).fill(base);
  for (const c of corners) {
    const extraOut = clamp(5 + 1100 / Math.max(c.R, 18), 6, 24) * clamp(c.angle / 0.9, 0.4, 1);
    const outside = -c.dir;
    const A = outside > 0 ? rawL : rawR, B = outside > 0 ? rawR : rawL;
    forRange(N, ds, c.s0 - 30, c.s1 + 45, (i, s) => {
      const f = Math.min(smooth01((s - (c.s0 - 30)) / 30), smooth01((c.s1 + 45 - s) / 35));
      A[i] = Math.max(A[i], base + extraOut * f);
      B[i] = Math.max(B[i], base + 2.5 * f);
    });
  }
  for (const zn of Lay.runoffs || []) {
    if (zn.w == null) continue;
    const wv = zoneWeights(zn);
    for (let i = 0; i < N; i++) if (wv[i] > 0) { if (zn.side !== -1) rawL[i] += (zn.w - rawL[i]) * wv[i]; if (zn.side !== 1) rawR[i] += (zn.w - rawR[i]) * wv[i]; }
  }
  // límites duros: interior de curva, otras partes de la pista, túneles, puentes
  const limL = new Float32Array(N).fill(60), limR = new Float32Array(N).fill(60);
  for (let i = 0; i < N; i++) {
    const k = KS[i];
    if (k > 1e-3) limL[i] = Math.min(limL[i], 0.85 / k - W[i] - 2);
    if (k < -1e-3) limR[i] = Math.min(limR[i], 0.85 / -k - W[i] - 2);
  }
  {
    // rayos laterales cada 3 muestras contra la rejilla: ¿hay otro tramo (mismo nivel) cerca?
    const G = T._grid, STEP = 3;
    const hitL = new Float32Array(N).fill(60), hitR = new Float32Array(N).fill(60);
    for (let i = 0; i < N; i += STEP) {
      for (const side of [1, -1]) {
        const lim = side > 0 ? limL : limR;
        const maxT = W[i] + Math.min(lim[i], 45) + 12;
        for (let t = W[i] + 1; t < maxT; t += 1.5) {
          const px = X[i] + NX[i] * side * t, pz = Z[i] + NZ[i] * side * t;
          const cx = clamp(Math.floor((px - G.x0) / CELL), 0, G.gw - 1), cz = clamp(Math.floor((pz - G.z0) / CELL), 0, G.gh - 1);
          let hit = false;
          for (let gz = Math.max(0, cz - 1); gz <= Math.min(G.gh - 1, cz + 1) && !hit; gz++) for (let gx = Math.max(0, cx - 1); gx <= Math.min(G.gw - 1, cx + 1) && !hit; gx++) {
            const c = gx + gz * G.gw;
            for (let q = G.start[c], e = G.start[c + 1]; q < e; q++) {
              const j = G.items[q];
              const ddx = X[j] - px, ddz = Z[j] - pz, rr = W[j] + 2;
              if (ddx * ddx + ddz * ddz > rr * rr) continue;
              const along = Math.abs(dS(i * ds, j * ds, L));
              const eu = Math.hypot(X[j] - X[i], Z[j] - Z[i]);
              if (along < 1.5 * eu + 25) continue; // misma zona de pista
              if (Math.abs(Y[j] - Y[i]) > 5) continue; // cruce a distinto nivel
              hit = true; break;
            }
          }
          if (hit) { (side > 0 ? hitL : hitR)[i] = (t - W[i] - 2) / 2 - 0.5; break; }
        }
      }
    }
    for (const [H, lim] of [[hitL, limL], [hitR, limR]]) {
      for (let i = 0; i < N; i++) {
        const a = Math.floor(i / STEP) * STEP, b = (a + STEP) % N;
        const v = Math.min(H[a], H[b]);
        if (v < lim[i]) lim[i] = v;
      }
    }
  }
  for (const l of landmarks) {
    if (l.type === 'tunnel') forRange(N, ds, l.s0 - 6, l.s1 + 6, (i) => { limL[i] = Math.min(limL[i], 1.6); limR[i] = Math.min(limR[i], 1.6); });
    if (l.type === 'bridge' && l.cross) forRange(N, ds, l.s0, l.s1, (i) => { limL[i] = Math.min(limL[i], 1.6); limR[i] = Math.min(limR[i], 1.6); });
  }
  const finish = (raw, lim) => {
    let a = new Float32Array(N); for (let i = 0; i < N; i++) a[i] = Math.min(raw[i], lim[i]);
    a = gauss(minFilter(a, 6), 5);
    for (let i = 0; i < N; i++) a[i] = Math.max(1.2, Math.min(a[i], lim[i]));
    a = gauss(a, 2);
    for (let i = 0; i < N; i++) a[i] = Math.max(1.2, Math.min(a[i], Math.max(1.2, lim[i])));
    return a;
  };
  const RL = finish(rawL, limL), RR = finish(rawR, limR);
  // en boxes, el lado de boxes queda reservado hasta el borde exterior del carril
  {
    const p = T.pit, A = p.side > 0 ? RL : RR, outer = Math.abs(p.lat1);
    forRange(N, ds, p.s0, p.s1, (i, s) => {
      const f = Math.min(smooth01((s - p.s0) / p.ramp), smooth01((p.s1 - s) / p.ramp));
      A[i] = Math.max(A[i], (outer - W[i]) * f + A[i] * (1 - f));
    });
  }
  T.runoffL = RL; T.runoffR = RR;
  const RW = new Float32Array(N), WL = new Float32Array(N), WR = new Float32Array(N);
  for (let i = 0; i < N; i++) { RW[i] = Math.max(RL[i], RR[i]); WL[i] = W[i] + RL[i]; WR[i] = W[i] + RR[i]; }
  T.runoffW = RW; T.wallL = WL; T.wallR = WR;
  // tipos de escapatoria / barrera por lado
  const code = (arr, v, def) => { const c = arr.indexOf(v); return c >= 0 ? c : def; };
  const roDef = code(RUNOFF_KINDS, T.theme.runoff, 0), baDef = code(BARRIER_KINDS, T.theme.barrier, 0);
  const rkL = new Uint8Array(N).fill(roDef), rkR = new Uint8Array(N).fill(roDef), bkL = new Uint8Array(N).fill(baDef), bkR = new Uint8Array(N).fill(baDef);
  for (const zn of Lay.runoffs || []) {
    if (!zn.type) continue; const cd = code(RUNOFF_KINDS, zn.type, roDef), wv = zoneWeights(zn, 0);
    for (let i = 0; i < N; i++) if (wv[i] > 0.5) { if (zn.side !== -1) rkL[i] = cd; if (zn.side !== 1) rkR[i] = cd; }
  }
  for (const zn of Lay.barriers || []) {
    const cd = code(BARRIER_KINDS, zn.type, baDef), wv = zoneWeights(zn, 0);
    for (let i = 0; i < N; i++) if (wv[i] > 0.5) { if (zn.side !== -1) bkL[i] = cd; if (zn.side !== 1) bkR[i] = cd; }
  }
  T.runoffKindL = rkL; T.runoffKindR = rkR; T.barrierKindL = bkL; T.barrierKindR = bkR;

  /* 11) parrilla, sectores, simulador */
  {
    const c1 = corners.find((c) => c.angle > 0.5) || corners[0];
    const pole = c1 ? c1.dir : -1; // la pole, por el interior de la primera curva
    const gl = Lay.gridLat || 0.38;
    T.grid = [];
    for (let k = 0; k < 6; k++) {
      const s = -(Lay.gridFront || 8) - GRID_STEP * k, lat = (k % 2 === 0 ? pole : -pole) * gl;
      T.grid.push({ s, lat, latM: lateralToMetres(T, s, lat) });
    }
  }
  {
    const fr = Lay.sectors || [0.36, 0.7];
    T.sectors = fr.map((f) => {
      let bi = Math.round(N * f), bk = Infinity;
      for (let d = -80; d <= 80; d++) { const i = (Math.round(N * f) + d + N) % N; const v = Math.abs(K[i]) + Math.abs(d) * 1e-5; if (v < bk) { bk = v; bi = i; } }
      return bi;
    });
  }
  T.raceD = L * T.laps;
  T.sim = { length: L, k: Float32Array.from(K), step: ds, line: Float32Array.from(LINE), halfW: W0, w: Float32Array.from(W), kLine: Float32Array.from(T.kLine) };

  /* 12) compatibilidad con la página antigua */
  const KEFF = new Float32Array(N), NEXT = new Int8Array(N);
  for (let i = 0; i < N; i++) {
    KEFF[i] = Math.abs(K[i]) * 0.78;
    let d = 0;
    for (let k = 20; k < 220; k += 10) { const kk = K[(i + k) % N]; if (Math.abs(kk) > TH) { d = Math.sign(kk); break; } }
    NEXT[i] = d;
  }
  T.kEff = KEFF; T.next = NEXT;
  const firstLm = (type) => landmarks.find((l) => l.type === type);
  const tun = firstLm('tunnel'), br = firstLm('bridge'), hp = firstLm('hairpin'), ch = firstLm('chicane');
  const hpC = corners.find((c) => c.kind === 'horquilla'), chC = corners.find((c) => c.chicane);
  const st1 = landmarks.find((l) => l.type === 'stand' && corners[0] && Math.abs(dS(l.s, corners[0].apex, L)) < 120);
  T.meta = {
    tunnel: tun ? [wrapS(tun.s0, L), wrapS(tun.s0, L) + (tun.s1 - tun.s0)] : [L * 0.5, L * 0.5 + 60],
    bridge: br ? wrapS(br.s, L) : L * 0.62,
    hairpin: hp ? wrapS(hp.s, L) : hpC ? hpC.apex : L * 0.3,
    chicane: ch ? wrapS(ch.s, L) : chC ? chC.apex : L * 0.65,
    t1: st1 ? wrapS(st1.s, L) : corners[0] ? corners[0].apex : 300,
  };
  T.layout = Lay;
  return T;
}

/* ------------------------------------------------------- trazada ideal */
/** curvatura con signo del camino C + n·line·(w − 1.2) */
function lineCurvature(T, LINE) {
  const { N, x: X, z: Z, nx: NX, nz: NZ, w: W, ds } = T;
  const lx = new Float32Array(N), lz = new Float32Array(N), lh = new Float32Array(N), kl = new Float32Array(N);
  for (let i = 0; i < N; i++) { const m = LINE[i] * (W[i] - CAR_HALF); lx[i] = X[i] + NX[i] * m; lz[i] = Z[i] + NZ[i] * m; }
  for (let i = 0; i < N; i++) { const a = (i - 2 + N) % N, b = (i + 2) % N; lh[i] = Math.atan2(lz[b] - lz[a], lx[b] - lx[a]); }
  for (let i = 0; i < N; i++) {
    const a = (i - 3 + N) % N, b = (i + 3) % N;
    let d = lh[b] - lh[a]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    const len = Math.hypot(lx[b] - lx[a], lz[b] - lz[a]) || 6 * ds;
    kl[i] = -d / len;
  }
  return gauss(kl, 4);
}
/**
 * Curvatura mínima: e(s) (m, + = izquierda) minimiza Σ (n·Δ²P)² con P = C + e·n,
 * |e| ≤ 0.93·(w − 1.2). Descenso proyectado acelerado (FISTA) de grueso a fino;
 * luego vértice tardío en las curvas lentas (se desplaza el perfil hacia la salida)
 * y suavizado (derivada continua). Devuelve unidades laterales (−1..1).
 */
export const LINE_TUNE = { lam0: 0.006, lamChicane: 0.06, lamExit: 0.05, lateApex: 4, exitSlope: 0.1 };
function racingLine(T, corners) {
  const { N, x: X, z: Z, nx: NX, nz: NZ, w: W, ds, L } = T;
  const bound = (i) => 0.93 * (W[i] - CAR_HALF);
  // penalización del cambio lateral (ángulo respecto al eje): pequeña en todo el circuito, mayor en chicanes/eses
  // rápidas para que se crucen con una trazada más plana
  const lam = new Float32Array(N).fill(LINE_TUNE.lam0);
  for (const c of corners) {
    if (!c.chicane) continue;
    const a = c.s0 - 25, b = c.s1 + 25;
    forRange(N, ds, a, b, (i, s) => { const f = Math.min(smooth01((s - a) / 20), smooth01((b - s) / 20)); lam[i] = Math.max(lam[i], LINE_TUNE.lamChicane * f); });
  }
  // salida de horquillas / curvas lentas: deshacer la trazada con más calma (el coche ya acelera)
  for (const c of corners) {
    if (c.chicane || c.R > 45 || c.angle < 1.2) continue;
    const a = c.apex + 0.5 * (c.s1 - c.apex), b = c.s1 + 70;
    forRange(N, ds, a, b, (i, s) => { const f = Math.min(smooth01((s - a) / 20), smooth01((b - s) / 30)); lam[i] = Math.max(lam[i], LINE_TUNE.lamExit * f); });
  }
  let prevE = null, prevM = 0;
  for (const h of [32, 16, 8, 4]) {
    const M = Math.max(16, Math.round(N / h));
    const idx = new Int32Array(M), cx = new Float64Array(M), cz = new Float64Array(M), nx = new Float64Array(M), nz = new Float64Array(M), b = new Float64Array(M), dp = new Float64Array(M);
    for (let m = 0; m < M; m++) { const i = Math.round((m * N) / M) % N; idx[m] = i; cx[m] = X[i]; cz[m] = Z[i]; nx[m] = NX[i]; nz[m] = NZ[i]; b[m] = bound(i); }
    for (let m = 0; m < M; m++) { const p = (m - 1 + M) % M; dp[m] = nx[p] * nx[m] + nz[p] * nz[m]; }
    let e = new Float64Array(M);
    if (prevE) for (let m = 0; m < M; m++) { const u = (m / M) * prevM, a = Math.floor(u), f = u - a; e[m] = prevE[a % prevM] * (1 - f) + prevE[(a + 1) % prevM] * f; }
    const y = Float64Array.from(e), c = new Float64Array(M), g = new Float64Array(M), en = new Float64Array(M);
    const om = new Float64Array(M), px = new Float64Array(M), pz = new Float64Array(M), hh = (L / M);
    const lm = new Float64Array(M), lsc = (hh / 4) * (hh / 4);
    let lmax = 0; for (let m = 0; m < M; m++) { lm[m] = lam[idx[m]] * lsc; if (lm[m] > lmax) lmax = lm[m]; }
    const iters = h >= 16 ? 1500 : h === 8 ? 1200 : 900;
    let t = 1, alpha = 0.028;
    for (let it = 0; it < iters; it++) {
      // Σ κ² ds con κ ≈ (n·Δ²P)/s², ds = s (s = espaciado local de la trazada): peso ω = (h/s)³, retardado una iteración
      for (let m = 0; m < M; m++) { px[m] = cx[m] + nx[m] * y[m]; pz[m] = cz[m] + nz[m] * y[m]; }
      let omax = 0;
      for (let m = 0; m < M; m++) {
        const p = (m - 1 + M) % M, q = (m + 1) % M;
        const ax = px[p] - 2 * px[m] + px[q], az = pz[p] - 2 * pz[m] + pz[q];
        c[m] = ax * nx[m] + az * nz[m];
        if (it % 10 === 0) { const sp = Math.hypot(px[q] - px[p], pz[q] - pz[p]) / (2 * hh); om[m] = 1 / (sp * sp * sp); }
        if (om[m] > omax) omax = om[m];
      }
      if (it % 10 === 0) alpha = 0.9 / (32 * omax + 8 * lmax);
      for (let m = 0; m < M; m++) {
        const p = (m - 1 + M) % M, q = (m + 1) % M;
        g[m] = 2 * (om[p] * c[p] * dp[m] - 2 * om[m] * c[m] + om[q] * c[q] * dp[q]) + 2 * (lm[p] * (y[m] - y[p]) - lm[m] * (y[q] - y[m]));
      }
      const tn = (1 + Math.sqrt(1 + 4 * t * t)) / 2, mom = (t - 1) / tn;
      for (let m = 0; m < M; m++) { let v = y[m] - alpha * g[m]; v = v > b[m] ? b[m] : v < -b[m] ? -b[m] : v; en[m] = v; }
      for (let m = 0; m < M; m++) { y[m] = en[m] + mom * (en[m] - e[m]); e[m] = en[m]; }
      t = tn;
      if (it % 200 === 199) t = 1; // reinicio del momento (más estable con restricciones)
    }
    prevE = e; prevM = M;
  }
  // a 1 m
  let E = new Float32Array(N);
  for (let i = 0; i < N; i++) { const u = (i / N) * prevM, a = Math.floor(u), f = u - a; E[i] = prevE[a % prevM] * (1 - f) + prevE[(a + 1) % prevM] * f; }
  E = gauss(E, 3);
  // vértice tardío: desplaza el perfil lateral hacia la salida en las curvas lentas (no en chicanes).
  // Sube hasta el vértice y se deshace despacio a la salida (pendiente ≤ exitSlope) para no
  // comprimir el deshacer de la trazada: E2(s) = E(s − δ(s)), compresión = 1 − δ'.
  const late = corners.filter((c) => !(c.R > 130 || c.angle < 0.6 || c.chicane));
  const scale = late.map(() => 1);
  const build = () => {
    const shift = new Float32Array(N);
    late.forEach((c, q) => {
      const dmax = clamp(c.angle / Math.PI, 0, 1.1) * clamp(45 / c.R, 0.25, 1.3) * LINE_TUNE.lateApex * scale[q];
      const a0 = Math.min(c.s0, c.apex - 20) - 10, a1 = c.apex;
      const a2 = a1 + Math.max(50, (dmax * Math.PI) / (2 * LINE_TUNE.exitSlope));
      const d = Math.min(dmax, (0.6 * 2 * (a1 - a0)) / Math.PI);
      forRange(N, ds, a0, a2, (i, s) => {
        const v = s < a1 ? 0.5 * (1 - Math.cos((Math.PI * (s - a0)) / (a1 - a0))) : 0.5 * (1 + Math.cos((Math.PI * (s - a1)) / (a2 - a1)));
        shift[i] = Math.max(shift[i], d * v);
      });
    });
    const E2 = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let u = i - shift[i] / ds; u -= Math.floor(u / N) * N;
      const a = Math.floor(u), f = u - a;
      E2[i] = E[a % N] * (1 - f) + E[(a + 1) % N] * f;
    }
    const out = gauss(E2, 2.5);
    for (let i = 0; i < N; i++) out[i] = clamp(out[i] / (W[i] - CAR_HALF), -0.95, 0.95);
    return out;
  };
  // la trazada nunca debe ser más cerrada que la curva: si el vértice tardío lo provoca, se reduce en esa curva
  let out = build();
  for (let it = 0; it < 4; it++) {
    const kl = lineCurvature(T, out);
    let again = false;
    late.forEach((c, q) => {
      let km = 0; forRange(N, ds, c.s0 - 15, c.s1 + 15, (i) => { km = Math.max(km, Math.abs(kl[i])); });
      if (km > 1.0 / c.R && scale[q] > 0.05) { scale[q] *= Math.max(0, Math.min(0.6, (1 / c.R) / km - 0.1)); again = true; }
    });
    if (!again) break;
    out = build();
  }
  return out;
}
