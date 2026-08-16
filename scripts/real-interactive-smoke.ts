/**
 * Real interactive smoke against the live DeepSeek API: one tool-using task, a
 * follow-up turn, then `/quit`. Credentials come from the environment or a
 * local `.env` and are never printed. Approval prompts are answered if the
 * model asks for an escalation; the run does not depend on it asking.
 */

import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')

function localEnv(): Record<string, string> {
  const file = join(root, '.env')
  if (!existsSync(file)) return {}
  const values: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(DEEPSEEK_[A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (match === null) continue
    values[match[1] as string] = (match[2] as string).trim().replace(/^["']|["']$/g, '')
  }
  return values
}

const dotenv = localEnv()
const apiKey = process.env.DEEPSEEK_API_KEY ?? dotenv.DEEPSEEK_API_KEY
if (apiKey === undefined || apiKey.trim().length === 0) {
  throw new Error('this smoke requires DEEPSEEK_API_KEY in the environment or in .env')
}
const baseURL = process.env.DEEPSEEK_BASE_URL
  ?? dotenv.DEEPSEEK_BASE_URL
  ?? process.env.DEEPSEEK_URL
  ?? dotenv.DEEPSEEK_URL
  ?? 'https://api.deepseek.com'

const harness = join(root, 'opensource/deepseek-harness')
// The approval mode runs in a throwaway workspace under the read-only preset,
// so a write can only proceed through a human escalation decision.
const approvalMode = process.argv.includes('--approval')
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
const writeCommand = process.platform === 'win32'
  ? 'Set-Content -Path real-tui-approval.txt -Value OK'
  : "printf OK > real-tui-approval.txt"
// The throwaway workspace lives inside the repository: the sandboxed test
// runner may refuse to launch a child process rooted outside the project.
const workspace = approvalMode
  ? mkdtempSync(join(root, '.real-approval-workspace-'))
  : harness
const firstTask = approvalMode
  ? `Run this command with the ${shell} tool: ${writeCommand}
`
    + 'Set sandbox_permissions to workspace-write on that tool call. Then reply FIRST_OK.'
  : 'Use your file tools to read package.json in the working directory, '
    + 'then reply with exactly FIRST_OK followed by the value of its "name" field.'
const followup = 'Reply with exactly SECOND_OK and call no tools.'
const RUN_TIMEOUT_MS = 420_000
const RESEND_INTERVAL_MS = 2_000
const POLL_INTERVAL_MS = 300

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

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-real-interactive-'))
const profile = join(home, 'profiles/tui')
const link = join(profile, 'node_modules/@deepseek-ai/dsh-tui')
mkdirSync(dirname(link), { recursive: true })
symlinkSync(join(root, 'packages/dsh-tui'), link, process.platform === 'win32' ? 'junction' : 'dir')
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-tui-real-interactive',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui'] } },
}, null, 2) + '\n')
writeFileSync(join(profile, 'cordis.patch.yml'), [
  '- id: session-persistence-jsonl',
  '  config:',
  "    root: !!js dshHomePath('sessions')",
  '    compression: none',
  '',
].join('\n'))
// `deepseek-v4-pro` rejects any effort but `high`; the TUI surfaces that as a
// turn error, which is exactly how this smoke discovered the constraint.
writeFileSync(join(home, 'settings.yaml'), [
  'agent-default-model:',
  '  provider: deepseek-official',
  '  model: deepseek-v4-pro',
  '  reasoningEffort: high',
  'llm-deepseek:',
  `  baseURL: ${baseURL}`,
  '  thinking: enabled',
  '  reasoningEffort: high',
  '',
].join('\n'))

interface Step {
  readonly name: string
  readonly ready: (transcript: string) => boolean
  readonly send: string
  readonly done: (tail: string) => boolean
}

/**
 * The composer only becomes interactive after the first task settles, and its
 * hint is the one on-screen signal the echoed prompt cannot forge.
 */
const firstTurnSettled = (transcript: string): boolean => transcript.includes('Enter send')

const quitSteps: readonly Step[] = [
  { name: 'type-quit', ready: firstTurnSettled, send: '/quit', done: tail => tail.includes('/quit') },
  { name: 'send-quit', ready: () => true, send: '\r', done: () => false },
]

// The approval run stays on one model turn: the escalation decision is the
// subject, and every extra turn is another chance for real-model variance.
const steps: readonly Step[] = approvalMode
  ? [
    { name: 'await-first-answer', ready: firstTurnSettled, send: '', done: () => true },
    ...quitSteps,
  ]
  : [
    {
      name: 'type-followup',
      ready: firstTurnSettled,
      send: followup,
      done: tail => tail.includes(followup),
    },
    {
      name: 'send-followup',
      ready: () => true,
      send: '\r',
      done: tail => normalize(tail).includes('SECOND_OK'),
    },
    ...quitSteps,
  ]

const child = ptyModule.spawn(process.execPath, [
  // An out-of-tree workspace cannot resolve `tsx/esm` by name.
  '--import', pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href,
  '--conditions=development', join(harness, 'apps/cli/src/bin.ts'),
  '--profile', 'tui', '--interactive',
  ...(approvalMode ? ['--permission', 'read-only'] : []),
  firstTask,
], {
  cwd: workspace,
  cols: 110,
  rows: 32,
  ...(process.platform === 'win32' ? { useConpty: true, useConptyDll: true } : {}),
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: apiKey,
    DEEPSEEK_BASE_URL: baseURL,
    // Running the Harness from source needs its tsconfig paths: the vendored
    // Cordis exposes const enums that only exist in the TypeScript sources.
    TSX_TSCONFIG_PATH: join(harness, 'tsconfig.json'),
  },
})

let transcript = ''
let index = 0
let readyOffset = -1
let lastSentAt = 0
let approvals = 0
let approvalOffset = 0
const completed: string[] = []

const advance = (): void => {
  // An escalation request can arrive at any point; answering it is not a step.
  // The prompt reads `Approve <tool>? (<preset>) [y/N]`, so match the suffix.
  const pendingApproval = transcript.slice(approvalOffset).includes('[y/N]')
  if (pendingApproval) {
    approvals++
    approvalOffset = transcript.length
    child.write('y')
    return
  }
  const step = steps[index]
  if (step === undefined) return
  if (readyOffset === -1) {
    if (!step.ready(transcript)) return
    readyOffset = transcript.length
    lastSentAt = 0
  }
  if (step.done(transcript.slice(readyOffset))) {
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
const finished = new Promise<number>((resolveExit, reject) => {
  const timer = setTimeout(() => {
    clearInterval(poll)
    child.kill()
    reject(new Error(
      `real interactive smoke timed out at step ${steps[index]?.name ?? 'done'}\n${transcript.slice(-6000)}`,
    ))
  }, RUN_TIMEOUT_MS)
  const exit = child.onExit(({ exitCode }) => {
    clearTimeout(timer)
    clearInterval(poll)
    data.dispose()
    exit.dispose()
    resolveExit(exitCode)
  })
})

function jsonlFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return extname(entry.name) === '.jsonl' ? [path] : []
  })
}

// ConPTY teardown can cut stdout short, so the outcome is also written to a
// file the caller can read after the process exits.
const reportPath = join(root, 'real-smoke-report.log')
const report = (text: string): void => {
  try { appendFileSync(reportPath, `${text}
`) } catch { /* best effort */ }
}
try {
  report(`start approvalMode=${String(approvalMode)} workspace=${workspace}`)
  const code = await finished
  report(`child exited ${String(code)}`)
  if (code !== 0) {
    throw new Error(`real interactive TUI exited ${String(code)}\n${transcript.slice(-6000)}`)
  }
  const screen = normalize(transcript)
  // The approval run's subject is the escalation decision, which is asserted
  // against the session log; the echoed prompt makes screen markers unreliable.
  for (const marker of approvalMode ? [] : ['FIRST_OK', 'SECOND_OK']) {
    if (!screen.includes(marker)) {
      throw new Error(`the transcript never showed ${marker}\n${transcript.slice(-6000)}`)
    }
  }
  if (!approvalMode && !completed.includes('send-followup')) {
    throw new Error(`the follow-up turn did not complete\n${transcript.slice(-6000)}`)
  }

  const records = jsonlFiles(join(home, 'sessions')).flatMap(file => readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as { type?: unknown; data?: Record<string, unknown> }))
  const toolCalls = records.filter(record => record.type === 'tool/call')
  const userMessages = records.filter(record => record.type === 'user/message')
  const turnEnds = records.filter(record => record.type === 'turn/end')
  if (toolCalls.length === 0) {
    throw new Error('the model never issued a tool call, so the tool path was not exercised')
  }
  const expectedTurns = approvalMode ? 1 : 2
  if (userMessages.length < expectedTurns) {
    throw new Error(`expected ${String(expectedTurns)} user message(s), saw ${String(userMessages.length)}`)
  }
  if (turnEnds.length < expectedTurns) {
    throw new Error(`expected ${String(expectedTurns)} completed turn(s), saw ${String(turnEnds.length)}`)
  }
  const toolNames = [...new Set(toolCalls.map(call => String(call.data?.name ?? 'unknown')))]
  if (approvalMode) {
    if (approvals === 0) {
      throw new Error(`the read-only preset produced no approval prompt\n${transcript.slice(-6000)}`)
    }
    if (!existsSync(join(workspace, 'real-tui-approval.txt'))) {
      throw new Error(`the approved command did not write its file\n${transcript.slice(-6000)}`)
    }
    if (records.every(record => record.type !== 'approval/decided')) {
      throw new Error('no approval decision was persisted to the session log')
    }
  }
  process.stdout.write(
    `real interactive TUI smoke accepted (${baseURL}, `
    + `${approvalMode ? 'read-only + escalation' : 'workspace-write'}, `
    + `${String(turnEnds.length)} turns, tools: ${toolNames.join(', ')}, `
    + `approvals answered: ${String(approvals)}, /quit exit 0)\n`,
  )
} catch (error) {
  report(`FAILED: ${error instanceof Error ? error.message : String(error)}`)
  throw error
} finally {
  data.dispose()
  child.kill()
  rmSync(home, { recursive: true, force: true })
  if (approvalMode) rmSync(workspace, { recursive: true, force: true })
}

if (process.platform === 'win32') process.exit(0)
