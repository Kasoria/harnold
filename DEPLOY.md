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
