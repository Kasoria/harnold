# Harnold – UI-Richtung

Ziel: ruhig, dicht, Fokus auf Inhalt. Wenig Farbe, wenig Chrome.

## Stack

- shadcn/ui (Radix) + Tailwind v4, Icons: lucide-react.
- Theme über CSS-Variablen (shadcn-Tokens), Light + Dark.

## Layout

Ein Fenster, drei Spalten, alle in der Breite verstellbar, rechte Spalte schließbar.

| Spalte | Breite | Inhalt |
|---|---|---|
| Sidebar | ~250px | Navigation |
| Chat | ~640px | aktive Session |
| Workspace | Rest | Canvas / Preview / Code / Dateien |

### Sidebar
- Oben: Dashboard.
- Baum: **Projekt** (farbiges Buchstaben-Avatar) → **Bereich** (optional, z. B. iOS/Web) → **Session**.
- Session-Zeile: Status-Punkt (grau = idle, grün = aktiv, rot = Fehler/wartet), Name, Aktionen nur bei Hover.
- Feature-Navigation: Tasks, Channels, Memory, Integrationen; unten Einstellungen. Aktiver Screen hervorgehoben.
- Leicht abgesetzter Hintergrund (Mac: transluzent).

### Feature-Screens
- Jede Oberkategorie (Tasks, Channels, Memory, Integrationen, Einstellungen) ist eine **eigene Seite** im Hauptbereich (Hash-Route, z. B. `#/memory/…`), keine Sheet/Modal.
- Aufbau: Kopf (Titel, Beschreibung, Aktionen, ggf. Tabs) + Master-Detail (Liste links, Detail/Editor rechts) bzw. Abschnitts-Navigation bei Einstellungen.
- Sheets/Modals/Inline nur für Erstellen/Bearbeiten **innerhalb** eines Screens, sparsam.

### Chat
- Header: Session-Titel, Status-Pill („Idle“/„Läuft“), Verlauf, Menü (…).
- Nachrichten ohne Bubbles (Assistent), Nutzer dezent abgesetzt.
- Tool-Aufrufe als einzeilige, graue, aufklappbare Zusammenfassung („3 Befehle ausgeführt ›“, „Skill genutzt ›“). Aufeinanderfolgende gleichartige gruppiert.
- Freigaben inline als Karte.
- Composer: Anhang, Textfeld („… Datei oder Screenshot einfügen/ablegen“), Mikrofon, runder Senden-Button. Darunter: Modell, Permission-Modus, Kontext-Ring.

### Workspace
- Header: Breadcrumb (Projekt › Session › Ansicht) + Icon-Aktionen rechts (Vollbild, Kommentare, Link, Neu laden, Extern öffnen, Schließen).
- Ansichten: Canvas (Standard), Preview, Code, Dateien.
- **Canvas:** grauer Hintergrund, benannte Gruppen (Frames) mit Screens/Artifacts als Thumbnails, Zoom/Pan. Schwebende Werkzeugleiste unten: Auswahl, Hand, Text, Frame, Notiz, Stift, Rechteck.
- Doppelklick auf Thumbnail → Preview; Kommentar an Element → Aufgabe im Chat.

## Stil

- Neutrales Grau, weiße Flächen, feine Rahmen (1px, sehr hell), Radius 8–10px.
- Schrift: System/Inter, 13–14px; Sekundärtext gedämpftes Grau.
- Farbe nur für Status, Projekt-Avatare und primäre Aktion.
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
