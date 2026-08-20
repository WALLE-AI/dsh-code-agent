# DeepSeek Harness TUI — user guide

The TUI is a Harness **profile**, not a second agent. Every model call, tool
call, permission decision, and session write goes through the Harness runtime;
the terminal only shows what happened and forwards your input.

## 1. Install and start

The profile is loaded through `dsh`. The `dshcodecli` command is the launcher in
front of it: it creates `$DSH_HOME/profiles/tui`, links the package into it,
loads credentials from the `.env` files described in §1.1, and starts the real
CLI.

```bash
pnpm install
pnpm link --global --dir packages/dsh-tui   # makes dshcodecli available anywhere

dshcodecli "fix the race in the login module and run the related tests"
dshcodecli -i "review the working tree"
dshcodecli -i --resume latest
```

The directory you run it in is the workspace the agent reads and edits. Inside
this repository the command runs the vendored CLI from source; installed
elsewhere it uses the installed `dsh` (override with `DSH_CLI`). `pnpm tui --`
and `./scripts/run-tui.sh` remain as aliases.

Nothing stops you from invoking the profile directly:

```bash
dsh --profile tui "fix the race in the login module"
dsh --profile tui --interactive --resume latest
```

`stdin` and `stdout` must both be TTYs. A redirected run exits non-zero and
points at `--profile headless`; nothing is written to `stdout` in interactive
mode except the rendered frame.

### 1.1 Where the API key comes from

`DEEPSEEK_API_KEY` (or the legacy `DEEPSEEK_API`) is read from the first of
these that has it, and `DEEPSEEK_BASE_URL` / `DEEPSEEK_URL` alongside it:

1. the environment you launch in — `DEEPSEEK_API_KEY=sk-… dshcodecli …` always wins;
2. `.env` in the working directory, then in each directory above it, so a key at
   a project root works from any subdirectory of that project;
3. `$DSH_HOME/.env` (`~/.dsh/.env` by default) — the machine-wide default, which
   is what to write if you want the command to work in every directory:

```bash
umask 077 && printf 'DEEPSEEK_API_KEY=sk-…\n' >> ~/.dsh/.env
```

The layers merge per variable rather than per file: a project `.env` that sets
only `DEEPSEEK_BASE_URL` still gets its key from `~/.dsh/.env`. A key stored
through the Harness credentials service (`$DSH_HOME/.credentials.yaml`) is used
when no `.env` supplies one. When nothing has a key, `dshcodecli` says so before
the TUI opens instead of leaving it to fail on the first turn.

## 2. Command line

| Flag | Meaning |
|---|---|
| `[task...]` | The first message. Required unless `--resume` is given. |
| `-i`, `--interactive` | Keep the session open after the first task for follow-ups. |
| `--resume [session]` | Resume by session id, unambiguous id prefix, or `latest`. |
| `--permission <preset>` | `read-only`, `workspace-write` (default), `danger-full-access`. |
| `--model <route>` | `provider/model[:reasoning-effort]`, or `model[:effort]`. This run only. |
| `--alternate-screen` | Render on the alternate screen buffer and restore on exit. |
| `--no-color` | Disable semantic colors (also honored: `NO_COLOR`, `TERM=dumb`). |
| `--diagnostic-log <path>` | Append a redacted JSONL diagnostic log. Off by default. |
| `--help` | Print the TUI's own usage. |

Invalid values fail **before** the terminal enters raw mode.

Shell completions live in `packages/dsh-tui/completions/` for bash, zsh, and
fish; each one covers both `dshcodecli` and `dsh`.

```bash
source packages/dsh-tui/completions/dsh-tui.bash      # bash
cp packages/dsh-tui/completions/dsh-tui.zsh ~/.zfunc/_dsh   # zsh, then compinit
cp packages/dsh-tui/completions/dsh-tui.fish ~/.config/fish/completions/dsh.fish
```

## 3. Keys

| Key | Action |
|---|---|
| `Enter` | Send the draft. |
| `Ctrl+Enter` / `Alt+Enter` | Insert a newline instead of sending. |
| `←` / `→` | Move the caret one character. |
| `Ctrl+←` / `Ctrl+→` | Move the caret one word. `Alt+←` / `Alt+→` and the readline pair `Alt+B` / `Alt+F` do the same. |
| `Ctrl+A` / `Ctrl+E` | Jump to the start or end of the current draft line. |
| `Ctrl+W` | Delete the word before the caret. `Alt+Backspace` and `Alt+Delete` do the same. |
| `Ctrl+U` / `Ctrl+K` | Delete to the start or end of the line. |
| `Esc` | Clears a non-empty draft first. With nothing to clear, the first press arms cancellation and the second cancels the current run. |
| `Ctrl+C` | Two-step cancellation, then a bounded shutdown. |
| `PgUp` / `PgDn` | Scroll the live rows. Scrolling up pauses following and shows an unread count. Settled rows are in the terminal's own buffer — use the wheel or `Shift+PgUp` for those. |
| `Tab` | Accept the open completion; otherwise move focus between the composer and the transcript. In transcript focus, `j`/`k` or `↑`/`↓` scroll and `Enter` returns to the composer. |
| `/` | At the start of the draft, completes a command name. `Tab` or `Enter` accepts, `↑`/`↓` selects, `Esc` dismisses. |
| `@` | Anywhere in the draft, completes a workspace path. A directory keeps the caret inside it so you can keep typing. |
| `?` | Show the shortcut sheet, when the draft is empty. It takes the whole screen, like the session browser, and any key closes it. |
| `Shift+Tab` | Cycle the permission mode through the presets the session offers. |
| `Ctrl+P` | Command palette: type to filter, `↑`/`↓` to select, `Enter` to prefill the draft, `Esc` to close. |
| `Ctrl+R` | Open the session browser, a full screen. Type to filter — the list *is* the search result, there is no mode to enter. `↑`/`↓` and `PgUp`/`PgDn` move the cursor, `Enter` resumes, `Esc` clears the filter and then closes. The cursor follows the session rather than the row number, so filtering cannot silently move it onto a different one. Wide terminals show a preview beside the list. |
| `Ctrl+O` | Fold or unfold the tool card you are looking at, including a collapsed run of look-ups. |
| `Ctrl+X` | Open that card's first file location in `$EDITOR`. |
| `↑` / `↓` | Move between lines of a multi-line draft, then walk the draft history. Inside a question, moves the option selection. |
| `1`–`9`, `Space` | Pick a question option; `Space` toggles in multi-select. |
| `y` / `n` | In an approval, allow once or reject outright. `1`–`9` answer by position, including the rows that ask for a reason. |

### Rebinding a key

Every shortcut in the table above is one row in a table the resolver and the
shortcut sheet both read, so rebinding one changes what the key does and what
`?` says it does in the same move.

Write `~/.dsh/keybindings.json` (or `$DSH_HOME/keybindings.json`), mapping an
action to a chord, a list of chords, or `null` to hand the key back to typing:

```json
{
  "palette:open": "ctrl+g",
  "session:browse": ["ctrl+r", "alt+r"],
  "help:open": null
}
```

Chords are lowercase, with `ctrl+`, `alt+` and `shift+` prefixes: `ctrl+g`,
`shift+tab`, `alt+left`, `pageup`, `escape`, `space`, `?`. Action names are the
`surface:verb` ids shown by the shortcut sheet — `palette:open`,
`session:browse`, `fold:toggle`, `editor:open`, `permission:cycle`,
`caret:word-left`, and so on.

`app:cancel` (`Ctrl+C`) and `app:escape` (`Esc`) are **reserved** and cannot be
rebound or unbound: a terminal you cannot get out of is not a terminal.

Anything wrong with the file — a misspelt action, an unreadable chord, a chord
you have given two meanings — is reported in the notice row and then ignored,
and the defaults stand. Nothing in that file can stop the TUI from starting,
because the TUI is where you would go to fix it.

### Scrolling: the terminal's, not the app's

**The mouse wheel is your terminal's.** A row that can no longer change is written
into the terminal's real scroll buffer and never touched again, so the wheel, the
scrollbar and `Shift+PgUp` reach the whole session — the banner included — exactly
the way they reach any other command's output. Drag-select works natively too,
with no `Shift` needed, and the session is still there after the TUI exits.

Only rows that are still moving stay in the repainted frame: the newest entry,
any call still running, and everything after it. Those are what `PgUp`/`PgDn` and
`Tab`+`j`/`k` page through, and what `Ctrl+O` folds — a card that has scrolled
into the terminal's buffer belongs to the terminal, so it cannot be re-folded or
re-wrapped on resize. That is the trade for scrolling that works everywhere,
including consoles that never forward wheel reports to the program at all.

`/mouse` claims the wheel for the live frame instead, if that is what you want to
scroll. `--alternate-screen` restores the old behaviour wholesale: the app takes
the screen, nothing reaches the scroll buffer, and the wheel is claimed for the
in-app viewport.

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
  model when the run was given one, and a line of tips. It is written into the
  terminal's scroll buffer, so it stays reachable for the whole session rather
  than holding rows on screen. On a colour terminal at least 40 columns
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

Long tool output folds automatically. A successful card shows three body rows,
or eight for a diff, whose rows are the answer rather than a preview of it. A
call that has not succeeded — failed, interrupted, or still running — gets eight:
enough to read the error or watch progress, and still bounded, so a command that
dies after printing forty frames of stack does not cost forty rows. A card never
folds to hide a single row, because saying so would cost that row back.

The budget is counted in **terminal rows, not lines**, so a card is folded by
what it would actually occupy at your width. This is what stops a single line of
JSON — one line by any count, twenty rows on screen — from pushing the rest of
the session out of view. `Ctrl+O` opens any card in full. An assistant's answer
is never folded for being long: prose is the reply, not evidence.

Output beyond the inline budget is reported as
`… N more line(s) not shown (output capped)` rather than silently dropped.

The transcript is in **causal order**: a tool card sits after the text that
led to it and before the answer it made possible, and the model's answer is
always the last thing in a turn. Each step of a turn keeps its own blocks, so
one turn can show several `∴ Thinking` sections and several `●` paragraphs —
they are the separate things the model actually said, not one merged bubble.

An assistant block with a tool call still to come in the same turn is a
**preamble** — the model saying what it is about to do. In the first turn it is
shown in full, because it is orientation and often carries the caveat the
answer rests on ("no tool to fetch those directly"). From the second turn on
the same narration is folded behind `Ctrl+O`, since by then you know the
routine. It folds only when folding buys a row: a one- or two-line preamble
stays exactly as it is.

A blank row separates a tool card from the answer that follows it, so a short
reply is not read as part of the card above it.

A **run of successful look-ups collapses into one card**. Three or more
consecutive reads and searches that all succeeded become a single row —
`✓ 8 reads · 2 searches` — whose body lists what was touched; `Ctrl+O` opens it
like any other card. This is what stops a turn that greps once and reads eight
files from spending forty rows saying so and pushing the answer off the screen.

Only reads and searches collapse, because *which* files were looked at matters
more than their contents. A command's output, a diff and a fetched page are
never hidden, nor is a call that failed, was interrupted, or is still running —
and the kind is taken from the card the tool declared, never from its name, so a
tool this profile has not seen is left exactly as it was. The tool count in the
status row keeps counting what ran, not what is shown.

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

Notices — `resumed session …`, `/mouse` toggles, terminal-capability warnings —
share one row and take turns on it. Each holds the row for its own timeout and
then yields; an answer to something you just did takes the row immediately and
gives it back to whatever it displaced. When more are waiting the row says so
with a trailing `+2`. Nothing is silently overwritten, and nothing stays for
ever.

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

The answers are:

| Row | What it does |
|---|---|
| `1` `allow once` | Grants this call and nothing else. |
| `2` `reject` | Refuses this call. |
| `3` `reject, and say why` | Refuses it and opens one line; what you type is sent as your next message, so the retry is informed rather than identical. |
| `4` `allow once, then switch to <preset>` | Grants this call, then sends the same `/permission` command `Shift+Tab` would. Shown only when there is a preset to advance to; switching **to** `danger-full-access` still needs its second confirmation. |

The order is deliberate: `1` and `2` mean what they have always meant, and `↑`
from the armed default still lands on `allow once`. The row that changes the
session's permission preset is last, so it is reached on purpose rather than by
muscle memory.

`y` allows once and `n` rejects outright — neither ever lands on a row that
would then ask you for something. `1`–`9` answer by position, `↑`/`↓` move and
`Enter` confirms the highlighted row. `Enter` only counts without a modifier
held, so a stray `Ctrl+Enter` cannot answer for you.

`Esc` on the list rejects, failing closed. `Esc` inside the reason field only
closes the field — the prompt is still open and nothing has been decided, so
opening it by mistake costs you one keystroke rather than a refusal.

Rejection is armed by default, and it is armed on a row that settles on its own:
an approval answered by accident fails closed and does not leave a text field
waiting. On a short terminal the preview is trimmed a row at a time and the two
wider answers are dropped, leaving `allow once` and `reject` — you can always
see what you are answering and how to answer it.

There is no "allow everything" key, and no answer here writes a permission rule:
the Harness's outcomes are one-shot by construction, and session-wide permission
is the preset, which is why the wider row names the preset it switches to. If the
terminal cannot answer — teardown, abort, a crashed renderer — the request is
answered `unavailable`, which the Harness treats as a refusal.

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
