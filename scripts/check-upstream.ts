import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const baseline = JSON.parse(readFileSync(join(root, 'upstream-compat.json'), 'utf8')) as {
  harness: { path: string; commit: string; version: string; sessionFormat: number }
}
const harness = join(root, baseline.harness.path)
const commit = execFileSync('git', [
  '-c', `safe.directory=${harness.replaceAll('\\', '/')}`,
  '-C', harness,
  'rev-parse', 'HEAD',
], { encoding: 'utf8' }).trim()
if (commit !== baseline.harness.commit) {
  throw new Error(`Harness commit changed: expected ${baseline.harness.commit}, found ${commit}`)
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
process.stdout.write(`upstream compatibility baseline accepted (${commit.slice(0, 7)}, ${manifest.version}, session format ${String(format)})\n`)
