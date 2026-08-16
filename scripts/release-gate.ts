/**
 * Release gate. Runs every blocking check in dependency order and refuses to
 * report success unless all of them pass. A failing gate keeps the previously
 * verified baseline as the only releasable version.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const skipSlow = process.argv.includes('--fast')

interface Gate {
  readonly name: string
  readonly script: string
  readonly slow?: boolean
}

const GATES: readonly Gate[] = [
  { name: 'upstream tuple + service contracts', script: 'check:upstream' },
  { name: 'strict typecheck', script: 'build' },
  { name: 'unit, projection, and boundary tests', script: 'test' },
  { name: 'real profile composition', script: 'check:profile' },
  { name: 'interactive PTY matrix', script: 'check:interactive', slow: true },
  { name: 'session resume', script: 'check:resume', slow: true },
  { name: 'cancellation and terminal restore', script: 'check:cancel', slow: true },
  { name: 'performance budgets', script: 'check:bench' },
  { name: 'packed artifact install', script: 'check:packed', slow: true },
  { name: 'durability soak (quick)', script: 'check:soak:quick', slow: true },
]

/** Structural invariants that need no child process. */
function staticInvariants(): void {
  const manifest = JSON.parse(
    readFileSync(join(root, 'packages/dsh-tui/package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
  const closure = { ...manifest.dependencies, ...manifest.peerDependencies }
  if ('@deepseek-ai/cordis' in closure) {
    throw new Error('the TUI must not depend on Cordis directly; the Harness vendored copy is the only instance')
  }
  const compat = JSON.parse(readFileSync(join(root, 'upstream-compat.json'), 'utf8')) as {
    compatibilityBoundary: string
  }
  const adapter = readFileSync(join(root, compat.compatibilityBoundary), 'utf8')
  if (adapter.includes("from '@deepseek-ai/cordis'")) {
    throw new Error('the adapter must reach Cordis through the Harness runtime, not by importing it')
  }
}

const results: { name: string; ms: number; skipped: boolean }[] = []
staticInvariants()

for (const gate of GATES) {
  if (skipSlow && gate.slow === true) {
    results.push({ name: gate.name, ms: 0, skipped: true })
    continue
  }
  const started = Date.now()
  process.stdout.write(`\n=== ${gate.name} (npm run ${gate.script}) ===\n`)
  const result = spawnSync('npm', ['run', gate.script], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    process.stderr.write(`\nrelease gate FAILED at: ${gate.name}\n`)
    process.exit(result.status ?? 1)
  }
  results.push({ name: gate.name, ms: Date.now() - started, skipped: false })
}

process.stdout.write('\nrelease gate summary\n')
for (const result of results) {
  process.stdout.write(`  ${result.skipped ? 'SKIP' : ' OK '}  ${result.name.padEnd(40)}`
    + `${result.skipped ? '' : `${(result.ms / 1000).toFixed(1)}s`}\n`)
}
if (skipSlow) process.stdout.write('\nfast mode: slow gates were skipped and this run is not releasable\n')
else process.stdout.write('\nall release gates passed\n')
