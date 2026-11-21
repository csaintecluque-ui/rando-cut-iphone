// Ce qui est dessiné par-dessus les images du film : légendes, titres des journées, carte du parcours,
// profil d'altitude, générique de fin. Même style que le PC (montage/carte.py, montage/profil.py).

import { km, metres } from './telemetrie.js';

export const ACCENT = '#FF8A1F';
export const MARGE_X = 0.06, MARGE_Y = 0.08;   // comme montage/textes.py
const ECART_MIN = 40;                           // m : sur le plat, la courbe ne fait pas des montagnes
const police = (taille, poids = 600) => `${poids} ${Math.round(taille)}px -apple-system, "SF Pro Display", "Helvetica Neue", Arial, sans-serif`;

/** Opacité d'un texte affiché à partir de `debut` pendant `duree` s (apparition et disparition en douceur). */
export function opacite(t, debut, duree = 3.5, fondu = 0.4) {
  const dt = t - debut;
  if (dt < 0 || dt > duree) return 0;
  return Math.min(1, dt / fondu, (duree - dt) / fondu);
}

function texteOmbre(ctx, texte, x, y, taille) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.65)';
  ctx.shadowBlur = taille * 0.25;
  ctx.shadowOffsetY = taille * 0.04;
  ctx.fillText(texte, x, y);
  ctx.restore();
}

/** Légende (date / heure) en bas à gauche, au-dessus de `bas` (px depuis le haut). */
export function dessinerLegende(ctx, W, H, texte, a, bas = H * (1 - MARGE_Y)) {
  if (a <= 0) return;
  const taille = Math.min(W, H) * 0.042;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.font = police(taille, 600);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = '#FFFFFF';
  texteOmbre(ctx, texte, W * MARGE_X, bas, taille);
  ctx.restore();
}

/** Titre de journée, au centre (comme le titre du film : jamais sous la carte). */
export function dessinerJour(ctx, W, H, texte, a) {
  if (a <= 0) return;
  const taille = Math.min(W, H) * 0.07;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFF4E0';
  let t = taille;
  ctx.font = police(t);
  while (ctx.measureText(texte).width > W * 0.88 && t > taille * 0.4) { t *= 0.92; ctx.font = police(t); }
  texteOmbre(ctx, texte, W / 2, H / 2, t);
  ctx.restore();
}

/** Prépare une trace pour la carte : points ramenés dans un carré 0-1 (le nord en haut) et échelle. */
export function preparerCarte(trace) {
  const n = trace.lat.length;
  const lat0 = trace.lat.reduce((s, v) => s + v, 0) / n;
  const lon0 = trace.lon.reduce((s, v) => s + v, 0) / n;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xs = trace.lon.map((v) => (v - lon0) * k), ys = trace.lat.map((v) => v - lat0);
  const etendue = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 150 / 111320);
  const mx = (Math.max(...xs) + Math.min(...xs)) / 2, my = (Math.max(...ys) + Math.min(...ys)) / 2;
  const px = xs.map((x) => 0.5 + ((x - mx) / etendue) * 0.8);
  const py = ys.map((y) => 0.5 - ((y - my) / etendue) * 0.8);
  let echelle = 10;
  for (const d of [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]) if (d <= etendue * 111320 * 0.3) echelle = d;
  return { px, py, echelle, longueurEchelle: (echelle / 111320 / etendue) * 0.8, pas: Math.max(1, Math.ceil(n / 600)) };
}

function chemin(ctx, c, x, y, S, a, b) {
  ctx.beginPath();
  ctx.moveTo(x + c.px[a] * S, y + c.py[a] * S);
  for (let j = a + c.pas; j < b; j += c.pas) ctx.lineTo(x + c.px[j] * S, y + c.py[j] * S);
  ctx.lineTo(x + c.px[b] * S, y + c.py[b] * S);
}

/** Mini-carte en haut à droite : le chemin du jour, la partie faite en couleur, le point du moment. */
export function dessinerCarte(ctx, W, H, trace, carte, i, a) {
  if (a <= 0) return;
  const S = Math.min(W, H) * (W > H ? 0.3 : 0.36);
  const txt = Math.max(14, S * 0.085);
  const x = W * (1 - MARGE_X) - S, y = H * MARGE_Y * (W > H ? 1 : 0.6);
  const fin = carte.px.length - 1;
  i = Math.max(0, Math.min(fin, i));
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.beginPath();
  ctx.roundRect(x, y, S, S + txt * 1.7, S * 0.05);
  ctx.fill();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  chemin(ctx, carte, x, y, S, 0, fin);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = S / 45; ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = S / 90; ctx.stroke();
  if (i > 0) {
    chemin(ctx, carte, x, y, S, 0, i);
    ctx.strokeStyle = ACCENT; ctx.lineWidth = S / 60; ctx.stroke();
  }
  // départ (vert), position (blanc cerclé de couleur)
  ctx.fillStyle = '#3DDC84';
  ctx.beginPath(); ctx.arc(x + carte.px[0] * S, y + carte.py[0] * S, S / 55, 0, 2 * Math.PI); ctx.fill();
  ctx.fillStyle = '#FFFFFF'; ctx.strokeStyle = ACCENT; ctx.lineWidth = S / 85;
  ctx.beginPath(); ctx.arc(x + carte.px[i] * S, y + carte.py[i] * S, S / 38, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
  // échelle et nord
  const bx = x + S * 0.08, by = y + S * 0.93, lg = carte.longueurEchelle * S;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = Math.max(2, S / 150); ctx.lineCap = 'butt';
  ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + lg, by); ctx.stroke();
  ctx.font = police(Math.max(11, S * 0.045), 500); ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillText(carte.echelle >= 1000 ? `${carte.echelle / 1000} km` : `${carte.echelle} m`, bx + lg + S * 0.02, by);
  const nx = x + S * 0.92, ny = y + S * 0.1;
  ctx.beginPath(); ctx.moveTo(nx, ny - S * 0.06); ctx.lineTo(nx - S * 0.022, ny - S * 0.005); ctx.lineTo(nx + S * 0.022, ny - S * 0.005); ctx.fill();
  ctx.textAlign = 'center'; ctx.fillText('N', nx, ny + S * 0.03);
  // distance parcourue et altitude du moment
  ctx.font = police(txt, 600); ctx.fillStyle = '#FFFFFF';
  ctx.fillText(`${km(trace.dist[i])} · ${metres(trace.alt[i])}`, x + S / 2, y + S + txt * 0.75);
  ctx.restore();
}

/** Panneau du profil d'altitude (en bas à droite en paysage, en bas sur toute la largeur en vertical). */
export function cadreProfil(W, H) {
  const S = W > H ? W * 0.4 : W * (1 - 2 * MARGE_X);
  const G = S * (W > H ? 0.22 : 0.26);
  const h = G + S * 0.13;
  return { x: W * (1 - MARGE_X) - S, y: H * (1 - MARGE_Y) - h, w: S, h, G };
}

export function dessinerProfil(ctx, W, H, trace, i, a) {
  if (a <= 0) return;
  const n = trace.alt.length;
  if (n < 2) return;
  const { x, y, w, h, G } = cadreProfil(W, H);
  i = Math.max(0, Math.min(n - 1, i));
  const total = trace.dist[n - 1] - trace.dist[0];
  const absc = total > 200 ? trace.dist.map((d) => d - trace.dist[0]) : trace.alt.map((_, k) => k);
  let bas = Math.min(...trace.alt), haut = Math.max(...trace.alt);
  if (haut - bas < ECART_MIN) { const m = (haut + bas) / 2; bas = m - ECART_MIN / 2; haut = m + ECART_MIN / 2; }
  const tp = Math.max(11, w * 0.028);
  const marge = w * 0.03, etiq = tp * 4.2;
  const gx0 = x + marge + etiq, gx1 = x + w - marge, gy0 = y + marge, gy1 = y + marge + G;
  const a1 = absc[n - 1] || 1;
  const px = (k) => gx0 + (absc[k] / a1) * (gx1 - gx0);
  const py = (k) => gy1 - ((trace.alt[k] - bas) / (haut - bas)) * (gy1 - gy0);
  const pas = Math.max(1, Math.ceil(n / 500));
  const ligne = (jusqua) => {
    ctx.beginPath();
    ctx.moveTo(px(0), py(0));
    for (let k = pas; k < jusqua; k += pas) ctx.lineTo(px(k), py(k));
    ctx.lineTo(px(jusqua), py(jusqua));
  };
  const aire = (jusqua) => { ligne(jusqua); ctx.lineTo(px(jusqua), gy1); ctx.lineTo(px(0), gy1); ctx.closePath(); };
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.beginPath(); ctx.roundRect(x, y, w, h, w * 0.025); ctx.fill();
  aire(n - 1); ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fill();
  ligne(n - 1); ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = Math.max(1.5, w / 400); ctx.lineJoin = 'round'; ctx.stroke();
  if (i > 0) {
    const degrade = ctx.createLinearGradient(0, gy0, 0, gy1);
    degrade.addColorStop(0, 'rgba(255,138,31,0.67)');
    degrade.addColorStop(1, 'rgba(255,138,31,0.16)');
    aire(i); ctx.fillStyle = degrade; ctx.fill();
    ligne(i); ctx.strokeStyle = ACCENT; ctx.lineWidth = Math.max(2, w / 220); ctx.stroke();
  }
  ctx.setLineDash([w / 120, w / 120]);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = Math.max(1, w / 700);
  ctx.beginPath(); ctx.moveTo(px(i), gy0); ctx.lineTo(px(i), gy1); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#FFFFFF'; ctx.strokeStyle = ACCENT; ctx.lineWidth = w / 150;
  ctx.beginPath(); ctx.arc(px(i), py(i), w / 70, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
  ctx.font = police(tp, 500); ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillText(metres(Math.max(...trace.alt)), gx0 - marge * 0.4, gy0);
  ctx.fillText(metres(Math.min(...trace.alt)), gx0 - marge * 0.4, gy1);
  ctx.textAlign = 'left'; ctx.fillText('Départ', gx0, gy1 + tp * 0.9);
  if (total > 200) { ctx.textAlign = 'right'; ctx.fillText(km(total), gx1, gy1 + tp * 0.9); }
  ctx.restore();
}

/** Générique de fin : fond noir, titre, période, chiffres de la journée (qui apparaissent l'un après l'autre). */
export function dessinerGenerique(ctx, W, H, lignes, dt, a) {
  if (a <= 0) return;
  const base = Math.min(W, H);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const styles = [[base * 0.075, 600, '#FFF4E0'], [base * 0.04, 400, '#EAD9B8'], [base * 0.036, 600, ACCENT]];
  const visibles = lignes.filter(Boolean);
  const hauteur = visibles.length * base * 0.1;
  visibles.forEach((texte, k) => {
    const [taille, poids, couleur] = styles[Math.min(k, styles.length - 1)];
    ctx.globalAlpha = a * Math.max(0, Math.min(1, (dt - 0.3 - 0.45 * k) / 0.5));
    let t = taille;
    ctx.font = police(t, poids);
    while (ctx.measureText(texte).width > W * 0.88 && t > taille * 0.4) { t *= 0.92; ctx.font = police(t, poids); }
    ctx.fillStyle = couleur;
    ctx.fillText(texte, W / 2, H / 2 - hauteur / 2 + base * 0.05 + k * base * 0.1);
  });
  ctx.restore();
}
