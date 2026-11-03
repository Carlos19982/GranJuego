/* =====================================================================
   garaje.js — Showroom cinematográfico (Gran Premio Neón v3, agente GARAJE)
   Escena y cámara propias: plató oscuro con suelo reflectante (reflejo
   planar difuminado), rig de luces que se tiñe con los colores de cada
   coche, conos volumétricos, holograma con el dorsal, efecto firma por
   coche y ambientación por circuito (neón / desierto / puerto).
   API: createShowroom({ renderer, tier, cars, makeCar }) → {
     scene, camera, setCircuit, showCar, update, resize, intro, outro, dispose, … }
   ===================================================================== */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const TAU = Math.PI * 2;
const R_W = 26; // radio de la pared virtual del plató (m)
const H_C = 15; // altura del techo virtual (m)
const HERO_YAW = -0.62; // morro hacia la izquierda de cámara (vista 3/4 frontal)
const D0 = 9.6, H0 = 1.22, TY = 0.62; // cámara en reposo: distancia, altura, altura del objetivo
const MOOD_IDS = ['neon', 'desierto', 'puerto'];
const FONT = '"Bungee", "Outfit", "Inter", "Arial Black", system-ui, sans-serif';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sat = (x) => clamp(x, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (x) => { x = sat(x); return x * x * (3 - 2 * x); };
const easeOut = (x, p = 3) => 1 - Math.pow(1 - sat(x), p);
const easeIn = (x, p = 2) => Math.pow(sat(x), p);
const easeInOut = (x) => { x = sat(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const damp = (k, dt) => 1 - Math.exp(-k * dt);
const pol = (r, phi) => [r * Math.sin(phi), -r * Math.cos(phi)]; // phi = 0 → detrás del coche (−Z)

/* ---------------- Paletas y efectos por coche ---------------- */
const PALETTES = {
  REL: ['#22e4ff', '#e2fbff', '#2f63ff'],
  FEN: ['#ff4a2e', '#ffcc33', '#ff8a1a'],
  VIB: ['#2bff88', '#d2ff4a', '#00c9a7'],
  PAN: ['#ff2fb3', '#ffffff', '#8f3bff'],
  COM: ['#ffcc33', '#ff6a2b', '#ff3d9a'],
  TIF: ['#8b5cff', '#22e4ff', '#e05cff'],
};
const FX_BY_CODE = { REL: 0, FEN: 1, VIB: 2, PAN: 3, COM: 4, TIF: 5 };
// 0 arcos eléctricos · 1 brasas/fuego · 2 niebla verde · 3 láseres · 4 retro (rejilla, estelas, scanlines) · 5 torbellino
const FX_LIGHT = [3.0, 2.2, 0.9, 1.6, 0.8, 1.2];

/* ---------------- Ambientaciones por circuito ---------------- */
const SUN_DIR = new THREE.Vector3(Math.sin(-0.5) * Math.cos(0.16), Math.sin(0.16), -Math.cos(-0.5) * Math.cos(0.16)).normalize(); // hacia el sol (desierto)
const MOODS = [
  { id: 'neon', key: [0.86, 0.8, 1.0], keyI: 1.6, keyPos: [2, 10, 6], hemiS: [0.34, 0.2, 0.62], hemiG: [0.03, 0.01, 0.05], hemiI: 0.75, top: 1.0,
    haze: [0.55, 0.22, 0.85], dust: [0.75, 0.6, 1.0], mist: [0.4, 0.18, 0.7], amb: [0.05, 0.04, 0.09], cone: 1.0, exposure: 1.0,
    bloom: { strength: 0.55, radius: 0.35, threshold: 1.0 }, envHor: [0.6, 0.12, 0.7], envSky: [0.03, 0.01, 0.06], envFloor: [0.02, 0.01, 0.03], refl: 1.0 },
  { id: 'desierto', key: [1.0, 0.58, 0.28], keyI: 3.4, keyPos: [SUN_DIR.x * 20, SUN_DIR.y * 20 + 2, SUN_DIR.z * 20], hemiS: [0.62, 0.38, 0.26], hemiG: [0.14, 0.07, 0.035], hemiI: 0.8, top: 0.75,
    haze: [1.0, 0.55, 0.22], dust: [1.0, 0.7, 0.4], mist: [0.65, 0.36, 0.16], amb: [0.11, 0.07, 0.045], cone: 0.55, exposure: 1.02,
    bloom: { strength: 0.5, radius: 0.38, threshold: 1.05 }, envHor: [1.4, 0.6, 0.22], envSky: [0.2, 0.12, 0.2], envFloor: [0.12, 0.07, 0.04], refl: 0.75 },
  { id: 'puerto', key: [0.62, 0.76, 1.0], keyI: 1.5, keyPos: [-3, 10, 5], hemiS: [0.2, 0.34, 0.6], hemiG: [0.02, 0.04, 0.07], hemiI: 0.85, top: 0.9,
    haze: [0.25, 0.45, 0.85], dust: [0.6, 0.8, 1.0], mist: [0.2, 0.38, 0.6], amb: [0.04, 0.06, 0.1], cone: 0.8, exposure: 1.0,
    bloom: { strength: 0.55, radius: 0.35, threshold: 1.0 }, envHor: [0.35, 0.35, 0.65], envSky: [0.03, 0.08, 0.22], envFloor: [0.01, 0.025, 0.05], refl: 0.95 },
];

/* =====================================================================
   GLSL
   ===================================================================== */
const G_COMMON = /* glsl */ `
#define TAU 6.28318530718
#define RW ${R_W.toFixed(1)}
#define HC ${H_C.toFixed(1)}
float sm(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float n21(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y); }
float fbm3(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { s += a * n21(p); p = p * 2.07 + vec2(3.1, 7.7); a *= 0.5; } return s; }
float caus(vec2 q, float t) {
  vec2 p = q - 250.0; vec2 i = p; float c = 1.0;
  for (int n = 0; n < 3; n++) {
    float tt = t * (1.0 - 3.5 / float(n + 1));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) * 200.0 + 1e-3), p.y / (cos(i.y + tt) * 200.0 + 1e-3)));
  }
  c /= 3.0; c = 1.17 - pow(c, 1.4);
  return clamp(pow(abs(c), 7.0), 0.0, 4.0);
}
`;

const V_WORLD = /* glsl */ `
varying vec3 vW;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }
`;
const F_TAIL = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

/* ---------- Fondo: pared/techo virtuales + exterior por ambientación ---------- */
const F_BACKDROP = /* glsl */ `
${G_COMMON}
uniform float uTime, uBgPower, uScan, uScanOn, uSweep, uSweepDir;
uniform int uMA, uMB;
uniform vec3 uPO[4]; uniform vec3 uPN[4];
uniform vec3 uSunS;
varying vec3 vW;

vec3 outNeon(vec3 rd) {
  float az = atan(rd.x, -rd.z);
  float el = rd.y / max(length(rd.xz), 1e-3);
  vec3 col = mix(vec3(0.16, 0.03, 0.2), vec3(0.012, 0.006, 0.03), sm(-0.05, 0.45, el));
  col += vec3(1.0, 0.2, 0.7) * 0.45 * exp(-abs(el - 0.02) * 14.0);
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float wdt = 0.045 + fk * 0.03;
    float x = az / wdt + fk * 13.7;
    float id = floor(x), fx = fract(x);
    float hh = h11(id * 1.37 + fk * 7.1);
    float top = (0.05 + 0.34 * hh * hh) * (1.0 - fk * 0.28);
    if (el < top && fx > 0.07 && fx < 0.95) {
      vec3 bc = vec3(0.01, 0.006, 0.02) * (1.0 + fk);
      vec2 wp = vec2(fx * (5.0 + fk * 2.0), el * (110.0 - fk * 25.0));
      vec2 wi = floor(wp), wf = fract(wp);
      float lit = step(0.6, h21(wi + id * 7.3 + fk * 3.1));
      float win = step(0.25, wf.x) * step(wf.x, 0.75) * step(0.3, wf.y) * step(wf.y, 0.75);
      vec3 wc = mix(vec3(1.0, 0.62, 0.3), vec3(0.35, 0.7, 1.0), h11(id + wi.y * 0.37));
      bc += wc * lit * win * (0.16 + 0.22 * fk);
      float sid = h11(id * 3.71 + fk);
      float sy = top - 0.03 - fk * 0.01;
      if (sid > 0.6 && abs(el - sy) < 0.011 && fx > 0.18 && fx < 0.82) bc = sid > 0.8 ? vec3(2.4, 0.25, 1.5) : vec3(0.25, 1.6, 2.4);
      col = bc;
    }
  }
  col += vec3(0.25, 0.04, 0.2) * exp(-max(el, 0.0) * 6.0) * 0.35;
  return col;
}
vec3 wallNeon(vec3 pw, float u, vec3 rd, bool ceil, vec3 c0) {
  if (ceil) {
    vec2 g = abs(fract(pw.xz / 5.0) - 0.5);
    float ln = sm(0.46, 0.5, max(g.x, g.y));
    return vec3(0.008, 0.006, 0.016) + vec3(0.5, 0.15, 0.8) * ln * 0.12;
  }
  float y = pw.y;
  vec3 col;
  if (y < 1.3) {
    col = vec3(0.016, 0.012, 0.028) * (0.5 + 0.5 * sm(0.0, 1.3, y));
    col += c0 * 2.4 * exp(-abs(y - 1.2) * 40.0);
    col += vec3(1.0, 0.12, 0.65) * 0.5 * exp(-abs(y - 0.06) * 22.0);
  } else if (y < 11.4) {
    col = outNeon(rd) * vec3(0.42, 0.38, 0.5) + vec3(0.008, 0.005, 0.016);
    col += vec3(0.06, 0.04, 0.11) * sm(0.9, 1.0, fract(u * 0.061 - y * 0.03));
    float pu = u / 3.4;
    float dm = (0.5 - abs(fract(pu) - 0.5)) * 3.4;
    float frame = max(1.0 - sm(0.1, 0.14, dm), 1.0 - sm(0.06, 0.1, abs(y - 6.4)));
    col = mix(col, vec3(0.013, 0.01, 0.022), frame);
    float mid = floor(pu + 0.5);
    float hm = h11(mid * 5.31 + 0.7);
    if (hm > 0.45) {
      vec3 nc = hm > 0.74 ? vec3(2.6, 0.28, 1.6) : vec3(0.28, 1.7, 2.7);
      float fl = hm > 0.92 ? step(0.3, h11(floor(uTime * 11.0) + mid)) : 1.0;
      col += nc * fl * (exp(-dm * dm * 500.0) + 0.1 * exp(-dm * 2.5)) * sm(1.3, 1.7, y) * sm(11.4, 11.0, y);
    }
  } else {
    col = vec3(0.012, 0.009, 0.02);
    col += vec3(0.85, 0.2, 1.0) * 0.9 * exp(-abs(y - 11.6) * 30.0);
    col += vec3(0.25, 1.3, 2.2) * 0.6 * step(0.72, h11(floor(u * 0.9))) * exp(-abs(y - 12.5) * 14.0);
  }
  return col;
}
vec3 outDesert(vec3 rd) {
  float az = atan(rd.x, -rd.z);
  float el = rd.y / max(length(rd.xz), 1e-3);
  float sa = atan(uSunS.x, -uSunS.z), se = uSunS.y / max(length(uSunS.xz), 1e-3);
  float da = az - sa;
  float glow = exp(-abs(da) * 1.4);
  vec3 hor = mix(vec3(0.62, 0.22, 0.09), vec3(1.35, 0.62, 0.24), glow);
  vec3 mid = mix(vec3(0.22, 0.07, 0.1), vec3(0.55, 0.22, 0.1), glow);
  vec3 col = mix(hor, mid, sm(0.0, 0.12, el));
  col = mix(col, vec3(0.04, 0.03, 0.09), sm(0.1, 0.5, el));
  float cl = fbm3(vec2(az * 5.0 + uTime * 0.004, el * 36.0));
  col += vec3(1.1, 0.48, 0.25) * sm(0.55, 0.78, cl) * sm(0.03, 0.08, el) * (1.0 - sm(0.16, 0.3, el)) * (0.25 + glow) * 0.8;
  float sd = length(vec2(da, el - se));
  col += vec3(5.0, 3.0, 1.3) * (1.0 - sm(0.024, 0.03, sd)) + vec3(1.8, 0.8, 0.28) * exp(-sd * 9.0) * 0.8;
  float mesa = 0.085 * sm(0.36, 0.38, az) * (1.0 - sm(0.6, 0.63, az)) + 0.05 * sm(0.62, 0.64, az) * (1.0 - sm(0.72, 0.75, az));
  float d0 = max(0.05 + 0.018 * sin(az * 4.0 + 1.0), mesa + 0.03);
  if (el < d0) { col = mix(col * 0.55, vec3(0.16, 0.06, 0.07), 0.7); col += vec3(0.9, 0.35, 0.12) * exp(-(d0 - el) * 300.0) * (0.15 + glow); }
  float d1 = 0.04 + 0.022 * sin(az * 3.1 + 0.6) + 0.01 * sin(az * 7.7 + 2.0) + 0.004 * sin(az * 19.0);
  float d2 = 0.012 + 0.016 * sin(az * 2.2 + 3.1) + 0.007 * sin(az * 5.3 + 1.0);
  if (el < d1) {
    col = mix(vec3(0.09, 0.03, 0.016), vec3(0.34, 0.13, 0.05) * (0.45 + glow), sm(d1 - 0.035, d1, el));
    col += vec3(1.3, 0.55, 0.18) * exp(-(d1 - el) * 260.0) * (0.15 + glow);
  }
  if (el < d2) {
    col = mix(vec3(0.035, 0.012, 0.008), vec3(0.16, 0.06, 0.025) * (0.6 + glow), sm(d2 - 0.04, d2, el));
    col += vec3(1.1, 0.45, 0.15) * exp(-(d2 - el) * 300.0) * (0.2 + glow);
  }
  col += vec3(0.7, 0.32, 0.12) * exp(-abs(el) * 26.0) * 0.1;
  return col;
}
vec3 wallDesert(vec3 pw, float u, float ang, vec3 rd, bool ceil) {
  if (ceil) {
    float cor = 0.5 + 0.5 * sin(pw.x * 22.0);
    vec3 c = mix(vec3(0.03, 0.018, 0.011), vec3(0.055, 0.032, 0.02), cor);
    return c * (0.6 + 0.4 * step(0.08, fract(pw.z / 4.0)));
  }
  float y = pw.y;
  float cor = 0.5 + 0.5 * sin(u * 34.9);
  vec3 col = mix(vec3(0.035, 0.02, 0.011), vec3(0.075, 0.042, 0.024), cor);
  col *= 0.45 + 0.55 * sm(0.0, 7.0, y);
  col *= 0.82 + 0.18 * step(0.035, fract(y / 2.4));
  col += vec3(0.35, 0.15, 0.05) * 0.3 * exp(-abs(ang + 0.5) * 1.5) * (1.0 - sm(0.0, 12.0, y));
  if (ang > 0.1 && ang < 0.9 && y < 8.8) {
    float e = min(min(ang - 0.1, 0.9 - ang) * RW, 8.8 - y);
    col = mix(vec3(0.02, 0.011, 0.006), outDesert(rd) * vec3(0.72, 0.66, 0.7), sm(0.14, 0.45, e));
  }
  if (ang > -0.9 && ang < -0.1 && y > 0.35 && y < 7.8) {
    float e = min(min(ang + 0.9, -0.1 - ang) * RW, min(y - 0.35, 7.8 - y));
    float su = fract(u / 0.8);
    float d = abs(su - 0.5);
    float g = 1.0 - sm(0.045, 0.075, d);
    vec3 o = outDesert(rd) * 1.1 + vec3(0.9, 0.38, 0.1);
    vec3 slat = vec3(0.03, 0.017, 0.01) * (0.7 + 0.3 * sin(y * 3.0));
    vec3 sc = mix(slat, o, g);
    sc += vec3(1.2, 0.45, 0.12) * 0.22 * exp(-max(d - 0.06, 0.0) * 30.0) * (1.0 - g);
    col = mix(col, sc, sm(0.05, 0.25, e));
  }
  return col;
}
vec3 outPuerto(vec3 rd) {
  float az = atan(rd.x, -rd.z);
  float el = rd.y / max(length(rd.xz), 1e-3);
  float e = max(el, 0.0);
  vec3 col = mix(vec3(0.42, 0.19, 0.2), vec3(0.15, 0.15, 0.32), sm(0.0, 0.03, e));
  col = mix(col, vec3(0.025, 0.06, 0.18), sm(0.02, 0.17, e));
  col = mix(col, vec3(0.004, 0.01, 0.045), sm(0.15, 0.6, e));
  float st = step(0.996, h21(floor(vec2(az, e) * 160.0))) * sm(0.12, 0.35, e);
  col += vec3(0.7, 0.8, 1.0) * st * 0.7;
  float x = az / 0.016;
  float id = floor(x), fx = fract(x);
  float bh = 0.006 + 0.03 * pow(h11(id * 0.71 + 3.0), 3.0) * (0.3 + 0.7 * exp(-abs(az - 0.25) * 1.2));
  if (el > 0.0 && el < bh) {
    col = vec3(0.012, 0.018, 0.04);
    vec2 wp = vec2(fx * 4.0, el * 380.0);
    float lit = step(0.6, h21(floor(wp) + id * 3.1)) * step(0.3, fract(wp.x)) * step(0.35, fract(wp.y));
    col += mix(vec3(1.4, 0.85, 0.4), vec3(0.7, 0.9, 1.4), h11(id)) * lit * 0.35;
  }
  float lx = az / 0.0055; float lid = floor(lx), lf = fract(lx);
  float lon = step(0.45, h11(lid * 1.93));
  vec3 lc = mix(vec3(1.6, 0.9, 0.4), vec3(0.8, 1.0, 1.6), step(0.75, h11(lid * 7.1)));
  col += lc * lon * exp(-pow((lf - 0.5) * 3.0, 2.0)) * exp(-pow(el / 0.0016, 2.0)) * 1.2;
  float la = -0.95;
  float lb = exp(-pow((az - la) * 300.0, 2.0) - pow((el - 0.02) * 300.0, 2.0));
  float beam = pow(max(0.0, cos(uTime * 1.2)), 30.0);
  col += vec3(2.5, 2.2, 1.6) * lb * (0.4 + beam * 2.0);
  col += vec3(0.4, 0.38, 0.3) * beam * exp(-abs(el - 0.02) * 60.0) * exp(-abs(az - la) * 2.0) * 0.6;
  if (el < 0.0) {
    float d = -el;
    float rip = n21(vec2(az * 260.0, d * 90.0 - uTime * 1.2)) * 0.6 + n21(vec2(az * 600.0, d * 240.0 + uTime * 0.7)) * 0.4;
    vec3 sky = mix(vec3(0.42, 0.19, 0.2), vec3(0.15, 0.15, 0.32), sm(0.0, 0.03, d));
    sky = mix(sky, vec3(0.025, 0.06, 0.18), sm(0.02, 0.17, d));
    col = vec3(0.006, 0.014, 0.03) + sky * 0.28 * (0.6 + 0.6 * rip);
    float streak = lon * exp(-pow((lf - 0.5) * 2.2, 2.0)) * exp(-d * 18.0) * sm(0.45, 0.8, rip);
    col += lc * streak * 0.9;
    col += vec3(2.0, 1.8, 1.3) * exp(-pow((az - la) * 120.0, 2.0)) * exp(-d * 30.0) * sm(0.5, 0.8, rip) * (0.3 + beam);
  }
  return col;
}
vec3 wallPuerto(vec3 pw, float u, float ang, vec3 rd, bool ceil) {
  if (ceil) {
    float c = caus(pw.xz * 0.35, uTime * 0.5);
    return vec3(0.03, 0.045, 0.075) + vec3(0.2, 0.45, 0.65) * c * 0.3;
  }
  float y = pw.y;
  vec3 col;
  if (y > 9.2) {
    float c = caus(vec2(u * 0.4, y * 0.5), uTime * 0.5);
    col = vec3(0.05, 0.07, 0.11) + vec3(0.25, 0.55, 0.75) * c * 0.5;
    col += vec3(1.6, 1.0, 0.5) * exp(-abs(y - 9.3) * 22.0) * 0.8;
  } else {
    col = outPuerto(rd);
    if (y < 1.0) {
      col = col * 0.75 + vec3(0.01, 0.02, 0.03);
      col += vec3(0.8, 0.9, 1.1) * 0.35 * exp(-abs(y - 1.0) * 40.0);
      float post = 1.0 - sm(0.03, 0.06, (0.5 - abs(fract(u / 1.6) - 0.5)) * 1.6);
      col = mix(col, vec3(0.1, 0.12, 0.16), post * 0.8);
    }
  }
  return col;
}
vec3 moodWall(int m, vec3 pw, float u, float ang, vec3 rd, bool ceil, vec3 c0) {
  if (m == 0) return wallNeon(pw, u, rd, ceil, c0);
  if (m == 1) return wallDesert(pw, u, ang, rd, ceil);
  return wallPuerto(pw, u, ang, rd, ceil);
}
void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vW - ro);
  float a = max(dot(rd.xz, rd.xz), 1e-6);
  float b = dot(ro.xz, rd.xz);
  float c = dot(ro.xz, ro.xz) - RW * RW;
  float tW = (-b + sqrt(max(b * b - a * c, 0.0))) / a;
  float tC = rd.y > 1e-4 ? (HC - ro.y) / rd.y : 1e9;
  bool ceil = tC < tW;
  vec3 pw = ro + rd * (ceil ? tC : tW);
  pw.y = max(pw.y, 0.0);
  float ang = atan(pw.x, -pw.z);
  float u = ang * RW;
  float ord = clamp(pw.x / 22.0 + 0.5, 0.0, 1.0);
  float o = uSweepDir > 0.0 ? 1.0 - ord : ord;
  vec3 c0 = mix(uPO[0], uPN[0], clamp((uSweep - o) / 0.08 + 0.5, 0.0, 1.0));
  float k = 1.0;
  float ys = (uScan - 0.55) / 0.45 * (HC + 3.0);
  if (uScanOn > 0.5) k = ceil ? sm(HC, HC + 3.0, ys) : 1.0 - sm(ys - 0.25, ys + 0.25, pw.y);
  vec3 col = vec3(0.0);
  if (k < 0.999) col = moodWall(uMA, pw, u, ang, rd, ceil, c0);
  if (k > 0.001) col = mix(col, moodWall(uMB, pw, u, ang, rd, ceil, c0), k);
  if (uScanOn > 0.5 && !ceil) col += mix(c0, vec3(1.0), 0.4) * 2.5 * exp(-abs(pw.y - ys) * 5.0) * step(-0.5, ys);
  gl_FragColor = vec4(col * uBgPower, 1.0);
  ${F_TAIL}
}
`;

/* ---------- Suelo reflectante ---------- */
const V_FLOOR = /* glsl */ `
uniform mat4 uTexMat;
varying vec3 vW; varying vec4 vR;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vR = uTexMat * vec4(position, 1.0); gl_Position = projectionMatrix * viewMatrix * w; }
`;
const F_FLOOR = /* glsl */ `
${G_COMMON}
uniform sampler2D tRefl, tRing, tReflD;
uniform vec2 uReflTexel;
uniform mat4 uReflInv; uniform vec3 uReflCam;
uniform float uTime, uPower, uScan, uScanOn, uTT, uRingRot, uHead, uGrid, uSweep, uSweepDir, uSweepOn, uStrip, uReflK, uLod, uHeat, uPoolK;
uniform int uMA, uMB;
uniform vec3 uPO[4]; uniform vec3 uPN[4];
uniform vec4 uCar, uCarDim, uImp; uniform vec2 uCarAx;
uniform vec3 uSunS;
varying vec3 vW; varying vec4 vR;

vec3 sunStripes(vec2 p) {
  vec3 ro = vec3(p.x, 0.0, p.y);
  vec3 rd = uSunS;
  float a = max(dot(rd.xz, rd.xz), 1e-5), b = dot(ro.xz, rd.xz), c = dot(ro.xz, ro.xz) - RW * RW;
  float t = (-b + sqrt(max(b * b - a * c, 0.0))) / a;
  vec3 h = ro + rd * t;
  float ang = atan(h.x, -h.z);
  float inWall = sm(-0.9, -0.84, ang) * (1.0 - sm(-0.16, -0.1, ang)) * sm(0.35, 0.6, h.y) * (1.0 - sm(7.5, 7.8, h.y));
  float su = fract(ang * RW / 0.8);
  float g = 1.0 - sm(0.05, 0.11, abs(su - 0.5));
  return vec3(1.7, 0.85, 0.36) * g * inWall;
}
void floorMood(int m, vec2 p, float r, vec2 fwp, inout vec3 base, inout float refl, inout float rough, inout vec3 emis, inout float wd) {
  if (m == 0) {
    base = vec3(0.011, 0.009, 0.017);
    vec2 tp = p / 2.0;
    vec2 tl = 1.0 - smoothstep(vec2(0.0), fwp * 0.75 + 0.004, abs(fract(tp + 0.5) - 0.5));
    float seam = max(tl.x, tl.y);
    base *= 1.0 - seam * 0.6;
    refl = 0.85; rough = 0.2;
    emis += vec3(0.1, 0.5, 0.9) * seam * 0.05 * (1.0 - sm(6.0, 16.0, r));
    base *= 1.0 - 0.6 * sm(RW - 6.0, RW, r);
  } else if (m == 1) {
    float n = fbm3(p * 0.33);
    base = mix(vec3(0.05, 0.034, 0.024), vec3(0.1, 0.068, 0.045), n);
    float dust = sm(0.5, 0.78, fbm3(p * 0.8 + 7.0)) * sm(5.0, 15.0, r);
    base = mix(base, vec3(0.12, 0.075, 0.045), dust * 0.55);
    refl = 0.62 * (1.0 - dust * 0.6); rough = 0.5;
    emis += sunStripes(p) * (0.2 + 0.25 * dust) * (1.0 - sm(9.0, 16.0, r) * 0.6);
    base *= 1.0 - 0.5 * sm(RW - 6.0, RW, r);
  } else {
    float n = fbm3(p * 0.5);
    base = mix(vec3(0.009, 0.016, 0.028), vec3(0.018, 0.028, 0.042), n);
    refl = 0.85; rough = 0.28;
    float c = caus(p * 0.4, uTime * 0.55);
    emis += vec3(0.15, 0.45, 0.7) * c * 0.14 * (0.35 + 0.65 * sm(3.0, 14.0, r));
    float wr = sm(19.3, 19.5, r);
    if (wr > 0.0) {
      float rip = n21(p * 1.6 + vec2(uTime * 0.4, uTime * 0.25)) + n21(p * 3.7 - uTime * 0.6) * 0.5;
      base = mix(base, vec3(0.004, 0.012, 0.022), wr);
      refl = mix(refl, 1.0, wr); rough = mix(rough, 0.1, wr);
      wd += (rip - 0.75) * 0.03 * wr;
      emis += vec3(0.1, 0.3, 0.45) * caus(p * 0.25, uTime * 0.7) * 0.2 * wr;
    }
    emis += vec3(1.5, 0.85, 0.42) * exp(-pow((r - 19.3) / 0.035, 2.0)) * 0.9;
  }
}
void main() {
  vec2 p = vW.xz;
  float r = length(p);
  vec2 fwp = fwidth(p);
  vec3 V = normalize(cameraPosition - vW);
  float ord = clamp(p.x / 22.0 + 0.5, 0.0, 1.0);
  float o = uSweepDir > 0.0 ? 1.0 - ord : ord;
  float sk = clamp((uSweep - o) / 0.08 + 0.5, 0.0, 1.0);
  vec3 c0 = mix(uPO[0], uPN[0], sk), c1 = mix(uPO[1], uPN[1], sk), c2 = mix(uPO[2], uPN[2], sk), ck = mix(uPO[3], uPN[3], sk);
  float sEdge = uSweepOn * exp(-pow((uSweep - o) / 0.03, 2.0));

  float k = 1.0, rs = uScan * 1.7 * RW;
  if (uScanOn > 0.5) k = 1.0 - sm(rs - 0.5, rs + 0.5, r);
  vec3 base = vec3(0.0), emis = vec3(0.0); float refl = 0.0, rough = 0.0, wd = 0.0;
  if (k < 0.999) floorMood(uMA, p, r, fwp, base, refl, rough, emis, wd);
  if (k > 0.001) {
    vec3 b2 = vec3(0.0), e2 = vec3(0.0); float rf2 = 0.0, rg2 = 0.0, wd2 = 0.0;
    floorMood(uMB, p, r, fwp, b2, rf2, rg2, e2, wd2);
    base = mix(base, b2, k); emis = mix(emis, e2, k); refl = mix(refl, rf2, k); rough = mix(rough, rg2, k); wd = mix(wd, wd2, k);
  }
  float strip = uStrip;
  // plataforma giratoria enrasada
  float disc = 1.0 - sm(3.24, 3.28, r);
  if (disc > 0.0) {
    float ca = cos(uTT), sa = sin(uTT);
    vec2 pr = vec2(ca * p.x - sa * p.y, sa * p.x + ca * p.y);
    float aa = atan(pr.x, -pr.y);
    float seg = (0.5 - abs(fract(aa / TAU * 16.0) - 0.5)) * TAU / 16.0 * r;
    float lines = (1.0 - sm(0.0, 0.012 + fwp.x * 1.5, seg)) * sm(0.6, 0.9, r);
    vec3 dc = vec3(0.016, 0.016, 0.022) * (0.9 + 0.1 * sin(r * 80.0));
    base = mix(base, dc, disc);
    refl = mix(refl, 0.8, disc); rough = mix(rough, 0.3, disc);
    emis += c0 * lines * 0.07 * disc;
    emis += c1 * 0.6 * exp(-pow((r - 1.15) / 0.02, 2.0)) * disc * strip;
  }
  emis += c0 * 3.2 * exp(-pow((r - 3.29) / 0.025, 2.0)) * strip;
  emis += c0 * 0.3 * exp(-abs(r - 3.29) * 3.0) * strip;
  emis += c1 * 1.4 * exp(-pow((r - 3.72) / 0.014, 2.0)) * strip;
  if (r > 3.84 && r < 4.3) {
    float ra = atan(p.x, -p.y);
    vec2 tuv = vec2(fract(-ra / TAU * 5.0 + uRingRot), 1.0 - (r - 3.84) / 0.46);
    float tr = textureLod(tRing, tuv, 0.0).r;
    emis += mix(c0, vec3(1.0), 0.25) * tr * 1.25 * strip;
  }
  // tiras radiales (apuntan a las columnas de luz)
  {
    float ra = atan(p.x, -p.y);
    float sec = TAU / 12.0;
    float ai = floor((ra - sec * 0.5) / sec + 0.5);
    float dA = abs((ra - sec * 0.5) / sec - ai) * sec * r;
    float sOn = 1.0 - sm(strip * 13.0 - 1.0, strip * 13.0, r);
    float st = exp(-dA * dA / (0.0009 + fwp.x * fwp.x * 2.0)) * sm(4.6, 5.0, r) * (1.0 - sm(9.4, 10.0, r));
    float chase = 0.3 + 0.7 * pow(0.5 + 0.5 * sin(r * 1.25 - uTime * 4.5 + ai * 1.7), 6.0);
    vec3 scol = mod(ai, 2.0) < 0.5 ? c0 : c1;
    emis += scol * st * chase * 2.4 * sOn;
  }
  // charcos de luz de los focos
  vec2 pa = p - vec2(-3.2, -2.6), pb = p - vec2(3.2, -2.6);
  vec3 pools = (ck * exp(-r * r / 9.0) + c0 * exp(-dot(pa, pa) / 5.0) * 0.6 + c1 * exp(-dot(pb, pb) / 5.0) * 0.6) * uPoolK;
  // sombra de contacto + ruedas (en coordenadas del coche)
  vec2 q = p - uCar.xy;
  float cy = cos(uCar.z), sy = sin(uCar.z);
  vec2 l = vec2(q.x * cy - q.y * sy, q.x * sy + q.y * cy);
  vec2 dq = abs(l) - uCarDim.xy + 0.4;
  float sd = length(max(dq, 0.0)) + min(max(dq.x, dq.y), 0.0) - 0.4;
  float sh = 0.84 * (1.0 - sm(-0.35, 0.45, sd)) + 0.22 * exp(-max(sd, 0.0) * 1.5);
  vec2 wq = vec2(abs(l.x) - uCarDim.z, min(abs(l.y - uCarAx.x), abs(l.y - uCarAx.y)));
  sh = max(sh, 0.95 * exp(-dot(wq, wq) * 24.0));
  sh *= uCar.w;
  // haces de los faros sobre el suelo
  float dz = l.y - (uCarDim.y - 0.1);
  if (dz > 0.0 && uHead > 0.01) {
    float spr = 0.22 + dz * 0.3;
    float hb = exp(-pow((l.x - 0.62) / spr, 2.0)) + exp(-pow((l.x + 0.62) / spr, 2.0));
    emis += vec3(1.0, 0.94, 0.82) * hb * sm(0.0, 0.7, dz) * exp(-dz * 0.25) * uHead * uCar.w * 0.6;
  }
  vec2 ip = p - uImp.xy;
  emis += mix(c0, vec3(1.0), 0.3) * uImp.z * exp(-dot(ip, ip) / uImp.w);
  emis += vec3(1.6, 0.5, 0.1) * uHeat * (exp(-pow((r - 3.55) / 0.35, 2.0)) * 0.45 + exp(-r * r / 30.0) * 0.05);
  if (uGrid > 0.001) {
    vec2 gp = vec2(p.x, p.y + uTime * 2.2) / 1.6;
    vec2 gl = 1.0 - smoothstep(vec2(0.0), fwp / 1.6 * 1.3 + 0.012, abs(fract(gp + 0.5) - 0.5));
    float g = max(gl.x, gl.y);
    float fade = sm(3.5, 4.8, r) * (1.0 - sm(10.0, 20.0, r));
    emis += mix(c2, c0, sm(4.0, 13.0, r)) * g * fade * uGrid * 1.8;
  }
  emis += vec3(1.0) * sEdge * 1.5 * (1.0 - sm(10.0, 16.0, r));
  if (uScanOn > 0.5) emis += mix(c0, vec3(1.0), 0.4) * 3.0 * exp(-abs(r - rs) * 4.0);

  vec3 col = base * (0.6 + pools * 7.0) + pools * 0.012;
  col *= (1.0 - sh) * uPower;
  col += emis * (1.0 - sh * 0.7);
  vec2 ruv = vR.xy / vR.w;
  vec2 nn = vec2(n21(p * 2.1), n21(p * 2.1 + 9.7)) - 0.5;
  ruv += nn * (0.002 + rough * 0.006) + vec2(0.0, wd);
  // desenfoque según la distancia recorrida tras el rebote (profundidad del reflejo)
  float dd = textureLod(tReflD, ruv, 0.0).r;
  vec4 vp = uReflInv * vec4(ruv * 2.0 - 1.0, dd * 2.0 - 1.0, 1.0);
  float bounce = dd > 0.9999 ? 60.0 : max(length(vp.xyz / vp.w) - length(vW - uReflCam), 0.0);
  float lod = min((0.25 + rough * 2.6) * log2(1.0 + bounce * 1.6), 5.0) * uLod;
  vec3 rc = textureLod(tRefl, ruv, lod).rgb;
#if TAPS > 1
  vec2 ofs = uReflTexel * exp2(lod) * vec2(0.6, 1.8);
  rc += textureLod(tRefl, ruv + vec2(0.0, ofs.y), lod).rgb + textureLod(tRefl, ruv - vec2(0.0, ofs.y), lod).rgb;
  rc += textureLod(tRefl, ruv + vec2(ofs.x, ofs.y * 2.2), lod + 0.5).rgb + textureLod(tRefl, ruv - vec2(ofs.x, ofs.y * 2.2), lod + 0.5).rgb;
  rc *= 0.2;
#endif
  float fres = 0.12 + 0.88 * pow(1.0 - clamp(V.y, 0.0, 1.0), 4.0);
  col += rc * refl * fres * uReflK * (1.0 - sh * 0.3);
  gl_FragColor = vec4(col, 1.0);
  ${F_TAIL}
}
`;

/* ---------- Rig de luz (tiras, halos, conos) ---------- */
const V_RIG = /* glsl */ `
attribute vec4 aRig; // slot, orden (barrido), secuencia (encendido), intensidad
uniform vec3 uPO[4]; uniform vec3 uPN[4];
uniform float uSweep, uSweepDir, uSweepOn;
varying vec3 vCol; varying float vEdge; varying vec4 vRig; varying vec2 vUv; varying vec3 vW; varying vec3 vN;
void main() {
  int s = int(aRig.x + 0.5);
  float o = uSweepDir > 0.0 ? 1.0 - aRig.y : aRig.y;
  vCol = mix(uPO[s], uPN[s], clamp((uSweep - o) / 0.08 + 0.5, 0.0, 1.0));
  vEdge = uSweepOn * exp(-pow((uSweep - o) / 0.05, 2.0));
  vRig = aRig; vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const F_RIG = /* glsl */ `
${G_COMMON}
uniform float uSeq, uPower, uTime, uConeK, uHaloK, uBarK;
varying vec3 vCol; varying float vEdge; varying vec4 vRig; varying vec2 vUv; varying vec3 vW; varying vec3 vN;
void main() {
  float on = sm(vRig.z, vRig.z + 0.025, uSeq);
  if (on > 0.0 && on < 1.0) on *= step(0.45, h11(floor(uTime * 45.0) + vRig.z * 131.0));
  vec3 col;
#if KIND == 0
  float ch = 0.88 + 0.12 * sin(vUv.y * 22.0 - uTime * 2.5 + vRig.y * 9.0);
  col = (vCol * ch * vRig.w * uBarK + vec3(2.0) * vEdge) * on;
#elif KIND == 1
  float d = abs(vUv.x - 0.5) * 2.0;
  float a = exp(-d * d * 6.0) * sm(0.0, 0.1, vUv.y) * sm(1.0, 0.85, vUv.y);
  col = (vCol + vEdge) * vRig.w * a * uHaloK * on;
#else
  vec3 V = normalize(cameraPosition - vW);
  float ndv = abs(dot(normalize(vN), V));
  float al = 1.0 - vUv.y;
  float a = pow(ndv, 2.2) * (0.35 + 0.65 * (1.0 - al)) * sm(0.0, 0.06, al) * sm(1.0, 0.7, al);
  float n = 0.7 + 0.3 * n21(vec2(vUv.x * 14.0 + uTime * 0.15, al * 4.0 - uTime * 0.25));
  col = vCol * vRig.w * a * n * uConeK * on;
#endif
  gl_FragColor = vec4(col * uPower, 1.0);
  ${F_TAIL}
}
`;

/* ---------- Decorado por ambientación (estructura + emisivos) ---------- */
const V_PROP = /* glsl */ `
attribute vec3 color; attribute float aEmis;
varying vec3 vCol; varying vec3 vN; varying vec3 vW; varying float vE;
void main() { vCol = color; vE = aEmis; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }
`;
const F_PROP = /* glsl */ `
${G_COMMON}
uniform float uTime, uPower, uBgPower;
uniform vec3 uKey, uAmb, uRimA, uRimB, uSunS;
varying vec3 vCol; varying vec3 vN; varying vec3 vW; varying float vE;
void main() {
  vec3 n = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float dif = 0.4 + 0.6 * max(dot(n, normalize(vec3(0.25, 1.0, 0.45))), 0.0);
  vec3 col = vCol * (uAmb * 2.0 + uKey * dif * 0.35);
  float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  col += vCol * (uRimA * max(-n.x, 0.0) + uRimB * max(n.x, 0.0)) * 0.22 + vCol * rim * uAmb * 2.0;
#if KIND == 1
  col += vCol * vec3(1.6, 0.8, 0.35) * max(dot(n, uSunS), 0.0) * 1.2;
#elif KIND == 2
  float c = caus(vW.xz * 0.35 + vec2(vW.y * 0.3), uTime * 0.5);
  col += vec3(0.25, 0.6, 0.85) * c * vCol * 1.4;
#endif
  col = vE > 0.0 ? vCol * vE : col;
  gl_FragColor = vec4(col * uBgPower, 1.0);
  ${F_TAIL}
}
`;
const F_RAYS = /* glsl */ `
${G_COMMON}
uniform float uTime, uPower, uRayK;
varying vec2 vUv;
void main() {
  float a = sm(0.0, 0.1, vUv.y) * sm(1.0, 0.8, vUv.y) * pow(1.0 - vUv.x, 1.6) * sm(0.0, 0.03, vUv.x);
  float n = 0.55 + 0.45 * fbm3(vec2(vUv.x * 9.0 - uTime * 0.12, vUv.y * 3.0 + uTime * 0.05));
  gl_FragColor = vec4(vec3(1.5, 0.8, 0.34) * a * n * uRayK * uPower, 1.0);
  ${F_TAIL}
}
`;
const V_UV = /* glsl */ `
varying vec2 vUv; varying vec3 vW;
void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }
`;

/* ---------- Holograma (dorsal + nombre) ---------- */
const F_HOLO = /* glsl */ `
${G_COMMON}
uniform sampler2D tHolo;
uniform vec3 uHC0, uHC1, uHC2;
uniform float uTime, uReveal, uGlitch, uHoloA, uPower;
varying vec2 vUv;
void main() {
  vec2 uv = vUv;
  float sl = floor(uv.y * 30.0), gt = floor(uTime * 18.0);
  float gk = step(0.55, h11(sl * 1.3 + gt)) * uGlitch;
  uv.x += (h11(sl * 7.1 + gt) - 0.5) * 0.2 * gk;
  vec4 tx = texture2D(tHolo, uv);
  float ca = texture2D(tHolo, uv + vec2(0.006 + gk * 0.02, 0.0)).g;
  float cb = texture2D(tHolo, uv - vec2(0.006 + gk * 0.02, 0.0)).g;
  float scan = 0.72 + 0.28 * sin(vUv.y * 520.0 - uTime * 9.0);
  float band = 0.85 + 0.6 * exp(-pow(fract(vUv.y * 0.7 - uTime * 0.35) - 0.5, 2.0) * 60.0);
  float flick = 0.92 + 0.08 * sin(uTime * 41.0) * sin(uTime * 13.7);
  vec3 grad = mix(uHC1, uHC0, sm(0.15, 0.85, vUv.y));
  vec3 col = grad * tx.r * 0.12 + uHC0 * tx.g * 0.75 + mix(uHC2, uHC0, vUv.y) * tx.b * 0.26;
  col += uHC1 * ca * 0.25 + uHC2 * cb * 0.25;
  col *= scan * band * flick;
  float rv = 1.0 - sm(uReveal - 0.015, uReveal, vUv.y);
  float edge = exp(-pow((vUv.y - uReveal) / 0.01, 2.0)) * step(0.0005, uReveal) * step(uReveal, 0.9995);
  float rowMask = sm(0.0, 0.12, vUv.x) * sm(1.0, 0.88, vUv.x);
  col = col * rv + mix(uHC0, vec3(1.0), 0.5) * edge * 2.2 * rowMask * (0.25 + 0.75 * max(tx.g, tx.b * 2.0));
  gl_FragColor = vec4(col * uHoloA * uPower, 1.0);
  ${F_TAIL}
}
`;

/* ---------- Cintas (rayos, láseres, estelas) ---------- */
const V_RIB = /* glsl */ `
attribute vec4 aCol; varying vec4 vC; varying vec2 vUv;
void main() { vC = aCol; vUv = uv; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }
`;
const F_RIB = /* glsl */ `
uniform float uPower;
varying vec4 vC; varying vec2 vUv;
void main() {
  float v = vUv.y;
  float core = exp(-v * v * 30.0), glow = exp(-v * v * 3.5);
  vec3 col = (vC.rgb * (core * 1.2 + glow * 0.45) + vec3(core * core) * 0.7) * vC.a;
  gl_FragColor = vec4(col * uPower, 1.0);
  ${F_TAIL}
}
`;

/* ---------- Partículas animadas en GPU (efecto firma) ---------- */
const V_PTS = /* glsl */ `
${G_COMMON}
attribute vec4 aSeed;
uniform float uTime, uMode, uLevel, uPScale;
uniform vec3 uC0, uC1, uC2;
varying vec3 vCol; varying float vA;
void main() {
  float s0 = aSeed.x, s1 = aSeed.y, s2 = aSeed.z, s3 = aSeed.w;
  vec3 p = vec3(0.0); float size = 0.03; vec3 col = uC0; float a = 0.0;
  if (uMode < 0.5) {           // chispas eléctricas
    float per = 0.55 + s1 * 0.5;
    float cyc = uTime / per + s0; float ci = floor(cyc); float t = fract(cyc) * per;
    float ang = h11(ci * 1.7 + s2 * 13.0) * TAU;
    vec3 dir = vec3(sin(ang), 0.0, -cos(ang));
    vec3 v = dir * (0.6 + s3 * 2.2) + vec3(0.0, 1.2 + s2 * 3.8, 0.0);
    p = dir * 3.3 + v * t + vec3(0.0, -4.9 * t * t, 0.0);
    p.y = max(p.y, 0.02);
    a = (1.0 - t / per) * step(0.45, h11(ci * 3.3 + s1 * 7.0));
    size = 0.035; col = mix(uC0, vec3(1.0), 0.45) * 3.0;
  } else if (uMode < 1.5) {    // brasas
    float life = fract(uTime * (0.1 + s1 * 0.12) + s0);
    float ang = s2 * TAU + life * (s3 - 0.5) * 2.0;
    float rr = 3.45 + (s3 - 0.5) * 0.5 + life * 0.9 * (s1 - 0.3);
    p = vec3(sin(ang) * rr, life * (3.5 + s3 * 4.5), -cos(ang) * rr);
    p.xz += vec2(sin(uTime * 1.7 + s0 * 40.0), cos(uTime * 1.3 + s1 * 30.0)) * 0.3 * life;
    size = mix(0.07, 0.018, life) * (0.6 + s3);
    col = mix(vec3(3.0, 2.0, 0.8), uC0 * 2.2, sm(0.0, 0.6, life));
    a = sm(0.0, 0.05, life) * (1.0 - sm(0.6, 1.0, life)) * (0.55 + 0.45 * sin(uTime * 25.0 + s0 * 60.0));
  } else if (uMode < 2.5) {    // esporas en la niebla
    float life = fract(uTime * (0.04 + s1 * 0.04) + s0);
    float ang = s2 * TAU; float rr = 1.0 + s3 * 7.5;
    p = vec3(sin(ang) * rr, life * 3.2, -cos(ang) * rr);
    p.x += sin(uTime * 0.5 + s0 * 20.0) * 0.4; p.z += cos(uTime * 0.4 + s1 * 20.0) * 0.4;
    size = 0.035 + s3 * 0.035; col = mix(uC0, uC1, s1) * 2.2;
    a = sin(life * 3.1416) * (0.5 + 0.5 * sin(uTime * 3.0 + s0 * 30.0));
  } else if (uMode < 3.5) {    // purpurina en los láseres
    p = vec3((s0 - 0.5) * 16.0, 0.3 + s1 * 7.0, 2.0 - s2 * 13.0);
    p += vec3(sin(uTime * 0.2 + s3 * 20.0), sin(uTime * 0.15 + s0 * 9.0) * 0.3, cos(uTime * 0.17 + s1 * 9.0)) * 0.6;
    float tw = pow(max(0.0, sin(uTime * (2.0 + s3 * 4.0) + s0 * 50.0)), 14.0);
    size = 0.045; col = mix(uC0, vec3(1.0), 0.35) * 3.0; a = tw;
  } else if (uMode < 4.5) {    // estrellas fugaces retro
    float sp = 0.12 + s1 * 0.2;
    p = vec3(mix(15.0, -15.0, fract(uTime * sp + s0)), 0.4 + s2 * 7.0, -3.5 - s3 * 11.0);
    size = 0.04 + s3 * 0.03; col = mix(uC0, uC2, s1) * 2.5;
    a = 0.6 + 0.4 * sin(uTime * 9.0 + s0 * 40.0);
  } else {                     // torbellino
    float life = fract(uTime * (0.07 + s1 * 0.05) + s0);
    float h = life * 7.5;
    float rr = 2.9 + h * 0.42 + (s3 - 0.5) * 0.8;
    float ang = s2 * TAU + uTime * (2.2 - h * 0.15) + h * 0.6;
    p = vec3(sin(ang) * rr, h, -cos(ang) * rr);
    size = 0.03 + s3 * 0.05;
    col = mix(uC0, uC1, step(0.6, s1)) * 2.4;
    a = sm(0.0, 0.08, life) * (1.0 - sm(0.75, 1.0, life));
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(size * uPScale / -mv.z, 1.0, 48.0);
  vCol = col; vA = a * uLevel;
}
`;
const F_PTS = /* glsl */ `
uniform float uPower;
varying vec3 vCol; varying float vA;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float f = exp(-dot(d, d) * 16.0);
  if (vA * f < 0.003) discard;
  gl_FragColor = vec4(vCol * vA * f * uPower, 1.0);
  ${F_TAIL}
}
`;
const V_DUST = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime, uPScale;
varying float vA;
void main() {
  vec3 p = vec3((aSeed.x - 0.5) * 22.0, aSeed.y * 8.5, (aSeed.z - 0.5) * 20.0 - 2.0);
  p += vec3(sin(uTime * 0.07 + aSeed.w * 20.0) * 0.9, sin(uTime * 0.05 + aSeed.x * 10.0) * 0.5, cos(uTime * 0.06 + aSeed.y * 10.0) * 0.9);
  float inCone = exp(-dot(p.xz, p.xz) / (3.0 + p.y * 0.6));
  vA = (0.12 + 1.6 * inCone) * (0.5 + 0.5 * sin(uTime * (0.6 + aSeed.w) + aSeed.z * 30.0));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp((0.018 + aSeed.w * 0.02) * uPScale / -mv.z, 1.0, 12.0);
}
`;
const F_DUST = /* glsl */ `
uniform vec3 uDust; uniform float uPower;
varying float vA;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float f = exp(-dot(d, d) * 14.0);
  gl_FragColor = vec4(uDust * vA * f * uPower * 0.6, 1.0);
  ${F_TAIL}
}
`;

/* ---------- Llamas (Fénix) y niebla (Víbora / humo de plató) ---------- */
const V_FLAME = /* glsl */ `
attribute vec3 aCenter; attribute vec3 aCorner; // x, y esquina; z semilla
uniform float uTime, uLevel;
varying vec2 vUv; varying float vSeed;
void main() {
  vec3 toC = cameraPosition - aCenter;
  vec3 right = normalize(vec3(toC.z, 0.0, -toC.x));
  float fl = 0.75 + 0.25 * sin(uTime * (5.0 + aCorner.z * 4.0) + aCorner.z * 40.0);
  float h = (0.5 + aCorner.z * 0.9) * fl * (0.25 + 0.75 * uLevel);
  vec3 p = aCenter + right * aCorner.x * 0.24 + vec3(0.0, aCorner.y * h, 0.0);
  vUv = vec2(aCorner.x * 0.5 + 0.5, aCorner.y); vSeed = aCorner.z;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;
const F_FLAME = /* glsl */ `
${G_COMMON}
uniform float uTime, uLevel, uPower;
varying vec2 vUv; varying float vSeed;
void main() {
  float n = fbm3(vec2(vUv.x * 3.0 + vSeed * 17.0, vUv.y * 2.6 - uTime * 3.6));
  float shape = (1.0 - vUv.y) * 1.15 - abs(vUv.x - 0.5) * 2.6 + (n - 0.5) * 1.5;
  float f = sm(0.02, 0.22, shape);
  vec3 col = mix(vec3(0.45, 0.03, 0.005), vec3(1.4, 0.42, 0.05), sm(0.08, 0.4, shape));
  col = mix(col, vec3(2.2, 1.5, 0.6), sm(0.45, 0.9, shape));
  gl_FragColor = vec4(col * f * uLevel * uPower * 0.5, 1.0);
  ${F_TAIL}
}
`;
const F_MIST = /* glsl */ `
${G_COMMON}
uniform float uTime, uPower, uMistK;
uniform vec3 uMistCol;
varying vec3 vW;
void main() {
  vec2 p = vW.xz;
  float r = length(p);
  float y = vW.y;
  vec2 dr = vec2(uTime * 0.13, uTime * 0.05) * (1.0 + y);
  float n = fbm3(p * 0.28 + dr + y * 3.0);
  float n2 = fbm3(p * 0.62 - dr * 1.3 + 5.0);
  float d = sm(0.45, 0.95, n * 0.7 + n2 * 0.5);
  float fade = (1.0 - sm(4.5, 11.0, r)) * (1.0 - sm(0.0, 0.6, y) * 0.6) * (0.35 + 0.65 * sm(1.4, 3.6, r));
  gl_FragColor = vec4(uMistCol * d * fade * uMistK * uPower, 1.0);
  ${F_TAIL}
}
`;

/* ---------- Destellos de faros / pilotos ---------- */
const V_FLARE = /* glsl */ `
attribute vec2 aInfo; // lámpara, tipo (0 halo, 1 estela anamórfica)
uniform vec3 uLP[4]; uniform vec3 uLC[4];
varying vec3 vC; varying vec2 vUv; varying float vK;
void main() {
  int i = int(aInfo.x + 0.5);
  vec4 mv = viewMatrix * vec4(uLP[i], 1.0);
  vec2 sz = aInfo.y < 0.5 ? vec2(0.55) : vec2(3.4, 0.07);
  mv.xy += position.xy * sz;
  gl_Position = projectionMatrix * mv;
  vC = uLC[i]; vUv = position.xy; vK = aInfo.y;
}
`;
const F_FLARE = /* glsl */ `
uniform float uPower;
varying vec3 vC; varying vec2 vUv; varying float vK;
void main() {
  float r2 = dot(vUv, vUv);
  float f = vK < 0.5 ? exp(-r2 * 5.0) * 0.6 + exp(-r2 * 45.0) * 1.6 : exp(-abs(vUv.y) * 3.5) * pow(max(1.0 - abs(vUv.x), 0.0), 3.0) * 0.8;
  gl_FragColor = vec4(vC * f * uPower, 1.0);
  ${F_TAIL}
}
`;

/* ---------- Capa de pantalla: viñeta, destello, barrido, scanlines ---------- */
const V_OVER = /* glsl */ `
varying vec2 vNdc;
void main() { vNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const F_OVER = /* glsl */ `
${G_COMMON}
uniform vec4 uVis;
uniform float uVig, uFlash, uWhip, uWhipDir, uCrt, uTime, uSpeed;
uniform vec3 uFlashCol;
varying vec2 vNdc;
void main() {
  vec2 q = (vNdc - uVis.xy) / uVis.zw;
  float a = sm(0.55, 1.6, length(q * vec2(0.85, 1.0))) * uVig;
  vec3 col = vec3(0.0);
  float w = max(uWhip, uSpeed);
  if (w > 0.001) {
    float row = floor((vNdc.y * 0.5 + 0.5) * 150.0);
    float rn = h11(row * 1.7);
    float x = fract(vNdc.x * 0.35 * (0.6 + h11(row * 3.1)) - uTime * 5.0 * uWhipDir * (0.5 + rn) + rn * 7.0);
    float s = sm(0.72, 1.0, rn) * sm(0.0, 0.6, x) * (1.0 - sm(0.6, 1.0, x));
    float radial = sm(0.15, 1.0, length(q));
    col += vec3(1.0) * s * w * 0.4 * radial;
    a = max(a, w * 0.3 * radial);
  }
  if (uCrt > 0.001) a = max(a, (0.5 + 0.5 * sin(gl_FragCoord.y * 1.5708)) * uCrt * 0.16);
  col = col * (1.0 - uFlash) + uFlashCol * uFlash;
  a = a * (1.0 - uFlash) + uFlash;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

/* =====================================================================
   Utilidades de geometría
   ===================================================================== */
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p3 = new THREE.Vector3(), _s3 = new THREE.Vector3();
function place(g, o = {}) {
  _e.set(o.rx || 0, o.ry || 0, o.rz || 0, 'YXZ'); _q.setFromEuler(_e);
  _m4.compose(_p3.set(o.x || 0, o.y || 0, o.z || 0), _q, _s3.set(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1));
  return g.applyMatrix4(_m4);
}
function fillAttr(g, name, vals) {
  const n = g.attributes.position.count, k = vals.length, a = new Float32Array(n * k);
  for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) a[i * k + j] = vals[j];
  g.setAttribute(name, new THREE.BufferAttribute(a, k));
  return g;
}
function mergeAll(list, keepUv) {
  const gs = list.map((g) => { const x = g.index ? g.toNonIndexed() : g; if (!keepUv && x.attributes.uv) x.deleteAttribute('uv'); if (x !== g) g.dispose(); return x; });
  const m = mergeGeometries(gs);
  gs.forEach((g) => g.dispose());
  return m;
}
const lin = (hex) => new THREE.Color(hex); // sRGB hex → lineal (gestión de color activa)
function luma(c) { return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722; }

/* Coche de emergencia si no llega makeCar (misma API mínima). */
function fallbackCar(def) {
  const root = new THREE.Group(), body = new THREE.Group(); body.position.y = 0.45; root.add(body);
  const paint = new THREE.MeshStandardMaterial({ color: def ? def.color : '#888', metalness: 0.5, roughness: 0.35 });
  const b = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.5, 4.5), paint); b.position.y = 0.05; body.add(b);
  const c = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.4, 1.8), new THREE.MeshStandardMaterial({ color: 0x111111 })); c.position.set(0, 0.45, -0.2); body.add(c);
  const wg = new THREE.CylinderGeometry(0.34, 0.34, 0.3, 18).rotateZ(Math.PI / 2), wm = new THREE.MeshStandardMaterial({ color: 0x111111 });
  const wheels = [[0.96, 1.42], [-0.96, 1.42], [0.96, -1.38], [-0.96, -1.38]].map(([x, z]) => {
    const steer = new THREE.Object3D(); steer.position.set(x, 0.34, z); root.add(steer); const spin = new THREE.Object3D(); steer.add(spin); spin.add(new THREE.Mesh(wg, wm)); return { steer, spin, radius: 0.34 };
  });
  const noop = () => {};
  return { root, body, wheels, dims: { length: 4.7, width: 2, height: 1.2, wheelbase: 2.8, track: 1.92, wheelRadius: 0.34, frontAxleZ: 1.42, rearAxleZ: -1.38, rideHeight: 0.12 },
    lamps: { head: [new THREE.Vector3(0.6, 0.55, 2.3), new THREE.Vector3(-0.6, 0.55, 2.3)], tail: [new THREE.Vector3(0.6, 0.6, -2.3), new THREE.Vector3(-0.6, 0.6, -2.3)], brake: [] }, exhaust: [],
    setBrake: noop, setHeadlights: noop, setFlame: noop, setHighlight: noop, setDamage: noop, setLod: noop,
    dispose() { b.geometry.dispose(); c.geometry.dispose(); wg.dispose(); paint.dispose(); wm.dispose(); c.material.dispose(); } };
}

/* =====================================================================
   SHOWROOM
   ===================================================================== */
export function createShowroom({ renderer, tier = 'med', cars = [], makeCar = null, circuit = 'neon' } = {}) {
  const LOW = tier === 'low', HIGH = tier === 'high';
  const NC = Math.max(1, cars.length || 6);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 260);
  camera.position.set(0, H0, D0);
  const disposables = [];
  const keep = (x) => { disposables.push(x); return x; };
  const L_REFL = 1; // capa de lo que se refleja en el suelo

  /* ---------------- Uniformes compartidos ---------------- */
  const v3 = () => new THREE.Vector3();
  const U = {
    uTime: { value: 0 }, uPower: { value: 1 }, uBgPower: { value: 1 },
    uPO: { value: [v3(), v3(), v3(), v3()] }, uPN: { value: [v3(), v3(), v3(), v3()] },
    uSweep: { value: 2 }, uSweepDir: { value: 1 }, uSweepOn: { value: 0 },
    uSeq: { value: 2 }, uStrip: { value: 1 },
    uMA: { value: 0 }, uMB: { value: 0 }, uScan: { value: 0 }, uScanOn: { value: 0 },
    uSunS: { value: SUN_DIR.clone() },
    uConeK: { value: 1 }, uHaloK: { value: LOW ? 0.5 : 0.22 }, uBarK: { value: 2.0 },
    uKey: { value: v3() }, uAmb: { value: v3() }, uRimA: { value: v3() }, uRimB: { value: v3() },
    uPScale: { value: 500 },
  };

  /* ---------------- Fondo ---------------- */
  const bgMat = keep(new THREE.ShaderMaterial({ uniforms: U, vertexShader: V_WORLD, fragmentShader: F_BACKDROP, side: THREE.BackSide, depthWrite: false }));
  const bgGeo = keep(new THREE.SphereGeometry(90, 48, 24));
  const backdrop = new THREE.Mesh(bgGeo, bgMat);
  backdrop.renderOrder = -10; backdrop.frustumCulled = false;
  if (!LOW) backdrop.layers.enable(L_REFL);
  scene.add(backdrop);

  /* ---------------- Reflejo planar ---------------- */
  const halfOK = (() => { try { return renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'); } catch (e) { return false; } })();
  const reflRT = keep(new THREE.WebGLRenderTarget(16, 16, {
    type: halfOK ? THREE.HalfFloatType : THREE.UnsignedByteType, generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true,
  }));
  reflRT.depthTexture = new THREE.DepthTexture(16, 16);
  keep(reflRT.depthTexture);
  const reflScale = LOW ? 0.28 : HIGH ? 0.5 : 0.38;
  const texMat = new THREE.Matrix4();
  const vCam = new THREE.PerspectiveCamera();
  vCam.layers.set(L_REFL);

  /* ---------------- Textura del anillo de texto ---------------- */
  const ringCanvas = document.createElement('canvas'); ringCanvas.width = 2048; ringCanvas.height = 192;
  const ringTex = keep(new THREE.CanvasTexture(ringCanvas));
  ringTex.colorSpace = THREE.NoColorSpace; ringTex.generateMipmaps = false; ringTex.minFilter = THREE.LinearFilter; ringTex.wrapS = THREE.RepeatWrapping;

  /* ---------------- Suelo ---------------- */
  const floorGeo = keep(new THREE.CircleGeometry(R_W, 128).rotateX(-Math.PI / 2));
  const floorU = Object.assign({}, U, {
    tRefl: { value: reflRT.texture }, tReflD: { value: reflRT.depthTexture }, uReflInv: { value: new THREE.Matrix4() }, uReflCam: { value: new THREE.Vector3() }, tRing: { value: ringTex }, uTexMat: { value: texMat }, uReflTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
    uTT: { value: 0 }, uRingRot: { value: 0 }, uHead: { value: 1 }, uGrid: { value: 0 }, uReflK: { value: 1 }, uLod: { value: LOW ? 0.7 : 1 }, uHeat: { value: 0 }, uPoolK: { value: 1 },
    uCar: { value: new THREE.Vector4(0, 0, HERO_YAW, 1) }, uCarDim: { value: new THREE.Vector4(1.0, 2.35, 0.96, 0.34) }, uCarAx: { value: new THREE.Vector2(1.42, -1.38) },
    uImp: { value: new THREE.Vector4(0, 0, 0, 1) },
  });
  const floorMat = keep(new THREE.ShaderMaterial({ uniforms: floorU, vertexShader: V_FLOOR, fragmentShader: F_FLOOR, defines: { TAPS: LOW ? 1 : 5 } }));
  const floor = new THREE.Mesh(floorGeo, floorMat);
  scene.add(floor);
  floor.onBeforeRender = (r, sc, cam) => renderReflection(r, cam);

  const _rp = new THREE.Vector3(), _cp = new THREE.Vector3(), _rot = new THREE.Matrix4(), _n = new THREE.Vector3(0, 1, 0);
  const _view = new THREE.Vector3(), _look = new THREE.Vector3(), _tgt = new THREE.Vector3();
  const _plane = new THREE.Plane(), _clip = new THREE.Vector4(), _qv = new THREE.Vector4();
  let reflBusy = false;
  function renderReflection(r, cam) {
    if (reflBusy) return;
    _rp.set(0, 0, 0);
    _cp.setFromMatrixPosition(cam.matrixWorld);
    if (_cp.y <= 0.01) return;
    _view.subVectors(_rp, _cp).reflect(_n).negate().add(_rp);
    _rot.extractRotation(cam.matrixWorld);
    _look.set(0, 0, -1).applyMatrix4(_rot).add(_cp);
    _tgt.subVectors(_rp, _look).reflect(_n).negate().add(_rp);
    vCam.position.copy(_view);
    vCam.up.set(0, 1, 0).applyMatrix4(_rot).reflect(_n);
    vCam.lookAt(_tgt);
    vCam.far = cam.far;
    vCam.updateMatrixWorld();
    vCam.projectionMatrix.copy(cam.projectionMatrix);
    texMat.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    texMat.multiply(vCam.projectionMatrix).multiply(vCam.matrixWorldInverse);
    _plane.setFromNormalAndCoplanarPoint(_n, _rp).applyMatrix4(vCam.matrixWorldInverse);
    _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
    const pm = vCam.projectionMatrix.elements;
    _qv.x = (Math.sign(_clip.x) + pm[8]) / pm[0];
    _qv.y = (Math.sign(_clip.y) + pm[9]) / pm[5];
    _qv.z = -1; _qv.w = (1 + pm[10]) / pm[14];
    _clip.multiplyScalar(2 / _clip.dot(_qv));
    pm[2] = _clip.x; pm[6] = _clip.y; pm[10] = _clip.z + 1 - 0.003; pm[14] = _clip.w;
    vCam.projectionMatrixInverse.copy(vCam.projectionMatrix).invert();
    floorU.uReflInv.value.copy(vCam.projectionMatrixInverse); floorU.uReflCam.value.copy(vCam.position);
    reflBusy = true;
    floor.visible = false;
    const prevRT = r.getRenderTarget(), prevXR = r.xr.enabled, prevSh = r.shadowMap.autoUpdate;
    r.xr.enabled = false; r.shadowMap.autoUpdate = false;
    r.setRenderTarget(reflRT);
    r.state.buffers.depth.setMask(true);
    if (r.autoClear === false) r.clear();
    r.render(scene, vCam);
    r.xr.enabled = prevXR; r.shadowMap.autoUpdate = prevSh;
    r.setRenderTarget(prevRT);
    if (cam.viewport !== undefined) r.state.viewport(cam.viewport);
    floor.visible = true;
    reflBusy = false;
  }

  /* ---------------- Rig de luces ---------------- */
  const rigU = U;
  const mkRigMat = (kind, extra = {}) => keep(new THREE.ShaderMaterial(Object.assign({ uniforms: rigU, vertexShader: V_RIG, fragmentShader: F_RIG, defines: { KIND: kind }, toneMapped: false }, extra)));
  const barGeos = [], haloGeos = [], coneGeos = [], structGeos = [];
  const BAR_PHI = [-105, -75, -45, -15, 15, 45, 75, 105].map((d) => (d * Math.PI) / 180);
  const BAR_R = 10.5, BAR_H = 7.4;
  BAR_PHI.forEach((phi, k) => {
    const [x, z] = pol(BAR_R, phi);
    const slot = Math.abs(phi) > 1.6 ? 2 : k % 2;
    const order = clamp(x / 22 + 0.5, 0, 1);
    const seq = 0.22 + 0.5 * (Math.abs(phi) / 1.9);
    const bar = place(new THREE.BoxGeometry(0.15, BAR_H, 0.15), { x, y: 0.15 + BAR_H / 2, z, ry: -phi });
    barGeos.push(fillAttr(bar, 'aRig', [slot, order, seq, 1]));
    const halo = place(new THREE.PlaneGeometry(1.5, BAR_H + 0.8), { x: x * 1.01, y: 0.15 + BAR_H / 2, z: z * 1.01, ry: -phi });
    haloGeos.push(fillAttr(halo, 'aRig', [slot, order, seq, 0.5]));
    structGeos.push(place(new THREE.BoxGeometry(0.34, 0.16, 0.34), { x, y: 0.08, z, ry: -phi }));
    structGeos.push(place(new THREE.BoxGeometry(0.3, 0.12, 0.3), { x, y: 0.15 + BAR_H + 0.06, z, ry: -phi }));
  });
  { // aro cenital
    const ring = new THREE.TorusGeometry(1, 0.012, 6, 120); ring.rotateX(Math.PI / 2); ring.scale(3.9, 1, 2.6); ring.translate(0, 6.6, -0.2);
    barGeos.push(fillAttr(ring, 'aRig', [3, 0.5, 0.9, 1.0]));
  }
  // focos (conos volumétricos) + carcasas + lentes
  const CONES = [
    { a: [0, 9.6, 1.2], b: [0, 0, -0.1], r: 3.4, slot: 3, k: 0.07, seq: 0.02 },
    { a: [-6.5, 8.5, -5.5], b: [-0.6, 0.2, -0.3], r: 1.9, slot: 0, k: 0.12, seq: 0.1 },
    { a: [6.5, 8.5, -5.5], b: [0.6, 0.2, -0.3], r: 1.9, slot: 1, k: 0.12, seq: 0.14 },
    { a: [-7.2, 0.15, -12.5], b: [3.5, 15.5, -7.5], r: 1.5, slot: 2, k: 0.14, seq: 0.6 },
    { a: [7.2, 0.15, -12.5], b: [-3.5, 15.5, -7.5], r: 1.5, slot: 2, k: 0.14, seq: 0.64 },
  ];
  const _ca = new THREE.Vector3(), _cb = new THREE.Vector3(), _cd = new THREE.Vector3(), _down = new THREE.Vector3(0, -1, 0), _cq = new THREE.Quaternion();
  CONES.forEach((c) => {
    _ca.fromArray(c.a); _cb.fromArray(c.b); _cd.subVectors(_cb, _ca); const len = _cd.length(); _cd.normalize();
    _cq.setFromUnitVectors(_down, _cd);
    const order = clamp(_ca.x / 22 + 0.5, 0, 1);
    const g = new THREE.CylinderGeometry(0.2, c.r, len, 32, 1, true); g.translate(0, -len / 2, 0); g.applyQuaternion(_cq); g.translate(_ca.x, _ca.y, _ca.z);
    coneGeos.push(fillAttr(g, 'aRig', [c.slot, order, c.seq, c.k]));
    const lens = new THREE.CircleGeometry(0.2, 20); lens.rotateX(Math.PI / 2); lens.translate(0, -0.02, 0); lens.applyQuaternion(_cq); lens.translate(_ca.x, _ca.y, _ca.z);
    barGeos.push(fillAttr(lens, 'aRig', [c.slot, order, c.seq, 2.4]));
    const hous = new THREE.CylinderGeometry(0.3, 0.24, 0.6, 14); hous.translate(0, 0.3, 0); hous.applyQuaternion(_cq); hous.translate(_ca.x, _ca.y, _ca.z);
    structGeos.push(hous);
  });
  // celosía cenital
  [[0, 9.95, 6.5, 15, 0.3, 0.3], [0, 9.95, -6.5, 15, 0.3, 0.3], [-7.5, 9.95, 0, 0.3, 0.3, 13.3], [7.5, 9.95, 0, 0.3, 0.3, 13.3], [0, 9.95, 1.2, 15, 0.22, 0.22]].forEach(([x, y, z, w, h, d]) => structGeos.push(place(new THREE.BoxGeometry(w, h, d), { x, y, z })));
  [[-6.5, -5.5], [6.5, -5.5]].forEach(([x, z]) => structGeos.push(place(new THREE.BoxGeometry(0.08, 1.5, 0.08), { x, y: 9.2, z })));
  const rigMesh = new THREE.Mesh(keep(mergeAll(barGeos, true)), mkRigMat(0));
  rigMesh.layers.enable(L_REFL);
  const haloMesh = new THREE.Mesh(keep(mergeAll(haloGeos, true)), mkRigMat(1, { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  const coneMesh = new THREE.Mesh(keep(mergeAll(coneGeos, true)), mkRigMat(2, { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  coneMesh.renderOrder = 5;
  const structMat = keep(new THREE.MeshStandardMaterial({ color: 0x0c0b12, metalness: 0.85, roughness: 0.38 }));
  const structMesh = new THREE.Mesh(keep(mergeAll(structGeos, false)), structMat);
  scene.add(rigMesh, haloMesh, coneMesh, structMesh);

  /* ---------------- Decorados por ambientación ---------------- */
  const props = [null, null, null];
  const propMat = (kind) => keep(new THREE.ShaderMaterial({ uniforms: U, vertexShader: V_PROP, fragmentShader: F_PROP, defines: { KIND: kind } }));
  function pgeo(g, o, color, emis = 0) {
    const x = place(g.index ? g.toNonIndexed() : g, o);
    if (x.attributes.uv) x.deleteAttribute('uv');
    const c = lin(color);
    fillAttr(x, 'color', emis > 0 ? [c.r, c.g, c.b] : [c.r, c.g, c.b]);
    fillAttr(x, 'aEmis', [emis]);
    return x;
  }
  function buildProps(m) {
    const group = new THREE.Group();
    const L = [];
    if (m === 0) {
      [-1.5, -0.95, -0.42, 0.42, 0.95, 1.5].forEach((phi, k) => {
        const [x, z] = pol(16.5, phi);
        L.push(pgeo(new THREE.BoxGeometry(0.9, 13, 0.9), { x, y: 6.5, z, ry: -phi }, '#1a1626'));
        const [tx, tz] = pol(16.0, phi);
        L.push(pgeo(new THREE.BoxGeometry(0.1, 12, 0.1), { x: tx, y: 6.4, z: tz, ry: -phi }, k % 2 ? '#ff4fd0' : '#3fe8ff', 2.0));
      });
      [[13.5, 13, 7, '#ff3fc8', 0.14], [17.5, 18, 9.5, '#38e6ff', 0.16]].forEach(([zz, w, h, col, t]) => {
        L.push(pgeo(new THREE.BoxGeometry(w, t, t), { x: 0, y: h, z: -zz }, col, 1.7));
        [-1, 1].forEach((s) => L.push(pgeo(new THREE.BoxGeometry(t, h, t), { x: (s * w) / 2, y: h / 2, z: -zz }, col, 1.7)));
        L.push(pgeo(new THREE.BoxGeometry(w + 0.6, 0.5, 0.5), { x: 0, y: h + 0.4, z: -zz - 0.3 }, '#14111f'));
      });
      [-1, 1].forEach((s) => {
        L.push(pgeo(new THREE.BoxGeometry(5, 0.5, 2.2), { x: s * 7.6, y: 0.25, z: -8.6, ry: s * 0.35 }, '#15121f'));
        L.push(pgeo(new THREE.BoxGeometry(5.02, 0.04, 0.04), { x: s * 7.6 - Math.sin(s * 0.35) * 1.1, y: 0.5, z: -8.6 + Math.cos(s * 0.35) * 1.1, ry: s * 0.35 }, s > 0 ? '#3fe8ff' : '#ff4fd0', 3.0));
      });
    } else if (m === 1) {
      // cerchas del techo
      [-12, -5, 2, 9].forEach((z) => {
        L.push(pgeo(new THREE.BoxGeometry(40, 0.35, 0.35), { x: 0, y: 13.4, z }, '#2a1a10'));
        L.push(pgeo(new THREE.BoxGeometry(40, 0.3, 0.3), { x: 0, y: 11.6, z }, '#2a1a10'));
        for (let x = -18; x <= 18; x += 3) L.push(pgeo(new THREE.BoxGeometry(0.16, 2.5, 0.16), { x: x + 0.75, y: 12.5, z, rz: ((x / 3) % 2 ? 1 : -1) * 0.62 }, '#2a1a10'));
      });
      // lámparas industriales colgantes
      [[-5, 8.0, -6], [0, 8.6, -9.5], [5, 8.0, -6]].forEach(([x, y, z]) => {
        L.push(pgeo(new THREE.BoxGeometry(0.03, 13.4 - y, 0.03), { x, y: (13.4 + y) / 2, z }, '#1a1410'));
        L.push(pgeo(new THREE.ConeGeometry(0.55, 0.45, 16, 1, true), { x, y: y - 0.2, z }, '#3a2a1c'));
        L.push(pgeo(new THREE.SphereGeometry(0.16, 10, 8), { x, y: y - 0.38, z }, '#ffcf8a', 4.0));
      });
      // cajas, bidones, neumáticos, banco de trabajo
      [[-10.5, -11, 0], [-9.2, -11.6, 0.3], [-10.0, -11.3, 1]].forEach(([x, z, lvl], k) => L.push(pgeo(new THREE.BoxGeometry(1.3, 1.1, 1.3), { x, y: 0.55 + lvl * 1.1, z, ry: k * 0.4 }, k % 2 ? '#6b4a2a' : '#5a3d22')));
      [[8.8, -12], [9.7, -12.4], [9.3, -11.2], [10.4, -11.6]].forEach(([x, z], k) => L.push(pgeo(new THREE.CylinderGeometry(0.42, 0.42, 1.2, 16), { x, y: 0.6, z }, k % 2 ? '#8a2a18' : '#a8481c')));
      for (let k = 0; k < 5; k++) L.push(pgeo(new THREE.TorusGeometry(0.42, 0.17, 8, 18), { x: -12.6, y: 0.18 + k * 0.33, z: -5.5, rx: Math.PI / 2 }, '#16120e'));
      L.push(pgeo(new THREE.BoxGeometry(3, 0.12, 1.1), { x: 12.2, y: 1.0, z: -7.4, ry: -0.6 }, '#4a3420'));
      [[-1.3, -0.45], [1.3, -0.45], [-1.3, 0.45], [1.3, 0.45]].forEach(([dx, dz]) => L.push(pgeo(new THREE.BoxGeometry(0.1, 1.0, 0.1), { x: 12.2 + dx * Math.cos(0.6) + dz * Math.sin(0.6), y: 0.5, z: -7.4 - dx * Math.sin(0.6) + dz * Math.cos(0.6) }, '#2a1c12')));
    } else {
      const N = 13;
      for (let k = 0; k < N; k++) {
        const phi = -1.8 + (3.6 * k) / (N - 1);
        const [x, z] = pol(15.5, phi);
        L.push(pgeo(new THREE.CylinderGeometry(0.22, 0.26, 8.8, 14), { x, y: 4.4, z }, '#c9d2dc'));
        L.push(pgeo(new THREE.BoxGeometry(0.7, 0.25, 0.7), { x, y: 0.12, z, ry: -phi }, '#aab4c0'));
        L.push(pgeo(new THREE.BoxGeometry(0.62, 0.22, 0.62), { x, y: 8.85, z, ry: -phi }, '#aab4c0'));
        if (k < N - 1) {
          const phi2 = -1.8 + (3.6 * (k + 1)) / (N - 1);
          const [x2, z2] = pol(15.5, phi2);
          const mx = (x + x2) / 2, mz = (z + z2) / 2, len = Math.hypot(x2 - x, z2 - z), yaw = Math.atan2(x2 - x, z2 - z);
          L.push(pgeo(new THREE.BoxGeometry(0.3, 0.45, len), { x: mx, y: 9.15, z: mz, ry: yaw }, '#9aa6b4'));
          for (let b = 1; b < 10; b++) {
            const f = b / 10, sag = 0.85 * (1 - Math.pow(2 * f - 1, 2));
            L.push(pgeo(new THREE.IcosahedronGeometry(0.075, 0), { x: lerp(x, x2, f), y: 8.3 - sag, z: lerp(z, z2, f) }, b % 3 ? '#ffd29a' : '#ffffff', 3.2));
          }
          // barandilla del muelle
          const [bx, bz] = pol(19.1, (phi + phi2) / 2);
          L.push(pgeo(new THREE.BoxGeometry(0.06, 1.0, 0.06), { x: bx, y: 0.5, z: bz }, '#8c96a4'));
          const [ax, az] = pol(19.1, phi), [cx, cz] = pol(19.1, phi2);
          L.push(pgeo(new THREE.BoxGeometry(0.07, 0.07, Math.hypot(cx - ax, cz - az)), { x: (ax + cx) / 2, y: 1.0, z: (az + cz) / 2, ry: Math.atan2(cx - ax, cz - az) }, '#dfe7f0', 1.2));
        }
      }
      [[-6, -17.5], [6, -17.5], [-13, -12.2], [13, -12.2]].forEach(([x, z]) => L.push(pgeo(new THREE.CylinderGeometry(0.22, 0.28, 0.6, 12), { x, y: 0.3, z }, '#20262e')));
    }
    const mesh = new THREE.Mesh(mergeAll(L, false), propMat(m));
    group.add(mesh);
    if (HIGH) mesh.layers.enable(L_REFL);
    let rays = null;
    if (m === 1) { // haces de sol entre las lamas
      const RG = [];
      const Ld = SUN_DIR.clone().negate();
      for (let k = 0; k < 11; k++) {
        const phi = -0.84 + k * 0.071 + (k % 3) * 0.012;
        const su = (Math.round((phi * R_W) / 0.8 - 0.5) + 0.5) * 0.8 / R_W;
        const [wx, wz] = pol(R_W - 0.2, su);
        const yb = 0.5, yt = 7.6, len = 36;
        const g = new THREE.BufferGeometry();
        const A = [wx, yt, wz], B = [wx, yb, wz], C = [wx + Ld.x * len, yb + Ld.y * len, wz + Ld.z * len], D = [wx + Ld.x * len, yt + Ld.y * len, wz + Ld.z * len];
        g.setAttribute('position', new THREE.Float32BufferAttribute([...A, ...B, ...C, ...A, ...C, ...D], 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1], 2));
        RG.push(g);
      }
      const rm = keep(new THREE.ShaderMaterial({ uniforms: Object.assign({}, U, { uRayK: { value: LOW ? 0.1 : 0.07 } }), vertexShader: V_UV, fragmentShader: F_RAYS, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
      rays = new THREE.Mesh(mergeGeometries(RG), rm);
      RG.forEach((g) => g.dispose());
      rays.renderOrder = 4;
      group.add(rays);
    }
    group.visible = false;
    scene.add(group);
    props[m] = { group, mesh, rays };
    return props[m];
  }

  /* ---------------- Holograma ---------------- */
  const holoCanvas = document.createElement('canvas'); holoCanvas.width = 1024; holoCanvas.height = 512;
  const holoTex = keep(new THREE.CanvasTexture(holoCanvas)); holoTex.colorSpace = THREE.NoColorSpace;
  const holoU = { tHolo: { value: holoTex }, uHC0: { value: v3() }, uHC1: { value: v3() }, uHC2: { value: v3() }, uTime: U.uTime, uReveal: { value: 1 }, uGlitch: { value: 0 }, uHoloA: { value: 1 }, uPower: U.uPower };
  const holoMat = keep(new THREE.ShaderMaterial({ uniforms: holoU, vertexShader: V_UV, fragmentShader: F_HOLO, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
  const holo = new THREE.Mesh(keep(new THREE.PlaneGeometry(12.5, 6.25)), holoMat);
  holo.position.set(0, 3.55, -7.6); holo.renderOrder = 3;
  holo.layers.enable(L_REFL);
  scene.add(holo);
  let holoDrawn = -1;
  function drawHolo(i) {
    const def = cars[i] || { name: 'Coche', num: i + 1, code: '' };
    const x = holoCanvas.getContext('2d'), W = 1024, H = 512;
    x.globalCompositeOperation = 'source-over'; x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
    x.globalCompositeOperation = 'lighter';
    const fx = fxOf(i);
    const num = String(def.num ?? i + 1).padStart(2, '0');
    x.textAlign = 'center'; x.textBaseline = 'alphabetic';
    if (fx === 4) { // sol retro
      x.save(); x.beginPath(); x.arc(W / 2, 300, 200, 0, TAU); x.clip();
      for (let k = 0; k < 14; k++) { const y0 = 100 + k * 30, cut = k > 6 ? (k - 6) * 3.2 : 0; x.fillStyle = 'rgba(0,0,255,0.55)'; x.fillRect(0, y0 + cut, W, 30 - cut); }
      x.restore();
    }
    x.font = `italic 900 330px ${FONT}`;
    x.fillStyle = '#ff0000'; x.fillText(num, W / 2, 352);
    x.lineWidth = 7; x.strokeStyle = '#00ff00'; x.lineJoin = 'round'; x.strokeText(num, W / 2, 352);
    x.save(); x.shadowColor = '#0000ff'; x.shadowBlur = 40; x.shadowOffsetX = 4000; x.fillStyle = '#0000ff'; x.fillText(num, W / 2 - 4000, 352); x.restore();
    const name = String(def.name || '').toUpperCase();
    x.font = `800 64px ${FONT}`;
    const spaced = name.split('').join(' ');
    x.fillStyle = '#00ff00'; x.fillText(spaced, W / 2, 452);
    x.save(); x.shadowColor = '#0000ff'; x.shadowBlur = 22; x.shadowOffsetX = 4000; x.fillStyle = '#0000ff'; x.fillText(spaced, W / 2 - 4000, 452); x.restore();
    x.fillStyle = '#00ff00';
    x.fillRect(W / 2 - 330, 474, 210, 3); x.fillRect(W / 2 + 120, 474, 210, 3);
    x.font = `700 24px ${FONT}`; x.fillText(`#${num} · ${def.code || ''}`, W / 2, 500);
    for (let k = 0; k < 4; k++) { x.fillRect(80 + k * 18, 70, 10, 10); x.fillRect(W - 80 - k * 18 - 10, 70, 10, 10); }
    holoTex.needsUpdate = true;
    // anillo de texto del suelo
    const rx = ringCanvas.getContext('2d');
    rx.clearRect(0, 0, 2048, 192); rx.fillStyle = '#000'; rx.fillRect(0, 0, 2048, 192);
    rx.fillStyle = '#ff0000'; rx.font = `800 120px ${FONT}`; rx.textBaseline = 'middle'; rx.textAlign = 'left';
    const unit = `${name}  •  #${num}  •  `;
    let px = 10; const uw = Math.max(200, rx.measureText(unit).width);
    const reps = Math.max(1, Math.floor(2048 / uw)); const sc = 2048 / (uw * reps);
    rx.save(); rx.scale(sc, 1); for (let k = 0; k < reps; k++) { rx.fillText(unit, px, 100); px += uw; } rx.restore();
    ringTex.needsUpdate = true;
    holoDrawn = i;
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!disposed && holoDrawn >= 0) drawHolo(holoDrawn); }).catch(() => {});

  /* ---------------- Efectos firma ---------------- */
  // Cintas (CPU): rayos, láseres, estelas
  const RIB_STRIPS = 22, RIB_PTS = 24;
  const RV = RIB_STRIPS * RIB_PTS * 2;
  const ribPos = new Float32Array(RV * 3), ribCol = new Float32Array(RV * 4), ribUv = new Float32Array(RV * 2);
  const ribIdx = [];
  for (let s = 0; s < RIB_STRIPS; s++) for (let i = 0; i < RIB_PTS - 1; i++) { const a = (s * RIB_PTS + i) * 2; ribIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const ribGeo = keep(new THREE.BufferGeometry());
  ribGeo.setAttribute('position', new THREE.BufferAttribute(ribPos, 3).setUsage(THREE.DynamicDrawUsage));
  ribGeo.setAttribute('aCol', new THREE.BufferAttribute(ribCol, 4).setUsage(THREE.DynamicDrawUsage));
  ribGeo.setAttribute('uv', new THREE.BufferAttribute(ribUv, 2).setUsage(THREE.DynamicDrawUsage));
  ribGeo.setIndex(ribIdx);
  const ribMat = keep(new THREE.ShaderMaterial({ uniforms: { uPower: U.uPower }, vertexShader: V_RIB, fragmentShader: F_RIB, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
  const ribbons = new THREE.Mesh(ribGeo, ribMat);
  ribbons.frustumCulled = false; ribbons.renderOrder = 6;
  if (!LOW) ribbons.layers.enable(L_REFL);
  scene.add(ribbons);
  let ribN = 0;
  const RP = new Float32Array(RIB_PTS * 3); // puntos de trabajo
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _t = new THREE.Vector3(), _sd = new THREE.Vector3(), _tc = new THREE.Vector3(), _camP = new THREE.Vector3();
  /** Añade una cinta: n puntos en RP, anchura w (fn o número), color rgb, brillo a(u). */
  function ribbon(n, w, r, g, b, alphaFn) {
    if (ribN >= RIB_STRIPS || n < 2) return;
    const base = ribN * RIB_PTS;
    for (let i = 0; i < RIB_PTS; i++) {
      const j = Math.min(i, n - 1);
      const u = j / (n - 1);
      _a.fromArray(RP, j * 3);
      const jp = Math.max(0, j - 1), jn = Math.min(n - 1, j + 1);
      _t.fromArray(RP, jn * 3).sub(_b.fromArray(RP, jp * 3));
      _tc.subVectors(_camP, _a);
      _sd.crossVectors(_t, _tc); const l = _sd.length() || 1;
      const ww = (typeof w === 'function' ? w(u) : w) * 0.5 * (i < n ? 1 : 0);
      _sd.multiplyScalar(ww / l);
      const vi = (base + i) * 2;
      ribPos[vi * 3] = _a.x + _sd.x; ribPos[vi * 3 + 1] = _a.y + _sd.y; ribPos[vi * 3 + 2] = _a.z + _sd.z;
      ribPos[vi * 3 + 3] = _a.x - _sd.x; ribPos[vi * 3 + 4] = _a.y - _sd.y; ribPos[vi * 3 + 5] = _a.z - _sd.z;
      const al = i < n ? alphaFn(u) : 0;
      for (let e = 0; e < 2; e++) { const ci = (vi + e) * 4; ribCol[ci] = r; ribCol[ci + 1] = g; ribCol[ci + 2] = b; ribCol[ci + 3] = al; ribUv[(vi + e) * 2] = u; ribUv[(vi + e) * 2 + 1] = e ? -1 : 1; }
    }
    ribN++;
  }
  function ribbonsEnd() {
    ribGeo.setDrawRange(0, ribN * (RIB_PTS - 1) * 6);
    ribGeo.attributes.position.needsUpdate = true; ribGeo.attributes.aCol.needsUpdate = true; ribGeo.attributes.uv.needsUpdate = true;
    ribbons.visible = ribN > 0;
  }

  // Partículas GPU
  const PN = LOW ? 260 : HIGH ? 900 : 560;
  const ptsGeo = keep(new THREE.BufferGeometry());
  { const s = new Float32Array(PN * 4); for (let i = 0; i < PN * 4; i++) s[i] = Math.random(); ptsGeo.setAttribute('aSeed', new THREE.BufferAttribute(s, 4)); ptsGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PN * 3), 3)); }
  const ptsU = { uTime: U.uTime, uPower: U.uPower, uPScale: U.uPScale, uMode: { value: 0 }, uLevel: { value: 0 }, uC0: { value: v3() }, uC1: { value: v3() }, uC2: { value: v3() } };
  const ptsMat = keep(new THREE.ShaderMaterial({ uniforms: ptsU, vertexShader: V_PTS, fragmentShader: F_PTS, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  const fxPts = new THREE.Points(ptsGeo, ptsMat); fxPts.frustumCulled = false; fxPts.renderOrder = 7;
  scene.add(fxPts);

  // Polvo en suspensión (siempre)
  const DN = LOW ? 160 : HIGH ? 520 : 340;
  const dustGeo = keep(new THREE.BufferGeometry());
  { const s = new Float32Array(DN * 4); for (let i = 0; i < DN * 4; i++) s[i] = Math.random(); dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(s, 4)); dustGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DN * 3), 3)); }
  const dustU = { uTime: U.uTime, uPScale: U.uPScale, uPower: U.uPower, uDust: { value: v3() } };
  const dust = new THREE.Points(dustGeo, keep(new THREE.ShaderMaterial({ uniforms: dustU, vertexShader: V_DUST, fragmentShader: F_DUST, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })));
  dust.frustumCulled = false; dust.renderOrder = 8;
  scene.add(dust);

  // Llamas (Fénix)
  const FLN = LOW ? 30 : 48;
  const flameGeo = keep(new THREE.BufferGeometry());
  {
    const cen = [], cor = [], idx = [];
    for (let k = 0; k < FLN; k++) {
      const ang = (k / FLN) * TAU + Math.random() * 0.05, r = 3.5 + Math.random() * 0.12, seed = Math.random();
      const cx = Math.sin(ang) * r, cz = -Math.cos(ang) * r;
      [[-1, 0], [1, 0], [1, 1], [-1, 1]].forEach(([a, b]) => { cen.push(cx, 0.0, cz); cor.push(a, b, seed); });
      const o = k * 4; idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    }
    flameGeo.setAttribute('aCenter', new THREE.Float32BufferAttribute(cen, 3));
    flameGeo.setAttribute('aCorner', new THREE.Float32BufferAttribute(cor, 3));
    flameGeo.setAttribute('position', new THREE.Float32BufferAttribute(cen, 3));
    flameGeo.setIndex(idx);
  }
  const flameU = { uTime: U.uTime, uPower: U.uPower, uLevel: { value: 0 } };
  const flames = new THREE.Mesh(flameGeo, keep(new THREE.ShaderMaterial({ uniforms: flameU, vertexShader: V_FLAME, fragmentShader: F_FLAME, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide })));
  flames.frustumCulled = false; flames.renderOrder = 6; flames.visible = false;
  if (!LOW) flames.layers.enable(L_REFL);
  scene.add(flames);

  // Niebla rasante
  const mistGeo = keep((() => { const L = []; const n = LOW ? 3 : 5; for (let k = 0; k < n; k++) L.push(place(new THREE.PlaneGeometry(24, 24).rotateX(-Math.PI / 2), { y: 0.04 + Math.pow(k / (n - 1), 1.4) * 0.5, ry: k * 0.7 })); return mergeAll(L, false); })());
  const mistU = { uTime: U.uTime, uPower: U.uPower, uMistK: { value: 0.02 }, uMistCol: { value: v3() } };
  const mist = new THREE.Mesh(mistGeo, keep(new THREE.ShaderMaterial({ uniforms: mistU, vertexShader: V_WORLD, fragmentShader: F_MIST, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide })));
  mist.renderOrder = 2;
  scene.add(mist);

  // Destellos
  const flareGeo = keep(new THREE.BufferGeometry());
  {
    const pos = [], info = [], idx = [];
    for (let l = 0; l < 4; l++) for (let kind = 0; kind < 2; kind++) {
      const o = pos.length / 3;
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([a, b]) => { pos.push(a, b, 0); info.push(l, kind); });
      idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    }
    flareGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    flareGeo.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 2));
    flareGeo.setIndex(idx);
  }
  const flareU = { uPower: U.uPower, uLP: { value: [v3(), v3(), v3(), v3()] }, uLC: { value: [v3(), v3(), v3(), v3()] } };
  const flares = new THREE.Mesh(flareGeo, keep(new THREE.ShaderMaterial({ uniforms: flareU, vertexShader: V_FLARE, fragmentShader: F_FLARE, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, toneMapped: false })));
  flares.frustumCulled = false; flares.renderOrder = 20;
  scene.add(flares);

  // Capa de pantalla
  const overU = { uVis: { value: new THREE.Vector4(0, 0, 1, 1) }, uVig: { value: 0.55 }, uFlash: { value: 0 }, uFlashCol: { value: new THREE.Color(1, 1, 1) }, uWhip: { value: 0 }, uWhipDir: { value: 1 }, uCrt: { value: 0 }, uSpeed: { value: 0 }, uTime: U.uTime };
  const overlay = new THREE.Mesh(keep(new THREE.PlaneGeometry(2, 2)), keep(new THREE.ShaderMaterial({
    uniforms: overU, vertexShader: V_OVER, fragmentShader: F_OVER, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  })));
  overlay.frustumCulled = false; overlay.renderOrder = 1000;
  scene.add(overlay);

  /* ---------------- Luces ---------------- */
  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  const top = new THREE.SpotLight(0xffffff, 0, 30, 0.5, 0.7, 1.2); top.position.set(0, 9.6, 1.2);
  const rimA = new THREE.SpotLight(0xffffff, 0, 26, 0.5, 0.6, 1.3); rimA.position.set(-6.5, 8.5, -5.5);
  const rimB = new THREE.SpotLight(0xffffff, 0, 26, 0.5, 0.6, 1.3); rimB.position.set(6.5, 8.5, -5.5);
  const fxL = new THREE.PointLight(0xffffff, 0, 14, 1.6); fxL.position.set(0, 2.4, 2.2);
  const swL = new THREE.PointLight(0xffffff, 0, 12, 1.4);
  const lightTgt = new THREE.Object3D(); lightTgt.position.set(0, 0.5, 0);
  [key, top, rimA, rimB].forEach((l) => { l.target = lightTgt; });
  scene.add(hemi, key, top, rimA, rimB, fxL, swL, lightTgt);
  [hemi, key, top, rimA, rimB, fxL, swL].forEach((l) => l.layers.enable(L_REFL));

  /* ---------------- Mapa de entorno (reflejos en la carrocería) ---------------- */
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene(); envScene.background = new THREE.Color(0);
  const envM = {};
  const envPanel = (name, geo, o) => { const m = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }); const me = new THREE.Mesh(geo, m); place(me.geometry, o); envScene.add(me); envM[name] = m; return me; };
  envPanel('top', new THREE.PlaneGeometry(9, 3.2), { y: 9, rx: Math.PI / 2 });
  envPanel('front', new THREE.PlaneGeometry(10, 1.2), { y: 6.5, z: 6, rx: Math.PI / 2 + 0.6 });
  envPanel('hor', new THREE.CylinderGeometry(24, 24, 5, 40, 1, true), { y: 1.5 });
  envPanel('sky', new THREE.SphereGeometry(30, 24, 12, 0, TAU, 0, 1.2), {});
  envPanel('floor', new THREE.CircleGeometry(24, 32), { y: -0.1, rx: -Math.PI / 2 });
  envPanel('sun', new THREE.PlaneGeometry(7, 4), { x: SUN_DIR.x * 20, y: SUN_DIR.y * 20 + 1, z: SUN_DIR.z * 20, ry: Math.atan2(-SUN_DIR.x, -SUN_DIR.z) });
  [0, 1, 2, 3, 4, 5, 6, 7].forEach((k) => {
    const phi = BAR_PHI[k], [x, z] = pol(10, phi);
    envPanel('b' + k, new THREE.BoxGeometry(0.5, 7, 0.5), { x, y: 3.6, z });
  });
  envPanel('sideL', new THREE.PlaneGeometry(12, 0.8), { x: -9, y: 2.2, ry: Math.PI / 2 });
  envPanel('sideR', new THREE.PlaneGeometry(12, 0.8), { x: 9, y: 2.2, ry: Math.PI / 2 });
  let envTex = null, envRT = null;
  const _ec = new THREE.Color();
  function regenEnv(moodIdx, pal) {
    const M = MOODS[moodIdx];
    envM.top.color.setRGB(M.key[0] * 1.5, M.key[1] * 1.5, M.key[2] * 1.5);
    envM.front.color.setRGB(M.key[0] * 0.7, M.key[1] * 0.7, M.key[2] * 0.7);
    envM.hor.color.setRGB(M.envHor[0] * 0.55, M.envHor[1] * 0.55, M.envHor[2] * 0.55);
    envM.sky.color.setRGB(M.envSky[0], M.envSky[1], M.envSky[2]);
    envM.floor.color.setRGB(M.envFloor[0], M.envFloor[1], M.envFloor[2]);
    envM.sun.color.setRGB(moodIdx === 1 ? 7 : 0, moodIdx === 1 ? 3.6 : 0, moodIdx === 1 ? 1.4 : 0);
    for (let k = 0; k < 8; k++) { const s = Math.abs(BAR_PHI[k]) > 1.6 ? 2 : k % 2; _ec.copy(pal[s]).multiplyScalar(1.5); envM['b' + k].color.copy(_ec); }
    _ec.copy(pal[0]).multiplyScalar(1.2); envM.sideL.color.copy(_ec);
    _ec.copy(pal[1]).multiplyScalar(1.2); envM.sideR.color.copy(_ec);
    const rt = pmrem.fromScene(envScene, 0.02, 0.1, 80);
    const old = envRT, wasNull = !envTex;
    envRT = rt; envTex = rt.texture;
    scene.environment = envTex;
    carObjs.forEach((c) => c && c.mats.forEach((m) => { m.envMap = envTex; if (wasNull) m.needsUpdate = true; }));
    if (old) old.dispose();
    envDirty = false;
  }
  let envDirty = true;

  /* ---------------- Coches ---------------- */
  const carObjs = [];
  const origEnv = new Map();
  function fxOf(i) { const d = cars[i]; return d && FX_BY_CODE[d.code] != null ? FX_BY_CODE[d.code] : i % 6; }
  function paletteOf(i) {
    const d = cars[i] || {};
    const p = PALETTES[d.code];
    if (p) return p.map(lin);
    const c0 = lin(d.color || '#ffffff'); let c1 = lin(d.accent || '#ffffff'); if (luma(c1) < 0.15) c1 = lin(d.rim || '#ffffff');
    const c2 = c0.clone().lerp(c1, 0.5).offsetHSL(0.08, 0, 0);
    return [c0, c1, c2];
  }
  function ensureCar(i) {
    if (carObjs[i]) return carObjs[i];
    let model = null;
    try { if (makeCar) model = makeCar(i, { envMap: envTex, tier, showroom: true }); } catch (e) { console.warn('[garaje] makeCar', e); }
    if (!model || !model.root) model = fallbackCar(cars[i]);
    const holder = new THREE.Group(); holder.add(model.root); holder.visible = false; scene.add(holder);
    try { model.setLod && model.setLod(0); } catch (e) {}
    const mats = new Set();
    model.root.traverse((o) => {
      o.layers.enable(L_REFL);
      if (o.isMesh) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
          if (m && (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) && opts.carEnv !== false) { if (!origEnv.has(m)) origEnv.set(m, m.envMap); m.envMap = envTex; m.needsUpdate = true; mats.add(m); }
        });
      }
    });
    const body = model.body || model.root;
    const d = model.dims || {};
    const envI = new Map(); mats.forEach((m) => { envI.set(m, m.envMapIntensity); if (S.envK != null) m.envMapIntensity *= S.envK; });
    const o = { i, model, holder, body, bodyY: body.position.y, mats: [...mats], envI, refl: true,
      halfW: (d.width || 2) / 2, halfL: (d.length || 4.7) / 2, halfT: (d.track || 1.92) / 2, wr: d.wheelRadius || 0.34, fz: d.frontAxleZ ?? 1.42, rz: d.rearAxleZ ?? -1.38 };
    carObjs[i] = o;
    return o;
  }
  const opts = { carEnv: true };
  const mkCS = () => ({ yaw0: HERO_YAW, o: null, s: 0, v: 0, vs: 0, acc: 0, yaw: HERO_YAW, pitch: 0, pv: 0, heave: 0, hv: 0, roll: 0, rv: 0, spin: 0, steer: 0, head: 1, brake: 0, flame: 0, shake: 0, vis: false, mode: 'idle', s0: 0, v0: 0, t: 0 });
  const A = mkCS(), B = mkCS(); // A = coche principal, B = coche saliente
  const trail = { n: 0, pts: new Float32Array(16 * 6), life: 0 };

  /* ---------------- Estado ---------------- */
  const S = {
    t: 0, cur: -1, tr: null, intro: null, outro: null, mt: null, mood: MOOD_IDS.indexOf(circuit) >= 0 ? MOOD_IDS.indexOf(circuit) : 0,
    arriveT: 10, idleT: 0, flick: false, drag: 0, dragV: 0,
    sweepRate: 2, flash: 0, flashCol: new THREE.Color(1, 1, 1), flashDecay: 4, whip: 0, whipDir: 1, speed: 0,
    camAz: 0, camRush: 0, fovMul: 1, holoGl: 0, holoA: 1, fx: 0, fxLevel: 0, power: 1, bgPower: 1,
    impT: 0, bolts: [], nextBolt: 0, white: 0, envK: null, bloomOn: !LOW,
  };
  const mb = { w: 1, from: S.mood, to: S.mood }; // mezcla de luces/colores de la ambientación
  const view = { w: 390, h: 844, cx: 195, cy: 300, vis: [0, 58, 390, 422], vfov: 60, s: 0.016 };

  // paletas iniciales
  const RED = [new THREE.Color(1.0, 0.06, 0.04), new THREE.Color(1.0, 0.16, 0.05), new THREE.Color(0.7, 0.02, 0.02)];
  const GREEN = [new THREE.Color(0.1, 1.0, 0.3), new THREE.Color(0.35, 1.0, 0.45), new THREE.Color(0.05, 0.8, 0.25)];
  function setPalNow(pal) { for (let k = 0; k < 3; k++) { U.uPO.value[k].set(pal[k].r, pal[k].g, pal[k].b); U.uPN.value[k].set(pal[k].r, pal[k].g, pal[k].b); } U.uSweep.value = 2; U.uSweepOn.value = 0; }
  function sweepTo(pal, dir, rate) {
    // fija como "viejo" lo que se ve ahora (si el barrido anterior no había terminado, cerramos en el nuevo)
    const done = U.uSweep.value >= 1.1;
    for (let k = 0; k < 3; k++) { if (done) U.uPO.value[k].copy(U.uPN.value[k]); else U.uPO.value[k].lerp(U.uPN.value[k], sat(U.uSweep.value)); U.uPN.value[k].set(pal[k].r, pal[k].g, pal[k].b); }
    U.uSweep.value = -0.15; U.uSweepDir.value = dir >= 0 ? 1 : -1; S.sweepRate = rate; U.uSweepOn.value = 1;
  }
  const palNow = [new THREE.Color(), new THREE.Color(), new THREE.Color()];
  function curPal() { const k = sat(U.uSweep.value); for (let s = 0; s < 3; s++) { const o = U.uPO.value[s], n = U.uPN.value[s]; palNow[s].setRGB(lerp(o.x, n.x, k), lerp(o.y, n.y, k), lerp(o.z, n.z, k)); } return palNow; }

  function applyFxStyle(i) {
    const fx = fxOf(i);
    S.fx = fx;
    const pal = paletteOf(i);
    ptsU.uMode.value = fx; ptsU.uC0.value.set(pal[0].r, pal[0].g, pal[0].b); ptsU.uC1.value.set(pal[1].r, pal[1].g, pal[1].b); ptsU.uC2.value.set(pal[2].r, pal[2].g, pal[2].b);
    holoU.uHC0.value.set(pal[0].r, pal[0].g, pal[0].b); holoU.uHC1.value.set(pal[1].r, pal[1].g, pal[1].b); holoU.uHC2.value.set(pal[2].r, pal[2].g, pal[2].b);
    ptsGeo.setDrawRange(0, fx === 2 ? Math.round(PN * 0.4) : fx === 3 ? Math.round(PN * 0.5) : fx === 4 ? Math.round(PN * 0.35) : PN);
    S.bolts.length = 0; S.nextBolt = 0;
  }

  function reflLayer(o, on) { if (o && o.refl !== on) { o.refl = on; o.model.root.traverse((x) => (on ? x.layers.enable(L_REFL) : x.layers.disable(L_REFL))); } }
  function placeCar(cs, i) {
    const o = ensureCar(i);
    reflLayer(o, true);
    cs.o = o; cs.vis = true; o.holder.visible = true;
    cs.s = 0; cs.v = 0; cs.vs = 0; cs.acc = 0; cs.pitch = 0; cs.pv = 0; cs.heave = 0; cs.hv = 0; cs.roll = 0; cs.rv = 0; cs.flame = 0; cs.shake = 0; cs.brake = 0; cs.steer = 0;
    cs.yaw = HERO_YAW; cs.mode = 'idle';
  }
  function hideCar(cs) { if (cs.o) { cs.o.holder.visible = false; try { cs.o.model.setBrake && cs.o.model.setBrake(0); cs.o.model.setFlame && cs.o.model.setFlame(0); } catch (e) {} } cs.o = null; cs.vis = false; }

  /** Cambia el coche mostrado. dir −1/+1 = transición cinemática, 0 = instantáneo. */
  function showCar(i, dir = 0) {
    i = ((i | 0) % NC + NC) % NC;
    if (S.tr && !S.tr.swapped) { S.tr.to = i; return; }
    if (i === S.cur && !S.tr) return;
    if (dir === 0 || S.cur < 0) {
      S.tr = null; hideCar(B);
      if (A.o && A.o.i !== i) hideCar(A);
      placeCar(A, i);
      S.cur = i; S.arriveT = 10; S.idleT = 10; S.flick = false;
      setPalNow(paletteOf(i));
      applyFxStyle(i); drawHolo(i);
      S.fxLevel = 1; S.holoA = 1; S.holoGl = 0; S.camAz = 0; S.whip = 0;
      envDirty = true;
      return;
    }
    if (S.tr && S.tr.swapped) finishTransition();
    S.tr = { kind: dir > 0 ? 'drive' : 'whip', dir: dir > 0 ? 1 : -1, t: 0, to: i, swapped: false, fxStart: S.fxLevel, holoStart: S.holoA };
  }
  function finishTransition() {
    const tr = S.tr; if (!tr) return;
    if (!tr.swapped) doSwap(tr);
    A.s = 0; A.v = 0; A.mode = 'idle';
    if (S.arriveT < 0 || S.arriveT > 5) S.arriveT = 0;
    hideCar(B); trail.n = 0;
    S.camAz = 0; S.whip = 0; S.tr = null;
  }
  function doSwap(tr) {
    tr.swapped = true;
    const i = tr.to;
    // el coche actual pasa a ser el saliente
    if (tr.kind === 'drive') {
      if (A.o) { Object.assign(B, A); B.mode = 'exit'; B.t = 0; B.s0 = A.s; B.v0 = A.v; B.yaw0 = A.yaw; trail.n = 0; trail.life = 1; reflLayer(B.o, false); }
      A.o = null; A.vis = false;
    } else { hideCar(A); hideCar(B); }
    placeCar(A, i);
    if (B.o === A.o) B.o = null;
    S.cur = i;
    const pal = paletteOf(i);
    if (tr.kind === 'drive') { A.s = -13; A.mode = 'arrive'; A.head = 1; A.brake = 0.2; sweepTo(pal, 1, 1 / 0.62); S.arriveT = -10; S.flick = false; holoU.uReveal.value = 0; }
    else { A.s = 0; A.mode = 'idle'; A.hv = -2.6; A.head = 0; sweepTo(pal, -1, 1 / 0.28); S.arriveT = 0; S.flick = true; S.flash = Math.max(S.flash, 0.32); S.flashCol.copy(pal[0]).lerp(_white, 0.3); S.flashDecay = 5.5; }
    S.idleT = 0;
    applyFxStyle(i); drawHolo(i);
    S.holoA = 1; S.holoGl = 0;
    envDirty = true;
  }

  /* ---------------- Ambientación ---------------- */
  function setCircuit(id, instant = false) {
    const m = MOOD_IDS.indexOf(id); if (m < 0) return;
    if (S.mt) { // saltamos a la mitad final si hay otra en curso
      finishMood();
    }
    if (m === S.mood) return;
    if (instant || S.t < 0.05 || S.intro || !props[S.mood] || !props[S.mood].group.visible) {
      S.mood = m; mb.from = mb.to = m; mb.w = 1; U.uMA.value = U.uMB.value = m; U.uScanOn.value = 0;
      props.forEach((p, k) => { if (p) { p.group.visible = k === m; p.group.position.y = 0; } });
      if (!props[m]) { buildProps(m).group.visible = true; }
      envDirty = true;
      return;
    }
    if (!props[m]) buildProps(m);
    S.mt = { t: 0, dur: 1.8, from: S.mood, to: m, env: false };
    U.uMA.value = S.mood; U.uMB.value = m; U.uScanOn.value = 1; U.uScan.value = 0;
    props[m].group.visible = true; props[m].group.position.y = -16;
    mb.from = S.mood; mb.to = m; mb.w = 0;
  }
  function finishMood() {
    const mt = S.mt; if (!mt) return;
    S.mood = mt.to; mb.from = mb.to = mt.to; mb.w = 1; U.uMA.value = U.uMB.value = mt.to; U.uScanOn.value = 0; U.uScan.value = 1;
    props.forEach((p, k) => { if (p) { p.group.visible = k === mt.to; p.group.position.y = 0; } });
    S.mt = null; envDirty = true;
  }
  function updateMood(dt) {
    const mt = S.mt; if (!mt) return;
    mt.t += dt;
    const s = easeInOut(mt.t / mt.dur);
    U.uScan.value = s;
    const pf = props[mt.from], pt = props[mt.to];
    if (pf) { pf.group.position.y = -easeIn(s / 0.5, 2) * 16; pf.group.visible = s < 0.5; }
    if (pt) { pt.group.position.y = -(1 - easeOut((s - 0.42) / 0.58, 3)) * 16; pt.group.visible = s > 0.42; }
    mb.w = smooth((s - 0.2) / 0.6);
    if (!mt.env && s > 0.5) { mt.env = true; envDirty = true; S.mood = mt.to; }
    if (mt.t >= mt.dur) finishMood();
  }

  /* ---------------- Intro / outro ---------------- */
  let introResolve = null, outroResolve = null;
  function intro() {
    if (outroResolve) { outroResolve(); outroResolve = null; }
    S.outro = null; S.white = 0; S.flash = 0; S.speed = 0;
    if (S.cur < 0) showCar(0, 0);
    else if (S.tr) finishTransition();
    if (!A.o) placeCar(A, S.cur);
    hideCar(B);
    A.s = 0; A.v = 0; A.mode = 'idle'; A.yaw = HERO_YAW;
    setPalNow(paletteOf(S.cur));
    S.intro = { t: 0, dur: 2.9 };
    S.arriveT = -1.45; S.idleT = 0; S.flick = true; S.drag = 0; S.dragV = 0;
    S.fxLevel = 0; S.holoA = 1; S.holoGl = 0; holoU.uReveal.value = 0; U.uSeq.value = -0.1; U.uStrip.value = 0; S.bgPower = 0.06; trail.n = 0; S.bolts.length = 0;
    if (introResolve) introResolve();
    return new Promise((res) => { introResolve = res; });
  }
  function outro() {
    if (introResolve) { introResolve(); introResolve = null; }
    S.intro = null;
    if (S.tr) finishTransition();
    if (!A.o && S.cur >= 0) placeCar(A, S.cur);
    S.outro = { t: 0, dur: 1.6, green: false, red: false, launched: false };
    if (outroResolve) outroResolve();
    return new Promise((res) => { outroResolve = res; });
  }

  /* ---------------- Encuadre ---------------- */
  function resize(w, h, coveredBottomPx = 0, o = {}) {
    w = Math.max(1, w); h = Math.max(1, h);
    const top = o.top ?? 58;
    let right = o.right;
    if (right == null) right = coveredBottomPx < 1 && w >= 900 && w / h >= 1.25 ? Math.min(470, w * 0.4) : 0;
    let y0 = top, y1 = h - Math.max(0, coveredBottomPx);
    if (y1 - y0 < 140) y0 = Math.max(0, y1 - 140);
    const x0 = 0, x1 = Math.max(160, w - right);
    const vw = x1 - x0, vh = Math.max(60, y1 - y0);
    const wide = vw / vh > 1.25;
    const Wm = wide ? 9.2 : 6.5, Hm = wide ? 5.6 : 4.6;
    const s = Math.max(Wm / vw, Hm / vh);
    view.w = w; view.h = h; view.s = s; view.vis = [x0, y0, x1, y1];
    view.cx = (x0 + x1) / 2; view.cy = y0 + vh * (wide ? 0.58 : 0.6);
    view.vfov = (2 * Math.atan((s * h) / 2 / D0) * 180) / Math.PI;
    camera.aspect = w / h;
    applyLens(1);
    const pr = renderer.getPixelRatio ? renderer.getPixelRatio() : 1;
    const rw = Math.max(64, Math.round(w * pr * reflScale)), rh = Math.max(64, Math.round(h * pr * reflScale));
    reflRT.setSize(rw, rh);
    floorU.uReflTexel.value.set(1 / rw, 1 / rh);
    overU.uVis.value.set(((x0 + x1) / w) - 1, 1 - ((y0 + y1) / h), vw / w, vh / h);
  }
  function applyLens(mul) {
    camera.fov = clamp(view.vfov * mul, 10, 120);
    camera.setViewOffset(view.w, view.h, view.w / 2 - view.cx, view.h / 2 - view.cy, view.w, view.h);
    camera.updateProjectionMatrix();
  }

  /* ---------------- Actualización ---------------- */
  const _white = new THREE.Color(1, 1, 1);
  const _cam = new THREE.Vector3(), _tg = new THREE.Vector3(), _lp = new THREE.Vector3(), _fw = new THREE.Vector3(), _tmpC = new THREE.Color(), _tmpC2 = new THREE.Color();
  const camPose = { az: 0, d: D0, h: H0, tx: 0, ty: TY, tz: 0 };
  let disposed = false;
  let preloadT = 0;

  function headFlick(t) { // patrón de encendido de faros
    if (t < 0) return 0;
    if (t > 0.42) return 1;
    const k = Math.floor(t / 0.06);
    return [1, 0, 0.7, 0, 0, 1, 0.4][k] ?? 1;
  }

  function stepCar(cs, dt) {
    if (!cs.o) return;
    const prevS = cs.s;
    if (cs.mode === 'exit') {
      cs.t += dt;
      const tt = cs.t;
      cs.s = cs.s0 + (cs.v0 + 7) * tt + 0.5 * 150 * tt * tt;
      cs.yaw = cs.yaw0 - 0.55 * easeIn(tt / 0.45, 1.6);
      cs.flame = tt < 0.35 ? (Math.sin(tt * 60) > 0 ? 1 : 0.3) : 0;
      cs.brake = 0;
      if (tt > 0.7) { hideCar(cs); return; }
    }
    const v = dt > 0 ? (cs.s - prevS) / dt : 0;
    const acc = dt > 0 ? (v - cs.vs) / dt : 0;
    cs.vs = v; cs.v = v;
    cs.acc = lerp(cs.acc, clamp(acc, -60, 60), damp(18, dt));
    // suspensión: cabeceo/altura con muelle-amortiguador
    const pT = clamp(cs.acc * 0.0012, -0.05, 0.05) + cs.shake * 0.01 * Math.sin(S.t * 31);
    cs.pv += (-(cs.pitch - pT) * 120 - cs.pv * 7.5) * dt; cs.pitch += cs.pv * dt;
    cs.hv += (-(cs.heave - (-0.012 * cs.shake)) * 140 - cs.hv * 6.5) * dt; cs.heave += cs.hv * dt;
    const rT = cs.shake * 0.012 * Math.sin(S.t * 47 + 1.3);
    cs.rv += (-(cs.roll - rT) * 160 - cs.rv * 9) * dt; cs.roll += cs.rv * dt;
    cs.spin += (v * dt) / (cs.o.wr || 0.34);
    const o = cs.o, m = o.model;
    o.holder.rotation.y = cs.yaw;
    m.root.position.set(0, 0, cs.s);
    o.body.rotation.x = cs.pitch; o.body.rotation.z = cs.roll; o.body.position.y = o.bodyY + cs.heave;
    const ws = m.wheels || [];
    for (let k = 0; k < ws.length; k++) { const w = ws[k]; if (!w) continue; if (w.spin) w.spin.rotation.x = cs.spin; if (w.steer && k < 2) w.steer.rotation.y = cs.steer; }
    try { m.setHeadlights && m.setHeadlights(cs.head); m.setBrake && m.setBrake(cs.brake); m.setFlame && m.setFlame(cs.flame); } catch (e) {}
  }

  function update(dt = 1 / 60) {
    if (disposed) return;
    dt = clamp(dt || 0, 0, 0.1);
    S.t += dt; U.uTime.value = S.t;
    updateMood(dt);

    // ---- transición de coche ----
    let azOff = 0;
    const tr = S.tr;
    if (tr) {
      tr.t += dt;
      if (tr.kind === 'drive') {
        const k = sat(tr.t / 0.24);
        S.fxLevel = Math.min(S.fxLevel, tr.fxStart * (1 - k));
        S.holoA = 1 - k * 0.9; S.holoGl = Math.sin(k * Math.PI) * 1.2 + k * 0.5;
        if (!tr.swapped && tr.t >= 0.3) doSwap(tr);
        if (tr.swapped) {
          const u = sat((tr.t - 0.3) / 0.66);
          A.s = -13 * Math.pow(1 - u, 2.2);
          A.brake = u > 0.4 ? 1 : 0.25;
          A.steer = lerp(-0.05, 0.0, u);
          const sw = sat((tr.t - 0.3) / 0.75);
          swL.position.set(lerp(9, -9, sw), 2.2, 3.2);
          swL.intensity = Math.sin(sw * Math.PI) * 18;
          if (u >= 1) { A.s = 0; S.arriveT = 0; S.idleT = 0; A.mode = 'idle'; hideCar(B); S.tr = null; swL.intensity = 0; }
        }
        azOff = -0.1 * Math.sin(Math.PI * sat(tr.t / 1.0));
      } else {
        const WA = 0.17, WB = 0.55;
        if (tr.t < WA) {
          const k = tr.t / WA;
          azOff = -tr.dir * 0.95 * easeIn(k, 2.4);
          S.whip = k; S.whipDir = tr.dir;
          S.fxLevel = Math.min(S.fxLevel, tr.fxStart * (1 - k)); S.holoA = 1 - k; S.holoGl = k * 1.5;
        } else {
          if (!tr.swapped) doSwap(tr);
          const k = sat((tr.t - WA) / WB);
          azOff = tr.dir * 0.95 * (1 - easeOut(k, 3));
          S.whip = 1 - k;
          if (k >= 1) { S.tr = null; S.whip = 0; azOff = 0; }
        }
      }
    }
    S.camAz = azOff;

    // ---- llegada: faros, holograma, efecto ----
    S.arriveT += dt;
    const at = S.arriveT;
    if (!S.tr || S.tr.swapped) {
      if (A.mode === 'idle' && !S.outro) {
        A.head = S.flick ? headFlick(at - 0.05) : 1;
        if (at < 1.2) A.brake = Math.max(0, 1 - at / 0.5);
        A.steer = lerp(A.steer, at > 0.3 ? 0.22 : 0, damp(3, dt));
      }
      if (at < 0) holoU.uReveal.value = 0;
      else if (at < 2.5) { holoU.uReveal.value = easeOut((at - 0.1) / 0.6, 2); S.holoGl = Math.max(0, 0.6 - at) * 1.2; S.holoA = 1; }
      else { holoU.uReveal.value = 1; S.holoGl = 0; }
      if (at >= 0) S.fxLevel = Math.max(S.fxLevel, smooth((at - 0.15) / 0.6));
    }
    if (S.tr && !S.tr.swapped) holoU.uReveal.value = 1;

    // ---- intro ----
    let camOverride = null;
    const rest = { az: 0.07 * Math.sin(S.t * 0.11) + 0.03 * Math.sin(S.t * 0.23 + 1.0), d: D0 + 0.18 * Math.sin(S.t * 0.07), h: H0 + 0.06 * Math.sin(S.t * 0.09), tx: 0, ty: TY, tz: 0 };
    if (S.intro) {
      const it = S.intro; it.t += dt;
      const t = it.t;
      U.uSeq.value = t < 0.25 ? -0.1 : lerp(0, 1.05, sat((t - 0.25) / 1.15));
      U.uStrip.value = easeOut((t - 0.45) / 1.2, 2);
      S.bgPower = lerp(0.06, 1, smooth((t - 0.7) / 1.5));
      S.power = 1;
      const k = easeInOut((t - 0.15) / 2.45);
      camOverride = {
        az: lerp(-0.42, rest.az, k), d: lerp(2.7, rest.d, k), h: lerp(0.42, rest.h, k),
        tx: lerp(-1.3, 0, k), ty: lerp(0.5, TY, k), tz: lerp(1.55, 0, k),
      };
      if (t > 0.25 && t < 0.32) { S.flash = Math.max(S.flash, 0.12); S.flashCol.setRGB(1, 1, 1); S.flashDecay = 6; }
      if (t >= it.dur) { S.intro = null; U.uSeq.value = 2; U.uStrip.value = 1; S.bgPower = 1; if (introResolve) { const r = introResolve; introResolve = null; r(); } }
    }
    // ---- outro ----
    if (S.outro) {
      const ot = S.outro; ot.t += dt;
      const t = ot.t;
      if (!ot.red) { ot.red = true; sweepTo(RED, 1, 1 / 0.3); S.holoGl = 1; }
      A.shake = t < 0.6 ? 0.5 + 0.5 * Math.sin(t * 9) : 0.2;
      A.brake = t < 0.55 ? 1 : 0;
      A.flame = t > 0.15 && t < 0.55 ? (Math.sin(t * 40) > 0.3 ? 1 : 0) : 0;
      A.head = 1;
      S.holoA = Math.max(0, 1 - t * 1.6);
      S.fxLevel = Math.max(0, 1 - t * 2);
      if (t >= 0.55 && !ot.green) { ot.green = true; sweepTo(GREEN, -1, 1 / 0.12); S.flash = Math.max(S.flash, 0.3); S.flashCol.setRGB(0.3, 1, 0.45); S.flashDecay = 4; }
      if (t >= 0.6 && !ot.launched && A.o) { ot.launched = true; A.mode = 'exit'; A.t = 0; A.s0 = A.s; A.v0 = -7; A.yaw0 = A.yaw + 0.35; }
      const k = easeIn((t - 0.55) / 0.95, 2.2);
      S.camRush = k; S.speed = sat((t - 0.6) / 0.6);
      S.fovMul = 1 + k * 0.45;
      if (t > 1.05) { S.white = sat((t - 1.05) / 0.45); }
      if (t >= ot.dur) { S.white = 1; if (outroResolve) { const r = outroResolve; outroResolve = null; r(); } }
    } else { S.camRush = 0; S.fovMul = lerp(S.fovMul, 1, damp(6, dt)); }

    // ---- reposo: giro lento + arrastre ----
    S.dragV *= Math.exp(-dt * 2.2);
    S.drag += S.dragV * dt;
    if (A.o && A.mode === 'idle' && !S.outro) {
      if (!S.intro && (!S.tr || S.tr.swapped)) S.idleT += dt;
      A.yaw = HERO_YAW + smooth(S.idleT / 3.5) * 0.62 * Math.sin(S.idleT * 0.3) + S.drag;
    }
    stepCar(A, dt); stepCar(B, dt);

    // ---- estela de pilotos del saliente ----
    const outC = B.o ? B : A.mode === 'exit' ? A : null;
    if (outC && outC.o) {
      const m = outC.o.model, tl = (m.lamps && m.lamps.tail) || [];
      outC.o.holder.updateMatrixWorld(true);
      if (trail.n >= 16) { trail.pts.copyWithin(0, 6); trail.n = 15; }
      for (let e = 0; e < 2; e++) { _lp.copy(tl[e] || tl[0] || _lp.set(0, 0.6, -2.3)).applyMatrix4(m.root.matrixWorld); trail.pts[trail.n * 6 + e * 3] = _lp.x; trail.pts[trail.n * 6 + e * 3 + 1] = _lp.y; trail.pts[trail.n * 6 + e * 3 + 2] = _lp.z; }
      trail.n++; trail.life = 1;
    } else { trail.life = Math.max(0, trail.life - dt * 4); if (trail.life <= 0) trail.n = 0; }

    // ---- cámara ----
    const cp = camOverride || rest;
    camPose.az = cp.az + S.camAz; camPose.d = cp.d; camPose.h = cp.h; camPose.tx = cp.tx; camPose.ty = cp.ty; camPose.tz = cp.tz;
    if (S.camRush > 0) { camPose.d = lerp(camPose.d, 1.2, S.camRush); camPose.tz = lerp(camPose.tz, -9, S.camRush); camPose.h = lerp(camPose.h, 0.8, S.camRush); camPose.ty = lerp(camPose.ty, 0.9, S.camRush); }
    _tg.set(camPose.tx, camPose.ty, camPose.tz);
    _cam.set(camPose.tx + Math.sin(camPose.az) * camPose.d, camPose.h, camPose.tz + Math.cos(camPose.az) * camPose.d);
    if (S.outro) { const sh = S.camRush * 0.04; _cam.x += Math.sin(S.t * 53) * sh; _cam.y += Math.sin(S.t * 61 + 1) * sh; }
    camera.position.copy(_cam); camera.lookAt(_tg);
    applyLens(S.fovMul);
    camera.updateMatrixWorld();
    _camP.copy(camera.position);
    U.uPScale.value = camera.projectionMatrix.elements[5] * view.h * (renderer.getPixelRatio ? renderer.getPixelRatio() : 1) * 0.5;

    // ---- barrido de color ----
    if (U.uSweep.value < 1.3) { U.uSweep.value += dt * S.sweepRate; if (U.uSweep.value >= 1.3) { U.uSweep.value = 2; U.uSweepOn.value = 0; for (let k = 0; k < 3; k++) U.uPO.value[k].copy(U.uPN.value[k]); } }
    const pal = curPal();

    // ---- ambientación: luces y colores ----
    const M0 = MOODS[mb.from], M1 = MOODS[mb.to], w = mb.w;
    const mix3 = (a, b, out) => out.setRGB(lerp(a[0], b[0], w), lerp(a[1], b[1], w), lerp(a[2], b[2], w));
    mix3(M0.key, M1.key, _tmpC); U.uKey.value.set(_tmpC.r, _tmpC.g, _tmpC.b);
    U.uPO.value[3].set(_tmpC.r, _tmpC.g, _tmpC.b); U.uPN.value[3].set(_tmpC.r, _tmpC.g, _tmpC.b);
    key.color.copy(_tmpC); key.intensity = lerp(M0.keyI, M1.keyI, w) * S.power * (0.12 + 0.88 * sat(U.uSeq.value / 0.5));
    key.position.set(lerp(M0.keyPos[0], M1.keyPos[0], w), lerp(M0.keyPos[1], M1.keyPos[1], w), lerp(M0.keyPos[2], M1.keyPos[2], w));
    top.color.copy(_tmpC);
    mix3(M0.hemiS, M1.hemiS, hemi.color); mix3(M0.hemiG, M1.hemiG, hemi.groundColor); hemi.intensity = lerp(M0.hemiI, M1.hemiI, w) * (0.12 + 0.88 * S.bgPower);
    const envK = 0.2 + 0.8 * sat(U.uSeq.value / 0.6);
    if (envK !== S.envK) { S.envK = envK; carObjs.forEach((c) => c && c.mats.forEach((m) => { m.envMapIntensity = (c.envI.get(m) ?? 1) * envK; })); }
    mix3(M0.amb, M1.amb, _tmpC); U.uAmb.value.set(_tmpC.r, _tmpC.g, _tmpC.b);
    mix3(M0.dust, M1.dust, _tmpC); dustU.uDust.value.set(_tmpC.r, _tmpC.g, _tmpC.b);
    U.uConeK.value = lerp(M0.cone, M1.cone, w) * (S.bloomOn ? 1 : 0.65);
    floorU.uReflK.value = lerp(M0.refl, M1.refl, w);
    const seqOn = (s0) => sat((U.uSeq.value - s0) / 0.03);
    top.intensity = 24 * lerp(M0.top, M1.top, w) * seqOn(0.02);
    rimA.color.copy(pal[0]); rimA.intensity = 34 * seqOn(0.1);
    rimB.color.copy(pal[1]); rimB.intensity = 34 * seqOn(0.14);
    U.uRimA.value.set(pal[0].r, pal[0].g, pal[0].b); U.uRimB.value.set(pal[1].r, pal[1].g, pal[1].b);

    // ---- efecto firma ----
    updateFx(dt, pal, M0, M1, w);

    // ---- holograma ----
    holoU.uGlitch.value = S.holoGl; holoU.uHoloA.value = S.holoA * (S.intro ? sat((S.intro.t - 1.5) / 0.3) : 1) * (S.bloomOn ? 1 : 0.62);
    if (S.intro && S.intro.t < 1.5) holoU.uReveal.value = 0;

    // ---- suelo ----
    const fu = floorU;
    fu.uTT.value = A.yaw; fu.uRingRot.value = S.t * 0.012;
    const sc = A.o ? A : B.o ? B : null;
    if (sc && sc.o) {
      const yy = sc.yaw;
      fu.uCar.value.set(Math.sin(yy) * sc.s, Math.cos(yy) * sc.s, yy, 1);
      fu.uCarDim.value.set(sc.o.halfW, sc.o.halfL, sc.o.halfT, sc.o.wr);
      fu.uCarAx.value.set(sc.o.fz, sc.o.rz);
      fu.uHead.value = sc.head;
    } else fu.uCar.value.w = 0;
    U.uPower.value = S.power; U.uBgPower.value = S.bgPower; floorU.uPoolK.value = sat(U.uSeq.value / 0.2);

    // ---- destellos de faros ----
    updateFlares();

    // ---- capa de pantalla ----
    if (S.flash > 0) S.flash = Math.max(0, S.flash - dt * S.flashDecay);
    const fl = Math.max(S.flash, S.white);
    overU.uFlash.value = fl;
    if (S.white > S.flash) overU.uFlashCol.value.setRGB(3, 3, 3); else overU.uFlashCol.value.setRGB(S.flashCol.r * 1.3, S.flashCol.g * 1.3, S.flashCol.b * 1.3);
    overU.uWhip.value = S.whip; overU.uWhipDir.value = S.whipDir || 1; overU.uSpeed.value = S.speed;
    overU.uCrt.value = S.fx === 4 ? S.fxLevel : 0;

    // ---- mapa de entorno ----
    if (envDirty) regenEnv(S.mt && !S.mt.env ? S.mt.from : S.mood, pal);

    // ---- precarga perezosa de coches ----
    if (!S.tr && !S.intro && !S.outro) {
      preloadT += dt;
      if (preloadT > 0.6) { preloadT = 0; for (let k = 0; k < NC; k++) if (!carObjs[k]) { ensureCar(k); break; } }
    }
  }

  function updateFx(dt, pal, M0, M1, w) {
    const fx = S.fx, lvl = S.fxLevel;
    ptsU.uLevel.value = lvl;
    fxPts.visible = lvl > 0.01;
    flames.visible = fx === 1 && lvl > 0.01; flameU.uLevel.value = fx === 1 ? lvl : 0;
    floorU.uGrid.value = fx === 4 ? lvl : 0;
    floorU.uHeat.value = fx === 1 ? lvl * (0.75 + 0.25 * Math.sin(S.t * 13) * Math.sin(S.t * 7.3)) : 0;
    // niebla: verde intensa para Víbora, humo tenue de plató para el resto
    const mc = _tmpC2.setRGB(lerp(M0.mist[0], M1.mist[0], w), lerp(M0.mist[1], M1.mist[1], w), lerp(M0.mist[2], M1.mist[2], w));
    if (fx === 2) mc.lerp(pal[0], lvl);
    mistU.uMistCol.value.set(mc.r, mc.g, mc.b);
    mistU.uMistK.value = fx === 2 ? lerp(0.025, LOW ? 0.26 : 0.16, lvl) : 0.025;
    // luz del efecto
    let fxI = 0; _tmpC.copy(pal[0]);
    floorU.uImp.value.z = Math.max(0, floorU.uImp.value.z - dt * 9);
    ribN = 0;
    if (lvl > 0.01) {
      if (fx === 0) fxI = fxArcs(dt, pal, lvl);
      else if (fx === 1) { fxI = (0.6 + 0.4 * Math.sin(S.t * 17) * Math.sin(S.t * 5.1)) * lvl; _tmpC.setRGB(1, 0.45, 0.12); }
      else if (fx === 2) fxI = (0.5 + 0.3 * Math.sin(S.t * 1.7)) * lvl;
      else if (fx === 3) fxI = fxLasers(dt, pal, lvl);
      else if (fx === 4) fxI = fxRetro(dt, pal, lvl);
      else fxI = fxVortex(dt, pal, lvl);
    }
    fxL.color.copy(_tmpC); fxL.intensity = fxI * FX_LIGHT[fx] * 9;
    // estela de pilotos
    if (trail.n > 2 && trail.life > 0) {
      for (let e = 0; e < 2; e++) {
        const n = Math.min(trail.n, RIB_PTS);
        for (let i = 0; i < n; i++) { const src = (trail.n - n + i) * 6 + e * 3; RP[i * 3] = trail.pts[src]; RP[i * 3 + 1] = trail.pts[src + 1]; RP[i * 3 + 2] = trail.pts[src + 2]; }
        const L = trail.life;
        ribbon(n, (u) => 0.08 + u * 0.18, 2.6, 0.12, 0.1, (u) => u * u * L * 1.4);
      }
    }
    ribbonsEnd();
  }

  // Relámpago: arcos eléctricos
  function bolt(ax, ay, az, bx, by, bz, n, amp) {
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1), env = Math.sin(u * Math.PI);
      RP[i * 3] = lerp(ax, bx, u) + (Math.random() - 0.5) * amp * env;
      RP[i * 3 + 1] = lerp(ay, by, u) + (Math.random() - 0.5) * amp * env * 0.7;
      RP[i * 3 + 2] = lerp(az, bz, u) + (Math.random() - 0.5) * amp * env;
    }
  }
  function fxArcs(dt, pal, lvl) {
    const T = S.t;
    if (T >= S.nextBolt) {
      const big = Math.random() < 0.35;
      const a0 = (Math.random() - 0.5) * 3.6;
      S.bolts.push({ big, a0, a1: a0 + (Math.random() - 0.5) * (big ? 0.6 : 0.9), t0: T, life: big ? 0.22 : 0.12, seed: 0, nextShape: 0 });
      S.nextBolt = T + (big ? 0.25 : 0.06) + Math.random() * (big ? 0.7 : 0.18);
      if (S.bolts.length > 7) S.bolts.shift();
    }
    let flash = 0;
    for (let k = S.bolts.length - 1; k >= 0; k--) {
      const b = S.bolts[k]; const age = T - b.t0;
      if (age > b.life) { S.bolts.splice(k, 1); continue; }
      const f = (1 - age / b.life) * (Math.random() < 0.25 ? 0.4 : 1) * lvl;
      const [x1, z1] = pol(3.3, b.a1);
      if (b.big) {
        const [x0, z0] = pol(2.4, b.a0);
        bolt(x0, 6.4, z0, x1, 0.03, z1, 20, 0.9);
        ribbon(20, 0.34, pal[0].r * 1.6 + 0.6, pal[0].g * 1.6 + 0.6, pal[0].b * 1.6 + 0.6, (u) => f * (0.6 + 0.4 * u));
        // ramificación
        const j = 8 + ((Math.random() * 6) | 0);
        const bx = RP[j * 3], by = RP[j * 3 + 1], bz = RP[j * 3 + 2];
        const [x2, z2] = pol(3.3 + (Math.random() - 0.5) * 1.6, b.a1 + (Math.random() - 0.5) * 0.8);
        bolt(bx, by, bz, x2, 0.03, z2, 10, 0.5);
        ribbon(10, 0.2, pal[0].r + 0.4, pal[0].g + 0.4, pal[0].b + 0.4, () => f * 0.6);
        floorU.uImp.value.set(x1, z1, 2.4 * f, 0.6);
        flash = Math.max(flash, f);
      } else {
        const [x0, z0] = pol(3.3, b.a0);
        const n = 12;
        for (let i = 0; i < n; i++) {
          const u = i / (n - 1), a = lerp(b.a0, b.a1, u), env = Math.sin(u * Math.PI);
          const rr = 3.3 + (Math.random() - 0.5) * 0.3 * env;
          RP[i * 3] = Math.sin(a) * rr; RP[i * 3 + 1] = 0.03 + env * (0.25 + Math.random() * 0.35); RP[i * 3 + 2] = -Math.cos(a) * rr;
        }
        void x0; void z0;
        ribbon(n, 0.16, pal[0].r + 0.5, pal[0].g + 0.5, pal[0].b + 0.5, () => f * 0.8);
        flash = Math.max(flash, f * 0.35);
      }
    }
    return 0.15 * lvl + flash;
  }
  // Pantera: láseres
  function fxLasers(dt, pal, lvl) {
    const T = S.t;
    const conv = smooth((Math.sin(T * 0.55) - 0.55) / 0.35); // a ratos convergen sobre el coche
    for (let e = 0; e < 2; e++) {
      const ex = e ? 4.9 : -4.9, ey = 6.9, ez = -7.2;
      for (let k = 0; k < 6; k++) {
        if (ribN >= RIB_STRIPS - 2) break;
        const ph = T * (0.6 + k * 0.07) + k * 1.1 + e * 2.3;
        let fx = (e ? -1 : 1) * 1.5 + Math.sin(ph) * 6.5, fz = Math.sin(ph * 0.73 + k) * 5.5 + 0.5;
        const cx = Math.sin(k * 1.7) * 1.1, cz = Math.cos(k * 2.3) * 1.8;
        fx = lerp(fx, cx, conv); fz = lerp(fz, cz, conv);
        const fy = lerp(0.02, 0.55, conv);
        RP[0] = ex; RP[1] = ey; RP[2] = ez; RP[3] = fx; RP[4] = fy; RP[5] = fz;
        const c = k % 2 ? pal[1] : pal[0];
        ribbon(2, 0.09, c.r * 1.4 + 0.2, c.g * 1.4 + 0.2, c.b * 1.4 + 0.2, (u) => lvl * (0.55 + 0.45 * u));
        // impacto en el suelo
        if (conv < 0.5) {
          _a.set(fx, 0.03, fz); _tc.subVectors(_camP, _a).normalize(); _sd.set(-_tc.z, 0, _tc.x).normalize().multiplyScalar(0.12);
          RP[0] = fx - _sd.x; RP[1] = 0.03; RP[2] = fz - _sd.z; RP[3] = fx + _sd.x; RP[4] = 0.03; RP[5] = fz + _sd.z;
          ribbon(2, 0.26, c.r * 2, c.g * 2, c.b * 2, () => lvl * 0.9 * (1 - conv * 2));
        }
      }
    }
    return 0.4 * lvl * (0.6 + 0.4 * conv);
  }
  // Cometa: estelas retro
  const COMETS = [0, 1, 2, 3, 4].map((k) => ({ y: 0.8 + k * 1.15, z: -4.5 - (k % 3) * 3.2, sp: 16 + k * 3.5, off: k * 0.37, len: 7 + k }));
  function fxRetro(dt, pal, lvl) {
    for (const c of COMETS) {
      const per = 36 / c.sp + 0.6;
      const ph = ((S.t + c.off * per) % per) / per;
      const hx = lerp(18, -18, ph * (36 / c.sp + 0.6) / (36 / c.sp));
      const n = 16;
      for (let i = 0; i < n; i++) { const u = i / (n - 1); RP[i * 3] = hx + (1 - u) * c.len; RP[i * 3 + 1] = c.y + Math.sin((hx + (1 - u) * c.len) * 0.35) * 0.15; RP[i * 3 + 2] = c.z; }
      const col = pal[(c.y * 10 | 0) % 2 ? 0 : 2];
      ribbon(n, (u) => 0.08 + u * 0.22, col.r * 1.6, col.g * 1.6, col.b * 1.6, (u) => lvl * u * u * 1.4);
    }
    return 0.25 * lvl;
  }
  // Tifón: espirales de viento
  function fxVortex(dt, pal, lvl) {
    for (let s = 0; s < 4; s++) {
      const n = 22;
      const a0 = S.t * 1.8 + s * (TAU / 4);
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1), h = 0.2 + u * 5.5, a = a0 - u * 2.6, r = 3.1 + u * 1.8;
        RP[i * 3] = Math.sin(a) * r; RP[i * 3 + 1] = h; RP[i * 3 + 2] = -Math.cos(a) * r;
      }
      const c = s % 2 ? pal[1] : pal[0];
      ribbon(n, (u) => 0.1 + u * 0.2, c.r * 1.2, c.g * 1.2, c.b * 1.2, (u) => lvl * Math.sin(u * Math.PI) * 0.7);
    }
    return 0.35 * lvl;
  }

  function updateFlares() {
    const LP = flareU.uLP.value, LC = flareU.uLC.value;
    for (let k = 0; k < 4; k++) LC[k].set(0, 0, 0);
    const cs = A.o ? A : null;
    if (!cs) return;
    const m = cs.o.model, lamps = m.lamps || {};
    cs.o.holder.updateMatrixWorld(true);
    _fw.set(Math.sin(cs.yaw), 0, Math.cos(cs.yaw));
    const heads = lamps.head || [], tails = lamps.tail || [];
    for (let k = 0; k < 2; k++) {
      if (heads[k]) {
        LP[k].copy(heads[k]).applyMatrix4(m.root.matrixWorld);
        _tc.subVectors(_camP, LP[k]).normalize();
        const f = Math.pow(Math.max(0, _fw.dot(_tc)), 2.5) * cs.head * 1.6;
        LC[k].set(1.0 * f, 0.95 * f, 0.85 * f);
      }
      if (tails[k]) {
        LP[k + 2].copy(tails[k]).applyMatrix4(m.root.matrixWorld);
        _tc.subVectors(_camP, LP[k + 2]).normalize();
        const f = Math.pow(Math.max(0, -_fw.dot(_tc)), 2) * (0.25 + cs.brake * 1.2);
        LC[k + 2].set(1.6 * f, 0.08 * f, 0.08 * f);
      }
    }
  }

  /* ---------------- Interacción ---------------- */
  /** Arrastre opcional del usuario (px de desplazamiento horizontal desde el último evento). */
  function drag(dxPx) { S.dragV += (dxPx || 0) * 0.02; S.dragV = clamp(S.dragV, -6, 6); }

  /* ---------------- Limpieza ---------------- */
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (introResolve) { introResolve(); introResolve = null; }
    if (outroResolve) { outroResolve(); outroResolve = null; }
    carObjs.forEach((c) => { if (!c) return; scene.remove(c.holder); c.holder.remove(c.model.root); try { c.model.dispose && c.model.dispose(); } catch (e) {} });
    carObjs.forEach((c) => c && c.envI.forEach((v, m) => { m.envMapIntensity = v; }));
    origEnv.forEach((env, m) => { m.envMap = env; });
    props.forEach((p) => { if (p) { p.mesh.geometry.dispose(); if (p.rays) p.rays.geometry.dispose(); } });
    disposables.forEach((d) => { try { d.dispose(); } catch (e) {} });
    envScene.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    if (envRT) envRT.dispose();
    pmrem.dispose();
    scene.clear();
  }

  // estado inicial
  buildProps(S.mood).group.visible = true;
  U.uMA.value = U.uMB.value = S.mood;
  mb.from = mb.to = S.mood;
  if (cars.length) showCar(0, 0);
  resize(typeof innerWidth !== 'undefined' ? innerWidth : 390, typeof innerHeight !== 'undefined' ? innerHeight : 844, 0);

  const api = {
    scene, camera,
    setCircuit, showCar, update, resize, intro, outro, dispose, drag,
    get current() { return S.cur; },
    get circuit() { return MOOD_IDS[S.mood]; },
    get busy() { return !!(S.tr || S.intro || S.outro || S.mt); },
    /** Sugerencias para el integrador (exposición y bloom de esta ambientación). */
    get env() { const M = MOODS[S.mood]; return { exposure: M.exposure, bloom: M.bloom, background: scene.background }; },
    /** Ajuste del halo falso cuando no hay bloom real. */
    setBloom(on) { S.bloomOn = !!on; U.uHaloK.value = on ? 0.22 : 0.5; },
    debug: { S, U, A, B, props, ensureCar, view },
  };
  return api;
}
