#!/usr/bin/env bash
# Puts the Viro WorkCare marketing site on https://workcare.viro3.online. Run on the Contabo host by someone with sudo, after the DNS record exists.
# Before running: add a DNS A record  workcare.viro3.online -> 79.143.177.140  and wait until it resolves.
set -euo pipefail
cd "$(dirname "$0")"
getent hosts workcare.viro3.online >/dev/null || { echo "workcare.viro3.online does not resolve yet: add the DNS record first"; exit 1; }
sudo cp nginx-workcare.conf /etc/nginx/sites-available/workcare.viro3.online.conf
sudo ln -sf /etc/nginx/sites-available/workcare.viro3.online.conf /etc/nginx/sites-enabled/workcare.viro3.online.conf
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d workcare.viro3.online --redirect --non-interactive --agree-tos -m info@viro3.online
sudo nginx -t && sudo systemctl reload nginx
curl -sI https://workcare.viro3.online/ | head -3
