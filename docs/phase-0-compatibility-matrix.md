# Phase 0 compatibility matrix

Recorded: 2026-08-14

| Capability | Result | Evidence |
|---|---|---|
| Harness external bundle resolution | Pass | `scripts/profile-smoke.ts` loads base + external TUI through the real Loader |
| TUI-owned `--help` | Pass | real profile exits 0 and prints `dsh --profile tui` usage |
| Non-TTY behavior | Pass | real profile exits 1 before Agent creation and points to headless |
| TypeScript 6 | Pass | `tsc -p tsconfig.json` |
| Ink / ESM / React | Pass | real Loader import using Ink 5.2.1 and React 18.3.1 |
| Approval abort/dispose | Pass (object layer) | `ApprovalQueue` tests settle cancelled/unavailable without pending promises |
| Bounded transcript | Pass (object layer) | store tail test |
| Node 24 | Pass | current test environment, Node 24.18.0 |
| Node 22 | Not run | required before supported release |
| Interactive PTY task and Bash approval | Pass | `scripts/interactive-smoke.ts` drives the real Agent with a deterministic mock LLM and `node-pty`; it approves Bash once, observes tool/final output, flushes, disposes, and exits 0 |
| Resize and alternate-screen restoration | Not run | PTY lifecycle test pending |
| Unicode width and Chinese IME | Not run | manual terminal matrix pending |
| SSH and tmux | Not run | manual environment matrix pending |
| Eight real Session event fixtures | Not run | projection phase input pending |

The mandatory task/approval/stream/exit path is now automated. The wider phase-zero terminal and event-fixture gate remains open until every “Not run” row has evidence.
