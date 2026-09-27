#!/bin/sh
set -eu

umask 077
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
app_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"
out_dir="${1:-$app_dir/backups}"
reason="${2:-manual}"
password_file="${SHENDU_SNAPSHOT_PASSWORD_FILE:-$app_dir/data/server-backup.password}"

case "$reason" in
  manual|pre-update) ;;
  *) echo "备份类型只能是 manual 或 pre-update" >&2; exit 1 ;;
esac

mkdir -p "$app_dir/data" "$app_dir/tmp" "$out_dir" "$(dirname -- "$password_file")"
out_dir="$(CDPATH= cd -- "$out_dir" && pwd)"

if [ -n "${SHENDU_SNAPSHOT_PASSWORD:-}" ]; then
  backup_password="$SHENDU_SNAPSHOT_PASSWORD"
else
  if [ ! -f "$password_file" ]; then
    command -v openssl >/dev/null 2>&1 || { echo "缺少 openssl，无法生成整站备份密码" >&2; exit 1; }
    openssl rand -hex 32 > "$password_file"
    chmod 600 "$password_file"
    echo "已生成服务器整站备份密码文件：$password_file" >&2
    echo "请把该密码文件另存到服务器之外；恢复整站快照时必须使用。" >&2
  fi
  chmod 600 "$password_file"
  backup_password="$(tr -d '\r\n' < "$password_file")"
fi

[ "${#backup_password}" -ge 15 ] || { echo "整站备份密码不能少于 15 个字符" >&2; exit 1; }

stamp="$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S)-$$"
filename="shendu-full-site-$reason-$stamp.shendu-db"
container_file="/app/tmp/$filename"
host_temp="$app_dir/tmp/$filename"
output_file="$out_dir/$filename"
password_token=".snapshot-password-$$"
password_host_file="$app_dir/tmp/$password_token"
password_container_file="/app/tmp/$password_token"

cleanup() {
  rm -f -- "$host_temp"
  rm -f -- "$password_host_file"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
printf '%s\n' "$backup_password" > "$password_host_file"
chmod 600 "$password_host_file"

cd "$app_dir"
docker compose config >/dev/null
if ! docker compose exec -T -u root shendu node scripts/admin-cli.mjs snapshot "$container_file" --password-file "$password_container_file"; then
  echo "运行中的应用容器不可用，正在使用临时容器创建整站快照……" >&2
  docker compose run --rm --no-deps shendu node scripts/admin-cli.mjs snapshot "$container_file" --password-file "$password_container_file"
fi

[ -s "$host_temp" ] || { echo "整站快照没有生成，备份已停止" >&2; exit 1; }
install -m 600 "$host_temp" "$output_file"
echo "整站加密备份已完成：$output_file" >&2
echo "$output_file"
