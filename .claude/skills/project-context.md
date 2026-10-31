# OCS Server Headless — 开发上下文

## 当前目标

本仓库从 OCS Desktop fork，以纯源码分发独立 Node.js 无头浏览器服务与同源 Web 控制台。默认目标是 Linux x86_64 服务器，不假定存在 Releases、Actions 或已发布应用镜像。取得完整源码后运行 bash deploy/install.sh，由 Docker 从源码构建并启动。控制台源码在 `packages/web-ui`，构建到 `packages/server/web`；后端在缺少该产物时仍可独立运行。控制台实现与约束见 `docs/web-ui.md`。

以实际源码、根 `package.json` 和 `pnpm-workspace.yaml` 为准。不要使用旧桌面文档推断已实现的服务端能力。

## 活跃模块与依赖

- `packages/server`：`@ocs-server/server`，Node.js >=22、Express、playwright-core、TypeScript，编译为 CommonJS `dist/`。
- `packages/common`：私有包 `@ocs-server/common`。配置校验、自动化类型与内置程序，编译为 `lib/`；构建先清空旧产物。
- `packages/web-ui`：`@ocs-server/web-ui`，Vue 3 + Vite + TypeScript 管理控制台，构建产物输出到 `packages/server/web`；不进入后端构建依赖。
- 原 Electron app、桌面渲染层、升级器、桌面发布工作流与旧公共入口已移除，迁移参考请查 Git 历史。
- 上游审查范围、已移植修复与排除原因见 `docs/upstream-sync.md`；原作者和许可证说明见 `NOTICE.md`。

不要为运行后端引入 Electron、keytar、electron-store、桌面 IPC、托盘或窗口依赖。浏览器管理能力应由 HTTP API 提供，不将 Node 模块或任意文件系统 RPC 暴露给客户端。

## 服务端文件与责任

| 文件 | 责任 |
| --- | --- |
| `packages/server/src/index.ts` | HTTP 服务启动、SIGINT / SIGTERM 清理、生命周期入口 |
| `config.ts` | `OCS_*` 环境变量、令牌及密钥路径 |
| `http.ts` | `/healthz`、版本化管理路由、Bearer 鉴权、Origin 校验、SSE |
| `validation.ts` | 输入字段、URL、脚本关联和自动化配置校验、密码脱敏 |
| `store.ts` | 加密状态数据库、原子写入、数据目录单写者锁 |
| `runtime.ts` | 浏览器 worker 监管、并发容量、启动停止互斥、超时和错误状态 |
| `worker.ts` | 实例内 Chromium、页面与下载、内置自动化、普通 JS 注入 |
| `protocol.ts` | 父子进程消息与动作协议 |
| `events.ts` | 有界内存事件和轮转 JSONL 日志 |
| `types.ts` | 服务端 profile / 用户脚本 / 运行状态 / 数据库类型 |
| `smoke.ts` | 使用本地 HTTP fixture 的真实浏览器端到端验证 |

每个实例拥有独立 Node worker 和 Chromium 持久上下文；HTTP 客户端断开不影响运行中的实例。runtime 状态为 starting / running / stopping / stopped / error。不要在服务主进程中执行浏览器 worker 的退出逻辑。服务停止时清理 worker、浏览器与在途请求；Linux 进程组终止逻辑由 runtime 维护。

浏览器强制 `headless: true`、使用 full Chromium（`channel: 'chromium'`）和 sandbox，不以自动加入 `--no-sandbox` 绕过环境配置。浏览器二进制必须与锁定的 Playwright 版本兼容。使用普通 Linux 用户运行，并满足 Chromium 共享库和用户命名空间要求。

## 共享自动化

内置自动化的唯一实现位于 `packages/common/src/automation/`：通用新建页面及超星、智慧树、职教云 / ICVE、智慧职教、爱课程登录程序。`packages/common/automation.ts` 作为 `@ocs-server/common/automation` 子入口导出 `AutomationScripts`、`LegacyScriptMappings`、具体程序及工具。common 仅提供主入口、automation 与 package.json，不再保留桌面 node/web 入口和 IPC 契约。

程序通过 `script.run(page, configs平铺值, 可选OCR选项)` 执行；配置定义沿用 common 的 `Config`。部分旧程序通过 `script-error` 事件报告失败，worker 监听该事件并输出结构化结果。每实例独立进程使共享程序实例的事件监听隔离。

当前没有动态第三方 Node 自动化 loader。用户脚本支持旧 plain 模式及标准 userscript 模式；后者通过 manager.ts 下载/缓存固定版本 ScriptCat（或管理员本地MV3管理器）、自动安装及同步受管脚本，GM API和元数据执行交给管理器。userscript-source.ts负责有界网络获取/元数据，userscripts.ts负责CRUD/导入/更新，catalog.ts提供官方与脚本源查询。

browser-bridge.ts提供实例内OCS配置和动作白名单桥接，凭据与管理token隔离；settings保存后通过update-ocs实时同步。ocr.ts通过OCS_OCR_URL接入兼容服务，并通过私有loopback随机路径把第三参数传给内置自动化；未配置时继续无验证码流程。screencast.ts提供背压控制的CDP实时帧，runtime私有订阅转MJPEG，不进入事件日志。resource.ts报告资源并支持启动阈值；transfer.ts支持密码加密导出及新旧格式导入；storage.ts在停止状态清理固定受管路径。

## HTTP 契约

完整路由与示例见 `docs/api.md`。

- `/healthz` 只报告进程存活，不检查浏览器。
- `/api/v1/*` 要求 Authorization Bearer。自动生成 token 位于数据目录 admin.token，不提供 HTTP 领取接口，不接受 URL token。
- 带 Origin 的请求需通过精确来源校验。HTTPS 反向代理需将外部 HTTPS Origin 加入 OCS_ALLOWED_ORIGINS，服务不自动信任代理头。
- JSON 通常返回 `{data:...}`；失败返回 `{error:{code,message}}`；创建 201，删除 204，截图为 PNG，下载为文件，事件为 SSE。
- 当 `OCS_WEB_DIR`（默认 `packages/server/web`）存在 `index.html` 时，服务在同源 `/` 托管控制台，使用专用 CSP、hash 路由和静态缓存；不重写未知路径，API 404 行为不变。未构建前端时保持纯 API。
- 实例配置 PATCH 和 DELETE 需先停止。删除仅删除配置，保留 profile / 下载数据。
- 自动化配置按服务器内置定义校验。password 字段读取脱敏为 `***`，提交 `***` 保留旧密码；若提交自动化数组，省略的具体配置项回默认值。完全省略 automationScripts 才保留旧数组。
- settings.ocs 更新是对象整体替换。运行时环境、token、密钥、浏览器与扩展路径不可通过 API 修改。
- SSE 通过带 Bearer 的 fetch 流消费；重连后重新同步实例状态。事件缓存有限且服务重启后序号重置，不是任务数据库。
- 提供 pages / navigate / click / fill / screenshot / new-page / close-page / reload / press / check / select 等明确动作，不添加任意 eval、CDP、fs、shell 透传。

不要在事件、错误或普通日志中写入密码、管理令牌、填充值或整个浏览器启动配置。页面截图、profile、下载和日志仍应视作私密数据。

## 持久化与配置

数据目录由 OCS_DATA_DIR 指定；默认相对进程 cwd 的 ./data。根 pnpm start 运行于 packages/server，因此默认是 packages/server/data；WSL 建议显式使用 Linux $HOME 下的绝对数据目录。

整个 state.json 数据库使用 AES-256-GCM 加密、随机 IV 和认证标签，写入临时文件、fsync 后替换。默认密钥为 dataDir/encryption.key；令牌和密钥创建为 0600，目录 0700。浏览器 profile / Cookie、下载和 JSONL 日志不属于数据库加密范围。密钥丢失或数据库损坏时应报错，不静默重置既有数据。

Linux 的 server.lock 使用 util-linux flock 和持有的文件描述符限制数据目录单写者；worker 继承同一锁，所有持有进程退出后内核自动释放。文件长期保留，不要在运行时删除。旧版 PID 文件锁不会自动接管，需管理员核实旧进程后一次性迁移；Windows / macOS 保留保守 PID 锁。备份前停止服务，保留完整数据目录与自定义密钥文件。

原生进程默认 OCS_HOST=127.0.0.1、OCS_PORT=15319、OCS_MAX_BROWSERS=4，完整变量见 .env.example 与 packages/server/src/config.ts。Compose 对外配置见 deploy/.env.example，内部固定监听 0.0.0.0:15319、数据目录 /data。服务不自动加载 .env 文件，由启动环境或 Compose 注入。进程环境中的 OCS_* 不传入 worker，API token 和数据库密钥不应进入页面。

## 开发、测试与部署

使用 Linux 原生 Node.js >=22、pnpm10.21.0；不要混用 Windows 与 WSL 的 node_modules。

```bash
bash scripts/setup.sh --with-browser
source "$HOME/.local/share/ocs-server/env.sh"
pnpm build
pnpm build:web
pnpm typecheck
pnpm test
pnpm test:web
env -u DISPLAY -u WAYLAND_DISPLAY pnpm smoke
```

setup.sh 用户级安装 Node 和 pnpm、不调用 sudo、不安装 Electron；setup.ps1 将命令转发到默认 WSL。共享库需管理员按发行版安装；openEuler 不是 Playwright 自动系统依赖安装的受支持环境。默认浏览器下载使用完整 Chromium，跳过未使用的 headless shell。

- common tests：共享配置校验、URL 规范化及主入口。
- server tests/extensions.test.ts：使用真实临时文件验证 MV3、无效 JSON 和目录形态 manifest.json。
- server tests/api.test.ts：认证、来源、CRUD / 校验、密码脱敏、持久化加密、路径、控制台静态托管与状态约束。
- server tests/runtime.test.cjs：fake worker 验证并发、启动失败、停止竞争、异常退出和清理。
- smoke.ts：真实 Chromium、本地页面、填写 / 点击 / 截图、关闭重启及持久化。
- web-ui tests/console.e2e.cjs：真实浏览器控制台回归，覆盖认证、SSE 重连、条件字段、实例生命周期、截图、操作、下载、自动化、事件与来源 403。

改动后运行对应测试，再运行必要类型检查与构建；有真实浏览器依赖的行为用 smoke 验证。不要把 mock 测试通过写成真实浏览器验证成功。

pre-push 执行 `pnpm lint && pnpm typecheck && pnpm typecheck:web`，与 CI 的格式及前后端类型检查保持一致。

默认部署不依赖 GitHub 服务：deploy/install.sh 从源码构建，deploy/compose.yaml 声明构建上下文且默认构建应用镜像；用户可从任意 Git 托管或源码压缩包获取完整源码。Dockerfile 使用固定摘要的 Node Debian base、锁定 Playwright 的 Chromium 和共享库，Compose 使用 named volume、sandbox 与 Chromium seccomp。现有工作流只是可选检查和打包工具，缺失 .github/ 不影响构建启动。scripts/package-container.sh 可手动导出离线包；离线导入需显式运行 install.sh --load-image，说明见 docs/offline-deployment.md。新机器入口见 docs/deployment.md；原生 systemd 示例使用 KillMode=mixed，部署时仍需调整实际路径和服务账号。

## 前端工作

Web 控制台已实现于 `packages/web-ui`，不依赖 Electron、桌面 IPC 或 Node 核心模块。它对接现有 `/api/v1`，完成单管理员令牌认证、实例 CRUD 与启停、自动化配置表单、页面截图与受限操作、下载、用户脚本、`settings.ocs` 和 SSE 恢复。

- 令牌默认仅在会话存储；可选 localStorage，并在设置页明确展示与清除。令牌只走 `Authorization` 头，SSE 使用 fetch 流。
- 页面支持受限明确操作、截图和MJPEG实时预览，不新增任意 JS、CDP、文件系统或 Node 入口。
- 自动化配置由服务端定义生成，密码 `***` 保持原值；`settings.ocs` 按整体替换提交。
- 视觉采用深色灵动线条：近黑底、发丝线、细线图标与单一强调色，克制使用渐变、光效和解释性文本；实现与约束见 `docs/web-ui.md`。
- `pnpm build:web` 输出到 `packages/server/web`，服务端可选同源托管；后端构建、测试和运行不依赖前端产物。
- `pnpm test:web` 运行真实浏览器端到端检查；CI 在安装 Chromium 后执行。
