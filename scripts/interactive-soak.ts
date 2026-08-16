import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_DURATION_MS = 30 * 60 * 1_000
const DEFAULT_INTERVAL_MS = 5_000
const OUTPUT_TAIL_LIMIT = 128 * 1_024
const PHASE_OUTPUT_LIMIT = 64 * 1_024
const TURN_TIMEOUT_MS = 45_000
const PROGRESS_INTERVAL_MS = 60_000

function integerOption(name: string, fallback: number, minimum: number): number {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = Number(process.argv[index + 1])
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`--${name} must be an integer greater than or equal to ${String(minimum)}`)
  }
  return value
}

const durationMs = integerOption('duration-ms', DEFAULT_DURATION_MS, 1_000)
const intervalMs = integerOption('interval-ms', DEFAULT_INTERVAL_MS, 0)
const root = resolve(import.meta.dirname, '..')
const harness = join(root, 'opensource/deepseek-harness')
const marker = 'phase two soak response'
const normalize = (text: string): string => text
  .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\s+/g, '')

const ptyModule = await import('node-pty') as {
  spawn(file: string, args: string[], options: Record<string, unknown>): {
    onData(callback: (data: string) => void): { dispose(): void }
    onExit(callback: (event: { exitCode: number }) => void): { dispose(): void }
    write(data: string): void
    resize(columns: number, rows: number): void
    kill(): void
  }
}
const { startMockLlmServer } = await import(pathToFileURL(join(
  harness, 'packages/test-support/llm-mock-server/src/index.ts',
)).href)

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-interactive-soak-'))
const profile = join(home, 'profiles/tui')
const link = join(profile, 'node_modules/@deepseek-ai/dsh-tui')
mkdirSync(dirname(link), { recursive: true })
symlinkSync(join(root, 'packages/dsh-tui'), link, process.platform === 'win32' ? 'junction' : 'dir')
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-tui-interactive-soak',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui'] } },
}, null, 2) + '\n')
if (!existsSync(join(profile, 'cordis.patch.yml'))) {
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
}

const apiKey = 'phase-two-soak-key'
const server = await startMockLlmServer({
  sequence: ['success'],
  repeatLast: true,
  apiKey,
  successText: marker,
  chunkSize: 3,
  chunkDelayMs: 5,
})

const child = ptyModule.spawn(process.execPath, [
  '--import', 'tsx/esm', '--conditions=development', 'apps/cli/src/bin.ts', '--profile', 'tui',
  '--interactive', '--alternate-screen', 'start the phase two soak',
], {
  cwd: harness,
  cols: 80,
  rows: 24,
  ...(process.platform === 'win32' ? { useConpty: true, useConptyDll: true } : {}),
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: apiKey,
    DEEPSEEK_BASE_URL: server.baseURL,
  },
})

type Phase = 'boot' | 'typing-turn' | 'waiting-turn' | 'resting' | 'typing-quit' | 'quitting'
let phase: Phase = 'boot'
let phaseOutput = ''
let outputTail = ''
let totalOutputBytes = 0
let turns = 0
let completedResponses = 0
let resizeCount = 0
let requestBaseline = 0
let currentTurn = ''
let soakStartedAt: number | undefined
let enteredAlternate = false
let restoredAlternate = false
let childClosed = false
let settled = false
let sendTimer: NodeJS.Timeout | undefined
let turnTimer: NodeJS.Timeout | undefined
let overallTimer: NodeJS.Timeout | undefined
let progressTimer: NodeJS.Timeout | undefined

let resolveFinished!: (exitCode: number) => void
let rejectFinished!: (error: Error) => void
const finished = new Promise<number>((resolve, reject) => {
  resolveFinished = resolve
  rejectFinished = reject
})

const closeChild = (): void => {
  if (childClosed) return
  childClosed = true
  child.kill()
}

const fail = (message: string): void => {
  if (settled) return
  settled = true
  closeChild()
  rejectFinished(new Error(`${message}\n${outputTail.slice(-8_000)}`))
}

const clearTurnTimer = (): void => {
  if (turnTimer !== undefined) clearTimeout(turnTimer)
  turnTimer = undefined
}

const armTurnTimer = (): void => {
  clearTurnTimer()
  turnTimer = setTimeout(() => {
    fail(`soak turn timed out in ${phase}; turns=${String(turns)} requests=${String(server.requests.length)}`)
  }, TURN_TIMEOUT_MS)
}

const beginQuit = (): void => {
  if (phase === 'typing-quit' || phase === 'quitting') return
  phase = 'typing-quit'
  phaseOutput = ''
  currentTurn = '/quit'
  child.write(currentTurn)
  armTurnTimer()
}

const sizes = [
  { columns: 80, rows: 24 },
  { columns: 160, rows: 50 },
  { columns: 80, rows: 12 },
] as const

const sendTurn = (): void => {
  if (soakStartedAt === undefined) return fail('soak reached send state before initial response')
  if (Date.now() - soakStartedAt >= durationMs) return beginQuit()
  turns += 1
  const size = sizes[turns % sizes.length] ?? sizes[0]
  child.resize(size.columns, size.rows)
  resizeCount += 1
  phase = 'typing-turn'
  phaseOutput = ''
  requestBaseline = server.requests.length
  currentTurn = `soak follow-up ${String(turns)}`
  child.write(currentTurn)
  armTurnTimer()
}

const responseReady = (): boolean => {
  const normalized = normalize(phaseOutput)
  return server.requests.length > requestBaseline
    && normalized.includes(normalize(marker))
    && normalized.includes('Entersend')
}

const responseCompleted = (): void => {
  clearTurnTimer()
  phase = 'resting'
  completedResponses += 1
  if (soakStartedAt === undefined) soakStartedAt = Date.now()
  const remaining = durationMs - (Date.now() - soakStartedAt)
  if (remaining <= 0 && turns > 0) return beginQuit()
  sendTimer = setTimeout(sendTurn, Math.min(intervalMs, Math.max(0, remaining)))
}

const dataSubscription = child.onData((data) => {
  totalOutputBytes += Buffer.byteLength(data)
  outputTail = (outputTail + data).slice(-OUTPUT_TAIL_LIMIT)
  phaseOutput = (phaseOutput + data).slice(-PHASE_OUTPUT_LIMIT)
  if (data.includes('\u001B[?1049h')) enteredAlternate = true
  if (data.includes('\u001B[?1049l')) restoredAlternate = true

  if ((phase === 'boot' || phase === 'waiting-turn') && responseReady()) {
    responseCompleted()
    return
  }
  if (phase === 'typing-turn' && phaseOutput.includes(currentTurn)) {
    phase = 'waiting-turn'
    phaseOutput = ''
    child.write('\r')
    armTurnTimer()
    return
  }
  if (phase === 'typing-quit' && phaseOutput.includes(currentTurn)) {
    phase = 'quitting'
    phaseOutput = ''
    child.write('\r')
    armTurnTimer()
  }
})

const exitSubscription = child.onExit(({ exitCode }) => {
  if (settled) return
  settled = true
  resolveFinished(exitCode)
})

overallTimer = setTimeout(() => {
  fail(`soak exceeded its overall deadline; phase=${phase} turns=${String(turns)}`)
}, durationMs + 120_000)
progressTimer = setInterval(() => {
  const elapsedMs = soakStartedAt === undefined ? 0 : Date.now() - soakStartedAt
  process.stdout.write(`soak progress: elapsed=${String(elapsedMs)}ms turns=${String(turns)} `
    + `requests=${String(server.requests.length)} resizes=${String(resizeCount)} `
    + `phase=${phase} outputBytes=${String(totalOutputBytes)}\n`)
}, PROGRESS_INTERVAL_MS)
armTurnTimer()

try {
  const exitCode = await finished
  clearTurnTimer()
  if (exitCode !== 0) throw new Error(`soak TUI exited ${String(exitCode)}\n${outputTail}`)
  if (soakStartedAt === undefined || Date.now() - soakStartedAt < durationMs) {
    throw new Error(`soak exited before the requested ${String(durationMs)}ms duration`)
  }
  if (turns < 1 || completedResponses < turns + 1 || server.requests.length < turns + 1) {
    throw new Error(`soak lost a response: turns=${String(turns)} completed=${String(completedResponses)} requests=${String(server.requests.length)}`)
  }
  if (resizeCount !== turns) {
    throw new Error(`soak resize mismatch: turns=${String(turns)} resizes=${String(resizeCount)}`)
  }
  if (!enteredAlternate || !restoredAlternate) {
    throw new Error('soak did not enter and restore the alternate screen')
  }
  process.stdout.write(`interactive Harness TUI soak accepted (${String(durationMs)}ms, `
    + `${String(turns)} follow-ups, ${String(resizeCount)} resizes, `
    + `${String(totalOutputBytes)} output bytes with ${String(OUTPUT_TAIL_LIMIT)}-byte capture bound)\n`)
} finally {
  if (sendTimer !== undefined) clearTimeout(sendTimer)
  clearTurnTimer()
  if (overallTimer !== undefined) clearTimeout(overallTimer)
  if (progressTimer !== undefined) clearInterval(progressTimer)
  dataSubscription.dispose()
  exitSubscription.dispose()
  closeChild()
  await server.close()
}

// node-pty's Windows ConPTY worker can retain an idle pipe after kill.
if (process.platform === 'win32') process.exit(0)
