# 后端兼容功能

2026-10-31，基于对上游 `dffb2ea` 的审查，将用户脚本、OCS 通信、OCR 适配、数据迁移和管理能力接入独立 Node.js 服务与 Web 控制台。原有 plain JS 和数据库保持兼容，没有引入 Electron 或桌面 IPC。

## 用户脚本

- 控制台脚本页可从 URL、本地 `.user.js` 或官方/GreasyFork/脚本猫资源库导入；可以检查版本、明确应用更新、选择源提供的历史版本及下载保存的原始代码。
- `plain` 为普通 JS，在外部 `matches` 匹配的 frame 中于 DOMContentLoaded 注入。旧记录默认为 plain。
- `userscript` 由 ScriptCat 执行元数据和 GM API；自动安装、启用状态和解绑均与实例当前关联对账。停用只关闭受管脚本，不清除其 GM 存储。重新启用、更新和实例重启保留存储。
- 自动安装适配并验证了 ScriptCat **1.5.0 MV3**。默认下载官方固定版本并校验 SHA-256，解包缓存位于数据目录 `extensions/`。支持通过 `OCS_SCRIPT_MANAGER_URL` 使用管理员选择的 ZIP 镜像，或通过 `OCS_EXTENSIONS` 使用已有 ScriptCat 解包目录。其他 MV3 扩展仍可加载；其他脚本管理器的安装 UI 不在此次适配范围内。
- 数据库与源码下载保持原文；安装副本关闭管理器自身的远程更新，避免绕过固定版本和管理 API。为使官方 OCS 的 GM 后台请求正常工作，安装副本仅把三个既有的本地配置/动作令牌读取地址适配到实例独有的随机 loopback 路径，不传递管理令牌。
- 管理器启动使用 Chromium sandbox 和普通用户。支持自动开启对应扩展的“允许用户脚本”设置。安装失败会上报事件并使本次启动失败，不把未安装状态报告为成功。

## OCS 配置与辅助动作

设置页使用以下结构开启同步：

```json
{"openSync":true,"store":{"你的 OCS 配置项":"值"}}
```

通过 `/api/v1/settings` 更新时最外层为 `{"ocs":{...}}`。保存后同步到正在启动和运行的实例；关闭同步后返回空配置。读取兼容官方脚本使用的 GM 后台请求，受管页面的环境识别与动作请求由 Playwright 路由提供。

动作使用独立实例凭据和明确白名单，包含鼠标/键盘、填写、选择、等待请求和响应等；URL 等待使用片段或 `*` 通配符，响应正文有大小上限。不提供任意 JS、Node、文件上传路径或 CDP 透传。旧的无认证 HTTP 接口没有重新对外开放。

## OCR、预览和数据

- `OCS_OCR_URL` 接入兼容 JSON OCR 服务，传递现有自动化的第三参数。支持文字验证码和滑块目标识别响应；未配置时提示 `OCR_UNAVAILABLE` 并继续无验证码流程。没有捆绑平台专属 OCR 二进制，实际识别能力由配置的服务提供。
- 实时画面使用 CDP screencast 与受认证的 MJPEG，保持一个未消费帧，断线、页面关闭、实例停止时清理。帧不进入 SSE 和磁盘日志。
- 每个实例报告内存和 CPU；可通过 `OCS_MIN_FREE_MEMORY_MB` / `OCS_MAX_CPU_PERCENT` 启用资源检查，默认 0 关闭。固定并发数量限制继续生效。
- 设置页导出密码加密的 `.ocsdata`，在所有实例停止后确认导入。本项目格式保留密码和脚本关联；桌面格式转换自动化和网络脚本，保留分组路径、标签名称与备注。旧本地文件路径、Cookie 和下载无法通过业务导入恢复，界面会报告兼容警告；完整磁盘数据仍按部署文档备份。
- 存储页可统计空间并确认清理缓存、profile、下载或全部；缓存清理保留 Cookie。删除 profile 会同时清除对应脚本管理器对账记录。逻辑分组字段不访问服务器目录，没有移植桌面的拖拽文件树。

## 验证入口

```bash
pnpm build
pnpm build:web
pnpm lint
pnpm typecheck
pnpm typecheck:web
pnpm test
pnpm smoke
pnpm test:browser
pnpm test:web
pnpm test:managed-scripts
```

最后一项默认获取固定版本管理器；离线时可指定已经解包且校验过的目录：

```bash
OCS_TEST_MANAGER_DIR=/absolute/path/to/scriptcat pnpm test:managed-scripts
```

`OCS_TEST_MANAGER_DIR` 只控制测试，生产环境使用 `OCS_EXTENSIONS`。浏览器测试使用本地 fixture，不连接课程站点；源 provider 的映射使用本地 HTTP fixture，不能据此保证第三方服务一直可用。管理器验证覆盖真实 ScriptCat 安装、GM 存储跨重启、禁用/解绑、版本更新、后台请求和完整管理 API。部署变量及请求示例见 [API](api.md)。

2026-10-31 校验：格式检查、前后端类型检查和构建通过；共享 2 项、后端 54 项、进程/锁 16 项测试通过，共 72 项。浏览器 smoke、桥接/预览 2 项真实浏览器测试、管理器/API 2 项真实浏览器测试和控制台 3 组端到端脚本均通过。独立 `pnpm deploy --legacy --prod --offline` 产物包含前端、新增运行依赖，并通过真实浏览器 smoke。使用 WSL Linux、Node.js 26.12.1、pnpm 10.21.0、Playwright 1.60.0 与匹配的 Chromium 148.0.7778.96，保留 sandbox；当前环境没有 Docker，未执行镜像构建和容器运行。
