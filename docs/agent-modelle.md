# Agent-Programm und Modell pro Einheit

Harnold kann drei Agent-Programme fahren: `claude-code`, `codex` und `native` (Harnolds eigener Agent).
Das Programm und das Modell lassen sich auf mehreren Ebenen festlegen – leer heißt immer „erben".

## Wo die Wahl liegt

| Ebene | Feld | Tabelle | UI |
| --- | --- | --- | --- |
| Workspace | `agent.backend` | `settings` | Einstellungen → Agent |
| Workspace-Modell | `claude.defaultModel` / `codex.defaultModel` / `native.defaultModel` | `settings` | Einstellungen → Agent |
| Rolle (Chat / Hintergrund) | `backendId`, `model` je Rolle im Wert `agent.roles` | `settings` | Einstellungen → Agent → „Programm und Modell je Rolle" |
| Umgebung | `claude_mode`, `model` | `environments` | Umgebungen |
| Teammitglied | `backend_id`, `model` | `team_agents` | Team |
| Channel | `backend_id`, `model` | `channels` | Channels |
| Postfach | `backend_id`, `model` | `mail_inboxes` | Postfach |
| Task | `backend_id`, `model` | `tasks` | Tasks |
| Composer | Modell je Session | `sessions.backend_id` | Chat |

## Auflösung eines Turns (`agent.ts`)

1. **Programm**: Läuft die Session bereits in einem Programm (`agentSessionId` gesetzt), bleibt sie dort –
   der Kontext lebt in diesem Programm. Sonst: eigenes Programm der Einheit (Task, Channel, Postfach,
   Teammitglied) → Rolle → Programm der Session → Umgebung → `agent.backend`.
2. **Modell**: eigenes Modell der Einheit bzw. aus dem Composer → Modell des Teammitglieds → Rollen-Modell →
   Modell der Umgebung → Standard des Programms. Modelle, die nicht zum Programm passen
   (`modelFitsBackend()`), werden nicht übergeben.

Aufrufer geben die Wahl als `TurnRequest.backendId` / `TurnRequest.model` mit (`channels/manager.ts`,
`mail/manager.ts`, `tasks.ts`) plus die Rolle: Channels und normale Chats `chat`, Tasks und Postfach
`automation`. Team-Mitglieder bringt `turnContextFor()` selbst aus `team_agents`.

## Rollen (`agent-roles.ts`)

Zwei Rollen fassen zusammen, was sonst pro Einheit eingestellt werden müsste:

- `chat` – Unterhaltungen: Chats, Channels, Teammitglieder.
- `automation` – Hintergrundläufe: Tasks und Postfach.

Je Rolle ein Programm und/oder Modell; leer = wie oben (Umgebung/`agent.backend`). Die Einheit selbst sticht
immer. Gedacht für den häufigen Fall „Unterhaltungen mit dem starken Modell, Hintergrundarbeit mit dem
günstigen": dort reicht dann eine Zeile statt vier Feldern pro Task. API: `GET`/`PUT /api/agent-roles`.

## Programmwechsel bei bestehenden Unterhaltungen

Ein Programm kann seinen Kontext nicht mit einem anderen teilen, deshalb:

- **Channel**: Wechsel des Programms setzt die verknüpften Konversationen zurück (`conversationStore.reset()`
  in `channels/store.ts`) – die nächste Nachricht startet eine neue Session.
- **Task** (`sessionMode: "continue"`): Ein Programmwechsel löscht den Agent-Kontext der fortgeführten Session,
  die Historie bleibt.
- **Postfach**: jede Mail ist eine eigene Session, die Wahl gilt sofort.
- **Teammitglied**: gilt für neue Unterhaltungen; laufende behalten ihr Programm, bis der Kontext neu beginnt.

## Tools

`team_save`, `channel_save`, `task_save`, `mail_inbox_save` nehmen `backendId` und `model` an
(`null` = erben, weglassen = unverändert). So kann Harnold die Einheiten auch im Chat konfigurieren.
