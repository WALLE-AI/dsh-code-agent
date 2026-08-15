# Phase 0 compatibility matrix

Recorded: 2026-08-15

| Capability | Result | Evidence |
|---|---|---|
| Harness external bundle resolution | Pass | `scripts/profile-smoke.ts` loads base + external TUI through the real Loader |
| TUI-owned `--help` | Pass | real profile exits 0 and prints `dsh --profile tui` usage |
| Non-TTY behavior | Pass | real profile exits 1 before Agent creation and points to headless |
| TypeScript 6 | Pass | `tsc -p tsconfig.json` |
| Ink / ESM / React | Pass | real Loader import using Ink 5.2.1 and React 18.3.1 |
| Approval abort/dispose | Pass (object layer) | `ApprovalQueue` tests settle cancelled/unavailable without pending promises |
| Bounded transcript | Pass (object layer) | store tail test |
| Seed/live projection equivalence | Pass (object layer) | keyless fixture covers chunk/final merge, parallel tool pairing, failure, diff, compaction marker, subagent marker and Code Mode parent id |
| Seq gap/duplicate/unknown-required handling | Pass (object layer) | projection pauses on incomplete semantics and can rebuild from a complete event list |
| Live gap/conflicting duplicate recovery | Pass | the Harness adapter rebuilds from the callback session's authoritative `events` list; incomplete logs and unknown required semantics remain paused and fail closed |
| AgentController create/resume lifecycle | Pass | upstream-neutral controller tests cover followup, steer, typed cancel, idle, flush, attach failure, dispose-during-attach and exactly-once teardown; adapter black-box uses the real Harness runtime contract |
| Registered Session projections | Pass | controller session/store carry detached `ctx.sessionProjections` snapshots; change feed is filtered by exact Session identity, seed state is published on create/resume, and observer-init failure rolls back subscription plus AgentHandle |
| Commands / model-input boundary | Pass | input-router tests and the Harness adapter bind list/execute to the exact Agent; unmatched slash commands never reach `followup` |
| Command discovery and local lifecycle commands | Pass | the composer filters the exact Agent command catalog; `/help` and `/quit` complete in both real PTY sizes without becoming model input |
| Transcript viewport and unread state | Pass (object layer) | reducer tests cover bottom follow, anchored PageUp, streaming/new-line unread accumulation, PageDown reset, and resize/rebuild clamping |
| 10000-event recovery | Pass (object layer) | seed fold batches immutable snapshot publication while live append remains incremental; the 10000-event Store test now completes with its full test file in roughly 24ms on Windows/Node 24 |
| Root questions and teardown | Pass | exact-root provider rejects child callers; form/queue tests cover multi-question single/multi/custom answers, validation, abort and close; an 80x12 real PTY invokes official `ask_user_question` and verifies the structured answer in the next model request |
| Tool presentation fallback | Pass (object layer) | recognized tool-owned intents survive; missing, throwing, and unknown-card presenters fall back to generic call/result views |
| Node 24 | Pass | current test environment, Node 24.14.0 |
| Node 22 | Pass | Node 22.23.2 drives TypeScript, all 55 tests, the real profile, 80x24 approval, 160x50 resize/alternate-screen, 80x12 Question/no-color, and quick soak through one inherited `process.execPath`; Question input uses a 50ms post-render PTY delay to avoid runtime-specific ConPTY loss |
| Interactive PTY task, approval, questions, and composer | Pass | 80x24 and 160x50 approval runs plus an 80x12 question run drive real Agents through tool interaction, stream, composer follow-up, `/help`, `/quit`, flush/dispose, and exit 0 |
| Real DeepSeek API through Harness TUI | Pass | `scripts/real-api-smoke.ts` uses an environment-only credential, runs the real profile over PTY, observes the streamed marker, and verifies the persisted request header selected `deepseek-official` / `deepseek-v4-pro` / `high`; run with `pnpm run check:real` when a key is available |
| Resize and alternate-screen restoration | Pass | 160x50 PTY enters alternate-screen, resizes to 80x24 and back during one Agent session, completes follow-up/commands, then asserts both `1049h` and `1049l` sequences |
| No-color mode | Pass | startup contract tests map `--no-color` independently; the real question PTY completes with no ANSI 30-37/90-97 foreground color sequences |
| Low-height layout | Pass | exact row-budget tests cover 12-line compact and 8-line modal degradation; the 80x12 real question PTY completes without losing the active controls or transcript viewport |
| Interactive soak durability | Pass | a full 30-minute real Harness/Agent/TUI PTY run completed 352 follow-ups and 352 resizes across 80x24, 160x50, and 80x12; per-turn watchdogs, bounded 128 KiB driver capture, normal `/quit`, and alternate-screen restoration all passed; the same state machine runs for 10 seconds in the regular gate |
| Unicode width and Chinese IME | Partial | composer reducer preserves Chinese/IME chunks and Unicode backspace; terminal width and manual IME matrix remain pending |
| SSH and tmux | Not run | manual environment matrix pending |
| Eight real Session event fixtures and Web parity | Pass | fixed upstream raw JSONL corpus covers text, parallel tools, Code Mode, failed shell, diff, compaction, subagent, and rejected approval; every live fold equals seed rebuild and Code Mode matches Web critical semantics |

The Stage 1 runtime gate is closed and the Stage 2 Node 22/24, size/resize/alternate-screen/low-height, and 30-minute durability gates pass. Wider terminal coverage remains open for terminal-width/IME behavior, SSH, and tmux.
