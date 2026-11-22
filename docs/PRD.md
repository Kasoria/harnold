# Harnold – PRD

## Ziel

Open-Source AI Agent Harness. Design, Entwicklung und Kommunikation in **einem** Workspace – ohne Kopieren zwischen Apps/Tabs. Vorbild: Claude Desktop / Claude Code.

## Problem

Heute: Artifact erstellen → teilen → Claude Code öffnen → Ordner wählen → einfügen. Zu viele Schritte, Kontext geht verloren.

## Prinzipien

1. **Ein Projekt = ein Ordner.** Alles (Chat, Code, Designs, Assets, Memory) liegt im Projekt. Kein Export/Import zwischen Bereichen.
2. **Klare Bereiche, gemeinsamer Kontext.** Bereiche haben eigene UI und Zuständigkeit, referenzieren sich aber direkt (`@design/hero`, `@file/src/app.tsx`).
3. **Überall hostbar.** Gleicher Core lokal (Desktop) und auf Server (24/7).
4. **Offen.** Agent-Programm (Claude Code, Codex, eigener Harnold-Agent für jeden Anbieter mit OpenAI- oder Anthropic-Schnittstelle), Provider, Channels, Integrationen über Adapter. Nichts davon ist fest verdrahtet: Das Agent-Programm ist eine Einstellung (pro Workspace, pro Umgebung überschreibbar). Wording generisch, nicht nutzerspezifisch.

## Begriffe

| Begriff | Bedeutung |
|---|---|
| Workspace | Instanz von Harnold (lokal oder Server) |
| Projekt | Ordner + Einstellungen + Memory |
| Session | Ein Gesprächsverlauf mit dem Agent in einem Projekt |
| Artifact | Vom Agent erzeugte, live gerenderte Datei (HTML, React, SVG, MD) im Projekt |
| Canvas | Freie Fläche je Projekt für Entwürfe, Bilder, Varianten, Notizen |
| Design System | Tokens + Komponenten je Projekt, vom Agent automatisch genutzt |
| Task | Geplanter Agent-Lauf (Cron) |
| Channel | Externer Ein-/Ausgang (Telegram, Discord, Slack, E-Mail) |
| Integration | MCP-Server oder Skill |

## Bereiche

### 1. Chat
- Sessions je Projekt, Verlauf persistent.
- Agent mit Tools: Dateien, Shell, Web, MCP, Subagents.
- Permission-Modi wie Claude Code (fragen / Edits erlauben / alles erlauben / Plan).
- `@`-Referenzen auf Dateien, Artifacts, Canvas-Elemente, Sessions.
- Eingabe per Text, Datei, Bild, Voice.

### 2. Code
- Datei-Baum + Editor (Monaco) + Diff-Ansicht der Agent-Änderungen.
- Terminal.
- Git: Status, Branch, Commit, Worktrees für parallele Sessions.

### 3. Design
- **Live-Preview:** Artifacts und Dev-Server direkt im Workspace. Artifacts sind Dateien im Projekt (`/design/…`) → Code-Agent nutzt sie ohne Übergabe.
- **Canvas:** Entwürfe, Varianten nebeneinander, Bilder/Referenzen, Kommentare. Kommentar an Element → wird Agent-Aufgabe.
- **Design System:** `design-system/` mit Tokens (JSON) + Komponenten. Wird automatisch in Kontext geladen, Änderungen fließen in Preview + Code.
- **Bild-Generierung:** Provider-Adapter (z. B. Gemini Image). Ergebnis landet auf Canvas + in `assets/`.
- **„In Code übernehmen“:** Ein Klick an Artifact/Canvas-Element → Code-Agent setzt im Projekt um.

### 4. Tasks (Cron)
- Task = Prompt + Projekt + Zeitplan + Ausgabeziel (App-Benachrichtigung, Channel, Datei).
- Verlauf jeder Ausführung einsehbar, manuell auslösbar.
- Läuft im Core → 24/7 nur bei Server-Betrieb oder laufender Desktop-App.

### 5. Channels
- Adapter: Telegram, Discord, Slack, E-Mail (IMAP/SMTP). Weitere über Adapter-Interface.
- Routing: Channel/Chat → Projekt + Session (konfigurierbar).
- Antworten, Dateien, Bilder, Freigaben (Permission-Anfragen per Button) im Channel.
- Allowlist erlaubter Absender.

### 6. Voice
- **STT:** Voice-Nachricht (App oder Channel) → Transkript erscheint editierbar im Chat → Agent verarbeitet.
- **TTS:** Optionale Sprachantwort (pro Channel/Session schaltbar).
- Provider-Adapter: lokal (whisper.cpp, Piper) oder API (OpenAI, ElevenLabs, Deepgram).

### 7. Integrationen
- MCP-Server (stdio, HTTP), global oder je Projekt.
- Skills (Claude-Skill-Format, kompatibel).
- Secrets verschlüsselt im Workspace gespeichert.

### 8. Memory
- **Entscheidung:** Markdown-Dateien sind die Wahrheit (`memory/`, Obsidian-kompatibel, externer Vault anbindbar). Daneben ein SQLite-Index (Volltext + Vektoren), jederzeit aus den Dateien neu aufbaubar.
- Begründung: lesbar, git-fähig, portabel; Index sorgt für schnelle Suche und skaliert.
- Ebenen: Workspace-Memory (Nutzer) + Projekt-Memory (`HARNOLD.md`, kompatibel mit `CLAUDE.md`).
- **Ordner mit Zugriff** je Ebene (Projekt, Umgebung, Workspace): einmal freigegeben, gelten sie für jede Session und jeden Task-Lauf dieses Projekts. Tasks können zusätzlich eigene Ordner bekommen.

## UI

- Ein Fenster, frei teilbare Panes. Standard: Sidebar (Projekte/Sessions/Tasks) | Chat | rechte Pane (Preview / Canvas / Code / Terminal).
- Mehrere Panes gleichzeitig sichtbar (z. B. Chat + Preview + Code).
- Befehlspalette (⌘K), alles per Tastatur erreichbar.
- Light/Dark.

## Architektur

```
┌──────────── Clients ────────────┐
│ Desktop (Tauri) │ Web-UI │ Channels │
└───────────┬─────────────────────┘
            │ WebSocket + REST
┌───────────▼───────────── Core (Node/TS) ┐
│ Agent Runtime (Claude Agent SDK)         │
│ Provider-Abstraktion                     │
│ Scheduler · Channel-Adapter · Voice      │
│ MCP/Skills · Memory-Index · Auth         │
└───────────┬─────────────────────────────┘
            │
   Dateisystem (Projekte) + SQLite (Meta, Index)
```

- **Core:** ein Node/TypeScript-Prozess. Lokal als Sidecar der Desktop-App, auf Server als Docker-Image.
- **UI:** React, identisch für Desktop und Web.
- **Desktop:** Tauri (Mac zuerst). Verbindet wahlweise mit lokalem oder entferntem Core (Workspace-Umschalter). Kein Sync: Daten liegen beim jeweiligen Core; Projekte bei Bedarf per Git spiegeln.
- **Modelle:** Claude via Agent SDK (Claude-Abo-Login, API-Key, Bedrock, Vertex). Provider-Interface für OpenAI, Gemini, Ollama.
- **Daten:** Projekte im Dateisystem, Metadaten/Sessions/Tasks in SQLite.
- **Auth:** Server-Betrieb mit Login (Single-User Standard, Multi-User vorbereitet). Lokal ohne Login.

## Nicht-Ziele

- Kein eigenes Modell-Training.
- Kein Figma-Ersatz (Canvas ist für Entwürfe/Referenzen, kein Vektor-Editor).
- Kein Hosted-SaaS-Betrieb durch das Projekt selbst (self-hosted).

## Lizenz

MIT.
