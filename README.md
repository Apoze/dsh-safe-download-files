# dsh-safe-download-files

Plugin local DeepSeek Harness exposant un outil modèle unique :

```text
download_files({ directory?, items: [{ url, file_name? }] })
```

- Télécharge uniquement des URL HTTP(S) publiques dans un sous-dossier du workspace.
- Réutilise les politiques anti-SSRF et le transport DNS-épinglé de `dsh-safe-web-fetch`.
- Revalide chaque redirection, limite tailles/durée/concurrence et n’envoie aucun credential.
- Vérifie le type réel, refuse les formats actifs/dangereux et ne remplace jamais un fichier existant.
- Publie les fichiers atomiquement et conserve les succès lorsqu’un autre élément échoue.

Formats : images raster, PDF, texte/Markdown/CSV/JSON/XML, audio et vidéo courants. Archives, Office, HTML, SVG, scripts, exécutables, WebAssembly et types inconnus sont refusés.

```sh
pnpm install --frozen-lockfile
pnpm test
```

Le dépôt est local et installé par lien dans le profil DSH Web.

