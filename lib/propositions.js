// Propositions d'ajouts au film (textes, infos de rando, effets, photos), présentées en liste à cocher avant la
// fabrication. Code pur, sans navigateur : testé avec Node.
//
// Une source (« entrée ») : { nom, duree, mesures, hilights, date (Date du début, heure universelle) | null,
//                             fuseau (minutes, réglé dans la GoPro) | null }

import { choisirPhotos, DUREE as DUREE_PHOTO } from './photos.js';
import { chiffres, km, metres } from './telemetrie.js';

export const LOOKS = ['Vif', 'Chaud', 'Cinéma', 'Froid', 'Rétro', 'Noir et blanc'];
export const DUREE_GENERIQUE = 4.5;
export const FIN_TITRE = 4.4;   // le titre du film disparaît vers 4,3 s (film.js, opaciteTitre)
const ACCELERE = { fenetre: 16, vitesse: 4, max: 2, marge: 2, dureeMin: 60 };
const pad = (n) => String(n).padStart(2, '0');
const majuscule = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Date et heure locales d'un instant (heure de la caméra si son fuseau est connu, sinon celle du téléphone). */
export function heureLocale(date, fuseau = null) {
  const utc = fuseau != null;
  const d = utc ? new Date(date.getTime() + fuseau * 60000) : date;
  const f = (o) => new Intl.DateTimeFormat('fr-FR', utc ? { ...o, timeZone: 'UTC' } : o).format(d);
  const [a, m, j, h, mi] = utc
    ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()]
    : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
  return {
    cle: `${a}-${pad(m)}-${pad(j)}`,
    annee: a,
    jour: f({ weekday: 'long', day: 'numeric', month: 'long' }),
    jourAnnee: f({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    jourMois: f({ day: 'numeric', month: 'long' }),
    heure: `${h} h ${pad(mi)}`,
  };
}

/** « samedi 21 novembre 2026 », ou « du 21 novembre au 23 novembre 2026 » sur plusieurs jours. */
export function periodeTexte(heures) {
  const liste = heures.filter(Boolean);
  if (!liste.length) return '';
  const premier = liste[0], dernier = liste[liste.length - 1];
  if (premier.cle === dernier.cle) return premier.jourAnnee;
  return `du ${premier.jourMois} au ${dernier.jourMois} ${dernier.annee}`;
}

/**
 * Passages « accélérés » : dans les vidéos longues (≥ 60 s), 16 s de chemin passées 4 fois plus vite, entre les
 * moments déjà choisis (2 s d'écart). On préfère un mouvement régulier (la marche) et des images utilisables.
 */
export function choisirAcceleres(entrees, passages, o = ACCELERE) {
  const res = [];
  const ordre = entrees.map((_, i) => i).filter((i) => entrees[i].duree >= o.dureeMin)
    .sort((a, b) => entrees[b].duree - entrees[a].duree);
  for (const i of ordre) {
    if (res.length >= o.max) break;
    const m = entrees[i].mesures;
    const n = Math.min(Math.floor(entrees[i].duree), m.lum.length);
    let meilleur = null;
    for (let d = 5; d + o.fenetre <= n - 5; d++) {
      const f = d + o.fenetre;
      if (passages.some((p) => p.source === i && f + o.marge > p.debut && d < p.fin + o.marge)) continue;
      let bons = 0, s = 0, s2 = 0;
      for (let k = d; k < f; k++) {
        if (m.lum[k] >= 30 && m.nettete[k] >= 5) bons++;
        s += m.nouveaute[k];
        s2 += m.nouveaute[k] ** 2;
      }
      if (bons < 0.9 * o.fenetre) continue;
      const moy = s / o.fenetre;
      const note = moy - Math.sqrt(Math.max(0, s2 / o.fenetre - moy * moy));
      if (!meilleur || note > meilleur.note) meilleur = { source: i, debut: d, fin: f, note };
    }
    if (meilleur) res.push({ ...meilleur, vitesse: o.vitesse, raison: 'Accéléré' });
  }
  return res.sort((a, b) => a.source - b.source || a.debut - b.debut);
}

/** Ambiance conseillée : chaude pour une journée sombre (soir, sous-bois), vive sinon. */
export function lookConseille(entrees) {
  const lum = entrees.flatMap((e) => Array.from(e.mesures.lum || [])).sort((a, b) => a - b);
  return lum.length && lum[lum.length >> 1] < 90 ? 'Chaud' : 'Vif';
}

/** Nombre de photos à glisser : environ une toutes les 18 s de film (au moins une). */
export function nombrePhotos(dureeVoulue, disponibles) {
  return Math.min(disponibles, Math.max(1, Math.round(dureeVoulue / 18)));
}

/**
 * La liste des propositions : [{ id, groupe, libelle, detail, actif, valeur?, choix?, donnees? }].
 * photos : [{ fichier, date }] ; gps : résultat de tracesParJour() ou null.
 */
export function proposer({ entrees, passages, photos = [], titre = '', gps = null, lookDispo = true, dureeVoulue = 60 }) {
  const props = [];
  const heures = entrees.map((e) => (e.date ? heureLocale(e.date, e.fuseau) : null));
  const premier = heures.find(Boolean);
  const jours = new Set(heures.filter(Boolean).map((h) => h.cle));
  const avecGps = !!(gps && gps.traces.length);

  const leTitre = titre || (premier ? majuscule(premier.jour) : '');
  if (leTitre) {
    props.push({ id: 'titre', groupe: 'Textes', libelle: `Titre au début : « ${leTitre} »`, valeur: leTitre, actif: true, auto: !titre,
      detail: titre ? 'Avec la date en dessous.' : 'Tu peux en écrire un autre dans « Titre » (étape 2).' });
  }
  if (premier) {
    props.push({ id: 'legendes', groupe: 'Textes', libelle: 'Date et heure des moments', actif: true,
      detail: `En bas de l'image, au début de chaque moment de la journée (ex. ${premier.heure}).` });
  }
  if (jours.size > 1) {
    props.push({ id: 'jours', groupe: 'Textes', libelle: `Titre de chaque journée (${jours.size} jours)`, actif: true,
      detail: '« Jour 2 — dimanche… » au début de chaque journée.' });
  }
  const c = chiffres(gps);
  props.push({ id: 'generique', groupe: 'Textes', libelle: 'Générique de fin', actif: true,
    detail: avecGps && c.distance > 200
      ? `Titre, date, ${km(c.distance)} et ${metres(c.denivele)} de dénivelé, sur fond noir.`
      : 'Titre et date, sur fond noir (4 s).' });

  if (avecGps) {
    props.push({ id: 'carte', groupe: 'Infos de rando', libelle: 'Carte du parcours', actif: true,
      detail: 'Dans un coin, avec un point qui avance avec la vidéo (dessinée sans internet).' });
    props.push({ id: 'profil', groupe: 'Infos de rando', libelle: "Profil d'altitude", actif: true,
      detail: 'En bas, avec la distance parcourue et l\'altitude.' });
  }

  const hl = passages.filter((p) => p.raison === 'HiLight').length;
  if (hl) {
    props.push({ id: 'ralenti', groupe: 'Effets', libelle: `Ralenti sur ${hl === 1 ? 'le HiLight' : `les ${hl} HiLight`}`, actif: true,
      detail: 'Les moments forts passent deux fois plus lentement.' });
  }
  const acc = choisirAcceleres(entrees, passages);
  if (acc.length) {
    props.push({ id: 'accelere', groupe: 'Effets', libelle: `Accéléré : ${acc.length} passage${acc.length > 1 ? 's' : ''} de chemin`, actif: true,
      detail: `${ACCELERE.fenetre} s de trajet en ${ACCELERE.fenetre / ACCELERE.vitesse} s, pour montrer la marche.`, donnees: acc });
  }
  if (lookDispo) {
    props.push({ id: 'ambiance', groupe: 'Effets', libelle: 'Ambiance de couleurs', actif: true, choix: LOOKS,
      valeur: lookConseille(entrees), detail: 'Appliquée aux vidéos et aux photos (pas aux textes).' });
  }

  if (photos.length) {
    const n = nombrePhotos(dureeVoulue, photos.length);
    let choisies = choisirPhotos(photos, n);
    if (!choisies.length) choisies = photos.slice(0, n); // photos sans date : à la fin du film
    props.push({ id: 'photos', groupe: 'Photos', libelle: `Glisser ${choisies.length} photo${choisies.length > 1 ? 's' : ''} dans le film`, actif: true,
      detail: `À leur heure dans la journée, avec un lent zoom (sur ${photos.length} choisie${photos.length > 1 ? 's' : ''}).`, donnees: choisies });
  }
  return props;
}

/** Glisse les photos parmi les passages, à leur heure. Heures incomplètes : les photos vont à la fin. */
export function insererPhotos(passages, photos, entrees) {
  const elements = photos.map((p, k) => ({ type: 'photo', fichier: p.fichier, date: p.date, duree: DUREE_PHOTO, raison: 'Photo', index: k }));
  const instant = (p) => (p.type === 'photo'
    ? (p.date ? p.date.getTime() : null)
    : (entrees[p.source] && entrees[p.source].date ? entrees[p.source].date.getTime() + p.debut * 1000 : null));
  const tous = [...passages.map((p) => [instant(p), 0, p]), ...elements.map((p) => [instant(p), 1, p])];
  if (tous.some(([h]) => h === null)) return [...passages, ...elements];
  tous.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return tous.map(([, , p]) => p);
}

/** Applique les propositions cochées : passages du film et options d'affichage. */
export function appliquer(props, { passages, entrees }) {
  const p = Object.fromEntries(props.filter((x) => x.actif).map((x) => [x.id, x]));
  let liste = passages.map((x) => ({ ...x, type: 'video', vitesse: 1 }));
  if (p.accelere) {
    liste = liste.concat(p.accelere.donnees.map((x) => ({ ...x, type: 'video' })))
      .sort((a, b) => a.source - b.source || a.debut - b.debut);
  }
  if (p.ralenti) for (const x of liste) if (x.raison === 'HiLight') x.vitesse = 0.5;
  if (p.photos) liste = insererPhotos(liste, p.photos.donnees, entrees);
  if (p.generique) liste.push({ type: 'generique', duree: DUREE_GENERIQUE, raison: 'Générique' });
  return {
    passages: liste,
    titre: p.titre ? p.titre.valeur : '',
    legendes: !!p.legendes,
    jours: !!p.jours,
    generique: !!p.generique,
    carte: !!p.carte,
    profil: !!p.profil,
    look: p.ambiance ? p.ambiance.valeur : null,
  };
}

/** Instant (Date) d'un morceau du film, ou null. */
function instantMorceau(m, entrees) {
  if (m.type === 'photo') return m.date ? { date: m.date, fuseau: null } : null;
  if (m.type === 'generique') return null;
  const e = entrees[m.source];
  return e && e.date ? { date: new Date(e.date.getTime() + m.debut * 1000), fuseau: e.fuseau } : null;
}

/**
 * Textes posés sur le film : légendes (date / heure) et titres des journées : { legendes, jours },
 * chacun [{ debut (s du film), texte }]. Nouvelle légende quand le jour change ou après 30 min d'écart.
 */
export function textesDuFilm(film, entrees, { legendes = false, jours = false, titre = false } = {}) {
  const res = { legendes: [], jours: [] };
  let jourPrec = null, dernier = null, numero = 0;
  for (const m of film.morceaux) {
    const i = instantMorceau(m, entrees);
    if (!i) continue;
    const h = heureLocale(i.date, i.fuseau);
    const nouveauJour = h.cle !== jourPrec;
    if (nouveauJour) numero++;
    // sous le titre du film, pas de « Jour 1 » (le titre donne déjà la date) et l'heure attend la fin du titre
    const ouverture = titre && jourPrec === null;
    const avecTitreJour = jours && nouveauJour && !ouverture;
    if (avecTitreJour) res.jours.push({ debut: m.sortieDebut + 0.3, texte: `Jour ${numero} — ${h.jour}` });
    if (legendes && (nouveauJour || i.date - dernier > 30 * 60000)) {
      const avecJour = nouveauJour && !jours && !ouverture;
      const debut = ouverture ? Math.max(m.sortieDebut + 0.2, FIN_TITRE) : m.sortieDebut + (avecTitreJour ? 3.2 : 0.2);
      res.legendes.push({ debut, texte: avecJour ? `${h.jour} · ${h.heure}` : h.heure });
      dernier = i.date;
    }
    jourPrec = h.cle;
  }
  return res;
}
