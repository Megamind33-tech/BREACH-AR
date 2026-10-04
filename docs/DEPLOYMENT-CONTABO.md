# Viro Control on the Contabo server

Where: the shared VPS reached with `ssh viro3` (79.143.177.140, user `claudeagent`, member of the `docker` group, no sudo). Other applications already run there (mail, reach, zamcops); this stack touches none of them.

| Piece | Where |
|---|---|
| Source and config | `~/viro-control` on the server (uploaded from `server/` and `deploy/contabo/`) |
| Containers | `viro-control-app` (127.0.0.1:8090 only) and `viro-control-db` (no host port) |
| Secrets | `~/viro-control/deploy/contabo/.env` (mode 600): database, JWT, platform key, job-signing key |
| First platform admin | `first-login.txt` next to `.env` (mode 600); delete after changing the password |
| Backups | `bash ~/viro-control/deploy/contabo/backup.sh` (database + `.env`, last 14 kept in `~/viro-control-backups`) |

## Two sides
- **Platform console** at `/platform.html`: the operator (our organization) creates and suspends organizations, adds or resets their administrators, publishes the Windows installer, and sees the activity log. Separate sign-in and token from everything below.
- **Organization console** at `/`: each organization's own owners, admins, technicians and viewers manage their computers, people, sites and policies. An organization's token never works on the platform side and the reverse. Suspending an organization blocks its people and computers at once.

## Public address (needs an administrator with sudo; the app account cannot do this)
1. DNS: add `A control.viro3.online -> 79.143.177.140` at the DNS provider.
2. On the server, with sudo:
```
sudo cp /home/claudeagent/viro-control/deploy/contabo/nginx-control.conf /etc/nginx/sites-available/control.viro3.online.conf
sudo ln -s /etc/nginx/sites-available/control.viro3.online.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d control.viro3.online
```
Computers only talk to Control over https (plain http is accepted solely for private local addresses).

## Update
Upload the new `server/` and `deploy/contabo/`, then `bash install.sh` again (it keeps `.env`). Migrations apply on start.


## Marketing site on the company domain
The landing site is part of the Control app (`/site/`). To show it at the root of `viro3.online` and `www.viro3.online`, add DNS A records for both names to this server, then (with sudo) install `deploy/contabo/nginx-landing.conf`, run certbot for both names, test and reload nginx. The console stays on `control.viro3.online`. The site's "Sign in" links lead to the console address when served from the company domain.
