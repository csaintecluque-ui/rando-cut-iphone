// Photos dans le film : date de prise (EXIF, dans les JPEG comme dans les HEIC de l'iPhone) et choix réparti
// sur la journée, comme montage/photos.py. La photo n'est jamais modifiée.

import { extension } from './gopro.js';

export const EXTENSIONS_PHOTO = ['.jpg', '.jpeg', '.png', '.heic', '.heif'];
export const DUREE = 4.0;   // durée d'une photo dans le film (s)
export const ZOOM = 1.18;   // agrandissement au bout du mouvement « Ken Burns »

export function estPhoto(f) {
  return (f.type || '').startsWith('image/') || EXTENSIONS_PHOTO.includes(extension(f.name));
}

/** Date lue dans un bloc TIFF (EXIF) : Date, ou null. */
export function dateTiff(buf, debut) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const le = buf[debut] === 0x49; // « II » : petit-boutiste
  const u16 = (o) => dv.getUint16(debut + o, le);
  const u32 = (o) => dv.getUint32(debut + o, le);
  const texte = (o, n) => String.fromCharCode(...buf.subarray(debut + o, debut + o + n)).replace(/\0.*$/, '');
  const lireIfd = (o) => {
    const res = {};
    if (o <= 0 || debut + o + 2 > buf.length) return res;
    const n = u16(o);
    for (let i = 0; i < n && debut + o + 2 + 12 * (i + 1) <= buf.length; i++) {
      const e = o + 2 + 12 * i;
      const tag = u16(e), type = u16(e + 2), nb = u32(e + 4);
      if (type === 2) res[tag] = nb <= 4 ? texte(e + 8, nb) : texte(u32(e + 8), nb);
      else if (type === 4) res[tag] = u32(e + 8);
    }
    return res;
  };
  try {
    if (u16(2) !== 42) return null;
    const ifd0 = lireIfd(u32(4));
    const exif = ifd0[0x8769] ? lireIfd(ifd0[0x8769]) : {};
    const brut = exif[0x9003] || exif[0x9004] || ifd0[0x0132];
    const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(brut || '');
    if (!m) return null;
    const [, a, mo, j, h, mi, s] = m.map(Number);
    const decalage = /^([+-])(\d\d):(\d\d)$/.exec(exif[0x9011] || exif[0x9010] || '');
    if (decalage) {
      const minutes = (decalage[1] === '-' ? -1 : 1) * (Number(decalage[2]) * 60 + Number(decalage[3]));
      return new Date(Date.UTC(a, mo - 1, j, h, mi, s) - minutes * 60000);
    }
    return new Date(a, mo - 1, j, h, mi, s); // heure du téléphone
  } catch {
    return null;
  }
}

/** Date de prise d'une photo (EXIF), sinon null. On cherche le bloc « Exif » au début du fichier. */
export async function datePhoto(fichier) {
  try {
    const buf = new Uint8Array(await fichier.slice(0, 1 << 20).arrayBuffer());
    for (let i = 0; i + 10 < buf.length; i++) {
      // « Exif\0\0 » suivi de « II* » ou « MM\0* »
      if (buf[i] === 0x45 && buf[i + 1] === 0x78 && buf[i + 2] === 0x69 && buf[i + 3] === 0x66 && buf[i + 4] === 0 && buf[i + 5] === 0) {
        const d = dateTiff(buf, i + 6);
        if (d) return d;
      }
    }
  } catch { /* illisible : pas de date */ }
  return null;
}

/**
 * Choisit `nombre` photos réparties sur la journée. Une rafale (photos à moins de 5 s d'écart) compte pour une
 * seule : on y garde la plus grosse (souvent la plus nette). photos : [{ fichier, date }].
 */
export function choisirPhotos(photos, nombre, rafale = 5) {
  const datees = photos.filter((p) => p.date).sort((a, b) => a.date - b.date);
  const groupes = [];
  for (const p of datees) {
    const dernier = groupes[groupes.length - 1];
    if (dernier && (p.date - dernier[dernier.length - 1].date) / 1000 <= rafale) dernier.push(p);
    else groupes.push([p]);
  }
  const meilleures = groupes.map((g) => g.reduce((a, b) => (b.fichier.size > a.fichier.size ? b : a)));
  if (nombre <= 0 || !meilleures.length) return [];
  if (meilleures.length <= nombre) return meilleures;
  const pas = meilleures.length / nombre;
  return Array.from({ length: nombre }, (_, k) => meilleures[Math.floor(pas * k + pas / 2)]);
}

/** Mouvement d'une photo : zoom avant, puis arrière, puis avant… (comme le PC en « automatique »). */
export function mouvement(index) {
  return index % 2 === 0 ? [1.0, ZOOM] : [ZOOM, 1.0];
}

/** Partie de la photo à montrer (x, y, l, h) à la fraction f du plan, pour remplir un cadre L×H. */
export function rectangle(lImg, hImg, L, H, f, index) {
  let x0, y0, w0, h0;
  if (lImg / hImg > L / H) { w0 = (hImg * L) / H; h0 = hImg; x0 = (lImg - w0) / 2; y0 = 0; } else { w0 = lImg; h0 = (lImg * H) / L; x0 = 0; y0 = (hImg - h0) / 2; }
  const [za, zb] = mouvement(index);
  f = Math.max(0, Math.min(1, f));
  const z = za + (zb - za) * f;
  const w = w0 / z, h = h0 / z;
  return [x0 + w0 / 2 - w / 2, y0 + h0 / 2 - h / 2, w, h];
}
