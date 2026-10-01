# orbis installer (windows, powershell 5.1+)
#   irm https://raw.githubusercontent.com/orbis-hub/orbis/main/install.ps1 | iex
#   or: .\install.ps1 -Mode both|hub|web [-Dir .\orbis] [-Port 3001] [-HubUrl http://host:3001] [-Version 0.1.0] [-Yes]
#
# modes
#   both  hub + web in one docker container (default). the hub serves the web app itself.
#   hub   hub only (api + websocket, no web ui)
#   web   web only: static files served by nginx in docker, talking to a hub elsewhere
param(
  [ValidateSet("both", "hub", "web", "")] [string]$Mode = "",
  [string]$Dir = ".\orbis",
  [string]$Port = "3001",
  [string]$WebPort = "8080",
  [string]$HubUrl = "",
  [string]$Version = "latest",
  [switch]$Yes
)
$ErrorActionPreference = "Stop"

function Ask($prompt, $default) {
  if ($Yes) { return $default }
  $a = Read-Host "  $prompt [$default]"
  if ([string]::IsNullOrWhiteSpace($a)) { return $default } else { return $a }
}

Write-Host ""
Write-Host "  o orbis installer"
Write-Host ""

if (-not $Mode) {
  Write-Host "  what should run on this machine?"
  Write-Host "    1) hub + web   everything in one container (recommended)"
  Write-Host "    2) hub only    api + websocket, web ui lives elsewhere"
  Write-Host "    3) web only    static web app pointing at a hub elsewhere"
  $c = Ask "choice" "1"
  switch ($c) { "2" { $Mode = "hub" } "3" { $Mode = "web" } default { $Mode = "both" } }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host "  docker desktop is required: https://docs.docker.com/desktop/install/windows-install/"
  exit 1
}

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Set-Location $Dir
$image = "ghcr.io/orbis-hub/orbis:$Version"
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } | Select-Object -First 1).IPAddress
if (-not $ip) { $ip = "localhost" }

if ($Mode -eq "both" -or $Mode -eq "hub") {
  if ($Port -eq "3001") { $Port = Ask "port" "3001" }
  # note: docker desktop on windows has no host networking; the lan device scanner only sees the docker network.
  # run the hub on a linux box or a pi if you want device discovery.
  $webDir = if ($Mode -eq "hub") { "      ORBIS_WEB_DIR: /nonexistent`n" } else { "" }
  $compose = @"
services:
  orbis:
    image: $image
    container_name: orbis
    restart: unless-stopped
    ports:
      - "${Port}:3001"
    environment:
      PORT: "3001"
      LOG_LEVEL: info
$webDir      ORBIS_CORS_ORIGINS: ""
    volumes:
      - ./data:/data
"@
  Set-Content -Path docker-compose.yml -Value $compose -Encoding utf8
  docker compose pull
  docker compose up -d
  Write-Host ""
  if ($Mode -eq "both") {
    Write-Host "  done. open http://${ip}:$Port and create the owner account."
  } else {
    Write-Host "  done. hub api at http://${ip}:$Port/api/health"
    Write-Host "  install the web part elsewhere with: install.ps1 -Mode web -HubUrl http://${ip}:$Port"
  }
  Write-Host "  note: on windows/docker desktop the network scanner cannot see your lan (no host networking)."
}
elseif ($Mode -eq "web") {
  if (-not $HubUrl) { $HubUrl = Ask "hub url (e.g. http://192.168.1.20:3001)" "http://localhost:3001" }
  $WebPort = Ask "port for the web app" $WebPort
  $rel = $Version
  if ($rel -eq "latest") {
    try { $rel = (Invoke-RestMethod "https://api.github.com/repos/orbis-hub/orbis/releases/latest").tag_name } catch { $rel = "v0.1.0" }
  }
  if ($rel -notlike "v*") { $rel = "v$rel" }
  Write-Host "  downloading web build $rel"
  if (Test-Path web) { Remove-Item -Recurse -Force web }
  New-Item -ItemType Directory -Force -Path web | Out-Null
  Invoke-WebRequest "https://github.com/orbis-hub/orbis/releases/download/$rel/web.tgz" -OutFile web.tgz
  tar -xzf web.tgz -C web
  Remove-Item web.tgz
  Set-Content -Path web\orbis-config.js -Encoding utf8 -Value "try { if (!localStorage.getItem('orbis.hubUrl')) localStorage.setItem('orbis.hubUrl', '$HubUrl'); } catch (e) {}"
  (Get-Content web\index.html -Raw) -replace "<head>", "<head><script src=`"/orbis-config.js`"></script>" | Set-Content web\index.html -Encoding utf8
  $nginx = @'
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;
  location / { try_files $uri $uri/ $uri.html /index.html; }
  location /_next/static/ { add_header Cache-Control "public, max-age=31536000, immutable"; }
}
'@
  Set-Content -Path nginx.conf -Value $nginx -Encoding utf8
  $compose = @"
services:
  orbis-web:
    image: nginx:alpine
    container_name: orbis-web
    restart: unless-stopped
    ports:
      - "${WebPort}:80"
    volumes:
      - ./web:/usr/share/nginx/html:ro
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
"@
  Set-Content -Path docker-compose.yml -Value $compose -Encoding utf8
  docker compose up -d
  Write-Host ""
  Write-Host "  done. web app at http://${ip}:$WebPort, talking to $HubUrl"
  Write-Host "  on the hub, add http://${ip}:$WebPort to ORBIS_CORS_ORIGINS and restart it."
}
Write-Host ""
