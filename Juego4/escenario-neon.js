/* =========================================================================
   GRAN PREMIO NEÓN · Escenario «Neón City» (circuito 'neon')
   Megaciudad nocturna synthwave alrededor del trazado:
   · cielo con sol retro, estrellas, nubes iluminadas por la ciudad
   · skyline en capas (centro, anillo medio, lejano) con ventanas animadas,
     fachadas LED, coronas de neón, vallas, letreros verticales y hologramas
   · calles con tráfico luminoso en el suelo, tráfico aéreo, dirigible,
     reflectores barriendo el cielo y láseres
   · tribunas con público animado (instanciado), boxes, torre de control,
     pórtico de salida (5 luces), pantallas gigantes, gran dosel de arcos
     de neón sobre la recta, túnel de luz en la frenada de la Curva 1,
     pasarela peatonal, torres de focos, palmeras y podio
   Todo se coloca a partir de la geometría del circuito T (circuito.js v3):
   distToTrack + T.wallL/R, T.pit, T.landmarks, T.corners.
   API (CONTRATO §4): buildScenery({ scene, renderer, track, tier, envMap, rain })
   ========================================================================= */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as CIRC from './circuito.js';

/* ------------------------------------------------------------ calidad */
const CFG = {
  low: { crowd: 0.34, maxCrowd: 2600, palms: 46, city: 0.55, signs: 0.5, traffic: 56, search: 4, lasers: 4, holo: false, glass: false, rainN: 420, atlas: 1024, clouds: false, boards: 14, maskRes: 128, blimp: true },
  med: { crowd: 0.62, maxCrowd: 6000, palms: 90, city: 0.8, signs: 0.8, traffic: 110, search: 6, lasers: 8, holo: true, glass: true, rainN: 900, atlas: 2048, clouds: true, boards: 24, maskRes: 192, blimp: true },
  high: { crowd: 1, maxCrowd: 11000, palms: 140, city: 1, signs: 1, traffic: 170, search: 8, lasers: 12, holo: true, glass: true, rainN: 1500, atlas: 2048, clouds: true, boards: 32, maskRes: 256, blimp: true },
};

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const _col = new THREE.Color();
/** Color hex (sRGB) → [r,g,b] lineales multiplicados por k (HDR si k > 1). */
const lin = (hex, k = 1) => { _col.set(hex); return [_col.r * k, _col.g * k, _col.b * k]; };
const NEON = { pink: '#ff2fb3', cyan: '#22e4ff', gold: '#ffcc33', green: '#2bff88', violet: '#8b5cff', orange: '#ff6a3d', white: '#f4f1ff', red: '#ff2244' };
const FONT = (px, w = 400) => `${w} ${px}px Bungee, Outfit, 'Arial Black', Impact, sans-serif`;
const FONT_B = (px, w = 800) => `${w} ${px}px Outfit, 'Arial', sans-serif`;

/* ------------------------------------------------------------ geometría: utilidades */
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _eu = new THREE.Euler(), _p = new THREE.Vector3(), _sc = new THREE.Vector3();
function applyXf(g, o) {
  _eu.set(o.rx || 0, o.ry || 0, o.rz || 0, 'YXZ');
  _q.setFromEuler(_eu);
  _m4.compose(_p.set(o.x || 0, o.y || 0, o.z || 0), _q, _sc.set(o.sx || 1, o.sy || 1, o.sz || 1));
  g.applyMatrix4(_m4);
  return g;
}
/** Acumula geometrías con el mismo juego de atributos y las fusiona en una sola malla (1 draw call). */
class Bucket {
  constructor(spec) { this.spec = spec; this.list = []; this.tris = 0; }
  add(geo, o, vals) {
    const g = geo; // las geometrías que llegan son nuevas: se modifican in situ
    if (!g.index) {
      const n = g.attributes.position.count, ix = new Uint32Array(n);
      for (let i = 0; i < n; i++) ix[i] = i;
      g.setIndex(new THREE.BufferAttribute(ix, 1));
    }
    if (o) applyXf(g, o);
    const n = g.attributes.position.count;
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && !(name in this.spec)) g.deleteAttribute(name);
    for (const name in this.spec) {
      if (g.attributes[name]) continue;
      if (name === 'normal') { g.computeVertexNormals(); continue; }
      const size = this.spec[name], v = vals && vals[name], a = new Float32Array(n * size);
      if (v) for (let i = 0; i < n; i++) for (let k = 0; k < size; k++) a[i * size + k] = v[k];
      g.setAttribute(name, new THREE.BufferAttribute(a, size));
    }
    g.morphAttributes = {};
    this.list.push(g);
    return g;
  }
  build(mat) {
    if (!this.list.length) return null;
    const g = mergeGeometries(this.list, false);
    this.list.forEach((x) => x.dispose());
    this.list = [];
    if (!g) return null;
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false;
    return m;
  }
}

/* ------------------------------------------------------------ circuito: adaptador */
function adaptTrack(T) {
  const N = T.N, L = T.L, ds = T.ds || L / N;
  const zero = new Float32Array(N);
  const X = T.x, Z = T.z, Y = T.y || zero, K = T.k || zero;
  const W = T.w && T.w.length === N ? T.w : new Float32Array(N).fill(typeof T.halfWidth === 'number' ? T.halfWidth : 9);
  const RW = T.runoffW && T.runoffW.length === N ? T.runoffW : new Float32Array(N).fill(14);
  let WL = T.wallL, WR = T.wallR;
  if (!WL || WL.length !== N) { WL = new Float32Array(N); WR = new Float32Array(N); for (let i = 0; i < N; i++) WL[i] = WR[i] = W[i] + RW[i]; }
  const wrap = (s) => { s %= L; return s < 0 ? s + L : s; };
  const dS = (a, b) => { let d = b - a; d -= Math.round(d / L) * L; return d; };
  function at(s, o) {
    let u = wrap(s) / ds; let i = Math.floor(u); if (i >= N) i -= N;
    const f = u - i, j = i + 1 < N ? i + 1 : 0;
    o.x = X[i] + (X[j] - X[i]) * f; o.y = Y[i] + (Y[j] - Y[i]) * f; o.z = Z[i] + (Z[j] - Z[i]) * f;
    let tx = T.tx[i] + (T.tx[j] - T.tx[i]) * f, tz = T.tz[i] + (T.tz[j] - T.tz[i]) * f;
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    o.tx = tx; o.tz = tz; o.nx = tz; o.nz = -tx; // normal izquierda (+lateral)
    o.k = K[i] + (K[j] - K[i]) * f; o.w = W[i] + (W[j] - W[i]) * f;
    o.wl = WL[i] + (WL[j] - WL[i]) * f; o.wr = WR[i] + (WR[j] - WR[i]) * f;
    o.i = i; o.s = s;
    return o;
  }
  // distancia: circuito.js (rejilla espacial) o búsqueda local de respaldo
  const DQ = { d: 0, s: 0, side: 1, lat: 0, i: 0 };
  let dist;
  if (typeof CIRC.distToTrack === 'function' && T._grid) dist = (x, z) => CIRC.distToTrack(T, x, z, DQ);
  else {
    dist = (x, z) => {
      let best = 1e18, bi = 0;
      for (let i = 0; i < N; i += 2) { const dx = X[i] - x, dz = Z[i] - z, d2 = dx * dx + dz * dz; if (d2 < best) { best = d2; bi = i; } }
      const lat = (x - X[bi]) * T.nz[bi] * 0 + (x - X[bi]) * T.tz[bi] - (z - Z[bi]) * T.tx[bi];
      DQ.d = Math.sqrt(best); DQ.s = bi * ds; DQ.side = lat >= 0 ? 1 : -1; DQ.lat = lat; DQ.i = bi;
      return DQ;
    };
  }
  /** Espacio libre (m) más allá de muro + 3 m (y un margen por terraplén en tramos elevados). */
  function margin(x, z) {
    const q = dist(x, z);
    const i = q.i, wall = q.side > 0 ? WL[i] : WR[i];
    return q.d - (wall + 3 + Math.max(0, Y[i]) * 1.4);
  }
  // polígono de la línea central (interior / exterior)
  const poly = [];
  for (let i = 0; i < N; i += 4) poly.push(X[i], Z[i]);
  const PN = poly.length / 2;
  function inside(x, z) {
    let wn = 0;
    for (let a = 0; a < PN; a++) {
      const b = a + 1 < PN ? a + 1 : 0;
      const ax = poly[a * 2], az = poly[a * 2 + 1], bx = poly[b * 2], bz = poly[b * 2 + 1];
      const cr = (bx - ax) * (z - az) - (x - ax) * (bz - az);
      if (az <= z) { if (bz > z && cr > 0) wn++; } else if (bz <= z && cr < 0) wn--;
    }
    return wn !== 0;
  }
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (let i = 0; i < N; i++) { minX = Math.min(minX, X[i]); maxX = Math.max(maxX, X[i]); minZ = Math.min(minZ, Z[i]); maxZ = Math.max(maxZ, Z[i]); }
  // recta de meta: desde s = 0 hacia atrás / delante mientras la curvatura sea pequeña
  const kAt = (s) => K[Math.round(wrap(s) / ds) % N];
  let mB = 0; while (mB < L * 0.4 && Math.abs(kAt(mB)) < 1 / 420) mB += 2;
  let mA = 0; while (mA > -L * 0.4 && Math.abs(kAt(mA)) < 1 / 420) mA -= 2;
  /**
   * Rejilla rápida (transformada de distancia chaflán + relleno por barrido) del margen libre y del interior:
   * evita decenas de miles de consultas exactas al colocar la ciudad y al hornear la máscara del suelo.
   */
  function buildFast(res, pad) {
    const x0 = minX - pad, z0 = minZ - pad, sx = maxX - minX + 2 * pad, sz = maxZ - minZ + 2 * pad;
    const cx = sx / res, cz = sz / res, dg = Math.hypot(cx, cz);
    const D = new Float32Array(res * res).fill(1e9), IN = new Uint8Array(res * res);
    for (let i = 0; i < N; i++) {
      const r = Math.max(WL[i], WR[i]) + 3 + Math.max(0, Y[i]) * 1.4, R2 = r + 2 * Math.max(cx, cz);
      const i0 = Math.max(0, Math.floor((X[i] - R2 - x0) / cx)), i1 = Math.min(res - 1, Math.floor((X[i] + R2 - x0) / cx));
      const j0 = Math.max(0, Math.floor((Z[i] - R2 - z0) / cz)), j1 = Math.min(res - 1, Math.floor((Z[i] + R2 - z0) / cz));
      for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) {
        const px = x0 + (k + 0.5) * cx - X[i], pz = z0 + (j + 0.5) * cz - Z[i];
        const v = Math.sqrt(px * px + pz * pz) - r, c = j * res + k;
        if (v < D[c]) D[c] = v;
      }
    }
    for (let j = 0; j < res; j++) for (let k = 0; k < res; k++) {
      const c = j * res + k; let v = D[c];
      if (k > 0) v = Math.min(v, D[c - 1] + cx);
      if (j > 0) { v = Math.min(v, D[c - res] + cz); if (k > 0) v = Math.min(v, D[c - res - 1] + dg); if (k < res - 1) v = Math.min(v, D[c - res + 1] + dg); }
      D[c] = v;
    }
    for (let j = res - 1; j >= 0; j--) for (let k = res - 1; k >= 0; k--) {
      const c = j * res + k; let v = D[c];
      if (k < res - 1) v = Math.min(v, D[c + 1] + cx);
      if (j < res - 1) { v = Math.min(v, D[c + res] + cz); if (k < res - 1) v = Math.min(v, D[c + res + 1] + dg); if (k > 0) v = Math.min(v, D[c + res - 1] + dg); }
      D[c] = v;
    }
    const xs = [];
    for (let j = 0; j < res; j++) {
      const z = z0 + (j + 0.5) * cz; xs.length = 0;
      for (let a = 0; a < PN; a++) {
        const b = a + 1 < PN ? a + 1 : 0, az = poly[a * 2 + 1], bz = poly[b * 2 + 1];
        if ((az <= z) !== (bz <= z)) { const ax = poly[a * 2], bx = poly[b * 2]; xs.push(ax + ((z - az) / (bz - az)) * (bx - ax)); }
      }
      xs.sort((p, q) => p - q);
      for (let a = 0; a + 1 < xs.length; a += 2) {
        const k0 = Math.max(0, Math.ceil((xs[a] - x0) / cx - 0.5)), k1 = Math.min(res - 1, Math.floor((xs[a + 1] - x0) / cx - 0.5));
        for (let k = k0; k <= k1; k++) IN[j * res + k] = 1;
      }
    }
    const cell = (x, z) => { const k = Math.floor((x - x0) / cx), j = Math.floor((z - z0) / cz); return k < 0 || j < 0 || k >= res || j >= res ? -1 : j * res + k; };
    return {
      res, x0, z0, sx, sz, D, IN,
      /** Margen aproximado; exacto (distToTrack) cuando está cerca del circuito. */
      margin(x, z) {
        const c = cell(x, z);
        if (c < 0) { const ox = Math.max(x0 - x, 0, x - (x0 + sx)), oz = Math.max(z0 - z, 0, z - (z0 + sz)); return pad - 40 + Math.hypot(ox, oz); }
        return D[c] > 45 ? D[c] : margin(x, z);
      },
      inside(x, z) { const c = cell(x, z); return c >= 0 && IN[c] === 1; },
    };
  }
  const lms = Array.isArray(T.landmarks) ? T.landmarks.filter((l) => l && typeof l.s0 === 'number') : [];
  let pit = T.pit;
  if (!pit) pit = { s0: Math.max(mA + 30, -250), s1: Math.min(mB - 40, 165), side: -1, lat0: -(9 + 1.2), lat1: -24 };
  return {
    T, N, L, ds, X, Y, Z, K, W, WL, WR, at, dist, margin, inside, wrap, dS, lms, pit, buildFast,
    main: { sA: mA, sB: mB },
    bounds: { minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, rx: (maxX - minX) / 2, rz: (maxZ - minZ) / 2 },
    corners: T.corners || [],
  };
}

/* ------------------------------------------------------------ GLSL común */
const GL_COMMON = `
uniform float uTime; uniform vec3 uFogColor; uniform float uFogDensity;
float h11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float fogF(float d, float k){ float x = uFogDensity * d * k; return 1.0 - exp(-x * x); }
`;

/* =========================================================================
   buildScenery
   ========================================================================= */
export function buildScenery(opts = {}) {
  const { scene = null, renderer = null, track: T, rain: rainOpt = true } = opts;
  const tier = CFG[opts.tier] ? opts.tier : 'med';
  const Q = CFG[tier];
  const PROF = {}; let _pt = performance.now();
  const prof = (k) => { const n = performance.now(); PROF[k] = Math.round(n - _pt); _pt = n; };
  const TK = adaptTrack(T);
  const rng = mulberry32(0x6e656f6e);
  const rand = (a = 0, b = 1) => a + (b - a) * rng();
  const group = new THREE.Group();
  group.name = 'escenario-neon';
  const textures = [];
  const o1 = {}, o2 = {}, o3 = {};

  /* --------------------------------------------- uniforms compartidos */
  const FOG_SECO = { color: new THREE.Color().setRGB(0.07, 0.03, 0.125), density: 0.00112 };
  const fog = new THREE.FogExp2(0x000000, FOG_SECO.density);
  fog.color.copy(FOG_SECO.color);
  const U = {
    uTime: { value: 0 }, uFogColor: { value: fog.color.clone() }, uFogDensity: { value: fog.density },
    uScale: { value: 400 }, uLights: { value: 0 }, uGo: { value: 0 }, uExcite: { value: 0.12 }, uWave: { value: 0 },
    uWet: { value: 0 }, uWind: { value: 0.25 }, uCloud: { value: 0.22 }, uStars: { value: 1 }, uBeam: { value: 1 },
    uCam: { value: new THREE.Vector3() }, uRain: { value: 0 },
  };
  const uni = (...names) => { const o = {}; for (const n of names) o[n] = U[n]; return o; };

  /* --------------------------------------------- mapa de entorno (reflejos neón) */
  let envTex = null, envRT = null;
  if (renderer) {
    const es = new THREE.Scene();
    es.background = new THREE.Color(0x030108);
    const geos = [];
    const panel = (w, h, col, x, y, z) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(col[0], col[1], col[2]), side: THREE.DoubleSide }));
      m.position.set(x, y, z); m.lookAt(0, 0, 0); es.add(m); geos.push(m);
    };
    const ring = [lin(NEON.pink, 2.4), lin(NEON.cyan, 2.2), lin(NEON.violet, 2.4), lin(NEON.gold, 1.6), lin(NEON.cyan, 2.0), lin(NEON.pink, 2.0), lin(NEON.orange, 1.8), lin(NEON.violet, 2.0)];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU, c = ring[i % ring.length];
      panel(2.2 + (i % 3), 0.5 + (i % 2) * 0.5, c, Math.cos(a) * 10, 0.6 + (i % 4) * 0.7, Math.sin(a) * 10);
    }
    panel(9, 2, [2.6, 2.45, 2.2], 0, 9, 0);   // focos blancos cálidos
    panel(30, 30, [0.04, 0.015, 0.07], 0, -6, 0); // suelo
    panel(40, 6, [0.22, 0.04, 0.16], 0, 0.5, -14); // resplandor del horizonte
    panel(40, 6, [0.12, 0.05, 0.2], 0, 0.5, 14);
    const pm = new THREE.PMREMGenerator(renderer);
    envRT = pm.fromScene(es, 0.035);
    envTex = envRT.texture;
    pm.dispose();
    geos.forEach((m) => { m.geometry.dispose(); m.material.dispose(); });
  }
  const ENV = envTex || opts.envMap || null;

  /* --------------------------------------------- texturas de canvas */
  const canvasTex = (w, h, srgb = true) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    if (renderer) t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    t.userData.ctx = c.getContext('2d');
    textures.push(t);
    return t;
  };

  /* ===== Atlas de vallas / letreros / hologramas (2048 base) ===== */
  const AT = Q.atlas, AS = AT / 2048;
  const atlas = canvasTex(AT, AT);
  const CELLS = {};
  const cell = (name, x, y, w, h, draw) => { CELLS[name] = { x, y, w, h, draw }; };
  const rect = (name, sub) => {
    // [u0, v0, du, dv] (v hacia arriba); sub = [a0, a1] fracción horizontal opcional
    const c = CELLS[name], pad = 3;
    let x0 = c.x + pad, w = c.w - 2 * pad;
    if (sub) { x0 = c.x + c.w * sub[0] + 1; w = c.w * (sub[1] - sub[0]) - 2; }
    return [x0 / 2048, 1 - (c.y + c.h - pad) / 2048, w / 2048, (c.h - 2 * pad) / 2048];
  };
  const flipU = (r) => [r[0] + r[2], r[1], -r[2], r[3]];
  const glow = (x, color, blur) => { x.shadowColor = color; x.shadowBlur = blur * AS; };
  const noGlow = (x) => { x.shadowBlur = 0; };
  const BRANDS = [
    ['NEOTRÓN', NEON.cyan, '#06121c'], ['VOLTIAX', NEON.gold, '#1c1206'], ['QUASARIX', NEON.pink, '#1c0614'], ['PIXELIA', NEON.green, '#061c10'],
    ['TURBONEO', NEON.orange, '#1c0b06'], ['ZYNTRA', NEON.violet, '#0e061c'], ['LUMIRA', NEON.white, '#16121f'], ['KROMAX', NEON.cyan, '#1c0614'],
  ];
  const TEAM = [NEON.cyan, '#ff4a2e', NEON.green, NEON.pink, NEON.gold, NEON.violet];
  const centerText = (x, txt, cx, cy, maxW) => { x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(txt, cx, cy, maxW); };
  cell('gp', 0, 0, 1024, 128, (x, w, h) => {
    x.fillStyle = '#07040f'; x.fillRect(0, 0, w, h);
    x.font = FONT(76); glow(x, NEON.pink, 26); x.fillStyle = '#ffd0f0'; centerText(x, 'GRAN PREMIO NEÓN CITY', w / 2, h / 2 + 4, w - 40);
    noGlow(x); x.fillStyle = NEON.cyan; x.fillRect(20, h - 10, w - 40, 4); x.fillRect(20, 6, w - 40, 4);
  });
  cell('banner', 1024, 0, 1024, 128, (x, w, h) => {
    x.fillStyle = '#0a0614'; x.fillRect(0, 0, w, h);
    x.font = FONT(62); glow(x, NEON.cyan, 22); x.fillStyle = '#c8f8ff'; centerText(x, 'PASARELA DEL MERCADO · NEOTRÓN', w / 2, h / 2 + 4, w - 40); noGlow(x);
  });
  cell('meta', 0, 128, 1024, 128, (x, w, h) => {
    const n = 48, cw = w / n, ch = h / 4;
    for (let i = 0; i < n; i++) for (let j = 0; j < 4; j++) { x.fillStyle = (i + j) % 2 ? '#0c0c0c' : '#f2f2f2'; x.fillRect(i * cw, j * ch, cw + 1, ch + 1); }
    x.fillStyle = 'rgba(8,6,20,.94)'; x.fillRect(w * 0.3, 10, w * 0.4, h - 20);
    x.font = FONT(70); glow(x, NEON.gold, 18); x.fillStyle = '#ffd966'; centerText(x, 'META', w / 2, h / 2 + 4); noGlow(x);
  });
  cell('garage', 1024, 128, 1024, 128, (x, w, h) => {
    const n = 16, cw = w / n;
    for (let i = 0; i < n; i++) {
      const c = TEAM[i % TEAM.length];
      x.fillStyle = '#0a0812'; x.fillRect(i * cw, 0, cw, h);
      const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#ffffff'); g.addColorStop(0.18, c); g.addColorStop(0.75, '#1a0f2a'); g.addColorStop(1, '#0c0814');
      x.fillStyle = g; x.fillRect(i * cw + 4, 6, cw - 8, h - 6);
      x.fillStyle = 'rgba(0,0,0,.32)'; for (let k = 14; k < h; k += 7) x.fillRect(i * cw + 4, k, cw - 8, 2);
      x.font = FONT_B(22); x.fillStyle = 'rgba(255,255,255,.85)'; centerText(x, String([1, 7, 13, 23, 44, 88][i % 6]), i * cw + cw / 2, h * 0.62);
    }
  });
  BRANDS.forEach(([name, fg, bg], i) => cell('brand' + i, (i % 4) * 512, 256 + Math.floor(i / 4) * 128, 512, 128, (x, w, h) => {
    const g = x.createLinearGradient(0, 0, w, 0); g.addColorStop(0, bg); g.addColorStop(0.5, '#05030a'); g.addColorStop(1, bg);
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.fillStyle = fg; x.fillRect(0, 0, w, 6); x.fillRect(0, h - 6, w, 6);
    // pequeño logotipo
    x.save(); x.translate(56, h / 2); glow(x, fg, 12); x.strokeStyle = fg; x.lineWidth = 6;
    if (i % 3 === 0) { x.beginPath(); x.arc(0, 0, 26, 0, TAU); x.stroke(); x.beginPath(); x.arc(0, 0, 10, 0, TAU); x.fill(); }
    else if (i % 3 === 1) { x.beginPath(); x.moveTo(-22, 22); x.lineTo(0, -26); x.lineTo(22, 22); x.closePath(); x.stroke(); }
    else { x.beginPath(); x.moveTo(-10, -28); x.lineTo(12, -4); x.lineTo(-4, 2); x.lineTo(10, 28); x.lineTo(-14, 0); x.lineTo(2, -6); x.closePath(); x.fillStyle = fg; x.fill(); }
    x.restore();
    x.font = FONT(58); glow(x, fg, 16); x.fillStyle = fg; centerText(x, name, w / 2 + 40, h / 2 + 4, w - 130); noGlow(x);
  }));
  const BILLS = [
    ['ZYNTRA', 'ENERGÍA SIN LÍMITE', '#3b0a6b', '#ff2fb3', NEON.violet],
    ['VOLTIAX', 'EL FUTURO ES ELÉCTRICO', '#06283b', '#22e4ff', NEON.gold],
    ['PIXELIA X9', 'VE MÁS. VIVE MÁS.', '#062b1c', '#2bff88', NEON.green],
    ['LUMIRA', 'LA NOCHE ES TUYA', '#2a0630', '#ff6ad5', NEON.white],
    ['KROMAX', 'AGARRE TOTAL', '#2b1206', '#ff6a3d', NEON.orange],
    ['QUASARIX', 'BANCA ESTELAR', '#0a0a3b', '#8b5cff', NEON.cyan],
    ['SYNTH FM 88.8', 'LA RADIO DE LA NOCHE', '#350626', '#ffcc33', NEON.pink],
    ['RAMEN ORBITAL', 'ABIERTO 24 H', '#3a0909', '#ff3b3b', NEON.gold],
  ];
  BILLS.forEach(([t1, t2, bg, acc, fg], i) => cell('bill' + i, (i % 4) * 512, 512 + Math.floor(i / 4) * 256, 512, 256, (x, w, h) => {
    const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, bg); g.addColorStop(1, '#05020a');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    // motivo gráfico
    x.save();
    glow(x, acc, 30); x.strokeStyle = acc; x.fillStyle = acc; x.lineWidth = 8;
    const mx = w * 0.78, my = h * 0.5;
    if (i === 0) { x.fillRect(mx - 28, my - 70, 56, 140); x.fillStyle = bg; x.fillRect(mx - 18, my - 40, 36, 60); }
    else if (i === 1) { x.beginPath(); x.moveTo(mx - 80, my + 30); x.quadraticCurveTo(mx - 40, my - 40, mx + 20, my - 20); x.lineTo(mx + 70, my + 10); x.lineTo(mx + 70, my + 30); x.closePath(); x.stroke(); x.beginPath(); x.arc(mx - 45, my + 34, 14, 0, TAU); x.arc(mx + 40, my + 34, 14, 0, TAU); x.fill(); }
    else if (i === 2) { x.strokeRect(mx - 34, my - 72, 68, 144); x.fillRect(mx - 6, my + 52, 12, 6); }
    else if (i === 3) { x.beginPath(); x.arc(mx, my, 62, 0, TAU); x.fill(); x.fillStyle = bg; x.beginPath(); x.arc(mx + 24, my - 18, 56, 0, TAU); x.fill(); }
    else if (i === 4) { x.beginPath(); x.arc(mx, my, 66, 0, TAU); x.stroke(); x.beginPath(); x.arc(mx, my, 34, 0, TAU); x.stroke(); for (let k = 0; k < 12; k++) { const a = (k / 12) * TAU; x.fillRect(mx + Math.cos(a) * 50 - 3, my + Math.sin(a) * 50 - 3, 6, 6); } }
    else if (i === 5) { for (let k = 0; k < 4; k++) { x.beginPath(); x.ellipse(mx, my, 70 - k * 14, 24 - k * 3, -0.5, 0, TAU); x.stroke(); } }
    else if (i === 6) { x.beginPath(); for (let k = 0; k <= 40; k++) { const px = mx - 90 + k * 4.5, py = my + Math.sin(k * 0.8) * (10 + (k % 5) * 9); k ? x.lineTo(px, py) : x.moveTo(px, py); } x.stroke(); }
    else { x.beginPath(); x.arc(mx, my + 10, 60, 0, Math.PI); x.closePath(); x.fill(); x.fillRect(mx - 70, my - 70, 8, 80); x.fillRect(mx - 52, my - 76, 8, 86); }
    x.restore();
    x.font = FONT(t1.length > 9 ? 44 : 56); glow(x, fg, 18); x.fillStyle = '#ffffff'; x.textAlign = 'left'; x.textBaseline = 'middle'; x.fillText(t1, 26, h * 0.4, w * 0.6);
    noGlow(x); x.font = FONT_B(24); x.fillStyle = acc; x.fillText(t2, 28, h * 0.68, w * 0.6);
    x.strokeStyle = acc; x.lineWidth = 4; x.strokeRect(6, 6, w - 12, h - 12);
  }));
  const VSIGNS = [['HOTEL', NEON.pink], ['KARAOKE', NEON.cyan], ['RAMEN', NEON.gold], ['CLUB', NEON.violet], ['NEÓN', NEON.green], ['CAFÉ', NEON.orange], ['24H', NEON.red], ['BAR', NEON.cyan]];
  VSIGNS.forEach(([txt, c], i) => cell('vsign' + i, i * 256, 1024, 256, 512, (x, w, h) => {
    x.fillStyle = '#06030c'; x.fillRect(0, 0, w, h);
    x.strokeStyle = c; x.lineWidth = 7; glow(x, c, 18); x.strokeRect(14, 14, w - 28, h - 28);
    const ch = [...txt], n = ch.length, step = Math.min(108, (h - 60) / n);
    x.font = FONT(Math.round(step * 0.9)); x.fillStyle = '#ffffff'; glow(x, c, 26);
    ch.forEach((l, k) => centerText(x, l, w / 2, h / 2 + (k - (n - 1) / 2) * step + 4));
    noGlow(x);
  }));
  cell('city', 0, 1536, 1024, 256, (x, w, h) => {
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    x.font = FONT(150); x.lineWidth = 10; glow(x, NEON.cyan, 30); x.strokeStyle = NEON.cyan; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.strokeText('NEÓN CITY', w / 2, h / 2 + 8, w - 50);
    glow(x, NEON.pink, 40); x.fillStyle = '#ffb3e6'; x.fillText('NEÓN CITY', w / 2, h / 2 + 8, w - 50); noGlow(x);
  });
  cell('ticker', 1024, 1536, 1024, 128, (x, w, h) => {
    x.fillStyle = '#0b0603'; x.fillRect(0, 0, w, h);
    x.font = FONT(64); glow(x, NEON.gold, 14); x.fillStyle = '#ffd36b'; centerText(x, 'EN DIRECTO · GRAN PREMIO NEÓN CITY · ', w / 2, h / 2 + 4, w - 8); noGlow(x);
  });
  cell('ring', 1024, 1664, 1024, 128, (x, w, h) => {
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    x.font = FONT(80); glow(x, '#9ff', 18); x.fillStyle = '#e8ffff'; centerText(x, 'NEÓN CITY ✦ GRAN PREMIO ✦', w / 2, h / 2 + 4, w - 4); noGlow(x);
  });
  cell('car', 0, 1792, 512, 256, (x, w, h) => {
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    x.save(); x.translate(w / 2, h * 0.62); glow(x, '#8ff', 16); x.strokeStyle = '#d8ffff'; x.lineWidth = 7; x.lineJoin = 'round';
    x.beginPath(); x.moveTo(-230, 20); x.lineTo(-225, -18); x.lineTo(-150, -30); x.lineTo(-70, -36); x.quadraticCurveTo(-30, -82, 40, -70); x.lineTo(110, -34); x.lineTo(210, -22); x.lineTo(236, 6); x.lineTo(230, 20); x.closePath(); x.stroke();
    x.lineWidth = 4; for (let k = -1; k <= 1; k += 2) { x.beginPath(); x.arc(k * 140 + 6, 22, 38, 0, TAU); x.stroke(); x.beginPath(); x.arc(k * 140 + 6, 22, 18, 0, TAU); x.stroke(); }
    x.beginPath(); x.moveTo(-250, -40); x.lineTo(-200, -40); x.lineTo(-200, -20); x.stroke();
    x.globalAlpha = 0.35; for (let k = -90; k < 40; k += 14) { x.beginPath(); x.moveTo(-230, k + 50); x.lineTo(230, k + 50); x.stroke(); }
    x.restore();
  });
  cell('trophy', 512, 1792, 256, 256, (x, w, h) => {
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    x.save(); x.translate(w / 2, 0); glow(x, '#ffd', 18); x.strokeStyle = '#fff2c0'; x.fillStyle = 'rgba(255,220,120,.35)'; x.lineWidth = 6;
    x.beginPath(); x.moveTo(-62, 30); x.lineTo(62, 30); x.quadraticCurveTo(60, 130, 0, 150); x.quadraticCurveTo(-60, 130, -62, 30); x.closePath(); x.fill(); x.stroke();
    x.beginPath(); x.arc(-70, 70, 26, Math.PI * 0.5, Math.PI * 1.5); x.stroke(); x.beginPath(); x.arc(70, 70, 26, -Math.PI * 0.5, Math.PI * 0.5); x.stroke();
    x.fillRect(-10, 150, 20, 46); x.strokeRect(-48, 196, 96, 26); x.fill();
    x.restore();
  });
  cell('emblem', 768, 1792, 256, 256, (x, w, h) => {
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    x.save(); x.translate(w / 2, h / 2); glow(x, NEON.pink, 18); x.strokeStyle = '#ffc6ef'; x.lineWidth = 6;
    x.beginPath(); x.arc(0, 0, 112, 0, TAU); x.stroke(); x.lineWidth = 3; x.beginPath(); x.arc(0, 0, 96, 0, TAU); x.stroke();
    x.font = FONT(96); x.fillStyle = '#fff'; centerText(x, 'GP', 0, 6); x.restore(); noGlow(x);
  });
  cell('chevron', 1024, 1792, 512, 256, (x, w, h) => {
    x.fillStyle = '#080306'; x.fillRect(0, 0, w, h);
    glow(x, NEON.orange, 18); x.fillStyle = '#ff9a5c';
    for (let k = 0; k < 4; k++) { const cx = 70 + k * 120; x.beginPath(); x.moveTo(cx - 40, 30); x.lineTo(cx + 10, 30); x.lineTo(cx + 70, h / 2); x.lineTo(cx + 10, h - 30); x.lineTo(cx - 40, h - 30); x.lineTo(cx + 20, h / 2); x.closePath(); x.fill(); }
    noGlow(x);
  });
  cell('pod', 1536, 1792, 384, 128, (x, w, h) => {
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    ['1', '2', '3'].forEach((n, i) => { x.font = FONT(92); glow(x, ['#ffcc33', '#cfe0ff', '#ff9f5a'][i], 20); x.fillStyle = ['#ffe58a', '#eef3ff', '#ffc08a'][i]; centerText(x, n, i * 128 + 64, 70); });
    noGlow(x);
  });
  cell('led', 1536, 1920, 512, 128, (x, w, h) => {
    const g = x.createLinearGradient(0, 0, w, 0);
    [NEON.pink, NEON.violet, NEON.cyan, NEON.green, NEON.gold, NEON.orange, NEON.pink].forEach((c, i, a) => g.addColorStop(i / (a.length - 1), c));
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.fillStyle = 'rgba(0,0,0,.55)'; for (let i = 0; i < w; i += 8) x.fillRect(i, 0, 3, h); for (let j = 0; j < h; j += 8) x.fillRect(0, j, w, 3);
  });
  function drawAtlas() {
    const x = atlas.userData.ctx;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.fillStyle = '#000'; x.fillRect(0, 0, AT, AT);
    for (const k in CELLS) {
      const c = CELLS[k];
      x.save(); x.setTransform(AS, 0, 0, AS, c.x * AS, c.y * AS);
      x.beginPath(); x.rect(0, 0, c.w, c.h); x.clip();
      c.draw(x, c.w, c.h);
      x.restore();
    }
    atlas.needsUpdate = true;
  }
  drawAtlas();

  /* ===== Público: atlas de siluetas (R = camiseta, G = piel/pelo, B = luz) ===== */
  const crowdTex = canvasTex(256, 256, false);
  {
    const x = crowdTex.userData.ctx;
    x.clearRect(0, 0, 256, 256);
    for (let row = 0; row < 2; row++) for (let pose = 0; pose < 4; pose++) {
      x.save(); x.translate(pose * 64 + 32, row * 128);
      const wide = row === 1;
      const sh = wide ? 21 : 17;
      // torso (camiseta)
      x.fillStyle = 'rgb(255,0,0)';
      x.beginPath(); x.moveTo(-sh, 128); x.lineTo(-sh, 66); x.quadraticCurveTo(-sh, 54, -8, 52); x.lineTo(8, 52); x.quadraticCurveTo(sh, 54, sh, 66); x.lineTo(sh, 128); x.closePath(); x.fill();
      // cabeza
      x.fillStyle = 'rgb(0,255,0)';
      x.beginPath(); x.arc(0, 38, wide ? 11 : 10, 0, TAU); x.fill();
      if (wide) { x.fillStyle = 'rgb(0,90,0)'; x.fillRect(-12, 24, 24, 7); } // gorra
      else { x.fillStyle = 'rgb(0,60,0)'; x.beginPath(); x.arc(0, 34, 11, Math.PI, TAU); x.fill(); }
      // brazos
      x.strokeStyle = 'rgb(255,0,0)'; x.lineWidth = 8; x.lineCap = 'round';
      const arm = (x0, y0, x1, y1, x2, y2) => { x.beginPath(); x.moveTo(x0, y0); x.lineTo(x1, y1); x.lineTo(x2, y2); x.stroke(); };
      const hand = (hx, hy) => { x.fillStyle = 'rgb(0,0,255)'; x.beginPath(); x.arc(hx, hy, 5, 0, TAU); x.fill(); };
      if (pose === 0) { arm(-sh + 2, 60, -sh - 2, 88, -sh + 2, 112); arm(sh - 2, 60, sh + 2, 88, sh - 2, 112); }
      else if (pose === 1) { arm(-sh + 2, 60, -sh - 2, 88, -sh + 2, 112); arm(sh - 2, 58, sh + 8, 34, sh + 10, 10); hand(sh + 10, 8); }
      else if (pose === 2) { arm(-sh + 2, 58, -sh - 10, 34, -sh - 12, 10); arm(sh - 2, 58, sh + 10, 34, sh + 12, 10); hand(-sh - 12, 8); hand(sh + 12, 8); }
      else { arm(-sh + 2, 58, -12, 30, -3, 12); arm(sh - 2, 58, 12, 30, 3, 12); hand(0, 10); }
      x.restore();
    }
    crowdTex.needsUpdate = true;
  }

  /* ===== Pantalla gigante (dinámica) ===== */
  const JW = 512, JH = 224;
  const jumboTex = canvasTex(JW, JH);
  let jumboKey = '', jumboArgs = ['GRAN PREMIO', 'NEÓN CITY', 'ESTA NOCHE · 4 VUELTAS', NEON.pink];
  function drawJumbo(top, big, sub, color = '#ffcc33') {
    jumboArgs = [top, big, sub, color];
    const key = top + '|' + big + '|' + sub + '|' + color;
    if (key === jumboKey) return;
    jumboKey = key;
    const x = jumboTex.userData.ctx, w = JW, h = JH;
    const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#1b0b3a'); g.addColorStop(1, '#07030f');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.fillStyle = color; x.globalAlpha = 0.9; x.fillRect(0, 0, w, 6); x.fillRect(0, h - 6, w, 6); x.globalAlpha = 1;
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = FONT_B(24); x.fillStyle = '#22e4ff'; x.fillText(String(top), w / 2, 38, w - 30);
    x.font = FONT(52); x.fillStyle = color; x.shadowColor = color; x.shadowBlur = 18; x.fillText(String(big), w / 2, 112, w - 30); x.shadowBlur = 0;
    x.font = FONT_B(26); x.fillStyle = '#f4f1ff'; x.fillText(String(sub), w / 2, 180, w - 30);
    x.fillStyle = 'rgba(0,0,0,.22)'; for (let i = 0; i < h; i += 3) x.fillRect(0, i, w, 1);
    jumboTex.needsUpdate = true;
  }
  drawJumbo(...jumboArgs);

  /* ===== Fuentes: redibujar cuando carguen ===== */
  const onFonts = () => { drawAtlas(); jumboKey = ''; drawJumbo(...jumboArgs); };
  let fontsHooked = false;
  if (typeof document !== 'undefined' && document.fonts) {
    try { document.fonts.addEventListener('loadingdone', onFonts); fontsHooked = true; document.fonts.ready.then(() => { if (fontsHooked) onFonts(); }); } catch (e) { /* sin API de fuentes */ }
  }

  /* --------------------------------------------- cubos de geometría */
  const LIT = new Bucket({ normal: 3, color: 3 });                     // estructuras iluminadas
  const GLASS = new Bucket({ normal: 3, color: 3 });                   // vidrio reflectante
  const EMI = new Bucket({ color: 3, aAnim: 4 });                      // neones (HDR, animables)
  const BILL = new Bucket({ uv: 2, aRect: 4, aRect2: 4, aAnim: 4 });   // vallas / letreros (atlas)
  const HOLO = new Bucket({ uv: 2, aRect: 4, aCenter: 3, aSpin: 4, color: 3 }); // hologramas
  const POOL = new Bucket({ color: 3 });                               // charcos de luz (aditivo)
  const BEAM = new Bucket({ normal: 3, uv: 2, color: 3, aBase: 3, aB: 4, aB2: 4 }); // reflectores y láseres
  const JUMBO = new Bucket({ uv: 2 });
  const GLOWS = [];   // {x,y,z,size,c:[r,g,b],blink,phase,minPx,move:[rx,rz,w,ph]}
  const OCC = [];     // cajas opacas
  const CROWD = [];   // {x,y,z,seed,wave,light,glow,col}
  const PALMS = [];   // {x,z,y,sc,rot}
  const stats = { buildings: 0, signs: 0, crowd: 0, palms: 0, traffic: 0, searchlights: 0, lasers: 0 };
  const occBox = (a) => OCC.push(a);
  function occPts(pts, pad = 0) {
    const a = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
    for (const p of pts) { a[0] = Math.min(a[0], p[0]); a[1] = Math.min(a[1], p[1]); a[2] = Math.min(a[2], p[2]); a[3] = Math.max(a[3], p[0]); a[4] = Math.max(a[4], p[1]); a[5] = Math.max(a[5], p[2]); }
    occBox([a[0] - pad, a[1], a[2] - pad, a[3] + pad, a[4], a[5] + pad]);
  }

  /* --------------------------------------------- rejilla de ocupación (decorado) */
  const B = TK.bounds;
  const OG = { cs: 5, x0: B.minX - 1700, z0: B.minZ - 1700 };
  OG.w = Math.ceil((B.maxX - B.minX + 3400) / OG.cs); OG.h = Math.ceil((B.maxZ - B.minZ + 3400) / OG.cs);
  OG.a = new Uint8Array(OG.w * OG.h);
  function ogMark(x, z, r) {
    const i0 = Math.max(0, Math.floor((x - r - OG.x0) / OG.cs)), i1 = Math.min(OG.w - 1, Math.floor((x + r - OG.x0) / OG.cs));
    const j0 = Math.max(0, Math.floor((z - r - OG.z0) / OG.cs)), j1 = Math.min(OG.h - 1, Math.floor((z + r - OG.z0) / OG.cs));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const cx = OG.x0 + (i + 0.5) * OG.cs, cz = OG.z0 + (j + 0.5) * OG.cs;
      if ((cx - x) ** 2 + (cz - z) ** 2 <= (r + OG.cs * 0.71) ** 2) OG.a[j * OG.w + i] = 1;
    }
  }
  function ogFree(x, z, r) {
    const i0 = Math.max(0, Math.floor((x - r - OG.x0) / OG.cs)), i1 = Math.min(OG.w - 1, Math.floor((x + r - OG.x0) / OG.cs));
    const j0 = Math.max(0, Math.floor((z - r - OG.z0) / OG.cs)), j1 = Math.min(OG.h - 1, Math.floor((z + r - OG.z0) / OG.cs));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const cx = OG.x0 + (i + 0.5) * OG.cs, cz = OG.z0 + (j + 0.5) * OG.cs;
      if (OG.a[j * OG.w + i] && (cx - x) ** 2 + (cz - z) ** 2 <= r * r) return false;
    }
    return true;
  }
  /** r: radio libre de otros objetos; rT: margen extra exigido respecto al muro + 3 m (por defecto r). */
  const FAST = TK.buildFast(Q.maskRes, 260);
  const canPlace = (x, z, r, rT = r) => FAST.margin(x, z) > rT && ogFree(x, z, r);

  /* --------------------------------------------- utilidades de colocación */
  const yawOf = (o) => Math.atan2(o.tx, o.tz);
  const wallAt = (s, side) => { TK.at(s, o3); return side > 0 ? o3.wl : o3.wr; };
  /** Lateral libre (m, con signo) para un objeto a ese lado: muro + 3 m + extra. */
  const clearLat = (s, side, extra = 0) => side * (wallAt(s, side) + 3 + extra);
  function ribbon(latA, yA, latB, yB, s0, s1, step, opt = {}) {
    const n = Math.max(1, Math.ceil(Math.abs(s1 - s0) / step));
    const pos = new Float32Array((n + 1) * 6), uv = new Float32Array((n + 1) * 4), idx = [];
    const col = opt.colA ? new Float32Array((n + 1) * 6) : null;
    const anim = opt.anim ? new Float32Array((n + 1) * 8) : null;
    const vS = opt.vScale || 10;
    for (let i = 0; i <= n; i++) {
      const s = s0 + ((s1 - s0) * i) / n;
      TK.at(s, o1);
      const la = typeof latA === 'function' ? latA(s) : latA, lb = typeof latB === 'function' ? latB(s) : latB;
      const by = opt.absY ? 0 : o1.y;
      const ya = (typeof yA === 'function' ? yA(s, o1) : yA) + by, yb = (typeof yB === 'function' ? yB(s, o1) : yB) + by;
      pos.set([o1.x + o1.nx * la, ya, o1.z + o1.nz * la, o1.x + o1.nx * lb, yb, o1.z + o1.nz * lb], i * 6);
      uv.set([0, s / vS, 1, s / vS], i * 4);
      if (col) {
        const ca = typeof opt.colA === 'function' ? opt.colA(s) : opt.colA, cb = opt.colB ? (typeof opt.colB === 'function' ? opt.colB(s) : opt.colB) : ca;
        col.set([ca[0], ca[1], ca[2], cb[0], cb[1], cb[2]], i * 6);
      }
      if (anim) { const a = opt.anim(s); anim.set([a[0], a[1], a[2], a[3], a[0], a[1], a[2], a[3]], i * 8); }
      if (i < n) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (anim) g.setAttribute('aAnim', new THREE.BufferAttribute(anim, 4));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  /** Caja orientada con el circuito en s: sx a lo ancho (normal), sy alto, sz a lo largo. */
  function boxAt(bucket, s, lat, y, sx, sy, sz, vals, ex = {}) {
    TK.at(s, o3);
    return bucket.add(new THREE.BoxGeometry(sx, sy, sz), { x: o3.x + o3.nx * lat, y: (ex.absY ? 0 : o3.y) + y, z: o3.z + o3.nz * lat, ry: yawOf(o3) + (ex.ry || 0), rx: ex.rx || 0, rz: ex.rz || 0 }, vals);
  }
  /** Panel del atlas vertical, centrado en (x,y,z), mirando hacia (fx, fz). */
  function billPanel(x, y, z, fx, fz, w, h, r1, anim = [0, 0, 0, 1.15], r2) {
    const g = new THREE.PlaneGeometry(w, h);
    return BILL.add(g, { x, y, z, ry: Math.atan2(fx, fz) }, { aRect: r1, aRect2: r2 || r1, aAnim: anim });
  }
  const glowAt = (x, y, z, size, c, ex = {}) => GLOWS.push({ x, y, z, size, c, blink: ex.blink || 0, phase: ex.phase || 0, minPx: ex.minPx || 0, move: ex.move || null });
  /** Barra (caja) entre dos puntos 3D. */
  function bar(bucket, a, b, th, vals, thY = th) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz) || 0.01;
    const g = new THREE.BoxGeometry(th, thY, len);
    const yaw = Math.atan2(dx, dz), pitch = -Math.asin(clamp(dy / len, -1, 1));
    return bucket.add(g, { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, z: (a[2] + b[2]) / 2, ry: yaw, rx: pitch }, vals);
  }
  const EM = (hex, k, anim = [0, 0, 0, 0]) => ({ color: lin(hex, k), aAnim: anim });
  const LC = (hex, k = 1) => ({ color: lin(hex, k) });
  const lmOf = (type) => TK.lms.filter((l) => l.type === type);
  const nearLm = (s, type, pad) => TK.lms.some((l) => (!type || l.type === type) && TK.dS(l.s0 - pad, s) >= 0 && TK.dS(s, l.s1 + pad) >= 0);

  /* =========================================================================
     TRIBUNAS (estructura + público instanciado)
     ========================================================================= */
  const STANDS = [];
  function buildStand(sA, sB, side, rows, opt = {}) {
    let lat0 = 0, yMax = -1e9, yMin = 1e9;
    for (let s = sA; s <= sB; s += 2) { lat0 = Math.max(lat0, wallAt(s, side) + 3.6); TK.at(s, o1); yMax = Math.max(yMax, o1.y); yMin = Math.min(yMin, o1.y); }
    const stepD = 1.3, stepH = 0.78, base = 1.7;
    let R = rows;
    const backOK = (r) => {
      for (let s = sA; s <= sB; s += 5) {
        TK.at(s, o1);
        for (const lat of [lat0 + r * stepD + 2, lat0 + (r * stepD) / 2]) {
          const x = o1.x + o1.nx * side * lat, z = o1.z + o1.nz * side * lat;
          const q = TK.dist(x, z);
          if (Math.abs(TK.dS(q.s, s)) > 30 && TK.margin(x, z) < 1) return false;
          if (!ogFree(x, z, 1)) return false;
        }
      }
      return true;
    };
    while (R >= 5 && !backOK(R)) R -= 2;
    if (R < 5) return null;
    const latEnd = lat0 + R * stepD, topH = base + R * stepH, roofY = topH + 5.8;
    const sd = side;
    const toGround = (s, o) => -o.y - 0.3; // y relativa que llega al suelo (0)
    const seat = (s) => (Math.floor((s - sA) / 26) % 2 ? [0.035, 0.06, 0.16] : [0.16, 0.03, 0.12]);
    for (let r = 0; r < R; r++) {
      const la = sd * (lat0 + r * stepD), lb = sd * (lat0 + (r + 1) * stepD), h = base + r * stepH;
      LIT.add(ribbon(la, h, lb, h, sA, sB, 3, { colA: seat }));
      LIT.add(ribbon(la, h - stepH, la, h, sA, sB, 3, { colA: [0.05, 0.045, 0.085] }));
      if (r % 2 === 1) {
        const c = r % 4 === 1 ? lin(NEON.pink, 1.7) : lin(NEON.cyan, 1.7);
        EMI.add(ribbon(la - sd * 0.03, h - 0.08, la - sd * 0.03, h - 0.01, sA, sB, 3, { anim: (s) => [8, s * 0.07 + r * 0.4, 2.2, 1] }), null, { color: c });
      }
      // público
      for (let s = sA + 0.8; s < sB - 0.8; s += 0.64) {
        if ((s - sA) % 26 < 1.8) continue; // pasillos
        if (rng() > 0.93 * Q.crowd) continue;
        TK.at(s, o1);
        const lat = sd * (lat0 + (r + 0.45) * stepD) + rand(-0.12, 0.12);
        CROWD.push({ x: o1.x + o1.nx * lat, y: o1.y + h, z: o1.z + o1.nz * lat, seed: rng(), wave: s * (opt.waveDir || 1), light: 0.62 + 0.38 * rng() * (1 - r / R * 0.4), glow: rng() < 0.18 ? 1 : 0 });
      }
    }
    // frente: murete con neón
    LIT.add(ribbon(sd * (lat0 - 0.35), toGround, sd * (lat0 - 0.35), base + 0.3, sA, sB, 3, { colA: [0.06, 0.05, 0.1] }));
    EMI.add(ribbon(sd * (lat0 - 0.4), base + 0.22, sd * (lat0 - 0.4), base + 0.36, sA, sB, 3, { anim: (s) => [8, s * 0.05, 3, 1] }), null, { color: lin(NEON.cyan, 2.2) });
    // pared trasera, cubierta, fachada de patrocinadores
    LIT.add(ribbon(sd * latEnd, toGround, sd * latEnd, roofY, sA, sB, 4, { colA: [0.045, 0.04, 0.085] }));
    LIT.add(ribbon(sd * (lat0 - 0.65), roofY, sd * (latEnd + 0.8), roofY + 1.3, sA, sB, 4, { colA: [0.06, 0.05, 0.12] }));
    LIT.add(ribbon(sd * (lat0 - 0.65), roofY - 2.3, sd * (lat0 - 0.65), roofY + 0.05, sA, sB, 4, { colA: [0.05, 0.04, 0.09] }));
    EMI.add(ribbon(sd * (lat0 - 0.7), roofY - 2.42, sd * (lat0 - 0.7), roofY - 2.26, sA, sB, 4), null, { color: lin('#ffe6c8', 2.6) });
    EMI.add(ribbon(sd * (lat0 - 0.7), roofY + 0.0, sd * (lat0 - 0.7), roofY + 0.14, sA, sB, 4, { anim: (s) => [1, s * 0.035, 1.4, 0.8] }), null, { color: lin(NEON.pink, 2.6) });
    // laterales
    [sA, sB].forEach((s) => {
      TK.at(s, o2);
      const sh = new THREE.Shape();
      sh.moveTo(lat0 - 0.65, roofY + 0.2); sh.lineTo(latEnd + 0.8, roofY + 1.3); sh.lineTo(latEnd, -o2.y - 0.3); sh.lineTo(lat0 - 0.35, -o2.y - 0.3); sh.lineTo(lat0 - 0.35, base);
      const g = new THREE.ShapeGeometry(sh);
      // shape XY → (lateral, altura); orientar: x local = normal * side
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) { const la = pos.getX(i) * sd, yy = pos.getY(i); pos.setXYZ(i, o2.x + o2.nx * la, o2.y + yy, o2.z + o2.nz * la); }
      g.computeVertexNormals();
      LIT.add(g, null, LC('#151028'));
    });
    // pilares y aletas de neón exteriores
    for (let s = sA; s <= sB + 0.1; s += 18) {
      boxAt(LIT, s, sd * (latEnd - 0.4), (roofY - toGround(s, TK.at(s, o2))) / 2 + toGround(s, o2) , 0.7, roofY - toGround(s, o2), 0.7, LC('#1d1a2e'));
      boxAt(EMI, s + 9, sd * (latEnd + 0.15), roofY * 0.5, 0.18, roofY - 3, 0.3, EM(NEON.violet, 2.2, [6, s * 0.1, 0.6, 1]));
    }
    // luces bajo la cubierta
    for (let s = sA + 4; s < sB - 2; s += 8) {
      boxAt(EMI, s, sd * (lat0 + 0.7), roofY - 0.12, 1.2, 0.12, 0.5, EM('#fff1dd', 3.2));
      TK.at(s, o2); glowAt(o2.x + o2.nx * sd * (lat0 + 0.7), o2.y + roofY - 0.4, o2.z + o2.nz * sd * (lat0 + 0.7), 6.5, [0.75, 0.68, 0.6]);
    }
    // vallas de patrocinadores en el frontal de la cubierta
    let bi = opt.brand0 || 0;
    for (let s = sA + 1; s + 12.4 <= sB; s += 13) {
      TK.at(s + 6.2, o2);
      const lat = sd * (lat0 - 0.73);
      billPanel(o2.x + o2.nx * lat, o2.y + roofY - 1.15, o2.z + o2.nz * lat, -o2.nx * sd, -o2.nz * sd, 12.2, 2.05, rect('brand' + (bi % 8)), [1, bi * 0.37, 1 / 14, 1.25], rect('brand' + ((bi + 3) % 8)));
      bi++;
    }
    // ocluyentes por tramos
    for (let s = sA; s < sB; s += 20) {
      const pts = [];
      for (let q = s; q <= Math.min(sB, s + 22); q += 5.5) { TK.at(q, o2); pts.push([o2.x + o2.nx * sd * (lat0 - 0.65), 0, o2.z + o2.nz * sd * (lat0 - 0.65)], [o2.x + o2.nx * sd * latEnd, o2.y + roofY + 1.2, o2.z + o2.nz * sd * latEnd]); }
      occPts(pts);
    }
    for (let s = sA; s <= sB; s += 5) { TK.at(s, o2); const lm = sd * (lat0 + latEnd) / 2; ogMark(o2.x + o2.nx * lm, o2.z + o2.nz * lm, (latEnd - lat0) / 2 + 3); }
    const st = { sA, sB, side, lat0, latEnd, topH, roofY, rows: R, name: opt.name || '' };
    STANDS.push(st);
    return st;
  }

  /* =========================================================================
     BOXES (garajes, planta VIP acristalada, torre de control)
     ========================================================================= */
  let PITB = null;
  function buildPits() {
    const p = TK.pit; if (!p) return;
    const sd = p.side || -1;
    const s0 = p.s0 + 14, s1 = p.s1 - 14;
    if (s1 - s0 < 60) return;
    let latF = Math.abs(p.lat1) + 3.2;
    for (let s = s0; s <= s1; s += 4) latF = Math.max(latF, wallAt(s, sd) + 3.2);
    latF += 2.7; // el voladizo de la planta VIP (2,6 m) también queda a más de muro + 3 m
    const depth = 17, H1 = 5.4, H2 = 9.0, roofY = 10.6, latB = latF + depth;
    const L0 = (v) => sd * v;
    const col = { wall: [0.06, 0.05, 0.1], slab: [0.08, 0.07, 0.13], roof: [0.05, 0.045, 0.09] };
    LIT.add(ribbon(L0(latF), 0, L0(latF), H1, s0, s1, 6, { colA: col.wall }));
    LIT.add(ribbon(L0(latF - 2.2), H1, L0(latB), H1, s0, s1, 6, { colA: col.slab }));
    LIT.add(ribbon(L0(latF - 2.2), H1 - 0.45, L0(latF - 2.2), H1, s0, s1, 6, { colA: col.slab }));
    (Q.glass ? GLASS : LIT).add(ribbon(L0(latF - 1.9), H1, L0(latF - 1.9), H2, s0, s1, 6, { colA: [0.05, 0.06, 0.1] }));
    LIT.add(ribbon(L0(latF - 2.6), H2, L0(latF - 2.6), roofY + 0.3, s0, s1, 6, { colA: col.wall }));
    LIT.add(ribbon(L0(latF - 2.6), roofY, L0(latB + 0.4), roofY, s0, s1, 6, { colA: col.roof }));
    LIT.add(ribbon(L0(latB), 0, L0(latB), roofY, s0, s1, 6, { colA: [0.04, 0.035, 0.07] }));
    EMI.add(ribbon(L0(latF - 2.25), H1 - 0.5, L0(latF - 2.25), H1 - 0.34, s0, s1, 6, { anim: (s) => [1, s * 0.03, 1.1, 0.75] }), null, { color: lin(NEON.pink, 2.6) });
    EMI.add(ribbon(L0(latF - 2.65), roofY + 0.18, L0(latF - 2.65), roofY + 0.34, s0, s1, 6, { anim: (s) => [1, -s * 0.03, 0.9, 0.75] }), null, { color: lin(NEON.cyan, 2.6) });
    EMI.add(ribbon(L0(latF - 1.95), H1 + 0.1, L0(latF - 1.95), H1 + 0.22, s0, s1, 6), null, { color: lin('#ffe9cf', 1.8) });
    // parteluces y luz interior
    for (let s = s0 + 1.5; s < s1; s += 3) boxAt(EMI, s, L0(latF - 1.95), (H1 + H2) / 2, 0.08, H2 - H1 - 0.3, 0.08, EM('#bcd4ff', 0.9));
    // garajes
    let k = 0;
    for (let s = s0 + 2; s + 5.2 < s1; s += 6.6, k++) {
      TK.at(s + 2.6, o2);
      const lat = L0(latF - 0.05);
      billPanel(o2.x + o2.nx * lat, o2.y + 2.25, o2.z + o2.nz * lat, -o2.nx * sd, -o2.nz * sd, 5.0, 4.3, rect('garage', [(k % 16) / 16, (k % 16 + 1) / 16]), [0, 0, 0, 1.3]);
      TK.at(s + 2.6, o2); glowAt(o2.x + o2.nx * L0(latF - 3), o2.y + H1 - 0.7, o2.z + o2.nz * L0(latF - 3), 4.5, [0.7, 0.75, 0.9]);
    }
    // marcas en el frontal superior
    let b = 2;
    for (let s = s0 + 3; s + 6.4 < s1; s += 9, b++) {
      TK.at(s + 3.2, o2); const lat = L0(latF - 2.66);
      billPanel(o2.x + o2.nx * lat, o2.y + (H2 + roofY) / 2 + 0.1, o2.z + o2.nz * lat, -o2.nx * sd, -o2.nz * sd, 6.2, 1.5, rect('brand' + (b % 8)), [0, 0, 0, 1.2]);
    }
    // cierres
    [s0, s1].forEach((s) => { TK.at(s, o2); boxAt(LIT, s, L0((latF - 2.6 + latB) / 2), roofY / 2, depth + 2.6, roofY, 0.5, LC('#140f26')); });
    // torre de control (a la salida de boxes)
    const ts = s1 - 26;
    TK.at(ts, o2);
    const tl = L0(latB + 9);
    const tx = o2.x + o2.nx * tl, tz = o2.z + o2.nz * tl, ty = o2.y;
    LIT.add(new THREE.CylinderGeometry(4.6, 5.4, 34, 10), { x: tx, y: ty + 17, z: tz }, LC('#1a1436'));
    (Q.glass ? GLASS : LIT).add(new THREE.CylinderGeometry(9.5, 7.6, 6.5, 16, 1, true), { x: tx, y: ty + 37, z: tz }, LC('#20243a'));
    LIT.add(new THREE.CylinderGeometry(10.2, 10.2, 0.8, 16), { x: tx, y: ty + 40.6, z: tz }, LC('#120e26'));
    LIT.add(new THREE.CylinderGeometry(7.8, 7.8, 0.6, 16), { x: tx, y: ty + 33.7, z: tz }, LC('#120e26'));
    EMI.add(new THREE.CylinderGeometry(10.25, 10.25, 0.35, 32, 1, true), { x: tx, y: ty + 40.2, z: tz }, EM(NEON.cyan, 3.4, [6, 0, 0.5, 1]));
    EMI.add(new THREE.CylinderGeometry(7.85, 7.85, 0.25, 32, 1, true), { x: tx, y: ty + 33.95, z: tz }, EM(NEON.pink, 3.2, [1, 0, 2, 0.6]));
    for (let a = 0; a < 10; a++) { const an = (a / 10) * TAU; EMI.add(new THREE.BoxGeometry(0.16, 30, 0.16), { x: tx + Math.cos(an) * 5.1, y: ty + 17, z: tz + Math.sin(an) * 5.1 }, EM(a % 2 ? NEON.violet : NEON.cyan, 1.6, [1, a * 0.6, 1.2, 0.6])); }
    LIT.add(new THREE.CylinderGeometry(0.15, 0.3, 9, 5), { x: tx, y: ty + 45.5, z: tz }, LC('#2a2440'));
    glowAt(tx, ty + 50.3, tz, 7, [2.2, 0.2, 0.3], { blink: 1.8 });
    occPts([[tx - 10, 0, tz - 10], [tx + 10, ty + 41, tz + 10]]);
    ogMark(tx, tz, 14);
    // ocluyentes y ocupación del edificio
    for (let s = s0; s < s1; s += 30) {
      const pts = [];
      for (let q = s; q <= Math.min(s1, s + 32); q += 8) { TK.at(q, o2); pts.push([o2.x + o2.nx * L0(latF - 2.6), 0, o2.z + o2.nz * L0(latF - 2.6)], [o2.x + o2.nx * L0(latB), o2.y + roofY + 0.4, o2.z + o2.nz * L0(latB)]); }
      occPts(pts);
    }
    for (let s = s0 - 4; s <= s1 + 4; s += 5) { TK.at(s, o2); const lm = L0((latF + latB) / 2); ogMark(o2.x + o2.nx * lm, o2.z + o2.nz * lm, depth / 2 + 4); }
    PITB = { s0, s1, side: sd, latF, latB, roofY, tower: { x: tx, y: ty, z: tz } };
  }

  /* =========================================================================
     PÓRTICO DE SALIDA (5 columnas × 2 luces rojas + fila verde)
     ========================================================================= */
  let GANTRY = null;
  function buildGantry(sG, standSide) {
    TK.at(sG, o2);
    const yaw = yawOf(o2), base = o2.y;
    const pit = TK.pit, sd = pit ? pit.side : -1;
    const inPit = pit && TK.dS(pit.s0, sG) > 0 && TK.dS(sG, pit.s1) > 0;
    const latA = standSide * (wallAt(sG, standSide) + 3.9);
    let latB = sd * (wallAt(sG, sd) + 3.9);
    if (PITB && inPit) latB = sd * Math.max(PITB.latF - 0.9, wallAt(sG, sd) + 3.9);
    const H = 10.4;
    // pilonos
    [latA, latB].forEach((lat, i) => {
      boxAt(LIT, sG, lat, H / 2 + 0.6, 1.5, H + 1.2, 1.5, LC('#221c38'));
      boxAt(EMI, sG, lat - Math.sign(lat) * 0.78, H / 2 + 0.6, 0.08, H, 0.5, EM(i ? NEON.pink : NEON.cyan, 3, [1, i * 3, 2, 0.5]));
    });
    const mid = (latA + latB) / 2, span = Math.abs(latA - latB);
    boxAt(LIT, sG, mid, H + 0.6, span + 1.5, 1.1, 1.4, LC('#221c38'));
    boxAt(EMI, sG, mid, H + 1.2, span + 1.5, 0.12, 1.45, EM(NEON.gold, 2.2));
    boxAt(EMI, sG, mid, H + 0.02, span + 1.5, 0.12, 1.45, EM(NEON.gold, 2.2));
    // carcasa de luces sobre el centro de la pista
    boxAt(LIT, sG, 0, H - 1.6, 12.2, 2.9, 0.55, LC('#0b0910'));
    const tf = -0.42; // cara hacia la parrilla (−t)
    for (let i = 0; i < 5; i++) {
      const lat = -4.4 + i * 2.2;
      for (let r = 0; r < 2; r++) {
        const y = H - 0.95 - r * 1.0;
        const px = o2.x + o2.nx * lat + o2.tx * tf, pz = o2.z + o2.nz * lat + o2.tz * tf;
        EMI.add(new THREE.SphereGeometry(0.4, 12, 8), { x: px, y: base + y, z: pz }, { color: [7, 0.18, 0.22], aAnim: [3, i, 0, 0] });
        if (r === 0) glowAt(px - o2.tx * 0.4, base + y - 0.5, pz - o2.tz * 0.4, 9, [2.6, 0.08, 0.1], { blink: -(i + 1) });
      }
      const pxg = o2.x + o2.nx * lat + o2.tx * tf, pzg = o2.z + o2.nz * lat + o2.tz * tf;
      EMI.add(new THREE.SphereGeometry(0.28, 10, 6), { x: pxg, y: base + H - 2.85, z: pzg }, { color: [0.2, 6, 0.8], aAnim: [4, 0, 0, 0] });
      glowAt(pxg - o2.tx * 0.4, base + H - 2.85, pzg - o2.tz * 0.4, 7, [0.1, 2.4, 0.4], { blink: -20 });
    }
    // banderola META por ambas caras
    const by = H + 2.9;
    [1, -1].forEach((f) => billPanel(o2.x + o2.nx * mid + o2.tx * 0.72 * f, base + by, o2.z + o2.nz * mid + o2.tz * 0.72 * f, o2.tx * f, o2.tz * f, Math.min(30, span + 1.5), 3.4, rect('meta'), [0, 0, 0, 1.05]));
    boxAt(LIT, sG, mid, by, Math.min(30, span + 1.5) + 0.4, 3.7, 1.3, LC('#120e1e'));
    GANTRY = { s: sG, yaw, latA, latB, H };
  }

  /* =========================================================================
     PANTALLAS GIGANTES
     ========================================================================= */
  const JUMBOS = [];
  function jumboAt(x, y, z, fx, fz, w = 30, legs = true, baseY = 0) {
    const h = (w * JH) / JW;
    const yaw = Math.atan2(fx, fz);
    JUMBO.add(new THREE.PlaneGeometry(w, h), { x: x + fx * 0.45, y, z: z + fz * 0.45, ry: yaw });
    LIT.add(new THREE.BoxGeometry(w + 1.4, h + 1.4, 0.8), { x, y, z, ry: yaw }, LC('#0d0a18'));
    const rx = Math.cos(yaw), rz = -Math.sin(yaw); // derecha local (eje x)
    EMI.add(new THREE.BoxGeometry(w + 1.5, 0.22, 0.3), { x: x + fx * 0.45, y: y + h / 2 + 0.7, z: z + fz * 0.45, ry: yaw }, EM(NEON.pink, 3.4, [1, 0, 1.5, 0.5]));
    EMI.add(new THREE.BoxGeometry(w + 1.5, 0.22, 0.3), { x: x + fx * 0.45, y: y - h / 2 - 0.7, z: z + fz * 0.45, ry: yaw }, EM(NEON.cyan, 3.4, [1, 3, 1.5, 0.5]));
    if (legs) [-w * 0.3, w * 0.3].forEach((d) => LIT.add(new THREE.BoxGeometry(1.1, y - h / 2 - baseY, 1.1), { x: x + rx * d - fx * 0.6, y: (y - h / 2 + baseY) / 2, z: z + rz * d - fz * 0.6, ry: yaw }, LC('#2a2440')));
    occPts([[x - rx * w / 2 - 1, y - h / 2 - 1, z - rz * w / 2 - 1], [x + rx * w / 2 + 1, y + h / 2 + 1, z + rz * w / 2 + 1]], 0.6);
    JUMBOS.push({ x, y, z, w, h });
  }

  /* =========================================================================
     GRAN DOSEL DE ARCOS sobre la recta (pies tras la tribuna y tras los boxes)
     + túnel de luz en la frenada de la Curva 1 + láseres
     ========================================================================= */
  const LASER_SRC = [];
  function buildArch(s, pts, ci, th, neonK, phase) {
    TK.at(s, o2);
    const P3 = pts.map(([lat, y]) => [o2.x + o2.nx * lat, o2.y + y, o2.z + o2.nz * lat]);
    for (let i = 0; i + 1 < P3.length; i++) {
      bar(LIT, P3[i], P3[i + 1], th, LC('#1c1830'));
      occPts([P3[i], P3[i + 1]], th * 0.7);
      // tubo de neón por la cara interior (desplazado hacia la pista)
      const a = P3[i], b = P3[i + 1];
      const c = ci % 2 ? NEON.cyan : NEON.pink;
      bar(EMI, [a[0] - o2.tx * (th * 0.55), a[1], a[2] - o2.tz * (th * 0.55)], [b[0] - o2.tx * (th * 0.55), b[1], b[2] - o2.tz * (th * 0.55)], th * 0.32, EM(c, neonK, [1, phase, 2.2, 0.85]));
      bar(EMI, [a[0] + o2.tx * (th * 0.55), a[1], a[2] + o2.tz * (th * 0.55)], [b[0] + o2.tx * (th * 0.55), b[1], b[2] + o2.tz * (th * 0.55)], th * 0.32, EM(ci % 2 ? NEON.violet : NEON.gold, neonK * 0.8, [1, phase + 0.5, 2.2, 0.85]));
    }
    return P3;
  }
  const CANOPY_S = [];
  function buildCanopy(standSide) {
    // dosel sobre tribuna principal + recta + boxes: patas verticales tras la tribuna y tras los boxes
    const st = STANDS.find((x) => x.name === 'main');
    if (!st || !PITB) return;
    const s0 = Math.max(st.sA, PITB.s0) + 12, s1 = Math.min(st.sB, PITB.s1) - 12;
    const n = Math.max(3, Math.min(8, Math.floor((s1 - s0) / 38) + 1));
    const step = (s1 - s0) / (n - 1);
    for (let k = 0; k < n; k++) {
      const s = s0 + k * step;
      CANOPY_S.push(s);
      TK.at(s, o2);
      const latL = standSide * (st.latEnd + 2.4), latR = PITB.side * (PITB.latB + 2.4);
      const H = 38 + (k % 2) * 3, g = -o2.y, span = latL - latR, c = (latL + latR) / 2;
      const pts = [
        [latL, g], [latL, st.roofY + 3], [latL - span * 0.13, H * 0.8], [c + span * 0.22, H * 0.965], [c, H],
        [c - span * 0.22, H * 0.965], [latR + span * 0.13, H * 0.8], [latR, PITB.roofY + 3], [latR, g],
      ];
      const P3 = buildArch(s, pts, k, 1.25, 3.4, k * 0.9);
      [P3[0], P3[P3.length - 1]].forEach((p) => { LIT.add(new THREE.BoxGeometry(3, 2, 3), { x: p[0], y: 1, z: p[2], ry: yawOf(o2) }, LC('#15122a')); ogMark(p[0], p[2], 3); });
      glowAt(P3[4][0], P3[4][1] + 1, P3[4][2], 7, k % 2 ? [0.2, 1.2, 1.6] : [1.6, 0.2, 1.0]);
      if (k % 2 === 0) LASER_SRC.push({ p: P3[3], s, k }, { p: P3[5], s, k: k + 1 });
    }
  }
  /** Centro del hueco entre arcos del dosel que contiene s (para no chocar con sus patas). */
  const canopyGap = (s) => { for (let i = 0; i + 1 < CANOPY_S.length; i++) if (CANOPY_S[i] <= s && s <= CANOPY_S[i + 1]) return (CANOPY_S[i] + CANOPY_S[i + 1]) / 2; return s; };
  function buildLightTunnel(standSide) {
    // frenada de la Curva 1: aros sobre la pista entre el fin de boxes/tribuna y el inicio de la curva
    const c1 = TK.corners[0];
    const end = c1 ? c1.s0 - 6 : TK.main.sB - 6;
    let beg = TK.main.sA;
    STANDS.forEach((st) => { if (st.sB < end && st.sB + 6 > beg) beg = st.sB + 6; });
    if (TK.pit) beg = Math.max(beg, TK.pit.s1 + 4);
    const n = Math.min(5, Math.floor((end - beg) / 12) + 1);
    if (n < 2) return;
    const step = (end - beg) / (n - 1);
    for (let k = 0; k < n; k++) {
      const s = beg + k * step;
      const lL = wallAt(s, 1) + 3.4, lR = wallAt(s, -1) + 3.4;
      const [xL, zL] = [TK.at(s, o2).x + o2.nx * lL, o2.z + o2.nz * lL];
      const [xR, zR] = [o2.x - o2.nx * lR, o2.z - o2.nz * lR];
      if (TK.margin(xL, zL) < -0.5 || TK.margin(xR, zR) < -0.5 || !ogFree(xL, zL, 1.5) || !ogFree(xR, zR, 1.5)) continue;
      const pts = [[lL, 0], [lL, 9], [lL * 0.55, 14], [-lR * 0.55, 14], [-lR, 9], [-lR, 0]];
      buildArch(s, pts, k + 1, 0.7, 4.2, -k * 1.3 + 2);
      ogMark(xL, zL, 4); ogMark(xR, zR, 4);
      // charco de luz bajo el aro
      POOL.add(ribbon(-9.5, 0.09, 9.5, 0.09, s - 7, s + 7, 1.5, { colA: (q) => { const g = Math.exp(-((q - s) ** 2) / 18) * 0.07; return k % 2 ? [g * 0.9, g * 0.15, g * 0.6] : [g * 0.15, g * 0.7, g * 0.9]; } }));
    }
  }

  /* =========================================================================
     PASARELA PEATONAL (landmark 'bridge' sin cross)
     ========================================================================= */
  function buildFootbridge(s) {
    TK.at(s, o2);
    const yaw = yawOf(o2), base = o2.y;
    const lL = wallAt(s, 1) + 3.5, lR = wallAt(s, -1) + 3.5;
    const span = lL + lR, mid = (lL - lR) / 2;
    const deckY = 10.2; // tablero alto: la banderola cuelga y su borde inferior queda a > 7 m
    const cx = o2.x + o2.nx * mid, cz = o2.z + o2.nz * mid;
    LIT.add(new THREE.BoxGeometry(span + 4, 0.8, 4), { x: cx, y: base + deckY + 0.4, z: cz, ry: yaw }, LC('#1d1734'));
    (Q.glass ? GLASS : LIT).add(new THREE.BoxGeometry(span + 4, 1.3, 0.12), { x: cx + o2.tx * 1.95, y: base + deckY + 1.45, z: cz + o2.tz * 1.95, ry: yaw }, LC('#2a2d48'));
    (Q.glass ? GLASS : LIT).add(new THREE.BoxGeometry(span + 4, 1.3, 0.12), { x: cx - o2.tx * 1.95, y: base + deckY + 1.45, z: cz - o2.tz * 1.95, ry: yaw }, LC('#2a2d48'));
    // cubierta en arco (marco ligero)
    for (let k = -3; k <= 3; k++) {
      const lat = mid + (k / 3) * (span / 2);
      const p = [o2.x + o2.nx * lat, o2.z + o2.nz * lat];
      bar(LIT, [p[0] + o2.tx * 2, base + deckY + 0.8, p[1] + o2.tz * 2], [p[0], base + deckY + 4.2, p[1]], 0.18, LC('#2a2448'));
      bar(LIT, [p[0] - o2.tx * 2, base + deckY + 0.8, p[1] - o2.tz * 2], [p[0], base + deckY + 4.2, p[1]], 0.18, LC('#2a2448'));
    }
    boxAt(EMI, s, mid, deckY + 4.2, span + 4, 0.14, 0.14, EM(NEON.violet, 3, [1, 0, 1.5, 0.6]));
    [1, -1].forEach((f) => {
      boxAt(EMI, s + f * 2.02, mid, deckY - 0.02, span + 4, 0.16, 0.16, EM(f > 0 ? NEON.pink : NEON.cyan, 3.6, [1, f, 2, 0.5]));
      billPanel(cx + o2.tx * 2.06 * f, base + deckY - 1.4, cz + o2.tz * 2.06 * f, o2.tx * f, o2.tz * f, Math.min(24, span - 2), 2.6, rect('banner'), [0, 0, 0, 1.2]);
    });
    boxAt(LIT, s, mid, deckY - 1.4, Math.min(24, span - 2) + 0.4, 2.8, 4.0, LC('#0d0a18'));
    // torres de escaleras
    [lL, -lR].forEach((lat) => {
      const ls = lat + Math.sign(lat) * 1.8;
      boxAt(LIT, s, ls, (deckY + 4.5 - base) / 2, 3.6, deckY + 4.5 + base, 4.4, LC('#191431'));
      boxAt(EMI, s, ls - Math.sign(lat) * 1.82, (deckY + 4.5) / 2, 0.1, deckY + 3.5, 0.24, EM(NEON.cyan, 2.4, [1, 0, 1, 0.5]));
      TK.at(s, o3); ogMark(o3.x + o3.nx * ls, o3.z + o3.nz * ls, 4);
      glowAt(o3.x + o3.nx * ls, base + deckY + 5, o3.z + o3.nz * ls, 5, [1.6, 0.3, 1.2], { blink: 2.2, phase: lat });
    });
    // espectadores en la pasarela
    for (let k = 0; k < 26; k++) {
      const lat = mid + rand(-span / 2 + 2, span / 2 - 2), f = rng() < 0.5 ? 1.45 : -1.45;
      CROWD.push({ x: o2.x + o2.nx * lat + o2.tx * f, y: base + deckY + 0.8, z: o2.z + o2.nz * lat + o2.tz * f, seed: rng(), wave: lat, light: 0.85, glow: rng() < 0.3 ? 1 : 0 });
    }
    occPts([[cx - Math.abs(o2.nx) * (span / 2 + 2) - 2.2, base + deckY - 2.9, cz - Math.abs(o2.nz) * (span / 2 + 2) - 2.2], [cx + Math.abs(o2.nx) * (span / 2 + 2) + 2.2, base + deckY + 1.4, cz + Math.abs(o2.nz) * (span / 2 + 2) + 2.2]]);
  }

  /* =========================================================================
     TORRES DE FOCOS + charcos de luz
     ========================================================================= */
  function buildLightTowers() {
    let k = 0;
    for (let s = 20; s < TK.L - 20; s += 92) {
      if (nearLm(s, 'tunnel', 30) || nearLm(s, 'bridge', 25) || nearLm(s, 'stand', 10)) continue;
      TK.at(s, o2);
      const pref = Math.abs(o2.k) > 1 / 300 ? -Math.sign(o2.k) : (k % 2 ? 1 : -1);
      let placed = false;
      for (const side of [pref, -pref]) {
        const lat = clearLat(s, side, 1.6);
        const x = o2.x + o2.nx * lat, z = o2.z + o2.nz * lat;
        if (!canPlace(x, z, 1.5, 0.6)) continue;
        const yaw = Math.atan2(-o2.nx * side, -o2.nz * side);
        const H = 24, gy = 0;
        LIT.add(new THREE.CylinderGeometry(0.28, 0.55, H, 6), { x, y: gy + H / 2, z }, LC('#2a2440'));
        EMI.add(new THREE.BoxGeometry(0.1, H - 4, 0.1), { x: x - o2.nx * side * 0.5, y: gy + H / 2 - 1, z: z - o2.nz * side * 0.5 }, EM(k % 2 ? NEON.pink : NEON.cyan, 2.2, [1, k, 1.2, 0.6]));
        const hx = x - o2.nx * side * 0.6, hz = z - o2.nz * side * 0.6;
        LIT.add(new THREE.BoxGeometry(6.4, 2.7, 0.6), { x: hx, y: gy + H + 0.6, z: hz, ry: yaw, rx: 0.42 }, LC('#18141f'));
        EMI.add(new THREE.BoxGeometry(5.8, 2.2, 0.1), { x: hx - o2.nx * side * 0.33, y: gy + H + 0.52, z: hz - o2.nz * side * 0.33, ry: yaw, rx: 0.42 }, EM('#fff4e0', 4.2));
        glowAt(hx - o2.nx * side * 1.1, gy + H + 0.4, hz - o2.nz * side * 1.1, 13, [0.8, 0.68, 0.52]);
        ogMark(x, z, 3);
        placed = true; k++;
        break;
      }
      if (!placed) continue;
    }
  }

  /* =========================================================================
     VALLAS LED A PIE DE PISTA + chevrones en curvas lentas
     ========================================================================= */
  function buildTrackBoards() {
    let n = 0, b = 0;
    for (let s = 30; s < TK.L - 30 && n < Q.boards; s += 47) {
      if (nearLm(s, 'tunnel', 20) || nearLm(s, 'stand', 6) || nearLm(s, 'bridge', 15)) continue;
      TK.at(s, o2);
      if (Math.abs(o2.k) > 1 / 160) continue;
      const side = n % 2 ? 1 : -1;
      for (const sd of [side, -side]) {
        const lat = clearLat(s, sd, 0.4);
        const x = o2.x + o2.nx * lat, z = o2.z + o2.nz * lat;
        if (!canPlace(x, z, 5.4, 0.1)) continue;
        // los extremos del tablero (±5,3 m a lo largo) también deben quedar fuera de muro + 3 m
        let endsOK = true;
        for (const d of [-5.3, 5.3]) { const ex = x + o2.tx * d, ez = z + o2.tz * d; if (TK.margin(ex, ez) < 0.35) endsOK = false; }
        if (!endsOK) continue;
        // tablero 10 × 2.5 m de cara a la pista, sobre patas
        const fx = -o2.nx * sd, fz = -o2.nz * sd, yaw = Math.atan2(fx, fz);
        const gy = Math.max(0, o2.y - 0.2);
        const mode = b % 5 === 4 ? [2, rng(), 0.05, 1.25] : [1, rng(), 1 / 9, 1.25];
        const r1 = b % 5 === 4 ? rect('ticker') : rect('brand' + (b % 8)), r2 = rect('brand' + ((b + 5) % 8));
        billPanel(x - fx * 0.05, gy + 2.4, z - fz * 0.05, fx, fz, 10, 2.5, r1, mode, r2);
        LIT.add(new THREE.BoxGeometry(10.4, 2.9, 0.35), { x: x - fx * 0.25, y: gy + 2.4, z: z - fz * 0.25, ry: yaw }, LC('#120e1e'));
        EMI.add(new THREE.BoxGeometry(10.4, 0.1, 0.4), { x: x - fx * 0.2, y: gy + 3.9, z: z - fz * 0.2, ry: yaw }, EM(BRANDS[b % 8][1], 2.6));
        [-4.2, 4.2].forEach((d) => LIT.add(new THREE.BoxGeometry(0.25, 1.2, 0.25), { x: x - fx * 0.25 + Math.cos(yaw) * d, y: gy + 0.6, z: z - fz * 0.25 - Math.sin(yaw) * d }, LC('#2a2440')));
        ogMark(x, z, 5.5);
        n++; b++;
        break;
      }
    }
    // chevrones en el exterior de las curvas lentas
    TK.corners.forEach((c) => {
      if (c.R > 60) return;
      const side = -c.dir; // exterior
      for (let k = 0; k < 3; k++) {
        const s = c.s0 + (c.apex - c.s0) * (0.2 + k * 0.35);
        TK.at(s, o2);
        const lat = clearLat(s, side, 2.2); // el panel va girado: su extremo interior queda a > muro + 3 m
        const x = o2.x + o2.nx * lat, z = o2.z + o2.nz * lat;
        if (!canPlace(x, z, 2.8, 1.5)) continue;
        if (TK.margin(x + o2.tx * 2.7, z + o2.tz * 2.7) < 1.2 || TK.margin(x - o2.tx * 2.7, z - o2.tz * 2.7) < 1.2) continue;
        // mirando al coche que llega (−t), girado hacia la pista
        let fx = -o2.tx * 0.55 - o2.nx * side * 0.83, fz = -o2.tz * 0.55 - o2.nz * side * 0.83;
        const l = Math.hypot(fx, fz); fx /= l; fz /= l;
        const r = c.dir < 0 ? rect('chevron') : flipU(rect('chevron'));
        const gy = Math.max(0, o2.y - 0.2);
        billPanel(x, gy + 1.9, z, fx, fz, 5, 2.5, r, [3, k * 7.1, 6, 1.4]);
        LIT.add(new THREE.BoxGeometry(5.3, 2.8, 0.3), { x: x - fx * 0.2, y: gy + 1.9, z: z - fz * 0.2, ry: Math.atan2(fx, fz) }, LC('#120e1e'));
        ogMark(x, z, 3);
      }
    });
  }

  /* =========================================================================
     PODIO (plaza en el interior, detrás de los boxes)
     ========================================================================= */
  let PODIUM = null;
  function buildPodium() {
    const p = TK.pit, sd = p ? p.side : -1;
    let best = null;
    const sMid = PITB ? (PITB.s0 + PITB.s1) / 2 : 0;
    const latBase = PITB ? PITB.latB + 30 : wallAt(0, sd) + 40;
    outer: for (let dl = 0; dl <= 60; dl += 6) for (const ds of [0, -24, 24, -48, 48, -72, 72, -100, 100]) {
      const s = sMid + ds;
      TK.at(s, o2);
      const lat = sd * (latBase + dl);
      const x = o2.x + o2.nx * lat, z = o2.z + o2.nz * lat;
      if (canPlace(x, z, 24)) { best = { x, z, s, fx: -o2.nx * sd, fz: -o2.nz * sd }; break outer; }
    }
    if (!best) {
      // búsqueda amplia en el interior
      for (let r = 60; r < 400 && !best; r += 20) for (let a = 0; a < TAU; a += 0.3) {
        const x = B.cx + Math.cos(a) * r, z = B.cz + Math.sin(a) * r;
        if (FAST.inside(x, z) && canPlace(x, z, 22)) { const q = TK.dist(x, z); TK.at(q.s, o2); const l = Math.hypot(o2.x - x, o2.z - z) || 1; best = { x, z, s: q.s, fx: (o2.x - x) / l, fz: (o2.z - z) / l }; break; }
      }
    }
    if (!best) best = { x: B.cx, z: B.cz, s: 0, fx: 0, fz: -1 };
    const { x: cx, z: cz, fx, fz } = best;
    const yaw = Math.atan2(fx, fz);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw); // izquierda del coche (= derecha del espectador)
    const heights = [1.7, 1.15, 0.75];
    const offs = [0, -5.6, 5.6]; // P2 a la izquierda del espectador
    const slots = [];
    LIT.add(new THREE.CylinderGeometry(15, 15.4, 0.3, 48), { x: cx, y: 0.15, z: cz }, LC('#0d0b1a'));
    EMI.add(new THREE.CylinderGeometry(15.45, 15.45, 0.12, 64, 1, true), { x: cx, y: 0.3, z: cz }, EM(NEON.violet, 3, [1, 0, 1, 0.6]));
    EMI.add(new THREE.TorusGeometry(10.5, 0.06, 4, 64).rotateX(Math.PI / 2), { x: cx, y: 0.32, z: cz }, EM(NEON.cyan, 2.4, [1, 2, 1.4, 0.7]));
    const rc = [lin('#ffcc33', 3), lin('#cfe0ff', 2.6), lin('#ff9f5a', 2.8)];
    offs.forEach((d, i) => {
      const h = heights[i], px = cx + rx * d, pz = cz + rz * d;
      LIT.add(new THREE.BoxGeometry(5.4, h, 6), { x: px, y: 0.3 + h / 2, z: pz, ry: yaw }, LC('#211a3c'));
      // aristas de neón
      const e = (lx, lz, ly, sx, sy, sz) => EMI.add(new THREE.BoxGeometry(sx, sy, sz), { x: px + rx * lx + fx * lz, y: 0.3 + ly, z: pz + rz * lx + fz * lz, ry: yaw }, { color: rc[i], aAnim: [1, i, 1.4, 0.4] });
      e(0, 3.02, h, 5.5, 0.09, 0.09); e(0, -3.02, h, 5.5, 0.09, 0.09); e(2.72, 0, h, 0.09, 0.09, 6.1); e(-2.72, 0, h, 0.09, 0.09, 6.1);
      e(2.72, 3.02, h / 2, 0.09, h, 0.09); e(-2.72, 3.02, h / 2, 0.09, h, 0.09);
      billPanel(px + fx * 3.03, 0.3 + h / 2, pz + fz * 3.03, fx, fz, Math.min(1.5, h * 0.9), Math.min(1.5, h * 0.9), rect('pod', [i / 3, (i + 1) / 3]), [0, 0, 0, 2.2]);
      const syaw = yaw + (i === 0 ? 0 : i === 1 ? -0.2 : 0.2);
      slots.push({ x: px, y: 0.3 + h, z: pz, yaw: syaw });
    });
    // telón de fondo con el cartel GP y estructura de focos
    const bx = cx - fx * 8, bz = cz - fz * 8;
    LIT.add(new THREE.BoxGeometry(30, 10, 0.8), { x: bx, y: 5, z: bz, ry: yaw }, LC('#0f0b1e'));
    billPanel(bx + fx * 0.45, 7.6, bz + fz * 0.45, fx, fz, 28, 3.5, rect('gp'), [0, 0, 0, 1.3]);
    billPanel(bx + fx * 0.45, 3.4, bz + fz * 0.45, fx, fz, 26, 3.25, rect('ticker'), [2, 0, 0.04, 1.1]);
    EMI.add(new THREE.BoxGeometry(30.2, 0.18, 0.2), { x: bx + fx * 0.5, y: 10.05, z: bz + fz * 0.5, ry: yaw }, EM(NEON.pink, 3.4, [1, 0, 2, 0.6]));
    EMI.add(new THREE.BoxGeometry(30.2, 0.18, 0.2), { x: bx + fx * 0.5, y: 1.55, z: bz + fz * 0.5, ry: yaw }, EM(NEON.cyan, 3.4, [1, 2, 2, 0.6]));
    [-15.5, 15.5].forEach((d) => {
      LIT.add(new THREE.BoxGeometry(0.7, 15, 0.7), { x: cx + rx * d - fx * 2, y: 7.5, z: cz + rz * d - fz * 2 }, LC('#221c38'));
      EMI.add(new THREE.BoxGeometry(0.14, 14.6, 0.14), { x: cx + rx * d - fx * 1.6, y: 7.5, z: cz + rz * d - fz * 1.6 }, EM(NEON.violet, 3, [1, d, 1.5, 0.6]));
    });
    LIT.add(new THREE.BoxGeometry(31.7, 0.8, 0.8), { x: cx - fx * 2, y: 15, z: cz - fz * 2, ry: yaw }, LC('#221c38'));
    EMI.add(new THREE.BoxGeometry(31.8, 0.14, 0.14), { x: cx - fx * 1.55, y: 14.55, z: cz - fz * 1.55, ry: yaw }, EM(NEON.gold, 2.6));
    for (let k = -4; k <= 4; k++) glowAt(cx + rx * k * 3.2 - fx * 1.5, 14.3, cz + rz * k * 3.2 - fz * 1.5, 3, [0.8, 0.7, 0.5]);
    POOL.add(new THREE.CircleGeometry(14, 32).rotateX(-Math.PI / 2), { x: cx, y: 0.33, z: cz }, { color: [0.08, 0.06, 0.05] });
    occPts([[bx - Math.abs(rx) * 15 - 1, 0, bz - Math.abs(rz) * 15 - 1], [bx + Math.abs(rx) * 15 + 1, 10.2, bz + Math.abs(rz) * 15 + 1]]);
    ogMark(cx, cz, 22);
    PODIUM = { x: cx, y: 0.3, z: cz, yaw, slots, front: [fx, fz] };
    return PODIUM;
  }

  /* =========================================================================
     CIUDAD: anillo cercano con letreros, centro y skyline lejano
     ========================================================================= */
  const SKY = new Bucket({ normal: 3, aB: 4, aCol: 3, aTop: 2 });
  const TOWERS = []; // edificios altos (para hologramas / reflectores)
  const BLOCK = 90, ROAD = 14;
  // sol synthwave: dirección (azimut hacia +z, ~9° de altura); la ciudad abre un «valle» bajo él
  const SUN = new THREE.Vector3(0.1, 0.16, 1).normalize();
  const sunAz = Math.atan2(SUN.x, SUN.z);
  const CLUSTERS = [
    { x: B.cx + 40, z: B.minZ - 520, r: 380, k: 1.6 },   // detrás de la tribuna principal
    { x: B.cx - 680, z: B.maxZ + 560, r: 420, k: 1.8 },  // flanqueando el sol synthwave
    { x: B.cx + 520, z: B.maxZ + 640, r: 360, k: 1.4 },
    { x: B.maxX + 600, z: B.cz + 60, r: 360, k: 1.3 },
    { x: B.minX - 560, z: B.cz - 80, r: 340, k: 1.2 },
  ];
  const winPal = [lin('#bcd8ff', 1.2), lin('#ffd9a8', 1.15), lin('#9ff6ff', 1.2), lin('#ffb3ec', 1.15), lin('#fff4d6', 1.1)];
  const trimPal = [NEON.pink, NEON.cyan, NEON.violet, NEON.gold, NEON.green];
  function addBuilding(x, z, w, d, h, opt = {}) {
    const seed = rng();
    const kind = opt.kind != null ? opt.kind : (rng() < 0.5 ? 0 : rng() < 0.6 ? 1 : rng() < 0.4 ? 2 : 0);
    const cw = winPal[Math.floor(rng() * winPal.length)];
    const shape = opt.shape || (h > 90 && rng() < 0.45 ? 'step' : h > 60 && rng() < 0.18 ? 'cyl' : 'box');
    const ry = opt.ry || 0;
    const attrs = (top) => ({ aB: [seed, kind, x, z], aCol: cw, aTop: [top, shape === 'cyl' ? 2 : opt.far ? 1 : 0] });
    const boxG = (bw, bh, bd, y0) => { const g = new THREE.BoxGeometry(bw, bh, bd); g.translate(0, y0 + bh / 2, 0); return g; };
    if (shape === 'cyl') {
      const g = new THREE.CylinderGeometry(w * 0.5, w * 0.55, h, 12, 1); g.translate(0, h / 2, 0);
      SKY.add(g, { x, z }, attrs(h));
    } else if (shape === 'step') {
      const h1 = h * rand(0.45, 0.6), h2 = h * rand(0.75, 0.88);
      SKY.add(boxG(w, h1, d, 0), { x, z, ry }, attrs(h1));
      SKY.add(boxG(w * 0.78, h2 - h1, d * 0.78, h1), { x, z, ry }, attrs(h2));
      SKY.add(boxG(w * 0.55, h - h2, d * 0.55, h2), { x, z, ry }, attrs(h));
    } else SKY.add(boxG(w, h, d, 0), { x, z, ry }, attrs(h));
    if (h > 120 && !opt.far) {
      // aguja + baliza roja
      LIT.add(new THREE.CylinderGeometry(0.4, 1.4, h * 0.14, 5), { x, y: h + h * 0.07, z }, LC('#1a1530'));
      glowAt(x, h + h * 0.14 + 1, z, 10, [2.4, 0.15, 0.2], { blink: 1.4 + rng(), phase: rng() * 6, minPx: 1.5 });
    } else if (h > 140) glowAt(x, h + 2, z, 10, [2.0, 0.12, 0.16], { blink: 1.2 + rng(), phase: rng() * 6, minPx: 1.2 });
    stats.buildings++;
    const tw = shape === 'step' ? w * 0.55 : w, td = shape === 'step' ? d * 0.55 : d;
    return { x, z, w, d, h, kind, shape, seed, tw, td, rc: Math.hypot(x - B.cx, z - B.cz) };
  }
  /** Neón de cornisa + letreros orientados hacia el circuito para edificios cercanos. */
  function dressNear(bld, toTrack) {
    const { x, z, h } = bld, w = bld.tw, d = bld.td;
    const tc = trimPal[Math.floor(rng() * trimPal.length)];
    const ec = lin(tc, 2.6), an = [rng() < 0.4 ? 1 : 0, rng() * 6, 0.8, 0.6];
    const hw = w / 2 + 0.06, hd = d / 2 + 0.06;
    if (bld.shape !== 'cyl') {
      EMI.add(new THREE.BoxGeometry(w + 0.3, 0.3, 0.3), { x, y: h - 0.15, z: z + hd }, { color: ec, aAnim: an });
      EMI.add(new THREE.BoxGeometry(w + 0.3, 0.3, 0.3), { x, y: h - 0.15, z: z - hd }, { color: ec, aAnim: an });
      EMI.add(new THREE.BoxGeometry(0.3, 0.3, d + 0.3), { x: x + hw, y: h - 0.15, z }, { color: ec, aAnim: an });
      EMI.add(new THREE.BoxGeometry(0.3, 0.3, d + 0.3), { x: x - hw, y: h - 0.15, z }, { color: ec, aAnim: an });
      if (rng() < 0.45) [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([a, b]) => EMI.add(new THREE.BoxGeometry(0.25, h - 1, 0.25), { x: x + a * hw, y: h / 2, z: z + b * hd }, { color: lin(tc, 1.8), aAnim: [0, 0, 0, 0] }));
    }
    // cara hacia el circuito
    const [tx, tz] = toTrack;
    let fx = 0, fz = 0, off;
    const bw = bld.w / 2 + 0.06, bd = bld.d / 2 + 0.06, isStep = bld.shape === 'step';
    if (Math.abs(tx) > Math.abs(tz)) { fx = Math.sign(tx); off = bw; } else { fz = Math.sign(tz); off = bd; }
    if (bld.shape === 'cyl') off = bld.w * 0.5;
    const faceW = fx ? bld.d : bld.w;
    const hFace = isStep ? h * 0.42 : h;
    if (hFace > 22 && rng() < 0.85 * Q.signs) {
      // letrero vertical (estilo callejero)
      const sw = Math.min(6, faceW * 0.3), sh = sw * 2;
      const along = rand(-0.3, 0.3) * faceW;
      const px = x + fx * (off + 0.6) + (fz ? along : 0), pz = z + fz * (off + 0.6) + (fx ? along : 0);
      const vy = Math.min(hFace - sh / 2 - 2, rand(sh / 2 + 6, Math.max(sh / 2 + 7, hFace * 0.6)));
      billPanel(px, vy, pz, fx, fz, sw, sh, rect('vsign' + Math.floor(rng() * 8)), [rng() < 0.3 ? 3 : 0, rng() * 10, 7, 1.5]);
      stats.signs++;
    }
    if (h < 70 && rng() < 0.6 * Q.signs) {
      // valla en la azotea, girada hacia la pista
      const ww = Math.min(26, Math.max(12, faceW * 0.8)), hh = ww / 2;
      const yaw = Math.atan2(tx, tz);
      const bi = Math.floor(rng() * 8);
      billPanel(x + tx * 0.5, h + 2 + hh / 2, z + tz * 0.5, tx, tz, ww, hh, rect('bill' + bi), [1, rng(), 1 / 12, 1.25], rect('bill' + ((bi + 4) % 8)));
      LIT.add(new THREE.BoxGeometry(ww + 0.8, hh + 0.8, 0.6), { x: x - tx * 0.1, y: h + 2 + hh / 2, z: z - tz * 0.1, ry: yaw }, LC('#0c0a14'));
      [-ww * 0.35, ww * 0.35].forEach((dd) => LIT.add(new THREE.BoxGeometry(0.5, 2.2, 0.5), { x: x + Math.cos(yaw) * dd, y: h + 1.1, z: z - Math.sin(yaw) * dd }, LC('#221c38')));
      stats.signs++;
    } else if (h >= 70 && h < 200 && rng() < 0.55 * Q.signs) {
      // pantalla LED de fachada
      const ww = Math.min(faceW * 0.8, 30), hh = ww * 0.5;
      const px = x + fx * (off + 0.15), pz = z + fz * (off + 0.15);
      const bi = Math.floor(rng() * 8);
      billPanel(px, isStep ? hFace * 0.6 : h * rand(0.55, 0.8), pz, fx, fz, ww, hh, rect('bill' + bi), [1, rng(), 1 / 10, 1.3], rect('bill' + ((bi + 3) % 8)));
      stats.signs++;
    }
  }
  function buildCity() {
    const R_IN = 760, R_OUT = 1500;
    const cxC = B.cx, czC = B.cz;
    // torres del interior: los puntos más alejados del trazado
    const cand = [];
    for (let x = B.minX + 40; x < B.maxX - 40; x += 15) for (let z = B.minZ + 40; z < B.maxZ - 40; z += 15) {
      if (!FAST.inside(x, z)) continue;
      const m = FAST.margin(x, z);
      if (m > 55 && ogFree(x, z, 40)) cand.push([m, x, z]);
    }
    cand.sort((a, b) => b[0] - a[0]);
    const infTowers = [];
    for (const [m, x, z] of cand) {
      if (infTowers.length >= 2) break;
      if (infTowers.some((t) => Math.hypot(t.x - x, t.z - z) < 140)) continue;
      if (PODIUM && Math.hypot(PODIUM.x - x, PODIUM.z - z) < 80) continue;
      const h = Math.min(250, 140 + m * 0.7);
      const fw = Math.min(34, m * 0.45);
      const b = addBuilding(x, z, fw, fw, h, { kind: infTowers.length ? 0 : 2, shape: infTowers.length ? 'cyl' : 'step' });
      infTowers.push(b); TOWERS.push(b);
      ogMark(x, z, fw * 0.8 + 6);
      occPts([[x - fw / 2, 0, z - fw / 2], [x + fw / 2, h, z + fw / 2]]);
      // corona de neón
      EMI.add(new THREE.CylinderGeometry(fw * 0.5 + 0.4, fw * 0.5 + 0.4, 0.5, 24, 1, true), { x, y: h + 0.3, z }, EM(NEON.pink, 3, [6, 0, 0.4, 1]));
    }
    const lots = [];
    const bi0 = Math.floor((cxC - R_OUT) / BLOCK), bi1 = Math.ceil((cxC + R_OUT) / BLOCK);
    const bj0 = Math.floor((czC - R_OUT) / BLOCK), bj1 = Math.ceil((czC + R_OUT) / BLOCK);
    for (let bi = bi0; bi <= bi1; bi++) for (let bj = bj0; bj <= bj1; bj++) {
      const bx = bi * BLOCK + 7, bz = bj * BLOCK + 7; // centro de manzana (calles en mod(x+45,90) < 14)
      const rc = Math.hypot(bx - cxC, bz - czC);
      if (rc > R_OUT) continue;
      if (rc < R_IN) for (const ox of [-19, 19]) for (const oz of [-19, 19]) lots.push([bx + ox, bz + oz, 32]);
      else lots.push([bx, bz, 66]);
    }
    let nearCount = 0;
    for (const [x, z, size] of lots) {
      if (rng() > Q.city + 0.05) continue;
      const rc = Math.hypot(x - cxC, z - czC);
      const half = size / 2;
      const m = FAST.margin(x, z);
      if (m < half * 1.2 + 6) continue;
      if (!ogFree(x, z, half * 0.9)) continue;
      const ins = FAST.inside(x, z);
      if (ins && m < 30) continue;
      let hCap;
      if (ins) hCap = Math.min(46, 12 + (m - 30) * 0.4);
      else hCap = Math.min(330, m < 60 ? 12 + (m - 20) * 0.5 : m < 250 ? 32 + (m - 60) * 0.72 : 169 + (m - 250) * 0.9);
      let boost = 1;
      // valle bajo el sol: edificios bajos en su azimut (vistos desde el centro del circuito)
      if (!ins) { let da = Math.atan2(x - B.cx, z - B.cz) - sunAz; da -= Math.round(da / TAU) * TAU; if (Math.abs(da) < 0.2) hCap = Math.min(hCap, 26 + Math.abs(da) * 500); }
      for (const c of CLUSTERS) boost += c.k * Math.exp(-((x - c.x) ** 2 + (z - c.z) ** 2) / (c.r * c.r));
      if (!ins && m > 120 && rng() < 0.1) continue; // plazas
      let h = hCap * (0.3 + 0.7 * Math.pow(rng(), 1.3)) * (0.6 + 0.4 * boost);
      h = Math.min(h, hCap * 1.6, 360);
      if (h < 9) continue;
      const w = size * rand(0.55, 0.92), d = size * rand(0.55, 0.92);
      const far = rc > 1150;
      const bld = addBuilding(x, z, w, d, h, { far, kind: far ? (rng() < 0.7 ? 3 : 0) : undefined });
      ogMark(x, z, Math.max(w, d) * 0.6);
      if (m < 240 && !far) {
        const q = TK.dist(x, z); TK.at(q.s, o2);
        let tx = o2.x - x, tz = o2.z - z; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        dressNear(bld, [tx, tz]);
        if (m < 170) occPts([[x - w / 2, 0, z - d / 2], [x + w / 2, h, z + d / 2]]);
        nearCount++;
      }
      if (h > 150 && !far) TOWERS.push(bld);
    }
    // hologramas / reflectores: primero las torres del interior, luego las altas más cercanas
    const rest = TOWERS.splice(infTowers.length).sort((a, b) => a.rc - b.rc);
    TOWERS.push(...rest);
    return { nearCount };
  }

  /* =========================================================================
     HOLOGRAMAS, REFLECTORES Y LÁSERES
     ========================================================================= */
  function holoPlane(cx, cy, cz, w, h, r, color, spin, crossed = true) {
    const mk = (ry) => { const g = new THREE.PlaneGeometry(w, h); g.rotateY(ry); g.translate(cx, cy, cz); HOLO.add(g, null, { aRect: r, aCenter: [cx, cy, cz], aSpin: spin, color }); };
    mk(0); if (crossed) mk(Math.PI / 2);
  }
  function holoRing(cx, cy, cz, radius, h, reps, color, spin) {
    const g = new THREE.CylinderGeometry(radius, radius, h, 48, 1, true);
    const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * reps);
    g.translate(cx, cy, cz);
    HOLO.add(g, null, { aRect: rect('ring'), aCenter: [cx, cy, cz], aSpin: spin, color });
  }
  function buildHolograms() {
    if (!Q.holo) return;
    // coche holográfico sobre los boxes
    if (PITB) {
      const s = canopyGap(-60);
      TK.at(s, o2);
      const lat = PITB.side * (PITB.latF + PITB.latB) / 2;
      holoPlane(o2.x + o2.nx * lat, PITB.roofY + 11, o2.z + o2.nz * lat, 34, 17, rect('car'), lin('#5ff3ff', 0.95), [0.22, 0.8, 0, 0.6], false);
      LIT.add(new THREE.CylinderGeometry(3, 3.6, 1.2, 12), { x: o2.x + o2.nx * lat, y: PITB.roofY + 0.6, z: o2.z + o2.nz * lat }, LC('#15122a'));
      EMI.add(new THREE.CylinderGeometry(3.05, 3.05, 0.2, 24, 1, true), { x: o2.x + o2.nx * lat, y: PITB.roofY + 1.1, z: o2.z + o2.nz * lat }, EM(NEON.cyan, 4));
      POOL.add(new THREE.ConeGeometry(16, 9, 24, 1, true).rotateX(Math.PI), { x: o2.x + o2.nx * lat, y: PITB.roofY + 5.6, z: o2.z + o2.nz * lat }, { color: [0.0, 0.05, 0.07] });
    }
    // trofeo sobre el podio
    if (PODIUM) {
      const { x, z, front } = PODIUM;
      holoPlane(x - front[0] * 9, 21, z - front[1] * 9, 9, 9, rect('trophy'), lin('#ffe9a0', 1.7), [0.5, 0.6, 1, 0.4]);
      holoPlane(x - front[0] * 9, 27.5, z - front[1] * 9, 7, 7, rect('emblem'), lin('#ff9de6', 1.4), [-0.3, 0.4, 2, 0.4], false);
    }
    // anillos de texto en las torres altas
    TOWERS.slice(0, 5).forEach((t, i) => {
      const r = Math.max(t.w, t.d) * 0.62 + 5;
      holoRing(t.x, t.h * 0.82, t.z, r, Math.min(14, t.h * 0.07), Math.max(2, Math.round(r / 9)), i % 2 ? lin('#7af7ff', 1.5) : lin('#ff8ae0', 1.5), [i % 2 ? 0.12 : -0.1, 0, i, 0.3]);
    });
    // emblemas flotando junto a torres medianas (cara + espalda: el emblema es simétrico)
    TOWERS.slice(5, 9).forEach((t, i) => holoPlane(t.x + t.w * 0.9, t.h * 0.6, t.z, 26, 26, rect('emblem'), lin(i % 2 ? '#7af7ff' : '#c58bff', 1.3), [0.15, 2, i * 2, 0.5]));
  }
  function beam(base, len, r0, r1, color, b, b2) {
    const g = new THREE.CylinderGeometry(r1, r0, len, 12, 1, true); g.translate(0, len / 2, 0);
    BEAM.add(g, null, { color, aBase: base, aB: b, aB2: b2 });
  }
  function buildBeams() {
    // reflectores desde azoteas (barren el cielo)
    const tall = TOWERS.filter((t) => t.h > 80).sort((a, b) => b.h - a.h);
    const srcs = tall.slice(0, Q.search - 2).map((t) => [t.x, t.h + 2, t.z]);
    const st = STANDS.find((x) => x.name === 'main');
    if (st) [0.25, 0.75].forEach((f) => { const s = lerp(st.sA, st.sB, f); TK.at(s, o2); const lat = st.side * (st.latEnd + 10); srcs.push([o2.x + o2.nx * lat, 1, o2.z + o2.nz * lat]); });
    const cols = [lin('#cfe2ff', 0.13), lin(NEON.pink, 0.12), lin(NEON.cyan, 0.12), lin('#cfe2ff', 0.12)];
    srcs.forEach((p, i) => {
      beam(p, 620, 0.9, 30, cols[i % cols.length], [rng() * TAU, (rng() < 0.5 ? -1 : 1) * rand(0.12, 0.25), rand(0.28, 0.5), rand(0.12, 0.22)], [0, 1, 0, 0]);
      glowAt(p[0], p[1] + 0.5, p[2], 9, [1.3, 1.3, 1.5]);
      stats.searchlights++;
    });
    // láseres desde el dosel
    const lc = [lin(NEON.green, 1.4), lin(NEON.pink, 1.4), lin(NEON.cyan, 1.4), lin(NEON.violet, 1.5)];
    LASER_SRC.slice(0, Q.lasers).forEach((L, i) => {
      TK.at(L.s, o2);
      const yaw0 = Math.atan2(o2.tx, o2.tz) + (i % 2 ? 0.6 : -0.6);
      beam(L.p, 380, 0.08, 0.6, lc[i % lc.length], [yaw0, 0.35 + (i % 3) * 0.12, rand(0.55, 0.9), 0.3], [0.9, 0.5 + rng(), 0, 0]);
      stats.lasers++;
    });
  }

  /* =========================================================================
     PALMERAS (instanciadas)
     ========================================================================= */
  function addPalm(x, z, y = 0) { PALMS.push({ x, z, y, sc: rand(0.85, 1.3), rot: rand(0, TAU), glow: rng() < 0.4 }); ogMark(x, z, 2.5); }
  function buildPalms() {
    const target = Q.palms;
    if (PODIUM) for (let k = 0; k < 10 && PALMS.length < target; k++) {
      const a = (k / 10) * TAU + 0.3, r = 19.5;
      const x = PODIUM.x + Math.cos(a) * r, z = PODIUM.z + Math.sin(a) * r;
      const fx = PODIUM.front[0], fz = PODIUM.front[1];
      if (Math.cos(a) * fx + Math.sin(a) * fz > 0.55) continue; // deja libre el frente (cámara)
      if (canPlace(x, z, 2)) addPalm(x, z);
    }
    // bulevares junto al circuito (tramos sin tribunas)
    for (let s = 8; s < TK.L && PALMS.length < target * 0.75; s += 15) {
      if (nearLm(s, 'stand', 8) || nearLm(s, 'tunnel', 10)) continue;
      TK.at(s, o2);
      for (const side of [1, -1]) {
        if (rng() < 0.35) continue;
        const lat = clearLat(s, side, rand(3, 7));
        const x = o2.x + o2.nx * lat, z = o2.z + o2.nz * lat;
        if (canPlace(x, z, 2.2)) addPalm(x, z);
      }
    }
    let tries = 0;
    while (PALMS.length < target && tries++ < 3000) {
      TK.at(rng() * TK.L, o2);
      const side = rng() < 0.5 ? 1 : -1, lat = clearLat(o2.s, side, rand(8, 45));
      const x = o2.x + o2.nx * lat, z = o2.z + o2.nz * lat;
      if (canPlace(x, z, 3)) addPalm(x, z);
    }
    stats.palms = PALMS.length;
  }

  /* =========================================================================
     MONTAJE: lugares a partir de T
     ========================================================================= */
  const pitSide = TK.pit ? TK.pit.side || -1 : -1;
  const standSide = -pitSide;
  // tribunas: landmarks 'stand' (o por defecto: recta principal + exterior de C1 y horquilla) + peraltada final
  {
    let stands = lmOf('stand').map((l) => ({ s0: l.s0, s1: l.s1, side: l.side || 1, name: l.name || '' }));
    if (!stands.length) {
      stands.push({ s0: TK.main.sA + 70, s1: Math.min(150, TK.main.sB - 60), side: standSide, name: 'main' });
      TK.corners.slice(0, 1).forEach((c) => stands.push({ s0: c.apex - 50, s1: c.apex + 50, side: -c.dir }));
    }
    // tribuna extra en la última curva larga (exterior), si cabe
    const last = TK.corners[TK.corners.length - 1];
    if (last && last.s1 - last.s0 > 160) stands.push({ s0: lerp(last.s0, last.s1, 0.42), s1: lerp(last.s0, last.s1, 0.72), side: -last.dir, name: 'Tribuna Peraltada' });
    stands.forEach((st, i) => {
      const isMain = TK.dS(st.s0, 0) > 0 && TK.dS(0, st.s1) > 0;
      // hueco en la tribuna principal para el pilono del pórtico
      if (isMain) {
        buildStand(st.s0, -7, st.side, 15, { name: 'main', brand0: 0, waveDir: 1 });
        const b = buildStand(7, st.s1, st.side, 15, { name: 'main2', brand0: 4 });
        if (b && STANDS.find((x) => x.name === 'main')) { const m = STANDS.find((x) => x.name === 'main'); m.sB = b.sB; m.latEnd = Math.max(m.latEnd, b.latEnd); }
      } else buildStand(st.s0, st.s1, st.side, i === 2 ? 11 : 10, { name: st.name || 'stand' + i, brand0: i * 3 });
    });
  }
  prof('stands');
  buildPits();
  buildGantry(0, standSide);
  buildCanopy(standSide);
  // pantallas: tras la tribuna principal (frente a la parrilla) y en la frenada de C1
  {
    const st = STANDS.find((x) => x.name === 'main');
    const sJ = canopyGap(-18);
    TK.at(sJ, o2);
    if (st) {
      const lat = standSide * (st.latEnd + 2.5);
      jumboAt(o2.x + o2.nx * lat, st.roofY + 9, o2.z + o2.nz * lat, -o2.nx * standSide, -o2.nz * standSide, 30);
      ogMark(o2.x + o2.nx * lat, o2.z + o2.nz * lat, 16);
      // segunda pantalla sobre la azotea de los boxes, mirando a la parrilla (la ve la cámara de salida)
      if (PITB) {
        const sP = canopyGap(35);
        TK.at(sP, o2);
        const latP = PITB.side * (PITB.latF + 6.5);
        let fx = -o2.tx * 0.72 - o2.nx * PITB.side * 0.7, fz = -o2.tz * 0.72 - o2.nz * PITB.side * 0.7; const l = Math.hypot(fx, fz); fx /= l; fz /= l;
        jumboAt(o2.x + o2.nx * latP, o2.y + PITB.roofY + 10.5, o2.z + o2.nz * latP, fx, fz, 26, true, o2.y + PITB.roofY);
      }
      // gran rótulo «NEÓN CITY» sobre la tribuna principal (cara a la recta)
      TK.at(canopyGap(70), o2);
      const lat2 = standSide * (st.latEnd + 1.5);
      billPanel(o2.x + o2.nx * lat2, st.roofY + 9, o2.z + o2.nz * lat2, -o2.nx * standSide, -o2.nz * standSide, 36, 9, rect('city'), [0, 0, 0, 1.6]);
      LIT.add(new THREE.BoxGeometry(36.6, 0.6, 1.2), { x: o2.x + o2.nx * (lat2 + standSide * 0.6), y: st.roofY + 3.2, z: o2.z + o2.nz * (lat2 + standSide * 0.6), ry: yawOf(o2) + Math.PI / 2 }, LC('#15122a'));
      [-15, 0, 15].forEach((d) => LIT.add(new THREE.BoxGeometry(0.6, 9, 0.6), { x: o2.x + o2.nx * (lat2 + standSide * 0.8) + o2.tx * d, y: st.roofY + 3.5, z: o2.z + o2.nz * (lat2 + standSide * 0.8) + o2.tz * d }, LC('#221c38')));
    }
    const c1 = TK.corners[0];
    if (c1) {
      const s = c1.s0 - 4, side = -c1.dir;
      TK.at(s, o2);
      const lat = clearLat(s, side, 10);
      const x = o2.x + o2.nx * lat, z = o2.z + o2.nz * lat;
      if (canPlace(x, z, 10, 5)) {
        let fx = -o2.tx * 0.8 - o2.nx * side * 0.6, fz = -o2.tz * 0.8 - o2.nz * side * 0.6; const l = Math.hypot(fx, fz); fx /= l; fz /= l;
        jumboAt(x, 15, z, fx, fz, 24);
        ogMark(x, z, 14);
      }
    }
  }
  buildLightTunnel(standSide);
  lmOf('bridge').filter((l) => !l.cross).forEach((l) => buildFootbridge((l.s0 + l.s1) / 2));
  buildPodium();
  buildLightTowers();
  buildTrackBoards();
  prof('pits..boards');
  buildCity();
  prof('city');
  buildHolograms();
  buildBeams();
  buildPalms();
  prof('holo+palms');

  /* =========================================================================
     MATERIALES Y MALLAS
     ========================================================================= */
  const meshes = [];
  const addMesh = (m, order) => { if (!m) return null; if (order != null) m.renderOrder = order; group.add(m); meshes.push(m); return m; };

  // --- cielo
  const SUN_DIR = SUN;
  const skyMat = new THREE.ShaderMaterial({
    uniforms: Object.assign(uni('uTime', 'uFogColor', 'uFogDensity', 'uCloud', 'uStars', 'uWind'), { uSun: { value: SUN_DIR } }),
    defines: Q.clouds ? { CLOUDS: 1 } : {},
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vec4 p = projectionMatrix * viewMatrix * w; gl_Position = p.xyww; gl_Position.z *= 0.99999; }`,
    fragmentShader: GL_COMMON + `varying vec3 vW; uniform vec3 uSun; uniform float uCloud; uniform float uStars; uniform float uWind;
      float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
      void main(){
        vec3 d = normalize(vW - cameraPosition);
        float h = d.y;
        vec3 zen = vec3(0.004, 0.003, 0.022), mid = vec3(0.04, 0.011, 0.095), hor = vec3(0.26, 0.035, 0.2);
        vec3 col = mix(hor, mid, smoothstep(0.0, 0.2, h));
        col = mix(col, zen, smoothstep(0.18, 0.75, h));
        // resplandor de la ciudad (más cálido hacia el sol)
        float az = dot(normalize(vec3(d.x, 0.0, d.z) + 1e-5), normalize(vec3(uSun.x, 0.0, uSun.z)));
        col += mix(vec3(0.32, 0.03, 0.26), vec3(0.5, 0.12, 0.12), smoothstep(0.4, 1.0, az)) * 0.28 * exp(-max(h, 0.0) * 11.0);
        // nebulosa tenue
        float neb = vn(d.xz / (d.y + 0.35) * 2.2 + 3.0) * vn(d.xz / (d.y + 0.35) * 5.0);
        col += vec3(0.05, 0.02, 0.09) * neb * smoothstep(0.1, 0.5, h) * uStars;
        // estrellas
        if (h > 0.02) {
          vec2 sp = d.xz / (1.0 + d.y) * 260.0;
          vec2 id = floor(sp), f = fract(sp) - 0.5;
          float r = h21(id);
          if (r > 0.84) {
            vec2 o = vec2(h21(id + 7.1), h21(id + 13.7)) - 0.5;
            float dd = length(f - o * 0.6);
            float tw = 0.55 + 0.45 * sin(uTime * (1.0 + r * 3.0) + r * 40.0);
            float s = smoothstep(0.1, 0.0, dd) * tw * (r - 0.84) * 9.0;
            col += mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.75, 0.9), h21(id + 3.3)) * s * uStars * smoothstep(0.02, 0.25, h);
          }
        }
        // sol synthwave
        float sd = acos(clamp(dot(d, uSun), -1.0, 1.0));
        float R = 0.17;
        float sy = (h - uSun.y) / R;
        vec3 sc = mix(vec3(1.0, 0.1, 0.48), vec3(1.0, 0.82, 0.25), clamp(sy * 0.5 + 0.55, 0.0, 1.0));
        float cut = 0.0;
        if (sy < 0.3) { float band = fract(sy * 6.5 - uTime * 0.1); cut = step(band, (0.3 - sy) * 0.4); }
        float disc = smoothstep(R, R - 0.004, sd) * (1.0 - cut) * (1.0 - uCloud * 0.75);
        col = mix(col, sc * 1.12, disc);
        col += vec3(1.0, 0.2, 0.5) * 0.14 * exp(-sd * 5.0) * (1.0 - uCloud * 0.6);
        #ifdef CLOUDS
        // nubes estiradas iluminadas por la ciudad
        if (h > -0.01) {
          vec2 cp = d.xz / (d.y + 0.08);
          float t = uTime * (0.004 + uWind * 0.02);
          float n = vn(cp * vec2(0.9, 3.2) + vec2(t, 0.0)) * 0.62 + vn(cp * vec2(2.7, 8.0) + vec2(t * 1.7, 2.0)) * 0.38;
          float c = smoothstep(0.62 - uCloud * 0.4, 0.98, n) * smoothstep(0.0, 0.06, h) * (1.0 - smoothstep(0.3, 0.75, h));
          vec3 cc = mix(vec3(0.24, 0.05, 0.2), vec3(0.06, 0.03, 0.11), smoothstep(0.0, 0.3, h));
          col = mix(col, cc, c * (0.55 + uCloud * 0.4));
        }
        #endif
        // bruma en el horizonte = color de niebla
        col = mix(col, uFogColor, smoothstep(0.08, -0.01, h) * (0.6 + 0.4 * uCloud));
        if (h < 0.0) col = mix(col, uFogColor, smoothstep(0.0, -0.04, h));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, depthTest: true,
  });
  const sky = addMesh(new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), skyMat), -20);

  // --- suelo: rejilla synthwave cerca del circuito, calles con tráfico en la ciudad
  prof('sky');
  const maskRes = FAST.res;
  const mx0 = FAST.x0, mz0 = FAST.z0, msx = FAST.sx, msz = FAST.sz;
  const maskData = new Uint8Array(maskRes * maskRes * 4);
  for (let c = 0; c < maskRes * maskRes; c++) {
    const k = c * 4;
    maskData[k] = clamp(Math.round(FAST.D[c] + 40), 0, 255); maskData[k + 1] = FAST.IN[c] ? 255 : 0; maskData[k + 2] = 0; maskData[k + 3] = 255;
  }
  const maskTex = new THREE.DataTexture(maskData, maskRes, maskRes, THREE.RGBAFormat);
  maskTex.magFilter = THREE.LinearFilter; maskTex.minFilter = THREE.LinearFilter; maskTex.needsUpdate = true;
  textures.push(maskTex);
  const groundMat = new THREE.ShaderMaterial({
    uniforms: Object.assign(uni('uTime', 'uFogColor', 'uFogDensity', 'uWet'), { uMask: { value: maskTex }, uBox: { value: new THREE.Vector4(mx0, mz0, 1 / msx, 1 / msz) } }),
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: GL_COMMON + `varying vec3 vW; uniform sampler2D uMask; uniform vec4 uBox; uniform float uWet;
      float gridL(vec2 c, float w){ vec2 g = abs(fract(c - 0.5) - 0.5) / (fwidth(c) * w); return 1.0 - min(min(g.x, g.y), 1.0); }
      void main(){
        vec2 p = vW.xz;
        vec2 mu = (p - uBox.xy) * uBox.zw;
        float e = 215.0, ins = 0.0;
        if (mu.x > 0.0 && mu.x < 1.0 && mu.y > 0.0 && mu.y < 1.0) { vec4 mk = texture2D(uMask, mu); e = mk.r * 255.0 - 40.0; ins = mk.g; }
        float vD = distance(vW, cameraPosition);
        vec2 fw = fwidth(p);
        float far = smoothstep(0.6, 3.5, max(fw.x, fw.y));
        vec3 col = vec3(0.011, 0.009, 0.022);
        // rejilla synthwave (zona abierta junto al circuito)
        float fade = exp(-vD * 0.003);
        vec3 lc = mix(vec3(0.55, 0.08, 0.95), vec3(0.08, 0.6, 1.0), smoothstep(-500.0, 500.0, p.x + p.y * 0.5));
        float open = 1.0 - smoothstep(30.0, 60.0, e) * (1.0 - ins * 0.6);
        col += lc * (gridL(p / 10.0, 1.0) * 0.08 + gridL(p / 50.0, 1.6) * 0.36) * fade * (0.25 + 0.75 * open);
        // calles
        float city = smoothstep(18.0, 40.0, e);
        vec2 q = mod(p + 45.0, 90.0);
        float rz = 1.0 - smoothstep(14.0 - fw.y, 14.0 + fw.y, q.y);
        float rx = 1.0 - smoothstep(14.0 - fw.x, 14.0 + fw.x, q.x);
        float road = max(rx, rz) * city;
        col = mix(col, vec3(0.024, 0.021, 0.034), road);
        // aceras con línea de luz
        float kerb = (smoothstep(13.4, 14.0, q.y) - smoothstep(14.0, 14.6, q.y)) + (smoothstep(13.4, 14.0, q.x) - smoothstep(14.0, 14.6, q.x));
        col += vec3(0.05, 0.35, 0.5) * clamp(kerb, 0.0, 1.0) * city * (1.0 - far) * 0.5;
        // tráfico: faros blancos en un sentido, pilotos rojos en el otro
        if (city > 0.01) {
          float tr = 0.0; vec3 tc = vec3(0.0);
          // calles a lo largo de x
          {
            float lane = floor(q.y / 3.5), lp = fract(q.y / 3.5);
            float dir = lane < 2.0 ? 1.0 : -1.0;
            float id = floor((p.y + 45.0) / 90.0) + lane * 31.0;
            float u = p.x / 16.0 - dir * uTime * (0.9 + 0.5 * h11(id * 7.3)) + h11(id) * 30.0;
            float on = step(fract(u), 0.2) * step(0.45, h11(floor(u) + id * 17.0)) * smoothstep(0.42, 0.3, abs(lp - 0.5));
            tr += on * rz; tc += on * rz * (dir > 0.0 ? vec3(1.6, 1.3, 0.9) : vec3(1.8, 0.1, 0.08));
          }
          {
            float lane = floor(q.x / 3.5), lp = fract(q.x / 3.5);
            float dir = lane < 2.0 ? 1.0 : -1.0;
            float id = floor((p.x + 45.0) / 90.0) + lane * 53.0 + 500.0;
            float u = p.y / 16.0 - dir * uTime * (0.9 + 0.5 * h11(id * 7.3)) + h11(id) * 30.0;
            float on = step(fract(u), 0.2) * step(0.45, h11(floor(u) + id * 17.0)) * smoothstep(0.42, 0.3, abs(lp - 0.5));
            tr += on * rx; tc += on * rx * (dir > 0.0 ? vec3(1.6, 1.3, 0.9) : vec3(1.8, 0.1, 0.08));
          }
          col += mix(tc, vec3(0.5, 0.25, 0.2) * road * 0.12, far) * city;
        }
        // asfalto mojado: brillo especular difuso del cielo de neón
        vec3 V = normalize(cameraPosition - vW);
        float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 4.0);
        col += uWet * fres * (uFogColor * 1.8 + vec3(0.1, 0.02, 0.09));
        col = mix(col, uFogColor, fogF(vD, 1.0));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const ground = addMesh(new THREE.Mesh(new THREE.PlaneGeometry(7000, 7000, 64, 64).rotateX(-Math.PI / 2).translate(B.cx, -0.25, B.cz), groundMat), -5);

  prof('ground+mask');
  // --- skyline
  const skyMatB = new THREE.ShaderMaterial({
    uniforms: uni('uTime', 'uFogColor', 'uFogDensity'),
    vertexShader: GL_COMMON + `attribute vec4 aB; attribute vec3 aCol; attribute vec2 aTop;
      varying vec3 vW; varying vec3 vN; varying vec4 vB; varying vec3 vCol; varying vec2 vTop; varying float vD;
      void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normal; vB = aB; vCol = aCol; vTop = aTop; vec4 mv = viewMatrix * w; vD = length(mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: GL_COMMON + `varying vec3 vW; varying vec3 vN; varying vec4 vB; varying vec3 vCol; varying vec2 vTop; varying float vD;
      void main(){
        vec3 n = normalize(vN);
        float seed = vB.x, kind = vB.y;
        vec3 col = vec3(0.014, 0.011, 0.032) * (0.75 + 0.5 * seed);
        col += vec3(0.07, 0.015, 0.07) * exp(-vW.y * 0.025);         // rebote de luz de la calle
        col += vec3(0.02, 0.03, 0.06) * max(0.0, n.x * 0.5 + n.z * 0.3); // luz de luna lateral
        vec3 em = vec3(0.0);
        if (abs(n.y) < 0.5) {
          vec2 tg = normalize(vec2(-n.z, n.x));
          vec2 rel = vW.xz - vB.zw;
          float hc = vTop.y > 1.5 ? atan(rel.y, rel.x) * length(rel) : dot(rel, tg); // cilindros: coordenada angular
          if (kind < 2.5 || kind > 3.5) {
            float cwid = kind < 0.5 ? 3.2 : 2.6, chgt = kind < 0.5 ? 3.7 : 3.1;
            vec2 cell = vec2(hc / cwid, vW.y / chgt);
            vec2 id = floor(cell), f = fract(cell);
            float win = step(0.16, f.x) * step(f.x, 0.84) * step(0.24, f.y) * step(f.y, 0.82);
            float r = h21(id + seed * 91.7);
            float slow = h21(id * 1.37 + floor(uTime * 0.05 + r * 17.0) + seed);
            float lit = step(kind < 0.5 ? 0.42 : 0.5, r * 0.55 + slow * 0.45);
            vec3 wc = vCol * (0.5 + 0.9 * h21(id + 3.1));
            if (kind > 0.5 && kind < 1.5) wc *= vec3(1.15, 0.85, 0.6);
            float aa = clamp(1.0 - max(fwidth(cell.x), fwidth(cell.y)) * 1.2, 0.0, 1.0);
            em = mix(vCol * 0.26 * (kind < 0.5 ? 0.55 : 0.45), wc * win * lit, aa);
            if (kind > 1.5) {
              // fachada LED: bandas de color animadas
              float b = 0.5 + 0.5 * sin(vW.y * 0.09 - uTime * 1.3 + seed * 20.0 + hc * 0.02);
              vec3 lc = mix(vec3(1.0, 0.1, 0.65), vec3(0.1, 0.8, 1.0), b);
              float stripe = smoothstep(0.35, 0.5, fract(vW.y / 4.0)) * 0.6 + 0.4;
              em = em * 0.3 + lc * stripe * (0.45 + 0.55 * pow(b, 3.0)) * 0.9;
            }
          } else {
            // silueta lejana: puntos dispersos
            vec2 cell = vec2(hc / 5.0, vW.y / 6.0);
            vec2 id = floor(cell);
            float lit = step(0.8, h21(id + seed * 13.0));
            float aa = clamp(1.0 - max(fwidth(cell.x), fwidth(cell.y)) * 1.2, 0.0, 1.0);
            em = mix(vCol * 0.08, vCol * lit * 0.8, aa);
          }
          // corona iluminada
          float crown = smoothstep(vTop.x - 5.0, vTop.x - 4.0, vW.y) * (1.0 - smoothstep(vTop.x - 1.2, vTop.x - 0.6, vW.y));
          em += mix(vec3(1.0, 0.15, 0.7), vec3(0.15, 0.8, 1.0), step(0.5, fract(seed * 5.3))) * crown * step(0.35, fract(seed * 3.7)) * 0.9;
        } else if (n.y > 0.5) col = vec3(0.02, 0.016, 0.04);
        float f = fogF(vD, 0.52);
        vec3 c = mix(col, uFogColor, f) + em * (1.0 - f * 0.88);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  addMesh(SKY.build(skyMatB), 0);

  // --- estructuras iluminadas y vidrio
  const litMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.3, envMap: ENV, envMapIntensity: 0.4, side: THREE.DoubleSide });
  const litMesh = addMesh(LIT.build(litMat));
  if (litMesh && tier === 'high') litMesh.receiveShadow = true;
  const glassMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.08, metalness: 0.9, envMap: ENV, envMapIntensity: 1.5, side: THREE.DoubleSide });
  addMesh(GLASS.build(glassMat));

  // --- neones
  const emiMat = new THREE.ShaderMaterial({
    uniforms: uni('uTime', 'uFogColor', 'uFogDensity', 'uLights', 'uGo', 'uExcite'),
    vertexShader: GL_COMMON + `attribute vec3 color; attribute vec4 aAnim; uniform float uLights; uniform float uGo; uniform float uExcite;
      varying vec3 vCol; varying float vFog;
      void main(){
        vec3 c = color; float m = aAnim.x;
        if (m > 0.5 && m < 1.5) { float w = 0.5 + 0.5 * sin(aAnim.y - uTime * aAnim.z); c *= mix(1.0, 0.3 + 1.7 * pow(w, 8.0), aAnim.w); }
        else if (m > 1.5 && m < 2.5) { c *= 0.08 + step(0.88, fract(uTime * aAnim.z + aAnim.y)) * 1.4; }
        else if (m > 2.5 && m < 3.5) { c *= step(aAnim.y + 0.5, uLights) * 0.97 + 0.03; }
        else if (m > 3.5 && m < 4.5) { c *= 0.03 + uGo; }
        else if (m > 4.5 && m < 5.5) { c *= h11(floor(uTime * aAnim.z + aAnim.y)) > 0.12 ? 1.0 : 0.15; }
        else if (m > 5.5 && m < 6.5) { c = mix(c, c.brg, 0.5 + 0.5 * sin(uTime * aAnim.z + aAnim.y)); }
        else if (m > 7.5 && m < 8.5) { float w = 0.5 + 0.5 * sin(aAnim.y - uTime * aAnim.z * (0.6 + uExcite * 2.0)); c *= 0.45 + uExcite * 0.4 + pow(w, 6.0) * (0.3 + uExcite * 2.2); }
        vCol = c;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vFog = fogF(length(mv.xyz), 0.7);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: GL_COMMON + `varying vec3 vCol; varying float vFog;
      void main(){ gl_FragColor = vec4(vCol * (1.0 - vFog * 0.9) + uFogColor * vFog, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.DoubleSide,
  });
  emiMat.toneMapped = false;
  addMesh(EMI.build(emiMat));

  // --- vallas / letreros
  const billMat = new THREE.ShaderMaterial({
    uniforms: Object.assign(uni('uTime', 'uFogColor', 'uFogDensity'), { uAtlas: { value: atlas } }),
    vertexShader: GL_COMMON + `attribute vec4 aRect; attribute vec4 aRect2; attribute vec4 aAnim;
      varying vec2 vUv; varying vec4 vR; varying vec4 vR2; varying vec4 vA; varying float vFog;
      void main(){ vUv = uv; vR = aRect; vR2 = aRect2; vA = aAnim; vec4 mv = modelViewMatrix * vec4(position, 1.0); vFog = fogF(length(mv.xyz), 0.72); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: GL_COMMON + `uniform sampler2D uAtlas; varying vec2 vUv; varying vec4 vR; varying vec4 vR2; varying vec4 vA; varying float vFog;
      void main(){
        vec2 uv = vUv; float m = vA.x;
        if (m > 1.5 && m < 2.5) uv.x = fract(uv.x + uTime * vA.z + vA.y);
        vec3 c = texture2D(uAtlas, vR.xy + uv * vR.zw).rgb;
        if (m > 0.5 && m < 1.5) {
          float ph = fract(uTime * vA.z + vA.y);
          float k = smoothstep(0.47, 0.5, ph) * (1.0 - smoothstep(0.97, 1.0, ph));
          float gl = (1.0 - abs(k * 2.0 - 1.0));
          vec2 uv2 = uv; uv2.x = fract(uv2.x + gl * 0.08 * sin(uv.y * 40.0 + uTime * 30.0));
          vec3 b = texture2D(uAtlas, vR2.xy + uv2 * vR2.zw).rgb;
          vec3 a2 = texture2D(uAtlas, vR.xy + uv2 * vR.zw).rgb;
          c = mix(a2, b, k) + gl * vec3(0.15, 0.05, 0.2);
        }
        if (m > 2.5 && m < 3.5) { float f = h11(floor(uTime * vA.z + vA.y * 7.0)); c *= f > 0.1 ? 1.0 : 0.25; }
        // matriz de LED muy sutil
        c *= 0.88 + 0.12 * step(0.25, fract(vUv.y * 60.0));
        c *= vA.w;
        gl_FragColor = vec4(c * (1.0 - vFog * 0.92) + uFogColor * vFog, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.DoubleSide,
  });
  billMat.toneMapped = false;
  addMesh(BILL.build(billMat), 1);

  // --- pantalla gigante
  const jumboMat = new THREE.MeshBasicMaterial({ map: jumboTex, toneMapped: false, color: new THREE.Color(1.15, 1.15, 1.15) });
  addMesh(JUMBO.build(jumboMat), 1);

  // --- hologramas
  const holoMat = new THREE.ShaderMaterial({
    uniforms: Object.assign(uni('uTime', 'uFogColor', 'uFogDensity'), { uAtlas: { value: atlas } }),
    vertexShader: GL_COMMON + `attribute vec4 aRect; attribute vec3 aCenter; attribute vec4 aSpin; attribute vec3 color;
      varying vec2 vUv; varying vec4 vR; varying vec3 vCol; varying float vY; varying float vFog; varying float vPh;
      void main(){
        vec3 p = position - aCenter;
        float a = uTime * aSpin.x + aSpin.z, c = cos(a), s = sin(a);
        p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
        p.y += sin(uTime * 0.6 + aSpin.z) * aSpin.y;
        vec3 w = aCenter + p;
        vUv = uv; vR = aRect; vCol = color; vY = w.y; vPh = aSpin.z + aSpin.w * 10.0;
        vec4 mv = viewMatrix * modelMatrix * vec4(w, 1.0);
        vFog = fogF(length(mv.xyz), 0.6);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: GL_COMMON + `uniform sampler2D uAtlas; varying vec2 vUv; varying vec4 vR; varying vec3 vCol; varying float vY; varying float vFog; varying float vPh;
      void main(){
        vec2 uv = fract(vUv);
        vec3 t = texture2D(uAtlas, vR.xy + uv * vR.zw).rgb;
        float scan = 0.6 + 0.4 * sin(vY * 4.0 - uTime * 6.0);
        float gl = step(0.95, h11(floor(uTime * 9.0) + vPh * 13.0));
        float fl = (1.0 - gl * 0.75) * (0.9 + 0.1 * sin(uTime * 37.0 + vPh));
        vec3 c = vCol * t * scan * fl * 1.4 + vCol * 0.02;
        gl_FragColor = vec4(c * (1.0 - vFog), 1.0);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true,
  });
  holoMat.toneMapped = false;
  addMesh(HOLO.build(holoMat), 8);

  // --- charcos de luz (aditivo)
  const poolMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, fog: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  addMesh(POOL.build(poolMat), 4);

  // --- reflectores y láseres
  const beamMat = new THREE.ShaderMaterial({
    uniforms: uni('uTime', 'uFogColor', 'uFogDensity', 'uBeam'),
    vertexShader: GL_COMMON + `attribute vec3 color; attribute vec3 aBase; attribute vec4 aB; attribute vec4 aB2; uniform float uBeam;
      varying vec3 vCol; varying float vT; varying vec3 vN; varying vec3 vV; varying float vFog;
      mat3 rotY(float a){ float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
      mat3 rotX(float a){ float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
      void main(){
        float yaw = aB2.x > 0.0 ? aB.x + sin(uTime * aB.y + aB.z * 3.0) * aB2.x : aB.x + uTime * aB.y;
        float tilt = aB.z + aB.w * sin(uTime * aB2.y * 0.7 + aB.x * 2.0);
        mat3 R = rotY(yaw) * rotX(tilt);
        vec3 p = aBase + R * position;
        vN = normalize(R * normal);
        vec4 w = modelMatrix * vec4(p, 1.0);
        vV = normalize(cameraPosition - w.xyz);
        vT = uv.y; vCol = color * uBeam;
        vec4 mv = viewMatrix * w;
        vFog = fogF(length(mv.xyz), 0.5);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: GL_COMMON + `varying vec3 vCol; varying float vT; varying vec3 vN; varying vec3 vV; varying float vFog;
      void main(){
        float edge = abs(dot(normalize(vN), normalize(vV)));
        float a = pow(edge, 2.2) * pow(1.0 - vT, 1.6) * smoothstep(0.0, 0.02, vT);
        gl_FragColor = vec4(vCol * a * (1.0 - vFog * 0.6), 1.0);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true,
  });
  beamMat.toneMapped = false;
  addMesh(BEAM.build(beamMat), 9);

  prof('merge');
  // --- público (billboards instanciados, 2 triángulos por espectador)
  let crowdMesh = null;
  {
    while (CROWD.length > Q.maxCrowd) CROWD.splice(Math.floor(rng() * CROWD.length), 1);
    const n = CROWD.length;
    stats.crowd = n;
    if (n) {
      const g = new THREE.InstancedBufferGeometry();
      const base = new THREE.PlaneGeometry(1, 1);
      g.index = base.index; g.setAttribute('position', base.attributes.position); g.setAttribute('uv', base.attributes.uv);
      const aPos = new Float32Array(n * 3), aInfo = new Float32Array(n * 4), aColor = new Float32Array(n * 3);
      const shirt = ['#1b1d2a', '#23263a', '#2e2a3f', '#3a3f6e', '#4b3a7a', '#5a2236', '#1f4f6b', '#6b6f80', '#c0c0d8', '#30343c', '#ff2fb3', '#22e4ff', '#ffcc33', '#8b5cff', '#ff6a3d', '#2bff88'];
      CROWD.forEach((c, i) => {
        aPos.set([c.x, c.y, c.z], i * 3);
        aInfo.set([c.seed, c.wave, c.light, c.glow], i * 4);
        const si = rng() < 0.72 ? Math.floor(rng() * 10) : 10 + Math.floor(rng() * 6);
        const cc = lin(shirt[si], si < 10 ? rand(0.8, 1.25) : rand(0.6, 0.9));
        aColor.set(cc, i * 3);
      });
      g.setAttribute('aPos', new THREE.InstancedBufferAttribute(aPos, 3));
      g.setAttribute('aInfo', new THREE.InstancedBufferAttribute(aInfo, 4));
      g.setAttribute('aColor', new THREE.InstancedBufferAttribute(aColor, 3));
      g.instanceCount = n;
      const mat = new THREE.ShaderMaterial({
        uniforms: Object.assign(uni('uTime', 'uFogColor', 'uFogDensity', 'uExcite', 'uWave'), { uTex: { value: crowdTex } }),
        vertexShader: GL_COMMON + `attribute vec3 aPos; attribute vec4 aInfo; attribute vec3 aColor; uniform float uExcite; uniform float uWave;
          varying vec2 vUv; varying vec3 vCol; varying float vGlow; varying float vFog; varying float vLight; varying float vSkin;
          void main(){
            float seed = aInfo.x;
            float ex = uExcite;
            float wv = uWave * smoothstep(0.7, 1.0, sin(aInfo.y * 0.055 - uTime * 2.4));
            float sp = 5.0 + seed * 5.0;
            float hop = max(0.0, sin(uTime * sp + seed * 40.0));
            float jump = hop * hop * smoothstep(0.35, 0.9, ex) * (0.12 + seed * 0.22) + wv * 0.32;
            float act = clamp((ex - 0.1) * 1.3 + wv, 0.0, 1.0);
            float slot = floor(uTime * (0.7 + seed * 1.6) + seed * 9.0);
            float r = h11(slot + seed * 113.0);
            float pose = 0.0;
            if (r < act) pose = 1.0 + floor(h11(slot * 1.7 + seed * 57.0) * 2.999);
            else if (r > 0.985) pose = 1.0;
            if (wv > 0.3) pose = 2.0;
            float body = step(0.5, fract(seed * 7.13));
            vUv = (vec2(pose, 1.0 - body) + uv) / vec2(4.0, 2.0);
            vec3 cd = cameraPosition - aPos; cd.y = 0.0;
            vec3 right = normalize(vec3(cd.z, 0.0, -cd.x) + 1e-5);
            float sc = 0.92 + seed * 0.22;
            vec3 wp = aPos + right * position.x * 0.62 * sc + vec3(0.0, (position.y + 0.5) * 1.24 * sc + jump - 0.12, 0.0);
            vec4 mv = viewMatrix * vec4(wp, 1.0);
            vCol = aColor; vLight = aInfo.z; vSkin = fract(seed * 3.31);
            float tw = step(0.5, sin(uTime * (3.0 + seed * 5.0) + seed * 30.0));
            float flash = step(0.9965 - ex * 0.006, h11(floor(uTime * 7.0) + seed * 997.0));
            vGlow = aInfo.w * (0.25 + 0.75 * tw) * (0.3 + ex * 1.4) + flash * 6.0;
            vFog = fogF(length(mv.xyz), 0.8);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: GL_COMMON + `uniform sampler2D uTex; varying vec2 vUv; varying vec3 vCol; varying float vGlow; varying float vFog; varying float vLight; varying float vSkin;
          void main(){
            vec4 t = texture2D(uTex, vUv);
            if (t.a < 0.45) discard;
            vec3 skin = mix(vec3(0.22, 0.13, 0.09), vec3(0.75, 0.52, 0.4), vSkin);
            vec3 c = (vCol * t.r + skin * t.g) * vLight * 0.9;
            c += mix(vec3(1.0, 0.3, 0.8), vec3(0.3, 0.9, 1.0), vSkin) * t.b * vGlow;
            gl_FragColor = vec4(mix(c, uFogColor, vFog), 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      });
      crowdMesh = new THREE.Mesh(g, mat);
      crowdMesh.frustumCulled = false;
      addMesh(crowdMesh, 2);
    }
  }

  // --- palmeras (instanciadas, balanceo con el viento)
  let palmMesh = null;
  if (PALMS.length) {
    const parts = [];
    const trunk = new THREE.CylinderGeometry(0.2, 0.4, 9, 5, 3, true).translate(0, 4.5, 0);
    { const p = trunk.attributes.position; for (let i = 0; i < p.count; i++) { const y = p.getY(i); p.setX(i, p.getX(i) + Math.pow(y / 9, 2) * 1.1); } }
    trunk.deleteAttribute('uv'); paintG(trunk, lin('#3a2433', 1));
    parts.push(trunk);
    for (let k = 0; k < 7; k++) {
      const lg = new THREE.ConeGeometry(0.62, 4.6, 3, 2, true).rotateZ(-Math.PI / 2).translate(2.3, 0, 0);
      const p = lg.attributes.position; for (let i = 0; i < p.count; i++) { const xx = p.getX(i); p.setY(i, p.getY(i) * 0.22 - Math.pow(xx / 4.6, 2) * 1.9); }
      lg.rotateY((k / 7) * TAU + (k % 2) * 0.2).translate(1.1, 9, 0);
      lg.deleteAttribute('uv'); paintG(lg, lin(k % 2 ? '#1d6a5c' : '#17584f', 1));
      parts.push(lg);
    }
    const pg = mergeGeometries(parts.map((g) => g.toNonIndexed()));
    parts.forEach((g) => g.dispose());
    pg.computeVertexNormals();
    const pm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.05, emissive: 0x0a1418, envMap: ENV, envMapIntensity: 0.5, side: THREE.DoubleSide });
    pm.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = U.uTime; sh.uniforms.uWind = U.uWind;
      sh.vertexShader = 'uniform float uTime; uniform float uWind;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        float ph = float(gl_InstanceID) * 1.37;
        float sway = (sin(uTime * (0.8 + uWind * 1.6) + ph) * 0.5 + sin(uTime * 2.3 + ph * 2.0) * 0.15) * (0.25 + uWind * 1.4);
        float hf = max(0.0, transformed.y - 3.0) / 8.0;
        transformed.x += sway * hf * hf * 1.2;
        transformed.z += sway * hf * hf * 0.5;`);
    };
    palmMesh = new THREE.InstancedMesh(pg, pm, PALMS.length);
    PALMS.forEach((p, i) => {
      _eu.set(0, p.rot, 0); _q.setFromEuler(_eu);
      _m4.compose(_p.set(p.x, p.y, p.z), _q, _sc.set(p.sc, p.sc, p.sc));
      palmMesh.setMatrixAt(i, _m4);
      if (p.glow) glowAt(p.x, 0.7, p.z, 6, i % 2 ? [1.2, 0.15, 0.9] : [0.15, 1.0, 1.2]);
    });
    palmMesh.frustumCulled = false;
    addMesh(palmMesh);
  }
  function paintG(g, c) { const n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) a.set(c, i * 3); g.setAttribute('color', new THREE.BufferAttribute(a, 3)); }

  // --- tráfico aéreo (en el shader de halos)
  {
    const nC = Q.traffic;
    for (let i = 0; i < nC; i++) {
      const lane = Math.floor(rng() * 7);
      const rx = 560 + lane * 120 + rand(-20, 20), rz = rx * rand(0.75, 0.95);
      const hgt = 70 + lane * 26 + rand(-6, 6);
      const dir = lane % 2 ? 1 : -1;
      const w = (dir * rand(26, 42)) / rx; // rad/s
      const ph = rng() * TAU;
      const front = [1.6, 1.5, 1.3], back = [1.8, 0.12, 0.1];
      glowAt(B.cx, hgt, B.cz, 3.2, front, { minPx: 1.6, move: [rx, rz, w, ph] });
      glowAt(B.cx, hgt, B.cz, 2.6, back, { minPx: 1.3, move: [rx, rz, w, ph - dir * 5 / rx] });
    }
    stats.traffic = nC;
  }

  // --- halos (Points)
  let glowPts = null;
  {
    const n = GLOWS.length;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3), colA = new Float32Array(n * 3), size = new Float32Array(n), blink = new Float32Array(n * 4), move = new Float32Array(n * 4);
    GLOWS.forEach((q, i) => {
      pos.set([q.x, q.y, q.z], i * 3); colA.set(q.c, i * 3); size[i] = q.size;
      blink.set([q.blink, q.phase, q.minPx, 0], i * 4);
      if (q.move) move.set(q.move, i * 4);
    });
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(colA, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aBlink', new THREE.BufferAttribute(blink, 4));
    g.setAttribute('aMove', new THREE.BufferAttribute(move, 4));
    const mat = new THREE.ShaderMaterial({
      uniforms: uni('uTime', 'uFogColor', 'uFogDensity', 'uScale', 'uLights', 'uGo'),
      vertexShader: GL_COMMON + `attribute float aSize; attribute vec3 aColor; attribute vec4 aBlink; attribute vec4 aMove; uniform float uScale; uniform float uLights; uniform float uGo;
        varying vec3 vColor;
        void main(){
          vec3 p = position;
          if (aMove.x != 0.0) { float a = aMove.w + uTime * aMove.z; p.x += cos(a) * aMove.x; p.z += sin(a) * aMove.y; p.y += sin(a * 3.0 + aMove.x) * 4.0; }
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float d = -mv.z;
          float b = 1.0;
          if (aBlink.x > 0.0) b = pow(0.5 + 0.5 * sin(uTime * aBlink.x + aBlink.y), 6.0);
          else if (aBlink.x < -0.5 && aBlink.x > -9.5) b = step(-aBlink.x - 0.5, uLights);
          else if (aBlink.x < -9.5) b = uGo;
          float fog = 1.0 - fogF(d, 0.55);
          vColor = aColor * b * fog;
          gl_PointSize = b < 0.002 ? 0.0 : clamp(aSize * uScale / max(d, 0.5), aBlink.z, 260.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying vec3 vColor;
        void main(){
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = max(0.0, 1.0 - d); a = a * a * (0.6 + 0.4 * a);
          float core = smoothstep(0.25, 0.0, d);
          gl_FragColor = vec4(vColor * (a + core * 1.4), 1.0);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    mat.toneMapped = false;
    glowPts = new THREE.Points(g, mat);
    glowPts.frustumCulled = false;
    addMesh(glowPts, 10);
  }

  // --- dirigible
  let blimp = null;
  const BLIMP = { rx: B.rx + 90, rz: B.rz + 80, h: 165, w: 7 / Math.max(B.rx + 90, 1) };
  if (Q.blimp) {
    const alb = canvasTex(512, 256), emi = canvasTex(512, 256);
    {
      const a = alb.userData.ctx, e = emi.userData.ctx;
      const g = a.createLinearGradient(0, 0, 0, 256); g.addColorStop(0, '#2b2840'); g.addColorStop(0.5, '#5a5878'); g.addColorStop(1, '#2b2840');
      a.fillStyle = g; a.fillRect(0, 0, 512, 256);
      e.fillStyle = '#000'; e.fillRect(0, 0, 512, 256);
      // bandas de color y pantallas a ambos lados (u ≈ 0.25 y 0.75)
      [0, 1].forEach((k) => {
        const cx = 128 + k * 256;
        a.fillStyle = '#ff2fb3'; a.fillRect(cx - 120, 30, 240, 8); a.fillRect(cx - 120, 218, 240, 8);
        e.fillStyle = '#ff2fb3'; e.fillRect(cx - 120, 30, 240, 8); e.fillRect(cx - 120, 218, 240, 8);
        e.save(); e.translate(cx, 128); e.rotate(k ? -Math.PI / 2 : Math.PI / 2);
        e.fillStyle = '#12061e'; e.fillRect(-90, -48, 180, 96);
        e.font = FONT(30); e.textAlign = 'center'; e.textBaseline = 'middle';
        e.shadowColor = '#22e4ff'; e.shadowBlur = 10; e.fillStyle = '#bff8ff'; e.fillText('NEÓN CITY', 0, -14, 170);
        e.font = FONT_B(20); e.shadowBlur = 0; e.fillStyle = '#ffcc33'; e.fillText('GRAN PREMIO', 0, 22, 170);
        e.restore();
      });
      // luces de navegación
      e.fillStyle = '#ff2030'; e.fillRect(0, 0, 512, 3);
      alb.needsUpdate = true; emi.needsUpdate = true;
    }
    const body = new THREE.SphereGeometry(1, 40, 20); body.rotateX(Math.PI / 2); body.scale(7.5, 7.5, 26);
    const parts = [body];
    const fin = (rx, ry, rz) => { const f = new THREE.BoxGeometry(0.4, 7, 6); f.translate(0, 5.5, 0); applyXf(f, { rz, x: 0, z: -21 }); return f; };
    for (let k = 0; k < 4; k++) parts.push(fin(0, 0, (k / 4) * TAU + Math.PI / 4));
    const gond = new THREE.BoxGeometry(2.6, 2, 8); gond.translate(0, -8, 2); parts.push(gond);
    parts.forEach((p, i) => { if (i > 0) { const uv = p.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setXY(k, 0.02, 0.5); } });
    const bg = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
    parts.forEach((g) => g.dispose());
    bg.computeVertexNormals();
    blimp = new THREE.Mesh(bg, new THREE.MeshStandardMaterial({ map: alb, emissiveMap: emi, emissive: new THREE.Color(1.6, 1.6, 1.6), roughness: 0.45, metalness: 0.35, envMap: ENV, envMapIntensity: 0.8 }));
    blimp.frustumCulled = false;
    addMesh(blimp);
  }

  // --- fuegos artificiales propios (Points animados en GPU; la CPU sólo escribe al lanzar)
  const FW = { n: tier === 'low' ? 5 : 8, p: tier === 'low' ? 70 : tier === 'med' ? 100 : 140, next: 0, until: -1, mesh: null, queue: [] };
  {
    const N = FW.n * FW.p;
    const dir = new Float32Array(N * 3), burst = new Float32Array(N * 4), colF = new Float32Array(N * 3), seedA = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      // dirección aleatoria en la esfera, con velocidad algo variable (esfera «llena»)
      const u = rng() * 2 - 1, th = rng() * TAU, r = Math.sqrt(1 - u * u), sp = 0.75 + 0.25 * rng();
      dir.set([r * Math.cos(th) * sp, u * sp, r * Math.sin(th) * sp], i * 3);
      burst.set([0, -1000, 0, -100], i * 4);
      seedA[i] = rng();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(dir, 3));
    g.setAttribute('aBurst', new THREE.BufferAttribute(burst, 4));
    g.setAttribute('aCol', new THREE.BufferAttribute(colF, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seedA, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: uni('uTime', 'uFogColor', 'uFogDensity', 'uScale'),
      vertexShader: GL_COMMON + `attribute vec4 aBurst; attribute vec3 aCol; attribute float aSeed; uniform float uScale; varying vec3 vC;
        void main(){
          float t = uTime - aBurst.w;
          float life = 2.4 + aSeed * 0.8;
          if (t < 0.0 || t > life) { gl_PointSize = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vC = vec3(0.0); return; }
          float k = 1.6;
          vec3 p = aBurst.xyz + position * 36.0 * (1.0 - exp(-k * t)) / k;
          p.y -= 4.5 * t * t;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float d = -mv.z;
          float f = 1.0 - t / life;
          float tw = 0.65 + 0.35 * sin(uTime * 30.0 + aSeed * 60.0);
          vC = (aCol * f * f * tw + vec3(3.0) * smoothstep(0.18, 0.0, t)) * (1.0 - fogF(d, 0.45));
          gl_PointSize = clamp((1.7 + smoothstep(0.2, 0.0, t) * 4.0) * uScale / max(d, 1.0), 2.0, 72.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying vec3 vC;
        void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = max(0.0, 1.0 - d); a *= a; gl_FragColor = vec4(vC * (a + smoothstep(0.3, 0.0, d)), 1.0);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    mat.toneMapped = false;
    FW.mesh = new THREE.Points(g, mat);
    FW.mesh.frustumCulled = false;
    FW.mesh.visible = false;
    addMesh(FW.mesh, 12);
  }
  const FW_PAL = [[lin(NEON.pink, 3), lin('#ffffff', 2)], [lin(NEON.cyan, 3), lin('#ffffff', 2)], [lin(NEON.gold, 3), lin(NEON.orange, 3)], [lin(NEON.green, 3), lin('#ffffff', 2)], [lin(NEON.violet, 3.2), lin(NEON.pink, 3)]];
  function launchBurst(x, y, z, delay = 0) {
    const b = FW.next; FW.next = (FW.next + 1) % FW.n;
    const g = FW.mesh.geometry, A = g.attributes.aBurst, C = g.attributes.aCol;
    const t0 = U.uTime.value + delay, pal = FW_PAL[Math.floor(Math.random() * FW_PAL.length)];
    for (let i = b * FW.p; i < (b + 1) * FW.p; i++) {
      A.array.set([x, y, z, t0], i * 4);
      C.array.set(pal[Math.random() < 0.7 ? 0 : 1], i * 3);
    }
    A.needsUpdate = true; C.needsUpdate = true;
    FW.mesh.visible = true;
    FW.until = Math.max(FW.until, t0 + 3.4);
  }

  // --- lluvia (sólo 'humedo')
  let rainMesh = null;
  if (rainOpt !== false) {
    const n = Q.rainN;
    const pos = new Float32Array(n * 6), end = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const x = rng(), y = rng(), z = rng();
      pos.set([x, y, z, x, y, z], i * 6); end[i * 2] = 0; end[i * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: uni('uTime', 'uFogColor', 'uFogDensity', 'uCam', 'uWind', 'uRain'),
      vertexShader: GL_COMMON + `attribute float aEnd; uniform vec3 uCam; uniform float uWind; uniform float uRain; varying float vA;
        void main(){
          vec3 box = vec3(64.0, 30.0, 64.0);
          vec3 w;
          w.x = uCam.x + mod(position.x * box.x - uCam.x, box.x) - box.x * 0.5;
          w.z = uCam.z + mod(position.z * box.z - uCam.z, box.z) - box.z * 0.5;
          w.y = uCam.y + mod(position.y * box.y - uTime * 26.0 - uCam.y, box.y) - box.y * 0.45;
          vec3 v = vec3(uWind * 6.0, -26.0, uWind * 2.0);
          w -= v * 0.035 * aEnd;
          vec4 mv = viewMatrix * vec4(w, 1.0);
          float d = length(mv.xyz);
          vA = uRain * (1.0 - smoothstep(8.0, 34.0, d)) * (0.5 + 0.5 * aEnd);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying float vA; void main(){ gl_FragColor = vec4(vec3(0.62, 0.7, 1.0) * vA * 0.5, 1.0);
        #include <colorspace_fragment>
      }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    mat.toneMapped = false;
    rainMesh = new THREE.LineSegments(g, mat);
    rainMesh.frustumCulled = false;
    rainMesh.visible = false;
    addMesh(rainMesh, 11);
  }

  if (scene) scene.add(group);

  /* =========================================================================
     CÁMARAS DE TV (validadas contra los ocluyentes)
     ========================================================================= */
  prof('crowd..rain');
  function segHitsBox(p, q, b) {
    let t0 = 0, t1 = 1;
    for (let a = 0; a < 3; a++) {
      const o = p[a], d = q[a] - o, mn = b[a], mx = b[a + 3];
      if (Math.abs(d) < 1e-9) { if (o < mn || o > mx) return false; continue; }
      let ta = (mn - o) / d, tb = (mx - o) / d; if (ta > tb) { const t = ta; ta = tb; tb = t; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); if (t0 > t1) return false;
    }
    return true;
  }
  const tvCams = [];
  {
    const cand = [];
    const nC = 48; // candidatas cada ~L/48 m
    for (let k = 0; k < nC; k++) {
      const s = 25 + (k * TK.L) / nC;
      TK.at(s, o2);
      const pref = Math.abs(o2.k) > 1 / 300 ? -Math.sign(o2.k) : (k % 2 ? 1 : -1);
      for (const side of [pref, -pref]) {
        let done = false;
        for (const ex of [4, 7, 10]) {
          const lat = clearLat(s, side, ex);
          const x = o2.x + o2.nx * lat, z = o2.z + o2.nz * lat;
          if (TK.margin(x, z) < 0.5 || !ogFree(x, z, 2)) continue;
          const y = o2.y + 6 + (k % 4) * 2.3;
          const P = [x, y, z];
          if (OCC.some((b) => x > b[0] - 1.5 && x < b[3] + 1.5 && y > b[1] - 1.5 && y < b[4] + 1.5 && z > b[2] - 1.5 && z < b[5] + 1.5)) continue;
          // ventana de visión continua alrededor de s (sólo ocluyentes cercanos)
          const near = OCC.filter((b) => Math.max(b[0] - x, x - b[3], 0) < 230 && Math.max(b[2] - z, z - b[5], 0) < 230);
          let w0 = null, w1 = null;
          for (let q = s - 200; q <= s + 90; q += 6) {
            TK.at(q, o3);
            const tp = [o3.x, o3.y + 1, o3.z];
            const d = Math.hypot(tp[0] - x, tp[1] - y, tp[2] - z);
            let ok = d > 12 && d < 210;
            if (ok) for (const b of near) if (segHitsBox(P, tp, b)) { ok = false; break; }
            if (ok) { if (w0 === null) w0 = q; w1 = q; } else if (w0 !== null && q < s) { w0 = null; w1 = null; } else if (w0 !== null) break;
          }
          if (w0 !== null && w1 - w0 >= 70 && w1 > s - 20) { cand.push({ x, y, z, s: TK.wrap(s), w0, w1, score: w1 - w0 }); done = true; break; }
        }
        if (done) break;
      }
    }
    // reparto uniforme: como mucho 18, separadas ≥ 60 m de recorrido (≥ 38 m si faltan para llegar a 12)
    cand.sort((a, b) => b.score - a.score);
    for (const gap of [60, 38]) for (const c of cand) {
      if (tvCams.length >= (gap === 60 ? 18 : 12)) break;
      if (tvCams.includes(c) || tvCams.some((t) => Math.abs(TK.dS(t.s, c.s)) < gap)) continue;
      tvCams.push(c);
    }
    tvCams.sort((a, b) => a.s - b.s);
    tvCams.forEach((c) => { delete c.score; });
  }

  /* =========================================================================
     API
     ========================================================================= */
  const sunDir = new THREE.Vector3(-60, 120, 40).normalize();
  const env = {
    background: fog.color.clone(),
    fog,
    exposure: 1.05,
    bloom: { strength: 0.62, radius: 0.38, threshold: 0.88 },
    envMap: ENV,
    ambient: { hemi: { sky: 0x5b4bb0, ground: 0x1a0b28, intensity: 0.85 }, sun: { color: 0xa8b8ff, intensity: 0.8, dir: [sunDir.x, sunDir.y, sunDir.z] } },
  };
  let goT = 0;
  const gantry = {
    set(n) {
      if (n < 0) { U.uLights.value = 0; U.uGo.value = 1; goT = 3.5; }
      else { U.uLights.value = clamp(n | 0, 0, 5); U.uGo.value = 0; goT = 0; }
    },
    pos: GANTRY ? (() => { TK.at(GANTRY.s, o2); return { x: o2.x, y: o2.y + GANTRY.H, z: o2.z }; })() : null,
  };
  const jumbo = JUMBOS.length ? { draw: drawJumbo, screens: JUMBOS.map((j) => ({ x: j.x, y: j.y, z: j.z, w: j.w, h: j.h })) } : null;
  let exciteTarget = 0.12, exciteCur = 0.12, waveT = 0;
  const crowd = { excite(level) { exciteTarget = clamp(+level || 0, 0, 1); }, count: stats.crowd };
  const W_CFG = {
    seco: { col: [0.07, 0.03, 0.125], dens: 0.00112, cloud: 0.22, stars: 1, wet: 0, rain: 0, wind: 0.25, beam: 1 },
    humedo: { col: [0.085, 0.05, 0.14], dens: 0.0016, cloud: 0.9, stars: 0.12, wet: 1, rain: 1, wind: 0.45, beam: 1.7 },
    viento: { col: [0.07, 0.032, 0.12], dens: 0.00098, cloud: 0.5, stars: 0.75, wet: 0, rain: 0, wind: 1, beam: 1 },
  };
  let weather = 'seco';
  function setWeather(w) {
    weather = W_CFG[w] ? w : 'seco';
    const c = W_CFG[weather];
    fog.color.setRGB(c.col[0], c.col[1], c.col[2]);
    fog.density = c.dens;
    env.background.copy(fog.color);
    if (scene && scene.background && scene.background.isColor && scene.fog === fog) scene.background.copy(fog.color);
    U.uCloud.value = c.cloud; U.uStars.value = c.stars; U.uWet.value = c.wet; U.uWind.value = c.wind; U.uBeam.value = c.beam;
    U.uRain.value = c.rain;
    if (rainMesh) rainMesh.visible = c.rain > 0;
  }
  setWeather('seco');

  const _dbs = new THREE.Vector2();
  let tAcc = 0;
  function update(dt = 0.016, t, camera) {
    dt = Math.min(0.1, Math.max(0, dt || 0));
    tAcc = typeof t === 'number' ? t : tAcc + dt;
    U.uTime.value = tAcc;
    const f = scene && scene.fog ? scene.fog : fog;
    U.uFogColor.value.copy(f.color); U.uFogDensity.value = f.density != null ? f.density : fog.density;
    if (camera) {
      sky.position.copy(camera.position);
      U.uCam.value.copy(camera.position);
      if (renderer) { renderer.getDrawingBufferSize(_dbs); U.uScale.value = _dbs.y / (2 * Math.tan((camera.fov * Math.PI) / 360)); }
    }
    // público
    exciteCur += (exciteTarget - exciteCur) * (1 - Math.exp(-dt * (exciteTarget > exciteCur ? 6 : 1.2)));
    U.uExcite.value = exciteCur;
    waveT += dt;
    const wavePhase = (waveT % 46) / 46; // ola cada ~46 s mientras hay ambiente
    const waveOn = exciteCur > 0.18 && exciteCur < 0.75 ? smoothstep(0, 0.08, wavePhase) * (1 - smoothstep(0.3, 0.38, wavePhase)) : 0;
    U.uWave.value += (waveOn - U.uWave.value) * (1 - Math.exp(-dt * 2));
    // luz verde: se apaga sola
    if (goT > 0) { goT -= dt; if (goT <= 0) U.uGo.value = 0; else if (goT < 1) U.uGo.value = goT; }
    while (FW.queue.length) { const q = FW.queue.shift(); launchBurst(q[0], q[1], q[2], q[3]); }
    if (FW.mesh.visible && tAcc > FW.until) FW.mesh.visible = false;
    // dirigible
    if (blimp) {
      const a = tAcc * BLIMP.w + 1.2;
      const x = B.cx + Math.cos(a) * BLIMP.rx, z = B.cz + Math.sin(a) * BLIMP.rz;
      const tx = -Math.sin(a) * BLIMP.rx, tz = Math.cos(a) * BLIMP.rz;
      blimp.position.set(x, BLIMP.h + Math.sin(tAcc * 0.3) * 2, z);
      blimp.rotation.set(Math.sin(tAcc * 0.4) * 0.02, Math.atan2(tx, tz), Math.sin(tAcc * 0.27) * 0.03);
    }
  }
  function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

  // fuegos artificiales: puntos de lanzamiento (sobre la tribuna principal, el dosel y tras el podio)
  const fwSpots = [];
  {
    const st = STANDS.find((x) => x.name === 'main') || STANDS[0];
    if (st) [0.15, 0.4, 0.65, 0.9].forEach((f) => { const s = lerp(st.sA, st.sB, f); TK.at(s, o2); const lat = st.side * (st.latEnd + 14); fwSpots.push({ x: o2.x + o2.nx * lat, y: 82, z: o2.z + o2.nz * lat }); });
    if (PITB) [0.3, 0.7].forEach((f) => { const s = lerp(PITB.s0, PITB.s1, f); TK.at(s, o2); const lat = PITB.side * (PITB.latB + 30); fwSpots.push({ x: o2.x + o2.nx * lat, y: 72, z: o2.z + o2.nz * lat }); });
    if (PODIUM) fwSpots.push({ x: PODIUM.x - PODIUM.front[0] * 45, y: 55, z: PODIUM.z - PODIUM.front[1] * 45 });
  }
  const fwC = fwSpots.reduce((a, p) => { a.x += p.x / fwSpots.length; a.y += p.y / fwSpots.length; a.z += p.z / fwSpots.length; return a; }, { x: 0, y: 0, z: 0 });
  const fireworks = {
    x: fwC.x, y: fwC.y, z: fwC.z, spots: fwSpots,
    /** Lanza n cohetes (escalonados ~0,3 s) en los puntos sugeridos o alrededor de at = {x,y,z}. */
    launch(n = 1, at = null) {
      for (let k = 0; k < Math.max(1, n | 0); k++) {
        const p = at || fwSpots[Math.floor(Math.random() * fwSpots.length)] || fwC;
        // se encola: update() lo escribe con el reloj del escenario ya al día
        FW.queue.push([p.x + (Math.random() - 0.5) * 50, p.y + (Math.random() - 0.5) * 18, p.z + (Math.random() - 0.5) * 50, k * 0.28 + Math.random() * 0.12]);
      }
    },
  };
  // puntos de interés para planos bonitos
  const landmarks = {};
  {
    const put = (k, x, y, z) => { landmarks[k] = { x, y, z }; };
    if (GANTRY) { TK.at(GANTRY.s, o2); put('portico', o2.x, o2.y + GANTRY.H, o2.z); }
    if (CANOPY_S.length) { TK.at(CANOPY_S[Math.floor(CANOPY_S.length / 2)], o2); put('dosel', o2.x, o2.y + 38, o2.z); }
    if (JUMBOS[0]) put('pantalla', JUMBOS[0].x, JUMBOS[0].y, JUMBOS[0].z);
    if (PITB) put('torreControl', PITB.tower.x, PITB.tower.y + 40, PITB.tower.z);
    if (PODIUM) put('podio', PODIUM.x, PODIUM.y + 2, PODIUM.z);
    STANDS.forEach((st) => { if (st.name === 'main2') return; TK.at((st.sA + st.sB) / 2, o2); const lat = st.side * (st.lat0 + st.latEnd) / 2; put('tribuna:' + (st.name === 'main' ? 'principal' : st.name), o2.x + o2.nx * lat, o2.y + st.topH, o2.z + o2.nz * lat); });
    lmOf('bridge').filter((l) => !l.cross).forEach((l) => { TK.at((l.s0 + l.s1) / 2, o2); put('pasarela', o2.x, o2.y + 10, o2.z); });
    if (TOWERS[0]) put('rascacielos', TOWERS[0].x, TOWERS[0].h, TOWERS[0].z);
    put('dirigible', B.cx + BLIMP.rx, BLIMP.h, B.cz);
  }

  // estadísticas
  let calls = 0, tris = 0;
  group.traverse((m) => {
    if (!(m.isMesh || m.isPoints || m.isLineSegments) || !m.geometry) return;
    if (m === rainMesh || m === FW.mesh) return;
    calls++;
    const g = m.geometry, ic = m.isInstancedMesh ? m.count : g.isInstancedBufferGeometry ? g.instanceCount : 1;
    if (m.isMesh) tris += ((g.index ? g.index.count : g.attributes.position.count) / 3) * ic;
  });
  prof('tvcams+api');
  Object.assign(stats, { buildMs: PROF, drawCalls: calls, drawCallsRain: rainMesh ? 1 : 0, drawCallsFireworks: 1, triangles: Math.round(tris), glows: GLOWS.length, occluders: OCC.length, tvCams: tvCams.length, tier });

  function dispose() {
    if (fontsHooked) { try { document.fonts.removeEventListener('loadingdone', onFonts); } catch (e) { /* */ } fontsHooked = false; }
    if (group.parent) group.parent.remove(group);
    const mats = new Set();
    group.traverse((m) => {
      if (m.geometry) m.geometry.dispose();
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => mats.add(x));
      if (m.isInstancedMesh) m.dispose();
    });
    mats.forEach((m) => m.dispose());
    textures.forEach((t) => t.dispose());
    if (envRT) envRT.dispose();
  }

  return {
    id: 'neon',
    group,
    env,
    occluders: OCC,
    tvCams,
    gantry,
    jumbo,
    podium: PODIUM ? { x: PODIUM.x, y: PODIUM.y, z: PODIUM.z, yaw: PODIUM.yaw, slots: PODIUM.slots } : { x: 0, y: 0, z: 60, yaw: Math.PI, slots: [{ x: 0, y: 1.7, z: 60, yaw: Math.PI }, { x: -5.6, y: 1.15, z: 60, yaw: Math.PI }, { x: 5.6, y: 0.75, z: 60, yaw: Math.PI }] },
    crowd,
    fireworks,
    landmarks,
    get blimp() { return blimp ? { x: blimp.position.x, y: blimp.position.y, z: blimp.position.z } : null; },
    setWeather,
    get weather() { return weather; },
    update,
    dispose,
    redraw: onFonts,
    stats,
  };
}
