# Harnold – UI-Richtung

Ziel: ruhig, dicht, Fokus auf Inhalt. Wenig Farbe, wenig Chrome.

## Stack

- shadcn/ui (Radix) + Tailwind v4, Icons: lucide-react.
- Theme über CSS-Variablen (shadcn-Tokens), Light + Dark; `color-scheme` folgt dem Theme.
- Ziel-Engines: WebKit (Tauri/macOS) + Chromium. Moderne Web-Standards vor JS-Nachbau, mit Feature-Detection/Fallback.

## Layout

Ein Fenster, drei Spalten, alle in der Breite verstellbar, rechte Spalte schließbar.

| Spalte | Breite | Inhalt |
|---|---|---|
| Sidebar | ~250px | Navigation |
| Chat | ~640px | aktive Session |
| Workspace | Rest | Canvas / Preview / Code / Dateien |

### Sidebar
- Ganz oben: **Quick Chat** (Akzent-Button) – Chat ohne Projekt. Liste „Quick Chats“ unter den Projekten; Zuweisen per „Kein Projekt ⌄“ links unterm Composer; Auto-Löschen nach X Tagen in Einstellungen › Allgemein.
- Darunter: **Heute** – Startansicht bei frischem Öffnen. Nur: wartende Freigaben (direkt erlauben/ablehnen), laufende Sessions, Task-Ergebnisse der letzten 24 h, 3 Sessions zum Weitermachen. Leere Bereiche entfallen.
- Baum: **Projekt** (Emoji-Icon oder farbiges Buchstaben-Avatar) → **Bereich** (optional, z. B. iOS/Web) → **Session**.
- Session-Zeile: Status-Punkt (grau = idle, grün = aktiv, rot = Fehler/wartet), Name, Aktionen nur bei Hover.
- Memory: Projektauswahl oben; Liste mit Notizen und Gruppe „Dateien“. „Datei hinzufügen“ oder Drag & Drop legt Dateien unter `memory/dateien/` (Projekt bzw. Workspace je nach Filter) ab; der Agent bekommt sie als Pfadliste und liest sie bei Bedarf. Vorschau: Bilder inline, PDF/Text im Frame.
- Feature-Navigation: Heute, Tasks, Channels, Memory, Integrationen, Design Systems, Umgebungen; unten Einstellungen. Über den Projekten der Umgebungs-Umschalter (nur wenn Umgebungen existieren). Aktiver Screen hervorgehoben.
- Leicht abgesetzter Hintergrund (Mac: transluzent).

### Feature-Screens
- Jede Oberkategorie (Tasks, Channels, Memory, Integrationen, Design Systems, Umgebungen, Einstellungen) ist eine **eigene Seite** im Hauptbereich (Hash-Route, z. B. `#/memory/…`), keine Sheet/Modal.
- Aufbau: Kopf (Titel, Aktionen, ggf. Tabs) + Master-Detail (Liste links, Detail/Editor rechts) bzw. Abschnitts-Navigation bei Einstellungen.
- Sheets/Modals/Inline nur für Erstellen/Bearbeiten **innerhalb** eines Screens, sparsam.
- **Keine Hint-Texte**, wo Label, Icon, Platzhalter oder Kontext reichen. Unvermeidbare Hints: ein kurzer, konkreter Satz.
- Nie „Standard“ ohne Wert: immer den tatsächlichen Wert zeigen (z. B. Modell „Opus 5.5 · Einstellungen“).

### Chat
- Header: Session-Titel, Status-Pill („Idle“/„Läuft“), Verlauf, Menü (…).
- Nachrichten ohne Bubbles (Assistent), Nutzer dezent abgesetzt.
- Tool-Aufrufe als einzeilige, graue, aufklappbare Zusammenfassung („3 Befehle ausgeführt ›“, „Skill genutzt ›“). Aufeinanderfolgende gleichartige gruppiert.
- Freigaben inline als Karte.
- Gedanken (Thinking) als eingeklappte Zeile „Gedanken ›“, live „Denkt nach“.
- Läuft ein Durchlauf ohne sichtbaren Stream: Aktivitätszeile („Arbeitet · 12 s“).
- Codeblöcke und Antworten mit Kopieren-Button (bei Hover).
- Systemereignisse (verschoben, komprimiert) als schmale Trennlinie mit Text.
- Slash-Commands: Popup beim Tippen von „/“ (Harnold-Commands + die des Agents).
- Destruktive Aktionen immer mit Bestätigungsdialog (`confirmAction`), nie `window.confirm`. Aktion links, Abbrechen rechts, Fokus auf der Aktion (Enter bestätigt, Esc bricht ab, ←/→ wechselt).
- Gesendete Nachricht bearbeiten → neue Version der Unterhaltung ab dort; Umschalter „‹ 1/2 ›“ an der Nachricht. Sidebar zeigt je Unterhaltung eine Zeile (öffnet die zuletzt genutzte Version).
- Composer: Anhang, Textfeld („… Datei oder Screenshot einfügen/ablegen“), Mikrofon, runder Senden-Button. Darunter: Modell, Permission-Modus, Kontext-Ring.
- Anhänge (Bilder, PDFs, Text, Office) per Büroklammer, Einfügen oder Drag & Drop (ganzer Chat ist Ablagefläche, gestrichelter Rahmen in Akzentfarbe); liegen im Projekt unter attachments/. Bilder (Anhänge, generierte, in Antworten genannte) erscheinen als Vorschau im Chat, Klick öffnet groß.

### Workspace
- Header: Breadcrumb (Projekt › Session › Ansicht) + Icon-Aktionen rechts (Vollbild, Kommentare, Link, Neu laden, Extern öffnen, Schließen).
- Ansichten: Canvas (Standard), Preview, Code, Dateien.
- Erststart ohne Claude-Verbindung: Onboarding-Overlay (überspringbar).
- **Canvas:** grauer Hintergrund, benannte Gruppen (Frames) mit Screens/Artifacts als Thumbnails, Zoom/Pan. Schwebende Werkzeugleiste unten: Auswahl, Hand, Text, Frame, Notiz, Stift, Rechteck.
- Doppelklick auf Thumbnail → Preview; Kommentar an Element → Aufgabe im Chat.

## Stil

- Neutrales Grau, weiße Flächen, feine Rahmen (1px, sehr hell), Radius 8–10px.
- Schrift: System/Inter, 13–14px; Sekundärtext gedämpftes Grau.
- Farbe nur für Status, Projekt-Avatare und Akzent (Blau: primäre Aktion, Auswahl, Fokus); Rot nur destruktiv.
- Icons 16px, Linienstil.
- Dicht, aber mit Luft: Zeilenhöhe Sidebar ~26px.

## Motion

Jeder Zustandswechsel ist animiert – dezent, nie verspielt.

- Toggles/Switches, Tabs, Segmented Controls: gleitender Indikator.
- Popover, Dropdown, Tooltip: Fade + leichter Zoom/Slide (4px) aus Richtung des Auslösers.
- Modals: Fade Overlay + Fade/Zoom (0.97→1) Inhalt.
- Side-Panels (Workspace, Sheets): Slide + Fade.
- Screen-Wechsel: Fade.
- Aufklappen (Tool-Gruppen, Baum): Höhe + Fade.
- Neue Chat-Einträge: kurzes Fade-in.
- Hover/Farbwechsel: 150ms.
- Dauer 150–250ms, Easing `ease-out` (rein) / `ease-in` (raus). Keine Bounces.
- `prefers-reduced-motion`: nur Fade bzw. keine Animation.
