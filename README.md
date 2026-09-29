# 慎独 SHENDU

按照所附 `code.html` 视觉稿实现的自托管个人复盘系统。界面覆盖电脑与手机，手机端用左侧抽屉进入全部功能。数据保存在自己的 Debian 服务器，不依赖 GPT 或第三方登录。

## 已实现

- 每日、每周、每月、90 天、年度、重大决策六类复盘
- 复盘周期按北京时间锁定：每日仅写今日、每周仅写本周，其余类型仅写当前周期；历史记录只读可查
- 草稿、完整性检查、完成后永久锁定、单次行动验证、版本冲突保护；六类复盘与行动验证的核心问题标题可在阶段设置中编辑，锁定记录会保留当时模板快照
- 每类 14 条文案，按账户和日期轮换
- 历史搜索与类型、年份、月份筛选；筛选栏在电脑与手机上自动重排，避免文字与下拉箭头挤压
- 所有书写控件统一使用日记正文的字体与字号，阶段指标输入框固定高度并与状态选项对齐
- 六套三色主题、自定义颜色、减少动态效果
- `code.html` 同款 Great Vibes / Pinyon Script / Alex Brush 艺术字体已随安装包本地提供；页面不加载第三方字体或统计脚本
- 用户注册登录、首位用户自动成为超级管理员并自动关闭公开注册、成员/管理员权限；管理员可在密码与用户名双重确认后永久删除授权范围内的账户及其关联数据
- 账户管理、阶段设置、备份弹窗和全部表单针对手机窄屏自适应，账户列表在移动端自动转为卡片布局
- 复盘标题、正文、日记、验证结果和个人设置落盘前使用 AES-256-GCM 加密；旧版明文数据库首次启动时自动迁移并清理旧页
- 个人 `.shendu` v4 整包加密导出、浏览器校验、安全合并与完整恢复；用户名只写入加密载荷，跨账户恢复必须再次确认原用户名与原备份密码，并兼容 v3 及更早加密备份
- 超级管理员可在网页导出、校验并恢复 `.shendu-site` 整站加密迁移包，一次迁移全部账户、密码摘要、复盘、设置和外部备份配置
- 每次服务器更新时询问是否生成 `.shendu-db` 整站加密快照；只有确认后才备份，备份失败时停止更新
- WebDAV 与 S3 兼容存储（R2、AWS S3、MinIO 等），连接读写校验和定时备份
- SQLite WAL、健康检查、安全响应头、严格同源写入检查、登录限速、上传任务限额与容器日志轮换
- 单账户最多 10,000 条复盘、32 MiB 加密正文容量，单条复盘最多 1 MiB；超限会明确报错，避免异常上传耗尽服务器资源
- Debian + Docker Compose + Caddy 自动 HTTPS

## Debian 12 / 13 部署

以下服务器命令需要在 **root 账户**执行。若当前不是 root，请先单独执行 `su -`，进入 root 后再复制后续命令；Debian 精简系统可能没有安装 `sudo`，所以本文不依赖 `sudo`。

### 1. 从 GitHub 下载

```bash
apt update && apt install -y git
git clone https://github.com/hikling/Shendu.git /opt/Shendu
cd /opt/Shendu/shendu
```

如果已经克隆过项目，先执行 `cd /opt/Shendu/shendu`，确认当前目录里能看到 `.env.example`、`compose.yaml` 和 `scripts/`，再继续安装。

### 2. 安装 Docker 并生成配置

```bash
sh scripts/install.sh
```

编辑 `.env`：

```bash
nano .env
```

至少修改：

```env
SHENDU_DOMAIN=shendu.your-domain.com
```

`SHENDU_MASTER_KEY` 已由安装脚本随机生成；程序首次启动后会把实际使用的数据加密主密钥持久化为 `./data/backup-master.key`。升级或重启会自动沿用该文件，请不要删除、替换或公开它。由 v5.1.x 或更早版本升级时会自动加密旧复盘数据，并通过 WAL 截断与 `VACUUM` 清理数据库文件中的旧明文页。

容器启动时会先校正宿主机 `data`、`tmp` 挂载目录的权限，再以普通 `node` 用户运行服务；从全新目录解压后可直接启动，不需要手工 `chown`。

### 3. 启动

```bash
docker compose up -d --build
docker compose ps
```

浏览器打开 `https://你的域名`。第一个注册账户会自动成为唯一超级管理员。

查看日志：

```bash
docker compose logs -f --tail=100
```

如果 Caddy 报 `dependency shendu failed to start`，先查看 `docker compose logs shendu`。本版已修复全新解压后挂载目录属于 root、导致 SQLite 或恢复临时文件无法写入的问题。

## 服务器更新已有部署

新版更新脚本会在拉取代码之前询问是否备份全站数据。只有明确输入 `y` 才会生成整站加密快照；输入 `n` 或直接回车会跳过。选择备份后若生成失败，脚本不会继续更新。网页导出的 `.shendu-site` 仍适合另存到电脑或其他服务器。更新过程中绝对不要删除或替换 `.env`、`data/` 和 `data/backup-master.key`。

### 1. 先确认是不是 Git 部署

在 root 账户执行：

```bash
if [ -d /opt/Shendu/.git ]; then
  echo "Git 部署，可以直接更新"
else
  echo "不是 Git 部署，不能使用 git pull"
fi
```

只有显示“Git 部署，可以直接更新”时，才继续下一步。如果项目不在 `/opt/Shendu`，请把后续命令中的路径替换成实际的 **仓库根目录**；仓库根目录应同时包含 `README.md` 和 `shendu/`。

### 2. 第一次使用新版更新脚本

旧版本还没有 `scripts/update.sh` 时，直接从 GitHub 下载最新版更新脚本：

```bash
apt-get update
apt-get install -y ca-certificates curl
curl -fL https://raw.githubusercontent.com/hikling/Shendu/main/shendu/scripts/update.sh \
  -o /tmp/shendu-update.sh
chmod 700 /tmp/shendu-update.sh
sh /tmp/shendu-update.sh /opt/Shendu
```

脚本会自动完成以下检查和操作：

- 不依赖 Git 是否设置了上游分支，直接获取 `origin/main`
- 自动处理 Git 的 `safe.directory` 检查
- 检查当前分支、受版本控制文件和 `.env`，发现风险立即停止，不强行覆盖
- 拉取代码前询问是否创建整站 AES-256-GCM 加密快照，只有输入 `y` 才执行
- 先构建新镜像，构建失败时不动正在运行的网站
- 先单独启动 `shendu` 并等待健康检查，再启动 Caddy，避免 `dependency shendu failed to start`
- 保留 `.env`、数据库、内部主密钥、Caddy 证书和全部用户资料

### 3. 以后更新只需要一条命令

```bash
sh /opt/Shendu/shendu/scripts/update.sh
```

运行后会显示：

```text
是否先备份全站数据？输入 y 确认备份，输入 n 或直接回车跳过 [y/N]：
```

输入 `y` 后才会生成：

- 整站快照：`/opt/Shendu/shendu/backups/shendu-full-site-pre-update-日期时间.shendu-db`
- 恢复密码文件：`/opt/Shendu/shendu/data/server-backup.password`

两者权限均为 `600`。快照包含全部账户、密码摘要、复盘、设置、外部备份配置、运行记录和内部数据密钥。请至少把密码文件另存到服务器之外；只保存快照、不保存密码将无法恢复。输入 `n` 或直接回车时不会创建快照，也不会生成新的备份密码文件。

无人值守更新可以通过环境变量明确选择：

```bash
SHENDU_BACKUP_BEFORE_UPDATE=yes sh /opt/Shendu/shendu/scripts/update.sh
# 或明确跳过：
SHENDU_BACKUP_BEFORE_UPDATE=no sh /opt/Shendu/shendu/scripts/update.sh
```

无论当前位于哪个目录都可以执行。如果仓库不在 `/opt/Shendu`，也可以明确传入仓库根目录：

```bash
sh /实际路径/shendu/scripts/update.sh /实际路径
```

### 4. 更新后检查

```bash
cd /opt/Shendu/shendu
docker compose ps
curl -fsS https://你的域名/healthz
```

健康检查应返回包含 `"ok":true` 的 JSON。浏览器仍显示旧界面时，Windows 使用 `Ctrl + F5`；手机浏览器清除本站缓存后重新打开。

### 5. 常见错误

#### 显示“不是 Git 克隆目录”或 `not a git repository`

说明服务器上运行的是以前上传的 ZIP 解压版，ZIP 中没有 `.git`，因此任何 `git pull` 命令都不可能成功。请按下一节“ZIP 旧部署迁移”处理。

#### 显示“受版本控制文件被修改”

新版更新脚本会自动忽略旧安装命令造成的 `chmod +x` 权限变化。如果仍然出现这个错误，说明服务器上的代码内容确实被改过。执行下面的命令查看改动：

```bash
git -c safe.directory=/opt/Shendu -c core.fileMode=false \
  -C /opt/Shendu status --short
git -c safe.directory=/opt/Shendu -c core.fileMode=false \
  -C /opt/Shendu diff --stat
```

先备份并确认这些代码修改是否需要保留。更新脚本不会使用 `git reset --hard`，也不会擅自覆盖真实的代码内容。

#### 显示 Docker 未启动

```bash
systemctl enable --now docker
sh /opt/Shendu/shendu/scripts/update.sh
```

#### 容器没有通过健康检查

更新脚本会自动打印应用日志，也可以手动查看：

```bash
cd /opt/Shendu/shendu
docker compose logs --tail=200 shendu
docker compose logs --tail=200 caddy
```

#### 显示“无法创建更新前整站备份”

为防止升级时丢失资料，更新脚本不会绕过备份继续运行。先查看应用状态与日志：

```bash
cd /opt/Shendu/shendu
docker compose ps
docker compose logs --tail=200 shendu
```

## ZIP 旧部署迁移为 Git 部署

ZIP 解压版不能原地执行 `git pull`。最安全的方法是使用网页整站备份迁移，并保留旧目录作为回退：

1. 在旧站使用超级管理员导出 `.shendu-site` 整站加密备份，并保存好备份密码。
2. 在旧项目中执行 `docker compose down`。执行前必须先 `cd` 到能看到旧站 `compose.yaml` 的目录。
3. 保留旧目录并重新克隆：

```bash
cd /opt
shendu_old_dir="/opt/Shendu-zip-old-$(date +%Y%m%d-%H%M%S)"
mv /opt/Shendu "$shendu_old_dir"
echo "旧站已保留在：$shendu_old_dir"
git clone https://github.com/hikling/Shendu.git /opt/Shendu
cd /opt/Shendu/shendu
sh scripts/install.sh
```

4. 把新站 `.env` 中的 `SHENDU_DOMAIN` 改成原来的域名：

```bash
nano /opt/Shendu/shendu/.env
```

5. 启动新站：

```bash
cd /opt/Shendu/shendu
docker compose up -d --build
docker compose ps
```

6. 打开网站，创建一个临时超级管理员，然后在“数据备份”中恢复 `.shendu-site`。
7. 确认原账户、复盘、设置和备份目标全部正常后，再自行处理刚才命令显示的旧站目录；确认前不要删除旧目录。

如果旧项目目录本来不叫 `/opt/Shendu`，只替换上面命令中的旧目录路径，新 Git 部署仍建议固定为 `/opt/Shendu`。

## Cloudflare 域名设置

1. 在 Cloudflare DNS 添加一条 `A` 记录，指向服务器公网 IP。
2. 初次签发证书时建议先用“仅 DNS（灰云）”。网站正常打开后可改为“已代理（橙云）”。
3. Cloudflare 的 SSL/TLS 加密模式使用 **Full (strict)**。
4. 不要为 `/api/*` 设置缓存规则；HTML 也不应缓存。
5. 服务器防火墙开放 TCP 80、443；使用 HTTP/3 时再开放 UDP 443。

## 数据位置与日常备份

- SQLite：`./data/shendu.db`（敏感内容为 AES-256-GCM 密文，文件权限 `600`）
- 数据加密主密钥：`./data/backup-master.key`（文件权限 `600`，丢失后服务器数据无法解密）
- 服务器快照恢复密码：`./data/server-backup.password`（首次确认备份后生成，文件权限 `600`）
- 更新前整站快照：`./backups/shendu-full-site-pre-update-*.shendu-db`（仅在更新时确认备份后生成）
- Caddy 证书：Docker 卷 `caddy_data`
- 临时导入文件：`./tmp`，完成、取消或空闲一小时后清理

账户用户名、称呼、权限、记录类型与日期等运行所需元数据保存在数据库中；复盘标题、正文、日记、验证内容、个人设置及外部备份凭据会加密。整站和个人导出文件均为独立密码加密的整包。服务器拥有数据主密钥，取得服务器管理权限的人仍可读取运行中的资料；请妥善保护服务器和 `backup-master.key`。

### 网页整站迁移（推荐）

1. 在旧站用超级管理员进入“数据备份”，选择“导出整站备份”，输入当前登录密码并设置一个独立的整站备份密码。
2. 在新服务器完成部署，先创建一个临时超级管理员账户。
3. 用临时超级管理员进入“数据备份”，上传 `.shendu-site`，输入整站备份密码、当前临时管理员登录密码，并按页面提示确认。
4. 恢复会完整替换新站现有资料、注销全部会话，并用新服务器的内部主密钥重新加密数据。随后使用旧站原超级管理员账户登录即可。

`.shendu-site` 不明文暴露用户名、条目数量或正文。它包含全部账户的密码摘要而不是登录密码明文，恢复后原账户密码仍然有效。

### 服务器整站快照

每次运行服务器更新脚本时，系统都会先询问是否创建整站加密快照；只有输入 `y` 才会备份。也可以随时手动创建：

```bash
cd /opt/Shendu/shendu
sh scripts/site-backup.sh
```

第一次运行会自动生成 `./data/server-backup.password`。后续备份沿用同一个密码，因此无需每次输入。备份内容使用 PBKDF2-HMAC-SHA-256（600,000 次）与 AES-256-GCM 整包加密；服务器磁盘上不会出现明文备份。

查看生成的快照：

```bash
ls -lh /opt/Shendu/shendu/backups/
```

恢复 `.shendu-db` 整站快照前先停止应用：

```bash
cd /opt/Shendu/shendu
backup_file="/opt/Shendu/shendu/backups/要恢复的文件.shendu-db"
install -m 600 "$backup_file" ./tmp/restore.shendu-db
docker compose stop shendu
docker compose run --rm --no-deps shendu node scripts/admin-cli.mjs restore \
  /app/tmp/restore.shendu-db --password-file /app/data/server-backup.password \
  && docker compose up -d \
  && rm -f ./tmp/restore.shendu-db
```

恢复命令会保留 `shendu.db.before-restore`，注销旧会话，并把快照中的内部数据密钥恢复到 `./data/backup-master.key`。`.shendu-db` 使用命令行恢复；网页上传恢复使用网页导出的 `.shendu-site`。

创建和恢复服务器快照时都会检查 SQLite 完整性、外键关系及内部密钥能否解密全部敏感字段。错误密码、截短认证标签或密钥不匹配会停止操作。请保持应用停止直到恢复成功；上面的命令只有恢复成功后才启动应用和清理临时文件。

网页整站备份同时受加密文件 128 MiB 和解压资料 176 MiB 的上限约束；超限会明确拒绝导出，请改用服务器快照。服务器快照解压内容上限为 1 GiB，生成时也会检查相同上限。

个人备份的“安全合并”保留当前已完成或已验证的记录，仅更新较旧的草稿。确实要用备份替换全部复盘时，使用“完整恢复”。数据密钥丢失时，应找回原 `backup-master.key`，或在新部署的站点用备份密码恢复；不能直接用新密钥解密旧数据库。

安全回归测试（在装有 Node.js 24 的开发环境执行，使用隔离临时数据库，不接触部署数据）：

```bash
cd /opt/Shendu/shendu
npm run check
npm test
```

## 外部备份

先在“数据备份”页面设置个人备份密码，再新增 WebDAV 或 S3 目标。连接测试会写入随机文件、读回校验并删除。外部凭据在数据库中使用内部主密钥加密，备份文件在离开服务器前已使用个人备份密码整包加密；归属用户名位于加密载荷内，远端看不到用户名、正文、导出时间或条目数量。

R2 常用填写方式：

- Endpoint：R2 的 S3 API 地址
- Region：`auto`
- Bucket：桶名称
- Path-style：通常不勾选；若账户提供的 Endpoint 要求路径形式再开启

## 安全提醒

- `.env`、`data/backup-master.key`、个人备份密码和整站备份密码应分别妥善保存；升级时必须保留原 `.env` 与 `data/`。
- 不要把 `data/`、`.env` 或备份文件提交到公开仓库。
- 管理员无法从接口读取用户的密码哈希、复盘正文或日记。
- 为支持登录、日期锁定、排序与统计，用户名、记录类型、周期、状态和时间戳属于必要索引元数据；复盘标题、正文、日记、验证结果和个人设置均加密保存。
- 停用账号、重置密码和修改本人密码都会使旧会话失效。
- 当前版本只提供站内验证日期，不发送短信、邮件、微信或系统推送。
- 当前版本不调用 GPT，也没有用户间查看、点赞或评论功能。
- 除非你主动配置 WebDAV 或 S3 外部备份，网页与服务端不会向第三方服务发送资料；外部备份地址会经过 HTTPS、公网 IP 与 DNS 固定校验。

## 本地开发

需要 Node.js 22.5 或更高版本：

```bash
cp .env.example .env
# 把 SHENDU_MASTER_KEY 改成：openssl rand -hex 32
npm start
```

访问 `http://localhost:3000`。
