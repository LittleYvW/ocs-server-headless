# @ocs-server/web-ui

OCS 无头浏览器 Web 控制台。Vue 3 + Vite + TypeScript，无 UI 组件库与外部字体依赖。

```bash
pnpm dev            # Vite 开发服务器，/api 代理到 127.0.0.1:15319
pnpm build          # 类型检查并输出到 packages/server/web
pnpm typecheck      # vue-tsc
pnpm test:e2e       # 真实浏览器端到端检查（需先构建前后端）
```

设计语言、认证、SSE、CSP、部署与测试说明见 [docs/web-ui.md](../../docs/web-ui.md)。
