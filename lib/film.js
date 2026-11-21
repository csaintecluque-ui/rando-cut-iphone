// Plan du film (où chaque passage tombe, fondus) et mixage du son. Code pur, sans navigateur : testé avec Node.

export const FORMATS = {
  paysage: { largeur: 1920, hauteur: 1080, nom: 'Paysage (télé)' },
  vertical: { largeur: 1080, hauteur: 1920, nom: 'Vertical (téléphone)' },
  carre: { largeur: 1080, hauteur: 1080, nom: 'Carré' },
};

export const FONDU_IMAGE_DEBUT = 0.4;   // le film sort du noir
export const FONDU_IMAGE_FIN = 1.0;     // et y retourne
export const FONDU_SON_DEBUT = 0.3;
export const FONDU_SON_FIN = 1.5;

/** Durée d'un passage dans le film : vidéo (ralentie ou accélérée selon `vitesse`), photo ou générique. */
export function longueur(p) {
  if (p.type === 'photo' || p.type === 'generique') return p.duree;
  return (p.fin - p.debut) / (p.vitesse || 1);
}

/**
 * Place les passages sur le film. `fondu` : durée d'un fondu enchaîné entre deux plans (0 = coupe franche).
 * Renvoie { morceaux: [{ ...passage, sortieDebut, sortieFin, fonduAvant, fonduApres }], duree }.
 */
export function construireFilm(passages, fondu = 0.5) {
  const morceaux = [];
  let fin = 0;
  passages.forEach((p, i) => {
    const d = longueur(p);
    const prec = morceaux[i - 1];
    const o = prec ? Math.max(0, Math.min(fondu, d / 3, longueur(prec) / 3)) : 0;
    const m = { ...p, sortieDebut: Math.max(0, fin - o), fonduAvant: o, fonduApres: 0 };
    m.sortieFin = m.sortieDebut + d;
    if (prec) prec.fonduApres = o;
    morceaux.push(m);
    fin = m.sortieFin;
  });
  return { morceaux, duree: fin };
}

/**
 * Images à poser à l'instant t du film, dans l'ordre de dessin : [{ morceau, tSource, progres, alpha }].
 * tSource : instant dans la vidéo (ralenti / accéléré compris) ; progres : avancement du plan (0 → 1).
 */
export function actifs(film, t) {
  const res = [];
  for (const m of film.morceaux) {
    if (t < m.sortieDebut || t >= m.sortieFin) continue;
    const dt = t - m.sortieDebut;
    const alpha = m.fonduAvant > 0 && dt < m.fonduAvant ? dt / m.fonduAvant : 1;
    const tSource = m.type === 'photo' || m.type === 'generique' ? dt : m.debut + dt * (m.vitesse || 1);
    res.push({ morceau: m, tSource, progres: dt / Math.max(1e-6, m.sortieFin - m.sortieDebut), alpha });
  }
  return res;
}

/** Le son de la caméra est gardé seulement pour les vidéos à vitesse normale. */
export function avecSonCamera(m) {
  return (m.type || 'video') === 'video' && (m.vitesse || 1) === 1;
}

/** Opacité du noir posé sur l'image (début et fin du film). */
export function noir(film, t) {
  if (t < FONDU_IMAGE_DEBUT) return 1 - t / FONDU_IMAGE_DEBUT;
  const reste = film.duree - t;
  if (reste < FONDU_IMAGE_FIN) return 1 - Math.max(0, reste) / FONDU_IMAGE_FIN;
  return 0;
}

/** Opacité du titre (apparaît après 0,5 s, reste 2,5 s, disparaît en 0,6 s). */
export function opaciteTitre(t, debut = 0.5, tenue = 2.5, fondu = 0.6) {
  if (t < debut || t > debut + tenue + 2 * fondu) return 0;
  if (t < debut + fondu) return (t - debut) / fondu;
  if (t > debut + fondu + tenue) return 1 - (t - debut - fondu - tenue) / fondu;
  return 1;
}

/** Instants (s) des images du film. */
export function instants(duree, ips) {
  const n = Math.max(1, Math.round(duree * ips));
  return Array.from({ length: n }, (_, k) => k / ips);
}

// ------------------------------------------------------------------ son

/** Rééchantillonne un canal (interpolation linéaire). */
export function reechantillonner(canal, de, vers) {
  if (de === vers) return canal;
  const n = Math.floor((canal.length * vers) / de);
  const res = new Float32Array(n);
  const r = de / vers;
  for (let i = 0; i < n; i++) {
    const x = i * r;
    const j = Math.floor(x);
    const f = x - j;
    const a = canal[j] ?? 0, b = canal[j + 1] ?? a;
    res[i] = a + f * (b - a);
  }
  return res;
}

/** Canaux quelconques → stéréo (mono dupliqué, plus de 2 canaux : les deux premiers). */
export function enStereo(canaux) {
  if (canaux.length >= 2) return [canaux[0], canaux[1]];
  return [canaux[0], canaux[0]];
}

/**
 * Mélange le son du film. Renvoie [gauche, droite] (Float32Array à `taux`).
 *  - morceaux : [{ sortieDebut, fonduAvant, fonduApres, canaux: [g, d] }] (son de chaque passage, à `taux`)
 *  - musique : { canaux: [g, d] } à `taux`, ou null (répétée si elle est plus courte que le film)
 *  - parle(t) : vrai quand quelqu'un parle (la musique baisse de `baisseDb`, en `rampe` secondes)
 */
export function mixer({ duree, taux = 48000, morceaux = [], musique = null, volumeCamera = 1, volumeMusique = 0.8,
  parle = () => false, baisseDb = -12, rampe = 0.4, normaliser = true }) {
  const n = Math.max(1, Math.round(duree * taux));
  const g = new Float32Array(n), d = new Float32Array(n);

  if (volumeCamera > 0) {
    for (const m of morceaux) {
      if (!m.canaux) continue;
      const [cg, cd] = m.canaux;
      const debut = Math.round(m.sortieDebut * taux);
      const nAvant = Math.round(m.fonduAvant * taux), nApres = Math.round(m.fonduApres * taux);
      const len = cg.length;
      for (let i = 0; i < len; i++) {
        const k = debut + i;
        if (k < 0 || k >= n) continue;
        let gain = volumeCamera;
        // fondu enchaîné à puissance constante (pas de creux de volume au milieu)
        if (i < nAvant) gain *= Math.sin((Math.PI / 2) * (i / nAvant));
        if (len - i <= nApres) gain *= Math.cos((Math.PI / 2) * (1 - (len - i) / nApres));
        g[k] += cg[i] * gain;
        d[k] += cd[i] * gain;
      }
    }
  }

  if (musique && musique.canaux && musique.canaux[0].length) {
    const [mg, md] = musique.canaux;
    const lm = mg.length;
    const bas = Math.pow(10, baisseDb / 20);
    const pas = Math.max(1, Math.round(taux / 100)); // décision toutes les 10 ms
    const vitesse = (1 - bas) / Math.max(1, rampe * 100);
    let niveau = parle(0) ? bas : 1;
    for (let k = 0; k < n; k += pas) {
      const cible = parle(k / taux) ? bas : 1;
      niveau = cible < niveau ? Math.max(cible, niveau - vitesse) : Math.min(cible, niveau + vitesse);
      const v = volumeMusique * niveau;
      for (let i = k; i < Math.min(n, k + pas); i++) {
        const j = i % lm;
        g[i] += mg[j] * v;
        d[i] += md[j] * v;
      }
    }
  }

  // fondus du début et de la fin
  const nDebut = Math.round(FONDU_SON_DEBUT * taux), nFin = Math.min(n, Math.round(FONDU_SON_FIN * taux));
  for (let i = 0; i < Math.min(n, nDebut); i++) { const f = i / nDebut; g[i] *= f; d[i] *= f; }
  for (let i = 0; i < nFin; i++) { const k = n - 1 - i; const f = i / nFin; g[k] *= f; d[k] *= f; }

  if (normaliser) {
    let carre = 0, crete = 0;
    for (let i = 0; i < n; i++) {
      carre += g[i] * g[i] + d[i] * d[i];
      crete = Math.max(crete, Math.abs(g[i]), Math.abs(d[i]));
    }
    const rms = Math.sqrt(carre / (2 * n));
    if (crete > 1e-4) {
      // viser un volume moyen de -18 dB, sans jamais dépasser -0,5 dB en crête
      let gain = Math.min(3, Math.max(0.5, Math.pow(10, -18 / 20) / Math.max(rms, 1e-6)));
      gain = Math.min(gain, 0.944 / crete);
      for (let i = 0; i < n; i++) { g[i] *= gain; d[i] *= gain; }
    }
  }
  return [g, d];
}

/**
 * Vrai quand quelqu'un parle à l'instant t du film (même règle que le PC : part de voix > 0,4 et volume
 * au-dessus du volume habituel de la vidéo). `mesures[i]` : mesures de la source i.
 */
export function fonctionParle(film, mesures) {
  const medianes = mesures.map((m) => {
    const s = [...((m && m.son_db) || [])].sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : 0;
  });
  return (t) => {
    const a = actifs(film, t);
    if (!a.length) return false;
    const { morceau, tSource } = a[a.length - 1];
    if (!avecSonCamera(morceau)) return false;
    const m = mesures[morceau.source];
    if (!m) return false;
    const s = Math.floor(tSource);
    return (m.voix[s] ?? 0) > 0.4 && (m.son_db[s] ?? -90) > medianes[morceau.source];
  };
}

/** Images par seconde du film : 25 si les vidéos sont filmées en 25/50/100 i/s (réglage européen), sinon 30. */
export function imagesParSeconde(ipsSources) {
  const premier = ipsSources.find((x) => x > 0);
  if (!premier) return 30;
  return [25, 50, 100, 200].some((x) => Math.abs(premier - x) < x * 0.03) ? 25 : 30;
}

/** Durée en texte : « 1 min 05 s », « 45 s ». */
export function dureeTexte(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')}`;
  if (m) return `${m} min ${String(sec).padStart(2, '0')} s`;
  return `${sec} s`;
}
