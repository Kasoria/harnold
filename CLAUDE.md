# Harnold

Eigenes AI Agent Harness. Orientierung: Claude / Claude Desktop / Claude Code.

PRD: `docs/PRD.md` · UI-Richtung: `docs/UI.md` (verbindlich für alle Screens)

## Regeln

- **Kürze:** Antworten und Docs (PRD, Specs etc.) so kurz wie möglich. Zusatzinfos/Kontext nur, wenn für das Verständnis nötig. So viel wie nötig, so wenig wie möglich.
- Sprache: Deutsch.

## Releases (Desktop-App, Auto-Update)

- Installierte Apps holen Updates aus GitHub Releases. Nach Änderungen gehört ein Release dazu – aber gebündelt: erst wenn mehrere Commits/Features zusammengekommen sind, nicht nach jeder Kleinigkeit.
- Wenn sich genug angesammelt hat: Release vorschlagen und auf Ja warten (nie ungefragt veröffentlichen).
- Ablauf: pushen, dann `pnpm --filter @harnold/desktop release <x.y.z> "Was ist neu"` (Version erhöhen, Notes kurz auf Deutsch), danach Versions-Commit pushen.
- Signatur-Key: `~/.tauri/harnold.key` – nie ins Repo.
- Versionen nach SemVer (`MAJOR.MINOR.PATCH`):
  - PATCH: nur Fehlerbehebungen.
  - MINOR: neue Funktionen; PATCH beginnt wieder bei 0.
  - MAJOR: inkompatible Änderungen, z. B. Daten oder Einstellungen, die eine Migration ohne Rückweg brauchen.
  - Vor 1.0: Brüche erhöhen MINOR.
  - 1.0.0 erst, wenn die App stabil für andere nutzbar ist.
  - Nie eine veröffentlichte Version neu vergeben.
