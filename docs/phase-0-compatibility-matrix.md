# Compatibility and verification matrix

Recorded: 2026-08-16 (supersedes the 2026-08-15 phase-0 record)

Every row states what was actually executed. Rows that were not run say so.

## Composition and upstream

| Capability | Result | Evidence |
|---|---|---|
| Harness external bundle resolution | Pass | `scripts/profile-smoke.ts` loads base + external TUI through the real Loader |
| Pinned upstream tuple | Pass | `check:upstream` verifies commit, version, session format, and 12 service/type contracts (agents create/resume, sessions.flush, sessionQuery.listSessions, SessionRecord, approval request shape, user questions, permission presets config, tool render-intent vocabulary, cmdlineArgs) |
| Single Cordis instance | Pass | `check:release` refuses a direct Cordis dependency or import; the TUI reaches Cordis only through the Harness runtime |
| Import boundary | Pass | `isolation.spec.ts` scans every source file: only `harness-adapter.ts` may name the checkout or an `@deepseek-ai/*` package, and no non-`.tsx` module may import React or Ink |
| TypeScript 6 strict | Pass | `tsc -p tsconfig.json` |
| Package build output | Pass | `tsc -p packages/dsh-tui/tsconfig.build.json` emits `lib/*.js` + `lib/types/*.d.ts` with rewritten relative specifiers |
| Packed artifact install | Pass | `check:packed` packs the tarball, extracts it outside the repository, resolves the `default` export to `lib/plugin.js`, and starts the real profile (help + non-TTY refusal) |

## Runtime and projection

| Capability | Result | Evidence |
|---|---|---|
| Seed/live projection equivalence | Pass | 8 fixed upstream raw-session fixtures: text, parallel tools, Code Mode, failed shell, diff, compaction, subagent, rejected approval — live fold equals seed rebuild |
| Projection and text properties | Pass | `fast-check` properties over generated logs: seed/live equality, idempotent redelivery, gap detection, tool pairing, retention bound; and over arbitrary binary strings: no escapes or control characters survive, truncation and wrapping stay inside the column budget, sanitizing is stable. The wrap property found and fixed a real overflow when one glyph is wider than the whole row |
| Plugin composition | Pass | 13 tests drive the real plugin, store, queues, controller and adapter with a replaced renderer: startup refusals, exit codes 0/1/74/130, cancel, SIGTERM, stdin EOF, listener cleanup, `/new`, picker resume, danger-preset confirmation, steering |
| Web Conversation parity | Pass | Code Mode parent/child pairing and failure semantics compared with the Web `ui.expected.md` |
| Seq gap / duplicate / unknown-required | Pass | projection pauses and can rebuild from the authoritative live session; unknown required semantics stay paused and fail closed |
| Tool pairing under concurrency | Pass | 100 out-of-order completions pair by call id with no pending residue |
| AgentController lifecycle | Pass | create, resume, followup, steer, typed cancel, whenIdle, flush, attach failure, dispose-during-attach, exactly-once teardown |
| Registered Session projections | Pass | detached snapshots filtered by exact Session identity; observer-init failure rolls back the subscription and the AgentHandle |
| Commands / model-input boundary | Pass | unmatched slash commands never reach `followup`; execution always goes through `ctx.commands.execute` |
| Root questions and teardown | Pass | exact-root provider rejects child callers; abort and close leave no pending promise |
| Tool presentation | Pass | recognized intents survive; missing, throwing, and unknown cards fall back to generic |

## Terminal behavior

| Capability | Result | Evidence |
|---|---|---|
| Terminal text safety | Pass | window title, OSC 8 hyperlink, OSC 52 clipboard, SGR, unterminated CSI/OSC, C0/C1/DEL and bidi overrides are removed; newlines, tabs and CJK/emoji/combining marks survive |
| Unicode width | Pass | wide, fullwidth, emoji and zero-width cells are measured; truncation never splits a wide cell and wrapping never exceeds the column budget |
| Chinese IME and bracketed paste | Pass | a real 80x24 ConPTY run pastes `中文宽字符🙂 é` + a second IME line, verifies no premature submit, and confirms the exact code points reach the next model request |
| Low-height layout | Pass | exact row-budget tests down to 8 rows; the composer reserves its real wrapped height so the status row never wraps |
| Resize and alternate screen | Pass | 160x50 enters alternate screen, resizes to 80x24 and back, then asserts both `1049h` and `1049l` |
| No-color mode | Pass | `--no-color` run asserts no ANSI 30-37/90-97 sequence; `NO_COLOR`, `FORCE_COLOR=0` and `TERM=dumb` are handled by capability detection |
| 10000-event recovery | Pass | batched seed fold; see the performance table |
| Interactive PTY matrix | Pass | 80x24 approval, 160x50 resize, 80x12 structured questions, 80x24 Unicode paste — all through task, stream, follow-up, `/help`, `/quit`, flush, dispose, exit 0 |
| Session resume | Pass | `check:resume` creates a session, quits, resumes with `--resume latest`, shows the earlier transcript, sends a follow-up, proves the restored history reached the next model request, then switches to a fresh session with in-session `/new` |
| Cancellation and terminal restore | Pass | `check:cancel` runs a real alternate-screen session: the first Ctrl+C only arms the confirmation, the second exits 130, and the transcript carries both `?1049l` and `?25h` |
| Component input routing | Pass | virtual-terminal tests cover double Enter, single-chunk bracketed paste with newlines, approval keys not leaking into the composer, Ctrl+C arming, Ctrl+P palette filtering, Ctrl+R session picking, Ctrl+O folding, Tab focus, and PgUp history paging |
| Transcript history paging | Pass | the window renders `maxEvents` nodes and grows one page per PgUp at the top, bounded by a retention limit; paged-in history keeps the viewport anchor and does not inflate the unread count |
| Durability soak | Pass | a full 30-minute single-Agent PTY run: 352 follow-ups, 352 resizes across three sizes, alternate-screen restoration; a 10-second variant runs in the regular gate |
| Node 22 / Node 24 | Pass | Node 22.23.2 drives typecheck, tests, real profile, four ConPTY scenarios, resume, cancellation, performance budgets and quick soak; Node 24.14.0 is the default environment. Node 22 exposed dropped keystrokes when input is written while Ink repaints, so the PTY drivers now re-send each step until its echo appears and use model-request counts (not screen text) to detect a new response |
| Real DeepSeek API | Pass (opt-in) | `check:real` streams through the real profile against `https://api.deepseek.com` and verifies the persisted route (`deepseek-official` / `deepseek-v4-pro` / `high`); credentials come from the environment or a local `.env` and are never printed |
| Real interactive coding loop | Pass (opt-in) | `check:real:interactive`: the live model calls the `read` tool on package.json, answers, takes a composer follow-up, completes a second turn, and exits 0 on `/quit`; the session log shows 2 user messages, 2 turn ends and the tool call |
| Real escalation and approval | Pass (opt-in) | `check:real:approval`: under `--permission read-only` the live model's write is denied (`exit 1`), it re-runs with `sandbox_permissions: workspace-write`, the TUI shows `Approve pwsh? (read-only) [y/N]` with the linked card and reason, the answered call succeeds (`exit 0`), the file appears, and `approval/decided` is persisted |
| Provider error rendering | Pass | an unsupported `reasoningEffort` produced `── turn error: UNSUPPORTED_REASONING_EFFORT …` in the transcript and a non-zero exit, observed during the real-API runs |

## Performance (plan section 9.3)

| Metric | Budget | Measured |
|---|---|---|
| 1k events to first screen | — | 10 ms |
| 10k events to first screen | < 1.5 s | 40 ms |
| 100k events to first screen | stress only | 0.32 s |
| 2k live appends (per-event publication) | — | 1.5 s |
| 10 MB command output card | — | 12 ms, body bounded and reported as capped |
| 100 parallel tool calls | — | 21 ms |
| 10k-event steady-state RSS | < 200 MB | 99.6 MB |

Reproduce with `npm run check:bench`.

## Fault injection

| Fault | Behavior |
|---|---|
| Approval answerer torn down, aborted, or absent | `unavailable` / `cancelled`; never allowed |
| Shutdown with queued approvals and questions | all settle before teardown continues |
| Final flush returns false | exit code 74 plus a diagnostic; handle still disposed |
| Final flush throws | error surfaces, handle still disposed |
| Turn ends for a non-completion reason | exit code 1 |
| Permission preset rejected or unknown | startup fails loudly; no session continues |
| Required Harness service missing | composition fails loudly |
| Renderer throws | region degrades to an error row; the Agent is unaffected |

## Still open

| Item | Status |
|---|---|
| Built-in `tui` profile registration | Not done by design. ADR 0001 keeps the Harness checkout read-only, so the profile is mounted as an external bundle instead of being registered in the upstream `PROFILE_TEMPLATES`. A published build would need that upstream entry. |
| Activity side pane (>=120 columns) | Not done (P1). The same data is projected into the status row. |
| stdin EOF shutdown | Covered at the composition layer (`plugin.spec.ts` emits `end` on the injected stdin). No PTY run: `node-pty` cannot close the child's stdin without terminating the process. |
| SSH and tmux environment matrix | Not run. Detection and degradation are implemented and unit-tested; a manual session has not been executed. |
| Linux and macOS PTY runs | Not run in this environment (Windows/ConPTY only). The PTY suites are platform-neutral and select `bash` off Windows. |
| Terminal emulator matrix (xterm, iTerm2, VS Code, screen) | Not run. |
| Published dependency closure | Not run. The packed artifact starts out of tree, but a fully published install needs a published Harness release. |
