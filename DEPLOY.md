# Harnold auf einem Server (Docker)

Voraussetzung: Server mit Docker und Docker Compose.

## Einrichten
1. `git clone https://github.com/Kasoria/harnold && cd harnold`
2. `cp .env.example .env` und `HARNOLD_TOKEN` setzen (`openssl rand -hex 32`).
3. `docker compose up -d`
4. `http://<server>:4317` öffnen (nur lokal gebunden, siehe unten), Token eingeben, unter Einstellungen → Agent bei Claude (und Codex) einloggen. Alternativ `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in die `.env`.

## Domain mit HTTPS
DNS: A-Record `harnold.deinedomain.de` → Server-IP. In der `.env` `HARNOLD_DOMAIN=harnold.deinedomain.de` setzen, dann
`docker compose --profile proxy up -d` (Ports 80/443 freigeben). Caddy holt das Zertifikat selbst.
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
sie werden beim lokalen Bauen ins Image installiert: `docker compose up -d --build`.
Hinweis: Das fertige Image aus der Registry enthält diese Extras nicht, nach `--build` also nicht mehr `pull` nutzen.

## Sichern
Volumes `harnold-data` (Projekte, Datenbank) und `harnold-home` (Logins, Tools) regelmäßig sichern.
