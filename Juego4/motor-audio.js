/* =====================================================================
   motor-audio.js — Audio procedural de carreras (Gran Premio Neón)
   ---------------------------------------------------------------------
   Módulo ES autónomo. No crea ni reanuda el AudioContext: lo recibe ya
   creado (tras un gesto del usuario) junto al nodo de destino.

     import { createRaceAudio } from './motor-audio.js';
     const ra = createRaceAudio(AX.sfx.ctx(), AX.sfx.master, { voices: 3 });
     // cada frame:
     ra.update({ listener, cars, dt });

   API (unidades: metros y m/s):
     update({ listener:{x,y,z,vx,vy,vz[,rx,rz]}, cars:[{x,y,z,vx,vy,vz,
             rpm 0..1, throttle 0..1, gear 1..6, slip 0..1}], dt })
        · El índice de cada coche en `cars` debe ser estable entre frames.
        · rx,rz (opcional): vector "derecha" horizontal y unitario de la
          cámara para el panorama; por defecto (1,0) = eje x del mundo.
        · Interno a ≤30 Hz; sin asignaciones por frame. Si la marcha sube:
          corte de encendido + caída breve de tono + petardeo ocasional.
     startBeep(final)   pitido de semáforo (corto grave / largo agudo)
     crowd(level 0..1)  fondo de público continuo · cheer() ovación
     whoosh(strength=1) soplo de aire de paso junto a la pista
     idle(level 0..1)   ralentí centrado (parrilla/garaje); 0 = apagar.
                        Reserva una voz del grupo mientras está activo.
     rev(amount 0..1)   acelerón en vacío (activa el ralentí si hace falta
                        y lo libera solo al terminar)
     setQuality('low'|'med'|'high')  1 / 2 / N voces (low quita el viento)
     setMuted(bool) · suspend() / resume() (silencia y desconecta la salida;
                        NO suspende el AudioContext compartido) · dispose()
     stats              diagnóstico: { nodes, enabled, active, voiceCar, pack }

   Diseño del motor (por voz):
     · Dos osciladores con PeriodicWave cuya fundamental es el CICLO
       completo del motor (720° de cigüeñal). Los armónicos múltiplos del
       nº de cilindros son los órdenes de encendido (fuertes 1º/2º/4º);
       los intermedios son los "sub-órdenes" (desequilibrio entre
       cilindros) que dan la aspereza/borboteo de un V10 real. La onda A
       (carga) es brillante; la B (retención) es más apagada y rugosa y
       va desafinada unos cents para que bata con la A.
     · Ruido en bucle → paso banda que sigue las rpm → ganancia modulada
       a ritmo de audio por la propia onda A (ráfagas sincronizadas con
       cada explosión = rasposo de admisión/escape).
     · Paso bajo dependiente de acelerador, rpm, distancia (absorción del
       aire) y Doppler: al levantar el pie el sonido se apaga y oscurece.
     · Petardeo (ruido filtrado por el mismo paso bajo, con envolvente
       programada) al levantar o cambiar de marcha, limitado en frecuencia.
     · Chirrido de neumáticos: ruido en paso banda estrecho con vibrato
       (LFO compartido) y ganancia según slip.
     · Atenuación inversa con rolloff, panorama estéreo (StereoPanner) y
       Doppler suavizado y limitado a ±15 %.
   Salida: bus → compresor/limitador → saturación suave (tanh) → mute.
   Todos los nodos se crean una sola vez (≈ 59 con 3 voces).
   ===================================================================== */

const SPEED_OF_SOUND = 343;
const TICK = 1 / 30; // máx. 30 Hz de actualización de parámetros
const IDLE = 0, ACTIVE = 1, FADE_OUT = 2, FADE_IN = 3, LOCAL = 4;

// también convierte NaN en el mínimo (entradas corruptas nunca llegan a un AudioParam)
const clamp = (v, a, b) => (v > a ? (v < b ? v : b) : a);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Amplitud de los órdenes de encendido (1 = fundamental percibida). */
function firingOrderAmp(k) {
  const table = [0, 1.0, 0.92, 0.42, 0.66, 0.28, 0.36, 0.2, 0.24, 0.13, 0.15];
  if (k < table.length) return table[k];
  return 0.95 * Math.pow(k, -1.15) * (k % 2 === 0 ? 1.15 : 0.85);
}

/**
 * Onda de un ciclo completo de motor (fundamental = ciclo de 720°).
 * cyl: explosiones por ciclo. orders: nº de órdenes de encendido.
 * tilt: caída espectral (mayor = más brillante). rough: sub-órdenes.
 */
function engineWave(ctx, rnd, cyl, orders, tilt, rough, burble) {
  const H = cyl * orders;
  const re = new Float32Array(H + 1);
  const im = new Float32Array(H + 1);
  const half = cyl / 2;
  for (let n = 1; n <= H; n++) {
    const o = n / cyl; // orden relativo al encendido
    let amp;
    if (n % cyl === 0) {
      amp = firingOrderAmp(o);
    } else {
      const k = Math.max(1, Math.round(o));
      amp = rough * firingOrderAmp(k) * (0.45 + rnd());
      if (n % half === 0) amp *= burble; // semi-órdenes: borboteo
      if (o < 1) amp *= 0.35 + 0.65 * o; // sub-graves contenidos
    }
    amp *= Math.exp(-(o - 1) / tilt);
    const ph = rnd() * Math.PI * 2;
    re[n] = amp * Math.cos(ph);
    im[n] = amp * Math.sin(ph);
  }
  return ctx.createPeriodicWave(re, im);
}

/**
 * Onda del "pelotón": fundamental = encendido/div; la energía se agrupa en
 * racimos alrededor de cada orden (±2 armónicos ≈ ±10 %) → varios motores
 * ligeramente distintos batiendo, con un solo oscilador.
 */
function packWave(ctx, rnd, div, orders) {
  const H = div * orders + 3;
  const re = new Float32Array(H + 1);
  const im = new Float32Array(H + 1);
  const spread = [0.55, 0.85, 1, 0.8, 0.5];
  for (let k = 1; k <= orders; k++) {
    const a = firingOrderAmp(k) * Math.exp(-(k - 1) / 5);
    for (let j = -2; j <= 2; j++) {
      const n = k * div + j;
      if (n < 1 || n > H) continue;
      const amp = a * spread[j + 2] * (0.7 + 0.6 * rnd());
      const ph = rnd() * Math.PI * 2;
      re[n] = amp * Math.cos(ph);
      im[n] = amp * Math.sin(ph);
    }
  }
  return ctx.createPeriodicWave(re, im);
}

/** Onda cuadrada suave para los pitidos del semáforo. */
function beepWave(ctx) {
  const re = new Float32Array(8);
  const im = new Float32Array(8);
  im[1] = 1; im[3] = 0.28; im[5] = 0.1; im[7] = 0.04;
  return ctx.createPeriodicWave(re, im);
}

/** Parámetro con caché: sólo programa si el cambio supera el umbral. */
class P {
  constructor(param, init) {
    this.p = param;
    this.v = init;
    param.value = init;
  }
  to(v, now, tc, rel, abs) {
    const d = v - this.v;
    if ((d < 0 ? -d : d) <= abs + rel * (this.v < 0 ? -this.v : this.v)) return;
    this.v = v;
    this.p.setTargetAtTime(v, now, tc);
  }
  /** Tras programar automatización manual: fuerza el siguiente to(). */
  dirty(v) {
    this.v = v === undefined ? NaN : v;
  }
}

/**
 * @param {BaseAudioContext} ctx  contexto ya creado (no se crea ni reanuda aquí)
 * @param {AudioNode} destination  p. ej. AX.sfx.master
 * @param {object} [opts]
 *   voices (3)        nº de coches con voz propia (1..6)
 *   volume (0.7)      ganancia del bus del módulo
 *   cylinders (10)    explosiones por ciclo (8 = V8, 10 = V10)
 *   minHz (40) maxHz (330)  frecuencia de encendido para rpm 0 y 1
 *   refDistance (8) rolloff (1) maxDistance (600)  atenuación (m)
 *   wind (true)       viento según la velocidad del oyente (cámara a bordo)
 *   seed (7)          semilla del timbre
 */
export function createRaceAudio(ctx, destination, opts = {}) {
  const MAXV = clamp((opts.voices ?? 3) | 0, 1, 6);
  const CYL = Math.max(4, (opts.cylinders ?? 10) | 0);
  const MIN_HZ = opts.minHz ?? 40;
  const MAX_HZ = opts.maxHz ?? 330;
  const REF_D = opts.refDistance ?? 8;
  const ROLLOFF = opts.rolloff ?? 1;
  const MAX_D = opts.maxDistance ?? 600;
  const PACK_DIV = 20;
  const sr = ctx.sampleRate;
  const rnd = mulberry32(opts.seed ?? 7);
  const nodes = [];
  const sources = [];
  const timers = [];
  const N = (n) => (nodes.push(n), n);
  // k-rate: coeficientes/fase por bloque de 128 muestras en vez de por muestra (mucho más barato)
  const kRate = (...ps) => { for (const p of ps) if (p && 'automationRate' in p) { try { p.automationRate = 'k-rate'; } catch (e) {} } };
  const panner = () => {
    if (ctx.createStereoPanner) { const p = N(ctx.createStereoPanner()); kRate(p.pan); return p; }
    // Safari antiguo: sin panorama, misma interfaz
    const g = N(ctx.createGain());
    g.pan = { value: 0, setTargetAtTime() {}, cancelScheduledValues() {} };
    return g;
  };
  const gain = (v) => { const g = N(ctx.createGain()); g.gain.value = v; return g; };
  const biquad = (type, f, q) => {
    const b = N(ctx.createBiquadFilter());
    b.type = type; b.frequency.value = f; b.Q.value = q;
    kRate(b.frequency, b.detune, b.Q, b.gain);
    return b;
  };
  const fireHz = (rpm) => MIN_HZ + (MAX_HZ - MIN_HZ) * rpm;

  /* ---------------- salida ---------------- */
  const out = gain(1);
  const clip = N(ctx.createWaveShaper());
  {
    const n = 2048, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1, ax = Math.abs(x);
      // lineal hasta 0.5, rodilla tanh suave hasta 0.95 (sin "fizz")
      const y = ax < 0.5 ? ax : 0.5 + 0.45 * Math.tanh((ax - 0.5) / 0.45);
      curve[i] = x < 0 ? -y : y;
    }
    clip.curve = curve;
    clip.oversample = 'none';
  }
  const comp = N(ctx.createDynamicsCompressor());
  comp.threshold.value = -9;
  comp.knee.value = 6;
  comp.ratio.value = 10;
  comp.attack.value = 0.004;
  comp.release.value = 0.2;
  const bus = gain(opts.volume ?? 0.7);
  bus.connect(comp); comp.connect(clip); clip.connect(out);
  let outConnected = false;
  const connectOut = () => { if (!outConnected) { out.connect(destination); outConnected = true; } };
  connectOut();

  /* ---------------- ruido compartido ---------------- */
  const noiseBuf = ctx.createBuffer(1, Math.floor(sr * 3), sr);
  {
    const d = noiseBuf.getChannelData(0), r = mulberry32(99);
    for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
  }
  const mkNoise = (offset) => {
    const s = N(ctx.createBufferSource());
    s.buffer = noiseBuf; s.loop = true;
    sources.push([s, offset]);
    return s;
  };
  const noiseV = mkNoise(0);     // voces
  const noiseB = mkNoise(1.37);  // fondos

  // LFO compartido para el vibrato del chirrido
  const sqLfo = N(ctx.createOscillator());
  sqLfo.frequency.value = 5.7;
  kRate(sqLfo.frequency, sqLfo.detune);
  sources.push([sqLfo, 0]);
  const sqLfoG = gain(70); // cents
  sqLfo.connect(sqLfoG);

  /* ---------------- ondas ---------------- */
  const waveA = engineWave(ctx, rnd, CYL, 32, 16, 0.12, 1.0);
  const waveB = engineWave(ctx, rnd, CYL, 32, 5.5, 0.24, 1.8);

  /* ---------------- voces ---------------- */
  const voices = [];
  for (let i = 0; i < MAXV; i++) {
    const oA = N(ctx.createOscillator()); oA.setPeriodicWave(waveA);
    const oB = N(ctx.createOscillator()); oB.setPeriodicWave(waveB);
    kRate(oA.frequency, oA.detune, oB.frequency, oB.detune);
    oB.detune.value = 6 + i * 1.7;
    const gA = gain(0), gB = gain(0);
    const nBP = biquad('bandpass', 800, 0.9);
    const nG = gain(0);
    const lp = biquad('lowpass', 600, 0.8);
    const popG = gain(0);
    const sqBP = biquad('bandpass', 2200, 11);
    const sqG = gain(0);
    const vG = gain(0);
    const pan = panner();
    const f0 = fireHz(0.1) / CYL;
    oA.frequency.value = f0; oB.frequency.value = f0;
    oA.connect(gA); gA.connect(lp);
    oB.connect(gB); gB.connect(lp);
    gA.connect(nG.gain); // AM del ruido sincronizada con las explosiones
    noiseV.connect(nBP); nBP.connect(nG); nG.connect(lp);
    noiseV.connect(popG); popG.connect(lp);
    lp.connect(vG);
    noiseV.connect(sqBP); sqLfoG.connect(sqBP.detune); sqBP.connect(sqG); sqG.connect(vG);
    vG.connect(pan); pan.connect(bus);
    sources.push([oA, 0], [oB, 0]);
    voices.push({
      idx: i, enabled: true, connected: true, pan,
      fA: new P(oA.frequency, f0), fB: new P(oB.frequency, f0),
      gA: new P(gA.gain, 0), gB: new P(gB.gain, 0),
      nf: new P(nBP.frequency, 800), ng: new P(nG.gain, 0),
      lp: new P(lp.frequency, 600), pop: popG.gain,
      sqf: new P(sqBP.frequency, 2200), sqg: new P(sqG.gain, 0),
      vg: new P(vG.gain, 0), pn: new P(pan.pan, 0),
      car: -1, pending: -1, state: IDLE, until: 0, snap: true,
      dop: 1, jit: 0, shiftAt: -10, holdUntil: 0,
    });
  }

  /* ---------------- pelotón ---------------- */
  const packOsc = N(ctx.createOscillator());
  packOsc.setPeriodicWave(packWave(ctx, rnd, PACK_DIV, 10));
  packOsc.frequency.value = fireHz(0.3) / PACK_DIV;
  kRate(packOsc.frequency, packOsc.detune);
  sources.push([packOsc, 0]);
  const packLP = biquad('lowpass', 700, 0.7);
  const packNBP = biquad('bandpass', 400, 0.8);
  const packG = gain(0);
  const packPan = panner();
  packOsc.connect(packLP); packLP.connect(packG);
  noiseB.connect(packNBP); packNBP.connect(packG);
  packG.connect(packPan); packPan.connect(bus);
  const pack = {
    f: new P(packOsc.frequency, packOsc.frequency.value), lp: new P(packLP.frequency, 700),
    nf: new P(packNBP.frequency, 400), g: new P(packG.gain, 0), pn: new P(packPan.pan, 0),
  };

  /* ---------------- público ---------------- */
  const crBP = biquad('bandpass', 750, 0.6);
  const crG = gain(0);
  const chBP = biquad('bandpass', 1650, 1.1);
  const chG = gain(0);
  noiseB.connect(crBP); crBP.connect(crG); crG.connect(bus);
  noiseB.connect(chBP); chBP.connect(chG); chG.connect(bus);
  const crowdP = new P(crG.gain, 0);
  let crowdLevel = 0, crowdMod = 1, crowdT = 0;

  /* ---------------- viento y whoosh ---------------- */
  const wBP = biquad('bandpass', 900, 0.6);
  const wG = gain(0);
  noiseB.connect(wBP); wBP.connect(wG); wG.connect(bus);
  const wind = { f: new P(wBP.frequency, 900), g: new P(wG.gain, 0) };
  let windOn = opts.wind !== false;
  const whBP = biquad('bandpass', 400, 1.3);
  const whG = gain(0);
  noiseB.connect(whBP); whBP.connect(whG); whG.connect(bus);

  /* ---------------- pitidos de salida ---------------- */
  const beepOsc = N(ctx.createOscillator());
  beepOsc.setPeriodicWave(beepWave(ctx));
  beepOsc.frequency.value = 520;
  sources.push([beepOsc, 0]);
  const beepG = gain(0);
  beepOsc.connect(beepG); beepG.connect(bus);

  // arrancar todas las fuentes
  {
    const t = ctx.currentTime;
    for (const [s, off] of sources) s.start(t, off);
  }

  /* ---------------- estado por coche (crece sin asignar por frame) ---------------- */
  let cap = 0;
  let dist, att, panv, carVoice, lastGear, thrHi, lastPop;
  const ensureCap = (n) => {
    if (n <= cap) return;
    const c = Math.max(n, cap * 2, 24);
    const grow = (A, old, fill) => { const a = new A(c); if (old) a.set(old); if (fill) a.fill(fill, old ? old.length : 0); return a; };
    dist = grow(Float64Array, dist); att = grow(Float64Array, att); panv = grow(Float64Array, panv);
    carVoice = grow(Int32Array, carVoice, -1); lastGear = grow(Int32Array, lastGear);
    thrHi = grow(Float64Array, thrHi); lastPop = grow(Float64Array, lastPop, -10);
    cap = c;
  };
  ensureCap(24);
  const chosen = new Int32Array(6);
  const chosenS = new Float64Array(6);

  let nEnabled = MAXV;
  let muted = false, suspended = false, disposed = false, suspendTimer = 0;
  let accum = TICK; // primer update procesa ya
  let localIdx = -1, localLevel = 0, localAuto = false, revUntil = 0;
  const stats = { nodes: nodes.length, voices: MAXV, enabled: MAXV, active: 0, voiceCar: new Int32Array(MAXV), pack: 0, ticks: 0 };

  const attenuation = (d) => {
    let g = REF_D / (REF_D + ROLLOFF * (Math.max(d, REF_D) - REF_D));
    if (d > MAX_D * 0.6) g *= clamp((MAX_D - d) / (MAX_D * 0.4), 0, 1);
    return g;
  };

  /** Petardeo: n ráfagas cortas de ruido a través del paso bajo de la voz. */
  function pops(v, n, amp, delay) {
    const now = ctx.currentTime + (delay || 0);
    const g = v.pop;
    let t = now;
    for (let i = 0; i < n; i++) {
      t += 0.03 + Math.random() * 0.09;
      const a = amp * (0.55 + Math.random() * 0.45) * (1 - i * 0.12);
      g.setTargetAtTime(a, t, 0.0015);
      g.setTargetAtTime(0, t + 0.006, 0.012 + Math.random() * 0.01);
    }
  }

  function shiftCut(v, now, up) {
    v.shiftAt = now;
    v.holdUntil = now + 0.12;
    const a = v.gA.v, b = v.gB.v;
    const pa = v.gA.p, pb = v.gB.p;
    pa.cancelScheduledValues(now); pb.cancelScheduledValues(now);
    pa.setTargetAtTime(a * (up ? 0.22 : 0.5), now, 0.008);
    pb.setTargetAtTime(b * 0.6, now, 0.01);
    pa.setTargetAtTime(a, now + (up ? 0.065 : 0.04), 0.03);
    pb.setTargetAtTime(b, now + 0.065, 0.03);
  }

  function releaseVoice(v, now, tc) {
    if (v.car >= 0 && carVoice[v.car] === v.idx) carVoice[v.car] = -1;
    if (v.pending >= 0 && carVoice[v.pending] === v.idx) carVoice[v.pending] = -1;
    v.car = -1; v.pending = -1;
    if (v.state !== IDLE) {
      v.vg.to(0, now, tc || 0.025, 0, 0);
      v.sqg.to(0, now, 0.02, 0, 0);
      v.state = FADE_OUT;
      v.until = now + 0.1;
    }
  }

  /* ------------ parámetros de una voz con un coche ------------ */
  function driveVoice(v, car, ci, L, now, tick) {
    const snap = v.snap;
    v.snap = false;
    const d = dist[ci];
    const rx = car.x - L.x, ry = (car.y || 0) - (L.y || 0), rz = car.z - L.z;
    const inv = 1 / Math.max(d, 0.5);
    const vr = (((car.vx || 0) - (L.vx || 0)) * rx + ((car.vy || 0) - (L.vy || 0)) * ry + ((car.vz || 0) - (L.vz || 0)) * rz) * inv;
    const dopT = clamp(SPEED_OF_SOUND / (SPEED_OF_SOUND + vr), 0.85, 1.15);
    v.dop = snap ? dopT : v.dop + (dopT - v.dop) * (1 - Math.exp(-tick / 0.06));
    const dop = v.dop;
    const rpm = clamp(car.rpm || 0, 0, 1);
    const thr = clamp(car.throttle ?? 1, 0, 1);
    const sd = now - v.shiftAt;
    const dip = sd < 0.3 ? 1 - 0.06 * Math.exp(-sd / 0.07) : 1;
    v.jit = v.jit * 0.85 + (Math.random() - 0.5) * 0.0024;
    const ff = fireHz(rpm) * dip;
    const fo = (ff / CYL) * dop * (1 + v.jit);
    const tf = snap ? 0.004 : 0.03;
    v.fA.to(fo, now, tf, 0.0015, 0);
    v.fB.to(fo, now, tf, 0.0015, 0);
    const air = 1 / (1 + d / 150);
    v.lp.to(clamp((320 + ff * (2.6 + 9 * thr)) * air * dop, 180, 14000), now, snap ? 0.004 : 0.04, 0.01, 0);
    v.nf.to(clamp(ff * 4.5 * dop, 200, 6000), now, snap ? 0.004 : 0.04, 0.01, 0);
    const ga = 0.5 * (0.32 + 0.68 * thr);
    if (now >= v.holdUntil) {
      v.gA.to(ga, now, 0.035, 0.01, 0.001);
      v.gB.to(0.3 * (1 - 0.4 * thr), now, 0.04, 0.01, 0.001);
    }
    v.ng.to(ga * (0.55 + 0.6 * thr * rpm), now, 0.04, 0.01, 0.001);
    // chirrido
    const slip = clamp(car.slip || 0, 0, 1);
    if (slip > 0.03) {
      v.sqg.to(1.3 * Math.pow(slip, 1.3), now, 0.05, 0.03, 0.002);
      v.sqf.to((1850 + 800 * slip) * dop * (1 + (Math.random() - 0.5) * 0.04), now, 0.06, 0.008, 0);
    } else v.sqg.to(0, now, 0.06, 0, 0.0005);
    // nivel y panorama
    const loud = 0.5 + 0.5 * rpm;
    v.vg.to(att[ci] * loud * 0.9, now, v.state === FADE_IN ? 0.07 : 0.04, 0.015, 0.0005);
    v.pn.to(panv[ci], now, 0.05, 0, 0.01);
    if (v.state === FADE_IN && now >= v.until) v.state = ACTIVE;
  }

  function driveLocal(v, now, snap) {
    const rpm = 0.07, ff = fireHz(rpm);
    const tc = snap ? 0.004 : 0.08;
    v.fA.to(ff / CYL, now, tc, 0.0015, 0);
    v.fB.to(ff / CYL, now, tc, 0.0015, 0);
    v.lp.to(320 + ff * 4.5, now, tc, 0.01, 0);
    v.nf.to(ff * 4.5, now, tc, 0.01, 0);
    v.gA.to(0.22, now, 0.06, 0.01, 0.001);
    v.gB.to(0.3, now, 0.06, 0.01, 0.001);
    v.ng.to(0.14, now, 0.06, 0.01, 0.001);
    v.sqg.to(0, now, 0.05, 0, 0.0005);
    v.pn.to(0, now, 0.05, 0, 0.01);
    v.vg.to(localLevel * 0.55, now, 0.12, 0.01, 0.0005);
  }

  /* ---------------- bucle por frame ---------------- */
  const ZL = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  const NOCARS = [];

  function update(frame) {
    if (disposed || suspended || ctx.state === 'closed') return;
    const dt = frame && frame.dt > 0 ? Math.min(frame.dt, 0.25) : 1 / 60;
    accum += dt;
    if (accum < TICK) return;
    const tick = Math.min(accum, 0.25);
    accum = 0;
    stats.ticks++;
    const now = ctx.currentTime;
    const L = (frame && frame.listener) || ZL;
    const cars = (frame && frame.cars) || NOCARS;
    const M = cars.length;
    ensureCap(M);
    const rxv = L.rx ?? 1, rzv = L.rz ?? 0; // vector "derecha" opcional del oyente

    // distancias, atenuación, panorama, eventos (cambios, levantadas)
    for (let i = 0; i < M; i++) {
      const c = cars[i];
      const dx = c.x - L.x, dy = (c.y || 0) - (L.y || 0), dz = c.z - L.z;
      let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(d < 1e7)) d = 1e7; // NaN/∞ → muy lejos
      dist[i] = d;
      att[i] = attenuation(d);
      const pr = (dx * rxv + dz * rzv) / (d + 1.5);
      panv[i] = pr === pr ? clamp(pr, -1, 1) * 0.85 : 0;
      const gear = c.gear | 0, thr = c.throttle ?? 1, rpm = c.rpm || 0;
      const vi = carVoice[i];
      const v = vi >= 0 ? voices[vi] : null;
      const audible = v && v.car === i && (v.state === ACTIVE || v.state === FADE_IN);
      if (lastGear[i] && gear !== lastGear[i] && audible) {
        const up = gear > lastGear[i];
        shiftCut(v, now, up);
        if (now - lastPop[i] > 0.5 && Math.random() < (up ? 0.4 : 0.3)) {
          lastPop[i] = now;
          pops(v, up ? 1 : 2 + (Math.random() * 2) | 0, up ? 0.35 : 0.5, 0.02);
        }
      }
      lastGear[i] = gear;
      thrHi[i] = Math.max(thr, thrHi[i] - tick * 2.5);
      if (thr < 0.2 && thrHi[i] > 0.6) {
        thrHi[i] = thr;
        if (audible && rpm > 0.45 && now - lastPop[i] > 1.2 && Math.random() < 0.65) {
          lastPop[i] = now;
          pops(v, 2 + ((Math.random() * 4) | 0), 0.55, 0.04);
        }
      }
    }

    // liberar voz local tras un rev() automático
    if (localIdx >= 0 && localAuto && localLevel > 0 && now > revUntil) idle(0);

    // elegir los K coches más cercanos (con histéresis)
    const K = nEnabled - (localIdx >= 0 ? 1 : 0);
    for (let k = 0; k < K; k++) { chosen[k] = -1; chosenS[k] = Infinity; }
    for (let i = 0; i < M && K > 0; i++) {
      const vi = carVoice[i];
      const s = dist[i] * (vi >= 0 ? 0.8 : 1) - (vi >= 0 ? 2 : 0);
      if (s >= chosenS[K - 1]) continue;
      let k = K - 1;
      while (k > 0 && chosenS[k - 1] > s) { chosenS[k] = chosenS[k - 1]; chosen[k] = chosen[k - 1]; k--; }
      chosenS[k] = s; chosen[k] = i;
    }
    // voces que pierden su coche
    for (let vi = 0; vi < nEnabled; vi++) {
      const v = voices[vi];
      if (v.state === LOCAL) continue;
      const c = v.pending >= 0 ? v.pending : v.car;
      if (c < 0) continue;
      let keep = c < M;
      if (keep) { keep = false; for (let k = 0; k < K; k++) if (chosen[k] === c) { keep = true; break; } }
      if (!keep) releaseVoice(v, now);
    }
    // coches elegidos sin voz
    for (let k = 0; k < K; k++) {
      const c = chosen[k];
      if (c < 0 || carVoice[c] >= 0) continue;
      let best = null;
      for (let vi = 0; vi < nEnabled; vi++) {
        const v = voices[vi];
        if (v.state === LOCAL || v.car >= 0 || v.pending >= 0) continue;
        if (!best || (v.state === IDLE && best.state !== IDLE)) best = v;
      }
      if (!best) break;
      carVoice[c] = best.idx;
      if (best.state === IDLE) { best.car = c; best.state = FADE_IN; best.snap = true; best.until = now + 0.3; }
      else best.pending = c; // espera a que termine su fundido de salida
    }
    // conducir voces
    let active = 0;
    for (let vi = 0; vi < nEnabled; vi++) {
      const v = voices[vi];
      if (v.state === LOCAL) {
        if (now >= revUntil) driveLocal(v, now, false);
        active++;
        continue;
      }
      if (v.state === FADE_OUT) {
        if (now < v.until) continue;
        if (v.pending >= 0) { v.car = v.pending; v.pending = -1; v.state = FADE_IN; v.snap = true; v.until = now + 0.3; }
        else { v.state = IDLE; continue; }
      }
      if (v.state === IDLE || v.car < 0 || v.car >= M) continue;
      driveVoice(v, cars[v.car], v.car, L, now, tick);
      active++;
    }
    stats.active = active;
    for (let vi = 0; vi < MAXV; vi++) stats.voiceCar[vi] = voices[vi].state === LOCAL ? -2 : voices[vi].car;

    // pelotón: todos los coches sin voz
    let E = 0, rs = 0, nP = 0, pAcc = 0;
    for (let i = 0; i < M; i++) {
      const vi = carVoice[i];
      if (vi >= 0 && voices[vi].car === i) continue; // ya suena en su voz (los que esperan relevo siguen aquí)
      const rpm = clamp(cars[i].rpm || 0, 0, 1);
      const a = att[i] * (0.5 + 0.5 * rpm);
      const e = a * a;
      E += e; pAcc += e * panv[i]; rs += rpm; nP++;
    }
    if (nP > 0) {
      const avg = rs / nP, ff = fireHz(avg);
      const lvl = Math.min(0.5, Math.sqrt(E) * 0.75);
      stats.pack = lvl;
      pack.g.to(lvl, now, 0.15, 0.02, 0.0005);
      pack.f.to(ff / PACK_DIV, now, 0.08, 0.002, 0);
      pack.lp.to(260 + ff * 2.6, now, 0.1, 0.02, 0);
      pack.nf.to(180 + ff * 2, now, 0.1, 0.02, 0);
      pack.pn.to(E > 0 ? (pAcc / E) * 0.6 : 0, now, 0.2, 0, 0.02);
    } else { stats.pack = 0; pack.g.to(0, now, 0.15, 0, 0.0005); }

    // viento según la velocidad del oyente (cámara a bordo)
    const ls = Math.sqrt((L.vx || 0) ** 2 + (L.vy || 0) ** 2 + (L.vz || 0) ** 2);
    const w = windOn ? clamp((ls - 12) / 80, 0, 1) : 0;
    wind.g.to(0.08 * w * w, now, 0.15, 0.03, 0.0005);
    if (w > 0) wind.f.to(500 + ls * 16, now, 0.2, 0.03, 0);

    // murmullo del público (≈ 4 Hz)
    crowdT += tick;
    if (crowdT > 0.25) {
      crowdT = 0;
      crowdMod = clamp(crowdMod + (Math.random() - 0.5) * 0.25, 0.75, 1.2);
      crowdP.to(crowdLevel * 0.2 * crowdMod, now, 0.35, 0.03, 0.0005);
    }
  }

  /* ---------------- extras ---------------- */
  function startBeep(final) {
    if (disposed) return;
    const now = ctx.currentTime + 0.005;
    const g = beepG.gain, f = beepOsc.frequency;
    g.cancelScheduledValues(now); f.cancelScheduledValues(now);
    f.setTargetAtTime(final ? 1046 : 523, now, 0.002);
    const dur = final ? 0.75 : 0.17, v = final ? 0.24 : 0.2;
    g.setTargetAtTime(v, now + 0.006, 0.004);
    g.setTargetAtTime(0, now + dur, final ? 0.08 : 0.018);
  }

  function crowd(level) {
    if (disposed) return;
    crowdLevel = clamp(level || 0, 0, 1);
    crowdP.to(crowdLevel * 0.2 * crowdMod, ctx.currentTime, 0.4, 0, 0.0002);
  }

  function cheer() {
    if (disposed) return;
    const now = ctx.currentTime;
    const g = chG.gain, f = chBP.frequency;
    g.cancelScheduledValues(now); f.cancelScheduledValues(now);
    g.setTargetAtTime(0.22, now, 0.18);
    g.setTargetAtTime(0, now + 1.6, 0.8);
    f.setTargetAtTime(1900, now, 0.3);
    f.setTargetAtTime(1500, now + 1.2, 0.8);
  }

  function whoosh(strength = 1) {
    if (disposed) return;
    const now = ctx.currentTime;
    const g = whG.gain, f = whBP.frequency, s = clamp(strength, 0, 1.5);
    g.cancelScheduledValues(now); f.cancelScheduledValues(now);
    f.setTargetAtTime(2800, now, 0.12);
    g.setTargetAtTime(0.3 * s, now, 0.07);
    f.setTargetAtTime(450, now + 0.22, 0.15);
    g.setTargetAtTime(0, now + 0.22, 0.12);
  }

  /** Motor al ralentí en parrilla/garaje (sin posición; centrado). 0 = apagar. */
  function idle(level) {
    if (disposed) return;
    const now = ctx.currentTime;
    localLevel = clamp(level || 0, 0, 1);
    if (localLevel > 0) {
      localAuto = false;
      if (localIdx < 0) {
        const v = voices[nEnabled - 1];
        releaseVoice(v, now, 0.01);
        v.state = LOCAL;
        localIdx = v.idx;
        driveLocal(v, now, true);
      } else if (now >= revUntil) driveLocal(voices[localIdx], now, false);
    } else if (localIdx >= 0) {
      const v = voices[localIdx];
      localIdx = -1;
      v.state = ACTIVE; // para que releaseVoice haga el fundido
      v.vg.p.cancelScheduledValues(now);
      v.vg.dirty();
      releaseVoice(v, now, 0.08);
      v.until = now + 0.35;
      revUntil = 0;
    }
  }

  /** Acelerón en vacío (garaje). amount 0..1. Activa el ralentí si hace falta. */
  function rev(amount = 0.7) {
    if (disposed) return;
    if (localIdx < 0) { idle(0.6); localAuto = true; }
    const v = voices[localIdx];
    const a = clamp(amount, 0, 1);
    const now = ctx.currentTime;
    const up = 0.08 + 0.12 * a, hold = 0.1 + 0.25 * a;
    const fI = fireHz(0.07), fP = fireHz(0.15 + 0.8 * a);
    const sched = (p, peak, rest, tUp, tDn) => {
      p.p.cancelScheduledValues(now);
      p.p.setTargetAtTime(peak, now, tUp);
      p.p.setTargetAtTime(rest, now + up + hold, tDn);
      p.dirty(rest);
    };
    sched(v.fA, fP / CYL, fI / CYL, up * 0.4, 0.22);
    sched(v.fB, fP / CYL, fI / CYL, up * 0.4, 0.22);
    sched(v.lp, 320 + fP * 11, 320 + fI * 4.5, up * 0.4, 0.2);
    sched(v.nf, fP * 4.5, fI * 4.5, up * 0.4, 0.22);
    sched(v.gA, 0.5, 0.22, 0.02, 0.1);
    sched(v.gB, 0.18, 0.3, 0.03, 0.15);
    sched(v.ng, 0.45, 0.14, 0.03, 0.15);
    const base = localLevel * 0.55;
    sched(v.vg, Math.min(1, base * (1.3 + 0.9 * a)), base, 0.04, 0.25);
    revUntil = now + up + hold + 0.9;
    if (a > 0.35 && Math.random() < 0.6) pops(v, 2 + ((Math.random() * 3) | 0), 0.5, up + hold + 0.06);
  }

  function setQuality(q) {
    if (disposed) return;
    const n = q === 'low' ? 1 : q === 'med' ? Math.min(2, MAXV) : MAXV;
    windOn = q !== 'low' && opts.wind !== false;
    if (n === nEnabled) return;
    const now = ctx.currentTime;
    const keepLocal = localIdx >= 0 ? localLevel : 0;
    if (localIdx >= 0) { localIdx = -1; voices.forEach((v) => { if (v.state === LOCAL) { v.state = ACTIVE; releaseVoice(v, now, 0.02); } }); }
    for (let i = 0; i < MAXV; i++) {
      const v = voices[i];
      if (i < n) {
        if (!v.connected) { v.pan.connect(bus); v.connected = true; }
        v.enabled = true;
      } else if (v.enabled) {
        v.enabled = false;
        releaseVoice(v, now, 0.02);
        timers.push(setTimeout(() => { if (!v.enabled && v.connected && !disposed) { v.pan.disconnect(); v.connected = false; v.state = IDLE; } }, 200));
      }
    }
    nEnabled = n;
    stats.enabled = n;
    if (keepLocal > 0) idle(keepLocal);
  }

  function setMuted(m) {
    if (disposed) return;
    muted = !!m;
    if (!suspended) out.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.03);
  }

  /** Silencia y desconecta la salida (ahorra CPU). No suspende el contexto compartido. */
  function suspend() {
    if (disposed || suspended) return;
    suspended = true;
    out.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
    clearTimeout(suspendTimer);
    suspendTimer = setTimeout(() => { if (suspended && outConnected && !disposed) { out.disconnect(); outConnected = false; } }, 200);
    timers.push(suspendTimer);
  }

  function resume() {
    if (disposed || !suspended) return;
    suspended = false;
    clearTimeout(suspendTimer);
    connectOut();
    accum = TICK;
    out.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.05);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    timers.forEach(clearTimeout);
    for (const [s] of sources) { try { s.stop(); } catch (e) {} }
    for (const n of nodes) { try { n.disconnect(); } catch (e) {} }
  }

  return {
    update, startBeep, crowd, cheer, whoosh, idle, rev,
    setQuality, setMuted, suspend, resume, dispose,
    /** Diagnóstico (objeto reutilizado, no copiar por frame). */
    stats,
  };
}

export default createRaceAudio;
