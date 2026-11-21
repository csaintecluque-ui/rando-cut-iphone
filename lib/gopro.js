// Fichiers GoPro : regrouper les chapitres d'une même prise, lire les marqueurs HiLight et la date de tournage.
// Même logique que montage/gopro.py et montage/gpmf.py sur le PC. On ne fait que LIRE les fichiers.
//
// Nom d'un fichier GoPro : G + X (HEVC) ou H (H.264) + 2 chiffres de chapitre + 4 chiffres de prise.
// GX011234.MP4, GX021234.MP4 = la même prise 1234, en 2 morceaux. GL011234.LRV = sa copie légère.

export const MOTIF = /^G([XHL])(\d{2})(\d{4})\.(MP4|LRV)$/i;
const EXTENSIONS_VIDEO = ['.mp4', '.mov', '.m4v', '.lrv', '.3gp', '.webm', '.mkv'];

export function extension(nom) {
  const i = nom.lastIndexOf('.');
  return i < 0 ? '' : nom.slice(i).toLowerCase();
}

export function estVideo(fichier) {
  return (fichier.type || '').startsWith('video/') || EXTENSIONS_VIDEO.includes(extension(fichier.name));
}

export function estLRV(fichier) {
  return extension(fichier.name) === '.lrv';
}

/**
 * Regroupe des fichiers en prises. Chaque prise : { nom, numero, chapitres: [File], legers: [File|null],
 * manquants: [n°] }. Les chapitres GoPro d'une même prise (mêmes 4 derniers chiffres) sont rangés dans l'ordre ;
 * les .LRV sont rattachés à leur .MP4 (analyse plus rapide) ; une autre vidéo est une prise à elle seule.
 */
export function regrouper(fichiers) {
  const groupes = new Map();
  const legers = new Map();
  const autres = [];
  const vus = new Set();
  for (const f of fichiers) {
    const cle = `${f.name}|${f.size}`;
    if (vus.has(cle) || !estVideo(f)) continue;
    vus.add(cle);
    const m = MOTIF.exec(f.name);
    if (m && m[1].toUpperCase() === 'L') {
      legers.set(`${Number(m[2])}|${m[3]}`, f);
    } else if (m && m[4].toUpperCase() === 'MP4') {
      const k = `${m[1].toUpperCase()}|${m[3]}`;
      if (!groupes.has(k)) groupes.set(k, { lettre: m[1].toUpperCase(), numero: m[3], morceaux: [] });
      groupes.get(k).morceaux.push([Number(m[2]), f]);
    } else if (!estLRV(f)) {
      autres.push({ nom: f.name.replace(/\.[^.]+$/, ''), numero: '', chapitres: [f], legers: [null], manquants: [] });
    }
  }
  const prises = [];
  for (const { lettre, numero, morceaux } of groupes.values()) {
    morceaux.sort((a, b) => a[0] - b[0]);
    const numeros = morceaux.map(([n]) => n);
    const manquants = [];
    for (let n = 1; n <= Math.max(...numeros); n++) if (!numeros.includes(n)) manquants.push(n);
    prises.push({
      nom: `G${lettre}${numero}`, numero,
      chapitres: morceaux.map(([, f]) => f),
      legers: morceaux.map(([n]) => legers.get(`${n}|${numero}`) || null),
      manquants,
    });
  }
  prises.sort((a, b) => a.numero.localeCompare(b.numero));
  return [...prises, ...autres];
}

// ------------------------------------------------------------------ lecture des boîtes MP4

async function lire(blob, debut, fin) {
  return new Uint8Array(await blob.slice(debut, fin).arrayBuffer());
}

/** Les boîtes MP4 entre debut et fin : { type, debut (contenu), fin }. On ne lit que les en-têtes. */
export async function boites(blob, debut = 0, fin = blob.size) {
  const res = [];
  let pos = debut;
  while (pos + 8 <= fin && res.length < 10000) {
    const h = await lire(blob, pos, Math.min(pos + 16, fin));
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let taille = dv.getUint32(0);
    const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
    let entete = 8;
    if (taille === 1) {
      if (h.length < 16) break;
      taille = Number(dv.getBigUint64(8));
      entete = 16;
    } else if (taille === 0) {
      taille = fin - pos;
    }
    if (taille < entete) break;
    res.push({ type, debut: pos + entete, fin: Math.min(pos + taille, fin) });
    pos += taille;
  }
  return res;
}

/** Contenu des sous-boîtes de moov/udta (petites) et de moov/mvhd. */
async function contenuMoov(blob) {
  const trouve = {};
  for (const b of await boites(blob)) {
    if (b.type !== 'moov') continue;
    for (const b2 of await boites(blob, b.debut, b.fin)) {
      if (b2.type === 'mvhd' && b2.fin - b2.debut < 1024) {
        trouve.mvhd = await lire(blob, b2.debut, b2.fin);
      } else if (b2.type === 'udta') {
        for (const b3 of await boites(blob, b2.debut, b2.fin)) {
          if (b3.fin - b3.debut < 10_000_000) trouve[b3.type] = await lire(blob, b3.debut, b3.fin);
        }
      }
    }
    break;
  }
  return trouve;
}

// ------------------------------------------------------------------ GPMF (clé, type, taille, nombre)

const TAILLE_TYPE = { b: 1, B: 1, c: 1, s: 2, S: 2, l: 4, L: 4, f: 4, d: 8, j: 8, J: 8, q: 4, Q: 8 };

/** Parcourt les éléments KLV d'un bloc GPMF : [{cle, type, taille, nombre, debut}]. */
export function klv(buf, debut = 0, fin = buf.length) {
  const res = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = debut;
  while (pos + 8 <= fin) {
    const cle = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
    const type = String.fromCharCode(buf[pos + 4]);
    const taille = buf[pos + 5];
    const nombre = dv.getUint16(pos + 6);
    const longueur = taille * nombre;
    res.push({ cle, type, taille, nombre, debut: pos + 8 });
    pos += 8 + Math.ceil(longueur / 4) * 4;
  }
  return res;
}

function chercherGPMF(buf, cle, debut = 0, fin = buf.length) {
  for (const e of klv(buf, debut, fin)) {
    if (e.cle === cle) return e;
    if (e.type === '\0') {
      const r = chercherGPMF(buf, cle, e.debut, e.debut + e.taille * e.nombre);
      if (r) return r;
    }
  }
  return null;
}

function entiersL(buf, e) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = Math.floor((e.taille * e.nombre) / 4);
  const res = [];
  for (let i = 0; i < n; i++) res.push(dv.getUint32(e.debut + 4 * i));
  return res;
}

/** Temps des marqueurs HiLight (millisecondes depuis le début du fichier), depuis le contenu de udta. */
export function hilightsMs(udta) {
  const hmmt = udta.HMMT;
  if (hmmt && hmmt.length >= 4) {
    const dv = new DataView(hmmt.buffer, hmmt.byteOffset, hmmt.byteLength);
    const n = Math.min(dv.getUint32(0), Math.floor((hmmt.length - 4) / 4));
    const temps = [];
    for (let i = 0; i < n; i++) {
      const t = dv.getUint32(4 + 4 * i);
      if (t > 0) temps.push(t);
    }
    if (temps.length) return temps.sort((a, b) => a - b);
  }
  const bloc = udta.GPMF;
  if (bloc) {
    const hlmt = chercherGPMF(bloc, 'HLMT');
    if (hlmt && hlmt.type === '\0') {
      const manl = chercherGPMF(bloc, 'MANL', hlmt.debut, hlmt.debut + hlmt.taille * hlmt.nombre);
      if (manl) return entiersL(bloc, manl).filter((t) => t > 0).sort((a, b) => a - b);
    }
  }
  return [];
}

/** Décalage horaire réglé dans la caméra (minutes), ou null. */
export function fuseauMinutes(udta) {
  const bloc = udta.GPMF;
  if (!bloc) return null;
  const e = chercherGPMF(bloc, 'TZON');
  if (!e || e.type !== 's' || e.taille !== 2) return null;
  return new DataView(bloc.buffer, bloc.byteOffset, bloc.byteLength).getInt16(e.debut);
}

/** Date de création écrite dans mvhd (secondes depuis 1904, heure universelle), ou null. */
export function dateMvhd(mvhd) {
  if (!mvhd || mvhd.length < 12) return null;
  const dv = new DataView(mvhd.buffer, mvhd.byteOffset, mvhd.byteLength);
  const version = mvhd[0];
  const s = version === 1 ? Number(dv.getBigUint64(4)) : dv.getUint32(4);
  if (!s) return null;
  const d = new Date((s - 2082844800) * 1000);
  return d.getFullYear() > 2000 ? d : null;
}

/** HiLight (s), date de tournage et fuseau de la caméra d'un fichier. Ne lève jamais d'erreur. */
export async function infosFichier(fichier) {
  try {
    const moov = await contenuMoov(fichier);
    return {
      hilights: hilightsMs(moov).map((t) => t / 1000),
      date: dateMvhd(moov.mvhd),
      fuseau: fuseauMinutes(moov),
    };
  } catch {
    return { hilights: [], date: null, fuseau: null };
  }
}
