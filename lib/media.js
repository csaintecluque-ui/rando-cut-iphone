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
 * Mesures seconde par seconde d'une vidéo (comme l'analyse du PC) : images clés réduites à 256×144
 * (au plus 2 par seconde) et son ramené à 16 kHz. onProgres(0 → 1).
 */
export async function analyser(fichier, { onProgres = () => {}, signal } = {}) {
  const v = await ouvrir(fichier);
  try {
    if (!(await v.video.canDecode())) throw new Error(`« ${fichier.name} » : ce format vidéo n'est pas lisible sur cet appareil.`);
    const nSec = Math.max(1, Math.floor(v.duree));
    const avecSon = !!v.audio && (await v.audio.canDecode().catch(() => false));
    const partImage = avecSon ? 0.75 : 1;

    // --- image : images clés seulement (rapide, même en 5,3K)
    const canvas = new OffscreenCanvas(L, H);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const vues = [];
    let erreur = null;
    const decodeur = new VideoDecoder({
      output: (image) => {
        try {
          ctx.drawImage(image, 0, 0, L, H);
          const st = statsImage(enGris(ctx.getImageData(0, 0, L, H).data));
          vues.push({ t: image.timestamp / 1e6 - v.t0, ...st });
        } catch (e) {
          erreur = e;
        } finally {
          image.close();
        }
      },
      error: (e) => { erreur = e; },
    });
    decodeur.configure(await v.video.getDecoderConfig());
    const paquets = new MB.EncodedPacketSink(v.video);
    let p = await paquets.getFirstKeyPacket();
    while (p) {
      arret(signal);
      if (erreur) throw erreur;
      decodeur.decode(p.toEncodedVideoChunk());
      await place(decodeur);
      onProgres(partImage * Math.min(1, (p.timestamp - v.t0) / Math.max(1, v.duree)));
      let suivant = await paquets.getKeyPacket(p.timestamp + 0.5);
      if (!suivant || suivant.timestamp <= p.timestamp) suivant = await paquets.getNextKeyPacket(p);
      p = suivant;
    }
    await decodeur.flush();
    decodeur.close();
    if (erreur) throw erreur;
    vues.sort((a, b) => a.t - b.t);
    const temps = vues.map((x) => x.t);
    const nouv = vues.map((x, i) => nouveaute(i ? vues[i - 1].petit : null, x.petit));

    // --- son
    let son = { db: new Array(nSec).fill(-90), voix: new Array(nSec).fill(0) };
    if (avecSon) {
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
    }
    onProgres(1);
    return {
      duree: v.duree,
      lum: parSeconde(temps, vues.map((x) => x.lum), nSec),
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
 */
export async function fabriquer({ sources, film, reglages, musique = null, titre = '', sousTitre = '',
  parle = () => false, extras = {}, onProgres = () => {}, onEtape = () => {}, signal }) {
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
  let output = null;
  try {
    // --- 1. le son (rapide) : son de chaque passage + musique, mélangés
    onEtape('son');
    const morceauxSon = [];
    for (const [k, m] of film.morceaux.entries()) {
      arret(signal);
      // ralenti, accéléré, photo, générique : sans le son de la caméra (la musique continue)
      const canaux = reglages.sonCamera !== false && avecSonCamera(m) ? await sonPassage(await ouverte(m.source), m.debut, m.fin) : null;
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
          ? { width: Math.round((Hs * sw) / sh / 2) * 2, height: Hs, fit: 'fill', poolSize: 3 }
          : { width: W, height: Hs, fit: 'cover', poolSize: 3 };
        sinks.set(i, { sink: new MB.CanvasSink(v.video, options), flou });
      }
      return sinks.get(i);
    };
    const lecteurs = new Map();
    const lecteur = async (m) => {
      if (!lecteurs.has(m)) {
        if (m.type === 'photo') {
          let photo = null;
          try { photo = await preparerPhoto(m.fichier, W, Hs); } catch (e) { console.warn('Photo illisible :', e); }
          lecteurs.set(m, { photo });
        } else {
          const v = await ouverte(m.source);
          const s = await sink(m.source);
          const vitesse = m.vitesse || 1;
          const aLire = temps.filter((t) => t >= m.sortieDebut && t < m.sortieFin)
            .map((t) => v.t0 + m.debut + (t - m.sortieDebut) * vitesse);
          lecteurs.set(m, { it: s.sink.canvasesAtTimestamps(aLire)[Symbol.asyncIterator](), dernier: null, flou: s.flou });
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
          const r = await lec.it.next();
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
          await lec.it?.return?.();
          lecteurs.delete(m);
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
