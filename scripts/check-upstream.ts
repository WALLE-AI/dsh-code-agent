import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const baseline = JSON.parse(readFileSync(join(root, 'upstream-compat.json'), 'utf8')) as {
  harness: { path: string; version: string; sessionFormat: number }
}
const harness = join(root, baseline.harness.path)
const manifest = JSON.parse(readFileSync(join(harness, 'package.json'), 'utf8')) as { version: string }
if (manifest.version !== baseline.harness.version) {
  throw new Error(`Harness version changed: expected ${baseline.harness.version}, found ${manifest.version}`)
}

const contracts: [string, RegExp, string][] = [
  ['packages/core/agent/src/index.ts', /interface AgentHandle[\s\S]*dispose\(\): Promise<void>/, 'AgentHandle.dispose'],
  ['packages/core/agent/src/index.ts', /async create\(options: CreateAgentOptions\): Promise<AgentHandle>/, 'agents.create'],
  ['packages/core/session/src/index.ts', /flush\(session: Session\): Promise<boolean>/, 'sessions.flush'],
  ['packages/interaction/user-approval/src/index.ts', /'approval\/request'/, 'approval/request'],
  ['packages/boot/cmdline/src/index.ts', /interface CmdlineArgs[\s\S]*get\(\): readonly string\[\]/, 'cmdlineArgs'],
]
for (const [file, pattern, contract] of contracts) {
  if (!pattern.test(readFileSync(join(harness, file), 'utf8'))) throw new Error(`Harness contract changed: ${contract} in ${file}`)
}

const sessionTypes = readFileSync(join(harness, 'packages/core/session/src/types.ts'), 'utf8')
const format = Number(/SESSION_FORMAT_VERSION\s*=\s*(\d+)/.exec(sessionTypes)?.[1] ?? baseline.harness.sessionFormat)
if (format !== baseline.harness.sessionFormat) {
  throw new Error(`Session format changed: expected ${baseline.harness.sessionFormat}, found ${format}`)
}
process.stdout.write(`upstream compatibility baseline accepted (${manifest.version}, session format ${String(format)})\n`)
