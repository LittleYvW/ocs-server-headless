# 部署审查（2026-10-25）

审查对象是当前工作区，包括尚未提交的 headless 服务、控制台和部署文件。验证使用独立的 WSL Linux 副本及临时数据目录；未修改现有部署配置或运行数据。

后续已增加 Linux 内核锁和 `KillMode=mixed`，并将默认部署改为从完整源码构建，不依赖发布页或自动构建产物。下文保留各阶段的审查快照与当时验证结果；当前部署说明以 [源码部署](deployment.md) 为准，离线镜像包仅为可选导出方式。

## 结论

可以简化。针对当前这台已启用 systemd、没有 Docker 的 openEuler WSL，优先采用“CI 生成带生产依赖的运行包 + systemd 管理一个 Node 服务”。无需为前端另开服务，控制台继续由后端同源提供。

如果目标是向多台不同发行版的服务器分发，再增加固定版本的容器镜像和单服务 Compose。容器有助于统一浏览器运行库，但不能自行解决应用的数据锁、任务恢复和 Windows/WSL 生命周期问题。

切换包装方式之前，应先处理下面两项高优先级问题。

## 已确认的问题

### P1：systemd 停止服务可能丢失刚写入的浏览器数据

位置：`deploy/ocs-server.service:26`，`packages/server/src/worker.ts:81`。

示例使用 `KillMode=control-group`。systemd 停止服务时会向同一 cgroup 内的主服务、worker 和 Chromium 一起发送 SIGTERM；这绕过了主服务通过 IPC 通知 worker、worker 等待 `browser.close()` 落盘的顺序。

在本机 WSL 使用临时 user service、真实浏览器和本地 HTTP 页面验证：写入 localStorage 后立即通过 `systemctl --user stop` 停止，重新启动同一数据目录并读取页面。

| 停止方式 | 服务锁正常删除 | 重启后保留 localStorage |
| --- | --- | --- |
| `KillMode=control-group` | 是 | 否 |
| `KillMode=mixed` | 是 | 是 |

这证明存在数据丢失路径，不表示每次停止都会丢数据。测试浏览器为本机已有 Chrome for Testing 156.0.8078.4，通过 `OCS_BROWSER_EXECUTABLE_PATH` 指定。

建议改为 `KillMode=mixed`，保留 `TimeoutStopSec=30`。这样先通知主进程执行已有清理流程，超时或主进程退出后仍由 systemd 清理残留进程。现有单元测试和 smoke 直接调用应用关闭流程，不能替代 systemd 停止方式的验证。

信号语义参见 [systemd.kill 官方文档](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html)。

### P1：崩溃后的锁使自动重启无法恢复服务

位置：`packages/server/src/store.ts:43`，`deploy/ocs-server.service:23`。

`server.lock` 用独占创建的普通文件表示所有权，只在正常关闭时删除。实测启动独立服务、对其发送 SIGKILL、等待进程退出后，再使用同一数据目录启动：锁仍存在，服务拒绝启动。systemd 的 `Restart=on-failure` 或容器的 restart policy 无法绕过这个条件。

这是当前为避免并发写入而采用的保守设计，但不满足无人值守的故障恢复目标。不能简单增加启动前无条件删锁，也不能只根据锁里的 PID 判断所有权；PID 会复用，容器还有 PID 命名空间。

建议在 Linux 部署中使用随持有进程结束而释放的操作系统锁，或实现经过并发验证的恢复协议。必须同时保证同一数据目录只有一个写入者，并确认旧 worker / Chromium 不再使用 profile。需要覆盖崩溃重启、双进程竞争和残留子进程场景。

### P2：安装脚本与服务示例没有形成统一安装入口

位置：`scripts/setup.sh:8`、`scripts/setup.sh:66`，`deploy/ocs-server.service:9`、`deploy/ocs-server.service:22`。

安装脚本把 Node、pnpm 和浏览器安装在当前用户目录；服务示例则使用 `ocs` 账号、`/usr/bin/node` 和 `/opt/ocs-server`。本机检查确认用户级 Node 已安装，但 `/usr/bin/node`、`ocs` 账号和已注册的 `ocs-server.service` 均不存在。

示例已经提示手工替换，因此这不是未说明的配置要求；问题是快速安装完成后仍需人工衔接路径、账号、浏览器缓存和数据目录。直接复制示例不能完成部署，换账号还可能导致浏览器查找失败。

建议提供一个安装入口，生成真实的绝对路径和固定数据目录。当前个人 WSL 可采用同一用户的 systemd user service；专用服务器可由安装器统一创建服务账号并安装其可读的浏览器。运行入口直接执行 Node，不依赖交互式 shell 或 pnpm。

### P2：HTTP 健康检查无法判断浏览器是否可用

位置：`packages/server/src/http.ts:44`，`.github/workflows/build.yml:30`。

实测指定不存在的浏览器路径后，`/healthz` 返回 200，创建浏览器后的启动请求返回 502。这符合 README 的存活检查约定，但不足以作为部署验收。

当前手动构建产物只有编译代码、控制台和清单，运行机器仍需安装生产依赖、浏览器及系统共享库。CI 的真实浏览器验证发生在 Ubuntu，不能证明 openEuler 目标环境具备相同运行条件。

建议保留轻量 `/healthz`，增加安装后的浏览器预检和发布包 smoke：检查二进制、共享库、普通用户 sandbox，并在临时 profile 中实际启动和关闭浏览器。不要在每次周期健康检查时启动 Chromium。

## 简化方案比较

| 方案 | 适用情况 | 改动和成本 |
| --- | --- | --- |
| 运行包 + systemd | 当前单机 WSL / Linux | 改动最少；统一安装入口；系统浏览器依赖仍需处理 |
| 固定镜像 + 单服务 Compose | 多机器、不同发行版分发 | 用户侧安装步骤更少；需要 Docker、镜像分发和浏览器 sandbox 配置 |
| 只加 PM2 | 已有 Node 服务运维体系 | 不能解决浏览器共享库和数据锁，对当前项目收益有限 |
| 浏览器拆成远端服务 | 有明确集中浏览器需求 | 当前使用每实例本地 worker 和持久 profile，需要改造连接、存储及生命周期，不适合作为本次简化的起点 |

### 优先方案：带生产依赖的运行包

在构建机器完成：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm build:web
pnpm --filter @ocs-server/server deploy --legacy --prod /absolute/path/to/release
```

已用项目指定的 pnpm 10.21.0 实测此方式：

- 产物包含 `dist/index.js`、`dist/worker.js`、`web/index.html` 和 common 的编译产物。
- 包含生产 `node_modules`，不包含直接的 TypeScript / Vitest 开发依赖。
- Playwright 仍为锁定的 1.60.0，Express 仍为 4.22.2。
- 未压缩运行包约 19 MB，不含 Node、Chromium、操作系统库及运行数据。
- 在产物目录直接执行 `node dist/smoke.js`，指定本机已有浏览器后通过完整 smoke。

这验证了部署时不再执行依赖安装的可行性。正式打包宜再用 `files` 白名单限制内容，记录提交版本和校验和，并在与目标兼容的 Linux 环境生成与验证产物。pnpm 10 的当前 workspace 没有启用 injected dependencies，因此这里明确使用 `--legacy`；不能直接省略。参见 [pnpm 10 deploy 文档](https://pnpm.io/10.x/cli/deploy)。

建议目录：

```text
~/.local/share/ocs-server/releases/<version>/   运行包
~/.local/share/ocs-server/current              指向选定版本
~/.local/share/ocs-server/data/                数据、密钥、profile、下载
~/.config/ocs-server/env                       配置
```

Node 可由安装器固定安装到用户目录，服务使用其绝对路径。浏览器按锁定 Playwright 的版本安装，升级时与运行包一起预检。前后端继续同源，不必新增前端服务器或进程管理层。

升级流程为“解压到新版本目录 → 临时目录预检 → 停止旧服务 → 切换 current → 启动并验收”；失败时切回旧版本。切换前保留数据备份。跨版本回滚仍需确认数据格式兼容，不能只靠切换符号链接保证。

### 可选方案：容器分发

如果以后以跨机器部署为主，建议在 CI 构建自己的 Ubuntu / Debian 运行镜像，并在构建阶段安装锁定版本的 Playwright Chromium 和共享库。发布不可变版本 / digest，运行时不下载依赖或浏览器。

容器应保持普通用户运行和 `chromiumSandbox: true`，配置兼容用户命名空间的 seccomp、init、足够的共享内存、持久数据卷及至少 30 秒的停止宽限期。内部监听 `0.0.0.0`，本地使用时将宿主端口绑定到 `127.0.0.1`。容器重启策略只处理进程退出，不能替代应用锁恢复，也不会因为普通 healthcheck 失败就自动修复应用。

Playwright 官方现成镜像定位为测试 / 开发；不要直接把默认 root 运行方式当作访问任意网页的生产方案。版本匹配、非 root 和 sandbox 要求见 [Playwright Docker 文档](https://playwright.dev/docs/docker)，重启策略见 [Docker 官方文档](https://docs.docker.com/engine/containers/start-containers-automatically/)。本机没有 Docker，未进行镜像构建或容器实测。

## 验证结果及边界

| 检查 | 本次结果 |
| --- | --- |
| 独立 WSL 副本、Node 22.22.0、pnpm 10.21.0、frozen lockfile 安装 | 通过 |
| 后端与 Web 控制台构建 | 通过 |
| 共享包 / API / worker 监管测试 | 35 项通过（15 + 11 + 9） |
| 默认 Playwright Chromium smoke | 失败：需要 revision 1223 / Chromium 148，本机缓存只有 revision 1248 / Chrome 156 |
| 显式指定已有 Chrome 156 的真实 smoke | 通过 |
| 缺失浏览器时 HTTP 检查及浏览器启动 | 200 / 502，确认健康检查边界 |
| SIGKILL 后重新启动同一数据目录 | 被遗留锁阻止 |
| systemd control-group / mixed 的落盘比较 | 前者丢失本次写入，后者保留 |
| 自包含生产依赖运行包 smoke | 通过，使用同一显式指定的 Chrome 156 |

本次没有下载安装锁定的 Chromium 148，也没有运行控制台的真实浏览器 E2E；上述成功不能视为这些项目已经验证。

还需区分服务恢复与任务恢复：当前服务重启后，浏览器实例配置会保留，但实例不会自动恢复运行。若目标是无人值守，还应另行定义哪些实例需要恢复、失败如何重试，以及重复执行自动化的处理规则。

WSL 已启用 systemd 不等于 Windows 开机后会启动发行版，也不保证其生命周期由服务维持；长期运行需要单独考虑 Windows 侧启动、睡眠及 WSL 终止策略。微软明确说明 systemd 服务不会使 WSL 实例保持运行，见 [WSL systemd 文档](https://learn.microsoft.com/en-us/windows/wsl/systemd)。需要持续在线的部署，优先评估持续运行的 Linux 主机或虚拟机。

## 建议实施顺序

1. 调整 systemd 停止方式，补充真实服务停止后的 profile 数据验证。
2. 设计并验证崩溃后的单写者锁恢复。
3. CI 输出带生产依赖的运行包，统一安装、预检、升级和回滚入口。
4. 有跨机器分发需求时再提供容器镜像与 Compose，并在非 root sandbox 条件下验证。

## 新机器部署实现后的验证（2026-10-25）

后续已根据 Linux x86_64 服务器目标实现 `Dockerfile`、Compose、离线打包和安装脚本；CI 增加真实容器检查，手动发布流程在后端测试通过后输出容器安装包。

- 独立 Linux 副本的前后端构建、格式检查和 39 项测试通过。
- Linux 数据锁改为内核 flock，覆盖双进程竞争、SIGKILL 后恢复、残留 worker 持锁和旧 PID 锁保护；不通过自动删除锁接管数据。
- 使用临时 Docker 29.9.2 / Compose 5.6.1 构建并测试实际 Linux amd64 镜像。镜像内 Node 22.23.4、Playwright 1.60.0、Chromium 148.0.7778.96，无需主机浏览器缓存。
- 普通用户、完整 sandbox、真实 smoke、Web 控制台 HTTP 访问、浏览器运行中容器被 SIGKILL 后重新启动均通过。Compose 保留 sandbox 所需的 SYS_CHROOT，其余 capabilities 丢弃。
- 导出的安装包在独立目录运行 `install.sh` 成功，重复安装保留已有 `.env` 与加密密钥。默认 Compose bridge 和 `127.0.0.1:15319` 端口映射也已实测。
- 本次生成 `releases/ocs-server-linux-amd64-local.tar.gz`，约 384 MB，包含 Node、Chromium、系统库、Web 控制台、生产依赖与安装资料。`local` 表示当前未提交工作区构建；GitHub Actions 交付时使用提交 SHA 标记镜像及安装包。

验证使用本地 HTTP fixture；未验证目标业务网站、远端服务器网络策略或 GitHub Actions 的实际执行。测试引擎使用独立数据目录和 socket，测试结束后清理；没有安装系统 Docker 服务。

## 纯源码分发复查（2026-10-25）

当前默认入口已改为取得完整源码后执行 `bash deploy/install.sh`。Compose 包含仓库根目录的构建上下文；安装脚本先构建，再以 `--no-build --pull never` 更新服务。默认流程不读取镜像压缩包、不依赖发布页或自动构建产物。离线导入需显式使用 `--load-image`，原有工作流保留为可选工具。

同时修复了源码完整性问题：旧 `.gitignore` 中的全局 `lib/` 会忽略 `packages/web-ui/src/lib/config.ts` 与 `format.ts`。规则现已收窄到根目录和包根目录的编译输出，103 个活跃源码文件均不再被误忽略，编译产物和运行配置仍保持忽略。

验证使用 Git 可提交文件清单生成不含 `.git/`、`.github/`、发布产物、node_modules 和既有编译输出的临时源码副本。锁定依赖安装、前后端构建、39 项测试和格式检查均通过；前端 src/lib 已包含在副本中。

安装入口用真实 Compose 5.6.1 解析配置，并以模拟 Docker 操作校验任意工作目录、带空格路径、新配置权限 0600、既有配置保留、构建失败后不继续启动，以及显式离线模式。Docker build / load / up 在这项控制流检查中是模拟的；本轮未重新构建镜像或运行容器。运行时源码及 Dockerfile 未改动，前一阶段的真实容器验证记录保留在上文。

本次检查时，核心服务、控制台及部署文件仍有未跟踪项。发布源码仓库前需一并纳入版本控制；仅提交 README 或根 package.json 会遗漏运行必需文件。
