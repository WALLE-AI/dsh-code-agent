import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const node = process.execPath

function run(label: string, args: string[]): void {
  process.stdout.write(`runtime matrix [${process.version}] ${label}\n`)
  const result = spawnSync(node, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${label} failed under ${process.version} with exit code ${String(result.status)}`)
  }
}

run('TypeScript', [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'])
run('upstream baseline', ['--import', 'tsx/esm', 'scripts/check-upstream.ts'])
run('unit tests', [join(root, 'node_modules/vitest/vitest.mjs'), 'run'])
run('profile smoke', ['--import', 'tsx/esm', 'scripts/profile-smoke.ts'])
run('interactive 80x24', ['--import', 'tsx/esm', 'scripts/interactive-smoke.ts'])
run('interactive resize', ['--import', 'tsx/esm', 'scripts/interactive-smoke.ts', '--wide'])
run('interactive question', ['--import', 'tsx/esm', 'scripts/interactive-smoke.ts', '--question'])
run('interactive Unicode/IME', ['--import', 'tsx/esm', 'scripts/interactive-smoke.ts', '--unicode'])
run('session resume', ['--import', 'tsx/esm', 'scripts/resume-smoke.ts'])
run('cancellation', ['--import', 'tsx/esm', 'scripts/cancel-smoke.ts'])
run('performance budgets', ['--expose-gc', '--import', 'tsx/esm', 'scripts/bench.ts'])
run('quick soak', [
  '--import', 'tsx/esm', 'scripts/interactive-soak.ts',
  '--duration-ms', '10000', '--interval-ms', '500',
])

process.stdout.write(`runtime matrix accepted under ${process.version}\n`)
