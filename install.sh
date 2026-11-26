#!/bin/sh
# Harnold-Installer für Docker. Aufruf:
#   curl -fsSL https://raw.githubusercontent.com/Kasoria/harnold/main/install.sh | sh
# Erneut ausführen ist gefahrlos: vorhandene Einstellungen und das Token bleiben, nur die Compose-Datei wird aufgefrischt.
# Optionale Umgebungsvariablen: HARNOLD_DIR (Standard ~/harnold), HARNOLD_DOMAIN, HARNOLD_PORT,
#   HARNOLD_HOST_FOLDERS ("/srv/projekte /home/ich/code": Ordner des Servers, die Harnold sehen darf),
#   HARNOLD_DOCKER (true/false: eigener Docker-Dienst für den Agenten).
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

# Wert vorhanden (auch leer)? Dann wurde die Frage schon einmal beantwortet.
env_has() { [ -f .env ] && grep -q "^$1=" .env; }
can_ask() { [ -r /dev/tty ]; }
# Frage im Terminal stellen, Antwort auf stdout (für $(ask …)).
ask() { printf '%s' "$1" > /dev/tty; read -r answer < /dev/tty || answer=""; printf '%s' "$answer"; }
port_in_use() { command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -qE ":$1 "; }

# Domain: aus der Umgebung, sonst (nur im Terminal) nachfragen.
domain="${HARNOLD_DOMAIN:-}"
if [ -z "$domain" ] && [ -z "$(env_value HARNOLD_DOMAIN)" ] && can_ask; then
  say ""
  say "Soll Harnold unter einer eigenen Domain mit HTTPS erreichbar sein? (z. B. harnold.meinedomain.de)"
  say "Die Domain muss schon per A-Record auf diesen Server zeigen, die Ports 80, 443 und 8443 (Vorschau laufender Apps) müssen frei sein."
  domain="$(ask 'Domain (leer lassen = nur lokal): ')"
fi
if [ -n "$domain" ]; then
  if port_in_use 80 || port_in_use 443 || port_in_use 8443; then
    say "Hinweis: Port 80, 443 oder 8443 ist auf diesem Server schon belegt. Caddy würde nicht starten."
    say "Setze dann einen vorhandenen Reverse-Proxy (z. B. nginx) vor 127.0.0.1:4317 (Harnold) und 127.0.0.1:4318 (Vorschau)"
    say "und trage die Vorschau-Adresse als HARNOLD_PREVIEW_PUBLIC_URL in die .env ein. Ich überspringe die Domain."
  else
    set_env HARNOLD_DOMAIN "$domain"
    set_env HARNOLD_PREVIEW_PUBLIC_PORT 8443
  fi
fi

# Ältere Installationen mit Domain: Vorschau läuft über Caddy auf 8443.
[ -n "$(env_value HARNOLD_DOMAIN)" ] && ! env_has HARNOLD_PREVIEW_PUBLIC_PORT && set_env HARNOLD_PREVIEW_PUBLIC_PORT 8443

# Ordner des Servers, die Harnold sehen darf (unter demselben Pfad eingebunden).
if [ -n "${HARNOLD_HOST_FOLDERS+set}" ]; then
  set_env HARNOLD_HOST_FOLDERS "${HARNOLD_HOST_FOLDERS}"
elif ! env_has HARNOLD_HOST_FOLDERS && can_ask; then
  say ""
  say "Harnold sieht im Container nur seine eigenen Projekte. Sollen Ordner dieses Servers dazukommen? (z. B. /srv/projekte)"
  set_env HARNOLD_HOST_FOLDERS "$(ask 'Ordner, durch Leerzeichen getrennt (leer lassen = keine): ')"
fi

# Docker für den Agenten: eigener Docker-Dienst (Docker-in-Docker), nicht der Docker dieses Servers.
if [ -n "${HARNOLD_DOCKER:-}" ]; then
  dockerChoice="$HARNOLD_DOCKER"
elif env_has HARNOLD_DOCKER; then
  dockerChoice="$(env_value HARNOLD_DOCKER)"
elif can_ask; then
  say ""
  say "Soll der Agent Docker nutzen können (docker compose für Datenbanken und Dienste)?"
  say "Er bekommt dafür einen eigenen Docker-Dienst und sieht die Container dieses Servers nicht. Braucht ca. 1 GB mehr Speicher."
  case "$(ask 'Docker für den Agenten einschalten? [j/N] ')" in [jJyY]*) dockerChoice=true ;; *) dockerChoice=false ;; esac
else
  dockerChoice=false
fi
case "$dockerChoice" in true|1|ja|yes) dockerChoice=true ;; *) dockerChoice=false ;; esac
set_env HARNOLD_DOCKER "$dockerChoice"

profiles=""
[ -n "$(env_value HARNOLD_DOMAIN)" ] && profiles="proxy"
if [ "$dockerChoice" = true ]; then
  profiles="${profiles:+$profiles,}docker"
  set_env HARNOLD_DOCKER_HOST "tcp://docker:2375"
else
  set_env HARNOLD_DOCKER_HOST ""
fi
set_env COMPOSE_PROFILES "$profiles"

# Ordner-Freigaben stehen in docker-compose.override.yml (Compose liest sie automatisch, Updates lassen sie stehen).
hostFolders="$(env_value HARNOLD_HOST_FOLDERS)"
if [ -n "$hostFolders" ]; then
  {
    say "# Von install.sh erzeugt aus HARNOLD_HOST_FOLDERS in der .env. Ändern: Wert anpassen und install.sh erneut ausführen."
    say "services:"
    for serviceName in harnold docker; do
      say "  $serviceName:"
      say "    volumes:"
      for hostFolder in $hostFolders; do say "      - \"$hostFolder:$hostFolder\""; done
    done
  } > docker-compose.override.yml
  for hostFolder in $hostFolders; do
    [ -d "$hostFolder" ] || say "Hinweis: $hostFolder existiert nicht, Docker legt ihn leer an (als root)."
  done
  say ""
  say "Harnold arbeitet im Container als Nutzer mit der ID 10001. Damit er in den freigegebenen Ordnern schreiben darf, z. B.:"
  for hostFolder in $hostFolders; do say "  sudo setfacl -R -m u:10001:rwX -m d:u:10001:rwX $hostFolder   (oder: sudo chown -R 10001 $hostFolder)"; done
  say "In Harnold dann ein Projekt mit dem Pfad des Ordners anlegen."
elif [ -f docker-compose.override.yml ] && grep -q "^# Von install.sh erzeugt" docker-compose.override.yml; then
  rm docker-compose.override.yml
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
  say "  Vorschau laufender Apps: https://$domain:8443 (öffnet Harnold selbst, Port 8443 in der Firewall freigeben)"
else
  say "  Adresse: http://localhost:$port   (nur auf diesem Rechner erreichbar)"
  say "  Auf einem entfernten Server: per SSH-Tunnel (ssh -L $port:localhost:$port -L 4318:localhost:4318 <server>, 4318 = Vorschau laufender Apps),"
  say "  Tailscale, oder install.sh erneut mit einer Domain starten."
fi
say "  Zugangs-Token: $(env_value HARNOLD_TOKEN)"
say "  (steht auch in $INSTALL_DIR/.env, bitte geheim halten)"
say ""
say "Danach in Harnold unter Einstellungen → Agent bei Claude (oder Codex) anmelden."
say "Updates: erscheinen in Harnold als Knopf. Von Hand: cd $INSTALL_DIR && docker compose pull && docker compose up -d"
