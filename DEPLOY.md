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
- In der UI erscheint unter Einstellungen „Version {x} ist verfügbar“.
- Von Hand: `docker compose pull && docker compose up -d`
- Automatisch (nachts 04:00, Zeit per `HARNOLD_UPDATE_SCHEDULE`): `docker compose --profile autoupdate up -d`.
  Laufende Agent-Sitzungen werden beim Neustart unterbrochen.
- Version festnageln: `HARNOLD_VERSION=0.11.0` in der `.env`.

## Eigene Pakete
Im Container hat der Agent `sudo`. Nutzer-Installationen (pip --user, npm -g, Playwright-Browser) liegen im Volume
`harnold-home` und bleiben bei Updates erhalten. Systempakete (apt) gehören in `HARNOLD_APT_PACKAGES` in der `.env`;
sie werden beim lokalen Bauen ins Image installiert: `docker compose up -d --build`.
Hinweis: Das fertige Image aus der Registry enthält diese Extras nicht, nach `--build` also nicht mehr `pull` nutzen.

## Sichern
Volumes `harnold-data` (Projekte, Datenbank) und `harnold-home` (Logins, Tools) regelmäßig sichern.
