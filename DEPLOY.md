# Harnold auf einem Server (Docker)

Voraussetzung: Server mit Docker und Docker Compose.

## Einrichten (einfachster Weg)
```
curl -fsSL https://raw.githubusercontent.com/Kasoria/harnold/main/install.sh | sh
```
Das Skript prüft Docker, legt `~/harnold` mit `docker-compose.yml` und `.env` (zufälliges Token) an, fragt optional nach einer Domain,
startet Harnold samt Update-Dienst und zeigt Adresse und Token. Danach in der UI unter Einstellungen → Agent bei Claude (und Codex)
einloggen, oder `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in die `.env` eintragen. Erneut ausführen ist gefahrlos (Token bleibt).

Von Hand: Repo klonen, `cp .env.example .env`, `HARNOLD_TOKEN` setzen (`openssl rand -hex 32`), `docker compose up -d`.
Updates per Knopf funktionieren nur mit dieser Compose-Datei, weil der Update-Dienst (watchtower) darin steht.

## Domain mit HTTPS
DNS: A-Record `harnold.deinedomain.de` → Server-IP. In der `.env` `HARNOLD_DOMAIN=harnold.deinedomain.de` setzen, dann
`COMPOSE_PROFILES=proxy` in die `.env` und `docker compose up -d` (Ports 80/443 freigeben). Caddy holt das Zertifikat selbst. Der Installer erledigt das, wenn du eine Domain angibst.
Ohne öffentliche Adresse: Tailscale oder Cloudflare Tunnel davorsetzen.

## Laufende Apps ansehen (Workspace → App)
Startet der Agent einen Dev-Server (`npm run dev`, Vite, Next …), erscheint er im Workspace unter **App** und lässt sich dort
oder in einem eigenen Tab öffnen, inklusive Hot Reload. Harnold leitet dafür über einen eigenen Port weiter (eigene Origin, damit
die App Harnolds Zugang nicht lesen kann): mit Domain `https://<domain>:8443` (Port 8443 in der Firewall freigeben),
ohne Domain `127.0.0.1:4318` (SSH-Tunnel: `ssh -L 4317:localhost:4317 -L 4318:localhost:4318 <server>`).
Hinter eigenem Reverse-Proxy: `127.0.0.1:4318` unter einer zweiten Adresse veröffentlichen (WebSockets durchlassen) und diese
als `HARNOLD_PREVIEW_PUBLIC_URL` in die `.env` schreiben. Es gilt immer die zuletzt geöffnete App je Browser.

## Ordner des Servers einbinden
Harnold sieht im Container nur seine Volumes. Weitere Ordner: `HARNOLD_HOST_FOLDERS="/srv/projekte /home/ich/code"` in der `.env`
und `install.sh` erneut ausführen (oder die Frage beim ersten Lauf beantworten). Die Ordner erscheinen im Container unter demselben
Pfad (über `docker-compose.override.yml`). Harnold schreibt als Nutzer 10001, also Schreibrechte geben, z. B.
`sudo setfacl -R -m u:10001:rwX -m d:u:10001:rwX /srv/projekte`. Danach in Harnold ein Projekt mit diesem Pfad anlegen.

## Docker für den Agenten
`HARNOLD_DOCKER=true` in der `.env` und `install.sh` erneut ausführen (oder beim ersten Lauf mit „j“ antworten). Dann läuft ein
eigener Docker-Dienst (Docker-in-Docker, privilegiert) neben Harnold, und der Agent kann `docker` und `docker compose` nutzen, z. B.
für Datenbanken. Er sieht die Container des Servers nicht. Veröffentlichte Container-Ports erreicht er unter `docker:PORT` statt
`localhost:PORT`, und sie erscheinen unter Workspace → App. Bind-Mounts funktionieren für Projekte unter `/data`, `/home/harnold`
und die eingebundenen Server-Ordner. Images und Container liegen im Volume `harnold-docker`.

## Umzug & Backup

Einstellungen → Allgemein → „Umzug & Backup“:

- **Auf Server übertragen** (Desktop-App): Server-Adresse und Token eintragen; die App bis zum Ende geöffnet lassen. Der Upload läuft parallel in kleinen Stücken und setzt nach Verbindungsabbrüchen fort; ein eigener Reverse Proxy braucht keine besonderen Limits. Der Server muss eine aktuelle Version laufen haben.
- **Als Datei exportieren** (Desktop: Ordner „Downloads“; Server: Download im Browser) und **Datei importieren**. Ein Server startet danach selbst neu, sonst Harnold beenden und neu öffnen. Die Datei enthält Konten und Schlüssel.

Umfang:

- **Ganzer Workspace:** Projekte (auch Ordner außerhalb von `~/.harnold`; ohne `node_modules` und Build-Caches wie Rusts `target`), Chats, Memory, Einstellungen, Konten und Schlüssel, auf Wunsch Claude-/Codex-Konfiguration und Chat-Verläufe. Einzelne Ordner lassen sich abwählen (sie kommen leer an). Die ersetzten Daten bleiben unter `.import/backup-…` im Datenordner (bei Bedarf selbst löschen).
- **Nur Agent-Konfiguration:** ergänzt Claude-/Codex-Konfiguration und Chat-Verläufe; der Workspace dort bleibt. Längere Verläufe auf der Zielseite bleiben erhalten.

Verknüpfte Skills und Dateien (z. B. aus `~/.agents/skills`) werden mitkopiert. Anmeldungen bei Claude/Codex auf der Zielseite neu vornehmen.

## Updates
- Eine neue Version erscheint in der UI unten und unter Einstellungen als „Update auf x“. Ein Klick auf **Auf x aktualisieren** holt das neue Image und startet Harnold neu (laufende Sitzungen werden unterbrochen). Die Seite lädt danach von selbst neu.
- Das übernimmt der mitlaufende Dienst `watchtower` (ein Container, kein Cronjob). Nur er hat Docker-Zugriff, Harnold nicht.
- Vollautomatisch (nachts 03:17, Zeit per `HARNOLD_UPDATE_SCHEDULE`): `HARNOLD_AUTO_UPDATE=true` in der `.env`, dann `docker compose up -d`.
- Von Hand geht es weiterhin: `docker compose pull && docker compose up -d`.
- Version festnageln: `HARNOLD_VERSION=0.11.0` in der `.env`.
- Eine Version wird erst angeboten, wenn ihr Image veröffentlicht ist (der Bau dauert nach dem Release etwa 10 Minuten).

## Eigene Pakete
Im Container hat der Agent `sudo`. Nutzer-Installationen (pip --user, npm -g, Playwright-Browser) liegen im Volume
`harnold-home` und bleiben bei Updates erhalten. Systempakete (apt) gehören in `HARNOLD_APT_PACKAGES` in der `.env`;
sie werden beim lokalen Bauen ins Image installiert: `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.
Hinweis: Das fertige Image aus der Registry enthält diese Extras nicht, nach `--build` also nicht mehr `pull` nutzen.

## Sichern
Volumes `harnold-data` (Projekte, Datenbank) und `harnold-home` (Logins, Tools) regelmäßig sichern.
