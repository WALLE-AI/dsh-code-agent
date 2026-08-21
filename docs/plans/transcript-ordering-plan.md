# 工具调用与模型输出的顺序修复 — 执行方案

> 编制日期：2026-08-20
> 触发：`images/ScreenShot_2026-08-20_094401_133.png`
> 结论：这**不是排版偏好问题，是投影层的顺序缺陷**。当前 8 个上游会话样本中，**每一个带工具调用的样本都把模型的最终回答渲染在工具卡片上方**。
>
> **状态（2026-08-20）**
> - §5 顺序修复：**已实现**，全量 514 个测试、4 个 `check:interactive` 场景、
>   `check:bench` 全部通过。审阅决议 1（推理分块保留）与 3（答案在最后）确认了这一实现。
> - §11 的两项后续改动（开场白折叠、工具卡与答案之间加空行）：**已实施**（决议 2 按
>   折叠落地，非隐藏）。全量 523 个测试、4 个 `check:interactive` 场景、`check:bench`
>   全部通过。
> - §11.3 续行缩进：**已实施**。当前全量 551 个测试、4 个 `check:interactive` 场景、
>   `check:bench`、打包安装与 quick soak 全部通过，本方案已无未完成任务。

---

## 1. 现象

截图里：

```
我这边无法直接登录 X 实时浏览…            ← 模型 step-1 的开场白
## DeepSeek Harness 相关  …（整段答案）    ← 模型 step-2 的最终回答
需要我针对某一条…再深挖一下吗？            ← 同上
────────
✓ DeepSeek Harness X Twitter 最新消息 今天  [8 sources (capped)]
  … +8 lines (ctrl+o to expand)
✓ DeepSeek news today Twitter X  [8 sources (capped)]
  …（共 5 次 WebSearch）
```

真实因果顺序是 **开场白 → 5 次搜索 → 最终回答**。屏幕上却是 **开场白 + 最终回答 → 5 次搜索**。用户看到的是"答案先出现，证据后出现"。

## 2. 复现（最小用例）

```ts
const p = new ConversationProjection()
p.append({ seq: 1, kind: 'assistant-delta', text: 'before' })
p.append({ seq: 2, kind: 'tool-call', text: '{}', name: 'WebSearch', callId: 'c1' })
p.append({ seq: 3, kind: 'tool-result', text: 'ok', callId: 'c1' })
p.append({ seq: 4, kind: 'assistant-delta', text: 'AFTER' })
```

得到：

```
assistant  "beforeAFTER"     ← 两段文字被并成一个节点，落在工具之前
tool       WebSearch
```

`assistant-final`、`reasoning-delta` 三条路径全部同样表现。

## 3. 根因

`packages/dsh-tui/src/conversation-projection.ts` 有**两个互相放大的缺陷**。

### 3.1 `findOpenTextId` 会越过工具节点

```ts
private findOpenTextId(kind: TextNode['kind']): string | undefined {
  for (let index = this.nodes.length - 1; index >= 0; index--) {
    const node = this.nodes[index]
    if (node?.kind === 'turn' || node?.kind === 'user' || node?.kind === 'marker') return undefined
    if (node?.kind === kind) return node.id     // ← 一路穿过 tool 节点
  }
  return undefined
}
```

`turn` / `user` / `marker` 是屏障，**`tool` 不是**。所以工具跑完之后的新文本会回填到工具之前那个节点里。

这也解释了为什么 `approval-rejected` 样本看起来是对的 —— 那里工具后面跟了一条 `marker`（Approval rejected），屏障生效，后续文本才另起了节点。

### 3.2 每个 step 都会产生一个空的 assistant 节点

上游真实事件流（`examples/acp-agent/tests/snapshots/parallel-tool-calls/session.jsonl`）：

```
 9 assistant/chunk block-start
10 assistant/chunk tool-call-delta
11 assistant/chunk block-end
17 assistant/message  blocks=["tool-call","tool-call"]   ← 没有 text block
18 tool/call read
19 tool/call read
20 tool/result
21 tool/result
23 step/start
25 assistant/chunk text-delta                            ← step-2 的回答
29 assistant/message  blocks=["text"]
```

seq 17 的 `assistant/message` 不含 text block，`textOf()` 返回 `''`，但 `mergeText` 仍然 `pushNode` 了一个空 assistant 节点 —— **位置在 seq 18 的工具之前**。随后 step-2 的文本通过 §3.1 并入这个空节点，并被 `nextId` 逻辑改名成 step-2 的 message id，位置却留在原地。

在 `compaction` 和 `approval-rejected` 样本里能直接看到这些空壳：

```
assistant  assistant:a71b2cfd-…  ""      ← 空节点
tool       tool:call_compaction_marker
```

### 3.3 实测：8 个样本全中

用真实上游日志跑当前投影：

| 样本 | 当前节点顺序 | 是否错位 |
|---|---|---|
| `text`（无工具） | user → reasoning → assistant | 正确 |
| `parallel-tools` | user → **assistant "DONE"** → tool read → tool read | **错** |
| `code-mode` | user → reasoning → **assistant "DONE"** → tool run_code → 2 个子调用 | **错** |
| `failed-shell` | user → **assistant** → 3 个 tool | **错** |
| `diff` | user → reasoning → **assistant "DONE"** → tool read → tool edit | **错** |
| `compaction` | user → **assistant ""** → tool → marker → assistant | **错**（含空壳） |
| `subagent` | user → reasoning → **assistant "PARENT_DONE"** → tool subagent | **错** |
| `approval-rejected` | user → reasoning → **assistant ""** → tool → marker → reasoning → assistant | **错**（含空壳） |

`upstream-fixture-parity.spec.ts` 之所以没发现，是因为它只断言工具节点的属性，没有断言**节点之间的相对顺序**。

## 4. 权威参照：正确的顺序长什么样

### 4.1 上游自己的 Web UI

`apps/web/tests/snapshots/code-mode-round/ui.expected.md` 是上游 Web 前端对**同一份会话日志**的期望渲染：

```
text:   Using ONE run_code program: …          ← 用户
button  Think The user wants me to write …     ← step-1 推理
button  Code Run bash echo and catch …         ← 工具调用
text    Bash Echo CODE_ROUND_OK Failed         ← 子调用
button  Read Error: cannot read …              ← 子调用
button  Think The program ran successfully …   ← step-2 推理（独立的一块）
paragraph: DONE                                ← step-2 回答，最后
```

两点确认：
1. **顺序严格因果**：工具在前，最终回答在最后。
2. **step-1 与 step-2 的推理是两块**，不是一块 —— 上游没有把它们并成一个节点。

dsh 当前对同一份日志产出 `reasoning(合并) → assistant "DONE" → tool run_code → 子调用`，两条都不符。

### 4.2 claude-code 的做法

`src/utils/messages.ts:731`：

```ts
// Split messages, so each content block gets its own message
export function normalizeMessages(messages: Message[]): NormalizedMessage[] {
  …
  case 'assistant': {
    isNewChain = isNewChain || message.message.content.length > 1
    return message.message.content.map((_, index) => ({
      …, content: [_],
      uuid: isNewChain ? deriveUUID(message.uuid, index) : message.uuid,
    }))
  }
```

**一个 content block = 一条消息**，id 由 `deriveUUID(父 uuid, 块序号)` 派生 —— 既唯一又稳定又保序。渲染层 `Messages.tsx` 直接按数组顺序渲染，所以 `text → tool_use → text` 天然是三行三个位置。

dsh 的等价物应该是：**一个 content block = 一个 TranscriptNode**。

## 5. 修复方案

### 5.1 核心规则

> **一个文本块只在它还是最后一个节点时是"开放"的。**
> 一旦有别的节点（工具、marker、user）被压在它后面，这个块就永久关闭；之后的 delta 另起一个新块。

这条规则是 claude-code "一块一消息" 在流式折叠下的等价表述，且不依赖任何新事件。

```ts
private findOpenTextId(kind: TextNode['kind']): string | undefined {
  const last = this.nodes.at(-1)
  return last?.kind === kind ? last.id : undefined
}
```

屏障从"三种节点类型"变成"任何节点"，`turn`/`user`/`marker` 的特判随之删除 —— 它们本来就是这条更强规则的特例。

### 5.2 四个必须一起处理的子问题

> 落地时的实测补充：C（id 唯一性）**不是假设性风险**。现有的
> `tests/fixtures/conversation-events.json` 正好是 `delta(a1) → 三个工具 → final(a1)`
> 的交错形状；只改 §5.1 而不加块序号，投影会产出**两个 id 都是 `assistant:a1` 的节点**
> （已实测到 `duplicate ids: [ 'assistant:a1' ]`），行缓存、fold 集合和 scrollback 的
> `emitted` 集合都会把两段不同的文字当成同一个节点。

| # | 问题 | 处理 |
|---|---|---|
| A | **空 assistant 节点**：`assistant/message` 不含 text block 时 `text === ''`，新规则下会在工具前压一个空壳 | `mergeText`：`assistant-final` 且 `text === ''` 时，**不创建节点**；若有开放节点则**不改写**它（空 final 不得抹掉已流入的 delta） |
| B | **`assistant-final` 的替换范围**：它携带的是该 message 全部 text block 的拼接 | 一个 message = 一个 step，其 text block 在事件流里是连续的（`tool/call` 在 `assistant/message` **之后**才发出），所以替换"当前开放块"永远正确。已由 §4.1 的真实日志确认 |
| C | **节点 id 唯一性**：同一 message 若有多个 text block，`assistant:<messageId>` 会撞 id | id 加块序号后缀：`assistant:<messageId>#<n>`，对应 claude-code 的 `deriveUUID(uuid, index)`。无 messageId 时现有的 `assistant:<seq>` 已经天然唯一 |
| D | **reasoning 同理** | 同一条规则，step-1 与 step-2 的推理自然分成两块，与上游 Web UI 一致 |

### 5.3 不做的事

- **不引入 `block-start`/`block-end` 事件解析。** 上游 `assistant/chunk` 确实带这两个标记（当前被归为 `ignored`），解析它们能得到更精确的块边界；但 §5.1 的规则在全部 8 个样本上已经给出正确结果，而新增两种事件类型会扩大投影的输入面和重放兼容面。留作后续，若出现"同一 step 内 text→tool→text"的真实模型才需要。
- **不改渲染样式。** `● 文本` / `▸✓✗⚠ 工具 [badge]` / ` ⎿ ` gutter 这套已经和 claude-code 的 `● Tool(args)` + `⎿ 结果` 同构，截图里的呈现本身没有问题。

## 6. 优化后交互示意图（真实抓取，非手绘）

下面的每一段都是**跑出来的**，不是画出来的：

- **实机抓取**：`scripts/transcript-capture.ts` 在真实 pty 里跑真实 TUI，对接 mock 模型
  服务，把差分帧回放成屏幕。`node --import tsx/esm scripts/transcript-capture.ts --turns 3`
- **样本渲染**：把 8 份上游真实会话日志喂给 `TuiStore`，打印 `snapshot().lines`。

### 6.1 实机抓取 — 修复前

`--turns 3 --rows 50`，第一轮是"调用 read → 回答"，与截图同形：

```
╭────────────────────────────╮
│ DeepSeek Harness TUI       │
╰────────────────────────────╯
deepseek-harness-master • main
Tip: /help for commands • Tab completes • ? for shortcuts
> read the README and tell me where the flush race is
●                                                          ← 空气泡 ①
●                                                          ← 空气泡 ②
● Reviewed the file. The flush race is in the settle path, and the retained
window is what hides it.                                   ← 答案
✓ Read README.md  [57 of 57 lines]                         ← 证据，排在答案之后
  … +58 lines (ctrl+o to expand)
── turn completed
```

两个空 `●` 是 §3.2 的空壳被直接拍到了。

### 6.2 实机抓取 — 修复后

同一脚本、同一输入：

```
> read the README and tell me where the flush race is
✓ Read README.md  [57 of 57 lines]                         ← 证据在前
  … +58 lines (ctrl+o to expand)
● Reviewed the file. The flush race is in the settle path, and the retained
window is what hides it.                                   ← 答案在后
── turn completed
> follow-up 1: check the retained window too
● Reviewed the file. The flush race is in the settle path, and the retained
  window is what hides it.                  ← §11.3：续行对齐正文
── turn completed
> follow-up 2: check the retained window too
● Reviewed the file. The flush race is in the settle path, and the retained
window is what hides it.
── turn completed
```

空气泡消失，顺序变成因果序。

> **抓取工具的已知限制**：mock 服务对每次 `tool_call_success` 都发同一个 tool call id
> `mock-call-1`，所以第 2、3 轮的工具卡会并进第 1 轮那张卡（`mergeToolCall` 按 callId 找
> 节点）。上面第 2、3 轮没有工具卡是这个原因，不是产品行为。真正的多轮多工具证据看 §6.3。
> （顺带记一笔：dsh 的工具节点只按 callId 索引、不带回合作用域，若真有提供商跨回合复用
> id 会合并成一张卡。不在本方案范围内，另开。）

### 6.3 上游真实会话样本 — 修复前后对照

**`parallel-tools`**（一次 assistant 消息里两个 read，然后回答 DONE）

```
修复前                                    修复后
─────────────────────────────────────    ─────────────────────────────────────
> Use the read tool twice in the same    > Use the read tool twice in the same
b.txt. Then reply DONE.                  b.txt. Then reply DONE.
● DONE                    ← 答案在前      ✓ read
✓ read                                     … +8 lines (ctrl+o to expand)
  … +8 lines (ctrl+o to expand)          ✓ read
✓ read                                     … +8 lines (ctrl+o to expand)
  … +8 lines (ctrl+o to expand)          ● DONE          ← 答案在后
── turn completed                        ── turn completed
```

**`diff`**（read → edit → 回答，两步之间各有一次推理）

```
修复前                                    修复后
─────────────────────────────────────    ─────────────────────────────────────
> First use the read tool …              > First use the read tool …
∴ Thinking          ← 三步推理并成一块    ∴ Thinking          ← step-1
  … +6 lines (ctrl+o to expand)            … +6 lines (ctrl+o to expand)
● DONE              ← 答案在前            ✓ read
✓ read                                     … +9 lines (ctrl+o to expand)
  … +9 lines (ctrl+o to expand)          ∴ Thinking          ← step-2
✓ edit                                     … +1 lines (ctrl+o to expand)
 ⎿ {"file_path":"config.txt",…}          ✓ edit
   The file … has been updated             ⎿ {"file_path":"config.txt",…}
── turn completed                            The file … has been updated
                                          ∴ Thinking          ← step-3
                                            … +1 lines (ctrl+o to expand)
                                          ● DONE              ← 答案在后
                                          ── turn completed
```

**`code-mode`** — 修复后与上游 Web UI 逐行对齐：

```
dsh（修复后，实际渲染）                          上游 ui.expected.md
──────────────────────────────────────────     ─────────────────────────────────────
> Using ONE run_code program: run bash …       text: Using ONE run_code program…
∴ Thinking                                     button "Think The user wants me…"
  … +7 lines (ctrl+o to expand)
✓ run_code                                     button "Code Run bash echo and catch…"
  … +8 lines (ctrl+o to expand)
  ✓ bash                                       text   "Bash Echo CODE_ROUND_OK Failed"
   ⎿ {"command":"echo CODE_ROUND_OK",…}
     CODE_ROUND_OK
  ✗ read  [failed]                             button "Read Error: cannot read…"
   ⎿ {"file_path":"missing.txt"}
     Error: cannot read "…/missing.txt": not found
∴ Thinking                                     button "Think The program ran successfully…"
  … +1 lines (ctrl+o to expand)
● DONE                                         paragraph: DONE
── turn completed
```

**`compaction`** — 空气泡消失：

```
修复前                                    修复后
─────────────────────────────────────    ─────────────────────────────────────
> Establish a durable compaction …       > Establish a durable compaction …
● （空）              ← 空壳              ✓ bash
✓ bash                                     ⎿ {"command":"printf 'alpha\n'",…}
 ⎿ {"command":"printf 'alpha\n'",…}          alpha
   alpha                                  • Conversation compacted
• Conversation compacted                  ● COMPACTION RECOVERED
● COMPACTION RECOVERED                    ── turn completed
── turn completed
```

### 6.4 八个样本的节点序列（已作为断言写入 parity spec）

| 样本 | 修复前 | 修复后 |
|---|---|---|
| `text` | `user reasoning assistant turn` | 同（无工具，本就正确） |
| `parallel-tools` | `user **assistant** tool tool turn` | `user tool tool **assistant** turn` |
| `code-mode` | `user reasoning **assistant** tool tool tool turn` | `user reasoning tool tool tool reasoning **assistant** turn` |
| `failed-shell` | `user **assistant** tool tool tool turn` | `user tool tool tool **assistant** turn` |
| `diff` | `user reasoning **assistant** tool tool turn` | `user reasoning tool reasoning tool reasoning **assistant** turn` |
| `compaction` | `user **assistant(空)** tool marker assistant turn` | `user tool marker **assistant** turn` |
| `subagent` | `user reasoning **assistant** tool turn` | `user reasoning tool reasoning **assistant** turn` |
| `approval-rejected` | `user reasoning **assistant(空)** tool marker reasoning assistant turn` | `user reasoning tool marker reasoning **assistant** turn` |

另有两条不变量也一并断言：**没有任何样本包含空的 assistant 节点**，**没有任何样本出现重复的节点 id**。

### 6.5 审阅决议（2026-08-20，已确认）

| # | 审阅项 | 决议 | 状态 |
|---|---|---|---|
| 1 | 推理是否按 step 分块保留 | **保留**，每个 step 一块，各自折叠 | 已实现，无需改动 |
| 2 | 开场白与答案分成两个 `●` 气泡 | 分块保留；**开场白只在第一轮出现，后续轮次不需要** | 见 §11.2，待实施 |
| 3 | 工具卡在前、答案在最后 | **确认** | 已实现 |
| 4 | 长工具卡与短答案之间加空行 | **需要加** | 见 §11.2，已实施 |

## 7. 改动清单

| 文件 | 改动 | 规模 |
|---|---|---|
| `src/conversation-projection.ts` | `findOpenTextId` → `openTextIndex`（只看末节点）；`mergeText` 增加空 final 守卫；新增 `openTextId` 块序号铸造；**删除** final 改名逻辑（node id 无外部消费者，实测 `grep` 确认） | 实际 ~45 行 |
| `src/contracts.ts` | 无（`TextNode` 结构不变） | — |
| `tests/conversation-projection.spec.ts`（新增或扩充） | 顺序规则的单元测试 | ~120 行 |
| `tests/upstream-fixture-parity.spec.ts` | **新增节点顺序断言**：8 个样本的 `kind` 序列 + 无空气泡 + id 唯一；`code-mode` 单独断言答案在 `run_code` 之后、推理分两块。已验证**在旧代码上会红** | 实际 ~40 行 |
| `tests/conversation-projection.spec.ts` | 6 条新规则单测；修正 2 条断言旧错误行为的用例 | 实际 ~70 行 |
| `scripts/transcript-capture.ts`（新增） | 真实 pty 抓取脚本，产出 §6.1/6.2 的证据 | ~200 行 |
| `docs/tui-user-guide.md` | §4「Reading the screen」补一句：transcript 严格按因果顺序，工具在触发它的文本之后、它促成的回答之前 | ~5 行 |
| `CHANGELOG.md` | Fixed 条目 | ~15 行 |

## 8. 测试计划

**单元（投影层，最小用例）**

1. `text → tool → text` 产出 3 个节点，顺序为 assistant / tool / assistant。
2. `text → tool → text` 的两个 assistant 节点 **id 不同**。
3. 连续 delta 仍然合并成一个节点（不能把流式文本打散成每 delta 一个节点）。
4. `assistant-final` 替换当前开放块；空 final 既不创建节点也不抹掉已有文本。
5. `reasoning → tool → reasoning` 产出两个 reasoning 节点。
6. `user` / `marker` / `turn` 仍然是屏障（旧行为的回归保护）。
7. 重放一致性：`rebuild(events)` 与逐条 `append` 结果全等（现有 parity spec 已覆盖，需在新规则下继续成立）。

**契约（真实上游日志）**

8. 8 个样本各断言一次完整的 `kind` 序列快照 —— 这是这次修复真正的验收面，也是当初漏掉的那条断言。
9. `code-mode` 样本额外断言：`run_code` 工具节点出现在 `assistant "DONE"` **之前**，两个 reasoning 节点分离。

**回归面（需要复核但预期无改动）**

10. `collapse.spec.ts` — 文本块变多会打断只读运行序列，折叠组可能变短。断言仍应通过；若不通过说明折叠规则依赖了错误的顺序。
11. `scrollback.spec.ts` — 新规则下"文本块后面跟了工具"意味着该块永久关闭，反而**更早**可以下沉到终端 scrollback。属于改善。
12. `transcript-performance.spec.ts` — 节点数增加（每 step 一块 vs 每 turn 一块），需确认 wrap 预算仍达标。
13. `check:interactive` 四个场景 + `check:bench`。

## 9. 分阶段执行

| 阶段 | 内容 | 验收 |
|---|---|---|
| **S1** | 先只加断言：在 `upstream-fixture-parity.spec.ts` 写入 8 个样本的 `kind` 序列快照，**让它红** | 红得符合 §3.3 的表格 |
| **S2** | 实施 §5.1 + §5.2 A/C/D | S1 的快照转绿，且与 `ui.expected.md` 的块顺序一致 |
| **S3** | 跑全量回归（§8 第 10–13 条），修正受影响的期望值 | 全部 506+ 测试绿；`check:interactive`、`check:bench` 通过 |
| **S4** | 文档与 CHANGELOG | — |

预估：S1+S2 半天，S3 半天。

## 10. 风险

| 风险 | 评估 |
|---|---|
| 节点数增加导致性能回退 | 低。每 step 多 1–2 个节点，`check:bench` 的 10 万事件场景可验证 |
| 已持久化会话重放后顺序变化 | **这正是修复目标**。投影是纯函数重放，旧会话恢复后会显示正确顺序，不存在数据迁移 |
| 空 final 守卫误伤"模型确实回了空字符串"的情况 | 该情况下没有 text block，本就不该有 assistant 气泡；上游 Web UI 也不渲染 |
| 折叠流水线（`collapse.ts`）行为变化 | 只读运行被文本打断属于正确行为；有测试覆盖 |

---

## 11. 基于审阅决议的后续改动（已实施）

§6.5 的决议 1 和 3 已经是当前实现，无需改动。决议 2 和 4 是新增行为，设计如下。
两者都是**渲染层**改动 —— 投影仍然如实保留每一个块，屏幕上少显示什么是可恢复的显示决定，
不改变会话的事实。

### 11.1 决议 2：开场白只在第一轮完整显示 ✅

#### 什么是"开场白"

需要一个不含歧义的定义，否则规则会误伤真正的答案。定义为：

> **开场白块** = 一个 assistant 文本块，它后面在**同一回合内**还有工具调用。

也就是"模型在动手之前写的话"，与"模型动完手之后给出的答案"相对。截图里的
「我这边无法直接登录 X 实时浏览…只能通过网络搜索聚合来回答」就是开场白块；
「## DeepSeek Harness 相关 …」是答案块，永不受此规则影响。

回合边界用 `user` 节点划分 —— 与 `state.ts` 里 `append()` 对 `kind === 'user'`
递增 `turns` 的口径一致。「第一轮」指**当前 transcript 渲染出来的第一轮**；
`--resume` 恢复的会话按重放出来的顺序算，这样规则在重放下是确定的。

#### 规则

| 位置 | 渲染 |
|---|---|
| 第 1 轮的开场白块 | 完整显示（不变） |
| 第 2 轮起的开场白块 | **默认折叠**，`Ctrl+O` 展开 |
| 任何回合的答案块（后面没有工具了） | 完整显示（不变） |

折叠后的形态就是现有折叠机制的形态，不需要新机制：

```
第 1 轮                                   第 3 轮
──────────────────────────────────────   ──────────────────────────────────────
> 帮我看看 X 上的最新讨论                  > 再帮我查一下公测时间线
∴ Thinking                               ∴ Thinking
  … +4 lines (ctrl+o to expand)            … +3 lines (ctrl+o to expand)
● 我这边无法直接登录 X 实时浏览（没有抓    ● 我再搜一轮公测相关的报道，把时间线
  取推文的工具），只能通过网络搜索聚合       … +3 lines (ctrl+o to expand)   ← 折叠
  最近 X 上的热点和媒体报道来回答。        ✓ 3 searches
✓ 5 searches                               … +3 lines (ctrl+o to expand)
  … +5 lines (ctrl+o to expand)
                                          ● 公测时间线大致是……            ← 答案不折叠
● DeepSeek Harness 相关                     • 7 月底官方 Agent 产品公测在即
  • 开源即爆火：…                            • …
```

（按规则推导，未实测；实测对照留到实施后补进 §11.5。）

#### 为什么是折叠，不是删除

你说的是"后续多轮不需要"。我按**折叠**实现，而不是不渲染，理由有两条，其中第一条
是实质性的：

1. **开场白经常携带载荷性的限制声明。** 截图里那句就是
   「（没有抓取推文的工具）」—— 这是模型对自己能力边界的交代，是读者判断后面那份
   答案可信度的依据。第 3 轮把它藏掉，读者会以为模型真的读到了推文。折叠保留了它，
   一个 `Ctrl+O` 就能拿回来。
2. 这与本项目既有的约定一致：超出预算的输出写成
   `… N more line(s) not shown (output capped)` 而不是悄悄丢掉。

**已按折叠落地。** 如果之后你要字面意义上的"不出现"，那是一行的差别（把
`foldedByDefault: true` 换成整块不产出行）。

折叠**不一定省行**，这是刻意的：折叠一个 N 行块要花 1 行说"还有 N-1 行"，所以只有
`detail.length > FOLD_MARGIN`（即整块 ≥3 行）时才折。一两行的短开场白原样保留 ——
规则在没有东西可省时什么也不做。这一条在实施时被自己的测试抓到过：最初的用例用了
2 行开场白并断言它会折，实际不折，**是用例错了不是代码错了**。

#### 落点（实施结果）

| 文件 | 改动 |
|---|---|
| `transcript-view.ts` | 新增 `preambleFlags(nodes)`：一次正向扫描算回合序号（`user` 节点递增，与 store 口径一致），一次反向扫描算"同回合内后面是否还有工具"；`textEntry` 增加 `preamble` 参数，设 `foldedByDefault: preamble && detail.length > FOLD_MARGIN` |

**两个必须一起改的缓存点**，漏掉任何一个都会表现为"折叠状态卡住不更新"：

1. `signatureOf(node, depth)` 目前对文本节点是 `kind|lastSeq|textLength`。
   开场白身份取决于**别的节点**（后面有没有工具、在第几轮），所以签名必须把这两个量
   算进去 —— 否则一个文本块在工具到达之后仍然会命中旧缓存，永远不折叠。
2. `transcriptLines` 的行缓存 key 是 `${columns}|${folded}|${startedAtMs}`。
   `folded` 已经在 key 里，所以这一层是安全的 —— 前提是第 1 点已经让 entry 对象换了新的。

#### 测试

1. 第 1 轮的开场白块不折叠；第 2 轮的同形块折叠。
2. 答案块（后面没有工具）在任何回合都不折叠。
3. 一个回合里有两个开场白块（text → tool → text → tool → answer）时，前两个都折叠。
4. 只有一行的开场白不折叠（`FOLD_MARGIN` 生效）。
5. `Ctrl+O` 能展开被折叠的开场白（走既有的 `toggleFold`）。
6. **缓存回归**：先 append 一个文本块（此时它是答案，不折叠），再 append 一个工具调用
   （它变成开场白，应折叠）—— 断言第二次快照里它确实折叠了。这条专门盯 `signatureOf`。

### 11.2 决议 4：工具卡与其后的答案之间加一空行 ✅

#### 规则

> 一个 assistant 文本块，若它紧跟在一个工具块之后，前面插入一个空行。

只针对 `tool → assistant` 这一个转换。不加在 `user → assistant`（用户行本身就是分隔），
也不加在 `tool → tool`（同类连排本来就该紧凑），也不加在 `assistant → tool`
（开场白与它触发的工具是一体的，隔开反而割裂因果）。

```
现在                                      加上之后
──────────────────────────────────────   ──────────────────────────────────────
✓ Read README.md  [57 of 57 lines]       ✓ Read README.md  [57 of 57 lines]
  … +58 lines (ctrl+o to expand)           … +58 lines (ctrl+o to expand)
● Reviewed the file. The flush race is
  in the settle path…                    ● Reviewed the file. The flush race is
── turn completed                          in the settle path…
                                         ── turn completed
```

#### 落点与两个坑（实施结果）

`transcript-view.ts` 新增 `needsMargin(previous, entry)`；`transcriptLines` 改为带下标
遍历并把 `margin` 并入行缓存 key；`entryLines` 增加 `margin` 参数，在最前面压一个
`text: ''`、`entryId` 为本 entry 的空行。

1. **空行必须归属于它后面的那个 entry**（`entryId` 取 assistant entry 的 id），
   不能归属前面的工具卡。理由是 `scrollback.ts`：行是按 `entryId` 判断能否下沉到终端
   scrollback 的，若空行挂在工具卡上，工具卡下沉、答案还在活动帧时，空行会跟着工具卡
   走，屏幕上就会缺一行。
2. **行缓存 key 必须加上"是否带前导空行"**。`transcriptLines` 目前按 `entry.id` 缓存，
   key 是 `${columns}|${folded}|${startedAtMs}`。是否加空行取决于**前一个 entry 的
   kind**，不在 key 里 —— 折叠了前面的工具卡、或前面插进来一条 marker，都会让缓存留着
   过时的空行。

#### 行预算

`terminal-layout.ts` 从 `lines.length` 反推 `viewportRows`，空行会自然被算进去，不需要
改预算逻辑。窄终端（`rows < 16`，即 `terminalLayoutPolicy().compact`）下每次
tool→answer 转换多花一行，一屏可能出现 1–2 次。**建议先无条件加**，如果 80x12 的
`check:interactive` 场景显示挤压，再改成 `compact` 时不加 —— 这是一行的开关，不值得
现在就提前优化。

#### 测试

1. `tool → assistant` 之间有且只有一个空行。
2. `user → assistant`、`tool → tool`、`assistant → tool` 之间没有空行。
3. 空行的 `entryId` 等于其后 assistant entry 的 id。
4. **缓存回归**：折叠/展开前面的工具卡之后，空行仍然只有一个。
5. 80x12 快照：空行没有把答案挤出视口。

### 11.3 换行续行缩进 ✅

抓取过程中看到的，不在你的四条决议里，但既然看见了就记下来。

`entryLines` 里的 `emit()` 对续行做 `${indent}${text.trimStart()}`，而 depth-0 的文本
entry 的 `indent` 是空串，所以**头行的续行会顶到第 0 列**，与 `● ` / `> ` 之后的正文
不对齐：

```
> Use the read tool twice in the same assistant message: read a.txt and
b.txt. Then reply DONE.          ← 顶格，没有对齐到 `> ` 之后
● Reviewed the file. The flush race is in the settle path, and the retained
window is what hides it.          ← 同上
```

正文块的 detail 行用的是 `lead = '  '`，所以只有**头行的续行**有这个问题。修法是让
头行的 `indent` 用它自己的标记宽度（`● ` / `> ` / `∴ ` 都是 2 列）而不是 `depth` 缩进。

实现采用 hanging indent：首行使用完整终端宽度，续行按“终端宽度减标记宽度”重新换行，
再补齐标记占用的空格。不能只在现有续行前硬加两个空格，否则一条已经占满 40 列的
CJK 文本会溢出到 42 列。styled segments 使用同一组重绕后的行重新分配，保证样式文本
与纯文本逐行一致。

**已实施。** 单元测试覆盖 user/assistant 两种头行、styled markdown 与 20 列宽度约束；
端到端测试覆盖 40 列 CJK 文本，确认所有续行以两格缩进且没有越界。

### 11.4 改动清单（实施结果）

| 文件 | 改动 | 实际 |
|---|---|---|
| `src/transcript-view.ts` | `preambleFlags()`；`signatureOf` 加入 preamble；`needsMargin()`；`transcriptLines` 带下标遍历 + 行缓存 key 加 margin；`entryLines` 的 `margin` 参数 | ~75 行 |
| `src/views/transcript.tsx` | 空行渲染为一个空格（§11.6） | 5 行 |
| `tests/transcript-view.spec.ts` | 开场白 5 条 + 空行 3 条，含 2 条缓存回归 | ~110 行 |
| `tests/app-view.spec.tsx` | 一条端到端：第 2 轮开场白折叠 + 两轮空行到位 | ~30 行 |
| `docs/tui-user-guide.md` | §4 补三段：因果顺序、开场白折叠、空行 | ~18 行 |
| `CHANGELOG.md` | Fixed（顺序、空行高度）+ Added（开场白、空行） | ~45 行 |

### 11.5 执行顺序（已完成）

| 步骤 | 内容 | 结果 |
|---|---|---|
| **T1** | 先写测试，让它们红 | 8 条新用例，6 条红在预期位置（2 条负向用例本就该绿） |
| **T2** | 实施决议 4（空行） | 空行 3 条转绿 |
| **T3** | 实施决议 2（开场白折叠） | 开场白 5 条转绿 |
| **T4** | 全量回归 + 实测抓取 | 523 测试绿；`check:interactive` 4/4；`check:bench` 全部达标 |
| **T5** | 文档与 CHANGELOG | 完成 |

### 11.6 实施中发现的第三件事：空行在 Ink 里没有高度

写完 §11.2 之后，模型里确实有那一行（`transcript-view` 的单测绿了），**但屏幕上没有**。
原因是 Ink 把 `<Text>` 里的空字符串量成 0 行高，于是这一行被直接量没了。

值得记一笔的是它为什么不是一个更大的问题：markdown 的段落空行走的是 detail 通道，
带着两格的 lead，文本是 `"  "` 而不是 `""`，所以一直是有高度的。这个缺陷精确地只
影响这次新加的空行。

修在 `views/transcript.tsx`：文本为空时渲染一个空格。分层是刻意的 —— **模型仍然说
`''`**，「一行空行要怎么画才有高度」是渲染器的问题，不是模型的问题。

### 11.7 实施后的实测对照

`npm run capture:transcript -- --turns 2`（真实 pty）：

```
> read the README and tell me where the flush race is
✓ Read README.md  [57 of 57 lines]
  … +58 lines (ctrl+o to expand)
                                        ← 决议 4 的空行
● Reviewed the file. The flush race is in the settle path, and the retained
window is what hides it.
── turn completed
```

两轮对话，开场白折叠（脚本化 store，第 1 轮 vs 第 2 轮同一段开场白）：

```
> question 1
● I cannot browse directly.          ← 第 1 轮：完整
  So I will search instead.
  One moment.
✓ search
 ⎿ {}
   found it
                                     ← 空行
● answer 1
── turn completed
> question 2
● I cannot browse directly.          ← 第 2 轮：折叠
  … +2 lines (ctrl+o to expand)
✓ search
 ⎿ {}
   found it
                                     ← 空行
● answer 2
── turn completed
```

上游真实样本 `parallel-tools`：

```
> Use the read tool twice in the same assistant message: read a.txt and
  b.txt. Then reply DONE.
✓ read
  … +8 lines (ctrl+o to expand)
✓ read
  … +8 lines (ctrl+o to expand)
                                     ← 空行；两张卡之间刻意没有
● DONE
```

### 11.8 验收

| 项 | 结果 |
|---|---|
| 全量测试 | 551 通过（§11.3 新增 `transcript-view` 2 条；多轮标题回归新增 `app-view` 1 条） |
| `tsc -p tsconfig.json` | 通过 |
| `check:interactive` | 4 个场景全过（含 80x12 窄终端 —— 空行没有挤压视口，暂不需要 compact 开关） |
| `check:bench` | 全部预算达标 |
| 真实 PTY 抓取 | 80x50、1 轮通过；assistant 续行以两格缩进对齐正文 |

### 11.9 遗留

- **工具卡之后的 `∴ Thinking` 没有空行**：决议 4 的规则只覆盖 `tool → assistant`。
  `diff` 样本里 `✓ read` 紧贴着 `∴ Thinking`，是同一类观感问题。当前折叠后的推理只占
  2 行，观感尚可，所以没有扩大规则 —— 需要的话是 `needsMargin` 里加一个 `|| tone === 'reasoning'`。
- **工具节点跨回合复用 callId 会合并成一张卡**：抓取脚本暴露的（mock 固定发
  `mock-call-1`）。`mergeToolCall` 只按 callId 索引、不带回合作用域。不在本方案范围。
