/**
 * Packed-artifact smoke: build the package, pack it, install the tarball into a
 * throwaway profile outside the repository, and start the real Harness TUI
 * profile from that artifact. Catches missing `files` entries, broken exports,
 * and any dependency on monorepo-only paths.
 */

import { spawnSync } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const harness = join(root, 'opensource/deepseek-harness/deepseek-harness-master')
const packageDir = join(root, 'packages/dsh-tui')

const linkType = process.platform === 'win32' ? 'junction' : 'dir'

function run(command: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${String(result.status)})\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

// 1. Build the publishable output the artifact advertises.
run('npx', ['tsc', '-p', 'tsconfig.build.json'], packageDir)
for (const required of ['lib/plugin.js', 'lib/startup.js', 'lib/types/plugin.d.ts']) {
  if (!existsSync(join(packageDir, required))) throw new Error(`build did not emit ${required}`)
}

// 2. Pack it.
const staging = mkdtempSync(join(tmpdir(), 'dsh-tui-pack-'))
run('npm', ['pack', '--pack-destination', staging], packageDir)
const tarball = readdirSync(staging).find(entry => entry.endsWith('.tgz'))
if (tarball === undefined) throw new Error('npm pack produced no tarball')

// 3. Extract it outside the repository.
const installRoot = mkdtempSync(join(tmpdir(), 'dsh-tui-install-'))
// The tarball is copied in first: a bare `C:\...` argument is parsed as a
// remote host by the tar builds shipped on Windows.
copyFileSync(join(staging, tarball), join(installRoot, tarball))
run('tar', ['-xzf', `./${tarball}`], installRoot)
const installed = join(installRoot, 'package')
const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as {
  exports?: Record<string, unknown>
  version?: string
}
for (const required of ['cordis.patch.yml', 'package.json']) {
  if (!existsSync(join(installed, required))) throw new Error(`tarball is missing ${required}`)
}
const entry = manifest.exports?.['.']
const entryPath = typeof entry === 'string' ? entry : (entry as { default?: string } | undefined)?.default
if (entryPath === undefined || !existsSync(join(installed, entryPath))) {
  throw new Error(`tarball entry ${String(entryPath)} does not exist in the artifact`)
}

// 4. Resolve runtime dependencies without the monorepo layout.
const modules = join(installed, 'node_modules')
mkdirSync(modules, { recursive: true })
for (const dependency of ['ink', 'react', 'commander', 'react-reconciler', 'yoga-layout']) {
  const source = join(root, 'node_modules', dependency)
  const target = join(modules, dependency)
  if (!existsSync(source) || existsSync(target)) continue
  symlinkSync(source, target, linkType)
}

// 5. Start the real profile from the installed artifact.
const home = mkdtempSync(join(tmpdir(), 'dsh-tui-packed-home-'))
const profile = join(home, 'profiles/tui')
const link = join(profile, 'node_modules/@deepseek-ai/dsh-tui')
mkdirSync(dirname(link), { recursive: true })
symlinkSync(installed, link, linkType)
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-tui-packed',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui'] } },
}, null, 2) + '\n')
writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')

const help = spawnSync(process.execPath, [
  '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'tui', '--help',
], {
  cwd: harness,
  encoding: 'utf8',
  env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
})
if (help.status !== 0 || !help.stdout.includes('dsh --profile tui')) {
  throw new Error(`packed profile help failed (${String(help.status)})\n${help.stdout}\n${help.stderr}`)
}

const redirected = spawnSync(process.execPath, [
  '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'tui', 'packed smoke task',
], {
  cwd: harness,
  encoding: 'utf8',
  env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
})
if (redirected.status === 0 || !`${redirected.stdout}${redirected.stderr}`.includes('headless')) {
  throw new Error(`packed profile did not refuse a non-TTY run\n${redirected.stdout}\n${redirected.stderr}`)
}

process.stdout.write(`packed artifact smoke accepted (${tarball}, entry ${entryPath}, `
  + 'profile help + non-TTY refusal from an out-of-tree install)\n')
