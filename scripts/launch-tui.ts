import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = join(root, 'opensource/deepseek-harness')
const tuiPackage = join(root, 'packages/dsh-tui')
const home = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
const profile = join(home, 'profiles/tui')
const link = join(profile, 'node_modules/@deepseek-ai/dsh-tui')

mkdirSync(dirname(link), { recursive: true })
try { symlinkSync(tuiPackage, link, process.platform === 'win32' ? 'junction' : 'dir') } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
}
mkdirSync(profile, { recursive: true })
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-tui',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui'] } },
}, null, 2) + '\n')
const userPatch = join(profile, 'cordis.patch.yml')
if (!existsSync(userPatch)) writeFileSync(userPatch, '[]\n')

const result = spawnSync(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'tui', ...process.argv.slice(2)], {
  cwd: harness,
  env: { ...process.env, DSH_HOME: home },
  stdio: 'inherit',
})
if (result.error !== undefined) throw result.error
process.exitCode = result.status ?? 1
