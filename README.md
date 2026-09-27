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
- `code.html` 同款 Great Vibes / Pinyon Script / Alex Brush 艺术字体已随安装包本地提供，不依赖访问外部字体站点
- 用户注册登录、首位用户自动成为超级管理员、成员/管理员权限；管理员可在密码与用户名双重确认后永久删除授权范围内的账户及其关联数据
- 账户管理、阶段设置、备份弹窗和全部表单针对手机窄屏自适应，账户列表在移动端自动转为卡片布局
- 复盘标题、正文、日记、验证结果和个人设置落盘前使用 AES-256-GCM 加密；旧版明文数据库首次启动时自动迁移并清理旧页
- 个人 `.shendu` v4 整包加密导出、浏览器校验、安全合并与完整恢复；用户名只写入加密载荷，跨账户恢复必须再次确认原用户名与原备份密码，并兼容 v3 及更早加密备份
- 超级管理员可在网页导出、校验并恢复 `.shendu-site` 整站加密迁移包，一次迁移全部账户、密码摘要、复盘、设置和外部备份配置
- WebDAV 与 S3 兼容存储（R2、AWS S3、MinIO 等），连接读写校验和定时备份
- SQLite WAL、健康检查、安全响应头、同源写入检查、登录限速
- Debian + Docker Compose + Caddy 自动 HTTPS

## Debian 12 / 13 部署

### 1. 从 GitHub 下载

```bash
apt update && apt install -y git
git clone https://github.com/hikling/Shendu.git /opt/Shendu
cd /opt/Shendu/shendu
```

如果已经克隆过项目，先执行 `cd /opt/Shendu/shendu`，确认当前目录里能看到 `.env.example`、`compose.yaml` 和 `scripts/`，再继续安装。

### 2. 安装 Docker 并生成配置

```bash
chmod +x scripts/install.sh scripts/site-backup.sh
sudo sh scripts/install.sh
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

以下步骤适用于按上文从 GitHub 克隆到 `/opt/Shendu` 的服务器。日常更新不需要重新运行 `scripts/install.sh`，也不要删除 `.env`、`shendu/data/` 或其中的 `backup-master.key`。

### 1. 更新前备份并检查工作区

建议先用超级管理员在网页“数据备份”中导出一份整站加密备份，再在服务器执行：

```bash
cd /opt/Shendu
git status --short
```

正常情况下不会输出内容。如果显示被修改的受版本控制文件，先保存或处理这些改动，不要直接覆盖；`.env`、`data/` 和 `tmp/` 属于本机数据，不会被普通 `git pull` 更新。

### 2. 拉取代码并重建容器

```bash
cd /opt/Shendu
git pull --ff-only
cd shendu
docker compose up -d --build --remove-orphans
```

这会保留现有数据库、主密钥和站点配置，只替换应用镜像并完成必要的数据迁移。

### 3. 检查更新结果

```bash
docker compose ps
docker compose logs --tail=100 shendu
curl -fsS https://你的域名/healthz
```

健康检查应返回包含 `"ok":true` 的 JSON。若服务没有正常启动，继续查看：

```bash
docker compose logs --tail=200 shendu
docker compose logs --tail=200 caddy
```

如果浏览器仍显示旧界面，先强制刷新页面并清理该站点缓存。安装目录不是 `/opt/Shendu` 时，请在项目目录执行 `git rev-parse --show-toplevel` 查出仓库根目录，再按相同步骤更新。

## Cloudflare 域名设置

1. 在 Cloudflare DNS 添加一条 `A` 记录，指向服务器公网 IP。
2. 初次签发证书时建议先用“仅 DNS（灰云）”。网站正常打开后可改为“已代理（橙云）”。
3. Cloudflare 的 SSL/TLS 加密模式使用 **Full (strict)**。
4. 不要为 `/api/*` 设置缓存规则；HTML 也不应缓存。
5. 服务器防火墙开放 TCP 80、443；使用 HTTP/3 时再开放 UDP 443。

## 数据位置与日常备份

- SQLite：`./data/shendu.db`（敏感内容为 AES-256-GCM 密文，文件权限 `600`）
- 数据加密主密钥：`./data/backup-master.key`（文件权限 `600`，丢失后服务器数据无法解密）
- Caddy 证书：Docker 卷 `caddy_data`
- 临时导入文件：`./tmp`，完成、取消或空闲一小时后清理

### 网页整站迁移（推荐）

1. 在旧站用超级管理员进入“数据备份”，选择“导出整站备份”，输入当前登录密码并设置一个独立的整站备份密码。
2. 在新服务器完成部署，先创建一个临时超级管理员账户。
3. 用临时超级管理员进入“数据备份”，上传 `.shendu-site`，输入整站备份密码、当前临时管理员登录密码，并按页面提示确认。
4. 恢复会完整替换新站现有资料、注销全部会话，并用新服务器的内部主密钥重新加密数据。随后使用旧站原超级管理员账户登录即可。

`.shendu-site` 不明文暴露用户名、条目数量或正文。它包含全部账户的密码摘要而不是登录密码明文，恢复后原账户密码仍然有效。

### 命令行快照（兜底方式）

创建整站加密快照：

```bash
export SHENDU_SNAPSHOT_PASSWORD='至少十五个字符的独立密码'
./scripts/site-backup.sh ./backups
```

也可直接在容器内创建迁移包：

```bash
docker compose exec shendu node scripts/admin-cli.mjs migration \
  /app/tmp/server.shendu-migration '至少十五个字符的独立密码'
docker compose cp shendu:/app/tmp/server.shendu-migration ./server.shendu-migration
```

恢复整站快照前先停止服务：

```bash
docker compose stop shendu
docker compose cp ./server.shendu-migration shendu:/app/tmp/server.shendu-migration
docker compose run --rm shendu node scripts/admin-cli.mjs restore \
  /app/tmp/server.shendu-migration '创建备份时的密码'
docker compose up -d
```

恢复命令会保留 `shendu.db.before-restore`，注销旧会话，并把快照中的内部备份密钥恢复到 `./data/backup-master.key`。

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

## 本地开发

需要 Node.js 22.5 或更高版本：

```bash
cp .env.example .env
# 把 SHENDU_MASTER_KEY 改成：openssl rand -hex 32
npm start
```

访问 `http://localhost:3000`。
