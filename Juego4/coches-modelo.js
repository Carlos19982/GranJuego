/* =====================================================================
   coches-modelo.js — Gran Premio Neón v3 · MODELOS DE COCHE
   Seis coches de carreras 100 % procedurales (sin assets externos):
   carrocería «loft» por secciones (spline), pasos de rueda reales,
   cúpula de cristal con reflejos, aerodinámica, luces LED, decoración
   completa pintada en un canvas por coche y ruedas multirradio.
   Presupuesto: ≤ 6 draw calls/coche en alta (LOD 0), ≤ 4 en LOD 1.
   ===================================================================== */
import * as THREE from 'three';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const FONT = '"Bungee", "Outfit", "Inter", "Arial Black", Arial, sans-serif';
const FONT2 = '"Outfit", "Inter", "Helvetica Neue", Arial, sans-serif';
/** Autoiluminación suave de la decoración: mantiene la identidad de color en escenas nocturnas. */
const SELF_LIT = 0.07;

/** Curva monótona (Hermite Fritsch–Carlson) a partir de pares z,v (z ascendente). */
function cv(...a) {
  const n = a.length >> 1, xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) { xs[i] = a[i * 2]; ys[i] = a[i * 2 + 1]; }
  if (n === 1) return () => ys[0];
  const d = new Float64Array(n - 1), m = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const p = m[i] / d[i], q = m[i + 1] / d[i], s = p * p + q * q;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * p * d[i]; m[i + 1] = t * q * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Catmull-Rom centrípeta (Barry–Goldman) en 2D. */
function crp(p0, p1, p2, p3, t, out) {
  const d = (a, b) => Math.max(1e-5, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const t0 = 0, t1 = d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3), u = lerp(t1, t2, t);
  for (let c = 0; c < 2; c++) {
    const a1 = ((t1 - u) * p0[c] + (u - t0) * p1[c]) / (t1 - t0);
    const a2 = ((t2 - u) * p1[c] + (u - t1) * p2[c]) / (t2 - t1);
    const a3 = ((t3 - u) * p2[c] + (u - t2) * p3[c]) / (t3 - t2);
    const b1 = ((t2 - u) * a1 + (u - t0) * a2) / (t2 - t0);
    const b2 = ((t3 - u) * a2 + (u - t1) * a3) / (t3 - t1);
    out[c] = ((t2 - u) * b1 + (u - t1) * b2) / (t2 - t1);
  }
  return out;
}
const lin = (hex, k = 1) => { const c = new THREE.Color(hex); return [c.r * k, c.g * k, c.b * k]; };
const mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/* ---------------------------------------------------------------------
   Constructor de geometría (atributos arbitrarios + pila de matrices)
   --------------------------------------------------------------------- */
const _bv = new THREE.Vector3(), _bn = new THREE.Vector3();
class Builder {
  constructor(attrs = {}) {
    this.sizes = attrs; this.P = []; this.N = []; this.A = {}; this.cur = {};
    for (const k in attrs) { this.A[k] = []; this.cur[k] = new Array(attrs[k]).fill(0); }
    if (this.cur.color) this.cur.color = [1, 1, 1];
    if (this.cur.skinWeight) this.cur.skinWeight = [1, 0, 0, 0];
    this.I = []; this.n = 0; this.M = null; this.NM = null; this.flip = false;
  }
  set(k, ...v) { const c = this.cur[k]; if (c) { if (v.length === 1 && Array.isArray(v[0])) v = v[0]; for (let i = 0; i < c.length && i < v.length; i++) c[i] = v[i]; } return this; }
  with(m, fn) {
    const pM = this.M, pN = this.NM, pF = this.flip;
    const M = pM ? pM.clone().multiply(m) : m.clone();
    this.M = M; this.NM = new THREE.Matrix3().getNormalMatrix(M); this.flip = M.determinant() < 0;
    try { fn(); } finally { this.M = pM; this.NM = pN; this.flip = pF; }
  }
  v(x, y, z, nx = 0, ny = 1, nz = 0) {
    if (this.M) {
      _bv.set(x, y, z).applyMatrix4(this.M); x = _bv.x; y = _bv.y; z = _bv.z;
      _bn.set(nx, ny, nz).applyMatrix3(this.NM).normalize(); nx = _bn.x; ny = _bn.y; nz = _bn.z;
    }
    this.P.push(x, y, z); this.N.push(nx, ny, nz);
    for (const k in this.A) { const c = this.cur[k], a = this.A[k]; for (let i = 0; i < c.length; i++) a.push(c[i]); }
    return this.n++;
  }
  t(a, b, c) { if (this.flip) this.I.push(a, c, b); else this.I.push(a, b, c); }
  q(a, b, c, d) { this.t(a, b, c); this.t(a, c, d); }
  geo(g, m) {
    const run = () => {
      const p = g.attributes.position, nn = g.attributes.normal, base = this.n;
      for (let i = 0; i < p.count; i++) this.v(p.getX(i), p.getY(i), p.getZ(i), nn ? nn.getX(i) : 0, nn ? nn.getY(i) : 1, nn ? nn.getZ(i) : 0);
      if (g.index) { const ix = g.index.array; for (let i = 0; i < ix.length; i += 3) this.t(base + ix[i], base + ix[i + 1], base + ix[i + 2]); }
      else for (let i = 0; i < p.count; i += 3) this.t(base + i, base + i + 1, base + i + 2);
    };
    if (m) this.with(m, run); else run();
    g.dispose();
  }
  get tris() { return this.I.length / 3; }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    for (const k in this.A) if (k !== 'proj') g.setAttribute(k, new THREE.Float32BufferAttribute(this.A[k], this.sizes[k]));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
    g.computeBoundingSphere();
    return g;
  }
}
const MIRROR = new THREE.Matrix4().makeScale(-1, 1, 1);
const mT = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
const mR = (x, y, z, order = 'XYZ') => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(x, y, z, order));
const mS = (x, y, z) => new THREE.Matrix4().makeScale(x, y, z);
const mul = (...ms) => ms.reduce((a, b) => a.multiply(b), new THREE.Matrix4());

/** Divide vértices por cara y asigna UV proyectadas (decoración / fibra). */
function splitProject(b, pick, uvOf) {
  const P = b.P, N = b.N, I = b.I, keys = Object.keys(b.A).filter((k) => k !== 'proj');
  const oP = [], oN = [], oU = [], oI = [], oA = {}; keys.forEach((k) => (oA[k] = []));
  const map = new Map(); let n = 0;
  const fn = (t, o) => {
    const a = I[t], bb = I[t + 1], c = I[t + 2];
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ux = P[bb * 3] - ax, uy = P[bb * 3 + 1] - ay, uz = P[bb * 3 + 2] - az;
    const vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
    o[0] = uy * vz - uz * vy; o[1] = uz * vx - ux * vz; o[2] = ux * vy - uy * vx; o[3] = (ax + P[bb * 3] + P[c * 3]) / 3;
    return Math.hypot(o[0], o[1], o[2]);
  };
  const f1 = [0, 0, 0, 0], f2 = [0, 0, 0, 0];
  let pairReg = -1;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], bb = I[t + 1], c = I[t + 2];
    const l = fn(t, f1);
    if (l < 1e-12) { pairReg = -1; continue; }
    let reg;
    if (pairReg >= 0) { reg = pairReg; pairReg = -1; }
    else {
      let fx = f1[0], fy = f1[1], fz = f1[2], cx = f1[3];
      // los dos triángulos de un mismo quad comparten región (evita dientes de sierra)
      if (t + 3 < I.length) {
        const a2 = I[t + 3], b2 = I[t + 4], c2 = I[t + 5];
        let sh = 0; for (const v of [a2, b2, c2]) if (v === a || v === bb || v === c) sh++;
        if (sh === 2 && fn(t + 3, f2) > 1e-12) { fx += f2[0]; fy += f2[1]; fz += f2[2]; cx = (cx + f2[3]) / 2; pairReg = -2; }
      }
      const ll = Math.hypot(fx, fy, fz); fx /= ll; fy /= ll; fz /= ll;
      reg = pick(fx, fy, fz, cx, a);
      if (pairReg === -2) pairReg = reg;
    }
    for (const v of [a, bb, c]) {
      const key = v * 8 + reg;
      let id = map.get(key);
      if (id === undefined) {
        id = n++; map.set(key, id);
        oP.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); oN.push(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
        for (const k of keys) { const s = b.sizes[k]; for (let i = 0; i < s; i++) oA[k].push(b.A[k][v * s + i]); }
        const uv = uvOf(reg, P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); oU.push(uv[0], uv[1]);
      }
      oI.push(id);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(oP, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(oN, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(oU, 2));
  for (const k of keys) g.setAttribute(k, new THREE.Float32BufferAttribute(oA[k], b.sizes[k]));
  g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(oI, 1) : new THREE.Uint16BufferAttribute(oI, 1));
  g.computeBoundingSphere();
  return g;
}

/* ---------------------------------------------------------------------
   Atlas de decoración: regiones proyectadas (lados, techo, frente, cola)
   --------------------------------------------------------------------- */
const REG = { SL: 0, SR: 1, TOP: 2, FR: 3, RR: 4, SW: 5 };
function makeLayout(D, W, H) {
  const zMin = D.zRear - 0.1, zMax = D.zFront + 0.1, yTop = 1.46, xH = 1.3, zl = zMax - zMin;
  const R = [
    { x: 0, y: 0, w: W, h: H * 0.305 },
    { x: 0, y: H * 0.305, w: W, h: H * 0.305 },
    { x: 0, y: H * 0.61, w: W * 0.78, h: H * 0.375 },
    { x: W * 0.78, y: H * 0.61, w: W * 0.22, h: H * 0.1875 },
    { x: W * 0.78, y: H * 0.7975, w: W * 0.22, h: H * 0.1875 },
    { x: W * 0.78, y: H * 0.985, w: W * 0.22, h: H * 0.015 },
  ];
  // transformaciones mundo → canvas (a, b, c, d, e, f) y orientación de rótulos
  const T = [];
  { const r = R[0], sz = r.w / zl, sy = r.h / yTop; T[0] = { m: [-sz, 0, 0, -sy, r.x + zMax * sz, r.y + yTop * sy], lab: [-1, -1] }; }
  { const r = R[1], sz = r.w / zl, sy = r.h / yTop; T[1] = { m: [sz, 0, 0, -sy, r.x - zMin * sz, r.y + yTop * sy], lab: [1, -1] }; }
  { const r = R[2], sz = r.w / zl, sx = r.h / (2 * xH); T[2] = { m: [sz, 0, 0, -sx, r.x - zMin * sz, r.y + xH * sx], lab: [1, -1] }; }
  { const r = R[3], s = r.w / (2 * xH), sy = r.h / yTop; T[3] = { m: [s, 0, 0, -sy, r.x + xH * s, r.y + yTop * sy], lab: [1, -1] }; }
  { const r = R[4], s = r.w / (2 * xH), sy = r.h / yTop; T[4] = { m: [-s, 0, 0, -sy, r.x + xH * s, r.y + yTop * sy], lab: [-1, -1] }; }
  const sw = [(R[5].x + R[5].w * 0.5) / W, 1 - (R[5].y + R[5].h * 0.5) / H];
  function uv(reg, x, y, z) {
    if (reg === 5) return sw;
    const r = R[reg]; let a, b2;
    if (reg === 0 || reg === 1) { a = z; b2 = y; }
    else if (reg === 2) { a = z; b2 = x; } else { a = x; b2 = y; }
    const m = T[reg].m;
    let px = m[0] * a + m[4], py = m[3] * b2 + m[5];
    px = clamp(px, r.x + 1, r.x + r.w - 1); py = clamp(py, r.y + 1, r.y + r.h - 1);
    return [px / W, 1 - py / H];
  }
  function pick(fx, fy, fz, cx) {
    const ax = Math.abs(fx), az = Math.abs(fz);
    if (fy > 0.6) return 2;
    if (az > 0.78 && az > ax) return fz > 0 ? 3 : 4;
    return (ax > 0.2 ? fx : cx) >= 0 ? 0 : 1;
  }
  return { R, T, W, H, zMin, zMax, yTop, xH, uv, pick, sw };
}

/* ---------------------------------------------------------------------
   Texturas compartidas (fibra de carbono, neumático/disco) — refcount
   --------------------------------------------------------------------- */
const SHARED = { refs: 0, carbon: null, wheel: null };
function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function sharedTextures(maxAniso) {
  SHARED.refs++;
  if (SHARED.carbon) return SHARED;
  { // sarga 2×2 de fibra de carbono
    const c = canvasOf(128, 128), x = c.getContext('2d');
    x.fillStyle = '#26282e'; x.fillRect(0, 0, 128, 128);
    const n = 8, s = 128 / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const h = ((i + j * 2) >> 1) % 2 === 0;
      const g = h ? x.createLinearGradient(i * s, j * s, i * s + s, j * s) : x.createLinearGradient(i * s, j * s, i * s, j * s + s);
      g.addColorStop(0, h ? '#3a3d45' : '#202228'); g.addColorStop(0.5, h ? '#5a5e68' : '#2c2f36'); g.addColorStop(1, h ? '#33363d' : '#1c1e23');
      x.fillStyle = g; x.fillRect(i * s + 0.5, j * s + 0.5, s - 1, s - 1);
    }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = Math.min(4, maxAniso);
    SHARED.carbon = t;
  }
  { // neumático (rotulado del flanco) + disco de freno perforado + texel blanco central
    const S = 512, c = canvasOf(S, S), x = c.getContext('2d'), C = S / 2;
    x.fillStyle = '#18181b'; x.fillRect(0, 0, S, S);
    const R = (rr) => (rr / (1.02 * 0.34)) * C; // radio de llanta → px
    // flanco: textura sutil
    x.strokeStyle = 'rgba(255,255,255,0.05)'; x.lineWidth = 2;
    for (let r = R(0.245); r < R(0.33); r += 6) { x.beginPath(); x.arc(C, C, r, 0, TAU); x.stroke(); }
    // franja de compuesto
    x.strokeStyle = '#ffd23a'; x.lineWidth = 5; x.beginPath(); x.arc(C, C, R(0.262), 0, TAU); x.stroke();
    // rotulado
    const ring = (txt, rad, size, col, a0) => {
      x.save(); x.translate(C, C); x.fillStyle = col; x.font = `800 ${size}px ${FONT2}`; x.textAlign = 'center'; x.textBaseline = 'middle';
      let a = a0; const step = (size * 0.66) / rad;
      for (const ch of txt) { x.save(); x.rotate(a); x.fillText(ch, 0, -rad); x.restore(); a += step * (ch === ' ' ? 0.6 : ch === 'I' ? 0.7 : 1); }
      x.restore();
    };
    ring('NEOGRIP', R(0.296), 30, '#f2f2f2', -0.62);
    ring('NEOGRIP', R(0.296), 30, '#f2f2f2', Math.PI - 0.62);
    ring('RACING SLICK · P-ZERO-G', R(0.300), 13, '#bdbdbd', 1.0);
    ring('RACING SLICK · P-ZERO-G', R(0.300), 13, '#bdbdbd', 1.0 + Math.PI);
    // disco de freno (corona 0.11–0.195)
    const r0 = R(0.105), r1 = R(0.2);
    const g = x.createRadialGradient(C, C, r0, C, C, r1);
    g.addColorStop(0, '#8a8c92'); g.addColorStop(0.5, '#b4b6bb'); g.addColorStop(1, '#7c7e84');
    x.fillStyle = g; x.beginPath(); x.arc(C, C, r1, 0, TAU); x.arc(C, C, r0, 0, TAU, true); x.fill();
    x.strokeStyle = 'rgba(30,30,34,0.55)'; x.lineWidth = 2;
    for (let i = 0; i < 36; i++) { const a = (i / 36) * TAU; x.beginPath(); x.moveTo(C + Math.cos(a) * (r0 + 4), C + Math.sin(a) * (r0 + 4)); x.lineTo(C + Math.cos(a + 0.35) * (r1 - 3), C + Math.sin(a + 0.35) * (r1 - 3)); x.stroke(); }
    x.fillStyle = '#2a2b30';
    for (let i = 0; i < 48; i++) { const a = (i / 48) * TAU, rr = lerp(r0 + 10, r1 - 8, (i % 3) / 2); x.beginPath(); x.arc(C + Math.cos(a) * rr, C + Math.sin(a) * rr, 2.4, 0, TAU); x.fill(); }
    // centro blanco (llanta, buje, pinza: color por vértice)
    x.fillStyle = '#ffffff'; x.beginPath(); x.arc(C, C, R(0.09), 0, TAU); x.fill();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = Math.min(4, maxAniso);
    SHARED.wheel = t;
  }
  return SHARED;
}
function releaseShared() {
  SHARED.refs = Math.max(0, SHARED.refs - 1);
  if (SHARED.refs === 0 && SHARED.carbon) { SHARED.carbon.dispose(); SHARED.wheel.dispose(); SHARED.carbon = SHARED.wheel = null; }
}

/* ---------------------------------------------------------------------
   Parches de shader (luz de contorno, daños, piezas sueltas, PBR por vértice)
   --------------------------------------------------------------------- */
function patchMaterial(mat, o) {
  const U = {
    uRim: { value: 0 }, uRimColor: { value: new THREE.Color(1, 1, 1) },
    uDamage: { value: 0 }, tDamage: { value: o.dmgTex || null }, uLoose: { value: 0 },
    uFl: { value: 1 }, uHead: { value: 0 }, uBrake: { value: 0 }, uBeaconA: { value: 0 }, uBeaconB: { value: 0 }, uHeat: { value: 0 }, uGlow: { value: 0 }, uGlowColor: { value: new THREE.Color(0, 0, 0) },
  };
  mat.userData.u = U;
  const key = ['cm6', o.rim ? 'r' : '', o.damage ? 'd' : '', o.loose ? 'l' : '', o.rm ? 'm' : '', o.lights ? 'L' : '', o.glow ? 'g' : '', o.glass ? 'G' : '', o.flame ? 'F' : ''].join('');
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    let vs = sh.vertexShader, fs = sh.fragmentShader;
    let vh = '', fh = '', vm = '';
    if (o.loose) { vh += 'attribute float aLoose;\nuniform float uLoose;\n'; vm += 'transformed += aLoose * uLoose * vec3(sign(transformed.x) * 0.04, -0.13, -0.03);\n'; }
    if (o.rm) { vh += 'attribute vec3 aRM;\nvarying vec3 vRM;\n'; fh += 'varying vec3 vRM;\n'; vm += 'vRM = aRM;\n'; }
    if (o.lights) { vh += 'attribute vec4 aCh;\nvarying vec4 vCh;\n'; fh += 'varying vec4 vCh;\nuniform float uHead;\nuniform float uBrake;\nuniform float uBeaconA;\nuniform float uBeaconB;\n'; vm += 'vCh = aCh;\n'; }
    if (o.glow) { vh += 'attribute vec2 aGlow;\nvarying vec2 vGlow;\n'; fh += 'varying vec2 vGlow;\nuniform float uHeat;\nuniform float uGlow;\nuniform vec3 uGlowColor;\n'; vm += 'vGlow = aGlow;\n'; }
    if (o.rim) fh += 'uniform float uRim;\nuniform vec3 uRimColor;\n';
    if (o.damage) fh += 'uniform float uDamage;\nuniform sampler2D tDamage;\n';
    if (o.flame) { vh += 'attribute vec3 aOrig;\nuniform float uFl;\n'; vm += 'transformed = aOrig + ( transformed - aOrig ) * uFl;\n'; }
    vs = vh + vs.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + vm);
    fs = fh + fs;
    if (o.rm) {
      fs = fs.replace('#include <map_fragment>', '#ifdef USE_MAP\n vec4 sampledDiffuseColor = texture2D( map, vMapUv );\n diffuseColor.rgb *= mix( vec3( 1.0 ), sampledDiffuseColor.rgb, vRM.z );\n#endif');
      fs = fs.replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRM.x;');
      fs = fs.replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vRM.y;');
    }
    if (o.damage) {
      fs = fs.replace('#include <color_fragment>', `#include <color_fragment>
#ifdef USE_MAP
 vec2 dmgS = texture2D( tDamage, vMapUv ).rg;
#else
 vec2 dmgS = vec2( 1.0, 0.0 );
#endif
 float dmgSc = step( dmgS.r + 0.004, uDamage );
 float dmgDirt = dmgS.g * uDamage;
 diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 0.32 + vec3( 0.03, 0.026, 0.022 ), dmgDirt * 0.85 );
 diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.075, 0.075, 0.08 ), dmgSc * 0.92 );`);
      fs = fs.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix( roughnessFactor, 0.85, max( dmgSc, dmgDirt * 0.7 ) );');
      fs = fs.replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\n material.clearcoat *= 1.0 - max( dmgSc, dmgDirt * 0.8 );\n#endif');
    }
    if (o.lights) fs = fs.replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= vCh.x + vCh.y * uHead + vCh.z * uBrake + max( vCh.w, 0.0 ) * uBeaconA + max( -vCh.w, 0.0 ) * uBeaconB;');
    if (o.damage) fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n#ifdef USE_COLOR\n totalEmissiveRadiance *= vColor.rgb;\n#endif\n totalEmissiveRadiance *= 1.0 - max( dmgSc, dmgDirt * 0.8 );');
    if (o.rim) fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += uRimColor * uRim * pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), 2.6 );');
    if (o.glow) fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += vec3( 1.0, 0.3, 0.05 ) * ( vGlow.x * uHeat * uHeat * 4.0 * ( 0.35 + 0.65 * diffuseColor.r ) ) + uGlowColor * ( vGlow.y * uGlow );');
    if (o.glass) fs = fs.replace('#include <opaque_fragment>', ' diffuseColor.a = mix( diffuseColor.a, 0.97, pow( 1.0 - saturate( abs( dot( normal, normalize( vViewPosition ) ) ) ), 2.2 ) );\n#include <opaque_fragment>');
    sh.vertexShader = vs; sh.fragmentShader = fs;
  };
  return mat;
}

/* ---------------------------------------------------------------------
   Carrocería: loft de secciones transversales
   --------------------------------------------------------------------- */
function makeBody(D, lod) {
  const nS = lod ? 3 : 7, n1 = lod ? 2 : 5, n2 = lod ? 2 : 4, n3 = lod ? 3 : 6;
  const K = 4 + nS + n1 + n2 + n3, iS = 3 + nS;
  const c = D.body, A = D.archList;
  const S = [0, 0], P0 = [0, 0], C = [0, 0], V = [0, 0], E = [0, 0], P5 = [0, 0], o = [0, 0];
  function section(z, X, Y) {
    const yF = c.yFloor(z), xH = c.xHalf(z), ySill = c.ySill(z), ySh = c.yShoulder(z), tb = c.tumble(z), uc = c.undercut(z);
    let wb = 0, yA = 0;
    for (const a of A) {
      const dz = (z - a.z) / a.rz;
      if (dz > -1 && dz < 1) { wb = 1; yA = a.cy + a.ry * Math.sqrt(1 - dz * dz); if (a.top !== undefined) yA = Math.min(yA, a.top); }
    }
    const xB = xH - uc, yBot = wb ? Math.min(yA, ySh - 0.035) : ySill;
    const xIn = wb ? D.wellX : xB - 0.03;
    X[0] = 0; Y[0] = yF; X[1] = xIn; Y[1] = yF; X[2] = xIn; Y[2] = yBot; X[3] = xB; Y[3] = yBot;
    for (let i = 1; i <= nS; i++) { const t = i / nS; X[3 + i] = xH - uc * (1 - t) ** 3 - tb * t * t; Y[3 + i] = lerp(yBot, ySh, t); }
    S[0] = X[iS]; S[1] = Y[iS]; P0[0] = X[iS - 1]; P0[1] = Y[iS - 1];
    C[0] = c.xCrown(z); C[1] = c.yCrown(z); V[0] = c.xValley(z); V[1] = c.yValley(z); E[0] = 0; E[1] = c.yCenter(z); P5[0] = -V[0]; P5[1] = V[1];
    let k = iS;
    for (let i = 1; i <= n1; i++) { crp(P0, S, C, V, i / n1, o); k++; X[k] = o[0]; Y[k] = o[1]; }
    for (let i = 1; i <= n2; i++) { crp(S, C, V, E, i / n2, o); k++; X[k] = o[0]; Y[k] = o[1]; }
    for (let i = 1; i <= n3; i++) { crp(C, V, E, P5, i / n3, o); k++; X[k] = Math.max(0, o[0]); Y[k] = o[1]; }
    X[K - 1] = 0;
    let f = 1, yL = 0, sh = 0;
    if (z > D.zFront - D.noseR) { const t = Math.min(1, (z - (D.zFront - D.noseR)) / D.noseR); f = Math.sqrt(Math.max(0, 1 - t * t)); yL = D.noseY; sh = D.noseShrink; }
    else if (D.tailR > 0 && z < D.zRear + D.tailR) { const t = Math.min(1, (D.zRear + D.tailR - z) / D.tailR); f = Math.sqrt(Math.max(0, 1 - t * t)); yL = D.tailY; sh = D.tailShrink; }
    if (f < 1) for (let k2 = 0; k2 < K; k2++) { Y[k2] = yL + (Y[k2] - yL) * f; X[k2] *= 1 - (1 - f) * sh; }
  }
  // consultas de superficie (resolución LOD0)
  const QX = new Float64Array(K), QY = new Float64Array(K); let qz = NaN;
  const sec = (z) => { if (z !== qz) { section(z, QX, QY); qz = z; } };
  function topY(z, x) {
    sec(z); x = Math.abs(x);
    for (let k = K - 1; k > 3; k--) {
      const x0 = QX[k], x1 = QX[k - 1];
      if ((x >= x0 && x <= x1) || (x <= x0 && x >= x1)) { const t = Math.abs(x1 - x0) < 1e-9 ? 0 : (x - x0) / (x1 - x0); return lerp(QY[k], QY[k - 1], t); }
    }
    return QY[iS];
  }
  function sideX(z, y) {
    sec(z); let best = -1;
    for (let k = 3; k < K - 1; k++) {
      const y0 = QY[k], y1 = QY[k + 1];
      if ((y >= y0 && y <= y1) || (y <= y0 && y >= y1)) { const t = Math.abs(y1 - y0) < 1e-9 ? 0 : (y - y0) / (y1 - y0); best = Math.max(best, lerp(QX[k], QX[k + 1], t)); }
    }
    return best < 0 ? QX[iS] : best;
  }
  function inside(z, x, y) {
    sec(z); x = Math.abs(x); let ins = false;
    for (let k = 0; k < K - 1; k++) {
      const x0 = QX[k], y0 = QY[k], x1 = QX[k + 1], y1 = QY[k + 1];
      if ((y0 > y) !== (y1 > y)) { const xi = x0 + ((y - y0) / (y1 - y0)) * (x1 - x0); if (xi > x) ins = !ins; }
    }
    return ins;
  }
  function endZ(x, y, zIn, zOut) {
    if (!inside(zIn, x, y)) return null;
    let a = zIn, b = zOut;
    for (let i = 0; i < 26; i++) { const m = (a + b) / 2; if (inside(m, x, y)) a = m; else b = m; }
    return (a + b) / 2;
  }
  return { K, iS, section, topY, sideX, inside, endZ };
}

function zSamples(D, lod, extra = []) {
  const imp = [];
  const nN = lod ? 4 : 10;
  for (let i = 0; i <= nN; i++) imp.push(D.zFront - D.noseR * (1 - Math.sin((i / nN) * Math.PI * 0.5)));
  if (D.tailR > 0) { const nT = lod ? 3 : 8; for (let i = 0; i <= nT; i++) imp.push(D.zRear + D.tailR * (1 - Math.sin((i / nT) * Math.PI * 0.5))); }
  else imp.push(D.zRear);
  for (const a of D.archList) {
    const nA = lod ? 6 : 14;
    for (let i = 0; i <= nA; i++) imp.push(a.z - a.rz * 0.997 * Math.cos((i / nA) * Math.PI));
    imp.push(a.z - a.rz - 0.004, a.z + a.rz + 0.004);
  }
  for (const z of extra) imp.push(z);
  imp.sort((p, q) => p - q);
  const pts = [];
  for (const z of imp) if (z >= D.zRear - 1e-6 && z <= D.zFront + 1e-6 && (!pts.length || z - pts[pts.length - 1] > 0.0015)) pts.push(z);
  const step = lod ? 0.2 : 0.085, out = [];
  for (let i = 0; i < pts.length; i++) {
    out.push(pts[i]);
    if (i < pts.length - 1) { const gap = pts[i + 1] - pts[i], n = Math.floor(gap / step); for (let k = 1; k <= n; k++) out.push(pts[i] + (gap * k) / (n + 1)); }
  }
  return out;
}

/** Normales por franja (aristas vivas entre franjas). */
function stripNormals(P, J, K, k0, k1, out) {
  for (let j = 0; j < J; j++) for (let k = k0; k <= k1; k++) { const i = (j * K + k) * 3; out[i] = out[i + 1] = out[i + 2] = 0; }
  const add = (i, x, y, z) => { out[i] += x; out[i + 1] += y; out[i + 2] += z; };
  for (let j = 0; j < J - 1; j++) for (let k = k0; k < k1; k++) {
    const a = (j * K + k) * 3, b = (j * K + k + 1) * 3, c = ((j + 1) * K + k + 1) * 3, d = ((j + 1) * K + k) * 3;
    for (const [p, q, r] of [[a, b, c], [a, c, d]]) {
      const ux = P[q] - P[p], uy = P[q + 1] - P[p + 1], uz = P[q + 2] - P[p + 2];
      const vx = P[r] - P[p], vy = P[r + 1] - P[p + 1], vz = P[r + 2] - P[p + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      add(p, nx, ny, nz); add(q, nx, ny, nz); add(r, nx, ny, nz);
    }
  }
  for (let j = 0; j < J; j++) for (let k = k0; k <= k1; k++) {
    const i = (j * K + k) * 3; const l = Math.hypot(out[i], out[i + 1], out[i + 2]);
    if (l < 1e-12) { out[i] = 0; out[i + 1] = 1; out[i + 2] = 0; } else { out[i] /= l; out[i + 1] /= l; out[i + 2] /= l; }
  }
}
/** Emite una rejilla (mitad +X y espejo) repartiendo cada quad a un constructor. */
function emitGrid(P, N, J, K, k0, k1, pick, mirror = true, center = true) {
  for (const s of mirror ? [1, -1] : [1]) {
    const caches = new Map();
    const vid = (b, j, k) => {
      let m = caches.get(b); if (!m) { m = new Map(); caches.set(b, m); }
      const key = j * K + k; let id = m.get(key);
      if (id === undefined) {
        const i = key * 3; let nx = N[i] * s;
        if (center && (k === 0 || k === K - 1) && Math.abs(P[i]) < 1e-6) nx = 0;
        const l = Math.hypot(nx, N[i + 1], N[i + 2]) || 1;
        id = b.v(P[i] * s, P[i + 1], P[i + 2], nx / l, N[i + 1] / l, N[i + 2] / l); m.set(key, id);
      }
      return id;
    };
    for (let j = 0; j < J - 1; j++) for (let k = k0; k < k1; k++) {
      const b = pick(j, k, s); if (!b) continue;
      const pa = (j * K + k) * 3, pb = (j * K + k + 1) * 3, pc = ((j + 1) * K + k + 1) * 3, pd = ((j + 1) * K + k) * 3;
      const ar = (p, q, r) => { const ux = P[q] - P[p], uy = P[q + 1] - P[p + 1], uz = P[q + 2] - P[p + 2], vx = P[r] - P[p], vy = P[r + 1] - P[p + 1], vz = P[r + 2] - P[p + 2]; return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx); };
      const t1 = ar(pa, pb, pc) > 1e-10, t2 = ar(pa, pc, pd) > 1e-10;
      if (!t1 && !t2) continue;
      const a = vid(b, j, k), bb = vid(b, j, k + 1), c = vid(b, j + 1, k + 1), d = vid(b, j + 1, k);
      if (s > 0) { if (t1) b.t(a, bb, c); if (t2) b.t(a, c, d); }
      else { if (t1) b.t(a, c, bb); if (t2) b.t(a, d, c); }
    }
  }
}

/* ---------------------------------------------------------------------
   Kit de piezas
   --------------------------------------------------------------------- */
function makeKit(D, body, B, lod, colors) {
  const K = {
    D, body, B, lod, col: colors, lamps: { head: [], tail: [], brake: [] }, exhaust: [], exhaustDir: [],
    /** Punto de la superficie de carrocería en un modo de proyección. */
    drape(mode, u, v, off = 0, out = {}) {
      const f = (uu, vv, o) => {
        if (mode === 'top') { o[0] = vv; o[1] = body.topY(uu, vv); o[2] = uu; }
        else if (mode === 'side') { o[0] = body.sideX(uu, vv); o[1] = vv; o[2] = uu; }
        else if (mode === 'front') { const z = body.endZ(uu, vv, D.zFrontIn, D.zFront + 0.2); o[0] = uu; o[1] = vv; o[2] = z === null ? D.zFrontIn : z; }
        else { const z = body.endZ(uu, vv, D.zRearIn, D.zRear - 0.2); o[0] = uu; o[1] = vv; o[2] = z === null ? D.zRearIn : z; }
        return o;
      };
      const p = f(u, v, [0, 0, 0]), h = 0.006;
      const pu = f(u + h, v, [0, 0, 0]), pv = f(u, v + h, [0, 0, 0]);
      const ax = pu[0] - p[0], ay = pu[1] - p[1], az = pu[2] - p[2], bx = pv[0] - p[0], by = pv[1] - p[1], bz = pv[2] - p[2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      const ref = mode === 'top' ? ny : mode === 'side' ? nx : mode === 'front' ? nz : -nz;
      if (ref < 0) { nx = -nx; ny = -ny; nz = -nz; }
      out.p = [p[0] + nx * off, p[1] + ny * off, p[2] + nz * off]; out.n = [nx, ny, nz];
      return out;
    },
    /** Cinta adaptada a la superficie (luces, rejillas, franjas). pts en el plano del modo. */
    ribbon(b, mode, pts0, hw, o = {}) {
      // re-muestreo: segmentos ≤ 4 cm para seguir la curvatura de la carrocería
      const maxL = lod ? 0.12 : 0.04, pts = [], ts = [];
      let total = 0; const seg = [];
      for (let i = 0; i < pts0.length - 1; i++) { const l = Math.hypot(pts0[i + 1][0] - pts0[i][0], pts0[i + 1][1] - pts0[i][1]); seg.push(l); total += l; }
      let acc = 0;
      for (let i = 0; i < pts0.length; i++) {
        if (i === pts0.length - 1) { pts.push(pts0[i]); ts.push(1); break; }
        const nn = Math.max(1, Math.ceil(seg[i] / maxL));
        for (let q = 0; q < nn; q++) { const t = q / nn; pts.push([lerp(pts0[i][0], pts0[i + 1][0], t), lerp(pts0[i][1], pts0[i + 1][1], t)]); ts.push(total > 0 ? (acc + seg[i] * t) / total : 0); }
        acc += seg[i];
      }
      const wOf = (i) => (Array.isArray(hw) ? lerp(hw[Math.min(hw.length - 1, Math.floor(ts[i] * (hw.length - 1)))], hw[Math.min(hw.length - 1, Math.ceil(ts[i] * (hw.length - 1)))], 0.5) : typeof hw === 'function' ? hw(ts[i]) : hw);
      let wMax = 0; for (let i = 0; i < pts.length; i++) wMax = Math.max(wMax, wOf(i));
      const n = pts.length, m = Math.max(o.across || 2, Math.min(lod ? 3 : 7, Math.ceil((2 * wMax) / maxL) + 1)), off = o.off ?? 0.004, rows = [];
      for (let i = 0; i < n; i++) {
        const p = pts[i], pp = pts[Math.max(0, i - 1)], pn = pts[Math.min(n - 1, i + 1)];
        let tx = pn[0] - pp[0], ty = pn[1] - pp[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
        const w = wOf(i), row = [];
        for (let k = 0; k < m; k++) {
          const s = (k / (m - 1)) * 2 - 1, d = K.drape(mode, p[0] - ty * w * s, p[1] + tx * w * s, off);
          if (o.col) b.set('color', o.col(ts[i], k / (m - 1)));
          row.push([b.v(d.p[0], d.p[1], d.p[2], d.n[0], d.n[1], d.n[2]), d]);
        }
        rows.push(row);
      }
      for (let i = 0; i < n - 1; i++) for (let k = 0; k < m - 1; k++) {
        const a = rows[i][k], bb = rows[i][k + 1], c = rows[i + 1][k + 1], d = rows[i + 1][k];
        const P = (r) => r[1].p;
        const ux = P(bb)[0] - P(a)[0], uy = P(bb)[1] - P(a)[1], uz = P(bb)[2] - P(a)[2], vx = P(c)[0] - P(a)[0], vy = P(c)[1] - P(a)[1], vz = P(c)[2] - P(a)[2];
        const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx, nn = a[1].n;
        if (fx * nn[0] + fy * nn[1] + fz * nn[2] >= 0) b.q(a[0], bb[0], c[0], d[0]); else b.q(a[0], d[0], c[0], bb[0]);
      }
      return rows;
    },
    /** Disco (óptica, pilotos redondos) sobre la superficie. */
    disc(b, mode, u, v, r, o = {}) {
      const seg = o.seg || (lod ? 8 : 16), off = o.off ?? 0.005, ry = o.ry || r;
      const c = K.drape(mode, u, v, off), ids = [];
      if (o.colC) b.set('color', o.colC);
      const ci = b.v(c.p[0], c.p[1], c.p[2], c.n[0], c.n[1], c.n[2]);
      if (o.colE) b.set('color', o.colE);
      for (let i = 0; i < seg; i++) { const a = (i / seg) * TAU, d = K.drape(mode, u + Math.cos(a) * r, v + Math.sin(a) * ry, off); ids.push([b.v(d.p[0], d.p[1], d.p[2], d.n[0], d.n[1], d.n[2]), d.p]); }
      for (let i = 0; i < seg; i++) {
        const a = ids[i], bb = ids[(i + 1) % seg];
        const ux = a[1][0] - c.p[0], uy = a[1][1] - c.p[1], uz = a[1][2] - c.p[2], vx = bb[1][0] - c.p[0], vy = bb[1][1] - c.p[1], vz = bb[1][2] - c.p[2];
        const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
        if (fx * c.n[0] + fy * c.n[1] + fz * c.n[2] >= 0) b.t(ci, a[0], bb[0]); else b.t(ci, bb[0], a[0]);
      }
      return c.p;
    },
    /** Hexaedro de 8 esquinas (caras planas). c: [x,y,z]×8 (000,100,110,010,001,101,111,011). */
    box8(b, c) {
      const F = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 4, 7, 3], [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2]];
      for (const f of F) {
        const p = f.map((i) => c[i]);
        const ux = p[2][0] - p[0][0], uy = p[2][1] - p[0][1], uz = p[2][2] - p[0][2], vx = p[3][0] - p[1][0], vy = p[3][1] - p[1][1], vz = p[3][2] - p[1][2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz); if (l < 1e-12) continue; nx /= l; ny /= l; nz /= l;
        const ids = p.map((q) => b.v(q[0], q[1], q[2], nx, ny, nz));
        b.q(ids[0], ids[1], ids[2], ids[3]);
      }
    },
    /** Caja orientada: centro, semiejes, rotación. */
    box(b, cx, cy, cz, hx, hy, hz, rx = 0, ry = 0, rz = 0) {
      b.geo(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), mul(mT(cx, cy, cz), mR(rx, ry, rz)));
    },
    /** Torno alrededor del eje X local (perfil [[radio, x], ...]); m orienta/ubica. */
    lathe(b, prof, seg, m, o = {}) {
      const run = () => {
        const n = prof.length, a0 = o.a0 ?? 0, a1 = o.a1 ?? TAU, full = o.a1 === undefined;
        const segs = [];
        if (o.hard) for (let i = 0; i < n - 1; i++) segs.push([prof[i], prof[i + 1]]);
        else segs.push(prof);
        for (const pr of segs) {
          const nn = pr.length, nrm = [];
          for (let i = 0; i < nn; i++) {
            const pa = pr[Math.max(0, i - 1)], pb = pr[Math.min(nn - 1, i + 1)];
            const dr = pb[0] - pa[0], dx = pb[1] - pa[1], l = Math.hypot(dr, dx) || 1;
            nrm.push([-dr / l, dx / l]);
          }
          const base = b.n;
          for (let s = 0; s <= seg; s++) {
            const a = lerp(a0, a1, s / seg), ca = Math.cos(a), sa = Math.sin(a);
            for (let i = 0; i < nn; i++) {
              const [rr, x] = pr[i];
              if (o.col) b.set('color', o.col(rr, x, a));
              if (o.uv) b.set('uv', o.uv(rr, x, a));
              if (o.glow) b.set('aGlow', o.glow(rr, x, a));
              b.v(x, rr * ca, rr * sa, nrm[i][0], nrm[i][1] * ca, nrm[i][1] * sa);
            }
          }
          for (let s = 0; s < seg; s++) for (let i = 0; i < nn - 1; i++) {
            const a = base + s * nn + i, c2 = base + (s + 1) * nn + i;
            b.t(a, c2, c2 + 1); b.t(a, c2 + 1, a + 1);
          }
          if (full) void 0;
        }
      };
      if (m) b.with(m, run); else run();
    },
    /** Elipsoide. */
    ellipsoid(b, cx, cy, cz, rx, ry, rz, ws = 14, hs = 9, m) {
      const g = new THREE.SphereGeometry(1, ws, hs);
      b.geo(g, mul(mT(cx, cy, cz), m || new THREE.Matrix4(), mS(rx, ry, rz)));
    },
    /** Placa vertical (perfil en el plano z-y) extruida en x. */
    plateZY(b, pts, x0, th, bevel = 0.004) {
      const sh = new THREE.Shape(pts.map((p) => new THREE.Vector2(p[0], p[1])));
      const g = new THREE.ExtrudeGeometry(sh, { depth: Math.max(0.001, th - bevel * 2), bevelEnabled: bevel > 0 && !lod, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 4 });
      // forma (x→z, y→y), extrusión → x
      const m = new THREE.Matrix4().set(0, 0, 1, x0 + bevel, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1);
      b.geo(g, m);
    },
    /** Placa horizontal (perfil en el plano x-z) extruida en y. */
    plateXZ(b, pts, y0, th, bevel = 0.004) {
      const sh = new THREE.Shape(pts.map((p) => new THREE.Vector2(p[0], p[1])));
      const g = new THREE.ExtrudeGeometry(sh, { depth: Math.max(0.001, th - bevel * 2), bevelEnabled: bevel > 0 && !lod, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 4 });
      const m = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, y0 + bevel, 0, 1, 0, 0, 0, 0, 0, 1);
      b.geo(g, m);
    },
    /** Perfil alar invertido extruido a lo largo de x. */
    airfoil(b, o) {
      const nc = lod ? 4 : 10, ns = o.bend ? (lod ? 4 : 10) : 1;
      const th = o.thick ?? 0.12, cam = o.camber ?? 0.05, ch = o.chord, al = o.pitch ?? 0.12;
      const loop = [];
      const yt = (x) => 5 * th * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
      const yc = (x) => -cam * (x < 0.4 ? (2 * 0.4 * x - x * x) / 0.16 : ((1 - 0.8) + 0.8 * x - x * x) / 0.36);
      for (let i = nc; i >= 0; i--) { const x = (1 - Math.cos((i / nc) * Math.PI)) / 2; loop.push([x, yc(x) + yt(x)]); }
      for (let i = 1; i <= nc; i++) { const x = (1 - Math.cos((i / nc) * Math.PI)) / 2; loop.push([x, yc(x) - yt(x)]); }
      const L = loop.length, J = ns + 1, P = new Float32Array(J * L * 3), N = new Float32Array(J * L * 3);
      const ca = Math.cos(al), sa = Math.sin(al);
      for (let j = 0; j < J; j++) {
        const u = j / ns, x = lerp(o.x0, o.x1, u), bd = o.bend ? o.bend(x) : [0, 0], chord = o.chordAt ? o.chordAt(x) : ch;
        for (let k = 0; k < L; k++) {
          const dz = -loop[k][0] * chord, dy = loop[k][1] * chord;
          const i = (j * L + k) * 3;
          P[i] = x; P[i + 1] = o.y + bd[0] + dy * ca - dz * sa; P[i + 2] = o.z + bd[1] + dz * ca + dy * sa;
        }
      }
      stripNormals(P, J, L, 0, L - 1, N);
      // la rejilla avanza en x; la orientación depende del sentido del contorno
      const fl = 1;
      emitGrid(P, N, J, L, 0, L - 1, () => b, false, false);
      // tapas
      for (const j of [0, J - 1]) {
        const ids = [], nx = j === 0 ? -1 : 1;
        for (let k = 0; k < L - 1; k++) { const i = (j * L + k) * 3; ids.push(b.v(P[i], P[i + 1], P[i + 2], nx, 0, 0)); }
        for (let k = 1; k < ids.length - 1; k++) { if (nx * fl > 0) b.t(ids[0], ids[k], ids[k + 1]); else b.t(ids[0], ids[k + 1], ids[k]); }
      }
    },
    sym(bs, fn) { bs = [].concat(bs); fn(1); const wrap = (i) => (i === bs.length ? fn(-1) : bs[i].with(MIRROR, () => wrap(i + 1))); wrap(0); },
  };
  return K;
}

/* ---------------------------------------------------------------------
   Ruedas (una sola malla con «skinning»: 4 giros + 4 manguetas)
   --------------------------------------------------------------------- */
function buildWheels(D, kit, lod, colors) {
  const b = new Builder({ uv: 2, color: 3, aRM: 3, aGlow: 2, skinIndex: 4, skinWeight: 4 });
  const r = D.r, tw = D.tyreW, rimR = 0.235, seg = lod ? 16 : 36;
  const W = D.wheel;
  const rimC = colors.rim, rimDark = mixc(colors.rim, [0.02, 0.02, 0.025], 0.55), lipC = mixc(colors.rim, [1, 1, 1], 0.35);
  const tyreUV = (side) => (rr, x, a) => { const y = rr * Math.cos(a), z = rr * Math.sin(a), R = 1.02 * r; return [0.5 + 0.5 * (-side * z) / R, 0.5 + 0.5 * y / R]; };
  const WUV = [0.5, 0.5];
  for (let w = 0; w < 4; w++) {
    const side = w % 2 === 0 ? 1 : -1, z = w < 2 ? D.frontAxleZ : D.rearAxleZ;
    const m = mul(mT(side * D.track / 2, r, z), mS(side, 1, 1));
    b.with(m, () => {
      b.set('skinIndex', w, 0, 0, 0);
      // neumático
      b.set('color', 1, 1, 1); b.set('aRM', 0.82, 0, 1); b.set('aGlow', 0, 0);
      const h = tw / 2;
      const tp = lod
        ? [[rimR + 0.004, -h + 0.02], [r - 0.03, -h], [r, -h + 0.04], [r, h - 0.04], [r - 0.03, h], [rimR + 0.004, h - 0.02]]
        : [[rimR + 0.004, -h + 0.022], [0.285, -h], [0.322, -h + 0.004], [0.336, -h + 0.02], [r, -h + 0.045], [r, 0], [r, h - 0.045], [0.336, h - 0.02], [0.322, h - 0.004], [0.285, h], [rimR + 0.004, h - 0.022]];
      kit.lathe(b, tp, seg, null, { uv: tyreUV(side) });
      b.set('uv', WUV[0], WUV[1]);
      // disco de freno (perforado; brilla con setBrake)
      if (!lod) {
        b.set('color', 0.62, 0.62, 0.66); b.set('aRM', 0.42, 0.75, 1);
        kit.lathe(b, [[0.105, -0.05], [0.198, -0.05], [0.198, -0.018], [0.105, -0.018]], 28, null, { hard: true, uv: tyreUV(side), glow: (rr) => [rr > 0.11 ? 1 : 0, 0] });
        b.set('aGlow', 0, 0); b.set('uv', WUV[0], WUV[1]);
        // buje / mangueta
        b.set('color', 0.05, 0.05, 0.06); b.set('aRM', 0.6, 0.4, 1);
        kit.lathe(b, [[0.1, -0.12], [0.1, -0.02], [0.06, 0.02]], 12, null, {});
      }
      // barril interior de llanta
      b.set('color', rimDark); b.set('aRM', 0.45, 0.8, 1);
      kit.lathe(b, [[rimR - 0.006, h - 0.015], [rimR - 0.006, -h + 0.02]], lod ? 12 : 28, null, {});
      // pestaña pulida
      b.set('color', lipC); b.set('aRM', 0.18, 1, 1);
      kit.lathe(b, lod ? [[rimR + 0.012, h - 0.004], [rimR - 0.02, h - 0.012]] : [[rimR + 0.014, h - 0.012], [rimR + 0.008, h - 0.004], [rimR - 0.004, h - 0.006], [rimR - 0.022, h - 0.018]], lod ? 14 : 36, null, {});
      // radios
      b.set('color', rimC); b.set('aRM', W.rough ?? 0.3, W.metal ?? 0.85, 1);
      spokes(b, kit, W, lod, rimR, h, colors);
      // tuerca central
      b.set('color', colors.nut); b.set('aRM', 0.25, 0.9, 1);
      b.geo(new THREE.CylinderGeometry(0.042, 0.046, 0.045, 6), mul(mT(h - 0.005, 0, 0), mR(0, 0, -Math.PI / 2)));
      if (!lod) {
        b.set('color', 0.85, 0.85, 0.88);
        b.geo(new THREE.CylinderGeometry(0.014, 0.014, 0.05, 8), mul(mT(h + 0.008, 0, 0), mR(0, 0, -Math.PI / 2)));
        // pinza de freno (sólo gira con la dirección)
        b.set('skinIndex', 4 + w, 0, 0, 0);
        b.set('color', colors.caliper); b.set('aRM', 0.35, 0.3, 1);
        const ac = -0.75;
        kit.lathe(b, [[0.152, 0.004], [0.152, -0.082], [0.214, -0.082], [0.214, 0.004], [0.152, 0.004]], 6, null, { hard: true, a0: ac - 0.55, a1: ac + 0.55 });
        b.set('color', 0.95, 0.95, 0.95);
        kit.lathe(b, [[0.2, 0.0045], [0.172, 0.0045]], 4, null, { a0: ac - 0.3, a1: ac + 0.3 });
      }
    });
  }
  return b;
}
function spokes(b, kit, W, lod, rimR, h, colors) {
  const n = W.n || 10, x0 = h - 0.012, rh = 0.06, rl = rimR - 0.012;
  const dish = W.dish ?? 0.03;
  const sp = (ang, wHub, wLip, thick, twist = 0, xs = 0) => {
    const c = [], ca = (a, rr) => [Math.cos(a) * rr, Math.sin(a) * rr];
    const corners = [[rh, -wHub, x0 - thick + xs], [rl, -wLip, x0 - dish - thick + xs], [rl, wLip, x0 - dish - thick + xs], [rh, wHub, x0 - thick + xs]];
    for (const fr of [0, 1]) for (const [rr, ww, xx] of corners) {
      const a = ang + Math.atan2(ww, rr) + (rr > 0.1 ? twist : 0), p = ca(a, Math.hypot(rr, ww));
      c.push([xx + fr * thick, p[0], p[1]]);
    }
    // orden box8: 000,100,110,010,001,101,111,011 → (x hacia fuera = eje 'z' del box)
    kit.box8(b, [c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]].map((p) => p));
  };
  if (W.type === 'aero') { // tapacubos aerodinámico (Grupo C)
    b.set('aRM', 0.3, 0.6, 1);
    kit.lathe(b, [[rimR - 0.01, h - 0.03], [0.09, h - 0.002], [0.0, h + 0.004]], lod ? 14 : 36, null, {});
    if (!lod) {
      b.set('color', colors.nut);
      for (let i = 0; i < 8; i++) sp((i / 8) * TAU, 0.006, 0.02, 0.012, 0.5, 0.012);
    }
    return;
  }
  if (lod) { for (let i = 0; i < Math.min(n, 6); i++) sp((i / Math.min(n, 6)) * TAU, 0.022, 0.026, 0.03); return; }
  if (W.type === 'y') { for (let i = 0; i < n; i++) { const a = (i / n) * TAU; sp(a, 0.02, 0.012, 0.028); sp(a + 0.12, 0.004, 0.012, 0.026, 0.12); sp(a - 0.12, 0.004, 0.012, 0.026, -0.12); } }
  else if (W.type === 'twist') { for (let i = 0; i < n; i++) sp((i / n) * TAU, 0.018, 0.02, 0.03, 0.35); }
  else if (W.type === 'blade') { for (let i = 0; i < n; i++) sp((i / n) * TAU, 0.03, 0.045, 0.022, 0.7); }
  else if (W.type === 'deep') { for (let i = 0; i < n; i++) sp((i / n) * TAU, 0.016, 0.02, 0.026, 0, -0.03); }
  else for (let i = 0; i < n; i++) sp((i / n) * TAU, 0.014, 0.016, 0.028);
  // centro de llanta
  b.set('color', colors.rim);
  kit.lathe(b, [[0.075, x0 - 0.02], [0.05, x0 + 0.002], [0.0, x0 + 0.006]], 20, null, {});
}

/* ---------------------------------------------------------------------
   Luces: helpers de canal (base, faros, freno)
   --------------------------------------------------------------------- */
const CH = { DRL: [1, 0, 0, 0], HEAD: [0.3, 1, 0, 0], TAIL: [0.45, 0, 1.25, 0], BRAKE: [0.04, 0, 1.6, 0], ALWAYS: [1, 0, 0, 0] };

/* ---------------------------------------------------------------------
   Decoración (canvas): API de pintura por regiones
   --------------------------------------------------------------------- */
function makePainter(L, ctx, colors) {
  const A = {
    x: ctx, L, col: colors, cur: null, num: colors.num, name: colors.name,
    region(reg, fn) {
      const r = L.R[reg], t = L.T[reg];
      ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
      ctx.setTransform(...t.m); A.cur = t; A.reg = reg;
      try { fn(ctx); } finally { ctx.restore(); A.cur = null; }
    },
    side(fn) { A.region(0, (x) => fn(x, 1)); A.region(1, (x) => fn(x, -1)); },
    top(fn) { A.region(2, fn); }, front(fn) { A.region(3, fn); }, rear(fn) { A.region(4, fn); },
    /** Rótulo orientado al espectador (unidades: cm). */
    label(a, b, fn, rot = 0) {
      const t = A.cur; ctx.save(); ctx.translate(a, b); ctx.scale(t.lab[0] * 0.01, t.lab[1] * 0.01); ctx.rotate(rot); fn(ctx); ctx.restore();
    },
    text(str, a, b, size, o = {}) {
      A.label(a, b, (x) => {
        x.font = `${o.weight || 900} ${o.italic ? 'italic ' : ''}${size}px ${o.font || FONT}`;
        x.textAlign = o.align || 'center'; x.textBaseline = 'middle';
        if (o.skew) x.transform(1, 0, -o.skew, 1, 0, 0);
        if (o.stroke) { x.lineJoin = 'round'; x.lineWidth = o.strokeW || size * 0.14; x.strokeStyle = o.stroke; x.strokeText(str, 0, 0, o.maxW); }
        x.fillStyle = o.color || '#fff'; x.fillText(str, 0, 0, o.maxW);
      }, o.rot || 0);
    },
    roundel(num, a, b, r, o = {}) {
      A.label(a, b, (x) => {
        const R = r * 100;
        if (o.shape === 'rect') { x.fillStyle = o.bg || '#fff'; roundRect(x, -R * 1.1, -R * 0.8, R * 2.2, R * 1.6, R * 0.25); x.fill(); if (o.ring) { x.lineWidth = R * 0.1; x.strokeStyle = o.ring; x.stroke(); } }
        else { x.beginPath(); x.arc(0, 0, R, 0, TAU); x.fillStyle = o.bg || '#fff'; x.fill(); if (o.ring) { x.lineWidth = R * 0.12; x.strokeStyle = o.ring; x.stroke(); } }
        x.fillStyle = o.color || '#0b0b12'; x.font = `900 ${o.italic ? 'italic ' : ''}${R * (String(num).length > 1 ? 1.12 : 1.38)}px ${o.font || FONT}`; x.textAlign = 'center'; x.textBaseline = 'middle';
        if (o.skew) x.transform(1, 0, -o.skew, 1, 0, 0);
        x.fillText(String(num), 0, R * 0.07);
      }, o.rot || 0);
    },
    /** Patrocinador ficticio (estilos variados). */
    sponsor(name, a, b, h, style = 0, o = {}) {
      A.label(a, b, (x) => {
        const H2 = h * 100;
        x.textAlign = 'center'; x.textBaseline = 'middle';
        if (style === 1) { // caja de color
          x.font = `900 italic ${H2 * 0.62}px ${FONT2}`; const w = x.measureText(name).width + H2 * 0.7;
          x.fillStyle = o.bg || '#fff'; x.save(); x.transform(1, 0, -0.25, 1, 0, 0); x.fillRect(-w / 2, -H2 / 2, w, H2); x.restore();
          x.fillStyle = o.color || '#111'; x.fillText(name, 0, H2 * 0.04);
        } else if (style === 2) { // logotipo con símbolo
          x.font = `800 ${H2 * 0.7}px ${FONT2}`; const w = x.measureText(name).width;
          x.fillStyle = o.color || '#fff'; x.beginPath(); x.arc(-w / 2 - H2 * 0.45, 0, H2 * 0.38, 0, TAU); x.fill();
          x.fillStyle = o.bg || '#111'; x.beginPath(); x.arc(-w / 2 - H2 * 0.45, 0, H2 * 0.18, 0, TAU); x.fill();
          x.fillStyle = o.color || '#fff'; x.fillText(name, H2 * 0.15, 0);
        } else if (style === 3) { // cursiva con subrayado
          x.font = `900 italic ${H2 * 0.8}px ${FONT2}`; const w = x.measureText(name).width;
          x.fillStyle = o.color || '#fff'; x.fillText(name, 0, -H2 * 0.08);
          x.fillRect(-w / 2, H2 * 0.38, w * 0.86, H2 * 0.1); x.fillStyle = o.color2 || o.color || '#fff'; x.fillRect(-w / 2 + w * 0.88, H2 * 0.38, w * 0.12, H2 * 0.1);
        } else { // texto plano
          x.font = `900 ${o.italic === false ? '' : 'italic '}${H2 * 0.8}px ${o.font || FONT}`;
          if (o.stroke) { x.lineWidth = H2 * 0.12; x.strokeStyle = o.stroke; x.lineJoin = 'round'; x.strokeText(name, 0, 0); }
          x.fillStyle = o.color || '#fff'; x.fillText(name, 0, 0);
        }
      }, o.rot || 0);
    },
    /** Fila de pegatinas de contingencia. */
    stickers(a, b, n, w, h, seed = 1) {
      const R = rng(seed), names = ['NOVA', 'KRN', 'LUX', 'AXL', 'ZETA', 'VOLT', 'OKO', 'RPM', 'ARC', 'DYN'];
      A.label(a, b, (x) => {
        const W2 = w * 100, H2 = h * 100;
        for (let i = 0; i < n; i++) {
          const cx = (i - (n - 1) / 2) * (W2 + 2);
          const bgc = ['#ffffff', '#111318', '#ffd23a', '#e8e8f0', '#2aa8ff'][(R() * 5) | 0];
          x.fillStyle = bgc; x.fillRect(cx - W2 / 2, -H2 / 2, W2, H2);
          x.fillStyle = bgc === '#111318' || bgc === '#2aa8ff' ? '#ffffff' : '#111318';
          x.font = `900 italic ${H2 * 0.55}px ${FONT2}`; x.textAlign = 'center'; x.textBaseline = 'middle';
          x.fillText(names[(R() * names.length) | 0], cx, H2 * 0.04, W2 * 0.9);
        }
      });
    },
  };
  return A;
}
/** Juntas de paneles, tapón de combustible y puntos de gato (detalle de primer plano). */
function seams(A, D) {
  const cp = D.canopy, sd = D.seams || {};
  const line = (x, draw, w = 0.006) => { x.save(); x.lineCap = 'round'; x.lineJoin = 'round'; x.strokeStyle = 'rgba(0,0,0,0.5)'; x.lineWidth = w; draw(); x.stroke(); x.restore(); };
  A.side((x) => {
    const zf = sd.doorF ?? Math.min(cp.z0 - 0.05, D.frontAxleZ - D.archList[0].rz - 0.06), zr = sd.doorR ?? Math.max(cp.driver[1] - 0.6, D.rearAxleZ + D.archList[1].rz + 0.08);
    const yb = sd.doorB ?? D.body.ySill(0) + 0.07, yt = sd.doorT ?? D.body.yShoulder((zf + zr) / 2) - 0.02;
    line(x, () => { x.beginPath(); x.moveTo(zf, yt); x.lineTo(zf + 0.03, yb + 0.03); x.quadraticCurveTo(zf, yb, zf - 0.04, yb); x.lineTo(zr + 0.05, yb); x.quadraticCurveTo(zr, yb, zr, yb + 0.05); x.lineTo(zr + 0.02, yt); });
    // tirador / puntos de gato
    x.fillStyle = 'rgba(0,0,0,0.55)'; x.fillRect(zr + 0.12, yt - 0.11, 0.1, 0.022);
    for (const zj of [D.frontAxleZ - D.archList[0].rz - 0.12, D.rearAxleZ + D.archList[1].rz + 0.12]) { x.fillStyle = '#1a1a1e'; x.beginPath(); x.arc(zj, D.body.ySill(zj) + 0.035, 0.018, 0, TAU); x.fill(); x.fillStyle = '#c8c8cc'; x.beginPath(); x.arc(zj, D.body.ySill(zj) + 0.035, 0.008, 0, TAU); x.fill(); }
  });
  A.top((x) => {
    // capó delantero y tapa de motor
    const zh = D.frontAxleZ + 0.15, w = 0.42;
    line(x, () => { x.beginPath(); x.moveTo(D.zFront + 0.2, w); x.lineTo(zh, w * 0.9); x.quadraticCurveTo(zh - 0.12, 0, zh, -w * 0.9); x.lineTo(D.zFront + 0.2, -w); });
    line(x, () => { x.beginPath(); x.moveTo(cp.z1 - 0.06, 0.36); x.lineTo(D.zRear - 0.2, 0.42); x.moveTo(cp.z1 - 0.06, -0.36); x.lineTo(D.zRear - 0.2, -0.42); });
    // tapón de combustible
    const fz = cp.driver[1] - 0.5, fx = 0.66;
    x.fillStyle = '#2a2b30'; x.beginPath(); x.arc(fz, fx, 0.045, 0, TAU); x.fill();
    x.fillStyle = '#b9bcc4'; x.beginPath(); x.arc(fz, fx, 0.032, 0, TAU); x.fill();
    x.fillStyle = '#e8262b'; x.beginPath(); x.arc(fz, fx, 0.012, 0, TAU); x.fill();
  });
}
function roundRect(x, X, Y, w, h, r) { x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r); x.arcTo(X + w, Y + h, X, Y + h, r); x.arcTo(X, Y + h, X, Y, r); x.arcTo(X, Y, X + w, Y, r); x.closePath(); }

/** Máscara de daños (R = umbral de rozadura, G = suciedad) en el mismo atlas. */
function paintDamage(D, L, W, H, seed) {
  const c1 = canvasOf(W, H), a = c1.getContext('2d');
  const c2 = canvasOf(W, H), d = c2.getContext('2d');
  a.fillStyle = '#fff'; a.fillRect(0, 0, W, H);
  d.fillStyle = '#000'; d.fillRect(0, 0, W, H);
  const R = rng(seed * 7919 + 13);
  const sx = W / L.W, sy = H / L.H;
  for (const reg of [0, 1, 2, 3, 4]) {
    const r = L.R[reg], t = L.T[reg].m;
    for (const ctx of [a, d]) { ctx.save(); ctx.beginPath(); ctx.rect(r.x * sx, r.y * sy, r.w * sx, r.h * sy); ctx.clip(); ctx.setTransform(t[0] * sx, 0, 0, t[3] * sy, t[4] * sx, t[5] * sy); }
    // suciedad: zonas bajas, detrás de las ruedas, frontal (insectos)
    if (reg <= 1) {
      const g = d.createLinearGradient(0, 0.05, 0, 0.6); g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      d.fillStyle = g; d.fillRect(L.zMin, 0, L.zMax - L.zMin, 0.6);
      for (const zA of [D.frontAxleZ, D.rearAxleZ]) { const g2 = d.createRadialGradient(zA - 0.6, 0.35, 0.05, zA - 0.6, 0.35, 0.7); g2.addColorStop(0, 'rgba(255,255,255,0.7)'); g2.addColorStop(1, 'rgba(255,255,255,0)'); d.fillStyle = g2; d.fillRect(zA - 1.4, 0, 1.6, 1); }
    } else if (reg === 3) { d.fillStyle = 'rgba(255,255,255,0.45)'; d.fillRect(-1.3, 0, 2.6, 1.4); }
    else if (reg === 4) { d.fillStyle = 'rgba(255,255,255,0.8)'; d.fillRect(-1.3, 0, 2.6, 1.4); }
    else { d.fillStyle = 'rgba(255,255,255,0.18)'; d.fillRect(L.zMin, -1.3, L.zMax - L.zMin, 2.6); }
    // rozaduras
    const n = reg <= 1 ? 70 : reg === 2 ? 26 : 22;
    for (let i = 0; i < n; i++) {
      const thr = 0.06 + R() * 0.9, g = Math.round(thr * 255);
      a.strokeStyle = `rgb(${g},${g},${g})`; a.lineCap = 'round';
      let pz, py;
      if (reg <= 1) { const zone = R(); pz = zone < 0.3 ? D.zFront - R() * 0.5 : zone < 0.55 ? D.zRear + R() * 0.5 : lerp(D.zRear, D.zFront, R()); py = 0.12 + R() * (zone < 0.55 ? 0.5 : 0.3); }
      else if (reg === 2) { pz = lerp(D.zRear, D.zFront, R()); py = (R() * 2 - 1) * 1.05; }
      else { pz = (R() * 2 - 1) * 1.0; py = 0.1 + R() * 0.5; }
      const len = 0.04 + R() * 0.22, ang = (R() - 0.5) * 0.7;
      a.lineWidth = 0.006 + R() * 0.02;
      a.beginPath(); a.moveTo(pz, py); a.lineTo(pz + Math.cos(ang) * len, py + Math.sin(ang) * len); a.stroke();
      if (R() < 0.35) { a.lineWidth *= 0.5; a.beginPath(); a.moveTo(pz, py + 0.012); a.lineTo(pz + Math.cos(ang) * len * 0.8, py + 0.012 + Math.sin(ang) * len * 0.8); a.stroke(); }
    }
    a.restore(); d.restore();
  }
  const ia = a.getImageData(0, 0, W, H), id = d.getImageData(0, 0, W, H);
  for (let i = 0; i < ia.data.length; i += 4) { ia.data[i + 1] = id.data[i]; ia.data[i + 2] = 0; ia.data[i + 3] = 255; }
  a.putImageData(ia, 0, 0);
  const t = new THREE.CanvasTexture(c1); t.colorSpace = THREE.NoColorSpace;
  return t;
}

/* =====================================================================
   DISEÑOS
   ===================================================================== */
const ARCH = (z, r, top) => ({ z, rz: r + 0.075, ry: r + 0.055, cy: r, top });

const DESIGN_DEFS = [];

function shade(hex, k) {
  const c = new THREE.Color(hex);
  if (k < 0) c.multiplyScalar(1 + k); else c.lerp(new THREE.Color(1, 1, 1), k);
  return '#' + c.getHexString();
}
const SPONS = ['VOLTEX', 'NEÓN ENERGY', 'ÓRBITA', 'KRONO', 'AURA OIL', 'ZÉFIRO', 'LUMEN', 'RAYO-X', 'NOVA FUEL', 'MAGMA', 'PIXELCOM', 'TURBINA'];

/* ---------- piezas comunes ---------- */
const CARBON_RM = [0.5, 0.2, 1], MATTE_RM = [0.85, 0, 0], CHROME_RM = [0.08, 1, 0], GLASSM_RM = [0.04, 1, 0];
function trimSet(T, col, rm) { T.set('color', col); T.set('aRM', rm); }
/** Retrovisores aerodinámicos con brazo de carbono. */
function mirrors(k, x, z, h = 0.12, out = 0.07) {
  if (k.lod) return;
  const { B, body } = k, P = B.paint, T = B.trim, y0 = body.topY(z, x) - 0.01, mx = x + out, my = y0 + h;
  k.sym([P, T], () => {
    // carcasa en lágrima (pintada), abierta por detrás con el espejo
    P.set('proj', 1);
    k.lathe(P, [[0.05, -0.02], [0.056, -0.012], [0.058, 0.02], [0.05, 0.06], [0.03, 0.095], [0.0, 0.11]], 14, mul(mT(mx, my, z - 0.03), mR(0, -Math.PI / 2, 0), mS(1, 0.62, 1)));
    trimSet(T, [0.6, 0.66, 0.78], GLASSM_RM);
    k.lathe(T, [[0.0, -0.016], [0.047, -0.016]], 14, mul(mT(mx, my, z - 0.03), mR(0, -Math.PI / 2, 0), mS(1, 0.62, 1)));
    // brazo
    trimSet(T, k.col.carbon, CARBON_RM);
    k.box8(T, [[x - 0.012, y0, z - 0.005], [mx - 0.01, my - 0.012, z - 0.005], [mx - 0.01, my - 0.012, z + 0.045], [x - 0.012, y0, z + 0.07], [x + 0.008, y0, z - 0.005], [mx + 0.01, my - 0.012, z - 0.005], [mx + 0.01, my - 0.012, z + 0.045], [x + 0.008, y0, z + 0.07]]);
  });
}
/** Escapes: lista de { p:[x,y,z], d:[dx,dy,dz], r }. */
function exhausts(k, list) {
  const T = k.B.trim;
  for (const e of list) {
    const r = e.r || 0.045, dir = e.d || [0, 0, -1];
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(...dir).normalize());
    const m = mul(mT(...e.p), new THREE.Matrix4().makeRotationFromQuaternion(q));
    T.set('aRM', 0.28, 0.9, 0);
    k.lathe(T, [[r, -0.22], [r, 0], [r - 0.006, 0.006], [r - 0.013, 0.0], [r - 0.013, -0.12], [0.0, -0.12]], k.lod ? 8 : 16, m, {
      col: (rr, xx) => (rr < r - 0.01 ? [0.02, 0.02, 0.02] : mixc([0.55, 0.56, 0.6], [0.3, 0.2, 0.48], clamp((xx + 0.14) / 0.14, 0, 1))),
    });
    k.exhaust.push(e.p.slice()); k.exhaustDir.push(dir);
  }
}
/** Splitter delantero (placa horizontal) con labio. */
function splitter(k, z0, z1, xw, y = 0.06, round = 0.25) {
  const T = k.B.trim; trimSet(T, k.col.carbon, CARBON_RM);
  z1 = Math.min(z1, k.D.zFront + 0.04); xw = Math.min(xw, 0.96);
  const pts = [[-xw, z0], [xw, z0], [xw, z1 - round], [xw - round * 0.6, z1], [-xw + round * 0.6, z1], [-xw, z1 - round]];
  const n0 = T.n;
  k.plateXZ(T, pts, y, 0.024, 0.004);
  // daños: la esquina izquierda del splitter cuelga (setDamage > 0.45)
  const LA = T.A.aLoose; if (LA) for (let i = n0; i < T.n; i++) { const x = T.P[i * 3], z = T.P[i * 3 + 2]; LA[i] = clamp((x - 0.15) / (xw - 0.15), 0, 1) * clamp((z - z0) / (z1 - z0) + 0.3, 0, 1); }
}
/** Aletas del difusor bajo la cola. */
function diffuser(k, xs, z0, z1, hTop) {
  if (k.lod) return;
  const T = k.B.trim; trimSet(T, k.col.carbon, CARBON_RM);
  for (const x of xs) k.plateZY(T, [[z0, 0.09], [z1, hTop], [z1 - 0.02, 0.07], [z0 + 0.1, 0.07]], x - 0.008, 0.016, 0.002);
}
/** Planos de buceo (canards) en las esquinas del morro. */
function canards(k, list) {
  if (k.lod) return;
  const T = k.B.trim; trimSet(T, k.col.carbon, CARBON_RM);
  k.sym(T, () => {
    for (const c of list) {
      const p = k.drape('front', c.x, c.y, 0).p;
      const z = p[2] - 0.12;
      k.plateXZ(T, [[c.x - 0.02, z], [c.x + c.w, z + 0.04], [c.x + c.w, z + 0.16], [c.x - 0.02, z + 0.24]], c.y - 0.006, 0.012, 0.002);
    }
  });
}
/** Rejillas de aletas sobre una superficie (respiraderos de paso de rueda). */
function louvers(k, mode, z0, z1, x0, x1, n, o = {}) {
  if (k.lod) return;
  const T = k.B.trim, P = k.B.paint;
  k.sym([T, P], () => {
    trimSet(T, [0.01, 0.01, 0.012], MATTE_RM);
    k.ribbon(T, mode, [[z0, (x0 + x1) / 2], [z1, (x0 + x1) / 2]], Math.abs(x1 - x0) / 2, { off: 0.003, across: 3 });
    const tgt = o.paint ? P : T;
    if (!o.paint) trimSet(T, k.col.carbon, CARBON_RM); else P.set('proj', 1);
    for (let i = 0; i < n; i++) {
      const z = lerp(z0, z1, (i + 0.5) / n);
      k.ribbon(tgt, mode, [[z, x0 + 0.01], [z, x1 - 0.01]], 0.011, { off: 0.016, across: 2 });
    }
  });
}
/** Conducto NACA (lágrima oscura) sobre la superficie. */
function naca(k, mode, u0, v0, u1, v1, w) {
  if (k.lod) return;
  const T = k.B.trim; trimSet(T, [0.012, 0.012, 0.015], MATTE_RM);
  const pts = []; for (let i = 0; i <= 6; i++) pts.push([lerp(u0, u1, i / 6), lerp(v0, v1, i / 6)]);
  k.ribbon(T, mode, pts, (t) => w * (0.25 + 0.75 * Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.5)), { off: 0.003, across: 2 });
}
/** Alerón trasero completo: plano principal (+flap), derivas y soportes. */
function rearWing(k, o) {
  const { B } = k, T = B.trim, P = B.paint;
  const wingB = o.paintWing ? P : T;
  if (o.paintWing) { P.set('proj', 0); P.set('color', o.wingCol || k.col.A); } else trimSet(T, k.col.carbon, CARBON_RM);
  k.airfoil(wingB, { x0: -o.span, x1: o.span, y: o.y, z: o.z, chord: o.chord, thick: o.thick ?? 0.11, camber: o.camber ?? 0.06, pitch: o.pitch ?? 0.1, bend: o.bend });
  if (o.flap) k.airfoil(wingB, { x0: -o.span, x1: o.span, y: o.y + o.flap.dy, z: o.z - o.chord * 0.92, chord: o.flap.chord, thick: 0.1, camber: 0.08, pitch: o.flap.pitch ?? 0.45, bend: o.bend });
  if (o.gurney && !k.lod) { const zt = o.z - (o.flap ? o.chord * 0.92 + o.flap.chord * 0.95 : o.chord * 0.98); const yt = o.y + (o.flap ? o.flap.dy + o.flap.chord * 0.42 : o.chord * 0.12); k.box(wingB, 0, yt + 0.015, zt, o.span, 0.018, 0.004); }
  P.set('proj', 1); P.set('color', 1, 1, 1);
  // derivas (endplates)
  if (o.plate) {
    const pb = o.plate.paint ? P : T;
    if (o.plate.paint) { P.set('proj', o.plate.solid ? 0 : 1); if (o.plate.solid) P.set('color', o.plate.solid); } else trimSet(T, k.col.carbon, CARBON_RM);
    k.sym(pb, () => k.plateZY(pb, o.plate.pts, o.span - 0.004, o.plate.th || 0.022));
    P.set('proj', 1); P.set('color', 1, 1, 1);
  }
  // soportes
  if (o.mount === 'swan') {
    trimSet(T, k.col.carbon, CARBON_RM);
    for (const x of o.mountX) {
      const yd = k.body.topY(o.z - 0.1, x) - 0.06, top = o.y + o.chord * 0.25;
      k.plateZY(T, [[o.z + 0.25, yd], [o.z + 0.05, yd + 0.05], [o.z - 0.05, top + 0.06], [o.z - 0.25, top + 0.1], [o.z - 0.3, top + 0.02], [o.z - 0.12, top - 0.02], [o.z + 0.0, yd + 0.15], [o.z + 0.12, yd]], x - 0.01, 0.02, 0.003);
    }
  } else if (o.mount === 'stalk') {
    trimSet(T, k.col.carbon, CARBON_RM);
    for (const x of o.mountX) {
      const yd = k.body.topY(o.z - o.chord * 0.4, x) - 0.05;
      k.plateZY(T, [[o.z - 0.05, yd], [o.z - o.chord * 0.25, o.y + 0.02], [o.z - o.chord * 0.75, o.y + 0.02], [o.z - o.chord * 0.6, yd]], x - 0.01, 0.02, 0.003);
    }
  }
}
/** Placa central (aleta de tiburón). */
function sharkFin(k, pts, th = 0.022) { const P = k.B.paint; P.set('proj', 1); P.set('color', 1, 1, 1); k.plateZY(P, pts, -th / 2, th); }
function setL(L, ch, col) { L.set('aCh', ch); L.set('color', col); }
const WHITE_LED = [3.2, 3.2, 3.5], RED_LED = [2.4, 0.05, 0.09], RED_BRK = [2.8, 0.04, 0.08], AMBER = [3, 1.1, 0.1];
const hdr = (c, k) => c.map((v) => v * k);
function addLamp(k, list, mode, x, y) { for (const s of [1, -1]) { const p = k.drape(mode, x, y, 0.02).p; p[0] *= s; k.lamps[list].push(p); } }

/* ---------- 0 · RELÁMPAGO #1 — prototipo «cola larga» de baja resistencia ---------- */
DESIGN_DEFS.push({
  key: 'relampago', title: 'Prototipo «Cola Larga»',
  desc: 'Baja resistencia: carrocería en lágrima, ruedas traseras carenadas, alerón fino entre derivas y LED en cuchilla.',
  wb: 2.86, track: 1.84, r: 0.34, tyreW: 0.3, zFront: 2.3, zRear: -2.62,
  noseR: 0.34, noseY: 0.19, noseShrink: 0.06, tailR: 0.3, tailY: 0.6, tailShrink: 0.1, wellX: 0.6,
  arches: { front: {}, rear: { top: 0.25 } },
  body: {
    xHalf: cv(-2.62, 0.88, -2.25, 1.02, -1.85, 1.1, -1.43, 1.115, -0.95, 1.08, -0.45, 0.97, 0.35, 0.95, 0.95, 1.05, 1.43, 1.085, 1.9, 1.04, 2.3, 0.9),
    yFloor: cv(-2.62, 0.4, -2.2, 0.27, -1.6, 0.1, 1.7, 0.08, 2.3, 0.13),
    ySill: cv(-2.62, 0.44, -2.2, 0.31, -1.6, 0.15, 1.8, 0.13, 2.3, 0.17),
    yShoulder: cv(-2.62, 0.7, -1.43, 0.79, -0.5, 0.66, 0.5, 0.6, 1.43, 0.74, 2.0, 0.56, 2.3, 0.4),
    tumble: cv(0, 0.1), undercut: cv(-1.9, 0.02, -1.0, 0.045, 0, 0.045),
    xCrown: cv(-2.62, 0.7, -1.43, 0.84, -0.5, 0.76, 0.5, 0.74, 1.43, 0.83, 2.3, 0.72),
    yCrown: cv(-2.62, 0.82, -1.43, 0.9, -0.6, 0.8, 0.4, 0.72, 1.43, 0.86, 1.95, 0.7, 2.3, 0.44),
    xValley: cv(-2.62, 0.42, -1.2, 0.5, 0, 0.53, 1.43, 0.46, 2.3, 0.4),
    yValley: cv(-2.62, 0.72, -1.43, 0.74, -0.3, 0.66, 0.6, 0.56, 1.43, 0.5, 2.3, 0.3),
    yCenter: cv(-2.62, 0.76, -1.6, 0.8, -0.6, 0.77, 0.4, 0.66, 1.2, 0.5, 1.9, 0.38, 2.3, 0.25),
  },
  canopy: {
    z0: 1.05, z1: -1.9, n: 2.8, tumble: 0.2, sink: 0.03,
    w: cv(-1.9, 0.22, -1.25, 0.38, -0.45, 0.48, 0.3, 0.48, 0.75, 0.42, 1.05, 0.3),
    h: cv(-1.9, -0.04, -1.4, 0.16, -0.6, 0.3, 0.0, 0.37, 0.55, 0.27, 1.05, -0.04),
    cuts: [0.06, 0.02, -0.58],
    glass: (z, t) => (z > 0.06 ? (t > 0.93 && z < 0.5 ? 'paint' : 'glass') : z > 0.02 ? 'paint' : z > -0.58 ? (t < 0.68 ? 'glass' : 'paint') : 'paint'),
    driver: [0.0, -0.32],
  },
  paint: { metal: 0.18, rough: 0.3 },
  wheel: { type: 'multi', n: 10, dish: 0.035 },
  parts(k) {
    const { B } = k, P = B.paint;
    sharkFin(k, [[-0.62, 0.9], [-1.4, 1.0], [-2.3, 1.06], [-2.52, 1.03], [-2.54, 0.74], [-0.8, 0.72]]);
    P.set('proj', 1);
    k.sym(P, () => k.plateZY(P, [[-1.0, 0.86], [-1.9, 0.98], [-2.52, 1.03], [-2.68, 0.99], [-2.66, 0.72], [-1.2, 0.8]], 0.8, 0.035));
    rearWing(k, { span: 0.8, y: 0.97, z: -2.26, chord: 0.32, thick: 0.1, camber: 0.04, pitch: 0.08 });
    splitter(k, 1.8, 2.36, 0.94, 0.06, 0.3);
    diffuser(k, [-0.6, -0.25, 0.25, 0.6], -1.55, -2.62, 0.4);
    louvers(k, 'top', 1.18, 1.5, 0.66, 0.94, 6);
    naca(k, 'top', 1.3, 0.15, 1.75, 0.15, 0.05);
    mirrors(k, 0.84, 0.5, 0.11);
    exhausts(k, [{ p: [0.15, 0.53, -2.56] }, { p: [-0.15, 0.53, -2.56] }]);
  },
  lights(k) {
    const L = k.B.lights, G = k.B.glass, c = k.col;
    k.sym([L, G], () => {
      setL(L, CH.DRL, hdr(mixc(c.P, [1, 1, 1], 0.35), 2.6));
      k.ribbon(L, 'front', [[0.36, 0.32], [0.6, 0.39], [0.85, 0.47], [1.0, 0.53]], 0.012, { off: 0.006 });
      setL(L, CH.HEAD, WHITE_LED);
      for (let i = 0; i < 3; i++) k.disc(L, 'front', 0.66 + i * 0.1, 0.455 + i * 0.03, 0.028, { off: 0.008 });
      k.ribbon(G, 'front', [[0.55, 0.42], [0.98, 0.52]], 0.065, { off: 0.016, across: 3 });
    });
    addLamp(k, 'head', 'front', 0.76, 0.48);
    setL(L, CH.TAIL, RED_LED);
    k.ribbon(L, 'rear', [[-0.84, 0.66], [-0.4, 0.69], [0, 0.7], [0.4, 0.69], [0.84, 0.66]], 0.016, { off: 0.008 });
    setL(L, CH.BRAKE, RED_BRK);
    k.ribbon(L, 'rear', [[-0.12, 0.63], [0.12, 0.63]], 0.02, { off: 0.008 });
    addLamp(k, 'tail', 'rear', 0.6, 0.68); addLamp(k, 'brake', 'rear', 0.6, 0.68);
  },
  livery(A) {
    const c = A.col, P = c.hex, AC = c.hexA;
    A.side((x) => {
      const g = x.createLinearGradient(0, 0.95, 0, 0.1); g.addColorStop(0, P); g.addColorStop(0.55, P); g.addColorStop(1, shade(P, -0.3));
      x.fillStyle = g; x.fillRect(-3, 0, 6, 1.5);
      x.fillStyle = AC; x.beginPath(); x.moveTo(2.4, 0.0); x.lineTo(2.4, 0.28); x.bezierCurveTo(1.4, 0.26, 0.8, 0.36, -0.2, 0.36); x.bezierCurveTo(-1.3, 0.36, -1.9, 0.5, -2.8, 0.66); x.lineTo(-2.8, 0); x.closePath(); x.fill();
      x.fillStyle = '#ffffff';
      x.beginPath(); x.moveTo(2.2, 0.36); x.lineTo(0.9, 0.42); x.lineTo(0.84, 0.49); x.lineTo(-0.35, 0.42); x.lineTo(-0.3, 0.5); x.lineTo(-2.1, 0.47); x.lineTo(-0.6, 0.56); x.lineTo(-0.66, 0.5); x.lineTo(0.6, 0.55); x.lineTo(0.55, 0.47); x.closePath(); x.fill();
      x.fillStyle = AC; x.fillRect(-3, 0.66, 6, 0.008);
      A.roundel(A.num, 0.12, 0.62, 0.16, { ring: AC, bg: '#fff' });
      A.sponsor('VOLTEX', -1.05, 0.66, 0.08, 0, { color: AC });
      A.sponsor('NEÓN ENERGY', 1.15, 0.24, 0.055, 1, { bg: '#fff', color: '#0b0d14' });
      A.sponsor('ÓRBITA', -1.95, 0.6, 0.055, 2, { color: AC, bg: P });
      A.stickers(1.72, 0.58, 4, 0.065, 0.032, 3);
      A.roundel(A.num, -2.12, 0.9, 0.11, { bg: AC, color: P });
      A.text('A. VEGA', -0.35, 0.82, 4.2, { color: AC, font: FONT2, weight: 800 });
    });
    A.top((x) => {
      x.fillStyle = P; x.fillRect(-3, -1.4, 6, 2.8);
      x.fillStyle = AC; x.fillRect(-3, -0.035, 6, 0.07);
      x.fillStyle = '#fff'; x.fillRect(-3, 0.05, 6, 0.016); x.fillRect(-3, -0.066, 6, 0.016);
      A.roundel(A.num, -0.95, 0, 0.16, { ring: AC });
      A.roundel(A.num, 1.62, 0, 0.11, { ring: AC, rot: -Math.PI / 2 });
      A.sponsor('VOLTEX', 1.25, 0.76, 0.08, 0, { color: AC, rot: -Math.PI / 2 });
      A.sponsor('VOLTEX', 1.25, -0.76, 0.08, 0, { color: AC, rot: -Math.PI / 2 });
      A.sponsor('NEÓN ENERGY', -2.24, 0, 0.09, 1, { bg: '#fff', color: '#0b0d14' });
    });
    A.front((x) => {
      x.fillStyle = P; x.fillRect(-1.4, 0, 2.8, 1.5);
      x.fillStyle = AC; x.fillRect(-1.4, 0, 2.8, 0.24);
      x.fillStyle = AC; x.fillRect(-0.035, 0, 0.07, 1.5);
    });
    A.rear((x) => {
      x.fillStyle = shade(P, -0.15); x.fillRect(-1.4, 0, 2.8, 1.5);
      x.fillStyle = AC; x.fillRect(-1.4, 0, 2.8, 0.6);
      A.text(A.name, 0, 0.8, 8, { color: AC });
    });
  },
});

/* ---------- 1 · FÉNIX #7 — GT agresivo con alerón gigante ---------- */
DESIGN_DEFS.push({
  key: 'fenix', title: 'GT «Cuello de Cisne»',
  desc: 'Gran turismo de aceleración: capó largo con branquias, aletines, splitter enorme y alerón cuello de cisne con derivas doradas.',
  wb: 2.72, track: 1.9, r: 0.34, tyreW: 0.3, zFront: 2.3, zRear: -2.3,
  noseR: 0.26, noseY: 0.25, noseShrink: 0.1, tailR: 0, wellX: 0.62,
  arches: { front: {}, rear: {} },
  body: {
    xHalf: cv(-2.3, 1.02, -2.0, 1.09, -1.36, 1.125, -0.8, 1.07, -0.3, 0.99, 0.5, 0.99, 1.0, 1.08, 1.36, 1.11, 1.9, 1.07, 2.3, 0.94),
    yFloor: cv(-2.3, 0.24, -1.9, 0.12, -1.3, 0.09, 1.8, 0.09, 2.3, 0.15),
    ySill: cv(-2.3, 0.32, -1.9, 0.19, -1.4, 0.15, 1.9, 0.15, 2.3, 0.19),
    yShoulder: cv(-2.3, 0.84, -1.36, 0.87, -0.6, 0.78, 0.4, 0.74, 1.36, 0.8, 2.0, 0.66, 2.3, 0.5),
    tumble: cv(0, 0.07), undercut: cv(0, 0.04),
    xCrown: cv(-2.3, 0.84, -1.36, 0.92, -0.5, 0.84, 0.5, 0.84, 1.36, 0.91, 2.3, 0.8),
    yCrown: cv(-2.3, 0.92, -1.36, 0.97, -0.6, 0.87, 0.4, 0.83, 1.36, 0.88, 2.0, 0.73, 2.3, 0.56),
    xValley: cv(-2.3, 0.46, 0, 0.52, 2.3, 0.46),
    yValley: cv(-2.3, 0.92, -1.4, 0.94, -0.6, 0.85, 0.4, 0.78, 1.4, 0.74, 2.0, 0.63, 2.3, 0.46),
    yCenter: cv(-2.3, 0.93, -1.5, 0.95, -0.7, 0.87, 0.4, 0.8, 1.3, 0.75, 2.0, 0.62, 2.3, 0.44),
  },
  canopy: {
    z0: 0.66, z1: -2.08, n: 4.2, tumble: 0.34, sink: 0.03,
    w: cv(-2.08, 0.56, -1.3, 0.7, -0.4, 0.75, 0.2, 0.75, 0.66, 0.66),
    h: cv(-2.08, -0.03, -1.65, 0.12, -0.95, 0.3, -0.35, 0.39, 0.15, 0.37, 0.66, -0.03),
    cuts: [-0.06, -0.1, -0.95, -1.06, -1.88],
    glass: (z, t) => (z > -0.06 ? 'glass' : z > -0.1 ? 'paint' : z > -0.95 ? (t < 0.6 ? 'glass' : 'paint') : z > -1.06 ? 'paint' : z > -1.88 ? (t > 0.52 ? 'glass' : 'paint') : 'paint'),
    driver: [0.3, -0.45],
  },
  paint: { metal: 0.22, rough: 0.28 },
  wheel: { type: 'y', n: 5, dish: 0.04 },
  caliper: '#1a1a1a',
  parts(k) {
    rearWing(k, {
      span: 0.98, y: 1.3, z: -1.86, chord: 0.42, thick: 0.12, camber: 0.07, pitch: 0.06, flap: { dy: 0.08, chord: 0.17, pitch: 0.5 }, gurney: true,
      plate: { paint: true, pts: [[-1.7, 1.16], [-1.72, 1.4], [-2.36, 1.47], [-2.4, 1.12], [-2.12, 1.1]] }, mount: 'swan', mountX: [-0.42, 0.42],
    });
    splitter(k, 1.8, 2.42, 1.04, 0.06, 0.2);
    canards(k, [{ x: 0.8, y: 0.32, w: 0.24 }, { x: 0.82, y: 0.44, w: 0.2 }]);
    diffuser(k, [-0.7, -0.35, 0, 0.35, 0.7], -1.5, -2.32, 0.34);
    louvers(k, 'top', 0.9, 1.25, 0.38, 0.68, 7);
    // toma de techo
    if (!k.lod) {
      const P = k.B.paint; P.set('proj', 1);
      const y = k.body.topY(-0.55, 0) - 0.03 + 0.37;
      k.plateZY(P, [[-0.15, y - 0.06], [-0.2, y + 0.07], [-0.32, y + 0.08], [-0.75, y - 0.02], [-0.75, y - 0.08]], -0.13, 0.26, 0.012);
      trimSet(k.B.trim, [0.01, 0.01, 0.012], MATTE_RM);
      k.box(k.B.trim, 0, y + 0.02, -0.215, 0.11, 0.035, 0.015);
    }
    mirrors(k, 0.92, 0.32, 0.13, 0.07);
    exhausts(k, [{ p: [1.04, 0.2, -0.68], d: [1, 0, -0.25], r: 0.042 }, { p: [-1.04, 0.2, -0.68], d: [-1, 0, -0.25], r: 0.042 }]);
  },
  lights(k) {
    const L = k.B.lights, G = k.B.glass, c = k.col, T = k.B.trim;
    k.sym([L, G, T], () => {
      trimSet(T, [0.015, 0.015, 0.02], [0.3, 0.6, 0]);
      k.ribbon(T, 'front', [[0.5, 0.49], [0.72, 0.53], [0.96, 0.6]], (t) => lerp(0.03, 0.055, t), { off: 0.004 });
      setL(L, CH.HEAD, WHITE_LED);
      k.ribbon(L, 'front', [[0.54, 0.49], [0.75, 0.53], [0.94, 0.59]], (t) => lerp(0.008, 0.02, t), { off: 0.008 });
      setL(L, CH.DRL, hdr(c.A, 2.4));
      k.ribbon(L, 'front', [[0.48, 0.545], [0.72, 0.585], [0.98, 0.655]], 0.009, { off: 0.008 });
      k.ribbon(G, 'front', [[0.48, 0.52], [0.98, 0.62]], 0.075, { off: 0.018, across: 3 });
    });
    addLamp(k, 'head', 'front', 0.75, 0.54);
    // boca de la parrilla
    trimSet(T, [0.01, 0.01, 0.012], MATTE_RM);
    k.ribbon(T, 'front', [[-0.62, 0.29], [-0.3, 0.27], [0, 0.265], [0.3, 0.27], [0.62, 0.29]], 0.065, { off: 0.004, across: 3 });
    setL(L, CH.TAIL, RED_LED);
    k.ribbon(L, 'rear', [[-0.98, 0.76], [-0.5, 0.775], [0, 0.78], [0.5, 0.775], [0.98, 0.76]], 0.012, { off: 0.006 });
    k.sym(L, () => { setL(L, CH.TAIL, RED_LED); k.ribbon(L, 'rear', [[0.62, 0.7], [0.96, 0.7]], 0.03, { off: 0.006 }); });
    setL(L, CH.BRAKE, RED_BRK);
    k.ribbon(L, 'rear', [[-0.15, 0.86], [0.15, 0.86]], 0.015, { off: 0.006 });
    addLamp(k, 'tail', 'rear', 0.8, 0.72); addLamp(k, 'brake', 'rear', 0.8, 0.72);
    trimSet(T, [0.012, 0.012, 0.014], MATTE_RM);
    k.ribbon(T, 'rear', [[-0.9, 0.42], [0.9, 0.42]], 0.11, { off: 0.003, across: 2 });
  },
  livery(A) {
    const c = A.col, P = c.hex, AC = c.hexA, DK = '#120808';
    const feathers = (x) => {
      for (let i = 0; i < 6; i++) {
        const z0 = 1.05 - i * 0.12, y0 = 0.36 + i * 0.045, len = 1.3 + i * 0.35;
        x.beginPath(); x.moveTo(z0, y0); x.bezierCurveTo(z0 - len * 0.3, y0 + 0.16, z0 - len * 0.7, y0 + 0.2, z0 - len, y0 + 0.28 + i * 0.01);
        x.bezierCurveTo(z0 - len * 0.7, y0 + 0.13, z0 - len * 0.35, y0 + 0.06, z0, y0); x.fill();
      }
    };
    A.side((x) => {
      const g = x.createLinearGradient(2.3, 0, -2.3, 0); g.addColorStop(0, shade(P, 0.05)); g.addColorStop(0.6, P); g.addColorStop(1, shade(P, -0.45));
      x.fillStyle = g; x.fillRect(-3, 0, 6, 1.6);
      x.fillStyle = DK; x.beginPath(); x.moveTo(2.4, 0); x.lineTo(2.4, 0.3); x.bezierCurveTo(1.0, 0.3, 0.2, 0.25, -1.0, 0.36); x.lineTo(-2.4, 0.5); x.lineTo(-2.4, 0); x.fill();
      const gg = x.createLinearGradient(1.2, 0, -2, 0); gg.addColorStop(0, '#fff3b0'); gg.addColorStop(0.4, AC); gg.addColorStop(1, shade(AC, -0.3));
      x.fillStyle = gg; feathers(x);
      x.fillStyle = AC; x.fillRect(-3, 0.3, 6, 0.012);
      A.roundel(A.num, 0.15, 0.56, 0.17, { bg: DK, color: AC, ring: AC });
      A.sponsor('FUEGO', -1.5, 0.67, 0.085, 3, { color: '#fff', color2: AC });
      A.sponsor('MAGMA', 1.25, 0.2, 0.06, 1, { bg: AC, color: DK });
      A.sponsor('SOLARIS', -1.85, 0.27, 0.05, 2, { color: AC, bg: DK });
      A.stickers(1.7, 0.56, 3, 0.07, 0.034, 7);
      A.text(A.name, -0.5, 0.92, 6, { color: '#fff', italic: true });
      A.text('C. ROJAS', 0.0, 0.82, 4, { color: AC, font: FONT2, weight: 800 });
      // derivas del alerón: degradado dorado con dorsal
      const ge = x.createLinearGradient(-1.7, 1.5, -2.4, 1.1); ge.addColorStop(0, '#fff0a0'); ge.addColorStop(0.45, AC); ge.addColorStop(1, '#c46a00');
      x.fillStyle = ge; x.fillRect(-2.5, 1.06, 0.9, 0.5);
      x.fillStyle = DK; x.beginPath(); x.moveTo(-1.65, 1.06); x.lineTo(-2.5, 1.32); x.lineTo(-2.5, 1.24); x.lineTo(-1.95, 1.06); x.fill();
      A.text(String(A.num), -2.0, 1.33, 15, { color: DK, italic: true });
    });
    A.top((x) => {
      x.fillStyle = P; x.fillRect(-3, -1.4, 6, 2.8);
      const g = x.createLinearGradient(2.3, 0, -2.3, 0); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(10,0,0,0.5)'); x.fillStyle = g; x.fillRect(-3, -1.4, 6, 2.8);
      x.fillStyle = AC;
      x.beginPath(); x.moveTo(2.4, 0.06); x.lineTo(-2.4, 0.2); x.lineTo(-2.4, 0.13); x.lineTo(2.4, 0.03); x.fill();
      x.beginPath(); x.moveTo(2.4, -0.06); x.lineTo(-2.4, -0.2); x.lineTo(-2.4, -0.13); x.lineTo(2.4, -0.03); x.fill();
      A.roundel(A.num, -0.55, 0, 0.17, { bg: DK, color: AC, ring: AC });
      A.roundel(A.num, 1.6, 0, 0.13, { bg: DK, color: AC, ring: AC, rot: -Math.PI / 2 });
      A.sponsor('FUEGO', -2.05, 0, 0.12, 3, { color: '#fff', color2: AC });
    });
    A.front((x) => { x.fillStyle = P; x.fillRect(-1.4, 0, 2.8, 1.5); x.fillStyle = DK; x.fillRect(-1.4, 0, 2.8, 0.25); });
    A.rear((x) => { x.fillStyle = shade(P, -0.4); x.fillRect(-1.4, 0, 2.8, 1.5); x.fillStyle = DK; x.fillRect(-1.4, 0, 2.8, 0.5); A.text(A.name, 0, 0.62, 8, { color: AC }); });
  },
});

/* ---------- 2 · VÍBORA #13 — monstruo de carga aerodinámica ---------- */
DESIGN_DEFS.push({
  key: 'vibora', title: 'Prototipo «Carga Máxima»',
  desc: 'Agarre puro: pontones altos con branquias, cola larga, alerón doble en torre, difusor gigante y ojos de serpiente.',
  wb: 2.9, track: 1.88, r: 0.34, tyreW: 0.3, zFront: 2.42, zRear: -2.76,
  noseR: 0.32, noseY: 0.2, noseShrink: 0.05, tailR: 0, wellX: 0.6,
  arches: { front: {}, rear: {} },
  body: {
    xHalf: cv(-2.76, 0.98, -2.3, 1.06, -1.45, 1.105, -0.9, 1.05, -0.4, 0.92, 0.5, 0.92, 1.0, 1.06, 1.45, 1.1, 2.0, 1.05, 2.42, 0.95),
    yFloor: cv(-2.76, 0.48, -2.2, 0.3, -1.3, 0.09, 1.8, 0.08, 2.42, 0.12),
    ySill: cv(-2.76, 0.52, -2.2, 0.34, -1.3, 0.13, 2.0, 0.13, 2.42, 0.16),
    yShoulder: cv(-2.76, 0.8, -1.45, 0.83, -0.5, 0.62, 0.5, 0.6, 1.45, 0.8, 2.0, 0.66, 2.42, 0.42),
    tumble: cv(0, 0.1), undercut: cv(0, 0.05),
    xCrown: cv(-2.76, 0.84, -1.45, 0.88, -0.5, 0.78, 0.6, 0.76, 1.45, 0.88, 2.42, 0.8),
    yCrown: cv(-2.76, 0.92, -1.45, 0.98, -0.5, 0.75, 0.5, 0.72, 1.45, 0.95, 2.0, 0.82, 2.42, 0.5),
    xValley: cv(-2.76, 0.38, -1.4, 0.45, 0, 0.5, 1.45, 0.42, 2.42, 0.36),
    yValley: cv(-2.76, 0.76, -1.45, 0.7, -0.5, 0.6, 0.5, 0.5, 1.45, 0.42, 2.0, 0.36, 2.42, 0.26),
    yCenter: cv(-2.76, 0.86, -1.8, 0.86, -0.7, 0.78, 0.4, 0.64, 1.2, 0.47, 1.9, 0.39, 2.42, 0.26),
  },
  canopy: {
    z0: 1.08, z1: -2.05, n: 3.0, tumble: 0.24, sink: 0.03,
    w: cv(-2.05, 0.2, -1.3, 0.36, -0.4, 0.47, 0.4, 0.47, 1.08, 0.36),
    h: cv(-2.05, -0.04, -1.45, 0.2, -0.5, 0.33, 0.1, 0.38, 0.62, 0.27, 1.08, -0.04),
    cuts: [0.08, 0.04, -0.55],
    glass: (z, t) => (z > 0.08 ? 'glass' : z > 0.04 ? 'paint' : z > -0.55 ? (t < 0.66 ? 'glass' : 'paint') : 'paint'),
    driver: [0, -0.28],
  },
  paint: { metal: 0.2, rough: 0.3 },
  wheel: { type: 'twist', n: 6, dish: 0.04 },
  parts(k) {
    sharkFin(k, [[-0.6, 0.9], [-1.3, 1.04], [-2.22, 1.18], [-2.42, 1.16], [-2.5, 0.8], [-0.8, 0.74]], 0.024);
    rearWing(k, {
      span: 1.0, y: 1.12, z: -2.3, chord: 0.5, thick: 0.13, camber: 0.08, pitch: 0.1, flap: { dy: 0.1, chord: 0.22, pitch: 0.55 }, gurney: true,
      plate: { paint: false, pts: [[-2.15, 0.86], [-2.12, 1.32], [-2.95, 1.42], [-3.0, 1.0], [-2.7, 0.86]] }, mount: 'stalk', mountX: [-0.3, 0.3],
    });
    splitter(k, 1.85, 2.5, 1.06, 0.055, 0.22);
    canards(k, [{ x: 0.78, y: 0.3, w: 0.27 }, { x: 0.8, y: 0.42, w: 0.24 }]);
    diffuser(k, [-0.82, -0.55, -0.27, 0.27, 0.55, 0.82], -1.3, -2.78, 0.52);
    louvers(k, 'top', 1.6, 2.0, 0.6, 0.98, 8);
    louvers(k, 'top', -1.15, -0.8, 0.62, 0.98, 6);
    mirrors(k, 0.86, 0.55, 0.12);
    exhausts(k, [{ p: [0.2, 0.58, -2.74] }, { p: [-0.2, 0.58, -2.74] }]);
    // aleta vertical de cola larga sobre la tapa trasera
    if (!k.lod) { trimSet(k.B.trim, k.col.carbon, CARBON_RM); k.box(k.B.trim, 0, 0.42, -2.73, 1.0, 0.012, 0.04); }
  },
  lights(k) {
    const L = k.B.lights, G = k.B.glass, c = k.col, T = k.B.trim;
    k.sym([L, G, T], () => {
      trimSet(T, [0.012, 0.012, 0.016], [0.3, 0.6, 0]);
      k.ribbon(T, 'front', [[0.7, 0.36], [0.74, 0.62]], 0.05, { off: 0.004 });
      setL(L, CH.HEAD, WHITE_LED);
      k.ribbon(L, 'front', [[0.7, 0.4], [0.735, 0.6]], 0.012, { off: 0.008 });
      k.ribbon(L, 'front', [[0.775, 0.42], [0.8, 0.58]], 0.008, { off: 0.008 });
      setL(L, CH.DRL, hdr(mixc(c.P, [1, 1, 0.4], 0.3), 2.4));
      k.ribbon(L, 'front', [[0.58, 0.33], [0.66, 0.345], [0.72, 0.38], [0.88, 0.5], [0.95, 0.58]], 0.009, { off: 0.008 });
      k.ribbon(G, 'front', [[0.72, 0.36], [0.76, 0.63]], 0.07, { off: 0.016, across: 2 });
    });
    addLamp(k, 'head', 'front', 0.72, 0.5);
    k.sym(L, () => { setL(L, CH.TAIL, RED_LED); k.ribbon(L, 'rear', [[0.78, 0.5], [0.8, 0.8]], 0.022, { off: 0.008 }); });
    setL(L, CH.TAIL, RED_LED);
    k.ribbon(L, 'rear', [[-0.6, 0.86], [0.6, 0.86]], 0.008, { off: 0.008 });
    setL(L, CH.BRAKE, RED_BRK);
    k.ribbon(L, 'rear', [[-0.12, 0.66], [0.12, 0.66]], 0.025, { off: 0.008 });
    addLamp(k, 'tail', 'rear', 0.79, 0.65); addLamp(k, 'brake', 'rear', 0.79, 0.65);
    trimSet(T, [0.012, 0.012, 0.014], MATTE_RM);
    k.ribbon(T, 'rear', [[-0.7, 0.62], [0.7, 0.62]], 0.08, { off: 0.003, across: 2 });
  },
  livery(A) {
    const c = A.col, P = c.hex, AC = c.hexA;
    const scales = (x, x0, x1, y0, y1, s, col, edge) => {
      for (let i = 0, zz = x1; zz > x0; zz -= s * 0.62, i++) for (let yy = y0 + (i % 2) * s * 0.5; yy < y1; yy += s) {
        x.beginPath(); x.moveTo(zz, yy - s * 0.5); x.bezierCurveTo(zz - s * 0.75, yy - s * 0.5, zz - s * 0.75, yy + s * 0.5, zz, yy + s * 0.5); x.closePath();
        x.fillStyle = col; x.fill(); x.lineWidth = s * 0.08; x.strokeStyle = edge; x.stroke();
      }
    };
    A.side((x) => {
      x.fillStyle = P; x.fillRect(-3, 0, 6, 1.6);
      x.fillStyle = AC; x.beginPath(); x.moveTo(2.5, 0.0); x.lineTo(2.5, 0.42); x.bezierCurveTo(1.6, 0.38, 1.2, 0.2, 0.4, 0.28); x.bezierCurveTo(-0.4, 0.36, -1.0, 0.5, -1.6, 0.48); x.bezierCurveTo(-2.2, 0.46, -2.5, 0.6, -2.9, 0.72); x.lineTo(-2.9, 0); x.fill();
      scales(x, -2.9, 2.5, 0.82, 1.5, 0.075, shade(P, -0.18), shade(P, -0.45));
      x.fillStyle = '#e8ff3a'; x.beginPath(); x.moveTo(2.5, 0.44); x.bezierCurveTo(1.6, 0.4, 1.2, 0.22, 0.4, 0.3); x.bezierCurveTo(-0.4, 0.38, -1.0, 0.52, -1.6, 0.5); x.lineTo(-1.6, 0.53); x.bezierCurveTo(-1.0, 0.55, -0.4, 0.41, 0.4, 0.33); x.bezierCurveTo(1.2, 0.25, 1.6, 0.43, 2.5, 0.47); x.fill();
      A.roundel(A.num, 0.15, 0.58, 0.17, { bg: AC, color: P, ring: P });
      A.sponsor('VENENO', -1.2, 0.68, 0.08, 0, { color: AC });
      A.sponsor('KOBRA-TEC', 1.2, 0.17, 0.05, 1, { bg: '#e8ff3a', color: AC });
      A.sponsor('ESCAMA', -2.1, 0.62, 0.05, 2, { color: AC, bg: P });
      A.stickers(1.85, 0.6, 4, 0.065, 0.032, 13);
      A.roundel(A.num, -2.45, 1.08, 0.11, { bg: P, color: AC });
      A.text('L. SERPA', -0.3, 0.84, 4, { color: AC, font: FONT2, weight: 800 });
    });
    A.top((x) => {
      x.fillStyle = P; x.fillRect(-3, -1.4, 6, 2.8);
      x.fillStyle = AC; x.beginPath(); x.moveTo(2.5, 0.0); x.bezierCurveTo(1.6, 0.18, 0.4, 0.42, -2.9, 0.4); x.lineTo(-2.9, -0.4); x.bezierCurveTo(0.4, -0.42, 1.6, -0.18, 2.5, 0); x.fill();
      scales(x, -2.9, 2.0, -0.4, 0.4, 0.08, '#0f2a1c', '#1d6b45');
      x.fillStyle = '#e8ff3a'; x.beginPath(); x.ellipse(2.05, 0.12, 0.07, 0.03, 0.3, 0, TAU); x.ellipse(2.05, -0.12, 0.07, 0.03, -0.3, 0, TAU); x.fill();
      A.roundel(A.num, -1.0, 0, 0.16, { bg: P, color: AC });
      A.roundel(A.num, 1.62, 0, 0.11, { bg: P, color: AC, rot: -Math.PI / 2 });
      A.sponsor('VENENO', 1.25, 0.78, 0.08, 0, { color: AC, rot: -Math.PI / 2 });
      A.sponsor('VENENO', 1.25, -0.78, 0.08, 0, { color: AC, rot: -Math.PI / 2 });
    });
    A.front((x) => { x.fillStyle = P; x.fillRect(-1.4, 0, 2.8, 1.5); x.fillStyle = AC; x.fillRect(-1.4, 0, 2.8, 0.26); x.fillRect(-0.3, 0, 0.6, 1.5); });
    A.rear((x) => { x.fillStyle = AC; x.fillRect(-1.4, 0, 2.8, 1.5); x.fillStyle = P; x.fillRect(-1.4, 0.95, 2.8, 0.5); A.text(A.name, 0, 0.5, 8, { color: P }); });
  },
});

/* ---------- 3 · PANTERA #23 — compacto de carrocería ancha ---------- */
DESIGN_DEFS.push({
  key: 'pantera', title: 'Coupé «Wide-Body»', crease: true,
  desc: 'Aceleración explosiva: batalla corta, aletines remachados, cabina adelantada, lamas traseras y faros gemelos redondos.',
  wb: 2.62, track: 1.94, r: 0.34, tyreW: 0.31, zFront: 2.12, zRear: -2.22,
  noseR: 0.24, noseY: 0.27, noseShrink: 0.08, tailR: 0, wellX: 0.64,
  arches: { front: {}, rear: {} },
  body: {
    xHalf: cv(-2.22, 1.05, -1.9, 1.14, -1.31, 1.17, -0.78, 1.14, -0.5, 1.0, 0.4, 0.98, 0.78, 1.11, 1.31, 1.15, 1.8, 1.11, 2.12, 0.98),
    yFloor: cv(-2.22, 0.24, -1.8, 0.12, -1.2, 0.09, 1.7, 0.09, 2.12, 0.15),
    ySill: cv(-2.22, 0.3, -1.8, 0.18, -1.2, 0.15, 1.8, 0.15, 2.12, 0.2),
    yShoulder: cv(-2.22, 0.86, -1.31, 0.86, -0.6, 0.74, 0.5, 0.71, 1.31, 0.79, 1.8, 0.71, 2.12, 0.53),
    tumble: cv(0, 0.05), undercut: cv(0, 0.03),
    xCrown: cv(-2.22, 0.94, -1.31, 1.0, -0.5, 0.86, 0.5, 0.85, 1.31, 0.98, 2.12, 0.86),
    yCrown: cv(-2.22, 0.92, -1.31, 0.93, -0.6, 0.83, 0.5, 0.79, 1.31, 0.85, 1.8, 0.77, 2.12, 0.57),
    xValley: cv(-2.22, 0.5, 0, 0.56, 2.12, 0.5),
    yValley: cv(-2.22, 0.9, -1.3, 0.91, -0.6, 0.83, 0.5, 0.75, 1.3, 0.73, 1.8, 0.67, 2.12, 0.5),
    yCenter: cv(-2.22, 0.92, -1.3, 0.93, -0.6, 0.86, 0.4, 0.77, 1.2, 0.73, 1.8, 0.65, 2.12, 0.47),
  },
  canopy: {
    z0: 0.98, z1: -1.78, n: 4.6, tumble: 0.34, sink: 0.03,
    w: cv(-1.78, 0.52, -1.0, 0.67, -0.2, 0.72, 0.5, 0.72, 0.98, 0.62),
    h: cv(-1.78, -0.03, -1.32, 0.14, -0.62, 0.3, 0.0, 0.37, 0.5, 0.33, 0.98, -0.03),
    cuts: [0.4, 0.36, -0.55],
    glass: (z, t) => (z > 0.4 ? 'glass' : z > 0.36 ? 'paint' : z > -0.55 ? (t < 0.6 ? 'glass' : 'paint') : 'paint'),
    driver: [0.28, -0.1],
  },
  paint: { metal: 0.25, rough: 0.28 },
  wheel: { type: 'deep', n: 8, dish: 0.05 },
  caliper: '#ff2fb3',
  parts(k) {
    rearWing(k, {
      span: 0.98, y: 1.2, z: -1.82, chord: 0.36, thick: 0.12, camber: 0.07, pitch: 0.1, gurney: true,
      plate: { paint: true, solid: k.col.A, pts: [[-1.72, 1.06], [-1.72, 1.34], [-2.24, 1.34], [-2.26, 1.06]] }, mount: 'stalk', mountX: [-0.55, 0.55],
    });
    splitter(k, 1.7, 2.24, 1.06, 0.07, 0.2);
    canards(k, [{ x: 0.86, y: 0.36, w: 0.2 }]);
    diffuser(k, [-0.6, -0.2, 0.2, 0.6], -1.6, -2.24, 0.3);
    // lamas sobre la tapa del motor
    if (!k.lod) {
      const T = k.B.trim; trimSet(T, [0.02, 0.02, 0.025], MATTE_RM);
      for (let i = 0; i < 7; i++) {
        const z = -1.0 - i * 0.1, y = k.body.topY(z, 0) - 0.03 + k.D.canopy.h(z) + 0.03;
        k.box(T, 0, y, z, 0.5, 0.008, 0.035, -0.35);
      }
    }
    louvers(k, 'top', 0.95, 1.3, 0.25, 0.55, 6);
    mirrors(k, 0.92, 0.62, 0.13, 0.08);
    exhausts(k, [{ p: [0.32, 0.36, -2.21], r: 0.06 }, { p: [-0.32, 0.36, -2.21], r: 0.06 }]);
  },
  lights(k) {
    const L = k.B.lights, G = k.B.glass, c = k.col, T = k.B.trim;
    k.sym([L, G, T], () => {
      trimSet(T, [0.015, 0.015, 0.02], [0.25, 0.7, 0]);
      k.ribbon(T, 'front', [[0.5, 0.56], [0.94, 0.62]], 0.075, { off: 0.004, across: 2 });
      setL(L, CH.HEAD, WHITE_LED);
      k.disc(L, 'front', 0.62, 0.57, 0.055, { off: 0.008 });
      k.disc(L, 'front', 0.82, 0.6, 0.055, { off: 0.008 });
      setL(L, CH.DRL, hdr(mixc(c.P, [1, 1, 1], 0.4), 2.6));
      for (const cx of [0.62, 0.82]) {
        const pts = []; for (let i = 0; i <= 16; i++) { const a = (i / 16) * TAU; pts.push([cx + Math.cos(a) * 0.072, (cx === 0.62 ? 0.57 : 0.6) + Math.sin(a) * 0.072]); }
        k.ribbon(L, 'front', pts, 0.007, { off: 0.009 });
      }
      k.ribbon(G, 'front', [[0.5, 0.58], [0.94, 0.62]], 0.1, { off: 0.02, across: 3 });
    });
    addLamp(k, 'head', 'front', 0.72, 0.58);
    trimSet(T, [0.01, 0.01, 0.012], MATTE_RM);
    k.ribbon(T, 'front', [[-0.7, 0.33], [0, 0.31], [0.7, 0.33]], 0.09, { off: 0.004, across: 3 });
    k.sym(L, () => {
      setL(L, CH.TAIL, RED_LED); k.disc(L, 'rear', 0.82, 0.74, 0.07, { off: 0.008 });
      setL(L, CH.TAIL, hdr(RED_LED, 0.8)); k.disc(L, 'rear', 0.62, 0.74, 0.06, { off: 0.008 });
    });
    setL(L, CH.BRAKE, RED_BRK);
    k.ribbon(L, 'rear', [[-0.25, 0.86], [0.25, 0.86]], 0.014, { off: 0.008 });
    addLamp(k, 'tail', 'rear', 0.82, 0.74); addLamp(k, 'brake', 'rear', 0.72, 0.74);
    trimSet(T, [0.012, 0.012, 0.014], MATTE_RM);
    k.ribbon(T, 'rear', [[-0.85, 0.42], [0.85, 0.42]], 0.12, { off: 0.003, across: 2 });
  },
  livery(A) {
    const c = A.col, P = c.hex, AC = c.hexA, DK = '#16101c';
    A.side((x) => {
      x.fillStyle = P; x.fillRect(-3, 0, 6, 1.6);
      x.fillStyle = AC; x.beginPath(); x.moveTo(2.3, 0); x.lineTo(2.3, 0.3); x.lineTo(0.9, 0.3); x.lineTo(0.2, 0.62); x.lineTo(-0.3, 0.62); x.lineTo(-1.0, 0.3); x.lineTo(-2.4, 0.3); x.lineTo(-2.4, 0); x.fill();
      x.fillStyle = DK; x.fillRect(-3, 0, 6, 0.2);
      // zarpazos
      x.fillStyle = DK;
      for (let i = 0; i < 3; i++) { const z = 1.05 - i * 0.16; x.beginPath(); x.moveTo(z, 0.78); x.quadraticCurveTo(z - 0.25, 0.55, z - 0.62, 0.3); x.lineTo(z - 0.56, 0.3); x.quadraticCurveTo(z - 0.18, 0.56, z + 0.05, 0.78); x.fill(); }
      // remaches de los aletines
      x.fillStyle = '#d8d8e0';
      for (const za of [1.31, -1.31]) for (let a = 0.15; a < Math.PI - 0.1; a += 0.21) { x.beginPath(); x.arc(za + Math.cos(a) * 0.5, 0.34 + Math.sin(a) * 0.47, 0.01, 0, TAU); x.fill(); }
      A.roundel(A.num, -0.55, 0.5, 0.15, { shape: 'rect', bg: AC, color: DK, ring: DK });
      A.sponsor('GARRA', -1.65, 0.62, 0.075, 3, { color: '#fff', color2: DK });
      A.sponsor('TURBO-K', 1.55, 0.6, 0.055, 1, { bg: DK, color: AC });
      A.sponsor('NEÓN ENERGY', 0.0, 0.11, 0.045, 0, { color: AC, italic: true });
      A.stickers(-1.75, 0.45, 3, 0.06, 0.03, 23);
      A.text('N. LUNA', 0.15, 0.92, 4, { color: AC, font: FONT2, weight: 800 });
    });
    A.top((x) => {
      x.fillStyle = P; x.fillRect(-3, -1.4, 6, 2.8);
      x.fillStyle = AC; x.fillRect(-3, 0.12, 6, 0.1); x.fillRect(-3, -0.22, 6, 0.1);
      x.fillStyle = DK; x.fillRect(-3, 0.22, 6, 0.015); x.fillRect(-3, -0.235, 6, 0.015);
      A.roundel(A.num, -0.15, 0, 0.17, { shape: 'rect', bg: AC, color: DK });
      A.roundel(A.num, 1.55, 0, 0.13, { shape: 'rect', bg: AC, color: DK, rot: -Math.PI / 2 });
      A.sponsor('GARRA', -1.9, 0, 0.12, 3, { color: AC, color2: DK });
    });
    A.front((x) => { x.fillStyle = P; x.fillRect(-1.4, 0, 2.8, 1.5); x.fillStyle = AC; x.fillRect(-0.22, 0, 0.1, 1.5); x.fillRect(0.12, 0, 0.1, 1.5); x.fillStyle = DK; x.fillRect(-1.4, 0, 2.8, 0.22); });
    A.rear((x) => { x.fillStyle = P; x.fillRect(-1.4, 0, 2.8, 1.5); x.fillStyle = DK; x.fillRect(-1.4, 0, 2.8, 0.55); A.text(A.name, 0, 0.62, 7, { color: AC }); });
  },
});

/* ---------- 4 · COMETA #44 — Grupo C retro años 80 ---------- */
DESIGN_DEFS.push({
  key: 'cometa', title: 'Resistencia «Grupo C»',
  desc: 'Agarre y resistencia retro: carrocería envolvente, faros amarillos carenados, ruedas traseras tapadas y llantas lenticulares.',
  wb: 2.8, track: 1.84, r: 0.34, tyreW: 0.3, zFront: 2.42, zRear: -2.38,
  noseR: 0.3, noseY: 0.17, noseShrink: 0.04, tailR: 0, wellX: 0.6,
  arches: { front: {}, rear: { top: 0.24 } },
  body: {
    xHalf: cv(-2.38, 1.06, -1.9, 1.11, -1.4, 1.12, -0.7, 1.09, 0.0, 1.05, 0.8, 1.06, 1.4, 1.08, 2.0, 1.03, 2.42, 0.9),
    yFloor: cv(-2.38, 0.3, -1.9, 0.18, -1.3, 0.08, 1.9, 0.08, 2.42, 0.11),
    ySill: cv(-2.38, 0.34, -1.9, 0.22, -1.3, 0.12, 2.0, 0.12, 2.42, 0.14),
    yShoulder: cv(-2.38, 0.8, -1.4, 0.8, -0.5, 0.72, 0.5, 0.65, 1.4, 0.68, 2.0, 0.48, 2.42, 0.3),
    tumble: cv(0, 0.14), undercut: cv(-1.8, 0.015, -0.9, 0.03, 0, 0.03),
    xCrown: cv(-2.38, 0.82, -1.4, 0.84, 0, 0.82, 1.4, 0.84, 2.42, 0.7),
    yCrown: cv(-2.38, 0.88, -1.4, 0.89, -0.5, 0.81, 0.5, 0.74, 1.4, 0.76, 2.0, 0.56, 2.42, 0.32),
    xValley: cv(-2.38, 0.45, 0, 0.5, 2.42, 0.42),
    yValley: cv(-2.38, 0.87, -1.4, 0.86, -0.5, 0.78, 0.5, 0.7, 1.4, 0.67, 2.0, 0.5, 2.42, 0.28),
    yCenter: cv(-2.38, 0.87, -1.4, 0.87, -0.5, 0.8, 0.5, 0.72, 1.4, 0.66, 2.0, 0.48, 2.42, 0.26),
  },
  canopy: {
    z0: 1.12, z1: -1.5, n: 2.6, tumble: 0.16, sink: 0.03,
    w: cv(-1.5, 0.3, -0.9, 0.5, -0.1, 0.58, 0.6, 0.58, 1.12, 0.46),
    h: cv(-1.5, -0.03, -1.05, 0.2, -0.4, 0.32, 0.2, 0.36, 0.7, 0.25, 1.12, -0.03),
    cuts: [0.16, 0.12, -0.78],
    glass: (z, t) => (z > 0.16 ? 'glass' : z > 0.12 ? 'paint' : z > -0.78 ? (t < 0.7 ? 'glass' : 'paint') : 'paint'),
    driver: [0.18, -0.25],
  },
  paint: { metal: 0.12, rough: 0.32 },
  wheel: { type: 'aero', n: 8 },
  parts(k) {
    const P = k.B.paint; P.set('proj', 1);
    // derivas de cola que sujetan el alerón
    k.sym(P, () => k.plateZY(P, [[-1.2, 0.86], [-1.9, 0.98], [-2.3, 1.12], [-2.5, 1.12], [-2.46, 0.8], [-1.6, 0.82]], 0.94, 0.04));
    rearWing(k, { span: 0.95, y: 1.03, z: -2.12, chord: 0.38, thick: 0.12, camber: 0.06, pitch: 0.12, paintWing: true, wingCol: k.col.A, gurney: true });
    splitter(k, 1.9, 2.46, 0.92, 0.055, 0.35);
    diffuser(k, [-0.55, 0, 0.55], -1.6, -2.4, 0.32);
    naca(k, 'side', -0.35, 0.5, -0.85, 0.52, 0.06);
    naca(k, 'top', 1.25, 0.2, 1.75, 0.2, 0.05);
    mirrors(k, 0.88, 0.58, 0.11, 0.06);
    exhausts(k, [{ p: [0.55, 0.3, -2.39], r: 0.055 }]);
    // tapacubos traseros (carenado) — bandeja oscura bajo el carenado
  },
  lights(k) {
    const L = k.B.lights, G = k.B.glass, T = k.B.trim;
    k.sym([L, G, T], () => {
      trimSet(T, [0.02, 0.02, 0.025], [0.25, 0.7, 0]);
      k.ribbon(T, 'top', [[1.86, 0.74], [2.16, 0.74]], 0.17, { off: 0.003, across: 3 });
      setL(L, CH.HEAD, [3.4, 2.6, 0.7]);
      k.disc(L, 'top', 2.07, 0.66, 0.07, { off: 0.008 });
      k.disc(L, 'top', 1.92, 0.82, 0.065, { off: 0.008 });
      k.ribbon(G, 'top', [[1.8, 0.74], [2.2, 0.74]], 0.2, { off: 0.024, across: 4 });
    });
    for (const s of [1, -1]) k.lamps.head.push(k.drape('top', 2.0, 0.74 * s, 0.03).p);
    setL(L, CH.TAIL, RED_LED);
    k.ribbon(L, 'rear', [[-0.95, 0.6], [-0.4, 0.6]], 0.05, { off: 0.008, across: 2 });
    k.ribbon(L, 'rear', [[0.4, 0.6], [0.95, 0.6]], 0.05, { off: 0.008, across: 2 });
    setL(L, CH.BRAKE, RED_BRK);
    k.ribbon(L, 'rear', [[-0.3, 0.6], [0.3, 0.6]], 0.03, { off: 0.008 });
    addLamp(k, 'tail', 'rear', 0.7, 0.6); addLamp(k, 'brake', 'rear', 0.7, 0.6);
    trimSet(T, [0.012, 0.012, 0.014], MATTE_RM);
    k.ribbon(T, 'rear', [[-0.9, 0.42], [0.9, 0.42]], 0.07, { off: 0.003, across: 2 });
  },
  livery(A) {
    const c = A.col, P = c.hex, AC = c.hexA;
    const stripes = (x) => {
      const cols = ['#ff7a1a', '#e8262b', AC];
      cols.forEach((cc, i) => {
        x.fillStyle = cc; const o = i * 0.05;
        x.beginPath(); x.moveTo(2.5, 0.2 + o); x.bezierCurveTo(1.2, 0.24 + o, 0.2, 0.3 + o, -1.0, 0.44 + o); x.bezierCurveTo(-1.6, 0.52 + o, -2.0, 0.78 + o, -2.6, 1.1 + o);
        x.lineTo(-2.6, 1.13 + o); x.bezierCurveTo(-2.0, 0.81 + o, -1.6, 0.555 + o, -1.0, 0.475 + o); x.bezierCurveTo(0.2, 0.335 + o, 1.2, 0.275 + o, 2.5, 0.235 + o); x.fill();
      });
    };
    A.side((x) => {
      x.fillStyle = P; x.fillRect(-3, 0, 6, 1.6);
      x.fillStyle = AC; x.fillRect(-3, 0, 6, 0.2);
      stripes(x);
      A.roundel(A.num, 0.35, 0.55, 0.16, { bg: '#fff', color: AC, ring: AC });
      A.sponsor('COMET TURBO', -1.0, 0.73, 0.07, 0, { color: AC, font: FONT2 });
      A.sponsor('STELLAR OIL', 1.3, 0.45, 0.055, 1, { bg: AC, color: P });
      A.sponsor('RAYO-X', -1.8, 0.92, 0.06, 3, { color: AC, color2: '#e8262b' });
      A.stickers(1.6, 0.62, 3, 0.07, 0.034, 44);
      A.text('J. ESTRELLA', -0.2, 0.85, 4, { color: AC, font: FONT2, weight: 800 });
    });
    A.top((x) => {
      x.fillStyle = P; x.fillRect(-3, -1.4, 6, 2.8);
      x.strokeStyle = AC; x.lineWidth = 0.025; x.beginPath(); x.moveTo(2.6, 0.62); x.lineTo(1.7, 0.0); x.lineTo(2.6, -0.62); x.stroke();
      x.strokeStyle = '#e8262b'; x.lineWidth = 0.012; x.beginPath(); x.moveTo(2.6, 0.55); x.lineTo(1.78, 0.0); x.lineTo(2.6, -0.55); x.stroke();
      // cometa
      const g = x.createLinearGradient(1.2, 0, -2.0, 0); g.addColorStop(0, '#ffffff'); g.addColorStop(0.15, '#ff7a1a'); g.addColorStop(1, 'rgba(232,38,43,0)');
      x.fillStyle = g; x.beginPath(); x.moveTo(1.2, 0); x.quadraticCurveTo(0, 0.42, -2.2, 0.15); x.quadraticCurveTo(0, 0.12, 1.2, 0); x.quadraticCurveTo(0, -0.12, -2.2, -0.15); x.quadraticCurveTo(0, -0.42, 1.2, 0); x.fill();
      x.fillStyle = '#fff'; x.beginPath(); x.arc(1.2, 0, 0.07, 0, TAU); x.fill();
      A.roundel(A.num, -0.65, 0, 0.17, { bg: '#fff', color: AC, ring: AC });
      A.roundel(A.num, 1.25, 0, 0.12, { bg: '#fff', color: AC, ring: AC, rot: -Math.PI / 2 });
      A.sponsor('COMET TURBO', -2.1, 0, 0.1, 0, { color: AC, font: FONT2 });
    });
    A.front((x) => { x.fillStyle = P; x.fillRect(-1.4, 0, 2.8, 1.5); x.fillStyle = AC; x.fillRect(-1.4, 0, 2.8, 0.2); });
    A.rear((x) => { x.fillStyle = P; x.fillRect(-1.4, 0, 2.8, 1.5); x.fillStyle = AC; x.fillRect(-1.4, 0, 2.8, 0.5); A.text(A.name, 0, 0.78, 8, { color: AC, italic: true }); });
  },
});

/* ---------- 5 · TIFÓN #88 — hiperdeportivo futurista ---------- */
DESIGN_DEFS.push({
  key: 'tifon', title: 'Hiperdeportivo «Vórtice»', crease: true,
  desc: 'Equilibrado y futurista: cúpula de cristal integral, pontones flotantes, barras de luz completas y llantas turbina con anillo de neón.',
  wb: 2.82, track: 1.9, r: 0.34, tyreW: 0.3, zFront: 2.36, zRear: -2.4,
  noseR: 0.3, noseY: 0.2, noseShrink: 0.04, tailR: 0, wellX: 0.62,
  arches: { front: {}, rear: {} },
  wheelGlow: true,
  body: {
    xHalf: cv(-2.4, 1.0, -2.0, 1.08, -1.41, 1.12, -0.85, 1.08, -0.4, 0.95, 0.4, 0.93, 0.9, 1.07, 1.41, 1.11, 1.95, 1.06, 2.36, 0.96),
    yFloor: cv(-2.4, 0.36, -1.9, 0.2, -1.3, 0.09, 1.8, 0.08, 2.36, 0.12),
    ySill: cv(-2.4, 0.4, -1.9, 0.24, -1.3, 0.14, 1.9, 0.14, 2.36, 0.18),
    yShoulder: cv(-2.4, 0.76, -1.41, 0.83, -0.5, 0.67, 0.5, 0.63, 1.41, 0.79, 1.95, 0.67, 2.36, 0.44),
    tumble: cv(0, 0.05), undercut: cv(0, 0.06),
    xCrown: cv(-2.4, 0.88, -1.41, 0.93, -0.5, 0.84, 0.5, 0.82, 1.41, 0.92, 2.36, 0.84),
    yCrown: cv(-2.4, 0.84, -1.41, 0.9, -0.5, 0.73, 0.5, 0.69, 1.41, 0.87, 1.95, 0.75, 2.36, 0.5),
    xValley: cv(-2.4, 0.42, 0, 0.5, 2.36, 0.4),
    yValley: cv(-2.4, 0.6, -1.41, 0.58, -0.5, 0.55, 0.5, 0.46, 1.41, 0.4, 2.0, 0.34, 2.36, 0.26),
    yCenter: cv(-2.4, 0.74, -1.6, 0.8, -0.6, 0.78, 0.4, 0.66, 1.2, 0.5, 1.9, 0.38, 2.36, 0.26),
  },
  canopy: {
    z0: 1.12, z1: -2.0, n: 2.7, tumble: 0.2, sink: 0.03,
    w: cv(-2.0, 0.24, -1.25, 0.42, -0.35, 0.5, 0.45, 0.5, 1.12, 0.4),
    h: cv(-2.0, -0.04, -1.35, 0.22, -0.5, 0.36, 0.2, 0.4, 0.7, 0.28, 1.12, -0.04),
    cuts: [-1.0],
    glass: (z, t) => (z > -1.0 ? (t > 0.9 && z < 0.35 && z > -0.8 ? 'paint' : 'glass') : 'paint'),
    driver: [0, -0.3],
  },
  paint: { metal: 0.3, rough: 0.26 },
  wheel: { type: 'blade', n: 5, dish: 0.03 },
  parts(k) {
    sharkFin(k, [[-1.0, 0.95], [-1.6, 1.04], [-2.15, 1.1], [-2.38, 1.08], [-2.4, 0.74], [-1.2, 0.74]], 0.02);
    rearWing(k, { span: 1.02, y: 1.05, z: -2.08, chord: 0.3, thick: 0.09, camber: 0.05, pitch: 0.06, mount: 'stalk', mountX: [-0.62, 0.62], bend: (x) => [-0.06 * (x / 1.02) ** 2, 0.08 * (x / 1.02) ** 2], plate: { paint: false, pts: [[-1.98, 0.92], [-2.04, 1.12], [-2.42, 1.14], [-2.46, 0.96]] } });
    splitter(k, 1.85, 2.42, 1.0, 0.06, 0.3);
    canards(k, [{ x: 0.82, y: 0.34, w: 0.22 }]);
    diffuser(k, [-0.75, -0.45, -0.15, 0.15, 0.45, 0.75], -1.4, -2.42, 0.4);
    louvers(k, 'top', -1.3, -0.95, 0.66, 1.0, 5);
    mirrors(k, 0.86, 0.6, 0.11, 0.07);
    exhausts(k, [{ p: [0.0, 0.62, -2.4], r: 0.065 }]);
  },
  lights(k) {
    const L = k.B.lights, G = k.B.glass, c = k.col, T = k.B.trim;
    const CY = hdr(c.A, 2.6);
    // barra frontal completa
    setL(L, CH.DRL, CY);
    k.ribbon(L, 'front', [[-0.98, 0.5], [-0.75, 0.42], [-0.5, 0.36], [-0.25, 0.32], [0, 0.31], [0.25, 0.32], [0.5, 0.36], [0.75, 0.42], [0.98, 0.5]], 0.008, { off: 0.007 });
    k.sym([L, G, T], () => {
      trimSet(T, [0.012, 0.012, 0.016], [0.3, 0.6, 0]);
      k.ribbon(T, 'front', [[0.62, 0.46], [0.97, 0.56]], 0.035, { off: 0.004 });
      setL(L, CH.HEAD, WHITE_LED);
      for (let i = 0; i < 4; i++) k.ribbon(L, 'front', [[0.66 + i * 0.075, 0.47 + i * 0.022], [0.7 + i * 0.075, 0.482 + i * 0.022]], 0.014, { off: 0.008 });
      k.ribbon(G, 'front', [[0.6, 0.46], [0.99, 0.57]], 0.05, { off: 0.016, across: 2 });
      // franja lateral de neón
      setL(L, CH.DRL, CY);
      k.ribbon(L, 'side', [[-0.9, 0.2], [0.85, 0.19]], 0.008, { off: 0.006 });
    });
    addLamp(k, 'head', 'front', 0.8, 0.51);
    setL(L, CH.TAIL, RED_LED);
    k.ribbon(L, 'rear', [[-1.0, 0.64], [-0.5, 0.66], [0, 0.665], [0.5, 0.66], [1.0, 0.64]], 0.014, { off: 0.008 });
    setL(L, CH.BRAKE, RED_BRK);
    k.sym(L, () => k.ribbon(L, 'rear', [[0.55, 0.6], [0.95, 0.59]], 0.012, { off: 0.008 }));
    setL(L, CH.DRL, CY);
    k.ribbon(L, 'rear', [[-0.5, 0.4], [0.5, 0.4]], 0.007, { off: 0.008 });
    addLamp(k, 'tail', 'rear', 0.75, 0.65); addLamp(k, 'brake', 'rear', 0.75, 0.6);
    trimSet(T, [0.012, 0.012, 0.014], MATTE_RM);
    k.ribbon(T, 'rear', [[-0.85, 0.5], [0.85, 0.5]], 0.07, { off: 0.003, across: 2 });
  },
  livery(A) {
    const c = A.col, P = c.hex, AC = c.hexA, DK = '#120a2a';
    A.side((x) => {
      const g = x.createLinearGradient(0, 1.0, 0, 0.1); g.addColorStop(0, shade(P, 0.15)); g.addColorStop(0.5, P); g.addColorStop(1, DK);
      x.fillStyle = g; x.fillRect(-3, 0, 6, 1.6);
      x.strokeStyle = AC; x.lineWidth = 0.012;
      for (let i = 0; i < 4; i++) { x.beginPath(); x.moveTo(2.3, 0.28 + i * 0.05); x.lineTo(1.1, 0.28 + i * 0.05); x.lineTo(0.9, 0.42 + i * 0.05); x.lineTo(-0.5, 0.42 + i * 0.05); x.lineTo(-0.75, 0.3 + i * 0.03); x.lineTo(-2.5, 0.3 + i * 0.03); x.stroke(); }
      x.fillStyle = AC; for (const [z, y] of [[0.9, 0.42], [-0.5, 0.57], [1.1, 0.43]]) { x.beginPath(); x.arc(z, y, 0.018, 0, TAU); x.fill(); }
      A.text(String(A.num), 0.12, 0.56, String(A.num).length > 2 ? 26 : 34, { color: DK, stroke: AC, strokeW: 3.2, italic: true, skew: 0.15 });
      A.sponsor('HIPERNOVA', -1.45, 0.65, 0.07, 0, { color: AC, font: FONT2 });
      A.sponsor('QUANTUM', 1.45, 0.62, 0.055, 2, { color: '#fff', bg: P });
      A.stickers(-1.7, 0.47, 3, 0.06, 0.03, 88);
      A.text('I. TORMENTA', -0.3, 0.86, 4, { color: AC, font: FONT2, weight: 800 });
    });
    A.top((x) => {
      x.fillStyle = P; x.fillRect(-3, -1.4, 6, 2.8);
      x.strokeStyle = AC; x.lineWidth = 0.014;
      for (let r = 0.2; r < 1.4; r += 0.16) { x.beginPath(); x.arc(-1.6, 0, r, -0.9, 0.9); x.stroke(); x.beginPath(); x.arc(-1.6, 0, r, Math.PI - 0.9, Math.PI + 0.9); x.stroke(); }
      x.fillStyle = DK; x.fillRect(-3, -0.04, 6, 0.08);
      x.fillStyle = AC; x.fillRect(-3, -0.008, 6, 0.016);
      A.roundel(A.num, 1.6, 0, 0.12, { bg: DK, color: AC, rot: -Math.PI / 2 });
      A.roundel(A.num, -0.5, 0, 0.15, { bg: DK, color: AC });
      A.sponsor('TIFÓN', -2.15, 0, 0.11, 0, { color: AC });
    });
    A.front((x) => { x.fillStyle = P; x.fillRect(-1.4, 0, 2.8, 1.5); x.fillStyle = DK; x.fillRect(-1.4, 0, 2.8, 0.25); });
    A.rear((x) => { x.fillStyle = DK; x.fillRect(-1.4, 0, 2.8, 1.5); x.fillStyle = P; x.fillRect(-1.4, 0.72, 2.8, 0.7); A.text(A.name, 0, 0.86, 7, { color: AC }); });
  },
});

/* ---------- SAFETY CAR — GT de calle con barra de luces ---------- */
const SAFETY_DEF = {
  key: 'safety', title: 'Safety Car', desc: 'GT de calle oficial con barra de luces ámbar en el techo.',
  wb: 2.7, track: 1.86, r: 0.34, tyreW: 0.28, zFront: 2.25, zRear: -2.25,
  noseR: 0.26, noseY: 0.28, noseShrink: 0.1, tailR: 0, wellX: 0.62,
  arches: { front: {}, rear: {} },
  body: {
    xHalf: cv(-2.25, 0.97, -1.9, 1.03, -1.35, 1.06, -0.8, 1.02, -0.3, 0.98, 0.5, 0.98, 1.0, 1.02, 1.35, 1.04, 1.9, 0.99, 2.25, 0.88),
    yFloor: cv(-2.25, 0.27, -1.9, 0.15, -1.3, 0.12, 1.8, 0.12, 2.25, 0.18),
    ySill: cv(-2.25, 0.35, -1.9, 0.23, -1.4, 0.18, 1.9, 0.18, 2.25, 0.22),
    yShoulder: cv(-2.25, 0.86, -1.35, 0.88, -0.6, 0.8, 0.4, 0.76, 1.35, 0.8, 2.0, 0.68, 2.25, 0.52),
    tumble: cv(0, 0.08), undercut: cv(0, 0.035),
    xCrown: cv(-2.25, 0.8, -1.35, 0.87, 0, 0.84, 1.35, 0.87, 2.25, 0.76),
    yCrown: cv(-2.25, 0.93, -1.35, 0.97, -0.6, 0.89, 0.4, 0.85, 1.35, 0.88, 2.0, 0.74, 2.25, 0.56),
    xValley: cv(-2.25, 0.45, 0, 0.5, 2.25, 0.45),
    yValley: cv(-2.25, 0.93, -1.4, 0.95, -0.6, 0.88, 0.4, 0.82, 1.4, 0.77, 2.0, 0.66, 2.25, 0.5),
    yCenter: cv(-2.25, 0.94, -1.4, 0.96, -0.6, 0.89, 0.4, 0.83, 1.3, 0.78, 2.0, 0.65, 2.25, 0.47),
  },
  canopy: {
    z0: 0.62, z1: -2.02, n: 4.4, tumble: 0.36, sink: 0.03,
    w: cv(-2.02, 0.56, -1.3, 0.7, -0.4, 0.75, 0.2, 0.75, 0.62, 0.66),
    h: cv(-2.02, -0.03, -1.6, 0.13, -0.95, 0.33, -0.35, 0.42, 0.15, 0.4, 0.62, -0.03),
    cuts: [-0.06, -0.1, -1.0, -1.1, -1.85],
    glass: (z, t) => (z > -0.06 ? 'glass' : z > -0.1 ? 'paint' : z > -1.0 ? (t < 0.62 ? 'glass' : 'paint') : z > -1.1 ? 'paint' : z > -1.85 ? (t > 0.5 ? 'glass' : 'paint') : 'paint'),
    driver: [0.3, -0.45],
  },
  paint: { metal: 0.55, rough: 0.24 },
  wheel: { type: 'multi', n: 10, dish: 0.03 },
  caliper: '#ffcc00',
  parts(k) {
    rearWing(k, { span: 0.82, y: 0.97, z: -1.98, chord: 0.2, thick: 0.1, camber: 0.03, pitch: 0.05, paintWing: true, wingCol: k.col.P });
    splitter(k, 1.85, 2.3, 0.86, 0.09, 0.25);
    diffuser(k, [-0.5, 0, 0.5], -1.7, -2.27, 0.3);
    mirrors(k, 0.9, 0.3, 0.13, 0.07);
    exhausts(k, [{ p: [0.42, 0.3, -2.26], r: 0.042 }, { p: [0.55, 0.3, -2.26], r: 0.042 }, { p: [-0.42, 0.3, -2.26], r: 0.042 }, { p: [-0.55, 0.3, -2.26], r: 0.042 }]);
    // barra de luces en el techo
    const z = -0.42, cp = k.D.canopy, yr = k.body.topY(z, 0) - cp.sink + cp.h(z);
    const T = k.B.trim;
    trimSet(T, [0.03, 0.03, 0.035], [0.4, 0.4, 0]);
    k.box(T, 0, yr + 0.02, z, 0.56, 0.025, 0.12);
    k.box(T, 0.4, yr + 0.004, z, 0.03, 0.02, 0.09); k.box(T, -0.4, yr + 0.004, z, 0.03, 0.02, 0.09);
    k.beaconY = yr + 0.075; k.beaconZ = z;
  },
  lights(k) {
    const L = k.B.lights, G = k.B.glass, T = k.B.trim, c = k.col;
    k.sym([L, G, T], () => {
      trimSet(T, [0.015, 0.015, 0.02], [0.3, 0.6, 0]);
      k.ribbon(T, 'front', [[0.5, 0.52], [0.9, 0.6]], 0.05, { off: 0.004 });
      setL(L, CH.HEAD, WHITE_LED);
      k.ribbon(L, 'front', [[0.55, 0.52], [0.86, 0.59]], 0.016, { off: 0.008 });
      setL(L, CH.DRL, [2.6, 2.6, 2.8]);
      k.ribbon(L, 'front', [[0.5, 0.565], [0.9, 0.645]], 0.007, { off: 0.008 });
      k.ribbon(G, 'front', [[0.48, 0.54], [0.92, 0.63]], 0.07, { off: 0.018, across: 3 });
    });
    addLamp(k, 'head', 'front', 0.7, 0.56);
    trimSet(T, [0.01, 0.01, 0.012], MATTE_RM);
    k.ribbon(T, 'front', [[-0.55, 0.32], [0, 0.3], [0.55, 0.32]], 0.07, { off: 0.004, across: 3 });
    setL(L, CH.TAIL, RED_LED);
    k.sym(L, () => k.ribbon(L, 'rear', [[0.55, 0.78], [0.92, 0.76]], 0.025, { off: 0.008 }));
    setL(L, CH.BRAKE, RED_BRK);
    k.ribbon(L, 'rear', [[-0.2, 0.9], [0.2, 0.9]], 0.012, { off: 0.008 });
    addLamp(k, 'tail', 'rear', 0.75, 0.77); addLamp(k, 'brake', 'rear', 0.75, 0.77);
    // barra de luces: ámbar izquierda (canal A) / derecha (canal B) + blanco central
    const y = k.beaconY, z = k.beaconZ;
    k.beacon = [];
    for (const s of [1, -1]) {
      L.set('aCh', 0.05, 0, 0, s); L.set('color', AMBER);
      for (let i = 0; i < 3; i++) k.box(L, s * (0.15 + i * 0.13), y, z, 0.055, 0.035, 0.09);
      k.beacon.push([s * 0.28, y, z]);
    }
    L.set('aCh', 0.6, 0, 0, 0); L.set('color', 2.2, 2.2, 2.4);
    k.box(L, 0, y, z + 0.05, 0.07, 0.03, 0.04);
    k.box(G, 0, y, z, 0.56, 0.05, 0.115);
  },
  livery(A) {
    const P = A.col.hex, Y = '#ffcc00', K = '#111216';
    const band = (x, y0, h, z0, z1, n) => { const s = (z1 - z0) / n; for (let i = 0; i < n; i++) for (let r = 0; r < 2; r++) { x.fillStyle = (i + r) % 2 ? Y : K; x.fillRect(z0 + i * s, y0 + r * h, s + 0.002, h + 0.002); } };
    A.side((x) => {
      const g = x.createLinearGradient(0, 1.1, 0, 0.1); g.addColorStop(0, shade(P, 0.2)); g.addColorStop(1, shade(P, -0.3));
      x.fillStyle = g; x.fillRect(-3, 0, 6, 1.6);
      band(x, 0.26, 0.09, -2.4, 2.4, 22);
      x.fillStyle = Y; x.fillRect(-3, 0.445, 6, 0.02);
      A.text('SAFETY CAR', 0.0, 0.62, 16, { color: K, maxW: 260 });
      A.sponsor('AURUM', -1.75, 0.68, 0.07, 3, { color: K, color2: Y });
      A.text('GRAN PREMIO NEÓN · OFICIAL', 1.5, 0.71, 4, { color: K, font: FONT2, weight: 800 });
    });
    A.top((x) => {
      x.fillStyle = shade(P, 0.15); x.fillRect(-3, -1.4, 6, 2.8);
      x.fillStyle = Y; x.fillRect(-3, 0.5, 6, 0.06); x.fillRect(-3, -0.56, 6, 0.06);
      A.text('SAFETY CAR', 1.5, 0, 15, { color: K, rot: -Math.PI / 2, maxW: 140 });
      A.text('SAFETY CAR', -1.95, 0, 13, { color: K, rot: Math.PI / 2, maxW: 120 });
      A.sponsor('AURUM', -0.7, 0, 0.12, 3, { color: K, color2: Y });
    });
    A.front((x) => { x.fillStyle = P; x.fillRect(-1.4, 0, 2.8, 1.5); band(x, 0.18, 0.06, -1.0, 1.0, 12); });
    A.rear((x) => { x.fillStyle = shade(P, -0.1); x.fillRect(-1.4, 0, 2.8, 1.5); band(x, 0.42, 0.07, -1.0, 1.0, 12); A.text('SAFETY CAR', 0, 0.66, 11, { color: K }); });
  },
};

/* =====================================================================
   Construcción de un coche
   ===================================================================== */
function prepDesign(def0) {
  const D = Object.assign({}, def0);
  D.frontAxleZ = D.wb / 2; D.rearAxleZ = -D.wb / 2;
  D.archList = [ARCH(D.frontAxleZ, D.r, D.arches.front.top), ARCH(D.rearAxleZ, D.r, D.arches.rear.top)];
  D.zFrontIn = D.frontAxleZ + D.archList[0].rz + 0.04;
  D.zRearIn = D.rearAxleZ - D.archList[1].rz - 0.04;
  return D;
}

function buildLOD(D, lod, colors, L) {
  const body = makeBody(D, lod);
  const paint = new Builder({ color: 3, aLoose: 1, proj: 1 });
  paint.set('proj', 1);
  // en LOD1 las piezas «trim» y el cristal van al material de pintura como color sólido (texel blanco)
  const trim = lod ? new Builder({ color: 3, aLoose: 1, proj: 1 }) : new Builder({ color: 3, aRM: 3, aLoose: 1 });
  const glass = lod ? new Builder({ color: 3, aLoose: 1, proj: 1 }) : new Builder({});
  if (lod) glass.set('color', colors.glassLo);
  const lights = new Builder({ color: 3, aCh: 4 });
  const B = { paint, trim, glass, lights };
  const kit = makeKit(D, body, B, lod, colors);
  const setTrim = (col, rm) => { trim.set('color', col); trim.set('aRM', rm); };
  // ---- carrocería
  const zs = zSamples(D, lod, D.zCuts || []);
  const J = zs.length, Kp = body.K, P = new Float32Array(J * Kp * 3), N = new Float32Array(J * Kp * 3);
  const X = new Float64Array(Kp), Y = new Float64Array(Kp);
  for (let j = 0; j < J; j++) { body.section(zs[j], X, Y); for (let k = 0; k < Kp; k++) { const i = (j * Kp + k) * 3; P[i] = X[k]; P[i + 1] = Y[k]; P[i + 2] = zs[j]; } }
  setTrim(colors.carbon, [0.5, 0.2, 1]);
  stripNormals(P, J, Kp, 0, 1, N); emitGrid(P, N, J, Kp, 0, 1, () => trim);
  setTrim(colors.well, [0.9, 0.0, 0]);
  stripNormals(P, J, Kp, 1, 2, N); emitGrid(P, N, J, Kp, 1, 2, () => trim);
  stripNormals(P, J, Kp, 2, 3, N); emitGrid(P, N, J, Kp, 2, 3, () => trim);
  paint.set('proj', 1); paint.set('color', 1, 1, 1);
  if (D.crease && !lod) {
    stripNormals(P, J, Kp, 3, body.iS, N); emitGrid(P, N, J, Kp, 3, body.iS, () => paint);
    stripNormals(P, J, Kp, body.iS, Kp - 1, N); emitGrid(P, N, J, Kp, body.iS, Kp - 1, () => paint);
  } else { stripNormals(P, J, Kp, 3, Kp - 1, N); emitGrid(P, N, J, Kp, 3, Kp - 1, () => paint); }
  // ganchos de remolque (rojos) y antena
  if (!lod) {
    trim.set('color', 0.85, 0.06, 0.05); trim.set('aRM', 0.4, 0.2, 0);
    const fz = body.endZ(0.18, D.noseY + 0.04, D.zFrontIn, D.zFront + 0.2), rz = body.endZ(0.3, D.body.yFloor(D.zRear) + 0.12, D.zRearIn, D.zRear - 0.2);
    if (fz !== null) trim.geo(new THREE.TorusGeometry(0.035, 0.008, 5, 10, Math.PI * 1.2), mul(mT(0.18, D.noseY + 0.04, fz + 0.012), mR(Math.PI / 2, 0, 0)));
    if (rz !== null) trim.geo(new THREE.TorusGeometry(0.035, 0.008, 5, 10, Math.PI * 1.2), mul(mT(0.3, D.body.yFloor(D.zRear) + 0.12, rz - 0.012), mR(-Math.PI / 2, 0, 0)));
  }
  // tapa trasera (si la cola es recta)
  if (!(D.tailR > 0)) {
    const ring = [];
    for (let k = 0; k < Kp; k++) ring.push([P[k * 3], P[k * 3 + 1]]);
    for (let k = Kp - 2; k > 0; k--) ring.push([-P[k * 3], P[k * 3 + 1]]);
    const clean = ring.filter((p, i) => i === 0 || Math.hypot(p[0] - ring[i - 1][0], p[1] - ring[i - 1][1]) > 1e-5);
    const tri = THREE.ShapeUtils.triangulateShape(clean.map((p) => new THREE.Vector2(p[0], p[1])), []);
    const ids = clean.map((p) => paint.v(p[0], p[1], zs[0], 0, 0, -1));
    for (const [a, b2, c2] of tri) {
      const pa = clean[a], pb = clean[b2], pc = clean[c2];
      const cz = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
      if (cz < 0) paint.t(ids[a], ids[b2], ids[c2]); else paint.t(ids[a], ids[c2], ids[b2]);
    }
  }
  // ---- cúpula
  buildCanopy(D, body, kit, lod, colors, setTrim);
  // ---- piezas y luces
  D.parts(kit, setTrim);
  if (!lod) D.lights(kit);
  if (lod) { mergeInto(paint, trim); mergeInto(paint, glass); }
  return { body, kit, B };
}

function mergeInto(dst, src) {
  const base = dst.n;
  dst.P.push(...src.P); dst.N.push(...src.N);
  for (const k in dst.A) { const s = dst.sizes[k]; if (src.A[k]) dst.A[k].push(...src.A[k]); else for (let i = 0; i < src.n * s; i++) dst.A[k].push(0); }
  for (const i of src.I) dst.I.push(i + base);
  dst.n += src.n;
}

function buildCanopy(D, body, kit, lod, colors, setTrim) {
  const cp = D.canopy, nT = lod ? 4 : 10;
  const zs = [];
  const nZ = lod ? 9 : 26;
  for (let i = 0; i <= nZ; i++) zs.push(lerp(cp.z1, cp.z0, i / nZ));
  if (!lod) for (const z of cp.cuts || []) zs.push(z);
  zs.sort((a, b) => a - b);
  const J = zs.length, Kc = nT + 1, P = new Float32Array(J * Kc * 3), N = new Float32Array(J * Kc * 3);
  const e = 2 / cp.n;
  for (let j = 0; j < J; j++) {
    const z = zs[j], w = cp.w(z), h = cp.h(z);
    for (let i = 0; i <= nT; i++) {
      const a = (i / nT) * Math.PI * 0.5, ex = i === nT ? 0 : Math.pow(Math.cos(a), e), ey = Math.pow(Math.sin(a), e);
      const x = w * ex * (1 - cp.tumble * ey * 0.5);
      const yb = body.topY(z, x) - cp.sink;
      const ii = (j * Kc + i) * 3; P[ii] = x; P[ii + 1] = yb + h * ey; P[ii + 2] = z;
    }
  }
  // normales: la rejilla va de abajo (i=0) hacia el centro, como la carrocería
  stripNormals(P, J, Kc, 0, nT, N);
  const { paint, glass, trim } = kit.B;
  const kinds = [];
  for (let j = 0; j < J - 1; j++) { const zm = (zs[j] + zs[j + 1]) / 2; kinds.push([]); for (let i = 0; i < nT; i++) kinds[j].push(cp.glass(zm, (i + 0.5) / nT)); }
  if (lod) {
    emitGrid(P, N, J, Kc, 0, nT, (j, i) => { if (kinds[j][i] === 'glass') { paint.set('proj', 0); paint.set('color', colors.glassLo); } else { paint.set('proj', 1); paint.set('color', 1, 1, 1); } return paint; });
    paint.set('proj', 1); paint.set('color', 1, 1, 1);
    return;
  }
  paint.set('proj', 1); paint.set('color', 1, 1, 1);
  emitGrid(P, N, J, Kc, 0, nT, (j, i) => (kinds[j][i] === 'glass' ? glass : kinds[j][i] === 'paint' ? paint : null));
  // interior oscuro visto a través del cristal
  const Pi = new Float32Array(P.length), Ni = new Float32Array(N.length);
  for (let i = 0; i < P.length; i += 3) { Pi[i] = P[i] - N[i] * 0.03; Pi[i + 1] = P[i + 1] - N[i + 1] * 0.03; Pi[i + 2] = P[i + 2] - N[i + 2] * 0.03; Ni[i] = -N[i]; Ni[i + 1] = -N[i + 1]; Ni[i + 2] = -N[i + 2]; }
  trim.set('color', colors.cabin); trim.set('aRM', 0.8, 0, 0);
  const flipB = { v: (...a) => trim.v(...a), t: (a, b, c) => trim.t(a, c, b) };
  emitGrid(Pi, Ni, J, Kc, 0, nT, (j, i) => (kinds[j][i] === 'glass' ? flipB : null));
  // suelo del habitáculo
  for (let j = 0; j < J - 1; j++) {
    if (!kinds[j].some((k) => k === 'glass') || cp.h(zs[j]) < 0.1 || cp.h(zs[j + 1]) < 0.1) continue;
    const row = (jj) => { const ii = jj * Kc * 3, x = P[ii] * 0.86, z = P[ii + 2]; return [[-x, body.topY(z, x) + 0.004, z], [0, body.topY(z, 0) + 0.006, z], [x, body.topY(z, x) + 0.004, z]]; };
    const r0 = row(j), r1 = row(j + 1), id0 = r0.map((p) => trim.v(p[0], p[1], p[2], 0, 1, 0)), id1 = r1.map((p) => trim.v(p[0], p[1], p[2], 0, 1, 0));
    for (let q = 0; q < 2; q++) trim.q(id0[q], id1[q], id1[q + 1], id0[q + 1]);
  }
  // piloto: casco + reposacabezas + volante
  const [dx, dz] = cp.driver, yTop = body.topY(dz, 0) - cp.sink + cp.h(dz) * Math.pow(1 - Math.min(0.95, Math.abs(dx) / cp.w(dz)), 0.5), hy = yTop - 0.165;
  paint.set('proj', 0); paint.set('color', colors.helmet);
  kit.ellipsoid(paint, dx, hy, dz, 0.112, 0.118, 0.124, 14, 10);
  paint.set('color', colors.helmet2);
  kit.ellipsoid(paint, dx, hy + 0.025, dz - 0.01, 0.114, 0.055, 0.124, 14, 6);
  paint.set('proj', 1); paint.set('color', 1, 1, 1);
  trim.set('color', 0.035, 0.04, 0.055); trim.set('aRM', 0.28, 0.6, 0);
  kit.ellipsoid(trim, dx, hy, dz + 0.052, 0.094, 0.042, 0.08, 12, 6);
  trim.set('color', colors.cabin); trim.set('aRM', 0.7, 0, 0);
  kit.box(trim, dx, hy - 0.12, dz - 0.19, 0.16, 0.2, 0.05, -0.15);
  trim.set('color', 0.08, 0.08, 0.09); trim.set('aRM', 0.4, 0.2, 1);
  kit.box(trim, dx, hy - 0.1, dz + 0.36, 0.1, 0.06, 0.02, -0.4);
}

/* ---------------------------------------------------------------------
   Llamas del escape
   --------------------------------------------------------------------- */
function flameGeometry(kit) {
  const b = new Builder({ color: 3, aOrig: 3 });
  kit.exhaust.forEach((p, i) => {
    const d = kit.exhaustDir[i];
    for (const [len, rad, k] of [[0.95, 0.09, 1], [0.5, 0.05, 1.6]]) {
      const g = new THREE.ConeGeometry(rad, len, 10, 6, true);
      const pos = g.attributes.position;
      const col = [];
      for (let v = 0; v < pos.count; v++) {
        const u = 0.5 - pos.getY(v) / len; // 1 = base (escape), 0 = punta
        let c;
        if (u > 0.8) { const q = (u - 0.8) / 0.2; c = [lerp(2.4, 0.9, q), lerp(1.3, 1.5, q), lerp(0.4, 3.2, q)]; }
        else { const q = u / 0.8; c = [2.6 * q, 0.9 * q * q, 0.12 * q]; }
        col.push(c[0] * k, c[1] * k, c[2] * k);
      }
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...d).normalize());
      const m = mul(mT(p[0] + d[0] * len * 0.5, p[1] + d[1] * len * 0.5, p[2] + d[2] * len * 0.5), new THREE.Matrix4().makeRotationFromQuaternion(q));
      const base = b.n; const gg = g.toNonIndexed(); const cc = gg.attributes.color;
      b.set('aOrig', p[0], p[1], p[2]);
      b.with(m, () => { for (let v = 0; v < gg.attributes.position.count; v++) { b.set('color', cc.getX(v), cc.getY(v), cc.getZ(v)); b.v(gg.attributes.position.getX(v), gg.attributes.position.getY(v), gg.attributes.position.getZ(v)); } });
      for (let v = 0; v < gg.attributes.position.count; v += 3) b.t(base + v, base + v + 1, base + v + 2);
      g.dispose(); gg.dispose();
    }
  });
  return b.build();
}

/* =====================================================================
   API PÚBLICA
   ===================================================================== */
export const DESIGNS = DESIGN_DEFS.map((d, i) => ({ index: i, key: d.key, title: d.title, desc: d.desc, wheel: d.wheel.type }));

const CODE_IDX = { REL: 0, FEN: 1, VIB: 2, PAN: 3, COM: 4, TIF: 5 };
/**
 * Crea el modelo 3D de un coche.
 * @param def  { name, code, num, color, accent, rim, ... } (CARS del juego)
 * @param opts { tier: 'low'|'med'|'high', envMap, index: 0..5 (diseño; si falta, se deduce de def.code) }
 */
export function createCarModel(def, { tier = 'high', envMap = null, index, safety = false } = {}) {
  if (safety) return createSafetyCar({ tier, envMap });
  if (index === undefined || index === null) index = CODE_IDX[def.code] ?? 0;
  const D = prepDesign(DESIGN_DEFS[((index % DESIGN_DEFS.length) + DESIGN_DEFS.length) % DESIGN_DEFS.length]);
  return buildModel(def, D, { tier, envMap, index });
}

/** Coche de seguridad: GT de calle con barra de luces ámbar (setBeacon). */
export function createSafetyCar({ tier = 'high', envMap = null } = {}) {
  const def = { name: 'Safety Car', code: 'SC', num: 'SC', color: '#c3c8d2', accent: '#ffcc00', rim: '#d4d8de' };
  const m = buildModel(def, prepDesign(SAFETY_DEF), { tier, envMap, index: 6 });
  const U = m.materials.lights.userData.u;
  let lastA = -1, lastB = -1;
  m.isSafetyCar = true;
  /** Destellos alternos (doble destello) de la barra ámbar; llamar cada fotograma. */
  m.setBeacon = (on, t = 0) => {
    let a = 0.04, b = 0.04;
    if (on) {
      const ph = ((t * 1.25) % 1 + 1) % 1;
      const fl = (p) => (p < 0.07 || (p > 0.13 && p < 0.2) ? 1.0 : 0.06);
      a = fl(ph); b = fl((ph + 0.5) % 1);
    }
    if (a !== lastA) { lastA = a; U.uBeaconA.value = a; }
    if (b !== lastB) { lastB = b; U.uBeaconB.value = b; }
  };
  m.setBeacon(false);
  return m;
}

function buildModel(def, D, { tier = 'high', envMap = null, index = 0 } = {}) {
  const hasLod0 = tier !== 'low';
  const maxAniso = 8;
  const sh = sharedTextures(maxAniso);
  const colors = {
    hex: def.color, hexA: def.accent, num: def.num ?? index + 1, name: String(def.name || '').toUpperCase(), P: lin(def.color), A: lin(def.accent), rim: lin(def.rim),
    carbon: [0.06, 0.062, 0.07], well: [0.018, 0.018, 0.022], cabin: [0.045, 0.047, 0.055], glassLo: [0.05, 0.07, 0.1],
    helmet: lin(def.accent === '#f4f1ff' ? '#f4f1ff' : def.rim), helmet2: lin(def.color), nut: lin(def.accent === '#10131c' || def.accent === '#0d1014' || def.accent === '#141414' ? '#e8e8f0' : def.accent),
  };
  colors.caliper = lin(D.caliper || (['#10131c', '#0d1014', '#141414'].includes(def.accent) ? '#ff3b30' : def.accent));
  // ---- texturas de la decoración
  const W = tier === 'low' ? 1024 : 2048, H = W / 2;
  const L = makeLayout(D, W, H);
  const cvs = canvasOf(W, H), ctx = cvs.getContext('2d');
  const paintLivery = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = def.color; ctx.fillRect(0, 0, W, H);
    const A = makePainter(L, ctx, colors);
    D.livery(A);
    seams(A, D);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const sw = L.R[5]; ctx.fillStyle = '#ffffff'; ctx.fillRect(sw.x - 2, sw.y - 3, sw.w + 2, sw.h + 3);
  };
  paintLivery();
  const livTex = new THREE.CanvasTexture(cvs); livTex.colorSpace = THREE.SRGBColorSpace; livTex.anisotropy = tier === 'high' ? 8 : 4;
  const dmgTex = paintDamage(D, L, W >> 2, H >> 2, index + 1);
  if (typeof document !== 'undefined' && document.fonts && document.fonts.status !== 'loaded') {
    document.fonts.ready.then(() => { if (!disposed) { paintLivery(); livTex.needsUpdate = true; } }).catch(() => {});
  }
  // ---- materiales
  const physical = tier === 'high';
  const paintMat = patchMaterial(physical
    ? new THREE.MeshPhysicalMaterial({ map: livTex, emissiveMap: livTex, emissive: 0xffffff, emissiveIntensity: SELF_LIT, vertexColors: true, metalness: D.paint.metal, roughness: D.paint.rough, clearcoat: 1, clearcoatRoughness: 0.06, envMap, envMapIntensity: 1.15 })
    : new THREE.MeshStandardMaterial({ map: livTex, emissiveMap: livTex, emissive: 0xffffff, emissiveIntensity: SELF_LIT, vertexColors: true, metalness: D.paint.metal, roughness: D.paint.rough * 0.85, envMap, envMapIntensity: 1.2 }), { rim: true, damage: true, loose: true, dmgTex });
  const trimMat = patchMaterial(new THREE.MeshStandardMaterial({ map: sh.carbon, vertexColors: true, envMap, envMapIntensity: 1 }), { rm: true, loose: true, rim: true });
  const glassMat = patchMaterial(new THREE.MeshStandardMaterial({ color: 0x5a6e88, metalness: 0.62, roughness: 0.05, transparent: true, opacity: 0.6, envMap, envMapIntensity: 1.6, depthWrite: false }), { glass: true });
  const lightMat = patchMaterial(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }), { lights: true });
  const wheelMat = patchMaterial(new THREE.MeshStandardMaterial({ map: sh.wheel, vertexColors: true, envMap, envMapIntensity: 1 }), { rm: true, glow: true });
  const flameMat = patchMaterial(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, opacity: 1 }), { flame: true });
  const rimCol = new THREE.Color(def.color).lerp(new THREE.Color(1, 1, 1), 0.55);
  paintMat.userData.u.uRimColor.value.copy(rimCol); trimMat.userData.u.uRimColor.value.copy(rimCol).multiplyScalar(0.6);
  wheelMat.userData.u.uGlowColor.value.copy(new THREE.Color(def.color));
  // ---- jerarquía
  const PIVOT = 0.45;
  const root = new THREE.Group(); root.name = 'coche-' + D.key; root.rotation.order = 'YXZ';
  const body = new THREE.Group(); body.name = 'carroceria'; body.position.y = PIVOT; root.add(body);
  const shell = new THREE.Group(); shell.position.y = -PIVOT; body.add(shell);
  const geos = [], lod0 = [], lod1 = [];
  const addMesh = (geo, mat, list, o = {}) => {
    const m = new THREE.Mesh(geo, mat); geos.push(geo);
    m.castShadow = !!o.shadow; m.receiveShadow = false; if (o.order) m.renderOrder = o.order;
    shell.add(m); list.push(m); return m;
  };
  let kit0 = null, stats = { lod0: { calls: 0, tris: 0 }, lod1: { calls: 0, tris: 0 } };
  if (hasLod0) {
    const r = buildLOD(D, 0, colors, L); kit0 = r.kit;
    const pg = splitProject(r.B.paint, (fx, fy, fz, cx, v) => (r.B.paint.A.proj[v] < 0.5 ? 5 : L.pick(fx, fy, fz, cx)), L.uv);
    const tg = splitProject(r.B.trim, (fx, fy, fz) => { const ax = Math.abs(fx), ay = Math.abs(fy), az = Math.abs(fz); return ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2; },
      (reg, x, y, z) => (reg === 0 ? [z * 9, y * 9] : reg === 1 ? [x * 9, z * 9] : [x * 9, y * 9]));
    addMesh(pg, paintMat, lod0, { shadow: true });
    addMesh(tg, trimMat, lod0, { shadow: true });
    addMesh(r.B.glass.build(), glassMat, lod0, { order: 2 });
  }
  // LOD 1 (lejos / gama baja): una sola malla de carrocería
  let kit1;
  {
    const r = buildLOD(D, 1, colors, L); kit1 = r.kit;
    const pg = splitProject(r.B.paint, (fx, fy, fz, cx, v) => (r.B.paint.A.proj[v] < 0.5 ? 5 : L.pick(fx, fy, fz, cx)), L.uv);
    addMesh(pg, paintMat, lod1, { shadow: true });
  }
  // luces (compartidas por ambos LOD)
  const kitL = kit0 || kit1;
  if (!kit0) D.lights(kit1);
  const lightGeo = kitL.B.lights.build();
  const lightMesh = new THREE.Mesh(lightGeo, lightMat); geos.push(lightGeo); shell.add(lightMesh);
  // llamas
  const flameGeo = flameGeometry(kitL);
  const flame = new THREE.Mesh(flameGeo, flameMat); geos.push(flameGeo); flame.visible = false; flame.renderOrder = 5; shell.add(flame);
  // ---- ruedas (skinning)
  const wheels = [], bones = [];
  for (let w = 0; w < 4; w++) {
    const side = w % 2 === 0 ? 1 : -1;
    const steer = new THREE.Object3D(); steer.name = 'mangueta' + w; steer.position.set(side * D.track / 2, D.r, w < 2 ? D.frontAxleZ : D.rearAxleZ);
    const spin = new THREE.Object3D(); spin.name = 'giro' + w; steer.add(spin); root.add(steer);
    wheels.push({ steer, spin, radius: D.r }); bones[w] = spin; bones[4 + w] = steer;
  }
  root.updateMatrixWorld(true);
  const boneInv = bones.map((bn) => bn.matrixWorld.clone().invert());
  const skeleton = new THREE.Skeleton(bones, boneInv);
  const makeWheelMesh = (lod) => {
    const geo = buildWheels(D, kit1, lod, colors).build(); geos.push(geo);
    const m = new THREE.SkinnedMesh(geo, wheelMat);
    m.bind(skeleton, new THREE.Matrix4());
    m.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, D.r, (D.frontAxleZ + D.rearAxleZ) / 2), D.wb / 2 + 0.75);
    m.castShadow = true; root.add(m);
    return m;
  };
  const wheel0 = hasLod0 ? makeWheelMesh(0) : null, wheel1 = makeWheelMesh(1);
  if (wheel0) lod0.push(wheel0); lod1.push(wheel1);
  // ---- datos públicos
  const len = D.zFront - D.zRear;
  const dims = {
    length: +len.toFixed(3), width: +(2 * Math.max(D.body.xHalf(D.frontAxleZ), D.body.xHalf(D.rearAxleZ), D.track / 2 + D.tyreW / 2)).toFixed(3),
    height: +Math.max(D.canopy.h(D.canopy.driver[1]) + kit1.body.topY(D.canopy.driver[1], 0), 1.0).toFixed(3),
    wheelbase: D.wb, track: D.track, wheelRadius: D.r, frontAxleZ: D.frontAxleZ, rearAxleZ: D.rearAxleZ, rideHeight: +D.body.yFloor(0).toFixed(3),
    pivotY: PIVOT, frontZ: D.zFront, rearZ: D.zRear,
  };
  if (D.height) dims.height = D.height;
  const V = (p) => new THREE.Vector3(p[0], p[1], p[2]);
  const lamps = { head: kitL.lamps.head.map(V), tail: kitL.lamps.tail.map(V), brake: kitL.lamps.brake.map(V) };
  if (kitL.beacon) lamps.beacon = kitL.beacon.map(V);
  const exhaust = kitL.exhaust.map(V);
  // ---- estado
  let lod = hasLod0 ? 0 : 1, brake = -1, head = -1, flameK = 0, hi = -1, dmg = -1, heat = 0, lastT = 0, disposed = false;
  const U = paintMat.userData.u, UT = trimMat.userData.u, UL = lightMat.userData.u, UW = wheelMat.userData.u;
  const applyLod = () => { for (const m of lod0) m.visible = lod === 0; for (const m of lod1) m.visible = lod === 1; };
  applyLod();
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  const model = {
    root, body, wheels, dims, lamps, exhaust, design: DESIGNS[index] || { index, key: D.key, title: D.title, desc: D.desc, wheel: D.wheel.type }, def, index,
    smoke: false, smokeLevel: 0, smokePoint: new THREE.Vector3(0, 0.75, D.rearAxleZ - 0.2),
    materials: { paint: paintMat, trim: trimMat, glass: glassMat, lights: lightMat, wheels: wheelMat, flame: flameMat },
    stats: null,
    setBrake(k) {
      k = k > 1 ? 1 : k < 0 ? 0 : k;
      const t = now(), dt = Math.min(0.25, Math.max(0, t - lastT)); lastT = t;
      // calor del disco: sube rápido al frenar, se enfría despacio
      const tgt = k > 0.35 ? k : 0;
      heat += (tgt - heat) * (1 - Math.exp(-dt * (tgt > heat ? 2.2 : 0.45)));
      if (Math.abs(heat - UW.uHeat.value) > 0.004) UW.uHeat.value = heat;
      if (Math.abs(k - brake) > 0.01) { brake = k; UL.uBrake.value = k; }
    },
    setHeadlights(k) { k = clamp(k, 0, 1); if (k !== head) { head = k; UL.uHead.value = k; } },
    setFlame(k) {
      k = clamp(k, 0, 1); flameK = k;
      const on = k > 0.02; flame.visible = on;
      if (on) { const f = 0.8 + Math.random() * 0.4; flameMat.userData.u.uFl.value = (0.5 + 0.6 * k) * (0.85 + Math.random() * 0.3); flameMat.opacity = Math.min(1, k * f); }
    },
    setHighlight(k) { k = clamp(k, 0, 1); if (k !== hi) { hi = k; U.uRim.value = k * 0.9; UT.uRim.value = k * 0.5; UW.uGlow.value = k * 0.6 + (D.wheelGlow ? 1.2 : 0); } },
    setDamage(k) {
      k = clamp(k, 0, 1); if (k === dmg) return; dmg = k;
      U.uDamage.value = k; U.uLoose.value = UT.uLoose.value = clamp((k - 0.45) / 0.55, 0, 1);
      model.smokeLevel = clamp((k - 0.55) / 0.45, 0, 1); model.smoke = k >= 0.6;
    },
    setLod(l) { const n = hasLod0 && l === 0 ? 0 : 1; if (n !== lod) { lod = n; applyLod(); } },
    getLod() { return lod; },
    dispose() {
      if (disposed) return; disposed = true;
      root.removeFromParent();
      for (const g of geos) g.dispose();
      for (const m of [paintMat, trimMat, glassMat, lightMat, wheelMat, flameMat]) m.dispose();
      livTex.dispose(); dmgTex.dispose(); skeleton.dispose();
      releaseShared();
    },
  };
  model.setHighlight(0); model.setDamage(0); model.setHeadlights(0); model.setBrake(0);
  // estadísticas (draw calls / triángulos por LOD)
  const triOf = (m) => (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
  stats.lod0 = hasLod0 ? { calls: lod0.length + 1, tris: lod0.reduce((s, m) => s + triOf(m), 0) + triOf(lightMesh) } : null;
  stats.lod1 = { calls: lod1.length + 1, tris: lod1.reduce((s, m) => s + triOf(m), 0) + triOf(lightMesh) };
  stats.flame = { calls: 1, tris: triOf(flame) };
  stats.parts = { lights: triOf(lightMesh), lod0: lod0.map((m) => [m.material.type + (m.isSkinnedMesh ? ':ruedas' : ''), triOf(m)]), lod1: lod1.map((m) => [m.material.type + (m.isSkinnedMesh ? ':ruedas' : ''), triOf(m)]) };
  model.stats = stats;
  return model;
}
