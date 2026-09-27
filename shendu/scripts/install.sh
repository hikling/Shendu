#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "请先执行 su - 进入 root 账户，再运行：sh scripts/install.sh"
  exit 1
fi

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
app_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"
cd "$app_dir"

if [ ! -f .env.example ]; then
  echo "缺少 $app_dir/.env.example，请重新拉取完整项目后再执行安装。"
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl gnupg openssl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

if [ ! -f .env ]; then
  cp .env.example .env
  key="$(openssl rand -hex 32)"
  sed -i "s/replace_with_64_hex_characters/$key/" .env
  chmod 600 .env
  echo "已生成 .env，请先修改 SHENDU_DOMAIN，再运行：docker compose up -d --build"
else
  chmod 600 .env
  echo ".env 已存在，未覆盖。"
fi

mkdir -p data tmp backups
