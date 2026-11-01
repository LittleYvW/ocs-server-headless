# 题库服务前端执行文档

状态：已实现。控制台新增 `#/question-bank` 页面与真实浏览器用例 `packages/web-ui/tests/question-bank.e2e.cjs`；本文件保留为功能、数据、交互、错误处理与验收规范，不规定视觉设计风格，沿用现有控制台设计系统。

实现落点：`api/types.ts`、`api/endpoints.ts`、`api/question-query.ts`（独立查询，不带管理令牌）、`lib/question-bank.ts`、`stores/question-bank.ts`、`views/QuestionBankView.vue` 与 `components/question-bank/*`。

接口完整契约见 [独立题库服务](question-bank.md)。新增代码仅消费管理 API 与独立查询 API，不使用 Tauri、文件系统、Docker socket 或任意代码执行接口。

## 1. 交付边界与文件

新增导航项“题库服务”，使用现有 hash router 路径 `/question-bank`。页面包含服务设置、题目、文件夹、客户端接入、查询验证和日志功能。保持与浏览器实例管理并列；不把题库服务作为一个浏览器实例。

建议执行顺序与文件：

1. 在 `packages/web-ui/src/api/types.ts` 增加题库类型；在 `api/endpoints.ts` 封装下表接口。
2. 新建 `stores/question-bank.ts` 管理状态、分页、草稿和页面请求取消，不在全局持久化 API Key 或查询令牌。
3. 新建 `views/QuestionBankView.vue`，在 router 和导航注册入口。
4. 按功能拆分设置、题目表单、导入、客户端接入、查询验证等组件。
5. 增加真实浏览器端到端用例，使用真实题库服务和本地供应商 fixture。

## 2. 类型与 API 封装

管理接口基路径 `/api/v1/question-bank`，使用现有管理客户端的 Bearer 及错误处理。普通成功 HTTP 200，删除成功也返回 `{data:null}`；连接配置创建为 201。保留 `error.code`，不要只按消息文本判断。

| 操作 | 方法与相对路径 | 关键数据 |
| --- | --- | --- |
| 状态 | GET `/status` | `configured/available/enabled/aiEnabled/stats/limits/capabilities` |
| 读取／保存设置 | GET / PATCH `/settings` | `Settings`，按字段合并 |
| 客户端列表 | GET `/tokens` | `id/name/prefix/createdAt/lastUsedAt` |
| 生成连接配置 | POST `/connections` | 输入 `{name,baseUrl}`；结果 `client/queryUrl/wrapper` |
| 撤销客户端 | DELETE `/tokens/:id` | 成功后刷新列表 |
| 文件夹列表 | GET `/folders` | `id/name/parentId/questionCount` |
| 新建／更新文件夹 | POST `/folders`、PUT `/folders/:id` | `{name,parentId}` |
| 删除空文件夹 | DELETE `/folders/:id` | 非空返回 409，默认文件夹不可删除 |
| 题目列表 | GET `/questions` | `page/limit/folderId/q`；结果 `items/total/page/limit` |
| 题目详情 | GET `/questions/:id` | 完整记录 |
| 新建／更新题目 | POST `/questions`、PUT `/questions/:id` | 完整 `QuestionInput` |
| 删除题目 | DELETE `/questions/:id` | 删除后更新分页 |
| 导入 | POST `/questions/import` | `{questions:[QuestionInput]}` |
| 日志 | GET `/logs?limit=100` | 最近元数据，不含正文 |

```ts
interface ModelConfig {
  protocol: 'openai-chat' | 'openai-response';
  baseUrl: string;
  modelId: string;
  apiKey: string; // 读取时为 ***；空字符串清除
}
interface Settings {
  enabled: boolean;
  aiEnabled: boolean;
  autoCache: boolean;
  sameQuestionCheck: boolean;
  timeoutSeconds: number; // 5–55，默认 50
  retryCount: number; // 0–2，默认 1
  model: ModelConfig;
}
interface QuestionInput {
  question: string;
  options?: string | null;
  answer: string;
  questionType?: string | null;
  folderId?: number;
  isAi?: boolean;
  isPendingCorrection?: boolean;
}
```

题目返回另有 `id/createdAt`。保存时显式组装 `QuestionInput`，不要把 `id/createdAt` 或表单内部字段直接提交给服务端。所有字段上限按 UTF-8 字节验证，不能用字符数代替字节数；中文按实际编码长度计算。SQLite 返回的 `YYYY-MM-DD HH:mm:ss` 时间按 UTC 解析后再转换为用户本地时间，不直接当作浏览器本地时区。

## 3. 服务状态与设置

进入页面先读取状态。页面可见时每 10 秒刷新；离开页面取消请求与计时器。读取失败保留上次状态并标记更新时间，不展示为正常运行。

状态处理：

- `configured:false`：显示尚未接入；说明需由部署配置启用，禁止提交设置和调用无效地址。
- `QUESTION_BANK_UNAVAILABLE`：显示连接失败，允许手动重试；不影响浏览器实例控制。
- `available:true, enabled:false`：服务在线但查询暂停；管理功能继续可用。
- `available:true, enabled:true`：显示查询可用、AI 是否开启、题目和客户端数量、并发及预算。

“启用查询／暂停查询”调用 PATCH `{enabled}`。操作期间禁用重复提交；失败恢复实际状态。此操作不停止容器；页面不提供尚未实现的进程启动、停止或重启按钮。

设置表单字段：AI 开关、自动缓存、同题判断、总超时、重试次数、协议、Base URL、模型 ID、API Key。读取 API Key 为 `***` 时表示已有值，用户未编辑则不提交该字段；明确清除时提交空字符串。保存成功采用返回的脱敏设置重建草稿，清除明文 Key。

Base URL 提示填写供应商的协议基础路径，例如带 `/v1` 的地址；保存前验证 HTTP(S)、无内嵌账号、查询参数或片段。开启 AI 必须有地址和模型 ID；不自动指定收费模型或连接远程模型目录。

草稿脏状态下提示尚未保存，刷新状态不覆盖草稿。每次只提交变更字段；失败保留草稿用于修正。禁止将 API Key 写入 URL、控制台日志、事件、localStorage、sessionStorage 或错误上报正文。

## 4. 题目与文件夹

题目列表支持文件夹筛选、题干搜索、分页、详情、新建、编辑和删除。搜索输入可防抖，切换查询条件回到第一页；取消旧请求，保证较早响应不会覆盖较新结果。每页最多 100 条。

新建与编辑包含题干、选项、答案、题型、文件夹、AI 来源标记、待修正标记。编辑保存使用完整 PUT；保留用户未改的字段。记录标记为待修正后不再参与查询，修改答案后由用户决定是否清除此标记。

题干与答案在管理页按文本展示，不使用未经净化的 `v-html`。详情中的多选、填空答案保留 `###` 原文，不擅自转换为选项字母。

文件夹支持新建、重命名、移动和删除空文件夹。禁止选择自身或后代作为父文件夹；默认文件夹 0 不可重命名、移动或删除。数量是直接包含的题目数，不代表整个子树数量。收到 `FOLDER_NOT_EMPTY` 时说明先移动或删除内容，不发起隐式级联删除。

删除题目或文件夹应先展示明确对象的确认；保存／删除期间避免重复操作。删除最后一页最后一条后回退到有效页。404 提示记录已不存在并刷新列表。

## 5. JSON 导入

文件在浏览器读取，不向服务端提交本地路径。接受规范的 `{questions:[...]}` JSON，使用与表单相同的字段校验。第一版不宣称兼容桌面文档、Excel、PDF 或任意 ZError 导出格式；旧 SQLite 的迁移由部署文档处理。

导入流程：选择文件 → 本地解析与校验 → 展示记录数量、目标文件夹及错误行 → 用户提交 → 显示每批 `inserted/skipped` 和汇总。

每批最多 500 条，同时编码后不超过 1 MiB，含 JSON 包装与转义开销。任一记录错误整批回滚；多批导入之间没有跨批事务。某批失败后停止后续批次，显示已成功批次与失败批次，允许从失败批重试，不宣称整份文件已全部回滚。

服务端跳过题干、选项、答案完全一致的记录；导入汇总区分新增、跳过和失败。导入期间禁用重复提交，离开页面时说明已完成批次不会自动撤销。

## 6. 客户端接入

每个浏览器或用户创建独立客户端，输入名称和可达的主服务 Base URL。默认建议当前控制台的 `location.origin`，允许用户根据访问位置修改。

说明调用位置：

- 外部客户端使用其能访问的 HTTPS 地址。
- 本项目受管浏览器可使用主容器内部 `http://127.0.0.1:15319`；主机映射端口不等于容器内部端口。
- 其他容器中的 `localhost` 不会指向本服务。

点击“生成配置”才 POST `/connections`。创建成功展示 `wrapper` JSON 及复制操作，说明导入 OCS 的“自定义题库”；用户脚本源码无需修改。配置内含查询令牌，按凭据处理。

完整令牌只保留在该次操作的内存状态。允许用户复制、重新显示本次结果；页面离开后清除。再次进入只展示名称、前缀、创建和最近使用时间，不能提供“找回旧令牌”。丢失时新建并撤销旧客户端。

撤销前确认客户端名称；成功后说明后续查询失效，已经接纳的请求可能完成。查询令牌只能搜题，不能管理实例、题目、模型或其他客户端。

本期不自动覆盖用户已有题库或 `settings.ocs`；若以后增加同步，需要明确所用 OCS 版本的存储键，并在提交前展示合并结果。不要把生成 wrapper 等同于已安装或已同步成功。

## 7. 查询验证

输入题干、选项、题型以及一个查询令牌，POST 到与 OCS 相同的 `/question-bank/query`。新生成连接配置可以在内存中带入令牌；页面重进后需用户输入或显式新建测试客户端。查询结果显示答案、AI 标记、记录 ID、耗时或错误码。

查询请求使用独立 fetch 封装，不沿用会自动附加管理令牌的客户端。查询 401 仅表示查询令牌无效，不触发管理员退出登录；管理 API 的 401 按现有登录行为处理。

按钮加载态持续到结果、取消或超时；取消仅停止页面等待，已接纳任务仍受服务端预算约束，不承诺撤销已发生的模型调用。重复点击不创建重复请求。

按错误区分操作：未命中提示本地无记录／AI 关闭；429 展示限制及等待后重试；503 区分暂停、未配置、连接失败；502 提示检查供应商设置且不显示原始供应商错误；504 提示预算耗尽。不要把失败当成空答案成功。

验证成功只证明该请求和所用令牌成功，不表示所有平台、图片题或题型都已验证。无正文日志意味着页面离开后不能从日志重新打开题目或答案。

## 8. 请求日志

读取 `/logs?limit=100`，展示时间、请求 ID、客户端 ID、状态、耗时、来源和错误码。可以手动刷新；页面可见时随状态轮询刷新，禁止在离开页面后继续轮询。

`source:ai-or-cache` 仅表示记录带 AI 来源标记，不能据此断言此次请求发生了收费调用。`local` 为非 AI 来源，`error` 为失败。日志最多 1000 条，单次最多 200 条；无历史分页或正文检索能力，不添加虚假筛选入口。

界面不得期待或要求后端返回 API Key、Bearer 请求头、题目正文、答案或供应商原始错误。

## 9. 验收顺序

1. 未接入、连接失败、在线、暂停四种状态可识别；原有实例页面仍正常。
2. 配置模型，保存后明文 Key 消失；`***` 保留、显式清除、关闭 AI 均符合接口契约。
3. 添加本地题，生成 OCS 配置，使用独立令牌查到正确答案；管理令牌不被发送到查询入口。
4. 在未打开 ZError 桌面应用、离开管理页的条件下，外部查询仍能执行 AI 并缓存。
5. 令牌只在创建时显示；列表无原文；撤销后查询 401，管理员登录不受影响。
6. 题目编辑、待修正、筛选、分页及默认文件夹保护均正确；异步乱序不覆盖新状态。
7. 无效导入整批回滚，多批失败展示真实的部分成功；没有隐式文件路径访问。
8. 限流、超时、供应商错误、服务故障有可区分反馈，不丢失未保存草稿。
9. 刷新、离开页面和退出登录清理敏感内存、请求与计时器；日志和浏览器存储中没有模型 Key、查询令牌或管理令牌的新增副本。

端到端测试沿用本项目真实浏览器框架；后端 fixture 可参考 `packages/server/tests/question-bank.e2e.cjs`。除测试自己的临时数据外，不使用真实付费供应商或修改已有用户数据。
