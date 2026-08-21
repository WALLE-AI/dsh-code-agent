# dsh-code-agent

[中文](README.md) | [English](README_EN.md)

[![npm version](https://img.shields.io/npm/v/dshcodecli.svg)](https://www.npmjs.com/package/dshcodecli)
[![Node.js](https://img.shields.io/badge/Node.js-%5E22.19.0%20%7C%7C%20%3E%3D24-339933?logo=node.js&logoColor=white)](packages/dsh-tui/package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)

A keyboard-first terminal coding agent for
[DeepSeek Harness](opensource/deepseek-harness/deepseek-harness-master).

dsh-code-agent provides the complete terminal interaction layer without
reimplementing the agent loop, tools, permissions, sandbox, or session
persistence. DeepSeek Harness continues to own those capabilities. This project
focuses on presenting the runtime accurately and routing user intent back to
Harness.

## Quick Start

### Install

~~~bash
npm install -g dshcodecli
~~~

Requirements:

- Node.js 22.19.0 or newer in the 22.x line, or Node.js 24+
- A real TTY with interactive stdin and stdout
- DeepSeek API credentials, or an existing Harness credential store

### Launch

Change into the project you want the agent to work on and run:

~~~bash
cd /path/to/your/project
dshcodecli
~~~

No placeholder task such as <code>-i "who are you"</code> is required. With no
arguments, dshcodecli opens the interactive composer and waits for your first
message.

The first launch in a directory displays a workspace safety prompt:

~~~text
Accessing workspace:

/path/to/your/project

Quick safety check: Is this a project you created or one you trust?
DSH Code Agent will be able to read, edit, and execute files here.

> Yes, use this folder
  No, exit
~~~

Project configuration is not read and Harness is not started until you accept.
Canonical trusted paths are stored in
<code>$DSH_HOME/tui/trusted-workspaces.json</code>. The home directory is trusted
for the current process only, so accepting it does not implicitly trust every
project below it.

You can also supply a task directly:

~~~bash
dshcodecli "review the current changes and run the relevant tests"
dshcodecli -i "review the working tree"
dshcodecli --resume latest
dshcodecli --permission read-only
~~~

## Credentials

The recommended global location is <code>~/.dsh/.env</code>:

~~~bash
umask 077
printf 'DEEPSEEK_API_KEY=sk-...\n' >> ~/.dsh/.env
~~~

A project can provide its own <code>.env</code>:

~~~dotenv
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
~~~

Configuration is resolved in this order:

1. variables already exported into the process;
2. <code>.env</code> in the current directory and its ancestors;
3. the repository-root <code>.env</code> in development mode;
4. <code>$DSH_HOME/.env</code>, or <code>~/.dsh/.env</code> by default;
5. the Harness credential store.

Project configuration never overwrites an already exported variable.

## Features

| Area | Capability |
|---|---|
| Startup safety | Trust prompt before project access; rejection starts no Harness service; private atomic trust storage |
| Conversation | No-argument REPL, streaming output, steering during a run, follow-ups, draft history, session resume, per-session model switching |
| Rendering | Markdown, code fences, tables, quotes, CJK wrapping, resize reflow, Unicode/ASCII fallback |
| Tools | Run/edit/search/read/web cards, colored diffs, folding, nested calls, explicit truncation |
| Permissions | read-only, workspace-write, danger-full-access, and fail-closed approvals |
| Navigation | Command and path completion, command palette, session browser, editor locations |
| Transcript | Full-screen Ctrl+T history, search, highlights, match navigation, copy, restore input to draft |
| Terminal | Differential frame painting, native scrollback, alternate screen, no-color mode, SSH/tmux fallback |
| Quality | Strict TypeScript, property tests, PTY smoke tests, performance budgets, packed-install and soak gates |

## CLI Reference

| Command | Description |
|---|---|
| <code>dshcodecli</code> | Open the interactive composer |
| <code>dshcodecli [task...]</code> | Run a one-shot task |
| <code>dshcodecli -i [task...]</code> | Stay interactive after the first task |
| <code>dshcodecli --resume [id]</code> | Resume by id, unambiguous prefix, or latest and enter interactive mode |
| <code>dshcodecli -r [id]</code> | Short form of <code>--resume</code> |
| <code>dshcodecli --resume-select</code> | Open the current-workspace session browser at startup |
| <code>dshcodecli --permission PRESET</code> | Select a permission preset |
| <code>dshcodecli --model ROUTE</code> | Override the model for this run |
| <code>dshcodecli --no-color</code> | Disable semantic colors |
| <code>dshcodecli --diagnostic-log PATH</code> | Write a redacted JSONL diagnostic log |
| <code>dshcodecli --help</code> | Show complete command-line help |

## Interactive Commands

Type <code>/</code> in the composer to complete commands. <code>/commands</code> and Ctrl+P open the same searchable command palette.

| Command | Description |
|---|---|
| <code>/model</code> | Open the searchable model picker, including partial-provider failures and reasoning-effort selection |
| <code>/model info</code> | Show the current session model |
| <code>/model PROVIDER/MODEL[:EFFORT]</code> | Switch this session starting with the next turn |
| <code>/model default</code> | Switch this session back to the saved default model |
| <code>/model save PROVIDER/MODEL[:EFFORT]</code> | Switch this session and save the route for future new sessions |
| <code>/status</code> | Show the session, model, permission, workspace, and runtime status |
| <code>/context</code> | Show context-window and token usage |
| <code>/permissions</code> | List permission presets; <code>/permissions PRESET</code> aliases <code>/permission PRESET</code> |
| <code>/clear</code> | Flush and start a new session; alias for <code>/new</code> |
| <code>/doctor</code> | Run read-only checks for the TTY, workspace, session, model catalog, and persistence |
| <code>/config</code> | Show effective non-secret paths, model, and permission |
| <code>/exit</code> | Flush and exit safely; alias for <code>/quit</code> |

A model switch never changes an in-flight request; it starts with the next turn. A normal <code>/model ROUTE</code>
is persisted as a session command and restored by <code>--resume</code>. Only <code>/model save ROUTE</code> changes the default for future sessions.

## Exit and Resume

When you exit normally with <code>/quit</code> or <code>/exit</code>, the TUI waits for the active task and flushes the session. After persistence succeeds, the terminal prints the exact session ID and resume command:

~~~text
Session saved: session-...
Resume: dshcodecli --resume session-...
~~~

Return to the workspace where the session was created and run that command. A valueless <code>--resume</code> is equivalent to <code>--resume latest</code>; neither form needs <code>-i</code>:

~~~bash
dshcodecli --resume
dshcodecli --resume latest
dshcodecli --resume session-abc
dshcodecli --resume-select
~~~

<code>latest</code> and the session browser consider only top-level sessions from the canonical current working directory. If an explicit ID belongs to another directory, the CLI prints the correct <code>cd</code> and resume command instead of silently restoring it in the wrong project. Resume with the same <code>DSH_HOME</code> that stored the session. A force-killed process cannot guarantee a final flush or an exit receipt.

## Keyboard Reference

| Key | Action |
|---|---|
| Enter | Submit the current draft |
| Ctrl+Enter / Alt+Enter | Insert a newline |
| Esc | Close the innermost surface; clear the composer before arming cancellation |
| Ctrl+C | Two-step cancellation and bounded shutdown |
| Tab | Accept completion, or switch composer/transcript focus |
| / | Complete a command; enter search inside the transcript screen |
| @ | Complete a workspace path |
| Ctrl+P | Open the command palette |
| Ctrl+R | Open the session browser |
| Ctrl+O | Fold or unfold the current tool card |
| Ctrl+T | Open the searchable transcript screen |
| Ctrl+X | Open the current card's first file location with $EDITOR |
| Shift+Tab | Cycle permission presets |
| ? | Open the shortcut reference |

Inside the transcript screen:

- <code>/</code> starts a search;
- <code>n</code> and <code>N</code> move through matches;
- <code>y</code> copies the current line and <code>Y</code> copies the whole entry;
- <code>r</code> restores a historical user message to the composer without submitting it;
- <code>q</code>, Esc, or Ctrl+T returns to the normal view.

Bindings can be changed in <code>~/.dsh/keybindings.json</code> or
<code>$DSH_HOME/keybindings.json</code>. See the
[user guide](docs/tui-user-guide.md) for the full reference.

## Architecture

~~~mermaid
flowchart LR
  User["Terminal / User"] --> TUI["dsh-code-agent TUI"]
  TUI --> Adapter["Harness adapter"]
  Adapter --> Harness["DeepSeek Harness"]
  Harness --> Agent["Agent loop"]
  Harness --> Tools["Tools / Sandbox / Permissions"]
  Harness --> Sessions["Sessions / Projections"]
  Harness --> Adapter
  Adapter --> TUI
~~~

The repository enforces explicit ownership boundaries:

- <code>packages/dsh-tui/src/harness-adapter.ts</code> is the only upstream coupling point;
- the TUI uses upstream-neutral contracts, projections, and view models;
- tools describe cards through data render intents instead of returning React nodes;
- <code>opensource/deepseek-harness</code> and <code>opensource/cordis</code> are read-only compatibility targets;
- <code>cordis.patch.yml</code> mounts the TUI as an external bundle overlay.

## Development

~~~bash
git clone https://github.com/WALLE-AI/dsh-code-agent.git
cd dsh-code-agent
corepack enable
pnpm install

pnpm run dshcodecli
~~~

Create a global development link:

~~~bash
pnpm link --global --dir packages/dsh-tui
dshcodecli
~~~

Common checks:

~~~bash
pnpm run build
pnpm run test
pnpm run check:startup
pnpm run check:interactive
pnpm run check:release
~~~

The complete release gate covers upstream contracts, strict type checking, the
full test suite, real profile composition, the PTY matrix, resume, cancellation
and terminal restoration, performance budgets, packed installation, and soak
testing.

## Releases and Artifacts

npm package: [dshcodecli](https://www.npmjs.com/package/dshcodecli)

~~~bash
npm install -g dshcodecli@latest
pnpm run package:npm
pnpm run publish:npm             # dry run
pnpm run publish:npm -- --yes    # upload
~~~

Additional artifacts:

~~~bash
pnpm run package:offline
pnpm run package:sea
~~~

Offline bundles are platform-specific. SEA artifacts also carry the Node.js
runtime.

## Security Model

- The default workspace-write mode requires approval outside the workspace.
- read-only blocks writes; danger-full-access displays an explicit warning.
- There is no global "allow everything" shortcut.
- An unavailable approval UI, interrupted terminal, or rendering failure is
  treated as rejection.
- Control characters and terminal escape sequences are sanitized before display.
- Diagnostic logs do not store raw credentials, prompts, file contents, tool
  arguments, or command output.
- Workspace trust is resolved before project <code>.env</code> files are read
  and before Harness starts.

## Platforms and Limitations

Linux and macOS are the primary release targets. Windows Terminal/ConPTY, SSH,
tmux, no-color terminals, and ASCII-only terminals have explicit probes or
fallback paths.

Current limitations:

- A real TTY is required. Non-interactive pipelines should use the Harness
  headless profile.
- The transcript screen does not implement mouse-drag selection; use
  <code>y</code> and <code>Y</code> to copy.
- Harness exposes no public session-fork or file-rewind API, so <code>r</code>
  restores input but does not roll files back.
- Terminal editors that must own the current TTY do not fit the detached Ctrl+X
  workflow.

## Documentation

- [Chinese README](README.md)
- [TUI user guide](docs/tui-user-guide.md)
- [Changelog](CHANGELOG.md)
- [Compatibility matrix](docs/phase-0-compatibility-matrix.md)
- [Architecture decision record](docs/adr/0001-external-tui-adapter-boundary.md)
- [TUI optimization and execution record](docs/tui-optimization-plan.md)
- [TUI package README](packages/dsh-tui/README.md)

## Contributing

Run the checks relevant to your change before submitting it. Changes to startup,
terminal lifecycle, projection contracts, or release artifacts should pass the
complete <code>pnpm run check:release</code> gate.

When opening an issue, include the Node.js version, operating system, terminal,
reproduction steps, and redacted errors. Never submit API keys, npm tokens,
project source, or unredacted session content.
