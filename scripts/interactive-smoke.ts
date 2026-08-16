import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const harness = join(root, 'opensource/deepseek-harness')
const wide = process.argv.includes('--wide')
const questionScenario = process.argv.includes('--question')
const unicodeScenario = process.argv.includes('--unicode')
const unicodeFollowup = '中文宽字符🙂 e\u0301\n第二行 IME commit'
const followupText = unicodeScenario ? unicodeFollowup : 'follow-up from composer'
const followupWire = unicodeScenario
  ? `\u001B[200~${unicodeFollowup}\u001B[201~`
  : followupText
const normalizeScreen = (value: string): string => value
  .replace(/\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\s+/g, '')
const terminalSize = wide
  ? { cols: 160, rows: 50 }
  : questionScenario ? { cols: 80, rows: 12 } : { cols: 80, rows: 24 }
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

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-interactive-smoke-'))
const profile = join(home, 'profiles/tui')
const link = join(profile, 'node_modules/@deepseek-ai/dsh-tui')
mkdirSync(dirname(link), { recursive: true })
symlinkSync(join(root, 'packages/dsh-tui'), link, process.platform === 'win32' ? 'junction' : 'dir')
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-tui-interactive-smoke',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui'] } },
}, null, 2) + '\n')
if (!existsSync(join(profile, 'cordis.patch.yml'))) writeFileSync(
  join(profile, 'cordis.patch.yml'),
  questionScenario
    ? "- insert:\n    - id: tool-ask-user\n      name: '@deepseek-ai/dsh-tool-ask-user'\n"
    : '[]\n',
)

const apiKey = 'phase-zero-tui-key'
const shellTool = process.platform === 'win32' ? 'pwsh' : 'bash'
const server = await startMockLlmServer({
  sequence: ['tool_call_success', 'success'],
  repeatLast: true,
  apiKey,
  successText: 'phase zero interactive complete',
  toolName: questionScenario ? 'ask_user_question' : shellTool,
  toolArguments: JSON.stringify(questionScenario ? {
    questions: [
      {
        id: 'mode', question: 'Mode?', header: 'Choose Mode',
        options: [{ label: 'Fast' }, { label: 'Careful' }],
      },
      { id: 'note', question: 'Note?' },
    ],
  } : {
    command: process.platform === 'win32' ? 'Write-Output phase-zero-tool' : 'printf phase-zero-tool',
    description: 'Exercise the TUI approval path',
    sandbox_permissions: 'danger-full-access',
    justification: 'The phase-zero smoke must verify a one-time escalation decision.',
  }),
})

let transcript = ''
let answered = false
let questionChoiceSent = false
let questionCustomSent = false
let questionCustomEnterSent = false
let followupSent = false
let followupEnterSent = false
let followupOffset = 0
let followupRequestBaseline = 0
let prematureUnicodeSubmit = false
let helpSent = false
let helpEnterSent = false
let quitSent = false
let quitOffset = 0
let quitEnterSent = false
let resizedNarrow = false
let narrowResizeOffset = 0
let resizedWide = false
let wideResizeOffset = 0
const pendingWrites = new Set<NodeJS.Timeout>()
const writeSoon = (data: string): void => {
  const timer = setTimeout(() => {
    pendingWrites.delete(timer)
    child.write(data)
  }, 50)
  pendingWrites.add(timer)
}
const child = ptyModule.spawn(process.execPath, [
  '--import', 'tsx/esm', '--conditions=development', 'apps/cli/src/bin.ts', '--profile', 'tui', '--interactive',
  ...(wide ? ['--alternate-screen'] : []),
  ...(questionScenario ? ['--no-color'] : []),
  'run the phase zero interactive smoke',
], {
  cwd: harness,
  cols: terminalSize.cols,
  rows: terminalSize.rows,
  ...(process.platform === 'win32' ? { useConpty: true, useConptyDll: true } : {}),
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: apiKey,
    DEEPSEEK_BASE_URL: server.baseURL,
  },
})

let ptyClosed = false
const closePty = (): void => {
  if (ptyClosed) return
  ptyClosed = true
  child.kill()
}

const dataSubscription = child.onData((data) => {
  transcript += data
  if (!answered && transcript.includes(`Approve ${shellTool}?`)) {
    answered = true
    child.write('y')
  }
  if (questionScenario && !questionChoiceSent && transcript.includes('Mode?')) {
    questionChoiceSent = true
    writeSoon('2')
  }
  if (questionScenario && questionChoiceSent && !questionCustomSent && transcript.includes('Note?')) {
    questionCustomSent = true
    writeSoon('按计划发布')
  }
  if (questionScenario && questionCustomSent && !questionCustomEnterSent && transcript.includes('按计划发布')) {
    questionCustomEnterSent = true
    answered = true
    writeSoon('\r')
  }
  if (wide && answered && !resizedNarrow && transcript.includes('Enter send')) {
    resizedNarrow = true
    narrowResizeOffset = transcript.length
    child.resize(80, 24)
  }
  if (answered && !followupSent && transcript.includes('Enter send')
    && (!wide || (resizedNarrow && transcript.length > narrowResizeOffset))) {
    followupSent = true
    followupOffset = transcript.length
    followupRequestBaseline = server.requests.length
    writeSoon(followupWire)
  }
  // The composer wraps a multi-line draft across rows, so the echo is compared
  // with terminal escapes and layout whitespace removed.
  if (followupSent && !followupEnterSent
    && normalizeScreen(transcript.slice(followupOffset)).includes(normalizeScreen(followupText))) {
    if (unicodeScenario && server.requests.length > followupRequestBaseline) prematureUnicodeSubmit = true
    followupEnterSent = true
    child.write('\r')
  }
  const afterFollowup = transcript.slice(followupOffset)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\s+/g, '')
  if (wide && followupSent && !resizedWide && server.requests.length > followupRequestBaseline
    && afterFollowup.includes('phasezerointeractivecomplete')) {
    resizedWide = true
    wideResizeOffset = transcript.length
    child.resize(160, 50)
  }
  if (followupSent && !helpSent && server.requests.length > followupRequestBaseline
    && afterFollowup.includes('phasezerointeractivecomplete')
    && (!wide || (resizedWide && transcript.length > wideResizeOffset))) {
    helpSent = true
    child.write('/help')
  }
  if (helpSent && !helpEnterSent && transcript.slice(followupOffset).includes('/help')) {
    helpEnterSent = true
    child.write('\r')
  }
  if (helpEnterSent && !quitSent && transcript.slice(followupOffset).includes('Commands:')) {
    quitSent = true
    quitOffset = transcript.length
    child.write('/quit')
  }
  if (quitSent && !quitEnterSent && transcript.slice(quitOffset).includes('/quit')) {
    quitEnterSent = true
    child.write('\r')
  }
})
let exitSubscription: { dispose(): void } | undefined
const finished = new Promise<number>((resolveExit, reject) => {
  const timer = setTimeout(() => {
    closePty()
    reject(new Error(`interactive TUI smoke timed out\n${transcript.slice(-8000)}`))
  // Booting the Harness through tsx can take tens of seconds when several gate
  // steps contend for the machine; this budget covers the whole scenario.
  }, 90_000)
  exitSubscription = child.onExit(({ exitCode }) => {
    clearTimeout(timer)
    resolveExit(exitCode)
  })
})

try {
  const code = await finished
  if (code !== 0) {
    const requestSummary = server.requests.map((request: {
      attempt: number
      behavior: string
      outcome: string
    }) => ({
      attempt: request.attempt,
      behavior: request.behavior,
      outcome: request.outcome,
    }))
    throw new Error(`interactive TUI exited ${String(code)}; requests=${JSON.stringify(requestSummary)}\n${transcript.slice(-8000)}`)
  }
  if (!answered) throw new Error(`TUI never displayed the ${shellTool} approval\n${transcript.slice(-8000)}`)
  if (questionScenario && (!questionChoiceSent || !questionCustomEnterSent)) {
    throw new Error(`TUI did not complete the multi-question flow\n${transcript.slice(-8000)}`)
  }
  if (wide) {
    if (!resizedNarrow || !resizedWide) {
      throw new Error(`TUI did not complete both resize transitions\n${transcript.slice(-8000)}`)
    }
    if (!transcript.includes('\u001B[?1049h') || !transcript.includes('\u001B[?1049l')) {
      throw new Error(`TUI did not enter and restore the alternate screen\n${transcript.slice(-8000)}`)
    }
  }
  if (!followupEnterSent || !helpEnterSent || !quitEnterSent) {
    throw new Error(`TUI composer did not complete follow-up + /help + /quit\n${transcript.slice(-8000)}`)
  }
  const normalizedTranscript = transcript
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\s+/g, '')
  if (!normalizedTranscript.includes('phasezerointeractivecomplete')) {
    throw new Error(`TUI did not stream the final response\n${transcript.slice(-8000)}`)
  }
  if (server.requests.length < 3) {
    throw new Error(`expected at least three model requests, observed ${String(server.requests.length)}`)
  }
  if (questionScenario) {
    const requestBodies = JSON.stringify(server.requests.map((request: { body: unknown }) => request.body))
    if (!requestBodies.includes('Careful') || !requestBodies.includes('按计划发布')) {
      throw new Error(`question answers did not reach the next model request\n${requestBodies.slice(-8000)}`)
    }
    if (/\u001B\[(?:3[0-7]|9[0-7])m/.test(transcript)) {
      throw new Error(`no-color question scenario emitted an ANSI foreground color\n${transcript.slice(-8000)}`)
    }
  }
  if (unicodeScenario) {
    if (prematureUnicodeSubmit) throw new Error('bracketed Unicode paste submitted before Enter')
    const requestBodies = JSON.stringify(server.requests.map((request: { body: unknown }) => request.body))
    const encodedFollowup = JSON.stringify(unicodeFollowup).slice(1, -1)
    if (!requestBodies.includes(encodedFollowup)) {
      throw new Error(`Unicode/IME follow-up did not reach the next model request intact\n${requestBodies.slice(-8000)}`)
    }
  }
  process.stdout.write(`interactive Harness TUI ${String(terminalSize.cols)}x${String(terminalSize.rows)} smoke accepted `
    + `(task + ${questionScenario ? 'questions + no-color' : `${shellTool} approval`} + `
    + `${unicodeScenario ? 'Unicode/IME paste' : 'follow-up'} + /help + /quit`
    + `${wide ? ' + resize + alternate-screen restore' : ''})\n`)
} finally {
  for (const timer of pendingWrites) clearTimeout(timer)
  dataSubscription.dispose()
  exitSubscription?.dispose()
  closePty()
  await server.close()
}

// node-pty's bundled Windows ConPTY worker can retain an idle pipe after kill.
// All owned resources and assertions have settled before this success-only exit.
if (process.platform === 'win32') process.exit(0)
