# DeepSeek Harness TUI — user guide

The TUI is a Harness **profile**, not a second agent. Every model call, tool
call, permission decision, and session write goes through the Harness runtime;
the terminal only shows what happened and forwards your input.

## 1. Install and start

The profile is loaded through `dsh`. In this repository the development
launcher creates `$DSH_HOME/profiles/tui`, links the local package into it, and
starts the real CLI:

```bash
pnpm install
pnpm tui -- "fix the race in the login module and run the related tests"
pnpm tui -- --interactive "review the working tree"
```

An installed setup runs the same thing directly:

```bash
dsh --profile tui "fix the race in the login module"
dsh --profile tui --interactive --resume latest
```

`stdin` and `stdout` must both be TTYs. A redirected run exits non-zero and
points at `--profile headless`; nothing is written to `stdout` in interactive
mode except the rendered frame.

## 2. Command line

| Flag | Meaning |
|---|---|
| `[task...]` | The first message. Required unless `--resume` is given. |
| `--interactive` | Keep the session open after the first task for follow-ups. |
| `--resume [session]` | Resume by session id, unambiguous id prefix, or `latest`. |
| `--permission <preset>` | `read-only`, `workspace-write` (default), `danger-full-access`. |
| `--model <route>` | `provider/model[:reasoning-effort]`, or `model[:effort]`. This run only. |
| `--alternate-screen` | Render on the alternate screen buffer and restore on exit. |
| `--no-color` | Disable semantic colors (also honored: `NO_COLOR`, `TERM=dumb`). |
| `--diagnostic-log <path>` | Append a redacted JSONL diagnostic log. Off by default. |
| `--help` | Print the TUI's own usage. |

Invalid values fail **before** the terminal enters raw mode.

Shell completions live in `packages/dsh-tui/completions/` for bash, zsh, and
fish.

## 3. Keys

| Key | Action |
|---|---|
| `Enter` | Send the draft. With an approval open: `y` allows once, `n`/`Esc`/`Enter` rejects. |
| `Ctrl+Enter` | Insert a newline instead of sending. |
| `Esc` | First press arms cancellation, second press cancels the current run. |
| `Ctrl+C` | Same two-step cancellation, then a bounded shutdown. |
| `PgUp` / `PgDn` | Scroll the transcript. Scrolling up pauses following and shows an unread count; at the oldest row `PgUp` pages more retained history in. |
| `Tab` | Move focus between the composer and the transcript. In transcript focus, `j`/`k` or `↑`/`↓` scroll and `Enter` returns to the composer. |
| `Ctrl+P` | Command palette: type to filter, `↑`/`↓` to select, `Enter` to prefill the draft, `Esc` to close. |
| `Ctrl+R` | Session picker: `↑`/`↓` to select, `Enter` to switch to that session, `Esc` to close. |
| `Ctrl+O` | Fold or unfold the tool card you are looking at. |
| `Ctrl+E` | Open that card's first file location in `$EDITOR`. |
| `↑` / `↓` | Draft history, or option selection inside a question. |
| `1`–`9`, `Space` | Pick a question option; `Space` toggles in multi-select. |

Pasted text is never sent automatically, even when it contains newlines.

A message sent while the Agent is running **steers** the current run and is
marked `queued for the current step`; a message sent while it is idle starts a
new turn.

## 4. Reading the screen

- `> text` — your message.
- plain text — the assistant, streamed.
- `~ text` — reasoning summary, folded by default.
- `▸ / ✓ / ✗ / ⚠ name  [badge]` — a tool call: running, succeeded, failed, or
  interrupted. The badge carries `exit 0`, `signal SIGTERM`, `+12 -4`,
  `17 matches`, or `1 of 400 lines`, depending on what the tool declared.
- Indented tool rows are Code Mode sub-calls under their parent call.
- `• text` — a durable marker (compaction, approval audit).
- `── turn …` — the end of one turn and its reason.

Long successful tool output folds automatically; failures stay open with their
tail visible. Output beyond the inline budget is reported as
`… N more line(s) not shown (output capped)` rather than silently dropped.

The status row shows the permission preset, plan/todo state, tool count, file
churn, approvals, subagent, context percentage, and token usage — all projected
from the Harness session projections, never recomputed locally.

## 5. Permissions

Three presets are configured by this profile:

| Preset | Files | Approvals |
|---|---|---|
| `read-only` | read only | required for anything else |
| `workspace-write` (default) | write inside the workspace | required for wider access |
| `danger-full-access` | unrestricted | not requested |

Switch with the official command: `/permission read-only`. Switching **to**
`danger-full-access` asks you to send the same command twice — the first send
only prints the warning.

Approval prompts show the tool, the streamed call summary, the reason, and the
active preset. There is no "allow everything" key. If the terminal cannot
answer — teardown, abort, a crashed renderer — the request is answered
`unavailable`, which the Harness treats as a refusal.

## 6. Sessions

- `/sessions` lists the sessions you can resume, newest first.
- `/new` flushes the current session and attaches a fresh one without leaving
  the TUI; `/resume [id|latest]` does the same for an existing session.
- `--resume latest` resumes the newest one; a prefix works when unambiguous.
- Resuming folds the complete persisted log first, then joins the live tail. If
  the log has a gap or an event this version does not understand, the transcript
  pauses with a diagnostic instead of showing a partial history.
- An unfinished tool call from an interrupted run is shown as `⚠ interrupted`,
  never as success.

## 7. Exit codes

| Code | Meaning |
|---|---|
| `0` | The task completed and the session was flushed. |
| `1` | The turn ended for another reason, or startup failed. |
| `74` | The work is done but the session could not be made durable. |
| `130` | Cancelled by `Esc`/`Ctrl+C`, `SIGINT`, or `SIGTERM`. |

Shutdown always runs the same sequence: stop input, settle pending approvals and
questions as unavailable, cancel, wait for idle within the grace window, flush,
dispose the agent handle, unmount, then restore the cursor, bracketed paste, and
alternate screen.

## 8. Diagnostics

`--diagnostic-log <path>` appends JSONL. Values are redacted: credentials become
`[redacted]`, and prompts, tool arguments, file content, and command output
become `[N chars]` shape summaries. Nothing is written to the interactive
`stdout`.

## 9. Platform support

| Platform | Level |
|---|---|
| Linux, macOS | Target platforms for the released profile. |
| Windows (Windows Terminal + ConPTY) | Verified in CI: approval, questions, resize, alternate screen, resume, 30-minute soak. |
| Legacy Windows console | Starts with a degradation notice; resize and Unicode support are limited. |
| tmux / screen | Detected; OSC hyperlinks and clipboard passthrough are disabled. |
| SSH | Detected; `$EDITOR` launches on the remote host. |
| `TERM=dumb`, `NO_COLOR` | No color, no alternate screen. |

See `docs/phase-0-compatibility-matrix.md` for what has actually been executed
and what is still pending.
