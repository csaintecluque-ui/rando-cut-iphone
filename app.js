// Rando Cut sur iPhone : choisir des vidéos, régler le film, monter. Tout se passe sur le téléphone.

import { regrouper, infosFichier } from './lib/gopro.js';
import { choisir, RYTHMES } from './lib/selection.js';
import { construireFilm, fonctionParle, imagesParSeconde, dureeTexte, FORMATS } from './lib/film.js';
import { manques, infosVideo, analyser, fabriquer } from './lib/media.js';

const $ = (id) => document.getElementById(id);

const etat = {
  fichiers: [],          // tous les fichiers choisis (vidéos et .LRV)
  prises: [],            // [{ nom, chapitres: [source], manquants }]
  musique: null,
  reglages: { duree: 60, format: 'paysage', rythme: 'normal', sonCamera: true },
  occupe: false,
  controle: null,
  resultat: null,        // { blob, url, nom }
};

const infosEnCache = new Map();    // clé du fichier → Promise<{ infos, gopro, vignette }>
const mesuresEnCache = new Map();  // clé du fichier → mesures
const cle = (f) => `${f.name}|${f.size}|${f.lastModified}`;

const AIDES = {
  format: { paysage: '16:9, pour la télé et l\'ordinateur.', vertical: '9:16, pour regarder sur un téléphone ou en story (le centre de l\'image est gardé).', carre: '1:1, pour Instagram.' },
  rythme: { calme: 'Plans d\'environ 6 s, fondus doux.', normal: 'Plans d\'environ 4 s, fondus doux.', rapide: 'Plans d\'environ 2,5 s, enchaînements vifs.' },
};

// ------------------------------------------------------------------ réglages

function chargerReglages() {
  try {
    Object.assign(etat.reglages, JSON.parse(localStorage.getItem('randocut-reglages') || '{}'));
  } catch { /* réglages par défaut */ }
}

function sauverReglages() {
  try { localStorage.setItem('randocut-reglages', JSON.stringify(etat.reglages)); } catch { /* tant pis */ }
}

function afficherReglages() {
  for (const groupe of document.querySelectorAll('.segments')) {
    const nom = groupe.dataset.reglage;
    for (const b of groupe.querySelectorAll('button')) {
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(b.dataset.valeur === String(etat.reglages[nom])));
    }
  }
  $('aide-format').textContent = AIDES.format[etat.reglages.format] || '';
  $('aide-rythme').textContent = AIDES.rythme[etat.reglages.rythme] || '';
  $('son-camera').checked = etat.reglages.sonCamera !== false;
}

for (const groupe of document.querySelectorAll('.segments')) {
  groupe.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || etat.occupe) return;
    const nom = groupe.dataset.reglage;
    etat.reglages[nom] = nom === 'duree' ? Number(b.dataset.valeur) : b.dataset.valeur;
    sauverReglages();
    afficherReglages();
    majBouton();
  });
}

$('son-camera').addEventListener('change', (e) => {
  etat.reglages.sonCamera = e.target.checked;
  sauverReglages();
});

// ------------------------------------------------------------------ vidéos

function definition(l, h) {
  const grand = Math.max(l, h);
  if (grand >= 5000) return '5,3K';
  if (grand >= 3800) return '4K';
  if (grand >= 2600) return '2,7K';
  if (grand >= 1900) return '1080p';
  if (grand >= 1200) return '720p';
  return `${l}×${h}`;
}

const formatDate = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const formatDateUTC = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Date de tournage en texte (heure de la caméra pour une GoPro, heure du téléphone sinon). */
function dateTexte(gopro) {
  if (!gopro || !gopro.date) return '';
  if (gopro.fuseau != null) return formatDateUTC.format(new Date(gopro.date.getTime() + gopro.fuseau * 60000));
  return formatDate.format(gopro.date);
}

function chargerInfos(source) {
  const k = cle(source.fichier);
  if (!infosEnCache.has(k)) {
    infosEnCache.set(k, (async () => {
      const gopro = await infosFichier(source.fichier);
      try {
        const infos = await infosVideo(source.fichier);
        return { infos, gopro, vignette: infos.vignette ? URL.createObjectURL(infos.vignette) : null };
      } catch (e) {
        return { infos: null, gopro, vignette: null, erreur: e.message || String(e) };
      }
    })());
  }
  return infosEnCache.get(k);
}

async function ajouterFichiers(liste) {
  const deja = new Set(etat.fichiers.map(cle));
  for (const f of liste) if (!deja.has(cle(f))) etat.fichiers.push(f);
  await regrouperEtAfficher();
}

async function regrouperEtAfficher() {
  const prises = regrouper(etat.fichiers).map((p) => ({
    nom: p.nom,
    manquants: p.manquants,
    chapitres: p.chapitres.map((f, i) => ({ fichier: f, leger: p.legers[i], charge: null })),
  }));
  etat.prises = prises;
  afficherListe();
  await Promise.all(prises.flatMap((p) => p.chapitres.map(async (s) => {
    s.charge = await chargerInfos(s);
  })));
  // dans l'ordre du tournage (date écrite dans la vidéo), sinon dans l'ordre des noms
  const quand = (p) => p.chapitres[0].charge?.gopro?.date?.getTime() ?? p.chapitres[0].fichier.lastModified;
  etat.prises.sort((a, b) => quand(a) - quand(b) || a.nom.localeCompare(b.nom));
  afficherListe();
}

function afficherListe() {
  const ul = $('liste');
  ul.replaceChildren();
  let total = 0, n = 0, lisibles = 0;
  for (const p of etat.prises) {
    const li = document.createElement('li');
    const charges = p.chapitres.map((s) => s.charge);
    const pret = charges.every(Boolean);
    const duree = charges.reduce((a, c) => a + (c?.infos?.duree || 0), 0);
    const premier = charges[0];

    const vignette = document.createElement('div');
    vignette.className = 'vignette';
    if (premier?.vignette) vignette.style.backgroundImage = `url("${premier.vignette}")`;
    if (pret && duree) {
      const d = document.createElement('span');
      d.className = 'duree';
      d.textContent = dureeTexte(duree);
      vignette.append(d);
    }

    const texte = document.createElement('div');
    const nom = document.createElement('div');
    nom.className = 'nom';
    nom.textContent = p.nom;
    const hl = charges.reduce((a, c) => a + (c?.gopro?.hilights.length || 0), 0);
    if (hl) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = `${hl} HiLight`;
      nom.append(b);
    }
    const infos = document.createElement('div');
    infos.className = 'infos';
    if (!pret) {
      infos.textContent = 'Lecture…';
    } else if (premier?.infos) {
      const bouts = [dateTexte(premier.gopro), definition(premier.infos.largeur, premier.infos.hauteur)];
      if (p.chapitres.length > 1) bouts.push(`${p.chapitres.length} morceaux recollés`);
      if (p.chapitres.some((s) => s.leger)) bouts.push('copie légère trouvée');
      infos.textContent = bouts.filter(Boolean).join(' · ');
    }
    texte.append(nom, infos);
    const soucis = [];
    if (p.manquants.length) soucis.push(`Morceau${p.manquants.length > 1 ? 'x' : ''} ${p.manquants.join(', ')} manquant${p.manquants.length > 1 ? 's' : ''}`);
    for (const c of charges) {
      if (c?.erreur) soucis.push(c.erreur);
      else if (c?.infos && !c.infos.decodable) soucis.push(`Format ${c.infos.codec} pas lisible sur cet appareil : ignorée`);
    }
    for (const s of soucis) {
      const a = document.createElement('div');
      a.className = 'attention';
      a.textContent = s;
      texte.append(a);
    }

    const retirer = document.createElement('button');
    retirer.type = 'button';
    retirer.className = 'retirer';
    retirer.textContent = '×';
    retirer.setAttribute('aria-label', `Retirer ${p.nom} de la liste (la vidéo n'est pas supprimée)`);
    retirer.disabled = etat.occupe;
    retirer.addEventListener('click', () => {
      const aRetirer = new Set(p.chapitres.flatMap((s) => [s.fichier, s.leger]).filter(Boolean));
      etat.fichiers = etat.fichiers.filter((f) => !aRetirer.has(f));
      etat.prises = etat.prises.filter((x) => x !== p);
      afficherListe();
    });

    li.append(vignette, texte, retirer);
    ul.append(li);
    if (pret) {
      total += duree;
      n++;
      lisibles += p.chapitres.filter((s) => s.charge?.infos?.decodable).length;
    }
  }
  $('resume-videos').textContent = n ? `${n} vidéo${n > 1 ? 's' : ''} · ${dureeTexte(total)} au total` : '';
  etat.lisibles = lisibles;
  majBouton();
}

$('choisir-videos').addEventListener('change', async (e) => {
  const liste = [...e.target.files];
  e.target.value = '';
  if (liste.length) await ajouterFichiers(liste);
});

// ------------------------------------------------------------------ musique

$('choisir-musique').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  etat.musique = f;
  $('nom-musique').textContent = f.name;
  $('retirer-musique').hidden = false;
});

$('retirer-musique').addEventListener('click', () => {
  etat.musique = null;
  $('nom-musique').textContent = 'Aucune';
  $('retirer-musique').hidden = true;
});

// ------------------------------------------------------------------ montage

function sourcesLisibles() {
  return etat.prises.flatMap((p) => p.chapitres).filter((s) => s.charge?.infos?.decodable);
}

function majBouton() {
  const b = $('monter');
  const n = sourcesLisibles().length;
  b.disabled = etat.occupe || !n || !!manques().length;
  b.textContent = `Faire le film (${dureeTexte(etat.reglages.duree)})`;
  $('aide-monter').textContent = n
    ? 'L\'appli choisit les meilleurs moments (HiLight, mouvement, voix, netteté), dans l\'ordre de la journée.'
    : 'Choisis d\'abord quelques vidéos.';
}

let debutPhase = 0;
function progres(titre, detail, fraction) {
  $('travail-titre').textContent = titre;
  $('travail-detail').textContent = detail;
  const f = Math.max(0, Math.min(1, fraction));
  $('travail-barre').style.width = `${(f * 100).toFixed(1)}%`;
  $('travail-pourcent').textContent = `${Math.floor(f * 100)} %`;
  const ecoule = (performance.now() - debutPhase) / 1000;
  $('travail-reste').textContent = f > 0.05 && ecoule > 5 ? `· encore environ ${dureeTexte((ecoule / f) * (1 - f))}` : '';
}

function nomDeFichier(texte) {
  return texte.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Rando Cut';
}

function occupe(oui) {
  etat.occupe = oui;
  $('travail').hidden = !oui;
  for (const id of ['etape-videos', 'etape-film', 'etape-monter']) $(id).toggleAttribute('inert', oui);
  majBouton();
  if (oui) $('travail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function monter() {
  const sources = sourcesLisibles();
  if (!sources.length || etat.occupe) return;
  liberDernierFilm();
  $('resultat').hidden = true;
  etat.controle = new AbortController();
  const signal = etat.controle.signal;
  occupe(true);
  let verrou = null;
  try {
    verrou = await navigator.wakeLock?.request('screen');
  } catch { /* l'écran pourra s'éteindre : on l'a dit à l'utilisateur */ }
  try {
    // 1. analyse (une seule fois par vidéo : refaire avec d'autres réglages est ensuite rapide)
    const aAnalyser = sources.filter((s) => !mesuresEnCache.has(cle(s.fichier)));
    debutPhase = performance.now();
    for (const [i, s] of aAnalyser.entries()) {
      const nom = s.fichier.name;
      const mesures = await analyser(s.leger || s.fichier, {
        signal,
        onProgres: (f) => progres('1/3 · Analyse des vidéos', `${nom} (${i + 1} sur ${aAnalyser.length})`, (i + f) / aAnalyser.length),
      });
      mesuresEnCache.set(cle(s.fichier), mesures);
    }

    // 2. choix des meilleurs moments
    progres('2/3 · Choix des meilleurs moments', '', 1);
    const mesures = sources.map((s) => mesuresEnCache.get(cle(s.fichier)));
    const entrees = sources.map((s, i) => ({
      duree: Math.min(s.charge.infos.duree, mesures[i].duree || s.charge.infos.duree),
      mesures: mesures[i],
      hilights: s.charge.gopro.hilights,
      sommet: null,
    }));
    const { passages, bonMetrage } = choisir(entrees, etat.reglages.duree, RYTHMES[etat.reglages.rythme] || 4);
    if (!passages.length) throw new Error('Pas assez de bons moments dans ces vidéos (trop courtes, trop sombres ou trop floues ?).');
    const film = construireFilm(passages, etat.reglages.rythme === 'rapide' ? 0.3 : 0.5);

    // 3. fabrication
    const titre = $('titre').value.trim();
    const date = dateTexte(sources[0].charge.gopro);
    debutPhase = performance.now();
    const ips = imagesParSeconde(sources.map((s) => s.charge.infos.ips));
    const blob = await fabriquer({
      sources, film, signal,
      reglages: { format: etat.reglages.format, ips, sonCamera: etat.reglages.sonCamera !== false, volumeMusique: 0.8 },
      musique: etat.musique,
      titre,
      sousTitre: titre ? date : '',
      parle: fonctionParle(film, mesures),
      onEtape: (e) => { if (e === 'image') debutPhase = performance.now(); },
      onProgres: (f) => progres('3/3 · Fabrication du film', `${dureeTexte(film.duree)} · ${FORMATS[etat.reglages.format].nom}`, f),
    });

    const nom = `${nomDeFichier(`Rando Cut - ${titre || date || 'film'}`)}.mp4`;
    etat.resultat = { blob, url: URL.createObjectURL(blob), nom };
    afficherResultat(film, sources, bonMetrage, ips);
  } catch (e) {
    if (e && e.name === 'AbortError') {
      $('aide-monter').textContent = 'Montage annulé.';
    } else {
      console.error(e);
      $('aide-monter').textContent = '';
      alert(`Le montage n'a pas pu se faire.\n\n${(e && e.message) || e}`);
    }
  } finally {
    try { await verrou?.release(); } catch { /* déjà libéré */ }
    etat.controle = null;
    occupe(false);
    if (etat.resultat) $('aide-monter').textContent = 'Tu peux changer les réglages et refaire : l\'analyse est gardée, ce sera plus rapide.';
  }
}

function liberDernierFilm() {
  if (etat.resultat) URL.revokeObjectURL(etat.resultat.url);
  etat.resultat = null;
  $('lecteur').removeAttribute('src');
  $('lecteur').load();
}

function minutes(s) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function afficherResultat(film, sources, bonMetrage, ips) {
  const { url, blob, nom } = etat.resultat;
  const f = FORMATS[etat.reglages.format];
  $('lecteur').src = url;
  $('telecharger').href = url;
  $('telecharger').download = nom;
  const mo = blob.size / 1e6;
  let infos = `${dureeTexte(film.duree)} · ${f.largeur}×${f.hauteur} · ${ips} images/s · ${mo < 10 ? mo.toFixed(1) : Math.round(mo)} Mo`;
  if (film.duree < etat.reglages.duree - 5) infos += ` · plus court que prévu : il n'y avait que ${dureeTexte(bonMetrage)} de bonnes images`;
  $('resultat-infos').textContent = infos;
  const ol = $('moments');
  ol.replaceChildren();
  for (const m of film.morceaux) {
    const li = document.createElement('li');
    li.textContent = `${sources[m.source].fichier.name} — de ${minutes(m.debut)} à ${minutes(m.fin)} (${m.raison})`;
    ol.append(li);
  }
  $('resultat').hidden = false;
  $('resultat').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('monter').addEventListener('click', monter);
$('annuler').addEventListener('click', () => etat.controle?.abort());
$('refaire').addEventListener('click', () => $('etape-film').scrollIntoView({ behavior: 'smooth', block: 'start' }));

$('partager').addEventListener('click', async () => {
  if (!etat.resultat) return;
  const fichier = new File([etat.resultat.blob], etat.resultat.nom, { type: 'video/mp4' });
  if (navigator.canShare && navigator.canShare({ files: [fichier] })) {
    try {
      await navigator.share({ files: [fichier] });
    } catch (e) {
      if (e.name !== 'AbortError') alert(`Le partage n'a pas marché : ${e.message}`);
    }
  } else {
    $('telecharger').click();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (etat.occupe) e.preventDefault();
});

// ------------------------------------------------------------------ démarrage

chargerReglages();
afficherReglages();
majBouton();

const manque = manques();
if (manque.length) {
  $('incompatible').hidden = false;
  $('incompatible-detail').textContent = `Il manque à ce navigateur : ${manque.join(', ')}.`;
}

const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
const installee = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
try {
  if (ios && !installee && !localStorage.getItem('randocut-astuce-vue')) $('installer').hidden = false;
} catch { /* pas de stockage */ }
$('installer-fermer').addEventListener('click', () => {
  $('installer').hidden = true;
  try { localStorage.setItem('randocut-astuce-vue', '1'); } catch { /* tant pis */ }
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// pour les tests automatiques (Chrome hors écran)
window.randoCut = { etat, ajouterFichiers, monter, mesuresEnCache };
