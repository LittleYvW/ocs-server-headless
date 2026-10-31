# 管理 API

API 基路径为 `/api/v1`。管理客户端通过 HTTP 请求管理实例，通过 SSE 订阅运行变化，不直接访问服务端文件系统或浏览器调试端口。同源 Web 控制台见 [Web 控制台](web-ui.md)。

## 认证与响应

`GET /healthz` 返回简略进程健康信息，无需认证；其余接口均要求：

```http
Authorization: Bearer <管理令牌>
Content-Type: application/json
```

首次启动未设置 `OCS_AUTH_TOKEN` 时，在 `OCS_DATA_DIR/admin.token` 生成管理员令牌。接口不提供令牌领取功能，也不接受查询参数令牌。请求的 `Origin` 必须为服务来源或 `OCS_ALLOWED_ORIGINS` 精确允许的来源。HTTPS 反向代理部署应显式设置外部 HTTPS Origin，服务不自动信任代理头。命令行客户端可以不发送 `Origin`。

普通 JSON 成功响应（创建返回 201；删除成功返回 204 空响应）：

```json
{"data": {}}
```

失败响应：

```json
{"error":{"code":"错误标识","message":"可展示的错误说明"}}
```

常见 HTTP 状态包括 `400`（参数非法）、`401`（认证失败）、`403`（来源未允许）、`404`（资源不存在）、`409`（状态冲突或并发容量已满），以及浏览器操作失败的 `5xx`。客户端以 HTTP 状态和实际返回的 `error.code` 分支处理，不依赖中文消息内容。截图、文件下载和事件流返回各自的媒体类型。

## 控制台静态资源

服务端在 `OCS_WEB_DIR`（默认 `packages/server/web`）存在 `index.html` 时，于同源根路径 `/` 提供控制台构建，并设置专用 CSP 与缓存头。控制台使用 hash 路由，不需要 SPA 重写；未知路径仍返回 JSON 404，API 路由不受影响。未构建前端时服务保持纯 API 行为。

控制台通过 `Authorization` 头调用接口，事件流使用带该头的 `fetch` SSE；管理令牌不进入 URL。部署与开发说明见 [Web 控制台](web-ui.md)。

## 服务与配置

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/healthz` | 进程存活检查；不探测浏览器 |
| GET | `/api/v1/system` | 服务信息、运行环境和实例状态 |
| GET | `/api/v1/automation-scripts` | 内置自动化程序及其配置定义 |
| GET | `/api/v1/settings` | 读取平台设置 |
| PATCH | `/api/v1/settings` | 更新平台设置，body 为 `{"ocs":{...}}` |
| GET | `/api/v1/logs?limit=100` | 读取近期内存事件记录 |
| GET | `/api/v1/events` | 订阅 `text/event-stream` 事件 |

监听地址、端口、密钥、可执行路径、扩展路径和实例容量由服务进程环境变量管理，不允许通过 API 修改。`settings.ocs` 是持久化的业务配置容器，PATCH 会用所提供对象整体替换 `ocs`，调用方应提交完整预期内容；设置会实时同步到正在运行的实例。设置形状为 `{"ocs":{"openSync":true,"store":{...}}}`；`openSync` 关闭时浏览器脚本获取空配置。旧桥接仅存在于实例内部，不作为公开管理路由。

`/automation-scripts` 返回配置定义、`needOCR` 和 `ocrAvailable`。OCR 通过部署变量 `OCS_OCR_URL` 配置，未配置时发布 `OCR_UNAVAILABLE` 并继续无验证码流程；配置后，worker 将现有自动化的 OCR 请求转发至该服务。服务需接受 `POST {"image":"base64"}` 并返回 `{"canOCR":true,"code":"文字"}`，或接受 `{"det_target":"base64","det_bg":"base64"}` 并返回 `{"canOCR":true,"det":{"target":[x,y]}}`。调用有超时和大小限制，不返回外部服务的原始错误。

`/system` 额外返回 `ocrAvailable`、宿主 `resources`（内存、CPU 数量、负载）和 `resourcePolicy`。运行状态的可选 `resources` 包含 `memoryMB/cpuPercent/cpuTime/sampledAt`，约每 10 秒更新。`OCS_MIN_FREE_MEMORY_MB` 与 `OCS_MAX_CPU_PERCENT` 为可选启动阈值，默认 0 关闭，超过限制返回 `409 RESOURCE_LIMIT`。

## 浏览器实例

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/v1/browsers` | 列出持久化实例及运行状态 |
| POST | `/api/v1/browsers` | 创建实例 |
| GET | `/api/v1/browsers/:id` | 读取实例 |
| PATCH | `/api/v1/browsers/:id` | 更新实例配置 |
| DELETE | `/api/v1/browsers/:id` | 删除配置，保留磁盘 profile 和下载 |
| POST | `/api/v1/browsers/:id/start` | 启动实例 |
| POST | `/api/v1/browsers/:id/stop` | 停止实例 |
| POST | `/api/v1/browsers/:id/restart` | 停止并按当前保存配置启动 |

创建或更新的字段：

```json
{
  "name": "实例一",
  "startUrl": "https://example.com",
  "automationScripts": [
    {"name": "通用-新建页面", "configs": {"url": "https://example.com"}}
  ],
  "userScriptIds": []
}
```

可选 `group`（最多 500 字符）、`tags`（最多 30 个、每个 100 字符）和 `notes`（最多 10000 字符）作为管理元数据；分组仅为逻辑路径，不是服务端目录。

`id` 和时间字段由服务端生成，不能指定 profile 目录、进程路径、任意 Chromium 参数或关闭无头模式。`startUrl` 使用不含用户名或密码的 HTTP / HTTPS 地址，默认 `https://example.com/`。自动化程序名称与配置应从 `/automation-scripts` 返回结果获取，不硬编码所有登录配置。

`configs` 是平铺值，而非桌面版 `{label,value,type}` 完整定义。服务端按内置定义补默认值并校验配置。密码类配置读取时脱敏为 `***`，更新时发送 `***` 保留原值；如果提交整个自动化程序数组，未提供的配置项使用该程序默认值；保留已有密码时应明确发送 `***`。完全省略 `automationScripts` 字段则保留之前整组配置。客户端保存表单时应保留这一语义。

PATCH 和 DELETE 要求实例处于 stopped 或 error 状态；运行中、启动中或停止中修改会返回 409 BROWSER_BUSY。

生命周期包括 `starting`、`running`、`stopping`、`stopped`、`error`。启动等待浏览器就绪后返回，内置自动化随后运行并发出事件；`running` 不等于所有自动化程序均已完成。浏览器已运行或启动中时的重复启动可能返回状态冲突。服务重启不会自动启动保存的实例。

## 页面与操作

以下操作需要实例已运行。页面 ID 由 pages 接口返回，其有效期属于当前浏览器运行周期；前端在重启后重新拉取。

| 方法 | 路径 | 参数 / 返回 |
| --- | --- | --- |
| GET | `/api/v1/browsers/:id/pages` | 页面数组，每项包括 `id,url,title` |
| POST | `/api/v1/browsers/:id/navigate` | `{"url":"https://example.com","pageId":"可选"}`，返回页面 `id,url,title` |
| POST | `/api/v1/browsers/:id/click` | `{"selector":"button[type=submit]","pageId":"可选"}` |
| POST | `/api/v1/browsers/:id/fill` | `{"selector":"input[name=username]","text":"内容","pageId":"可选"}` |
| GET | `/api/v1/browsers/:id/screenshot?pageId=...` | `image/png`；pageId 可选 |
| POST | `/api/v1/browsers/:id/new-page` | `{"url":"可选，默认 about:blank"}` |
| POST | `/api/v1/browsers/:id/close-page` | `{"pageId":"必填"}` |
| POST | `/api/v1/browsers/:id/reload` | `{"pageId":"可选"}` |
| POST | `/api/v1/browsers/:id/press` | `{"selector":"input","key":"Enter","pageId":"可选"}` |
| POST | `/api/v1/browsers/:id/check` | `{"selector":"input[type=checkbox]","checked":true,"pageId":"可选"}` |
| POST | `/api/v1/browsers/:id/select` | `{"selector":"select","values":["value"],"pageId":"可选"}` |
| GET | `/api/v1/browsers/:id/preview?pageId=...` | 带 Bearer 的 MJPEG 实时预览；同实例限一个连接 |

未提供 pageId 时使用 worker 的默认页面。选择器交由 Playwright 定位；操作存在超时，不提供任意 JavaScript 求值、Node 执行、文件读取或 CDP 透传 API。截图可能包含站点敏感内容，需要管理令牌才能读取。

## 用户脚本

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/v1/user-scripts` | 列表 |
| POST | `/api/v1/user-scripts` | 新建 |
| GET | `/api/v1/user-scripts/:id` | 详情与代码 |
| PATCH | `/api/v1/user-scripts/:id` | 更新 |
| DELETE | `/api/v1/user-scripts/:id` | 删除 |

示例：

```json
{
  "name": "示例页面脚本",
  "code": "document.documentElement.dataset.ocs = 'ready';",
  "matches": ["https://example.com/*"],
  "enabled": true
}
```

`mode` 缺省为 `plain`，兼容原有普通 JS：`matches` 按完整 URL 匹配，仅 `*` 是通配符，在匹配 frame 的 DOMContentLoaded 注入，不提供 GM API。

`mode: "userscript"` 表示标准脚本，由脚本管理器执行 `@match/@include/@exclude/@run-at/@require/@grant` 等元数据并提供 GM 能力。名称、版本与 `metadata` 从代码头解析，`sourceUrl` 和 `updateUrl` 可选。标准源码上限 2 MiB。首次关联标准脚本启动时下载固定版本的 ScriptCat ZIP 并校验 SHA-256，或加载管理员提供的本地 ScriptCat 1.5 管理器。管理器安装进度通过事件上报，安装失败不会假报完成。脚本代码/启用状态/实例关联变更在实例重启时应用。

| 方法 | 路径 | 参数 / 返回 |
| --- | --- | --- |
| POST | `/api/v1/user-scripts/import` | `{"url":"https://example.com/script.user.js"}` 或 `{"code":"完整 .user.js 文本"}`；可附 name/enabled/pinned |
| GET | `/api/v1/user-scripts/:id/code` | 鉴权下载完整脚本源码 |
| POST | `/api/v1/user-scripts/:id/check-update` | `{available,currentVersion,latestVersion,updateUrl}`；只检查，不改代码 |
| POST | `/api/v1/user-scripts/:id/update` | 显式下载并应用更新，失败保留原代码 |
| GET | `/api/v1/script-catalog?provider=official&q=...&page=1&limit=20` | 官方、greasyfork、scriptcat 脚本搜索 |
| GET | `/api/v1/script-catalog/:provider/:id/versions` | 源支持时返回版本及固定版本 codeUrl；选定 URL 后导入 |

下载只使用 HTTP(S)，不携带管理凭据；有重定向、超时和响应大小限制。删除仍被实例引用的脚本返回 `409 SCRIPT_IN_USE`。源获取由管理员显式发起，不是任意 Node 代码上传接口。

安装副本关闭管理器自身更新，版本由管理 API 控制；保存和下载的源码保持原文。GM 后台请求通过安装副本适配到随机私有 loopback 端点；服务不监听公开旧接口。请求等待支持 URL 片段和 `*` 通配符，返回正文上限 1 MiB。

实例内部的 `/browser`、`/is-browser-config-sync`、`/get-actions-key`、`/ocs-environment`、`/ocs-script-actions` 由 Playwright 请求路由提供，使用独立实例凭据与明确动作白名单；服务管理令牌不会传入页面。动作桥接不接受任意求值、上传本地文件、截图文件路径或 Node API。

## 数据与存储

- `POST /api/v1/data/export {"password":"导出密码"}`：下载密码加密 `.ocsdata`，包含业务配置和脚本，不包含 Cookie/profile/下载目录。
- `POST /api/v1/data/import {"content":"文件完整文本","password":"可选"}`：在所有实例停止时替换业务数据库，返回实例/脚本计数和兼容警告。支持本项目格式和桌面明文/密码加密导出；绑定旧机器的密文需在原机器重新导出。
- 旧桌面网络脚本会获取源码，本地文件路径脚本无法跨机读取，会跳过并报告；Cookie/profile 应按部署文档单独备份。
- `GET /api/v1/browsers/:id/storage`：返回 profileBytes/downloadBytes/cacheBytes。
- `DELETE /api/v1/browsers/:id/storage {"target":"cache"}`：仅停止状态允许，target 可为 cache/profile/downloads/all。cache 保留 Cookie，profile/all 会清除对应浏览器登录数据。

实时画面通过受认证的 MJPEG 流传递，包含背压与断线清理，不写入 SSE 或磁盘事件日志。

## 下载

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/v1/browsers/:id/downloads` | 列出该实例下载文件 |
| GET | `/api/v1/browsers/:id/downloads/:filename` | 下载列表中指定的文件 |

下载由 worker 存入服务端数据目录下的实例专属目录；文件名由服务端规范化并加入唯一标识。请求时使用列表返回的文件名并对路径段进行 URL 编码。API 不接受任意绝对路径，不允许读取下载目录之外的文件。

## 事件流

`GET /api/v1/events` 返回标准 SSE。使用带 Bearer 头的 `fetch` 流读取；原生 `EventSource` 无法直接设置该认证头，不能把 token 拼到 URL 中规避。

```js
const response = await fetch('/api/v1/events', {
  headers: { Authorization: `Bearer ${token}` },
  signal: controller.signal
});
if (!response.ok) throw new Error(`HTTP ${response.status}`);
// 通过 TextDecoderStream 和 SSE 解析器增量解析 response.body。
```

事件用于状态更新与诊断，不是任务结果数据库。客户端断线重连后应重新获取实例和页面状态；近期事件缓存容量有限，不能假定永久可回放。跨域预检允许 `Authorization`、`Content-Type` 与 `Last-Event-ID`；原生 `EventSource` 无法附加认证头。界面按返回的事件类型处理，不将页面文本、脚本配置或密码写入自己的事件日志。

事件格式为 `id`、`event`（类型）和 `data`（完整 JSON 事件对象）：

```json
{"id":1,"type":"browser-state","time":"2026-10-24T00:00:00.000Z","data":{"profileId":"实例ID","id":"实例ID","status":"running"}}
```

主要事件包括 `browser-state`、`page-created`、`page-closed`、`automation-started`、`automation-warning`、`automation-result`、`download-completed`、`userscript-result`、`userscript-install-started`、`userscript-install-result`、`resource-usage`、`automation-diagnostic`、`browser-error`，以及配置变更事件如 `browser.created`、`browser.updated`、`userscript.updated`。自动化结果的 status 为 `completed` 或 `error`。客户端宜忽略未知事件类型，以便兼容新增类型。

近期内存缓存最多 500 条，`logs` 的 limit 范围为 1–500，重启后内存历史清空；磁盘事件保存在数据目录 `logs/events.jsonl`，达到约 5 MiB 后轮转一份。SSE 每 15 秒发送注释心跳，最多 64 个并行订阅。`Last-Event-ID` 可用于同次服务运行期间的有限回放；重启后序号重置，应重新同步状态。

普通 JSON 请求体上限 1 MiB，用户脚本接口 3 MiB，数据导入接口 30 MiB（文件内容上限 20 MiB）；普通脚本上限 250000 字符，标准脚本上限 2 MiB；实例和用户脚本各最多 1000 条。运行实例上限由 OCS_MAX_BROWSERS 控制（默认 4，允许 1–64）。这些限制不替代浏览器自身的内存和 CPU 资源管理。
