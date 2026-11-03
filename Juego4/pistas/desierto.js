/* =========================================================================
   DESIERTO SOLAR · trazado (sin three.js)
   Circuito de alta velocidad al atardecer: recta de meta hacia +x por el
   origen, curva rápida (T1), eses rápidas por un cañón, curva peraltada
   tipo "bol" (La Caldera), la Recta del Sol (≈ 850 m, con cresta de duna)
   que muere en una horquilla de frenada brutal (zona de adelantamiento),
   y una parabólica rápida de vuelta a meta. Sentido horario (curvas a
   derechas; el interior queda a la derecha, lado −1, en +z).
   Longitud ≈ 2,79 km · radio mínimo ≈ 21 m · desnivel 0–14 m.
   ========================================================================= */

export default {
  id: 'desierto',
  name: 'Desierto Solar',
  short: 'DESIERTO',
  desc: 'Rectas eternas y rebufos: manda la velocidad punta',
  favours: 'velocidad',
  laps: 4,
  weatherOdds: { seco: 0.75, humedo: 0.0, viento: 0.25 },

  // Puntos de control [x, z, y] de una Catmull-Rom centrípeta cerrada.
  // Recta de meta: x de −160 a 280 en z = 0 (la línea de meta en el origen).
  points: [
    [-160, 0, 0],
    [-50, 0, 0.2],
    [60, 0, 0.4],
    [170, 0, 0.9],
    [280, 0, 1.2],
    // T1 · Curva Espejismo (rápida, a derechas, ~90°)
    [335.5, 11, 1.5],
    [382.5, 42.5, 2.1],
    [414, 89.5, 2.7],
    [425, 145, 3],
    // bajada entre dunas
    [425, 215, 5.3],
    [425, 285, 7.5],
    // Eses del Cañón (izq · der · izq, rápidas)
    [429.4, 313.6, 8.3],
    [442.2, 339.5, 9.9],
    [453.9, 364.7, 11.2],
    [456.3, 392.3, 11.5],
    [449.2, 419.2, 11.7],
    [441.8, 445.2, 12.1],
    [442.9, 472.3, 12.4],
    [452.6, 497.6, 12.5],
    // La Caldera (bol peraltado, ~135° a derechas)
    [477.6, 540.9, 12.2],
    [485.4, 559.7, 12],
    [488, 579.9, 11.7],
    [485.4, 600.1, 11.4],
    [477.6, 618.9, 11.2],
    [465.2, 635.1, 11.1],
    [449, 647.5, 11],
    [430.2, 655.3, 10.6],
    [410, 657.9, 9.9],
    [389.8, 655.3, 9.5],
    // Recta del Sol (la más larga, ≈ 850 m; cresta de duna a mitad)
    [283.6, 626.8, 11.2],
    [177.3, 598.3, 13.9],
    [71.1, 569.8, 13.9],
    [-35.2, 541.4, 11],
    [-141.4, 512.9, 9],
    [-247.7, 484.4, 4.8],
    [-353.9, 456, 3.7],
    [-460.2, 427.5, 2.5],
    // Horquilla del Oasis (R ≈ 21 m, ~165°): frenada fuerte, adelantamientos
    [-464.4, 425.9, 2.5],
    [-468.2, 423.4, 2.5],
    [-471.5, 420.2, 2.4],
    [-474, 416.4, 2.4],
    [-475.7, 412.2, 2.4],
    [-476.4, 407.7, 2.3],
    [-476.3, 403.2, 2.3],
    [-475.2, 398.8, 2.2],
    [-473.2, 394.7, 2.1],
    [-470.4, 391.1, 2.1],
    [-467, 388.1, 2.1],
    [-463, 385.9, 2],
    [-458.6, 384.6, 2],
    [-454.1, 384.2, 2],
    // salida y curva a izquierdas
    [-384.1, 385.5, 2.2],
    [-365.9, 382.9, 2.3],
    [-349.5, 374.8, 2.4],
    [-336.4, 361.9, 2.4],
    [-328, 345.6, 2.5],
    [-325.1, 327.5, 2.5],
    // subida y Parabólica del Poniente (rápida, a derechas) → meta
    [-325.1, 246.3, 5.5],
    [-325.1, 165.1, 2],
    [-312.5, 101.9, 1.7],
    [-276.7, 48.4, 1],
    [-223.2, 12.6, 0.3],
  ],

  halfWidth: 9,
  // Anchos por distancia aproximada desde la meta (m): recta de meta ancha,
  // cañón más estrecho, horquilla ancha para adelantar.
  widths: [
    { s0: 0, s1: 240, w: 10 },
    { s0: 2640, s1: 2790, w: 10 },
    { s0: 620, s1: 900, w: 8.5 },
    { s0: 1900, s1: 2080, w: 10.5 },
  ],
  // La Caldera: peralte (+ = lado izquierdo arriba = exterior de esta curva a derechas)
  banking: [{ x: 445, z: 610, r: 95, deg: 10 }],

  runoff: 'arena',
  barrier: 'muro',

  landmarks: [
    { type: 'stand', x: -130, z: 0, x2: 170, z2: 0, side: 1, name: 'Tribuna Oasis' },
    { type: 'pits', x: -140, z: 0, x2: 220, z2: 0, side: -1, name: 'Boxes' },
    { type: 'custom', x: 445, z: 395, name: 'Eses del Cañón' },
    { type: 'custom', x: 455, z: 610, name: 'La Caldera' },
    { type: 'hairpin', x: -476, z: 405, name: 'Horquilla del Oasis' },
    { type: 'stand', x: -430, z: 450, x2: -476, z2: 405, side: 1, name: 'Tribuna Horquilla' },
  ],
  // Nombres de curva (opcional, por proximidad al vértice)
  cornerNames: [
    { x: 400, z: 70, name: 'Curva Espejismo' },
    { x: 430, z: 313, r: 40, name: 'Eses del Cañón' },
    { x: 454, z: 366, r: 40, name: 'Eses del Cañón' },
    { x: 442, z: 447, r: 40, name: 'Eses del Cañón' },
    { x: 470, z: 600, r: 80, name: 'La Caldera' },
    { x: -476, z: 405, name: 'Horquilla del Oasis' },
    { x: -345, z: 370, name: 'Curva de la Duna' },
    { x: -300, z: 90, name: 'Parabólica del Poniente' },
  ],

  night: false,
  surface: { asphalt: '#3a3a3f', kerbA: '#e8452c', kerbB: '#f6eee0', line: '#fff3dc', glow: '#ffb04a' },
};
