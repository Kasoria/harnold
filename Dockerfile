# syntax=docker/dockerfile:1
# Harnold Core + Web-UI in einem Image (Server-Betrieb, 24/7).

FROM node:26-bookworm-slim AS build
RUN npm install -g pnpm@12.15.0
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY apps/ui/package.json apps/ui/
COPY apps/desktop/package.json apps/desktop/
# Nur die UI: der Core (mit node-pty) wird erst im Laufzeit-Image installiert, dort gibt es Compiler.
RUN pnpm install --frozen-lockfile --filter "@harnold/ui..."
COPY apps/ui apps/ui
# Die UI liest ihre Version aus der Desktop-Konfiguration.
COPY apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/tauri.conf.json
ARG HARNOLD_VERSION=""
RUN HARNOLD_VERSION="$HARNOLD_VERSION" pnpm --filter @harnold/ui build

FROM node:26-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/Kasoria/harnold"
# Zusätzliche Systempakete (.env: HARNOLD_APT_PACKAGES), werden beim Build ins Image installiert.
ARG HARNOLD_APT_PACKAGES=""
# Werkzeugkasten wie auf einem normalen Linux-Server: Compiler, Python, sudo für apt zur Laufzeit,
# Docker-CLI (spricht den optionalen Docker-Dienst aus der Compose-Datei an, DOCKER_HOST).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl openssh-client ripgrep \
      sudo build-essential python3 python3-pip python3-venv jq unzip wget procps ${HARNOLD_APT_PACKAGES} \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin docker-buildx-plugin \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@12.15.0 tsx@4.23.15 playwright \
 && playwright install-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.cache /root/.npm
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY apps/ui/package.json apps/ui/
COPY apps/desktop/package.json apps/desktop/
RUN pnpm install --frozen-lockfile --prod --filter "@harnold/core..." \
 && rm -rf /root/.cache /root/.local/share/pnpm/store /root/.npm
COPY packages/core packages/core
COPY --from=build /app/apps/ui/dist apps/ui/dist

# Claude Code verweigert Root mit Rechte-Umgehung: eigener Nutzer (mit sudo, Root gilt nur im Container).
RUN useradd --create-home --uid 10001 harnold \
 && echo "harnold ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/harnold && chmod 440 /etc/sudoers.d/harnold \
 && mkdir -p /data /home/harnold/.npm-global /home/harnold/.local/bin /home/harnold/.cache \
 && chown -R harnold /data /home/harnold
USER harnold
# Nutzer-Installationen (npm -g, pip --user, Playwright-Browser) landen im Home und überleben Updates.
ENV HARNOLD_HOST=0.0.0.0 \
    HARNOLD_PORT=4317 \
    HARNOLD_PREVIEW_PORT=4318 \
    HARNOLD_DATA_DIR=/data \
    HARNOLD_UI_DIR=/app/apps/ui/dist \
    NODE_ENV=production \
    HARNOLD_DEPLOYMENT=docker \
    NPM_CONFIG_PREFIX=/home/harnold/.npm-global \
    PLAYWRIGHT_BROWSERS_PATH=/home/harnold/.cache/ms-playwright \
    PATH=/home/harnold/.npm-global/bin:/home/harnold/.local/bin:$PATH
# /data = Projekte + SQLite; /home/harnold = Logins (.claude, .codex), Tools, Caches
VOLUME ["/data", "/home/harnold"]
EXPOSE 4317 4318
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:4317/ >/dev/null || exit 1
WORKDIR /app/packages/core
# tsx global (devDependency im Core); direkt starten, kein pnpm-Install beim Start.
CMD ["tsx", "src/index.ts"]
