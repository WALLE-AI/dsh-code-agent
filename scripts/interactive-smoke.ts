import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const harness = join(root, 'opensource/deepseek-harness/deepseek-harness-master')
const ptyModule = await import('node-pty') as {
  spawn(file: string, args: string[], options: Record<string, unknown>): {
    onData(callback: (data: string) => void): void
    onExit(callback: (event: { exitCode: number }) => void): void
    write(data: string): void
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
if (!existsSync(join(profile, 'cordis.patch.yml'))) writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')

const apiKey = 'phase-zero-tui-key'
const server = await startMockLlmServer({
  sequence: ['tool_call_success', 'success'],
  repeatLast: true,
  apiKey,
  successText: 'phase zero interactive complete',
  toolName: 'bash',
  toolArguments: JSON.stringify({
    command: 'printf phase-zero-tool',
    description: 'Exercise the TUI approval path',
    sandbox_permissions: 'danger-full-access',
    justification: 'The phase-zero smoke must verify a one-time escalation decision.',
  }),
})

let transcript = ''
let answered = false
const child = ptyModule.spawn(process.execPath, [
  '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'tui', 'run the phase zero interactive smoke',
], {
  cwd: harness,
  cols: 100,
  rows: 30,
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: apiKey,
    DEEPSEEK_BASE_URL: server.baseURL,
  },
})

const finished = new Promise<number>((resolveExit, reject) => {
  const timer = setTimeout(() => {
    child.kill()
    reject(new Error(`interactive TUI smoke timed out\n${transcript.slice(-8000)}`))
  }, 30_000)
  child.onData((data) => {
    transcript += data
    if (!answered && transcript.includes('Approve bash?')) {
      answered = true
      child.write('y')
    }
  })
  child.onExit(({ exitCode }) => {
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
  if (!answered) throw new Error(`TUI never displayed the Bash approval\n${transcript.slice(-8000)}`)
  const normalizedTranscript = transcript
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\s+/g, '')
  if (!normalizedTranscript.includes('phasezerointeractivecomplete')) {
    throw new Error(`TUI did not stream the final response\n${transcript.slice(-8000)}`)
  }
  if (server.requests.length < 2) {
    throw new Error(`expected at least two model requests, observed ${String(server.requests.length)}`)
  }
  process.stdout.write('interactive Harness TUI smoke accepted (task + Bash approval + stream + exit)\n')
} finally {
  await server.close()
}
