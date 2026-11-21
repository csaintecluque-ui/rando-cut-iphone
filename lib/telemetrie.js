// GPS des vidéos GoPro : lu dans la piste de télémétrie GPMF du fichier MP4 (comme montage/telemetrie.py).
// Rien n'est envoyé sur internet : on lit seulement le fichier, et la carte est dessinée sans fond de carte.

import { boites, klv } from './gopro.js';

const EPOQUE_GPS9 = Date.UTC(2000, 0, 1) / 1000;
export const SEUIL_DENIVELE = 5.0; // m : une montée ne compte qu'au-delà (le GPS tremble en altitude)

async function lire(blob, a, b) {
  return new Uint8Array(await blob.slice(a, b).arrayBuffer());
}

/** Boîtes contenues dans buf[a, b) : [{ type, a (début du contenu), b }]. */
function enfants(buf, a = 0, b = buf.length) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const res = [];
  let pos = a;
  while (pos + 8 <= b) {
    let taille = dv.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    let entete = 8;
    if (taille === 1 && pos + 16 <= b) {
      taille = Number(dv.getBigUint64(pos + 8));
      entete = 16;
    } else if (taille === 0) {
      taille = b - pos;
    }
    if (taille < entete) break;
    res.push({ type, a: pos + entete, b: Math.min(pos + taille, b) });
    pos += taille;
  }
  return res;
}

const un = (buf, liste, type) => liste.find((x) => x.type === type);

/** Tables d'échantillons d'une piste dont la description est `format` (ex. 'gpmd'), ou null. */
function tablesPiste(moov, format) {
  const dv = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  for (const trak of enfants(moov).filter((x) => x.type === 'trak')) {
    const mdia = un(moov, enfants(moov, trak.a, trak.b), 'mdia');
    if (!mdia) continue;
    const dansMdia = enfants(moov, mdia.a, mdia.b);
    const mdhd = un(moov, dansMdia, 'mdhd');
    const minf = un(moov, dansMdia, 'minf');
    if (!mdhd || !minf) continue;
    const stbl = un(moov, enfants(moov, minf.a, minf.b), 'stbl');
    if (!stbl) continue;
    const t = Object.fromEntries(enfants(moov, stbl.a, stbl.b).map((x) => [x.type, x]));
    if (!t.stsd || !t.stsz || !t.stsc || !(t.stco || t.co64)) continue;
    const typeEntree = String.fromCharCode(...moov.subarray(t.stsd.a + 12, t.stsd.a + 16));
    if (typeEntree !== format) continue;

    const v = moov[mdhd.a];
    const echelle = v === 1 ? dv.getUint32(mdhd.a + 20) : dv.getUint32(mdhd.a + 12);
    // tailles
    const tailleFixe = dv.getUint32(t.stsz.a + 4);
    const n = dv.getUint32(t.stsz.a + 8);
    const tailles = Array.from({ length: n }, (_, i) => (tailleFixe || dv.getUint32(t.stsz.a + 12 + 4 * i)));
    // positions des morceaux (chunks)
    const co = t.co64 || t.stco;
    const nc = dv.getUint32(co.a + 4);
    const morceaux = Array.from({ length: nc }, (_, i) => (t.co64
      ? Number(dv.getBigUint64(co.a + 8 + 8 * i)) : dv.getUint32(co.a + 8 + 4 * i)));
    // échantillons par morceau
    const ns = dv.getUint32(t.stsc.a + 4);
    const regles = Array.from({ length: ns }, (_, i) => [dv.getUint32(t.stsc.a + 8 + 12 * i), dv.getUint32(t.stsc.a + 12 + 12 * i)]);
    const positions = [];
    let k = 0;
    for (let c = 0; c < nc && k < n; c++) {
      let parMorceau = 1;
      for (const [premier, nb] of regles) if (c + 1 >= premier) parMorceau = nb;
      let pos = morceaux[c];
      for (let j = 0; j < parMorceau && k < n; j++, k++) {
        positions.push(pos);
        pos += tailles[k];
      }
    }
    // durées
    const durees = [];
    if (t.stts) {
      const ne = dv.getUint32(t.stts.a + 4);
      for (let i = 0; i < ne; i++) {
        const nb = dv.getUint32(t.stts.a + 8 + 8 * i), d = dv.getUint32(t.stts.a + 12 + 8 * i);
        for (let j = 0; j < nb; j++) durees.push(d / (echelle || 1));
      }
    }
    return { positions, tailles, durees };
  }
  return null;
}

/** Blocs de la piste de télémétrie GoPro : [{ t, d, donnees }] (≈ un bloc par seconde), ou []. */
export async function blocsGPMF(fichier) {
  const moovBoite = (await boites(fichier)).find((b) => b.type === 'moov');
  if (!moovBoite || moovBoite.fin - moovBoite.debut > 64e6) return [];
  const moov = await lire(fichier, moovBoite.debut, moovBoite.fin);
  const tables = tablesPiste(moov, 'gpmd');
  if (!tables) return [];
  const blocs = [];
  let t = 0;
  for (let i = 0; i < tables.positions.length; i++) {
    const d = tables.durees[i] ?? 1;
    blocs.push({ t, d, donnees: await lire(fichier, tables.positions[i], tables.positions[i] + tables.tailles[i]) });
    t += d;
  }
  return blocs;
}

function nombres(buf, e) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const lire1 = { s: [2, (o) => dv.getInt16(o)], S: [2, (o) => dv.getUint16(o)], l: [4, (o) => dv.getInt32(o)],
    L: [4, (o) => dv.getUint32(o)], f: [4, (o) => dv.getFloat32(o)], d: [8, (o) => dv.getFloat64(o)] }[e.type];
  if (!lire1) return [];
  const n = Math.floor((e.taille * e.nombre) / lire1[0]);
  return Array.from({ length: n }, (_, i) => lire1[1](e.debut + i * lire1[0]) || 1);
}

/** Mesures GPS valides d'un bloc DEVC : [{ lat, lon, alt, vitesse, utc|null }]. */
export function mesuresBloc(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let mesures = [];
  for (const devc of klv(buf)) {
    if (devc.cle !== 'DEVC' || devc.type !== '\0') continue;
    for (const strm of klv(buf, devc.debut, devc.debut + devc.taille * devc.nombre)) {
      if (strm.cle !== 'STRM' || strm.type !== '\0') continue;
      let scal = [1], gpsf = 0, gpsp = 0, gpsu = null;
      const ici = [];
      for (const e of klv(buf, strm.debut, strm.debut + strm.taille * strm.nombre)) {
        if (e.cle === 'SCAL') scal = nombres(buf, e).length ? nombres(buf, e) : [1];
        else if (e.cle === 'GPSF') gpsf = dv.getUint32(e.debut);
        else if (e.cle === 'GPSP') gpsp = dv.getUint16(e.debut);
        else if (e.cle === 'GPSU') {
          const s = String.fromCharCode(...buf.subarray(e.debut, e.debut + 16)).replace(/\0/g, '');
          const m = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d(?:\.\d+)?)$/.exec(s);
          gpsu = m ? Date.UTC(2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000 + parseFloat(m[6]) : null;
        } else if (e.cle === 'GPS9' && e.taille >= 32) {
          const s = [...scal, ...new Array(9).fill(1)].slice(0, 9);
          for (let i = 0; i < e.nombre; i++) {
            const b = e.debut + i * e.taille;
            const [lat, lon, alt, v2, , jours, secs] = Array.from({ length: 7 }, (_, j) => dv.getInt32(b + 4 * j));
            const dop = dv.getUint16(b + 28), fix = dv.getUint16(b + 30);
            if (fix >= 3 && lat && dop / s[7] <= 5) {
              ici.push({ lat: lat / s[0], lon: lon / s[1], alt: alt / s[2], vitesse: v2 / s[3],
                utc: EPOQUE_GPS9 + (jours / s[5]) * 86400 + secs / s[6] });
            }
          }
        } else if (e.cle === 'GPS5' && e.taille === 20) {
          const s = [...scal, ...new Array(5).fill(1)].slice(0, 5);
          for (let i = 0; i < e.nombre; i++) {
            const b = e.debut + i * 20;
            ici.push({ lat: dv.getInt32(b) / s[0], lon: dv.getInt32(b + 4) / s[1], alt: dv.getInt32(b + 8) / s[2],
              vitesse: dv.getInt32(b + 12) / s[3], utc: null });
          }
        }
      }
      // GPS5 : la qualité et l'heure sont données pour tout le bloc
      if (ici.length && ici[ici.length - 1].utc === null) {
        if (gpsf < 3 || (gpsp && gpsp / 100 > 5)) continue;
        for (const m of ici) m.utc = gpsu;
      }
      mesures = mesures.concat(ici);
    }
  }
  return mesures;
}

/** Piste GPS d'un fichier (temps en s depuis son début), ou null s'il n'y en a pas. Ne lève jamais d'erreur. */
export async function gpsFichier(fichier) {
  try {
    const blocs = await blocsGPMF(fichier);
    const p = { t: [], lat: [], lon: [], alt: [], vitesse: [] };
    for (const b of blocs) {
      const m = mesuresBloc(b.donnees);
      m.forEach((x, k) => {
        p.t.push(b.t + ((k + 0.5) / m.length) * b.d);
        p.lat.push(x.lat); p.lon.push(x.lon); p.alt.push(x.alt); p.vitesse.push(x.vitesse);
      });
    }
    return p.t.length >= 2 ? p : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ calculs

export function distanceM(lat1, lon1, lat2, lon2) {
  const r = 6371000, rad = Math.PI / 180;
  const p1 = lat1 * rad, p2 = lat2 * rad, dp = p2 - p1, dl = (lon2 - lon1) * rad;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

/** Moyenne glissante sur n valeurs (bords prolongés), comme montage/telemetrie.py. */
export function lisser(x, n) {
  if (x.length < 3 || n < 2) return [...x];
  n = Math.min(n, x.length);
  const bord = n >> 1;
  const etendu = [...new Array(bord).fill(x[0]), ...x, ...new Array(n - 1 - bord).fill(x[x.length - 1])];
  const res = [];
  let s = 0;
  for (let i = 0; i < n; i++) s += etendu[i];
  res.push(s / n);
  for (let i = n; i < etendu.length; i++) {
    s += etendu[i] - etendu[i - n];
    res.push(s / n);
  }
  return res;
}

/**
 * Distance et dénivelé cumulés d'une piste, une valeur par seconde environ :
 * { t, lat, lon, alt, dist, deniv }. Positions lissées sur ≈ 5 s (le GPS tremble), distance comptée
 * seulement quand on bouge (> 1 km/h), altitude lissée sur ≈ 15 s avec un seuil de 5 m.
 */
export function cumul(p) {
  const n = p.t.length;
  const parS = Math.max(1, Math.round(n / Math.max(1e-6, p.t[n - 1] - p.t[0] + 1e-6)));
  const lat = lisser(p.lat, 5 * parS), lon = lisser(p.lon, 5 * parS), v = lisser(p.vitesse, 2 * parS);
  const altL = lisser(p.alt, 15 * parS);
  const idx = [];
  for (let i = 0; i < n; i += parS) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  const res = { t: [], lat: [], lon: [], alt: [], dist: [], deniv: [] };
  let dist = 0, ref = altL[0], total = 0;
  idx.forEach((i, k) => {
    if (k > 0) {
      const j = idx[k - 1];
      const d = distanceM(lat[j], lon[j], lat[i], lon[i]);
      const duree = Math.max(p.t[i] - p.t[j], 0.05);
      if (d < 60 * duree && 0.5 * (v[j] + v[i]) > 0.3) dist += d;
    }
    // dénivelé positif avec hystérésis (sur tous les points entre j et i)
    for (let m = k > 0 ? idx[k - 1] + 1 : 0; m <= i; m++) {
      if (altL[m] > ref + SEUIL_DENIVELE) { total += altL[m] - ref; ref = altL[m]; } else if (altL[m] < ref - SEUIL_DENIVELE) ref = altL[m];
    }
    res.t.push(p.t[i]); res.lat.push(lat[i]); res.lon.push(lon[i]); res.alt.push(altL[i]);
    res.dist.push(dist); res.deniv.push(total);
  });
  return res;
}

/**
 * Traces de la journée : les pistes des vidéos d'un même jour mises bout à bout (distance et dénivelé
 * qui continuent d'une vidéo à l'autre). `pistes[i]` : piste de la source i (ou null), `jours[i]` : clé du jour.
 * Renvoie { traces: [{ lat, lon, alt, dist, deniv }], ou: Map(source → { trace, t, debut }) }.
 */
export function tracesParJour(pistes, jours) {
  const traces = new Map();
  const ou = new Map();
  pistes.forEach((p, i) => {
    if (!p) return;
    const c = cumul(p);
    const cle = jours[i] ?? '?';
    if (!traces.has(cle)) traces.set(cle, { lat: [], lon: [], alt: [], dist: [], deniv: [] });
    const tr = traces.get(cle);
    const d0 = tr.dist.length ? tr.dist[tr.dist.length - 1] : 0;
    const h0 = tr.deniv.length ? tr.deniv[tr.deniv.length - 1] : 0;
    ou.set(i, { trace: tr, t: c.t, debut: tr.lat.length });
    for (let k = 0; k < c.t.length; k++) {
      tr.lat.push(c.lat[k]); tr.lon.push(c.lon[k]); tr.alt.push(c.alt[k]);
      tr.dist.push(d0 + c.dist[k]); tr.deniv.push(h0 + c.deniv[k]);
    }
  });
  return { traces: [...traces.values()], ou };
}

/** Où en est-on sur la trace à l'instant tSource de la source i : { trace, i } ou null. */
export function position(gps, source, tSource) {
  const o = gps && gps.ou.get(source);
  if (!o || !o.t.length) return null;
  let a = 0, b = o.t.length - 1;
  while (a < b) {
    const m = (a + b + 1) >> 1;
    if (o.t[m] <= tSource) a = m; else b = m - 1;
  }
  return { trace: o.trace, i: o.debut + a };
}

/** Chiffres de toutes les traces : { distance (m), denivele (m), haut (m) }. */
export function chiffres(gps) {
  let distance = 0, denivele = 0, haut = -Infinity;
  for (const tr of gps ? gps.traces : []) {
    if (!tr.dist.length) continue;
    distance += tr.dist[tr.dist.length - 1];
    denivele += tr.deniv[tr.deniv.length - 1];
    haut = Math.max(haut, ...tr.alt);
  }
  return { distance, denivele, haut: Number.isFinite(haut) ? haut : null };
}

export const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`).replace('.', ',');
export const metres = (a) => `${String(Math.round(a)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f')} m`;
