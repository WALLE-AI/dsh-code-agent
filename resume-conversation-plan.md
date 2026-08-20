# DSH Code Agent 会话恢复执行方案

## 实施状态（2026-08-20）

本方案的发布阻塞项已经实施并通过完整发布门禁：

- [x] `--resume` 无任务时自动进入交互模式，并增加 `-r`。
- [x] 增加 `--resume-select`，在会话就绪后自动打开当前工作区浏览器。
- [x] `/quit` 持久化成功后输出 Session ID 和可直接执行的恢复命令。
- [x] 持久化失败时不输出成功凭据，并保留退出码 `74`。
- [x] `latest`、`/sessions`、进程内 `/resume` 和浏览器使用规范化当前工作目录。
- [x] 显式跨目录恢复返回原目录及安全恢复命令。
- [x] 排除 subagent 和当前活动会话，避免恢复选择漂移或恢复自身。
- [x] 更新 Bash、Fish、Zsh completion 和中英文 README。
- [x] PTY 冒烟验证第二进程仅使用 `--resume`，不再依赖 `-i`。
- [x] 严格类型检查、574 项测试、真实 profile、PTY 矩阵、恢复、取消、性能、打包和耐久门禁全部通过。

会话标题、全文预览、跨项目列表切换、重命名、删除、fork 和文件回滚仍受 Harness 公开 API 限制，继续保留为非阻塞后续能力；本次实现没有读取或修改 Harness 私有持久化格式。

## 1. 目标

完善 `dshcodecli` 在用户通过 `/quit` 正常退出后的会话恢复体验，使用户能够直接使用 `--resume` 恢复历史对话，并参考 `opensource/claude-code-main` 的交互设计，补齐会话发现、选择、跨工作目录保护、退出提示和测试覆盖。

目标命令：

```bash
# 恢复当前工作目录最近一次会话
dshcodecli --resume
dshcodecli --resume latest

# 使用完整 Session ID 或唯一前缀恢复
dshcodecli --resume <session-id-or-prefix>

# 可选短参数
dshcodecli -r <session-id-or-prefix>
```

`--resume` 是标准长参数写法，不支持非标准的 `-resume`。

## 2. 当前可用方式

当前版本已经支持恢复会话，但启动时仍需显式指定交互模式：

```bash
cd /path/to/project

dshcodecli -i --resume latest
dshcodecli -i --resume
dshcodecli -i --resume <session-id-or-prefix>
```

进入 TUI 后还可以使用：

```text
/sessions
/resume latest
/resume <session-id-or-prefix>
```

也可以按 `Ctrl+R` 打开会话选择器。

恢复时应保持使用原来的 `DSH_HOME`，并优先回到创建会话时的项目工作目录。

## 3. 现状分析

当前恢复链路已经基本打通：

- `packages/dsh-tui/src/startup.ts` 支持 `--resume [session]`，空参数转换为 `latest`。
- `packages/dsh-tui/src/plugin.ts` 处理 `/quit`，退出前停止输入、关闭未完成审批、等待任务停止并刷新会话。
- `packages/dsh-tui/src/harness-adapter.ts` 通过 Harness 官方 `agents.resume()` 恢复会话。
- `packages/dsh-tui/src/session-selector.ts` 支持 `latest`、完整 ID 和唯一 ID 前缀。
- `packages/dsh-tui/scripts/resume-smoke.ts` 已验证“创建会话、退出、新进程恢复、继续对话并保留上下文”的主流程。

当前主要不足：

1. `--resume` 没有自动进入交互模式，用户还需要输入 `-i`。
2. `/quit` 后没有显示 Session ID 和可直接执行的恢复命令。
3. `latest` 缺少严格的当前工作目录隔离，存在恢复到其他项目会话的风险。
4. 启动阶段没有完整的会话浏览和选择流程。
5. 会话标题、预览、加载状态和跨项目提示仍不完整。

## 4. 目标交互

用户正常退出时：

```text
> /quit

Session saved: 01JXYZ...
Resume: dshcodecli --resume 01JXYZ...
```

用户可以直接执行退出时显示的命令：

```bash
dshcodecli --resume 01JXYZ...
```

当 `--resume` 没有同时携带任务文本时，程序自动进入交互模式，不再要求 `-i`。

建议的参数语义：

| 命令 | 行为 |
| --- | --- |
| `dshcodecli --resume` | 恢复当前工作目录最近的顶层会话并进入 TUI |
| `dshcodecli --resume latest` | 与无参数 `--resume` 相同 |
| `dshcodecli --resume <id>` | 按完整 ID 或唯一前缀恢复 |
| `dshcodecli -r <id>` | `--resume` 的短参数形式 |
| `dshcodecli --resume-select` | 启动会话选择器 |

## 5. 分阶段执行方案

### M1：修正启动参数和交互模式

涉及文件：

- `packages/dsh-tui/src/startup.ts`
- CLI 参数解析测试和帮助文本
- Shell completion 文件

执行内容：

1. 当存在 `--resume`、不存在任务文本时，将启动模式自动设为 interactive。
2. 保留空值 `--resume` 等价于 `--resume latest` 的现有行为，避免兼容性破坏。
3. 增加 `-r, --resume [session]` 标准短参数。
4. 明确拒绝或正常报告 `-resume`，避免被解析成组合短参数。
5. 更新 `--help`、错误信息和命令补全。

验收结果：

```bash
dshcodecli --resume
dshcodecli --resume latest
dshcodecli --resume <id>
```

以上命令都能直接进入恢复后的 TUI。

### M2：为 `/quit` 输出可靠的恢复凭据

涉及文件：

- `packages/dsh-tui/src/plugin.ts`
- `packages/dsh-tui/src/agent-controller.ts`
- `packages/dsh-tui/src/state.ts`
- 关闭流程相关测试

执行内容：

1. 在运行时状态中保存当前活动 Session ID。
2. `/new` 或进程内 `/resume` 切换会话时同步更新活动 ID。
3. `/quit` 按现有顺序停止输入、处理审批、取消任务、等待空闲并刷新会话。
4. 只有会话刷新成功后，才输出 `Session saved` 和准确的恢复命令。
5. 在 TUI 屏幕恢复后输出退出凭据，确保内容留在终端滚动区域中。
6. 刷新失败时不宣称会话已经保存，保留退出码 `74` 并输出恢复风险说明。
7. 强制终止、崩溃等非正常退出不承诺能够输出恢复凭据。

### M3：实现工作目录安全隔离

涉及文件：

- `packages/dsh-tui/src/session-selector.ts`
- `packages/dsh-tui/src/harness-adapter.ts`
- `packages/dsh-tui/src/contracts.ts`

执行内容：

1. 将当前工作目录规范化，处理相对路径、符号链接和尾部斜杠。
2. `latest` 只从当前规范化工作目录的顶层会话中选择。
3. 继续排除包含 `delegationDepth` 或父会话标记的 subagent 会话。
4. 当前目录没有可恢复会话时明确报错，不自动恢复其他项目的最新会话。
5. 完整 ID 指向其他工作目录时，不自动切换目录或直接恢复。
6. 显示会话原始目录和建议执行的命令：

```bash
cd /original/project
dshcodecli --resume <session-id>
```

工作目录保护必须在 Harness 恢复之前完成，避免文件权限、信任状态和工具执行边界与原会话不一致。

### M4：增加启动会话选择器

涉及文件：

- `packages/dsh-tui/src/session-browser.ts`
- `packages/dsh-tui/src/view-model.ts`
- `packages/dsh-tui/src/views/screens.tsx`
- 键盘映射和浏览器状态测试

执行内容：

1. 复用现有 `Ctrl+R` 会话浏览器的状态模型和渲染组件。
2. 增加 `dshcodecli --resume-select` 启动入口。
3. 默认只展示当前项目会话，并提供“显示全部项目”的显式切换。
4. 支持按 Session ID 和工作目录搜索。
5. 使用 Session ID 维护光标，而不是列表索引，避免列表刷新后选中项漂移。
6. 增加加载、恢复和错误状态：

```text
Loading sessions...
Resuming session...
Unable to resume session: ...
```

7. 宽终端显示预览列，窄终端自动退化为单列列表。
8. 预览按选中项延迟加载，并通过取消信号停止过期请求。

建议显示的信息：

- Session ID 后缀
- 原工作目录
- 创建时间或更新时间
- 第一条用户消息或公开 API 提供的会话标题
- 持久化或活动状态
- 当前选中会话的只读内容预览

### M5：参考 Claude Code 的交互边界

参考文件：

- `opensource/claude-code-main/src/screens/ResumeConversation.tsx`
- `opensource/claude-code-main/src/components/LogSelector.tsx`

采用以下交互原则：

1. 优先快速加载当前项目的会话。
2. 其他项目必须由用户显式切换查看。
3. 加载和恢复过程需要有明确状态反馈。
4. 搜索结果应展示足够的上下文和内容摘要。
5. 跨项目恢复必须提示正确的工作目录，而不是静默恢复。

不直接复制 Claude Code 的内部存储、工作树恢复、文件回滚、成本恢复或 fork 实现。DSH TUI 必须继续通过 Harness 的公开查询服务和 `agents.resume()` 工作。

在 Harness 没有公开 API 之前，不实现：

- 直接解析或修改会话持久化文件
- 会话删除和重命名
- 真正的会话 fork
- 文件版本回滚
- Agentic 或深度全文搜索

### M6：文档、打包和发布验证

涉及内容：

- `README.md`
- `README_EN.md`
- 用户指南和变更日志
- npm 包帮助输出
- Shell completions

文档必须说明：

1. `/quit` 和强制终止的区别。
2. `--resume`、`latest`、Session ID 和唯一前缀的用法。
3. 必须使用相同 `DSH_HOME`。
4. 为什么建议回到原项目目录恢复。
5. 如何使用 `/sessions`、`/resume` 和 `Ctrl+R`。
6. 跨项目会话的安全限制。

## 6. 数据和接口调整

建议增加明确的恢复请求类型：

```ts
type ResumeRequest =
  | { kind: 'latest'; scope: 'workspace' }
  | { kind: 'id'; value: string }
  | { kind: 'picker'; scope: 'workspace' | 'all' };
```

会话摘要可以按 Harness 公开能力逐步扩展：

```ts
interface TuiSessionSummary {
  id: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  title?: string;
  preview?: string;
  workspaceMatch: boolean;
}
```

`updatedAt`、`title` 和 `preview` 只能在公开查询接口提供时填充，不从私有持久化格式推断。缺失字段时，界面应正常降级。

## 7. 测试计划

### 单元测试

- 无值 `--resume` 转换为 `latest`。
- 恢复参数没有任务时自动进入 interactive。
- 完整 ID、唯一前缀、冲突前缀和不存在的 ID。
- 无会话和只有 subagent 会话。
- 当前目录规范化与符号链接场景。
- 当前项目与其他项目的 `latest` 隔离。
- 跨工作目录的显式 ID 被阻止并返回建议命令。
- 会话列表顺序变化时选中 ID 保持稳定。

### 关闭持久化测试

- `/quit` 刷新成功后输出 Session ID 和恢复命令。
- 刷新失败时不输出成功提示并返回退出码 `74`。
- 有未完成审批或问题时按 fail-closed 处理。
- 活动任务取消超时时仍按规定顺序结束。
- `/new` 和进程内 `/resume` 后退出凭据指向新的活动会话。

### PTY 端到端测试

1. 启动 TUI 并发送第一条消息。
2. 输入 `/quit`。
3. 捕获终端输出中的恢复命令。
4. 新进程直接执行该命令。
5. 验证历史对话被加载。
6. 发送后续消息，验证模型请求包含退出前的上下文。
7. 再次 `/quit`，验证会话继续持久化。

附加场景：

- 其他工作目录有更新会话时，当前目录 `latest` 仍选择当前项目。
- 会话选择器的搜索、翻页、调整终端尺寸、ASCII 和无颜色模式。
- 损坏或不可读取会话的错误展示。
- npm 安装包中的 CLI 与源码运行行为一致。

## 8. 验收标准

以下行为全部满足后，方案才算执行完成：

1. `/quit` 正常退出后显示准确、可直接执行的恢复命令。
2. `dshcodecli --resume` 无需 `-i` 即可进入恢复后的 TUI。
3. `latest` 不会静默恢复其他项目的会话。
4. 完整 ID 和唯一前缀均能恢复，会话前缀冲突时给出明确错误。
5. `Ctrl+R` 和启动选择器均可选择并恢复会话。
6. 恢复后继续对话时包含退出前的模型上下文。
7. 持久化失败不会输出误导性的成功提示。
8. 源码测试和 npm 打包安装后的测试均通过。

建议执行的验收命令：

```bash
npm run check:resume
npm run check:interactive
npm run check:packed
npm run check:release
```

## 9. 推荐实施顺序

1. 先完成 M1，使 `--resume` 不再依赖 `-i`。
2. 完成 M2，让用户退出后立即获得准确恢复命令。
3. 完成 M3，消除跨项目误恢复风险。
4. 完成 M4，补充 Claude Code 风格的启动选择体验。
5. 完成 M5 和 M6，收紧能力边界并同步中英文文档、打包与发布检查。

M1 至 M3 是本功能的发布阻塞项；会话预览和增强元数据可以在 Harness 公开能力不足时作为后续增量交付。
