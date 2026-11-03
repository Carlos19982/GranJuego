/* =========================================================================
   NEÓN CITY · trazado (sin three.js)
   Circuito nocturno urbano de ≈ 2,03 km: recta de meta hacia +x por el
   origen con la calle de boxes en el interior (lado −1, +z), Curva 1 larga
   a derechas, las Eses del Mirador, la Horquilla Neón (R ≈ 21 m), subida
   a la avenida elevada con la Galería de Neón (túnel), la pasarela
   peatonal, la Chicane del Mercado y la Gran Peraltada final de vuelta a
   meta. Sentido horario. Puntos [x, z, y], Catmull-Rom centrípeta cerrada.
   ========================================================================= */

export default {
  id: 'neon',
  name: 'Neón City',
  short: 'NEÓN',
  desc: 'Noche de neón: túnel, horquilla y una peraltada rapidísima — circuito equilibrado',
  favours: 'equilibrado',
  laps: 4,
  night: true,
  weatherOdds: { seco: 0.55, humedo: 0.25, viento: 0.2 },

  points: [
    [-60, 0, 0],
    [80, 0, 0],
    [200, 0, 0],
    // Curva 1 (larga, a derechas)
    [267.5, 18.1, 0.5],
    [316.9, 67.5, 1.5],
    [335.0, 135.0, 2.5],
    [335, 215, 3.5],
    // Eses del Mirador
    [320, 262, 4.5],
    [338, 310, 5.5],
    [334, 352, 6],
    // Horquilla Neón
    [329.6, 394.2, 6],
    [318.0, 410.8, 6],
    [297.8, 412.6, 6],
    [283.4, 398.2, 6],
    [268, 350, 6],
    [238, 328, 6.3],
    // avenida elevada: Galería de Neón y subida al viaducto
    [190, 314, 7],
    [110, 290, 9],
    [10, 266, 6],
    [-90, 248, 1.5],
    // Chicane del Mercado
    [-138, 246, 0.5],
    [-160, 236, 0],
    [-182, 236, 0],
    [-205, 246, 0],
    [-240, 240, 0],
    // Gran Peraltada
    [-330.4, 228.9, 0],
    [-392.2, 177.0, 0],
    [-408.0, 118.0, 0],
    [-392.2, 59.0, 0],
    [-330.4, 7.1, 0],
    [-200, 0, 0],
  ],

  halfWidth: 9,
  widths: [
    { x: 40, z: 0, r: 200, w: 9.5 },     // recta de meta (parrilla) un poco más ancha
    { x: 300, z: 40, r: 60, w: 10 },     // frenada de la Curva 1
    { x: 300, z: 400, r: 30, w: 9.6 },   // horquilla: sitio para el interior
    { x: 120, z: 295, r: 70, w: 8.4 },   // galería (túnel), más estrecha
  ],
  banking: [{ x: -395, z: 118, r: 120, deg: 7 }], // Gran Peraltada

  runoff: 'asfalto',
  barrier: 'muro',
  runoffs: [
    { x: 330, z: 80, r: 90, type: 'grava' },   // escapatoria de grava en la Curva 1
    { x: 300, z: 405, r: 40, type: 'grava' },  // y en la horquilla
  ],
  barriers: [
    { x: 330, z: 80, r: 80, type: 'neumaticos' },
    { x: 300, z: 405, r: 45, type: 'neumaticos' },
  ],

  landmarks: [
    { type: 'pits', x: -250, z: 0, x2: 185, z2: 0, side: -1, name: 'Boxes Neón' },
    { type: 'stand', x: -160, z: 0, x2: 150, z2: 0, side: 1, name: 'Tribuna Principal' },
    { type: 'stand', x: 325, z: 70, side: 1, name: 'Tribuna Curva 1' },
    { type: 'stand', x: 286, z: 404, name: 'Tribuna Horquilla' },
    { type: 'tunnel', x: 160, z: 302, x2: 70, z2: 276, name: 'Galería de Neón' },
    { type: 'bridge', x: -40, z: 254, name: 'Pasarela del Mercado' },
    { type: 'hairpin', x: 286, z: 404, name: 'Horquilla Neón' },
    { type: 'chicane', x: -168, z: 232, name: 'Chicane del Mercado' },
  ],
  cornerNames: [
    { x: 325, z: 70, name: 'Curva 1' },
    { x: 330, z: 290, r: 45, name: 'Eses del Mirador' },
    { x: 250, z: 335, r: 30, name: 'Curva del Viaducto' },
    { x: -395, z: 118, r: 120, name: 'Gran Peraltada' },
  ],

  surface: { asphalt: '#26232e', kerbA: '#ff2fb3', kerbB: '#f4f1ff', line: '#ffffff', glow: '#22e4ff', glowB: '#ff2fb3' },
};
