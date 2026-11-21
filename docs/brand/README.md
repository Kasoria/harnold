# Harnold – Logo

**Idee:** Von der Seite ist eine Hantel ein H. Unter dem Gewicht biegt sich die Stange zu einem Grinsen: Kraft (Arnold) plus Selbstironie, ohne Gesicht.

## Dateien

| Datei | Wofür |
|---|---|
| `logo/harnold-horizontal-color.svg` | Standard-Logo (Blau + Schwarz) |
| `logo/harnold-stacked-color.svg` | Gestapelt, für quadratische Flächen |
| `logo/harnold-symbol-color.svg` | Nur Symbol (Avatar, Sticker) |
| `logo/harnold-symbol-small.svg` | Kleingrößen-Schnitt ≤ 24 px (dickere Stange, breitere Scheiben) |
| `logo/harnold-wordmark.svg` | Nur Schriftzug |
| `logo/variants/` | Schwarz, Weiß, Blau einfarbig; App-Icon, Favicon, Web-Icons (`head-snippet.html`, `site.webmanifest`) |
| `presentation.html`, `slides/` | Präsentation mit Mockups |
| `concepts/` | Verworfene Konzepte (Archiv) |

## Farben

| Name | HEX | RGB | Einsatz |
|---|---|---|---|
| Harnold-Blau | `#0F4BF7` | 15 75 247 | Symbol, App-Icon (= `--primary` der UI) |
| Tinte | `#121210` | 18 18 16 | Schriftzug, einfarbig |
| Papier | `#FAFAF9` | 250 250 249 | Hintergrund |

Weiß auf Blau: Kontrast ca. 6,2:1 (AA). Druck: CMYK ca. 94/70/0/3, Pantone vor Druck abmustern.

## Regeln

- **Schutzzone:** rundum eine Scheibenbreite des Symbols.
- **Mindestgröße:** Symbol 16 px (ab ≤ 24 px den Kleingrößen-Schnitt nehmen), horizontales Logo 96 px breit.
- **Hintergründe:** hell → Farbversion; dunkel oder Blau → weiße Version; Fotos nur auf ruhigen Flächen.
- **Wortmarke:** eigene Konstruktion aus Pfaden (gleiche Strichstärke, runde Enden), keine Schrift nachsetzen. UI-Schrift bleibt System/Inter.
- **Nicht:** verzerren, drehen, Stange gerade biegen, Farben tauschen (Schriftzug blau, Symbol schwarz in der Farbversion), Effekte/Schatten/Verläufe, Arnold-Gesicht hinzufügen.

## Offen

- Markenrecherche (DPMA/EUIPO, Bildersuche) vor öffentlichem Launch.
- Einbinden: Favicon/App-Icon in `apps/ui` (Snippet in `logo/variants/head-snippet.html`), Tauri-Icons aus `icon-512.png` generieren.
