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

监听地址、端口、密钥、可执行路径、扩展路径和实例容量由服务进程环境变量管理，不允许通过 API 修改。`settings.ocs` 是持久化的业务配置容器，PATCH 会用所提供对象整体替换 `ocs`，调用方应提交完整预期内容；本阶段不承诺旧桌面版 OCS 网页桥接接口。

`/automation-scripts` 每项返回 `name`、可选 `icon`、`configs` 和布尔字段 `needOCR`。`needOCR: true` 表示登录过程可能遇到需要 OCR 的验证码。当前服务未提供 OCR 后端，控制台会提示该限制；不阻止创建配置或启动浏览器，也不保证这些站点的登录一定成功。worker 在执行此类程序前发布 `automation-warning`，其 data 包含 `profileId`、`name` 与 `code: "OCR_UNAVAILABLE"`，之后继续执行并报告实际结果。

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

这是普通 JavaScript 的页面注入。`matches` 按完整页面 URL 匹配，仅 `*` 为任意长度通配符，其他字符按字面处理。例如 `https://example.com/*` 匹配该站点路径，`https://*.example.com/*` 不自动匹配根域。代码在每个匹配 frame 的 DOMContentLoaded 时运行；不解析 `.user.js` 元数据，不实现 `GM_*`、外部 `@require`、脚本管理器存储或扩展权限。更改代码、启用状态或实例的脚本关联后，重启实例使其生效。删除仍被实例引用的脚本返回 409 SCRIPT_IN_USE，需要先停止相关实例并移除关联。代码在浏览器页面上下文中执行，不是服务端自动化脚本上传接口。

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

主要事件包括 `browser-state`、`page-created`、`page-closed`、`automation-started`、`automation-warning`、`automation-result`、`download-completed`、`userscript-result`、`browser-error`，以及配置变更事件如 `browser.created`、`browser.updated`、`userscript.updated`。自动化结果的 status 为 `completed` 或 `error`。客户端宜忽略未知事件类型，以便兼容新增类型。

近期内存缓存最多 500 条，`logs` 的 limit 范围为 1–500，重启后内存历史清空；磁盘事件保存在数据目录 `logs/events.jsonl`，达到约 5 MiB 后轮转一份。SSE 每 15 秒发送注释心跳，最多 64 个并行订阅。`Last-Event-ID` 可用于同次服务运行期间的有限回放；重启后序号重置，应重新同步状态。

JSON 请求体上限 1 MiB；脚本代码上限 250000 字符；实例和用户脚本各最多 1000 条。运行实例上限由 OCS_MAX_BROWSERS 控制（默认 4，允许 1–64）。这些限制不替代浏览器自身的内存和 CPU 资源管理。
