#!/bin/sh
set -eu

umask 077

fail() {
  echo "更新失败：$*" >&2
  exit 1
}

if [ "$(id -u)" -ne 0 ]; then
  fail "请先执行 su - 进入 root 账户，再运行本脚本。"
fi

requested_repo="${1:-}"
if [ -n "$requested_repo" ]; then
  repo_dir="$(CDPATH= cd -- "$requested_repo" 2>/dev/null && pwd)" || fail "找不到项目目录：$requested_repo"
else
  script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
  app_dir_from_script="$(CDPATH= cd -- "$script_dir/.." && pwd)"
  repo_dir="$(CDPATH= cd -- "$app_dir_from_script/.." && pwd)"
fi

# Git 更新可能替换正在执行的脚本，因此先用临时副本重新执行。
if [ "${SHENDU_UPDATE_REEXEC:-0}" != "1" ]; then
  update_copy="$(mktemp /tmp/shendu-update.XXXXXX)"
  cp "$0" "$update_copy"
  chmod 700 "$update_copy"
  SHENDU_UPDATE_REEXEC=1 exec sh "$update_copy" "$repo_dir" "$update_copy"
fi

update_copy="${2:-}"
cleanup() {
  if [ -n "$update_copy" ] && [ -f "$update_copy" ]; then
    rm -f -- "$update_copy"
  fi
  if [ -n "${backup_temp_file:-}" ] && [ -f "$backup_temp_file" ]; then
    rm -f -- "$backup_temp_file"
  fi
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

app_dir="$repo_dir/shendu"
git_in_repo() {
  # 旧版安装文档要求 chmod +x，部分服务器因此只有脚本权限位发生变化。
  # 部署更新只比较文件内容，忽略 chmod 产生的权限差异。
  git -c safe.directory="$repo_dir" -c core.fileMode=false -C "$repo_dir" "$@"
}

command -v git >/dev/null 2>&1 || fail "服务器没有安装 git。请先执行：apt update && apt install -y git"
[ -d "$repo_dir/.git" ] || fail "$repo_dir 不是 Git 克隆目录。ZIP 解压版不能执行 git pull，请按 README 的“ZIP 旧部署迁移”处理。"
[ -f "$app_dir/compose.yaml" ] || fail "缺少 $app_dir/compose.yaml，项目目录可能填写错误。"
[ -f "$app_dir/.env" ] || fail "缺少 $app_dir/.env。为防止覆盖域名与加密密钥，脚本已停止。"

branch="$(git_in_repo symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
[ "$branch" = "main" ] || fail "当前分支是 ${branch:-游离状态}，不是 main。请先确认服务器上的代码来源。"

if ! git_in_repo diff --quiet || ! git_in_repo diff --cached --quiet; then
  git_in_repo status --short >&2
  fail "检测到受版本控制文件的内容被修改。上方已列出文件；请按 README 的“服务器存在本地代码修改”处理。"
fi

if [ ! -f "$app_dir/data/backup-master.key" ]; then
  echo "警告：没有找到 data/backup-master.key。请确认这是尚未首次启动的新站；已有数据的站点不要继续丢失该文件。" >&2
fi

command -v docker >/dev/null 2>&1 || fail "没有找到 Docker。请重新运行 scripts/install.sh 安装 Docker。"
docker compose version >/dev/null 2>&1 || fail "没有找到 Docker Compose v2 插件。"

cd "$app_dir"
echo "[1/6] 校验 Compose 与本机配置……"
docker compose config >/dev/null

echo "[2/6] 选择是否创建更新前整站备份……"
backup_choice="${SHENDU_BACKUP_BEFORE_UPDATE:-}"
if [ -z "$backup_choice" ]; then
  if [ -t 0 ]; then
    printf "是否先备份全站数据？输入 y 确认备份，输入 n 或直接回车跳过 [y/N]："
    IFS= read -r backup_choice || backup_choice=""
  else
    backup_choice="no"
    echo "当前为非交互运行，未收到备份确认，已跳过整站备份。"
  fi
fi

case "$backup_choice" in
  y|Y|yes|YES|Yes|1|是)
    command -v openssl >/dev/null 2>&1 || fail "没有找到 openssl，无法生成整站备份密码。"
    mkdir -p "$app_dir/data" "$app_dir/tmp" "$app_dir/backups"
    backup_password_file="$app_dir/data/server-backup.password"
    if [ ! -f "$backup_password_file" ]; then
      openssl rand -hex 32 > "$backup_password_file"
      echo "已生成备份密码文件：$backup_password_file"
      echo "请把该密码文件另存到服务器之外；恢复整站快照时必须使用。"
    fi
    chmod 600 "$backup_password_file"
    backup_password="$(tr -d '\r\n' < "$backup_password_file")"
    [ "${#backup_password}" -ge 15 ] || fail "$backup_password_file 中的密码少于 15 个字符。"
    backup_stamp="$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S)"
    backup_name="shendu-full-site-pre-update-$backup_stamp.shendu-db"
    backup_container_file="/app/tmp/$backup_name"
    backup_temp_file="$app_dir/tmp/$backup_name"
    backup_output_file="$app_dir/backups/$backup_name"
    if ! docker compose exec -T shendu node scripts/admin-cli.mjs snapshot "$backup_container_file" "$backup_password"; then
      echo "运行中的应用容器不可用，正在使用临时容器创建整站快照……" >&2
      if ! docker compose run --rm --no-deps shendu node scripts/admin-cli.mjs snapshot "$backup_container_file" "$backup_password"; then
        fail "无法创建更新前整站备份；代码和容器均未更新。"
      fi
    fi
    [ -s "$backup_temp_file" ] || fail "整站备份文件没有生成；代码和容器均未更新。"
    install -m 600 "$backup_temp_file" "$backup_output_file"
    rm -f -- "$backup_temp_file"
    backup_temp_file=""
    echo "整站备份：$backup_output_file"
    ;;
  n|N|no|NO|No|0|否|'')
    echo "已按选择跳过整站备份，继续更新。"
    ;;
  *)
    fail "备份选项无效。请输入 y 确认备份，或输入 n 跳过。"
    ;;
esac

old_commit="$(git_in_repo rev-parse --short HEAD)"
echo "[3/6] 拉取 GitHub main 分支……"
git_in_repo fetch --prune origin main
git_in_repo merge --ff-only origin/main
new_commit="$(git_in_repo rev-parse --short HEAD)"

if [ "${SHENDU_UPDATE_GIT_ONLY:-0}" = "1" ]; then
  echo "Git 更新测试通过：$old_commit -> $new_commit"
  exit 0
fi

echo "[4/6] 用新版代码再次校验 Compose……"
docker compose config >/dev/null

echo "[5/6] 构建新版应用镜像（当前网站继续运行）……"
docker compose build --pull shendu

echo "[6/6] 启动新版应用并等待健康检查……"
docker compose up -d --no-deps shendu
attempt=0
health=""
while [ "$attempt" -lt 60 ]; do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' shendu 2>/dev/null || true)"
  [ "$health" = "healthy" ] && break
  case "$health" in
    exited|dead)
      docker compose logs --tail=160 shendu >&2 || true
      fail "shendu 容器已经退出。上方是错误日志。"
      ;;
  esac
  attempt=$((attempt + 1))
  sleep 2
done

if [ "$health" != "healthy" ]; then
  docker compose logs --tail=160 shendu >&2 || true
  fail "等待 120 秒后应用仍未通过健康检查（当前状态：${health:-未知}）。"
fi

echo "应用健康检查通过，正在启动完整服务并清理旧容器……"
docker compose up -d --remove-orphans
docker compose ps

version="$(sed -n '1p' VERSION 2>/dev/null || true)"
echo "更新完成：$old_commit -> $new_commit${version:+，慎独 v$version}"
echo "如果浏览器仍显示旧界面，请执行强制刷新（Windows：Ctrl+F5；手机：清除本站缓存后重开）。"
