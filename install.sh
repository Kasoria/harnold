#!/bin/sh
# Harnold-Installer für Docker. Aufruf:
#   curl -fsSL https://raw.githubusercontent.com/Kasoria/harnold/main/install.sh | sh
# Erneut ausführen ist gefahrlos: vorhandene Einstellungen und das Token bleiben, nur die Compose-Datei wird aufgefrischt.
# Optionale Umgebungsvariablen: HARNOLD_DIR (Standard ~/harnold), HARNOLD_DOMAIN, HARNOLD_PORT.
set -eu

BASE_URL="${HARNOLD_RAW_BASE:-https://raw.githubusercontent.com/Kasoria/harnold/main}"
INSTALL_DIR="${HARNOLD_DIR:-$HOME/harnold}"

say() { printf '%s\n' "$*"; }
fail() { printf 'Fehler: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "Docker ist nicht installiert. Installation: https://docs.docker.com/get-docker/ (Linux: curl -fsSL https://get.docker.com | sh)"
docker info >/dev/null 2>&1 || fail "Docker läuft nicht oder dein Benutzer darf es nicht nutzen (Docker starten bzw. mit sudo ausführen)."
docker compose version >/dev/null 2>&1 || fail "Das Docker-Compose-Plugin fehlt. Installation: https://docs.docker.com/compose/install/"
command -v curl >/dev/null 2>&1 || fail "curl wird gebraucht."

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"
say "Installiere nach $INSTALL_DIR"

curl -fsSL "$BASE_URL/docker-compose.yml" -o docker-compose.yml.new || fail "docker-compose.yml konnte nicht geladen werden."
mv docker-compose.yml.new docker-compose.yml

# Wert aus der .env lesen (leer, wenn nicht gesetzt).
env_value() { [ -f .env ] && sed -n "s/^$1=//p" .env | tail -n 1 || true; }
# Wert in der .env setzen oder ersetzen.
set_env() {
  touch .env
  if grep -q "^$1=" .env; then
    sed "s|^$1=.*|$1=$2|" .env > .env.tmp && mv .env.tmp .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

umask 077
if [ -z "$(env_value HARNOLD_TOKEN)" ]; then
  if command -v openssl >/dev/null 2>&1; then
    newToken="$(openssl rand -hex 32)"
  else
    newToken="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  set_env HARNOLD_TOKEN "$newToken"
fi
[ -n "${HARNOLD_PORT:-}" ] && set_env HARNOLD_PORT "$HARNOLD_PORT"

# Domain: aus der Umgebung, sonst (nur im Terminal) nachfragen.
domain="${HARNOLD_DOMAIN:-}"
if [ -z "$domain" ] && [ -z "$(env_value HARNOLD_DOMAIN)" ] && [ -r /dev/tty ]; then
  say ""
  say "Soll Harnold unter einer eigenen Domain mit HTTPS erreichbar sein? (z. B. harnold.meinedomain.de)"
  say "Die Domain muss schon per A-Record auf diesen Server zeigen, die Ports 80 und 443 müssen frei sein."
  printf 'Domain (leer lassen = nur lokal): '
  read -r domain < /dev/tty || domain=""
fi
if [ -n "$domain" ]; then
  if (command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -qE ':(80|443) '); then
    say "Hinweis: Port 80 oder 443 ist auf diesem Server schon belegt. Caddy würde nicht starten."
    say "Setze dann einen vorhandenen Reverse-Proxy (z. B. nginx) vor 127.0.0.1:4317. Ich überspringe die Domain."
  else
    set_env HARNOLD_DOMAIN "$domain"
    set_env COMPOSE_PROFILES proxy
  fi
fi

say "Lade Images und starte Harnold (das erste Mal dauert einige Minuten) ..."
docker compose pull
docker compose up -d

say "Warte, bis Harnold bereit ist ..."
containerId="$(docker compose ps -q harnold)"
attempts=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$containerId" 2>/dev/null)" = "healthy" ]; do
  attempts=$((attempts + 1))
  [ "$attempts" -gt 60 ] && fail "Harnold wurde nicht bereit. Logs: cd $INSTALL_DIR && docker compose logs harnold"
  sleep 3
done

port="$(env_value HARNOLD_PORT)"; port="${port:-4317}"
domain="$(env_value HARNOLD_DOMAIN)"
say ""
say "Harnold läuft."
if [ -n "$domain" ]; then
  say "  Adresse: https://$domain   (das Zertifikat kann beim ersten Aufruf ein paar Sekunden brauchen)"
else
  say "  Adresse: http://localhost:$port   (nur auf diesem Rechner erreichbar)"
  say "  Auf einem entfernten Server: per SSH-Tunnel (ssh -L $port:localhost:$port <server>), Tailscale, oder install.sh erneut mit einer Domain starten."
fi
say "  Zugangs-Token: $(env_value HARNOLD_TOKEN)"
say "  (steht auch in $INSTALL_DIR/.env, bitte geheim halten)"
say ""
say "Danach in Harnold unter Einstellungen → Agent bei Claude (oder Codex) anmelden."
say "Updates: erscheinen in Harnold als Knopf. Von Hand: cd $INSTALL_DIR && docker compose pull && docker compose up -d"
