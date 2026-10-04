#!/usr/bin/env bash
# Sets up and starts Viro Control on this server. Safe to run again: existing secrets are kept, nothing is overwritten.
# Usage: bash install.sh admin@yourdomain.com
set -euo pipefail
cd "$(dirname "$0")"
ADMIN_EMAIL="${1:-}"

if [ ! -f .env ]; then
  [ -n "$ADMIN_EMAIL" ] || { echo "First run: give the email address for the first platform admin, e.g. bash install.sh you@example.com"; exit 2; }
  rand() { openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-"$1"; }
  umask 077
  ADMIN_PASSWORD="$(rand 24)"
  KEY="$(openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt | awk 'NF{printf "%s\\n",$0}')"
  {
    echo "POSTGRES_PASSWORD=$(rand 32)"
    echo "JWT_SECRET=$(rand 64)"
    echo "PLATFORM_KEY=$(rand 48)"
    echo "JOB_SIGNING_KEY=$KEY"
    echo "PLATFORM_ADMIN_EMAIL=$ADMIN_EMAIL"
    echo "PLATFORM_ADMIN_PASSWORD=$ADMIN_PASSWORD"
  } > .env
  printf 'Platform console sign-in\nEmail: %s\nPassword: %s\n\nChange this password after the first sign-in, then delete this file.\n' "$ADMIN_EMAIL" "$ADMIN_PASSWORD" > first-login.txt
  echo "Created .env (secrets) and first-login.txt (the first platform admin's password). Both are readable only by you."
fi

docker compose up -d --build
echo "Waiting for the app to become healthy..."
for i in $(seq 1 60); do
  s="$(docker inspect -f '{{.State.Health.Status}}' viro-control-app 2>/dev/null || echo starting)"
  [ "$s" = "healthy" ] && break; sleep 3
done
docker compose ps
curl -fsS http://127.0.0.1:8090/healthz && echo "  <- Viro Control answers on 127.0.0.1:8090"
