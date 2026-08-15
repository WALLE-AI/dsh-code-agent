import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'

const apiKey = process.env.DEEPSEEK_API_KEY
if (apiKey === undefined || apiKey.trim().length === 0) {
  throw new Error('check:real requires DEEPSEEK_API_KEY in the launching environment')
}

const root = resolve(import.meta.dirname, '..')
const harness = join(root, 'opensource/deepseek-harness')
const ptyModule = await import('node-pty') as {
  spawn(file: string, args: string[], options: Record<string, unknown>): {
    onData(callback: (data: string) => void): { dispose(): void }
    onExit(callback: (event: { exitCode: number }) => void): { dispose(): void }
    kill(): void
  }
}

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-real-api-smoke-'))
const profile = join(home, 'profiles/tui')
const link = join(profile, 'node_modules/@deepseek-ai/dsh-tui')
mkdirSync(dirname(link), { recursive: true })
symlinkSync(join(root, 'packages/dsh-tui'), link, process.platform === 'win32' ? 'junction' : 'dir')
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-tui-real-api-smoke',
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
writeFileSync(join(home, 'settings.yaml'), [
  'agent-default-model:',
  '  provider: deepseek-official',
  '  model: deepseek-v4-pro',
  '  reasoningEffort: high',
  'llm-deepseek:',
  '  baseURL: https://api.deepseek.com',
  '  thinking: enabled',
  '  reasoningEffort: high',
  '',
].join('\n'))

let transcript = ''
const child = ptyModule.spawn(process.execPath, [
  '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'tui',
  'Reply with exactly REAL_TUI_OK and do not call tools.',
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
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
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
})
let exitSubscription: { dispose(): void } | undefined
const finished = new Promise<number>((resolveExit, reject) => {
  const timer = setTimeout(() => {
    closePty()
    reject(new Error(`real API TUI smoke timed out\n${transcript.slice(-8000)}`))
  }, 120_000)
  exitSubscription = child.onExit(({ exitCode }) => {
    clearTimeout(timer)
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

try {
  const code = await finished
  if (code !== 0) throw new Error(`real API TUI exited ${String(code)}\n${transcript.slice(-8000)}`)

  const normalizedTranscript = transcript
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\s+/g, '')
  if (!normalizedTranscript.includes('REAL_TUI_OK')) {
    throw new Error(`real API response marker was not rendered\n${transcript.slice(-8000)}`)
  }

  const records = jsonlFiles(join(home, 'sessions')).flatMap(file => readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as {
      type?: unknown
      data?: { header?: { config?: Record<string, unknown> } }
    }))
  const config = records.find(record => record.type === 'request/header')?.data?.header?.config
  if (config?.provider !== 'deepseek-official'
    || config.model !== 'deepseek-v4-pro'
    || config.reasoningEffort !== 'high') {
    throw new Error(`unexpected persisted model selection: ${JSON.stringify(config)}`)
  }

  process.stdout.write('real Harness TUI API smoke accepted (deepseek-v4-pro + thinking/high + streamed response)\n')
} finally {
  dataSubscription.dispose()
  exitSubscription?.dispose()
  closePty()
  rmSync(home, { recursive: true, force: true })
}

// node-pty's bundled Windows ConPTY worker can retain an idle pipe after kill.
// All owned resources and assertions have settled before this success-only exit.
if (process.platform === 'win32') process.exit(0)
