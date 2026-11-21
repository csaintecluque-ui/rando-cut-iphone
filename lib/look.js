// Ambiance de couleurs (« looks ») appliquée à chaque image par la carte graphique (WebGL) : mêmes formules que
// les looks du PC (montage/couleur.py). Safari ne sait pas filtrer une image 2D (pas de ctx.filter).

import { LOOKS } from './propositions.js';

const SOMMETS = `
attribute vec2 p;
varying vec2 v;
void main() { v = vec2((p.x + 1.0) / 2.0, (1.0 - p.y) / 2.0); gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAGMENTS = `
precision mediump float;
varying vec2 v;
uniform sampler2D image;
uniform int look;
float luma(vec3 x) { return dot(x, vec3(0.2126, 0.7152, 0.0722)); }
vec3 courbeS(vec3 x, float f) { return x + f * (x - 0.5) * (1.0 - abs(2.0 * x - 1.0)); }
void main() {
  vec3 x = texture2D(image, v).rgb;
  vec3 l = vec3(luma(x));
  vec3 r = x;
  if (look == 0) r = courbeS(l + (x - l) * 1.35, 0.25);                                          // Vif
  else if (look == 1) r = x * vec3(1.07, 1.01, 0.88) + vec3(0.015, 0.005, 0.0);                   // Chaud
  else if (look == 2) r = courbeS(x + (vec3(1.0, 0.55, 0.15) - 0.5) * 0.10 * (l.x - 0.45) * 2.5, 0.2); // Cinéma
  else if (look == 3) r = x * vec3(0.92, 1.0, 1.08);                                              // Froid
  else if (look == 4) r = 0.07 + 0.88 * (l + (x - l) * 0.75) * vec3(1.05, 1.0, 0.86);            // Rétro
  else if (look == 5) r = courbeS(l, 0.3);                                                        // Noir et blanc
  gl_FragColor = vec4(clamp(r, 0.0, 1.0), 1.0);
}`;

const ORDRE = ['Vif', 'Chaud', 'Cinéma', 'Froid', 'Rétro', 'Noir et blanc'];
if (ORDRE.join() !== LOOKS.join()) throw new Error('look.js : liste des looks à mettre à jour');

/** Vrai si l'appareil sait appliquer une ambiance (WebGL sur une toile hors écran). */
export function lookDisponible() {
  try {
    return !!new OffscreenCanvas(4, 4).getContext('webgl');
  } catch {
    return false;
  }
}

/** Prépare l'ambiance `nom` pour des images W×H. Renvoie { appliquer(toile) → toile filtrée } ou null. */
export function creerLook(nom, W, H) {
  const n = ORDRE.indexOf(nom);
  if (n < 0) return null;
  let gl;
  try {
    const toile = new OffscreenCanvas(W, H);
    gl = toile.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) return null;
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, SOMMETS));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAGMENTS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const tampon = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, tampon);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const p = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(p);
    gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    for (const [k, val] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, val);
    gl.uniform1i(gl.getUniformLocation(prog, 'look'), n);
    gl.uniform1i(gl.getUniformLocation(prog, 'image'), 0);
    gl.viewport(0, 0, W, H);
    return {
      appliquer(source) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return toile;
      },
    };
  } catch (e) {
    console.warn('Ambiance de couleurs indisponible :', e);
    return null;
  }
}
