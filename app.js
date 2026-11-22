// Rando Cut sur iPhone : choisir des vidéos (et des photos), régler le film, voir les propositions, monter.
// Tout se passe sur le téléphone.

import { regrouper, infosFichier } from './lib/gopro.js';
import { choisir, RYTHMES } from './lib/selection.js';
import { construireFilm, fonctionParle, imagesParSeconde, dureeTexte, FORMATS } from './lib/film.js';
import { manques, infosVideo, analyser, fabriquer } from './lib/media.js';
import { estPhoto, datePhoto } from './lib/photos.js';
import { gpsFichier, tracesParJour, chiffres, km, metres } from './lib/telemetrie.js';
import { proposer, appliquer, textesDuFilm, heureLocale, periodeTexte } from './lib/propositions.js';
import { lookDisponible } from './lib/look.js';

const $ = (id) => document.getElementById(id);
const VERSION = 5;   // la même que dans sw.js
const montrer = (m) => (window.__montrer ? window.__montrer(m) : console.error(m));

const etat = {
  fichiers: [],          // vidéos choisies (et .LRV)
  photos: [],            // [{ fichier, date, url }]
  prises: [],            // [{ nom, chapitres: [source], manquants }]
  musique: null,
  reglages: { duree: 60, format: 'paysage', rythme: 'normal', sonCamera: true },
  occupe: false,
  controle: null,
  projet: null,          // entre le choix des moments et la fabrication : { sources, entrees, passages, ... }
  resultat: null,        // { blob, url, nom }
};

const infosEnCache = new Map();    // clé du fichier → Promise<{ infos, gopro, vignette }>
const mesuresEnCache = new Map();  // clé du fichier → mesures
const gpsEnCache = new Map();      // clé du fichier → piste GPS ou null
const cle = (f) => `${f.name}|${f.size}|${f.lastModified}`;

const AIDES = {
  format: { paysage: '16:9, pour la télé et l\'ordinateur.', vertical: '9:16, pour regarder sur un téléphone ou en story (le centre de l\'image est gardé).', carre: '1:1, pour Instagram.' },
  rythme: { calme: 'Plans d\'environ 6 s, fondus doux.', normal: 'Plans d\'environ 4 s, fondus doux.', rapide: 'Plans d\'environ 2,5 s, enchaînements vifs.' },
};

// ------------------------------------------------------------------ réglages

function lire(nom, defaut) {
  try { return JSON.parse(localStorage.getItem(nom) || 'null') ?? defaut; } catch { return defaut; }
}

function ecrire(nom, valeur) {
  try { localStorage.setItem(nom, JSON.stringify(valeur)); } catch { /* tant pis */ }
}

function afficherReglages() {
  for (const groupe of document.querySelectorAll('.segments[data-reglage]')) {
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

for (const groupe of document.querySelectorAll('.segments[data-reglage]')) {
  groupe.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || etat.occupe) return;
    const nom = groupe.dataset.reglage;
    etat.reglages[nom] = nom === 'duree' ? Number(b.dataset.valeur) : b.dataset.valeur;
    ecrire('randocut-reglages', etat.reglages);
    afficherReglages();
    majBouton();
  });
}

$('son-camera').addEventListener('change', (e) => {
  etat.reglages.sonCamera = e.target.checked;
  ecrire('randocut-reglages', etat.reglages);
});

// ------------------------------------------------------------------ vidéos et photos

function definition(l, h) {
  const grand = Math.max(l, h);
  if (grand >= 5000) return '5,3K';
  if (grand >= 3800) return '4K';
  if (grand >= 2600) return '2,7K';
  if (grand >= 1900) return '1080p';
  if (grand >= 1200) return '720p';
  return `${l}×${h}`;
}

/** Date de tournage en texte (heure de la caméra pour une GoPro, heure du téléphone sinon). */
function dateTexte(gopro) {
  if (!gopro || !gopro.date) return '';
  return heureLocale(gopro.date, gopro.fuseau).jourAnnee;
}

function chargerInfos(source) {
  const k = cle(source.fichier);
  if (!infosEnCache.has(k)) {
    infosEnCache.set(k, (async () => {
      const gopro = await infosFichier(source.fichier);
      try {
        const infos = await Promise.race([
          infosVideo(source.fichier),
          new Promise((_, non) => setTimeout(() => non(new Error('Lecture trop longue (plus de 60 s) : vidéo ignorée.')), 60000)),
        ]);
        return { infos, gopro, vignette: infos.vignette ? URL.createObjectURL(infos.vignette) : null };
      } catch (e) {
        return { infos: null, gopro, vignette: null, erreur: e.message || String(e) };
      }
    })());
  }
  return infosEnCache.get(k);
}

async function ajouterFichiers(liste) {
  const deja = new Set([...etat.fichiers, ...etat.photos.map((p) => p.fichier)].map(cle));
  const nouvelles = [];
  for (const f of liste) {
    if (deja.has(cle(f))) continue;
    if (estPhoto(f)) nouvelles.push(f);
    else etat.fichiers.push(f);
  }
  for (const f of nouvelles) etat.photos.push({ fichier: f, date: await datePhoto(f), url: URL.createObjectURL(f) });
  etat.photos.sort((a, b) => (a.date ?? Infinity) - (b.date ?? Infinity));
  afficherPhotos();
  await regrouperEtAfficher();
}

function afficherPhotos() {
  const zone = $('photos');
  zone.hidden = !etat.photos.length;
  const bande = $('photos-bande');
  bande.replaceChildren();
  for (const p of etat.photos.slice(0, 12)) {
    const img = document.createElement('img');
    img.src = p.url;
    img.alt = '';
    img.loading = 'lazy';
    bande.append(img);
  }
  const n = etat.photos.length, sansDate = etat.photos.filter((p) => !p.date).length;
  $('photos-resume').textContent = `${n} photo${n > 1 ? 's' : ''}${sansDate ? ` (dont ${sansDate} sans date)` : ''} : Rando Cut proposera d'en glisser quelques-unes dans le film.`;
}

$('retirer-photos').addEventListener('click', () => {
  for (const p of etat.photos) URL.revokeObjectURL(p.url);
  etat.photos = [];
  afficherPhotos();
});

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
  let total = 0, n = 0;
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
      if (c?.echec) soucis.push(`${c.echec} Vidéo laissée de côté.`);
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
    }
  }
  $('resume-videos').textContent = n ? `${n} vidéo${n > 1 ? 's' : ''} · ${dureeTexte(total)} au total` : '';
  majBouton();
}

async function recevoirVideos(e) {
  const liste = [...(e.target.files || [])];
  if (!liste.length) return;   // déjà traité (Safari envoie « input » puis « change »)
  e.target.value = '';
  const n = liste.length;
  $('etat-videos').textContent = `${n} fichier${n > 1 ? 's' : ''} reçu${n > 1 ? 's' : ''}, lecture en cours…`;
  try {
    await ajouterFichiers(liste);
    const rien = !etat.prises.length && !etat.photos.length;
    $('etat-videos').textContent = rien
      ? `Aucune vidéo reconnue parmi ${liste.map((f) => `${f.name} (${f.type || 'type inconnu'})`).join(', ')}.`
      : '';
  } catch (err) {
    $('etat-videos').textContent = '';
    montrer(`Ajout des vidéos : ${(err && err.message) || err}`);
  }
}
for (const evt of ['input', 'change']) $('choisir-videos').addEventListener(evt, recevoirVideos);

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
  return etat.prises.flatMap((p) => p.chapitres).filter((s) => s.charge?.infos?.decodable && !s.charge.echec);
}

function majBouton() {
  const b = $('monter');
  const n = sourcesLisibles().length;
  b.disabled = etat.occupe || !n || !!manques().length;
  b.textContent = `Faire le film (${dureeTexte(etat.reglages.duree)})`;
  $('aide-monter').textContent = n
    ? 'L\'appli choisit les meilleurs moments (HiLight, mouvement, voix, netteté), puis te propose des ajouts.'
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

/** Écran affiché : 'reglages', 'travail' (barre de progression) ou 'propositions'. */
function ecran(nom) {
  etat.occupe = nom !== 'reglages';
  $('travail').hidden = nom !== 'travail';
  $('propositions').hidden = nom !== 'propositions';
  for (const id of ['etape-videos', 'etape-film', 'etape-monter']) $(id).toggleAttribute('inert', etat.occupe);
  majBouton();
  if (nom !== 'reglages') $(nom).scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let verrou = null;
async function garderEcranAllume(oui) {
  try {
    if (oui && !verrou) verrou = await navigator.wakeLock?.request('screen');
    if (!oui && verrou) { await verrou.release(); verrou = null; }
  } catch { verrou = null; /* l'écran pourra s'éteindre : on l'a dit à l'utilisateur */ }
}

function erreurMontage(e) {
  if (e && e.name === 'AbortError') {
    $('aide-monter').textContent = 'Montage annulé.';
  } else {
    console.error(e);
    $('aide-monter').textContent = '';
    alert(`Le montage n'a pas pu se faire.\n\n${(e && e.message) || e}`);
  }
}

/** Étapes 1 et 2 : analyse (une seule fois par vidéo), GPS, choix des moments ; puis les propositions. */
async function monter() {
  // une vidéo écartée la fois d'avant est retentée (l'échec venait peut-être d'un manque de mémoire passager)
  for (const c of etat.prises.flatMap((x) => x.chapitres)) if (c.charge) delete c.charge.echec;
  let sources = sourcesLisibles();
  if (!sources.length || etat.occupe) return;
  libererDernierFilm();
  $('resultat').hidden = true;
  etat.controle = new AbortController();
  const signal = etat.controle.signal;
  ecran('travail');
  await garderEcranAllume(true);
  const debutAnalyse = performance.now();
  try {
    const aAnalyser = sources.filter((s) => !mesuresEnCache.has(cle(s.fichier)));
    debutPhase = performance.now();
    for (const [i, s] of aAnalyser.entries()) {
      const nom = s.fichier.name;
      try {
        const mesures = await analyser(s.leger || s.fichier, {
          signal,
          onProgres: (f) => progres('1/3 · Analyse des vidéos', `${nom} (${i + 1} sur ${aAnalyser.length})`, (i + f) / aAnalyser.length),
        });
        mesuresEnCache.set(cle(s.fichier), mesures);
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        // une vidéo illisible est laissée de côté (et signalée dans la liste) : les autres sont montées
        s.charge.echec = (e && e.message) || String(e);
        console.warn(e);
      }
    }
    afficherListe();
    sources = sources.filter((s) => !s.charge.echec);
    if (!sources.length) throw new Error('Aucune des vidéos n\'a pu être lue (voir la liste).');
    progres('1/3 · Analyse des vidéos', 'Lecture du GPS…', 1);
    for (const s of sources) {
      if (!gpsEnCache.has(cle(s.fichier))) gpsEnCache.set(cle(s.fichier), await gpsFichier(s.fichier));
    }

    progres('2/3 · Choix des meilleurs moments', '', 1);
    const mesures = sources.map((s) => mesuresEnCache.get(cle(s.fichier)));
    const entrees = sources.map((s, i) => ({
      nom: s.fichier.name,
      duree: Math.min(s.charge.infos.duree, mesures[i].duree || s.charge.infos.duree),
      mesures: mesures[i],
      hilights: s.charge.gopro.hilights,
      sommet: null,
      date: s.charge.gopro.date,
      fuseau: s.charge.gopro.fuseau,
    }));
    const { passages, bonMetrage } = choisir(entrees, etat.reglages.duree, RYTHMES[etat.reglages.rythme] || 4);
    if (!passages.length) throw new Error('Pas assez de bons moments dans ces vidéos (trop courtes, trop sombres ou trop floues ?).');
    const jours = entrees.map((e) => (e.date ? heureLocale(e.date, e.fuseau).cle : null));
    const gps = tracesParJour(sources.map((s) => gpsEnCache.get(cle(s.fichier))), jours);
    const propositions = proposer({
      entrees, passages, gps: gps.traces.length ? gps : null, photos: etat.photos, titre: $('titre').value.trim(),
      lookDispo: lookDisponible(), dureeVoulue: etat.reglages.duree,
    });
    // les choix de la dernière fois (cases décochées, ambiance) sont gardés
    const memoire = lire('randocut-propositions', {});
    for (const p of propositions) {
      if (memoire[p.id] !== undefined) p.actif = memoire[p.id];
      if (p.choix && p.choix.includes(memoire[`${p.id}-valeur`])) p.valeur = memoire[`${p.id}-valeur`];
    }
    const ecartees = etat.prises.flatMap((x) => x.chapitres).filter((x) => x.charge?.echec).length;
    etat.projet = { sources, entrees, mesures, passages, bonMetrage, gps, propositions, ecartees,
      dureeAnalyse: (performance.now() - debutAnalyse) / 1000 };
    afficherPropositions();
    ecran('propositions');
  } catch (e) {
    ecran('reglages');
    erreurMontage(e);
  } finally {
    etat.controle = null;
    await garderEcranAllume(false);
  }
}

function estimation() {
  const p = etat.projet;
  const choix = appliquer(p.propositions, { passages: p.passages, entrees: p.entrees });
  return construireFilm(choix.passages, etat.reglages.rythme === 'rapide' ? 0.3 : 0.5).duree;
}

function majResume() {
  const p = etat.projet;
  const n = new Set(p.passages.map((x) => x.source)).size;
  $('propositions-resume').textContent = `${p.passages.length} moments choisis dans ${n} vidéo${n > 1 ? 's' : ''}`
    + ` · film d'environ ${dureeTexte(estimation())}.`
    + (p.ecartees ? ` ${p.ecartees} vidéo${p.ecartees > 1 ? 's' : ''} illisible${p.ecartees > 1 ? 's' : ''} laissée${p.ecartees > 1 ? 's' : ''} de côté (voir la liste).` : '');
}

function memoriser() {
  const memoire = lire('randocut-propositions', {});
  for (const p of etat.projet.propositions) {
    memoire[p.id] = p.actif;
    if (p.choix) memoire[`${p.id}-valeur`] = p.valeur;
  }
  ecrire('randocut-propositions', memoire);
}

function afficherPropositions() {
  const zone = $('propositions-liste');
  zone.replaceChildren();
  let groupe = null;
  for (const p of etat.projet.propositions) {
    if (p.groupe !== groupe) {
      groupe = p.groupe;
      const h = document.createElement('h3');
      h.textContent = groupe;
      zone.append(h);
    }
    const bloc = document.createElement('div');
    bloc.className = 'proposition';
    const label = document.createElement('label');
    label.className = 'interrupteur';
    const caseACocher = document.createElement('input');
    caseACocher.type = 'checkbox';
    caseACocher.checked = p.actif;
    caseACocher.dataset.id = p.id;
    const texte = document.createElement('span');
    const titre = document.createElement('strong');
    titre.textContent = p.libelle;
    texte.append(titre);
    if (p.detail) {
      const d = document.createElement('small');
      d.textContent = p.detail;
      texte.append(d);
    }
    label.append(caseACocher, texte);
    bloc.append(label);
    let choix = null;
    if (p.choix) {
      choix = document.createElement('div');
      choix.className = 'segments choix';
      choix.dataset.id = p.id;
      for (const c of p.choix) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = c;
        b.dataset.valeur = c;
        b.setAttribute('aria-checked', String(c === p.valeur));
        b.addEventListener('click', () => {
          p.valeur = c;
          for (const x of choix.children) x.setAttribute('aria-checked', String(x === b));
          memoriser();
        });
        choix.append(b);
      }
      choix.hidden = !p.actif;
      bloc.append(choix);
    }
    caseACocher.addEventListener('change', () => {
      p.actif = caseACocher.checked;
      if (choix) choix.hidden = !p.actif;
      memoriser();
      majResume();
    });
    zone.append(bloc);
  }
  majResume();
}

/** Étape 3 : fabrication du film avec les propositions cochées. */
async function fabriquerLeFilm() {
  const p = etat.projet;
  if (!p) return;
  etat.controle = new AbortController();
  const signal = etat.controle.signal;
  ecran('travail');
  await garderEcranAllume(true);
  try {
    const choix = appliquer(p.propositions, { passages: p.passages, entrees: p.entrees });
    const film = construireFilm(choix.passages, etat.reglages.rythme === 'rapide' ? 0.3 : 0.5);
    const textes = textesDuFilm(film, p.entrees, { legendes: choix.legendes, jours: choix.jours, titre: !!choix.titre });
    const heures = film.morceaux.filter((m) => m.type === 'video' && p.entrees[m.source].date)
      .map((m) => heureLocale(p.entrees[m.source].date, p.entrees[m.source].fuseau));
    const periode = periodeTexte(heures);
    const c = chiffres(p.gps.traces.length ? p.gps : null);
    const titreFilm = (p.propositions.find((x) => x.id === 'titre') || {}).valeur || '';
    const generique = choix.generique ? [
      titreFilm,
      periode,
      c.distance > 200 ? `${km(c.distance)} · ${metres(c.denivele)} de dénivelé${c.haut != null ? ` · point haut ${metres(c.haut)}` : ''}` : '',
    ] : null;
    debutPhase = performance.now();
    const debutFabrication = performance.now();
    const problemes = [];
    const ips = imagesParSeconde(p.sources.map((s) => s.charge.infos.ips));
    const blob = await fabriquer({
      sources: p.sources, film, signal, problemes,
      reglages: { format: etat.reglages.format, ips, sonCamera: etat.reglages.sonCamera !== false, volumeMusique: 0.8 },
      musique: etat.musique,
      titre: choix.titre,
      sousTitre: choix.titre && heures.length && !(p.propositions.find((x) => x.id === 'titre') || {}).auto ? heures[0].jourAnnee : '',
      parle: fonctionParle(film, p.mesures),
      extras: {
        legendes: textes.legendes, jours: textes.jours, generique,
        gps: p.gps, carte: choix.carte, profil: choix.profil, look: choix.look,
      },
      onEtape: (e) => { if (e === 'image') debutPhase = performance.now(); },
      onProgres: (f) => progres('3/3 · Fabrication du film', `${dureeTexte(film.duree)} · ${FORMATS[etat.reglages.format].nom}`, f),
    });
    const nom = `${nomDeFichier(`Rando Cut - ${titreFilm || periode || 'film'}`)}.mp4`;
    etat.resultat = { blob, url: URL.createObjectURL(blob), nom, problemes,
      temps: { analyse: p.dureeAnalyse, fabrication: (performance.now() - debutFabrication) / 1000 } };
    ecran('reglages');
    afficherResultat(film, p.sources, p.bonMetrage, ips);
    $('aide-monter').textContent = 'Tu peux changer les réglages et refaire : l\'analyse est gardée, ce sera plus rapide.';
  } catch (e) {
    ecran('propositions');
    erreurMontage(e);
  } finally {
    etat.controle = null;
    await garderEcranAllume(false);
  }
}

function libererDernierFilm() {
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
  const { temps, problemes } = etat.resultat;
  if (temps) infos += `. Temps : analyse ${dureeTexte(temps.analyse)}, fabrication ${dureeTexte(temps.fabrication)}.`;
  if (problemes && problemes.length) {
    const liste = [...new Set(problemes)];
    infos += ` Attention : ${liste.length} plan${liste.length > 1 ? 's' : ''} mal lu${liste.length > 1 ? 's' : ''} (${liste.slice(0, 3).join(' ; ')}${liste.length > 3 ? '…' : ''}), image figée ou son coupé à cet endroit.`;
  }
  $('resultat-infos').textContent = infos;
  const ol = $('moments');
  ol.replaceChildren();
  for (const m of film.morceaux) {
    const li = document.createElement('li');
    if (m.type === 'photo') li.textContent = `Photo ${m.fichier.name}`;
    else if (m.type === 'generique') li.textContent = 'Générique de fin';
    else {
      const raison = m.vitesse > 1 ? `accéléré ×${m.vitesse}` : `${m.raison}${m.vitesse === 0.5 ? ', ralenti' : ''}`;
      li.textContent = `${sources[m.source].fichier.name} — de ${minutes(m.debut)} à ${minutes(m.fin)} (${raison})`;
    }
    ol.append(li);
  }
  $('resultat').hidden = false;
  $('resultat').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('monter').addEventListener('click', monter);
$('fabriquer').addEventListener('click', fabriquerLeFilm);
$('propositions-retour').addEventListener('click', () => {
  ecran('reglages');
  $('etape-film').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
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
  if (etat.occupe && !$('travail').hidden) e.preventDefault();
});

// ------------------------------------------------------------------ démarrage

Object.assign(etat.reglages, lire('randocut-reglages', {}));
afficherReglages();
majBouton();
$('version').textContent = `Version ${VERSION} · prête`;

// Thème : clair par défaut, sombre au choix (bouton en bas de page), gardé sur le téléphone
function majTheme() {
  const sombre = document.documentElement.dataset.theme === 'sombre';
  $('theme').textContent = sombre ? 'Thème clair' : 'Thème sombre';
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = sombre ? '#17130F' : '#FBF6EC';
}
$('theme').addEventListener('click', () => {
  const sombre = document.documentElement.dataset.theme !== 'sombre';
  document.documentElement.dataset.theme = sombre ? 'sombre' : 'clair';
  try { localStorage.setItem('randocut.theme', sombre ? 'sombre' : 'clair'); } catch { /* tant pis */ }
  majTheme();
});
majTheme();

const manque = manques();
if (manque.length) {
  $('incompatible').hidden = false;
  $('incompatible-detail').textContent = `Il manque à ce navigateur : ${manque.join(', ')}.`;
}

const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
const installee = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (ios && !installee && !lire('randocut-astuce-vue', false)) $('installer').hidden = false;
$('installer-fermer').addEventListener('click', () => {
  $('installer').hidden = true;
  ecrire('randocut-astuce-vue', true);
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// pour les tests automatiques (Chrome hors écran)
window.randoCut = { etat, ajouterFichiers, monter, fabriquerLeFilm, mesuresEnCache };
