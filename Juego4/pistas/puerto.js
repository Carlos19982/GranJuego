/* =========================================================================
   GRAN PREMIO NEÓN · Puerto Marina — trazado (sin three.js)
   Circuito urbano de hora azul alrededor de un puerto mediterráneo ficticio.
   Recta de meta junto al muelle (+x, agua al lado −z), subida al casino
   (+18 m), horquilla lenta alrededor de la fuente, bajada con dos ángulos
   rectos, túnel bajo el Hotel Miramar, chicane del muelle y dos curvas
   de 90° de vuelta al puerto. Vuelta ≈ 1,73 km, radio mínimo ≈ 19,5 m.
   Puntos [x, z, y] (y = altura en m), spline Catmull-Rom centrípeta cerrada.
   ========================================================================= */
export default {
  id: 'puerto', name: 'Puerto Marina', short: 'PUERTO',
  desc: 'Calles estrechas, horquilla y túnel junto al puerto: manda el agarre',
  favours: 'agarre',
  laps: 4,
  weatherOdds: { seco: 0.55, humedo: 0.35, viento: 0.10 },
  points: [
    [-120, 0, 0], [0, 0, 0], [120, 0, 0], [200, 0, 0.1],
    [225, 1, 0.2], [242, 7, 0.5], [249, 24, 1.2],
    [250, 60, 3], [256, 100, 6], [267, 140, 9], [271, 180, 12], [267, 215, 15], [262, 235, 16.2],
    [253, 256, 17.2], [232, 265, 17.8],
    [200, 268, 18], [160, 270, 18], [130, 276, 17.8], [100, 281, 17.4], [60, 283, 16.8], [20, 283, 16],
    [-10, 283, 15.5], [-30, 283, 15.2], [-44.85, 276.85, 15], [-51, 262, 14.8], [-44.85, 247.15, 14.6], [-30, 241, 14.4],
    [0, 241, 14], [40, 239.5, 13.5], [65, 238, 13],
    [80.5, 231.5, 12.8], [87, 216, 12.4],
    [88, 170, 9.5], [86, 145, 7.5],
    [79.5, 129.5, 6.5], [64, 123, 6],
    [30, 121, 5], [-20, 117, 4.5], [-70, 111, 4], [-110, 108, 3.6],
    [-125, 108, 3.4], [-135, 108, 3.2], [-141.2, 106.9, 3.1], [-146.6, 103.8, 3.05], [-150.6, 99, 3], [-154.6, 94.2, 2.95], [-160, 91.1, 2.9], [-166.2, 90, 2.8],
    [-185, 90, 2.6], [-210, 90, 2.3],
    [-235, 90, 2], [-252.7, 82.7, 1.8], [-260, 65, 1.5],
    [-260, 50, 1], [-260, 25, 0.6],
    [-252.7, 7.3, 0.2], [-235, 0, 0],
  ],
  halfWidth: 7.5,
  // por distancia aproximada desde la meta (vuelta ≈ 1734 m)
  widths: [
    { s0: 0, s1: 195, w: 8.2 },        // recta del puerto (parrilla)
    { s0: 1545, s1: 1740, w: 8.2 },
    { s0: 560, s1: 900, w: 6.5 },      // plaza del casino + horquilla de la fuente
    { s0: 900, s1: 1270, w: 7.0 },     // bajada + túnel
  ],
  runoff: 'asfalto',
  barrier: 'guardarrail',
  night: true,                       // hora azul: look nocturno de pista.js, neón atenuado (glowK)
  embankment: 'wall',
  landmarks: [
    { type: 'pits', x: -150, z: 0, x2: 150, z2: 0, side: -1, name: 'Boxes del Muelle' },
    { type: 'stand', x: -120, z: 0, x2: 150, z2: 0, side: 1, name: 'Tribuna del Puerto' },
    { type: 'tunnel', x: 50, z: 121, x2: -95, z2: 109, name: 'Túnel del Hotel Miramar' },
    { type: 'hairpin', x: -48, z: 262, name: 'Horquilla de la Fuente' },
    { type: 'chicane', x: -151, z: 99, name: 'Chicane del Muelle' },
    { type: 'custom', x: 160, z: 300, side: 1, name: 'Casino' },
  ],
  surface: { asphalt: '#2b2d36', kerbA: '#e3262f', kerbB: '#f4f1ea', line: '#ffffff', glow: '#ffbf5a', glowK: 0.5 },
};
