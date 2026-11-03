/* =========================================================================
   GRAN PREMIO NEÓN · comentarista.js
   «Pronóstico del comentarista»: dos o tres frases de retransmisión generadas
   a partir del mercado (favorito, sorpresa), del estado de los coches, del
   tiempo, del tipo de circuito frente a las virtudes de cada coche, de la
   parrilla y de las rachas. Sin cifras ni porcentajes. Determinista por semilla.

     pronostico({ circuit: { id, name, favours }, cars, grid, pWin, estado, notes,
                  weather, history, seed }) → { text, sentences, fav, pick }
   ========================================================================= */

function rng32(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, a) => a[Math.floor(r() * a.length) % a.length];
const lc = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const OPENINGS = {
  neon: {
    seco: ['Noche cerrada en {C} y asfalto seco: los neones ya iluminan la parrilla.', 'Cielo despejado sobre {C} y la ciudad entera pegada a las vallas: esto huele a carrera rápida.'],
    humedo: ['Llueve sobre {C} y el asfalto brilla como un espejo: hoy cada frenada cuenta.', 'Charcos de neón en {C}: con la pista mojada, el que no tenga agarre lo va a pasar mal.'],
    viento: ['Rachas de viento entre los rascacielos de {C}: cuidado al salir del túnel.', 'Sopla fuerte en {C} y las rectas se vuelven traicioneras: noche para pilotos fríos.'],
  },
  desierto: {
    seco: ['Sol rasante en el {C} y el asfalto ardiendo: las rectas eternas esperan.', 'Calor seco en el {C}, sin una nube: hoy manda el motor y los rebufos.'],
    humedo: ['Una rareza en el {C}: cae agua sobre la arena y la pista se vuelve imprevisible.', 'Llueve en pleno {C}, algo casi nunca visto: el agarre va a ser oro.'],
    viento: ['El viento levanta arena en el {C}: los rebufos van a ser una lotería.', 'Rachas de arena cruzan el {C}: en estas rectas, un golpe de aire cambia la carrera.'],
  },
  puerto: {
    seco: ['Hora azul en {C}, con los muelles llenos: entre estos muros no hay sitio para errores.', 'Brisa suave y pista seca en {C}: curvas lentas, muros cerca y cero margen.'],
    humedo: ['Llovizna sobre {C}: con el asfalto mojado junto al agua, el agarre lo es todo.', 'El puerto amanece mojado en {C}: cada salida de curva será una pequeña batalla.'],
    viento: ['Viento de mar en {C}: las grúas crujen y los coches bailan en la frenada.', 'Sopla el levante en {C}: en un trazado tan estrecho, cualquier racha asusta.'],
  },
};
const OPENING_ANY = ['Todo listo en {C}: luces encendidas y motores en ebullición.'];

const GRID_TXT = ['desde la pole', 'desde la primera fila', 'desde la segunda fila', 'desde la segunda fila', 'desde la última fila', 'desde la última fila'];

function formTxt(h) {
  if (!h || !h.length) return '';
  const last = h[h.length - 1], rec = h.slice(-3);
  const wins = rec.filter((p) => p === 1).length;
  if (last === 0) return 'aunque viene de abandonar';
  if (wins >= 2) return 'y llega lanzado tras varias victorias';
  if (last === 1) return 'y defiende la victoria de la última carrera';
  if (rec.length >= 3 && rec.every((p) => p >= 1 && p <= 3)) return 'y no se baja del podio últimamente';
  if (rec.length >= 3 && rec.every((p) => p === 0 || p >= 5)) return 'aunque arrastra una mala racha';
  return '';
}

export function pronostico(o) {
  const r = rng32(o.seed || 1);
  const cars = o.cars || [], n = cars.length;
  if (!n || !o.pWin) return { text: '', sentences: [] };
  const C = (o.circuit && o.circuit.name) || 'el circuito';
  const id = (o.circuit && o.circuit.id) || 'neon';
  const when = { neon: 'la noche', desierto: 'la tarde', puerto: 'la velada' }[id] || 'la jornada';
  const q = (t) => '«' + lc(t) + '»';
  const wx = o.weather || 'seco';
  const nm = (i) => 'el ' + cars[i].name;
  const est = o.estado || [];
  const notes = o.notes || [];
  const grid = o.grid || cars.map((_, i) => i);
  const slot = (i) => grid.indexOf(i);

  // 1) apertura: circuito + tiempo
  const pool = (OPENINGS[id] && OPENINGS[id][wx]) || OPENING_ANY;
  const s1 = pick(r, pool).replace('{C}', C);

  // 2) favorito (+ encaje con el trazado)
  const order = cars.map((_, i) => i).sort((a, b) => o.pWin[b] - o.pWin[a]);
  const fav = order[0];
  const fv = (o.circuit && o.circuit.favours) || 'equilibrado';
  const strength = (i) => (wx === 'humedo' ? cars[i].grip * 1.4 + cars[i].acc * 0.4 : fv === 'velocidad' ? cars[i].spd * 1.5 + cars[i].acc * 0.3 : fv === 'agarre' ? cars[i].grip + cars[i].acc : cars[i].spd + cars[i].acc + cars[i].grip);
  const best = cars.map((_, i) => i).sort((a, b) => strength(b) - strength(a))[0];
  const gs = GRID_TXT[Math.max(0, Math.min(GRID_TXT.length - 1, slot(fav)))];
  const ft = formTxt(o.history && o.history[fav]);
  const lead = pick(r, ['{F} parte como gran favorito {G}', 'Todas las miradas apuntan a {F}, que sale {G}', 'Las apuestas señalan a {F}, que arranca {G}']);
  let s2 = cap(lead.replace('{F}', nm(fav)).replace('{G}', gs));
  if (ft) s2 += ' ' + ft;
  if (best === fav) {
    s2 += pick(r, fv === 'velocidad' && wx !== 'humedo'
      ? [', y este trazado de pura velocidad le sienta de maravilla.', ', y en estas rectas su motor es un arma.']
      : fv === 'agarre' || wx === 'humedo'
        ? [', y aquí su agarre vale su peso en oro.', ', con el agarre justo que pide este asfalto.']
        : [', y es el coche más completo de la parrilla.', '.']);
  } else {
    const why = wx === 'humedo' ? 'con la pista mojada, el agarre de ' + nm(best) + ' puede darle la vuelta a todo'
      : fv === 'velocidad' ? 'en estas rectas la punta de ' + nm(best) + ' será un peligro constante'
        : fv === 'agarre' ? 'en este laberinto de curvas lentas ' + nm(best) + ' tiene el mejor agarre'
          : nm(best) + ' tiene el coche más completo';
    s2 += ', aunque ' + why + '.';
  }
  s2 = s2.replace(/\.\.$/, '.').replace(/ ,/g, ',');

  // 3) estado de los coches / sorpresa
  let s3 = '';
  const bad = notes.filter((q) => q && q.effect < 0 && q.car != null && q.car !== fav && cars[q.car]);
  const good = notes.filter((q) => q && q.effect > 0 && q.car != null && q.car !== fav && cars[q.car]);
  const favBad = notes.find((q) => q && q.effect < 0 && q.car === fav);
  if (favBad) {
    s3 = pick(r, ['Eso sí, en su box hablan de {N}, y eso puede pasarle factura.', 'Ojo, porque en su garaje reconocen {N}: cualquier problema y la carrera se abre.']).replace('{N}', q(favBad.text));
  } else if (bad.length && r() < 0.6) {
    const qn = bad[Math.floor(r() * bad.length)];
    s3 = pick(r, ['Preocupa {X}: en su box hablan de {N} y podría no ver la bandera a cuadros.', 'Cuidado con {X}, que arrastra {N}: tendrá que mimar la mecánica.']).replace('{X}', nm(qn.car)).replace('{N}', q(qn.text));
  } else {
    // sorpresa: cuota alta pero con un motivo
    const cands = order.slice(2).map((i) => {
      let w = 0;
      if (good.some((q) => q.car === i)) w += 2;
      if (i === best) w += 1.5;
      if (slot(i) <= 2) w += 1;
      const h = o.history && o.history[i];
      if (h && h.length && h[h.length - 1] >= 1 && h[h.length - 1] <= 2) w += 0.8;
      if ((est[i] || 1) > 0.9) w += 0.5;
      return { i, w: w + r() * 0.6 };
    }).sort((a, b) => b.w - a.w);
    const sp = cands.length ? cands[0].i : order[1];
    const g = good.find((q) => q.car === sp);
    if (g) s3 = pick(r, ['Atención a {X}: en su box presumen de {N} y llega con ganas de dar la sorpresa.', 'Y no pierdan de vista a {X}, con {N}: puede ser la sorpresa de {W}.']).replace('{X}', nm(sp)).replace('{N}', q(g.text)).replace('{W}', when);
    else if (sp === best) s3 = pick(r, ['La sorpresa puede venir de {X}: el trazado juega a su favor.', 'Ojo a {X}, al que este circuito le va como un guante.']).replace('{X}', nm(sp));
    else s3 = pick(r, ['El rival a batir será {R}, que no piensa regalar nada.', '{R} es la gran alternativa si el favorito falla.', 'Ojo a {R}: a poco que la carrera se complique, estará ahí.']).replace('{R}', nm(order[1]));
    s3 = cap(s3);
  }
  if (wx === 'humedo' && id === 'desierto') s3 = s3 || 'Nadie sabe cómo responderán los coches.';
  const sentences = [s1, s2, s3].filter(Boolean);
  const text = sentences.join(' ').replace(/\s+/g, ' ').replace(/\d/g, '').replace(/\b([Aa]) el /g, '$1l ').replace(/\b([Dd])e el /g, '$1el ').trim();
  return { text, sentences, fav, pick: best };
}
