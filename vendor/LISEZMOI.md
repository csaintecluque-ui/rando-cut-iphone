# Bibliothèques embarquées

Elles sont copiées ici (et pas chargées depuis internet) pour que l'appli marche hors ligne et que rien ne sorte du téléphone.

| Fichier | Rôle | Origine | Licence |
|---|---|---|---|
| `mediabunny.js` | Lire les vidéos (MP4, MOV), décoder et encoder avec le matériel de l'iPhone (WebCodecs), écrire le film MP4 | [Mediabunny](https://github.com/Vanilagy/mediabunny) 1.66.2 (npm `mediabunny`) | MPL-2.0 (`licences/MPL-2.0.txt`) |
| `aac.js` | Encodeur AAC de secours, chargé **seulement** si le navigateur n'en a pas (Safari 26 en a un) | `@mediabunny/aac-encoder` 1.66.2, qui contient l'encodeur AAC de [FFmpeg](https://ffmpeg.org/) compilé en WebAssembly | MPL-2.0 ; partie FFmpeg : LGPL 2.1 (`licences/FFmpeg-*`) |

Les en-têtes de licence de Mediabunny sont gardés dans les fichiers (obligatoire). Le code n'est pas modifié,
seulement regroupé en un fichier.

## Refaire ces fichiers (nouvelle version de Mediabunny)

Dans un dossier de travail (pas dans le dépôt), avec Node.js :

```bash
npm install mediabunny @mediabunny/aac-encoder esbuild
cp <dépôt>/iphone/outils/entree-mediabunny.js <dépôt>/iphone/outils/entree-aac.js .
npx esbuild entree-mediabunny.js --bundle --format=esm --minify --legal-comments=inline --outfile=mediabunny.js
npx esbuild entree-aac.js --bundle --format=esm --minify --legal-comments=inline --external:mediabunny --outfile=aac.js
sed -i 's/from"mediabunny"/from".\/mediabunny.js"/g' aac.js
```

Puis copier `mediabunny.js` et `aac.js` ici, changer `VERSION` dans `sw.js`, et relancer les tests
(`npm test` et `tests/bout-en-bout.mjs`).
