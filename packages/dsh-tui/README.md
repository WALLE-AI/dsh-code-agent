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
pnpm run check:soak:quick
pnpm run check:soak
pnpm run check:node22
pnpm tui -- "检查当前改动并运行测试"
pnpm tui -- --interactive "检查当前改动并运行测试"
pnpm tui -- --interactive --alternate-screen --no-color "检查当前改动并运行测试"
```

`pnpm tui` 会在 `$DSH_HOME/profiles/tui` 创建本地开发 profile，并将本目录的 bundle 以符号链接挂载进去。当前阶段要求 stdin/stdout 都是 TTY；重定向场景会失败并提示使用 headless profile。

`--interactive` 会在首任务完成后保留同一个 Agent，会话中可继续输入 follow-up 或 Harness slash command。输入 `/` 可发现当前 Agent 的命令，`/help` 显示目录，`/quit` 退出；PageUp/PageDown 控制 transcript 并在离底时显示未读数。Question modal 支持逐题单选、多选和自由文本。`--alternate-screen` 使用备用屏幕，`--no-color` 关闭语义颜色。`check:interactive` 在 80x24 与 160x50 下验证审批链路、动态 resize 与屏幕恢复，并在 80x12 下通过官方 `ask_user_question` 验证低高度、无色结构化回答链路。

`check:soak` 默认运行 30 分钟单 Agent 会话，连续发送 follow-up，并在 80x24、160x50、80x12 间轮换；每轮有独立超时，测试驱动仅保留 128 KiB 输出尾部，退出时验证 alternate-screen 恢复。当前基线已实跑 30 分钟并完成 352 次 follow-up/resize。`check:soak:quick` 使用相同状态机运行 10 秒，已纳入常规 `check`。

`check:node22` 使用临时 Node.js v22.23.2 执行严格 TypeScript、55 项测试、profile、三组真实 ConPTY 和 quick soak；runtime matrix 的所有子进程均继承同一个 Node 22 可执行文件，不会切回系统 Node。

## 阶段 0 限制

当前已支持一次性任务及 opt-in 单会话 composer。runtime 已具备真实 Session projection、8 类原始 fixture 的 seed/live 等价、Web Code Mode 关键 parity、Commands/root Question/tool presentation adapter、viewport/未读、命令发现、完整 Question 编辑、动态 resize、低至 8 行的预算降级、30 分钟耐久门禁、Node 22/24、备用屏幕恢复和无色模式。会话选择/恢复和完整工具卡片仍属于后续阶段；手工 Unicode/IME、SSH/tmux 环境矩阵仍待完成。
