# dsh-tui 优化方案（对标 claude-code TUI 深度分析）

> 编制日期：2026-08-19
> 对标基线：`opensource/claude-code-main/src`（1903 个源文件，其中 `components/` 389、`ink/` 96、`hooks/` 104）
> 现状基线：`packages/dsh-tui/src`（45 个源文件，约 8.4k 行；Ink 5.2.1 + React 18）

---

## 0. 结论先行

dsh-tui 的**内核质量很高**：纯函数键位解析器、优先级降级的状态行、`Static` 滚动回填、差分帧绘制、投影缓存 —— 这些设计在 claude-code 里要么没有对等物，要么是靠一个 fork 版 Ink 才做到的。所以本方案**不是"重写成 claude-code"**，而是跟踪原始六个能力缺口及新增的启动缺口，并按当前代码重新划分剩余工作。

当前状态按投入产出排序：

| # | 能力 | 2026-08-20 现状 | 对标实现 | 优先级 |
|---|---|---|---|---|
| 0 | **目录确认 + 无参数交互启动** | 未实现 | workspace trust + 空首轮 REPL | **P0** |
| 1 | **消息折叠/分组流水线** | 已完成首批规则 | `collapseReadSearchGroups` + `groupToolUses` 等 5 级 | 已完成 |
| 2 | **审批档位与反馈** | 已按 Harness 能力完成 | accept-once / preset 切换 / 附反馈 | 已完成 |
| 3 | **通知队列** | 已完成 | 优先级 + fold + invalidate 队列 | 已完成 |
| 4 | **键位 context 栈与和弦** | 唯一真源、用户配置已完成；栈/和弦未完成 | `keybindings/` 14 文件 | P1 |
| 5 | **历史区检索/复制/重绕** | 未完成 | transcript mode + `/`搜索 + rewind | P1 |
| 6 | **等待反馈与工具意图** | stalled、宽度门控、activity 已完成；其余未完成 | thinking/token 动画/子 agent 树 | P2 |

> **范围补充（2026-08-20）**：启动链路还缺一个比上述 TUI 内部能力更靠前的边界：
> `dshcodecli` 无参数时不能直接进入交互 composer，且在首次使用某个目录前没有工作目录确认。
> 该项作为 **P0-0** 纳入本方案，必须先于其余未完成项实施。

---

## 1. claude-code TUI 模块深度拆解

### 1.1 渲染内核：自研 Ink fork（`src/ink/`，96 文件）

claude-code 没有用上游 Ink，而是 fork 了一份并把渲染改成**屏幕缓冲 + 双帧 diff**：

- `ink/screen.ts`：字符串驻留池（`CharPool`，ASCII 走 `Int32Array` 快表）+ 样式池（`StylePool`），每个 cell 存整数 id 而非字符串。`blitRegion` 直接拷 id，`diffEach` 比较整数。
- `ink/renderer.ts`：`frontFrame`/`backFrame` 双缓冲，`prevFrameContaminated` 标记（选区高亮改写过缓冲、alt-screen 进出、SIGCONT）时禁用 blit。
- `ink/components/ScrollBox.tsx`：`overflow: scroll` 的 Box + 命令式滚动 API（`scrollTo/scrollBy/scrollToElement/scrollToBottom/isSticky/setClampBounds`）。**关键点**：`scrollTo/scrollBy` 绕过 React —— 直接改 DOM 节点上的 `scrollTop`、`markDirty`、调根节点的节流 `scheduleRender`。滚动时 React 完全不参与。
- `hooks/useVirtualScroll.ts`（721 行）：视口裁剪 + overscan 80 行 + `SCROLL_QUANTUM = 40`（`useSyncExternalStore` 快照量化，避免每个滚轮 tick 触发 Yoga 全量 layout）+ `SLIDE_STEP = 25`（单次 commit 最多新挂 25 项，防止一次挂 194 个 MessageRow 造成 ~290ms 同步阻塞）+ `MAX_MOUNTED_ITEMS = 300`。
- `ink/components/AlternateScreen.tsx`：整个 REPL 包在 alt-screen 里，`<Box height={rows}>` 给 ScrollBox 的 `flexGrow` 一个天花板。

**对 dsh 的意义**：这是"重写渲染层"级别的投入。dsh 的 `frame-writer.ts`（差分行绘制）+ `scrollback.ts`（`Static` 外溢到终端原生 scrollback）是**另一条同样自洽的路线**，且在"滚轮天然可用、不吃终端兼容性"上更优。**不建议照搬**，但要吸收其中三个可移植的点（见 §3.5）。

### 1.2 布局骨架：`FullscreenLayout`（637 行）

一个显式的**槽位模型**，比 dsh 现在 `app.tsx` 里线性堆叠的 JSX 更有结构：

| 槽位 | 语义 |
|---|---|
| `scrollable` | 会滚的内容（消息、工具输出），装在 ScrollBox 里 |
| `bottom` | 钉底（spinner、输入框、权限框），`flexShrink:0`，`maxHeight:50%` |
| `overlay` | 渲染在 ScrollBox **内部**消息之后 —— 用户可以往上滚看上下文（`PermissionRequest` 用它） |
| `modal` | 绝对定位、底部锚定的面板，带 `▔` 分隔线，覆盖 ScrollBox 和 bottom；通过 `ModalContext` 告诉内部 `Pane`/`Dialog` 跳过自己的边框 |
| `bottomFloat` | ScrollBox 区域右下角的绝对定位浮层 |
| sticky header | 滚动派生的粘性提示（当前 user prompt） |
| pill | "N 条新消息"跳转胶囊 |

配套的 `useUnseenDivider`：滚离底部时快照 `scrollHeight` 到 **ref**（不是 state），`FullscreenLayout` 用 `useSyncExternalStore` 直接订阅 ScrollBox 判断 pill 可见性 —— 逐帧滚动不会 re-render REPL。这是"把高频信号挡在 React 之外"的范式。

### 1.3 输入与快捷键：`keybindings/`（14 文件）+ 处理器组件分层

两层设计：

**声明层** `defaultBindings.ts`：按 **context** 分块（`Global` / `Chat` / `Autocomplete` / `Confirmation` / `Transcript` / `Scroll` / `Select` / `Footer` / `MessageActions` / `Tabs` / `DiffDialog` / `HistorySearch` / `Task` / `Attachments` / `MessageSelector` / `Settings` / `Plugin` / `ModelPicker` / `Help`），值是 **action 字符串**（`app:toggleTranscript`、`chat:cycleMode`）。要点：

- **多 context 同时激活**：`resolveKey(input, key, activeContexts[], bindings)` 取最后一个匹配（用户覆盖 last-wins）。
- **和弦**：`'ctrl+x ctrl+k'`、`'ctrl+x ctrl+e'`（避开 readline 的 ctrl+a/b/e/f）。
- **用户可覆盖**：`loadUserBindings.ts` 读 `~/.claude/keybindings.json`；`reservedShortcuts.ts` 保护 ctrl+c/ctrl+d 不被改；`validate.ts` 报错。
- **平台/终端能力分支**：Windows 无 VT 模式时 `shift+tab` → `meta+m`；`ctrl+v` → `alt+v`；`cmd+*` 只在 kitty 协议终端有效。
- **显示与实现同源**：`useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')` —— 帮助菜单、权限选项文案里的 "(shift+tab)" 全部从绑定表反查，改键即改文案。

**执行层**：不是一个大 `useInput` switch，而是**一串零高度的处理器组件按挂载顺序分层**：

```
<KeybindingSetup>
  <GlobalKeybindingHandlers/>
  <CommandKeybindingHandlers/>
  <ScrollKeybindingHandler/>      ← 必须在 CancelRequestHandler 之前挂载
  <CancelRequestHandler/>
  ...
```

顺序即优先级：`ScrollKeybindingHandler` 先挂，所以"有选区时 ctrl+c 复制"能在"ctrl+c 取消任务"之前用 `stopImmediatePropagation` 截胡；没选区时事件继续冒泡。

**对 dsh 的意义**：dsh 的 `keymap.ts` 是**单 surface、纯函数**解析（`UiSurface` 七选一），可测试性其实更好，但缺三样：context **栈**（一个键可以由多个层依次消费）、**用户可配置**、**显示与实现同源**。

### 1.4 会话流渲染：折叠流水线 + 虚拟列表

`components/Messages.tsx` 的核心是一条**消息变换流水线**（这是 dsh 最缺的一块）：

```
filter → reorderMessagesInUI → applyGrouping(groupToolUses)
      → collapseReadSearchGroups      // 连续的 Read/Grep/Glob 折叠成一行 "Read 12 files"
      → collapseTeammateShutdowns
      → collapseHookSummaries
      → collapseBackgroundBashNotifications
      → buildMessageLookups           // resolvedToolUseIDs 等索引
```

- `CollapsedReadSearchContent.tsx`（483 行）把一组只读探查折叠成单行，`MIN_HINT_DISPLAY_MS = 700` 保证快速完成的调用不会一帧闪过。
- `CtrlOToExpand` 提供统一的"ctrl+o 展开"提示。
- 非虚拟路径有 `MAX_MESSAGES_WITHOUT_VIRTUALIZATION` 安全上限，且切片起点用 **uuid 锚定**（`computeSliceStart`）而不是 `slice(-200)` —— 因为折叠重组会改变数组长度，计数切片会抖动。

### 1.5 工具呈现契约：工具自带 UI（`Tool.ts` 520–680 行）

工具接口暴露一整族渲染钩子：

```
userFacingName / userFacingNameBackgroundColor / isTransparentWrapper
getToolUseSummary / getActivityDescription        // 摘要 & spinner 文案
renderToolUseMessage        (input 可能是流式半成品 → Partial)
renderToolUseTag            // timeout / model / resume-id 等元数据标签
renderToolUseProgressMessage
renderToolUseQueuedMessage
renderToolResultMessage     (style?: 'condensed', verbose, isTranscriptMode, isBriefOnly)
renderToolUseRejectedMessage / renderToolUseErrorMessage
renderGroupedToolUse        // 并行同类调用合并渲染
isResultTruncated           // 是否值得给"点击展开"的可供性
extractSearchText           // 供 transcript 全文检索索引（有专门的 renderFidelity 测试防漂移）
```

**dsh 的对应物是 `tool-presentation.ts` + `tool-card.ts`**：工具通过 `presentCall`/`presentResult` 返回**数据意图**（`{card: 'diff'|'terminal'|'search'|'read'|'web'|'generic', ...}`），TUI 侧渲染。**这个方向比 claude-code 更好**（工具不依赖 React，可跨前端复用，可快照测试）。缺的是意图的**表达力**：没有 `condensed` 变体、没有 grouped 渲染、没有 activity description、没有 truncated 标记。

### 1.6 权限与问答（`components/permissions/`，12k 行）

- 每种工具一个专用请求组件：`BashPermissionRequest`（可编辑前缀）、`FileEditPermissionRequest`（带 diff）、`WebFetchPermissionRequest`、`SkillPermissionRequest`、`ExitPlanModePermissionRequest`、`ComputerUseApproval`……
- **选项不是二元的**（`FilePermissionDialog/permissionOptions.tsx`）：`accept-once` / `accept-session`（带 scope：工作目录内 / 具名目录 / `.claude` 目录）/ `reject`，标签里内嵌 `(shift+tab)` 提示。
- **选项可带输入框**：`type: 'input'` 的选项让用户"同意，并告诉 Claude 接下来做什么"或"拒绝，并说明改做什么"，`allowEmptySubmitToCancel`。
- `PermissionExplanation` / `PermissionDecisionDebugInfo`（ctrl+e / ctrl+d 展开"为什么问我"）。
- 队列化：`toolUseConfirmQueue`，`focusedInputDialog` 单一派生量决定谁拿焦点。

### 1.7 状态与反馈三件套

**Spinner**（`components/Spinner.tsx` 561 行 + `Spinner/` 9 文件）：

- 动画时钟下沉到 `SpinnerAnimationRow`，父组件不在 50ms 时钟上（dsh 已有等价优化：`useAnimationClock` 只在 running 时开 interval）。
- `useStalledAnimation`：3 秒无新 token → spinner 渐变红（2 秒 fade，`reducedMotion` 时瞬变）。**有工具在跑时不算 stall**。
- token 计数器**缓动逼近**真实值（按帧间隔自适应 increment），而不是跳变。
- **渐进宽度门控**：`thinking → 计时 → token 数` 按可用宽度依次放弃，窄终端下 `thinking(effort)` 还能降级成 `thinking`。
- 动词随机 + shimmer 扫光；动词可通过 settings `spinnerVerbs: {mode: 'replace'|'append'}` 自定义。
- 有 token 预算时显示 `Target: 12.3k / 50k (25%) ~2m`。

**StatusLine**（323 行）：支持用户自定义命令生成状态行（`statusLineShouldDisplay(settings)`），有自定义状态行时自动隐藏 `? for shortcuts`。

**Notifications**（`context/notifications.tsx` 239 行）：优先级队列（`low|medium|high|immediate`）+ `timeoutMs`（默认 8s）+ `invalidates: string[]`（新通知作废旧的）+ `fold(acc, incoming)`（同 key 合并）。文本或 JSX 两种载荷。

### 1.8 输入框（`components/PromptInput/`，5161 行）

- 模式：`prompt` / `bash`(`!`) / `memory`(`#`) / vim（`vim/` 5 文件：motions/operators/textObjects/transitions）。
- `useTextInput.ts`（529 行）：撤销栈（`ctrl+_`）、括号粘贴、图片粘贴（`ctrl+v`/`alt+v`）、`ctrl+x ctrl+e` 外部编辑器、`ctrl+s` 暂存草稿、`ctrl+r` 反向历史搜索。
- `PromptInputFooterSuggestions`：全屏模式下通过 `promptOverlayContext` **portal 到 FullscreenLayout**，避免建议列表撑高 bottom 槽位。
- `PromptInputQueuedCommands`：运行中排队的后续指令。
- 窄终端（<80 列）footer 由 row 转 column；矮终端（<24 行）先丢 StatusLine。

### 1.9 导航与检索

- **Transcript mode**（实际采用 `ctrl+t`，因为 `ctrl+o` 已用于卡片折叠）：整屏接管 + `/` 搜索栏 + `n`/`N` 跳转 + 匹配计数徽章 + 屏幕缓冲级高亮（`ink/searchHighlight.ts`）。
- **MessageSelector**（rewind）：选一条 user message，可"恢复代码"（`fileHistoryRewind`）、"从此处摘要"（`partialCompactConversation`，支持 `from` / `up_to` 两个方向）、"恢复消息"。
- **MessageActions**：光标在消息间移动（`j/k`、`shift+↑↓` 跳 user message），对单条消息执行操作。
- `QuickOpenDialog` / `GlobalSearchDialog`（`ctrl+shift+p` / `ctrl+shift+f`）。
- 未读分隔线 + "N new messages" pill。

### 1.10 选区与复制（`ink/selection.ts` + `ScrollKeybindingHandler` 1011 行）

锚点/焦点的屏幕缓冲坐标选区，字符/词/行三种模式，拖拽到边缘自动滚动并把滚出视口的行累积到 `scrolledOffAbove/Below`（含软换行位图，保证复制出来的是逻辑行）。滚轮加速：原生终端线性 ramp（40ms 窗口、step 0.3、上限 6），xterm.js 走指数衰减曲线，还做了**编码器抖动检测**（劣质滚轮 28% 反向 tick）来区分鼠标和触控板。

### 1.11 设计系统（`components/design-system/`，16 文件 2238 行）

`Dialog` / `Pane` / `Divider` / `ListItem` / `Tabs` / `FuzzyPicker` / `ProgressBar` / `StatusIcon` / `Byline` / `KeyboardShortcutHint` / `ThemedText` / `ThemedBox` / `ThemeProvider`。

`StatusIcon` 是个好范式：`success|error|warning|info|pending|loading` → (figure, themeColor) 的单一映射表。`Dialog` 自带 `confirm:no` 绑定和 ctrl+c/d 双击退出，并用 `isCancelActive` 在内嵌输入框编辑时让位。

---

## 2. dsh-tui 现状盘点

### 2.1 已经做得好、不要动的部分

| 模块 | 评价 |
|---|---|
| `keymap.ts` | 纯函数解析器 + `KEY_BINDINGS` 文档表 + 漂移测试。比 claude-code 更可测。 |
| `status-line.ts` | 分优先级**整段丢弃**而非截断，比 claude-code 的宽度门控更干净。 |
| `scrollback.ts` | `Static` 外溢到终端原生 scrollback，滚轮天然可用、零终端兼容负担。前缀 settled 规则（未决卡片钉住其后所有条目、最后一条永不 settled）是正确的。 |
| `frame-writer.ts` | 拦截 Ink 的 `eraseLines(n)+output`，只重写变化行。用 30 行拿到了 fork Ink 才有的大部分收益。 |
| `tool-presentation.ts` | 工具用**数据意图**而非 React 节点声明 UI，跨前端可复用。方向优于 claude-code。 |
| `terminal-layout.ts` | 显式行预算分配。 |
| `transcript-view.ts` 双层缓存 | entry 缓存 + row 缓存（按 fold 状态和宽度 key），流式增量只重排受影响 entry。 |

### 2.2 缺口清单（对照 §1）

| 对标模块 | dsh 现状 |
|---|---|
| 折叠流水线（§1.4） | ❌ 无。只有单卡片 `foldedByDefault` |
| 审批多档 + 附反馈（§1.6） | ❌ 只有 `APPROVAL_CHOICES = [allow once, reject]`；`decideApproval(allowed: boolean)` |
| 通知队列（§1.7） | ❌ `state.notice?: string` 单槽位 |
| 键位可配置 / context 栈 / 和弦（§1.3） | ❌ 编译期静态表，单 surface |
| 显示与实现同源 | ⚠️ `KEY_BINDINGS` 是**描述性**副本，靠漂移测试对齐 |
| transcript 检索 / rewind / 选区复制（§1.9-10） | ❌ 全无（history 交给终端 scrollback，代价已在 `scrollback.ts` 注释中明示） |
| spinner 分层反馈（§1.7） | ⚠️ 单行 `buildWorkingLine`，无 stalled、无 thinking、无缓动 |
| 输入框：撤销 / bash 模式 / 反向历史搜索 / 图片 | ❌ 无（有粘贴、有外部编辑器 `ctrl+x`、有历史上下键） |
| 设计系统 | ⚠️ `themed()` 内联散布在 `app.tsx` 888 行里，`overlay.ts` 是唯一被复用的列表模型 |
| 工具意图表达力 | ⚠️ 6 种 card，无 condensed / grouped / activity-description / truncated |
| `app.tsx` 单文件 888 行 | ⚠️ 承担了状态、布局、输入分发、5 个模态的全部渲染 |

---

## 3. 优化方案

### P0-0　工作目录确认 + 无参数直接进入交互

#### 目标交互

直接执行：

```bash
dshcodecli
```

在当前目录尚未确认时，先显示一个与 claude-code `TrustDialog` 同构的选择界面：

```text
Accessing workspace:

/absolute/path/to/project

Quick safety check: Is this a project you created or one you trust?
DSH Code Agent will be able to read, edit, and execute files here.

> Yes, use this folder
  No, exit

Enter to confirm · Esc to cancel
```

确认后直接显示 splash + 空 composer，等待用户输入第一条消息。**不得**为了启动会话发送
`"你是谁"`、空格或任何其他占位 prompt，也不得在用户提交前产生 LLM 请求。

兼容性约束：

- `dshcodecli "修复这个问题"` 继续保持一次性任务语义；显式 `-i/--interactive` 继续兼容。
- `dshcodecli --resume [id]`、`--help`、`--version` 的现有语义不变；help/version 不弹目录确认。
- 无参数仅在 stdin/stdout 都是 TTY 时进入交互；重定向 IO 时给出明确错误，不静默挂起。
- `No` 退出且不启动 Harness；`Esc` 与 `Ctrl+C` 走取消/有界退出，不把按键传给后续 TUI。

#### 安全边界

目录确认必须位于 launcher，而不是 Agent 已创建后的 React view。当前 `launch.mjs` 会在 spawn
之前沿 cwd 及其父目录读取 `.env`；因此正确顺序是：

```text
解析 --help/--version
  → 解析并规范化 cwd（realpath）
  → 检查/展示 workspace 确认
  → 读取项目 .env、准备运行环境
  → spawn Harness
  → 创建空 session
  → 挂载 interactive composer
  → 用户首次提交后才 followup / 发起模型请求
```

未经确认，不读取 cwd 内的 `.env`、项目配置、技能、hook、MCP 配置，也不创建 Agent。这样该弹窗
才是工作区信任边界，而不只是一个已经太晚的视觉提示。

确认记录建议写入 `$DSH_HOME/tui/trusted-workspaces.json`，key 使用 `realpath(cwd)` 后的绝对路径，
避免同一目录通过符号链接重复确认。写入采用临时文件 + rename，文件权限限制为当前用户；损坏、
不可读或版本不兼容的记录一律按“未确认”处理。与 claude-code 一致，home 目录只做本次会话确认，
不把整个 home 永久标记为可信。已经确认的普通目录走 fast path，不重复弹窗。

#### 代码落点

1. `packages/dsh-tui/bin/workspace-trust.mjs`（新增）：信任记录读写、目录规范化、选择器状态机和
   最小 ANSI 渲染；保持 plain ESM，保证安装包启动不依赖 TypeScript loader。
2. `packages/dsh-tui/bin/launch.mjs`：在 `envSearchPath/loadEnvFile` 和 child spawn 之前执行 preflight；
   空 argv 原样交给 startup，不在 launcher 注入伪任务。
3. `packages/dsh-tui/src/startup.ts`：允许“无 task、无 resume”，并把该形态归一化为
   `{ task: '', interactive: true }`；有 task 时仍按原默认保持 one-shot。
4. `packages/dsh-tui/src/plugin.ts` / `harness-adapter.ts`：沿用已经存在的 optional first task 路径；
   `task.trim() === ''` 时只建立交互控制器，不调用 `controller.followup()`。增加断言测试，防止以后
   又通过占位消息启动。
5. shell completion、`--help` 和 `docs/tui-user-guide.md`：把无参数启动写成主路径，`-i` 标为兼容的
   显式覆盖，而不是必需步骤。

#### 验收

- 新目录首次执行 `dshcodecli`：先看到绝对路径与 Yes/No；选择 Yes 后进入空 composer。
- 选择 No：Harness/LLM 请求数均为 0，项目 `.env` 读取数为 0，退出码明确。
- 同一路径第二次启动不再询问；符号链接路径与真实路径共用一条确认记录。
- 未提交消息前 LLM 请求数严格为 0；提交第一条消息后只发送该消息一次。
- PTY smoke 覆盖 40x12、80x24、无颜色和 ASCII-only；提示文本不溢出、不与选项重叠。
- 单元测试覆盖空 argv、one-shot、`-i`、resume、损坏记录、拒绝、Esc/Ctrl+C、原子写失败。
- 完整门禁：`pnpm run check`、packed-install smoke 和 installed-mode CLI smoke 全绿。

### P0-1　消息折叠流水线（渐进披露）

**问题**：一次 `Grep` + 8 次 `Read` 会在 transcript 里占 9 张卡片、几十行，把真正的回答挤出屏幕。这是长会话可读性的**第一杀手**。

**方案**：在 `transcript-view.ts` 与 `state.ts` 之间插入一层纯函数流水线，输入 `TranscriptEntry[]`，输出 `TranscriptEntry[]`：

```ts
// packages/dsh-tui/src/collapse.ts  (新增)
export interface CollapseRule {
  readonly id: string
  /** 判断从 index 开始能吃掉多少条；0 表示不适用 */
  match(entries: readonly TranscriptEntry[], index: number): number
  /** 把吃掉的那一段折成一条 */
  fold(group: readonly TranscriptEntry[]): TranscriptEntry
}

export function collapseEntries(
  entries: readonly TranscriptEntry[],
  rules: readonly CollapseRule[],
  expanded: ReadonlySet<string>,   // 用户 ctrl+o 展开过的组
): readonly TranscriptEntry[]
```

首批规则（按价值排序）：

1. `read-search-run`：连续的只读探查卡（card 为 `read`/`search`，且 `status === 'ok'`）→ 一行 `⤿ Read 8 files · Grep 2 patterns`，展开还原。**判据用 card kind，不用工具名** —— 保持 dsh"永不按工具名分支"的原则。
2. `parallel-same-tool`：同一轮内并行的同 card 调用 → 一条带计数的卡。
3. `failed-retry`：同 card 同目标的失败→重试序列 → 只显示最终态 + `(2 retries)`。

**落地点**：
- 新增 `src/collapse.ts` + `tests/collapse.spec.ts`（纯函数，全快照测试）。
- `state.ts` 在 `renderLines` 之前调用；折叠组的 id 稳定派生自首条 entry id（**不能用下标** —— 见 claude-code 的 `computeSliceStart` 教训）。
- `app.tsx` 的 `toggle-fold` action 复用为组展开；`scrollback.ts` 的 settled 判定要把"折叠组内含 pending"视为未 settled。

**风险**：折叠组一旦 flush 进 `Static` scrollback 就不可再展开。缓解：**折叠组在有 pending 成员或是最后 N 条时不 flush**（把 `settledEntryIds` 的 `length - 1` 放宽成 `length - RECENT_KEEP`，`RECENT_KEEP` 取一屏高度）。

**验收**：一轮 10 次只读调用后，transcript 占用行数 ≤ 3 行；`ctrl+o` 可展开；快照测试覆盖折叠/展开/含 pending 三态。

---

### P0-2　审批档位与附带反馈

**问题**：`decideApproval(allowed: boolean)` 让用户在"每次都问"和"关掉审批"之间二选一，实践中会逼用户切到 `acceptEdits`/`bypass`，反而降低安全性。

**方案**：把决策从布尔提升为**结构化决策**。

```ts
// contracts.ts
export type ApprovalDecision =
  | { kind: 'allow-once' }
  | { kind: 'allow-session'; scope?: ApprovalScope }   // scope 由 harness 在请求里声明
  | { kind: 'reject'; feedback?: string }
  | { kind: 'allow-once'; feedback?: string }

export interface ApprovalRequest {
  readonly callId: string
  readonly toolName: string
  readonly reason?: string
  /** Harness 声明本次可提供的档位；TUI 只渲染，不推断。 */
  readonly options: readonly ApprovalOption[]
}
export interface ApprovalOption {
  readonly id: string
  readonly label: string
  readonly decision: ApprovalDecision
  /** 选中后进入输入态，收集一句反馈再提交 */
  readonly acceptsFeedback?: boolean
}
```

**关键约束**：档位由 Harness 侧提供（它才知道 `.dsh/` 目录、工作区边界、规则可持久化性），TUI 只负责渲染与键位。这与 dsh 现有 `cycle-mode` 走 `/permission` 官方命令的原则一致。

> **落地时的范围修正（2026-08-19）。** 核查上游后确认：`packages/interaction/user-approval/src/types.ts` 的
> `ApprovalOutcome` 是**封闭集** `allowed-once | rejected | cancelled | unavailable`，
> 这个 Harness **没有**任何可持久化规则的授权出口 —— 会话级权限完全由 **permission preset**
> 表达。因此上文的 `allow-session` + scope **无法诚实实现**，强行加会让 TUI 提供一个
> Harness 无法兑现的决定。已落地的是同等价值、且完全在 Harness 能力内的版本：
>
> - `allow once, then switch to <preset>` = 一次性授权 **+** 发送 `Shift+Tab` 同款
>   `/permission` 命令。标签直接写出目标 preset，因为这改的是会话规则而不只是这一次调用；
>   进入 `danger-full-access` 仍然继承命令处理器里的二次确认。
> - `reject, and say why` = 拒绝 **+** 把用户本来就要打的那句话作为下一条消息发出，
>   让重试是"被告知过的"而不是原样再来一遍。
>
> 这两行都不是新决定，而是把两件 Harness 已经支持的事合成一步。

**落地点**：
- `contracts.ts` 扩展；`harness-adapter.ts` 补齐档位构造与回传。
- `app.tsx` 的 `APPROVAL_CHOICES` 常量删除，改为渲染 `state.approval.options`；`approval-decide` action 改带 `optionId`。
- 数字键 `1..9` 直选、`↑↓` + Enter、`Esc` = 第一个 `reject` 档（**fail closed 语义保留**）。
- 新增反馈输入子态：选中 `acceptsFeedback` 的档位后 Enter 进入单行输入，空提交 = 取消回到列表。

**风险**：Esc 的 fail-closed 语义不能被 feedback 输入态吞掉 —— 输入态里 Esc 退回列表，列表里 Esc 才 reject。`keymap.ts` 里显式建模这两个子 surface。

**验收**：`tests/keymap.spec.ts` 覆盖 Esc 两级语义；快照覆盖 2/3/4 档渲染与窄终端截断。

---

### P0-3　通知队列

**问题**：`notice` 单槽位意味着"已切换模型"和"MCP 服务器断开"会互相覆盖，且没有超时。

**方案**：移植 claude-code 的队列语义，但保持 dsh 的纯数据风格（不用 JSX 载荷）。

```ts
// packages/dsh-tui/src/notifications.ts  (新增)
export type NoticePriority = 'low' | 'medium' | 'high' | 'immediate'
export interface Notice {
  readonly key: string
  readonly text: string
  readonly tone?: RowTone
  readonly priority: NoticePriority
  readonly timeoutMs?: number          // 默认 8000
  readonly invalidates?: readonly string[]
  readonly fold?: (acc: Notice, incoming: Notice) => Notice
}
export interface NoticeQueue { readonly current?: Notice; readonly queue: readonly Notice[] }
export function pushNotice(q: NoticeQueue, n: Notice, now: number): NoticeQueue
export function tickNotices(q: NoticeQueue, now: number): NoticeQueue
```

**落地点**：`state.ts` 用 `NoticeQueue` 替换 `notice: string`；`app.tsx` 渲染 `current`，右侧显示 `+N` 表示队列深度；时钟复用已有的 `useAnimationClock`（但通知队列需要**即使不 running 也走一个低频 tick** —— 用 1s 周期的独立 interval，仅在 `queue.length > 0 || current !== undefined` 时存在）。

**验收**：纯函数测试覆盖优先级插队、invalidate、fold、超时出队；idle 且无通知时不得存在任何 timer（沿用 `useAnimationClock` 的 idle-零唤醒约束）。

---

### P1-4　键位系统：context 栈 + 用户配置 + 显示同源

**执行状态（2026-08-20）**：4a“显示与实现同源”和 4c 中的单键用户配置已经完成：
`keybindings.ts` 已是唯一真源，`$DSH_HOME/keybindings.json` 已支持校验、保留键保护、冲突提示，
帮助文案也从同一表生成。尚未完成的是 **4b context 栈** 与 **多键和弦状态机**。下列原始分步
说明保留作设计依据，执行时只实施未完成部分。

**分三步，不要一次做完**：

**4a. 显示同源（低成本，先做）**
把 `KEY_BINDINGS` 从"描述性副本"改成**唯一真源**：解析器从表里查，而不是表去追解析器。

```ts
export interface Binding {
  readonly action: UiAction['kind']
  readonly chord: string            // 'ctrl+x ctrl+e'
  readonly surfaces: readonly (UiSurface | 'global')[]
  readonly description: string
}
export function shortcutFor(action: string, surface: UiSurface | 'global'): string
```

`overlay.ts` 的 `helpRows`、`docs/tui-user-guide.md` 生成器、审批选项里的 "(shift+tab)" 文案全部走 `shortcutFor`。删掉漂移测试（不再需要）。

**4b. context 栈**
把 `UiSurface`（七选一）改成 `readonly UiSurface[]`（由内到外），`resolveKey` 依次询问每层，第一个返回非 `undefined` 的胜出，某层可以显式返回 `'swallow'` 阻断。这样"completion 打开时 Tab 归 completion"这类逻辑从 `openKey` 里的内联 if 变成栈的自然结果，也让"有选区时 ctrl+c 复制"（P1-6）能干净插入。

**4c. 用户配置**
读 `~/.dsh/keybindings.json`，schema 校验，`ctrl+c` 保留不可改，冲突报警但不阻断启动。和弦支持（前缀态 + 超时取消）放到最后。

**验收**：`tests/keymap.spec.ts` 扩展为栈解析；新增 `tests/keybindings-config.spec.ts`；帮助面板快照由绑定表生成。

---

### P1-5　`app.tsx` 分解 + 轻量设计系统

**问题**：888 行单文件里塞了 5 个模态、输入分发、布局预算、状态行。新增任何一个模态（如 P0-2 的反馈输入态）都会让它继续膨胀。

**方案**（结构性重构，不改行为，先于其余 P1 做）：

1. **槽位化布局**（借鉴 §1.2，但不引入 ScrollBox）：
   ```tsx
   <Frame
     scrollback={...}      // Static
     transcript={...}      // 活动帧
     overlay={...}         // approval / question —— 在 transcript 之下、composer 之上
     modal={...}           // help / browser / palette —— 整屏接管
     status={...}          // working line + todo + notice + error + context bar + status row
     composer={...}
   />
   ```
   `terminal-layout.ts` 已经在算行预算，让它直接产出槽位高度。

2. **模态拆文件**：`views/approval.tsx` / `views/question.tsx` / `views/palette.tsx` / `views/session-browser.tsx` / `views/help.tsx`，各自导出 `{ rows(state, layout): Row[] }` 的纯模型 + 薄渲染组件。

3. **最小设计系统** `src/ui/`：
   - `StatusGlyph`：`ok|error|warn|info|pending|running` → (glyph, tone) 单表，替换散落的 `glyphs.ts` 用法。
   - `ListView`：把 `overlay.ts` 的 `buildOverlay` 包成组件（palette / browser / completion / question options 四处已经在手抄同一套 `>` 前缀 + above/below hint 逻辑）。
   - `ShortcutHint`：走 P1-4a 的 `shortcutFor`。
   - `Field` / `Divider`。

**验收**：`app.tsx` ≤ 250 行；现有 44 个测试文件全绿（这是纯重构的硬门槛）；新增 `tests/views/*.spec.tsx` 快照。

---

### P1-6　历史区能力：检索、选区复制、重绕

这是**唯一需要动架构抉择**的一项。

**架构抉择：不要放弃 `Static` scrollback，改为"双模式"**

- **默认（scrollback 模式）**：现状不变。滚轮属于终端、零兼容负担、`frame-writer` 差分绘制。
- **`ctrl+t` transcript 模式**：进入 alt-screen，接管整屏，此时 dsh **自己拥有全部行**，可以做检索、复制和草稿恢复。`ctrl+o` 保留为既有卡片折叠键。退出 alt-screen 时终端自动还原原 scrollback，**用户的历史一行都不会丢** —— 这是 alt-screen 的天然属性，也正是这个方案成立的原因。

这样既不用 fork Ink（transcript 模式下行数已经由 dsh 自己分页，不需要虚拟滚动的 Yoga 级优化），也拿到了 90% 的能力。

**分三期**：

- **6a. transcript 模式骨架**：`terminal-capabilities.ts` 已有 `alternateScreen` 探测；进入时写 `\x1b[?1049h`，退出写 `\x1b[?1049l`；复用 `viewport.ts` 的分页逻辑（已存在），复用 `overlay.ts` 的窗口模型。`Esc`/`q`/`ctrl+t` 退出。
- **6b. `/` 检索**：`transcript-view.ts` 的 `TranscriptLine.text` 已经是纯文本 —— 直接在行数组上 `indexOf`，`n`/`N` 跳转，匹配行加 `segments` 高亮（`StyledSegment` 已支持 `background`）。计数徽章放页脚。**不需要 claude-code 的 `extractSearchText` 契约**，因为 dsh 的卡片本来就是先转成文本行再渲染的 —— 这是 dsh 数据意图架构的红利。
- **6c. 重绕（rewind）**：`↑↓` 选中一条 user 消息，Enter 提供"从此处重来"。依赖 Harness 侧的 session fork 能力，若暂不具备则只做"复制该消息到草稿"。

**明确不做**：鼠标拖拽选区。alt-screen 下终端原生选区失效，要自己实现就得走 claude-code 那条 1011 行的路（含滚轮抖动检测）。替代方案：transcript 模式下 `y` 复制当前行 / `Y` 复制当前卡片全文（通过 OSC 52 写系统剪贴板，`terminal-capabilities.ts` 可探测）。这是 90% 收益 5% 成本。

---

### P2-7　等待反馈分层

**执行状态（2026-08-20）**：已完成。除既有 stalled 判定、宽度降级和工具 activity 外，现已加入
reasoning/thinking 阶段提示、纯函数 token 缓动和参与终端行预算的子 agent 树状行。

按价值排序，逐条加进 `working-line.ts`（保持纯函数 + 宽度门控风格）：

1. **stalled 提示**：超过 `STALL_AFTER_MS`（3s）无新输出且无 pending 工具 → 行首 tone 切 `warn`，附 `(no output for 12s)`。**有 pending 工具时不算 stall**（照抄 claude-code 的判据，这条很关键，否则跑 `npm test` 会一直报红）。
2. **渐进宽度门控**：现在是 `elapsedMs >= TOKENS_AFTER_MS` 才显示 token —— 改成按**可用宽度**依次放弃 `token → 计时 → 动词`，窄终端下永远至少剩一个 spinner 帧。这是 `status-line.ts` 已有的优先级降级思想，平移过来。
3. **thinking 段**：`activity` 里若有 reasoning 阶段，显示 `thinking` / `thought for 8s`（最短显示 2s 防抖，照抄 `MIN_HINT_DISPLAY_MS` 思路）。
4. **token 缓动**：显示值向真实值逼近而非跳变（纯函数：`nextDisplayed(prev, target, dtMs)`）。
5. **子 agent 行**：`activity.subagent` 已在状态行里，可升级为 working line 下的树状分行。

**不做**：shimmer 扫光、随机动词库扩充。dsh 的 `workingVerb(turn)` 用 turn index 取模保证快照可复现，这个性质比"更花哨"更值钱。

---

### P2-8　工具意图表达力扩展

**执行状态（2026-08-20）**：`activity` 的声明、传播与 working line 消费已完成；内置 search/web
卡已经能显示其原始结果里的 `truncated` 状态，但通用 `ToolRenderIntent` 契约仍没有统一的
`summary`、`condensed`、`truncated` 字段。执行时只补齐这三个通用意图和对应降级测试。

在 `ToolRenderIntent` 上加四个可选字段，全部向后兼容（缺失即当前行为）：

```ts
interface ToolRenderIntent {
  card: ToolCardKind
  // 既有字段…
  /** 一行摘要，供折叠组与 working line 使用 */
  summary?: string
  /** 现在进行时描述，供 working line：'Reading src/app.tsx' */
  activity?: string
  /** 精简变体，供 verbose=false / 折叠组展开时 */
  condensed?: { title?: string; body?: DetailLine[] }
  /** 非 verbose 渲染是否被截断（决定是否给"ctrl+o 展开"可供性） */
  truncated?: boolean
}
```

`activity` 直接喂给 P2-7 的 working line（把 `Working…` 换成 `Reading src/app.tsx`），信息密度提升明显且成本极低。

---

## 4. 明确不建议照搬的部分

| claude-code 做法 | 不建议的原因 |
|---|---|
| fork Ink，自研屏幕缓冲 + 虚拟滚动 | 96 个文件的维护负担。dsh 的 `Static` + `frame-writer` 在 dsh 的使用场景下已解决同一问题的 80%，且滚轮兼容性更好。 |
| 工具返回 React 节点 | dsh 的数据意图协议更好：可跨前端、可快照、工具不依赖 React。 |
| 鼠标拖拽选区（1011 行 + 滚轮抖动检测） | 收益/成本比极差。用 OSC 52 + `y`/`Y` 行复制替代。 |
| `focusedInputDialog` 巨型派生量 | dsh 的 `UiSurface` 显式枚举更清晰；P1-4b 的 context 栈是更好的演进方向。 |
| 随机 spinner 动词 + shimmer | 破坏快照可复现性，与 dsh"帧可由输入复现"的设计原则冲突。 |
| React Compiler | 编译产物几乎不可读（本次分析中多个文件被 `_c(99)` 缓存槽淹没）。dsh 手写 memo 边界即可。 |

---

## 5. 合并后的执行里程碑

**执行记录（2026-08-20）**：M1–M3 和 M4 的既有部分是本轮基线；下表是本轮合并执行范围及
最终状态。所有实现项均已完成，M7 根据 Harness 的公开能力走了明确的草稿恢复降级路径。

| 阶段 | 状态 | 内容 | 预估 | 验收门槛 |
|---|---|---|---|---|
| **M0** | 已完成 | P0-0 目录确认 + 无参数交互启动 | - | PTY 覆盖首次确认、持久信任、拒绝和空任务启动 |
| **M4R** | 已完成 | P1-4b context 栈 + 多键和弦；保留现有用户配置 | - | 内层 surface 消费/阻断；和弦超时恢复；保留键不可覆盖 |
| **M5A** | 已完成 | P1-6a transcript alt-screen 骨架 | - | 进入/退出恢复 scrollback；inline 能力降级可用 |
| **M5B** | 已完成 | P1-6b `/` 检索 + `n/N` 跳转 + `y/Y` 复制 | - | 搜索高亮/循环跳转；OSC 52 不可用时显示复制内容 |
| **M6A** | 已完成 | P2-7：thinking、token 缓动、子 agent 树 | - | idle 无新增 timer；树行参与预算；工具运行不误报 stalled |
| **M6B** | 已完成 | P2-8：统一 `summary/condensed/truncated` 意图 | - | 新字段统一消毒；未声明字段的工具保持原渲染 |
| **M7** | 已完成（降级） | P1-6c 能力核查 + 历史用户输入恢复到草稿 | - | Harness 无公开 fork/rewind API；明确不宣称已回滚文件或会话 |

### 5.1 实际执行顺序

1. **M0**：它改变 startup contract 和端到端启动方式，后续所有 PTY 用例都以
   `dshcodecli` 无参数启动作为基线。
2. **M4R**：transcript 搜索会新增 `/`、`n/N`、`y/Y` 和模式切换，先有 context 栈与和弦
   状态机，避免再次把优先级硬编码进 `app.tsx`。
3. **M5A/M5B**：先证明 alt-screen 生命周期可靠，再加检索和复制；两阶段之间保留独立
   回滚点。
4. **M6A/M6B**：等待反馈使用工具意图，二者共享契约测试，便于定位渲染
   性能或兼容性回归。
5. **M7**：已核实 Harness 没有公开的 session fork/file rewind 能力，因此实现 `r` 恢复历史用户
   输入到草稿，不跨层私接内部 API，也不伪造回滚成功状态。

### 5.2 提交与验证策略

每个里程碑按“纯函数/契约 → view/launcher 接线 → PTY smoke → 文档”拆成可独立审查的提交。
M0 至少拆为：workspace trust 状态机与存储、startup 空任务语义、launcher 接线、PTY/installed
smoke 四个提交。任何阶段失败时只回退该阶段，不触碰 M1–M3 已稳定的折叠、审批和通知代码。

每阶段运行对应单元测试和 targeted smoke；合并前统一运行：

```bash
pnpm run check
```

涉及 launcher/package 的 M0 额外执行 packed-install、installed mode 和 Node 22/24 runtime matrix；
涉及 alt-screen 的 M5 额外做 SIGINT、SIGTERM、stdin EOF、异常抛出四种终端恢复测试。

**本次执行结果（2026-08-20）**：`npm run check` 与 Node 24.18.0 runtime matrix 全部通过；包括
569 项单元/交互测试、workspace trust PTY、四种交互尺寸/能力、resume、cancel、packed install、性能
预算和 10 秒 soak。锁定的 Node 22.23.2 因执行环境无法解析 npm registry 而未能下载；本机仅有、且
低于项目最低要求的 Node 22.12.0，其 569 项单测通过，但 Harness 交互启动因该版本没有
`node:zlib.createZstdDecompress` 而失败。该项是环境矩阵缺口，不是本次实现失败。

**贯穿性约束**（每个阶段都要守住的、dsh 现有的好性质）：

1. 渲染逻辑留在纯函数模块，`.tsx` 只负责画 —— 新增能力先写纯函数 + 测试。
2. idle 会话零 timer。
3. 帧可由 `(state, columns, rows, now)` 复现 —— 不引入随机性。
4. 永不按工具名分支，只按工具声明的意图。
5. 安全默认 fail-closed，审批不可用即拒绝。
6. 无颜色 / ASCII-only / 40 列 三条降级路径持续可用。
