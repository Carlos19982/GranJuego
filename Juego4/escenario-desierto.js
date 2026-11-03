/* =========================================================================
   DESIERTO SOLAR · escenario (three.js)
   Atardecer dorado en el desierto: cielo en degradado con un sol enorme y
   rayos, espejismo/calima sobre el suelo y las rectas, dunas con arena al
   viento, mesas y cañón por capas, arco de piedra sobre las eses, torre
   solar con campo de heliostatos que destellan, complejo-oasis con tribuna
   de lonas, lago, palmeras y hotel escalonado, boxes, molinos, dirigible,
   globos, rodadoras, remolinos de polvo, público animado y tormenta de
   arena con 'viento'. No dibuja pista/pianos/barreras (pista.js) ni añade
   luces globales (el integrador las crea desde env.ambient).

   export function buildScenery({ scene, renderer, track: T, tier, envMap, rain }) → {
     id, group, env, occluders, tvCams, gantry, jumbo, podium, crowd,
     setWeather(w), update(dt, t, camera), dispose(), stats }
   ========================================================================= */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sampleTrack, distToTrack } from './circuito.js';

/* ------------------------------------------------------------ utilidades */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function mulberry(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function hash2(i, j) { let h = (Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; }
function vnoise(x, z) {
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2(i, j), b = hash2(i + 1, j), c = hash2(i, j + 1), d = hash2(i + 1, j + 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}
function fbm(x, z, o = 4) { let s = 0, a = 0.5, f = 1; for (let k = 0; k < o; k++) { s += a * vnoise(x * f + k * 17.3, z * f - k * 9.1); f *= 2.03; a *= 0.5; } return s; }
const C = (hex) => new THREE.Color(hex);
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _s3 = new THREE.Vector3();
function M(x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) {
  _e.set(rx, ry, rz, 'YXZ'); _q.setFromEuler(_e); _s3.set(sx, sy, sz); _v1.set(x, y, z);
  return new THREE.Matrix4().compose(_v1, _q, _s3);
}
function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d'); draw(x, w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.userData.ctx = x; t.userData.canvas = c;
  return t;
}

/** Acumulador de geometría con color por vértice (se fusiona en una malla). */
function makeBag() {
  const parts = [];
  return {
    parts,
    add(geo, m, color, flat = true) {
      let g = geo.index ? geo.toNonIndexed() : geo.clone();
      geo.dispose();
      if (m) g.applyMatrix4(m);
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
      if (flat || !g.attributes.normal) g.computeVertexNormals();
      const n = g.attributes.position.count, p = g.attributes.position.array, c = new Float32Array(n * 3);
      if (typeof color === 'function') for (let i = 0; i < n; i++) { const cc = color(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], i); c[i * 3] = cc.r; c[i * 3 + 1] = cc.g; c[i * 3 + 2] = cc.b; }
      else for (let i = 0; i < n; i++) { c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      parts.push(g);
      return g;
    },
    raw(pos, col) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
      g.computeVertexNormals();
      parts.push(g);
      return g;
    },
    mesh(mat) {
      if (!parts.length) return null;
      const g = mergeGeometries(parts, false);
      parts.forEach((p) => p.dispose()); parts.length = 0;
      g.computeBoundingSphere();
      return new THREE.Mesh(g, mat);
    },
  };
}

/* ------------------------------------------------------------ calidad */
const QUALITY = {
  low: { cell: 15, crowd: 0.3, maxCrowd: 1200, mirrors: 360, palms: 70, cacti: 50, shrubs: 110, sandDry: 160, sandStorm: 800, rain: 700, devils: 2, balloons: 4, tumble: 4, birds: 0, beams: 26, mesaN: 9, shadows: false },
  med: { cell: 12, crowd: 0.5, maxCrowd: 2600, mirrors: 680, palms: 110, cacti: 90, shrubs: 200, sandDry: 300, sandStorm: 1500, rain: 1200, devils: 3, balloons: 5, tumble: 6, birds: 5, beams: 44, mesaN: 11, shadows: false },
  high: { cell: 10, crowd: 0.78, maxCrowd: 4600, mirrors: 1100, palms: 150, cacti: 130, shrubs: 300, sandDry: 420, sandStorm: 2400, rain: 1800, devils: 3, balloons: 6, tumble: 9, birds: 7, beams: 64, mesaN: 13, shadows: true },
};

/* ------------------------------------------------------------ paleta */
// Sol bajo hacia +z (sur) y algo hacia −x: desde la tribuna principal se ve tras la torre solar.
const SUN_DIR = new THREE.Vector3(-0.33, 0.128, 0.935).normalize();
const WIND = new THREE.Vector2(0.9, 0.42).normalize(); // hacia dónde sopla (xz)
const PAL = {
  zenith: C('#1f2a5a'), mid: C('#c27a80'), horizon: C('#f4ad7e'), glow: C('#ff9a3c'), ground: C('#c98f6a'),
  sunHor: C('#ffc768'), sunMid: C('#ff8a4a'),
  fog: C('#c39088'), fogSun: C('#f3ae6c'), storm: C('#c4864c'), rainSky: C('#6c6a78'),
  sand: C('#d9a574'), sandLight: C('#f2c88e'), sandDark: C('#a86f4c'), sandRed: C('#c47248'), hardpan: C('#cfa582'), grass: C('#6b7a35'), wetSand: C('#8a6040'),
};

/* =========================================================================
   buildScenery
   ========================================================================= */
export function buildScenery({ scene, renderer, track: T, tier = 'med', envMap = null, rain = true } = {}) {
  const Q = QUALITY[tier] || QUALITY.med;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const tB0 = now();
  const rnd = mulberry(20261103);
  const R = (a, b) => a + rnd() * (b - a);
  const group = new THREE.Group(); group.name = 'escenario-desierto';
  const disposables = [];
  const own = (o) => { disposables.push(o); return o; };
  const occluders = [];
  const reserved = []; // círculos reservados {x, z, r}
  const solids = []; // huellas de rocas {x, z, r, top} (las cámaras de TV se suben encima)
  const tp = {}, tq = { d: 0, s: 0, side: 1, lat: 0, i: 0 };
  const TL = T.L;

  /* ---------------- uniformes compartidos ---------------- */
  const U = {
    uTime: { value: 0 }, uSunDir: { value: SUN_DIR.clone() }, uFogSun: { value: PAL.fogSun.clone() },
    uStorm: { value: 0 }, uRain: { value: 0 }, uExcite: { value: 0.15 }, uWind: { value: new THREE.Vector2(WIND.x, WIND.y) }, uGust: { value: 0.25 },
    uHorizon: { value: PAL.horizon.clone() }, uMirage: { value: 1 },
  };

  /* ---------------- helpers de pista ---------------- */
  const at = (s) => sampleTrack(T, s, tp);
  const wallAtI = (i, side) => (side > 0 ? T.wallL[i] : T.wallR[i]);
  /** distancia libre más allá de la barrera (m) */
  function beyond(x, z) { distToTrack(T, x, z, tq); return tq.d - wallAtI(tq.i, tq.side); }
  function clearAt(x, z, r = 0) {
    if (beyond(x, z) < 3 + r) return false;
    for (const c of reserved) if ((x - c.x) ** 2 + (z - c.z) ** 2 < (c.r + r) ** 2) return false;
    return true;
  }
  const occ = (x0, y0, z0, x1, y1, z1) => occluders.push([Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1), Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)]);
  function occPts(pts) { let a = [1e9, 1e9, 1e9], b = [-1e9, -1e9, -1e9]; for (const p of pts) for (let k = 0; k < 3; k++) { a[k] = Math.min(a[k], p[k]); b[k] = Math.max(b[k], p[k]); } occ(a[0], a[1], a[2], b[0], b[1], b[2]); }
  const wrapS = (s) => s - Math.floor(s / TL) * TL;
  const cornerBy = (fn) => T.corners.find(fn);
  const hairpin = cornerBy((c) => c.kind === 'horquilla') || T.corners[5] || T.corners[0];
  const bowl = T.corners.reduce((b, c) => (c.angle > (b ? b.angle : 0) && c !== hairpin ? c : b), null);
  const t1c = T.corners[0];
  const lmBy = (type, name) => T.landmarks.find((l) => l.type === type && (!name || l.name === name));
  const canyonLm = T.landmarks.find((l) => /Ca[ñn]/i.test(l.name || ''));
  const canyonS = canyonLm ? wrapS(canyonLm.s) : 765;
  const mainStand = lmBy('stand', 'Tribuna Oasis') || T.landmarks.find((l) => l.type === 'stand') || { s0: -130, s1: 170, side: 1 };
  const hpStand = T.landmarks.find((l) => l.type === 'stand' && l !== mainStand) || { s0: hairpin.s0 - 20, s1: hairpin.apex, side: -hairpin.dir };
  const PIT = T.pit;

  /* =====================================================================
     TERRENO (dunas) — función de altura exacta + malla en rejilla tensorial
     ===================================================================== */
  const pads = []; // {x,z,rx,rz,y,f}  (elipses planas)
  const bands = []; // {s0,s1,side,l0,l1,dy,f} (franjas relativas a la pista)
  const LAKE = { x: 40, z: -150, rx: 120, rz: 48, y: -0.9 };
  const LAKE2 = { x: 0, z: 0, rx: 34, rz: 22, y: 1.1 }; // charca del oasis de la horquilla (se coloca luego)
  const FIELD = { x: 30, z: 300, r: 232 };
  const PODIUM = { s: 232, lat: 62 };
  function trackRelPoint(s, lat) { at(s); return [tp.x + tp.nx * lat, tp.y, tp.z + tp.nz * lat]; }
  {
    // charca de la horquilla, fuera de la curva
    const [hx, , hz] = trackRelPoint(hairpin.apex, -hairpin.dir * 78);
    LAKE2.x = hx; LAKE2.z = hz;
    const [px, , pz] = trackRelPoint(PODIUM.s, PODIUM.lat); PODIUM.x = px; PODIUM.z = pz;
  }
  pads.push({ x: FIELD.x, z: FIELD.z, rx: FIELD.r + 25, rz: FIELD.r + 25, y: 3.0, f: 60 });
  pads.push({ x: LAKE.x, z: LAKE.z - 40, rx: 230, rz: 150, y: 0.25, f: 70 }); // oasis + hotel
  pads.push({ x: PODIUM.x, z: PODIUM.z, rx: 34, rz: 26, y: 0.3, f: 20 });
  pads.push({ x: LAKE2.x, z: LAKE2.z, rx: 70, rz: 60, y: 2.2, f: 40 });
  bands.push({ s0: mainStand.s0 - 25, s1: mainStand.s1 + 25, side: 1, l0: 8, l1: 62, dy: 0, f: 20 });
  bands.push({ s0: PIT.s0 - 20, s1: PIT.s1 + 20, side: -1, l0: 8, l1: 95, dy: 0, f: 25 });
  bands.push({ s0: hpStand.s0 - 25, s1: hpStand.s1 + 25, side: hpStand.side || 1, l0: 8, l1: 58, dy: 0, f: 18 });
  if (bowl) bands.push({ s0: bowl.s0 + 20, s1: bowl.s1 - 10, side: -bowl.dir, l0: 8, l1: 50, dy: 0.5, f: 18 });

  function dunes(x, z) {
    const u = x * WIND.x + z * WIND.y, v = -x * WIND.y + z * WIND.x;
    const warp = fbm(x * 0.0035, z * 0.0035, 3);
    let p = (u + warp * 70 + Math.sin(v * 0.012) * 28) / 175; p -= Math.floor(p);
    let h = p < 0.74 ? Math.pow(p / 0.74, 1.7) : Math.pow(1 - (p - 0.74) / 0.26, 1.25);
    const amp = 0.55 + 0.45 * fbm(x * 0.0021 + 3.1, z * 0.0021 - 1.7, 2);
    let p2 = (u * 1.0 + v * 0.35 + warp * 25) / 52; p2 -= Math.floor(p2);
    const h2 = p2 < 0.7 ? p2 / 0.7 : 1 - (p2 - 0.7) / 0.3;
    return h * 15 * amp + h2 * 1.6 + fbm(x * 0.01, z * 0.01, 2) * 1.2;
  }
  const lakeDepth = (L, x, z) => { const q = ((x - L.x) / L.rx) ** 2 + ((z - L.z) / L.rz) ** 2; return q < 1.6 ? (1 - sstep(0.55, 1.45, q)) : 0; };
  /** Altura exacta del terreno (y metadatos en hInfo). */
  const hInfo = { e: 0, inf: 0, pad: 0, lake: 0, ty: 0 };
  function heightAt(x, z) {
    const inFine = x > -900 && x < 920 && z > -520 && z < 1120;
    let e = 1e4, ty = 0, side = 1, s = 0;
    let tyB = 0;
    if (inFine) {
      distToTrack(T, x, z, tq); e = tq.d - wallAtI(tq.i, tq.side); ty = T.y[tq.i]; side = tq.side; s = tq.s;
      // altura de la escapatoria peraltada junto a la barrera (y + u·tan(peralte))
      tyB = ty + clamp(tq.lat, -T.wallR[tq.i], T.wallL[tq.i]) * Math.tan(T.bank[tq.i]);
    }
    const inf = side < 0 && e < 1e3 ? 1 : 0;
    let h = dunes(x, z);
    const ampN = sstep(6, 170, e) * (inf ? 0.35 : 1);
    const far = sstep(1100, 2600, Math.hypot(x, z - 330));
    h = h * ampN * (1 + far * 1.6) + ty * (1 - sstep(40, 320, e)) + far * 6;
    // zonas planas
    let padW = 0;
    for (const p of pads) {
      const q = Math.sqrt(((x - p.x) / p.rx) ** 2 + ((z - p.z) / p.rz) ** 2);
      const w = 1 - sstep(1, 1 + p.f / Math.min(p.rx, p.rz), q);
      if (w > 0) { h = lerp(h, p.y, w); padW = Math.max(padW, w); }
    }
    if (inFine && e < 200) for (const b of bands) {
      if (b.side !== side) continue;
      let ds0 = s - b.s0; ds0 -= Math.floor(ds0 / TL) * TL;
      const len = b.s1 - b.s0;
      if (ds0 > len + b.f && ds0 < TL - b.f) continue;
      const along = ds0 <= len + b.f ? Math.min(sstep(-b.f, 0, ds0), 1 - sstep(len, len + b.f, ds0)) : sstep(-b.f, 0, ds0 - TL);
      const lat = tq.d;
      const across = Math.min(sstep(b.l0 - b.f, b.l0, lat), 1 - sstep(b.l1, b.l1 + b.f, lat));
      const w = along * across;
      if (w > 0) { h = lerp(h, ty + b.dy, w); padW = Math.max(padW, w); }
    }
    // La Caldera: talud/cráter de arena por fuera del bol
    if (bowl && inFine && side === -bowl.dir && e > 30 && e < 190) {
      let ds = s - (bowl.s0 - 30); ds -= Math.floor(ds / TL) * TL;
      const len = bowl.s1 - bowl.s0 + 60;
      if (ds < len) h += 11 * Math.min(sstep(0, 50, ds), 1 - sstep(len - 50, len, ds)) * sstep(48, 85, e) * (1 - sstep(120, 185, e));
    }
    // lagos
    const lk = Math.max(lakeDepth(LAKE, x, z), lakeDepth(LAKE2, x, z));
    if (lk > 0) h -= lk * 3.2;
    // junto a la pista: plano bajo la escapatoria
    if (e < 60) h = lerp(tyB - 0.4, h, sstep(3, 40, e));
    hInfo.e = e; hInfo.inf = inf; hInfo.pad = padW; hInfo.lake = lk; hInfo.ty = ty;
    return h;
  }

  // rejilla tensorial: fina en la zona del circuito, cada vez más ancha hacia el horizonte
  function axis(a0, a1, c, far) {
    const v = []; for (let x = a0; x <= a1 + 1e-6; x += c) v.push(x);
    const pre = []; let st = c, x = a0; while (x > a0 - far) { st *= 1.42; x -= st; pre.unshift(x); }
    x = v[v.length - 1]; st = c; while (x < a1 + far) { st *= 1.42; x += st; v.push(x); }
    return pre.concat(v);
  }
  const GX = axis(-800, 800, Q.cell, 3600), GZ = axis(-420, 1000, Q.cell, 3600);
  const NXg = GX.length, NZg = GZ.length;
  const HG = new Float32Array(NXg * NZg);
  const terrainMesh = (() => {
    const n = NXg * NZg, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const E = new Float32Array(n), INF = new Uint8Array(n), PAD = new Float32Array(n), LK = new Float32Array(n);
    for (let j = 0; j < NZg; j++) for (let i = 0; i < NXg; i++) {
      const k = j * NXg + i, x = GX[i], z = GZ[j];
      const h = heightAt(x, z);
      HG[k] = h; E[k] = hInfo.e; INF[k] = hInfo.inf; PAD[k] = hInfo.pad; LK[k] = hInfo.lake;
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
    }
    const c = new THREE.Color(), c2 = new THREE.Color();
    for (let j = 0; j < NZg; j++) for (let i = 0; i < NXg; i++) {
      const k = j * NXg + i, x = GX[i], z = GZ[j];
      const i0 = Math.max(0, i - 1), i1 = Math.min(NXg - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(NZg - 1, j + 1);
      const gx = (HG[j * NXg + i1] - HG[j * NXg + i0]) / (GX[i1] - GX[i0] || 1), gz = (HG[j1 * NXg + i] - HG[j0 * NXg + i]) / (GZ[j1] - GZ[j0] || 1);
      const slope = Math.hypot(gx, gz);
      const down = -(gx * WIND.x + gz * WIND.y); // >0 ladera a sotavento (cara de avalancha)
      const nn = fbm(x * 0.013, z * 0.013, 2);
      c.copy(PAL.sand);
      c.lerp(PAL.sandLight, clamp(0.35 + nn * 0.5 + (HG[k] - 6) * 0.03, 0, 0.8));
      if (down > 0.05) c.lerp(PAL.sandRed, clamp(down * 1.6, 0, 0.55));
      c.lerp(PAL.sandDark, clamp(slope * 0.8 - 0.15, 0, 0.35));
      if (INF[k] && E[k] > 10) c.lerp(PAL.hardpan, 0.45 * sstep(10, 60, E[k]));
      if (E[k] < 12) c.lerp(PAL.hardpan, 0.4 * (1 - sstep(2, 12, E[k])));
      if (PAD[k] > 0.3) c.lerp(c2.copy(PAL.hardpan).multiplyScalar(1.02), 0.35 * PAD[k]);
      if (LK[k] > 0) { c.lerp(PAL.grass, sstep(0.0, 0.35, LK[k]) * 0.85); c.lerp(PAL.wetSand, sstep(0.35, 0.6, LK[k])); }
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
    }
    const idx = new Uint32Array((NXg - 1) * (NZg - 1) * 6);
    let q = 0;
    for (let j = 0; j < NZg - 1; j++) for (let i = 0; i < NXg - 1; i++) {
      const a = j * NXg + i, b = a + 1, d = a + NXg, e = d + 1;
      idx[q++] = a; idx[q++] = d; idx[q++] = b; idx[q++] = b; idx[q++] = d; idx[q++] = e;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  })();
  const tB1 = now();
  /** altura del terreno interpolada de la rejilla (para cosas que se mueven) */
  function groundAt(x, z) {
    let i = 0, lo = 0, hi = NXg - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (GX[m] <= x) lo = m; else hi = m; } i = lo;
    let j = 0; lo = 0; hi = NZg - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (GZ[m] <= z) lo = m; else hi = m; } j = lo;
    const fx = clamp((x - GX[i]) / (GX[i + 1] - GX[i]), 0, 1), fz = clamp((z - GZ[j]) / (GZ[j + 1] - GZ[j]), 0, 1);
    const a = HG[j * NXg + i], b = HG[j * NXg + i + 1], c = HG[(j + 1) * NXg + i], d = HG[(j + 1) * NXg + i + 1];
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fz);
  }

  /* ---------------- texturas procedurales ---------------- */
  const sandTex = own(canvasTex(256, 256, (x, w, h) => {
    const img = x.createImageData(w, h), d = img.data;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const u = i / w, v = j / h;
      const warp = Math.sin(v * Math.PI * 2 * 2 + Math.sin(u * Math.PI * 2 * 3) * 1.2) * 0.06 + Math.sin(u * Math.PI * 2) * 0.03;
      const ph = (u * 0.94 + v * 0.34 + warp) * 11; let f = ph - Math.floor(ph);
      f = f < 0.72 ? f / 0.72 : 1 - (f - 0.72) / 0.28; // rizo asimétrico
      const grain = hash2(i * 7 + 3, j * 13 + 1);
      const mac = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * 2 + Math.cos(v * Math.PI * 2 * 3) * 1.4) * Math.cos(v * Math.PI * 2 * 1 + u * 3);
      d[(j * w + i) * 4] = 120 + f * 110 + (grain - 0.5) * 40;
      d[(j * w + i) * 4 + 1] = 70 + mac * 150;
      d[(j * w + i) * 4 + 2] = grain * 255;
      d[(j * w + i) * 4 + 3] = 255;
    }
    x.putImageData(img, 0, 0);
  }, false));
  sandTex.wrapS = sandTex.wrapT = THREE.RepeatWrapping;
  sandTex.anisotropy = renderer && renderer.capabilities ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;

  /* ---------------- parches de material (niebla direccional, espejismo, estratos) ---------------- */
  const FOG_GLSL = `
#ifdef USE_FOG
  vec3 fdv = vWPos - cameraPosition;
  float fsun = dot(normalize(fdv.xz + 1e-4), normalize(uSunDir.xz + 1e-4)) * 0.5 + 0.5;
  vec3 fcol = mix(fogColor, uFogSun, fsun * fsun * fsun * (1.0 - uStorm * 0.6));
  float fogFactor = 1.0 - exp(- fogDensity * fogDensity * vFogDepth * vFogDepth);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fcol, fogFactor);
#endif`;
  function patch(mat, key, extra = {}) {
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, { uTime: U.uTime, uSunDir: U.uSunDir, uFogSun: U.uFogSun, uStorm: U.uStorm, uHorizon: U.uHorizon, uMirage: U.uMirage, uWind: U.uWind, uGust: U.uGust }, extra.uniforms || {});
      const head = 'varying vec3 vWPos;\nuniform float uTime; uniform vec3 uSunDir; uniform vec3 uFogSun; uniform float uStorm; uniform vec3 uHorizon; uniform float uMirage; uniform vec2 uWind; uniform float uGust;\n';
      sh.vertexShader = head + (extra.vhead || '') + sh.vertexShader
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + (extra.vbegin || ''))
        .replace('#include <project_vertex>', `#include <project_vertex>
  { vec4 wp4 = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    wp4 = instanceMatrix * wp4;
  #endif
    vWPos = (modelMatrix * wp4).xyz; }`);
      let fs = head + (extra.fhead || '') + sh.fragmentShader;
      if (extra.map) fs = fs.replace('#include <map_fragment>', extra.map);
      if (extra.color) fs = fs.replace('#include <color_fragment>', extra.color);
      fs = fs.replace('#include <fog_fragment>', (extra.prefog || '') + FOG_GLSL);
      sh.fragmentShader = fs;
    };
    mat.customProgramCacheKey = () => 'desierto-' + key;
    return mat;
  }

  /* ---------------- materiales ---------------- */
  const matTerrain = own(patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'terrain', {
    uniforms: { tSand: { value: sandTex } },
    fhead: 'uniform sampler2D tSand;\n',
    map: `{
      vec2 wuv = vWPos.xz;
      vec4 t1 = texture2D(tSand, wuv * 0.16);
      vec4 t2 = texture2D(tSand, wuv * 0.023 + 0.37);
      float rip = mix(t1.r, 0.6, smoothstep(60.0, 260.0, length(vWPos - cameraPosition)));
      diffuseColor.rgb *= (0.8 + 0.3 * rip) * (0.86 + 0.24 * t2.g) * (0.96 + 0.08 * t1.b);
    }`,
    prefog: `{
      vec3 vv = vWPos - cameraPosition; float dist = length(vv); vec3 vd = vv / dist;
      float graze = smoothstep(0.12, 0.012, -vd.y) * step(vd.y, 0.02);
      float m = graze * smoothstep(110.0, 520.0, dist) * (1.0 - smoothstep(1800.0, 3000.0, dist)) * uMirage * (1.0 - uStorm);
      float sh = 0.72 + 0.28 * sin(vWPos.x * 0.07 + uTime * 2.6 + sin(vWPos.z * 0.045 - uTime * 1.3) * 2.2) * sin(vWPos.z * 0.11 + uTime * 3.1);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, uHorizon * sh, clamp(m * 0.8, 0.0, 0.85));
    }`,
  }));
  const ROCK_STRATA = `
    #include <color_fragment>
    {
      float yy = vWPos.y + sin(vWPos.x * 0.031 + vWPos.z * 0.027) * 2.5;
      float b1 = sin(yy * 0.85) * 0.5 + 0.5, b2 = sin(yy * 2.7 + 1.3) * 0.5 + 0.5;
      diffuseColor.rgb *= 0.8 + 0.16 * b1 + 0.1 * b2 * b2;
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.72, 0.62, 0.66), smoothstep(0.93, 0.99, sin(yy * 0.37 + 2.0)) * 0.7);
    }`;
  const matRockNear = own(patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'rock', { color: ROCK_STRATA }));
  const matRockFar = own(patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'rock', { color: ROCK_STRATA }));
  const matStatic = own(patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'static'));
  const matEmissive = own(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: THREE.DoubleSide, fog: true }));

  // sin sombras (low/med) se fusionan rocas cercanas+lejanas y flora+estructuras: menos llamadas
  const bagRockNear = makeBag(), bagRockFar = Q.shadows ? makeBag() : bagRockNear, bagStatic = makeBag(), bagEmis = makeBag(), bagFlora = Q.shadows ? makeBag() : bagStatic;

  /* =====================================================================
     ROCAS: mesas lejanas, oteros, cañón con arco de piedra
     ===================================================================== */
  const ROCK_PAL = ['#8e3b24', '#b5532d', '#cf7a45', '#e2a66b', '#ecc79a', '#a5482e', '#c56a3c', '#7a3a2c'].map(C);
  function rockColorFn(seed, topY, shade = 1) {
    const cc = new THREE.Color();
    return (x, y, z) => {
      const b = Math.floor((y + vnoise(x * 0.02 + seed, z * 0.02) * 3 + seed * 7) / 6.5);
      const k = ((b % ROCK_PAL.length) + ROCK_PAL.length) % ROCK_PAL.length;
      cc.copy(ROCK_PAL[k]).lerp(ROCK_PAL[(k + 3) % ROCK_PAL.length], 0.25 + 0.25 * vnoise(x * 0.05, z * 0.05 + seed));
      if (y > topY - 0.6) cc.lerp(C('#c98a55'), 0.5);
      return cc.multiplyScalar(shade * (0.92 + 0.08 * vnoise(x * 0.3, y * 0.3)));
    };
  }
  function mesa(bag, cx, cz, r, h, o = {}) {
    const n = o.n || Q.mesaN, sx = o.sx || 1, sz = o.sz || 1, rot = o.rot || 0, seed = o.seed != null ? o.seed : R(0, 100);
    const y0 = o.y0 != null ? o.y0 : groundAt(cx, cz) - 4;
    const rings = o.rings || [[1.36, -0.05], [1.17, 0.18], [1.03, 0.3], [1.0, 0.6], [0.91, 0.64], [0.9, 0.95], [0.84, 1.0]];
    const rr = []; for (let i = 0; i < n; i++) rr.push(1 + 0.24 * vnoise(seed + i * 0.93, seed * 0.31) + 0.07 * Math.sin(i * 2.7 + seed));
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const P = rings.map(([rf, hf], j) => rr.map((rv, i) => {
      const a = (i / n) * Math.PI * 2 + (j % 2) * 0.04;
      const Rr = r * rf * rv * (1 + 0.06 * vnoise(i * 1.7 + seed, j * 3.1));
      const lx = Math.cos(a) * Rr * sx, lz = Math.sin(a) * Rr * sz;
      return [cx + lx * cr - lz * sr, y0 + 4 + h * hf + (hf > 0.9 ? vnoise(i + seed, 7) * h * 0.03 : 0), cz + lx * sr + lz * cr];
    }));
    const pos = [], col = [];
    const cf = rockColorFn(seed, y0 + 4 + h, o.shade || 1);
    const push = (p) => { pos.push(p[0], p[1], p[2]); const c = cf(p[0], p[1], p[2]); col.push(c.r, c.g, c.b); };
    for (let j = 0; j < P.length - 1; j++) for (let i = 0; i < n; i++) {
      const i1 = (i + 1) % n, a = P[j][i], b = P[j][i1], c = P[j + 1][i1], d = P[j + 1][i];
      push(a); push(b); push(c); push(a); push(c); push(d);
    }
    const top = P[P.length - 1]; let tx = 0, ty = 0, tz = 0; top.forEach((p) => { tx += p[0]; ty += p[1]; tz += p[2]; });
    const ctr = [tx / n, ty / n + h * 0.01, tz / n];
    for (let i = 0; i < n; i++) { push(top[i]); push(top[(i + 1) % n]); push(ctr); }
    bag.raw(pos, col);
    solids.push({ x: cx, z: cz, r: r * 1.36 * Math.max(sx, sz), top: y0 + 4 + h });
    return { y0, top: y0 + 4 + h };
  }
  const CENTER = new THREE.Vector2(0, 330);
  // anillo lejano de mesas (más denso en la dirección del sol: siluetas)
  {
    const sunAz = Math.atan2(SUN_DIR.z, SUN_DIR.x);
    const count = tier === 'low' ? 22 : 32;
    for (let k = 0; k < count; k++) {
      let a = (k / count) * Math.PI * 2 + R(-0.08, 0.08);
      const nearSun = Math.cos(a - sunAz);
      const dist = R(1250, 2700) - nearSun * 250;
      const x = CENTER.x + Math.cos(a) * dist, z = CENTER.y + Math.sin(a) * dist;
      const r = R(90, 260) * (nearSun > 0.6 ? 1.3 : 1), h = R(70, 170) * (nearSun > 0.5 ? 1.15 : 1);
      mesa(bagRockFar, x, z, r, h, { sx: R(1, 2.2), sz: R(0.7, 1.2), rot: R(0, 3.14), shade: 0.95, n: Q.mesaN + 3 });
      if (rnd() < 0.5) mesa(bagRockFar, x + R(-1, 1) * r * 1.5, z + R(-1, 1) * r * 1.5, r * R(0.3, 0.55), h * R(0.6, 1.3), { shade: 0.95 });
    }
    // oteros y agujas a media distancia
    let placed = 0;
    for (let tries = 0; placed < (tier === 'low' ? 10 : 16) && tries < 400; tries++) {
      const a = R(0, Math.PI * 2), dist = R(560, 1150);
      const x = CENTER.x + Math.cos(a) * dist * 1.15, z = CENTER.y + Math.sin(a) * dist;
      if (beyond(x, z) < 160) continue;
      if (Math.hypot(x - LAKE.x, z - LAKE.z) < 330) continue;
      const spire = rnd() < 0.45;
      const r = spire ? R(9, 16) : R(28, 70), h = spire ? R(45, 85) : R(28, 62);
      const m = mesa(bagRockFar, x, z, r, h, spire ? { rings: [[1.9, -0.05], [1.3, 0.14], [1.0, 0.25], [0.86, 0.7], [1.05, 0.8], [1.12, 0.92], [0.9, 1.0]] } : { sx: R(1, 1.8), rot: R(0, 3) });
      occ(x - r * 1.4, m.y0, z - r * 1.4, x + r * 1.4, m.top, z + r * 1.4);
      placed++;
    }
  }
  // cañón de las eses: paredes de oteros encadenados a ambos lados + arco de piedra
  const canyon = { s0: canyonS - 230, s1: canyonS + 175, archS: canyonS - 10 };
  {
    for (const side of [1, -1]) {
      for (let s = canyon.s0; s <= canyon.s1; s += R(15, 21)) {
        at(s);
        const i = tp.i, wall = wallAtI(i, side);
        const prof = Math.min(sstep(canyon.s0, canyon.s0 + 90, s), 1 - sstep(canyon.s1 - 70, canyon.s1, s));
        const r = R(13, 20), lat = wall + 4.5 + r * 1.32 + R(0, 4);
        const x = tp.x + tp.nx * side * lat, z = tp.z + tp.nz * side * lat;
        if (!clearAt(x, z, r * 1.25)) continue;
        const h = 6 + prof * R(19, 30) + (side > 0 ? 4 : 0);
        const rot = Math.atan2(tp.tz, tp.tx);
        const m = mesa(bagRockNear, x, z, r, h, { sx: 1.45, sz: 1, rot, y0: tp.y - 4.2, rings: [[1.3, -0.05], [1.12, 0.12], [1.02, 0.2], [1.0, 0.55], [0.93, 0.6], [0.92, 0.94], [0.8, 1.0]] });
        // detrás, una masa más ancha y baja que cierra el cañón
        mesa(bagRockNear, tp.x + tp.nx * side * (lat + r * 1.8), tp.z + tp.nz * side * (lat + r * 1.8), r * 1.5, h * R(0.75, 1.05), { sx: 1.4, rot, y0: tp.y - 4 });
        occ(x - r * 1.5, m.y0, z - r * 1.5, x + r * 1.5, m.top, z + r * 1.5);
      }
    }
    // arco natural sobre la pista (gálibo ≥ 14 m)
    at(canyon.archS);
    const aw = Math.max(wallAtI(tp.i, 1), wallAtI(tp.i, -1)) + 7;
    const ax = tp.x, az = tp.z, ay = tp.y, anx = tp.nx, anz = tp.nz;
    const pts = [];
    for (let k = 0; k <= 8; k++) {
      const u = -1 + (2 * k) / 8, lat = u * (aw + 6);
      const yy = ay + 12 + 12 * Math.pow(1 - u * u, 0.45) + (Math.abs(u) > 0.92 ? -5 * (Math.abs(u) - 0.92) / 0.08 : 0);
      pts.push(new THREE.Vector3(ax + anx * lat, yy, az + anz * lat));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.TubeGeometry(curve, 30, 3.6, 8, false);
    const p = tube.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), y = p.getY(k), z = p.getZ(k);
      const nz = vnoise(x * 0.15, z * 0.15 + y * 0.1) * 1.6;
      p.setXYZ(k, x + nz * 0.6, y + nz + (y > ay + 21 ? 1.2 : 0) - (y < ay + 18 ? 0.8 : 0), z + nz * 0.6);
    }
    // el arco no puede bajar de 7 m sobre la pista + escapatoria
    let clr = 1e9;
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), z = p.getZ(k); distToTrack(T, x, z, tq);
      if (tq.d < wallAtI(tq.i, tq.side) + 1) clr = Math.min(clr, p.getY(k) - T.y[tq.i] - Math.abs(tq.lat) * Math.abs(Math.tan(T.bank[tq.i])));
    }
    if (clr < 7) console.warn('[desierto] gálibo del arco', clr.toFixed(1));
    canyon.clearance = clr;
    bagRockNear.add(tube, null, rockColorFn(4.2, ay + 30, 1.25), true);
    for (const sd of [1, -1]) {
      const lat = sd * (aw + 7), x = ax + anx * lat, z = az + anz * lat;
      const m = mesa(bagRockNear, x, z, 10, 26, { sx: 1.3, rot: Math.atan2(tp.tz, tp.tx), y0: ay - 4, rings: [[1.5, -0.05], [1.2, 0.15], [1.0, 0.3], [0.95, 0.75], [1.1, 0.85], [1.0, 0.97], [0.85, 1.0]] });
      occ(x - 13, m.y0, z - 13, x + 13, m.top, z + 13);
    }
    canyon.arch = { x: ax, z: az, y: ay, lat: aw };
  }
  // borde de La Caldera: lomas rocosas bajas por fuera del bol
  if (bowl) {
    const side = -bowl.dir;
    for (let s = bowl.s0 + 10; s < bowl.s1 + 10; s += R(16, 24)) {
      at(s);
      if (rnd() < 0.3) continue;
      const wall = wallAtI(tp.i, side), r = R(7, 20), lat = wall + 55 + R(0, 40) + r;
      const x = tp.x + tp.nx * side * lat, z = tp.z + tp.nz * side * lat;
      if (!clearAt(x, z, r * 1.4)) continue;
      mesa(bagRockNear, x, z, r, R(5, 16), { sx: R(1.1, 1.9), rot: Math.atan2(tp.tz, tp.tx) + R(-0.4, 0.4), y0: heightAt(x, z) - 4 });
    }
  }
  // peñascos sueltos
  for (let k = 0, tries = 0; k < (tier === 'low' ? 30 : 60) && tries < 600; tries++) {
    const x = R(-760, 780), z = R(-380, 980);
    if (!clearAt(x, z, 6)) continue;
    if (Math.hypot(x - FIELD.x, z - FIELD.z) < FIELD.r + 30 || Math.hypot(x - LAKE.x, z - LAKE.z + 40) < 250) continue;
    const r = R(1.5, 5.5), y = groundAt(x, z);
    const g = new THREE.DodecahedronGeometry(r, 0);
    bagRockNear.add(g, M(x, y + r * 0.3, z, R(0, 6), R(0.9, 1.6), R(0.5, 0.9), R(0.9, 1.4), R(-0.3, 0.3)), rockColorFn(R(0, 50), 1e9, 0.9));
    k++;
  }

  /* =====================================================================
     TORRE SOLAR + CAMPO DE HELIOSTATOS
     ===================================================================== */
  const TOWER = { x: FIELD.x, z: FIELD.z, h: 104, y: 3.0 };
  const RECV = new THREE.Vector3(TOWER.x, TOWER.y + TOWER.h + 8, TOWER.z);
  {
    const y = TOWER.y, concrete = C('#d2c3ae'), dark = C('#4a4038');
    bagStatic.add(new THREE.CylinderGeometry(5.6, 8.5, TOWER.h, 14, 1), M(TOWER.x, y + TOWER.h / 2, TOWER.z), (x, yy) => concrete.clone().multiplyScalar(0.85 + 0.15 * Math.sin(yy * 0.5)), false);
    bagStatic.add(new THREE.CylinderGeometry(9.5, 9.5, 1.2, 16), M(TOWER.x, y + TOWER.h - 0.4, TOWER.z), dark);
    bagStatic.add(new THREE.CylinderGeometry(6.4, 7.2, 3, 12), M(TOWER.x, y + TOWER.h + 18.5, TOWER.z), dark);
    bagStatic.add(new THREE.CylinderGeometry(1.2, 1.2, 14, 6), M(TOWER.x, y + TOWER.h + 26, TOWER.z), dark);
    for (let k = 0; k < 4; k++) bagStatic.add(new THREE.TorusGeometry(6.2 + k * 0.4, 0.25, 4, 18), M(TOWER.x, y + 22 + k * 20, TOWER.z, 0, 1, 1, 1, Math.PI / 2), dark);
    // receptor incandescente (emisivo HDR)
    bagEmis.add(new THREE.CylinderGeometry(7.1, 7.1, 16, 18, 4, true), M(TOWER.x, y + TOWER.h + 8.5, TOWER.z), (xx, yy) => { const k = 0.65 + 0.35 * Math.sin((yy - y - TOWER.h) * 0.9); return new THREE.Color(9 * k, 6.2 * k, 3.2 * k); });
    occ(TOWER.x - 9, y, TOWER.z - 9, TOWER.x + 9, y + TOWER.h + 33, TOWER.z + 9);
    reserved.push({ x: TOWER.x, z: TOWER.z, r: 26 });
  }
  const mirrorPts = [];
  {
    const want = Q.mirrors;
    const rings = [];
    for (let r = 34; r < FIELD.r; r += 8.2) rings.push(r);
    const cand = [];
    rings.forEach((r, ri) => {
      const n = Math.floor((2 * Math.PI * r) / 7.4);
      for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2 + (ri % 2) * (Math.PI / n); cand.push([TOWER.x + Math.cos(a) * r, TOWER.z + Math.sin(a) * r, r]); }
    });
    const keep = cand.filter(([x, z]) => clearAt(x, z, 6) && beyond(x, z) > 14 && Math.abs(z - (PIT.side < 0 ? 85 : -85)) > 0);
    // reduce de forma uniforme hasta el presupuesto
    const step = Math.max(1, keep.length / want);
    for (let f = 0; f < keep.length && mirrorPts.length < want; f += step) mirrorPts.push(keep[Math.floor(f)]);
  }
  let mirrors = null;
  {
    const panel = new THREE.PlaneGeometry(5.4, 3.4).translate(0, 0, 0.07);
    const frame = new THREE.PlaneGeometry(5.4, 3.4).rotateY(Math.PI).translate(0, 0, -0.07);
    const pole = new THREE.BoxGeometry(0.32, 3.2, 0.32, 1, 1, 1).translate(0, -1.75, -0.2);
    const parts = [panel, frame, pole].map((g) => g.toNonIndexed());
    const geo = mergeGeometries(parts.map((g) => { for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k); return g; }));
    parts.forEach((g) => g.dispose()); panel.dispose(); frame.dispose(); pole.dispose();
    const n = geo.attributes.position.count, isM = new Float32Array(n), pa = geo.attributes.position.array, na = geo.attributes.normal.array;
    for (let i = 0; i < n; i++) isM[i] = na[i * 3 + 2] > 0.9 && Math.abs(pa[i * 3 + 2] - 0.07) < 0.01 ? 1 : 0;
    geo.setAttribute('aMirror', new THREE.BufferAttribute(isM, 1));
    const mat = new THREE.ShaderMaterial({
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]),
      vertexShader: `
        attribute float aMirror; varying float vMirror; varying vec3 vN; varying vec3 vWPos; varying float vId;
        #include <fog_pars_vertex>
        void main() {
          vMirror = aMirror; vId = float(gl_InstanceID);
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vWPos = wp.xyz;
          vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        uniform float uTime; uniform vec3 uSunDir; uniform vec3 uFogSun; uniform float uStorm; uniform vec3 uHorizon; uniform float uMirage; uniform vec2 uWind; uniform float uGust;
        varying float vMirror; varying vec3 vN; varying vec3 vWPos; varying float vId;
        #include <common>
        #include <fog_pars_fragment>
        vec3 skyCol(vec3 d) {
          float y = clamp(d.y, -0.2, 1.0);
          vec3 c = mix(vec3(1.0, 0.55, 0.26), vec3(0.62, 0.22, 0.30), smoothstep(0.02, 0.25, y));
          c = mix(c, vec3(0.05, 0.05, 0.16), smoothstep(0.2, 0.75, y));
          float az = dot(normalize(d.xz + 1e-4), normalize(uSunDir.xz)) * 0.5 + 0.5;
          c += vec3(1.0, 0.45, 0.12) * pow(az, 4.0) * exp(-max(y, 0.0) * 7.0);
          if (y < 0.0) c = mix(c, vec3(0.55, 0.32, 0.2), smoothstep(0.0, -0.08, y));
          return c;
        }
        void main() {
          vec3 N = normalize(vN);
          if (!gl_FrontFacing) N = -N;
          vec3 V = normalize(vWPos - cameraPosition);
          vec3 col;
          if (vMirror > 0.5 && gl_FrontFacing) {
            vec3 Np = normalize(N + 0.035 * vec3(sin(vId * 1.7 + uTime * 0.35), 0.0, cos(vId * 2.3 + uTime * 0.29)));
            vec3 r = reflect(V, Np);
            float fr = 0.55 + 0.45 * pow(1.0 - max(dot(-V, Np), 0.0), 3.0);
            col = skyCol(r) * fr * 1.15 + vec3(0.03, 0.05, 0.08);
            float glint = pow(max(dot(r, normalize(uSunDir)), 0.0), 60.0);
            float tw = step(0.985, fract(sin(vId * 12.9898 + floor(uTime * 3.0 + vId)) * 43758.5)) ;
            col += vec3(4.0, 2.8, 1.6) * (glint * 2.5 + tw * 0.9 * smoothstep(0.0, 0.4, r.y + 0.3)) * (1.0 - uStorm * 0.8);
            // rejilla de facetas
            col *= 0.9 + 0.1 * step(0.04, abs(fract(vWPos.x * 0.37 + vWPos.z * 0.37) - 0.5));
          } else {
            float l = 0.32 + 0.9 * max(dot(N, normalize(uSunDir)), 0.0) + 0.18 * N.y;
            col = vec3(0.32, 0.29, 0.27) * l;
          }
          col *= 1.0 - uStorm * 0.35;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    Object.assign(mat.uniforms, { uTime: U.uTime, uSunDir: U.uSunDir, uFogSun: U.uFogSun, uStorm: U.uStorm, uHorizon: U.uHorizon, uMirage: U.uMirage, uWind: U.uWind, uGust: U.uGust });
    mirrors = new THREE.InstancedMesh(geo, mat, Math.max(1, mirrorPts.length));
    const o = new THREE.Object3D();
    mirrorPts.forEach(([x, z], k) => {
      const y = TOWER.y + 4.1;
      o.position.set(x, y, z);
      _v1.set(RECV.x - x, RECV.y - y, RECV.z - z).normalize();
      _v2.copy(SUN_DIR).add(_v1).normalize();
      o.lookAt(x + _v2.x, y + _v2.y, z + _v2.z);
      o.updateMatrix(); mirrors.setMatrixAt(k, o.matrix);
    });
    mirrors.count = mirrorPts.length;
    mirrors.instanceMatrix.needsUpdate = true;
    mirrors.frustumCulled = false;
    own(geo); own(mat);
  }

  /* =====================================================================
     PÓRTICO (Arco Solar), TRIBUNAS, BOXES, OASIS, HOTEL, PODIO, MOLINOS…
     ===================================================================== */
  const glowList = []; // {x,y,z,size,r,g,b,blink,phase}
  const GLOW = (x, y, z, size, r, g, b, blink = 0, phase = 0) => { glowList.push({ x, y, z, size, r, g, b, blink, phase }); return glowList.length - 1; };
  // barrido de un perfil [lat, y] a lo largo de la pista (no indexado; color por segmento)
  function sweep(bag, sA, sB, step, prof, colorOf, yAt = (o) => o.y) {
    const ns = Math.max(1, Math.ceil((sB - sA) / step)), rows = [];
    for (let i = 0; i <= ns; i++) {
      const s = sA + ((sB - sA) * i) / ns; at(s);
      rows.push(prof.map(([lat, y]) => [tp.x + tp.nx * lat, yAt(tp) + y, tp.z + tp.nz * lat]));
    }
    const pos = [], col = [];
    for (let i = 0; i < ns; i++) for (let k = 0; k < prof.length - 1; k++) {
      const c = colorOf(k, sA + ((sB - sA) * (i + 0.5)) / ns);
      if (!c) continue;
      const a = rows[i][k], b = rows[i + 1][k], d = rows[i][k + 1], e = rows[i + 1][k + 1];
      for (const p of [a, b, e, a, e, d]) { pos.push(p[0], p[1], p[2]); col.push(c.r, c.g, c.b); }
    }
    bag.raw(pos, col);
    return rows;
  }
  const CROWD = [];
  const STANDS = [];
  function buildStand(sA, sB, side, rows, lat0, opt = {}) {
    const stepD = 1.45, stepH = 0.86, base = 1.3;
    for (let s = sA; s <= sB; s += 4) { at(s); lat0 = Math.max(lat0, wallAtI(tp.i, side) + 3.5); }
    const prof = [[lat0 - 0.4, 0], [lat0 - 0.4, base]];
    for (let r = 0; r < rows; r++) { const la = lat0 + r * stepD, h = base + r * stepH; prof.push([la + stepD, h], [la + stepD, h + stepH]); }
    const latEnd = lat0 + rows * stepD, topH = base + rows * stepH;
    prof.push([latEnd + 0.4, topH + 1.2], [latEnd + 0.4, 0]);
    const sideProf = prof.map(([l, y]) => [side * l, y]);
    const seatA = C(opt.seatA || '#c4552f'), seatB = C(opt.seatB || '#e9d2ad'), riser = C('#8a5a3c'), back = C('#d9c3a0'), plinth = C('#b38a64');
    sweep(bagStatic, sA, sB, 6, sideProf, (k, s) => {
      if (k === 0) return plinth;
      if (k >= sideProf.length - 3) return back;
      const r = Math.floor((k - 1) / 2);
      if ((k - 1) % 2 === 0) return riser; // contrahuella
      return (Math.floor(s / 14) + r) % 5 === 0 ? seatB : seatA;
    });
    // pasarela trasera y voladizo de lonas tensadas (picos blancos)
    const canopyH = topH + 7.5;
    for (let s = sA + 10; s <= sB - 6; s += 20) {
      at(s); const yb = tp.y;
      const mx = tp.x + tp.nx * side * (latEnd + 0.6), mz = tp.z + tp.nz * side * (latEnd + 0.6);
      bagStatic.add(new THREE.CylinderGeometry(0.35, 0.45, canopyH + 4, 6), M(mx, yb + (canopyH + 4) / 2, mz), C('#e8e2d6'));
      const cx = tp.x + tp.nx * side * (lat0 + (latEnd - lat0) * 0.45), cz = tp.z + tp.nz * side * (lat0 + (latEnd - lat0) * 0.45);
      const cone = new THREE.ConeGeometry(14.5, 7, 4, 1, true);
      bagStatic.add(cone, M(cx, yb + canopyH + 3.5, cz, Math.atan2(tp.tx, tp.tz) + Math.PI / 4, 1, 1, 1), (x, y) => C(y > yb + canopyH + 5 ? '#fbf6ee' : '#ece2d2'), true);
      GLOW(cx, yb + canopyH - 0.2, cz, 7, 1.0, 0.62, 0.3);
    }
    // borde LED ámbar en el frente de la cubierta
    sweep(bagEmis, sA, sB, 6, [[side * (lat0 - 1.5), topH + 4.0], [side * (lat0 - 1.5), topH + 4.35]], () => new THREE.Color(1.1, 0.6, 0.25));
    // público
    const o = {};
    for (let r = 0; r < rows; r++) {
      const h = base + r * stepH;
      for (let s = sA + 0.7; s < sB - 0.5; s += 0.82) {
        if (rnd() > Q.crowd) continue;
        sampleTrack(T, s, o);
        const lat = side * (lat0 + (r + 0.55) * stepD) + R(-0.12, 0.12);
        CROWD.push({ x: o.x + o.nx * lat, y: o.y + h, z: o.z + o.nz * lat, yaw: Math.atan2(-o.nx * side, -o.nz * side) });
      }
    }
    const pts = [];
    for (let s = sA; s <= sB; s += 8) { at(s); pts.push([tp.x + tp.nx * side * lat0, tp.y, tp.z + tp.nz * side * lat0], [tp.x + tp.nx * side * latEnd, tp.y + topH + 1.2, tp.z + tp.nz * side * latEnd]); }
    for (let k = 0; k + 6 <= pts.length; k += 4) occPts(pts.slice(k, k + 6));
    for (let s = sA; s <= sB; s += 10) { at(s); reserved.push({ x: tp.x + tp.nx * side * (lat0 + latEnd) / 2, z: tp.z + tp.nz * side * (lat0 + latEnd) / 2, r: (latEnd - lat0) / 2 + 6 }); }
    const st = { sA, sB, side, lat0, latEnd, topH, canopyH };
    STANDS.push(st);
    return st;
  }
  // tribuna principal partida en la línea de meta: ahí apoya la pata del Arco Solar (gran entrada)
  const MAIN0 = buildStand(mainStand.s0 + 5, -10, mainStand.side || 1, 14, 16);
  const MAIN = buildStand(10, mainStand.s1 - 5, mainStand.side || 1, 14, 16);
  MAIN.sA0 = MAIN0.sA;
  const HPS = buildStand(hpStand.s0, hpStand.s1 + 25, hpStand.side || 1, 9, 14, { seatA: '#d07a2e', seatB: '#f0e2c4' });
  let BOWLS = null;
  if (bowl) BOWLS = buildStand(bowl.s0 + 40, bowl.s0 + 140, -bowl.dir, 8, 12, { seatA: '#b8462c', seatB: '#ead6b4' });

  // ---- Arco Solar: pórtico de salida (patas fuera de escapatoria + 3 m) ----
  const GANTRY = [];
  {
    at(0);
    const i0 = tp.i, gx = tp.x, gz = tp.z, gy = tp.y, nx = tp.nx, nz = tp.nz, tx = tp.tx, tz = tp.tz;
    const latL = Math.max(T.w[i0] + T.runoffW[i0], wallAtI(i0, 1)) + 4.5, latR = -(Math.max(T.w[i0] + T.runoffW[i0], wallAtI(i0, -1)) + 4.5);
    const pts = [];
    for (let k = 0; k <= 24; k++) {
      const u = k / 24, lat = lerp(latL, latR, u);
      const y = gy + 24 * Math.sin(Math.PI * u) ** 0.8;
      pts.push(new THREE.Vector3(gx + nx * lat, y, gz + nz * lat));
    }
    const gold = C('#f0b54e');
    bagStatic.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 1.05, 8, false), null, gold, false);
    bagStatic.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => p.clone().addScaledVector(_v1.set(tx, 0, tz), 2.6))), 40, 0.55, 6, false), null, C('#b98236'), false);
    for (const lat of [latL, latR]) bagStatic.add(new THREE.CylinderGeometry(2.4, 3.0, 1.6, 8), M(gx + nx * lat, gy + 0.6, gz + nz * lat), C('#8c6a4a'));
    // viga de semáforos colgada (gálibo ≥ 8 m)
    const beamY = gy + 9.4, yaw = Math.atan2(tx, tz);
    bagStatic.add(new THREE.BoxGeometry(23, 1.9, 1.3), M(gx, beamY, gz, yaw), C('#2a2320'));
    for (const lat of [-9, 9]) bagStatic.add(new THREE.CylinderGeometry(0.08, 0.08, 24 * Math.sin(Math.PI * (latL - lat) / (latL - latR)) ** 0.8 - 10.3, 4), M(gx + nx * lat, beamY + 1 + (24 * Math.sin(Math.PI * (latL - lat) / (latL - latR)) ** 0.8 - 10.3) / 2, gz + nz * lat), C('#3a3330'));
    for (let c = 0; c < 5; c++) for (let r = 0; r < 2; r++) {
      const lat = 4.4 - c * 2.2; // columna 0 a la izquierda del piloto
      const px = gx + nx * lat - tx * 0.72, pz = gz + nz * lat - tz * 0.72, py = beamY + 0.45 - r * 0.95;
      GANTRY.push(GLOW(px - tx * 0.4, py, pz - tz * 0.4, 1.6, 0.12, 0.01, 0.02));
      bagEmis.add(new THREE.CircleGeometry(0.36, 10), M(px + tx * 0.06, py, pz + tz * 0.06, yaw + Math.PI), new THREE.Color(0.25, 0.02, 0.03));
    }
    GANTRY.meta = { x: gx, y: beamY + 2.4, z: gz, yaw };
    reserved.push({ x: gx + nx * latL, z: gz + nz * latL, r: 5 }, { x: gx + nx * latR, z: gz + nz * latR, r: 5 });
    // hueco para la pata en el edificio de boxes
    GANTRY.gap = 9;
  }

  // ---- edificio de boxes (detrás de lat1 + 3 m) ----
  {
    const side = PIT.side, l0 = Math.abs(PIT.lat1) + 3.3, l1 = l0 + 19;
    const segs = [[PIT.s0 + 12, -GANTRY.gap], [GANTRY.gap, PIT.s1 - 10]];
    const white = C('#efe4d0'), sand = C('#d7b48a'), glassC = C('#2c3640'), terr = C('#b5562f');
    for (const [a, b] of segs) {
      if (b - a < 10) continue;
      sweep(bagStatic, a, b, 10, [[side * l0, 0], [side * l0, 4.8], [side * (l0 + 1.5), 4.8], [side * (l0 + 1.5), 9.2], [side * (l0 - 2.5), 9.6], [side * (l1 + 1), 9.6], [side * l1, 0]].map((p, k) => p),
        (k) => [white, white, glassC, white, sand, sand][k] || sand);
      // tejadillo de lona con ondas
      sweep(bagEmis, a, b, 5, [[side * (l0 + 1.0), 10.6], [side * (l0 + 7), 12.6], [side * (l1 - 3), 11.2]], (k) => new THREE.Color(0.78, 0.6, 0.46).multiplyScalar(k ? 0.85 : 1), (o) => o.y + 0.8 * Math.sin(o.i * 0.21));
      // portones (interior iluminado) y ventanal superior
      for (let s = a + 6; s < b - 6; s += 12.5) {
        at(s);
        const x = tp.x + tp.nx * side * (l0 - 0.05), z = tp.z + tp.nz * side * (l0 - 0.05), yaw = Math.atan2(tp.tx, tp.tz) + Math.PI / 2;
        bagEmis.add(new THREE.PlaneGeometry(9, 3.7), M(x, tp.y + 2.1, z, yaw), new THREE.Color(1.15, 0.78, 0.5));
        bagEmis.add(new THREE.PlaneGeometry(10.5, 0.5), M(x, tp.y + 4.45, z, yaw), new THREE.Color(...[[2.2, 0.4, 0.2], [0.3, 1.2, 2.2], [2.2, 1.6, 0.3], [0.5, 2.0, 0.8], [2.0, 0.5, 1.6], [1.6, 0.9, 2.2]][Math.floor((s - a) / 12.5) % 6]));
      }
      sweep(bagEmis, a + 2, b - 2, 10, [[side * (l0 + 1.42), 5.6], [side * (l0 + 1.42), 8.5]], () => new THREE.Color(0.95, 0.62, 0.38));
      const p0 = trackRelPoint(a, side * l0), p1 = trackRelPoint(b, side * l1);
      occ(p0[0], p0[1], p0[2], p1[0], p1[1] + 12, p1[2]);
      for (let s = a; s <= b; s += 10) { at(s); reserved.push({ x: tp.x + tp.nx * side * (l0 + l1) / 2, z: tp.z + tp.nz * side * (l0 + l1) / 2, r: 14 }); }
    }
    // torre de control de carrera
    const ts = (PIT.s0 + PIT.s1) / 2 + 40; at(ts);
    const cx = tp.x + tp.nx * side * (l1 + 9), cz = tp.z + tp.nz * side * (l1 + 9), yaw = Math.atan2(tp.tx, tp.tz);
    bagStatic.add(new THREE.CylinderGeometry(4.2, 5.2, 26, 8), M(cx, tp.y + 13, cz), C('#e6d8c0'));
    bagStatic.add(new THREE.CylinderGeometry(10, 7, 6, 8), M(cx, tp.y + 29, cz, yaw), C('#3a3a40'));
    bagStatic.add(new THREE.CylinderGeometry(10.6, 10.6, 0.6, 8), M(cx, tp.y + 32.3, cz, yaw), C('#efe6d6'));
    bagEmis.add(new THREE.CylinderGeometry(9.2, 7.6, 2.6, 8, 1, true), M(cx, tp.y + 29, cz, yaw), new THREE.Color(1.3, 0.85, 0.5));
    GLOW(cx, tp.y + 36, cz, 3, 2.2, 0.2, 0.15, 1.2, 0);
    bagStatic.add(new THREE.CylinderGeometry(0.15, 0.15, 4, 4), M(cx, tp.y + 34.5, cz), C('#3a3a40'));
    occ(cx - 10, tp.y, cz - 10, cx + 10, tp.y + 33, cz + 10);
    reserved.push({ x: cx, z: cz, r: 14 });
    // paddock: carpas de hospitalidad y camiones de equipo
    const teamCols = ['#22e4ff', '#ff4a2e', '#2bff88', '#ff2fb3', '#ffcc33', '#8b5cff'];
    for (let k = 0; k < 12; k++) {
      const s = PIT.s0 + 30 + k * ((PIT.s1 - PIT.s0 - 60) / 11); at(s);
      const lat = side * (l1 + 16 + (k % 2) * 10), x = tp.x + tp.nx * lat, z = tp.z + tp.nz * lat, yaw = Math.atan2(tp.tx, tp.tz);
      if (Math.hypot(x - cx, z - cz) < 16) continue;
      if (k % 2 === 0) {
        bagStatic.add(new THREE.BoxGeometry(2.6, 3.6, 13), M(x, tp.y + 2.2, z, yaw), C(teamCols[(k / 2) % 6]).lerp(C('#ffffff'), 0.15));
        bagStatic.add(new THREE.BoxGeometry(2.6, 3.0, 3.2), M(x + tp.tx * 8.4, tp.y + 1.9, z + tp.tz * 8.4, yaw), C('#e9e4dc'));
      } else {
        bagStatic.add(new THREE.ConeGeometry(6.5, 4.5, 4, 1, true), M(x, tp.y + 5.6, z, yaw + Math.PI / 4), C('#f8f2e6'));
        bagStatic.add(new THREE.BoxGeometry(8.6, 3.4, 8.6), M(x, tp.y + 1.7, z, yaw), C('#efe6d5'));
        GLOW(x, tp.y + 3.6, z, 6, 1.0, 0.6, 0.3);
      }
    }
  }

  // ---- podio (plaza frente al oasis; mira a +z, hacia la pista y el sol) ----
  const podium = (() => {
    const x0 = PODIUM.x, z0 = PODIUM.z, y0 = 0.3;
    const yaw = 0; // los coches miran hacia +z
    const stone = C('#e7d3b1'), dark = C('#5a3b2a'), gold = C('#e0aa4a');
    bagStatic.add(new THREE.BoxGeometry(23, 0.6, 13), M(x0, y0 + 0.3, z0 - 1), C('#cdb08a'));
    const steps = [[0, 2.0], [-5.4, 1.35], [5.4, 0.85]];
    steps.forEach(([dx, h], k) => {
      bagStatic.add(new THREE.BoxGeometry(5.0, h, 7.0), M(x0 + dx, y0 + 0.6 + h / 2, z0), k === 0 ? gold : stone);
      bagEmis.add(new THREE.PlaneGeometry(4.8, 0.16), M(x0 + dx, y0 + 0.6 + h - 0.15, z0 + 3.51), new THREE.Color(2.0, 1.3, 0.55));
    });
    // fondo: muro con disco solar
    bagStatic.add(new THREE.BoxGeometry(26, 9, 1.2), M(x0, y0 + 4.5, z0 - 7.6), C('#d9c09a'));
    bagStatic.add(new THREE.CircleGeometry(7.4, 32, 0, Math.PI), M(x0, y0 + 9.0, z0 - 7.0), gold);
    for (let k = 0; k < 9; k++) { const a = (k + 0.5) / 9 * Math.PI; bagStatic.add(new THREE.BoxGeometry(0.5, 3.2, 0.3), M(x0 + Math.cos(a) * 9.6, y0 + 9 + Math.sin(a) * 9.6, z0 - 7.1, 0, 1, 1, 1, 0, a - Math.PI / 2), gold); }
    bagEmis.add(new THREE.RingGeometry(7.6, 7.85, 40, 1, 0, Math.PI), M(x0, y0 + 9, z0 - 6.95), new THREE.Color(1.3, 0.8, 0.32));
    for (const dx of [-14, 14]) bagStatic.add(new THREE.BoxGeometry(1.2, 13, 1.2), M(x0 + dx, y0 + 6.5, z0 - 7.4), dark);
    occ(x0 - 13, y0, z0 - 8.5, x0 + 13, y0 + 17, z0 - 6.8);
    reserved.push({ x: x0, z: z0, r: 22 }, { x: x0, z: z0 + 22, r: 12 });
    const slots = steps.map(([dx, h]) => ({ x: x0 + dx, y: y0 + 0.6 + h, z: z0, yaw }));
    return { x: x0, y: y0 + 0.6, z: z0, yaw, slots };
  })();

  // ---- hotel escalonado, torres de viento, cúpulas, torre-vela ----
  {
    const hx = LAKE.x + 10, hz = LAKE.z - 112, y0 = 0.2;
    const adobe = C('#d9a679'), adobe2 = C('#c98f62'), cream = C('#efdcbc');
    for (let lv = 0; lv < 5; lv++) {
      const w = 150 - lv * 16, d = 46 - lv * 7, h = 5.2;
      bagStatic.add(new THREE.BoxGeometry(w, h, d), M(hx, y0 + h * (lv + 0.5), hz), lv % 2 ? adobe2 : adobe);
      bagStatic.add(new THREE.BoxGeometry(w + 0.6, 0.5, d + 0.6), M(hx, y0 + h * (lv + 1) + 0.1, hz), cream);
      // ventanas cálidas en la fachada que mira al lago (+z)
      for (let k = 0; k < Math.floor(w / 6); k++) {
        if (hash2(lv * 31 + k, 7) < 0.25) continue;
        const wx = hx - w / 2 + 3 + k * 6;
        const lit = hash2(k, lv) < 0.7;
        bagEmis.add(new THREE.PlaneGeometry(3.2, 2.2), M(wx, y0 + h * lv + 2.6, hz + d / 2 + 0.05), lit ? new THREE.Color(1.5, 0.95, 0.5) : new THREE.Color(0.18, 0.12, 0.1));
      }
    }
    occ(hx - 75, y0, hz - 23, hx + 75, y0 + 27, hz + 23);
    for (const dx of [-62, -22, 22, 62]) {
      const tx = hx + dx, tz = hz + 14;
      bagStatic.add(new THREE.BoxGeometry(7, 40, 7), M(tx, y0 + 20, tz), adobe);
      bagStatic.add(new THREE.BoxGeometry(8, 1.2, 8), M(tx, y0 + 40.6, tz), cream);
      for (const [ox, oz] of [[3.55, 0], [-3.55, 0], [0, 3.55], [0, -3.55]]) bagStatic.add(new THREE.BoxGeometry(ox ? 0.1 : 4.2, 5, oz ? 0.1 : 4.2), M(tx + ox * 1.002, y0 + 36, tz + oz * 1.002), C('#3a2418'));
    }
    // torre-vela (hotel de lujo) con espina dorada
    const sx = hx + 105, sz = hz - 10;
    const shape = new THREE.Shape();
    shape.moveTo(-14, 0); shape.quadraticCurveTo(0, 13, 14, 0); shape.quadraticCurveTo(0, 6, -14, 0);
    const sail = new THREE.ExtrudeGeometry(shape, { depth: 82, bevelEnabled: false, curveSegments: 8 });
    const sp = sail.attributes.position;
    for (let k = 0; k < sp.count; k++) { const zz = sp.getZ(k), f = 1 - (zz / 82) * 0.55; sp.setX(k, sp.getX(k) * f); sp.setY(k, sp.getY(k) * f); }
    bagStatic.add(sail, M(sx, y0, sz, 0, 1, 1, 1, -Math.PI / 2), (x, y) => C('#9fb4c2').lerp(C('#ffd7a0'), clamp((y - 10) / 90, 0, 0.6)));
    bagStatic.add(new THREE.CylinderGeometry(0.8, 1.4, 96, 6), M(sx, y0 + 48, sz - 2), C('#d6a24c'));
    GLOW(sx, y0 + 97, sz - 2, 5, 2.4, 0.3, 0.2, 1.0, 1.3);
    occ(sx - 15, y0, sz - 14, sx + 15, y0 + 90, sz + 3);
    for (let k = 0; k < 10; k++) bagEmis.add(new THREE.PlaneGeometry(14 - k * 0.7, 0.35), M(sx, y0 + 8 + k * 7.5, sz + 6.6 - k * 0.32), new THREE.Color(1.6, 1.0, 0.55));
    // cúpulas
    for (const [dx, dz, r] of [[-130, 30, 13], [150, 55, 10], [-170, 80, 8], [95, -55, 9]]) {
      bagStatic.add(new THREE.SphereGeometry(r, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2), M(LAKE.x + dx, y0, LAKE.z + dz), C('#f1e4cc'), false);
      bagStatic.add(new THREE.CylinderGeometry(r * 1.02, r * 1.02, 1.2, 14), M(LAKE.x + dx, y0 + 0.6, LAKE.z + dz), C('#c58b5c'));
      bagStatic.add(new THREE.CylinderGeometry(0.3, 0.6, 3, 5), M(LAKE.x + dx, y0 + r + 1.2, LAKE.z + dz), C('#d6a24c'));
      occ(LAKE.x + dx - r, y0, LAKE.z + dz - r, LAKE.x + dx + r, y0 + r, LAKE.z + dz + r);
    }
    // embarcadero
    bagStatic.add(new THREE.BoxGeometry(4, 0.4, 40), M(LAKE.x - 20, -0.5, LAKE.z + 30), C('#8a5a3a'));
  }

  // ---- molinos de viento sobre la cresta sur ----
  const TURB = [];
  {
    const n = tier === 'low' ? 5 : 7;
    for (let k = 0; k < n; k++) {
      const x = -720 + k * 175 + R(-30, 30), z = 905 + R(-40, 40) + (k % 2) * 60;
      const y = groundAt(x, z), hub = 82;
      bagStatic.add(new THREE.CylinderGeometry(1.5, 2.8, hub, 10), M(x, y + hub / 2, z), C('#ece8e2'), false);
      const yaw = Math.atan2(-WIND.x, -WIND.y);
      bagStatic.add(new THREE.BoxGeometry(3.4, 3.4, 10), M(x, y + hub + 1, z, yaw), C('#f2efe9'));
      TURB.push({ x: x + Math.sin(yaw) * 5.6, y: y + hub + 1, z: z + Math.cos(yaw) * 5.6, yaw, a: R(0, 6), w: R(0.8, 1.15) });
      GLOW(x - Math.sin(yaw) * 4, y + hub + 3.2, z - Math.cos(yaw) * 4, 3.5, 2.5, 0.15, 0.1, 1.0, k * 0.7);
    }
  }

  // ---- carteles (atlas) ----
  const SPONSORS = [['SOLARIA', '#ffb03a', '#2a1a12'], ['DUNAR', '#fff3dc', '#b5401f'], ['ESPEJISMO', '#2a1a12', '#ffd27a'], ['OASIS GT', '#ffffff', '#1d6f74'], ['VIENTO SUR', '#ffe9c2', '#5b2a6e'], ['ARENA ROJA', '#ffffff', '#c23a22'], ['CACTO COLA', '#1b3a1a', '#9be36a'], ['SOL NEGRO', '#ffb03a', '#111111']];
  const atlas = own(canvasTex(1024, 1024, (x, w, h) => {
    x.fillStyle = '#20140e'; x.fillRect(0, 0, w, h);
    // 0: gran rótulo (1024×128)
    let g = x.createLinearGradient(0, 0, w, 0); g.addColorStop(0, '#5a1d12'); g.addColorStop(0.5, '#a33a17'); g.addColorStop(1, '#5a1d12');
    x.fillStyle = g; x.fillRect(0, 0, w, 128);
    x.font = '900 82px Outfit, Arial Black, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = '#ffd27a'; x.shadowColor = '#ff8a2a'; x.shadowBlur = 16; x.fillText('DESIERTO SOLAR', w / 2, 68); x.shadowBlur = 0;
    // 1: META (1024×96 a y=128)
    const n = 32, cw = w / n, ch = 96 / 4;
    for (let i = 0; i < n; i++) for (let j = 0; j < 4; j++) { x.fillStyle = (i + j) % 2 ? '#111' : '#f4efe6'; x.fillRect(i * cw, 128 + j * ch, cw, ch); }
    x.fillStyle = 'rgba(20,10,6,.92)'; x.fillRect(w * 0.3, 136, w * 0.4, 80);
    x.font = '900 60px Outfit, Arial Black, sans-serif'; x.fillStyle = '#ffcc55'; x.fillText('META', w / 2, 178);
    // 2..9: patrocinadores (512×96) en 4 filas × 2 columnas desde y=224
    SPONSORS.forEach(([t, fg, bg], k) => {
      const cx = (k % 2) * 512, cy = 224 + Math.floor(k / 2) * 96;
      x.fillStyle = bg; x.fillRect(cx + 4, cy + 4, 504, 88);
      x.strokeStyle = fg; x.lineWidth = 4; x.strokeRect(cx + 12, cy + 12, 488, 72);
      x.font = '900 52px Outfit, Arial Black, sans-serif'; x.fillStyle = fg; x.fillText(t, cx + 256, cy + 50, 460);
    });
    // 10..12: carteles de frenada 150/100/50 (256×256 a y=608)
    ['150', '100', '50'].forEach((t, k) => {
      const cx = k * 256, cy = 608;
      x.fillStyle = '#f6f1e6'; x.fillRect(cx + 8, cy + 8, 240, 240);
      x.fillStyle = '#c23a22'; x.fillRect(cx + 8, cy + 8, 240, 40); x.fillRect(cx + 8, cy + 208, 240, 40);
      x.font = '900 120px Outfit, Arial Black, sans-serif'; x.fillStyle = '#151515'; x.fillText(t, cx + 128, cy + 132);
    });
    // 13: chevrones (256×256 a 768,608)
    x.fillStyle = '#151515'; x.fillRect(776, 616, 240, 240);
    x.fillStyle = '#ffb03a';
    for (let k = 0; k < 3; k++) { x.beginPath(); const ox = 800 + k * 70; x.moveTo(ox, 640); x.lineTo(ox + 40, 640); x.lineTo(ox + 80, 736); x.lineTo(ox + 40, 832); x.lineTo(ox, 832); x.lineTo(ox + 40, 736); x.closePath(); x.fill(); }
    // 14: números del podio (1024×160 a y=864)
    ['2', '1', '3'].forEach((t, k) => { x.fillStyle = '#e0aa4a'; x.font = '900 140px Outfit, Arial Black, sans-serif'; x.fillText(t, 170 + k * 342, 948); });
  }));
  atlas.anisotropy = 8;
  const RECTS = { title: [0, 0, 1024, 128], meta: [0, 128, 1024, 96], board: [150, 100, 50].map((_, k) => [k * 256 + 8, 608 + 8, 240, 240]), chevron: [776, 616, 240, 240], pod: [0, 864, 1024, 160] };
  SPONSORS.forEach((_, k) => { RECTS['sp' + k] = [(k % 2) * 512 + 4, 224 + Math.floor(k / 2) * 96 + 4, 504, 88]; });
  const signParts = [];
  function sign(rect, w, h, m, color = 1) {
    const g = new THREE.PlaneGeometry(w, h);
    const uv = g.attributes.uv, [rx, ry, rw, rh] = rect;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, (rx + uv.getX(k) * rw) / 1024, 1 - (ry + (1 - uv.getY(k)) * rh) / 1024);
    g.applyMatrix4(m);
    const c = new Float32Array(uv.count * 3).fill(color); g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    signParts.push(g);
  }
  {
    // rótulo sobre la tribuna principal
    at((MAIN.sA + MAIN.sB) / 2);
    const side = MAIN.side, yaw = Math.atan2(-tp.nx * side, -tp.nz * side);
    sign(RECTS.title, 50, 6.25, M(tp.x + tp.nx * side * (MAIN.lat0 - 1.6), tp.y + MAIN.topH + 6.0, tp.z + tp.nz * side * (MAIN.lat0 - 1.6), yaw));
    // META en el pórtico (dos caras)
    const gm = GANTRY.meta;
    const gtx = Math.sin(gm.yaw), gtz = Math.cos(gm.yaw);
    sign(RECTS.meta, 20, 1.9, M(gm.x - gtx * 0.67, gm.y - 0.1, gm.z - gtz * 0.67, gm.yaw + Math.PI));
    sign(RECTS.meta, 20, 1.9, M(gm.x + gtx * 0.67, gm.y - 0.1, gm.z + gtz * 0.67, gm.yaw));
    // números del podio
    const P = podium;
    [[-5.4, 1], [0, 0], [5.4, 2]].forEach(([dx, k], q) => {
      const h = [2.0, 1.35, 0.85][k];
      sign([k === 1 ? 0 : k === 0 ? 342 : 684, 864, 340, 160], 3.4, 1.6, M(P.x + dx, 0.3 + 0.6 + h * 0.5, P.z + 3.52, 0), 1.2);
    });
    sign(RECTS.title, 19, 2.4, M(P.x, 0.3 + 7.2, P.z - 6.95, 0));
    // vallas publicitarias a lo largo de las rectas (fuera de la barrera)
    const boards = [];
    for (let s = 40; s < TL; s += 95) {
      at(s); if (Math.abs(tp.k) > 1 / 300) continue;
      if (s > MAIN.sA0 - 20 && s < MAIN.sB + 20) continue;
      const side = (Math.floor(s / 95) % 2) ? 1 : -1;
      if (s > wrapS(PIT.s0) - 10 || s < PIT.s1 + 10) if (side === PIT.side) continue;
      const lat = side * (wallAtI(tp.i, side) + 4.2), x = tp.x + tp.nx * lat, z = tp.z + tp.nz * lat;
      if (!clearAt(x, z, 1)) continue;
      boards.push([x, tp.y, z, Math.atan2(-tp.nx * side, -tp.nz * side), Math.floor(s / 95) % SPONSORS.length]);
    }
    boards.forEach(([x, y, z, yaw, k]) => {
      const gy = groundAt(x, z);
      sign(RECTS['sp' + k], 12, 2.1, M(x, gy + 2.6, z, yaw));
      bagStatic.add(new THREE.BoxGeometry(12.4, 2.5, 0.3), M(x - Math.sin(yaw) * 0.18, gy + 2.6, z - Math.cos(yaw) * 0.18, yaw), C('#2a201a'));
      for (const d of [-5, 5]) bagStatic.add(new THREE.BoxGeometry(0.25, 1.6, 0.25), M(x + Math.cos(yaw) * d, gy + 0.8, z - Math.sin(yaw) * d, yaw), C('#3a2e26'));
    });
    // carteles de frenada antes de la horquilla (por fuera)
    const hs = hairpin.s0 - 20, hside = -hairpin.dir;
    [150, 100, 50].forEach((d, k) => {
      at(hs - d); const lat = hside * (wallAtI(tp.i, hside) + 3.6), x = tp.x + tp.nx * lat, z = tp.z + tp.nz * lat, yaw = Math.atan2(-tp.tx, -tp.tz);
      const gy = groundAt(x, z);
      sign(RECTS.board[k], 2.6, 2.6, M(x, gy + 2.2, z, yaw));
      bagStatic.add(new THREE.BoxGeometry(0.2, 2.2, 0.2), M(x, gy + 0.6, z, yaw), C('#3a2e26'));
    });
    // chevrones por fuera de la horquilla y de T1
    for (const c of [hairpin, t1c]) {
      const side = -c.dir;
      for (let s = c.apex - 25; s <= c.apex + 25; s += 12.5) {
        at(s); const lat = side * (wallAtI(tp.i, side) + 3.4), x = tp.x + tp.nx * lat, z = tp.z + tp.nz * lat;
        if (!clearAt(x, z, 0.5)) continue;
        const yaw = Math.atan2(-tp.nx * side, -tp.nz * side), gy = groundAt(x, z);
        sign(RECTS.chevron, 2.4, 2.4, M(x, gy + 1.7, z, yaw, c.dir > 0 ? -1 : 1));
      }
    }
  }

  // ---- marcadores TV: plataformas ----
  const tvCams = [];
  function tvCam(s, side, extra = 6, h = 8) {
    at(s); const lat = side * (wallAtI(tp.i, side) + extra), x = tp.x + tp.nx * lat, z = tp.z + tp.nz * lat;
    for (const c of reserved) if ((x - c.x) ** 2 + (z - c.z) ** 2 < c.r * c.r) return;
    let gy = groundAt(x, z), y = Math.max(gy + 3, tp.y + h), onRock = false;
    // sobre rocas: por encima de la más alta de alrededor (sin voladizos encima)
    for (const r of solids) if ((x - r.x) ** 2 + (z - r.z) ** 2 < (r.r + 10) ** 2 && r.top + 4 > y) { y = r.top + 4; onRock = true; }
    if (canyon.arch && Math.hypot(x - canyon.arch.x, z - canyon.arch.z) < 30) y = Math.max(y, canyon.arch.y + 32);
    tvCams.push({ x, y, z, s: wrapS(s), side });
    reserved.push({ x, z, r: 5 });
    if (onRock) return;
    // andamio de cámara, detrás del punto de vista (nunca en plano)
    const bx = x + tp.nx * side * 2.6, bz = z + tp.nz * side * 2.6, top = y - 2.4;
    bagStatic.add(new THREE.BoxGeometry(2.2, 0.25, 2.2), M(bx, top, bz), C('#5a4a3e'));
    for (const [ox, oz] of [[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]]) bagStatic.add(new THREE.BoxGeometry(0.14, top - gy, 0.14), M(bx + ox, (top + gy) / 2, bz + oz), C('#6a5a4e'));
    bagStatic.add(new THREE.BoxGeometry(0.5, 0.5, 1.1), M(bx, top + 0.45, bz, Math.atan2(-tp.nx * side, -tp.nz * side)), C('#202020'));
  }
  {
    tvCam(-70, 1, 4, 10);
    tvCam(PIT.s1 + 30, -1, 6, 9);
    for (const c of T.corners) {
      tvCam(c.apex, -c.dir, 7, c.kind === 'horquilla' ? 9 : 8);
      if (c.R < 90) tvCam(c.s0 - 40, c.dir, 6, 7);
    }
    // rectas largas
    for (let s = 0; s < TL; s += 40) {
      at(s); if (Math.abs(tp.k) > 1 / 500) continue;
      if (tvCams.some((c) => Math.abs(((c.s - s + TL * 1.5) % TL) - TL / 2) < 220)) continue;
      tvCam(s, (Math.floor(s / 40) % 2) ? 1 : -1, 6, 7);
    }
  }

  /* =====================================================================
     FLORA: palmeras (instanciadas, con vaivén), cactus y matojos (fusionados)
     ===================================================================== */
  const palmPts = [];
  function tryPalm(x, z, s = R(0.8, 1.25)) { if (!clearAt(x, z, 2.5)) return false; palmPts.push([x, groundAt(x, z), z, s]); return true; }
  {
    const want = Q.palms;
    // orilla de los lagos
    for (const L of [LAKE, LAKE2]) {
      const n = L === LAKE ? Math.floor(want * 0.45) : Math.floor(want * 0.18);
      for (let k = 0, tries = 0; k < n && tries < n * 10; tries++) {
        const a = R(0, Math.PI * 2), q = R(1.05, 1.5);
        if (tryPalm(L.x + Math.cos(a) * L.rx * q, L.z + Math.sin(a) * L.rz * q)) k++;
      }
    }
    // paseo tras la tribuna principal y plaza del podio
    for (let s = MAIN.sA0; s < MAIN.sB; s += 13) { at(s); const lat = MAIN.side * (MAIN.latEnd + 8 + R(0, 3)); tryPalm(tp.x + tp.nx * lat, tp.z + tp.nz * lat, R(1.0, 1.3)); }
    for (const dx of [-17, -15.5, 15.5, 17]) tryPalm(podium.x + dx, podium.z - 4 + R(-2, 2), 1.15);
    // paddock
    for (let k = 0, tries = 0; k < 12 && tries < 100; tries++) { const s = R(PIT.s0, PIT.s1); at(s); const lat = PIT.side * R(55, 80); if (tryPalm(tp.x + tp.nx * lat, tp.z + tp.nz * lat)) k++; }
    while (palmPts.length > want) palmPts.splice(Math.floor(rnd() * palmPts.length), 1);
  }
  let palms = null;
  {
    const parts = [];
    const trunk = new THREE.CylinderGeometry(0.22, 0.38, 9, 5, 5, true).translate(0, 4.5, 0);
    const tp2 = trunk.attributes.position;
    for (let k = 0; k < tp2.count; k++) { const y = tp2.getY(k); tp2.setX(k, tp2.getX(k) + (y / 9) ** 2 * 0.9); tp2.setX(k, tp2.getX(k) * (1 + 0.12 * Math.max(0, Math.sin(y * 3.2)))); }
    parts.push([trunk, (x, y) => C('#7a5638').multiplyScalar(0.8 + 0.25 * Math.max(0, Math.sin(y * 3.2)))]);
    const nF = 8;
    for (let f = 0; f < nF; f++) {
      const a = (f / nF) * Math.PI * 2 + (f % 2) * 0.2, len = 4.6 + (f % 3) * 0.5, droop = 0.55 + (f % 2) * 0.25;
      const pos = [], idx = [];
      const segs = 4;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs, r = t * len, y = 9 + Math.sin(t * 1.6) * 1.0 - t * t * droop * 4.2, w = Math.sin(t * Math.PI) * 0.95 + 0.06;
        const cx = 0.9 + Math.cos(a) * r, cz = Math.sin(a) * r;
        pos.push(cx - Math.sin(a) * w, y - w * 0.25, cz + Math.cos(a) * w, cx + Math.sin(a) * w, y - w * 0.25, cz - Math.cos(a) * w, cx, y + 0.12, cz);
        if (i < segs) { const b = i * 3, n2 = b + 3; idx.push(b, n2, b + 2, b + 2, n2, n2 + 2, b + 2, n2 + 2, b + 1, b + 1, n2 + 2, n2 + 1); }
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
      parts.push([g, (x, y, z) => { const t = Math.hypot(x - 0.9, z) / len; return C('#4f7d2a').lerp(C('#a7a24a'), t * 0.55).multiplyScalar(0.85 + 0.2 * (f % 2)); }]);
    }
    parts.push([new THREE.IcosahedronGeometry(0.55, 0).translate(0.9, 8.7, 0), () => C('#6a4a22')]);
    const bagP = makeBag(); parts.forEach(([g, c]) => bagP.add(g, null, c, true));
    const geo = mergeGeometries(bagP.parts, false); bagP.parts.forEach((p) => p.dispose());
    const mat = own(patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'palm', {
      vbegin: `{
        float hh = max(position.y - 3.0, 0.0) / 7.0;
        float ph = float(gl_InstanceID) * 2.17;
        float sw = sin(uTime * (1.1 + uGust * 1.6) + ph) * (0.18 + uGust * 0.55) + sin(uTime * 2.9 + ph * 1.7) * 0.05;
        transformed.x += uWind.x * sw * hh * hh * 1.6;
        transformed.z += uWind.y * sw * hh * hh * 1.6;
      }`,
    }));
    palms = new THREE.InstancedMesh(geo, mat, Math.max(1, palmPts.length));
    palmPts.forEach(([x, y, z, s], k) => { palms.setMatrixAt(k, M(x, y - 0.2, z, R(0, 6.28), s, s * R(0.9, 1.2), s, R(-0.06, 0.06), R(-0.06, 0.06))); });
    palms.count = palmPts.length; palms.instanceMatrix.needsUpdate = true;
    own(geo);
  }
  // cactus y matojos (fusionados en "flora")
  {
    const cactC = C('#5f7a3a'), shrubC = C('#8a7a45'), dryC = C('#9c7448');
    let nc = 0, ns = 0;
    for (let tries = 0; (nc < Q.cacti || ns < Q.shrubs) && tries < 6000; tries++) {
      const x = R(-780, 790), z = R(-400, 990);
      if (!clearAt(x, z, 2)) continue;
      if (Math.hypot(x - FIELD.x, z - FIELD.z) < FIELD.r + 12) continue;
      const y = groundAt(x, z);
      if (nc < Q.cacti && rnd() < 0.45) {
        const h = R(3, 7), s = R(0.85, 1.2), ry = R(0, 6.28);
        bagFlora.add(new THREE.CylinderGeometry(0.42, 0.5, h, 7), M(x, y + h / 2, z, ry, s, 1, s), cactC);
        bagFlora.add(new THREE.SphereGeometry(0.42, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2), M(x, y + h, z, ry, s, 1, s), cactC);
        for (let a = 0; a < (h > 4.5 ? 2 : 1); a++) {
          const dir = a ? -1 : 1, ay = y + h * R(0.4, 0.6), ah = R(1.4, 2.4);
          const ox = Math.cos(ry) * dir, oz = -Math.sin(ry) * dir;
          bagFlora.add(new THREE.CylinderGeometry(0.3, 0.3, 1.3, 6), M(x + ox * 0.9, ay, z + oz * 0.9, ry, 1, 1, 1, 0, Math.PI / 2 * dir), cactC);
          bagFlora.add(new THREE.CylinderGeometry(0.3, 0.32, ah, 6), M(x + ox * 1.5, ay + ah / 2, z + oz * 1.5, ry), cactC);
        }
        nc++;
      } else if (ns < Q.shrubs) {
        const r = R(0.6, 1.5);
        bagFlora.add(new THREE.IcosahedronGeometry(r, 0), M(x, y + r * 0.35, z, R(0, 6), 1, R(0.45, 0.7), 1), rnd() < 0.5 ? shrubC : dryC);
        ns++;
      }
    }
  }

  /* =====================================================================
     AGUA (lagos del oasis): refleja el cielo, destellos del sol
     ===================================================================== */
  let water = null;
  {
    const gs = [];
    for (const L of [LAKE, LAKE2]) { const g = new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2); g.scale(L.rx * 1.12, 1, L.rz * 1.12); g.translate(L.x, L.y, L.z); gs.push(g); }
    const geo = mergeGeometries(gs); gs.forEach((g) => g.dispose());
    const mat = new THREE.ShaderMaterial({
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]),
      vertexShader: `varying vec3 vWPos;
        #include <fog_pars_vertex>
        void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vWPos = wp.xyz; vec4 mvPosition = viewMatrix * wp; gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
        }`,
      fragmentShader: `uniform float uTime; uniform vec3 uSunDir; uniform float uStorm; uniform vec3 uHorizon; varying vec3 vWPos;
        #include <common>
        #include <fog_pars_fragment>
        void main(){
          vec3 V = normalize(vWPos - cameraPosition);
          vec2 p = vWPos.xz;
          vec3 N = normalize(vec3(0.0, 1.0, 0.0) + 0.045 * vec3(sin(p.x*0.9 + uTime*1.3) + sin(p.x*0.37 - p.y*0.6 + uTime*0.9), 0.0, cos(p.y*0.8 - uTime*1.1) + sin(p.y*0.31 + p.x*0.5 + uTime*0.7)));
          vec3 r = reflect(V, N);
          float y = clamp(r.y, 0.0, 1.0);
          vec3 sky = mix(uHorizon * 1.05, vec3(0.62, 0.24, 0.32), smoothstep(0.02, 0.25, y));
          sky = mix(sky, vec3(0.06, 0.06, 0.18), smoothstep(0.2, 0.8, y));
          float az = dot(normalize(r.xz + 1e-4), normalize(uSunDir.xz)) * 0.5 + 0.5;
          sky += vec3(1.0, 0.45, 0.12) * pow(az, 5.0) * exp(-y * 6.0) * 0.8;
          float sun = pow(max(dot(r, normalize(uSunDir)), 0.0), 220.0) * 14.0 + pow(max(dot(r, normalize(uSunDir)), 0.0), 18.0) * 0.5;
          float fr = 0.25 + 0.75 * pow(1.0 - max(-V.y, 0.0), 4.0);
          vec3 deep = vec3(0.04, 0.16, 0.17);
          vec3 col = mix(deep, sky, fr) + vec3(1.0, 0.7, 0.4) * sun * (1.0 - uStorm * 0.8);
          col *= 1.0 - uStorm * 0.3;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    Object.assign(mat.uniforms, { uTime: U.uTime, uSunDir: U.uSunDir, uStorm: U.uStorm, uHorizon: U.uHorizon });
    water = new THREE.Mesh(geo, mat);
    own(geo); own(mat);
  }

  /* =====================================================================
     CIELO: degradado, sol enorme, halo, rayos, cirros, velo de tormenta
     ===================================================================== */
  const SKY_FRAG = `
    uniform float uTime; uniform vec3 uSunDir; uniform float uStorm; uniform float uRain;
    uniform vec3 uZenith, uMid, uHorizon, uGlow, uGround, uStormCol, uRainCol, uSunHor, uSunMid;
    varying vec3 vDir;
    float h1(float n){ return fract(sin(n) * 43758.5453); }
    float n1(float x){ float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(h1(i), h1(i + 1.0), f); }
    float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), f.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), f.x), f.y); }
    void main(){
      vec3 d = normalize(vDir);
      vec3 sd = normalize(uSunDir);
      float y = d.y, cs = dot(d, sd);
      float az = dot(normalize(d.xz + 1e-5), normalize(sd.xz)) * 0.5 + 0.5;
      float t = max(y, 0.0);
      // lado opuesto al sol: melocotón → malva → azul
      vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.22, t));
      col = mix(col, vec3(0.09, 0.12, 0.32), smoothstep(0.18, 0.5, t));
      col = mix(col, uZenith, smoothstep(0.45, 0.95, t));
      // lado del sol: oro → naranja → rosa
      vec3 sc = mix(uSunHor, uSunMid, smoothstep(0.0, 0.16, t));
      sc = mix(sc, vec3(0.5, 0.2, 0.25), smoothstep(0.14, 0.42, t));
      col = mix(col, sc, pow(az, 1.2) * (1.0 - smoothstep(0.3, 0.7, t)));
      col += uGlow * pow(az, 4.0) * exp(-t * 9.0) * 0.6;
      // halo de Mie
      float csp = max(cs, 0.0);
      col += uGlow * (pow(csp, 10.0) * 0.55 + pow(csp, 60.0) * 0.6) + vec3(1.0, 0.8, 0.5) * pow(csp, 400.0) * 1.5;
      // rayos crepusculares
      vec3 up = vec3(0.0, 1.0, 0.0);
      vec3 ax = normalize(cross(up, sd)); vec3 ay = cross(sd, ax);
      float ang = atan(dot(d, ay), dot(d, ax));
      float rays = n1(ang * 14.0 + uTime * 0.04) * 0.55 + n1(ang * 37.0 - uTime * 0.07) * 0.45;
      rays = smoothstep(0.42, 0.95, rays);
      float rf = pow(csp, 5.0) * (1.0 - smoothstep(0.9992, 0.99995, cs));
      col += uGlow * rays * rf * 0.75 * smoothstep(-0.05, 0.03, y) * (1.0 - uStorm) * (1.0 - uRain);
      // cirros iluminados desde abajo
      if (y > 0.0) {
        vec2 uv = d.xz / (y + 0.06);
        float grp = n2(uv * 0.22 + 3.7);
        float c1 = n2(uv * vec2(0.35, 4.5) + vec2(uTime * 0.003, 0.0)) * 0.65 + n2(uv * vec2(1.1, 11.0)) * 0.35;
        float cl = smoothstep(0.62, 0.9, c1) * smoothstep(0.45, 0.75, grp) * smoothstep(0.015, 0.06, y) * (1.0 - smoothstep(0.16, 0.34, y));
        vec3 cc = mix(vec3(0.95, 0.42, 0.5), vec3(1.6, 0.85, 0.35), pow(az, 1.5));
        col = mix(col, cc, cl * 0.55 * (1.0 - uStorm));
      }
      // sol enorme (radio ~2.2°), con limbo oscurecido
      float disc = smoothstep(0.99918, 0.99935, cs);
      float limb = smoothstep(0.99918, 0.99985, cs);
      vec3 sunC = mix(vec3(3.2, 1.25, 0.42), vec3(5.0, 3.4, 1.7), limb);
      col = mix(col, sunC * (1.0 - uStorm * 0.75) + uStormCol * uStorm * 0.4, disc * (1.0 - uStorm * 0.55) * (1.0 - uRain));
      // bajo el horizonte: calima del suelo
      col = mix(col, uGround, smoothstep(0.0, -0.05, y));
      // tormenta de arena: velo ocre con remolinos
      if (uStorm > 0.002) {
        float sw = n2(vec2(ang * 3.0 + uTime * 0.25, y * 9.0 - uTime * 0.12)) * 0.5 + n2(d.xz * 6.0 + uTime * 0.2) * 0.5;
        vec3 storm = uStormCol * (0.7 + 0.35 * sw) * (0.75 + 0.45 * az) + uGlow * pow(csp, 8.0) * 0.4;
        col = mix(col, storm, uStorm * (0.85 - 0.25 * smoothstep(0.1, 0.8, y)));
      }
      col = mix(col, uRainCol * (0.8 + 0.25 * az), uRain * 0.85);
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;
  const skyMat = own(new THREE.ShaderMaterial({
    uniforms: {
      uTime: U.uTime, uSunDir: U.uSunDir, uStorm: U.uStorm, uRain: U.uRain,
      uZenith: { value: PAL.zenith }, uMid: { value: PAL.mid }, uSunHor: { value: PAL.sunHor }, uSunMid: { value: PAL.sunMid }, uHorizon: U.uHorizon, uGlow: { value: PAL.glow }, uGround: { value: PAL.ground },
      uStormCol: { value: PAL.storm }, uRainCol: { value: PAL.rainSky },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
  }));
  const skyGeo = own(new THREE.SphereGeometry(1, 48, 24));
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.scale.setScalar(500); sky.frustumCulled = false; sky.renderOrder = -1000; sky.name = 'cielo';

  /* =====================================================================
     HACES de luz del campo solar al receptor + calima sobre las rectas
     ===================================================================== */
  let beams = null;
  {
    const pos = [], aT = [], aA = [];
    const deep = mirrorPts.filter(([x, z]) => beyond(x, z) > 70);
    const nb = Math.min(Q.beams, deep.length);
    for (let k = 0; k < nb; k++) {
      const [x, z] = deep[Math.floor((k / nb) * deep.length + rnd() * 3) % deep.length];
      const a = new THREE.Vector3(x, TOWER.y + 4, z), b = RECV.clone().add(_v1.set(R(-3, 3), R(-5, 5), R(-3, 3)));
      const dir = _v2.subVectors(b, a).normalize();
      for (const cross of [_v3.set(-dir.z, 0, dir.x).normalize(), new THREE.Vector3().crossVectors(dir, _v3).normalize()]) {
        const w0 = 1.6, w1 = 0.5;
        const p0 = a.clone().addScaledVector(cross, -w0), p1 = a.clone().addScaledVector(cross, w0), p2 = b.clone().addScaledVector(cross, w1), p3 = b.clone().addScaledVector(cross, -w1);
        for (const [p, t, s] of [[p0, 0, -1], [p1, 0, 1], [p2, 1, 1], [p0, 0, -1], [p2, 1, 1], [p3, 1, -1]]) { pos.push(p.x, p.y, p.z); aT.push(t); aA.push(s); }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aT', new THREE.Float32BufferAttribute(aT, 1));
    geo.setAttribute('aA', new THREE.Float32BufferAttribute(aA, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      uniforms: { uTime: U.uTime, uStorm: U.uStorm, uAmt: { value: 1 } },
      vertexShader: `attribute float aT; attribute float aA; varying float vT; varying float vA; varying float vD; varying float vI;
        void main(){ vT = aT; vA = aA; vI = float(gl_VertexID / 12); vec4 mv = modelViewMatrix * vec4(position,1.0); vD = -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform float uTime; uniform float uStorm; uniform float uAmt; varying float vT; varying float vA; varying float vD; varying float vI;
        void main(){ float e = 1.0 - abs(vA); e *= e;
          float a = e * (0.25 + 0.75 * vT) * (0.85 + 0.15 * sin(uTime * 2.0 + vI * 3.1 + vT * 8.0)) * smoothstep(8.0, 60.0, vD) * (1.0 - smoothstep(900.0, 1800.0, vD));
          gl_FragColor = vec4(vec3(1.0, 0.72, 0.38) * a * 0.075 * uAmt * (1.0 - uStorm), 1.0); }`,
    });
    beams = new THREE.Mesh(geo, mat); beams.frustumCulled = false; beams.renderOrder = 5;
    own(geo); own(mat);
  }
  // calima (espejismo) sobre las rectas largas: capa transparente sobre el asfalto, sólo visible a lo lejos y rasante
  let haze = null;
  {
    const runs = [];
    let s0 = null;
    for (let s = 0; s <= TL + 1; s += 4) {
      at(s); const straight = Math.abs(tp.k) < 1 / 450;
      if (straight && s0 === null) s0 = s;
      if ((!straight || s >= TL) && s0 !== null) { if (s - s0 > 220) runs.push([s0 + 10, s - 10]); s0 = null; }
    }
    const pos = [], uvs = [];
    for (const [a, b] of runs) {
      const n = Math.ceil((b - a) / 8);
      for (let i = 0; i < n; i++) {
        const sA = a + ((b - a) * i) / n, sB = a + ((b - a) * (i + 1)) / n;
        const P = [];
        for (const s of [sA, sB]) { at(s); const w = tp.w + 0.6; P.push([tp.x + tp.nx * w, tp.y + 0.09, tp.z + tp.nz * w], [tp.x - tp.nx * w, tp.y + 0.09, tp.z - tp.nz * w]); }
        for (const k of [0, 2, 3, 0, 3, 1]) { pos.push(...P[k]); uvs.push(k % 2, k < 2 ? 0 : 1); }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      uniforms: { uTime: U.uTime, uHorizon: U.uHorizon, uMirage: U.uMirage, uStorm: U.uStorm },
      vertexShader: `varying vec3 vWPos; varying vec2 vUv; void main(){ vUv = uv; vec4 wp = modelMatrix * vec4(position,1.0); vWPos = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: `uniform float uTime; uniform vec3 uHorizon; uniform float uMirage; uniform float uStorm; varying vec3 vWPos; varying vec2 vUv;
        void main(){
          vec3 vv = vWPos - cameraPosition; float dist = length(vv); vec3 vd = vv / dist;
          float graze = smoothstep(0.07, 0.008, -vd.y);
          float m = graze * smoothstep(90.0, 360.0, dist) * (1.0 - smoothstep(1500.0, 2400.0, dist));
          float sh = 0.6 + 0.4 * sin(vWPos.x * 0.21 + vWPos.z * 0.13 + uTime * 4.0 + sin(vWPos.z * 0.07 - uTime * 2.0) * 2.0);
          float edge = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x);
          float a = m * (0.45 + 0.4 * sh) * edge * uMirage * (1.0 - uStorm);
          vec3 c = uHorizon * (1.05 + 0.25 * sh);
          gl_FragColor = vec4(c, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    haze = new THREE.Mesh(geo, mat); haze.renderOrder = 2; haze.frustumCulled = false;
    own(geo); own(mat);
  }

  /* =====================================================================
     PÚBLICO (quads con sprites, animado por shader)
     ===================================================================== */
  const crowdTex = own(canvasTex(512, 128, (x, w, h) => {
    x.clearRect(0, 0, w, h);
    for (let k = 0; k < 8; k++) {
      const ox = k * 64, cx = ox + 32;
      const skin = ['#e8b48a', '#c98b5e', '#8a5a3a', '#f0c8a0'][k % 4];
      // cuerpo (blanco → se tiñe con el color de instancia)
      x.fillStyle = '#ffffff';
      x.beginPath(); x.moveTo(cx - 20, 124); x.lineTo(cx - 17, 62); x.quadraticCurveTo(cx, 50, cx + 17, 62); x.lineTo(cx + 20, 124); x.closePath(); x.fill();
      // brazos (algunos levantados)
      x.strokeStyle = '#ffffff'; x.lineWidth = 9; x.lineCap = 'round';
      x.beginPath();
      if (k % 3 === 0) { x.moveTo(cx - 12, 66); x.lineTo(cx - 20, 30); x.moveTo(cx + 12, 66); x.lineTo(cx + 20, 30); }
      else if (k % 3 === 1) { x.moveTo(cx - 12, 66); x.lineTo(cx - 18, 100); x.moveTo(cx + 12, 66); x.lineTo(cx + 22, 36); }
      else { x.moveTo(cx - 12, 66); x.lineTo(cx - 17, 102); x.moveTo(cx + 12, 66); x.lineTo(cx + 17, 102); }
      x.stroke();
      // cabeza
      x.fillStyle = skin; x.beginPath(); x.arc(cx, 42, 13, 0, Math.PI * 2); x.fill();
      if (k % 3 === 0) { x.fillStyle = skin; x.beginPath(); x.arc(cx - 20, 28, 4.5, 0, 7); x.arc(cx + 20, 28, 4.5, 0, 7); x.fill(); }
      // pelo / sombrero / pañuelo
      x.fillStyle = ['#2a1a10', '#f2e6cc', '#4a2a18', '#c23a22', '#111', '#e0aa4a', '#3a2a20', '#ffffff'][k];
      if (k % 2) { x.fillRect(cx - 17, 30, 34, 4); x.fillRect(cx - 10, 22, 20, 9); } else { x.beginPath(); x.arc(cx, 38, 11.5, Math.PI, 0); x.fill(); }
      // sombra inferior
      x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(cx - 15, 112, 30, 12);
    }
  }));
  crowdTex.anisotropy = 4;
  let crowdMesh = null;
  {
    while (CROWD.length > Q.maxCrowd) CROWD.splice(Math.floor(rnd() * CROWD.length), 1);
    const g = new THREE.PlaneGeometry(0.8, 1.6).translate(0, 0.8, 0);
    const mat = new THREE.ShaderMaterial({
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { tMap: { value: null } }]),
      vertexShader: `uniform float uTime; uniform float uExcite; uniform vec3 uSunDir; varying vec2 vUv; varying vec3 vCol; varying float vLit;
        #include <fog_pars_vertex>
        void main(){
          float ph = float(gl_InstanceID) * 1.618;
          float spr = floor(fract(ph * 0.371) * 8.0);
          vUv = vec2((uv.x + spr) / 8.0, uv.y);
          vCol = instanceColor;
          float sp = 5.0 + fract(ph * 3.7) * 5.0;
          float hop = max(0.0, sin(uTime * sp + ph * 6.0));
          vec3 p = position;
          p.y += hop * uExcite * (0.28 + fract(ph * 1.3) * 0.4);
          p.x += sin(uTime * sp * 0.5 + ph) * 0.06 * uExcite * p.y;
          vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
          vec3 fwd = normalize(mat3(instanceMatrix) * vec3(0.0, 0.0, 1.0));
          vLit = 0.55 + 0.6 * max(dot(fwd, normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0);
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `uniform sampler2D tMap; uniform float uStorm; varying vec2 vUv; varying vec3 vCol; varying float vLit;
        #include <common>
        #include <fog_pars_fragment>
        void main(){
          vec4 t = texture2D(tMap, vUv);
          if (t.a < 0.5) discard;
          vec3 base = t.rgb;
          float white = step(0.92, min(base.r, min(base.g, base.b)));
          vec3 c = mix(base, vCol, white) * vLit * (1.0 - uStorm * 0.3);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    mat.uniforms.tMap.value = crowdTex;
    Object.assign(mat.uniforms, { uTime: U.uTime, uExcite: U.uExcite, uSunDir: U.uSunDir, uStorm: U.uStorm });
    crowdMesh = new THREE.InstancedMesh(g, mat, Math.max(1, CROWD.length));
    const pal = ['#f4efe6', '#ffffff', '#c23a22', '#ffb03a', '#1d6f74', '#ff6a3d', '#e9d2ad', '#3a3f6e', '#ffcc33', '#22e4ff', '#ff2fb3', '#2bff88', '#5b2a6e', '#d07a2e'];
    const col = new THREE.Color();
    CROWD.forEach((p, i) => {
      crowdMesh.setMatrixAt(i, M(p.x, p.y, p.z, p.yaw + R(-0.25, 0.25), R(0.92, 1.08), R(0.9, 1.1), 1));
      col.set(pal[Math.floor(rnd() * pal.length)]).multiplyScalar(R(0.75, 1.1));
      crowdMesh.setColorAt(i, col);
    });
    crowdMesh.count = CROWD.length;
    crowdMesh.frustumCulled = false;
    own(g); own(mat);
  }

  /* =====================================================================
     PANTALLA GIGANTE
     ===================================================================== */
  const jumboTex = own(canvasTex(512, 256, () => {}));
  let jumboMesh = null, jumboKey = '';
  function drawJumbo(top = '', big = '', sub = '', color = '#ffcc55') {
    const key = top + '|' + big + '|' + sub + '|' + color;
    if (key === jumboKey) return; jumboKey = key;
    const x = jumboTex.userData.ctx, w = 512, h = 256;
    const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#3a1408'); g.addColorStop(1, '#120604');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.fillStyle = 'rgba(255,170,80,.08)'; for (let i = 0; i < h; i += 4) x.fillRect(0, i, w, 1);
    x.fillStyle = 'rgba(255,190,90,.9)'; x.fillRect(0, 0, w, 6); x.fillRect(0, h - 6, w, 6);
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = '800 26px Outfit, Arial, sans-serif'; x.fillStyle = '#ffb36b'; x.fillText(top, w / 2, 40, w - 30);
    x.font = '900 58px Outfit, Arial Black, sans-serif'; x.fillStyle = color; x.shadowColor = color; x.shadowBlur = 18; x.fillText(big, w / 2, 126, w - 30); x.shadowBlur = 0;
    x.font = '800 28px Outfit, Arial, sans-serif'; x.fillStyle = '#fff3dc'; x.fillText(sub, w / 2, 204, w - 30);
    jumboTex.needsUpdate = true;
  }
  {
    const s = PIT.s1 + 6; at(s);
    const side = PIT.side, lat = side * (Math.abs(PIT.lat1) + 14);
    const x = tp.x + tp.nx * lat, z = tp.z + tp.nz * lat, y = tp.y + 16;
    // mira hacia los coches que llegan (−tangente) y un poco hacia la tribuna
    const fx = -tp.tx * 0.85 + tp.nx * -side * 0.5, fz = -tp.tz * 0.85 + tp.nz * -side * 0.5, yaw = Math.atan2(fx, fz);
    jumboMesh = new THREE.Mesh(own(new THREE.PlaneGeometry(26, 13)), own(new THREE.MeshBasicMaterial({ map: jumboTex, toneMapped: false, color: new THREE.Color(1.15, 1.15, 1.15), fog: true })));
    jumboMesh.position.set(x + Math.sin(yaw) * 0.45, y, z + Math.cos(yaw) * 0.45); jumboMesh.rotation.y = yaw;
    bagStatic.add(new THREE.BoxGeometry(27.6, 14.6, 0.8), M(x, y, z, yaw), C('#2a201a'));
    bagStatic.add(new THREE.BoxGeometry(2.2, y - tp.y - 7, 2.2), M(x - Math.sin(yaw) * 1.2, tp.y + (y - tp.y - 7) / 2, z - Math.cos(yaw) * 1.2), C('#b98236'));
    bagEmis.add(new THREE.BoxGeometry(27.8, 0.25, 0.3), M(x + Math.sin(yaw) * 0.45, y + 7.35, z + Math.cos(yaw) * 0.45, yaw), new THREE.Color(2.4, 1.3, 0.45));
    occ(x - 14, tp.y, z - 14, x + 14, y + 7.5, z + 14);
    drawJumbo('GRAN PREMIO', 'DESIERTO SOLAR', 'Rectas eternas · 4 vueltas', '#ffcc55');
  }

  /* =====================================================================
     VIDA: rotores, dirigible, globos, rodadoras, remolinos, buitres
     ===================================================================== */
  // rotores
  let rotors = null;
  {
    const parts = [new THREE.SphereGeometry(1.6, 8, 6).scale(1, 1, 1.5)];
    for (let b = 0; b < 3; b++) { const g = new THREE.BoxGeometry(1.7, 40, 0.35).translate(0, 21, 0); g.rotateZ((b / 3) * Math.PI * 2); parts.push(g); }
    const bag = makeBag(); parts.forEach((g) => bag.add(g, null, C('#f4f1ec'), true));
    const geo = mergeGeometries(bag.parts, false); bag.parts.forEach((p) => p.dispose());
    rotors = new THREE.InstancedMesh(geo, own(patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'rotor')), Math.max(1, TURB.length));
    rotors.count = TURB.length; rotors.frustumCulled = false;
    own(geo);
  }
  // dirigible
  let blimp = null;
  {
    const bag = makeBag();
    bag.add(new THREE.SphereGeometry(6, 20, 12).scale(1, 1, 4.2), null, (x, y, z) => (Math.abs(y) < 1.1 && Math.abs(z) < 18 ? C('#c23a22') : Math.abs(y + 0.0) < 1.6 && Math.abs(z) < 19 ? C('#ffb03a') : C('#f2ece2')), false);
    for (let k = 0; k < 4; k++) { const g = new THREE.BoxGeometry(0.4, 7, 6).translate(0, 4.5, -21); g.rotateZ((k / 4) * Math.PI * 2 + Math.PI / 4); bag.add(g, null, C('#c23a22'), true); }
    bag.add(new THREE.BoxGeometry(2.6, 2.2, 8), M(0, -6.6, 2), C('#3a3330'));
    const geo = mergeGeometries(bag.parts, false); bag.parts.forEach((p) => p.dispose());
    blimp = new THREE.Mesh(own(geo), own(patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'blimp')));
    blimp.userData = { r: 560, y: 170, a: R(0, 6.28), w: 6.5 / 560 };
    blimp.userData.glow = [GLOW(0, 0, 0, 3.5, 2.6, 0.2, 0.15, 1.4, 0), GLOW(0, 0, 0, 3.5, 0.2, 2.6, 0.4, 1.4, 0.5)];
  }
  // globos aerostáticos
  let balloons = null; const BAL = [];
  {
    const prof = []; for (let k = 0; k <= 12; k++) { const t = k / 12, a = t * Math.PI; const r = Math.sin(a) ** 0.9 * (t > 0.5 ? 1 : 0.62 + 0.38 * Math.sin(a)) * 9; prof.push(new THREE.Vector2(Math.max(0.6, r), -9 + 22 * (1 - Math.cos(a * 0.92)) * 0.5)); }
    prof.reverse();
    const env = new THREE.LatheGeometry(prof, 16).toNonIndexed();
    const mask = new Float32Array(env.attributes.position.count);
    const pa = env.attributes.position.array;
    for (let i = 0; i < mask.length; i += 3) { const cx = (pa[i * 3] + pa[i * 3 + 3] + pa[i * 3 + 6]) / 3, cz = (pa[i * 3 + 2] + pa[i * 3 + 5] + pa[i * 3 + 8]) / 3, cy = (pa[i * 3 + 1] + pa[i * 3 + 4] + pa[i * 3 + 7]) / 3; const a = Math.atan2(cz, cx); const g = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 16) % 2; const m = cy > 9.5 ? 1 : g; mask[i] = mask[i + 1] = mask[i + 2] = m; }
    env.setAttribute('aMask', new THREE.BufferAttribute(mask, 1));
    for (const k of Object.keys(env.attributes)) if (!['position', 'normal', 'aMask'].includes(k)) env.deleteAttribute(k);
    const basket = new THREE.BoxGeometry(2.4, 1.8, 2.4).translate(0, -13.5, 0).toNonIndexed();
    for (const k of Object.keys(basket.attributes)) if (!['position', 'normal'].includes(k)) basket.deleteAttribute(k);
    basket.setAttribute('aMask', new THREE.BufferAttribute(new Float32Array(basket.attributes.position.count).fill(2), 1));
    const geo = mergeGeometries([env, basket]); env.dispose(); basket.dispose();
    const mat = own(patch(new THREE.MeshLambertMaterial({ color: 0xffffff }), 'balloon', {
      vhead: 'attribute float aMask; varying float vMask;\n',
      vbegin: 'vMask = aMask;',
      fhead: 'varying float vMask;\n',
      color: `#include <color_fragment>
        diffuseColor.rgb = vMask > 1.5 ? vec3(0.32, 0.2, 0.1) : vMask > 0.5 ? vec3(0.95, 0.9, 0.8) : diffuseColor.rgb;`,
    }));
    balloons = new THREE.InstancedMesh(geo, mat, Q.balloons);
    const cols = ['#c23a22', '#ffb03a', '#1d6f74', '#5b2a6e', '#2a7a3a', '#e0446a'];
    for (let k = 0; k < Q.balloons; k++) {
      const a = R(0, 6.28), d = R(450, 1300);
      BAL.push({ x: CENTER.x + Math.cos(a) * d, z: CENTER.y + Math.sin(a) * d, y: R(70, 230), s: R(0.9, 1.25), ph: R(0, 6.28), sp: R(0.6, 1.4), glow: GLOW(0, 0, 0, 3, 2.8, 1.4, 0.4, 3.0, R(0, 6)) });
      balloons.setColorAt(k, C(cols[k % cols.length]));
    }
    balloons.frustumCulled = false;
    own(geo);
  }
  // rodadoras (bolas de matojo)
  let tumble = null; const TUM = [];
  {
    const twig = own(canvasTex(128, 128, (x, w, h) => {
      x.clearRect(0, 0, w, h); x.strokeStyle = '#6a4a2a'; x.lineCap = 'round';
      const r = mulberry(7);
      for (let k = 0; k < 70; k++) { x.lineWidth = 1 + r() * 2.2; x.beginPath(); let px = r() * w, py = r() * h; x.moveTo(px, py); for (let s = 0; s < 3; s++) { px += (r() - 0.5) * 50; py += (r() - 0.5) * 50; x.lineTo(px, py); } x.stroke(); }
    }));
    const g1 = new THREE.IcosahedronGeometry(0.75, 1), g2 = new THREE.IcosahedronGeometry(0.5, 0);
    const geo = mergeGeometries([g1, g2].map((g) => g.toNonIndexed())); g1.dispose(); g2.dispose();
    const mat = own(patch(new THREE.MeshLambertMaterial({ map: twig, alphaTest: 0.4, side: THREE.DoubleSide, color: 0xc8a070 }), 'tumble'));
    tumble = new THREE.InstancedMesh(geo, mat, Q.tumble);
    for (let k = 0; k < Q.tumble; k++) TUM.push({ x: 0, z: 0, y: 0, a: 0, r: R(0.8, 1.3), sp: R(3.5, 7), ph: R(0, 6), alive: false });
    tumble.frustumCulled = false;
    own(geo);
  }
  // remolinos de polvo
  let devils = null; const DEV = [];
  {
    const geo = new THREE.CylinderGeometry(7, 1.1, 46, 18, 8, true).translate(0, 23, 0);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uTime: U.uTime, uStorm: U.uStorm, uSunDir: U.uSunDir },
      vertexShader: `uniform float uTime; varying vec2 vUv; varying float vD; varying vec3 vN;
        void main(){ vUv = uv; vec3 p = position; float t = uTime * 0.8 + float(gl_InstanceID) * 3.0;
          p.x += sin(p.y * 0.08 + t) * p.y * 0.08; p.z += cos(p.y * 0.07 + t * 1.3) * p.y * 0.06;
          vN = normalize(mat3(instanceMatrix) * normal);
          vec4 mv = viewMatrix * modelMatrix * instanceMatrix * vec4(p, 1.0); vD = -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform float uTime; uniform float uStorm; uniform vec3 uSunDir; varying vec2 vUv; varying float vD; varying vec3 vN;
        float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h2(i), h2(i+vec2(1,0)), f.x), mix(h2(i+vec2(0,1)), h2(i+vec2(1,1)), f.x), f.y); }
        void main(){
          vec2 q = vec2(vUv.x * 6.0 + vUv.y * 5.0 - uTime * 1.6, vUv.y * 5.0 - uTime * 0.9);
          float n = n2(q * vec2(1.0, 2.0)) * 0.6 + n2(q * 3.1) * 0.4;
          float a = smoothstep(0.35, 0.85, n) * smoothstep(0.0, 0.12, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y)) * (0.32 + uStorm * 0.25);
          a *= smoothstep(15.0, 60.0, vD) * (1.0 - smoothstep(1400.0, 2200.0, vD));
          float l = 0.75 + 0.4 * max(dot(normalize(vN), normalize(uSunDir)), 0.0);
          gl_FragColor = vec4(vec3(0.86, 0.6, 0.38) * l, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    devils = new THREE.InstancedMesh(geo, mat, Q.devils + 2);
    for (let k = 0; k < Q.devils + 2; k++) DEV.push({ x: 0, z: 0, ph: R(0, 6.28), cx: 0, cz: 0, s: R(0.8, 1.3), on: k < Q.devils });
    devils.frustumCulled = false; devils.renderOrder = 3;
    own(geo); own(mat);
    // centros lejos de la pista
    DEV.forEach((d) => { for (let t = 0; t < 200; t++) { const a = R(0, 6.28), r = R(260, 900); const x = CENTER.x + Math.cos(a) * r * 1.2, z = CENTER.y + Math.sin(a) * r; if (beyond(x, z) > 90 && Math.hypot(x - LAKE.x, z - LAKE.z) > 260 && Math.hypot(x - FIELD.x, z - FIELD.z) > FIELD.r + 60) { d.cx = x; d.cz = z; break; } } });
  }
  // buitres planeando sobre el cañón
  let birds = null; const BIRD = [];
  if (Q.birds > 0) {
    const pos = [0, 0, 0.9, -3.2, 0.35, -0.3, 0, 0.1, -0.5, 0, 0, 0.9, 0, 0.1, -0.5, 3.2, 0.35, -0.3, 0, 0, 0.9, 0, -0.15, -1.2, 0, 0.1, -0.5];
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.computeVertexNormals();
    birds = new THREE.InstancedMesh(geo, own(new THREE.MeshBasicMaterial({ color: 0x24160f, side: THREE.DoubleSide, fog: true })), Q.birds);
    at(canyonS);
    for (let k = 0; k < Q.birds; k++) BIRD.push({ cx: tp.x + R(-60, 60), cz: tp.z + R(-60, 60), y: tp.y + R(55, 110), r: R(30, 70), a: R(0, 6.28), w: R(0.12, 0.22) * (rnd() < 0.5 ? 1 : -1) });
    birds.frustumCulled = false;
    own(geo);
  }

  /* =====================================================================
     DESTELLOS aditivos (lámparas, receptor, balizas) — billboards instanciados
     ===================================================================== */
  // halo del receptor
  GLOW(RECV.x, RECV.y, RECV.z, 70, 1.6, 0.9, 0.45);
  GLOW(RECV.x, RECV.y, RECV.z, 22, 3.5, 2.4, 1.3);
  let glows = null;
  const glowBlink = new Float32Array(glowList.length * 2);
  {
    const geo = new THREE.PlaneGeometry(1, 1);
    glowList.forEach((g, k) => { glowBlink[k * 2] = g.blink; glowBlink[k * 2 + 1] = g.phase; });
    geo.setAttribute('aBlink', new THREE.InstancedBufferAttribute(glowBlink, 2));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      uniforms: { uTime: U.uTime, uStorm: U.uStorm },
      vertexShader: `attribute vec2 aBlink; uniform float uTime; varying vec2 vUv; varying vec3 vCol; varying float vFade;
        void main(){
          vUv = uv - 0.5;
          vec3 c = vec3(instanceMatrix[3]);
          float s = length(vec3(instanceMatrix[0]));
          vec4 mv = viewMatrix * modelMatrix * vec4(c, 1.0);
          float b = aBlink.x > 0.0 ? step(0.55, fract(uTime / aBlink.x + aBlink.y)) : 1.0;
          if (aBlink.x > 2.5) b = 0.6 + 0.4 * step(0.8, fract(sin(floor(uTime * 6.0 + aBlink.y * 10.0)) * 4375.85));
          vCol = instanceColor * b;
          vFade = smoothstep(0.5, 6.0, -mv.z);
          mv.xy += position.xy * s;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform float uStorm; varying vec2 vUv; varying vec3 vCol; varying float vFade;
        void main(){ float d = length(vUv) * 2.0; float a = exp(-d * d * 4.5) * (1.0 - d * 0.2); if (d > 1.0) discard;
          gl_FragColor = vec4(vCol * a * vFade * (1.0 - uStorm * 0.4), 1.0); }`,
    });
    glows = new THREE.InstancedMesh(geo, mat, glowList.length);
    const col = new THREE.Color();
    glowList.forEach((g, k) => { glows.setMatrixAt(k, M(g.x, g.y, g.z, 0, g.size, g.size, g.size)); glows.setColorAt(k, col.setRGB(g.r, g.g, g.b)); });
    glows.frustumCulled = false; glows.renderOrder = 6;
    own(geo); own(mat);
  }
  const setGlowPos = (k, x, y, z, s) => { const g = glowList[k]; g.x = x; g.y = y; g.z = z; if (s) g.size = s; _m4.makeScale(g.size, g.size, g.size).setPosition(x, y, z); glows.setMatrixAt(k, _m4); };

  /* =====================================================================
     PARTÍCULAS: arena al viento / tormenta / lluvia
     ===================================================================== */
  const PMAX = Math.max(Q.sandStorm, rain ? Q.rain : 0, Q.sandDry);
  let parts = null;
  {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(PMAX * 4); for (let k = 0; k < seeds.length; k++) seeds[k] = rnd();
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = Q.sandDry;
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uTime: U.uTime, uCam: { value: new THREE.Vector3() }, uGround: { value: 0 }, uMode: { value: 0 }, uWind: U.uWind, uStorm: U.uStorm, uSunDir: U.uSunDir, uBox: { value: new THREE.Vector3(90, 14, 90) } },
      vertexShader: `attribute vec4 aSeed; uniform float uTime; uniform vec3 uCam; uniform float uGround; uniform float uMode; uniform vec2 uWind; uniform vec3 uBox; varying float vA; varying vec2 vQ; varying float vS;
        void main(){
          vec3 w = normalize(vec3(uWind.x, 0.0, uWind.y));
          float rainM = step(1.5, uMode);
          float spd = mix(mix(9.0, 26.0, uMode) * (0.6 + aSeed.w * 0.8), 2.0, rainM);
          vec3 vel = mix(w * spd, w * 4.0 + vec3(0.0, -22.0, 0.0), rainM);
          vec3 p = aSeed.xyz * uBox * 2.0 - uBox;
          p += vel * uTime;
          vec3 rel = mod(p - uCam + uBox, uBox * 2.0) - uBox;
          vec3 wp = uCam + rel;
          // seco: sólo a ras de suelo
          float hDry = uGround + pow(aSeed.y, 2.2) * 2.6 + 0.05;
          float hStorm = uGround + aSeed.y * aSeed.y * 14.0;
          wp.y = mix(hDry, hStorm, clamp(uMode, 0.0, 1.0));
          if (rainM > 0.5) wp.y = uCam.y + rel.y;
          // estela orientada en espacio de vista (robusta aunque el viento apunte a cámara)
          float len = mix(mix(1.8, 6.0, uMode), 1.4, rainM);
          float wid = mix(mix(0.07, 0.11, uMode), 0.025, rainM) * (1.0 + aSeed.z);
          vec3 dv = mat3(viewMatrix) * normalize(vel);
          float fl = length(dv.xy);
          vec2 dir = fl > 1e-3 ? dv.xy / fl : vec2(0.0, 1.0);
          vec4 mv = viewMatrix * vec4(wp, 1.0);
          mv.xy += dir * position.y * len * max(fl, 0.12) + vec2(dir.y, -dir.x) * position.x * wid;
          vQ = position.xy; vS = aSeed.w;
          float dc = length(rel.xz) / uBox.x;
          vA = (1.0 - smoothstep(0.65, 1.0, dc)) * smoothstep(1.0, 4.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform float uMode; uniform float uStorm; varying float vA; varying vec2 vQ; varying float vS;
        void main(){
          float e = 1.0 - abs(vQ.x) * 2.0; float t = sin(vQ.y * 3.14159);
          float a = vA * e * t;
          vec3 c = uMode > 1.5 ? vec3(0.75, 0.78, 0.85) : mix(mix(vec3(0.98, 0.8, 0.58), vec3(0.92, 0.7, 0.46), clamp(uMode, 0.0, 1.0)), vec3(0.45, 0.29, 0.16), step(0.5, vS) * clamp(uMode, 0.0, 1.0));
          float k = uMode > 1.5 ? 0.35 : mix(0.36, 0.42, clamp(uMode, 0.0, 1.0));
          gl_FragColor = vec4(c, a * k);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    parts = new THREE.Mesh(geo, mat); parts.frustumCulled = false; parts.renderOrder = 8;
    own(geo); own(mat);
  }

  /* =====================================================================
     FUEGOS ARTIFICIALES (sobre el oasis; se ven desde el podio y la recta)
     ===================================================================== */
  const FW = { x: LAKE.x + 20, y: 70, z: LAKE.z + 10, nb: 8, per: tier === 'low' ? 30 : tier === 'med' ? 44 : 60, next: 0, until: -1 };
  let fireworks = null;
  {
    const n = FW.nb * FW.per;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const vel = new Float32Array(n * 4);
    for (let b = 0; b < FW.nb; b++) for (let k = 0; k < FW.per; k++) {
      const i = b * FW.per + k, u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u), sp = 24 + rnd() * 6;
      vel[i * 4] = Math.cos(a) * r * sp; vel[i * 4 + 1] = u * sp; vel[i * 4 + 2] = Math.sin(a) * r * sp; vel[i * 4 + 3] = b;
    }
    geo.setAttribute('aVel', new THREE.InstancedBufferAttribute(vel, 4));
    geo.instanceCount = n;
    const bursts = []; const cols = [];
    for (let b = 0; b < FW.nb; b++) { bursts.push(new THREE.Vector4(0, -999, 0, -99)); cols.push(new THREE.Color(1, 1, 1)); }
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      uniforms: { uTime: U.uTime, uB: { value: bursts }, uC: { value: cols } },
      vertexShader: `uniform float uTime; uniform vec4 uB[${FW.nb}]; uniform vec3 uC[${FW.nb}]; attribute vec4 aVel; varying vec3 vCol; varying vec2 vUv;
        void main(){
          int b = int(aVel.w + 0.5); vec4 B = uB[b]; float age = uTime - B.w;
          if (age < 0.0 || age > 2.8) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          vec3 p = B.xyz + aVel.xyz * (1.0 - exp(-age * 1.7)) / 1.7 + vec3(0.0, -2.2 * age * age, 0.0);
          float fade = 1.0 - smoothstep(1.2, 2.8, age);
          float tw = 0.7 + 0.3 * sin(age * 30.0 + aVel.x);
          vCol = uC[b] * fade * tw * (1.0 + 3.0 * exp(-age * 6.0));
          vUv = position.xy;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          mv.xy += position.xy * (1.6 + 1.2 * exp(-age * 3.0));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying vec3 vCol; varying vec2 vUv; void main(){ float d = length(vUv) * 2.0; if (d > 1.0) discard; gl_FragColor = vec4(vCol * exp(-d * d * 4.0), 1.0); }`,
    });
    fireworks = new THREE.Mesh(geo, mat); fireworks.frustumCulled = false; fireworks.visible = false; fireworks.renderOrder = 7;
    own(geo); own(mat);
  }
  const FW_COLS = [[3, 1.6, 0.4], [3, 0.5, 0.3], [2.6, 2.4, 1.6], [0.6, 2.2, 3], [3, 0.6, 2.2], [1.2, 3, 0.8]];
  const fireworksApi = {
    x: FW.x, y: FW.y, z: FW.z,
    launch(n = 6) {
      const t = U.uTime.value, uB = fireworks.material.uniforms.uB.value, uC = fireworks.material.uniforms.uC.value;
      for (let k = 0; k < Math.min(n, FW.nb); k++) {
        const b = FW.next; FW.next = (FW.next + 1) % FW.nb;
        uB[b].set(FW.x + R(-70, 70), FW.y + R(-10, 35), FW.z + R(-30, 30), t + k * R(0.25, 0.5));
        const c = FW_COLS[Math.floor(rnd() * FW_COLS.length)]; uC[b].setRGB(c[0], c[1], c[2]);
        FW.until = Math.max(FW.until, uB[b].w + 3);
      }
      fireworks.visible = true;
    },
  };

  /* =====================================================================
     montaje de mallas
     ===================================================================== */
  const terrain = new THREE.Mesh(own(terrainMesh), matTerrain); terrain.name = 'terreno'; terrain.receiveShadow = Q.shadows;
  const rockNear = bagRockNear.mesh(matRockNear); const rockFar = bagRockFar.mesh(matRockFar);
  const statics = bagStatic.mesh(matStatic); const emis = bagEmis.mesh(matEmissive); const flora = bagFlora.mesh(matStatic);
  if (!rockFar) matRockFar.dispose();
  const signMesh = (() => { const g = mergeGeometries(signParts); signParts.forEach((p) => p.dispose()); return new THREE.Mesh(own(g), own(patch(new THREE.MeshLambertMaterial({ map: atlas, vertexColors: true, side: THREE.DoubleSide }), 'signs'))); })();
  for (const m of [rockNear, rockFar, statics, emis, flora]) if (m) own(m.geometry);
  if (rockNear) { rockNear.castShadow = Q.shadows; rockNear.receiveShadow = Q.shadows; }
  if (statics) { statics.castShadow = Q.shadows; statics.receiveShadow = Q.shadows; }
  if (palms) palms.castShadow = Q.shadows;
  const NAMED = { sky, terrain, rockFar, rockNear, statics, flora, emis, mirrors, water, palms, crowd: crowdMesh, signs: signMesh, jumbo: jumboMesh, rotors, blimp, balloons, tumble, devils, birds, beams, haze, glows, parts, fireworks };
  for (const [k, m] of Object.entries(NAMED)) if (m) { m.name = k; group.add(m); }
  scene.add(group);

  /* =====================================================================
     ENTORNO (lo aplica el integrador)
     ===================================================================== */
  const fog = new THREE.FogExp2(PAL.fog.getHex(), 0.0003);
  fog.color.copy(PAL.fog);
  const SUN0 = { color: 0xffb070, intensity: 3.9 }, HEMI0 = { sky: 0xb0a6d8, ground: 0xb0703f, intensity: 1.0 };
  const env = {
    background: PAL.horizon.clone(),
    fog,
    exposure: 1.0,
    bloom: { strength: 0.6, radius: 0.55, threshold: 0.86 },
    ambient: { hemi: { ...HEMI0 }, sun: { ...SUN0, dir: [SUN_DIR.x, SUN_DIR.y, SUN_DIR.z] } },
    envMap: null,
  };
  // mapa de entorno (cielo del atardecer) para reflejos de los coches
  if (renderer && renderer.isWebGLRenderer) {
    try {
      const pm = new THREE.PMREMGenerator(renderer);
      const es = new THREE.Scene();
      const s2 = new THREE.Mesh(skyGeo, skyMat); s2.scale.setScalar(50); es.add(s2);
      const grd = new THREE.Mesh(new THREE.CircleGeometry(40, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: PAL.ground.clone().multiplyScalar(0.6) }));
      grd.position.y = -2; es.add(grd);
      const rt = pm.fromScene(es, 0.02, 0.1, 200);
      env.envMap = rt.texture; own(rt);
      grd.geometry.dispose(); grd.material.dispose(); pm.dispose();
    } catch (e) { console.warn('[desierto] envMap', e); }
  }

  /* =====================================================================
     API
     ===================================================================== */
  const _gOn = new THREE.Color(2.4, 0.09, 0.05), _gOff = new THREE.Color(0.1, 0.008, 0.012);
  const gantry = {
    set(n) {
      const on = _gOn, off = _gOff;
      for (let c = 0; c < 5; c++) for (let r = 0; r < 2; r++) glows.setColorAt(GANTRY[c * 2 + r], n >= 0 && c < n ? on : off);
      glows.instanceColor.needsUpdate = true;
    },
  };
  gantry.set(0);
  const crowd = { _target: 0.15, excite(level) { this._target = clamp(level, 0, 1); } };
  const W = { cur: 'seco', storm: 0, rain: 0, tStorm: 0, tRain: 0 };
  function setWeather(w) {
    W.cur = w;
    W.tStorm = w === 'viento' ? 1 : 0;
    W.tRain = w === 'humedo' ? 1 : 0;
    const sunK = w === 'viento' ? 0.42 : w === 'humedo' ? 0.3 : 1;
    env.ambient.sun.intensity = SUN0.intensity * sunK;
    env.ambient.sun.color = w === 'viento' ? 0xf0a060 : w === 'humedo' ? 0xc8c0c8 : SUN0.color;
    env.ambient.hemi.sky = w === 'viento' ? 0xd8a070 : w === 'humedo' ? 0xa8a8b8 : HEMI0.sky;
    env.ambient.hemi.intensity = HEMI0.intensity * (w === 'viento' ? 1.35 : w === 'humedo' ? 1.3 : 1);
    env.bloom.strength = w === 'seco' ? 0.6 : 0.45;
    if (env.onChange) try { env.onChange(env); } catch (e) {}
  }
  const fogTarget = new THREE.Color(), _cam = new THREE.Vector3();
  let lastT = 0;
  function update(dt, t, camera) {
    dt = clamp(dt || 0, 0, 0.1);
    lastT = t;
    U.uTime.value = t;
    // clima (transición suave)
    const kk = 1 - Math.exp(-dt * 0.9);
    W.storm += (W.tStorm - W.storm) * kk; W.rain += (W.tRain - W.rain) * kk;
    U.uStorm.value = W.storm; U.uRain.value = W.rain;
    U.uGust.value = 0.25 + W.storm * 0.75 + 0.1 * Math.sin(t * 0.7);
    const f = scene.fog && scene.fog.isFogExp2 ? scene.fog : fog;
    fogTarget.copy(PAL.fog).lerp(PAL.storm, W.storm).lerp(PAL.rainSky, W.rain * 0.8);
    f.color.copy(fogTarget);
    f.density = 0.0003 + W.storm * 0.0022 + W.rain * 0.0009;
    U.uFogSun.value.copy(PAL.fogSun).lerp(PAL.storm, W.storm * 0.7).lerp(PAL.rainSky, W.rain);
    U.uHorizon.value.copy(PAL.horizon).lerp(PAL.storm, W.storm * 0.6).lerp(PAL.rainSky, W.rain * 0.7);
    // público
    U.uExcite.value += (crowd._target - U.uExcite.value) * (1 - Math.exp(-dt * 3));
    if (camera) {
      camera.getWorldPosition(_cam);
      sky.position.copy(_cam);
      // partículas alrededor de la cámara
      const pm = parts.material.uniforms;
      pm.uCam.value.copy(_cam);
      pm.uGround.value = groundAt(_cam.x, _cam.z);
      const mode = W.rain > 0.5 && rain ? 2 : W.storm;
      pm.uMode.value = mode;
      const bx = mode > 1.5 ? 45 : lerp(55, 60, W.storm);
      pm.uBox.value.set(bx, mode > 1.5 ? 18 : 14, bx);
      parts.geometry.instanceCount = mode > 1.5 ? Q.rain : Math.round(lerp(Q.sandDry, Q.sandStorm, W.storm));
      if (!rain && W.rain > 0.5) parts.geometry.instanceCount = 0;
      // rodadoras cerca de la cámara, a favor del viento
      for (let k = 0; k < TUM.length; k++) {
        const b = TUM[k];
        const far = (b.x - _cam.x) ** 2 + (b.z - _cam.z) ** 2 > 260 * 260;
        if (!b.alive || far) {
          if (rnd() < 0.02 || !b.alive) {
            for (let tr = 0; tr < 6; tr++) {
              const a = Math.atan2(-WIND.y, -WIND.x) + R(-1.1, 1.1), d = R(60, 200);
              const x = _cam.x + Math.cos(a) * d, z = _cam.z + Math.sin(a) * d;
              if (beyond(x, z) > 6) { b.x = x; b.z = z; b.alive = true; break; }
            }
          }
          if (!b.alive) continue;
        }
        const sp = b.sp * (1 + W.storm * 1.6) * (0.7 + 0.3 * Math.sin(t * 1.3 + b.ph));
        const nx = b.x + WIND.x * sp * dt, nz = b.z + WIND.y * sp * dt;
        if (k % 3 === Math.floor(t * 20) % 3 && beyond(nx, nz) < 4) { b.alive = false; continue; }
        b.x = nx; b.z = nz; b.a += (sp * dt) / b.r;
        b.y = groundAt(b.x, b.z) + b.r * 0.8 + Math.abs(Math.sin(t * 2.2 + b.ph)) * 0.6 * (1 + W.storm);
      }
    }
    // rodadoras → matrices
    for (let k = 0; k < TUM.length; k++) {
      const b = TUM[k];
      _e.set(0, 0, 0); _q.setFromAxisAngle(_v1.set(-WIND.y, 0, WIND.x), -b.a); _s3.setScalar(b.alive ? b.r : 0.0001);
      _m4.compose(_v2.set(b.x, b.y, b.z), _q, _s3); tumble.setMatrixAt(k, _m4);
    }
    tumble.instanceMatrix.needsUpdate = true;
    // rotores
    for (let k = 0; k < TURB.length; k++) {
      const r = TURB[k]; r.a += dt * r.w * (0.9 + W.storm * 1.4);
      _e.set(0, r.yaw, r.a, 'YXZ'); _q.setFromEuler(_e); _s3.set(1, 1, 1);
      _m4.compose(_v1.set(r.x, r.y, r.z), _q, _s3); rotors.setMatrixAt(k, _m4);
    }
    rotors.instanceMatrix.needsUpdate = true;
    // dirigible
    {
      const b = blimp.userData; b.a += dt * b.w;
      const x = CENTER.x + Math.cos(b.a) * b.r, z = CENTER.y + Math.sin(b.a) * b.r * 0.8, y = b.y + Math.sin(t * 0.2) * 4;
      blimp.position.set(x, y, z);
      const tx = -Math.sin(b.a), tz = Math.cos(b.a) * 0.8;
      blimp.rotation.set(0, Math.atan2(tx, tz), 0);
      setGlowPos(b.glow[0], x - Math.cos(blimp.rotation.y) * 6.3, y, z + Math.sin(blimp.rotation.y) * 6.3);
      setGlowPos(b.glow[1], x + Math.cos(blimp.rotation.y) * 6.3, y, z - Math.sin(blimp.rotation.y) * 6.3);
    }
    // globos (se ocultan con tormenta)
    {
      const vis = 1 - clamp(W.storm * 1.6 + W.rain * 1.6, 0, 1);
      for (let k = 0; k < BAL.length; k++) {
        const b = BAL[k];
        b.x += WIND.x * dt * 1.6 * b.sp; b.z += WIND.y * dt * 1.6 * b.sp;
        const dx = b.x - CENTER.x, dz = b.z - CENTER.y;
        if (dx * dx + dz * dz > 1500 * 1500) { b.x = CENTER.x - WIND.x * 1300 + R(-300, 300); b.z = CENTER.y - WIND.y * 1300 + R(-300, 300); }
        const y = b.y + Math.sin(t * 0.25 + b.ph) * 6 - (1 - vis) * 400;
        _q.setFromAxisAngle(_v1.set(0, 1, 0), t * 0.03 + b.ph); _s3.setScalar(b.s * Math.max(vis, 0.001));
        _m4.compose(_v2.set(b.x, y, b.z), _q, _s3); balloons.setMatrixAt(k, _m4);
        setGlowPos(b.glow, b.x, y - 10 * b.s, b.z, 3 * Math.max(vis, 0.001));
      }
      balloons.instanceMatrix.needsUpdate = true;
    }
    // remolinos
    {
      const n = Math.round(Q.devils + W.storm * 2);
      for (let k = 0; k < DEV.length; k++) {
        const d = DEV[k];
        const x = d.cx + Math.sin(t * 0.05 + d.ph) * 120 + Math.sin(t * 0.13 + d.ph * 2) * 40, z = d.cz + Math.cos(t * 0.04 + d.ph) * 110;
        const life = k < n ? 0.75 + 0.25 * Math.sin(t * 0.1 + d.ph) : 0.0001;
        _q.setFromAxisAngle(_v1.set(0, 1, 0), t * 2.5 + d.ph); _s3.set(d.s * life, d.s * (0.8 + 0.3 * life), d.s * life);
        _m4.compose(_v2.set(x, groundAt(x, z) - 1, z), _q, _s3); devils.setMatrixAt(k, _m4);
      }
      devils.instanceMatrix.needsUpdate = true;
    }
    // buitres
    if (birds) {
      for (let k = 0; k < BIRD.length; k++) {
        const b = BIRD[k]; b.a += dt * b.w;
        const x = b.cx + Math.cos(b.a) * b.r, z = b.cz + Math.sin(b.a) * b.r;
        _e.set(0, Math.atan2(-Math.sin(b.a) * Math.sign(b.w), Math.cos(b.a) * Math.sign(b.w)), -0.3 * Math.sign(b.w) + Math.sin(t + k) * 0.08, 'YXZ'); _q.setFromEuler(_e); _s3.setScalar(1.3);
        _m4.compose(_v1.set(x, b.y + Math.sin(t * 0.3 + k) * 3, z), _q, _s3); birds.setMatrixAt(k, _m4);
      }
      birds.instanceMatrix.needsUpdate = true;
    }
    glows.instanceMatrix.needsUpdate = true;
    beams.material.uniforms.uAmt.value = 1 - W.rain;
    if (fireworks.visible && t > FW.until) fireworks.visible = false;
  }

  function dispose() {
    scene.remove(group);
    if (scene.fog === fog) scene.fog = null;
    for (const d of disposables) { try { d.dispose && d.dispose(); } catch (e) {} }
    group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach((m) => m.dispose()); }
      if (o.isInstancedMesh) o.dispose();
    });
  }

  // estadísticas de construcción
  const stats = { archClearance: +canyon.clearance.toFixed(1), buildMs: { terrain: Math.round(tB1 - tB0), total: Math.round(now() - tB0) }, draws: 0, tris: 0, instances: {}, crowd: CROWD.length, mirrors: mirrorPts.length, palms: palmPts.length, tvCams: tvCams.length, occluders: occluders.length };
  group.traverse((o) => {
    if (!o.isMesh) return;
    stats.draws++;
    const g = o.geometry; let tri = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    if (o.isInstancedMesh) { tri *= o.count; stats.instances[o.name] = o.count; }
    else if (g.isInstancedBufferGeometry) tri *= o === parts ? PMAX : g.instanceCount;
    stats.tris += Math.round(tri);
    (stats.byMesh || (stats.byMesh = {}))[o.name] = Math.round(tri);
  });

  setWeather('seco');
  update(0, 0, null);

  return {
    id: 'desierto', group, env, occluders,
    tvCams: tvCams.map(({ x, y, z }) => ({ x, y, z })),
    gantry,
    jumbo: { draw: drawJumbo },
    podium,
    crowd,
    setWeather, update, dispose, stats,
    fireworks: fireworksApi,
    landmarks: {
      torreSolar: { x: TOWER.x, y: RECV.y, z: TOWER.z },
      campoSolar: { x: FIELD.x, y: TOWER.y, z: FIELD.z },
      canon: { x: canyon.arch.x, y: canyon.arch.y + 20, z: canyon.arch.z },
      oasis: { x: LAKE.x, y: 2, z: LAKE.z },
      hotel: { x: LAKE.x + 10, y: 20, z: LAKE.z - 112 },
      horquilla: (() => { at(hairpin.apex); return { x: tp.x, y: tp.y, z: tp.z }; })(),
      caldera: bowl ? (() => { at(bowl.apex); return { x: tp.x, y: tp.y, z: tp.z }; })() : { x: 0, y: 0, z: 0 },
      molinos: TURB.length ? { x: TURB[Math.floor(TURB.length / 2)].x, y: TURB[0].y, z: TURB[Math.floor(TURB.length / 2)].z } : { x: 0, y: 80, z: 900 },
      podio: { x: podium.x, y: podium.y, z: podium.z },
    },
    groundAt,
  };
}
