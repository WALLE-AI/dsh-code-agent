/**
 * Real resume smoke: one session is created and quit, then `--resume latest`
 * restores it through the Harness session query and resume path, shows the
 * earlier transcript, accepts a follow-up, switches to a fresh session with
 * `/new`, and exits cleanly.
 */

import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const harness = join(root, 'opensource/deepseek-harness')
const firstTask = 'remember the resume marker alpha'
const followup = 'continue after resume'

const normalize = (value: string): string => value
  .replace(/\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\s+/g, '')

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

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-resume-smoke-'))
const profile = join(home, 'profiles/tui')
const link = join(profile, 'node_modules/@deepseek-ai/dsh-tui')
mkdirSync(dirname(link), { recursive: true })
symlinkSync(join(root, 'packages/dsh-tui'), link, process.platform === 'win32' ? 'junction' : 'dir')
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-tui-resume-smoke',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui'] } },
}, null, 2) + '\n')
if (!existsSync(join(profile, 'cordis.patch.yml'))) writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')

const apiKey = 'phase-four-resume-key'
const server = await startMockLlmServer({
  sequence: ['success'],
  repeatLast: true,
  apiKey,
  successText: 'resume smoke acknowledged',
})

/** One scripted interaction: wait for `ready`, send `send`, wait for `done`. */
interface Step {
  readonly name: string
  readonly ready: (transcript: string) => boolean
  readonly send: string
  /**
   * Receives the transcript written after this step became ready, plus the
   * number of model requests observed since then. Ink repaints the whole
   * screen every frame, so a step that waits for a model response must count
   * requests instead of matching text that is already on screen.
   */
  readonly done: (tail: string, newRequests: number) => boolean
}

interface RunResult {
  code: number
  transcript: string
  completed: readonly string[]
}

// Booting the Harness through tsx is slower on Node 22 and under gate
// contention; this budget covers one complete run, not just startup.
const RUN_TIMEOUT_MS = 120_000
// A keystroke written while Ink is mid-redraw can be dropped, so each step is
// re-sent until its echo appears.
const RESEND_INTERVAL_MS = 1_500
const POLL_INTERVAL_MS = 250

function runTui(args: readonly string[], steps: readonly Step[]): Promise<RunResult> {
  const child = ptyModule.spawn(process.execPath, [
    '--import', 'tsx/esm', '--conditions=development', 'apps/cli/src/bin.ts',
    '--profile', 'tui', '--interactive', ...args,
  ], {
    cwd: harness,
    cols: 100,
    rows: 30,
    ...(process.platform === 'win32' ? { useConpty: true, useConptyDll: true } : {}),
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: apiKey,
      DEEPSEEK_BASE_URL: server.baseURL,
    },
  })
  let transcript = ''
  let index = 0
  let readyOffset = -1
  let readyRequests = 0
  let lastSentAt = 0
  const completed: string[] = []

  const advance = (): void => {
    const step = steps[index]
    if (step === undefined) return
    if (readyOffset === -1) {
      if (!step.ready(transcript)) return
      readyOffset = transcript.length
      readyRequests = server.requests.length
      lastSentAt = 0
    }
    if (step.done(transcript.slice(readyOffset), server.requests.length - readyRequests)) {
      completed.push(step.name)
      index++
      readyOffset = -1
      lastSentAt = 0
      advance()
      return
    }
    const now = Date.now()
    if (now - lastSentAt < RESEND_INTERVAL_MS) return
    lastSentAt = now
    child.write(step.send)
  }

  const data = child.onData((chunk) => {
    transcript += chunk
    advance()
  })
  const poll = setInterval(advance, POLL_INTERVAL_MS)
  return new Promise<RunResult>((resolveRun, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll)
      child.kill()
      reject(new Error(
        `resume smoke timed out at step ${steps[index]?.name ?? 'done'}\n${transcript.slice(-6000)}`,
      ))
    }, RUN_TIMEOUT_MS)
    const exit = child.onExit(({ exitCode }) => {
      clearTimeout(timer)
      clearInterval(poll)
      data.dispose()
      exit.dispose()
      resolveRun({ code: exitCode, transcript, completed })
    })
  })
}

const answered = (tail: string): boolean => normalize(tail).includes('resumesmokeacknowledged')

/** Type `/quit`, then send Enter until the process exits. */
const quitSteps: readonly Step[] = [
  { name: 'type-quit', ready: answered, send: '/quit', done: tail => tail.includes('/quit') },
  { name: 'send-quit', ready: () => true, send: '\r', done: () => false },
]

try {
  const first = await runTui([firstTask], quitSteps)
  if (first.code !== 0) {
    throw new Error(`first TUI run exited ${String(first.code)}\n${first.transcript.slice(-6000)}`)
  }

  const firstRunRequests = server.requests.length
  const second = await runTui(['--resume'], [
    {
      name: 'type-followup',
      ready: transcript => transcript.includes('resumed session'),
      send: followup,
      done: tail => tail.includes(followup),
    },
    {
      name: 'send-followup',
      ready: () => true,
      send: '\r',
      // The restored transcript already shows the earlier answer, so only a new
      // model request proves this follow-up was actually sent.
      done: (_tail, newRequests) => newRequests > 0,
    },
    // One process walks several sessions: /new settles this one and attaches a
    // fresh session without restarting the TUI.
    { name: 'type-new', ready: () => true, send: '/new', done: tail => tail.includes('/new') },
    {
      name: 'send-new',
      ready: () => true,
      send: '\r',
      done: tail => normalize(tail).includes('startedanewsession'),
    },
    ...quitSteps.map(step => step.name === 'type-quit'
      ? { ...step, ready: (): boolean => true }
      : step),
  ])
  if (second.code !== 0) {
    throw new Error(`resumed TUI run exited ${String(second.code)}\n${second.transcript.slice(-6000)}`)
  }
  const screen = normalize(second.transcript)
  if (!screen.includes('resumedsession')) {
    throw new Error(`resumed run did not report the restored session\n${second.transcript.slice(-6000)}`)
  }
  if (!screen.includes(normalize(firstTask))) {
    throw new Error(`resumed run did not restore the earlier transcript\n${second.transcript.slice(-6000)}`)
  }
  if (!second.completed.includes('send-new')) {
    throw new Error(`in-session /new did not attach a fresh session\n${second.transcript.slice(-6000)}`)
  }
  if (server.requests.length <= firstRunRequests) {
    throw new Error(`the resumed run issued no model request (${String(server.requests.length)} total)`)
  }
  // Only requests from the resumed run prove the restored history was sent.
  const resumedBodies: string[] = server.requests
    .slice(firstRunRequests)
    .map((request: { body: unknown }) => JSON.stringify(request.body))
  if (!resumedBodies.some((body: string) => body.includes(firstTask) && body.includes(followup))) {
    throw new Error('the resumed request did not carry the restored conversation history')
  }
  process.stdout.write(
    'resume smoke accepted (create + quit + --resume latest + follow-up + history + in-session /new)\n',
  )
} finally {
  await server.close()
}

if (process.platform === 'win32') process.exit(0)
