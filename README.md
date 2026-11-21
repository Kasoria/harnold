# Harnold

Open-Source AI Agent Harness: Chat, Code und Design in einem Workspace. Lizenz: MIT.

## Struktur

- `packages/core` – Core (Node/TS): API, WebSocket, Agent-Runtime (Claude Agent SDK), SQLite
- `apps/ui` – UI (React/Vite)
- `docs/PRD.md` – Anforderungen

## Starten

```bash
pnpm install
pnpm dev:core   # Core auf :4317
pnpm dev:ui     # UI auf :5317
```

Server-Modus: `pnpm --filter @harnold/ui build`, dann `pnpm --filter @harnold/core start` (liefert UI mit aus).

## Konfiguration (env)

| Variable | Standard | Zweck |
|---|---|---|
| `HARNOLD_DATA_DIR` | `~/.harnold` | DB + Daten |
| `HARNOLD_PROJECTS_DIR` | `~/.harnold/projects` | Ordner für neue Projekte |
| `HARNOLD_HOST` / `HARNOLD_PORT` | `127.0.0.1` / `4317` | Bind-Adresse |
| `HARNOLD_TOKEN` | – | Zugriffstoken (Pflicht im Server-Betrieb) |
| `HARNOLD_MODEL` | SDK-Standard | Modell |

Auth zu Claude: beim ersten Start Onboarding, sonst Einstellungen → Claude. Claude-Konto (Pro/Max/Team/Console, geteilt mit `claude` auf dem Rechner, Anmeldung per Code) oder API-Key (verschlüsselt gespeichert; Fallback `ANTHROPIC_API_KEY`).

## Tasks & Channels

- Tasks: Cron-Zeitplan, laufen im Core. Jeder Lauf = Session im Projekt, optional Ergebnis an einen Channel.
- Channels: Telegram, Discord, Slack (Socket Mode), E-Mail (IMAP/SMTP). Keine öffentliche URL nötig. Secrets verschlüsselt (`~/.harnold/secret.key`).
- Im Chat: `/neu` startet eine neue Session. Freigaben per Button bzw. „ja“/„nein“.

## Voice

- Einstellungen → Voice: Spracherkennung (OpenAI, ElevenLabs, Deepgram, whisper.cpp) und Sprachausgabe (OpenAI, ElevenLabs, Piper).
- App: Mikrofon im Composer → Transkript editierbar im Textfeld. „Vorlesen“ je Antwort oder automatisch.
- Channels: Sprachnachrichten werden transkribiert; Sprachantwort je Channel einstellbar. Lokale Provider und Telegram-Sprachnachrichten brauchen `ffmpeg`.

## Memory

- Markdown ist die Wahrheit: Workspace-Memory (`~/.harnold/memory`, oder ein eigener Ordner bzw. Obsidian-Vault) und Projekt-Memory (`<projekt>/memory/`).
- `HARNOLD.md` (im Projekt-Root bzw. Workspace-Memory) wird bei jedem Durchlauf als Anweisung geladen.
- SQLite-Index (Volltext, optional Vektoren via OpenAI/Ollama), aktualisiert sich bei Dateiänderungen und lässt sich jederzeit neu aufbauen.
- Agent-Tools: `memory_search`, `memory_read`, `memory_write`, `memory_list`. In der App: Sidebar → Memory.

## Integrationen

- MCP-Server (lokal/stdio, HTTP, SSE) je Workspace oder Projekt; Projekt überschreibt gleichnamige. Env/Header verschlüsselt. „Testen“ verbindet und listet die Tools. Import per JSON (Format Claude Desktop/Code).
- Zusätzlich lädt der Agent wie Claude Code `.mcp.json` und `~/.claude.json`.
- Skills im Claude-Format (`SKILL.md`) aus `~/.claude/skills` und `<projekt>/.claude/skills`, einzeln abschaltbar.

## Design Systems

- Eigener Screen. Systeme liegen workspace-weit unter `~/.harnold/design-systems/<id>/` (`tokens.json` mit Referenzen `{color.accent}` und `$modes.dark` → `tokens.css` automatisch; `components/`).
- Mit beliebig vielen Projekten und Sessions verknüpfbar; je Ziel ein System, Session vor Projekt.
- Der Agent bekommt das verknüpfte System (Pfad, Tokens) und Zugriff auf den Ordner; Entwürfe binden es über `_harnold/design-systems/<id>/tokens.css` ein (virtuell in der Preview).
- Alte projektlokale `design-system/`-Ordner werden einmalig importiert und verknüpft.

## Bild-Generierung

- Einstellungen → Bilder: Google Gemini (Standard `gemini-nano-banana-2.1`, Key oder `GEMINI_API_KEY`) oder OpenAI (`gpt-image-1`).
- Canvas: ✦ in der Werkzeugleiste oder `G` → Prompt, Seitenverhältnis, Anzahl, ausgewähltes Bild als Vorlage. Ergebnis in `assets/generated/` und in der Bildmitte.
- Agent-Tool `generate_image` (fragt vor jedem Aufruf um Freigabe, da kostenpflichtig); Ergebnisse landen im Frame „Generiert“.
