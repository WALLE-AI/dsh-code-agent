/**
 * Real cancellation smoke: Ctrl+C must arm first, cancel second, exit 130, and
 * restore the terminal. Ink exits on Ctrl+C by default, so this also guards the
 * `exitOnCtrlC: false` decision that keeps the bounded shutdown in charge.
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const harness = join(root, 'opensource/deepseek-harness/deepseek-harness-master')
const CTRL_C = String.fromCharCode(3)

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

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-cancel-smoke-'))
const profile = join(home, 'profiles/tui')
const link = join(profile, 'node_modules/@deepseek-ai/dsh-tui')
mkdirSync(dirname(link), { recursive: true })
symlinkSync(join(root, 'packages/dsh-tui'), link, process.platform === 'win32' ? 'junction' : 'dir')
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-tui-cancel-smoke',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui'] } },
}, null, 2) + '\n')
writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')

const apiKey = 'phase-four-cancel-key'
const server = await startMockLlmServer({
  sequence: ['success'],
  repeatLast: true,
  apiKey,
  successText: 'cancel smoke ready',
})

const child = ptyModule.spawn(process.execPath, [
  '--import', 'tsx/esm', '--conditions=development', 'apps/cli/src/bin.ts',
  '--profile', 'tui', '--interactive', '--alternate-screen', 'run the cancel smoke',
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
let armed = false
let confirmed = false
let armedOffset = 0
const pending = new Set<NodeJS.Timeout>()
const writeSoon = (data: string): void => {
  const timer = setTimeout(() => {
    pending.delete(timer)
    child.write(data)
  }, 60)
  pending.add(timer)
}

const data = child.onData((chunk) => {
  transcript += chunk
  if (!armed && normalize(transcript).includes('cancelsmokeready')) {
    armed = true
    armedOffset = transcript.length
    writeSoon(CTRL_C)
    return
  }
  // The first Ctrl+C must only arm the confirmation, never exit.
  if (armed && !confirmed && normalize(transcript.slice(armedOffset)).includes('Pressagaintostop')) {
    confirmed = true
    writeSoon(CTRL_C)
  }
})

const finished = new Promise<number>((resolveExit, reject) => {
  const timer = setTimeout(() => {
    child.kill()
    reject(new Error(`cancel smoke timed out\n${transcript.slice(-6000)}`))
  // Booting the Harness through tsx is slower on Node 22 and under contention.
  }, 120_000)
  const exit = child.onExit(({ exitCode }) => {
    clearTimeout(timer)
    for (const item of pending) clearTimeout(item)
    data.dispose()
    exit.dispose()
    resolveExit(exitCode)
  })
})

try {
  const code = await finished
  if (!armed) throw new Error(`TUI never became interactive\n${transcript.slice(-6000)}`)
  if (!confirmed) {
    throw new Error(`the first Ctrl+C did not arm the confirmation\n${transcript.slice(-6000)}`)
  }
  if (code !== 130) throw new Error(`expected exit code 130, observed ${String(code)}\n${transcript.slice(-6000)}`)
  if (!transcript.includes('[?1049l')) {
    throw new Error(`the alternate screen was not restored\n${transcript.slice(-4000)}`)
  }
  if (!transcript.includes('[?25h')) {
    throw new Error(`the cursor was not restored\n${transcript.slice(-4000)}`)
  }
  process.stdout.write('cancel smoke accepted (arm + confirm + exit 130 + cursor and screen restored)\n')
} finally {
  await server.close()
}

if (process.platform === 'win32') process.exit(0)
