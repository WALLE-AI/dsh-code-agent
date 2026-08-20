/**
 * Capture the rendered transcript of a scripted multi-turn session.
 *
 * The ordering of tool cards against model prose is the kind of thing that can
 * only be judged by looking at it, and a hand-drawn mock-up is exactly the sort
 * of evidence that quietly disagrees with the code. So this drives the real TUI
 * in a real pty against the mock model server, replays the writes the way a
 * terminal would, and prints the screen.
 *
 * Each scripted turn is `tool_call_success` followed by `success`, which is the
 * shape the screenshot came from: the model calls a tool, the tool runs, and the
 * model then answers.
 *
 *     npm run capture:transcript             # 3 turns, 80x40
 *     npm run capture:transcript -- --turns 2 --rows 30
 *
 * Exit code is 0 on a clean capture; the output is for reading, not asserting.
 */

import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const harness = join(root, 'opensource/deepseek-harness/deepseek-harness-master')

function flag(name: string, fallback: number): number {
  const at = process.argv.indexOf(`--${name}`)
  if (at === -1) return fallback
  const value = Number(process.argv[at + 1])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

const turns = flag('turns', 3)
const cols = flag('cols', 80)
const rows = flag('rows', 40)

const ptyModule = await import('node-pty') as {
  spawn(file: string, args: string[], options: Record<string, unknown>): {
    onData(callback: (data: string) => void): { dispose(): void }
    onExit(callback: (event: { exitCode: number }) => void): { dispose(): void }
    write(data: string): void
    kill(): void
  }
}
const { startMockLlmServer } = await import(pathToFileURL(join(
  harness, 'packages/test-support/llm-mock-server/src/index.ts',
)).href)

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-capture-'))
const profile = join(home, 'profiles/tui')
const link = join(profile, 'node_modules/@deepseek-ai/dsh-tui')
mkdirSync(dirname(link), { recursive: true })
symlinkSync(join(root, 'packages/dsh-tui'), link, process.platform === 'win32' ? 'junction' : 'dir')
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-tui-capture',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui'] } },
}, null, 2) + '\n')
if (!existsSync(join(profile, 'cordis.patch.yml'))) {
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
}

const behaviours: string[] = []
const apiKey = 'dsh-tui-capture-key'
// One `read` per turn: it needs no approval, so the capture is the transcript
// rather than a sequence of prompts, and it declares a card kind the collapse
// rule can act on.
const server = await startMockLlmServer({
  // One `tool_call_success` + one `success` per turn: the model calls a tool,
  // the tool runs, and the model then answers — the shape the screenshot came
  // from. The script is unrolled per turn so every round has a tool call.
  sequence: Array.from({ length: turns }, () => ['tool_call_success', 'success'] as const).flat(),
  repeatLast: true,
  apiKey,
  successText: 'Reviewed the file. The flush race is in the settle path, '
    + 'and the retained window is what hides it.',
  toolName: 'read',
  toolArguments: JSON.stringify({ file_path: 'README.md' }),
  onEvent: (event: { type: string; scriptBehavior?: string; path?: string }) => {
    if (event.type === 'request') behaviours.push(`${event.scriptBehavior ?? '?'}`)
  },
})

/**
 * Replay the writes into a row buffer the way a terminal would.
 *
 * The frame is painted differentially, so no single write is the screen — the
 * screen is what the rows add up to. This handles the small escape vocabulary
 * the TUI actually emits (cursor up, column reset, erase line) and strips the
 * rest, which is styling.
 */
function renderScreen(writes: string): string {
  const ESC = String.fromCharCode(0x1b)
  const rows: string[] = []
  let row = 0
  let pending = ''
  let dirty = false
  const flush = (): void => {
    if (dirty) rows[row] = pending
    pending = ''
    dirty = false
  }
  let at = 0
  while (at < writes.length) {
    const move = /^\u001B\[(\d*)A/.exec(writes.slice(at))
    if (move !== null) {
      flush()
      row = Math.max(0, row - (move[1] === '' ? 1 : Number(move[1])))
      at += move[0].length
      continue
    }
    if (writes.startsWith(`${ESC}[2K`, at)) {
      rows[row] = ''
      pending = ''
      dirty = false
      at += 4
      continue
    }
    // Everything else that is an escape sequence is styling or cursor
    // bookkeeping the row buffer does not model; drop it whole.
    const escape = /^\u001B\[[0-?]*[ -/]*[@-~]/.exec(writes.slice(at))
    if (escape !== null) {
      at += escape[0].length
      continue
    }
    if (writes.startsWith(`${ESC}]`, at)) {
      const terminator = writes.indexOf('\u0007', at)
      at = terminator === -1 ? writes.length : terminator + 1
      continue
    }
    if (writes[at] === '\n') {
      flush()
      row++
      at++
      continue
    }
    if (writes[at] === '\r' || writes[at] === ESC) {
      at++
      continue
    }
    pending += writes[at]
    dirty = true
    at++
  }
  flush()
  return rows.map(line => (line ?? '').replace(/\s+$/, '')).join('\n')
}

let transcript = ''
let sent = 0
let quitSent = false
let lastLength = 0
let idleSince = Date.now()

const child = ptyModule.spawn(process.execPath, [
  '--import', 'tsx/esm', '--conditions=development', 'apps/cli/src/bin.ts',
  '--profile', 'tui', '--interactive', '--no-color',
  'read the README and tell me where the flush race is',
], {
  cwd: harness,
  cols,
  rows,
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: apiKey,
    DEEPSEEK_BASE_URL: server.baseURL,
  },
})

const subscription = child.onData((data) => {
  transcript += data
  idleSince = Date.now()
})

const exited = new Promise<number>((resolve_) => {
  child.onExit(({ exitCode }) => { resolve_(exitCode) })
})

const IDLE_HINT = 'ctrl+p commands'
/**
 * One turn costs two model requests here — the tool call and the answer — so
 * the server's own request count is the turn counter. Counting markers in the
 * transcript would not work: the frame is repainted, so one marker is written
 * many times.
 */
const REQUESTS_PER_TURN = 2

/**
 * Type, then submit as a separate write.
 *
 * The composer reads a chunk at a time and treats a bracketed paste as one
 * edit; sending the text and its Enter in the same chunk lands both in the
 * draft, which is how the first attempt at this ended up with three follow-ups
 * concatenated on one line.
 */
function submit(text: string): void {
  child.write(text)
  const timer = setTimeout(() => { child.write('\r') }, 150)
  pending.add(timer)
}

const pending = new Set<NodeJS.Timeout>()

const pump = setInterval(() => {
  if (transcript.length !== lastLength) {
    lastLength = transcript.length
    return
  }
  if (Date.now() - idleSince < 900) return
  if (!transcript.slice(-4000).includes(IDLE_HINT)) return
  if (server.requests.length < (sent + 1) * REQUESTS_PER_TURN) return
  if (sent < turns - 1) {
    sent++
    // Each follow-up starts a fresh turn, so the capture shows several rounds
    // stacked the way a real session stacks them.
    submit(`follow-up ${String(sent)}: check the retained window too`)
    idleSince = Date.now()
    return
  }
  if (!quitSent) {
    quitSent = true
    submit('/quit')
  }
}, 250)

const timeout = setTimeout(() => { child.kill() }, 120_000)
const code = await exited
clearInterval(pump)
clearTimeout(timeout)
for (const timer of pending) clearTimeout(timer)
subscription.dispose()
await server.close()

process.stdout.write(`\n=== rendered screen (${String(cols)}x${String(rows)}, ${String(turns)} turns, exit ${String(code)}) ===\n`)
process.stdout.write(renderScreen(transcript))
process.stdout.write('\n=== end ===\n')
process.stdout.write(`model requests: ${behaviours.join(', ')}\n`)
