# DeepSeek Harness - Code Agent - DSH Code TUI 三层架构设计

> 目标：基于 `opensource/deepseek-harness/deepseek-harness-master` 构建独立的编码 Agent 能力层，由 `dsh-code-tui` 提供人机交互，由 headless surface 接入 `benchmark` 进行可重复评测。
>
> 设计原则：Harness 保持通用，Code Agent 拥有编码策略，TUI 只拥有交互，Benchmark 独立验证结果。

## 1. 架构结论

不建议将系统设计成严格的线性链路：

```text
Harness -> Code Agent -> TUI -> Benchmark
```

更合理的结构是“三层运行架构 + 独立评测面”：

```text
                    +-- dsh-code-tui
DeepSeek Harness ---+-- dsh-code-agent
                    +-- dsh-code-headless --- Benchmark / Harbor
```

TUI 和 Benchmark 复用同一个 Code Agent，只是 surface 不同。Benchmark 不通过 TUI 运行，避免把 PTY、Ink 渲染、按键交互和终端生命周期当成编码能力的一部分。

```text
+-------------------------------------------------------------+
| 第三层：Surface                                             |
|                                                             |
| dsh-code-tui              dsh-code-headless                 |
| 人机交互、审批、会话恢复     JSONL 事件、无人值守、退出码    |
+--------------------------+----------------------------------+
                           | CodeAgentPort / SessionEvent
+--------------------------v----------------------------------+
| 第二层：dsh-code-agent                                    |
|                                                             |
| Agent 配置  Prompt 策略  Repo 上下文  Skills  编码工具组合 |
| 任务规划   修改策略    测试策略    子 Agent  失败恢复     |
| 运行预算   结果判定    Telemetry   Code Agent Bundle       |
+--------------------------+----------------------------------+
                           | Harness 公开服务 / Cordis composition
+--------------------------v----------------------------------+
| 第一层：deepseek-harness-master                           |
|                                                             |
| Agent loop  LLM  Session  Tool registry  Sandbox            |
| Approval    Compaction  Persistence  Subagent  Workflow      |
+-------------------------------------------------------------+

+-------------------------------------------------------------+
| 独立评测面：benchmark                                      |
| Dataset -> Sandbox -> Headless runner -> Verifier -> Report  |
+-------------------------------------------------------------+
```

## 2. 设计目标与非目标

### 2.1 目标

- 在不复制 Harness Agent loop 的前提下提高编码任务完成率。
- TUI 和 headless 运行共享完全相同的编码策略和工具组合。
- 通过独立 verifier 评价 workspace 最终状态，不依赖 Agent 的自我声明。
- 支持基线、消融实验、回归评测和成本分析。
- 保持 Harness 上游升级边界，使上游更新主要由适配和兼容门禁吸收。

### 2.2 非目标

- 不在 TUI 中实现编码决策或独立 Agent loop。
- 不为 Benchmark 制造另一套 Agent 逻辑。
- 不默认 fork 或修改 Harness 内部事件格式。
- 不把所有编码规则都塞进一个超长 system prompt。
- 不把 Agent 最终回答中的“已完成”视为任务通过。

## 3. 第一层：DeepSeek Harness 内核

`opensource/deepseek-harness/deepseek-harness-master` 作为通用 Agent 运行时，原则上保持只读。

### 3.1 Harness 负责的能力

- Agent loop 与模型请求。
- Agent create、resume、followup、steer、cancel 和 dispose。
- SessionEvent、session projection 和持久化。
- Bash、文件系统、LSP、搜索等工具注册机制。
- sandbox、approval、permission preset。
- token meter、compaction 和 checkpoint。
- subagent、workflow、Ralph 等通用编排能力。
- Cordis Loader、profile、bundle 和 patch overlay。

### 3.2 Harness 不负责的能力

- 针对本产品的编码人格。
- “修复后必须如何测试”等产品级行为策略。
- 任务类型识别和编码质量门禁。
- TUI 或 Benchmark 的 surface 特定行为。

### 3.3 上游修改准入条件

只有同时满足以下条件的能力才应该上移到 Harness：

1. 它不仅服务 Code Agent，还能被其他 surface 复用。
2. 它属于运行时语义，而不是产品策略。
3. 无法通过公开 Cordis service、tool、projection 或 bundle 扩展实现。
4. 拥有独立 contract test，并且不要求 TUI 或 Benchmark 参与。

## 4. 第二层：dsh-code-agent 能力层

Code Agent 层是产品的核心能力层。它将 Harness 的通用能力组合成面向软件工程任务的 Agent。

### 4.1 建议目录

```text
packages/
|-- dsh-code-agent/
|   |-- src/
|   |   |-- contracts.ts
|   |   |-- runtime.ts
|   |   |-- task-policy.ts
|   |   |-- context-policy.ts
|   |   |-- verification-policy.ts
|   |   |-- recovery-policy.ts
|   |   |-- budget-policy.ts
|   |   |-- telemetry.ts
|   |   `-- projections.ts
|   |-- prompts/
|   |   |-- persona.md
|   |   |-- coding.md
|   |   `-- verification.md
|   |-- skills/
|   |-- cordis.patch.yml
|   |-- package.json
|   `-- README.md
|-- dsh-code-headless/
`-- dsh-tui/
```

### 4.2 主要模块

#### 4.2.1 Repo Context

负责用有界方式向模型提供仓库信息：

- 发现 `AGENTS.md`、README、构建配置和项目约束。
- 识别主要语言、package manager、构建系统和测试框架。
- 收集 git status、已有 diff 和用户未提交改动。
- 先搜索再读取，不一次性注入整个仓库。
- 按任务相关性和 token 预算选择上下文。
- 在 resume 时检测工作区和指令变化。

#### 4.2.2 Task Policy

建议的默认工作流：

```text
理解请求
  -> 勘察仓库
  -> 定位相关代码
  -> 形成修改策略
  -> 编辑
  -> 运行定向验证
  -> 检查 diff
  -> 必要时修正
  -> 输出事实性结果
```

这个流程不应该实现为完全僵硬的状态机。启发式决策由模型完成，可机械检查的事实由代码保证。例如：

- 可以由模型决定是先读测试还是先读实现。
- 不允许模型在没有对应 command record 时声称“测试已通过”。
- 如果修改了文件，结束前必须至少执行 diff review。

#### 4.2.3 Tool Composition

优先复用 Harness 现有能力：

- `dsh-tool-fs`
- `dsh-bash-local` / subprocess
- `dsh-tool-lsp`
- `dsh-tool-todo`
- `dsh-subagent`
- `dsh-tool-workflow`
- session projection
- filesystem observation policy

只对确实缺失且能产生结构化价值的能力新增工具，例如：

```text
repo_inspect       识别仓库结构、语言和建议门禁
test_discover      将改动映射到可能的定向测试
test_run           返回结构化测试结果和失败摘要
diff_review        结构化描述改动、风险和无关文件
diagnostic_collect 归一编译器、测试和 LSP 诊断
```

工具应返回结构化结果，避免无限向模型提供大段终端输出。

#### 4.2.4 Verification Policy

Code Agent 的“完成”应是可检查的运行结果：

```ts
export interface CodeAgentResult {
  status: 'completed' | 'blocked' | 'failed'
  sessionId: string
  changedFiles: string[]
  checks: Array<{
    command: string
    exitCode: number
    durationMs: number
    outputDigest?: string
  }>
  unresolvedIssues: string[]
  usage: {
    inputTokens: number
    outputTokens: number
    cachedTokens?: number
    modelRequests: number
    toolCalls: number
  }
}
```

Verification Policy 负责：

- 根据改动选择最小有效测试集。
- 必要时扩大到 typecheck、lint、build 或更广测试。
- 记录真实执行的命令、退出码和持续时间。
- 区分“未运行”“运行失败”“基线已失败”。
- 不将 Agent 文本回答当成验证证据。

#### 4.2.5 Recovery Policy

- 单工具超时和整体超时。
- 重复读取、重复失败命令和循环编辑检测。
- 测试失败后的有限重试。
- compaction 后保留任务目标、已改文件和未完成验证。
- 无法继续时输出结构化 blocker，不伪装完成。

#### 4.2.6 Budget Policy

每次运行至少应包含：

```ts
export interface CodeAgentBudget {
  maxWallTimeMs: number
  maxModelRequests: number
  maxInputTokens?: number
  maxOutputTokens?: number
  maxToolCalls: number
  maxSubagentDepth: number
  maxConcurrentSubagents: number
  maxRecoveryAttempts: number
}
```

开发模式可放宽预算，Benchmark 必须固定预算，否则不同版本的成绩不可比。

### 4.3 Code Agent 端口

Surface 不应该直接操作 Code Agent 内部实现，而应依赖稳定端口：

```ts
export interface CodeAgentRequest {
  task: string
  cwd: string
  model?: string
  permissionPreset: string
  budget: CodeAgentBudget
  resumeSessionId?: string
  metadata?: Record<string, string>
}

export interface CodeAgentRun {
  readonly sessionId: string
  events(): AsyncIterable<CodeAgentEvent>
  steer(message: string): void
  cancel(reason: string): void
  result(): Promise<CodeAgentResult>
  dispose(): Promise<void>
}

export interface CodeAgentPort {
  start(request: CodeAgentRequest): Promise<CodeAgentRun>
  resume(request: CodeAgentRequest): Promise<CodeAgentRun>
}
```

`CodeAgentEvent` 应尽量由 Harness `SessionEvent` 和 registered projection 归一化得到，不创造与 Harness 争夺真相来源的第二份会话日志。

### 4.4 Prompt、Policy 和 Tool 的分工

| 类型 | 适合放置的内容 | 不适合放置的内容 |
|---|---|---|
| Prompt | 角色、默认工作方式、输出风格 | 可以由代码强制的安全和验证规则 |
| Policy | 预算、验证证据、循环检测、权限边界 | 需要语义理解的代码设计决策 |
| Tool | 结构化外部操作、可观测事实 | 用一个巨型工具代替所有 Agent 推理 |
| Skill | 特定领域、框架或任务方法 | 每轮都必须注入的全局规则 |

## 5. 第三层：Surface

### 5.1 dsh-code-tui

TUI 继续负责：

- 用户输入、快捷键和补全。
- transcript、tool card、diff 和 markdown 渲染。
- approval 和 structured question UI。
- session 浏览、恢复和运行状态。
- steer、cancel 和有界关闭。
- 终端尺寸、scrollback、鼠标和 raw mode 生命周期。

TUI 不负责：

- 决定要读哪些源码。
- 决定应运行哪些测试。
- 定义编码完成标准。
- 实现与 headless 不同的 Agent 策略。

依赖关系：

```text
dsh-tui
  |-- dsh-code-agent/contracts
  `-- dsh-code-agent bundle
          `-- DeepSeek Harness
```

### 5.2 dsh-code-headless

Headless surface 用于 CI、Benchmark 和自动化，它不需要 TTY。

建议命令形式：

```bash
dsh-code-headless run \
  --task-file /task/instruction.md \
  --workspace /app \
  --result /trial/result.json \
  --events /trial/events.jsonl \
  --permission danger-full-access \
  --budget /trial/budget.json
```

输出约定：

- `result.json`：规范化 `CodeAgentResult`。
- `events.jsonl`：用于运行分析的规范化事件。
- Harness session：保留原始、可回放事件。
- `stderr`：基础设施和运行诊断。
- 进程退出码：表示 runner 是否正常完成，不表示任务是否正确。

任务是否正确必须由独立 verifier 判定。

## 6. Benchmark 评测面

Benchmark 是运行架构的外部消费者，不是 Code Agent 的生产依赖。

### 6.1 运行链路

```text
Dataset task
   |
   |-- instruction
   |-- workspace image
   |-- resource limits
   `-- hidden verifier
           |
           v
 Isolated task container
           |
           v
 dsh-code-headless
           |
           |-- result.json
           |-- events.jsonl
           |-- session log
           `-- workspace changes
           |
           v
 Separate verifier container
           |
           v
 Trial record -> Aggregator -> Report
```

### 6.2 数据集目录

```text
benchmark/
|-- datasets/
|   `-- code-agent-v1/
|       |-- dataset.toml
|       |-- splits/
|       |   |-- development.txt
|       |   |-- validation.txt
|       |   `-- test.txt
|       `-- tasks/
|           `-- <task-id>/
|               |-- task.toml
|               |-- instruction.md
|               |-- environment/
|               |   `-- Dockerfile
|               |-- tests/
|               |   `-- verifier
|               `-- solution/
|                   `-- reference.patch
|-- adapters/
|   `-- dsh-code-headless/
|-- runners/
|-- schemas/
|   |-- trial.schema.json
|   `-- result.schema.json
|-- reports/
`-- artifacts/
```

`development` 集可用于调试 Code Agent；`validation` 用于版本准入；`test` 的 verifier 和关键任务应隔离，降低对 Benchmark 的过拟合。

### 6.3 任务类型

建议数据集覆盖：

- Bug 修复。
- 功能实现。
- 跨文件重构。
- 测试补全。
- 性能优化。
- 并发与数据一致性。
- 构建和依赖故障。
- 安全修复。
- 大仓库代码定位。
- 多语言或跨运行时工程。

任务元数据至少包含：

```toml
[task]
id = "typescript-session-race"
category = "bug-fix"
language = "typescript"
difficulty = "hard"

[agent]
timeout_sec = 3600
max_model_requests = 80
max_tool_calls = 300

[environment]
cpus = 2
memory_mb = 4096
network = "none"

[verifier]
environment_mode = "separate"
timeout_sec = 300
```

### 6.4 Verifier 原则

- verifier 运行在与 Agent 分离的环境。
- Agent 不能读取 hidden tests、oracle 或 reference patch。
- 默认关闭 verifier 网络。
- 优先验证行为和不变量，不仅比较文本 diff。
- 可区分部分得分的任务使用明确 rubric，不使用含糊的 LLM 主观判分作为主指标。
- oracle 基线应接近 100%，nop 基线应接近 0%。
- 验证失败应输出机器可读原因，但不泄漏 hidden test 实现。

### 6.5 指标

#### 主指标

- pass@1。
- 多次独立 trial 的任务成功率。
- 按类型、语言和难度分组的成功率。

#### 效率指标

- input/output/cache token。
- 模型请求次数。
- wall time。
- 工具调用数。
- 测试运行次数。
- 成功任务的平均成本。

#### 工程质量指标

- hidden tests 和回归测试通过率。
- patch size 和无关文件修改。
- 是否真正执行验证。
- lint/typecheck/build 状态。
- sandbox 和权限违规次数。

#### 稳定性指标

- Agent timeout。
- Harness fault。
- 工具异常。
- 无效重复操作。
- session/compaction 恢复失败。
- headless runner 基础设施失败。

### 6.6 Trial 记录

每次 trial 必须记录完整 provenance：

```json
{
  "trialId": "uuid",
  "taskId": "typescript-session-race",
  "datasetVersion": "code-agent-v1.0",
  "harnessCommit": "...",
  "codeAgentCommit": "...",
  "tuiVersion": null,
  "surface": "headless",
  "model": "deepseek/deepseek-v4-pro",
  "reasoningEffort": "max",
  "permissionPreset": "danger-full-access",
  "budget": {},
  "seed": 1,
  "startedAt": "...",
  "durationMs": 0,
  "agentStatus": "completed",
  "verifierScore": 0,
  "usage": {},
  "artifacts": {}
}
```

没有 Harness commit、Code Agent commit、模型路由、预算和数据集版本的成绩不应进入正式报告。

## 7. 对照与消融实验

不能只评估最终 Code Agent。建议长期保留四组配置：

```text
A. Harness headless 基线
B. A + Code Agent persona/prompt
C. B + repo context + verification policy
D. C + skills + subagent/workflow
```

对照组必须固定：

- 相同模型和 reasoning effort。
- 相同任务容器和 verifier。
- 相同权限、网络和资源限制。
- 相同 token、轮次和 wall-time 预算。
- 每任务至少三次独立 trial。

建议使用 paired comparison：同一任务的 A/B/C/D 尽量在相同时间窗口运行，减少模型服务波动对结果的影响。

## 8. 可观测与失败归因

建议将失败分为三类，不要只保留一个“任务失败”：

### 8.1 Infrastructure Failure

- 容器启动失败。
- 模型服务不可用。
- 凭证或网络错误。
- headless runner 崩溃。
- artifact 丢失。

### 8.2 Agent Runtime Failure

- Harness 异常。
- tool protocol 错误。
- session 无法 flush。
- compaction/resume 错误。
- 超出预算或超时。

### 8.3 Capability Failure

- 未找到根因。
- 修改错误文件。
- 方案不完整。
- 未运行必要测试。
- 对测试失败归因错误。
- 产生无关回归。

只有 Capability Failure 应直接进入编码能力分数；Infrastructure Failure 应单独报告或重试。

## 9. 依赖与边界规则

最终依赖规则应冻结为：

```text
TUI / Headless
      |
      v
Code Agent contracts + bundle
      |
      v
Harness public services
```

必须通过自动化门禁强制以下规则：

1. `dsh-code-agent` 不 import React、Ink 或 Benchmark 代码。
2. `dsh-tui` 不实现独立编码策略。
3. `dsh-code-headless` 不依赖 TUI。
4. Benchmark 只调用 headless CLI 和读取公开 artifact。
5. Code Agent 只通过一个明确 adapter 接触 Harness 可变接口。
6. Harness 不 import Code Agent、TUI 或 Benchmark。
7. 生产运行不得读取 benchmark hidden verifier 或 reference solution。

## 10. 版本与兼容策略

建议将当前 `upstream-compat.json` 扩展为完整运行基线：

```json
{
  "harness": {
    "commit": "...",
    "version": "...",
    "sessionFormat": 0
  },
  "codeAgent": {
    "version": "0.1.0",
    "eventSchema": 1,
    "resultSchema": 1
  },
  "surfaces": {
    "tui": "0.1.4",
    "headless": "0.1.0"
  },
  "benchmark": {
    "dataset": "code-agent-v1.0",
    "trialSchema": 1
  }
}
```

升级 Harness 时先运行：

1. Harness 公开 service contract 检查。
2. Code Agent adapter 测试。
3. session fixture 回放和 projection parity。
4. headless smoke。
5. TUI smoke。
6. validation benchmark 回归。

## 11. 分阶段实施路线

### 阶段 0：固化基线

产出：

- 固定 Harness commit、模型、推理强度和预算。
- 用现有 headless-agent 跑第一组 baseline。
- 保存原始 session、成本、时间和 verifier 结果。
- 分离 infrastructure failure 与 capability failure。

退出条件：同一任务可重复运行，每次 trial 都有完整 provenance。

### 阶段 1：建立 Code Agent Bundle

产出：

- `packages/dsh-code-agent`。
- Harness adapter 和 CodeAgentPort。
- persona、workspace context、现有工具组合。
- 不新增专用工具，先证明组合层的价值。

退出条件：TUI 和 headless 可以加载同一 bundle。

### 阶段 2：正式 Headless Surface

产出：

- 无 TTY 依赖的 `dsh-code-headless`。
- 稳定的 result/event schema。
- timeout、signal、flush 和 artifact 落盘。
- Harbor adapter。

退出条件：Benchmark 不再需要 PTY 包装 TUI。

### 阶段 3：可观测和评测体系

产出：

- trial schema 和 provenance。
- oracle/nop/baseline 运行。
- 失败归因管线。
- 按类型、难度和成本分组的报告。

退出条件：一次 Code Agent 改动能产生可比的前后报告。

### 阶段 4：逐项提升编码能力

每次只引入一类变化：

1. Repo context 优化。
2. Verification policy。
3. 结构化测试和诊断工具。
4. 循环检测与失败恢复。
5. 特定领域 skills。
6. 有界 subagent/workflow。

每项都必须经过 A/B 和消融实验，不以个别案例的主观体感作为上线依据。

### 阶段 5：TUI 对齐

产出：

- TUI 展示 verification records、budget 和 blocker。
- TUI 展示 Code Agent 注册的 projection，不自行推导另一套状态。
- TUI 与 headless 对同一 session fixture 得到一致语义。

退出条件：用户在 TUI 中看到的 Agent 行为与 Benchmark 测试的 Agent 行为一致。

## 12. 测试分层

```text
单元测试
  - Code Agent policy
  - budget/recovery
  - result normalization

Contract 测试
  - Harness adapter
  - CodeAgentPort
  - event/result schema

Composition 测试
  - 真实 Cordis Loader
  - bundle/profile 组合
  - create/resume/flush/dispose

Replay 测试
  - 固定模型事件语料
  - compaction/subagent/tool failure

Surface 测试
  - headless JSONL/result
  - TUI PTY/snapshot

Capability Benchmark
  - 隐藏 verifier
  - 多 trial
  - 成本和稳定性统计
```

低层测试保证“系统按 contract 运行”，Benchmark 保证“Agent 真的能完成编码任务”，两者不能互相替代。

## 13. 关键风险

| 风险 | 结果 | 缓解方式 |
|---|---|---|
| 把策略写入 TUI | Headless 与真实产品行为分叉 | 统一 CodeAgentPort 和 bundle |
| Benchmark 通过 PTY 驱动 TUI | 评测包含终端噪声 | 正式 headless surface |
| 所有能力都写进 prompt | 难测试、难强制、token 膨胀 | Prompt/Policy/Tool/Skill 分层 |
| 直接修改 Harness 内核 | 上游升级成本持续上升 | 优先 bundle/service/tool 扩展 |
| 只看最终 pass rate | 无法定位改进方向 | 结构化 telemetry 和失败归因 |
| Benchmark 数据泄漏 | 分数虚高 | hidden verifier、分割数据集、canary |
| 多项能力同时修改 | 无法确定收益来源 | 逐项消融和 paired trials |
| 子 Agent 无限扩张 | 成本和不确定性失控 | 深度、并发、token 和时间预算 |

## 14. 最终验收标准

三层架构完成时应满足：

- Harness checkout 没有因 TUI 或 Benchmark 需求引入产品特定修改。
- TUI 和 headless 使用同一 Code Agent bundle、prompt、tools 和 policy。
- Benchmark 不需要 TTY，不 import TUI，不依赖人工交互。
- 每次 trial 都能追溯 Harness、Code Agent、模型、数据集和预算版本。
- verifier 与 Agent 环境分离，Agent 无法读取 hidden tests。
- 能对 baseline、prompt、context/policy 和 skill/subagent 分别执行消融实验。
- 能区分 infrastructure、runtime 和 capability failure。
- Code Agent 宣称的测试、改动和 blocker 都有可观测证据。

## 15. 简要决策记录

1. Harness 是通用内核，不是 Code Agent 产品层。
2. Code Agent 是唯一的编码能力所有者。
3. TUI 和 headless 是并列 surface，不是上下游 Agent。
4. Benchmark 只测 headless surface，不通过 TUI 测能力。
5. 任务正确性由独立 verifier 判定，不由 Agent 自评。
6. 所有能力改进必须通过固定预算的消融实验证明。
