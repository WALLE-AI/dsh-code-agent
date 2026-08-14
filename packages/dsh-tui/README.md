# DeepSeek Harness TUI

阶段 0 的轻量终端工程，独立位于本仓库 `packages/dsh-tui`，不会修改 `opensource/deepseek-harness` 或 `opensource/cordis`。

边界如下：

- `src/harness-adapter.ts` 是唯一允许导入 Harness 源码的文件，负责把 Agent、SessionEvent 和 approval waterfall 归一为 TUI 自有 contract。
- `src/state.ts`、`src/approval-queue.ts` 和 `src/app.tsx` 不依赖 Harness/Cordis 内部类型。
- `cordis.patch.yml` 是外置 bundle overlay；Harness 仍拥有 Agent loop、工具、安全策略、sandbox 和持久化。
- `upstream-compat.json` 固定已验证 commit 和工具链。上游更新先跑兼容门禁，失败时保留旧基线，不要求 TUI 跟随更新。

开发命令：

```bash
pnpm install
pnpm check
pnpm run check:interactive
pnpm tui -- "检查当前改动并运行测试"
```

`pnpm tui` 会在 `$DSH_HOME/profiles/tui` 创建本地开发 profile，并将本目录的 bundle 以符号链接挂载进去。当前阶段要求 stdin/stdout 都是 TTY；重定向场景会失败并提示使用 headless profile。

`check:interactive` 使用确定性 mock LLM 和真实 PTY 验证任务、Bash 一次性审批、流式输出、flush/dispose 与正常退出。它要求上游 Harness checkout 已安装依赖并构建其 host 运行产物。

## 阶段 0 限制

当前只支持启动时提交一个任务、流式事件行、一次性审批和 `Ctrl+C` 取消。会话恢复、composer、命令面板、问题 provider、工具卡片与 seed/live parity 属于后续阶段。
