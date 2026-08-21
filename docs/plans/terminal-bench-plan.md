# Terminal-Bench 评测执行方案

> 目标：用 `benchmark/terminal-bench` 评测本仓库的 `dshcodecli` agent。
> 编写日期：2026-08-19

---

## 一、现状勘察（已确认）

| 项目 | 结论 |
|---|---|
| `benchmark/terminal-bench` | 上游 harbor-framework/terminal-bench 完整 checkout，commit `642ae58d`，**76 个任务** |
| 运行框架 | Harbor（`uv tool install 'harbor[modal]'`）；任务通过 `task.toml` 声明 environment / verifier / agent timeout，跑在容器里 |
| 待测对象 | `dshcodecli`（`packages/dsh-tui/bin/dshcodecli.mjs`），一次性模式 `dshcodecli "<task>"`，`-i` 才进交互；支持 `--permission danger-full-access`、`--model provider/model[:effort]`、`--diagnostic-log` |
| 模型侧 | `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` |
| **阻塞点 1** | 本机**没有 docker**（`docker: command not found`），只有 uv / python3 / node |
| **阻塞点 2** | TUI 依赖真 TTY（`packages/dsh-tui/src/terminal-capabilities.ts:54` 要求 stdin+stdout 均为 TTY），Harbor 里是非 TTY 的 `docker exec`，需要 PTY 包装或 headless 输出通道 |
| **阻塞点 3** | Harbor 没有内置 `dsh` agent adapter，必须自己写一个 |

---

## 二、执行方案

### 阶段 0 · 环境就绪（0.5 天）

1. 安装 Harbor：`uv tool install 'harbor[modal]'`，确认 `harbor --version`，并确认能解析本地任务路径 `benchmark/terminal-bench/tasks/<task>`。
2. 选定执行后端（见第三节决策点），跑通 **oracle 基线**：

   ```bash
   harbor run -p benchmark/terminal-bench/tasks -k 1 --agent oracle --n-concurrent 8
   ```

   oracle 必须接近 100% 通过；不通过的任务先记为"环境不可用"，从后续统计中剔除，避免把环境问题算到 agent 头上。
3. 同时跑 `--agent nop` 做零分对照，验证 verifier 不会误判通过。

### 阶段 1 · 打通 dshcodecli 的无人值守模式（1–2 天，关键路径）

这是整个评测能否进行的前提。产出物放在 `benchmark/adapters/`，不污染 `packages/`。

1. **PTY 包装器**：用 `node-pty`（devDeps 已有）起伪终端运行 `dshcodecli`，把任务文本喂入、最终 transcript 落盘，退出码映射为成功/失败。改动最小，绕开 TTY 硬要求。
2. **权限直通**：固定 `--permission danger-full-access`（容器内隔离，terminal-bench 语义要求 agent 能自由改文件 / 装包）。
3. **超时与终止**：对齐 `task.toml` 的 `[agent] timeout_sec`（多数 7200s），超时强杀并标记 `agent_timeout`。
4. **可观测**：接 `--diagnostic-log`，每个 trial 保留一份脱敏日志，便于事后归因。
5. 本地先用 3 个易任务自测包装器（不进 Harbor），确认"喂任务 → 跑完 → 退出"闭环稳定。

### 阶段 2 · Harbor Agent Adapter（0.5–1 天）

1. 按 Harbor 的自定义 agent 接口实现 `DshAgent`：将 dsh 安装脚本 + 阶段 1 的包装器注入容器，设置 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`，然后执行。
2. **安装策略**：优先复用已有的 `pnpm package:offline` / `package:sea` 产物（`scripts/package-offline.ts`、`scripts/package-sea.ts`），把 agent 作为单文件 / 离线包塞进容器，避免每个任务容器都联网 `pnpm install`，减少耗时与抖动。
3. 冒烟：单任务 `harbor run -p tasks/<easy-task> --agent dsh --model deepseek/deepseek-v4-pro`，逐条排掉注入 / 鉴权 / 路径问题。

### 阶段 3 · 小规模试跑与调参（1 天）

- 选 8–10 个覆盖不同 category（Software / Systems / ML / Security 等）的任务，`-k 2` 跑，观察失败属于：agent 能力问题、包装器问题、还是超时 / 网络问题。
- 校准 reasoning effort、并发数、容器资源（部分任务需 4GB 内存 / 10GB 存储）。
- 目标：**把非能力性失败清零**，否则全量结果没有意义。

### 阶段 4 · 全量评测（0.5–1 天机时）

```bash
harbor run -p benchmark/terminal-bench/tasks \
  --agent dsh --model deepseek/deepseek-v4-pro \
  -k 3 --n-concurrent 20
```

- `-k 3`：三次独立 trial，报 pass@1 均值 + 标准差（terminal-bench 单次结果方差很大，单跑一次不可信）。
- 同步跑一组对照 agent（如 `claude-code` + 对应模型）作为横向参照，前提是有对应 API key。

### 阶段 5 · 分析与产出（0.5 天）

- 汇总表：总体 pass@1、按 category / difficulty 分解、每任务通过率矩阵。
- 失败归因分类：`agent_timeout` / `工具调用错误` / `环境操作失败` / `答案错误` / `harness bug`，前几类是 dsh 自身可改进项。
- 产出 `benchmark/REPORT.md` + 原始 trial 日志归档。

**总计约 4–6 人日，其中阶段 1 是主要风险。**

---

## 三、待决策事项

### 1. 执行后端（本机无 docker）

- **A. Modal 云端**（上游 CI 即用此方案，`--env modal`）：无需本地装 docker，并发高（官方示例 `--n-concurrent 500`）；需要 Modal 账号，产生云费用。
- **B. 本地安装 Docker**：无外部费用、数据不出网；需要 sudo 权限，且 76 任务 × 3 次在单机串行会很慢（部分任务 2 CPU / 4GB / 构建 600s）。

### 2. 评测范围

- 全量 76 任务 × 3 trial（约 228 次容器运行，按平均 20–40 分钟/任务估，机时与 token 开销可观）；
- 或先跑 15–20 个代表性子集，出一份快速摸底报告。

**建议：Modal + 先跑子集摸底，确认包装器稳定后再上全量。**

---

## 四、参考命令速查

```bash
# 安装 Harbor
uv tool install 'harbor[modal]'

# oracle 基线（验证环境）
harbor run -p benchmark/terminal-bench/tasks -k 1 --agent oracle --n-concurrent 8

# nop 对照（验证 verifier）
harbor run -p benchmark/terminal-bench/tasks -k 1 --agent nop

# 单任务冒烟
harbor run -p benchmark/terminal-bench/tasks/<task> --agent dsh --model deepseek/deepseek-v4-pro

# 全量评测
harbor run -p benchmark/terminal-bench/tasks --agent dsh \
  --model deepseek/deepseek-v4-pro -k 3 --n-concurrent 20
```
