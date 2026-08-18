import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { harnessDigest } from './harness-digest.ts'

const root = resolve(import.meta.dirname, '..')
const compatPath = join(root, 'upstream-compat.json')
const baseline = JSON.parse(readFileSync(compatPath, 'utf8')) as {
  harness: { path: string; sourceDigest: string; version: string; sessionFormat: number }
}
const harness = join(root, baseline.harness.path)
// Re-pinning is deliberately a separate, explicit run: a gate that silently
// adopts whatever it finds is not a gate.
if (process.argv.includes('--update')) {
  const updated = harnessDigest(harness)
  const manifestVersion = (JSON.parse(
    readFileSync(join(harness, 'package.json'), 'utf8'),
  ) as { version: string }).version
  const next = {
    ...JSON.parse(readFileSync(compatPath, 'utf8')) as Record<string, unknown>,
    harness: { ...baseline.harness, sourceDigest: updated, version: manifestVersion },
  }
  writeFileSync(compatPath, `${JSON.stringify(next, undefined, 2)}\n`)
  process.stdout.write(`upstream baseline re-pinned (${updated.slice(0, 12)}, ${manifestVersion})\n`)
  process.exit(0)
}
// Not a commit id: the Harness is vendored as a source drop with no `.git`, so
// `git rev-parse HEAD` inside it answers with our own commit and pins nothing.
// See `harness-digest.ts`.
const digest = harnessDigest(harness)
if (digest !== baseline.harness.sourceDigest) {
  throw new Error(
    `Harness source changed: expected ${baseline.harness.sourceDigest}, found ${digest}.\n`
    + 'Re-pin with `npm run check:upstream -- --update` once the change is reviewed.',
  )
}
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
  ['packages/core/agent/src/index.ts', /async resume\(options: ResumeAgentOptions\): Promise<AgentHandle>/, 'agents.resume'],
  [
    'packages/session-query/session-query/src/index.ts',
    /listSessions\(signal\?: AbortSignal\): Promise<SessionRecord\[\]>/,
    'sessionQuery.listSessions',
  ],
  [
    'packages/session-query/session-query/src/types.ts',
    /interface SessionRecord[\s\S]*header: SessionHeader[\s\S]*live: boolean[\s\S]*persisted: boolean/,
    'SessionRecord shape',
  ],
  [
    'packages/interaction/permission-presets/src/index.ts',
    /presets: z\.dict[\s\S]*defaultPreset: z\.string\(\)/,
    'permission-presets config',
  ],
  [
    'packages/interaction/user-questions/src/index.ts',
    /registerProvider/,
    'userQuestions.registerProvider',
  ],
  [
    'packages/core/tools/src/presentation.ts',
    /card: 'generic'[\s\S]*card: 'terminal'[\s\S]*card: 'diff'[\s\S]*card: 'search'[\s\S]*card: 'read'[\s\S]*card: 'web'/,
    'tool render-intent vocabulary',
  ],
  [
    'packages/interaction/user-approval/src/index.ts',
    /interface ApprovalRequest[\s\S]*readonly toolName: string[\s\S]*readonly callId\?: CallId/,
    'ApprovalRequest shape',
  ],
]
for (const [file, pattern, contract] of contracts) {
  if (!pattern.test(readFileSync(join(harness, file), 'utf8'))) throw new Error(`Harness contract changed: ${contract} in ${file}`)
}

const sessionTypes = readFileSync(join(harness, 'packages/core/session/src/types.ts'), 'utf8')
const format = Number(/SESSION_FORMAT_VERSION\s*=\s*(\d+)/.exec(sessionTypes)?.[1] ?? baseline.harness.sessionFormat)
if (format !== baseline.harness.sessionFormat) {
  throw new Error(`Session format changed: expected ${baseline.harness.sessionFormat}, found ${format}`)
}
process.stdout.write(`upstream compatibility baseline accepted (source ${digest.slice(0, 12)}, ${manifest.version}, session format ${String(format)})\n`)
