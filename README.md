# dsh-code-agent

[中文](README.md) | [English](README_EN.md)

[![npm version](https://img.shields.io/npm/v/dshcodecli.svg)](https://www.npmjs.com/package/dshcodecli)
[![Node.js](https://img.shields.io/badge/Node.js-%5E22.19.0%20%7C%7C%20%3E%3D24-339933?logo=node.js&logoColor=white)](packages/dsh-tui/package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)

一个面向 [DeepSeek Harness](opensource/deepseek-harness/deepseek-harness-master) 的键盘优先终端 Code Agent。

dsh-code-agent 提供完整的终端交互体验，但不会复制 Agent loop、工具、权限、沙箱或会话持久化。
这些能力仍由 DeepSeek Harness 负责；本项目专注于把运行过程准确地呈现在终端中，并将用户操作送回 Harness。

## 快速开始

### 安装

~~~bash
npm install -g dshcodecli
~~~

运行环境：

- Node.js 22.19.0 以上的 22.x，或 Node.js 24 及以上版本
- 支持交互输入的真实 TTY
- DeepSeek API 凭据，或 Harness 已配置的凭据存储

### 启动

进入需要处理的项目目录，直接运行：

~~~bash
cd /path/to/your/project
dshcodecli
~~~

无需提供 <code>-i "你是谁"</code> 一类占位任务。没有参数时，dshcodecli 会直接打开交互式
composer，等待你的第一条消息。

首次在一个目录中启动时，会先显示工作区安全确认：

~~~text
Accessing workspace:

/path/to/your/project

Quick safety check: Is this a project you created or one you trust?
DSH Code Agent will be able to read, edit, and execute files here.

> Yes, use this folder
  No, exit
~~~

只有确认后才会读取项目配置并启动 Harness。被信任的规范化目录记录在
<code>$DSH_HOME/tui/trusted-workspaces.json</code>。主目录只在当前进程中临时信任，避免一次确认
隐式信任其下所有项目。

也可以直接给出任务：

~~~bash
dshcodecli "检查当前改动并运行相关测试"
dshcodecli -i "review the working tree"
dshcodecli --resume latest
dshcodecli --permission read-only
~~~

## 配置凭据

推荐将全局凭据写入 <code>~/.dsh/.env</code>：

~~~bash
umask 077
printf 'DEEPSEEK_API_KEY=sk-...\n' >> ~/.dsh/.env
~~~

项目也可以提供自己的 <code>.env</code>：

~~~dotenv
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
~~~

配置按以下顺序解析：

1. 当前进程环境变量；
2. 当前目录及其父目录中的 <code>.env</code>；
3. 开发模式下的仓库根目录 <code>.env</code>；
4. <code>$DSH_HOME/.env</code>，默认是 <code>~/.dsh/.env</code>；
5. Harness 凭据存储。

项目配置不会覆盖已经导出的同名环境变量。

## 主要能力

| 领域 | 能力 |
|---|---|
| 启动安全 | 首次进入工作区前确认；拒绝时不启动 Harness；信任记录使用私有权限和原子写入 |
| 对话 | 无参数交互启动、流式输出、运行中 steering、多轮跟进、草稿历史、会话恢复 |
| 渲染 | Markdown、代码块、表格、引用、CJK 折行、resize 重排、Unicode/ASCII 降级 |
| 工具 | run/edit/search/read/web 卡片、diff 着色、长输出折叠、嵌套调用、截断提示 |
| 权限 | read-only、workspace-write、danger-full-access，以及 fail-closed 审批 |
| 导航 | 命令补全、路径补全、命令面板、会话浏览器、文件位置跳转 |
| Transcript | Ctrl+T 全屏历史视图、搜索、高亮、匹配跳转、复制、历史输入恢复到草稿 |
| 终端 | 差分帧绘制、原生 scrollback、alternate screen、无色模式、SSH/tmux 降级 |
| 工程质量 | 严格 TypeScript、属性测试、PTY 冒烟、性能预算、打包安装和耐久测试 |

## 命令行

| 命令 | 说明 |
|---|---|
| <code>dshcodecli</code> | 打开交互式 composer |
| <code>dshcodecli [task...]</code> | 执行一次性任务 |
| <code>dshcodecli -i [task...]</code> | 完成首个任务后继续交互 |
| <code>dshcodecli --resume [id]</code> | 按 id、唯一前缀或 latest 恢复，并自动进入交互模式 |
| <code>dshcodecli -r [id]</code> | <code>--resume</code> 的短参数形式 |
| <code>dshcodecli --resume-select</code> | 启动后直接打开当前工作区会话浏览器 |
| <code>dshcodecli --permission PRESET</code> | 选择权限预设 |
| <code>dshcodecli --model ROUTE</code> | 本次运行覆盖模型 |
| <code>dshcodecli --no-color</code> | 关闭语义颜色 |
| <code>dshcodecli --diagnostic-log PATH</code> | 写入脱敏 JSONL 诊断日志 |
| <code>dshcodecli --help</code> | 查看完整帮助 |

## 退出与恢复会话

使用 <code>/quit</code> 正常退出时，TUI 会等待当前任务结束并刷新会话。持久化成功后，终端会显示准确的 Session ID 和恢复命令：

~~~text
Session saved: session-...
Resume: dshcodecli --resume session-...
~~~

回到创建会话的工作目录，直接执行输出的命令即可恢复。无参数 <code>--resume</code> 等价于 <code>--resume latest</code>，并且不再需要 <code>-i</code>：

~~~bash
dshcodecli --resume
dshcodecli --resume latest
dshcodecli --resume session-abc
dshcodecli --resume-select
~~~

<code>latest</code> 和会话浏览器只查询当前规范化工作目录的顶层会话。显式 ID 属于其他目录时，CLI 会显示正确的 <code>cd</code> 和恢复命令，而不会在错误的项目中静默恢复。恢复时必须继续使用保存该会话的 <code>DSH_HOME</code>。强制杀死进程无法保证刷新完成或打印恢复凭据。

## 常用按键

| 按键 | 作用 |
|---|---|
| Enter | 发送当前草稿 |
| Ctrl+Enter / Alt+Enter | 插入换行 |
| Esc | 关闭最内层界面；在 composer 中先清草稿，再进入两段式取消 |
| Ctrl+C | 两段式取消和有界关闭 |
| Tab | 接受补全；无补全时切换 composer/transcript 焦点 |
| / | 命令补全；在 transcript screen 中进入搜索 |
| @ | 补全工作区路径 |
| Ctrl+P | 打开命令面板 |
| Ctrl+R | 打开会话浏览器 |
| Ctrl+O | 折叠或展开当前工具卡 |
| Ctrl+T | 打开可搜索的 transcript screen |
| Ctrl+X | 使用 $EDITOR 打开当前卡片的首个文件位置 |
| Shift+Tab | 切换权限预设 |
| ? | 打开快捷键说明 |

Transcript screen 支持：

- <code>/</code> 搜索；
- <code>n</code> / <code>N</code> 前后跳转匹配项；
- <code>y</code> 复制当前行，<code>Y</code> 复制整条记录；
- <code>r</code> 将历史用户输入恢复到 composer，但不自动提交；
- <code>q</code>、Esc 或 Ctrl+T 返回正常界面。

快捷键可以通过 <code>~/.dsh/keybindings.json</code> 或
<code>$DSH_HOME/keybindings.json</code> 重绑定。完整说明见[用户手册](docs/tui-user-guide.md)。

## 架构

~~~mermaid
flowchart LR
  User["Terminal / User"] --> TUI["dsh-code-agent TUI"]
  TUI --> Adapter["Harness adapter"]
  Adapter --> Harness["DeepSeek Harness"]
  Harness --> Agent["Agent loop"]
  Harness --> Tools["Tools / Sandbox / Permissions"]
  Harness --> Sessions["Sessions / Projections"]
  Harness --> Adapter
  Adapter --> TUI
~~~

项目保持明确的所有权边界：

- <code>packages/dsh-tui/src/harness-adapter.ts</code> 是唯一上游耦合点；
- TUI 使用自身的中立 contract、projection 和 view model；
- 工具通过数据化 render intent 描述卡片，不向 TUI 返回 React 节点；
- <code>opensource/deepseek-harness</code> 和 <code>opensource/cordis</code> 是只读兼容目标；
- <code>cordis.patch.yml</code> 以外置 bundle overlay 的形式挂载 TUI。

## 从源码开发

~~~bash
git clone https://github.com/WALLE-AI/dsh-code-agent.git
cd dsh-code-agent
corepack enable
pnpm install

pnpm run dshcodecli
~~~

建立全局开发链接：

~~~bash
pnpm link --global --dir packages/dsh-tui
dshcodecli
~~~

常用验证命令：

~~~bash
pnpm run build
pnpm run test
pnpm run check:startup
pnpm run check:interactive
pnpm run check:release
~~~

完整发布门禁覆盖上游契约、严格类型检查、全部测试、真实 profile 组合、PTY 交互矩阵、resume、
取消与终端恢复、性能预算、打包安装和 soak。

## 发布与制品

npm 包：[dshcodecli](https://www.npmjs.com/package/dshcodecli)

~~~bash
npm install -g dshcodecli@latest
pnpm run package:npm
pnpm run publish:npm             # dry-run
pnpm run publish:npm -- --yes    # 实际发布
~~~

其他制品：

~~~bash
pnpm run package:offline
pnpm run package:sea
~~~

离线包按构建平台生成；SEA 制品还包含 Node 运行时。

## 安全模型

- 默认 workspace-write，工作区外操作需要审批；
- read-only 限制写入，danger-full-access 会显式警告；
- 没有全局“全部允许”快捷键；
- 审批界面不可用、终端中断或渲染失败时按拒绝处理；
- 控制字符和终端 escape 在显示前消毒；
- 诊断日志不记录原始凭据、提示词、文件内容、工具参数或命令输出；
- 工作区信任在读取项目 <code>.env</code> 和启动 Harness 之前完成。

## 平台与限制

主要发布目标是 Linux 和 macOS。Windows Terminal/ConPTY、SSH、tmux、无色终端和 ASCII-only
终端具有对应的能力探测或降级路径。

当前限制：

- 只支持真实 TTY；非交互流水线应使用 Harness 的 headless profile；
- transcript screen 不实现鼠标拖拽选区，使用 <code>y</code> / <code>Y</code> 复制；
- Harness 当前没有公开的 session fork/file rewind API，因此 <code>r</code> 只恢复输入，不回滚文件；
- 需要接管当前 TTY 的终端编辑器不适合 detached Ctrl+X 流程。

## 文档

- [英文 README](README_EN.md)
- [TUI 用户手册](docs/tui-user-guide.md)
- [更新日志](CHANGELOG.md)
- [兼容性矩阵](docs/phase-0-compatibility-matrix.md)
- [架构决策记录](docs/adr/0001-external-tui-adapter-boundary.md)
- [TUI 优化与执行记录](docs/tui-optimization-plan.md)
- [TUI 子包说明](packages/dsh-tui/README.md)

## 参与项目

提交改动前请运行与范围对应的测试。涉及启动器、终端生命周期、投影契约或发布产物时，应运行
完整的 <code>pnpm run check:release</code>。

提交 issue 时请附带 Node.js 版本、操作系统、终端类型、复现步骤和脱敏后的错误信息。
请勿提交 API key、npm token、项目源码或未经脱敏的会话内容。
