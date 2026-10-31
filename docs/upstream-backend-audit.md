# 后端能力差异检查（2026-10-30）

> 下文为 `3508ab1` 的历史审查快照。2026-10-31 的处理已补齐关键链路；当前能力、配置和验证方式见 [后端兼容功能](backend-compatibility.md)。

本项目已保留独立实例管理和普通 JavaScript 注入，但尚未保留上游完整的标准用户脚本运行链路。特别是“获取数据库里已保存的脚本”和“从远程获取、安装、更新标准用户脚本”是两种不同能力：前者已有，后者缺失。OCS 配置同步、软件辅助桥接和 OCR 也有独立缺口。

## 比较基准与范围

- 本项目：`3508ab1260d84a6f7aa389fda882a92935f4b2ea`。
- 上游：[`dffb2ea3c518fb862ad5e31b6881632287fb2993`](https://github.com/ocsjs/ocs-desktop/commit/dffb2ea3c518fb862ad5e31b6881632287fb2993)，检查时的 `main`，对应 3.7.0。
- 已更新 `upstream/main` 后逐项检查源码，没有仅凭 README 或提交落后数量判定功能缺失。
- `docs/upstream-sync.md` 记录的审查终点仍是 `dbf2c25`；到本次上游基准共有 56 个提交。此次仅审查，不代表已移植这些提交。
- 涵盖主进程/worker、HTTP 与桌面 RPC 承担的业务、前端发起的资源获取和安装流程。前端入口不意味着功能可以只在新控制台补一个按钮。

## 用户脚本：已有能力与真实缺口

| 能力 | 本项目状态 | 判断和影响 |
| --- | --- | --- |
| 获取已保存的脚本、源码与列表 | 已有 `GET /api/v1/user-scripts`、`GET /api/v1/user-scripts/:id`，响应包含 `code` | 不缺这一类“获取脚本”；增删改及启用状态也已有 |
| 按实例关联并执行普通 JS | 已有 `userScriptIds`、`enabled` 过滤，以及匹配 URL 后的 `addInitScript` | 可执行不依赖脚本管理器的普通 JS |
| 从 URL 或 `.user.js` 文件导入 | 没有来源字段和获取/解析入口 | 只能手工提供 `name/code/matches`；不能直接提交脚本 URL 安装 |
| 官方脚本、GreasyFork、脚本猫资源获取 | 没有对应资源 API/provider，也没有启动时补齐官方脚本的流程 | 缺少上游资源发现、搜索和自动准备能力 |
| 版本检查、固定版本、更新和失败重试 | 没有 source/version/lastInstalledVersion 等状态 | 保存的是静态代码文本，不会跟随脚本源更新 |
| 远程脚本预下载与 `.user.js` 分发 | 没有对应管线；现有 GET 返回 JSON | 无法供管理器拦截安装；若采用纯 JS 注入方案，则不必照搬旧 HTTP 路径 |
| 下载脚本管理器并自动安装脚本 | 只支持 `OCS_EXTENSIONS` 指定已有的本地解包 MV3 扩展 | “能加载扩展”不代表具备管理器下载、脚本安装和安装结果确认 |
| `GM_*`、`@require`、`@match`、`@exclude`、`@run-at` 等执行语义 | 当前不实现，由外部 `matches` 字段匹配，固定在 DOMContentLoaded 执行 | 常规油猴/脚本猫脚本不能直接视为兼容；元数据注释不会自动生效 |

本地主要证据：`packages/server/src/http.ts:240`、`:256`；`types.ts:11`；`validation.ts:99`（仅允许 `name/code/matches/enabled`）；`worker.ts:118`、`:125`；`config.ts:58`、`extensions.ts:5`。

上游链路的证据：

- [user-scripts.ts:59](https://github.com/ocsjs/ocs-desktop/blob/dffb2ea3c518fb862ad5e31b6881632287fb2993/packages/web/src/utils/user-scripts.ts#L59)：URL 获取；同文件 `:9` 是本地文件入口，`:99` 解析展示用的 name/version/author/description/license。
- [config/index.ts:73](https://github.com/ocsjs/ocs-desktop/blob/dffb2ea3c518fb862ad5e31b6881632287fb2993/packages/web/src/config/index.ts#L73)：脚本源搜索、详情和版本 provider；[env-bootstrap.ts:30](https://github.com/ocsjs/ocs-desktop/blob/dffb2ea3c518fb862ad5e31b6881632287fb2993/packages/web/src/utils/env-bootstrap.ts#L30)：启动时补齐管理器及官方脚本。
- [script-version.ts:149](https://github.com/ocsjs/ocs-desktop/blob/dffb2ea3c518fb862ad5e31b6881632287fb2993/packages/web/src/utils/script-version.ts#L149)：`.meta.js`、固定版本、已安装版本与重试判定。
- [remote.register.ts:237](https://github.com/ocsjs/ocs-desktop/blob/dffb2ea3c518fb862ad5e31b6881632287fb2993/packages/app/src/tasks/remote.register.ts#L237)：预下载脚本；[startup.server.ts:419](https://github.com/ocsjs/ocs-desktop/blob/dffb2ea3c518fb862ad5e31b6881632287fb2993/packages/app/src/tasks/startup.server.ts#L419)：白名单下分发本地脚本。
- [extension.ts:11](https://github.com/ocsjs/ocs-desktop/blob/dffb2ea3c518fb862ad5e31b6881632287fb2993/packages/web/src/utils/extension.ts#L11)：下载、解压管理器；[worker/index.ts:1210](https://github.com/ocsjs/ocs-desktop/blob/dffb2ea3c518fb862ad5e31b6881632287fb2993/packages/app/src/worker/index.ts#L1210)：打开脚本 URL、等待管理器安装页并操作安装。

**关于“封装”的澄清：上游没有自行把用户脚本编译或打包成 MV3 扩展。** 它加载现成的脚本管理器，由管理器提供 GM API 和用户脚本执行语义。其元数据解析函数只提取展示信息。

```text
上游：获取 .user.js → 检查版本 → 预下载 → HTTP 分发
    → 脚本管理器拦截 → Playwright 操作安装 → 管理器执行

本项目：手工填写 name/code/matches → JSON 持久化
      → 实例启动时 addInitScript → DOMContentLoaded 执行普通 JS
```

如果“封装”指下载一个带元数据头的 `.user.js` 文件，目前也没有专用原始脚本下载接口；不过已有获取 `code` 的 JSON 接口。补一个导出接口并不能补齐管理器兼容性。

## 其他后端差异

| 优先级 | 缺口 | 本项目证据与实际影响 | 上游证据 |
| --- | --- | --- | --- |
| 高 | OCS 配置没有同步到脚本 | `http.ts:285` 只有 settings 存取；`protocol.ts:5` 的启动 payload 不含 settings；worker 没有消费 `settings.ocs`。控制台保存成功不等于页面内脚本会应用配置 | [startup.server.ts:251](https://github.com/ocsjs/ocs-desktop/blob/dffb2ea3c518fb862ad5e31b6881632287fb2993/packages/app/src/tasks/startup.server.ts#L251) 的 `/browser` 和 `:258` 的 `/is-browser-config-sync` |
| 高 | OCS 软件环境与动作桥接 | `protocol.ts:3` 只有 pages/navigate/screenshot/click/fill，worker 没有对应请求拦截；即使手工加载管理器，也缺上游的软件辅助通信协议 | [worker/index.ts:1588](https://github.com/ocsjs/ocs-desktop/blob/dffb2ea3c518fb862ad5e31b6881632287fb2993/packages/app/src/worker/index.ts#L1588) 的 `/ocs-environment`、`/ocs-script-actions`，`:1560` 的动作白名单 |
| 高 | OCR 服务与自动化调用参数 | `worker.ts:182` 报告 `OCR_UNAVAILABLE`，`:191` 仅传入 page/configs；验证码或滑块出现时无法使用上游识别能力 | [startup.server.ts:386](https://github.com/ocsjs/ocs-desktop/blob/dffb2ea3c518fb862ad5e31b6881632287fb2993/packages/app/src/tasks/startup.server.ts#L386) 的 `/ocr`；[worker/index.ts:1469](https://github.com/ocsjs/ocs-desktop/blob/dffb2ea3c518fb862ad5e31b6881632287fb2993/packages/app/src/worker/index.ts#L1469) 传入 OCR 参数 |
| 中 | `.ocsdata` 导入导出/旧数据迁移 | `types.ts:28` 使用新 schema，HTTP 无导入导出入口；完整数据目录备份不能替代跨版本业务数据导入 | [remote.register.ts:211](https://github.com/ocsjs/ocs-desktop/blob/dffb2ea3c518fb862ad5e31b6881632287fb2993/packages/app/src/tasks/remote.register.ts#L211) 的加密导出/解密导入；[Title.vue:218](https://github.com/ocsjs/ocs-desktop/blob/dffb2ea3c518fb862ad5e31b6881632287fb2993/packages/web/src/components/Title.vue#L218) |
| 中 | 实测 CPU/内存及启动资源检查 | `runtime.ts:70` 仅固定 `maxBrowsers` 数量保护，`types.ts:21` 无资源指标；这是较新上游增量中适用于服务器的能力 | [worker/index.ts:326](https://github.com/ocsjs/ocs-desktop/blob/dffb2ea3c518fb862ad5e31b6881632287fb2993/packages/app/src/worker/index.ts#L326)、`:350`；[launch-check.ts:43](https://github.com/ocsjs/ocs-desktop/blob/dffb2ea3c518fb862ad5e31b6881632287fb2993/packages/web/src/utils/launch-check.ts#L43) |
| 中 | 自动化诊断信息收缩 | `worker.ts:177` 把 script-error 转为布尔状态，`:202` 只发布完成/失败；`runtime.ts:85` 忽略 worker stdout/stderr。虽有事件日志，平台失败原因仍难追踪 | [worker/index.ts:1462](https://github.com/ocsjs/ocs-desktop/blob/dffb2ea3c518fb862ad5e31b6881632287fb2993/packages/app/src/worker/index.ts#L1462) 转发 script-data/script-error |
| 可选 | 实时浏览器预览 | `worker.ts:219` 只有单次 PNG；SSE 是事件流，没有视频帧 | [worker/index.ts:568](https://github.com/ocsjs/ocs-desktop/blob/dffb2ea3c518fb862ad5e31b6881632287fb2993/packages/app/src/worker/index.ts#L568) 的 screencast |
| 较低 | 缓存空间统计/清理和管理元数据 | `http.ts:155` 删除实例仅删除配置，保留 profile/downloads；无专用清理 API。BrowserProfile 无上游的文件夹/标签/备注等字段 | [browser.ts:143](https://github.com/ocsjs/ocs-desktop/blob/dffb2ea3c518fb862ad5e31b6881632287fb2993/packages/web/src/utils/browser.ts#L143)、`:187`；[fs/interface.ts:46](https://github.com/ocsjs/ocs-desktop/blob/dffb2ea3c518fb862ad5e31b6881632287fb2993/packages/web/src/fs/interface.ts#L46) |

六个内置自动化程序并未缺失：通用新建页面、超星、智慧树、职教云/ICVE、智慧职教、中国大学 MOOC。与上游当前实现逐文件对照，主要差异是 import、类型、注释和 OCR 缺失提示，执行逻辑一致。缺的是部分执行依赖与外围能力，不能概括为“没有登录程序”。

托盘、窗口、桌面开机自启、Electron 更新器、桌面显示环境修复和桌面安装包不属于此次应补的 headless 后端能力。浏览器安装已由锁定的 Playwright 和容器构建承担。上游 collector 入口为空，也不能仅凭 `CollectorScript` 类型认定遗漏了采集系统。

## 验证与边界

- 在现有 WSL openEuler 环境对当前源码执行 common/server TypeScript 编译，通过。
- API 13 项、扩展清单校验 3 项，共 16 项测试通过。
- 使用临时数据目录启动服务，确认：已保存脚本的详情可读取原始 code；仅提交 URL 的创建请求返回 400；标准 userscript 形式的 `*://example.com/*` 在当前 matches 校验中返回 400；settings 可保存；旧 `/browser`、`/is-browser-config-sync`、`/api/local-userscript`、`POST /ocr` 返回 404。
- 使用真实 Chromium 和本地 HTTP fixture 验证：普通 JS 注入成功；`typeof GM_getValue` 为 `undefined`；即使元数据写有不匹配的 `@match`、排除当前页面的 `@exclude` 和 `@run-at document-start`，只要外部 matches 匹配，脚本仍在 DOMContentLoaded 时执行，观测到 readyState 为 `interactive`。
- 浏览器验证使用现有 Playwright 1.60.0、Node.js 26.12.1，以及临时显式指定的本机缓存 Chromium 156.0.8078.4，保留 sandbox。环境缺少 Playwright 默认查找的 chromium-1223，因此没有证明默认浏览器安装路径或 Docker 交付正常；未安装新浏览器，也未改变项目运行配置。
- 未连接课程站点，未验证实际验证码识别、外部脚本源可用性或真实脚本管理器安装。旧接口 404 本身不足以证明业务缺失；上述判断同时核对了当前 worker、协议、配置类型和全部 HTTP 路由。
- 本次只新增检查记录，没有实现功能移植，也没有修改业务代码。

## 建议落地顺序

1. 先确定标准用户脚本的运行方式；若目标是兼容上游，优先迁移管理器加载、脚本安装和结果确认，再补 URL/文件导入、版本检查、资源搜索。
2. 接通 OCS 配置同步与实例内软件辅助桥接。使用实例范围的通信凭据，沿用动作白名单设计，不向页面下发服务管理总令牌。
3. 让 OCR 成为可配置的服务依赖，传入现有自动化的第三参数，并保留无验证码场景继续运行的行为。
4. 增加脱敏的诊断信息、数据导入导出和资源统计；实时预览、标签及目录清理按实际管理需要安排。

只增加一个“获取脚本 URL”接口不足以让依赖 GM API、外部库或软件辅助协议的 OCS 用户脚本等价运行。
