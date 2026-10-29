# 可选：离线镜像包

项目默认从源码构建，正常部署见仓库中的 `docs/deployment.md`。本文仅用于已有人在联网构建机上手动导出镜像、再转移到另一台 Linux x86_64 服务器的情况。

## 在构建机导出

在完整源码的仓库根目录执行：

```bash
docker build --tag ocs-server-headless:local .
bash scripts/test-container.sh ocs-server-headless:local
bash scripts/package-container.sh ocs-server-headless:local
```

安装包位于本地 `releases/` 目录。这是手动生成的构建输出，不要求代码托管平台提供发布页或自动构建服务。

## 在目标服务器导入

目标服务器需要 Docker Engine、Compose 插件、bash、tar 和 sha256sum。将安装包解压到固定目录，在解压目录执行：

```bash
bash install.sh --load-image
```

脚本校验 SHA256 清单、加载镜像，再以 `--no-build --pull never` 启动。离线导入不会访问源码构建上下文，也不会从镜像仓库拉取应用镜像。已有 `.env` 会保留。

读取登录令牌：

```bash
docker compose exec -T ocs node -e 'process.stdout.write(require("fs").readFileSync("/data/admin.token","utf8"))'
```

默认监听 `http://127.0.0.1:15319/`。远程访问可使用 SSH 隧道，或通过 HTTPS 反向代理同源提供控制台与 API，并在 `.env` 设置外部 `OCS_ALLOWED_ORIGINS`。

## 配置、备份与升级

`.env` 支持 `OCS_BIND_ADDRESS`、`OCS_PORT`、`OCS_MAX_BROWSERS` 和 `OCS_ALLOWED_ORIGINS`。修改配置后执行：

```bash
docker compose up --detach --no-build --pull never --wait --wait-timeout 90
```

容器的数据目录 `/data` 保存在 `ocs-server-headless_ocs-data` 卷中。停止后备份完整目录，包括配置、密钥、令牌、profile 和下载：

```bash
docker compose stop
docker compose cp ocs:/data "./backup-$(date +%Y%m%d-%H%M%S)"
docker compose start
```

升级时先停止服务并备份，将新包解压到同一目录，保留 `.env`，再次执行 `bash install.sh --load-image`。本地构建默认使用 `local` 标签，因此应保留旧安装包；回滚前确认数据格式兼容，必要时恢复相应备份。

配置数据库使用 AES-256-GCM 加密；浏览器 profile、Cookie、下载和日志不属于数据库加密范围。密钥缺失将无法解密配置。`docker compose down` 保留卷，添加 `--volumes` 会删除数据。
