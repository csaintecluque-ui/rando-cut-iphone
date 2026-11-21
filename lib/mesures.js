// Mesures seconde par seconde, comme montage/analyse.py sur le PC :
// image (luminosité, netteté, nouveauté) sur des images clés réduites à 256×144,
// son (volume en dB, part de la voix entre 300 et 3400 Hz) sur le son ramené à 16 kHz.

export const L = 256;
export const H = 144;
export const TAUX_SON = 16000;

/** Image RGBA (ImageData.data) → niveaux de gris (0-255). */
export function enGris(rgba, n = L * H) {
  const g = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  return g;
}

/** { lum, nettete, petit } d'une image en gris L×H. `petit` : moyenne par case 32×18 (pour la nouveauté). */
export function statsImage(g, l = L, h = H) {
  let somme = 0;
  for (let i = 0; i < g.length; i++) somme += g[i];
  const lum = somme / g.length;
  // variance du laplacien (bords exclus)
  let s1 = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < l - 1; x++) {
      const i = y * l + x;
      const v = 4 * g[i] - g[i - l] - g[i + l] - g[i - 1] - g[i + 1];
      s1 += v; s2 += v * v; n++;
    }
  }
  const moy = s1 / n;
  const nettete = s2 / n - moy * moy;
  const petit = new Float32Array(32 * 18);
  const cx = l / 32, cy = h / 18;
  for (let y = 0; y < h; y++) {
    const py = Math.floor(y / cy);
    for (let x = 0; x < l; x++) petit[py * 32 + Math.floor(x / cx)] += g[y * l + x];
  }
  for (let i = 0; i < petit.length; i++) petit[i] /= cx * cy;
  return { lum, nettete, petit };
}

/** Différence moyenne entre deux images « petites » (0 pour la première). */
export function nouveaute(avant, apres) {
  if (!avant) return 0;
  let s = 0;
  for (let i = 0; i < apres.length; i++) s += Math.abs(apres[i] - avant[i]);
  return s / apres.length;
}

/** Valeurs mesurées à des instants quelconques → une valeur par seconde (au milieu de chaque seconde). */
export function parSeconde(temps, valeurs, nSec) {
  if (!valeurs.length) return new Array(nSec).fill(0);
  if (valeurs.length === 1) return new Array(nSec).fill(valeurs[0]);
  const res = [];
  let j = 0;
  for (let s = 0; s < nSec; s++) {
    const t = s + 0.5;
    if (t <= temps[0]) { res.push(valeurs[0]); continue; }
    if (t >= temps[temps.length - 1]) { res.push(valeurs[valeurs.length - 1]); continue; }
    while (j < temps.length - 2 && temps[j + 1] < t) j++;
    const a = temps[j], b = temps[j + 1];
    const f = b > a ? (t - a) / (b - a) : 0;
    res.push(valeurs[j] + f * (valeurs[j + 1] - valeurs[j]));
  }
  return res;
}

// ------------------------------------------------------------------ son

/** Transformée de Fourier en place (taille puissance de 2). */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const N_FFT = 16384;
let fenetre = null;

/** Son mono à 16 kHz → { db, voix } par seconde. */
export function mesuresSon(son, nSec) {
  const db = new Array(nSec).fill(-90);
  const voix = new Array(nSec).fill(0);
  if (!fenetre) {
    fenetre = new Float64Array(TAUX_SON);
    for (let i = 0; i < TAUX_SON; i++) fenetre[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (TAUX_SON - 1));
  }
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
  const pasHz = TAUX_SON / N_FFT;
  const kMin = Math.ceil(60 / pasHz), k300 = Math.ceil(300 / pasHz), k3400 = Math.floor(3400 / pasHz);
  const nMax = Math.min(nSec, Math.floor(son.length / TAUX_SON));
  for (let s = 0; s < nMax; s++) {
    let carre = 0;
    re.fill(0); im.fill(0);
    for (let i = 0; i < TAUX_SON; i++) {
      const v = son[s * TAUX_SON + i];
      carre += v * v;
      re[i] = v * fenetre[i];
    }
    db[s] = 20 * Math.log10(Math.sqrt(carre / TAUX_SON) + 1e-9);
    fft(re, im);
    let total = 0, bande = 0;
    for (let k = kMin; k <= N_FFT / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      total += p;
      if (k >= k300 && k <= k3400) bande += p;
    }
    voix[s] = total > 0 ? bande / total : 0;
  }
  return { db, voix };
}

/**
 * Accumule le son d'une vidéo, morceau par morceau, en mono 16 kHz (moyenne des canaux, puis moyenne
 * des échantillons qui tombent dans chaque case de 1/16000 s).
 */
export class Reechantillonneur {
  constructor(dureeS) {
    this.son = new Float32Array(Math.ceil(dureeS * TAUX_SON) + TAUX_SON);
    this.compte = new Uint16Array(this.son.length);
  }

  /** canaux : tableaux Float32Array ; debut : temps (s) du premier échantillon ; taux : échantillons/s. */
  ajouter(canaux, debut, taux) {
    const n = canaux[0].length;
    const nc = canaux.length;
    for (let i = 0; i < n; i++) {
      const k = Math.floor((debut + i / taux) * TAUX_SON);
      if (k < 0 || k >= this.son.length) continue;
      let v = 0;
      for (let c = 0; c < nc; c++) v += canaux[c][i];
      this.son[k] += v / nc;
      if (this.compte[k] < 65535) this.compte[k]++;
    }
  }

  resultat() {
    for (let k = 0; k < this.son.length; k++) if (this.compte[k] > 1) this.son[k] /= this.compte[k];
    return this.son;
  }
}
