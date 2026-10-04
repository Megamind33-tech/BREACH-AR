#!/usr/bin/env bash
# Backs up the Viro Control database and the job-signing key. Keeps the last 14 backups.
# Usage: bash backup.sh      (run daily from cron: 17 3 * * * bash ~/viro-control/deploy/contabo/backup.sh)
set -euo pipefail
cd "$(dirname "$0")"
DEST="${BACKUP_DIR:-$HOME/viro-control-backups}"; mkdir -p "$DEST"; chmod 700 "$DEST"
STAMP="$(date +%Y%m%d-%H%M%S)"
docker exec viro-control-db pg_dump -U viro -d viro --no-owner | gzip > "$DEST/viro-$STAMP.sql.gz"
# The signing key is what every enrolled computer trusts. Losing it means every computer must re-enroll, so it is backed up with the data.
cp -p .env "$DEST/env-$STAMP" && chmod 600 "$DEST/env-$STAMP"
ls -1t "$DEST"/viro-*.sql.gz | tail -n +15 | xargs -r rm -f
ls -1t "$DEST"/env-* | tail -n +15 | xargs -r rm -f
echo "Backup written: $DEST/viro-$STAMP.sql.gz ($(du -h "$DEST/viro-$STAMP.sql.gz" | cut -f1))"
