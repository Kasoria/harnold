# Harnold

Eigenes AI Agent Harness. Orientierung: Claude / Claude Desktop / Claude Code.

PRD: `docs/PRD.md` · UI-Richtung: `docs/UI.md` (verbindlich für alle Screens)

## Regeln

- **Kürze:** Antworten und Docs (PRD, Specs etc.) so kurz wie möglich. Zusatzinfos/Kontext nur, wenn für das Verständnis nötig. So viel wie nötig, so wenig wie möglich.
- Sprache: Deutsch.
- **Alle Sprachen mitdenken:** Jeder neue/geänderte Nutzertext in `t("…")` bekommt sofort die englische Übersetzung (UI: `apps/ui/src/i18n/en.ts`, Core: `packages/core/src/i18n-en.ts`). Bei weiteren Sprachen ebenso.

## Releases (Desktop-App, Auto-Update)

- Installierte Apps holen Updates aus GitHub Releases. Nach Änderungen gehört ein Release dazu – aber gebündelt: erst wenn mehrere Commits/Features zusammengekommen sind, nicht nach jeder Kleinigkeit.
- Wenn sich genug angesammelt hat: Release vorschlagen und auf Ja warten (nie ungefragt veröffentlichen).
- Jedes veröffentlichte Release baut automatisch das Server-Image (`.github/workflows/docker-image.yml` → `ghcr.io/kasoria/harnold`); Docker-Server melden in der UI „Update verfügbar“ und holen es per Knopf. Der Tag liegt vor dem Versions-Commit, deshalb bekommt das Image die Version per Build-Argument aus dem Tag (`HARNOLD_VERSION`); wird ein Release nachgebaut: `gh workflow run docker-image.yml -f version=x.y.z`.
- Ablauf: pushen, dann `pnpm --filter @harnold/desktop release <x.y.z> "Was ist neu"` (Version erhöhen, Notes kurz auf Deutsch), danach Versions-Commit pushen.
- Signatur-Key: `~/.tauri/harnold.key` – nie ins Repo.
- macOS-Codesignatur: Das Release signiert mit fester Identität (Developer ID, sonst Apple Development aus dem Schlüsselbund; `HARNOLD_SIGNING_IDENTITY=none` schaltet ab). Ohne feste Signatur erkennt macOS nach jedem Update die Ordner-Freigaben (TCC) nicht wieder und fragt neu.
- macOS-Notarisierung: Zugangsdaten aus `~/.tauri/harnold-notary.env` (`APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH`); Tauri notarisiert und stapelt die App im Release dann selbst. Fehlen die Daten, wird nur signiert (Gatekeeper-Warnung für andere Nutzer).
- Versionen nach SemVer (`MAJOR.MINOR.PATCH`):
  - PATCH: nur Fehlerbehebungen.
  - MINOR: neue Funktionen; PATCH beginnt wieder bei 0.
  - MAJOR: inkompatible Änderungen, z. B. Daten oder Einstellungen, die eine Migration ohne Rückweg brauchen.
  - Vor 1.0: Brüche erhöhen MINOR.
  - 1.0.0 erst, wenn die App stabil für andere nutzbar ist.
  - Nie eine veröffentlichte Version neu vergeben.
