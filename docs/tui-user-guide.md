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
| `Enter` | Send the draft. |
| `Ctrl+Enter` | Insert a newline instead of sending. |
| `←` / `→` | Move the caret one character. |
| `Ctrl+←` / `Ctrl+→` | Move the caret one word. |
| `Ctrl+A` / `Ctrl+E` | Jump to the start or end of the current draft line. |
| `Ctrl+W` | Delete the word before the caret. |
| `Ctrl+U` / `Ctrl+K` | Delete to the start or end of the line. |
| `Esc` | Clears a non-empty draft first. With nothing to clear, the first press arms cancellation and the second cancels the current run. |
| `Ctrl+C` | Two-step cancellation, then a bounded shutdown. |
| `PgUp` / `PgDn` | Scroll the transcript. Scrolling up pauses following and shows an unread count; at the oldest row `PgUp` pages more retained history in. |
| `Tab` | Accept the open completion; otherwise move focus between the composer and the transcript. In transcript focus, `j`/`k` or `↑`/`↓` scroll and `Enter` returns to the composer. |
| `/` | At the start of the draft, completes a command name. `Tab` or `Enter` accepts, `↑`/`↓` selects, `Esc` dismisses. |
| `@` | Anywhere in the draft, completes a workspace path. A directory keeps the caret inside it so you can keep typing. |
| `?` | Show the shortcut sheet, when the draft is empty. It takes the whole screen, like the session browser, and any key closes it. |
| `Shift+Tab` | Cycle the permission mode through the presets the session offers. |
| `Ctrl+P` | Command palette: type to filter, `↑`/`↓` to select, `Enter` to prefill the draft, `Esc` to close. |
| `Ctrl+R` | Open the session browser, a full screen. Type to filter — the list *is* the search result, there is no mode to enter. `↑`/`↓` and `PgUp`/`PgDn` move the cursor, `Enter` resumes, `Esc` clears the filter and then closes. The cursor follows the session rather than the row number, so filtering cannot silently move it onto a different one. Wide terminals show a preview beside the list. |
| `Ctrl+O` | Fold or unfold the tool card you are looking at. |
| `Ctrl+X` | Open that card's first file location in `$EDITOR`. |
| `↑` / `↓` | Move between lines of a multi-line draft, then walk the draft history. Inside a question, moves the option selection. |
| `1`–`9`, `Space` | Pick a question option; `Space` toggles in multi-select. |

The mouse wheel scrolls the transcript, the same viewport `PgUp`/`PgDn` move —
rolling far enough up reaches the startup banner. It has to: the frame is
repainted in place, so the terminal's own scrollback never receives a row of the
session and scrolling it would only show whatever the shell printed before
launch. Because the wheel is claimed, native drag-select needs `Shift` (most
terminals pass a shifted drag straight through). `/mouse` hands the wheel back to
the terminal if you would rather select and scroll natively; `PgUp`/`PgDn` keep
working either way, and a terminal with no `TERM` set never gets asked to report.

`Home` and `End` are not bound: Ink 5 resolves both to a key name it then blanks
out, so the TUI never sees them. `Ctrl+A` and `Ctrl+E` carry that duty. For the
same reason the physical `Backspace` and `Delete` keys arrive as one key and both
delete backwards; `Alt+Backspace` deletes the previous word.

Drafts you send are kept in `$DSH_HOME/tui/history.jsonl` (200 entries) and are
available to `↑` in the next session. A home directory that cannot be written
costs the history, never the session.

Pasted text is never sent automatically, even when it contains newlines.

A message sent while the Agent is running **steers** the current run and is
marked `queued for the current step`; a message sent while it is idle starts a
new turn.

## 4. Reading the screen

- A framed banner opens a fresh session with the directory, the branch, the
  model when the run was given one, and a line of tips. It scrolls away with the
  history rather than holding rows. On a colour terminal at least 40 columns
  wide it is led by the DeepSeek whale and a `deepseek` wordmark; with
  `NO_COLOR`, `--no-color`, `TERM=dumb` or a narrower window the art is dropped
  and the banner starts at the frame.
- `> text` — your message, on a filled background so it is findable while
  scrolling past screens of tool output (truecolor terminals only).
- `● text` — the assistant, streamed.
- `∴ Thinking` — reasoning, folded by default; `Ctrl+O` opens it.
- `▸ / ✓ / ✗ / ⚠ name  [badge]` — a tool call: running, succeeded, failed, or
  interrupted. The status mark is coloured by what the call does — run, edit,
  search, read, fetch — from the card the tool itself declared, never from its
  name; a tool this profile cannot classify keeps the plain tool colour, and a
  failure is red whatever it was doing. The badge carries `exit 0`, `signal SIGTERM`, `+12 -4`,
  `17 matches`, or `1 of 400 lines`, depending on what the tool declared.
- A tool card's body hangs under a ` ⎿ ` gutter so the card reads as one block.
- Indented tool rows are Code Mode sub-calls under their parent call.
- `• text` — a durable marker (compaction, approval audit).
- `── turn …` — the end of one turn and its reason.

Long successful tool output folds automatically — above three body rows, or
eight for a diff, whose rows are the answer rather than a preview of it. A card
never folds to hide a single row, because saying so would cost that row back.
Failures stay open with their tail visible. Output beyond the inline budget is reported as
`… N more line(s) not shown (output capped)` rather than silently dropped.

Rows wrap at word boundaries rather than being cut at the terminal edge; a token
wider than the row is broken, and CJK text breaks between characters. A resize
re-flows the whole transcript.

Diffs are coloured per row — added, removed and hunk headers each get their own
tone rather than sharing the card's. Assistant prose is rendered as markdown:
the syntax is consumed and only the styling is left. Headings lose their hashes,
`**bold**`, `*italic*`, `~~strikethrough~~` and `` `code` `` keep the text and
drop the delimiters, `[label](url)` shows the label followed by a dimmed URL,
list markers become `•`, quotes get a `│` gutter, and `---` draws a rule. Pipe
tables are laid out with their columns aligned by display width — CJK cells
included — with a `─┼─` rule under the header instead of the `|---|` row. Code
fences are the exception: the fence line becomes a rule carrying the language and
everything inside it is kept exactly as the model wrote it. A construct whose
closing delimiter has not streamed in yet stays literal until it arrives, and a
table wider than the layout budget is left as written. A terminal without wide
glyphs gets the ASCII stand-ins (`-`, `|`).

Colour follows the terminal: muted hexes on a truecolor terminal, ANSI names on
anything less so your own scheme still applies, and nothing at all under
`NO_COLOR`, `TERM=dumb` or `--no-color`. A terminal that cannot draw wide glyphs
gets ASCII stand-ins (`+ x ! >`) instead of replacement boxes.

A tool call that is still running shows a turning frame in place of its status
glyph and the time it has been running. Nothing animates once the session
settles: the frame clock only exists while the Agent is busy or a call is open.

Above the status row, a bar shows context pressure whenever the projection
reports a context window.

While the Agent is working, a line above the composer says so: a turning frame,
a verb, how long the turn has been going, and — once the wait passes thirty
seconds, when it starts to matter — the output token count.

The status row carries three fields: the activity segments on the left (the
model route the Harness resolved, the permission preset, plan/todo state, context percentage, tool count, file churn,
approvals, subagent, token usage, provider cache hit share), a hint in the middle for what the next key
does, and the branch, directory and session title on the right. All of it is
projected from the Harness session projections, never recomputed locally. On a
narrow terminal whole fields are dropped rather than wrapped, lowest value
first — the session title goes before the directory, and the permission preset
never goes at all.

When the projection reports a goal or a todo list, a two-line panel above the
composer shows the goal and the item in progress. It collapses to one line once
everything is done and takes no rows at all when there is nothing to show.

## 5. Permissions

Three presets are configured by this profile:

| Preset | Files | Approvals |
|---|---|---|
| `read-only` | read only | required for anything else |
| `workspace-write` (default) | write inside the workspace | required for wider access |
| `danger-full-access` | unrestricted | not requested |

The composer prompt is coloured by the active preset: red under
`danger-full-access`, where nothing will stop to ask, and cyan under
`read-only`. A preset this profile does not recognise leaves the prompt in its
ordinary colour rather than guessing at how permissive it is — the status row
still names it in full.

Switch with the official command: `/permission read-only`. Switching **to**
`danger-full-access` asks you to send the same command twice — the first send
only prints the warning.

Approval prompts show the tool, the active preset, the first rows of the call's
own card — the command or the diff you are being asked about — and the reason.
Answer with `y`/`1` to allow once or `n`/`2` to reject; `↑`/`↓` move between the
two and `Enter` confirms the highlighted one. `Enter` only counts without a
modifier held, so a stray `Ctrl+Enter` cannot answer for you. `Esc` rejects.
On a short terminal the preview is trimmed a row at a time, and the tool name
and both answers are the last things to go — you can always see what you are
answering and how to answer it.
There is no "allow everything" key. If the terminal cannot
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
