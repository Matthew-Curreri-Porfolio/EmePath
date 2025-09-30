#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DB_PATH="$ROOT_DIR/gateway/db/app.db"
BACKUP_DIR="$ROOT_DIR/backups"
mkdir -p "$BACKUP_DIR"

TS=$(date +%Y%m%d_%H%M%S)
BASE_NAME="gateway-db_$TS.db"
cp "$DB_PATH" "$BACKUP_DIR/$BASE_NAME"
gzip -9 "$BACKUP_DIR/$BASE_NAME"

echo "Backup created: $BACKUP_DIR/$BASE_NAME.gz"

# Optional retention: keep latest 14 backups
ls -1t "$BACKUP_DIR"/gateway-db_*.db.gz | tail -n +15 | xargs -r rm -f
