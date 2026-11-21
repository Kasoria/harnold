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

## Agent-Zugriff auf Harnold

Der Agent hat in jeder Session Tools (`harnold`) für alles in Harnold: Überblick, Projekte, andere Sessions lesen, Design Systems (anlegen, verknüpfen, Tokens/Dateien schreiben), Tasks (anlegen, ändern, starten, löschen), Channels und Integrationen. Lesen und Design-System-Änderungen laufen ohne Rückfrage, Tasks/Löschen/Skills über die Freigabe. API-Keys bleiben in den Einstellungen.

## Design Systems

- Eigener Screen. Systeme liegen workspace-weit unter `~/.harnold/design-systems/<id>/` (`tokens.json` mit Referenzen `{color.accent}` und `$modes.dark` → `tokens.css` automatisch; `components/`).
- Mit beliebig vielen Projekten und Sessions verknüpfbar; je Ziel ein System, Session vor Projekt.
- Der Agent bekommt das verknüpfte System (Pfad, Tokens) und Zugriff auf den Ordner; Entwürfe binden es über `_harnold/design-systems/<id>/tokens.css` ein (virtuell in der Preview).
- Alte projektlokale `design-system/`-Ordner werden einmalig importiert und verknüpft.

## Chat

- Menü (…): umbenennen (auch Doppelklick auf den Titel), in ein anderes Projekt/eine andere Umgebung verschieben (Agent-Kontext kommt mit), Umgebung des Projekts, Kontext leeren, löschen.
- Slash-Commands: `/clear`, `/new`, `/rename`, `/move`, `/model`, `/plan` (Harnold) plus die des Agents (`/compact`, `/context`, `/init`, `/review`, eigene Commands und Skills).
- Agent-Tools: `session_move`, `session_rename`.

## Heute

Startansicht: wartende Freigaben, laufende Sessions, Task-Ergebnisse (24 h), zuletzt genutzte Sessions.

## Modell

Einstellungen → Claude → Modell (Standard Opus 5.5). Umgebung und Auswahl im Chat bzw. Task können es überschreiben; angezeigt wird immer das tatsächliche Modell.

## Umgebungen

- Eigener Screen. Eine Umgebung bündelt beliebige Konten (GitHub, GitLab, Vercel, Netlify, Cloudflare, Supabase, AWS, Google Cloud, Fly.io, Railway, Render, npm, Expo, Stripe, Sentry, OpenAI, Gemini, Linear – Katalog in `environment-providers.ts`), Git-Identität, SSH-Key, KI und freie Variablen (verschlüsselt). Jedes Projekt gehört zu höchstens einer.
- „Vom Rechner übernehmen“ bzw. im Chat „mach aus meinen aktuellen Anmeldungen eine Umgebung“: liest gh-Token, CLI-Logins, passende Env-Variablen und git-Identität im Core (Tokens laufen nicht durch den Chat). Agent-Tools `environment_import_current`, `environment_save`, `environment_check`, `environment_delete` (Änderungen mit Freigabe).
- Jeder Agent-Durchlauf im Projekt (auch Tasks, Channels) läuft mit diesen Werten als Env-Variablen (z. B. `GH_TOKEN`, `VERCEL_TOKEN`, `CLOUDFLARE_API_TOKEN`); dazu git über HTTPS per GitHub-Token (Keychain/gh-Helper werden übergangen), `GIT_AUTHOR_*`, `GIT_SSH_COMMAND`. Kein Umloggen in der CLI.
- KI je Umgebung: Claude-Zugang „Wie Einstellungen“, eigenes Claude-Konto (eigener Config-Ordner unter `~/.harnold/claude-accounts/<id>`, Skills/CLAUDE.md/Settings aus `~/.claude` verlinkt) oder eigener API-Key; dazu Standardmodell (Auswahl im Chat geht vor).
- Sidebar-Umschalter zeigt nur die Projekte einer Umgebung; neue Projekte landen darin. „Konten prüfen“ zeigt, wem die Tokens gehören.

## Bild-Generierung

- Einstellungen → Bilder: Google Gemini (Standard `gemini-nano-banana-2.1`, Key oder `GEMINI_API_KEY`) oder OpenAI (`gpt-image-1`).
- Canvas: ✦ in der Werkzeugleiste oder `G` → Prompt, Seitenverhältnis, Anzahl, ausgewähltes Bild als Vorlage. Ergebnis in `assets/generated/` und in der Bildmitte.
- Agent-Tool `generate_image` (fragt vor jedem Aufruf um Freigabe, da kostenpflichtig); Ergebnisse landen im Frame „Generiert“.
