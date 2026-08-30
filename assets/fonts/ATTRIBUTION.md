# Bundled fonts

Both families ship with the app (no runtime fetching) under the
**SIL Open Font License 1.1** — the full text is in `OFL.txt`.

| Family | Files | Copyright |
|---|---|---|
| Noto Kufi Arabic | `NotoKufiArabic-{400,500,600,700}.ttf` | Copyright The Noto Project Authors (https://github.com/notofonts/kufi) |
| IBM Plex Sans Arabic | `IBMPlexSansArabic-{300,400,500,600,700}.ttf` | Copyright 2017 IBM Corp. (https://github.com/IBM/plex) |

Static instances were taken from the Google Fonts CDN (`fonts.gstatic.com`)
rather than the variable sources: Flutter maps `FontWeight` to a declared
`@font-face` weight, so one static file per weight gives the exact weights the
design calls for without relying on variable-axis support.
