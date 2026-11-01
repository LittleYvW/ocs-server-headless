# 独立题库服务

本项目通过独立 Rust 服务提供兼容 OCS 自定义题库的查询接口。服务从 ZError 提取检索、SQLite 迁移和答案规范化能力，文本 AI 调用由服务端直接执行，不需要桌面、Tauri、WebView 或保持控制台打开。

控制台“题库服务”页面（`#/question-bank`）提供设置、题目、文件夹、导入、客户端接入、查询验证与请求日志；行为与验收见 [题库服务前端执行文档](question-bank-frontend-plan.md)，管理 API 仍可单独使用。无需修改 OCS 用户脚本源码。

## 运行范围

- 精确题目及选项匹配；模糊候选可交给 AI 判断是否为同题。
- 单模型文本答题，支持兼容 OpenAI Chat Completions 或 Responses 的 HTTP 协议。
- AI 答案规范化及可选 SQLite 自动缓存；被标记为待修正的记录不参与查询。
- 文件夹、题目管理、分页检索、JSON 批量导入。
- 每客户端独立查询令牌、限流、并发控制和相同在途请求合并。
- 独立加密的模型配置；元数据日志不保存题目、答案、请求头或供应商原始错误。

第一版不提供图片解码、URL 页面抓取、视觉模型、多模型汇总、桌面文档导入或自定义 JS 模型协议。查询不会下载题目中出现的 URL。OCS 的图片优化字段不属于当前接口契约；使用文本题配置。

本项目不附带现成题目资源。题目可以导入、手动添加，或在启用 AI 后逐步缓存。

## Compose 部署

仓库根目录执行 `bash deploy/install.sh`，同时从源码构建并启动 `ocs` 和 `zerror`。题库默认启用本地查询，AI 默认关闭；首次需通过管理 API 配置模型并创建查询令牌。

`zerror` 仅在 Compose 网络监听 `3002`，不向宿主发布端口。外部客户端通过已有 OCS 入口的 `/question-bank/query` 访问。原生服务和管理 API 令牌均不交给 OCS 用户脚本。

| 卷 | 内容 |
| --- | --- |
| `ocs-server-headless_ocs-data` | 原有配置、浏览器和主服务令牌 |
| `ocs-server-headless_zerror-data` | `airesponses.db`、加密模型配置、配置密钥、SQLite WAL、目录锁 |
| `ocs-server-headless_zerror-credentials` | 内部管理令牌；OCS 容器只读挂载 |

`ZERROR_MAX_CONCURRENT` 控制题库全局并发，默认 8，范围 1–64，独立于 `OCS_MAX_BROWSERS`。每查询令牌最多 2 个并发请求、每分钟最多 60 次。超限立即返回 `429`，不排入无限队列。数据库阻塞操作另有并发上限。

题库故障后，已运行的 OCS 主服务及浏览器继续运行；题库接口返回 `503`。`/healthz` 仍只检查 OCS HTTP 进程；题库状态通过管理 API 单独读取。Compose 首次启动会等待题库健康。

## 原生开发和部署

需要 Rust 稳定工具链、C 编译工具和本项目已有的 Node.js 环境。Windows 开发与现有后端一样在 WSL 中运行。Rust 编译自带 SQLite，不需要运行时安装数据库服务。

```bash
cargo build --release --locked --manifest-path services/zerror/Cargo.toml
ZERROR_DATA_DIR="$PWD/data/zerror" \
  services/zerror/target/release/zerror-headless
```

默认监听 `127.0.0.1:3002`。另一个终端启动主服务：

```bash
OCS_DATA_DIR="$PWD/data/ocs" \
OCS_QUESTION_BANK_URL=http://127.0.0.1:3002 \
OCS_QUESTION_BANK_TOKEN_FILE="$PWD/data/zerror/admin.token" \
  pnpm start
```

先按本项目原有流程构建后端和控制台。主服务不设置这两个题库变量时，可以独立运行；`GET /api/v1/question-bank/status` 返回 `configured:false, available:false`。

| 环境变量 | 默认值／说明 |
| --- | --- |
| `ZERROR_HOST` | `127.0.0.1`；Compose 固定 `0.0.0.0` |
| `ZERROR_PORT` | `3002` |
| `ZERROR_DATA_DIR` | 当前目录下 `data`；部署应使用绝对路径 |
| `ZERROR_ADMIN_TOKEN_FILE` | 数据目录内 `admin.token`；Compose 使用共享凭据卷 |
| `ZERROR_MAX_CONCURRENT` | `8` |
| `OCS_QUESTION_BANK_URL` | 主服务连接的固定题库 HTTP Origin |
| `OCS_QUESTION_BANK_TOKEN_FILE` | 主服务可读的内部令牌绝对路径 |

环境变量不会自动从 `.env` 加载。监听、文件路径和上游服务地址只能由部署配置指定，不能通过管理 API 修改。

## 管理 API

以下接口都位于 `/api/v1/question-bank`，使用本项目现有管理 Bearer 令牌和 Origin 规则。成功返回 `{data:...}`，默认 HTTP 200；创建连接配置返回 201；删除返回 `{data:null}`。错误有 `error.code/message`，可能同时附带 OCS 兼容字段 `code:0,data:null,message`。

| 方法 | 相对路径 | 请求／结果 |
| --- | --- | --- |
| GET | `/status` | 配置、可用性、查询开关、AI 开关、数量、容量和能力 |
| GET | `/settings` | 脱敏设置 |
| PATCH | `/settings` | 按字段合并设置；`model` 内也按字段合并 |
| GET | `/tokens` | 令牌元数据，不含原文或哈希 |
| POST | `/tokens` | `{name}`；原文 `token` 仅返回此次 |
| DELETE | `/tokens/:id` | 撤销查询令牌，后续请求立即失效 |
| POST | `/connections` | `{name,baseUrl}`；创建查询令牌并返回可直接导入的 `wrapper` 数组 |
| GET | `/folders` | 文件夹及直接包含的题目数量 |
| POST | `/folders` | `{name,parentId?:0}` |
| PUT | `/folders/:id` | `{name,parentId?:0}`；禁止循环引用 |
| DELETE | `/folders/:id` | 仅删除空文件夹；默认文件夹 0 不可删除 |
| GET | `/questions` | `page=1&limit=20&folderId=0&q=文本`；`folderId/q` 可省略 |
| GET | `/questions/:id` | 单条题目 |
| POST | `/questions` | 新建完整题目对象 |
| PUT | `/questions/:id` | 完整替换题目可编辑字段 |
| DELETE | `/questions/:id` | 删除题目 |
| POST | `/questions/import` | `{questions:[...]}`；单批 1–500 条，事务导入 |
| GET | `/logs` | `limit=100`，范围 1–200；最多保留最近 1000 条元数据 |

查询和管理接口均不接受 URL 中的令牌。查询令牌不能调用管理 API，内部管理令牌不能调用查询接口。

### 模型设置

```json
{
  "enabled": true,
  "aiEnabled": true,
  "autoCache": true,
  "sameQuestionCheck": true,
  "timeoutSeconds": 50,
  "retryCount": 1,
  "model": {
    "protocol": "openai-chat",
    "baseUrl": "https://provider.example/v1",
    "modelId": "your-model-id",
    "apiKey": "your-provider-key"
  }
}
```

`protocol` 仅接受 `openai-chat`、`openai-response`，分别在 `baseUrl` 后追加 `/chat/completions`、`/responses`。不自动添加 `/v1`。地址不允许账号、密码、查询参数或片段；不会跟随重定向。自建无密钥供应商允许空 `apiKey`。

读取时非空 `apiKey` 返回 `***`；PATCH 中 `***` 保留原值，空字符串清除。关闭 AI 后仍能查询已有题库。`enabled:false` 暂停接纳新查询，已接纳任务按原预算完成，管理 API 保持可用。未知字段（包括 `jsCode`）会被拒绝。

`timeoutSeconds` 默认 50，范围 5–55，覆盖查库、同题判断、请求、重试的总时间；同题判断最多使用其中 10 秒。`retryCount` 默认 1，范围 0–2，仅对瞬时网络、超时、限流及供应商错误尝试重试，全部受总预算约束。供应商必须返回包含有效 `answer` 的模型文本；失败或非结构化内容不入库。

兼容协议参考：[Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Responses 格式](https://developers.openai.com/api/docs/guides/migrate-to-responses)。服务不预选模型，不自动连接 ZError 的远程模型目录。

### 题目对象

```json
{
  "question": "中国首都是哪里",
  "options": "A. 北京\nB. 上海",
  "answer": "北京",
  "questionType": "single",
  "folderId": 0,
  "isAi": false,
  "isPendingCorrection": false
}
```

`question/answer` 必填且非空；其他字段可省略，默认空选项、空题型、文件夹 0、非 AI、无需修正。长度上限按 UTF-8 字节计算：题干 16000、选项 24000、答案 24000、题型 100。列表每页 1–100 条，返回 `{items,total,page,limit}`；条目另含 `id/createdAt`。

导入不接收文件路径、SQL 或数据库文件。单次 JSON 请求最多 1 MiB；任一记录无效则整批回滚。题干、选项和答案完全相同的已有记录会跳过，返回 `{inserted,skipped}`。大文件应拆批。

### 客户端连接配置

管理员请求：

```http
POST /api/v1/question-bank/connections
Authorization: Bearer <本项目管理令牌>
Content-Type: application/json

{"name":"我的外部浏览器","baseUrl":"https://ocs.example.com"}
```

返回的 `data.wrapper` 是 OCS 自定义题库数组，已经带有独立查询令牌和响应处理器。将此数组导入 OCS 的题库配置即可。`client.token` 和 wrapper 中的令牌仅在创建响应中出现，列表不能重新取回；丢失后新建并撤销旧令牌。

- 外部客户端：`baseUrl` 填该客户端可访问的 HTTPS 地址。
- 本项目受管浏览器：容器内可使用 `http://127.0.0.1:15319`，这里是容器内部端口；也可使用其可达的公开 HTTPS 地址。
- 不同容器访问使用 Compose 服务地址或主服务入口，不能把其他容器误认为 `localhost`。
- 脚本管理器必须允许请求服务域名；可在其域名权限或已有 OCS 版本允许的 `@connect` 范围内配置。

当前只生成题库配置，不自动覆盖 `settings.ocs` 或客户端现有题库。已有配置同步通道继续可用，具体存储键需按所用 OCS 版本配置。

## 查询协议

公开路径为 `GET/POST /question-bank/query`，只接受查询 Bearer 令牌。POST 使用 JSON：

```json
{"title":"中国首都是哪里","options":"A. 北京\nB. 上海","type":"single"}
```

成功 HTTP 200：

```json
{"code":1,"data":{"id":1,"question":"中国首都是哪里","answer":"北京","is_ai":false,"is_pending_correction":false}}
```

`data` 为对象。题干按 HTML 文本转义，不注入桌面版的内联修正按钮；答案仍是用于匹配的正文，多选和填空按 `###` 分隔。失败返回 `code:0,data:null,message,error` 和相应 HTTP 状态：

| HTTP／错误码 | 含义 |
| --- | --- |
| 400 `INVALID_INPUT` | 字段、长度、类型不符合契约 |
| 401 `UNAUTHORIZED` | 查询令牌缺失、错误或已撤销 |
| 404 `NO_MATCH` | 本地未命中且未开启 AI |
| 413 `BODY_TOO_LARGE` | 查询请求超过 64 KiB |
| 422 `TEXT_ONLY` | 当前路径不支持的图片内容 |
| 429 `QUERY_LIMIT` | 查询并发或频率超限，带 `Retry-After:60` |
| 502 `INVALID_MODEL_RESPONSE` / `PROVIDER_*` | 模型格式、认证或供应商调用失败 |
| 503 `QUESTION_BANK_DISABLED` / `QUESTION_BANK_UNAVAILABLE` | 主服务未接入题库或无法连接 |
| 503 `SERVICE_PAUSED` / `STORAGE_BUSY` | 查询暂停或存储容量繁忙 |
| 504 `PROVIDER_TIMEOUT` | 查询总时间预算耗尽 |

查询 CORS 允许携带 Authorization 的跨域调用，不依赖 Cookie。管理接口继续使用严格 Origin 校验。反向代理需转发 `/question-bank/` 和 `/api/v1/question-bank/`，查询响应等待时间应大于 58 秒；无需修改 OCS 用户脚本。

相同题干、选项、题型和设置的同时请求合并执行。客户端断开后，已接纳的任务仍受同一个总预算与并发许可约束并清理；不会因关闭控制台而丢失执行器。撤销令牌阻止后续请求，不中断已经接纳的请求。

## 持久化、迁移与备份

`airesponses.db` 沿用 ZError 的 `Folders/AIResponses` 表结构，并增加本服务的 `HeadlessTokens/HeadlessLogs` 表。配置独立存储在 AES-256-GCM 加密的 `settings.enc`，密钥为 `settings.key`。缺失密钥、解密失败或配置损坏会阻止启动，不静默重置。

SQLite 题目、查询令牌哈希和日志元数据不属于配置加密范围。数据目录默认 0700，敏感文件默认 0600；使用完整备份保护数据。令牌仅存 SHA-256 哈希及展示前缀。

迁移桌面题库：先停止桌面 ZError，复制其完整、已停止写入的 `airesponses.db` 备份；停止本项目题库服务，把备份放到题库数据目录，再启动，自动补齐兼容字段。不要在运行中覆盖 SQLite 文件，不复用桌面模型配置、桌面账号或请求日志作为本服务鉴权。替换整个数据库也会替换本服务的查询令牌和日志；已使用的服务应优先做 JSON 导入，或迁移后重新为客户端生成配置。

在 `deploy/` 停止服务后备份三个目录：

```bash
docker compose stop
backup="./backup-$(date +%Y%m%d-%H%M%S)"
mkdir "$backup"
docker compose cp ocs:/data "$backup/ocs"
docker compose cp zerror:/data "$backup/zerror"
docker compose cp zerror:/credentials "$backup/zerror-credentials"
docker compose start
```

本项目原有 `.ocsdata` 导出不包含独立题库数据。恢复时保留对应 `settings.enc/settings.key`、SQLite 数据和内部令牌；非正常停机的备份还需保留对应 WAL 文件。目录锁文件不要在服务运行时删除。

检索目前仍基于上游中文分词和相似度扫描，候选内存最多保留 5 条，并受查询截止时间约束。未对大规模题库承诺吞吐；大题库部署应先压测，再考虑索引化检索。

## 验证

```bash
cargo fmt --manifest-path services/zerror/Cargo.toml --check
pnpm test:question-bank
```

该命令验证 Rust 单元测试，并启动真实 Rust 服务、主服务网关和本地模拟模型供应商，覆盖令牌隔离、OCS 协议、题库维护、AI 调用、超时、缓存、加密和重启。不会使用真实 API Key 或消耗模型额度。

镜像构建后：

```bash
docker build --tag ocs-server-headless:local .
docker build --file services/zerror/Dockerfile --tag ocs-zerror-headless:local .
bash scripts/test-question-bank-container.sh
```

容器检查使用独立临时 Compose 项目，验证健康、共享凭据权限、查询、撤销和持久化；完成后只删除测试项目的容器及卷。离线包包含两个镜像，见 [离线部署](offline-deployment.md)。
