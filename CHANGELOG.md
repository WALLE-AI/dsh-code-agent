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

- **Testable key bindings** — the 160-line `useInput` cascade became a pure
  resolver in `src/keymap.ts`. The Ink layer translates a keypress into a
  renderer-independent event and dispatches the action the resolver returns, so
  binding precedence, graded `Esc` and modal key containment are unit tested
  without a terminal. `KEY_BINDINGS` is the documented table, and a drift test
  fails when a binding is missing from the user guide.
- **Caret editing in the composer** — the draft is a string plus a code-point
  cursor. `←`/`→`, `Ctrl+←`/`Ctrl+→`, `Ctrl+A`/`Ctrl+E`, `Ctrl+W`, `Ctrl+U`,
  `Ctrl+K` and `Alt+Backspace` all edit in place; `↑`/`↓` move between lines of a
  multi-line draft before falling through to the history. The rendered caret
  follows the edit and the visible window scrolls to keep it on screen.
- **Draft completion** — `/` completes a command name at the start of the draft
  and `@` completes a workspace path anywhere in it, matching on relative path
  or basename. `Tab` or `Enter` accepts, `Esc` dismisses the list for that token
  only. Accepting replaces just the matched token; a directory keeps the caret
  inside it. The path walk is bounded, skips VCS and dependency directories, and
  refuses a prefix that climbs out of the workspace.
- **Persistent draft history** — submitted drafts are appended to
  `$DSH_HOME/tui/history.jsonl` (200 entries) and seed the next session's `↑`
  walk. Parsing is total: a truncated tail costs one entry, and an unwritable
  home costs the history rather than the session.
- **Working line** — while the Agent is working, one line above the composer
  carries a turning frame, a verb, the turn's elapsed time and, past thirty
  seconds, the output token count. The verb is chosen from the turn index rather
  than at random, so a frame stays reproducible from its inputs. It outranks the
  todo panel in the row budget, being the only thing that says the run is alive.
- **Resolved model in the status row** — the Harness already knew which model it
  had selected; the adapter now reports it through a hook, so the row shows the
  real route rather than only an explicit `--model`. Neither it nor the
  permission preset is ever dropped when the row is squeezed.
- **Session browser** — `Ctrl+R` opens a screen instead of an overlay: it
  replaces the conversation, so nothing underneath can be repainted or bleed
  through, and it is rendered as an early return after every hook has run.
  Typing filters, with no mode to enter — the list *is* the result. The cursor
  is a session **id**, not a row number, so filtering can never silently move it
  onto a different session. `Enter` resumes and the screen stays open until the
  resume lands; `Esc` peels one layer per press, clearing the filter before
  closing. Wide terminals get a preview beside the list.
- **Startup banner** — a fresh session opens with a framed title, the directory
  and branch, the model when the run was given one, and a line of tips. It is
  stored as transcript rows rather than a pinned region, so it scrolls away with
  the history and costs nothing thereafter, and it re-flows on resize. Facts the
  profile was not told are left out rather than filled with a placeholder.
- **Speaker marks and the tool gutter** — the assistant gets a `●`, reasoning
  folds behind `∴ Thinking` instead of a bare `~`, and a tool card's body hangs
  under a ` ⎿ ` gutter with its continuation rows aligned, so a card reads as one
  block. All four have ASCII stand-ins.
- **Fold limits per card kind** — three body rows for prose, eight for a diff,
  and never a fold that hides a single row, since the marker saying so would
  cost that row back.
- **Shared overlay pane** — the command palette, the session picker and the new
  shortcut sheet render through one model with one window rule. The window is
  computed from a *row* budget, growing alternately from the focus and taking
  the shorter side, which replaces two copies of an `index - 2` slice that
  pushed the focused row off the end of a long list. A property test asserts the
  focus is never dropped, for any list size, focus and budget.
- **Approval panel** — the one-line `[y/N]` prompt became a panel that shows the
  first rows of the pending call's own card, so the decision is made against the
  command or the diff rather than a joined summary. `↑`/`↓` move between allow
  and reject with reject highlighted by default; confirmation requires a bare
  `Enter`, so a modifier held over from the previous keystroke cannot answer a
  prompt that gates a tool run. `y`/`n` still answer directly. A questionnaire
  waiting behind an approval is now reported rather than silently dropped.
- **Shortcut sheet** — `?` on an empty draft shows the bindings, generated from
  the same table the resolver uses, so it cannot drift from the real keymap.
- **Permission mode cycling** — `Shift+Tab` walks the presets the session
  reports, going through the official `/permission` command so the Harness stays
  the source of truth.
- **Per-row tone** — `TranscriptLine.tone` was per entry, so a diff's added and
  removed lines were painted in the card's single colour. Card bodies are now
  toned rows and rows carry styled runs, which is what finally makes red/green
  diffs possible; context rows stay untoned and inherit the card.
- **Semantic palette** — `theme.ts` maps a tone to what the terminal can show:
  muted hexes on truecolor, ANSI names below it so the user's own scheme still
  applies, and nothing at all under `NO_COLOR` or `--no-color`. The capability
  probe's `colorLevel`, which used to be collapsed to a boolean, now reaches the
  renderer.
- **Glyph fallback** — status and structure markers come from a glyph set chosen
  by the `unicode` capability, so a legacy console shows `+ x ! >` instead of
  replacement boxes.
- **Markdown styling** — assistant prose gets fenced code blocks, headings,
  quotes, list markers, inline code and bold. It is line-oriented rather than a
  parser, so it costs the same per streamed delta and an unterminated fence or
  `**` just stays plain until it closes; a plain-text fast path and a size
  ceiling keep a pathological message off the frame budget. The markup is never
  hidden, so each styled row's text still equals its source exactly.
- **Word wrapping** — rows wrap at word boundaries instead of being truncated at
  the terminal edge, breaking oversized tokens and breaking CJK between cells.
  Wrapping happens in the store, so a resize re-flows the transcript. Rows are
  memoized per entry against width and fold state: a streamed delta re-wraps one
  entry (~1 ms on an 8000-row transcript) rather than all of them, which a new
  performance spec pins.
- **Running feedback** — a call that is still open shows a turning frame in
  place of its status glyph plus the time it has been running. Start times are
  kept in the store, not the projection, so the durable event fold stays
  replay-deterministic and a resumed call correctly shows no elapsed time. The
  frame clock is mounted only while something is running: a settled session
  holds no interval, which a test asserts by watching the frame count go quiet.
- **Status row rebuilt** — the single joined string became a segment model with
  an explicit drop order, a context-pressure bar on its own row, and a hint
  field that says what the next key does (`esc to interrupt` while running,
  `paused · N unread` when scrolled away). Narrow terminals drop whole fields
  from the least valuable up instead of truncating mid-word; the permission
  preset is never dropped. The branch and directory are now shown, the branch
  read straight from `.git/HEAD` rather than by spawning `git`.
- **Goal and todo panel** — the goal, todo counts and active item the projection
  has always computed are finally rendered, above the composer, collapsing to
  one line when the work is done and to nothing when there is none.
- **Unicode capability detection** — a legacy Windows console, `TERM=dumb` or a
  non-UTF-8 locale now yields `unicode: false`, which selects ASCII stand-ins
  and a static status glyph instead of frames the terminal cannot draw.
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

### Changed

- The gate scripts, `upstream-compat.json`, the fixture-parity spec and the
  adapter's source fallback all pointed one directory above the vendored Harness
  root, so every terminal gate failed to boot while `pnpm tui` worked. All of
  them now resolve `opensource/deepseek-harness/deepseek-harness-master`.
- Inline `` `code` `` and `**bold**` keep their delimiters. Consuming them left
  the styled runs no longer summing to the row's own text, which is the string
  that drives wrapping, width and search — a property test caught it on `` ` ` ``.

- `Ctrl+E` now jumps to the end of the draft line, the readline binding it
  displaces nothing else could carry: Ink 5 resolves `Home`/`End` to a key name
  it then blanks out, so the TUI never receives them. Opening a tool card's
  location in `$EDITOR` moved to `Ctrl+X`.
- `Esc` clears a non-empty draft before it arms a cancellation, so a half-typed
  message is no longer one keystroke away from stopping the run.

### Fixed

- Bracketed paste was disabled on exit but never enabled on entry, so pastes
  arrived as ordinary keystrokes and were only cleaned up defensively. The
  terminal guard now sends `?2004h` alongside the alternate-screen switch.
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
