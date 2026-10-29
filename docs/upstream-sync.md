# 上游同步记录

## 2026-10-25

审查 [ocsjs/ocs-desktop](https://github.com/ocsjs/ocs-desktop) 的 `main`，从本项目 Git 基点 `6ca8a45` 到 `dbf2c25`，共 21 个提交。此次按服务端实际依赖选择移植，未合并整条桌面分支；Git 的落后计数仍会包含这些已审查提交。后续审查从 `dbf2c25` 继续。

| 提交 | 上游变更 | 本项目处理 |
| --- | --- | --- |
| `fb96477` | 主密钥需等待 Electron ready，升级旧明文密钥包装 | 不适用：服务使用独立 AES-256-GCM 数据库和受权限保护的密钥文件，不依赖 safeStorage；密钥缺失或损坏时拒绝启动 |
| `b35c9bb` | deb 包与 Linux 密钥环依赖 | 不适用：源码及容器部署，无桌面密钥环 |
| `dc528c2` | Electron 加密 mock 适配 | 不适用：无 Electron 测试 |
| `3acfa26` | AppImage 桌面集成和密钥环检测 | 不适用：无桌面入口 |
| `ea444ba` | 开发者设置与桌面辅助开关 | 不适用：服务使用显式 API、独立下载保存及数据库加密 |
| `561797c` | 检测时跳过目录形式的 manifest.json | 适配：显式配置的扩展必须具有普通文件形式的 MV3 manifest；在读取前拒绝目录，避免 EISDIR，并增加真实文件系统回归 |
| `c9a4919` | 桌面资源解压与 Windows rename 重试 | 不适用：浏览器安装由锁定的 Playwright 管理，无自定义 ZIP 安装器 |
| `baac962` | 并发及断点下载器，应用中心遮罩 | 不适用：无应用中心和资源下载器；浏览器页面下载由 Playwright saveAs 处理 |
| `6b7a71b` | 桌面解压库改为 extract-zip | 不适用：不保留旧解压依赖 |
| `9ffc8b2` | OCR 依赖标记与非阻塞提示 | 已移植 `needOCR` 到共享自动化、管理 API 和控制台；worker 发布 OCR_UNAVAILABLE 提示后继续执行，不添加尚未迁移的 OCR 二进制或安装入口 |
| `8e65b04` | Electron 开发环境重启提示 | 不适用：Node 服务和 Vite 使用各自开发入口 |
| `57b5748` | OCR 资源按平台下载 | 不适用：不下载桌面 OCR 资源 |
| `f1d5060` | OCR CLI 打包和发布 | 不适用：服务当前无 OCR 后端 |
| `206dd7e` | 合并 dev | 无额外变更，按其组成提交审查 |
| `8bb740e` | ZIP 软链接测试夹具修复 | 不适用：无桌面解压测试 |
| `29ca4b3` | 桌面 3.2.0 发版 | 不适用：服务版本独立维护，不沿用桌面版本和历史 changelog |
| `e01c5f5` | 历史桌面文件格式整理 | 对应模块已移除；保留源码执行当前格式检查 |
| `70189b7` | 提取 URL 正则，修复 lint 超长行 | 已同步到 common 及控制台镜像，保持原有识别行为 |
| `ae777aa` | pre-push 执行 lint | 已移植，检查覆盖全部共享源码及服务测试 |
| `5a9a3f7` | pre-push 增加类型检查 | 已移植，并包含控制台独立类型检查；CI 使用同样命令 |
| `dbf2c25` | 合并 3.2.0 发布 PR | 无额外服务端修复 |

## 清理范围

删除旧 Electron app、桌面 Vue 渲染层、upgrader-stub、桌面浏览器下载及打包脚本、停用的发布工作流、release-please 配置和桌面 CHANGELOG。共享包删除无人使用的桌面 IPC/worker 契约、浏览器探测与下载源、远程资源 API、日志和字符串辅助，以及 node/web 桌面入口。

活跃共享包改名为私有 `@ocs-server/common`，仅公开服务端使用的配置校验和自动化入口；构建前清除旧 `lib`，防止删除的桌面代码继续进入交付包。清理桌面依赖配置、编辑器配置和问题模板，项目地址指向本 fork，原作者与许可证信息保留在 [来源说明](../NOTICE.md) 和包元数据中。旧源码仍可通过 Git 历史查阅。

TypeScript 统一使用控制台已有的 5.9.3，移除旧 4.x 编译器、无效的 minimatch override 和桌面安装脚本白名单。锁文件清除 jsdom、Less、Terser 的可选 peer 及其不再可达的依赖，包元数据和依赖快照从 523 项降为 416 项；现有测试使用 Node 环境，控制台使用 CSS 和默认 esbuild 压缩。Prettier 忽略规则只排除构建目录，保留对控制台 `src/lib` 源码的检查。

## 本项目额外修复

真实浏览器回归发现，`browser:install --no-shell` 和 CI 只安装完整 Chromium，控制台测试却默认查找 headless shell，导致干净环境中测试无法启动。控制台测试改用 `channel: 'chromium'` 并启用 sandbox，与 worker 使用同一安装产物；初始化也纳入清理范围，浏览器启动失败时及时关闭 HTTP 服务、fixture 和定时器，删除临时数据目录。

## 验证

在独立 WSL openEuler 副本使用 Linux Node.js 22.22.0、pnpm 10.21.0，以及锁定的 Playwright 1.60.0 / Chromium 148.0.7778.96。浏览器使用独立校验缓存，测试数据均为临时本地 fixture，不连接课程站点。

- 干净依赖安装和当前工作区 `pnpm install --frozen-lockfile --offline`、`pnpm build`、`pnpm build:web` 通过。
- `pnpm lint`、`pnpm typecheck`、`pnpm typecheck:web` 通过。
- `pnpm test` 通过：共享校验 2 项、API 13 项、扩展清单 3 项、Linux 数据锁与进程监管 13 项，共 31 项。
- 移除 DISPLAY / WAYLAND_DISPLAY 后，Chromium sandbox 预检、后端真实浏览器 smoke、控制台端到端回归通过；控制台回归包含 OCR 提示断言。
- `pnpm --filter @ocs-server/server deploy --legacy --prod --offline` 通过。独立生产目录检查共享导出、六个自动化程序、控制台，以及不含桌面模块和开发依赖；该目录的真实浏览器 smoke 也通过。
- YAML / JSON 配置解析、保留 shell 脚本语法及 `git diff --check` 通过。

校验环境没有 Docker，未执行容器构建与容器运行测试。
