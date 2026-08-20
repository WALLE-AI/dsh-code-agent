# Changelog

All notable changes to the DeepSeek Harness TUI profile.

## Unreleased

### Fixed

- **The transcript showed the answer above the evidence that produced it.** A
  turn that searched five times and then replied rendered the reply first and
  the five cards after it — and it was not a display quirk in one place, it was
  every one of the eight upstream session samples. Two faults compounded:
  the projection treated `user`, `marker` and `turn` as block boundaries but not
  `tool`, so text written after a tool ran was folded back into the paragraph
  that preceded it; and an assistant message whose content held no text block
  still pushed an empty bubble, which then sat in front of the tool calls and
  swallowed the next step's answer.

  A text block is now open only while it is the last node. Once anything is
  pushed after it — a tool call above all — it is closed, and the next delta
  starts a new block. That is the streaming form of what upstream's own web UI
  and Claude Code both do by splitting a message into one node per content
  block, and the Code Mode sample now renders block-for-block against
  `apps/web/tests/snapshots/code-mode-round/ui.expected.md`.

  Two blocks of one message need two identities, so a block opened under a
  message id that already has one takes an ordinal. Without it the fixture with
  the interleaved shape produced two different paragraphs sharing the id
  `assistant:a1`, which the row cache, the fold set and the scrollback split
  would all have treated as one node.

  `upstream-fixture-parity.spec.ts` gained the assertion it was missing: the
  full node sequence of each sample, plus "no empty bubbles" and "no duplicate
  ids". It only ever checked the tool nodes' own properties, which is how a
  transcript in the wrong order passed for as long as it existed.

### Added

- **Tools can describe their live activity in their own words.** A
  `presentCall` intent may declare `activity`, such as `Reading src/app.tsx`,
  and the working line shows it while the call is pending. Existing tools keep
  using their card title as the fallback.

- **A run of successful look-ups collapses into one card.** A turn that greps
  once and reads eight files used to spend nine cards and forty rows saying so,
  which pushed the answer it was working towards off the screen. Three or more
  consecutive reads and searches that all succeeded now render as a single
  `✓ 8 reads · 2 searches` row whose body lists what was touched; `Ctrl+O` opens
  it like any other card, because it *is* an ordinary foldable card rather than
  a new mechanism.

  What may collapse is deliberately narrow. Only reads and searches, because
  *which* files were looked at matters more than their contents — a command's
  output, a diff and a fetched page are never hidden. Never a call that failed,
  was interrupted, or is still running. Never a nested Code Mode sub-call. And
  the kind is taken from the card the tool declared, never from its name, so a
  tool this profile has not seen is left exactly as it was. The tool count in
  the status row keeps counting what ran, not what is shown.

  A group takes its identity from its first member rather than its position, so
  it survives the re-projection that happens on every append. A group that can
  still absorb the call below it does not leave for the terminal's scroll
  buffer: flushing it early would leave `3 reads` in a buffer the frame can no
  longer reach while the truth had become four.

- **Approvals answer with more than yes and no.** The panel offered two rows,
  which is the whole reason people turn approvals off — the only way to stop
  being asked the same question was to stop being asked any question. Two
  answers that were always available and simply had nowhere to be typed are now
  offered:

  - `allow once, then switch to <preset>` grants this call and then sends the
    same `/permission` command `Shift+Tab` would. It names the preset, because
    you are changing the rules of the session rather than just this call, and
    entering `danger-full-access` still takes its own second confirmation.
  - `reject, and say why` refuses the call and opens one line; what you type is
    sent as your next message, so the retry is informed rather than identical.

  Neither invents a decision the Harness cannot honour: its outcome set is
  closed to one-shot values, and session-wide permission is the preset, which is
  why the wider row names the preset it switches to.

  `y` and `n` keep meaning allow-now and reject-now and never land on a row that
  would then ask for something. `1`–`9` answer by position. The armed default is
  computed from the list rather than pinned to an index, and it is always a
  rejection that settles on its own. `Esc` on the list still fails closed; `Esc`
  inside the reason field only closes the field, so opening it by mistake costs
  a keystroke rather than a refusal. On a terminal with no room for four rows
  the two wider answers are dropped first.

- **Keys can be rebound.** Write `~/.dsh/keybindings.json` mapping an action to
  a chord, a list of chords, or `null` to hand the key back to typing.

  This was only possible once the chords had one home. They used to be spelled
  inline in the resolver — `ctrl(key, 'p')` for the palette, `key.name === 'tab'
  && key.shift` for the mode cycle — with a second, hand-written table
  describing them for the shortcut sheet, and a drift test holding the two
  copies together. Rebinding anything in that arrangement meant editing the
  resolver, the sheet and the guide, and missing one of them was silent. The
  chords now live in one table that the resolver, the sheet and every piece of
  prose that names a key all read, so a rebind changes the behaviour and its
  description in the same move. The drift test is gone; there is nothing left
  for it to compare.

  `app:cancel` and `app:escape` are reserved and cannot be rebound: a terminal
  you cannot get out of is not a terminal. A misspelt action, an unreadable
  chord, or a chord given two meanings is reported in the notice row and then
  ignored — a bad config file must never be what stops the terminal from
  opening, because the terminal is where you would fix it.

  Conflicts are only reported when the override caused them. Some chords are
  shared on purpose — `Tab` accepts a completion while the list is open and
  moves focus when it is not — and telling someone their config broke something
  they never touched is worse than saying nothing.

  What did *not* move into the table is when an action applies. Whether `↑`
  walks the history or moves the caret depends on where the caret is, and that
  is a condition, not a chord.

- **A preamble is shown once and folded thereafter.** An assistant block with a
  tool call still to come in the same turn is the model narrating its intent.
  The first turn shows it in full — it is orientation, and it often carries the
  caveat the answer rests on. From the second turn on it folds behind `Ctrl+O`.
  It is folded rather than dropped for that same reason: "I have no tool that
  can fetch those directly" is what tells you how far to trust the answer, and
  it must stay reachable. Folding only happens when it buys a row, so a short
  preamble is left exactly as it was.

- **A blank row lifts an answer off the tool card above it.** A one-line reply
  pressed against a tall card read as part of it. The row is added only for
  that transition: card-after-card stays tight, and a block followed by the
  tool it triggered is one thought and is not cut in half. The spacer belongs
  to the block it introduces, not to the card above, so it cannot be stranded
  when the card leaves for the terminal's scroll buffer.

- **Notices take turns instead of overwriting each other.** The row held a
  single string, so whatever was said last won and nothing ever expired: a
  terminal-capability warning raised at startup was written over by the
  `resumed session …` line one statement later and never reached the screen, and
  a `/mouse` toggle stayed up for the rest of the session. Notices are now
  queued — each holds the row for its own timeout and then yields it, an answer
  to something you just did takes the row immediately and gives it back to
  whatever it displaced, and a repeated event replaces or folds into itself
  rather than queueing twice. When more are waiting the row says so with a
  trailing `+2`. An idle session with an empty queue still holds no timer.

### Changed

- `app.tsx` was 888 lines carrying the frame's state, its layout budget, its
  input dispatch and all five of its modal regions. The decisions moved out to
  where they can be tested without a terminal: `view-model.ts` derives the whole
  frame as one pure function, `input-dispatch.ts` acts on a resolved action,
  and `views/` paints. What is left is the wiring only React can express.

### Fixed

- The live frame no longer prints a second `DeepSeek Harness TUI` header after
  every settled turn. The product title now appears only in the startup splash,
  and the reclaimed row is available to the transcript.

- Wrapped user and assistant headers now use a hanging indent, so continuation
  rows align with the text after `> ` or `● ` instead of jumping back to column
  zero. Continuations are rewrapped to their smaller width budget, keeping CJK
  text and styled Markdown inside the terminal width.

- Ink reports a bare `Esc` with its `meta` flag set, because the escape key
  *is* the meta prefix on that wire. Chord normalisation now ignores it there;
  honouring it would have spelled every `Esc` as `alt+escape` and left the
  binding permanently unmatched.

- Ink measures a `<Text>` holding an empty string as zero rows tall, so a blank
  row asked for by the transcript model simply vanished. Blank rows are drawn as
  a row again; the model still says `''`, because what an empty line costs to
  draw is the view's problem.

- `interactive-smoke.ts` still required wheel reporting to be enabled on every
  run, which had stopped being true when the wheel was handed back to the
  terminal outside the alternate screen. It now asserts what the profile
  actually does: reporting is claimed on the alternate screen, never claimed
  outside it, and released whenever it was claimed.

## 0.1.4

### Changed

- **The mouse wheel is the terminal's again, and it reaches the whole session.**
  The transcript used to be one repainted viewport: every row the session
  produced lived inside a region the terminal treats as a single frame. The
  shell's scroll buffer therefore held nothing but torn fragments of earlier
  repaints — scrolling up showed pieces of old frames rather than the
  conversation, and the banner existed nowhere the terminal could reach. Wheel
  reporting was turned on to compensate, which works only on terminals that
  forward it, and takes the wheel away from the ones that do not: on those the
  wheel did nothing at all.

  Rows now leave the frame instead. An entry that can no longer change is
  written once, through Ink's `<Static>`, into the terminal's real scroll
  buffer; only rows that are still moving stay in the repainted frame, which is
  sized to its content rather than padded to fill the screen. The wheel, the
  scrollbar, `Shift+PgUp` and drag-select all work natively, on every terminal,
  with no reporting mode — and the session is still there after the TUI exits.
  Wheel reporting is off by default; `/mouse` claims it for the live frame, and
  `--alternate-screen` restores the previous model wholesale.

  What may leave is deliberately conservative, because scrollback is
  append-only: the longest prefix of settled entries, never the newest one
  (streaming grows it), and never past a call that is still running.

  The cost is stated rather than worked around: a row in the terminal's buffer
  belongs to the terminal, so it cannot be re-wrapped on resize, and its card
  can no longer be folded with `Ctrl+O`. Both still hold for the live region,
  where a card spends the time anyone is looking at it.

- Ink falls back to `ESC[2J ESC[3J ESC[H` — which erases the scroll buffer
  itself — as soon as a frame is as tall as the terminal. That would throw away
  everything this design hands to the terminal, so it is now a tested
  invariant that the frame stays strictly shorter, at any size.

## 0.1.3

### Fixed

- **Tool output no longer buries the conversation.** A card folded only when its
  output had more *lines* than its budget, which missed the case that actually
  floods a terminal: a few lines each wide enough to wrap across the screen. One
  `node -e` printing a 2 KB JSON response was two lines by that measure and
  nineteen rows on screen. Folding is now judged on the rows a card would
  occupy at the current width, so no tool card costs more than its budget
  regardless of how its output is shaped.
- **A failed call is no longer unbounded.** Failures were never folded at all,
  so a command that died after printing forty frames of stack rendered all
  forty. A call that has not succeeded — failed, interrupted, or still running —
  now gets a *larger* budget than a success (8 rows against 3) rather than an
  infinite one: enough to read the error or watch progress, bounded enough to
  leave the rest of the session on screen.
- Together these are why earlier turns scrolled away. On the reported session —
  eight calls in one turn — the cards came to 66 rows on a 45-row terminal, so
  the opening question was already gone; they now come to 16, and the whole
  exchange fits. `ctrl+o` still opens any card in full, and an assistant's
  answer is never folded for being long: prose is the reply, not evidence.

### Notes

- The `TERM is unset or dumb; the alternate screen buffer is disabled` line in
  that session is from 0.1.0. Windows sets no `TERM` in cmd, PowerShell or
  Windows Terminal, which 0.1.0 read as "unknown, assume the worst" and so
  turned the alternate screen off on every Windows machine. Fixed in 0.1.1.

## 0.1.2

### Fixed

- **`dshcodecli` finds your API key from any directory.** The launcher only read
  `.env` from the exact directory the command was typed in, so a key at a project
  root worked there and nowhere else — every other directory failed the first
  turn with `MISSING_CREDENTIAL llm-deepseek: no API key for provider route
  "deepseek-official"`, and the message could only point at the environment or
  the web Models page. `.env` is now read from the working directory, then each
  directory above it, then `$DSH_HOME/.env` (`~/.dsh/.env`), which is the
  machine-wide place to set a key once. The files layer per variable rather than
  first-file-wins, so a project `.env` that sets only `DEEPSEEK_BASE_URL` no
  longer hides the only key on the machine. When nothing anywhere has a key —
  including `$DSH_HOME/.credentials.yaml` — the launcher says so and names the
  file to write, before the TUI takes the screen.

### Added

- **`npm run publish:npm` is the release command.** `package:npm` still stops at
  the tarball by design; this is the other half, and the only thing in the repo
  that uploads. It refuses to run against a read-only mirror, refuses a version
  that npm already has (naming the versions that exist and the bump to make),
  checks the login against the publish registry rather than the configured one,
  refuses a dirty tree without `--allow-dirty`, and re-reads the registry
  afterwards instead of trusting the exit code. Without `--yes` it is a dry run
  that performs every check and uploads nothing.

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

- **`dshcodecli` is the launch command.** One binary (`bin/dshcodecli.mjs`),
  usable from any directory once linked or installed, replacing the
  run-it-from-the-repo-root `pnpm tui -- …` incantation. It picks its mode from
  where it resolves: inside this checkout it runs the vendored CLI from source
  with `--conditions=development`; installed elsewhere it uses the installed
  `dsh` (`DSH_CLI` → a `@deepseek-ai/dsh` dependency → `PATH`, and naming
  `DSH_CLI` forces this mode). Either way it writes `$DSH_HOME/profiles/tui`,
  links this package in, reads `DEEPSEEK_API`/`DEEPSEEK_URL` from a `.env` next
  to you without overwriting anything you exported yourself, adds
  `--use-env-proxy` when a proxy is set and the runtime is new enough to accept
  it, and runs **in the directory you typed the command in** — that directory,
  not the checkout, is the workspace the agent edits. `-i` is now accepted as
  the short form of `--interactive`, `--help` names the command you actually
  typed, and shell completions cover both `dshcodecli` and `dsh`.

- **`npm run package:npm` builds the publishable tarball.** The workspace
  package is `@deepseek-ai/dsh-tui` because that is the bundle specifier
  `cordis.patch.yml` imports and the name the profile links the directory under
  — and it belongs to someone else's npm org. The script stages a copy renamed
  to `dshcodecli`, drops `private`, and adds `@deepseek-ai/dsh` as a real
  dependency so a single `npm i -g dshcodecli` brings the CLI too; the profile
  still links the installed directory in as `@deepseek-ai/dsh-tui` by absolute
  path, so both names keep working. It installs the tarball into a throwaway
  project and drives the command before reporting a sha256, and it stops short
  of publishing. This artifact is the cross-platform one: the package is pure
  JavaScript and every native dependency is resolved per machine by npm.

- **A Windows `dsh.cmd` shim is started through a shell.** Node has refused to
  execute batch files directly since the 2024 argument-injection fix, so the
  `PATH` fallback would have failed on exactly the machines that need it.

- **Two packaging scripts that produce something you can hand to a machine that
  has neither this checkout nor a network.** `npm run package:offline` builds
  `dist/dshcodecli-<version>/` (and a tarball): the profile, the published
  `@deepseek-ai/dsh`, and every runtime dependency, installed once on the build
  machine, plus `dshcodecli` / `dshcodecli.cmd` launchers — the target needs only
  Node ≥22.19. Both are specific to the platform they were built on — six
  packages in the `dsh` closure ship a compiled binary as a per-platform
  optional dependency, and npm installs only the variant matching the build
  machine — so the manifest and the bundle's own README name that platform and
  list those packages. `npm run package:sea` goes one step further and
  injects the bundle into a copy of the Node binary as a single-file executable,
  which needs no Node at all; it unpacks itself into `$XDG_CACHE_HOME/dshcodecli`
  on first run, because the Harness resolves profiles through real directories.
  Both scripts drive their own output through help, a non-TTY refusal and a
  profile-write check before reporting a size and a sha256. The bundled `dsh` is
  the released version rather than the pinned `rc.5`, which was never published;
  the exact version travels in the bundle's `MANIFEST.json`.

- **The mouse wheel scrolls the transcript** — a wheel roll used to scroll the
  terminal's own buffer, which holds none of the session: the frame is repainted
  in place, so nothing is ever handed to scrollback, and rolling up past two
  turns showed the shell's output from before launch instead of the banner.
  Wheel reporting (`?1000` + `?1006` SGR) is on for a TTY whose `TERM` is set,
  `src/mouse.ts` parses the reports — including the several a fast roll batches
  into one chunk — and each notch moves the same viewport `PgUp`/`PgDn` move, so
  rolling up reaches the whale and the wordmark again. Every report is consumed,
  never typed into the draft. Claiming the wheel means native drag-select needs
  `Shift`; `/mouse` hands it back to the terminal, and the mode is cleared on
  every exit path so no shell inherits it.
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
- **Brand art on the banner** — a colour DeepSeek whale drawn in half-block
  cells and a `deepseek` wordmark in a block font with a left-to-right gradient
  lead the banner on a terminal that can carry them. Both are dropped whole on
  an ASCII terminal, under `NO_COLOR`/`--no-color`, or below 40 columns: art
  with the colour removed is a grey slab, not a degraded whale. Below truecolor
  the palette falls back to named 16-colour blues so the outline stays distinct
  from the body. The sprite and the glyph table come from the `dsh-TUI` project
  (MIT) — see `THIRD_PARTY_NOTICES.md`; the painters are ours and emit ordinary
  styled transcript rows.
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
  focus is never dropped, for any list size, focus and budget. The draft
  completion list runs through the same model, so it too keeps the focused
  candidate on screen and now says how many it is hiding; `terminalLayout`
  knows the region as `overlay: { rows }` rather than by which list is showing.
- **Colour that says what a row is** — the user's own message sits on a filled
  background (truecolor only; a 16-colour block would be a slab), a tool card's
  status mark takes the colour of what the call *does* — run, edit, search,
  read, fetch — from the card kind the tool declared rather than from its name,
  and the composer prompt takes the permission preset's colour so
  `danger-full-access` looks like what it is. Unclassifiable kinds and unknown
  presets keep the ordinary tone rather than guessing.
- **Cache hit share in the status row** — `cache 76%` from the session's own
  token-usage projection, using the Harness's own definition (cache reads over
  all three disjoint prompt-side buckets). It is the first segment dropped on a
  narrow terminal, and it is absent entirely until something has been billed.
  There is no tokens-per-second segment beside it: the projection reports no
  rate, and a locally computed one would be this profile's guess wearing the
  Harness's authority.
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

- **`pnpm tui` and `scripts/run-tui.sh` are now thin aliases for `dshcodecli`**
  (the latter still forcing `--interactive`), and `scripts/launch-tui.ts` is
  gone — its profile-preparation logic moved into the new bin unchanged, and the
  shell script's `.env` and proxy handling moved there too, so both work from
  any directory instead of only from the repository root. A new `check:cli` gate
  covers the launcher, and `check:packed` now fails if the tarball ships without
  it.
- **Assistant prose is rendered as markdown, not just tinted.** The syntax is
  consumed and only the styling survives: headings drop their hashes, bold,
  italic, strikethrough, code spans and links lose their delimiters, list
  markers become one glyph, `---` draws a rule, and pipe tables are laid out
  with columns aligned by display width (CJK included) under a `─┼─` rule.
  Fenced code keeps its contents verbatim. The renderer still emits exactly one
  row per source line, so header/detail alignment and fold counts are unchanged;
  an unclosed construct stays literal until the rest of it streams in.
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

- Windows lost the alternate screen buffer on every machine. `detectTerminal`
  read an empty `TERM` as "unknown terminal, assume the worst" and reported
  `TERM is unset or dumb; the alternate screen buffer is disabled` — but Windows
  never sets `TERM`, not in `cmd`, not in PowerShell, not in Windows Terminal,
  so the condition was true for every Windows user. An empty `TERM` now only
  disables the alternate screen off Windows, where it really does mean the
  caller stripped it; `TERM=dumb` still disables it everywhere.
- The screen flickered on every repaint once anything animated. Ink only
  repaints incrementally while the frame is shorter than the terminal; at
  `outputHeight >= stdout.rows` it erases the whole screen and rewrites it
  (`ink.js:121`). The layout was spending the full row count, so every frame
  took that path — measured 29 of 29 streaming frames carrying `ESC[2J`.
  `terminalLayout` now reserves one row of headroom, which brought that to 0.
  A layout invariant asserts the frame stays strictly shorter than the terminal
  across heights, and a view test asserts no streamed frame clears the screen.
- The same flicker returned whenever an approval was pending, which is where it
  was most disruptive: the answer you are being asked for is on the screen that
  will not hold still. The approval region renders a blank row, a title, a
  preview of the call and one row per answer, but the layout budgeted only two
  or three rows for the whole thing — up to six rows of overflow, repainted on
  every spinner tick. `terminalLayout` now budgets the region as it is actually
  drawn, trims the preview when the terminal is short, and drops the separating
  blank row before it would let the answers themselves off the screen.
- Even below that threshold the screen still flickered, because staying under
  the terminal height only avoids Ink's *full-screen* clear. Its ordinary
  repaint erases every row it wrote last time and then rewrites them
  (`log-update`: `eraseLines(previousLineCount) + output`), so a frame that
  nearly fills the terminal is blanked and redrawn ten times a second while the
  spinner turns — 40 rows erased per render, measured over 70 consecutive
  renders with an approval pending. Between two ticks only a handful of those
  rows actually differ, so `src/frame-writer.ts` now wraps the output stream and
  repaints in place: it walks the cursor up, overwrites only the rows that
  changed, steps over the rest with a bare newline, and writes nothing at all
  for an identical frame. No row is erased before it is overwritten, so there is
  no blank state to see. It is a transformation of Ink's own bytes, not a
  replacement renderer — a write it does not recognise, or a frame whose height
  changed, is handed back to Ink untouched.
- The startup banner painted as a grey slab instead of the brand art. The whale
  and the wordmark *are* their styled runs — the shape is carried by colour, not
  by the characters — and the header rows were copied into the transcript with
  `text` and `tone` only, dropping the runs on the way. They are carried
  through now, and a row that brings its own colours is no longer dimmed on top
  of them.
- The whale's outline was trimmed with grey speckle wherever it met empty
  space. A half-block paints its other half with the background, so a cell whose
  top pixel was transparent was drawing that top half in the terminal's default
  foreground; a one-pixel cell now takes the block that sits on its own half and
  no background at all.
- The `?` shortcut sheet rendered a viewport's worth of rows while the layout
  had only reserved the smaller palette budget, so it overflowed the frame and
  triggered the same full-screen clear. It is now a screen of its own, like the
  session browser, rather than a region inside the conversation frame.
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
