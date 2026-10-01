#!/usr/bin/env sh
# orbis installer (linux / macos / wsl)
#   curl -fsSL https://raw.githubusercontent.com/orbis-hub/orbis/main/install.sh | sh
#   or: sh install.sh [--mode both|hub|web] [--dir ./orbis] [--port 3001] [--hub-url http://host:3001] [--version 0.1.0] [--yes]
#
# modes
#   both  hub + web in one docker container (default). the hub serves the web app itself.
#   hub   hub only (api + websocket, no web ui). point a separately hosted web app at it.
#   web   web only: static files served by nginx in docker, talking to a hub somewhere else.
set -eu

MODE=""; DIR="./orbis"; PORT="3001"; HUB_URL=""; VERSION="latest"; YES=0; WEB_PORT="8080"
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2;;
    --dir) DIR="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --web-port) WEB_PORT="$2"; shift 2;;
    --hub-url) HUB_URL="$2"; shift 2;;
    --version) VERSION="$2"; shift 2;;
    --yes|-y) YES=1; shift;;
    -h|--help) sed -n '2,12p' "$0"; exit 0;;
    *) echo "unknown option $1"; exit 1;;
  esac
done

say() { printf '%s\n' "$*"; }
ask() { # ask "prompt" "default"
  if [ "$YES" = 1 ]; then echo "$2"; return; fi
  printf '%s [%s]: ' "$1" "$2" >&2
  read -r a </dev/tty || a=""
  [ -n "$a" ] && echo "$a" || echo "$2"
}

say ""
say "  ◎ orbis installer"
say ""

if [ -z "$MODE" ]; then
  say "  what should run on this machine?"
  say "    1) hub + web   everything in one container (recommended)"
  say "    2) hub only    api + websocket, web ui lives elsewhere"
  say "    3) web only    static web app pointing at a hub elsewhere"
  c=$(ask "  choice" "1")
  case "$c" in 2) MODE=hub;; 3) MODE=web;; *) MODE=both;; esac
fi

if ! command -v docker >/dev/null 2>&1; then
  say "  docker is required. install it from https://docs.docker.com/engine/install/ and run this again."
  exit 1
fi
COMPOSE="docker compose"; $COMPOSE version >/dev/null 2>&1 || COMPOSE="docker-compose"

mkdir -p "$DIR"; cd "$DIR"
IMAGE="ghcr.io/orbis-hub/orbis:$VERSION"

case "$MODE" in
  both|hub)
    [ "$PORT" = "3001" ] && PORT=$(ask "  port" "3001")
    say "  writing docker-compose.yml (host networking so the hub can see your lan devices)"
    cat > docker-compose.yml <<EOF
services:
  orbis:
    image: $IMAGE
    container_name: orbis
    restart: unless-stopped
    network_mode: host
    environment:
      PORT: "$PORT"
      LOG_LEVEL: info
$( [ "$MODE" = hub ] && printf '      # hub only: no web ui served, the api answers on /api\n      ORBIS_WEB_DIR: /nonexistent\n' )
      # add the origin of a separately hosted web app here, comma separated
      ORBIS_CORS_ORIGINS: ""
    volumes:
      - ./data:/data
EOF
    $COMPOSE pull
    $COMPOSE up -d
    IP=$(hostname -I 2>/dev/null | awk '{print $1}'); [ -z "$IP" ] && IP=localhost
    say ""
    if [ "$MODE" = both ]; then
      say "  done. open http://$IP:$PORT and create the owner account."
    else
      say "  done. hub api at http://$IP:$PORT/api/health"
      say "  install the web part on another machine with: sh install.sh --mode web --hub-url http://$IP:$PORT"
      say "  and add that machine's origin to ORBIS_CORS_ORIGINS in $DIR/docker-compose.yml."
    fi
    say "  logs: $COMPOSE -f $DIR/docker-compose.yml logs -f    update: $COMPOSE pull && $COMPOSE up -d"
    ;;
  web)
    [ -z "$HUB_URL" ] && HUB_URL=$(ask "  hub url (e.g. http://192.168.1.20:3001)" "http://localhost:3001")
    WEB_PORT=$(ask "  port for the web app" "$WEB_PORT")
    REL="$VERSION"; [ "$REL" = latest ] && REL=$(curl -fsSL https://api.github.com/repos/orbis-hub/orbis/releases/latest | sed -n 's/.*"tag_name": *"\(v[^"]*\)".*/\1/p') || true
    [ -z "$REL" ] && REL="v0.1.0"
    case "$REL" in v*) ;; *) REL="v$REL";; esac
    say "  downloading web build $REL"
    rm -rf web && mkdir -p web
    curl -fsSL "https://github.com/orbis-hub/orbis/releases/download/$REL/web.tgz" | tar -xz -C web
    # the app asks for the hub url on first start; pre-seed it so nobody has to type it
    cat > web/orbis-config.js <<EOF
try { if (!localStorage.getItem("orbis.hubUrl")) localStorage.setItem("orbis.hubUrl", "$HUB_URL"); } catch (e) {}
EOF
    sed -i.bak 's#<head>#<head><script src="/orbis-config.js"></script>#' web/index.html 2>/dev/null && rm -f web/index.html.bak || true
    cat > nginx.conf <<'EOF'
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;
  location / { try_files $uri $uri/ $uri.html /index.html; }
  location /_next/static/ { add_header Cache-Control "public, max-age=31536000, immutable"; }
}
EOF
    cat > docker-compose.yml <<EOF
services:
  orbis-web:
    image: nginx:alpine
    container_name: orbis-web
    restart: unless-stopped
    ports:
      - "$WEB_PORT:80"
    volumes:
      - ./web:/usr/share/nginx/html:ro
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
EOF
    $COMPOSE up -d
    IP=$(hostname -I 2>/dev/null | awk '{print $1}'); [ -z "$IP" ] && IP=localhost
    say ""
    say "  done. web app at http://$IP:$WEB_PORT, talking to $HUB_URL"
    say "  on the hub, add http://$IP:$WEB_PORT to ORBIS_CORS_ORIGINS and restart it, otherwise the browser blocks the api calls."
    ;;
esac
say ""
