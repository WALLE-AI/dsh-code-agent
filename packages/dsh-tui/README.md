# DeepSeek Harness TUI

键盘优先的终端 profile，独立位于本仓库 `packages/dsh-tui`，不修改
`opensource/deepseek-harness` 或 `opensource/cordis`。用户文档见
[`docs/tui-user-guide.md`](../../docs/tui-user-guide.md)，验证记录见
[`docs/phase-0-compatibility-matrix.md`](../../docs/phase-0-compatibility-matrix.md)。

## 边界

- `src/harness-adapter.ts` 是唯一允许接触上游的模块：它优先 import 已安装的
  `@deepseek-ai/dsh-*` 包，开发环境回退到固定的源码 checkout，并把 Agent、
  SessionEvent、approval waterfall、commands、questions 与 tool presentation
  归一为 TUI 自有 contract。
- 其余模块（projection、store、卡片、布局、shutdown、诊断）不引用上游类型；
  非 `.tsx` 模块也不引用 React/Ink。`tests/isolation.spec.ts` 扫描全部源码强制这两条。
- `cordis.patch.yml` 是外置 bundle overlay，并显式补齐 `read-only` permission
  preset；Agent loop、工具、策略、sandbox 与持久化仍归 Harness 所有。
- `upstream-compat.json` 固定已验证 commit 与工具链；上游更新先跑
  `npm run check:release`，失败时保留旧基线。

## 模块

| 模块 | 职责 |
|---|---|
| `startup.ts` | argv 解析与校验（进入 raw mode 前失败） |
| `plugin.ts` | 组合、生命周期、受控关闭、诊断日志 |
| `harness-adapter.ts` | 唯一上游耦合点，含 session 列表与运行请求 |
| `agent-controller.ts` | 上游中立的 handle 所有权与操作 |
| `conversation-projection.ts` | seq gate + 幂等折叠（id 索引，无线性扫描） |
| `transcript-view.ts` / `tool-card.ts` / `diff-view.ts` | 卡片与折叠策略 |
| `terminal-text.ts` / `terminal-capabilities.ts` / `terminal-layout.ts` | 终端安全、能力探测与行预算 |
| `activity.ts` | 状态行投影（权限、todo、token、子 Agent） |
| `session-selector.ts` | 恢复候选与选择解析 |
| `shutdown.ts` / `diagnostic-log.ts` | 有界关闭与脱敏诊断 |
| `app.tsx` / `render-boundary.tsx` | Ink 渲染与区域级错误边界 |

## 开发命令

```bash
pnpm install
pnpm run check:release       # 完整发布门禁（下列全部）
pnpm run check:release -- --fast

pnpm run check:upstream      # 上游 tuple 与服务契约
pnpm build                   # 严格 TypeScript
pnpm test                    # 单元 / 投影 / 边界 / 故障注入
pnpm run check:profile       # 真实 Harness profile 组合
pnpm run check:interactive   # 80x24 审批 / 160x50 resize / 80x12 提问 / Unicode 粘贴
pnpm run check:resume        # 新建 -> 退出 -> --resume latest -> 续跑
pnpm run check:bench         # 性能预算
pnpm run check:packed        # 打包产物离树安装
pnpm run check:soak:quick    # 10 秒耐久；pnpm run check:soak 为 30 分钟
pnpm run check:node22        # Node 22 运行时矩阵
pnpm run check:real              # 真实 DeepSeek API 一次性任务（密钥取自环境或 .env）
pnpm run check:real:interactive  # 真实模型 + 真实工具 + follow-up + /quit
pnpm run check:real:approval     # read-only 预设下的真实升权与审批决策
pnpm run build:lib           # 生成发布用 lib/

pnpm tui -- "检查当前改动并运行测试"
pnpm tui -- --interactive --alternate-screen "修复登录竞态"
pnpm tui -- --interactive --resume latest
pnpm tui -- --permission read-only "review current changes"
```

开发链路通过 `--conditions=development` 让 profile 解析 `src/*.ts`；打包产物默认
解析编译后的 `lib/*.js`。

## 当前限制

- `Ctrl+E` 以 detached 进程打开编辑器，适合 GUI/远程编辑器；需要接管 TTY 的终端
  编辑器不在 P0 范围。
- SSH/tmux 已探测并降级，但人工环境矩阵尚未执行；Linux/macOS 的 PTY 套件未在本
  环境运行。
- 无鼠标、图像协议、PTY 面板、右侧 activity 面板与会话全文搜索（P1）。
- 内置 profile 注册需上游 `PROFILE_TEMPLATES` 配合；本仓库按 ADR 0001 只用外置 bundle。
