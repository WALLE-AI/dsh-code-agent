# dsh-code-agent 文档

本目录集中保存用户文档、架构决策、兼容性记录和历史执行方案。仓库根目录仅保留项目入口、
版本记录及开源分发所需文件。

## 用户与兼容性

- [TUI 用户手册](tui-user-guide.md)
- [Phase 0 兼容性矩阵](phase-0-compatibility-matrix.md)

## 架构设计

- [三层 Code Agent/TUI 架构](architecture/three-layer-code-agent-tui.md)
- [ADR 0001：外置 TUI Adapter 边界](adr/0001-external-tui-adapter-boundary.md)

## 执行方案

- [Harness/Cordis TUI 总体执行方案](plans/harness-cordis-tui-execution-plan.md)
- [TUI 优化方案与执行记录](plans/tui-optimization-plan.md)
- [模型切换与基础命令方案](plans/model-and-basic-commands-plan.md)
- [会话恢复方案](plans/resume-conversation-plan.md)
- [Transcript 顺序修复方案](plans/transcript-ordering-plan.md)
- [Terminal-Bench 评测方案](plans/terminal-bench-plan.md)

方案文档保留设计背景、实施过程与当时的验证数据；当前使用方式以用户手册和根目录 README 为准。
