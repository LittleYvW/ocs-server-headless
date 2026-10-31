# 从源码部署

默认目标为 Linux x86_64 服务器。仓库只需提供完整源码，不要求有 Releases、Actions、镜像仓库账号或预构建产物。

推荐通过 Docker 构建：宿主只需 bash、Docker Engine 和 Compose 插件，Node.js、前后端依赖、Chromium 及其系统库均在镜像构建阶段准备。首次构建需要能访问基础镜像、npm 和浏览器下载源。宿主内核需允许 Chromium sandbox 使用的非特权用户命名空间。

## 获取源码与首次启动

使用 Git 克隆仓库，或下载源码压缩包并解压。确认取得的是完整项目，至少包含：

```text
Dockerfile
.dockerignore
.gitattributes
.gitignore
package.json
pnpm-workspace.yaml
pnpm-lock.yaml
.npmrc
packages/common/
packages/server/
packages/web-ui/
deploy/
```

无需先执行 pnpm install，也不需要现成的 dist、lib、控制台构建目录或 node_modules。在包含 Dockerfile 的仓库根目录执行：

```bash
bash deploy/install.sh
```

脚本会检查 Docker、保留或创建 `deploy/.env`、校验 Compose 配置，随后构建应用镜像。构建成功后才创建或更新服务；失败时不会停止已有服务。构建完成的镜像包含控制台和锁定 Playwright 所需的 Chromium。

启动时会用临时 profile 验证浏览器与 sandbox，预检失败会退出。脚本等待 HTTP 健康后返回；服务重启后浏览器实例仍需在控制台重新启动。

脚本使用固定的 Compose 项目目录，从其他工作目录通过脚本绝对路径调用也可运行。正常部署不读取镜像压缩包或 SHA256 交付清单，也不依赖 `.github/`。

## 登录与运行目录

安装脚本内部的目录切换不会改变调用终端。之后的 Compose 命令都在仓库的 `deploy/` 中执行：

```bash
cd deploy
docker compose ps
docker compose exec -T ocs node -e 'process.stdout.write(require("fs").readFileSync("/data/admin.token","utf8"))'
```

默认在服务器回环地址提供 `http://127.0.0.1:15319/`。使用生成的管理令牌登录。

通过其他电脑访问时，可在该电脑建立 SSH 隧道：

```bash
ssh -L 15319:127.0.0.1:15319 user@server
```

也可以使用 HTTPS 反向代理同源提供控制台与 `/api`，将外部 Origin 写入 `OCS_ALLOWED_ORIGINS`；为 `/api/v1/events` 保留 SSE 长连接并关闭缓冲。

## 配置

`deploy/.env` 的初始内容来自 `deploy/.env.example`：

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `OCS_BIND_ADDRESS` | `127.0.0.1` | 宿主监听地址 |
| `OCS_PORT` | `15319` | 宿主端口 |
| `OCS_MAX_BROWSERS` | `4` | 浏览器并发上限 |
| `OCS_ALLOWED_ORIGINS` | 空 | 逗号分隔的精确 Origin；HTTPS 代理需填写外部 Origin |

仅修改配置时，在 `deploy/` 使用现有镜像重新创建服务：

```bash
docker compose up --detach --no-build --pull never --wait --wait-timeout 90
```

容器内部监听 `15319`，数据目录为 `/data`。自定义 Node 路径、浏览器缓存路径或服务账号不是容器部署的前置步骤。

## 构建与网络行为

`deploy/compose.yaml` 的构建上下文指向仓库根目录，默认应用镜像为 `ocs-server-headless:local`。默认策略是从源码构建，不会尝试从公共镜像仓库下载同名应用镜像。

安装脚本先单独执行构建，再以 `--no-build --pull never` 启动，避免启动阶段重复构建或拉取应用镜像。该选项不妨碍构建阶段下载固定摘要的 Node 基础镜像和锁定依赖。

所有构建依赖在 Docker 内安装，不复用宿主 node_modules、编译产物或浏览器。更新基础镜像或 Playwright 时，应重新构建并验证 Chromium 与 sandbox。

浏览器以普通用户运行。Compose 采用 Chromium seccomp 配置，丢弃全部 capabilities 后仅保留 sandbox 所需的 `SYS_CHROOT`。不通过 root、`--privileged` 或关闭 sandbox 绕过启动问题。

## 日常操作与排查

在 `deploy/` 中执行：

```bash
docker compose ps
docker compose logs --tail=100 ocs
docker compose restart ocs
docker compose stop
docker compose start
```

浏览器启动失败先查看容器预检日志。HTTP `/healthz` 只表示服务进程存活，不保证所有运行中的实例或自动化任务均正常。

检查部署配置可运行 `docker compose config --quiet`。修改环境变量后使用上面的 `up` 命令；`restart` 不负责应用新的环境配置。

## 备份、更新与回滚

完整数据在 `ocs-server-headless_ocs-data` 卷中，包括配置数据库、密钥、令牌、profile、下载和日志。停止后备份：

```bash
docker compose stop
docker compose cp ocs:/data "./backup-$(date +%Y%m%d-%H%M%S)"
docker compose start
```

配置数据库使用 AES-256-GCM 加密，浏览器 profile、Cookie、下载和日志不属于数据库加密范围。保留完整备份和密钥；缺失密钥无法解密已有配置。

更新时先停止服务并备份，然后更新源码并保留 `deploy/.env`，最后在仓库根目录执行 `bash deploy/install.sh`。Git checkout 可使用 `git pull --ff-only` 更新；源码压缩包方式更新时同样保留配置。数据保存在独立卷中。

默认镜像标签会被新构建更新。回滚应切回已验证的源码版本并重新构建；先确认数据格式兼容，必要时恢复对应备份。不要把未提交的代码改动或本地配置直接覆盖掉。

`docker compose down` 保留数据卷；添加 `--volumes` 会删除数据，不用于普通升级。

## 旧数据迁移

迁移前停止旧服务并确认 worker 与 Chromium 均退出，将完整数据目录及加密密钥一并转移。旧版仅有 PID 的 `server.lock` 需在完成上述核实后移除一次；服务不会自动接管旧锁。

新的 Linux 锁通过 flock 保证单写者，锁文件会长期存在。不能根据文件存在判断服务运行，也不能在服务运行时删除锁文件。需要使用支持文件锁的本地 Linux 文件系统，默认 Docker named volume 满足此部署方式。

## 手动验证与可选工具

在仓库根目录可以单独构建和运行真实浏览器验证：

```bash
docker build --tag ocs-server-headless:local .
bash scripts/test-container.sh ocs-server-headless:local
```

若目标机器无法访问构建下载源，可在另一台联网机器从源码构建，再手动导出镜像。这个可选流程见 [离线部署](offline-deployment.md)。已有工作流仅用于可选检查和打包；没有自动构建服务也可使用仓库中的全部本地命令。

Compose 构建行为参见 [Docker 构建规范](https://docs.docker.com/reference/compose-file/build/)，启动参数参见 [docker compose up](https://docs.docker.com/reference/cli/docker/compose/up/)。

## 标准脚本、OCR 与资源检查

标准脚本首次使用时下载固定版本 ScriptCat 并校验 SHA-256，缓存于数据卷 `extensions/`。已有 ScriptCat 1.5 解包目录可通过 `OCS_EXTENSIONS` 配置，路径必须是容器内绝对路径（例如 `/data/extensions/scriptcat`）。`OCS_SCRIPT_MANAGER_URL` 可配置 ZIP 镜像，避免部署网络无法访问官方源。

`OCS_OCR_URL` 是容器可访问的 JSON OCR 地址；宿主的 `127.0.0.1` 不等于容器的宿主网络。`OCS_MIN_FREE_MEMORY_MB` 和 `OCS_MAX_CPU_PERCENT` 配置启动阈值，0 关闭该项检查。`/api/v1/browsers/:id/preview` 同 SSE 一样需要反向代理关闭缓冲。完整契约见 [API](api.md) 和 [兼容功能说明](backend-compatibility.md)。
