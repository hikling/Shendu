#!/bin/sh
set -eu
: "${SHENDU_SNAPSHOT_PASSWORD:?请先设置 SHENDU_SNAPSHOT_PASSWORD（至少 15 个字符）}"
stamp="$(date +%Y%m%d-%H%M%S)"
out_dir="${1:-./backups}"
mkdir -p "$out_dir"
docker compose exec -T shendu node scripts/admin-cli.mjs snapshot "/app/tmp/shendu-site-$stamp.shendu-db" "$SHENDU_SNAPSHOT_PASSWORD"
docker compose cp "shendu:/app/tmp/shendu-site-$stamp.shendu-db" "$out_dir/shendu-site-$stamp.shendu-db"
chmod 600 "$out_dir/shendu-site-$stamp.shendu-db"
echo "$out_dir/shendu-site-$stamp.shendu-db"
