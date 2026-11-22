# E-Mail: Channel vs. Postfach-Integration

Zwei getrennte, klar abgegrenzte E-Mail-Funktionen.

## 1. E-Mail als Channel (Kommunikation User ↔ Harnold)

Besteht bereits (`packages/core/src/channels/email.ts`). IMAP-Polling der INBOX, SMTP-Antworten,
`chatId = Absenderadresse`, Filter über `allowedSenders`, SPF/DKIM/DMARC-Spoof-Schutz.
Bleibt ein Channel wie Telegram/Discord/Slack und dient **nur** der direkten Kommunikation mit Harnold.

## 2. E-Mail-Postfach als Integration („KI im Postfach", Superhuman-lite)

Neu. Ein Postfach (IMAP + SMTP) wird an einen **Team-Agenten** gebunden. Der Agent liest,
fasst zusammen, sortiert und beantwortet die Mails des Users **im Namen des Users**.
Das ist **keine** User↔Harnold-Kommunikation, sondern ein Assistent, der das Postfach bedient.

### Entscheidungen (mit dem User geklärt)

- **Autonomie**: pro Postfach einstellbar, von sehr zurückhaltend bis voll autonom.
  - `readonly` – nur lesen + zusammenfassen, keinerlei Änderung.
  - `drafts` – zusätzlich Antwort-Entwürfe im Postfach anlegen + sortieren/markieren (kein Senden).
  - `approve` – Entwürfe werden im Postfach-Screen zur Freigabe vorgelegt; erst nach Freigabe sendet Harnold. (Standard)
  - `auto` – vollautonom: Agent darf direkt senden, verschieben, markieren.
- **Umfang V1**: Lesen + Zusammenfassen, Beantworten (Entwürfe), Sortieren/Labels/Ordner, Newsletter/Digest bündeln.
- **Scope**: `project` (an ein Projekt gebunden) oder `global` (überall verfügbar). User wählt.
- **Output**: eigener Postfach-Screen in der UI (Verbindungen, Status, verarbeitete Mails, Agent-Aktionen, offene Freigaben).

### Datenmodell (SQLite)

- `mail_inboxes` – Postfach-Verbindungen (IMAP/SMTP, Agent, Scope, Autonomie, enabled). Secrets verschlüsselt.
- `mail_messages` – Cache der verarbeiteten Mails (UID, Ordner, Absender, Betreff, Snippet, Status, Aktion).
- `mail_actions` – Log der Agent-Aktionen inkl. Freigaben (kind, description, payload, status done/pending/sent/rejected).

### Architektur

- `packages/core/src/mail/mail-parse.ts` – geteilte Parser-Helfer (Quoted-Reply-Strip, Auth-Ergebnis).
- `packages/core/src/mail/inbox.ts` – Typen, Schemas, Store.
- `packages/core/src/mail/transport.ts` – IMAP/SMTP-Kapselung (lesen, Ordner, Flags, Verschieben, Entwürfe/Append, Senden).
- `packages/core/src/mail/tools.ts` – Mail-Tools für den gebundenen Agenten (lesen, zusammenfassen, Entwurf, senden, verschieben, markieren, Digest).
- `packages/core/src/mail/manager.ts` – Polling, übergibt neue Mails dem Agenten als Turn, führt Freigaben aus.
- API-Routen in `index.ts`, Tools + Anleitung in `workspace-tools.ts`, Event `mail_changed` in `events.ts`.

### Autonomie-Erzwingung

Die Mail-Tools prüfen server-seitig das Autonomie-Level des gebundenen Postfachs und verweigern
z. B. `mail_send` bei allem unter `auto`, bzw. Schreibaktionen bei `readonly`. Der Prompt teilt dem
Agenten das Level mit, sodass er sich entsprechend verhält.

### Konfiguration pro Postfach

Ein Postfach ist nicht nur ein Zugang, sondern bekommt einen eigenen Auftrag. Alle Felder liegen in
`mail_inboxes` (Spalten, per Migration ergänzt) und im UI im Postfach-Screen:

- `instructions` – **Auftrag & Regeln**: was der Agent mit eingehenden Mails tun soll, was er lassen soll,
  wie er priorisiert. Ohne Auftrag bleibt der generische Prompt („zusammenfassen, beantworten oder sortieren").
- `tone` – Anrede, Ton, Sprache für Antworten (z. B. „Sie, sachlich und kurz, Deutsch").
- `signature` – wird an Entwürfe und Antworten **automatisch** angehängt (`withSignature()` in `mail/inbox.ts`),
  unabhängig davon, ob das Modell sie selbst geschrieben hat (Doppelung wird erkannt).
- `context` – Hintergrundwissen über den Nutzer/das Geschäft. Das Projekt-Memory des Postfach-Projekts geht
  zusätzlich über den Systemprompt mit.
- `includeSenders` / `excludeSenders` – Absender-Muster (Komma/semikolongetrennt, `*` als Wildcard).
  Filter laufen **vor** dem Agenten (`mailFilterAllows()`): ausgeschlossene Absender werden als `ignored`
  protokolliert, ohne einen Turn zu kosten.
- `folders` – zu beobachtende Ordner (leer = INBOX).
- `backendId` / `model` – eigenes Agent-Programm und Modell für dieses Postfach (siehe
  [agent-modelle.md](agent-modelle.md)). Da jede Mail eine neue Session startet, gilt die Wahl sofort.

Prompt-Bau: `briefingFor()` in `mail/manager.ts` hängt Auftrag, Ton, Signatur und Hintergrundwissen an
jeden Mail-Prompt. Die Autonomie-Stufe bleibt davon unberührt und wird weiterhin serverseitig in
`mail/tools.ts` erzwungen.

Der Agent kann Postfächer auch selbst einrichten: Tools `mail_inbox_save` / `mail_inbox_delete`
(`setup-tools.ts`).
