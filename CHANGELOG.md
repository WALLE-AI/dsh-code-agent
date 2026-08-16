# Changelog

All notable changes to the DeepSeek Harness TUI profile.

## 0.1.0 — unreleased preview

The first coding-loop-complete build of the terminal profile: create or resume a
session, watch tools stream, approve escalations, read diffs, and exit with the
session durable.

### Verified upstream tuple

| Component | Pinned value |
|---|---|
| Harness | `0.1.0-rc.5`, commit `47f9438` |
| Harness vendored Cordis | manifest `56b3d4f` (independent reference `8cc9e33`) |
| Session format | `0` |
| Node | verified on `22.23.2` and `24.14.0` |
| TypeScript / Ink / React | `6.0.3` / `5.2.1` / `18.3.1` |

`upstream-compat.json` is the machine-readable copy of this tuple and is
enforced by `npm run check:upstream`.

### Added

- **Terminal safety layer** — ANSI, OSC, DCS, C0/C1, DEL and bidi-spoofing marks
  are stripped from every untrusted string before it reaches the screen;
  East-Asian, emoji and combining-mark widths drive truncation and wrapping.
- **Terminal capability detection** — color level, alternate screen, hyperlinks,
  tmux/screen, SSH and legacy Windows console are detected and every reduction
  is reported as an explicit note instead of a silent downgrade.
- **Tool cards from declared intents** — `generic`, `terminal`, `diff`,
  `search`, `read` and `web` cards are built from each tool's own
  `presentCall`/`presentResult` output, never from tool names; a missing,
  unknown or throwing presenter degrades to the generic card.
- **Diff rendering** — LCS hunks with context, line numbers, add/remove counts,
  created-file and binary markers, plus a cell guard that falls back to a
  whole-file replacement instead of stalling the loop.
- **Bounded output** — inline tool bodies are capped by rows and bytes with an
  explicit `… N more line(s) not shown (output capped)` marker.
- **Foldable transcript** — long successful cards fold by default, failures stay
  open, reasoning folds, Code Mode sub-calls are indented under their parent
  call, and `Ctrl+O` toggles the card in view.
- **Editor launch** — `Ctrl+E` opens a card's first location with an argv array;
  paths that leave the workspace and editors containing shell syntax are
  refused.
- **Activity projection** — permission preset, plan/todo, tool count, file
  churn, approvals, subagent, context pressure and token usage are projected
  from the registered Harness session projections.
- **Session resume** — `--resume [id|prefix|latest]` and `/sessions` read the
  official session query service; the persisted log is folded first and the live
  tail joins by seq.
- **Permission presets** — the profile configures `read-only` explicitly next to
  `workspace-write` and `danger-full-access`; switching to the unrestricted
  preset requires sending the command twice.
- **Startup contract** — `--resume`, `--permission`, `--model`,
  `--diagnostic-log` are validated before the terminal enters raw mode.
- **Bounded shutdown** — one ordered, exactly-once sequence for quit, cancel,
  `SIGINT`/`SIGTERM` and fatal errors, ending with cursor, bracketed paste and
  alternate-screen restoration.
- **Durability exit code** — `74` when the work completed but the session could
  not be flushed; `130` for cancellation.
- **Redacted diagnostics** — `--diagnostic-log` writes JSONL with credentials
  replaced and prompts, arguments, file content and command output reduced to
  shape summaries. Never on stdout.
- **Render error boundary** — a failing region degrades to an error row instead
  of taking down the frame or the Agent.
- **Command palette** — `Ctrl+P` filters the exact Agent's command catalog and
  prefills the draft, so a command with arguments stays reviewable before it
  runs.
- **In-session switching** — `Ctrl+R` opens a session picker, and `/new` and
  `/resume` settle the current session durably before attaching the next one
  inside the same process.
- **Steering** — a message typed while the Agent is running reaches the live run
  immediately instead of queueing behind it; an idle Agent still gets a normal
  follow-up that waits for idle and flushes.
- **Transcript history paging** — the window renders a bounded tail and grows
  one page per `PgUp` at the oldest row, up to a retention limit. Paged-in
  history keeps the viewport anchor and never counts as unread.
- **Focus routing** — `Tab` moves between the composer and the transcript;
  navigation keys never leak into the draft.
- **Shell completions** — bash, zsh and fish, covered by a drift test and a real
  bash completion probe.
- **Property and composition tests** — `fast-check` properties cover seed/live
  equality, idempotent redelivery, gap detection, tool pairing and terminal-text
  safety and width; 13 composition tests drive the real plugin (exit codes,
  cancel, SIGTERM, stdin EOF, listener cleanup, session switching, steering).
- **Release tooling** — `npm run check:release` chains the upstream tuple,
  typecheck, tests, real profile, PTY matrix, resume, performance budgets,
  packed-artifact install and durability soak.

### Fixed

- Ink unmounts on the first `Ctrl+C` by default, which would have bypassed the
  bounded shutdown entirely. The renderer now runs with `exitOnCtrlC: false`, so
  the first press arms the confirmation and the second one runs the full
  sequence; a real PTY smoke asserts exit code 130 plus cursor and
  alternate-screen restoration.
- Bracketed paste lost its first characters because Ink strips the leading `ESC`
  from every chunk; both paste markers are now removed wherever they appear, so
  multi-line and IME text arrives intact and still never auto-submits.
- The projection scanned the whole transcript for every tool pairing, text merge
  and turn end. An id index and a pending-call set removed the quadratic paths:
  100k-event rebuild went from ~50s to ~0.3s and 10k from ~314ms to ~40ms.
- Duplicate detection retained a JSON copy of every event; it now keeps a
  numeric fingerprint, which is what brought 10k steady-state RSS to ~100 MB.
- Wrapping overflowed by one cell when a single glyph was wider than the whole
  row (a one-column terminal showing a wide CJK character). Found by the wrap
  property; such a cell is now replaced by a one-column stand-in.
- The package pinned unpublished peer versions, which made `pnpm install` fail
  outright. The Harness peers are now declared as optional ranges: a profile
  supplies them, so they must not block installation.
- `--permission` and `--model` were parsed and validated but never mapped into
  the plugin config, so both flags were silently ignored. Found by the first
  real-API run against the live model, where the status row still read
  `workspace-write` under `--permission read-only`.

### Known limitations

- Terminal editors that need the TTY are out of scope: `Ctrl+E` spawns a
  detached process, which suits GUI and remote editors.
- The packed-artifact gate installs the tarball out of tree and starts the real
  profile, but a fully published dependency closure needs a published Harness
  release; until then the adapter falls back to the pinned source checkout.
- SSH and tmux behavior is detected and degraded deliberately, but the manual
  environment matrix has not been executed.
- No mouse support, no image protocols, no PTY panel, no session search; these
  stay in P1.
