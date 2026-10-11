# 升级个人备份兼容能力

新版继续读取旧版 `.shendu` **个人备份**。旧版 `.shendu-site`、`.shendu-db` 整站备份不是新版导入兼容承诺；回退必须保留原服务器目录中的数据库和内部密钥。不要只复制 `shendu.db`，也不要用新站生成的 `backup-master.key` 覆盖旧密钥。

## 升级前

1. 在旧站为每个需要迁移的账户导出 `.shendu`，分别保存备份密码。文件和密码应放在服务器之外。升级后先用新版的“数据备份”页面校验并预览，再选择“安全合并”或“完整恢复”。
2. 在 Debian 服务器上以 root 身份，停止应用后复制整个部署目录。这会一并保留 `.env`、`data/shendu.db`、WAL 文件、`data/backup-master.key`、旧代码和 Git 状态。将副本存放在空间足够且只有管理员能访问的位置。

```sh
cd /opt/Shendu/shendu
docker compose stop shendu
cd /opt
umask 077
backup_dir="/opt/Shendu-before-ui-$(date +%Y%m%d-%H%M%S)"
cp -a Shendu "$backup_dir"
printf '回退副本：%s\n' "$backup_dir"
```

3. 确认副本中存在 `shendu/data/shendu.db` 和 `shendu/data/backup-master.key`。如果缺少密钥，先查明旧站实际使用的 `SHENDU_MASTER_KEY_PATH`，并将该密钥与副本一起保存。记录当前 Git 提交：`git -C /opt/Shendu rev-parse HEAD`。

## 升级与核对

将新版代码部署到 `/opt/Shendu`，保留原 `.env`、`shendu/data/`、`shendu/tmp/` 和 Caddy 数据卷。现有 SQLite 资料及内部密钥会继续使用；首次启动可能执行旧明文资料的加密迁移。启动后检查：

```sh
cd /opt/Shendu/shendu
docker compose up -d --build
docker compose ps
curl -fsS https://你的域名/healthz
```

用原账户登录，逐项核对六类复盘、完成与验证状态、阶段设置、主题、账户权限和备份目标。再导出一份新版个人备份并在隔离环境测试导入。若使用网页整站备份，在新版导出并在**隔离的新站**验证同版本恢复后，才把它作为新版的整站备份使用。

## 回退

如果核对失败，先停止当前部署，然后把升级前的**整个目录副本**恢复到原路径。下面命令会把失败部署保留在另一个目录供排查；把 `backup_dir` 换成升级前输出的实际路径。

```sh
cd /opt/Shendu/shendu
docker compose down
cd /opt
backup_dir=/opt/Shendu-before-ui-实际时间
mv Shendu "Shendu-failed-$(date +%Y%m%d-%H%M%S)"
cp -a "$backup_dir" Shendu
cd /opt/Shendu/shendu
docker compose up -d --build
docker compose ps
```

回退后用旧账户登录，确认记录和设置。**不要**把升级后写入的新数据库文件单独复制到旧代码目录；代码、数据库和内部密钥应成组回退。正式部署前应在旧站目录的副本上演练这一流程，避免直接在生产资料上验证升级。
