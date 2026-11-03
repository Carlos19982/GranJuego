/* =========================================================================
   GRAN PREMIO NEÓN · pista.js — la pista en sí (asfalto, pianos, escapatorias,
   barreras, boxes, túneles y puentes) a partir de circuito.js.

   buildTrackSurface({ scene, track: T, tier, envMap, embankment? }) → {
     group, occluders: [[minX,minY,minZ,maxX,maxY,maxZ]], setWet(0..1),
     update(dt, t), dispose(), stats { drawCalls, tris, verts, meshes, ms }, uniforms
   }
   embankment: 'wall' | 'slope' | 'none' (por defecto layout.embankment, o 'wall' en
   circuitos urbanos/nocturnos y 'slope' en el resto). Tema: T.theme (surface del
   trazado + night, glowK, glowB, flood, stripeA/B, sand, grass, gravel, wall).

   · Asfalto con shader propio (sobre MeshStandardMaterial): árido fino,
     manchas y parches de reparación, juntas, goma de la trazada (T.line) con
     las dos rodadas, frenazos en las frenadas, líneas pintadas, meta a
     cuadros, casillas de parrilla (T.grid), líneas de entrada/salida de boxes,
     charcos y brillo de mojado (setWet).
   · Pianos con relieve (dientes de sierra a la salida, planos en el vértice).
   · Escapatorias por tipo (asfalto con franjas, arena, hierba, grava) y
     taludes / muros de contención hasta el suelo (y = 0).
   · Barreras: muro de hormigón + valla, neumáticos con cinta transportadora,
     guardarraíl doble; protecciones de neumáticos automáticas en las
     escapatorias grandes. Logotipos pintados (marcas ficticias).
   · Calle de boxes (superficie, carriles, cajones) y muro de boxes.
   · Túneles (paredes, techo, luces) y tableros de puente para cruces reales.
   · Sin luces globales. ≤ 7 draw calls (8 con sombras en 'high').
   ========================================================================= */
import * as THREE from 'three';
import { sampleTrack } from './circuito.js';

const TIER = {
  low: { maxStep: 6, ang: 0.06, minStep: 0.8, tex: 512, kerbStep: 0.5, kerbFlat: 1.5, ridges: false, fence: false, wallLogos: 0.5, shadow: false },
  med: { maxStep: 4, ang: 0.04, minStep: 0.6, tex: 512, kerbStep: 0.4, kerbFlat: 1.0, ridges: true, fence: true, wallLogos: 1, shadow: false },
  high: { maxStep: 3, ang: 0.03, minStep: 0.5, tex: 1024, kerbStep: 0.3, kerbFlat: 0.75, ridges: true, fence: true, wallLogos: 1, shadow: true },
};
const BRANDS = [
  ['NEOTRÓN', '#22e4ff', '#071a26'], ['VOLTIAX', '#ffcc33', '#1f1405'], ['QUASARIX', '#ff2fb3', '#24061a'], ['PIXELIA', '#2bff88', '#04200f'],
  ['TURBONEO', '#ff6a3d', '#260c05'], ['ZYNTRA', '#b49bff', '#120826'], ['LUMIRA', '#ffffff', '#1a1626'], ['KROMAX', '#ffe14d', '#0b1d3a'],
];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lin = (hex, k = 1) => { const c = new THREE.Color(hex); return [c.r * k, c.g * k, c.b * k]; };

/* ===================================================== texturas procedurales */
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/**
 * Textura de detalle RGBA (DataTexture, sin premultiplicar):
 * R árido / grano · G manchas y parches (0.5 neutro) · B estrías de frenada (a lo largo de v) · A charcos
 */
/** suma una octava de ruido de valor periódico (cells × cells) a out (S × S), rápido (sin cierres) */
function octave(out, S, cells, amp, R) {
  const g = new Float32Array(cells * cells); for (let i = 0; i < g.length; i++) g[i] = R() - 0.5;
  const ix = new Int32Array(S), tx = new Float32Array(S);
  for (let x = 0; x < S; x++) { const f = (x * cells) / S, i = Math.floor(f), t = f - i; ix[x] = i % cells; tx[x] = t * t * (3 - 2 * t); }
  for (let y = 0; y < S; y++) {
    const y0 = ix[y] * cells, y1 = ((ix[y] + 1) % cells) * cells, ty = tx[y], row = y * S;
    for (let x = 0; x < S; x++) {
      const x0 = ix[x], x1 = (x0 + 1) % cells, t = tx[x];
      const a = g[x0 + y0] + (g[x1 + y0] - g[x0 + y0]) * t, b = g[x0 + y1] + (g[x1 + y1] - g[x0 + y1]) * t;
      out[row + x] += amp * (a + (b - a) * ty);
    }
  }
}
function makeDetail(S) {
  const R = rng(1234), d = new Uint8Array(S * S * 4);
  const fR = new Float32Array(S * S).fill(0.5), fG = new Float32Array(S * S).fill(0.5), fB = new Float32Array(S * S), fA = new Float32Array(S * S);
  octave(fR, S, 64, 0.35, R); octave(fR, S, 128, 0.35, R); octave(fR, S, Math.min(256, S / 2), 0.3, R);
  for (let i = 0; i < S * S; i++) fR[i] += (R() - 0.5) * 0.35;
  octave(fG, S, 4, 0.25, R); octave(fG, S, 8, 0.2, R); octave(fG, S, 16, 0.12, R);
  const pa = new Float32Array(S * S).fill(0.5);
  octave(pa, S, 3, 0.55, R); octave(pa, S, 6, 0.3, R); octave(pa, S, 12, 0.15, R);
  for (let i = 0; i < S * S; i++) fA[i] = sstep(0.56, 0.72, pa[i]);
  // piedras del árido (puntos claros/oscuros)
  const nSt = (S * S) / 26;
  for (let k = 0; k < nSt; k++) {
    const x = (R() * S) | 0, y = (R() * S) | 0, r = R() < 0.8 ? 1 : 2, val = R() < 0.55 ? 0.35 : -0.3;
    for (let dy = -r; dy < r; dy++) for (let dx = -r; dx < r; dx++) { const i = ((x + dx + S) % S) + ((y + dy + S) % S) * S; fR[i] += val * (0.6 + 0.4 * R()); }
  }
  // parches de reparación (rectángulos) y grietas
  for (let k = 0; k < 4; k++) {
    const w = (0.05 + R() * 0.16) * S, h = (0.05 + R() * 0.3) * S, x0 = R() * S, y0 = R() * S, tone = R() < 0.6 ? -0.2 - R() * 0.1 : 0.14 + R() * 0.08;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const edge = Math.min(x, y, w - x, h - y);
      const i = (((x0 + x) | 0) % S) + ((((y0 + y) | 0) % S) * S);
      fG[i] += tone * Math.min(1, edge / 2) + (edge < 1.5 ? -0.12 : 0);
    }
  }
  for (let k = 0; k < 10; k++) {
    let x = R() * S, y = R() * S, a = R() * Math.PI * 2;
    const len = 30 + R() * S * 0.3;
    for (let t = 0; t < len; t++) { a += (R() - 0.5) * 0.6; x += Math.cos(a); y += Math.sin(a); const i = ((((x | 0) % S) + S) % S) + ((((y | 0) % S) + S) % S) * S; fG[i] -= 0.1; }
  }
  // estrías de neumático (verticales = a lo largo de la pista)
  for (let k = 0; k < 90; k++) {
    const x0 = R() * S, w = 0.6 + R() * 2.0, y0 = R() * S, len = (0.15 + R() * 0.6) * S, val = 0.35 + R() * 0.65, wob = (R() - 0.5) * 6;
    for (let t = 0; t < len; t++) {
      const f = Math.min(1, t / (len * 0.15), (len - t) / (len * 0.3));
      const xc = x0 + wob * Math.sin((t / len) * Math.PI);
      for (let dx = -2; dx <= 2; dx++) {
        const xx = Math.floor(xc + dx), cov = clamp(w / 2 + 0.5 - Math.abs(xx + 0.5 - xc), 0, 1);
        if (cov <= 0) continue;
        const i = ((xx % S) + S) % S + ((((y0 + t) | 0) % S) * S);
        fB[i] = Math.max(fB[i], val * f * cov);
      }
    }
  }
  for (let i = 0; i < S * S; i++) {
    d[i * 4] = clamp(fR[i], 0, 1) * 255; d[i * 4 + 1] = clamp(fG[i], 0, 1) * 255; d[i * 4 + 2] = clamp(fB[i], 0, 1) * 255; d[i * 4 + 3] = clamp(fA[i], 0, 1) * 255;
  }
  const t = new THREE.DataTexture(d, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
  return t;
}
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function canvasTex(c, srgb = true) { const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; }
function makeKerbTex(th) {
  const c = canvas(32, 128), x = c.getContext('2d'), R = rng(7);
  x.fillStyle = th.kerbA; x.fillRect(0, 0, 32, 64); x.fillStyle = th.kerbB; x.fillRect(0, 64, 32, 64);
  for (let i = 0; i < 900; i++) { x.fillStyle = `rgba(0,0,0,${R() * 0.12})`; x.fillRect(R() * 32, R() * 128, 1, 1); }
  // goma en el borde interior (u = 0) y bordes de bloque
  const g = x.createLinearGradient(0, 0, 32, 0); g.addColorStop(0, 'rgba(20,18,22,.55)'); g.addColorStop(0.35, 'rgba(20,18,22,.12)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 32, 128);
  x.fillStyle = 'rgba(0,0,0,.25)'; x.fillRect(0, 63, 32, 2); x.fillRect(0, 0, 32, 1); x.fillRect(0, 127, 32, 1);
  const t = canvasTex(c); t.wrapT = THREE.RepeatWrapping; t.wrapS = THREE.ClampToEdgeWrapping;
  return t;
}
// Atlas de barreras: bandas horizontales (u se repite a lo largo de la pista)
const AT_H = 1024;
const BAND = { concrete: [0, 256], belt: [256, 384], tyres: [384, 512], armco: [512, 640], tunnel: [640, 832], plain: [832, 896], top: [896, 1024] };
const V = (band, f) => { const [a, b] = BAND[band]; const y = b - 4 - f * (b - a - 8); return 1 - y / AT_H; };
function makeAtlas() {
  const W = 512, c = canvas(W, AT_H), x = c.getContext('2d'), R = rng(99);
  const speck = (y0, y1, n, a) => { for (let i = 0; i < n; i++) { const v = R(); x.fillStyle = v < 0.5 ? `rgba(0,0,0,${a * R()})` : `rgba(255,255,255,${a * R() * 0.7})`; x.fillRect(R() * W, y0 + R() * (y1 - y0), 1 + R() * 2, 1 + R() * 2); } };
  // hormigón: paneles de 2 m (u: 4 m por repetición) con churretes y roces
  { const [a, b] = BAND.concrete; x.fillStyle = '#d2d0cc'; x.fillRect(0, a, W, b - a); speck(a, b, 5000, 0.18);
    for (let i = 0; i < 22; i++) { const xx = R() * W, g = x.createLinearGradient(0, a, 0, a + 40 + R() * 120); g.addColorStop(0, 'rgba(70,64,58,.12)'); g.addColorStop(1, 'rgba(70,64,58,0)'); x.fillStyle = g; x.fillRect(xx, a, 3 + R() * 10, 200); }
    const gb = x.createLinearGradient(0, b - 70, 0, b); gb.addColorStop(0, 'rgba(30,28,30,0)'); gb.addColorStop(1, 'rgba(30,28,30,.45)'); x.fillStyle = gb; x.fillRect(0, b - 70, W, 70);
    for (let i = 0; i < 6; i++) { x.fillStyle = `rgba(20,20,24,${0.06 + R() * 0.12})`; const yy = a + 190 + R() * 45; x.beginPath(); x.ellipse(R() * W, yy, 30 + R() * 70, 1.5 + R() * 3, 0, 0, 7); x.fill(); }
    x.fillStyle = 'rgba(0,0,0,.3)'; x.fillRect(0, a, 2, b - a); x.fillRect(W / 2, a, 2, b - a);
    x.fillStyle = 'rgba(255,255,255,.25)'; x.fillRect(2, a, 1, b - a); x.fillRect(W / 2 + 2, a, 1, b - a);
    x.fillStyle = 'rgba(255,255,255,.18)'; x.fillRect(0, a, W, 5); }
  // cinta transportadora (goma negra, tornillos y franjas)
  { const [a, b] = BAND.belt; x.fillStyle = '#18181c'; x.fillRect(0, a, W, b - a); speck(a, b, 2500, 0.15);
    for (let yy = a + 10; yy < b; yy += 18) { x.fillStyle = 'rgba(255,255,255,.05)'; x.fillRect(0, yy, W, 1); }
    x.fillStyle = '#c8202c'; x.fillRect(0, a + 14, W, 9); x.fillStyle = '#e8e8e8'; x.fillRect(0, a + 23, W, 5);
    x.fillStyle = '#c8202c'; x.fillRect(0, b - 22, W, 6);
    for (let xx = 8; xx < W; xx += 32) { x.fillStyle = '#6a6a72'; x.beginPath(); x.arc(xx, a + 36, 2.5, 0, 7); x.arc(xx, b - 34, 2.5, 0, 7); x.fill(); } }
  // neumáticos vistos desde arriba (2 filas, 4 por repetición de 2.4 m)
  { const [a, b] = BAND.tyres; x.fillStyle = '#0d0d10'; x.fillRect(0, a, W, b - a);
    for (let r = 0; r < 2; r++) for (let k = 0; k < 5; k++) {
      const cx = k * 128 + (r ? 64 : 0), cy = a + 32 + r * 64;
      x.fillStyle = '#26262b'; x.beginPath(); x.ellipse(cx, cy, 58, 30, 0, 0, 7); x.fill();
      x.fillStyle = '#34343a'; x.beginPath(); x.ellipse(cx - 4, cy - 3, 50, 25, 0, 0, 7); x.fill();
      x.fillStyle = '#070709'; x.beginPath(); x.ellipse(cx, cy, 30, 15, 0, 0, 7); x.fill();
      x.strokeStyle = 'rgba(255,255,255,.08)'; x.lineWidth = 2; x.beginPath(); x.ellipse(cx, cy, 44, 22, 0, 0, 7); x.stroke();
    } }
  // guardarraíl (acero galvanizado, ondas horneadas)
  { const [a, b] = BAND.armco; const g = x.createLinearGradient(0, a, 0, b);
    [[0, '#7d8288'], [0.15, '#dfe3e6'], [0.3, '#9aa0a6'], [0.5, '#5f646a'], [0.7, '#c9cdd1'], [0.85, '#edf0f2'], [1, '#80858b']].forEach(([o, cc]) => g.addColorStop(o, cc));
    x.fillStyle = g; x.fillRect(0, a, W, b - a); speck(a, b, 1500, 0.12);
    for (let i = 0; i < 18; i++) { x.fillStyle = `rgba(120,70,30,${0.08 + R() * 0.15})`; x.beginPath(); x.ellipse(R() * W, a + R() * 128, 4 + R() * 18, 2 + R() * 6, 0, 0, 7); x.fill(); }
    for (let xx = 16; xx < W; xx += 128) { x.fillStyle = '#4a4e53'; x.fillRect(xx, a + 58, 7, 12); } }
  // túnel: azulejos 0.5 m
  { const [a, b] = BAND.tunnel; x.fillStyle = '#c9ccd2'; x.fillRect(0, a, W, b - a); speck(a, b, 3000, 0.1);
    x.fillStyle = 'rgba(40,40,50,.5)'; for (let xx = 0; xx < W; xx += 32) x.fillRect(xx, a, 2, b - a); for (let yy = a; yy < b; yy += 24) x.fillRect(0, yy, W, 2);
    const gb = x.createLinearGradient(0, b - 60, 0, b); gb.addColorStop(0, 'rgba(20,20,25,0)'); gb.addColorStop(1, 'rgba(20,20,25,.55)'); x.fillStyle = gb; x.fillRect(0, b - 60, W, 60); }
  { const [a, b] = BAND.plain; x.fillStyle = '#f2f2f2'; x.fillRect(0, a, W, b - a); speck(a, b, 800, 0.08); }
  { const [a, b] = BAND.top; x.fillStyle = '#8d8a86'; x.fillRect(0, a, W, b - a); speck(a, b, 3000, 0.25); }
  const t = canvasTex(c); t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
function makeFenceTex() {
  const c = canvas(64, 64), x = c.getContext('2d');
  x.fillStyle = 'rgba(170,176,186,0.04)'; x.fillRect(0, 0, 64, 64);
  x.strokeStyle = 'rgba(170,176,186,0.95)'; x.lineWidth = 1.6;
  for (let k = -64; k <= 128; k += 16) { x.beginPath(); x.moveTo(k, 0); x.lineTo(k + 64, 64); x.stroke(); x.beginPath(); x.moveTo(k + 64, 0); x.lineTo(k, 64); x.stroke(); }
  const t = canvasTex(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}
/** Atlas de rótulos pintados: 8 marcas (2×4 celdas de 512×128), dígitos 1-6, nombre del circuito, flechas */
function makeLogoAtlas(T) {
  const c = canvas(1024, 1024), x = c.getContext('2d');
  const font = (px) => `900 ${px}px "Arial Black", "Helvetica Neue", Impact, sans-serif`;
  BRANDS.forEach(([name, fg, bg], i) => {
    const cx = (i % 2) * 512, cy = Math.floor(i / 2) * 128;
    const panel = i % 3 !== 2;
    if (panel) {
      x.fillStyle = bg; x.beginPath(); x.roundRect ? x.roundRect(cx + 8, cy + 10, 496, 108, 18) : x.rect(cx + 8, cy + 10, 496, 108); x.fill();
      x.strokeStyle = fg; x.lineWidth = 6; x.stroke();
    }
    x.fillStyle = fg; x.font = font(78); x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(name, cx + 256, cy + 68, 460);
    if (!panel) { x.fillRect(cx + 40, cy + 112, 432, 6); }
  });
  // dígitos de parrilla (celdas 128×128 en y 512)
  for (let k = 0; k < 6; k++) { x.fillStyle = '#ffffff'; x.font = font(104); x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(String(k + 1), k * 128 + 64, 512 + 68); }
  // nombre del circuito (1024×128 en y 640)
  x.fillStyle = '#ffffff'; x.font = font(96); x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText((T.name || '').toUpperCase(), 512, 640 + 68, 980);
  // "PIT" y flecha (y 768)
  x.font = font(100); x.fillText('PIT', 128, 768 + 68); x.fillText('80', 384, 768 + 68);
  x.beginPath(); x.moveTo(560, 800); x.lineTo(700, 832); x.lineTo(560, 864); x.closePath(); x.fill();
  const t = canvasTex(c); return t;
}
const LOGO_CELL = (i) => { const cx = (i % 2) * 512, cy = Math.floor(i / 2) * 128; return [cx / 1024, 1 - (cy + 128) / 1024, (cx + 512) / 1024, 1 - cy / 1024]; };
const DIGIT_CELL = (k) => [(k * 128) / 1024, 1 - 640 / 1024, ((k + 1) * 128) / 1024, 1 - 512 / 1024];
const NAME_CELL = [0, 1 - 768 / 1024, 1, 1 - 640 / 1024];
const PIT_CELL = [0, 1 - 896 / 1024, 256 / 1024, 1 - 768 / 1024];

/** caché de texturas compartidas con contador de referencias (se liberan con el último dispose) */
const SHARED = new Map();
function shared(key, make) { let e = SHARED.get(key); if (!e) { e = { tex: make(), n: 0 }; SHARED.set(key, e); } e.n++; return e.tex; }
function release(key) { const e = SHARED.get(key); if (!e) return; if (--e.n <= 0) { e.tex.dispose(); SHARED.delete(key); } }

/* ===================================================== acumulador de geometría */
class Acc {
  constructor(attrs) { this.p = []; this.idx = []; this.n = 0; this.attrs = attrs; this.a = {}; for (const k in attrs) this.a[k] = []; }
  v(x, y, z, at) { this.p.push(x, y, z); for (const k in this.attrs) { const src = at[k], dst = this.a[k]; for (let q = 0; q < this.attrs[k]; q++) dst.push(src[q]); } return this.n++; }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, c, b, b, c, d); } // a,b = fila r (b a la izquierda); c,d = fila r+1 → normal hacia arriba
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    for (const k in this.attrs) g.setAttribute(k, new THREE.Float32BufferAttribute(this.a[k], this.attrs[k]));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}

/* ===================================================== shaders */
const GLSL_COMMON = /* glsl */`
uniform sampler2D tDetail; uniform float uWet; uniform float uL; uniform float uTime; uniform vec3 uFloodCol; uniform vec3 uGlowA; uniform vec3 uGlowB; uniform float uKerbOut;
float lineAA(float d, float hw) { float fw = fwidth(d) * 0.75 + 1e-4; return 1.0 - smoothstep(hw - fw, hw + fw, d); }
float sgnWrap(float d) { return d - uL * floor(d / uL + 0.5); }
`;
const ROAD_FRAG = /* glsl */`
  float trkRough = 0.8; vec3 trkEmis = vec3(0.0);
  {
  float u = vTrk.x, s = vTrk.y, hw = vTrk.z, ln = vTrk.w;
  float brake = vAux.x, rubK = vAux.y, mode = vAux.z;
  vec4 tF = texture2D(tDetail, vWXZ * 0.31);
  vec4 tM = texture2D(tDetail, vWXZ * 0.071 + 0.37);
  vec4 tC = texture2D(tDetail, vWXZ * 0.0213);
  float grain = tF.r;
  vec3 col = uAsph * (0.6 + 0.8 * grain);
  col *= 0.86 + 0.28 * tM.g;
  vec4 tP = texture2D(tDetail, vec2(u * 0.045 + 0.5, s * 0.0105));
  col *= 1.0 + (tP.g - 0.5) * 0.45;
  float rough = 0.74 + 0.22 * grain;
  float paint = 0.0; vec3 pcol = uPaint;
  float ed = hw - abs(u);
  if (mode < 0.5) {
    // goma de la trazada: banda ancha + dos rodadas
    float dl = u - ln;
    float band = exp(-dl * dl / 3.4);
    float tr = exp(-pow((abs(dl) - 0.96) / 0.3, 2.0));
    float rub = (band * 0.5 + tr * 0.6) * rubK * (0.7 + 0.6 * tM.r);
    col *= 1.0 - 0.36 * clamp(rub, 0.0, 1.0);
    rough -= 0.1 * rub;
    // frenazos (estrías a lo largo de la pista, cerca de las rodadas)
    vec4 tS = texture2D(tDetail, vec2(u * 0.37 + 0.13, s * 0.019));
    float near = smoothstep(0.85, 0.15, abs(abs(dl) - 0.96));
    float sk = tS.b * brake * near;
    col *= 1.0 - 0.6 * sk;
    rough -= 0.15 * sk;
    // polvo / gravilla junto a los bordes
    col = mix(col, col * 1.18 + vec3(0.006), (1.0 - smoothstep(0.4, 2.2, ed)) * 0.55);
    // juntas transversales y junta central
    float jf = fract(s / 97.0 + 0.004 * sin(u * 0.9)); float jd = min(jf, 1.0 - jf) * 97.0;
    col *= 1.0 - 0.45 * lineAA(jd, 0.035);
    col *= 1.0 - 0.18 * lineAA(abs(u - 0.15 * sin(s * 0.013)), 0.025);
    // líneas pintadas del borde
    paint = max(paint, lineAA(abs(ed - 0.27), 0.13));
    // meta a cuadros
    float sd = sgnWrap(s);
    if (abs(sd) < 1.5) {
      float ck = mod(floor((u + 60.0) / 0.6) + floor((sd + 0.9) / 0.6), 2.0);
      float inC = step(abs(sd), 0.9);
      col = mix(col, ck > 0.5 ? vec3(0.8) : vec3(0.012), inC);
      rough = mix(rough, 0.55, inC);
      paint = max(paint, lineAA(abs(sd - 1.05), 0.08));
    }
    // casillas de parrilla
    for (int i = 0; i < 6; i++) {
      vec2 g = uGrid[i];
      float d = sgnWrap(s - g.x), du = u - g.y;
      float front = step(abs(du), 1.4) * lineAA(abs(d - 2.75), 0.11);
      float legs = lineAA(abs(abs(du) - 1.35), 0.07) * step(1.5, d) * step(d, 2.86);
      paint = max(paint, max(front, legs));
    }
    // líneas de entrada / salida de boxes
    float pe = sgnWrap(s - uPit.x), px = sgnWrap(s - uPit.y);
    float pitLine = (step(-70.0, pe) * step(pe, 0.0) + step(0.0, px) * step(px, 90.0)) * lineAA(abs(u - uPit.z * (hw - 2.1)), 0.1);
    paint = max(paint, pitLine);
  } else {
    // calle de boxes: u = distancia desde el borde interior, hw = ancho
    float full = step(0.99, vAux.w);
    col *= 1.06;
    paint = max(paint, lineAA(abs(u - 0.2), 0.1) * step(0.5, hw));
    paint = max(paint, lineAA(abs(hw - u - 0.2), 0.1) * step(0.5, hw));
    paint = max(paint, lineAA(abs(u - 5.6), 0.08) * step(fract(s / 6.0), 0.5) * step(7.0, hw));
    float cs = fract(s / 14.0) * 14.0;
    float bx = (lineAA(abs(u - 6.4), 0.07) + lineAA(abs(u - (hw - 0.8)), 0.07)) * step(2.0, cs) * step(cs, 11.0)
             + (lineAA(abs(cs - 2.0), 0.07) + lineAA(abs(cs - 11.0), 0.07)) * step(6.4, u) * step(u, hw - 0.8);
    float boxes = clamp(bx, 0.0, 1.0) * full;
    pcol = mix(pcol, vec3(1.0, 0.62, 0.05), boxes);
    paint = max(paint, boxes);
  }
  // mojado: más oscuro, brillante, charcos
  float puddle = smoothstep(0.35, 0.85, tC.a) * uWet;
  puddle = max(puddle, (1.0 - smoothstep(0.3, 1.6, ed)) * 0.5 * uWet);
  col *= mix(1.0, 0.5, uWet);
  col *= 1.0 - 0.3 * puddle;
  rough = mix(rough, 0.3 + 0.25 * grain, uWet);
  rough = mix(rough, 0.1, puddle);
  // pintura (gastada)
  paint *= 0.82 + 0.18 * grain;
  col = mix(col, pcol * mix(1.0, 0.75, uWet), paint);
  rough = mix(rough, mix(0.5, 0.12, uWet), paint);
  diffuseColor.rgb = col;
  // iluminación horneada: focos del circuito (charcos de luz alternos) + reflejo de los neones del borde
  float pA = pow(0.5 + 0.5 * cos(6.2832 * s / 46.0), 3.0), pB = pow(0.5 + 0.5 * cos(6.2832 * (s + 23.0) / 46.0), 3.0);
  float fl = 0.38 + 0.62 * (pA * exp(-pow(u - hw, 2.0) / 60.0) + pB * exp(-pow(u + hw, 2.0) / 60.0));
  trkEmis = col * uFloodCol * fl;
  float spill = exp(-max(ed, 0.0) / mix(0.7, 1.6, uWet)) * (0.6 + 1.6 * uWet) * (1.0 - mode);
  trkEmis += (u > 0.0 ? uGlowA : uGlowB) * spill * 0.05 * (0.6 + 0.4 * grain);
  trkRough = clamp(rough, 0.03, 1.0);
  }
`;
const RUN_FRAG = /* glsl */`
  float trkRough = 0.9; vec3 trkEmis = vec3(0.0);
  {
  vec4 tF = texture2D(tDetail, vWXZ * 0.37);
  vec4 tV = texture2D(tDetail, vWXZ * 1.27 + 0.21);
  vec4 tC = texture2D(tDetail, vWXZ * 0.026);
  vec4 wR = vRun / max(1e-3, vRun.x + vRun.y + vRun.z + vRun.w);
  float d = vEdge.x, st = vEdge.z, flag = vEdge.w;
  vec3 cA = uRunAsph * (0.7 + 0.6 * tF.r) * (0.86 + 0.28 * tC.g);
  if (st > 0.01) {
    float b1 = step(1.7, d) * step(d, 3.2), b2 = step(3.2, d) * step(d, 4.7);
    cA = mix(cA, uStripeA * (0.75 + 0.35 * tF.r), b1 * st);
    cA = mix(cA, uStripeB * (0.75 + 0.35 * tF.r), b2 * st);
  }
  float rip = sin(dot(vWXZ, vec2(1.9, 0.8)) + tC.r * 14.0) * 0.5 + 0.5;
  vec3 cS = uSand * (0.84 + 0.12 * rip + 0.28 * (tV.r - 0.5) + 0.12 * (tC.g - 0.5));
  float mw = fract(dot(vWXZ, vec2(0.6, 0.8)) / 9.0); float mow = smoothstep(0.42, 0.5, mw) - smoothstep(0.92, 1.0, mw);
  vec3 cG = uGrass * (0.62 + 0.55 * tV.r) * (0.86 + 0.24 * mow) * (0.9 + 0.2 * tC.g);
  vec4 tP = texture2D(tDetail, vWXZ * 0.21 + 0.5);
  vec3 cR = uGravel * (0.5 + 0.75 * tP.r) * (0.8 + 0.4 * tF.g) * (0.92 + 0.08 * sin(d * 7.0 + tC.r * 6.0));
  vec3 col = cA * wR.x + cS * wR.y + cG * wR.z + cR * wR.w;
  if (flag > 0.5 && flag < 1.5) col *= 0.8;
  if (flag > 1.5 && flag < 2.5) col *= 1.25;
  float rough = 0.86 * wR.x + 0.96 * wR.y + 0.92 * wR.z + 0.97 * wR.w;
  col *= mix(1.0, 0.58, uWet);
  rough = mix(rough, 0.3 * wR.x + 0.7 * wR.y + 0.55 * wR.z + 0.6 * wR.w, uWet);
  float pud = smoothstep(0.45, 0.8, tC.a) * uWet * wR.x;
  rough = mix(rough, 0.05, pud);
  diffuseColor.rgb = col;
  float sv = vExt.y > 0.0 ? 1.0 : 0.0;
  float pA = pow(0.5 + 0.5 * cos(6.2832 * (vEdge.y + (sv > 0.5 ? 0.0 : 23.0)) / 46.0), 3.0);
  trkEmis = col * uFloodCol * (0.3 + 0.5 * pA * exp(-d * d / 90.0)) * (1.0 - step(1.5, flag) * step(flag, 2.5) * 0.4);
  vec3 gc = mix(uGlowB, uGlowA, sv);
  float sp = exp(-abs(d - uKerbOut - 0.18) / 0.55) + exp(-max(vExt.x - d, 0.0) / 0.8) * step(flag, 0.5) * 0.7;
  trkEmis += gc * sp * 0.045 * (1.0 + 2.0 * uWet) * step(flag, 0.5);
  trkRough = clamp(rough, 0.03, 1.0);
  }
`;
function patchMaterial(mat, key, uniforms, vDecl, vBody, fDecl, fBody) {
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + vDecl).replace('#include <begin_vertex>', '#include <begin_vertex>\n' + vBody);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + GLSL_COMMON + fDecl)
      .replace('#include <map_fragment>', fBody)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = trkRough;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += trkEmis;');
  };
}

/* ===================================================== constructor */
export function buildTrackSurface({ scene = null, track: T, tier = 'med', envMap = null, embankment = null } = {}) {
  const Q = TIER[tier] || TIER.med;
  const PROF = {}; let _pt = performance.now(); const mark = (k) => { const n = performance.now(); PROF[k] = Math.round(n - _pt); _pt = n; };
  const th = T.theme || {};
  const L = T.L, N = T.N, DS = T.ds;
  const night = !!th.night;
  const glowK = th.glowK != null ? th.glowK : night ? 1 : th.glow ? 0.35 : 0;
  const glowA = th.glow || '#22e4ff', glowB = th.glowB || th.kerbA || '#ff2fb3';
  const kIn = T.kerbIn != null ? T.kerbIn : 1.0, kOut = T.kerbOut != null ? T.kerbOut : 0.6;
  const EMB = embankment || (T.layout && T.layout.embankment) || (th.runoff === 'asfalto' || night ? 'wall' : 'slope');
  const group = new THREE.Group(); group.name = 'pista';
  const occluders = [];
  const owned = [];
  const wrap = (s) => s - Math.floor(s / L) * L;
  const idx = (s) => { let i = Math.round(wrap(s) / DS); if (i >= N) i -= N; return i; };
  const p = T.pit;

  /* ---------- por muestra: frenadas, goma, franjas, peso de escapatoria */
  const brakeA = new Float32Array(N), rubA = new Float32Array(N), stripeL = new Float32Array(N), stripeR = new Float32Array(N), tyreBufL = new Uint8Array(N), tyreBufR = new Uint8Array(N);
  {
    const forS = (a, b, fn) => { for (let s = a; s <= b; s += DS) fn(idx(s), s); };
    for (const c of T.corners) {
      const strong = clamp(40 / c.R, 0.25, 1) * clamp(c.angle / 0.8, 0.3, 1);
      const Lb = clamp(40 + 1500 / c.R, 50, 120), b0 = c.s0 - Lb, b1 = c.apex - 0.3 * (c.apex - c.s0);
      forS(b0, b1 + 10, (i, s) => { const f = Math.min(sstep(b0, b0 + Lb * 0.35, s), 1 - sstep(b1, b1 + 10, s)); brakeA[i] = Math.max(brakeA[i], strong * f); });
      if (c.R < 45) forS(c.apex, c.s1 + 25, (i, s) => { const f = Math.min(sstep(c.apex, c.apex + 8, s), 1 - sstep(c.s1, c.s1 + 25, s)); brakeA[i] = Math.max(brakeA[i], 0.45 * f); });
      // franjas pintadas en la escapatoria de asfalto exterior (y protecciones de neumáticos)
      const SA = c.dir > 0 ? stripeR : stripeL, TB = c.dir > 0 ? tyreBufR : tyreBufL;
      if (c.angle > 0.45) forS(c.apex - 15, c.s1 + 35, (i, s) => { const f = Math.min(sstep(c.apex - 15, c.apex, s), 1 - sstep(c.s1 + 20, c.s1 + 35, s)); SA[i] = Math.max(SA[i], f); });
      if (c.angle > 0.45 && c.R < 140) forS(c.apex - 5, c.s1 + 25, (i) => { TB[i] = 1; });
    }
    const ka = new Float32Array(N); for (let i = 0; i < N; i++) ka[i] = Math.min(1, Math.abs(T.k[i]) * 55);
    // suavizado barato
    for (let i = 0; i < N; i++) { let a = 0; for (let k = -15; k <= 15; k += 3) a += ka[(i + k + N) % N]; rubA[i] = 0.3 + 0.7 * Math.min(1, (a / 11) * 1.3); }
  }
  const lerpA = (A, s) => { let u = wrap(s) / DS; let i = Math.floor(u); const f = u - i; if (i >= N) i -= N; const j = i + 1 < N ? i + 1 : 0; return A[i] + (A[j] - A[i]) * f; };
  /** muestra enriquecida */
  function at(s) {
    const o = sampleTrack(T, s, {});
    o.s = s; o.tb = Math.tan(o.bank);
    o.rL = lerpA(T.runoffL, s); o.rR = lerpA(T.runoffR, s);
    const i = idx(s); o.ii = i;
    o.kkL = T.kerbKindL[i]; o.kkR = T.kerbKindR[i];
    o.roL = T.runoffKindL[i]; o.roR = T.runoffKindR[i]; o.baL = T.barrierKindL[i]; o.baR = T.barrierKindR[i];
    o.br = lerpA(brakeA, s); o.rub = lerpA(rubA, s); o.stL = lerpA(stripeL, s); o.stR = lerpA(stripeR, s);
    return o;
  }
  // altura del plano peraltado (plano solo hasta w + 2; luego horizontal)
  const H = (o, u) => o.y + clamp(u, -(o.w + 2), o.w + 2) * o.tb;
  const PX = (o, u) => o.x + o.nx * u, PZ = (o, u) => o.z + o.nz * u;

  mark('pre');
  /* ---------- filas adaptativas con cortes forzados */
  const cuts = new Set([0]);
  const addCut = (s) => cuts.add(Math.round(wrap(s) * 100) / 100);
  addCut(p.s0); addCut(p.s1); addCut(p.s0 + p.ramp); addCut(p.s1 - p.ramp);
  const tunnels = T.landmarks.filter((l) => l.type === 'tunnel');
  const decks = T.landmarks.filter((l) => l.type === 'bridge' && l.cross);
  for (const l of tunnels.concat(decks)) { addCut(l.s0); addCut(l.s1); }
  const cutList = [...cuts].sort((a, b) => a - b).concat([L]);
  const rowS = [];
  {
    let s = 0, ci = 1;
    while (s < L - 1e-6) {
      rowS.push(s);
      while (cutList[ci] <= s + 1e-6) ci++;
      let km = 0; for (let d = 0; d <= Q.maxStep; d += 1) km = Math.max(km, Math.abs(T.k[idx(s + d)]));
      let st = clamp(Q.ang / Math.max(km, 1e-5), Q.minStep, Q.maxStep);
      if (st > 2.5 && Math.abs(T.bank[idx(s)]) > 0.01) st = 2.5;
      s = Math.min(s + st, cutList[ci]);
    }
    rowS.push(L);
  }
  const ROWS = rowS.map((s) => at(s));
  /** filas de [a, b] (a ≤ b, b − a ≤ L), con s continua */
  function rowsIn(a, b) {
    const a0 = wrap(a), span = b - a, out = [];
    let k = ROWS.findIndex((r) => Math.abs(r.s - a0) < 0.02);
    if (k < 0) { k = ROWS.findIndex((r) => r.s > a0); if (k < 0) k = 0; }
    let base = a - a0, guard = 0;
    while (guard++ < ROWS.length + 2) {
      const r = ROWS[k], sc = r.s + base;
      if (sc > b + 0.02) break;
      out.push({ o: r, sc });
      if (k === ROWS.length - 1) { k = 1; base += L; } else k++;
    }
    return out;
  }
  const inSpan = (s, a, b) => wrap(s - a) <= (b - a) + 1e-6;
  const inTunnel = (s, pad = 0) => tunnels.some((l) => inSpan(s, l.s0 - pad, l.s1 + pad));
  const pitF = (s) => { if (!inSpan(s, p.s0, p.s1)) return 0; const d0 = wrap(s - p.s0), d1 = (p.s1 - p.s0) - d0; return Math.min(sstep(0, p.ramp, d0), sstep(0, p.ramp, d1)); };
  const inPit = (s) => inSpan(s, p.s0, p.s1);
  /** talud por fila: 'deck' sobre un puente (sin talud), 'wall' en los accesos al puente o en circuitos urbanos, si no EMB */
  const embAt = (s) => {
    for (const l of decks) { if (inSpan(s, l.s0, l.s1)) return 'deck'; if (inSpan(s, l.s0 - 80, l.s1 + 80)) return 'wall'; }
    return EMB;
  };

  /* ---------- texturas y materiales */
  mark('rows');
  // texturas independientes del tema: compartidas entre construcciones (con contador de referencias)
  const tDetail = shared('detail' + Q.tex, () => makeDetail(Q.tex));
  mark('texDetail');
  const kerbTex = makeKerbTex(th); owned.push(kerbTex);
  const atlas = shared('atlas', makeAtlas);
  const fenceTex = Q.fence ? shared('fence', makeFenceTex) : null;
  mark('texAtlas');
  const sharedKeys = ['detail' + Q.tex, 'atlas'].concat(Q.fence ? ['fence'] : []);
  const logoTex = makeLogoAtlas(T); owned.push(logoTex);
  mark('texLogo');
  const col3 = (hex, k = 1) => new THREE.Color(hex).multiplyScalar(k);
  const asph = col3(th.asphalt || '#2a2a33');
  { const l = asph.r * 0.3 + asph.g * 0.55 + asph.b * 0.15; asph.setRGB(l + (asph.r - l) * 0.2, l + (asph.g - l) * 0.2, l + (asph.b - l) * 0.2).multiplyScalar(2.3); }
  const U = {
    tDetail: { value: tDetail }, uWet: { value: 0 }, uL: { value: L }, uTime: { value: 0 },
    uAsph: { value: asph }, uPaint: { value: col3(th.line || '#ffffff', 0.85) },
    uGrid: { value: (T.grid || []).slice(0, 6).map((g) => new THREE.Vector2(g.s, g.latM != null ? g.latM : g.lat * 7.8)) },
    uPit: { value: new THREE.Vector3(p.s0, p.s1, p.side) },
    uRunAsph: { value: asph.clone().multiplyScalar(1.22) },
    uSand: { value: col3(th.sand || '#c9a066') }, uGrass: { value: col3(th.grass || (night ? '#1d3524' : '#3f6b2c')) }, uGravel: { value: col3(th.gravel || (night ? '#4a4650' : '#8a8274')) },
    uStripeA: { value: col3(th.stripeA || (night ? glowA : '#1e4fd6')) }, uStripeB: { value: col3(th.stripeB || (night ? glowB : '#d42a32')) },
    uFloodCol: { value: night ? new THREE.Color(0.62, 0.6, 0.78).multiplyScalar(th.flood != null ? th.flood : 1) : new THREE.Color(0, 0, 0) },
    uGlowA: { value: col3(glowA, glowK >= 0.6 ? glowK : 0) }, uGlowB: { value: col3(glowB, glowK >= 0.6 ? glowK : 0) }, uKerbOut: { value: kOut },
  };
  while (U.uGrid.value.length < 6) U.uGrid.value.push(new THREE.Vector2(-1e5, 0));
  const envI = (envMap ? 0.5 : 1) * (night ? 1.6 : 1);
  const roadMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, envMap, envMapIntensity: 0.35 * envI });
  patchMaterial(roadMat, 'pista-road', U,
    'attribute vec4 aTrk; attribute vec4 aAux; varying vec4 vTrk; varying vec4 vAux; varying vec2 vWXZ;',
    'vTrk = aTrk; vAux = aAux; vWXZ = (modelMatrix * vec4(position, 1.0)).xz;',
    'uniform vec3 uAsph; uniform vec3 uPaint; uniform vec2 uGrid[6]; uniform vec3 uPit; varying vec4 vTrk; varying vec4 vAux; varying vec2 vWXZ;',
    ROAD_FRAG);
  const runMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, envMap, envMapIntensity: 0.25 * envI });
  patchMaterial(runMat, 'pista-runoff', U,
    'attribute vec4 aRun; attribute vec4 aEdge; attribute vec2 aExt; varying vec4 vRun; varying vec4 vEdge; varying vec2 vExt; varying vec2 vWXZ;',
    'vRun = aRun; vEdge = aEdge; vExt = aExt; vWXZ = (modelMatrix * vec4(position, 1.0)).xz;',
    'uniform vec3 uRunAsph; uniform vec3 uSand; uniform vec3 uGrass; uniform vec3 uGravel; uniform vec3 uStripeA; uniform vec3 uStripeB; varying vec4 vRun; varying vec4 vEdge; varying vec2 vExt; varying vec2 vWXZ;',
    RUN_FRAG);
  const kerbMat = new THREE.MeshStandardMaterial({ map: kerbTex, roughness: 0.58, metalness: 0, envMap, envMapIntensity: 0.4 * envI, emissive: 0xffffff, emissiveMap: kerbTex, emissiveIntensity: night ? 0.22 * glowK : 0 });
  const barMat = new THREE.MeshStandardMaterial({ map: atlas, vertexColors: true, roughness: 0.78, metalness: 0.05, envMap, envMapIntensity: 0.35 * envI, side: THREE.DoubleSide, emissive: night ? new THREE.Color(0.11, 0.1, 0.14) : 0x000000, emissiveMap: night ? atlas : null });
  const fenceMat = fenceTex ? new THREE.MeshStandardMaterial({ map: fenceTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, roughness: 0.5, metalness: 0.5, envMap, envMapIntensity: 0.4 * envI, color: 0xc4c8d0 }) : null;
  const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const decalMat = new THREE.MeshStandardMaterial({ map: logoTex, transparent: true, depthWrite: false, roughness: 0.55, metalness: 0, envMap, envMapIntensity: 0.3 * envI, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, side: THREE.DoubleSide, forceSinglePass: true });
  owned.push(roadMat, runMat, kerbMat, barMat, glowMat, decalMat); if (fenceMat) owned.push(fenceMat);

  /* ---------- acumuladores */
  const road = new Acc({ aTrk: 4, aAux: 4 });
  const run = new Acc({ aRun: 4, aEdge: 4, aExt: 2 });
  const kerb = new Acc({ uv: 2 });
  const bar = new Acc({ uv: 2, color: 3 });
  const fence = new Acc({ uv: 2 });
  const glow = new Acc({ color: 3 });
  const decal = new Acc({ uv: 2 });

  /** cinta genérica: stations(o, sc) → [{u, y, at}] (de derecha a izquierda = u creciente) */
  function ribbon(acc, rows, stations) {
    let prev = null;
    for (const r of rows) {
      const st = stations(r.o, r.sc);
      const ids = st.map((q) => acc.v(PX(r.o, q.u), q.y, PZ(r.o, q.u), q.at));
      if (prev && prev.length === ids.length) for (let k = 0; k < ids.length - 1; k++) acc.quad(prev[k], prev[k + 1], ids[k], ids[k + 1]);
      prev = ids;
    }
  }

  mark('tex');
  /* ======================= ASFALTO */
  ribbon(road, rowsIn(0, L), (o, sc) => {
    const lnM = o.line * (o.w - 1.2), aux = [o.br, o.rub, 0, 0];
    return [-1, 0, 1].map((k) => ({ u: k * o.w, y: H(o, k * o.w), at: { aTrk: [k * o.w, sc, o.w, lnM], aAux: aux } }));
  });
  // calle de boxes (cuña en la entrada/salida)
  const pitRows = rowsIn(p.s0, p.s1);
  const pIn = Math.abs(p.lat0), pOut = Math.abs(p.lat1), sd = p.side;
  const laneEdges = (o) => { const f = pitF(o.s); return [o.w + f * (pIn - o.w), o.w + f * (pOut - o.w), f]; };
  ribbon(road, pitRows, (o, sc) => {
    const [a, b, f] = laneEdges(o), lw = b - a;
    const st = [0, 0.5, 1].map((k) => ({ u: sd * (a + lw * k), y: H(o, sd * (a + lw * k)) + 0.004, at: { aTrk: [lw * k, sc, lw, 0], aAux: [0, 0.3, 1, f] } }));
    return sd > 0 ? st : st.reverse();
  });

  mark('road');
  /* ======================= ESCAPATORIAS (+ taludes) */
  const KIND_W = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const groundKind = th.runoff === 'arena' ? 1 : th.runoff === 'grava' ? 1 : 2;
  const EMB_W = EMB === 'wall' ? [1, 0, 0, 0] : KIND_W[th.runoff === 'arena' ? 1 : groundKind];
  const ROOF_W = th.runoff === 'arena' ? KIND_W[1] : KIND_W[2];
  const barDepth = (kind, tyreBuf) => (kind === 1 || tyreBuf ? 1.75 : kind === 2 ? 0.45 : 0.55);
  function runStations(o, sc, side) {
    const R = side > 0 ? o.rL : o.rR, kind = side > 0 ? o.roL : o.roR, stp = side > 0 ? o.stL : o.stR;
    const ba = side > 0 ? o.baL : o.baR, tb = (side > 0 ? tyreBufL : tyreBufR)[o.ii] && R > 9 && ba !== 1;
    const kw = KIND_W[kind] || KIND_W[0], stripe = kind === 0 ? stp : 0;
    const vg = Math.min(1.6, R * 0.5);
    const tunnel = inTunnel(o.s, 2);
    const ds = [0, vg, vg + 0.02, R];
    const W = [KIND_W[0], KIND_W[0], kw, kw];
    const ext = [R, side];
    const out = ds.map((d, k) => { const u = side * (o.w + d); return { u, y: H(o, u), at: { aRun: W[k], aEdge: [d, sc, stripe, 0], aExt: ext } }; });
    // bajo la barrera y talud / muro de contención
    const dep = tunnel ? 0.6 : barDepth(ba, tb);
    const uB = side * (o.w + R + dep), yB = H(o, uB);
    out.push({ u: uB, y: yB, at: { aRun: kw, aEdge: [R + dep, sc, 0, 0], aExt: ext } });
    const hgt = yB;
    const em = embAt(o.s);
    let run = em === 'slope' && hgt > 0.25 ? 1.6 * hgt + 1.5 : (em === 'wall' || em === 'deck') && hgt > 0.25 ? 0.01 : 1.2;
    if (tunnel) run = 0.6;
    const uE = side * (o.w + R + dep + run), yE = em === 'slope' && hgt > 0.25 ? -0.08 : yB;
    out.push({ u: uE, y: yE, at: { aRun: EMB_W, aEdge: [R + dep + run, sc, 0, 1], aExt: ext } });
    return side > 0 ? out : out.reverse();
  }
  for (const side of [1, -1]) {
    if (side === sd) {
      ribbon(run, rowsIn(p.s1, p.s0 + L), (o, sc) => runStations(o, sc, side));
      // zona de boxes: franja entre pista y carril + explanada tras el carril
      ribbon(run, pitRows, (o, sc) => {
        const [a, b] = laneEdges(o);
        const st = [0, a - o.w].map((d) => { const u = side * (o.w + d); return { u, y: H(o, u), at: { aRun: KIND_W[0], aEdge: [d, sc, 0, 3], aExt: [a - o.w, side] } }; });
        return side > 0 ? st : st.reverse();
      });
      ribbon(run, pitRows, (o, sc) => {
        const [, b, f] = laneEdges(o);
        const Rn = side > 0 ? o.rL : o.rR;
        const end = Math.max(b - o.w + 3.5, f < 1 ? Rn + 1.2 : 0);
        const st = [b - o.w, end].map((d, k) => { const u = side * (o.w + d); return { u, y: H(o, u) + (k ? 0.01 : 0.004), at: { aRun: KIND_W[0], aEdge: [d, sc, 0, 2], aExt: [end, side] } }; });
        return side > 0 ? st : st.reverse();
      });
    } else ribbon(run, rowsIn(0, L), (o, sc) => runStations(o, sc, side));
  }

  mark('runoff');
  /* ======================= PIANOS */
  for (const side of [1, -1]) {
    const KB = side > 0 ? T.kerbL : T.kerbR, KK = side > 0 ? T.kerbKindL : T.kerbKindR;
    // tramos contiguos con piano
    let i0 = 0; while (i0 < N && KB[i0] > 0) i0++;
    for (let q = 0; q < N; q++) {
      const i = (i0 + q) % N;
      if (KB[i] > 0 && KB[(i - 1 + N) % N] <= 0) {
        let e = 0; while (e < N && KB[(i + e) % N] > 0) e++;
        const sA = (i - 1) * DS, sB = (i + e) * DS;
        let prev = null, sNow = sA, guard = 0;
        while (guard++ < 20000) {
          const s = Math.min(sNow, sB), o = sampleTrack(T, s, {}); o.tb = Math.tan(o.bank);
          const pres = side > 0 ? o.kerbL : o.kerbR, kind = KK[idx(s)] || 1;
          const saw = kind === 2 && Q.ridges;
          let hk = kind === 2 ? 0.045 : kind === 3 ? 0.02 : 0.03;
          if (saw) hk = Math.floor(s / Q.kerbStep + 0.5) % 2 ? 0.026 : 0.058;
          hk *= clamp(pres, 0, 1);
          const prof = [[-kIn, 0.006], [-kIn + 0.2, hk * 0.6 + 0.006], [kOut - 0.12, hk + 0.006], [kOut + 0.02, -0.04]];
          const ids = prof.map(([d, hh], k) => {
            const u = side * (o.w + d), y = o.y + clamp(u, -(o.w + 2), o.w + 2) * o.tb + hh;
            return kerb.v(o.x + o.nx * u, y, o.z + o.nz * u, { uv: [[0, 0.15, 0.95, 1][k], s / 2] });
          });
          if (side < 0) ids.reverse();
          if (prev) for (let k = 0; k < ids.length - 1; k++) kerb.quad(prev[k], prev[k + 1], ids[k], ids[k + 1]);
          prev = ids;
          if (s >= sB) break;
          sNow = s + (saw ? Q.kerbStep : Q.kerbFlat);
        }
        q += e;
      }
    }
  }

  mark('kerbs');
  /* ======================= BARRERAS */
  const WALL_TINT = th.wall ? lin(th.wall) : night ? [0.36, 0.34, 0.44] : th.runoff === 'arena' ? [1.0, 0.9, 0.78] : [0.92, 0.92, 0.95];
  const WHITE = [1, 1, 1], STEEL = [0.95, 0.97, 1.0];
  /** extruye un perfil [(du, h)] a lo largo de filas; du hacia fuera desde lat(o) */
  function extrude(rows, side, latFn, prof, band, period, tint, opts = {}) {
    // cada segmento del perfil es una tira con sus propios vértices (aristas vivas)
    for (let k = 0; k < prof.length - 1; k++) {
      const [d0, h0] = prof[k], [d1, h1] = prof[k + 1];
      const f0 = opts.vf ? opts.vf[k] : k / (prof.length - 1), f1 = opts.vf ? opts.vf[k + 1] : (k + 1) / (prof.length - 1);
      let prev = null;
      for (const r of rows) {
        const o = r.o, lat = latFn(o);
        const base = opts.baseFn ? opts.baseFn(o) : H(o, side * lat);
        const u0 = side * (lat + d0), u1 = side * (lat + d1);
        const hh0 = typeof h0 === 'function' ? h0(o, base) : h0, hh1 = typeof h1 === 'function' ? h1(o, base) : h1;
        const tc = typeof tint === 'function' ? tint(o) : tint;
        const a = bar.v(PX(o, u0), base + hh0, PZ(o, u0), { uv: [r.sc / period, V(band, f0)], color: tc });
        const b = bar.v(PX(o, u1), base + hh1, PZ(o, u1), { uv: [r.sc / period, V(band, f1)], color: tc });
        if (prev) bar.quad(prev[0], prev[1], a, b);
        prev = [a, b];
      }
    }
  }
  const box = (acc, cx, cy, cz, sx, sy, sz, yaw, band, tint) => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const P = (x, y, z) => [cx + x * c + z * s, cy + y, cz - x * s + z * c];
    const faces = [[[-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1]], [[1, -1, -1], [-1, -1, -1], [1, 1, -1], [-1, 1, -1]], [[1, -1, 1], [1, -1, -1], [1, 1, 1], [1, 1, -1]], [[-1, -1, -1], [-1, -1, 1], [-1, 1, -1], [-1, 1, 1]], [[-1, 1, 1], [1, 1, 1], [-1, 1, -1], [1, 1, -1]]];
    for (const f of faces) {
      const ids = f.map(([x, y, z], k) => { const q = P((x * sx) / 2, (y * sy) / 2, (z * sz) / 2); return acc.v(q[0], q[1], q[2], { uv: [k % 2, V(band, k < 2 ? 0 : 1)], color: tint }); });
      acc.idx.push(ids[0], ids[1], ids[2], ids[1], ids[3], ids[2]);
    }
  };
  // perfiles
  const P_WALL = [[0, -0.25], [0, 0.95], [0.05, 1.02], [0.5, 1.02], [0.55, 0.95], [0.55, -0.25]];
  const VF_WALL = [0, 0.94, 1, 1, 0.94, 0];
  const glowLine = (rows, side, latFn, h0, h1, rgb, du = -0.035) => {
    let prev = null;
    for (const r of rows) {
      const o = r.o, lat = latFn(o), base = H(o, side * lat), u = side * (lat + du);
      const a = glow.v(PX(o, u), base + h0, PZ(o, u), { color: rgb }), b = glow.v(PX(o, u), base + h1, PZ(o, u), { color: rgb });
      if (prev) glow.quad(prev[0], prev[1], a, b);
      prev = [a, b];
    }
  };
  const groundLine = (rows, side, d0, d1, rgb) => {
    let prev = null;
    for (const r of rows) {
      const o = r.o, u0 = side * (o.w + d0), u1 = side * (o.w + d1);
      const a = glow.v(PX(o, u0), H(o, u0) + 0.018, PZ(o, u0), { color: rgb }), b = glow.v(PX(o, u1), H(o, u1) + 0.018, PZ(o, u1), { color: rgb });
      if (prev) { if (side > 0) glow.quad(prev[0], prev[1], a, b); else glow.quad(prev[1], prev[0], b, a); }
      prev = [a, b];
    }
  };
  /** separa filas en tramos según una clave */
  const split = (rows, key) => { const out = []; let cur = null, ck = null; for (const r of rows) { const k = key(r); if (k !== ck) { if (cur && cur.length) { cur.push(r); out.push({ k: ck, rows: cur }); } cur = [r]; ck = k; } else cur.push(r); } if (cur && cur.length > 1) out.push({ k: ck, rows: cur }); return out; };
  const fencePosts = [];
  for (const side of [1, -1]) {
    const rows = side === sd ? rowsIn(p.s1, p.s0 + L) : rowsIn(0, L);
    const segs = split(rows, (r) => (inTunnel(r.o.s, 0.5) ? 't' : String(side > 0 ? r.o.baL : r.o.baR)));
    const glowRGB = lin(side > 0 ? glowA : glowB, 1.5 * glowK);
    for (const sg of segs) {
      if (sg.k === 't') continue;
      const kind = +sg.k, R = (o) => (side > 0 ? o.rL : o.rR);
      const lat = (o) => o.w + R(o);
      if (kind === 0 || kind === 1) {
        const off = kind === 1 ? 1.2 : 0;
        const latW = (o) => lat(o) + off;
        if (kind === 1) {
          // neumáticos con cinta transportadora delante del muro
          extrude(sg.rows, side, lat, [[0, 0.02], [0, 1.0]], 'belt', 8, WHITE);
          extrude(sg.rows, side, lat, [[0, 1.0], [1.15, 1.0]], 'tyres', 2.4, WHITE);
        }
        const hRet = (o, base) => (embAt(o.s) === 'wall' ? -base - 0.1 : -0.25);
        extrude(sg.rows, side, latW, [[0, -0.25], [0, 1.0], [0.5, 1.0], [0.5, hRet]], 'concrete', 4, WALL_TINT, { vf: [0, 0.97, 1, 0] });
        if (glowK >= 0.6 && kind === 0) glowLine(sg.rows, side, latW, 0.84, 0.92, glowRGB);
        if (glowK >= 0.6 && kind === 1) glowLine(sg.rows, side, lat, 0.94, 0.99, glowRGB);
        // valla: postes cada 4 m y malla
        if (Q.fence) {
          let prev = null;
          for (const r of sg.rows) {
            const o = r.o, u = side * (latW(o) + 0.3), base = H(o, side * latW(o));
            const a = fence.v(PX(o, u), base + 1.02, PZ(o, u), { uv: [r.sc / 0.9, 0] }), b = fence.v(PX(o, u), base + 3.7, PZ(o, u), { uv: [r.sc / 0.9, 3] });
            if (prev) fence.quad(prev[0], prev[1], a, b);
            prev = [a, b];
          }
          const s0 = sg.rows[0].sc, s1 = sg.rows[sg.rows.length - 1].sc;
          for (let s = Math.ceil(s0 / 5) * 5; s < s1; s += 5) fencePosts.push({ s, side, lat: latW(at(s)) + 0.3 });
        }
      } else {
        // guardarraíl doble sobre postes
        const W = [[0.1, 0.0], [0.0, 0.15], [0.1, 0.31]];
        for (const h of [0.42, 0.82]) extrude(sg.rows, side, lat, W.map(([d, hh]) => [d, h + hh]), 'armco', 4, STEEL);
        if (EMB === 'wall' || decks.length) extrude(sg.rows, side, lat, [[0.45, -0.1], [0.45, (o, base) => (embAt(o.s) === 'wall' ? -base - 0.1 : -0.1)]], 'concrete', 4, WALL_TINT);
        const s0 = sg.rows[0].sc, s1 = sg.rows[sg.rows.length - 1].sc;
        for (let s = Math.ceil(s0 / 4) * 4; s < s1; s += 4) { const o = at(s), l = lat(o) + 0.22, u = side * l; box(bar, PX(o, u), H(o, u) + 0.4, PZ(o, u), 0.12, 1.1, 0.16, Math.atan2(o.tx, o.tz), 'plain', [0.55, 0.57, 0.6]); }
        if (glowK >= 0.6) glowLine(sg.rows, side, lat, 1.14, 1.17, glowRGB, 0.06);
      }
    }
    // protecciones de neumáticos automáticas (escapatorias grandes, exterior de curva)
    const TB = side > 0 ? tyreBufL : tyreBufR;
    const segs2 = split(rows, (r) => { const o = r.o, Rr = side > 0 ? o.rL : o.rR, ba = side > 0 ? o.baL : o.baR; return TB[o.ii] && Rr > 9 && ba !== 1 && !inTunnel(o.s, 2) ? 'y' : 'n'; });
    for (const sg of segs2) {
      if (sg.k !== 'y' || sg.rows.length < 3) continue;
      const lat = (o) => o.w + (side > 0 ? o.rL : o.rR);
      extrude(sg.rows, side, lat, [[0, 0.02], [0, 0.98]], 'belt', 8, WHITE);
      extrude(sg.rows, side, lat, [[0, 0.98], [1.15, 0.98], [1.15, 0.02]], 'tyres', 2.4, WHITE, { vf: [0, 1, 1] });
    }
    // fin de tramos en la zona de boxes: tapas
  }
  // postes de valla (cajas finas)
  for (const fp of fencePosts) { const o = at(fp.s), u = fp.side * fp.lat, base = H(o, fp.side * (fp.lat - 0.3)); box(bar, PX(o, u), base + 2.35, PZ(o, u), 0.1, 2.7, 0.1, Math.atan2(o.tx, o.tz), 'plain', [0.42, 0.44, 0.48]); }

  mark('barriers');
  /* ======================= MURO DE BOXES */
  {
    const rows = pitRows.filter((r) => { const [a] = laneEdges(r.o); return a - r.o.w > 1.6; });
    const segs = split(rows, () => 'p');
    const latFn = (o) => { const [a] = laneEdges(o); return a - 0.65; };
    const pitTint = night ? [0.24, 0.22, 0.32] : [0.9, 0.9, 0.92];
    for (const sg of segs) {
      extrude(sg.rows, sd, latFn, [[0, -0.1], [0, 1.0], [0.06, 1.08], [0.5, 1.08], [0.56, 1.0], [0.56, -0.1]], 'concrete', 4, pitTint, { vf: VF_WALL });
      if (Q.fence) {
        let prev = null;
        for (const r of sg.rows) {
          const o = r.o, l = latFn(o) + 0.28, u = sd * l, base = H(o, u);
          const a = fence.v(PX(o, u), base + 1.08, PZ(o, u), { uv: [r.sc / 0.9, 0] }), b = fence.v(PX(o, u), base + 3.2, PZ(o, u), { uv: [r.sc / 0.9, 2.4] });
          if (prev) fence.quad(prev[0], prev[1], a, b);
          prev = [a, b];
        }
      }
      if (glowK > 0) { glowLine(sg.rows, sd, latFn, 0.92, 0.98, lin('#ffcc33', 0.9 * Math.max(0.5, glowK))); glowLine(sg.rows, sd, (o) => latFn(o) + 0.56, 0.92, 0.98, lin('#ffcc33', 0.7 * Math.max(0.5, glowK)), 0.035); }
      // cabezas del muro: atenuadores amarillos
      for (const r of [sg.rows[0], sg.rows[sg.rows.length - 1]]) { const o = r.o, l = latFn(o) + 0.28, u = sd * l; box(bar, PX(o, u), H(o, u) + 0.55, PZ(o, u), 0.9, 1.1, 1.6, Math.atan2(o.tx, o.tz), 'plain', [1.0, 0.75, 0.05]); }
    }
  }

  /* ======================= TÚNELES */
  for (const l of tunnels) {
    const rows = rowsIn(l.s0, l.s1);
    const Ht = 6.6, roof = 0.9;
    const latFn = (side) => (o) => o.w + (side > 0 ? o.rL : o.rR);
    if (glowK >= 0.6) for (const side of [1, -1]) glowLine(rows, side, (o) => latFn(side)(o) + 0.6, Ht + roof + 0.02, Ht + roof + 0.14, lin(side > 0 ? glowA : glowB, 1.3 * glowK), 0.02);
    const tTint = night ? [0.55, 0.55, 0.68] : [0.95, 0.93, 0.9];
    for (const side of [1, -1]) {
      extrude(rows, side, latFn(side), [[0, -0.2], [0, Ht]], 'tunnel', 6, tTint);
      extrude(rows, side, latFn(side), [[0.6, Ht + roof], [0.6, -0.2]], 'concrete', 4, WALL_TINT);
      if (glowK > 0) glowLine(rows, side, latFn(side), 0.25, 0.37, lin(side > 0 ? glowA : glowB, 1.4 * Math.max(0.6, glowK)));
    }
    // techo (cara inferior y superior)
    let pv = null, pt = null;
    for (const r of rows) {
      const o = r.o, uL = o.w + o.rL + 0.6, uR = -(o.w + o.rR + 0.6), yb = o.y + Ht;
      const ids = [uR, 0, uL].map((u, k) => bar.v(PX(o, u), yb, PZ(o, u), { uv: [r.sc / 6, V('plain', k / 2)], color: [0.16, 0.16, 0.2] }));
      const top = [uR, uL].map((u, k) => run.v(PX(o, u), yb + roof, PZ(o, u), { aRun: ROOF_W, aEdge: [Math.abs(u), r.sc, 0, 2], aExt: [0, 1] }));
      if (pv) { bar.quad(pv[2], pv[1], ids[2], ids[1]); bar.quad(pv[1], pv[0], ids[1], ids[0]); run.quad(pt[0], pt[1], top[0], top[1]); }
      pv = ids; pt = top;
    }
    // luces del techo
    for (const off of [-0.35, 0.35]) {
      let prev = null;
      for (const r of rows) {
        const o = r.o, u0 = off * o.w - 0.1, u1 = off * o.w + 0.1, y = o.y + Ht - 0.03;
        const c = night ? lin(off > 0 ? glowA : glowB, 1.15) : lin('#fff3d8', 1.5);
        const a = glow.v(PX(o, u0), y, PZ(o, u0), { color: c }), b = glow.v(PX(o, u1), y, PZ(o, u1), { color: c });
        if (prev) glow.quad(prev[1], prev[0], b, a);
        prev = [a, b];
      }
    }
    // portales (frente sobre la boca)
    for (const [r, dir] of [[rows[0], -1], [rows[rows.length - 1], 1]]) {
      const o = r.o, uL = o.w + o.rL + 0.6, uR = -(o.w + o.rR + 0.6), cx = o.x + o.nx * (uL + uR) / 2, cz = o.z + o.nz * (uL + uR) / 2;
      box(bar, cx + o.tx * dir * 0.3, o.y + Ht + roof / 2 + 0.6, cz + o.tz * dir * 0.3, uL - uR + 2, roof + 1.2, 0.8, Math.atan2(o.tx, o.tz), 'plain', night ? [0.18, 0.17, 0.24] : [0.85, 0.82, 0.78]);
      if (glowK > 0) box(glow, cx + o.tx * dir * 0.72, o.y + Ht + 0.12, cz + o.tz * dir * 0.72, uL - uR, 0.14, 0.05, Math.atan2(o.tx, o.tz), 'plain', lin(glowA, 3 * Math.max(0.6, glowK)));
    }
    // ocluyentes por tramos de ~20 m
    for (let k = 0; k < rows.length - 1;) {
      let j = k; const bb = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
      while (j < rows.length && rows[j].sc - rows[k].sc < 20) {
        const o = rows[j].o;
        for (const u of [o.w + o.rL + 0.6, -(o.w + o.rR + 0.6)]) { const x = PX(o, u), z = PZ(o, u); bb[0] = Math.min(bb[0], x); bb[2] = Math.min(bb[2], z); bb[3] = Math.max(bb[3], x); bb[5] = Math.max(bb[5], z); bb[1] = Math.min(bb[1], o.y - 0.2); bb[4] = Math.max(bb[4], o.y + Ht + roof); }
        j++;
      }
      occluders.push(bb);
      k = Math.max(k + 1, j - 1);
      if (j >= rows.length) break;
    }
  }

  /* ======================= PUENTES (cruces a distinto nivel) */
  for (const l of decks) {
    const rows = rowsIn(l.s0, l.s1);
    const depth = 1.4;
    let prev = null;
    for (const r of rows) {
      const o = r.o, uL = o.w + o.rL + 0.7, uR = -(o.w + o.rR + 0.7), y = o.y - depth;
      const ids = [uL, 0, uR].map((u, k) => bar.v(PX(o, u), y, PZ(o, u), { uv: [r.sc / 4, V('top', k / 2)], color: [0.5, 0.5, 0.55] }));
      if (prev) { bar.quad(prev[0], prev[1], ids[0], ids[1]); bar.quad(prev[1], prev[2], ids[1], ids[2]); }
      prev = ids;
    }
    for (const side of [1, -1]) extrude(rows, side, (o) => o.w + (side > 0 ? o.rL : o.rR) + 0.55, [[0, 1.0], [0, -depth - 0.1]], 'concrete', 4, WALL_TINT, { baseFn: (o) => o.y });
    // pilas a ambos lados del tramo inferior
    const ob = at(l.cross.sBottom), ot = at(l.cross.sTop);
    for (const side of [1, -1]) {
      const u = side * (ob.w + (side > 0 ? ob.rL : ob.rR) + 1.6);
      const x = PX(ob, u), z = PZ(ob, u), top = ot.y - depth, h = top - ob.y + 0.3;
      box(bar, x, ob.y - 0.3 + h / 2, z, 1.4, h, 4.5, Math.atan2(ot.tx, ot.tz), 'concrete', WALL_TINT);
    }
    const bb = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
    for (const r of rows) { const o = r.o; for (const u of [o.w + o.rL + 0.7, -(o.w + o.rR + 0.7)]) { const x = PX(o, u), z = PZ(o, u); bb[0] = Math.min(bb[0], x); bb[2] = Math.min(bb[2], z); bb[3] = Math.max(bb[3], x); bb[5] = Math.max(bb[5], z); bb[1] = Math.min(bb[1], o.y - depth); bb[4] = Math.max(bb[4], o.y + 1); } }
    occluders.push(bb);
  }

  /* ======================= BORDES LUMINOSOS (noche) */
  if (glowK >= 0.6) {
    for (const side of [1, -1]) {
      const rows = rowsIn(0, L).filter((r) => !(side === sd && pitF(r.o.s) > 0.02));
      for (const sg of split(rows, () => 'x')) groundLine(sg.rows, side, kOut + 0.14, kOut + 0.22, lin(side > 0 ? glowA : glowB, 0.9 * glowK));
    }
  }

  mark('special');
  /* ======================= ROTULOS PINTADOS */
  {
    let bi = 0;
    const flatDecal = (sMid, len, side, d0, d1, cell) => {
      const n = 8, sA = sMid - len / 2;
      let prev = null;
      for (let k = 0; k <= n; k++) {
        const s = sA + (len * k) / n, o = at(s);
        const f = k / n, uu = side > 0 ? f : 1 - f;
        const U0 = cell[0] + (cell[2] - cell[0]) * uu;
        const ua = side * (o.w + d0), ub = side * (o.w + d1);
        const a = decal.v(PX(o, ua), H(o, ua) + 0.02, PZ(o, ua), { uv: [U0, cell[1]] }), b = decal.v(PX(o, ub), H(o, ub) + 0.02, PZ(o, ub), { uv: [U0, cell[3]] });
        const pair = side > 0 ? [a, b] : [b, a];
        if (prev) decal.quad(prev[0], prev[1], pair[0], pair[1]);
        prev = pair;
      }
    };
    const wallDecal = (sMid, len, side, latFn, h0, h1, cell) => {
      const n = 8, sA = sMid - len / 2;
      let prev = null;
      for (let k = 0; k <= n; k++) {
        const s = sA + (len * k) / n, o = at(s), f = k / n, uu = side > 0 ? f : 1 - f;
        const U0 = cell[0] + (cell[2] - cell[0]) * uu, lat = latFn(o) - 0.025, u = side * lat, base = H(o, side * latFn(o));
        const a = decal.v(PX(o, u), base + h0, PZ(o, u), { uv: [U0, cell[1]] }), b = decal.v(PX(o, u), base + h1, PZ(o, u), { uv: [U0, cell[3]] });
        if (prev) decal.quad(prev[0], prev[1], a, b);
        prev = [a, b];
      }
    };
    // en las escapatorias de asfalto / hierba de las curvas
    for (const c of T.corners) {
      if (c.angle < 0.45) continue;
      const side = -c.dir, sMid = c.apex + Math.max(12, 0.6 * (c.s1 - c.apex)) + 6;
      const o = at(sMid), R = side > 0 ? o.rL : o.rR, kind = side > 0 ? o.roL : o.roR;
      if (R < 8 || (kind !== 0 && kind !== 2) || inTunnel(sMid, 20) || inPit(sMid)) continue;
      flatDecal(sMid, Math.min(16, R * 1.35), side, 5.0, 5.0 + Math.min(4, R * 0.32), LOGO_CELL(bi++ % BRANDS.length));
    }
    // en los muros de las rectas
    const step = 55 / Q.wallLogos;
    for (let s = 30; s < L - 20; s += step) {
      const side = Math.round(s / step) % 2 ? 1 : -1, o = at(s);
      if (Math.abs(o.k) > 1 / 300 || inTunnel(s, 12) || (side === sd && inSpan(s, p.s0 - 10, p.s1 + 10))) continue;
      const ba = side > 0 ? o.baL : o.baR; if (ba !== 0) continue;
      const lat = (q) => q.w + (side > 0 ? q.rL : q.rR);
      wallDecal(s, 7.2, side, lat, 0.16, 0.86, LOGO_CELL(bi++ % BRANDS.length));
    }
    // números de parrilla y nombre del circuito junto a la salida
    (T.grid || []).forEach((g, k) => {
      const lat = g.latM != null ? g.latM : g.lat * 7.8, s = g.s + 3.6, o = at(s);
      const n = 1, len = 1.3;
      // número tumbado mirando a los coches (lectura desde atrás)
      const cell = DIGIT_CELL(k);
      const corners = [[-0.65, -len / 2], [0.65, -len / 2], [-0.65, len / 2], [0.65, len / 2]];
      const ids = corners.map(([du, dsv], q) => { const oo = at(s + dsv), u = lat + du; return decal.v(PX(oo, u), H(oo, u) + 0.02, PZ(oo, u), { uv: [du > 0 ? cell[0] : cell[2], dsv < 0 ? cell[1] : cell[3]] }); });
      decal.quad(ids[1], ids[0], ids[3], ids[2]);
      void n;
    });
    // "PIT" a la entrada del carril
    {
      const s = p.s0 + p.ramp + 8, o = at(s), [a, b] = laneEdges(o), mid = (a + b) / 2;
      const cell = PIT_CELL, ids = [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]].map(([du, dsv]) => { const oo = at(s + dsv), u = sd * (mid + du * sd); return decal.v(PX(oo, u), H(oo, u) + 0.03, PZ(oo, u), { uv: [du * sd > 0 ? cell[0] : cell[2], dsv < 0 ? cell[1] : cell[3]] }); });
      decal.quad(ids[1], ids[0], ids[3], ids[2]);
    }
  }

  mark('decals');
  /* ======================= mallas */
  const meshes = [];
  const add = (acc, mat, name, o = {}) => {
    if (!acc.idx.length) return null;
    const m = new THREE.Mesh(acc.build(), mat); m.name = name;
    m.matrixAutoUpdate = false; m.updateMatrix();
    if (o.receive) m.receiveShadow = tier !== 'low';
    if (o.cast) m.castShadow = Q.shadow;
    if (o.order != null) m.renderOrder = o.order;
    group.add(m); meshes.push(m); return m;
  };
  add(run, runMat, 'pista-escapatorias', { receive: true });
  add(road, roadMat, 'pista-asfalto', { receive: true });
  add(kerb, kerbMat, 'pista-pianos', { receive: true });
  add(bar, barMat, 'pista-barreras', { receive: true, cast: true });
  if (fenceMat) add(fence, fenceMat, 'pista-vallas');
  add(glow, glowMat, 'pista-neones');
  add(decal, decalMat, 'pista-rotulos', { receive: true, order: 1 });
  if (scene) scene.add(group);

  mark('meshes');
  let tris = 0, verts = 0;
  const perMesh = {};
  for (const m of meshes) { tris += m.geometry.index.count / 3; verts += m.geometry.attributes.position.count; perMesh[m.name.replace('pista-', '')] = m.geometry.index.count / 3; }
  const stats = { drawCalls: meshes.length, tris: Math.round(tris), verts, meshes: perMesh, textures: owned.filter((o) => o.isTexture).length + sharedKeys.length, rows: ROWS.length, embankment: EMB, ms: PROF };
  let wet = 0;
  function setWet(v) {
    wet = clamp(+v || 0, 0, 1);
    U.uWet.value = wet;
    roadMat.envMapIntensity = (0.35 + 0.45 * wet) * envI;
    runMat.envMapIntensity = (0.25 + 0.6 * wet) * envI;
    kerbMat.roughness = 0.58 - 0.42 * wet; kerbMat.color.setScalar(1 - 0.3 * wet);
    barMat.roughness = 0.78 - 0.3 * wet;
    decalMat.roughness = 0.55 - 0.4 * wet; decalMat.color.setScalar(1 - 0.25 * wet);
  }
  function update(dt, t) { U.uTime.value = t || 0; }
  function dispose() {
    if (group.parent) group.parent.remove(group);
    for (const m of meshes) m.geometry.dispose();
    for (const o of owned) o.dispose();
    for (const k of sharedKeys) release(k);
    sharedKeys.length = 0;
  }
  return { group, occluders, setWet, update, dispose, stats, uniforms: U };
}
