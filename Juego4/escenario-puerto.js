/* =========================================================================
   GRAN PREMIO NEÓN · Escenario «Puerto Marina»
   Hora azul en un puerto mediterráneo ficticio: agua con reflejos, yates en
   movimiento, crucero iluminado, pantalanes, paseo de palmeras, casas en
   terrazas que trepan la colina, casino con cúpula dorada, Hotel Miramar
   sobre el túnel, faro con haz giratorio, tribuna en la recta del puerto,
   balcones con público, banderines, barcaza de fuegos artificiales.
   No dibuja asfalto, pianos ni barreras (pista.js). No crea luces globales
   (el integrador crea hemisferio + luna con env.ambient).
   API: buildScenery({ scene, renderer, track, tier, envMap, rain }) → ver CONTRATO §4.
   ========================================================================= */
import * as THREE from 'three';
import LAYOUT from './pistas/puerto.js';

const TIERS = {
  high: { cell: 6, crowd: 1900, palms: 1, lamps: 30, bunting: true, flags: true, wakes: true, jets: true, fill: 1, rocks: 1, clouds: 1, strings: true, rainN: 1800 },
  med: { cell: 6, crowd: 1100, palms: 0.8, lamps: 34, bunting: true, flags: true, wakes: true, jets: true, fill: 0.8, rocks: 0.6, clouds: 1, strings: true, rainN: 1100 },
  low: { cell: 9, crowd: 420, palms: 0.55, lamps: 40, bunting: false, flags: false, wakes: false, jets: false, fill: 0.55, rocks: 0.3, clouds: 0, strings: false, rainN: 600 },
};

// ---------------------------------------------------------------- utilidades
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hex = (h, k = 1) => { const c = new THREE.Color(h); return [c.r * k, c.g * k, c.b * k]; };

const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _m = new THREE.Matrix4(), _m3 = new THREE.Matrix3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
/** Matriz TRS (rotación Y·X·Z). */
function M(x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) {
  _e.set(rx, ry, rz, 'YXZ'); _q.setFromEuler(_e);
  return _m.compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz));
}

/** Acumulador de geometría fusionada (posición, normal, color, uv + atributos extra). */
class Batch {
  constructor(extra = {}) {
    this.p = []; this.n = []; this.c = []; this.uv = []; this.ex = {};
    for (const k in extra) this.ex[k] = { size: extra[k], a: [] };
  }
  get count() { return this.p.length / 3; }
  _push(px, py, pz, nx, ny, nz, col, u, v, ex) {
    this.p.push(px, py, pz); this.n.push(nx, ny, nz); this.c.push(col[0], col[1], col[2]); this.uv.push(u, v);
    for (const k in this.ex) {
      const e = this.ex[k], val = ex && ex[k] != null ? ex[k] : 0;
      if (e.size === 1) e.a.push(typeof val === 'number' ? val : val[0]);
      else for (let j = 0; j < e.size; j++) e.a.push(typeof val === 'number' ? val : val[j] ?? 0);
    }
  }
  /** Añade una geometría plantilla (indexada o no) transformada por m. col: [r,g,b] o fn(wx,wy,wz,nx,ny,nz,ly) */
  add(geo, m, col, ex) {
    const P = geo.attributes.position, Nn = geo.attributes.normal, UV = geo.attributes.uv;
    _m3.getNormalMatrix(m);
    const idx = geo.index ? geo.index.array : null, cnt = idx ? idx.length : P.count;
    const fn = typeof col === 'function';
    for (let k = 0; k < cnt; k++) {
      const i = idx ? idx[k] : k;
      _a.fromBufferAttribute(P, i); const ly = _a.y; _a.applyMatrix4(m);
      if (Nn) _b.fromBufferAttribute(Nn, i).applyMatrix3(_m3).normalize(); else _b.set(0, 1, 0);
      const cc = fn ? col(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, ly) : col;
      this._push(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, cc, UV ? UV.getX(i) : 0, UV ? UV.getY(i) : 0, typeof ex === 'function' ? ex(ly) : ex);
    }
  }
  /** Triángulo en coordenadas de mundo con normal plana. */
  tri(a, b, c, col, ex, uvs) {
    _a.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]); _b.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]); _c.crossVectors(_a, _b).normalize();
    const nx = _c.x, ny = _c.y, nz = _c.z;
    this._push(a[0], a[1], a[2], nx, ny, nz, col, uvs ? uvs[0] : 0, uvs ? uvs[1] : 0, ex);
    this._push(b[0], b[1], b[2], nx, ny, nz, col, uvs ? uvs[2] : 0, uvs ? uvs[3] : 0, ex);
    this._push(c[0], c[1], c[2], nx, ny, nz, col, uvs ? uvs[4] : 0, uvs ? uvs[5] : 0, ex);
  }
  quad(a, b, c, d, col, ex, uv) { // a-b-c-d en sentido antihorario visto desde fuera
    this.tri(a, b, c, col, ex, uv ? [uv[0], uv[1], uv[2], uv[3], uv[4], uv[5]] : null);
    this.tri(a, c, d, col, ex, uv ? [uv[0], uv[1], uv[4], uv[5], uv[6], uv[7]] : null);
  }
  build(opts = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    if (opts.normal !== false) g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    if (opts.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    for (const k in this.ex) g.setAttribute(k, new THREE.Float32BufferAttribute(this.ex[k].a, this.ex[k].size));
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------- shaders
const FOG_FADE = /* glsl */ `
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogF = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
  #else
    float fogF = 0.0;
  #endif`;
const HASH = /* glsl */ `
  float h21(vec2 p){ p = fract(p * vec2(233.34, 851.73)); p += dot(p, p + 23.45); return fract(p.x * p.y); }
  float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }`;
const END = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>`;

const BUILD_VS = /* glsl */ `
  attribute vec4 aWin;
  varying vec3 vCol; varying vec3 vN; varying vec2 vUv; flat varying vec4 vWin;
  #include <fog_pars_vertex>
  void main(){
    vCol = color; vN = normal; vUv = uv; vWin = aWin;
    vec4 mvPosition = viewMatrix * modelMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const BUILD_FS = /* glsl */ `
  uniform vec3 uSky; uniform vec3 uGround; uniform vec3 uWarm; uniform float uWet; uniform float uLit;
  varying vec3 vCol; varying vec3 vN; varying vec2 vUv; flat varying vec4 vWin;
  #include <fog_pars_fragment>
  ${HASH}
  void main(){
    vec3 n = normalize(vN);
    vec3 amb = mix(uGround, uSky, n.y * 0.5 + 0.5);
    float face = 0.8 + 0.2 * dot(n.xz, vec2(-0.55, -0.83));
    vec3 base = vCol;
    vec3 col = base * amb * face;
    vec3 em = vec3(0.0);
    float wall = 1.0 - step(0.55, abs(n.y));
    float style = floor(vWin.z);
    if (vWin.x > 0.0 && wall > 0.5 && vUv.y > 0.0) {
      float lit = fract(vWin.z);
      float nC = floor(vWin.w); float seed = fract(vWin.w) * 97.0;
      vec2 c = vUv / vWin.xy; vec2 id = floor(c); vec2 f = fract(c);
      if (id.x >= 0.0 && id.x < nC) {
        float r1 = h21(id + seed), r2 = h21(id * 1.37 + seed + 7.1), r3 = h21(id.yx * 0.73 + seed * 1.9);
        vec4 R = vec4(0.28, 0.3, 0.72, 0.84);
        if (style == 1.0) R = vec4(0.1, 0.16, 0.9, 0.9);
        else if (style == 2.0) R = vec4(0.25, 0.38, 0.75, 0.74);
        else if (style == 3.0) R = vec4(0.24, 0.12, 0.76, 0.9);
        else if (style == 4.0) R = vec4(0.04, 0.12, 0.96, 0.92);
        bool shop = (style == 0.0 && id.y < 1.0);
        if (shop) R = vec4(0.06, 0.03, 0.94, 0.7);
        float inW = step(R.x, f.x) * step(f.x, R.z) * step(R.y, f.y) * step(f.y, R.w);
        if (style == 3.0 && f.y > R.w - 0.26) inW *= step(length((f - vec2(0.5, R.w - 0.26)) / vec2(0.26, 0.26)), 1.0);
        float on = step(1.0 - (shop ? min(lit + 0.3, 0.95) : lit), r1);
        vec3 wc = mix(vec3(1.0, 0.48, 0.16), vec3(1.0, 0.78, 0.48), r2);
        if (r3 > 0.94) wc = vec3(0.45, 0.65, 1.0);
        if (style == 2.0) wc = mix(vec3(1.0, 0.82, 0.55), vec3(0.85, 0.92, 1.0), r2);
        if (style == 4.0) wc = mix(vec3(1.0, 0.9, 0.75), vec3(0.8, 0.9, 1.0), r2);
        float inten = (0.7 + 1.25 * r2 * r2) * uLit;
        vec3 glass = vec3(0.008, 0.011, 0.02) + uSky * (0.05 + 0.12 * r3);
        vec3 shut = base * 0.42 * amb * vec3(0.75, 0.95, 0.8);
        vec3 winc = (style == 0.0 && r2 > 0.62) ? shut : glass;
        float g = 1.0 - 0.45 * length((f - vec2(0.5, 0.42)) * vec2(1.1, 1.5));
        col = mix(col, winc, inW * (1.0 - on));
        col *= 1.0 - inW * on;
        em += wc * inten * g * inW * on;
        if (style <= 1.0 && !shop) { float bal = step(f.y, 0.085) * step(0.4, h21(vec2(id.y, seed))); col = mix(col, base * amb * 0.3, bal); }
        if (shop) { float aw = step(0.74, f.y) * step(f.y, 0.93); vec3 ac = mix(vec3(0.55, 0.08, 0.06), vec3(0.08, 0.28, 0.5), step(0.5, h21(vec2(id.x, seed)))); ac = mix(ac, vec3(0.6, 0.55, 0.4), step(0.8, h21(vec2(seed, id.x)))); col = mix(col, ac * (amb + uWarm * 0.7), aw); }
      }
    }
    float up = (style == 3.0 ? 1.35 : 1.0) * (exp(-max(vUv.y, 0.0) * 0.16) * 0.55 + 0.12);
    col += base * uWarm * up * wall;
    if (n.y > 0.55) col = base * amb * 0.95;
    col *= 1.0 - 0.18 * uWet;
    col += em;
    gl_FragColor = vec4(col, 1.0);
    ${END}
  }`;

const GLOW_VS = /* glsl */ `
  attribute vec3 aS;
  uniform float uScale; uniform float uTime; uniform float uBoost;
  varying vec3 vC;
  #include <fog_pars_vertex>
  void main(){
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float b = 1.0;
    if (aS.y > 0.0) b = 0.08 + 0.92 * step(0.55, fract(uTime * aS.y + aS.z));
    else if (aS.y < 0.0) b = 0.75 + 0.25 * sin(uTime * -aS.y + aS.z * 6.28);
    vC = color * b;
    gl_PointSize = clamp(aS.x * uBoost * uScale / max(-mvPosition.z, 0.5), 0.0, 384.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const GLOW_FS = /* glsl */ `
  varying vec3 vC;
  #include <fog_pars_fragment>
  void main(){
    vec2 c = gl_PointCoord * 2.0 - 1.0; float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    float a = exp(-r2 * 4.5) * 0.55 + exp(-r2 * 28.0) * 1.1;
    a *= 1.0 - r2;
    ${FOG_FADE}
    gl_FragColor = vec4(vC * a * (1.0 - fogF * 0.82), 1.0);
  }`;

const POOL_VS = /* glsl */ `
  varying vec3 vC; varying vec2 vUv;
  #include <fog_pars_vertex>
  void main(){ vC = color; vUv = uv; vec4 mvPosition = viewMatrix * modelMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const POOL_FS = /* glsl */ `
  uniform float uWet;
  varying vec3 vC; varying vec2 vUv;
  #include <fog_pars_fragment>
  void main(){
    vec2 c = vUv * 2.0 - 1.0; float r2 = dot(c, c);
    float a = max(1.0 - r2, 0.0); a = a * a * (1.0 + uWet * 0.7);
    ${FOG_FADE}
    gl_FragColor = vec4(vC * a * (1.0 - fogF), 1.0);
  }`;

const STREAK_VS = /* glsl */ `
  attribute vec3 aC; attribute vec3 aQ; attribute vec2 aW;
  uniform float uWind; uniform float uWet;
  varying vec3 vC; varying vec2 vQ; varying float vLen;
  #include <fog_pars_vertex>
  void main(){
    vec2 toCam = cameraPosition.xz - aC.xz; float D = max(length(toCam), 0.01); vec2 dir = toCam / D;
    vec2 perp = vec2(-dir.y, dir.x);
    float hL = max(aC.y - aW.x, 0.3), hC = max(cameraPosition.y - aW.x, 0.4);
    float mirror = D * hL / (hL + hC);
    bool ground = aQ.z > 0.5;
    float rough = ground ? 0.7 : (0.75 + uWind * 1.1);
    float len = clamp(mirror * 1.5 * rough + 2.0, 2.0, ground ? 16.0 : 85.0);
    float start = max(mirror - len * 0.5, 0.0);
    float along = start + aQ.x * len;
    vec2 xz = aC.xz + dir * min(along, D - 1.0) + perp * aQ.y * aW.y * (0.55 + 0.45 * aQ.x);
    vec4 mvPosition = viewMatrix * vec4(xz.x, aW.x + (ground ? 0.07 : 0.04), xz.y, 1.0);
    vC = color * (ground ? uWet : 1.0);
    vQ = aQ.xy; vLen = len;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const STREAK_FS = /* glsl */ `
  uniform float uTime;
  varying vec3 vC; varying vec2 vQ; varying float vLen;
  #include <fog_pars_fragment>
  void main(){
    float s = 1.0 - abs(vQ.y); s *= s;
    float l = pow(max(sin(3.14159 * clamp(vQ.x, 0.0, 1.0)), 0.0), 0.6);
    float m = vQ.x * vLen;
    float sh = 0.45 + 0.55 * sin(m * 5.3 - uTime * 4.1 + vQ.y * 3.0) * sin(m * 2.1 + uTime * 1.7);
    ${FOG_FADE}
    gl_FragColor = vec4(vC * s * l * max(sh, 0.0) * (1.0 - fogF), 1.0);
  }`;

const SWAY_VS = /* glsl */ `
  attribute vec3 aSway; attribute float aLit;
  uniform float uTime; uniform float uWind; uniform vec3 uAmb; uniform vec3 uWarmLit;
  varying vec3 vC;
  #include <fog_pars_vertex>
  void main(){
    vec3 p = position;
    float amp = aSway.x * (0.3 + uWind * 1.4);
    float s = sin(uTime * aSway.z + aSway.y) + 0.35 * sin(uTime * aSway.z * 2.3 + aSway.y * 1.7);
    p.x += s * amp; p.z += cos(uTime * aSway.z * 0.8 + aSway.y) * amp * 0.45; p.y -= abs(s) * amp * 0.2;
    vec3 n = normalize(normal);
    float l = 0.6 + 0.4 * abs(n.y);
    vC = color * (uAmb * l + uWarmLit * aLit);
    vec4 mvPosition = viewMatrix * modelMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const SWAY_FS = /* glsl */ `
  varying vec3 vC;
  #include <fog_pars_fragment>
  void main(){ gl_FragColor = vec4(vC, 1.0);
    ${END}
  }`;

const CROWD_VS = /* glsl */ `
  attribute float aPart;
  uniform float uTime; uniform float uExcite; uniform vec3 uAmb; uniform vec3 uWarmLit;
  varying vec3 vC;
  #include <fog_pars_vertex>
  void main(){
    vec3 p = position;
    vec4 ip = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float ph = fract(sin(dot(ip.xz, vec2(12.9898, 78.233))) * 43758.5453);
    float t = uTime * (2.2 + ph * 2.6) + ph * 6.2831;
    float ex = uExcite * step(0.3, ph);
    p.y += max(0.0, sin(t)) * 0.17 * ex;
    if (aPart > 2.5) { float wv = ex * (0.55 + 0.45 * sin(t * 1.7)); p.y += wv * 0.78; p.x *= 1.0 + wv * 0.7; }
    vec3 c = instanceColor;
    if (aPart > 0.5 && aPart < 1.5) c = mix(vec3(0.86, 0.63, 0.5), vec3(0.4, 0.26, 0.17), ph);
    if (aPart > 1.5) c = mix(c, vec3(0.8, 0.6, 0.47), 0.35);
    vec3 n = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
    float l = 0.45 + 0.35 * max(n.y, 0.0) + 0.25 * max(dot(n, vec3(0.0, 0.2, 0.98)), 0.0);
    float fl = step(0.9975, fract(sin(ph * 91.7 + floor(uTime * 7.0) * 3.17) * 43758.5)) * (0.25 + uExcite) * step(aPart, 0.5);
    vC = c * (uAmb * l + uWarmLit) + vec3(4.0) * fl;
    vec4 mvPosition = viewMatrix * modelMatrix * instanceMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;

const WATER_VS = /* glsl */ `
  varying vec3 vW;
  #include <fog_pars_vertex>
  void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vec4 mvPosition = viewMatrix * w; gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const WATER_FS = /* glsl */ `
  uniform float uTime; uniform float uWind; uniform float uRain; uniform float uQ;
  uniform vec3 uZen; uniform vec3 uHor; uniform vec3 uGlow; uniform vec2 uGlowDir; uniform vec3 uDeep;
  varying vec3 vW;
  #include <fog_pars_fragment>
  ${HASH}
  vec2 wv(vec2 p, vec2 d, float k, float sp, float a){ return d * (a * k * cos(dot(p, d) * k + uTime * sp)); }
  void main(){
    vec3 V = normalize(cameraPosition - vW);
    float dist = length(cameraPosition - vW);
    vec2 p = vW.xz;
    float A = 0.55 + uWind * 1.6;
    vec2 g = wv(p, vec2(0.94, 0.33), 0.19, 1.2, 0.06 * A) + wv(p, vec2(-0.37, 0.93), 0.33, 1.6, 0.035 * A);
    if (uQ > 0.5) {
      g += wv(p, vec2(0.8, -0.6), 0.81, 2.5, 0.014 * A) + wv(p, vec2(-0.98, -0.2), 1.63, 3.3, 0.007 * A);
      g += (vec2(vnoise(p * 0.9 + uTime * 0.35), vnoise(p * 0.9 - uTime * 0.31 + 17.0)) - 0.5) * 0.05 * A;
    }
    if (uRain > 0.01) { vec2 q = p * 2.7; vec2 id = floor(q); vec2 f = fract(q) - 0.5; float ph = fract(uTime * 1.3 + h21(id)); float r = length(f); g += f / max(r, 0.01) * sin((r - ph * 0.5) * 40.0) * (1.0 - ph) * step(r, 0.5) * 0.06 * uRain; }
    g /= 1.0 + dist * 0.006;
    vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
    vec3 R = reflect(-V, N);
    float h = max(R.y, 0.0);
    vec3 sky = mix(uHor, uZen, pow(h, 0.45));
    vec2 rz = normalize(R.xz + vec2(1e-4));
    sky += uGlow * pow(max(dot(rz, uGlowDir), 0.0), 4.0) * exp(-h * 7.0);
    float city = smoothstep(0.05, 0.55, rz.y) * (1.0 - smoothstep(0.015, 0.13, h));
    float az = atan(rz.x, rz.y);
    vec2 cell = vec2(az * 140.0, h * 150.0);
    float sp = step(0.82, h21(floor(cell))) * step(0.3, fract(cell.x)) * step(0.25, fract(cell.y));
    vec3 cc = vec3(0.012, 0.014, 0.024) + vec3(1.0, 0.58, 0.26) * sp * 0.9;
    sky = mix(sky, cc, city * 0.9);
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    vec3 col = mix(uDeep, sky, clamp(fres + 0.06, 0.0, 1.0));
    gl_FragColor = vec4(col, 1.0);
    ${END}
  }`;

const SKY_VS = /* glsl */ `
  varying vec3 vDir;
  void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`;
const SKY_FS = /* glsl */ `
  uniform vec3 uZen; uniform vec3 uMid; uniform vec3 uHor; uniform vec3 uGlow; uniform vec3 uGlow2; uniform vec2 uGlowDir;
  uniform vec3 uMoon; uniform float uTime; uniform float uRain; uniform float uClouds;
  varying vec3 vDir;
  ${HASH}
  float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
  void main(){
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = mix(uHor, uMid, smoothstep(0.0, 0.2, h));
    col = mix(col, uZen, smoothstep(0.16, 0.8, h));
    vec2 dz = normalize(d.xz + vec2(1e-4));
    float gA = max(dot(dz, uGlowDir), 0.0);
    float gl = pow(gA, 3.0);
    float hp = max(h, 0.0);
    col += uGlow * gl * exp(-hp * 10.0) * 1.15 + uGlow2 * pow(gA, 1.5) * exp(-hp * 3.2) * 0.45;
    // estrellas
    vec3 sd = d * 260.0; vec3 id = floor(sd); vec3 fr = fract(sd) - 0.5;
    float rs = h21(id.xy + id.z * 7.13);
    float st = step(0.985, rs) * smoothstep(0.32, 0.0, length(fr)) * (0.6 + 0.4 * sin(uTime * (1.0 + rs * 3.0) + rs * 40.0));
    col += vec3(0.85, 0.9, 1.0) * st * smoothstep(0.12, 0.55, h) * (1.0 - uRain) * 0.9;
    // luna creciente
    float md = acos(clamp(dot(d, uMoon), -1.0, 1.0));
    vec3 mo = normalize(uMoon + vec3(uGlowDir.x, 0.0, uGlowDir.y) * 0.012);
    float md2 = acos(clamp(dot(d, mo), -1.0, 1.0));
    float disc = smoothstep(0.019, 0.016, md) * (1.0 - smoothstep(0.018, 0.015, md2) * 0.92);
    col += vec3(1.0, 0.95, 0.82) * disc * 1.6 * (1.0 - uRain);
    col += vec3(0.5, 0.6, 0.85) * exp(-md * 18.0) * 0.12 * (1.0 - uRain);
    // nubes altas teñidas por el resplandor
    if (uClouds > 0.5 && h > 0.0) {
      vec2 cp = d.xz / (h + 0.18) * 1.6 + vec2(uTime * 0.004, 0.0);
      float c = fbm(cp * vec2(0.7, 2.2));
      float cl = smoothstep(0.52 - uRain * 0.3, 0.86, c) * smoothstep(0.015, 0.12, h) * (1.0 - smoothstep(0.45, 0.85, h) * (1.0 - uRain));
      vec3 cc = mix(vec3(0.07, 0.09, 0.17), vec3(0.95, 0.5, 0.42), gl * exp(-hp * 2.0));
      cc = mix(cc, vec3(0.12, 0.13, 0.16), uRain);
      col = mix(col, cc, cl * 0.8);
    }
    col = mix(col, mix(vec3(0.07, 0.085, 0.12), vec3(0.16, 0.17, 0.2), smoothstep(0.4, -0.05, h)) + uGlow * gl * exp(-hp * 8.0) * 0.12, uRain * 0.88);
    if (h < 0.0) col = mix(col, uHor, smoothstep(0.0, -0.04, h));
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const HILL_VS = /* glsl */ `
  attribute vec2 aH; varying vec2 vH; varying vec3 vCol;
  void main(){ vH = aH; vCol = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const HILL_FS = /* glsl */ `
  uniform vec3 uHaze; uniform float uTime; uniform float uRain;
  varying vec2 vH; varying vec3 vCol;
  ${HASH}
  void main(){
    float v = vH.y;
    vec3 col = mix(uHaze, vCol, 0.25 + 0.45 * v);
    vec2 cell = vec2(vH.x * 1400.0, v * 34.0);
    vec2 id = floor(cell); vec2 f = fract(cell) - 0.5;
    float r = h21(id);
    float dens = mix(0.955, 0.995, smoothstep(0.05, 0.7, v));
    float lt = step(dens, r) * smoothstep(0.35, 0.05, length(f * vec2(1.0, 0.6)));
    vec3 lc = mix(vec3(1.0, 0.62, 0.3), vec3(1.0, 0.85, 0.6), h21(id + 3.1));
    col += lc * lt * (0.75 + 0.25 * sin(uTime * 2.0 + r * 50.0)) * (1.0 - v * 0.7) * 0.55 * (1.0 - uRain * 0.5);
    col = mix(col, uHaze, uRain * 0.45);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const BEAM_VS = /* glsl */ `
  varying vec2 vUv; varying float vD; varying float vF;
  void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vD = -mv.z;
    vec3 nv = normalize(normalMatrix * normal); vF = abs(dot(nv, normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv; }`;
const BEAM_FS = /* glsl */ `
  uniform float uI; uniform float uRain;
  varying vec2 vUv; varying float vD; varying float vF;
  void main(){
    float along = vUv.y;
    float a = pow(1.0 - along, 2.2) * pow(vF, 2.0) * uI * (1.0 + uRain * 0.8);
    gl_FragColor = vec4(vec3(1.0, 0.9, 0.7) * a * 0.075 * smoothstep(4.0, 40.0, vD), 1.0);
  }`;

const JET_VS = /* glsl */ `
  varying vec2 vUv;
  #include <fog_pars_vertex>
  void main(){ vUv = uv; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const JET_FS = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  #include <fog_pars_fragment>
  void main(){
    float s = 1.0 - abs(vUv.x * 2.0 - 1.0);
    float flow = 0.55 + 0.45 * sin(vUv.y * 38.0 - uTime * 14.0);
    float a = s * s * flow * (1.0 - vUv.y * 0.7) * smoothstep(0.0, 0.05, vUv.y);
    ${FOG_FADE}
    gl_FragColor = vec4(vec3(0.55, 0.85, 1.0) * a * 0.8 * (1.0 - fogF), 1.0);
  }`;

const WAKE_VS = /* glsl */ `
  varying vec2 vUv;
  #include <fog_pars_vertex>
  void main(){ vUv = uv; vec4 mvPosition = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const WAKE_FS = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  #include <fog_pars_fragment>
  ${HASH}
  void main(){
    float x = vUv.x * 2.0 - 1.0; float y = vUv.y;
    float vee = abs(abs(x) - y * 0.85);
    float a = smoothstep(0.16, 0.0, vee) * (1.0 - y) + smoothstep(0.35, 0.0, abs(x)) * (1.0 - y) * 0.6;
    a *= 0.6 + 0.4 * vnoise(vec2(x * 8.0, y * 20.0 - uTime * 3.0));
    a *= smoothstep(0.0, 0.06, y);
    ${FOG_FADE}
    gl_FragColor = vec4(vec3(0.55, 0.6, 0.66) * a * 0.55 * (1.0 - fogF), 1.0);
  }`;

const RAIN_VS = /* glsl */ `
  attribute vec4 aR;
  uniform float uTime; uniform float uWind;
  varying float vA;
  void main(){
    vec3 box = vec3(70.0, 40.0, 70.0);
    vec3 o = aR.xyz * box;
    o.y -= uTime * 24.0 * (0.85 + aR.w * 0.3);
    o.x += uTime * (2.0 + uWind * 9.0);
    vec3 base = cameraPosition - box * 0.5;
    vec3 p = base + mod(o - base, box);
    vec3 dirv = normalize(vec3(0.06 + uWind * 0.35, -1.0, 0.03));
    p += dirv * position.y * (0.55 + aR.w * 0.5);
    vec4 mv = viewMatrix * vec4(p, 1.0);
    vA = (1.0 - position.y) * smoothstep(60.0, 3.0, -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;
const RAIN_FS = /* glsl */ `
  uniform float uI; varying float vA;
  void main(){ gl_FragColor = vec4(vec3(0.55, 0.62, 0.75) * vA * uI * 0.32, 1.0); }`;

// ================================================================= MAIN
export function buildScenery({ scene, renderer, track: T, tier = 'med', envMap = null, rain = true } = {}) {
  const tStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const Q = TIERS[tier] || TIERS.med;
  const TM = {}; let tmLast = tStart; const tick = (k) => { const n = typeof performance !== 'undefined' ? performance.now() : Date.now(); TM[k] = Math.round(n - tmLast); tmLast = n; };
  const rnd = mulberry(20261103);
  const R = (a, b) => a + (b - a) * rnd();
  const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
  const group = new THREE.Group(); group.name = 'escenario-puerto';
  const U = {
    uTime: { value: 0 }, uWind: { value: 0.15 }, uWet: { value: 0 }, uRain: { value: 0 }, uExcite: { value: 0.3 },
    uScale: { value: 500 }, uBoost: { value: 1 },
    uSky: { value: new THREE.Color(0.19, 0.23, 0.38) }, uGround: { value: new THREE.Color(0.1, 0.085, 0.095) },
    uWarm: { value: new THREE.Color(0.62, 0.36, 0.15) }, uLit: { value: 1.0 },
    uAmb: { value: new THREE.Color(0.2, 0.25, 0.4) }, uWarmLit: { value: new THREE.Color(0.75, 0.48, 0.24) },
  };
  const PAL = {
    zen: new THREE.Color(0.005, 0.014, 0.055), mid: new THREE.Color(0.026, 0.066, 0.18), hor: new THREE.Color(0.085, 0.115, 0.22),
    glow: new THREE.Color(0.95, 0.4, 0.17), glow2: new THREE.Color(0.32, 0.14, 0.3), deep: new THREE.Color(0.004, 0.016, 0.03),
  };
  const GLOW_DIR = new THREE.Vector2(-0.62, -0.78).normalize(); // resplandor del ocaso: suroeste, sobre el mar
  const MOON_DIR = new THREE.Vector3(0.55, 0.42, -0.72).normalize();
  const FOG_DRY = new THREE.Color(0.06, 0.082, 0.165), FOG_WET = new THREE.Color(0.085, 0.095, 0.125);
  const FOG_D = 0.0012;

  // ------------------------------------------------------------ pista
  const N = T.N, L = T.L, DS = T.ds || T.L / T.N;
  const TX = T.x, TY = T.y, TZ = T.z, NX = T.nx, NZ = T.nz, TTX = T.tx, TTZ = T.tz;
  const W = T.w || new Float32Array(N).fill(LAYOUT.halfWidth || 7.5);
  const RW = T.runoffW || new Float32Array(N).fill(3);
  const WALL_L = T.wallL || Float32Array.from(W, (w, i) => w + RW[i]);
  const WALL_R = T.wallR || Float32Array.from(W, (w, i) => w + RW[i]);
  const wallOf = (i, side) => (side > 0 ? WALL_L[i] : WALL_R[i]);
  function at(s, o = {}) {
    let u = s / DS; u -= Math.floor(u / N) * N; let i = u | 0; if (i >= N) i = 0; const f = u - i, j = (i + 1) % N;
    o.x = TX[i] + (TX[j] - TX[i]) * f; o.y = TY[i] + (TY[j] - TY[i]) * f; o.z = TZ[i] + (TZ[j] - TZ[i]) * f;
    o.tx = TTX[i]; o.tz = TTZ[i]; o.nx = NX[i]; o.nz = NZ[i]; o.i = i; o.wl = WALL_L[i]; o.wr = WALL_R[i]; o.w = W[i];
    return o;
  }
  const yawAlong = (o) => Math.atan2(o.tx, o.tz);     // +Z local = tangente
  const yawAcross = (o) => Math.atan2(-o.tz, o.tx);   // +X local = tangente, +Z local = derecha (−n)
  const CS = 16;
  let gx0 = 1e9, gz0 = 1e9, gx1 = -1e9, gz1 = -1e9;
  for (let i = 0; i < N; i++) { gx0 = Math.min(gx0, TX[i]); gx1 = Math.max(gx1, TX[i]); gz0 = Math.min(gz0, TZ[i]); gz1 = Math.max(gz1, TZ[i]); }
  const GI0 = Math.floor(gx0 / CS), GJ0 = Math.floor(gz0 / CS), GW = Math.floor(gx1 / CS) - GI0 + 1, GH = Math.floor(gz1 / CS) - GJ0 + 1;
  const HG = new Array(GW * GH);
  for (let i = 0; i < N; i++) { const k = (Math.floor(TZ[i] / CS) - GJ0) * GW + (Math.floor(TX[i] / CS) - GI0); (HG[k] || (HG[k] = [])).push(i); }
  const NR = { d: 1e9, i: 0, side: 1, wall: 10, y: 0, lat: 0 };
  function near(x, z, Rm = 60) {
    const r = Math.ceil(Rm / CS), cx = Math.floor(x / CS), cz = Math.floor(z / CS);
    let best = -1, bd = Rm * Rm;
    const j0 = Math.max(cz - r - GJ0, 0), j1 = Math.min(cz + r - GJ0, GH - 1), i0 = Math.max(cx - r - GI0, 0), i1 = Math.min(cx + r - GI0, GW - 1);
    for (let gj = j0; gj <= j1; gj++) for (let gi = i0; gi <= i1; gi++) {
      const a = HG[gj * GW + gi]; if (!a) continue;
      for (let k = 0; k < a.length; k++) { const i = a[k], ex = TX[i] - x, ez = TZ[i] - z, d2 = ex * ex + ez * ez; if (d2 < bd) { bd = d2; best = i; } }
    }
    if (best < 0) { NR.d = 1e9; NR.i = -1; NR.wall = 0; NR.side = 1; NR.y = 0; NR.lat = 1e9; return NR; }
    const lat = (x - TX[best]) * NX[best] + (z - TZ[best]) * NZ[best];
    NR.d = Math.sqrt(bd); NR.i = best; NR.side = lat >= 0 ? 1 : -1; NR.wall = wallOf(best, NR.side); NR.y = TY[best]; NR.lat = lat;
    return NR;
  }
  const LM = (type) => {
    const l = (T.landmarks || []).find((q) => q.type === type);
    const raw = (LAYOUT.landmarks || []).find((q) => q.type === type);
    if (!l && !raw) return null;
    const o = Object.assign({}, raw || {}, l || {});
    if (o.s0 == null) { let b = 0, bd = 1e18; for (let i = 0; i < N; i++) { const d = (TX[i] - o.x) ** 2 + (TZ[i] - o.z) ** 2; if (d < bd) { bd = d; b = i; } } o.s0 = o.s1 = b * DS; }
    if (o.s1 == null) o.s1 = o.s0;
    if (o.s1 < o.s0) o.s1 += L;
    return o;
  };
  const LM_STAND = LM('stand'), LM_TUN = LM('tunnel'), LM_HP = LM('hairpin');
  const LM_CAS = (T.landmarks || []).find((q) => q.type === 'custom' && /casino/i.test(q.name || '')) || (LAYOUT.landmarks || []).find((q) => q.type === 'custom');
  const PIT = T.pit || (() => {
    const l = LM('pits'); if (!l) return null;
    return { s0: l.s0 > L / 2 ? l.s0 - L : l.s0, s1: l.s1, side: -1, lat0: -(WALL_R[0] - 12), lat1: -WALL_R[0] };
  })();
  const inS = (s, a, b) => { s = ((s % L) + L) % L; a = ((a % L) + L) % L; b = ((b % L) + L) % L; return a <= b ? s >= a && s <= b : s >= a || s <= b; };

  // ------------------------------------------------------------ costa y terreno
  let maxWl = 0;
  {
    const st = (T.landmarks || []).find((q) => q.type === 'stand') || { s0: -150, s1: 150 };
    let a = st.s0 > L / 2 ? st.s0 - L : st.s0, b = st.s1 > L / 2 && a < 0 ? st.s1 - L : st.s1; if (b < a) b += L;
    for (let s = a - 60; s <= b; s += 5) maxWl = Math.max(maxWl, at(s).wl);
  }
  const WL0 = WALL_L[0];
  const QUAY_Z = -Math.max(30, maxWl + 22.5);
  const LAND = [[-1600, 1600], [-1600, -60], [-470, -60], [-440, -110], [-405, -158], [-350, -176], [-312, -138], [-302, -80], [-300, QUAY_Z],
    [300, QUAY_Z], [322, -14], [352, 16], [410, 64], [520, 96], [700, 118], [1600, 140], [1600, 1600]];
  const MOLES = [
    { a: [307, QUAY_Z + 2], b: [307, -250], r: 9 },
    { a: [307, -250], b: [236, -262], r: 7 },
    { a: [-338, -150], b: [-74, -226], r: 7.5 },
  ];
  const inPoly = (x, z, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const xi = P[i][0], zi = P[i][1], xj = P[j][0], zj = P[j][1]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; };
  const segD = (x, z, a, b) => { const vx = b[0] - a[0], vz = b[1] - a[1], wx = x - a[0], wz = z - a[1]; const t = clamp((wx * vx + wz * vz) / (vx * vx + vz * vz), 0, 1); return Math.hypot(wx - vx * t, wz - vz * t); };
  const onMole = (x, z) => { for (const m of MOLES) if (segD(x, z, m.a, m.b) < m.r) return true; return false; };
  const isLand = (x, z) => inPoly(x, z, LAND);
  const WY = -1.4;
  function baseH(x, z) {
    let h = 18 * sstep(12, 268, z);
    h += 40 * sstep(330, 760, z) * (0.78 + 0.22 * Math.sin(x * 0.0061 + 1.3));
    h += sstep(560, 1050, z) * (90 + 70 * Math.sin(x * 0.0043 + 0.7) + 35 * Math.sin(x * 0.011 + 2.1));
    h += sstep(560, 1100, Math.abs(x - 60)) * sstep(150, 600, z) * 80;
    h += 16 * sstep(300, 540, x) * sstep(-30, 220, z);
    h += 15 * Math.exp(-((x + 378) ** 2 + (z + 98) ** 2) / (2 * 52 * 52));
    h += 1.6 * Math.sin(x * 0.021) * Math.sin(z * 0.017) * sstep(70, 220, z);
    return h;
  }
  const SMP = []; for (let i = 0; i < N; i += 5) SMP.push(i);
  const SX = Float32Array.from(SMP, (i) => TX[i]), SZ = Float32Array.from(SMP, (i) => TZ[i]), SYY = Float32Array.from(SMP, (i) => TY[i]);
  const SNX = Float32Array.from(SMP, (i) => NX[i]), SNZ = Float32Array.from(SMP, (i) => NZ[i]), SWL = Float32Array.from(SMP, (i) => WALL_L[i]), SWR = Float32Array.from(SMP, (i) => WALL_R[i]);
  const wB = 1 / (32 * 32 * 32);
  const SG = new Map(), SGC = 130, sgk = (a, b) => (a + 64) * 1024 + (b + 64);
  for (let k = 0; k < SX.length; k++) { const q = sgk(Math.floor(SX[k] / SGC), Math.floor(SZ[k] / SGC)); let a = SG.get(q); if (!a) SG.set(q, (a = [])); a.push(k); }
  const SGL = [];
  let TH_E = 1e9, TH_LAND = 0; // 0 agua, 1 tierra, 2 escollera
  function terrainH(x, z) {
    TH_E = 1e9;
    if (onMole(x, z)) { TH_LAND = 2; return 0.7; }
    if (!isLand(x, z)) { TH_LAND = 0; return -7; }
    TH_LAND = 1;
    const b = baseH(x, z);
    let ws = 0, ys = 0, emin = 1e9, ymin = 0;
    const gx = Math.floor(x / SGC), gz = Math.floor(z / SGC);
    let any = false;
    for (let ca = -1; ca <= 1; ca++) for (let cb = -1; cb <= 1; cb++) {
    const l = SG.get(sgk(gx + ca, gz + cb)); if (!l) continue; any = true;
    for (let q = 0; q < l.length; q++) {
      const k = l[q];
      const dx = x - SX[k], dz = z - SZ[k];
      if (dx > 130 || dx < -130 || dz > 130 || dz < -130) continue;
      const d = Math.sqrt(dx * dx + dz * dz); if (d > 130) continue;
      const lat = dx * SNX[k] + dz * SNZ[k];
      const e = d - (lat >= 0 ? SWL[k] : SWR[k]);
      if (e < emin) { emin = e; ymin = SYY[k]; }
      const dd = Math.max(e, 1.2);
      const w = (1 / (dd * dd * dd)) * (d < 60 ? 1 : sstep(130, 60, d));
      ws += w; ys += w * SYY[k];
    }
    }
    if (!any) return b;
    let h = (ys + wB * b) / (ws + wB);
    TH_E = emin;
    if (emin < 1.2) h = ymin - 0.28;
    else if (emin < 7) h = lerp(ymin - 0.28, h, sstep(1.2, 7, emin));
    return h;
  }
  const groundAt = (x, z, w = 0, d = 0, yaw = 0) => {
    if (!w) return terrainH(x, z);
    const c = Math.cos(yaw), s = Math.sin(yaw); let m = 1e9;
    for (const [a, b] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0, 0]]) { const lx = a * w, lz = b * d; m = Math.min(m, terrainH(x + lx * c + lz * s, z - lx * s + lz * c)); }
    return m;
  };

  // ------------------------------------------------------------ ocupación (bit 1 = físico, bit 2 = no edificable)
  const OG = { x0: -900, z0: -420, cs: 3, w: 0, h: 0, a: null };
  OG.w = Math.ceil(2000 / OG.cs); OG.h = Math.ceil(1500 / OG.cs); OG.a = new Uint8Array(OG.w * OG.h);
  const ogAt = (x, z) => { const i = Math.floor((x - OG.x0) / OG.cs), j = Math.floor((z - OG.z0) / OG.cs); if (i < 0 || j < 0 || i >= OG.w || j >= OG.h) return 0; return OG.a[j * OG.w + i]; };
  const occ = (x, z) => (ogAt(x, z) & 1) !== 0;
  const noBuild = (x, z) => ogAt(x, z) !== 0;
  function markRect(x, z, w, d, yaw, m = 0, bit = 1) {
    const c = Math.cos(yaw), s = Math.sin(yaw), hw = w / 2 + m, hd = d / 2 + m, r = Math.hypot(hw, hd);
    const i0 = Math.max(0, Math.floor((x - r - OG.x0) / OG.cs)), i1 = Math.min(OG.w - 1, Math.floor((x + r - OG.x0) / OG.cs));
    const j0 = Math.max(0, Math.floor((z - r - OG.z0) / OG.cs)), j1 = Math.min(OG.h - 1, Math.floor((z + r - OG.z0) / OG.cs));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = OG.x0 + (i + 0.5) * OG.cs - x, pz = OG.z0 + (j + 0.5) * OG.cs - z;
      const lx = px * c - pz * s, lz = px * s + pz * c;
      if (Math.abs(lx) <= hw && Math.abs(lz) <= hd) OG.a[j * OG.w + i] |= bit;
    }
  }
  const markCircle = (x, z, r, bit = 1) => {
    const i0 = Math.max(0, Math.floor((x - r - OG.x0) / OG.cs)), i1 = Math.min(OG.w - 1, Math.floor((x + r - OG.x0) / OG.cs));
    const j0 = Math.max(0, Math.floor((z - r - OG.z0) / OG.cs)), j1 = Math.min(OG.h - 1, Math.floor((z + r - OG.z0) / OG.cs));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const px = OG.x0 + (i + 0.5) * OG.cs - x, pz = OG.z0 + (j + 0.5) * OG.cs - z; if (px * px + pz * pz <= r * r) OG.a[j * OG.w + i] |= bit; }
  };
  function fits(x, z, w, d, yaw, gap = 1.5) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const nx = Math.max(2, Math.ceil(w / 7)), nz = Math.max(2, Math.ceil(d / 7));
    for (let a = 0; a <= nx; a++) for (let b = 0; b <= nz; b++) {
      const lx = (a / nx - 0.5) * w, lz = (b / nz - 0.5) * d;
      const px = x + lx * c + lz * s, pz = z - lx * s + lz * c;
      if (noBuild(px, pz) || !isLand(px, pz) || onMole(px, pz)) return false;
      const n = near(px, pz, 52); if (n.d < n.wall + gap) return false;
    }
    return true;
  }
  const propOK = (x, z, gap = 2.5) => { if (occ(x, z) || !isLand(x, z) && !onMole(x, z)) return false; const n = near(x, z, 60); return n.d >= n.wall + gap; };

  // ------------------------------------------------------------ lotes de geometría
  const PROPS = new Batch({ aLit: 1 });
  const BUILD = new Batch({ aWin: 4 });
  const EMIS = new Batch();
  const SWAY = new Batch({ aSway: 3, aLit: 1 });
  const POOLS = new Batch();
  const SIGNS = new Batch();
  const GLOWS = { p: [], c: [], s: [] };
  const STREAKS = { c: [], q: [], col: [], w: [] };
  const CROWD = [];
  const OCCL = [];
  const TEMPL = [];
  const tg = (g) => { TEMPL.push(g); return g; };
  const BOX = tg(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
  const BOXC = tg(new THREE.BoxGeometry(1, 1, 1));
  const CYL6 = tg(new THREE.CylinderGeometry(1, 1, 1, 6, 1).translate(0, 0.5, 0));
  const CYL8 = tg(new THREE.CylinderGeometry(1, 1, 1, 8, 1).translate(0, 0.5, 0));
  const CYL16 = tg(new THREE.CylinderGeometry(1, 1, 1, 16, 1).translate(0, 0.5, 0));
  const CYL24 = tg(new THREE.CylinderGeometry(1, 1, 1, 24, 1).translate(0, 0.5, 0));
  const TUBE16 = tg(new THREE.CylinderGeometry(1, 1, 1, 16, 1, true).translate(0, 0.5, 0));
  const CONE8 = tg(new THREE.ConeGeometry(1, 1, 8, 1).translate(0, 0.5, 0));
  const CONE4 = tg(new THREE.ConeGeometry(1, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0));
  const SPH = tg(new THREE.SphereGeometry(1, 10, 7));
  const SPH_LO = tg(new THREE.SphereGeometry(1, 6, 4));
  const DOME = tg(new THREE.SphereGeometry(1, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2));
  const ICO = tg(new THREE.IcosahedronGeometry(1, 0));
  const _M2 = new THREE.Matrix4();
  const MM = (base, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) => _M2.multiplyMatrices(base, M(x, y, z, ry, sx, sy, sz, rx, rz));
  const tp = (m, x, y, z) => { _v.set(x, y, z).applyMatrix4(m); return [_v.x, _v.y, _v.z]; };

  const glow = (x, y, z, size, col, blink = 0, phase = 0) => { GLOWS.p.push(x, y, z); GLOWS.c.push(col[0], col[1], col[2]); GLOWS.s.push(size, blink, phase); };
  function pool(x, y, z, r, col, yaw = 0, sx = 1) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const P = (u, v) => [x + u * r * sx * c + v * r * s, y, z - u * r * sx * s + v * r * c];
    const A = P(-1, -1), B = P(1, -1), C = P(1, 1), D = P(-1, 1);
    for (const [p, uv] of [[A, [0, 0]], [B, [1, 0]], [C, [1, 1]], [A, [0, 0]], [C, [1, 1]], [D, [0, 1]]]) POOLS._push(p[0], p[1], p[2], 0, 1, 0, col, uv[0], uv[1]);
  }
  function streak(x, yl, z, ys, width, col, ground = 0) {
    for (const [a, sd] of [[0, -1], [1, -1], [1, 1], [0, -1], [1, 1], [0, 1]]) { STREAKS.c.push(x, yl, z); STREAKS.q.push(a, sd, ground); STREAKS.col.push(col[0], col[1], col[2]); STREAKS.w.push(ys, width); }
  }
  const occluder = (x0, y0, z0, x1, y1, z1) => OCCL.push([Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1), Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)]);
  function occluderRect(x, z, w, d, yaw, y0, y1) {
    const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
    const ex = (w * c + d * s) / 2, ez = (w * s + d * c) / 2;
    occluder(x - ex * 0.8, y0, z - ez * 0.8, x + ex * 0.8, y1, z + ez * 0.8);
  }
  const person = (x, y, z, yaw, col, stand = 0) => CROWD.push([x, y, z, yaw, col, stand]);
  const SHIRTS = ['#d23a3a', '#f2f2f2', '#2b5fd9', '#ffcc33', '#1d8f5a', '#ff6fa8', '#202434', '#ff8a2a', '#7a4fd8', '#22b8d8', '#e8e0c8', '#f2f2f2'].map((h) => hex(h));
  const shirt = () => pick(SHIRTS);
  const FACADES = ['#e9d8b4', '#e2b27a', '#d48b62', '#e9a68f', '#f0d98c', '#efe9dc', '#a8b7bf', '#c9845a', '#f3c6a5', '#dcc7a0', '#b9c7a8', '#efe9dc'].map((h) => hex(h, 0.95));
  const ROOF_T = hex('#9b4a2e', 0.9), ROOF_F = hex('#5b5550', 0.9);
  const WARM_L = [5.2, 3.6, 1.9], WARM_G = [1.0, 0.66, 0.34], WARM_S = [0.55, 0.34, 0.15];
  const COUNT = { buildings: 0, lamps: 0, palms: 0, yachts: 0, trees: 0 };
  let ENV_RT = null;
  let GANTRY_META = null, HAIRPIN = null, BRIDGE = null, FARO = null;
  const JETS = [];
  const PROPS_EXTRA = new Batch({ aLit: 1 });

  /** Edificio: caja (w = x local, d = z local) con UV en metros para el shader de ventanas.
   *  win = [anchoCelda, altoCelda, fracciónEncendida, estilo]; roof 0 plano, 1 a cuatro aguas. */
  function building(x, z, w, d, h, yaw, yg, col, win, roof = 0, roofCol = null, below = 3) {
    COUNT.buildings++;
    const y0 = yg - below, y1 = yg + h;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const P = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    const hw = w / 2, hd = d / 2;
    const cs = [P(-hw, hd), P(hw, hd), P(hw, -hd), P(-hw, -hd)];
    const lens = [w, d, w, d];
    const seed = rnd() * 0.98;
    for (let k = 0; k < 4; k++) {
      const a = cs[k], b = cs[(k + 1) % 4], len = lens[k];
      let aw = [0, 0, 0, 0], off = 0;
      if (win) {
        const nC = Math.max(1, Math.floor(len / win[0]));
        off = (len - nC * win[0]) / 2;
        aw = [win[0], win[1], (win[3] || 0) + Math.min(0.995, win[2]), nC + seed];
      }
      const A = [a[0], y0, a[1]], B = [b[0], y0, b[1]], C = [b[0], y1, b[1]], D = [a[0], y1, a[1]];
      BUILD.quad(A, B, C, D, col, { aWin: aw }, [-off, y0 - yg, len - off, y0 - yg, len - off, y1 - yg, -off, y1 - yg]);
    }
    const rc = roofCol || col, ex = { aWin: [0, 0, 0, 0] };
    const C0 = [cs[0][0], y1, cs[0][1]], C1 = [cs[1][0], y1, cs[1][1]], C2 = [cs[2][0], y1, cs[2][1]], C3 = [cs[3][0], y1, cs[3][1]];
    if (roof === 1) {
      const rh = Math.min(w, d) * 0.22, top = y1 + rh;
      if (w >= d) {
        const r0 = P(-hw + hd, 0), r1 = P(hw - hd, 0), R0 = [r0[0], top, r0[1]], R1 = [r1[0], top, r1[1]];
        BUILD.quad(C0, C1, R1, R0, rc, ex); BUILD.quad(C2, C3, R0, R1, rc, ex); BUILD.tri(C3, C0, R0, rc, ex); BUILD.tri(C1, C2, R1, rc, ex);
      } else {
        const r0 = P(0, -hd + hw), r1 = P(0, hd - hw), R0 = [r0[0], top, r0[1]], R1 = [r1[0], top, r1[1]];
        BUILD.tri(C0, C1, R1, rc, ex); BUILD.tri(C2, C3, R0, rc, ex); BUILD.quad(C1, C2, R0, R1, rc, ex); BUILD.quad(C3, C0, R1, R0, rc, ex);
      }
    } else {
      BUILD.quad(C0, C1, C2, C3, rc, ex);
      if (roof === 2) { // azotea con pretil
        const p = 0.8;
        for (let k = 0; k < 4; k++) { const a = cs[k], b = cs[(k + 1) % 4]; const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2; const len = Math.hypot(b[0] - a[0], b[1] - a[1]); PROPS.add(BOXC, M(mx, y1 + p / 2, mz, Math.atan2(b[0] - a[0], b[1] - a[1]), 0.3, p, len), [col[0] * 0.8, col[1] * 0.8, col[2] * 0.8], { aLit: 0.1 }); }
      }
    }
    return y1;
  }

  // ================================================================= CÁMARAS DE TV (reservadas primero)
  const tvCams = [];
  {
    const cand = [];
    (T.corners || []).forEach((c) => cand.push({ s: c.apex, side: -(c.dir || 1) }));
    [120, -95, 300, 680, 1010, 1640, 1180].forEach((s) => cand.push({ s, side: s === -95 || s === 120 ? -1 : 1 }));
    for (const c of cand) {
      if (LM_TUN && inS(c.s, LM_TUN.s0 - 12, LM_TUN.s1 + 4)) continue;
      const o = at(c.s);
      for (const sd of [c.side, -c.side]) {
        const lat = sd * (wallOf(o.i, sd) + 4.5);
        const x = o.x + o.nx * lat, z = o.z + o.nz * lat;
        if (!isLand(x, z)) continue;
        const n = near(x, z, 80); if (n.d < n.wall + 3) continue;
        tvCams.push({ x, y: o.y + 7.5 + (tvCams.length % 3) * 2.5, z, s: c.s });
        markCircle(x, z, 9, 2);
        break;
      }
      if (tvCams.length >= 16) break;
    }
  }

  tick('tv');
  // ================================================================= PASEO DEL PUERTO (no edificable)
  {
    const zTop = -(WL0 - 0.5);
    markRect(0, (QUAY_Z - 2 + zTop) / 2, 640, zTop - QUAY_Z + 2, 0, 0, 2);
  }

  // ================================================================= TRIBUNA DEL PUERTO
  const STAND_META = [];
  const STAND_ROWS = 9, ROW_D = 1.6, ROW_H = 0.7, STAND_FRONT = 2.6;
  function flagPole(x, y, z, h, yaw) {
    if (!Q.flags) return;
    PROPS.add(CYL6, M(x, y, z, 0, 0.06, h, 0.06), [0.8, 0.8, 0.82]);
    const cols = [hex('#d8283a'), hex('#f4f1ea'), hex('#1f4fb8'), hex('#ffc72c'), hex('#0f8a6a')];
    const c1 = pick(cols), c2 = pick(cols);
    const ph = rnd() * 6.28, fw = 2.2, fh = 1.4, segs = 4;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const p = (u, v) => [x + u * c, y + h - 0.1 - v, z - u * s];
    for (let k = 0; k < segs; k++) {
      const u0 = (k / segs) * fw, u1 = ((k + 1) / segs) * fw;
      const col = k < segs / 2 ? c1 : c2;
      const e0 = { aSway: [0.16 * (u0 / fw), ph + u0 * 1.6, 4.5], aLit: 0.25 }, e1 = { aSway: [0.16 * (u1 / fw), ph + u1 * 1.6, 4.5], aLit: 0.25 };
      for (const [u, v, e] of [[u0, 0, e0], [u1, 0, e1], [u1, fh, e1], [u0, 0, e0], [u1, fh, e1], [u0, fh, e0]]) { const q = p(u, v); SWAY._push(q[0], q[1], q[2], 0, 0, 1, col, 0, 0, e); }
    }
  }
  if (LM_STAND) {
    let s0 = LM_STAND.s0, s1 = LM_STAND.s1;
    if (s0 > L / 2) { s0 -= L; s1 -= L; }
    if (s1 < s0) s1 += L;
    const span = s1 - s0, nSec = Math.max(1, Math.round(span / 66));
    const cuts = []; for (let k = 0; k <= nSec; k++) cuts.push(s0 + (span * k) / nSec);
    const secs = [];
    for (let k = 0; k < nSec; k++) {
      let a = cuts[k] + 3, b = cuts[k + 1] - 3;
      if (a < 8 && b > -8) { if (-8 - a > b - 8) b = -8; else a = 8; }
      if (b - a > 20) secs.push([a, b]);
    }
    const side = LM_STAND.side || 1;
    for (const [sa, sb] of secs) {
      const oa = at(sa, {}), ob = at(sb, {});
      let U0 = 0; for (let s = sa; s <= sb; s += 5) { const o = at(s); U0 = Math.max(U0, wallOf(o.i, side)); }
      U0 += 3;
      const len = Math.hypot(ob.x - oa.x, ob.z - oa.z);
      const tx = (ob.x - oa.x) / len, tz = (ob.z - oa.z) / len;
      const nx = tz * side, nz = -tx * side;
      const y0 = Math.min(oa.y, ob.y);
      const sh = new THREE.Shape();
      sh.moveTo(0, -0.6); sh.lineTo(0, STAND_FRONT); sh.lineTo(1.4, STAND_FRONT);
      for (let r = 0; r < STAND_ROWS; r++) { const u = 1.4 + r * ROW_D, v = STAND_FRONT + 0.5 + r * ROW_H; sh.lineTo(u, v); sh.lineTo(u + ROW_D, v); }
      const UB = 1.4 + STAND_ROWS * ROW_D;
      sh.lineTo(UB, -0.6); sh.lineTo(0, -0.6);
      const eg = tg(new THREE.ExtrudeGeometry(sh, { depth: len, bevelEnabled: false, curveSegments: 1 }));
      const basis = new THREE.Matrix4();
      if (side > 0) basis.makeBasis(new THREE.Vector3(nx, 0, nz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(tx, 0, tz)).setPosition(oa.x + nx * U0, y0, oa.z + nz * U0);
      else basis.makeBasis(new THREE.Vector3(nx, 0, nz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-tx, 0, -tz)).setPosition(ob.x + nx * U0, y0, ob.z + nz * U0);
      const ox = oa.x, oz = oa.z;
      PROPS.add(eg, basis, (wx, wy, wz, gx, gy) => {
        if (gy > 0.7) { const r = Math.round((wy - y0 - STAND_FRONT - 0.5) / ROW_H); return r < 0 ? [0.32, 0.31, 0.3] : r % 2 ? [0.1, 0.2, 0.52] : [0.66, 0.68, 0.72]; }
        if (Math.abs(gy) < 0.3) { const lat = (wx - ox) * nx + (wz - oz) * nz - U0; if (lat < 0.3) return [0.05, 0.08, 0.17]; if (lat > UB - 0.3) return [0.4, 0.37, 0.33]; }
        return [0.33, 0.32, 0.31];
      }, { aLit: 0.5 });
      const midx = (oa.x + ob.x) / 2, midz = (oa.z + ob.z) / 2, yaw = Math.atan2(tx, tz);
      EMIS.add(BOXC, M(midx + nx * (U0 - 0.05), y0 + STAND_FRONT - 0.3, midz + nz * (U0 - 0.05), yaw, 0.08, 0.1, len - 1), [2.6, 1.8, 0.8]);
      const roofY = y0 + STAND_FRONT + 0.5 + STAND_ROWS * ROW_H + 4.6;
      PROPS.add(BOXC, M(midx + nx * (U0 + UB / 2 + 0.4), roofY, midz + nz * (U0 + UB / 2 + 0.4), yaw, UB + 3, 0.4, len + 1, side * 0.07), [0.7, 0.72, 0.76], { aLit: 0.06 });
      PROPS.add(BOXC, M(midx + nx * (U0 - 0.95), roofY - 0.05, midz + nz * (U0 - 0.95), yaw, 0.3, 1.7, len + 1), [0.05, 0.08, 0.18], { aLit: 0.05 });
      for (let z = 4; z < len - 2; z += 11) PROPS.add(CYL8, M(oa.x + tx * z + nx * (U0 + UB - 0.4), y0 + 0.5, oa.z + tz * z + nz * (U0 + UB - 0.4), 0, 0.28, roofY - y0 - 0.5, 0.28), [0.78, 0.79, 0.82]);
      EMIS.add(BOXC, M(midx + nx * (U0 + 1.2), roofY - 0.3, midz + nz * (U0 + 1.2), yaw, 0.5, 0.08, len - 2), [2.2, 1.9, 1.5]);
      for (let z = 3; z < len - 1; z += 6) {
        const px = oa.x + tx * z, pz = oa.z + tz * z;
        glow(px + nx * (U0 + 1.2), roofY - 0.55, pz + nz * (U0 + 1.2), 2.6, [1.0, 0.92, 0.78]);
        if (Math.round(z / 6) % 2 === 0) {
          const bx = px + nx * (U0 + UB + 0.06), bz = pz + nz * (U0 + UB + 0.06);
          EMIS.add(BOXC, M(bx, y0 + 4.2, bz, yaw, 0.12, 0.6, 0.6), WARM_L);
          glow(bx + nx * 0.4, y0 + 4.2, bz + nz * 0.4, 2.0, WARM_G);
          streak(bx, y0 + 4.2, bz, WY, 0.9, WARM_S);
        }
      }
      STAND_META.push({ midx, midz, yaw, nx, nz, U0, UB, roofY, len, y0, tx, tz });
      for (let r = 0; r < STAND_ROWS; r++) {
        const u = U0 + 1.4 + r * ROW_D + 0.85, v = y0 + STAND_FRONT + 0.5 + r * ROW_H;
        for (let z = 0.6; z < len - 0.6; z += 0.78) if (rnd() < 0.9) person(oa.x + tx * z + nx * u + R(-0.08, 0.08), v, oa.z + tz * z + nz * u, Math.atan2(-nx, -nz) + R(-0.3, 0.3), shirt(), 0);
      }
      for (let z = 4; z < len; z += 10) flagPole(oa.x + tx * z + nx * (U0 + UB + 0.2), roofY + 0.2, oa.z + tz * z + nz * (U0 + UB + 0.2), 4.5, yaw);
      markRect(midx + nx * (U0 + UB / 2), midz + nz * (U0 + UB / 2), UB + 2, len + 2, yaw);
      occluderRect(midx + nx * (U0 + UB / 2), midz + nz * (U0 + UB / 2), UB, len, yaw, y0, roofY);
    }
  }

  tick('stand');
  // ================================================================= BOXES (edificio de garajes + torre + pantalla)
  let JUMBO_AT = null;
  if (PIT) {
    const side = PIT.side || -1;
    const U0 = Math.abs(PIT.lat1) + 3, D = 14, H = 9.6;
    const segL = 30;
    const s0 = PIT.s0, s1 = PIT.s1;
    for (let s = s0; s < s1 - 4; s += segL) {
      const sm = Math.min(s + segL / 2, s1 - 2), o = at(sm, {});
      const lat = side * (U0 + D / 2);
      const x = o.x + o.nx * lat, z = o.z + o.nz * lat;
      const yaw = yawAcross(o);
      const w = Math.min(segL, s1 - s) + 0.3;
      const yg = Math.min(o.y, groundAt(x, z));
      building(x, z, w, D, H, yaw, yg, hex('#dfe3ea', 0.85), [6, 4.8, 0.32, 4], 2);
      // portones de garaje iluminados hacia el pit-lane
      const fl = side * U0 - side * 0.08;
      for (let g = 0; g < Math.floor(w / 7.5); g++) {
        const sg = s + 3.75 + g * 7.5; if (sg > s1 - 2) break;
        const og = at(sg, {});
        const gx = og.x + og.nx * fl, gz = og.z + og.nz * fl;
        const tint = g % 3 === 0 ? [0.62, 0.6, 0.56] : g % 3 === 1 ? [0.7, 0.52, 0.32] : [0.48, 0.56, 0.68];
        EMIS.add(BOXC, M(gx, yg + 1.9, gz, yawAlong(og), 0.05, 3.4, 6.6), tint);
        pool(og.x + og.nx * (fl + side * -2.5), og.y + 0.05, og.z + og.nz * (fl + side * -2.5), 4.5, [0.045, 0.04, 0.035], yawAlong(og), 1.4);
      }
      // terraza VIP en la azotea
      const fr = side * (U0 + 0.6);
      const rx = o.x + o.nx * fr, rz = o.z + o.nz * fr;
      PROPS.add(BOXC, M(rx, yg + H + 0.55, rz, yawAlong(o), 0.08, 1.1, w - 0.5), [0.75, 0.8, 0.85], { aLit: 0.2 });
      for (let z = -w / 2 + 1; z < w / 2 - 0.5; z += 0.9) if (rnd() < 0.55) {
        const px = rx + o.tx * z - side * o.nx * R(0.6, 2.5), pz = rz + o.tz * z - side * o.nz * R(0.6, 2.5);
        person(px, yg + H + 0.72, pz, Math.atan2(side * o.nx, side * o.nz) + R(-0.4, 0.4), shirt(), 1);
      }
      for (let z = -w / 2 + 4; z < w / 2; z += 8) {
        const px = o.x + o.nx * side * (U0 + 8) + o.tx * z, pz = o.z + o.nz * side * (U0 + 8) + o.tz * z;
        PROPS.add(CYL6, M(px, yg + H, pz, 0, 0.05, 2.4, 0.05), [0.8, 0.8, 0.8]);
        PROPS.add(CONE8, M(px, yg + H + 2.0, pz, 0, 1.9, 0.6, 1.9), z % 16 < 8 ? [0.85, 0.85, 0.82] : [0.7, 0.12, 0.12], { aLit: 0.6 });
        glow(px, yg + H + 1.8, pz, 2.2, WARM_G);
      }
      occluderRect(x, z, w, D, yaw, yg, yg + H);
      markRect(x, z, w, D + 4, yaw, 1);
      if (!JUMBO_AT && sm > -80) JUMBO_AT = { o: at(Math.max(s0 + 20, -55), {}), lat: side * (U0 + 5), y: yg + H };
    }
    // torre de control
    {
      const o = at(s1 - 16, {}), lat = side * (U0 + D + 6);
      const x = o.x + o.nx * lat, z = o.z + o.nz * lat, yg = groundAt(x, z);
      if (fits(x, z, 9, 9, yawAcross(o), 0.5) || true) {
        building(x, z, 8, 8, 21, yawAcross(o), yg, hex('#e8eaee', 0.9), [4, 3.5, 0.5, 4], 0);
        PROPS.add(CYL16, M(x, yg + 21, z, 0, 6.2, 0.5, 6.2), [0.85, 0.86, 0.9]);
        EMIS.add(TUBE16, M(x, yg + 21.5, z, 0, 5.9, 2.6, 5.9), [0.9, 1.15, 1.4]);
        PROPS.add(CYL16, M(x, yg + 24.1, z, 0, 6.5, 0.6, 6.5), [0.85, 0.86, 0.9]);
        PROPS.add(CYL6, M(x, yg + 24.7, z, 0, 0.12, 6, 0.12), [0.8, 0.8, 0.8]);
        glow(x, yg + 30.8, z, 3, [1.0, 0.1, 0.12], 0.7, 0.2);
        occluder(x - 6, yg, z - 6, x + 6, yg + 25, z + 6);
        markRect(x, z, 14, 14, 0, 0);
      }
    }
  }

  tick('pits');
  // ================================================================= PÓRTICO DE SALIDA
  const GANTRY_PTS = [];
  {
    const o = at(0, {});
    const yaw = yawAlong(o);
    const latL = WALL_L[o.i] + 3.5;
    const latR = -Math.max(WALL_R[o.i] + 1.4, 3.5 + (PIT ? 0 : WALL_R[o.i]));
    const pL = [o.x + o.nx * latL, o.z + o.nz * latL], pR = [o.x + o.nx * latR, o.z + o.nz * latR];
    const span = latL - latR, mid = (latL + latR) / 2;
    const yb = o.y;
    for (const p of [pL, pR]) {
      PROPS.add(BOXC, M(p[0], yb + 5.6, p[1], yaw, 1.1, 11.2, 1.1), [0.1, 0.12, 0.2], { aLit: 0.2 });
      EMIS.add(BOXC, M(p[0], yb + 5.6, p[1], yaw, 1.14, 10.6, 0.15), [1.3, 0.9, 0.32]);
      markCircle(p[0], p[1], 2);
    }
    const mx = o.x + o.nx * mid, mz = o.z + o.nz * mid;
    PROPS.add(BOXC, M(mx, yb + 8.4, mz, yaw, span, 1.2, 1.3), [0.1, 0.12, 0.2], { aLit: 0.2 });
    EMIS.add(BOXC, M(mx, yb + 9.06, mz, yaw, span, 0.1, 1.36), [1.5, 1.05, 0.38]);
    EMIS.add(BOXC, M(mx, yb + 7.78, mz, yaw, span, 0.1, 1.36), [1.5, 1.05, 0.38]);
    // panel de semáforos sobre el centro de la pista
    PROPS.add(BOXC, M(o.x - o.tx * 0.1, yb + 10.3, o.z - o.tz * 0.1, yaw, 11.6, 2.4, 0.5), [0.02, 0.02, 0.03]);
    for (let i = 0; i < 5; i++) for (let r = 0; r < 2; r++) {
      const lat = -4.4 + i * 2.2;
      GANTRY_PTS.push(new THREE.Vector3(o.x + o.nx * lat - o.tx * 0.42, yb + 10.85 - r * 1.05, o.z + o.nz * lat - o.tz * 0.42));
    }
    GANTRY_META = { o, yaw, mx, mz, span, yb };
  }

  // ================================================================= PODIO (paseo del puerto) + barcaza de fuegos
  let PODIUM;
  {
    let sP = -178;
    if (LM_STAND) { let a = LM_STAND.s0 > L / 2 ? LM_STAND.s0 - L : LM_STAND.s0; sP = Math.min(sP, a - 52); }
    const o = at(sP, {});
    const side = 1, lat = WALL_L[o.i] + 12.5;
    const px = o.x + o.nx * lat, pz = o.z + o.nz * lat, py = o.y + 0.25;
    const yaw = Math.atan2(-o.nx, -o.nz); // mira hacia la pista
    const fx = Math.sin(yaw), fz = Math.cos(yaw), lx = Math.cos(yaw), lz = -Math.sin(yaw); // frente y +X local (izquierda del podio)
    PROPS.add(CYL24, M(px, o.y - 0.3, pz, 0, 12.5, 0.55, 12.5), [0.13, 0.14, 0.19], { aLit: 0.25 });
    EMIS.add(TUBE16, M(px, o.y + 0.2, pz, 0, 12.55, 0.06, 12.55), [2.6, 1.9, 0.9]);
    PROPS.add(BOXC, M(px + fx * 9, o.y + 0.27, pz + fz * 9, yaw, 4, 0.04, 8), [0.45, 0.05, 0.07], { aLit: 0.5 });
    const steps = [[0, 1.7], [-5.9, 1.15], [5.9, 0.75]];
    const slots = [];
    steps.forEach(([dx, h], k) => {
      const cx = px + lx * dx, cz = pz + lz * dx;
      PROPS.add(BOXC, M(cx, py + h / 2, cz, yaw, 5.7, h, 6.4), [0.06, 0.08, 0.16], { aLit: 0.3 });
      const ec = k === 0 ? [3.4, 2.5, 0.7] : k === 1 ? [2.2, 2.4, 2.8] : [3.0, 1.6, 0.7];
      EMIS.add(BOXC, M(cx + fx * 3.21, py + h - 0.04, cz + fz * 3.21, yaw, 5.72, 0.08, 0.06), ec);
      EMIS.add(BOXC, M(cx - fx * 3.21, py + h - 0.04, cz - fz * 3.21, yaw, 5.72, 0.08, 0.06), ec);
      slots.push({ x: cx, y: py + h, z: cz, yaw: yaw + (k === 1 ? 0.22 : k === 2 ? -0.22 : 0) * 1, h });
    });
    // arco de fondo
    const bx = px - fx * 5.2, bz = pz - fz * 5.2;
    for (const d of [-11, 11]) {
      PROPS.add(BOXC, M(bx - lx * d, py + 6, bz - lz * d, yaw, 1.1, 12, 1.1), [0.06, 0.08, 0.16], { aLit: 0.2 });
      EMIS.add(BOXC, M(bx - lx * d + fx * 0.58, py + 6, bz - lz * d + fz * 0.58, yaw, 0.14, 11.4, 0.05), [3.0, 2.2, 0.8]);
      flagPole(bx - lx * d * 1.25, py, bz - lz * d * 1.25, 9, yaw + Math.PI / 2);
    }
    PROPS.add(BOXC, M(bx, py + 12.3, bz, yaw, 23.2, 2.6, 1.2), [0.06, 0.08, 0.16], { aLit: 0.2 });
    for (let k = -5; k <= 5; k++) glow(bx - lx * k * 2 + fx * 0.9, py + 10.6, bz - lz * k * 2 + fz * 0.9, 1.8, [1.0, 0.85, 0.6]);
    pool(px, o.y + 0.32, pz, 12, [0.09, 0.065, 0.035]);
    for (const d of [-8, 8]) { pool(px - lx * d + fx * 7, o.y + 0.32, pz - lz * d + fz * 7, 5, [0.1, 0.08, 0.05]); }
    markCircle(px, pz, 14);
    markCircle(px + fx * 9, pz + fz * 9, 5);
    occluder(bx - 12, py, bz - 1.5, bx + 12, py + 13.6, bz + 1.5);
    PODIUM = { x: px, y: py, z: pz, yaw, slots: slots.map((s) => ({ x: s.x, y: s.y, z: s.z, yaw: s.yaw })), signAt: { x: bx + fx * 0.65, y: py + 12.15, z: bz + fz * 0.65, yaw }, numsAt: slots.map((s) => ({ x: s.x + fx * 3.22, y: s.y - s.h / 2, z: s.z + fz * 3.22 })) };
    const fw = { x: px - fx * 72, y: WY, z: pz - fz * 72 };
    // barcaza
    PROPS.add(BOXC, M(fw.x, WY + 0.5, fw.z, yaw, 26, 1.8, 10), [0.08, 0.08, 0.1], { aLit: 0.1 });
    for (let k = -4; k <= 4; k++) PROPS.add(BOXC, M(fw.x - lx * k * 2.6, WY + 1.8, fw.z - lz * k * 2.6, yaw, 1.6, 0.9, 3), [0.18, 0.16, 0.14]);
    for (let k = -1; k <= 1; k += 2) { glow(fw.x - lx * k * 12.5, WY + 2.2, fw.z - lz * k * 12.5, 1.4, [1, 0.12, 0.1], 0.8, k * 0.25); streak(fw.x - lx * k * 12.5, WY + 2.2, fw.z - lz * k * 12.5, WY, 0.5, [0.5, 0.05, 0.04]); }
    PODIUM.fw = fw;
  }

  tick('podium');
  // ================================================================= HOTEL MIRAMAR sobre el túnel
  const HOTEL = [];
  if (LM_TUN) {
    const s0 = LM_TUN.s0 + 2, s1 = LM_TUN.s1 - 2, seg = 12;
    const latS = -30, latN = 24;
    let gap = 0; for (let s = s0; s <= s1; s += 4) { const o = at(s); gap = Math.max(gap, o.wl, o.wr); }
    const gIn = gap + 0.65;
    const top = 7.6 + 7 * 3.3 + 0.9;
    const HC = hex('#efe4cc', 0.95);
    for (let s = s0; s < s1 - 1; s += seg) {
      const sm = Math.min(s + seg / 2, s1 - 1), o = at(sm, {}), w = Math.min(seg, s1 - s) + 0.4;
      const yaw = yawAcross(o);
      const P = (lat) => [o.x + o.nx * lat, o.z + o.nz * lat];
      // bloque superior (sobre el túnel)
      const c = P((latS + latN) / 2);
      const yL = o.y + 7.6, hL = 5 * 3.3, ySb = yL + hL, SB = 5;
      building(c[0], c[1], w, latN - latS, hL, yaw, yL, HC, [4.2, 3.3, 0.62, 1], 0, null, 0);
      const cU = P((latS + SB + latN) / 2);
      building(cU[0], cU[1], w, latN - latS - SB, top - 7.6 - hL, yaw, ySb, HC, [4.2, 3.3, 0.7, 1], 2, null, 0.01);
      // cornisas y pilastras luminosas en la fachada al mar
      const fS = P(latS - 0.3), fT = P(latS + SB - 0.3);
      const ya = yawAlong(o);
      PROPS.add(BOXC, M(fS[0], ySb + 0.25, fS[1], ya, 0.9, 0.5, w), [0.85, 0.78, 0.64], { aLit: 0.5 });
      PROPS.add(BOXC, M(fS[0], yL + 0.25, fS[1], ya, 0.9, 0.5, w), [0.85, 0.78, 0.64], { aLit: 0.5 });
      PROPS.add(BOXC, M(fT[0], o.y + top + 0.3, fT[1], ya, 0.9, 0.6, w), [0.85, 0.78, 0.64], { aLit: 0.4 });
      const e0 = [o.x + o.nx * (latS - 0.12) - o.tx * w / 2, o.z + o.nz * (latS - 0.12) - o.tz * w / 2];
      EMIS.add(BOXC, M(e0[0], yL + hL / 2, e0[1], ya, 0.22, hL - 0.6, 0.22), [1.25, 0.82, 0.38]);
      // barandilla con luces en la terraza retranqueada
      for (let q = 0; q < 5; q++) { const u = (q / 4 - 0.5) * (w - 1); glow(fS[0] + o.tx * u + o.nx * 0.6, ySb + 1.3, fS[1] + o.tz * u + o.nz * 0.6, 0.8, [1, 0.8, 0.5]); }
      glow(fS[0] - o.nx * 0.5, yL - 0.4, fS[1] - o.nz * 0.5, 2.2, [1, 0.72, 0.38]);
      // alas por debajo
      const cS = P((latS - gIn) / 2), cN = P((latN + gIn) / 2);
      const gS = groundAt(cS[0], cS[1]), gN = groundAt(cN[0], cN[1]);
      building(cS[0], cS[1], w, -gIn - latS, o.y + 7.7 - gS, yaw, gS, HC, [4.2, 3.3, 0.7, 1], 0, null, 3);
      if (o.y + 7.7 - gN > 1) building(cN[0], cN[1], w, latN - gIn, o.y + 7.7 - gN, yaw, gN, HC, [4.2, 3.3, 0.5, 1], 0, null, 3);
      markRect(c[0], c[1], w, latN - latS, yaw, 1, 3);
      HOTEL.push({ o, yaw, c, w });
      occluderRect(c[0], c[1], w, latN - latS, yaw, o.y + 7.6, o.y + top);
      occluderRect(cS[0], cS[1], w, -gIn - latS, yaw, gS, o.y + 7.7);
    }
    // piscina en la azotea + guirnaldas
    const om = at((s0 + s1) / 2, {});
    const pc = [om.x + om.nx * -8, om.z + om.nz * -8];
    EMIS.add(BOXC, M(pc[0], om.y + top + 0.05, pc[1], yawAcross(om), 22, 0.06, 9), [0.15, 0.85, 1.1]);
    glow(pc[0], om.y + top + 1.5, pc[1], 14, [0.05, 0.3, 0.4]);
    for (const h of HOTEL) {
      const pS = [h.o.x + h.o.nx * (latS - 0.3), h.o.z + h.o.nz * (latS - 0.3)];
      glow(pS[0], h.o.y + top + 0.6, pS[1], 1.6, WARM_G);
    }
    HOTEL.top = top;
  }

  tick('hotel');
  // ================================================================= CASINO
  let CASINO = null;
  if (LM_CAS) {
    const cx0 = LM_CAS.x, cz0 = LM_CAS.z;
    const n = near(cx0, cz0, 200);
    const o = at(n.i * DS, {});
    // frente hacia la pista
    let fx = o.x - cx0, fz = o.z - cz0; const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
    const yaw = Math.atan2(fx, fz); // +Z local = frente
    const lx = Math.cos(yaw), lz = -Math.sin(yaw);
    const need = n.wall + 16; // jardines delante
    const dist = Math.max(fl, need + 13);
    const cx = o.x - fx * dist, cz = o.z - fz * dist;
    const yg = groundAt(cx, cz, 70, 30, yaw) + 0.4;
    const CC = hex('#f2dfb4', 1.0);
    building(cx, cz, 50, 24, 15, yaw, yg, CC, [6, 5, 0.85, 3], 2);
    for (const d of [-30, 30]) {
      const px = cx + lx * d, pz = cz + lz * d;
      building(px, pz, 11, 28, 19, yaw, yg, CC, [5.5, 4.75, 0.85, 3], 0);
      PROPS.add(CONE4, M(px, yg + 19, pz, yaw, 8.2, 7, 10.4), [0.2, 0.42, 0.38], { aLit: 0.35 });
      glow(px, yg + 26.5, pz, 2.4, [1.0, 0.8, 0.45]);
      PROPS.add(CYL6, M(px, yg + 25.5, pz, 0, 0.08, 3, 0.08), [0.6, 0.5, 0.3]);
    }
    // cúpula dorada luminosa
    const dy = yg + 15;
    PROPS.add(CYL16, M(cx, dy, cz, 0, 8.5, 4.5, 8.5), CC, { aLit: 0.6 });
    EMIS.add(DOME, M(cx, dy + 4.5, cz, 0, 8.9, 8.2, 8.9), [1.25, 0.95, 0.42]);
    for (let k = 0; k < 12; k++) EMIS.add(BOXC, M(cx, dy + 4.5, cz, (k / 12) * Math.PI * 2, 0.22, 0.22, 0.22), [0, 0, 0]);
    for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2; for (let j = 1; j < 6; j++) { const el = (j / 6) * (Math.PI / 2); glow(cx + Math.cos(a) * 8.95 * Math.cos(el), dy + 4.5 + 8.25 * Math.sin(el), cz + Math.sin(a) * 8.95 * Math.cos(el), 0.9, [1.0, 0.8, 0.4]); } }
    EMIS.add(CYL8, M(cx, dy + 12.6, cz, 0, 1.4, 2.4, 1.4), [3.4, 2.6, 1.2]);
    PROPS.add(CONE8, M(cx, dy + 15, cz, 0, 1.6, 2.5, 1.6), [0.2, 0.42, 0.38]);
    glow(cx, dy + 13.8, cz, 7, [1.0, 0.75, 0.35]);
    glow(cx, dy + 8, cz, 34, [0.32, 0.22, 0.1]);
    for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2; glow(cx + Math.cos(a) * 8.9, dy + 4.8, cz + Math.sin(a) * 8.9, 1.3, WARM_G); }
    // pórtico
    const fpx = cx + fx * 12, fpz = cz + fz * 12;
    for (let k = -3; k <= 3; k++) if (k) PROPS.add(CYL8, M(fpx + fx * 4 + lx * k * 2.6, yg, fpz + fz * 4 + lz * k * 2.6, 0, 0.55, 9.5, 0.55), CC, { aLit: 0.9 });
    PROPS.add(BOXC, M(fpx + fx * 4, yg + 10.2, fpz + fz * 4, yaw, 18.5, 1.4, 3.2), CC, { aLit: 0.7 });
    {
      const m = new THREE.Matrix4().copy(M(fpx + fx * 4, yg + 10.9, fpz + fz * 4, yaw));
      const a = tp(m, -9.3, 0, 1.6), b = tp(m, 9.3, 0, 1.6), c = tp(m, 0, 3.4, 1.6), a2 = tp(m, -9.3, 0, -1.6), b2 = tp(m, 9.3, 0, -1.6), c2 = tp(m, 0, 3.4, -1.6);
      PROPS.tri(a, b, c, CC, { aLit: 0.8 }); PROPS.quad(a, c, c2, a2, CC, { aLit: 0.6 }); PROPS.quad(b, b2, c2, c, CC, { aLit: 0.6 });
    }
    for (let k = 0; k < 4; k++) PROPS.add(BOXC, M(fpx + fx * (6.5 + k * 0.7), yg - 0.2 - k * 0.25, fpz + fz * (6.5 + k * 0.7), yaw, 16 + k * 2, 0.5, 0.8), [0.6, 0.57, 0.52], { aLit: 0.6 });
    EMIS.add(BOXC, M(fpx + fx * 0.3, yg + 4, fpz + fz * 0.3, yaw, 8, 6.5, 0.1), [1.7, 1.25, 0.65]);
    // bombillas del rótulo
    CASINO = { cx, cz, yaw, fx, fz, lx, lz, yg, signAt: { x: fpx + fx * 5.75, y: yg + 13.6, z: fpz + fz * 5.75 } };
    for (let k = 0; k < 22; k++) { const u = (k / 21 - 0.5) * 15; glow(CASINO.signAt.x + lx * u, CASINO.signAt.y + 1.9, CASINO.signAt.z + lz * u, 0.7, [1, 0.8, 0.4], -6, k / 22); glow(CASINO.signAt.x + lx * u, CASINO.signAt.y - 1.9, CASINO.signAt.z + lz * u, 0.7, [1, 0.8, 0.4], -6, k / 22 + 0.5); }
    // focos en la fachada
    for (let k = -4; k <= 4; k++) { glow(cx + fx * 12.6 + lx * k * 6, yg + 0.6, cz + fz * 12.6 + lz * k * 6, 2.2, [1, 0.75, 0.4]); }
    // jardines: fuente circular, parterres, palmeras
    const gx = cx + fx * 24, gz = cz + fz * 24, gy = groundAt(gx, gz);
    fountain(gx, gy, gz, 5.5, false);
    for (const d of [-22, -14, 14, 22]) { const px = gx + lx * d, pz = gz + lz * d; palm(px, groundAt(px, pz), pz, R(9, 11.5), 1); }
    for (const d of [-1, 1]) { const px = gx + lx * d * 9 + fx * 2, pz = gz + lz * d * 9 + fz * 2; PROPS.add(BOX, M(px, gy, pz, yaw, 6, 0.6, 3), [0.12, 0.2, 0.08]); PROPS.add(BOX, M(px, gy + 0.6, pz, yaw, 5.4, 0.25, 2.4), [0.55, 0.09, 0.16], { aLit: 0.4 }); }
    pool(cx + fx * 14, yg + 0.1, cz + fz * 14, 16, [0.22, 0.15, 0.07], yaw, 1.8);
    markRect(cx, cz, 76, 34, yaw, 2);
    markRect(cx + fx * 22, cz + fz * 22, 60, 22, yaw, 0, 2);
    occluderRect(cx, cz, 70, 26, yaw, yg, yg + 19);
    occluder(cx - 9, dy, cz - 9, cx + 9, dy + 12, cz + 9);
    // terraza de público frente al casino
    for (let k = 0; k < 40; k++) { const u = R(-24, 24), v = R(16.5, 19); const px = cx + lx * u + fx * v, pz = cz + lz * u + fz * v; person(px, groundAt(px, pz) + 0.72, pz, yaw + R(-0.5, 0.5), shirt(), 1); }
    PROPS.add(BOXC, M(cx + fx * 19.6, gy + 0.55, cz + fz * 19.6, yaw, 52, 1.1, 0.12), [0.75, 0.7, 0.6], { aLit: 0.6 });
  }

  tick('casino');
  // ================================================================= FUENTE DE LA HORQUILLA
  function fountain(x, y, z, r, big = true) {
    PROPS.add(CYL24, M(x, y - 0.3, z, 0, r, 1.0, r), [0.62, 0.58, 0.52], { aLit: 0.6 });
    EMIS.add(CYL24, M(x, y + 0.5, z, 0, r - 0.45, 0.22, r - 0.45), [0.08, 0.36, 0.5]);
    EMIS.add(TUBE16, M(x, y + 0.66, z, 0, r - 0.4, 0.05, r - 0.4), [0.5, 1.6, 2.2]);
    PROPS.add(CYL16, M(x, y + 0.5, z, 0, 0.6, big ? 2.6 : 1.6, 0.6), [0.62, 0.58, 0.52], { aLit: 0.6 });
    PROPS.add(CYL16, M(x, y + (big ? 3.0 : 2.0), z, 0, big ? 2.2 : 1.5, 0.35, big ? 2.2 : 1.5), [0.62, 0.58, 0.52], { aLit: 0.6 });
    if (big) { PROPS.add(CYL8, M(x, y + 3.3, z, 0, 0.35, 1.6, 0.35), [0.62, 0.58, 0.52], { aLit: 0.6 }); PROPS.add(SPH, M(x, y + 5.3, z, 0, 0.55, 0.55, 0.55), [0.75, 0.6, 0.3], { aLit: 1 }); }
    glow(x, y + 1.5, z, r * 2.2, [0.12, 0.35, 0.45]);
    for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; glow(x + Math.cos(a) * (r - 0.6), y + 0.75, z + Math.sin(a) * (r - 0.6), 0.9, [0.6, 0.9, 1.0]); }
    pool(x, y + 0.08, z, r * 2.4, [0.05, 0.12, 0.16]);
    JETS.push({ x, y: y + (big ? 3.4 : 2.2), z, r: big ? r - 1.2 : r - 1, h: big ? 5.5 : 3.6 });
  }
  if (LM_HP) {
    // centro de curvatura de la horquilla
    let best = null;
    for (const c of T.corners || []) if (inS(c.apex, LM_HP.s0 - 5, LM_HP.s1 + 5)) { if (!best || c.R < best.R) best = c; }
    const o = at(best ? best.apex : (LM_HP.s0 + LM_HP.s1) / 2, {});
    const k = T.k ? T.k[o.i] : 1 / 20;
    let cx = o.x + o.nx / k, cz = o.z + o.nz / k;
    const yg = terrainH(cx, cz);
    fountain(cx, yg, cz, 6.2, true);
    markCircle(cx, cz, 9);
    // isla entre los tramos: palmeras y jardín
    const dirx = -(o.tx), dirz = -(o.tz);
    HAIRPIN = { cx, cz, yg, o };
    for (let k2 = 0; k2 < 6; k2++) {
      const a = (k2 / 6) * Math.PI * 2;
      const px = cx + Math.cos(a) * 9.5, pz = cz + Math.sin(a) * 9.5;
      if (propOK(px, pz, 3)) palm(px, terrainH(px, pz), pz, R(8, 10.5), 1);
    }
    for (let d = 16; d < 90; d += 11) {
      // a lo largo de la isla (dirección opuesta a la tangente en el vértice: el centro de la isla)
      const px = cx + o.nx * 0 + (o.tz) * 0, pz = cz;
      void px; void pz; void dirx; void dirz;
    }
  }

  // ================================================================= PALMERAS / FAROLAS / ÁRBOLES
  function palm(x, yb, z, h, lit = 0) {
    COUNT.palms++;
    const la = rnd() * 6.28, lean = R(0.03, 0.13);
    const lx = Math.sin(la) * lean, lz = Math.cos(la) * lean;
    const segs = 5; let px = x, pz = z, py = yb;
    for (let k = 0; k < segs; k++) {
      const t = (k + 1) / segs, nx = x + lx * h * t * t, nz = z + lz * h * t * t, ny = yb + h * t;
      const r = lerp(0.26, 0.16, t);
      PROPS.add(CYL6, M((px + nx) / 2, py, (pz + nz) / 2, 0, r, ny - py + 0.06, r), [0.26, 0.2, 0.15], { aLit: lit * 0.9 * (1 - t * 0.6) });
      px = nx; pz = nz; py = ny;
    }
    PROPS.add(SPH, M(px, py, pz, 0, 0.42, 0.5, 0.42), [0.22, 0.2, 0.12], { aLit: lit * 0.3 });
    const nF = 10, ph = rnd() * 6.28;
    for (let f = 0; f < nF; f++) {
      const a = (f / nF) * Math.PI * 2 + R(-0.2, 0.2), len = R(3.4, 4.6), ca = Math.cos(a), sa = Math.sin(a);
      const up = R(0.35, 0.7);
      const pt = (t) => [px + ca * len * t, py + len * (up * t - 0.85 * t * t), pz + sa * len * t];
      const wv = (t) => 0.6 * (1 - t * 0.75);
      const cA = [0.05, 0.11, 0.045], cB = [0.08, 0.16, 0.06];
      for (let k = 0; k < 4; k++) {
        const t0 = k / 4, t1 = (k + 1) / 4, p0 = pt(t0), p1 = pt(t1), w0 = wv(t0), w1 = wv(t1);
        const A = [p0[0] - sa * w0, p0[1], p0[2] + ca * w0], B = [p0[0] + sa * w0, p0[1], p0[2] - ca * w0];
        const C = [p1[0] + sa * w1, p1[1] - 0.05, p1[2] - ca * w1], D = [p1[0] - sa * w1, p1[1] - 0.05, p1[2] + ca * w1];
        const col = k < 2 ? cA : cB;
        const e0 = { aSway: [0.1 * t0 * len / 4, ph + f, 1.7], aLit: lit * 0.4 * (1 - t0 * 0.7) }, e1 = { aSway: [0.1 * t1 * len / 4, ph + f, 1.7], aLit: lit * 0.4 * (1 - t1 * 0.7) };
        for (const [q, e] of [[A, e0], [B, e0], [C, e1], [A, e0], [C, e1], [D, e1]]) SWAY._push(q[0], q[1], q[2], 0, 1, 0, col, 0, 0, e);
      }
    }
    if (lit) { glow(x, yb + 0.35, z, 1.3, [1.0, 0.75, 0.45]); pool(x, yb + 0.07, z, 3.2, [0.13, 0.08, 0.04]); }
    markCircle(x, z, 1.5);
  }
  function cypress(x, yb, z, h) {
    COUNT.trees++;
    const r = h * R(0.12, 0.16), ph = rnd() * 6.28;
    SWAY.add(CONE8, M(x, yb - 0.3, z, rnd() * 3, r, h, r), [0.04, 0.085, 0.05], (ly) => ({ aSway: [0.05 * ly, ph, 1.1], aLit: 0 }));
  }
  function pine(x, yb, z, h) {
    COUNT.trees++;
    PROPS.add(CYL6, M(x, yb, z, 0, 0.2, h * 0.8, 0.2), [0.22, 0.17, 0.12]);
    const ph = rnd() * 6.28;
    SWAY.add(SPH, M(x, yb + h * 0.82, z, rnd() * 3, h * 0.38, h * 0.16, h * 0.38), [0.05, 0.1, 0.055], (ly) => ({ aSway: [0.05 * (ly + 1), ph, 1.0], aLit: 0 }));
  }
  const LAMPS = { 1: [], [-1]: [] };
  function streetLamp(x, yb, z, yaw, h = 7.2, arm = 1.6) {
    COUNT.lamps++;
    const dark = [0.05, 0.075, 0.065];
    PROPS.add(CYL8, M(x, yb - 0.2, z, 0, 0.2, 1.0, 0.2), dark);
    PROPS.add(CYL6, M(x, yb, z, 0, 0.085, h, 0.085), dark);
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    PROPS.add(BOXC, M(x + (fx * arm) / 2, yb + h - 0.05, z + (fz * arm) / 2, yaw, 0.07, 0.07, arm), dark);
    const lx = x + fx * arm, lz = z + fz * arm, ly = yb + h - 0.32;
    PROPS.add(BOXC, M(lx, ly + 0.2, lz, yaw, 0.55, 0.22, 0.8), dark);
    EMIS.add(BOXC, M(lx, ly, lz, yaw, 0.44, 0.16, 0.66), WARM_L);
    glow(lx, ly - 0.15, lz, 3.6, WARM_G);
    return [lx, ly, lz];
  }
  function promLamp(x, yb, z) {
    COUNT.lamps++;
    const dark = [0.05, 0.075, 0.065];
    PROPS.add(CYL8, M(x, yb - 0.2, z, 0, 0.22, 0.9, 0.22), dark);
    PROPS.add(CYL6, M(x, yb, z, 0, 0.08, 4.3, 0.08), dark);
    PROPS.add(BOXC, M(x, yb + 4.2, z, 0.3, 1.5, 0.07, 0.07), dark);
    for (const d of [-0.72, 0.72]) {
      const gx = x + Math.cos(0.3) * d, gz = z - Math.sin(0.3) * d;
      EMIS.add(SPH_LO, M(gx, yb + 4.55, gz, 0, 0.26, 0.3, 0.26), [4.4, 3.4, 2.2]);
      glow(gx, yb + 4.55, gz, 2.4, [1.0, 0.75, 0.48]);
    }
    return [x, yb + 4.55, z];
  }

  tick('fountain');
  // --- farolas a lo largo de la pista
  for (let s = 0; s < L; s += Q.lamps) for (const side of [1, -1]) {
    const ss = s + (side > 0 ? 0 : Q.lamps / 2);
    if (LM_TUN && inS(ss, LM_TUN.s0 - 8, LM_TUN.s1 + 8)) continue;
    const o = at(ss, {});
    const wall = wallOf(o.i, side);
    const lat = side * (wall + 2.4);
    const x = o.x + o.nx * lat, z = o.z + o.nz * lat;
    if (!isLand(x, z) || occ(x, z)) continue;
    const n = near(x, z, 60); if (n.d < n.wall + 2.2) continue;
    const yb = terrainH(x, z);
    const yaw = Math.atan2(-side * o.nx, -side * o.nz);
    const [lx, ly, lz] = streetLamp(x, yb, z, yaw);
    pool(x, yb + 0.05, z, 7, [0.11, 0.07, 0.035], yawAlong(o), 1.3);
    streak(lx, ly, lz, o.y, 1.1, [0.5, 0.32, 0.15], 1);
    markCircle(x, z, 1.4);
    LAMPS[side].push({ x, z, yb, s: ss });
  }
  // --- paseo marítimo: farolas, palmeras iluminadas, banderines
  const PROM = [];
  for (let x = -296; x <= 296; x += 20) {
    const z = QUAY_Z + 1.5;
    if (occ(x, z)) continue;
    const yb = terrainH(x, z + 1);
    const p = promLamp(x, yb, z);
    streak(x, yb + 4.55, z, WY, 1.4, [0.62, 0.42, 0.22]);
    pool(x, yb + 0.06, z + 2, 5.5, [0.12, 0.085, 0.05]);
    PROM.push({ x, z, y: yb + 4.2 });
    markCircle(x, z, 1);
    const pxp = x + 10, pzp = QUAY_Z + 4.5;
    if (rnd() < Q.palms && !occ(pxp, pzp) && near(pxp, pzp).d > near(pxp, pzp).wall + 3) palm(pxp, terrainH(pxp, pzp), pzp, R(9, 12.5), 1);
  }
  // guirnaldas de bombillas entre farolas del paseo
  if (Q.strings) for (let k = 0; k < PROM.length - 1; k++) {
    const a = PROM[k], b = PROM[k + 1];
    if (b.x - a.x > 24) continue;
    for (let j = 1; j < 14; j++) { const t = j / 14; const sag = 1.1 * 4 * t * (1 - t); glow(lerp(a.x, b.x, t), lerp(a.y, b.y, t) - sag, lerp(a.z, b.z, t), 0.55, [1.0, 0.8, 0.5]); }
  }
  // banderines (pennants) entre farolas del mismo lado
  function bunting(a, b, y0, y1, sag) {
    if (!Q.bunting) return;
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const n = Math.floor(len / 0.55), cols = [hex('#e3262f'), hex('#ffd23a'), hex('#1f5fd0'), hex('#f4f1ea'), hex('#18a06a')];
    const dx = (b[0] - a[0]) / len, dz = (b[2] - a[2]) / len, ph = rnd() * 6;
    for (let j = 0; j < n; j++) {
      const t = (j + 0.5) / n, y = lerp(y0, y1, t) - sag * 4 * t * (1 - t);
      const x = lerp(a[0], b[0], t), z = lerp(a[2], b[2], t), col = cols[j % cols.length];
      const e0 = { aSway: [0.02, ph + j * 0.4, 3], aLit: 0.3 }, e1 = { aSway: [0.12, ph + j * 0.4, 3], aLit: 0.3 };
      const A = [x - dx * 0.2, y, z - dz * 0.2], B = [x + dx * 0.2, y, z + dz * 0.2], C = [x, y - 0.4, z];
      for (const [q, e] of [[A, e0], [B, e0], [C, e1]]) SWAY._push(q[0], q[1], q[2], 0, 1, 0, col, 0, 0, e);
    }
  }
  for (let k = 0; k < PROM.length - 1; k++) { const a = PROM[k], b = PROM[k + 1]; if (b.x - a.x < 24) bunting([a.x, 0, a.z], [b.x, 0, b.z], a.y + 0.6, b.y + 0.6, 0.9); }
  for (const side of [1, -1]) {
    const arr = LAMPS[side];
    for (let k = 0; k < arr.length - 1; k++) {
      const a = arr[k], b = arr[k + 1];
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d > Q.lamps * 1.35 || d < 8) continue;
      bunting([a.x, 0, a.z], [b.x, 0, b.z], a.yb + 6.2, b.yb + 6.2, 1.2);
    }
  }

  tick('lamps');
  // ================================================================= MUELLE, ESCOLLERAS, FARO
  {
    // muro del muelle principal
    PROPS.add(BOXC, M(0, -1.75, QUAY_Z - 0.35, 0, 600, 3.9, 0.9), [0.32, 0.3, 0.27], { aLit: 0.25 });
    PROPS.add(BOXC, M(0, 0.07, QUAY_Z - 0.35, 0, 600, 0.3, 1.5), [0.55, 0.52, 0.47], { aLit: 0.3 });
    for (let x = -296; x <= 296; x += 9) if (!occ(x, QUAY_Z + 0.6)) PROPS.add(CYL8, M(x, 0.2, QUAY_Z + 0.25, 0, 0.2, 0.55, 0.2), [0.08, 0.08, 0.09]);
    // escolleras
    for (const m of MOLES) {
      const dx = m.b[0] - m.a[0], dz = m.b[1] - m.a[1], len = Math.hypot(dx, dz), yaw = Math.atan2(dx, dz);
      const cx = (m.a[0] + m.b[0]) / 2, cz = (m.a[1] + m.b[1]) / 2;
      PROPS.add(BOXC, M(cx, -1.5, cz, yaw, m.r * 1.5, 4.4, len + m.r), [0.42, 0.41, 0.39], { aLit: 0.1 });
      const nx = dz / len, nz = -dx / len;
      PROPS.add(BOXC, M(cx + nx * m.r * 0.6, 1.4, cz + nz * m.r * 0.6, yaw, 1.0, 1.6, len + m.r * 0.8), [0.5, 0.49, 0.46], { aLit: 0.1 });
      const nR = Math.floor((len / 3.5) * Q.rocks);
      for (let k = 0; k < nR; k++) {
        const t = rnd(), sd = rnd() < 0.5 ? -1 : 1, off = m.r * R(0.75, 1.1);
        const px = m.a[0] + dx * t + nx * sd * off, pz = m.a[1] + dz * t + nz * sd * off;
        const sc = R(1.2, 2.4);
        PROPS.add(ICO, M(px, WY + R(-0.6, 0.3), pz, rnd() * 6, sc * R(0.8, 1.3), sc * 0.8, sc), [0.36, 0.35, 0.34]);
      }
      for (let t = 25; t < len - 10; t += 32) {
        const px = m.a[0] + (dx * t) / len - nx * m.r * 0.3, pz = m.a[1] + (dz * t) / len - nz * m.r * 0.3;
        PROPS.add(CYL6, M(px, 0.7, pz, 0, 0.07, 3.6, 0.07), [0.1, 0.1, 0.1]);
        EMIS.add(SPH_LO, M(px, 4.35, pz, 0, 0.2, 0.2, 0.2), [3.8, 3.4, 2.8]);
        glow(px, 4.35, pz, 2.0, [0.85, 0.8, 0.7]);
        streak(px, 4.35, pz, WY, 0.9, [0.4, 0.38, 0.33]);
      }
    }
    // faro (punta de la escollera este)
    const L0 = MOLES[1].b, fx = L0[0] + 2, fz = L0[1];
    FARO = { x: fx, y: 0.7 + 24.2, z: fz };
    PROPS.add(CYL24, M(fx, 0.4, fz, 0, 5, 1.2, 5), [0.6, 0.58, 0.55], { aLit: 0.2 });
    const bands = 6;
    for (let k = 0; k < bands; k++) {
      const t0 = k / bands, t1 = (k + 1) / bands;
      const r0 = lerp(3.2, 2.3, t0), r1 = lerp(3.2, 2.3, t1);
      const g = tg(new THREE.CylinderGeometry(r1, r0, 22 / bands, 16, 1).translate(0, 11 / bands, 0));
      PROPS.add(g, M(fx, 1.6 + 22 * t0, fz), k % 2 ? [0.62, 0.1, 0.08] : [0.86, 0.86, 0.84], { aLit: 0.15 });
    }
    PROPS.add(CYL16, M(fx, 23.6, fz, 0, 3.4, 0.35, 3.4), [0.15, 0.15, 0.16]);
    EMIS.add(CYL8, M(fx, 23.95, fz, 0, 1.55, 2.4, 1.55), [4.5, 3.9, 2.6]);
    PROPS.add(CONE8, M(fx, 26.35, fz, 0, 1.9, 2.2, 1.9), [0.62, 0.1, 0.08]);
    glow(fx, 25.1, fz, 9, [1.0, 0.92, 0.7]);
    glow(fx, 25.1, fz, 20, [0.6, 0.5, 0.35], -1.6, 0);
    streak(fx, 25.1, fz, WY, 3.2, [0.6, 0.52, 0.36]);
    for (let k = 0; k < 4; k++) streak(fx + R(-3, 3), R(2, 20), fz + R(-3, 3), WY, 1.2, [0.18, 0.18, 0.17]);
    // luz verde en la escollera oeste
    const g0 = MOLES[2].b;
    PROPS.add(CYL8, M(g0[0], 0.7, g0[1], 0, 1.1, 6.5, 1.1), [0.2, 0.55, 0.3], { aLit: 0.2 });
    glow(g0[0], 7.8, g0[1], 4.5, [0.2, 1.0, 0.35], 0.45, 0.1);
    EMIS.add(SPH, M(g0[0], 7.6, g0[1], 0, 0.45, 0.45, 0.45), [0.4, 3.0, 0.8]);
    streak(g0[0], 7.6, g0[1], WY, 1.2, [0.05, 0.4, 0.12]);
  }

  tick('moles');
  // ================================================================= PANTALANES Y YATES AMARRADOS
  function yacht(base, Lb, kind, hullCol, B = PROPS, E = EMIS, dyn = false) {
    const Bm = Lb * 0.3, dk = 1.0 + Lb * 0.045, keel = -0.6;
    const st = -Lb / 2, md = Lb * 0.12, bw = Lb / 2;
    const pts = {
      SLt: [Bm / 2, dk, st], SRt: [-Bm / 2, dk, st], SLb: [Bm * 0.4, keel, st], SRb: [-Bm * 0.4, keel, st],
      MLt: [Bm / 2, dk, md], MRt: [-Bm / 2, dk, md], MLb: [Bm * 0.4, keel, md], MRb: [-Bm * 0.4, keel, md],
      Bt: [0, dk + 0.45, bw], Bb: [0, keel + 0.4, bw - 1.2],
    };
    const P = {}; for (const k in pts) P[k] = tp(base, ...pts[k]);
    const ex = { aLit: 0.15 };
    B.quad(P.SLb, P.MLb, P.MLt, P.SLt, hullCol, ex); B.quad(P.SRt, P.MRt, P.MRb, P.SRb, hullCol, ex);
    B.quad(P.MLb, P.Bb, P.Bt, P.MLt, hullCol, ex); B.quad(P.MRt, P.Bt, P.Bb, P.MRb, hullCol, ex);
    B.quad(P.SRb, P.SLb, P.SLt, P.SRt, hullCol, ex);
    const deck = [0.45, 0.33, 0.22];
    B.quad(P.SLt, P.MLt, P.MRt, P.SRt, deck, ex); B.tri(P.MLt, P.Bt, P.MRt, deck, ex);
    const white = [0.88, 0.89, 0.92];
    const cabL = Lb * 0.42, cabZ = -Lb * 0.06;
    if (kind !== 'sail') {
      B.add(BOX, MM(base, 0, dk, cabZ, 0, Bm * 0.74, 1.35, cabL), white, ex);
      if (rnd() < 0.75 || dyn) E.add(BOXC, MM(base, 0, dk + 0.78, cabZ, 0, Bm * 0.76, 0.3, cabL * 0.9), dyn ? [1.5, 0.95, 0.45] : [R(0.9, 1.5), R(0.55, 0.9), R(0.22, 0.4)]);
      if (Lb > 15) {
        B.add(BOX, MM(base, 0, dk + 1.35, cabZ - Lb * 0.05, 0, Bm * 0.6, 0.9, cabL * 0.6), white, ex);
        E.add(BOXC, MM(base, 0, dk + 1.8, cabZ - Lb * 0.05, 0, Bm * 0.62, 0.2, cabL * 0.55), [0.9, 0.7, 0.45]);
        B.add(BOXC, MM(base, 0, dk + 3.0, cabZ - Lb * 0.02, 0, Bm * 0.5, 0.15, 0.4), white, ex);
      }
    } else {
      B.add(BOX, MM(base, 0, dk, cabZ, 0, Bm * 0.6, 0.6, cabL * 0.8), white, ex);
      if (rnd() < 0.5) E.add(BOXC, MM(base, 0, dk + 0.35, cabZ, 0, Bm * 0.62, 0.14, cabL * 0.6), [1.1, 0.7, 0.3]);
      const mh = Lb * 1.15;
      B.add(CYL6, MM(base, 0, dk, Lb * 0.08, 0, 0.09, mh, 0.09), [0.75, 0.75, 0.78], ex);
      B.add(BOXC, MM(base, 0, dk + 1.3, Lb * 0.08 - Lb * 0.18, 0, 0.1, 0.1, Lb * 0.36), [0.75, 0.75, 0.78], ex);
      const mt = tp(base, 0, dk + mh, Lb * 0.08);
      if (!dyn) glow(mt[0], mt[1], mt[2], 0.7, [1.0, 0.95, 0.85]);
    }
    return dk;
  }
  {
    const PX = [-262, -212, -60, 22, 104, 186, 258];
    const fwx = PODIUM.fw.x;
    for (const px of PX) {
      if (Math.abs(px - fwx) < 30) continue;
      const len = 62 + (px % 3) * 6, z0 = QUAY_Z, yb = WY + 0.42;
      PROPS.add(BOXC, M(px, yb, z0 - len / 2, 0, 2.6, 0.4, len), [0.3, 0.25, 0.2], { aLit: 0.15 });
      for (let z = z0 - 10; z > z0 - len + 2; z -= 11) {
        for (const sd of [-1, 1]) {
          PROPS.add(BOXC, M(px + sd * 6.5, yb, z - 5.5, 0, 10, 0.3, 1.0), [0.3, 0.25, 0.2], { aLit: 0.1 });
          if (rnd() < 0.86) {
            const Lb = R(10, 24), kind = rnd() < 0.45 ? 'sail' : 'motor';
            const hc = rnd() < 0.72 ? [0.86, 0.87, 0.9] : pick([[0.06, 0.08, 0.18], [0.1, 0.18, 0.14], [0.45, 0.08, 0.06]]);
            const yx = px + sd * (1.6 + Lb / 2), yz = z + R(-0.6, 0.6);
            const base = new THREE.Matrix4().copy(M(yx, WY, yz, sd > 0 ? Math.PI / 2 : -Math.PI / 2));
            const dk = yacht(base, Lb, kind, hc);
            COUNT.yachts++;
            if (kind !== 'sail' && rnd() < 0.5) streak(yx, WY + dk + 0.8, yz, WY, 1.0, [0.42, 0.28, 0.14]);
            if (kind !== 'sail' && Lb > 17 && rnd() < 0.5) {
              // fiesta a bordo
              for (let q = 0; q < 5; q++) { const pp = tp(base, R(-1.2, 1.2), dk + 1.35 + 0.72, R(-Lb * 0.3, -Lb * 0.1)); person(pp[0], pp[1], pp[2], rnd() * 6.28, shirt(), 1); }
              const a = tp(base, 0, dk + 3.0, -Lb * 0.08), b = tp(base, 0, dk + 0.5, Lb * 0.48), c = tp(base, 0, dk + 0.5, -Lb * 0.48);
              for (let j = 1; j < 9; j++) { const t = j / 9; glow(lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), 0.45, pick([[1, 0.4, 0.3], [0.4, 0.7, 1], [1, 0.85, 0.4]])); glow(lerp(a[0], c[0], t), lerp(a[1], c[1], t), lerp(a[2], c[2], t), 0.45, pick([[1, 0.4, 0.3], [0.4, 0.7, 1], [1, 0.85, 0.4]])); }
            }
          }
        }
        EMIS.add(BOXC, M(px + 1.2, yb + 0.55, z, 0, 0.18, 0.5, 0.18), [3, 2.6, 2]);
        glow(px + 1.2, yb + 0.85, z, 1.2, [1.0, 0.85, 0.6]);
        streak(px + 1.2, yb + 0.85, z, WY, 0.45, [0.35, 0.27, 0.16]);
      }
    }
  }

  tick('marina');
  // ================================================================= CRUCERO ILUMINADO
  {
    const cx = 160, cz = -470, yaw = Math.PI / 2, Lc = 230, Bc = 30;
    const navy = [0.05, 0.07, 0.13], wht = [0.86, 0.87, 0.9];
    building(cx, cz, Bc, Lc, 12.5, yaw, WY, navy, [2.4, 2.5, 0.55, 2], 0, wht, 4);
    const base = new THREE.Matrix4().copy(M(cx, WY, cz, yaw));
    { // proa
      const a = tp(base, Bc / 2, -4, Lc / 2), b = tp(base, -Bc / 2, -4, Lc / 2), c = tp(base, Bc / 2, 12.5, Lc / 2), d = tp(base, -Bc / 2, 12.5, Lc / 2);
      const t1 = tp(base, 0, 13.5, Lc / 2 + 26), t0 = tp(base, 0, -4, Lc / 2 + 16);
      PROPS.quad(a, c, t1, t0, navy); PROPS.quad(b, t0, t1, d, navy); PROPS.tri(c, d, t1, wht);
    }
    for (let k = 0; k < 8; k++) {
      const lk = Lc * (0.78 - k * 0.045), zc = -Lc * 0.04 - k * 1.2, bk = Bc * (0.94 - k * 0.025);
      const p = tp(base, 0, 0, zc);
      building(p[0], p[2], bk, lk, 3.05, yaw, WY + 12.5 + k * 3.05, wht, [2.1, 3.05, 0.84, 2], 0, [0.7, 0.72, 0.76], 0.2);
    }
    const fp = tp(base, 0, 0, -Lc * 0.3);
    PROPS.add(BOXC, M(fp[0], WY + 40, fp[2], yaw, 9, 10, 15), [0.08, 0.08, 0.1]);
    EMIS.add(BOXC, M(fp[0], WY + 42, fp[2], yaw, 9.2, 2.4, 6), [2.6, 0.5, 0.35]);
    // luces de engalanado: proa → mástil → popa
    const mast = tp(base, 0, 54, Lc * 0.18), bow = tp(base, 0, 13.5, Lc / 2 + 26), stern = tp(base, 0, 14, -Lc / 2);
    PROPS.add(CYL6, M(mast[0], WY + 36, mast[2], 0, 0.3, 18, 0.3), wht);
    glow(mast[0], mast[1] + 0.5, mast[2], 2.5, [1, 0.15, 0.1], 0.5, 0.3);
    for (let j = 1; j < 30; j++) {
      const t = j / 30;
      const c1 = pick([[1, 0.75, 0.4], [0.6, 0.85, 1], [1, 0.45, 0.35], [0.6, 1, 0.6]]);
      glow(lerp(bow[0], mast[0], t), lerp(bow[1], mast[1], t) - 3 * Math.sin(Math.PI * t), lerp(bow[2], mast[2], t), 1.6, c1);
      glow(lerp(stern[0], mast[0], t), lerp(stern[1], mast[1], t) - 4 * Math.sin(Math.PI * t), lerp(stern[2], mast[2], t), 1.6, c1);
    }
    for (let k = 0; k < 12; k++) {
      const t = (k + 0.5) / 12, p = tp(base, (k % 2 ? 1 : -1) * Bc * 0.3, 0, (t - 0.5) * Lc * 0.9);
      streak(p[0], WY + 8 + (k % 3) * 6, p[2] + 15, WY, 3.0, [0.38, 0.33, 0.25]);
    }
    for (let k = 0; k < 6; k++) { const p = tp(base, Bc * 0.5, 30, (k / 5 - 0.5) * Lc * 0.6); glow(p[0], p[1], p[2], 6, [0.3, 0.27, 0.22]); }
  }

  // ================================================================= PASARELA SOBRE LA SUBIDA
  {
    const sB = 330;
    const o = at(sB, {});
    const lL = WALL_L[o.i] + 3, lR = -(WALL_R[o.i] + 3);
    const pL = [o.x + o.nx * lL, o.z + o.nz * lL], pR = [o.x + o.nx * lR, o.z + o.nz * lR];
    const ok = [pL, pR].every((p) => isLand(p[0], p[1]) && !occ(p[0], p[1]));
    if (ok) {
      const yaw = yawAlong(o), span = lL - lR, mid = (lL + lR) / 2, mx = o.x + o.nx * mid, mz = o.z + o.nz * mid;
      const dy = o.y + 7.6;
      PROPS.add(BOXC, M(mx, dy + 0.35, mz, yaw, span + 4, 0.7, 3.4), [0.85, 0.86, 0.88], { aLit: 0.2 });
      for (const sd of [-1, 1]) {
        PROPS.add(BOXC, M(mx + o.tx * sd * 1.6, dy + 1.25, mz + o.tz * sd * 1.6, yaw, span + 4, 1.1, 0.08), [0.7, 0.75, 0.8], { aLit: 0.3 });
      }
      EMIS.add(BOXC, M(mx, dy - 0.02, mz, yaw, span + 3, 0.06, 0.4), [2.8, 2.3, 1.6]);
      for (const p of [pL, pR]) {
        const yg = terrainH(p[0], p[1]);
        PROPS.add(BOX, M(p[0], yg - 1, p[1], yaw, 4.2, dy + 0.7 - yg + 1, 4.2), [0.8, 0.8, 0.82], { aLit: 0.25 });
        markCircle(p[0], p[1], 4);
      }
      for (let k = 0; k < 14; k++) { const u = R(-span / 2 + 1, span / 2 - 1); person(mx + o.nx * u + o.tx * R(-0.8, 0.4), dy + 0.7 + 0.72, mz + o.nz * u + o.tz * R(-0.8, 0.4), Math.atan2(-o.tx, -o.tz) + R(-0.4, 0.4), shirt(), 1); }
      for (let k = -4; k <= 4; k++) glow(mx + o.nx * k * 3, dy - 0.3, mz + o.nz * k * 3, 1.2, [1, 0.85, 0.6]);
      BRIDGE = { mx, mz, dy, yaw, span, o };
      occluder(mx - Math.abs(o.nx) * span / 2 - 2, dy, mz - Math.abs(o.nz) * span / 2 - 2, mx + Math.abs(o.nx) * span / 2 + 2, dy + 1.6, mz + Math.abs(o.nz) * span / 2 + 2);
    }
  }

  tick('cruise');
  // ================================================================= EDIFICIOS
  const FLOOR_H = 3.2;
  function zoneFloors(x, z) {
    if (x > 330 && z > 40 && z < 360) return Math.round(R(9, 17));
    if (x < -300) return Math.round(R(2, 4));
    if (z > 420) return Math.round(R(2, 3.6));
    if (z < 120 && z > -10) return Math.round(R(4, 7.4));
    return Math.round(R(3.5, 6.4));
  }
  function placeBuilding(x, z, w, d, yaw, floors, frontSide = 0, o = null, gap = 1.5) {
    if (!fits(x, z, w, d, yaw, gap)) return false;
    const yg = groundAt(x, z, w, d, yaw);
    const col = pick(FACADES);
    const tower = floors > 8;
    const h = floors * FLOOR_H + 0.9;
    const roof = tower ? 2 : rnd() < 0.6 ? 1 : 2;
    building(x, z, w, d, h, yaw, yg, col, tower ? [3.6, FLOOR_H, R(0.4, 0.62), 1] : [R(2.9, 3.6), FLOOR_H, R(0.35, 0.62), 0], roof, roof === 1 ? ROOF_T : ROOF_F);
    markRect(x, z, w, d, yaw, 1.2);
    if (h > 12 && o) occluderRect(x, z, w, d, yaw, yg, yg + h);
    // terraza con luces en azoteas
    if (roof === 2 && rnd() < 0.3) { for (let k = 0; k < 6; k++) glow(x + R(-w / 3, w / 3), yg + h + 1.4, z + R(-d / 3, d / 3), 0.6, [1, 0.8, 0.5]); }
    // balcones con público hacia la pista
    if (frontSide && o && floors >= 3) {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const fz = frontSide; // +1: fachada local +z mira a la pista
      const nb = Math.min(floors - 1, 4);
      for (let f = 1; f <= nb; f++) {
        if (rnd() < 0.25) continue;
        const by = yg + f * FLOOR_H;
        const bw = w * R(0.45, 0.8), bxo = R(-(w - bw) / 2, (w - bw) / 2);
        const lz = fz * (d / 2 + 0.6);
        const px = x + bxo * c + lz * s, pz = z - bxo * s + lz * c;
        PROPS.add(BOXC, M(px, by + 0.05, pz, yaw, bw, 0.18, 1.2), [col[0] * 0.95, col[1] * 0.92, col[2] * 0.9], { aLit: 0.55 });
        const lz2 = fz * (d / 2 + 1.15), rx = x + bxo * c + lz2 * s, rz = z - bxo * s + lz2 * c;
        PROPS.add(BOXC, M(rx, by + 0.6, rz, yaw, bw, 0.9, 0.05), [0.12, 0.13, 0.12], { aLit: 0.2 });
        const np = Math.floor(bw / 1.1);
        for (let k = 0; k < np; k++) if (rnd() < 0.65) {
          const u = bxo - bw / 2 + 0.55 + k * 1.1, v = fz * (d / 2 + 0.55);
          person(x + u * c + v * s, by + 0.14 + 0.72, z - u * s + v * c, yaw + (fz > 0 ? 0 : Math.PI) + R(-0.35, 0.35), shirt(), 1);
        }
        glow(px, by + 2.6, pz, 1.4, WARM_G);
      }
    }
    return true;
  }
  // fachadas a pie de calle (cañón urbano)
  for (const side of [1, -1]) {
    let s = side > 0 ? 0 : 7;
    while (s < L) {
      const o = at(s, {});
      if (LM_TUN && inS(s, LM_TUN.s0 - 10, LM_TUN.s1 + 8)) { s += 6; continue; }
      const wall = wallOf(o.i, side);
      const w = R(12, 19), d = R(10, 15);
      const lat = side * (wall + 1.6 + d / 2);
      const x = o.x + o.nx * lat, z = o.z + o.nz * lat;
      const yaw = yawAcross(o);
      const floors = Math.max(3, zoneFloors(x, z) + (wall < 14 ? 1 : 0));
      const ok = wall < 30 && placeBuilding(x, z, w, d, yaw, floors, side > 0 ? 1 : -1, o, 1.5);
      s += ok ? w * 0.92 + R(0.5, 3) : 4;
    }
  }
  tick('frontage');
  // relleno por parcelas
  {
    const step = 21;
    for (let gz = -60; gz < 760; gz += step) for (let gx = -560; gx < 760; gx += step) {
      const x = gx + R(-5, 5), z = gz + R(-5, 5);
      if (!isLand(x, z)) continue;
      const n = near(x, z, 160);
      const far = n.d > 140;
      const dens = (far ? 0.3 : n.d > 90 ? 0.6 : 0.95) * Q.fill * (z > 560 || x > 600 || x < -460 ? 0.4 : 1);
      if (rnd() > dens) continue;
      let yaw;
      if (!far && n.d < 70) { const o = at(n.i * DS, {}); yaw = yawAcross(o) + (rnd() < 0.3 ? Math.PI / 2 : 0); }
      else yaw = R(-0.2, 0.2) + (x > 330 ? -0.35 : 0);
      const old = x < -300;
      const w = old ? R(8, 12) : R(11, 20), d = old ? R(7, 11) : R(9, 15);
      placeBuilding(x, z, w, d, yaw, zoneFloors(x, z), 0, null, 1.6);
    }
  }
  tick('fill');
  // iglesia del casco antiguo
  {
    const x = -384, z = -100;
    if (isLand(x, z)) {
      const yg = groundAt(x, z, 14, 26, 0.3);
      building(x, z, 13, 26, 11, 0.3, yg, hex('#e7d6b6'), [4, 5, 0.4, 3], 1, ROOF_T);
      const bx = x + 8, bz = z - 10, by = groundAt(bx, bz);
      building(bx, bz, 5.5, 5.5, 24, 0.3, by, hex('#ead9b8'), [5.5, 8, 0.9, 3], 0);
      PROPS.add(CONE4, M(bx, by + 24, bz, 0.3, 4.4, 6, 4.4), ROOF_T);
      EMIS.add(CYL16, M(bx + Math.sin(0.3) * 2.8, by + 19, bz + Math.cos(0.3) * 2.8, 0.3, 1.1, 0.05, 1.1, Math.PI / 2), [3, 2.5, 1.5]);
      glow(bx, by + 18, bz, 10, [0.6, 0.45, 0.25]);
      for (const d of [-1, 1]) glow(x + d * 7, yg + 0.5, z + 14, 3, [1, 0.75, 0.4]);
    }
  }
  // árboles: cipreses y pinos en la colina; palmeras en el interior
  {
    const nT = Math.round(260 * Q.fill);
    for (let k = 0; k < nT; k++) {
      const x = R(-520, 700), z = R(60, 700);
      if (!isLand(x, z) || occ(x, z) || noBuild(x, z)) continue;
      const n = near(x, z, 60); if (n.d < n.wall + 3) continue;
      const yb = terrainH(x, z);
      if (z > 300 || rnd() < 0.4) { if (rnd() < 0.6) cypress(x, yb, z, R(9, 15)); else pine(x, yb, z, R(9, 14)); }
      else if (rnd() < 0.5 * Q.palms) palm(x, yb, z, R(8, 12), 0);
      markCircle(x, z, 2);
    }
    // avenida de palmeras en la subida (detrás de las farolas)
    for (const c of T.corners || []) void c;
  }

  tick('trees');
  // avenida de palmeras con focos a lo largo del circuito
  for (let s = 13; s < L; s += 24) for (const side of [1, -1]) {
    if (rnd() > 0.55 * Q.palms) continue;
    if (LM_TUN && inS(s, LM_TUN.s0 - 10, LM_TUN.s1 + 10)) continue;
    const o = at(s);
    const lat = side * (wallOf(o.i, side) + 4.2);
    const x = o.x + o.nx * lat, z = o.z + o.nz * lat;
    if (!propOK(x, z, 3.5) || noBuild(x, z) && !(z < 0 && z > QUAY_Z)) continue;
    palm(x, terrainH(x, z), z, R(8.5, 12), 1);
  }
  // pueblos lejanos en las laderas
  for (let k = 0; k < 260; k++) {
    const x = R(-1050, 1150), z = R(380, 1050);
    if (Math.abs(x - 60) < 520 && z < 520) continue;
    const y = terrainH(x, z);
    if (rnd() < 0.5) glow(x, y + 2, z, R(2.5, 4.5), rnd() < 0.8 ? [1.0, 0.62, 0.3] : [0.85, 0.85, 1.0], rnd() < 0.05 ? -2 : 0, rnd());
    else for (let q = 0; q < 5; q++) glow(x + R(-25, 25), terrainH(x, z) + 2 + R(0, 6), z + R(-25, 25), R(2, 3.6), [1.0, 0.6, 0.28]);
  }
  // ================================================================= SUELO (terreno con baldosas)
  const ENV = buildEnv();
  let groundMat;
  const paveTex = makePaveTex(), puddleTex = makePuddleTex();
  {
    const cell = Q.cell;
    const xs = [], zs = [];
    for (let x = -440; x <= 580; x += cell) xs.push(x);
    { let x = -440, st = cell; while (x > -1100) { st *= 1.18; x -= st; xs.unshift(x); } x = xs[xs.length - 1]; st = cell; while (x < 1150) { st *= 1.18; x += st; xs.push(x); } }
    const zStart = QUAY_Z - cell * Math.ceil((QUAY_Z + 285) / cell);
    for (let z = zStart; z <= 560; z += cell) zs.push(z);
    { let z = zs[zs.length - 1], st = cell; while (z < 1050) { st *= 1.18; z += st; zs.push(z); } }
    const nx = xs.length, nz = zs.length;
    const pos = new Float32Array(nx * nz * 3), col = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2);
    const H = new Float32Array(nx * nz);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const x = xs[i], z = zs[j], k = j * nx + i;
      const h = terrainH(x, z), land = TH_LAND, e = TH_E;
      H[k] = h;
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      uv[k * 2] = x / 3.2; uv[k * 2 + 1] = z / 3.2;
      // color de zona
      let c;
      const nse = Math.sin(x * 0.07) * Math.sin(z * 0.05) + Math.sin(x * 0.013 + z * 0.021);
      if (land === 2) c = [0.36, 0.35, 0.34];
      else if (land === 0) c = [0.08, 0.08, 0.08];
      else if (e < 6) c = [0.3, 0.29, 0.28];
      else if (z < 0 && z > QUAY_Z - 1 && Math.abs(x) < 302) c = [0.46, 0.42, 0.37];
      else if (x < -300) c = [0.3, 0.27, 0.24];
      else if (z > 520 || Math.abs(x) > 700) { const g = sstep(-0.5, 1.2, nse); c = [lerp(0.045, 0.025, g), lerp(0.05, 0.045, g), lerp(0.045, 0.03, g)]; }
      else if (z > 320 || (z > 140 && nse > 0.4)) { const g = sstep(-0.5, 1.2, nse); c = [lerp(0.13, 0.06, g), lerp(0.13, 0.12, g), lerp(0.1, 0.06, g)]; }
      else c = [0.34, 0.32, 0.3];
      col[k * 3] = c[0]; col[k * 3 + 1] = c[1]; col[k * 3 + 2] = c[2];
    }
    // jardines especiales
    const idx = [];
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      if (H[a] < -6.5 && H[b] < -6.5 && H[c] < -6.5 && H[d] < -6.5) continue;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    groundMat = tier === 'low'
      ? new THREE.MeshLambertMaterial({ vertexColors: true, map: paveTex })
      : new THREE.MeshStandardMaterial({ vertexColors: true, map: paveTex, roughness: 0.93, metalness: 0, envMap: ENV, envMapIntensity: 0.45 });
    const m = new THREE.Mesh(g, groundMat);
    m.name = 'puerto-suelo'; m.receiveShadow = tier === 'high';
    group.add(m);
  }

  tick('ground');
  // ================================================================= AGUA
  const waterMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]),
    vertexShader: WATER_VS, fragmentShader: WATER_FS, fog: true,
  });
  Object.assign(waterMat.uniforms, { uTime: U.uTime, uWind: U.uWind, uRain: U.uRain, uQ: { value: tier === 'low' ? 0 : 1 }, uZen: { value: PAL.mid.clone().lerp(PAL.zen, 0.5) }, uHor: { value: PAL.hor }, uGlow: { value: PAL.glow.clone().multiplyScalar(0.8) }, uGlowDir: { value: GLOW_DIR }, uDeep: { value: PAL.deep } });
  {
    const g = new THREE.PlaneGeometry(7000, 7000, 1, 1).rotateX(-Math.PI / 2).translate(0, WY, -1500);
    const m = new THREE.Mesh(g, waterMat); m.name = 'puerto-agua'; group.add(m);
  }

  // ================================================================= CIELO + COLINAS LEJANAS
  const skyMat = new THREE.ShaderMaterial({
    uniforms: { uZen: { value: PAL.zen }, uMid: { value: PAL.mid }, uHor: { value: PAL.hor }, uGlow: { value: PAL.glow }, uGlow2: { value: PAL.glow2 }, uGlowDir: { value: GLOW_DIR }, uMoon: { value: MOON_DIR }, uTime: U.uTime, uRain: U.uRain, uClouds: { value: Q.clouds } },
    vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), skyMat);
  sky.name = 'puerto-cielo'; sky.renderOrder = -10; sky.frustumCulled = false; group.add(sky);
  const hillMat = new THREE.ShaderMaterial({ uniforms: { uHaze: { value: FOG_DRY.clone() }, uTime: U.uTime, uRain: U.uRain }, vertexShader: HILL_VS, fragmentShader: HILL_FS, vertexColors: true, fog: false, side: THREE.DoubleSide });
  {
    const pos = [], col = [], aH = [], idx = [];
    const C = [60, 250], segs = 220;
    let prev = -1;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
      const land = sstep(-0.42, 0.12, dz);
      const nse = 0.5 + 0.3 * Math.sin(a * 5.3 + 1) + 0.2 * Math.sin(a * 13.1) + 0.12 * Math.sin(a * 31.7);
      const hgt = land * (170 + 210 * nse);
      const Rr = 1250 + 150 * Math.sin(a * 3.7);
      const x = C[0] + dx * Rr, z = C[1] + dz * Rr;
      const b = pos.length / 3;
      pos.push(x, -30, z, x, hgt, z);
      col.push(0.02, 0.03, 0.05, 0.035, 0.05, 0.08);
      aH.push(i / segs, 0, i / segs, 1);
      if (prev >= 0 && land > 0.01) idx.push(prev, prev + 1, b, b, prev + 1, b + 1);
      prev = b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setAttribute('aH', new THREE.Float32BufferAttribute(aH, 2)); g.setIndex(idx);
    const m = new THREE.Mesh(g, hillMat); m.name = 'puerto-colinas'; m.renderOrder = -9; m.frustumCulled = false; group.add(m);
    for (let k = 0; k < 7; k++) { const a = R(0.6, 2.5), Rr = 1200; glow(C[0] + Math.cos(a) * Rr, R(150, 230), C[1] + Math.sin(a) * Rr, 9, [1, 0.12, 0.1], 0.5, rnd()); }
  }

  // ================================================================= MALLAS FUSIONADAS
  const propsMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  propsMat.onBeforeCompile = (sh) => {
    sh.uniforms.uWarmLit = U.uWarmLit;
    sh.vertexShader = 'attribute float aLit;\nvarying float vLit;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvLit = aLit;');
    sh.fragmentShader = 'uniform vec3 uWarmLit;\nvarying float vLit;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uWarmLit * vLit;');
  };
  propsMat.customProgramCacheKey = () => 'puerto-props';
  const buildMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]), vertexShader: BUILD_VS, fragmentShader: BUILD_FS, vertexColors: true, fog: true,
  });
  Object.assign(buildMat.uniforms, { uSky: U.uSky, uGround: U.uGround, uWarm: U.uWarm, uWet: U.uWet, uLit: U.uLit });
  const emisMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const swayMat = new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]), vertexShader: SWAY_VS, fragmentShader: SWAY_FS, vertexColors: true, fog: true, side: THREE.DoubleSide });
  Object.assign(swayMat.uniforms, { uTime: U.uTime, uWind: U.uWind, uAmb: U.uAmb, uWarmLit: U.uWarmLit });
  const add = (b, mat, name, opts) => { if (!b.count) return null; const m = new THREE.Mesh(b.build(opts), mat); m.name = name; group.add(m); return m; };
  const propsMesh = add(PROPS, propsMat, 'puerto-props');
  if (propsMesh && tier === 'high') { propsMesh.castShadow = true; propsMesh.receiveShadow = true; }
  add(BUILD, buildMat, 'puerto-edificios', { uv: true });
  add(EMIS, emisMat, 'puerto-luces', { normal: false });
  add(SWAY, swayMat, 'puerto-vegetacion');
  const poolMat = new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]), vertexShader: POOL_VS, fragmentShader: POOL_FS, vertexColors: true, fog: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  poolMat.uniforms.uWet = U.uWet;
  const poolMesh = add(POOLS, poolMat, 'puerto-charcos-luz', { uv: true, normal: false });
  if (poolMesh) { poolMesh.renderOrder = 2; poolMat.polygonOffset = true; poolMat.polygonOffsetFactor = -2; poolMat.polygonOffsetUnits = -2; }

  // reflejos alargados (agua y suelo mojado)
  const streakMat = new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]), vertexShader: STREAK_VS, fragmentShader: STREAK_FS, vertexColors: true, fog: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  Object.assign(streakMat.uniforms, { uTime: U.uTime, uWind: U.uWind, uWet: U.uWet });
  // yates en movimiento (se reservan reflejos dinámicos)
  const MOVERS = [
    { c: [-40, -150], r: [110, 22], w: 0.034, p: 0.3, Lb: 22 },
    { c: [130, -200], r: [110, 28], w: -0.03, p: 2.1, Lb: 17 },
    { c: [60, -330], r: [260, 60], w: 0.016, p: 4.0, Lb: 30 },
    { c: [-260, -410], r: [200, 45], w: -0.013, p: 1.0, Lb: 38 },
    { c: [200, -140], r: [60, 18], w: 0.05, p: 5.2, Lb: 11 },
    { c: [-235, -150], r: [25, 15], w: -0.08, p: 0.0, Lb: 9 },
  ].slice(0, tier === 'low' ? 4 : 6);
  const streakDynStart = STREAKS.c.length / 3;
  MOVERS.forEach(() => { streak(0, 3, 0, WY, 1.4, [0.55, 0.38, 0.2]); streak(0, 4, 0, WY, 0.6, [0.5, 0.06, 0.04]); });
  let streakGeo = null;
  if (STREAKS.c.length) {
    streakGeo = new THREE.BufferGeometry();
    const nV = STREAKS.c.length / 3;
    streakGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(nV * 3), 3));
    streakGeo.setAttribute('aC', new THREE.Float32BufferAttribute(STREAKS.c, 3));
    streakGeo.setAttribute('aQ', new THREE.Float32BufferAttribute(STREAKS.q, 3));
    streakGeo.setAttribute('color', new THREE.Float32BufferAttribute(STREAKS.col, 3));
    streakGeo.setAttribute('aW', new THREE.Float32BufferAttribute(STREAKS.w, 2));
    const m = new THREE.Mesh(streakGeo, streakMat); m.name = 'puerto-reflejos'; m.frustumCulled = false; m.renderOrder = 3; group.add(m);
  }

  // yates móviles instanciados
  const yB = new Batch({ aLit: 1 }), yE = new Batch();
  yacht(new THREE.Matrix4(), 20, 'motor', [0.9, 0.9, 0.93], yB, yE, true);
  for (const [sx, col] of [[1, [3.5, 0.2, 0.15]], [-1, [0.2, 3.2, 0.5]]]) yE.add(SPH, M(sx * 3.1, 2.9, 3, 0, 0.16, 0.16, 0.16), col);
  yE.add(SPH, M(0, 6.3, -1.5, 0, 0.18, 0.18, 0.18), [3.5, 3.5, 3.2]);
  const yachtMesh = new THREE.InstancedMesh(yB.build(), propsMat, MOVERS.length);
  const yachtLights = new THREE.InstancedMesh(yE.build({ normal: false }), emisMat, MOVERS.length);
  yachtMesh.name = 'puerto-yates'; yachtLights.name = 'puerto-yates-luces';
  yachtMesh.frustumCulled = false; yachtLights.frustumCulled = false;
  group.add(yachtMesh, yachtLights);
  let wakeMesh = null;
  const wakeMat = new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]), vertexShader: WAKE_VS, fragmentShader: WAKE_FS, fog: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  wakeMat.uniforms.uTime = U.uTime;
  if (Q.wakes) {
    const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, -0.5);
    const uvA = g.attributes.uv; for (let k = 0; k < uvA.count; k++) uvA.setY(k, 1 - uvA.getY(k));
    wakeMesh = new THREE.InstancedMesh(g, wakeMat, MOVERS.length);
    wakeMesh.name = 'puerto-estelas'; wakeMesh.frustumCulled = false; wakeMesh.renderOrder = 2; group.add(wakeMesh);
  }

  // halos (Points)
  const glowMat = new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]), vertexShader: GLOW_VS, fragmentShader: GLOW_FS, vertexColors: true, fog: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  Object.assign(glowMat.uniforms, { uScale: U.uScale, uTime: U.uTime, uBoost: U.uBoost });
  {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(GLOWS.p, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(GLOWS.c, 3)); g.setAttribute('aS', new THREE.Float32BufferAttribute(GLOWS.s, 3));
    const pts = new THREE.Points(g, glowMat); pts.name = 'puerto-halos'; pts.frustumCulled = false; pts.renderOrder = 4; group.add(pts);
  }

  // haz del faro
  const beamMat = new THREE.ShaderMaterial({ uniforms: { uI: { value: 1 }, uRain: U.uRain }, vertexShader: BEAM_VS, fragmentShader: BEAM_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const beam = new THREE.Group(); beam.position.set(FARO.x, FARO.y, FARO.z); group.add(beam);
  {
    const len = 300, g1 = new THREE.CylinderGeometry(15, 0.5, len, 14, 1, true).translate(0, len / 2, 0).rotateZ(-Math.PI / 2 + 0.035);
    const g2 = g1.clone().rotateY(Math.PI);
    const g = mergeGeos([g1, g2]); g1.dispose(); g2.dispose();
    const m = new THREE.Mesh(g, beamMat); m.name = 'puerto-faro-haz'; m.frustumCulled = false; m.renderOrder = 5; beam.add(m);
  }

  // chorros de las fuentes
  if (Q.jets && JETS.length) {
    const jb = new Batch();
    for (const j of JETS) {
      const n = 10;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        const pt = (t) => [j.x + ca * j.r * t, j.y + j.h * 4 * t * (1 - t) * 0.9 + t * -0.6, j.z + sa * j.r * t];
        for (let q = 0; q < 6; q++) {
          const t0 = q / 6, t1 = (q + 1) / 6, p0 = pt(t0), p1 = pt(t1), w = 0.16;
          const A = [p0[0] - sa * w, p0[1], p0[2] + ca * w], B = [p0[0] + sa * w, p0[1], p0[2] - ca * w], C = [p1[0] + sa * w, p1[1], p1[2] - ca * w], D = [p1[0] - sa * w, p1[1], p1[2] + ca * w];
          jb._push(...A, 0, 1, 0, [1, 1, 1], 0, t0); jb._push(...B, 0, 1, 0, [1, 1, 1], 1, t0); jb._push(...C, 0, 1, 0, [1, 1, 1], 1, t1);
          jb._push(...A, 0, 1, 0, [1, 1, 1], 0, t0); jb._push(...C, 0, 1, 0, [1, 1, 1], 1, t1); jb._push(...D, 0, 1, 0, [1, 1, 1], 0, t1);
        }
      }
      // chorro central
      for (const rot of [0, Math.PI / 2]) {
        const c = Math.cos(rot), s = Math.sin(rot), w = 0.22, hh = j.h * 1.3;
        const A = [j.x - c * w, j.y, j.z + s * w], B = [j.x + c * w, j.y, j.z - s * w], C = [j.x + c * w * 0.4, j.y + hh, j.z - s * w * 0.4], D = [j.x - c * w * 0.4, j.y + hh, j.z + s * w * 0.4];
        jb._push(...A, 0, 1, 0, [1, 1, 1], 0, 0); jb._push(...B, 0, 1, 0, [1, 1, 1], 1, 0); jb._push(...C, 0, 1, 0, [1, 1, 1], 1, 1);
        jb._push(...A, 0, 1, 0, [1, 1, 1], 0, 0); jb._push(...C, 0, 1, 0, [1, 1, 1], 1, 1); jb._push(...D, 0, 1, 0, [1, 1, 1], 0, 1);
      }
    }
    const jetMat = new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]), vertexShader: JET_VS, fragmentShader: JET_FS, fog: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    jetMat.uniforms.uTime = U.uTime;
    const m = new THREE.Mesh(jb.build({ uv: true, normal: false }), jetMat); m.name = 'puerto-fuentes'; m.renderOrder = 3; group.add(m);
  }

  tick('meshes');
  // ================================================================= PÚBLICO (instanciado)
  const crowdMat = new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]), vertexShader: CROWD_VS, fragmentShader: SWAY_FS, fog: true, side: THREE.DoubleSide });
  Object.assign(crowdMat.uniforms, { uTime: U.uTime, uExcite: U.uExcite, uAmb: { value: new THREE.Color(0.3, 0.33, 0.48) }, uWarmLit: { value: new THREE.Color(0.32, 0.22, 0.12) } });
  let crowdMesh = null;
  {
    const pg = personGeo();
    let list = CROWD;
    if (list.length > Q.crowd) {
      // muestreo uniforme conservando la proporción por zonas
      const keep = Q.crowd / list.length; list = list.filter(() => rnd() < keep);
    }
    if (list.length) {
      crowdMesh = new THREE.InstancedMesh(pg, crowdMat, list.length);
      crowdMesh.name = 'puerto-publico';
      const col = new THREE.Color();
      list.forEach((p, i) => { crowdMesh.setMatrixAt(i, M(p[0], p[1] - (p[5] ? 0.72 : 0), p[2], p[3], 1, p[5] ? 1.0 : 1, 1)); col.setRGB(p[4][0], p[4][1], p[4][2]); crowdMesh.setColorAt(i, col); });
      // de pie: añadir piernas implícitas elevando el torso
      list.forEach((p, i) => { if (p[5]) { crowdMesh.setMatrixAt(i, M(p[0], p[1] - 0.72 + 0.74, p[2], p[3], 1, 1, 1)); } });
      crowdMesh.instanceMatrix.needsUpdate = true; if (crowdMesh.instanceColor) crowdMesh.instanceColor.needsUpdate = true;
      crowdMesh.frustumCulled = false;
      group.add(crowdMesh);
    }
    COUNT.crowd = list.length;
  }

  // ================================================================= SEMÁFORO, PANTALLA, RÓTULOS
  const gLightMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  const gLights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.34, 10, 6), gLightMat, GANTRY_PTS.length);
  gLights.name = 'puerto-semaforo';
  const LIGHT_OFF = new THREE.Color(0.1, 0.012, 0.016), LIGHT_ON = new THREE.Color(7, 0.18, 0.2);
  GANTRY_PTS.forEach((p, i) => { gLights.setMatrixAt(i, M(p.x, p.y, p.z)); gLights.setColorAt(i, LIGHT_OFF); });
  gLights.instanceMatrix.needsUpdate = true;
  group.add(gLights);
  const gantry = {
    n: 0,
    set(n) {
      this.n = n;
      for (let i = 0; i < 5; i++) for (let r = 0; r < 2; r++) gLights.setColorAt(i * 2 + r, n > 0 && i < n ? LIGHT_ON : LIGHT_OFF);
      gLights.instanceColor.needsUpdate = true;
    },
    pos: GANTRY_PTS.length ? { x: GANTRY_META.mx, y: GANTRY_META.yb + 9, z: GANTRY_META.mz } : null,
  };
  gantry.set(0);

  // rótulos (atlas de lienzo)
  const signCanvas = makeCanvas(1024, 512);
  drawSigns(signCanvas.getContext('2d'));
  const signTex = new THREE.CanvasTexture(signCanvas); signTex.colorSpace = THREE.SRGBColorSpace; signTex.anisotropy = 4;
  const REG = {
    hotel: [0, 0, 1024, 110], casino: [0, 110, 512, 120], puerto: [512, 110, 512, 120], meta: [0, 230, 512, 80],
    aqua: [512, 230, 256, 80], vela: [768, 230, 256, 80], solmar: [0, 310, 256, 80], brisa: [256, 310, 256, 80],
    n1: [512, 310, 128, 128], n2: [640, 310, 128, 128], n3: [768, 310, 128, 128], gp: [0, 440, 1024, 72],
  };
  function sign(reg, x, y, z, yaw, w, h, k = 1.0, both = false) {
    const [px, py, pw, ph] = REG[reg];
    const u0 = px / 1024, u1 = (px + pw) / 1024, v1 = 1 - py / 512, v0 = 1 - (py + ph) / 512;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const P = (lx, ly) => [x + lx * c, y + ly, z - lx * s];
    const col = [k, k, k];
    const A = P(-w / 2, -h / 2), B = P(w / 2, -h / 2), C = P(w / 2, h / 2), D = P(-w / 2, h / 2);
    for (const [p, u, v] of [[A, u0, v0], [B, u1, v0], [C, u1, v1], [A, u0, v0], [C, u1, v1], [D, u0, v1]]) SIGNS._push(p[0], p[1], p[2], 0, 0, 1, col, u, v);
    if (both) for (const [p, u, v] of [[B, u0, v0], [A, u1, v0], [D, u1, v1], [B, u0, v0], [D, u1, v1], [C, u0, v1]]) SIGNS._push(p[0], p[1], p[2], 0, 0, -1, col, u, v);
  }
  // fachada visible desde +z local (yaw = dirección a la que mira el rótulo)
  if (CASINO) sign('casino', CASINO.signAt.x, CASINO.signAt.y, CASINO.signAt.z, CASINO.yaw, 14, 3.3, 1.5);
  if (PODIUM) {
    const p = PODIUM.signAt; sign('puerto', p.x, p.y, p.z, p.yaw, 11, 2.6, 1.3);
    ['n1', 'n2', 'n3'].forEach((r, i) => { const q = PODIUM.numsAt[i]; sign(r, q.x, q.y, q.z, PODIUM.yaw, 1.6, 1.6, 1.6); });
  }
  if (HOTEL.length) {
    const h = HOTEL[Math.floor(HOTEL.length / 2)];
    const lat = -30.25, x = h.o.x + h.o.nx * lat, z = h.o.z + h.o.nz * lat;
    sign('hotel', x, h.o.y + HOTEL.top + 2.6, z, Math.atan2(-h.o.nx, -h.o.nz), 46, 5, 1.7);
    for (const e of [HOTEL[0], HOTEL[HOTEL.length - 1]]) {
      const dirS = e === HOTEL[0] ? -1 : 1; const y = e.o.y + 9.4;
      sign('gp', e.o.x + e.o.tx * dirS * (e.w / 2 + 0.06), y, e.o.z + e.o.tz * dirS * (e.w / 2 + 0.06), Math.atan2(e.o.tx * dirS, e.o.tz * dirS), 26, 1.8, 1.3);
    }
  }
  for (const st of STAND_META) {
    const regs = ['aqua', 'vela', 'solmar', 'brisa'];
    const n = Math.floor(st.len / 14);
    for (let k = 0; k < n; k++) {
      const u = (k + 0.5) / n - 0.5;
      const x = st.midx + st.tx * u * st.len + st.nx * (st.U0 - 1.12), z = st.midz + st.tz * u * st.len + st.nz * (st.U0 - 1.12);
      sign(k % 2 ? 'gp' : regs[k % 4], x, st.roofY - 0.05, z, Math.atan2(-st.nx, -st.nz), k % 2 ? 13 : 5.4, k % 2 ? 0.95 : 1.6, 1.2);
    }
    for (let k = 0; k < n; k++) {
      const u = (k + 0.5) / n - 0.5;
      const x = st.midx + st.tx * u * st.len + st.nx * (st.U0 - 0.12), z = st.midz + st.tz * u * st.len + st.nz * (st.U0 - 0.12);
      sign(regs[(k + 1) % 4], x, st.y0 + STAND_FRONT - 1.0, z, Math.atan2(-st.nx, -st.nz), 4.6, 1.3, 1.0);
    }
  }
  if (GANTRY_META) {
    const g = GANTRY_META;
    for (const d of [-1, 1]) sign('meta', g.o.x + g.o.tx * d * 0.7, g.yb + 12.3, g.o.z + g.o.tz * d * 0.7, g.yaw + (d > 0 ? 0 : Math.PI), 13, 2.0, 0.8);
  }
  if (BRIDGE) {
    for (const d of [-1, 1]) sign('puerto', BRIDGE.mx + BRIDGE.o.tx * d * 1.75, BRIDGE.dy + 0.35, BRIDGE.mz + BRIDGE.o.tz * d * 1.75, Math.atan2(BRIDGE.o.tx * d, BRIDGE.o.tz * d), 14, 1.6 * 0.7, 1.2);
  }
  const signMat = new THREE.MeshBasicMaterial({ map: signTex, vertexColors: true, transparent: true, depthWrite: false, side: THREE.FrontSide });
  const signMesh = add(SIGNS, signMat, 'puerto-rotulos', { uv: true, normal: false });
  if (signMesh) signMesh.renderOrder = 1;

  // pantalla gigante
  let jumbo = null;
  if (JUMBO_AT) {
    const o = JUMBO_AT.o, lat = JUMBO_AT.lat;
    const x = o.x + o.nx * lat, z = o.z + o.nz * lat, y = JUMBO_AT.y + 7.5;
    const jc = makeCanvas(512, 224);
    const jt = new THREE.CanvasTexture(jc); jt.colorSpace = THREE.SRGBColorSpace;
    const yawF = Math.atan2(Math.sign(lat) * -o.nx, Math.sign(lat) * -o.nz);
    const jm = new THREE.Mesh(new THREE.PlaneGeometry(20, 8.75), new THREE.MeshBasicMaterial({ map: jt, toneMapped: false, color: new THREE.Color(1.05, 1.05, 1.05) }));
    jm.position.set(x - Math.sin(yawF) * -0.45, y, z - Math.cos(yawF) * -0.45); jm.rotation.y = yawF; jm.name = 'puerto-pantalla';
    group.add(jm);
    PROPS_EXTRA.add(BOXC, M(x, y, z, yawF, 21.4, 10.1, 0.7), [0.05, 0.06, 0.1]);
    for (const d of [-6, 6]) PROPS_EXTRA.add(BOX, M(x + Math.cos(yawF) * d, JUMBO_AT.y, z - Math.sin(yawF) * d, yawF, 0.6, 3, 0.6), [0.2, 0.2, 0.22]);
    let state = '';
    jumbo = {
      draw(top, big, sub, color = '#ffc85a') {
        const k = top + '|' + big + '|' + sub + '|' + color; if (k === state) return; state = k;
        const x2 = jc.getContext('2d'), w = 512, h = 224;
        const gr = x2.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#0c1a3c'); gr.addColorStop(1, '#040814');
        x2.fillStyle = gr; x2.fillRect(0, 0, w, h);
        x2.strokeStyle = 'rgba(255,255,255,.05)'; for (let i = 0; i < h; i += 4) { x2.beginPath(); x2.moveTo(0, i); x2.lineTo(w, i); x2.stroke(); }
        x2.fillStyle = 'rgba(255,200,90,.9)'; x2.fillRect(0, 0, w, 5); x2.fillRect(0, h - 5, w, 5);
        x2.textAlign = 'center'; x2.textBaseline = 'middle';
        x2.font = '800 24px Outfit, "Helvetica Neue", Arial, sans-serif'; x2.fillStyle = '#7fd6ff'; x2.fillText(String(top || ''), w / 2, 36, w - 30);
        x2.font = '400 50px Bungee, Outfit, Impact, sans-serif'; x2.fillStyle = color; x2.shadowColor = color; x2.shadowBlur = 18; x2.fillText(String(big || ''), w / 2, 112, w - 30); x2.shadowBlur = 0;
        x2.font = '800 25px Outfit, "Helvetica Neue", Arial, sans-serif'; x2.fillStyle = '#f4efe2'; x2.fillText(String(sub || ''), w / 2, 182, w - 30);
        jt.needsUpdate = true;
      },
      position: { x, y, z, yaw: yawF },
    };
    jumbo.draw('GRAN PREMIO', 'PUERTO MARINA', 'CIRCUITO URBANO · 4 VUELTAS');
    occluder(x - 11, y - 5, z - 11, x + 11, y + 5, z + 11);
  }
  if (PROPS_EXTRA.count) add(PROPS_EXTRA, propsMat, 'puerto-props-2');

  // ================================================================= LLUVIA
  let rainMesh = null;
  const rainMat = new THREE.ShaderMaterial({ uniforms: { uTime: U.uTime, uWind: U.uWind, uI: { value: 1 } }, vertexShader: RAIN_VS, fragmentShader: RAIN_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  if (rain !== false) {
    const n = Q.rainN, pos = new Float32Array(n * 6), ar = new Float32Array(n * 8);
    for (let i = 0; i < n; i++) {
      const a = [rnd(), rnd(), rnd(), rnd()];
      pos[i * 6 + 1] = 0; pos[i * 6 + 4] = 1;
      for (let k = 0; k < 4; k++) { ar[i * 8 + k] = a[k]; ar[i * 8 + 4 + k] = a[k]; }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aR', new THREE.BufferAttribute(ar, 4));
    rainMesh = new THREE.LineSegments(g, rainMat); rainMesh.name = 'puerto-lluvia'; rainMesh.frustumCulled = false; rainMesh.visible = false; rainMesh.renderOrder = 6;
    group.add(rainMesh);
  }

  // ================================================================= FUEGOS ARTIFICIALES
  const FW_N = tier === 'low' ? 500 : 1400;
  const fwPos = new Float32Array(FW_N * 3), fwCol = new Float32Array(FW_N * 3), fwS = new Float32Array(FW_N * 3), fwVel = new Float32Array(FW_N * 3), fwLife = new Float32Array(FW_N), fwMax = new Float32Array(FW_N), fwBase = new Float32Array(FW_N * 3), fwKind = new Uint8Array(FW_N);
  const fwGeo = new THREE.BufferGeometry();
  fwGeo.setAttribute('position', new THREE.BufferAttribute(fwPos, 3).setUsage(THREE.DynamicDrawUsage));
  fwGeo.setAttribute('color', new THREE.BufferAttribute(fwCol, 3).setUsage(THREE.DynamicDrawUsage));
  fwGeo.setAttribute('aS', new THREE.BufferAttribute(fwS, 3).setUsage(THREE.DynamicDrawUsage));
  const fwPts = new THREE.Points(fwGeo, glowMat); fwPts.name = 'puerto-fuegos'; fwPts.frustumCulled = false; fwPts.visible = false; fwPts.renderOrder = 5;
  group.add(fwPts);
  let fwQueue = [], fwActive = 0, fwCursor = 0;
  const FW_COLS = [[1, 0.78, 0.35], [1, 0.3, 0.25], [0.4, 1, 0.5], [0.45, 0.65, 1], [1, 0.45, 0.85], [1, 1, 0.92]];
  function fwSpawn(kind, x, y, z, vx, vy, vz, life, c) {
    const i = fwCursor; fwCursor = (fwCursor + 1) % FW_N;
    fwPos[i * 3] = x; fwPos[i * 3 + 1] = y; fwPos[i * 3 + 2] = z; fwVel[i * 3] = vx; fwVel[i * 3 + 1] = vy; fwVel[i * 3 + 2] = vz;
    fwLife[i] = life; fwMax[i] = life; fwKind[i] = kind; fwBase[i * 3] = c[0]; fwBase[i * 3 + 1] = c[1]; fwBase[i * 3 + 2] = c[2];
  }
  const fireworks = {
    x: PODIUM.fw.x, y: PODIUM.fw.y, z: PODIUM.fw.z,
    launch(n = 1) { for (let k = 0; k < n; k++) fwQueue.push(k * R(0.25, 0.5)); fwPts.visible = true; },
  };
  function fwUpdate(dt) {
    for (let k = fwQueue.length - 1; k >= 0; k--) {
      fwQueue[k] -= dt;
      if (fwQueue[k] <= 0) { fwQueue.splice(k, 1); fwSpawn(1, fireworks.x + R(-9, 9), WY + 2, fireworks.z + R(-3, 3), R(-5, 5), R(31, 39), R(-3, 3), R(0.95, 1.3), [1, 0.85, 0.6]); }
    }
    let alive = 0;
    const drag = Math.exp(-1.25 * dt);
    for (let i = 0; i < FW_N; i++) {
      if (fwLife[i] <= 0) { fwS[i * 3] = 0; continue; }
      alive++;
      fwLife[i] -= dt;
      const k = fwKind[i];
      if (k === 1 && fwLife[i] <= 0) {
        const c = pick(FW_COLS), c2 = rnd() < 0.3 ? pick(FW_COLS) : c, n = tier === 'low' ? 45 : 95, sp = R(13, 19);
        for (let q = 0; q < n; q++) {
          const u = rnd() * 2 - 1, th = rnd() * 6.283, r = Math.sqrt(1 - u * u);
          fwSpawn(2, fwPos[i * 3], fwPos[i * 3 + 1], fwPos[i * 3 + 2], r * Math.cos(th) * sp, u * sp, r * Math.sin(th) * sp, R(1.5, 2.4), q % 2 ? c : c2);
        }
        fwS[i * 3] = 0; continue;
      }
      fwVel[i * 3] *= k === 2 ? drag : 1; fwVel[i * 3 + 2] *= k === 2 ? drag : 1; fwVel[i * 3 + 1] = fwVel[i * 3 + 1] * (k === 2 ? drag : 1) - 9.8 * (k === 2 ? 0.45 : 1) * dt;
      fwPos[i * 3] += fwVel[i * 3] * dt; fwPos[i * 3 + 1] += fwVel[i * 3 + 1] * dt; fwPos[i * 3 + 2] += fwVel[i * 3 + 2] * dt;
      const f = clamp(fwLife[i] / fwMax[i], 0, 1), b = k === 1 ? 1.4 : Math.sqrt(f) * f * (rnd() < 0.2 && f < 0.45 ? 2.2 : 1.25);
      fwCol[i * 3] = fwBase[i * 3] * b; fwCol[i * 3 + 1] = fwBase[i * 3 + 1] * b; fwCol[i * 3 + 2] = fwBase[i * 3 + 2] * b;
      fwS[i * 3] = k === 1 ? 1.6 : 2.8;
    }
    fwActive = alive + fwQueue.length;
    fwGeo.attributes.position.needsUpdate = true; fwGeo.attributes.color.needsUpdate = true; fwGeo.attributes.aS.needsUpdate = true;
    if (!fwActive) fwPts.visible = false;
  }

  tick('rest');
  // ================================================================= ENTORNO / API
  const fog = new THREE.FogExp2(FOG_DRY.getHex(), FOG_D);
  fog.color.copy(FOG_DRY);
  const background = FOG_DRY.clone();
  const env = {
    background, fog, exposure: 1.0,
    bloom: { strength: 0.6, radius: 0.42, threshold: 0.84 },
    envMap: ENV,
    ambient: {
      hemi: { sky: 0x6a84c8, ground: 0x2a2430, intensity: 1.1 },
      sun: { color: 0xaebeff, intensity: 0.75, dir: [-0.42, 0.62, -0.66].map((v, i, a) => v / Math.hypot(a[0], a[1], a[2])) },
    },
  };

  let weather = 'seco';
  function setWeather(w) {
    weather = w === 'humedo' || w === 'viento' ? w : 'seco';
    const wet = weather === 'humedo' ? 1 : 0;
    U.uWet.value = wet; U.uRain.value = wet;
    U.uWind.value = weather === 'viento' ? 1 : wet ? 0.45 : 0.15;
    U.uBoost.value = wet ? 1.35 : 1;
    const fc = wet ? FOG_WET : FOG_DRY, fd = wet ? FOG_D * 1.75 : weather === 'viento' ? FOG_D * 0.85 : FOG_D;
    fog.color.copy(fc); fog.density = fd; background.copy(fc);
    hillMat.uniforms.uHaze.value.copy(fc);
    if (scene && scene.fog && scene.fog !== fog && scene.fog.isFogExp2) { scene.fog.color.copy(fc); scene.fog.density = fd; }
    if (scene && scene.background && scene.background.isColor && scene.background !== background) scene.background.copy(fc);
    if (rainMesh) rainMesh.visible = !!wet;
    beamMat.uniforms.uI.value = wet ? 1.4 : 1;
    if (groundMat.isMeshStandardMaterial) {
      groundMat.roughnessMap = wet ? puddleTex : null;
      groundMat.roughness = wet ? 1.0 : 0.93;
      groundMat.envMapIntensity = wet ? 0.8 : 0.45;
      groundMat.color.setScalar(wet ? 0.72 : 1);
      groundMat.needsUpdate = true;
    }
  }

  let exciteT = 0.3;
  const crowd = { excite(l) { exciteT = clamp(+l || 0, 0, 1); } };
  const _vs = new THREE.Vector2();
  function update(dt, t, camera) {
    U.uTime.value = t;
    U.uExcite.value += (exciteT - U.uExcite.value) * (1 - Math.exp(-3 * (dt || 0)));
    if (camera) {
      sky.position.copy(camera.position);
      if (renderer && camera.isPerspectiveCamera) { renderer.getDrawingBufferSize(_vs); U.uScale.value = _vs.y / (2 * Math.tan((camera.fov * Math.PI) / 360)); }
    }
    beam.rotation.y = t * 0.75;
    // yates en movimiento
    MOVERS.forEach((mv, i) => {
      const th = mv.p + t * mv.w;
      const x = mv.c[0] + Math.cos(th) * mv.r[0], z = mv.c[1] + Math.sin(th) * mv.r[1];
      const vx = -Math.sin(th) * mv.r[0] * mv.w, vz = Math.cos(th) * mv.r[1] * mv.w;
      const yaw = Math.atan2(vx, vz), sc = mv.Lb / 20;
      const bob = Math.sin(t * 1.3 + i) * 0.08;
      _e.set(Math.sin(t * 0.9 + i * 2) * 0.012, yaw, Math.sin(t * 1.1 + i) * 0.02, 'YXZ'); _q.setFromEuler(_e);
      _m.compose(_v.set(x, WY + bob, z), _q, _s.set(sc, sc, sc));
      yachtMesh.setMatrixAt(i, _m); yachtLights.setMatrixAt(i, _m);
      if (wakeMesh) {
        const sp = Math.hypot(vx, vz);
        const bx = x - Math.sin(yaw) * mv.Lb * 0.45, bz = z - Math.cos(yaw) * mv.Lb * 0.45;
        _q.setFromAxisAngle(_n.set(0, 1, 0), yaw);
        _m.compose(_v.set(bx, WY + 0.03, bz), _q, _s.set(mv.Lb * 0.9, 1, mv.Lb * (2.5 + sp * 0.2)));
        wakeMesh.setMatrixAt(i, _m);
      }
      if (streakGeo) {
        const ac = streakGeo.attributes.aC.array;
        const k0 = (streakDynStart + i * 12) * 3;
        const ly = WY + (1.0 + mv.Lb * 0.045 + 0.8) * sc;
        for (let v = 0; v < 6; v++) { ac[k0 + v * 3] = x; ac[k0 + v * 3 + 1] = ly; ac[k0 + v * 3 + 2] = z; }
        const px = x + Math.cos(yaw) * 3.1 * sc, pz = z - Math.sin(yaw) * 3.1 * sc;
        for (let v = 6; v < 12; v++) { ac[k0 + v * 3] = px; ac[k0 + v * 3 + 1] = WY + 2.9 * sc; ac[k0 + v * 3 + 2] = pz; }
      }
    });
    yachtMesh.instanceMatrix.needsUpdate = true; yachtLights.instanceMatrix.needsUpdate = true;
    if (wakeMesh) wakeMesh.instanceMatrix.needsUpdate = true;
    if (streakGeo) streakGeo.attributes.aC.needsUpdate = true;
    if (fwPts.visible) fwUpdate(Math.min(dt || 0, 0.05));
  }

  function dispose() {
    group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of ms) { if (m.map) m.map.dispose(); m.dispose(); }
    });
    [paveTex, puddleTex, signTex].forEach((t) => t && t.dispose());
    if (ENV_RT) ENV_RT.dispose(); else if (ENV && ENV !== envMap) ENV.dispose();
    if (group.parent) group.parent.remove(group);
  }

  TEMPL.forEach((g) => g.dispose());
  if (scene) scene.add(group);
  setWeather('seco');

  // estadísticas
  let calls = 0, tris = 0; const meshes = {};
  group.traverse((o) => {
    if (!(o.isMesh || o.isPoints || o.isLineSegments)) return;
    if (o === rainMesh || o === fwPts) return;
    calls++;
    const g = o.geometry, c = g.index ? g.index.count : g.attributes.position.count;
    const t = Math.round((o.isMesh ? c / 3 : 0) * (o.isInstancedMesh ? o.count : 1));
    tris += t; meshes[o.name || '?'] = o.isPoints ? 'pts' + c : t;
  });
  const stats = Object.assign({ drawCalls: calls, drawCallsRain: calls + (rainMesh ? 1 : 0), tris: Math.round(tris), glows: GLOWS.p.length / 3, streaks: STREAKS.c.length / 18, occluders: OCCL.length, tvCams: tvCams.length, timing: TM, meshes, buildMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - tStart) }, COUNT);

  return {
    id: 'puerto', group, env, occluders: OCCL, tvCams: tvCams.map((c) => ({ x: c.x, y: c.y, z: c.z, s: c.s })),
    gantry, jumbo, podium: Object.assign({}, PODIUM, { fireworks: { x: fireworks.x, y: fireworks.y, z: fireworks.z } }),
    crowd, fireworks, setWeather, update, dispose, stats,
    landmarks: { lighthouse: FARO, casino: CASINO && { x: CASINO.cx, y: CASINO.yg, z: CASINO.cz }, hairpinFountain: HAIRPIN && { x: HAIRPIN.cx, y: HAIRPIN.yg, z: HAIRPIN.cz }, cruise: { x: 160, y: WY, z: -470 } },
  };

  // ---------------------------------------------------------- auxiliares internos
  function personGeo() {
    const B = new Batch({ aPart: 1 });
    const t = [[-0.23, 0, -0.13], [0.23, 0, -0.13], [0.23, 0, 0.13], [-0.23, 0, 0.13], [-0.2, 0.62, -0.12], [0.2, 0.62, -0.12], [0.2, 0.62, 0.12], [-0.2, 0.62, 0.12]];
    const W1 = [1, 1, 1];
    const e0 = { aPart: 0 };
    B.quad(t[3], t[2], t[6], t[7], W1, e0); B.quad(t[1], t[0], t[4], t[5], W1, e0); B.quad(t[2], t[1], t[5], t[6], W1, e0); B.quad(t[0], t[3], t[7], t[4], W1, e0); B.quad(t[7], t[6], t[5], t[4], W1, e0);
    const hy = 0.8, hr = 0.125;
    const H = [[0, hy + hr * 1.2, 0], [0, hy - hr * 1.2, 0], [hr, hy, 0], [-hr, hy, 0], [0, hy, hr], [0, hy, -hr]];
    const e1 = { aPart: 1 };
    for (const [a, b] of [[2, 4], [4, 3], [3, 5], [5, 2]]) { B.tri(H[0], H[a], H[b], W1, e1); B.tri(H[1], H[b], H[a], W1, e1); }
    for (const sx of [-1, 1]) {
      const x0 = sx * 0.21, x1 = sx * 0.29;
      const A = [x0, 0.58, 0.02], Bp = [x1, 0.58, 0.02], C = [x1, 0.12, 0.05], D = [x0, 0.12, 0.05];
      const ePt = (p, part) => B._push(p[0], p[1], p[2], 0, 0, 1, W1, 0, 0, { aPart: part });
      ePt(A, 2); ePt(Bp, 2); ePt(C, 3); ePt(A, 2); ePt(C, 3); ePt(D, 3);
    }
    return B.build();
  }
  function buildEnv() {
    if (!renderer) return envMap || null;
    try {
      const es = new THREE.Scene();
      const sg = new THREE.SphereGeometry(50, 32, 16);
      const sm = new THREE.ShaderMaterial({ uniforms: skyUniformsForEnv(), vertexShader: SKY_VS.replace('gl_Position = p.xyww;', 'gl_Position = p;'), fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false });
      es.add(new THREE.Mesh(sg, sm));
      const panel = (w, h, col, x, y, z) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); es.add(m); };
      panel(30, 6, new THREE.Color(0.05, 0.045, 0.05), 0, -6, 0);
      const fl = new THREE.Mesh(new THREE.CircleGeometry(40, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.03, 0.035, 0.05) })); fl.position.y = -2; es.add(fl);
      for (let k = 0; k < 7; k++) { const a = (k / 7) * Math.PI * 2 + 0.3; panel(3.2, 0.9, new THREE.Color(3.2, 2.1, 1.1), Math.cos(a) * 18, 3 + (k % 2) * 2, Math.sin(a) * 18); }
      panel(10, 2.4, new THREE.Color(1.5, 0.75, 0.35), GLOW_DIR.x * 30, 2, GLOW_DIR.y * 30);
      const pm = new THREE.PMREMGenerator(renderer);
      const rt = pm.fromScene(es, 0.02);
      pm.dispose();
      es.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      ENV_RT = rt;
      return rt.texture;
    } catch (e) { return envMap || null; }
  }
  function skyUniformsForEnv() { return { uZen: { value: PAL.zen }, uMid: { value: PAL.mid }, uHor: { value: PAL.hor }, uGlow: { value: PAL.glow }, uGlow2: { value: PAL.glow2 }, uGlowDir: { value: GLOW_DIR }, uMoon: { value: MOON_DIR }, uTime: { value: 0 }, uRain: { value: 0 }, uClouds: { value: 0 } }; }
}

// ---------------------------------------------------------------- texturas de lienzo (una sola vez por construcción)
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined' && typeof document === 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
function makePaveTex() {
  const c = makeCanvas(256, 256), x = c.getContext('2d');
  x.fillStyle = 'rgb(122,118,112)'; x.fillRect(0, 0, 256, 256);
  const r = mulberry(7);
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
    const off = j % 2 ? 16 : 0;
    const v = 138 + r() * 22;
    x.fillStyle = `rgb(${v | 0},${(v * 0.97) | 0},${(v * 0.93) | 0})`;
    x.fillRect(((i * 32 + off) % 256) + 1, j * 32 + 1, 30, 30);
    if (off) x.fillRect(0, j * 32 + 1, 15, 30);
  }
  for (let k = 0; k < 2500; k++) { const v = (r() * 60 + 100) | 0; x.fillStyle = `rgba(${v},${v},${v},0.25)`; x.fillRect(r() * 256, r() * 256, 1.5, 1.5); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
function makePuddleTex() {
  const c = makeCanvas(256, 256), x = c.getContext('2d');
  x.fillStyle = 'rgb(140,140,140)'; x.fillRect(0, 0, 256, 256);
  const r = mulberry(11);
  for (let k = 0; k < 26; k++) {
    const px = r() * 256, py = r() * 256, rad = 10 + r() * 34;
    const g = x.createRadialGradient(px, py, 0, px, py, rad);
    g.addColorStop(0, 'rgba(28,28,28,0.95)'); g.addColorStop(0.7, 'rgba(28,28,28,0.7)'); g.addColorStop(1, 'rgba(28,28,28,0)');
    x.fillStyle = g;
    for (const [dx, dy] of [[0, 0], [256, 0], [-256, 0], [0, 256], [0, -256]]) { x.save(); x.translate(dx, dy); x.beginPath(); x.ellipse(px, py, rad * (1 + r()), rad, r() * 3, 0, Math.PI * 2); x.fill(); x.restore(); }
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1, 1);
  return t;
}
function drawSigns(x) {
  x.clearRect(0, 0, 1024, 512);
  const glowText = (txt, cx, cy, font, fill, glowc, blur = 16, maxW) => { x.font = font; x.textAlign = 'center'; x.textBaseline = 'middle'; x.shadowColor = glowc; x.shadowBlur = blur; x.fillStyle = fill; x.fillText(txt, cx, cy, maxW); x.shadowBlur = 0; x.fillText(txt, cx, cy, maxW); };
  glowText('H O T E L    M I R A M A R', 512, 58, 'bold 78px Georgia, "Times New Roman", serif', '#ffe6b0', '#ffb347', 22, 1000);
  glowText('C A S I N O', 256, 172, 'bold 92px Georgia, "Times New Roman", serif', '#ffe0a0', '#ffae3a', 20, 490);
  x.fillStyle = 'rgba(10,18,40,0.92)'; x.fillRect(516, 114, 504, 112);
  x.strokeStyle = '#ffc85a'; x.lineWidth = 4; x.strokeRect(520, 118, 496, 104);
  glowText('PUERTO MARINA', 768, 160, 'bold 62px Georgia, "Times New Roman", serif', '#fff2d6', '#ffc85a', 12, 470);
  glowText('GRAN PREMIO NEÓN', 768, 205, '600 22px Georgia, serif', '#9fd8ff', '#3aa0ff', 6, 470);
  { const n = 24, cw = 512 / n, ch = 20; for (let i = 0; i < n; i++) for (let j = 0; j < 4; j++) { x.fillStyle = (i + j) % 2 ? '#111' : '#f2f2f2'; x.fillRect(i * cw, 230 + j * ch, cw, ch); } x.fillStyle = 'rgba(8,14,30,.94)'; x.fillRect(150, 236, 212, 68); glowText('META', 256, 271, 'bold 50px Georgia, serif', '#ffd36b', '#ffae3a', 10); }
  const board = (px, py, bg, fg, txt, font) => { x.fillStyle = bg; x.fillRect(px + 2, py + 2, 252, 76); x.strokeStyle = 'rgba(255,255,255,.5)'; x.lineWidth = 2; x.strokeRect(px + 4, py + 4, 248, 72); glowText(txt, px + 128, py + 41, font, fg, 'rgba(0,0,0,0)', 0, 236); };
  board(512, 230, '#0a4fa8', '#ffffff', 'AQUAMAR', 'bold 40px "Helvetica Neue", Arial, sans-serif');
  board(768, 230, '#b3141f', '#fff4e0', 'VELA ROSSA', 'italic bold 36px Georgia, serif');
  board(0, 310, '#f2b705', '#14213d', 'SOLMAR', 'bold 44px "Helvetica Neue", Arial, sans-serif');
  board(256, 310, '#0b7a75', '#e8fff8', 'BRISA·MAR', 'bold 38px "Helvetica Neue", Arial, sans-serif');
  ['1', '2', '3'].forEach((n, i) => { glowText(n, 576 + i * 128, 376, 'bold 96px Georgia, serif', ['#ffe08a', '#eef3ff', '#ffc08a'][i], ['#ffb300', '#9fc4ff', '#ff8a3a'][i], 18); });
  x.fillStyle = 'rgba(6,12,30,0.95)'; x.fillRect(0, 440, 1024, 72);
  x.fillStyle = '#ffc85a'; x.fillRect(0, 440, 1024, 3); x.fillRect(0, 509, 1024, 3);
  glowText('GRAN PREMIO NEÓN  ·  PUERTO MARINA  ·  CIRCUITO URBANO', 512, 477, 'bold 34px Georgia, serif', '#f6ecd6', '#ffc85a', 6, 1000);
}
function mergeGeos(list) {
  const out = new Batch();
  for (const g of list) out.add(g, new THREE.Matrix4(), [1, 1, 1]);
  return out.build({ uv: true });
}
