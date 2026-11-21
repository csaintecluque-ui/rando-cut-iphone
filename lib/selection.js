// Choix des meilleurs passages : traduction fidèle de montage/selection.py (PC).
//
// 1. Chaque seconde est « utilisable » ou non (trop sombre, floue, secousse violente).
// 2. Les secondes utilisables reçoivent une note d'intérêt : changement d'image, voix, volume, netteté.
// 3. On découpe le bon métrage en zones égales dans l'ordre chronologique et on prend le meilleur passage de
//    chaque zone : le film raconte toute la journée dans l'ordre. Les HiLight sont toujours gardés.
//
// Une source : { duree, mesures: { lum, nettete, nouveaute, son_db, voix, secousse?, visages? },
//                hilights: [s], sommet: s|null }

export const SEUIL_SOMBRE = 45;
export const SEUIL_FLOU = 15;
export const SEUIL_SECOUSSE = 3.0;
export const PAS = 0.5;
export const VOISINAGE = 20.0;

export const RYTHMES = { calme: 6.0, normal: 4.0, rapide: 2.5 };

function mediane(a) {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function ecartType(a) {
  if (!a.length) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
}

/** Écart à la médiane, en « nombre d'écarts typiques », borné. */
export function robuste(x, masque) {
  let ref = x.filter((_, i) => masque[i]);
  if (!ref.length) ref = x;
  const med = mediane(ref);
  const mad = mediane(ref.map((v) => Math.abs(v - med))) * 1.4826 || ecartType(ref) || 1.0;
  return x.map((v) => Math.min(3, Math.max(-2, (v - med) / mad)));
}

const NOMS = ['mouvement', 'voix', 'son', 'netteté', 'visages'];

/** Pour chaque source : { ok, note, raisons, calme } par seconde. */
function notes(sources) {
  const col = (nom) => sources.map((s) => Array.from(s.mesures[nom] || []));
  const lum = col('lum'), net = col('nettete'), nouv = col('nouveaute'), db = col('son_db'), voix = col('voix');
  const sec = sources.map((s, i) => (s.mesures.secousse && s.mesures.secousse.length
    ? Array.from(s.mesures.secousse) : new Array(lum[i].length).fill(0)));
  const vis = sources.map((s, i) => ((s.mesures.visages || []).length === lum[i].length
    ? Array.from(s.mesures.visages) : new Array(lum[i].length).fill(0)));
  const tout = (liste) => liste.flat();
  const lumT = tout(lum), netT = tout(net);
  // seuils relatifs à la journée : un soir ou un jour de brouillard n'est plus rejeté en entier
  const lumMed = lumT.length ? mediane(lumT) : 128;
  const netMed = netT.length ? mediane(netT) : 50;
  const seuilSombre = Math.min(SEUIL_SOMBRE, Math.max(12, 0.5 * lumMed));
  const seuilFlou = Math.min(SEUIL_FLOU, Math.max(3, 0.3 * netMed));
  const ok = lum.map((l, i) => l.map((v, k) => v >= seuilSombre && net[i][k] >= seuilFlou && sec[i][k] <= SEUIL_SECOUSSE));

  const masque = tout(ok);
  const voixT = tout(voix), dbT = tout(db), secT = tout(sec), visT = tout(vis);
  const zNouv = robuste(tout(nouv), masque);
  const zVoix = robuste(voixT, masque);
  const zDb = robuste(dbT, masque);
  const zNet = robuste(netT, masque);
  const n = masque.length;
  const comp = [new Array(n), new Array(n), new Array(n), new Array(n), new Array(n)];
  const note = new Array(n), raisons = new Array(n), calme = new Array(n);
  for (let k = 0; k < n; k++) {
    const parle = voixT[k] > 0.4 && zDb[k] > 0 ? 1 : 0;
    comp[0][k] = 1.0 * zNouv[k];
    comp[1][k] = 0.8 * zVoix[k] * parle;
    comp[2][k] = 0.5 * zDb[k];
    comp[3][k] = 0.3 * zNet[k];
    comp[4][k] = 0.7 * Math.min(visT[k], 2.0);
    note[k] = comp[0][k] + comp[1][k] + comp[2][k] + comp[3][k] + comp[4][k] - 0.5 * Math.max(0, secT[k] - 1.5);
    let best = 0;
    for (let c = 1; c < 5; c++) if (comp[c][k] > comp[best][k]) best = c;
    raisons[k] = NOMS[best];
    calme[k] = Math.max(0, 1.5 - secT[k]) * (secT[k] > 0 ? 1 : 0);
  }
  const res = [];
  let i = 0;
  for (const o of ok) {
    const m = o.length;
    res.push({ ok: o, note: note.slice(i, i + m), raisons: raisons.slice(i, i + m), calme: calme.slice(i, i + m) });
    i += m;
  }
  return res;
}

const demi = (x) => x.flatMap((v) => [v, v]);

/** n éléments pris régulièrement dans la liste (en gardant l'ordre). */
export function repartir(elements, n) {
  if (n >= elements.length) return [...elements];
  if (n <= 0) return [];
  const res = [];
  for (let k = 0; k < n; k++) res.push(elements[Math.floor(((k + 0.5) * elements.length) / n)]);
  return res;
}

/** a // b comme en Python (flottants) : Math.floor(a / b) se trompe quand a / b tombe presque sur un entier. */
export function divEntiere(a, b) {
  let mod = a % b;
  let div = (a - mod) / b;
  if (mod && (b < 0) !== (mod < 0)) {
    mod += b;
    div -= 1;
  }
  if (!div) return 0;
  let r = Math.floor(div);
  if (div - r > 0.5) r += 1;
  return r;
}

function mode(liste) {
  const compte = new Map();
  for (const r of liste) compte.set(r, (compte.get(r) || 0) + 1);
  let best = liste[0], n = 0;
  for (const [r, c] of compte) if (c > n) { best = r; n = c; }
  return best;
}

/**
 * Renvoie { passages, bonMetrage } : passages choisis dans l'ordre ({ source, debut, fin, note, raison }),
 * et secondes de bon métrage disponibles.
 */
export function choisir(sources, dureeVoulue, plan = 4.0) {
  const nts = notes(sources);
  plan = Math.max(PAS * 2, Math.round(plan / PAS) * PAS);
  const longueur = Math.round(plan / PAS);

  // Fenêtres candidates : `plan` secondes, toutes utilisables
  const candidats = []; // [position, source, début, fin, note, raison, calme]
  let pos = 0;
  sources.forEach((src, idx) => {
    const { ok, note, raisons, calme } = nts[idx];
    const okSec = ok.reduce((a, v) => a + (v ? 1 : 0), 0);
    const ok2 = demi(ok), note2 = demi(note), raisons2 = demi(raisons), calme2 = demi(calme);
    const n = Math.min(ok2.length, Math.floor(src.duree / PAS));
    const lg = Math.min(longueur, n);
    if (lg * PAS < 2) { pos += okSec; return; }
    const avant = [0];
    for (const v of ok2) avant.push(avant[avant.length - 1] + (v ? PAS : 0));
    let mauvais = 0; // nombre de demi-secondes inutilisables dans la fenêtre
    for (let k = 0; k < lg; k++) if (!ok2[k]) mauvais++;
    for (let d = 0; d <= n - lg; d++) {
      if (d > 0) {
        if (!ok2[d - 1]) mauvais--;
        if (!ok2[d + lg - 1]) mauvais++;
      }
      if (mauvais === 0) {
        let s = 0, c = 0;
        for (let k = d; k < d + lg; k++) { s += note2[k]; c += calme2[k]; }
        candidats.push([pos + avant[d], idx, d * PAS, (d + lg) * PAS, s / lg, mode(raisons2.slice(d, d + lg)), c / lg]);
      }
    }
    pos += okSec;
  });

  const bonMetrage = nts.reduce((a, n) => a + n.ok.reduce((x, v) => x + (v ? 1 : 0), 0), 0);
  const choisis = []; // [source, début, fin, note, raison]
  const libre = (idx, d, f) => choisis.every(([i, d2, f2]) => i !== idx || f <= d2 || d >= f2);
  const loin = (idx, d, f) => choisis.every(([i, d2, f2]) => i !== idx || f + VOISINAGE <= d2 || d >= f2 + VOISINAGE);
  const total = () => choisis.reduce((a, c) => a + (c[2] - c[1]), 0);

  // HiLight : gardés en priorité (3 s avant le marqueur, 1 s après), dans la durée demandée
  const marqueurs = [];
  sources.forEach((src, idx) => {
    for (const t of [...src.hilights].sort((a, b) => a - b)) {
      const d = Math.max(0, t - 3), f = Math.min(src.duree, t + 1);
      if (f - d > 0.5 && marqueurs.every(([i, d2, f2]) => i !== idx || f <= d2 || d >= f2)) marqueurs.push([idx, d, f]);
    }
  });
  const place = marqueurs.length ? divEntiere(dureeVoulue, 4.0) : 0;
  for (const [idx, d, f] of repartir(marqueurs, marqueurs.length ? Math.max(1, place) : 0)) {
    if (libre(idx, d, f)) choisis.push([idx, d, f, 99.0, 'HiLight']);
  }
  // le point le plus haut de la journée (GPS) : un moment fort, comme un HiLight
  sources.forEach((src, idx) => {
    if (src.sommet != null) {
      const d = Math.max(0, src.sommet - plan / 2), f = Math.min(src.duree, src.sommet + plan / 2);
      if (f - d > 1.0 && libre(idx, d, f)) choisis.push([idx, d, f, 98.0, 'Sommet']);
    }
  });

  const nVoulu = Math.max(1, Math.round(dureeVoulue / plan));
  const reste = nVoulu - choisis.length;
  if (reste > 0 && candidats.length && total() < dureeVoulue) {
    const tot = Math.max(...candidats.map((c) => c[0])) + 1;
    const tailleZone = tot / reste;
    const parZone = new Map();
    for (const c of candidats) {
      const z = divEntiere(c[0], tailleZone);
      if (!parZone.has(z)) parZone.set(z, []);
      parZone.get(z).push(c);
    }
    const zones = [...parZone.keys()].sort((a, b) => a - b);
    for (const zone of zones) {
      if (total() >= dureeVoulue) break;
      // récit : le film s'ouvre et se termine sur des plans calmes et stables
      const bords = zone === zones[0] || zone === zones[zones.length - 1];
      const tries = [...parZone.get(zone)].sort((a, b) => -(a[4] + (bords ? 1.5 * a[6] : 0)) + (b[4] + (bords ? 1.5 * b[6] : 0)));
      for (const [, idx, d, f, note, raison] of tries) {
        if (libre(idx, d, f) && loin(idx, d, f)) { choisis.push([idx, d, f, note, raison]); break; }
      }
    }
    const parNote = [...candidats].sort((a, b) => b[4] - a[4]);
    for (const condition of [loin, () => true]) {
      for (const [, idx, d, f, note, raison] of parNote) {
        if (total() >= dureeVoulue) break;
        if (libre(idx, d, f) && condition(idx, d, f)) choisis.push([idx, d, f, note, raison]);
      }
    }
  }

  // Ordre chronologique, puis on fusionne les passages presque collés (sans dépasser 2 fois le rythme)
  choisis.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const passages = [];
  for (const [idx, d, f, note, raison] of choisis) {
    const p = passages[passages.length - 1];
    if (p && p.source === idx && d - p.fin <= 2.0 && Math.max(p.fin, f) - p.debut <= 2 * plan) {
      p.fin = Math.max(p.fin, f);
      p.note = Math.max(p.note, note);
    } else {
      passages.push({ source: idx, debut: d, fin: f, note, raison });
    }
  }
  // rythme : premier et dernier plans un peu plus longs, dans la limite de la durée demandée
  const duree = (p) => p.fin - p.debut;
  for (const k of passages.length > 2 ? [0, passages.length - 1] : []) {
    const p = passages[k];
    const allonge = Math.min(plan / 2, Math.max(0, dureeVoulue + plan / 2 - passages.reduce((a, q) => a + duree(q), 0)));
    if (p.raison === 'HiLight' || p.raison === 'Sommet' || allonge < 0.5) continue;
    const voisins = passages.filter((q) => q !== p && q.source === p.source);
    if (k === 0) {
      const debut = Math.max(0, p.debut - allonge);
      if (voisins.every((q) => q.fin <= debut || q.debut >= p.fin)) p.debut = debut;
    } else {
      const fin = Math.min(sources[p.source].duree, p.fin + allonge);
      if (voisins.every((q) => q.debut >= fin || q.fin <= p.debut)) p.fin = fin;
    }
  }
  return { passages, bonMetrage };
}
