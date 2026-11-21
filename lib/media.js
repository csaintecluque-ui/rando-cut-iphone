// Tout ce qui lit ou écrit de la vidéo, dans le navigateur (Safari sur iPhone) : WebCodecs via Mediabunny.
// Les vidéos sont lues sur le téléphone et ne sont jamais modifiées ; rien n'est envoyé sur internet.

import * as MB from '../vendor/mediabunny.js';
import { L, H, enGris, statsImage, nouveaute, parSeconde, mesuresSon, Reechantillonneur } from './mesures.js';
import { actifs, noir, opaciteTitre, instants, mixer, enStereo, reechantillonner, avecSonCamera, FORMATS } from './film.js';
import { rectangle } from './photos.js';
import { position } from './telemetrie.js';
import { creerLook } from './look.js';
import {
  opacite, dessinerLegende, dessinerJour, preparerCarte, dessinerCarte, cadreProfil, dessinerProfil, dessinerGenerique, MARGE_Y,
} from './dessins.js';

export const TAUX = 48000;

/** Ce qui manque à ce navigateur pour monter (liste vide = tout va bien). */
export function manques() {
  const m = [];
  for (const nom of ['VideoDecoder', 'VideoEncoder', 'AudioDecoder', 'AudioEncoder', 'OffscreenCanvas', 'AudioBuffer']) {
    if (typeof globalThis[nom] === 'undefined') m.push(nom);
  }
  return m;
}

function arret(signal) {
  if (signal && signal.aborted) throw new DOMException('Montage annulé', 'AbortError');
}

/** Ouvre une vidéo (lecture seule). */
export async function ouvrir(fichier) {
  const input = new MB.Input({ source: new MB.BlobSource(fichier), formats: MB.ALL_FORMATS });
  let video;
  try {
    video = await input.getPrimaryVideoTrack();
  } catch {
    video = null;
  }
  if (!video) {
    input.dispose();
    throw new Error(`« ${fichier.name} » n'est pas une vidéo lisible.`);
  }
  const audio = await input.getPrimaryAudioTrack().catch(() => null);
  const t0 = Math.max(0, await input.getFirstTimestamp().catch(() => 0));
  const fin = await input.computeDuration();
  return { input, video, audio, t0, duree: Math.max(0, fin - t0) };
}

async function versBlob(canvas, type = 'image/jpeg', qualite = 0.75) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality: qualite });
  return new Promise((ok) => canvas.toBlob(ok, type, qualite));
}

/** Infos d'une vidéo pour la liste : durée, taille, images/s, décodable, vignette (Blob JPEG). */
export async function infosVideo(fichier) {
  const v = await ouvrir(fichier);
  try {
    const decodable = await v.video.canDecode().catch(() => false);
    const stats = await v.video.computePacketStats(90).catch(() => null);
    let vignette = null;
    if (decodable) {
      try {
        const sink = new MB.CanvasSink(v.video, { width: 192, height: 108, fit: 'cover' });
        const c = await sink.getCanvas(v.t0 + Math.min(1, v.duree / 2));
        if (c) vignette = await versBlob(c.canvas);
      } catch { /* pas de vignette : tant pis */ }
    }
    return {
      duree: v.duree,
      largeur: await v.video.getDisplayWidth(),
      hauteur: await v.video.getDisplayHeight(),
      ips: stats ? stats.averagePacketRate : 30,
      codec: v.video.codec || '?',
      decodable,
      son: !!v.audio && (await v.audio.canDecode().catch(() => false)),
      vignette,
    };
  } finally {
    v.input.dispose();
  }
}

/** Attend que le décodeur ait de la place (pour ne pas remplir la mémoire). */
async function place(decodeur, max = 4) {
  while (decodeur.decodeQueueSize > max) await new Promise((ok) => setTimeout(ok, 4));
}

/**
 * Les secondes trop loin de toute image lue (fin d'un fichier abîmé, trou au milieu) deviennent « noires » :
 * le choix des moments ne les prendra pas, au lieu de deviner ce qu'il y a dedans.
 */
export function secondesIlisibles(lum, temps) {
  if (!temps.length) return lum.map(() => 0);
  const ecarts = temps.slice(1).map((t, i) => t - temps[i]).sort((a, b) => a - b);
  const seuil = Math.max(5, 3 * (ecarts.length ? ecarts[ecarts.length >> 1] : 1));
  let j = 0;
  return lum.map((v, s) => {
    const t = s + 0.5;
    while (j < temps.length - 1 && temps[j + 1] <= t) j++;
    const proche = Math.min(Math.abs(t - temps[j]), j + 1 < temps.length ? Math.abs(temps[j + 1] - t) : Infinity);
    return proche > seuil / 2 ? 0 : v;
  });
}

/** Images clés seulement (rapide, même en 5,3K), au plus une par seconde : [{ t, lum, nettete, petit }]. */
async function vuesImagesCles(v, ctx, { onProgres, signal }) {
  const vues = [];
  let erreur = null;
  const decodeur = new VideoDecoder({
    output: (image) => {
      try {
        ctx.drawImage(image, 0, 0, L, H);
        vues.push({ t: image.timestamp / 1e6 - v.t0, ...statsImage(enGris(ctx.getImageData(0, 0, L, H).data)) });
      } catch (e) {
        erreur = e;
      } finally {
        image.close();
      }
    },
    error: (e) => { erreur = e; },
  });
  try {
    decodeur.configure(await v.video.getDecoderConfig());
    const paquets = new MB.EncodedPacketSink(v.video);
    let p = await paquets.getFirstKeyPacket();
    while (p) {
      arret(signal);
      if (erreur) throw erreur;
      decodeur.decode(p.toEncodedVideoChunk());
      await place(decodeur);
      onProgres(Math.min(1, (p.timestamp - v.t0) / Math.max(1, v.duree)));
      let suivant = await paquets.getKeyPacket(p.timestamp + 1.0);
      if (!suivant || suivant.timestamp <= p.timestamp) suivant = await paquets.getNextKeyPacket(p);
      p = suivant;
    }
    await decodeur.flush();
    if (erreur) throw erreur;
    return vues;
  } catch (e) {
    e.vues = vues; // ce qui a pu être lu avant l'erreur
    throw e;
  } finally {
    if (decodeur.state !== 'closed') decodeur.close();
  }
}

/** Plan B (plus lent mais plus sûr) : une image par seconde, décodée normalement et réduite tout de suite. */
async function vuesUneParSeconde(v, ctx, { onProgres, signal }) {
  const vues = [];
  const sink = new MB.CanvasSink(v.video, { width: L, height: H, fit: 'fill', poolSize: 1 });
  const instants = Array.from({ length: Math.max(1, Math.floor(v.duree)) }, (_, s) => v.t0 + s + 0.5);
  for await (const c of sink.canvasesAtTimestamps(instants)) {
    arret(signal);
    if (!c) continue;
    ctx.drawImage(c.canvas, 0, 0, L, H);
    vues.push({ t: c.timestamp - v.t0, ...statsImage(enGris(ctx.getImageData(0, 0, L, H).data)) });
    onProgres(Math.min(1, vues.length / instants.length));
  }
  return vues;
}

/**
 * Mesures seconde par seconde d'une vidéo (comme l'analyse du PC) : images clés réduites à 256×144
 * (au plus une par seconde) et son ramené à 16 kHz. onProgres(0 → 1).
 * Si le décodeur lâche, on essaie une autre façon de lire ; si le son ne se lit pas, la vidéo est gardée sans
 * mesure du son. Les erreurs nomment le fichier.
 */
export async function analyser(fichier, { onProgres = () => {}, signal } = {}) {
  const v = await ouvrir(fichier);
  try {
    if (!(await v.video.canDecode())) throw new Error(`« ${fichier.name} » : ce format vidéo n'est pas lisible sur cet appareil.`);
    const nSec = Math.max(1, Math.floor(v.duree));
    const avecSon = !!v.audio && (await v.audio.canDecode().catch(() => false));
    const partImage = avecSon ? 0.8 : 1;

    const ctx = new OffscreenCanvas(L, H).getContext('2d', { willReadFrequently: true });
    let vues;
    try {
      vues = await vuesImagesCles(v, ctx, { signal, onProgres: (f) => onProgres(partImage * f) });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      console.warn(`${fichier.name} : images clés illisibles (${e && e.message}), autre méthode`);
      try {
        vues = await vuesUneParSeconde(v, ctx, { signal, onProgres: (f) => onProgres(partImage * f) });
      } catch (e2) {
        if (e2 && e2.name === 'AbortError') throw e2;
        vues = e.vues || [];
        if (vues.length < Math.max(2, nSec / 4)) {
          throw new Error(`« ${fichier.name} » : la vidéo n'a pas pu être lue (${(e2 && e2.message) || e2}).`);
        }
      }
    }
    vues.sort((a, b) => a.t - b.t);
    const temps = vues.map((x) => x.t);
    const nouv = vues.map((x, i) => nouveaute(i ? vues[i - 1].petit : null, x.petit));

    // --- son (s'il ne se lit pas, la vidéo est gardée, sans mesure du son)
    let son = { db: new Array(nSec).fill(-90), voix: new Array(nSec).fill(0) };
    if (avecSon) {
      try {
        const r = new Reechantillonneur(v.duree);
        const sink = new MB.AudioBufferSink(v.audio);
        for await (const { buffer, timestamp } of sink.buffers()) {
          arret(signal);
          const canaux = [];
          for (let c = 0; c < buffer.numberOfChannels; c++) canaux.push(buffer.getChannelData(c));
          r.ajouter(canaux, timestamp - v.t0, buffer.sampleRate);
          onProgres(partImage + (1 - partImage) * Math.min(1, (timestamp - v.t0) / Math.max(1, v.duree)));
        }
        son = mesuresSon(r.resultat(), nSec);
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        console.warn(`${fichier.name} : son illisible`, e);
      }
    }
    onProgres(1);
    return {
      duree: v.duree,
      lum: secondesIlisibles(parSeconde(temps, vues.map((x) => x.lum), nSec), temps),
      nettete: parSeconde(temps, vues.map((x) => x.nettete), nSec),
      nouveaute: parSeconde(temps, nouv, nSec),
      son_db: son.db,
      voix: son.voix,
    };
  } finally {
    v.input.dispose();
  }
}

// ------------------------------------------------------------------ fabrication du film

/** Son d'un passage, en stéréo à TAUX : [g, d] (ou null s'il n'y a pas de son). */
async function sonPassage(v, debut, fin) {
  if (!v.audio) return null;
  const sink = new MB.AudioBufferSink(v.audio);
  const a = v.t0 + debut, b = v.t0 + fin;
  let taux = 0;
  let morceaux = [];
  for await (const { buffer, timestamp } of sink.buffers(a, b)) {
    taux = buffer.sampleRate;
    const canaux = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) canaux.push(buffer.getChannelData(c).slice());
    morceaux.push({ timestamp, canaux: enStereo(canaux) });
  }
  if (!taux) return null;
  const n = Math.round((fin - debut) * taux);
  const g = new Float32Array(n), d = new Float32Array(n);
  for (const { timestamp, canaux } of morceaux) {
    const decal = Math.round((timestamp - a) * taux);
    for (let i = 0; i < canaux[0].length; i++) {
      const k = decal + i;
      if (k >= 0 && k < n) { g[k] = canaux[0][i]; d[k] = canaux[1][i]; }
    }
  }
  morceaux = null;
  return [reechantillonner(g, taux, TAUX), reechantillonner(d, taux, TAUX)];
}

/** Musique (fichier audio) décodée en stéréo à TAUX. */
async function decoderMusique(fichier) {
  const Contexte = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Contexte(2, TAUX, TAUX);
  const buf = await ctx.decodeAudioData(await fichier.arrayBuffer());
  const canaux = [];
  for (let c = 0; c < buf.numberOfChannels; c++) canaux.push(reechantillonner(buf.getChannelData(c), buf.sampleRate, TAUX));
  return { canaux: enStereo(canaux) };
}

/** Où écrire le film : un fichier privé de l'appli (OPFS) si possible, sinon en mémoire. */
async function cible(nImages, duree) {
  try {
    if (navigator.storage?.getDirectory && globalThis.FileSystemFileHandle
      && 'createWritable' in FileSystemFileHandle.prototype) {
      const dossier = await navigator.storage.getDirectory();
      try {
        const vieux = [];
        for await (const nom of dossier.keys()) if (nom.startsWith('film-')) vieux.push(nom);
        for (const nom of vieux) await dossier.removeEntry(nom).catch(() => {});
      } catch { /* ménage impossible : pas grave */ }
      const poignee = await dossier.getFileHandle(`film-${Date.now()}.mp4`, { create: true });
      const flux = await poignee.createWritable();
      return {
        target: new MB.StreamTarget(flux, { chunked: true }),
        format: new MB.Mp4OutputFormat({ fastStart: 'reserve' }),
        paquetsVideo: Math.ceil(nImages * 1.05) + 16,
        paquetsAudio: Math.ceil((duree * TAUX) / 1024 * 1.05) + 64,
        fichier: () => poignee.getFile(),
      };
    }
  } catch { /* on passe à la mémoire */ }
  const target = new MB.BufferTarget();
  return {
    target,
    format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }),
    fichier: async () => new Blob([target.buffer], { type: 'video/mp4' }),
  };
}

/** Photo prête à animer : la partie qui remplit le cadre du film, en 1,25 × sa taille (net pendant le zoom). */
async function preparerPhoto(fichier, W, H) {
  let source = null, url = null;
  try {
    source = await createImageBitmap(fichier, { imageOrientation: 'from-image' });
  } catch {
    url = URL.createObjectURL(fichier); // Safari : en passant par une image HTML (HEIC compris)
    const img = new Image();
    img.src = url;
    await img.decode();
    source = img;
  }
  try {
    const lw = source.naturalWidth || source.width, lh = source.naturalHeight || source.height;
    const cw = Math.round(W * 1.25), ch = Math.round(H * 1.25);
    const toile = new OffscreenCanvas(cw, ch);
    const [sx, sy, sw, sh] = rectangle(lw, lh, W, H, 0, 0);
    toile.getContext('2d').drawImage(source, sx, sy, sw, sh, 0, 0, cw, ch);
    return toile;
  } finally {
    if (source && source.close) source.close();
    if (url) URL.revokeObjectURL(url);
  }
}

function dessinerTitre(ctx, l, h, titre, sousTitre, opacite) {
  if (!titre || opacite <= 0) return;
  const base = Math.min(l, h);
  ctx.save();
  ctx.globalAlpha = opacite;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFF4E0';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = base * 0.02;
  let taille = base * 0.085;
  const police = (t) => `600 ${Math.round(t)}px -apple-system, "SF Pro Display", "Helvetica Neue", Arial, sans-serif`;
  ctx.font = police(taille);
  while (ctx.measureText(titre).width > l * 0.88 && taille > base * 0.03) {
    taille *= 0.92;
    ctx.font = police(taille);
  }
  ctx.fillText(titre, l / 2, h / 2 - (sousTitre ? taille * 0.35 : 0));
  if (sousTitre) {
    ctx.font = `400 ${Math.round(taille * 0.45)}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
    ctx.fillStyle = '#EAD9B8';
    ctx.fillText(sousTitre, l / 2, h / 2 + taille * 0.6);
  }
  ctx.restore();
}

/**
 * Fabrique le film MP4 (H.264 + AAC, comme l'export du PC). Renvoie un Blob.
 *  - sources : [{ fichier }] (les vidéos originales, dans l'ordre des indices de `film.morceaux[].source`)
 *  - film : résultat de construireFilm()
 *  - reglages : { format, ips, sonCamera, volumeMusique }
 *  - parle(t) : vrai quand quelqu'un parle à l'instant t du film (la musique baisse)
 *  - extras : ajouts acceptés { legendes, jours: [{ debut, texte }], generique: [lignes] | null,
 *             gps (tracesParJour), carte, profil (booléens), look (nom de l'ambiance) | null }
 *  - problemes : tableau qui reçoit, en texte, les plans qui n'ont pas pu être lus (le film est fait quand même)
 *
 * Mémoire (l'iPhone est vite à court avec des vidéos 4K / 5,3K) : une vidéo n'est ouverte que le temps de ses
 * plans, puis fermée avec son décodeur.
 */
export async function fabriquer({ sources, film, reglages, musique = null, titre = '', sousTitre = '',
  parle = () => false, extras = {}, problemes = [], onProgres = () => {}, onEtape = () => {}, signal }) {
  const { largeur: W, hauteur: Hs } = FORMATS[reglages.format] || FORMATS.paysage;
  const ips = reglages.ips || 30;
  const debit = W * Hs >= 1920 * 1080 ? 10_000_000 : 8_000_000;
  if (!(await MB.canEncodeVideo('avc', { width: W, height: Hs, bitrate: debit }))) {
    throw new Error("Cet appareil ne sait pas fabriquer de vidéo H.264 dans le navigateur.");
  }
  if (!(await MB.canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: TAUX, bitrate: 192_000 }))) {
    const { registerAacEncoder } = await import('../vendor/aac.js');
    registerAacEncoder();
  }

  const ouvertes = new Map();
  const ouverte = async (i) => {
    if (!ouvertes.has(i)) ouvertes.set(i, await ouvrir(sources[i].fichier));
    return ouvertes.get(i);
  };
  const fermer = (i) => {
    const v = ouvertes.get(i);
    if (v) v.input.dispose();
    ouvertes.delete(i);
  };
  const nomPlan = (m) => `${sources[m.source].fichier.name} à ${Math.floor(m.debut / 60)}:${String(Math.floor(m.debut % 60)).padStart(2, '0')}`;
  let output = null;
  try {
    // --- 1. le son (rapide) : son de chaque passage + musique, mélangés ; une vidéo ouverte à la fois
    onEtape('son');
    const morceauxSon = [];
    let ouverteSon = null;
    for (const [k, m] of film.morceaux.entries()) {
      arret(signal);
      // ralenti, accéléré, photo, générique : sans le son de la caméra (la musique continue)
      let canaux = null;
      if (reglages.sonCamera !== false && avecSonCamera(m)) {
        if (ouverteSon !== null && ouverteSon !== m.source) fermer(ouverteSon);
        ouverteSon = m.source;
        try {
          canaux = await sonPassage(await ouverte(m.source), m.debut, m.fin);
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          problemes.push(`son de ${nomPlan(m)}`);
        }
      }
      morceauxSon.push({ ...m, canaux });
      onProgres(0.08 * ((k + 1) / film.morceaux.length));
    }
    const sonMusique = musique ? await decoderMusique(musique) : null;
    arret(signal);
    const [g, d] = mixer({
      duree: film.duree, taux: TAUX, morceaux: morceauxSon, musique: sonMusique,
      volumeCamera: reglages.sonCamera === false ? 0 : 1,
      volumeMusique: reglages.sonCamera === false ? 1 : (reglages.volumeMusique ?? 0.8),
      parle,
    });
    morceauxSon.length = 0;
    if (ouverteSon !== null) fermer(ouverteSon);

    // --- 2. l'image, plan par plan, encodée au fur et à mesure (avec le son, bien entrelacé)
    onEtape('image');
    const temps = instants(film.duree, ips);
    const sortie = await cible(temps.length, film.duree);
    output = new MB.Output({ format: sortie.format, target: sortie.target });
    const toile = new OffscreenCanvas(W, Hs);
    const ctx = toile.getContext('2d', { alpha: false });
    const sourceImage = new MB.CanvasSource(toile, { codec: 'avc', bitrate: debit, keyFrameInterval: 2 });
    const sourceSon = new MB.AudioBufferSource({ codec: 'aac', bitrate: 192_000 });
    output.addVideoTrack(sourceImage, { frameRate: ips, ...(sortie.paquetsVideo ? { maximumPacketCount: sortie.paquetsVideo } : {}) });
    output.addAudioTrack(sourceSon, sortie.paquetsAudio ? { maximumPacketCount: sortie.paquetsAudio } : {});
    output.setMetadataTags({ title: titre || 'Rando Cut', date: new Date() });
    await output.start();

    let sonEnvoye = 0; // échantillons déjà donnés à l'encodeur
    const envoyerSon = async (jusqua) => {
      const fin = Math.min(g.length, Math.round(jusqua * TAUX));
      while (sonEnvoye < fin) {
        const n = Math.min(TAUX, fin - sonEnvoye);
        const buf = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: TAUX });
        buf.copyToChannel(g.subarray(sonEnvoye, sonEnvoye + n), 0);
        buf.copyToChannel(d.subarray(sonEnvoye, sonEnvoye + n), 1);
        await sourceSon.add(buf);
        sonEnvoye += n;
      }
    };

    // Une vidéo filmée en portrait (téléphone) dans un film paysage : en entier, sur un fond flou de la même
    // image (au lieu d'un gros zoom). Sinon : l'image remplit le cadre, centrée (comme le PC sans cadrage auto).
    const sinks = new Map();
    const sink = async (i) => {
      if (!sinks.has(i)) {
        const v = await ouverte(i);
        const sw = await v.video.getDisplayWidth(), sh = await v.video.getDisplayHeight();
        const flou = sh > sw * 1.05 && W > Hs * 1.05;
        const options = flou
          ? { width: Math.round((Hs * sw) / sh / 2) * 2, height: Hs, fit: 'fill', poolSize: 2 }
          : { width: W, height: Hs, fit: 'cover', poolSize: 2 };
        sinks.set(i, { sink: new MB.CanvasSink(v.video, options), flou });
      }
      return sinks.get(i);
    };
    // dernier instant du film où chaque vidéo sert : ensuite, elle est fermée (décodeur et mémoire libérés)
    const derniereFin = new Map();
    for (const m of film.morceaux) if ((m.type || 'video') === 'video') derniereFin.set(m.source, Math.max(derniereFin.get(m.source) || 0, m.sortieFin));
    const lecteurs = new Map();
    const iterateur = (s, v, m, depuis = -Infinity) => {
      const vitesse = m.vitesse || 1;
      const aLire = temps.filter((t) => t >= m.sortieDebut && t < m.sortieFin && t >= depuis)
        .map((t) => v.t0 + m.debut + (t - m.sortieDebut) * vitesse);
      return s.sink.canvasesAtTimestamps(aLire)[Symbol.asyncIterator]();
    };
    const lecteur = async (m) => {
      if (!lecteurs.has(m)) {
        if (m.type === 'photo') {
          let photo = null;
          try { photo = await preparerPhoto(m.fichier, W, Hs); } catch (e) { console.warn('Photo illisible :', e); }
          lecteurs.set(m, { photo });
        } else {
          const v = await ouverte(m.source);
          const s = await sink(m.source);
          lecteurs.set(m, { it: iterateur(s, v, m), dernier: null, flou: s.flou, essais: 0 });
        }
      }
      return lecteurs.get(m);
    };
    const ambiance = extras.look ? creerLook(extras.look, W, Hs) : null;
    const cartes = new Map();
    const carteDe = (trace) => {
      if (!cartes.has(trace)) cartes.set(trace, preparerCarte(trace));
      return cartes.get(trace);
    };
    const basLegende = extras.profil && W <= Hs ? cadreProfil(W, Hs).y - Hs * 0.02 : Hs * (1 - MARGE_Y);
    const compo = new OffscreenCanvas(W, Hs);
    const cctx = compo.getContext('2d', { alpha: false });
    const petit = new OffscreenCanvas(48, Math.max(2, Math.round((48 * Hs) / W)));
    const pctx = petit.getContext('2d', { alpha: false });
    const poser = (image, flou, alpha) => {
      ctx.globalAlpha = alpha;
      if (!flou) {
        ctx.drawImage(image, 0, 0, W, Hs);
        return;
      }
      const r = Math.max(petit.width / image.width, petit.height / image.height);
      pctx.drawImage(image, (petit.width - image.width * r) / 2, (petit.height - image.height * r) / 2, image.width * r, image.height * r);
      cctx.imageSmoothingEnabled = true;
      cctx.imageSmoothingQuality = 'high';
      cctx.drawImage(petit, 0, 0, W, Hs);
      cctx.fillStyle = 'rgba(0,0,0,0.35)';
      cctx.fillRect(0, 0, W, Hs);
      cctx.drawImage(image, Math.round((W - image.width) / 2), 0, image.width, Hs);
      ctx.drawImage(compo, 0, 0);
    };

    for (let k = 0; k < temps.length; k++) {
      arret(signal);
      const t = temps[k];
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, Hs);
      const presents = actifs(film, t);
      let generique = null, gpsVu = 0, ici = null;
      for (const a of presents) {
        const m = a.morceau;
        if (m.type === 'generique') { generique = a; continue; }
        const lec = await lecteur(m);
        if (m.type === 'photo') {
          if (lec.photo) {
            const [x, y, w, h] = rectangle(lec.photo.width, lec.photo.height, W, Hs, a.progres, m.index || 0);
            ctx.globalAlpha = a.alpha;
            ctx.drawImage(lec.photo, x, y, w, h, 0, 0, W, Hs);
          }
        } else {
          // un plan illisible ne fait pas échouer le film : un nouvel essai, puis l'image d'avant reste affichée
          let r = { done: true };
          if (lec.it) {
            try {
              r = await lec.it.next();
            } catch (e) {
              if (e && e.name === 'AbortError') throw e;
              await lec.it.return?.().catch(() => {});
              lec.it = null;
              if (lec.essais++ < 1) {
                await new Promise((ok) => setTimeout(ok, 300));
                try {
                  lec.it = iterateur(await sink(m.source), await ouverte(m.source), m, t);
                  r = await lec.it.next();
                } catch (e2) {
                  if (e2 && e2.name === 'AbortError') throw e2;
                  lec.it = null;
                }
              }
              if (!lec.it) problemes.push(`image de ${nomPlan(m)}`);
            }
          }
          if (lec.it && (r.done || !r.value) && !lec.signale) {
            lec.signale = true; // la vidéo s'arrête avant la fin du plan (fichier abîmé ?)
            problemes.push(`image de ${nomPlan(m)}`);
          }
          const image = (!r.done && r.value && r.value.canvas) || lec.dernier;
          if (image) {
            lec.dernier = image;
            poser(image, lec.flou, a.alpha);
          }
        }
        // la carte et le profil suivent la vidéo du moment (cachés sur une photo ou une vidéo sans GPS)
        const pos = m.type === 'photo' ? null : position(extras.gps, m.source, a.tSource);
        gpsVu = gpsVu * (1 - a.alpha) + (pos ? a.alpha : 0);
        if (pos) ici = pos;
      }
      ctx.globalAlpha = 1;
      if (ambiance) ctx.drawImage(ambiance.appliquer(toile), 0, 0);
      dessinerTitre(ctx, W, Hs, titre, sousTitre, opaciteTitre(t));
      for (const j of extras.jours || []) dessinerJour(ctx, W, Hs, j.texte, opacite(t, j.debut, 2.8));
      for (const l of extras.legendes || []) dessinerLegende(ctx, W, Hs, l.texte, opacite(t, l.debut, 3.5), basLegende);
      if (ici && gpsVu > 0.01) {
        if (extras.carte) dessinerCarte(ctx, W, Hs, ici.trace, carteDe(ici.trace), ici.i, gpsVu);
        if (extras.profil) dessinerProfil(ctx, W, Hs, ici.trace, ici.i, gpsVu);
      }
      if (generique && extras.generique) dessinerGenerique(ctx, W, Hs, extras.generique, generique.tSource, generique.alpha);
      const n = noir(film, t);
      if (n > 0) {
        ctx.globalAlpha = n;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, Hs);
      }
      ctx.globalAlpha = 1;
      await envoyerSon(t + 1);
      await sourceImage.add(t, 1 / ips);
      // les plans terminés libèrent leur décodeur
      for (const [m, lec] of lecteurs) {
        if ((k + 1) / ips >= m.sortieFin) {
          await lec.it?.return?.()?.catch?.(() => {});
          lecteurs.delete(m);
        }
      }
      for (const [i, fin] of derniereFin) {
        if (fin <= (k + 1) / ips && ouvertes.has(i)) {
          sinks.delete(i);
          fermer(i);
          derniereFin.delete(i);
        }
      }
      onProgres(0.08 + 0.9 * ((k + 1) / temps.length));
    }
    await envoyerSon(film.duree + 1);
    for (const lec of lecteurs.values()) await lec.it?.return?.();
    onEtape('fin');
    await output.finalize();
    output = null;
    onProgres(1);
    const blob = await sortie.fichier();
    return blob.type === 'video/mp4' ? blob : new Blob([blob], { type: 'video/mp4' });
  } finally {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
    for (const v of ouvertes.values()) v.input.dispose();
  }
}
