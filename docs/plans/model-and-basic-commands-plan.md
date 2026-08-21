# DSH Code Agent 模型切换与基础命令执行方案

## 1. 背景与目标

当前版本只能在启动时指定模型：

```bash
dshcodecli --model deepseek-official/deepseek-v4-flash
dshcodecli --model deepseek-official/deepseek-v4-flash:high
```

会话内还没有 `/model`。原因是 `packages/dsh-tui/src/harness-adapter.ts` 在创建 Agent 时安装模型选择，但没有向 TUI 暴露后续修改接口。

本方案的目标是：

1. 增加会话内 `/model` 命令和完整模型选择器。
2. 确保模型切换遵循 Harness 的请求组装、持久化和恢复语义。
3. 参考 `opensource/claude-code-main` 补充常用基础命令。
4. 保持 TUI 与 Harness 的职责边界，不复制 Agent loop、模型路由、权限或会话存储。

## 2. 目标交互

输入：

```text
/model
```

打开全屏模型选择器，按照 Provider 分组，显示当前模型、描述和 reasoning effort。

同时支持直接命令：

```text
/model info
/model deepseek-official/deepseek-v4-flash
/model deepseek-official/deepseek-v4-flash:high
/model default
/model save deepseek-official/deepseek-v4-flash
```

命令语义：

| 命令 | 行为 |
| --- | --- |
| `/model` | 打开模型选择器 |
| `/model info` | 显示当前模型、Provider 和 effort |
| `/model ROUTE` | 仅切换当前会话，从下一次模型请求生效 |
| `/model default` | 当前会话恢复全局默认模型 |
| `/model save ROUTE` | 切换并保存为未来会话的默认模型 |

模型正在响应时允许选择，但不能改变已经组装完成的当前请求，只对下一轮生效，并显示：

```text
Model set to deepseek-official/deepseek-v4-flash · applies next turn
```

## 3. 设计原则

1. 使用 Harness 公开的 `installModelSelection()`、`llm` 和 `agentDefaultModel` 服务。
2. 不重建 Agent，不创建新 Session 来完成普通模型切换。
3. 当前请求已经捕获的模型不被并发切换影响。
4. 普通 `/model` 只影响当前 Session；只有 `/model save` 修改未来会话默认值。
5. 模型目录是 advisory catalog，不能仅因模型没有出现在目录中就拒绝用户输入。
6. 命令事件和最终模型请求都应通过 Harness 正式路径持久化。
7. 不读取或修改 Harness 私有会话文件与设置文件。

## 4. M1：模型运行时接口

涉及文件：

- `packages/dsh-tui/src/harness-adapter.ts`
- `packages/dsh-tui/src/agent-controller.ts`
- `packages/dsh-tui/src/contracts.ts`
- 对应单元测试和 fake Harness

上游 `installModelSelection()` 接收可变的 `ModelSelectionRef`，已经支持逐轮安全切换。因此应保留安装时创建的 ref，并通过受控端口向 TUI 暴露模型能力。

建议接口：

```ts
interface TuiModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

interface ControlledAgentHandle {
  currentModel(): TuiModelSelection
  selectModel(selection: TuiModelSelection): void
  listModels(signal?: AbortSignal): Promise<TuiModelDirectory>
  saveDefaultModel(selection: TuiModelSelection): Promise<void>
}
```

`AgentController` 提供同名方法，并继续保证只有 active 状态才能调用。

实现要求：

1. 在 Agent context 中安装一个持续存活的 `ModelSelectionRef`。
2. `selectModel()` 只修改 `selectionRef.current`。
3. 当前步骤已经进入 prompt assembly 时，`assembled` 保持不变。
4. 下一步骤进入 prompt assembly 时捕获新的 `current`。
5. `currentModel()` 返回不可变副本，不能把 ref 暴露给 UI。
6. dispose 时继续由 Agent context 生命周期卸载 selection listeners。

## 5. M2：模型目录与验证

新增文件：

- `packages/dsh-tui/src/model-directory.ts`
- `packages/dsh-tui/tests/model-directory.spec.ts`

通过 Harness 公开 `llm` 服务获取模型信息：

- `llm.listProviders()`
- `llm.listModels(provider)`
- `llm.resolveModelInfo(provider, model)`

目录结构：

```ts
interface TuiModelOption {
  id: string
  name: string
  description?: string
  reasoning?: {
    efforts: readonly {
      id: string
      name: string
      description?: string
    }[]
    defaultEffort?: string
  }
}

interface TuiModelDirectory {
  current: TuiModelSelection
  providers: readonly {
    id: string
    name: string
    models: readonly TuiModelOption[]
  }[]
  failures: readonly {
    id: string
    name: string
    message: string
  }[]
}
```

加载规则：

1. Provider 并行加载。
2. 单个 Provider 失败不影响其他 Provider。
3. 空模型目录不构造虚假模型。
4. 搜索结果保留 Provider 分组信息。
5. `AbortController` 取消过期加载。
6. direct route 必须指向已注册 Provider。
7. 未列出的模型 ID仍可由已注册 Provider 接受，不用目录成员关系作为硬验证。
8. reasoning effort 必须来自 `resolveModelInfo()` 返回的公开选项；未声明 effort 时使用 Provider 默认行为。

## 6. M3：模型命令

新增文件：

- `packages/dsh-tui/src/model-command.ts`
- `packages/dsh-tui/tests/model-command.spec.ts`

解析以下输入：

```text
/model
/model info
/model default
/model save <route>
/model <provider>/<model>[:effort]
/model <model>[:effort]
```

当 Provider 省略时，沿用当前 Provider。

模型 route 解析应复用或提取 `startup.ts` 中已有的 `parseModelSelection()`，避免 CLI 与 slash command 对相同语法产生不同结果。

结果必须区分：

```ts
type ModelCommand =
  | { kind: 'picker' }
  | { kind: 'info' }
  | { kind: 'default' }
  | { kind: 'select'; selection: TuiModelSelection }
  | { kind: 'save'; selection: TuiModelSelection }
```

错误情况：

- route 为空或组件为空。
- 多个 Provider 分隔符。
- effort 为空或不受模型支持。
- Provider 未注册。
- `/model save` 缺少 route。
- 活动 Session 尚未挂载。

## 7. M4：命令持久化与恢复

`/model ROUTE` 应通过 Harness command execution 链记录为正式 command event，而不是只修改 React 状态。

建议实现一个 TUI model runtime：

1. 使用 `WeakMap<Agent, ModelSelectionRef>` 保存每个 Agent 的选择引用。
2. 在 Harness `commands` 服务中注册 `model` command descriptor。
3. command handler 根据 invocation 中的 Agent 找到对应 selection ref。
4. 成功切换后由 Harness 记录 command run/done 事件。
5. TUI 裸 `/model` 负责打开 picker；选中结果仍提交为 `/model ROUTE`。

恢复模型优先级：

```text
本次启动 --model
    > Session 最后一次成功持久化的 /model 选择
    > Session 最后一次模型请求的 provider/model/effort
    > agentDefaultModel.currentSelection()
```

这样即使用户执行 `/model` 后立即 `/quit`，没有再发送消息，恢复后也能保持所选模型。

`/model save` 除更新当前 Session 外，显式调用：

```ts
agentDefaultModel.saveSelection(selection)
```

普通 `/model` 绝不能隐式改变全局默认模型。

## 8. M5：模型选择界面

涉及文件：

- `packages/dsh-tui/src/model-picker.ts`
- `packages/dsh-tui/src/views/screens.tsx`
- `packages/dsh-tui/src/keymap.ts`
- `packages/dsh-tui/src/input-dispatch.ts`
- `packages/dsh-tui/src/app.tsx`
- `packages/dsh-tui/src/view-model.ts`
- 对应组件和键盘测试

参考 Claude Code 的 `ModelPicker`，但使用当前 Ink screen 架构实现。

界面要求：

1. 模型选择器是独立 screen，不是叠加在 transcript 上的卡片。
2. Provider 分组展示。
3. 当前模型有明确 active 标记。
4. 支持按 Provider、模型 ID、名称和描述搜索。
5. 宽终端显示列表和详情双栏。
6. 窄终端退化为单栏。
7. 选择支持多个 effort 的模型后进入二级 effort 选择。
8. Provider 加载失败显示在目录中，但失败行不可选。
9. 加载、切换和错误状态明确显示：

```text
Loading models...
Switching model...
Unable to load provider: ...
```

按键：

| 按键 | 行为 |
| --- | --- |
| 输入文字 | 搜索 Provider、模型 ID 和名称 |
| `Up` / `Down` | 移动光标 |
| `Enter` | 选择模型或进入 effort 选择 |
| `Esc` | 返回上一级或关闭 |
| `Home` / `End` | 移动到首项或末项 |
| `PgUp` / `PgDn` | 翻页 |

选择模型时不得取消当前正在运行的 turn。若当前 turn 已经开始，提示所选模型从下一轮生效。

## 9. M6：本地命令注册架构

当前 `packages/dsh-tui/src/plugin.ts` 中的本地命令是内联数组。应抽取为：

- `packages/dsh-tui/src/local-commands.ts`
- `packages/dsh-tui/tests/local-commands.spec.ts`

建议接口：

```ts
interface LocalCommand {
  descriptor: TuiCommandDescriptor
  execute(context: LocalCommandContext, args: string): Promise<void>
}
```

统一处理：

1. 命令描述、参数提示和别名。
2. 本地命令保留字冲突。
3. `/help`、命令面板和 slash completion 使用同一命令目录。
4. 本地命令与 Harness 动态命令合并。
5. Harness 同名命令默认优先。
6. 只有 TUI 生命周期命令，如 `/quit`、`/sessions`，由本地层保留。
7. 未知 slash command 继续返回明确错误，不作为普通用户消息发送给模型。

## 10. M7：基础命令补充

### P0：首个版本必须完成

| 命令 | 行为 |
| --- | --- |
| `/model` | 选择、查看和保存模型 |
| `/status` | 显示 Session ID、模型、权限、工作目录和上下文状态 |
| `/clear` | `/new` 的用户友好别名，持久化当前 Session 后开始新 Session |
| `/permissions` | 打开权限预设选择器；保留 `/permission PRESET` |
| `/exit` | `/quit` 的别名，使用完全相同的可靠关闭流程 |
| `/commands` | 打开与 `Ctrl+P` 相同的命令面板 |

### P1：在 P0 稳定后完成

| 命令 | 行为 |
| --- | --- |
| `/context` | 显示上下文占用、压缩状态和 token 统计 |
| `/doctor` | 检查凭据、Provider、模型目录、TTY、Session 持久化和工作区 |
| `/config` | 只读显示有效配置和配置文件路径 |
| `/export PATH` | 通过公开 Session 导出接口导出当前会话 |

已有 Harness 命令继续从 `controller.listCommands()` 动态读取，例如：

- `/compact`
- `/goal`
- `/plan`
- `/permission`
- `/feedback`

不在 TUI 中复制这些命令的业务实现。

### 本阶段不实现

暂不增加：

- `/cost`：Harness 当前没有可靠的统一账单数据。
- `/rewind`：没有公开的文件和会话回滚接口。
- `/mcp`：当前 profile 没有对应 MCP 管理服务。
- `/memory`：没有明确的指令存储公共契约。
- `/login`、`/logout`：凭据生命周期不属于当前 TUI。

不能添加只显示占位提示但无法完成工作的空壳命令。

## 11. `/status` 数据边界

`/status` 只展示可以通过当前 runtime 和 projection 获得的数据：

```text
Session: session-...
Workspace: /path/to/project
Model: deepseek-official/deepseek-v4-flash
Effort: high
Permission: workspace-write
Context: 12%
Status: idle
```

不猜测费用、账户套餐、剩余额度或 Provider 健康状态。

## 12. `/permissions` 交互

复用已有 permission projection 中的：

- 当前 preset。
- 可用 preset 列表。
- 名称和描述。

`/permissions` 打开选择器，最终选择仍通过官方 `/permission PRESET` command 执行。

`danger-full-access` 必须继续使用现有的二次确认机制，不能因选择器而跳过。

## 13. `/clear`、`/exit` 和 `/commands`

`/clear`：

- 直接复用 `/new` 的 flush、dispose 和 attach 流程。
- 不清空当前 Session 的持久化日志。
- 当前 turn 正在运行时走现有有界取消或明确拒绝，不能静默丢失输出。

`/exit`：

- 与 `/quit` 共享一个处理函数。
- 同样等待持久化。
- 同样输出 Session ID 和恢复命令。
- 同样在持久化失败时返回退出码 `74`。

`/commands`：

- 打开现有 `Ctrl+P` 命令面板。
- 不再维护第二份命令列表。

## 14. 测试计划

### 模型命令单元测试

- route、Provider、模型和 effort 解析。
- `info`、`default`、`save`。
- 缺少参数、空组件、多个分隔符和未知 Provider。
- 省略 Provider 时沿用当前 Provider。
- 未在 advisory catalog 中出现的自定义模型仍可选择。
- 不受支持的 effort 被拒绝。

### 模型运行时测试

- 空闲状态切换影响下一次请求。
- 运行中切换不改变当前 assembled 请求。
- 后续请求使用新模型和 effort。
- `/model default` 恢复 live default。
- 普通选择不调用 `saveSelection()`。
- `/model save` 调用一次 `saveSelection()`。

### 持久化与恢复测试

- `/model` command event 被 Session 持久化。
- 选择后立即 `/quit`，恢复后仍使用所选模型。
- 最后模型请求与最后 `/model` 命令冲突时按定义的优先级恢复。
- 显式 CLI `--model` 覆盖恢复的 Session 模型。
- `/new` 使用当前全局默认值，不意外继承旧 Session override。

### Picker 组件测试

- Provider 分组、当前项、搜索和详情。
- effort 二级选择。
- 加载失败和部分 Provider 成功。
- 过期请求取消。
- `Esc` 分层退出。
- 窄终端、宽终端和 resize。
- Unicode、ASCII 和无颜色模式。
- 快速 Enter 不重复提交选择。

### 基础命令测试

- `/clear` 与 `/new` 使用相同持久化流程。
- `/exit` 与 `/quit` 返回相同退出码和恢复凭据。
- `/permissions` 不绕过 `danger-full-access` 二次确认。
- `/commands` 打开现有命令面板。
- `/status` 在字段缺失时安全降级。
- 本地和 Harness 命令冲突时遵守所有权规则。

### PTY 端到端测试

1. 使用模型 A 启动。
2. 完成一次模型请求。
3. 执行 `/model` 并选择模型 B。
4. 发送后续消息。
5. 验证模拟服务器收到的第二次请求使用模型 B。
6. `/quit` 并通过输出命令恢复。
7. 再次发送消息，验证仍使用模型 B。
8. 运行 `/model save` 后新建 Session，验证默认模型变化。

### 打包测试

- npm 包包含模型选择器和命令文件。
- 安装包中的 `/model`、`/status`、`/clear` 和 `/exit` 可执行。
- Bash、Fish 和 Zsh completion 同步更新。
- README 中文和英文命令说明一致。

## 15. 验收标准

方案完成必须满足：

1. `/model` 可以打开可搜索模型选择器。
2. `/model ROUTE` 可以直接切换当前 Session 模型。
3. 切换不影响已开始请求，只从下一轮生效。
4. 模型和 reasoning effort 在状态栏及 `/status` 中及时更新。
5. `/quit` 后恢复 Session 仍保留模型选择。
6. `/model save` 才会修改未来 Session 默认模型。
7. Provider 部分加载失败不会使整个选择器不可用。
8. `/clear`、`/exit` 和 `/permissions` 不绕过现有持久化与安全确认。
9. 本地命令和 Harness 命令只保留一个可见目录。
10. 源码运行和 npm 安装包行为一致。

验收命令：

```bash
npm run build
npm test
npm run check:interactive
npm run check:resume
npm run check:packed
npm run check:release
```

## 16. 推荐实施顺序

1. 完成模型 selection ref 和 controller 接口。
2. 完成模型目录、route 解析和直接 `/model ROUTE`。
3. 完成模型 command event 持久化及恢复优先级。
4. 完成全屏 model picker。
5. 抽取统一 local command registry。
6. 完成 P0 基础命令。
7. 完成 P1 只读诊断和导出命令。
8. 更新中英文 README、completion 和发布检查。

M1 至 M4 和 P0 命令是发布阻塞项。P1 命令可以在公开 Harness 能力不足时延后，但不能用不完整的占位实现替代。

## 17. 执行状态（2026-08-21）

已完成：

- M1-M4：可变 model selection、公开模型目录、route/effort 校验、Session command 持久化恢复、全屏搜索选择器。
- P0：`/model`、`/status`、`/clear`、`/exit`、`/permissions` 和 `/commands`；危险权限仍经过重复确认。
- P1 只读命令：`/context`、`/doctor` 和 `/config`。
- 中英文 README、包内 README、类型检查与模型/界面/适配器测试。

延期：

- `/export PATH`：当前已验证的 Harness 公共接口只有 Web UI 下载路径，没有可供 TUI 按指定路径导出的
  Session API。按本方案的边界要求延期，不注册无法保证格式和持久化语义的占位命令。
