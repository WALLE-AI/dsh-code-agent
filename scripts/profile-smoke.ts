import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const harness = join(root, 'opensource/deepseek-harness')
const home = mkdtempSync(join(tmpdir(), 'dsh-tui-profile-smoke-'))
const profile = join(home, 'profiles/tui')
const link = join(profile, 'node_modules/@deepseek-ai/dsh-tui')
mkdirSync(dirname(link), { recursive: true })
symlinkSync(join(root, 'packages/dsh-tui'), link, process.platform === 'win32' ? 'junction' : 'dir')
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-tui-smoke',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui'] } },
}, null, 2) + '\n')
if (!existsSync(join(profile, 'cordis.patch.yml'))) writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'tui', ...args], {
    cwd: harness,
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  })
  if (result.error !== undefined) throw result.error
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const help = run(['--help'])
if (help.status !== 0 || help.stderr !== '' || !help.stdout.includes('Usage: dsh --profile tui')) {
  throw new Error(`TUI help smoke failed (${String(help.status)}): ${help.stdout}${help.stderr}`)
}
const nonTty = run(['smoke-task'])
if (nonTty.status !== 1 || !nonTty.stderr.includes('requires interactive stdin and stdout')
  || !nonTty.stderr.includes('--profile headless')) {
  throw new Error(`TUI non-TTY smoke failed (${String(nonTty.status)}): ${nonTty.stdout}${nonTty.stderr}`)
}
process.stdout.write('real Harness profile smoke accepted (help + non-TTY refusal)\n')
