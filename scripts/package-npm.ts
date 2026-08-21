/**
 * Build the tarball that gets published to npm as `dshcodecli`.
 *
 * The published package is this one with three edits, applied to a staged copy
 * rather than to the source tree:
 *
 * 1. **A different name.** The workspace package is `@deepseek-ai/dsh-tui`,
 *    which is the *bundle* identity: `cordis.patch.yml` imports itself under
 *    that specifier and `prepareProfile` links the directory into the profile
 *    under it. That name belongs to DeepSeek's npm org, so it is not what this
 *    gets published as — and it cannot simply be renamed either, because the
 *    bundle specifier has to keep working. Publishing under `dshcodecli` (the
 *    command name) leaves both intact: npm installs the directory as
 *    `node_modules/dshcodecli`, and the profile still links it in as
 *    `@deepseek-ai/dsh-tui` by absolute path.
 * 2. **`private` dropped**, which is what blocks `npm publish` today.
 * 3. **`@deepseek-ai/dsh` added as a dependency**, so one install brings the
 *    CLI this profile runs on. Installed from the workspace it is resolved at
 *    runtime instead (`DSH_CLI` → dependency → `PATH`); a published package has
 *    no reason to make the user do that by hand.
 *
 * Nothing here is platform-specific: this package is JavaScript, and every
 * native dependency belongs to `@deepseek-ai/dsh`, which npm resolves per
 * machine. The same tarball therefore serves Ubuntu, Windows and macOS — unlike
 * the offline bundle, which is fixed to the platform it was built on.
 *
 * This script does not publish. It prints the command to run, because pushing a
 * name to a public registry is not something a build script should do on its
 * own.
 *
 * Usage:
 *   node --import tsx/esm scripts/package-npm.ts
 *   node --import tsx/esm scripts/package-npm.ts --name @you/dshcodecli
 *   node --import tsx/esm scripts/package-npm.ts --no-verify
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

/** The published name. `@deepseek-ai/dsh-tui` stays the bundle identity. */
const DEFAULT_NAME = 'dshcodecli'
/** The CLI the profile runs on, pinned rather than ranged: it is a prerelease. */
const DSH_VERSION = '0.1.0-rc.8'
const NPM_REGISTRY = 'https://registry.npmjs.org'

const root = resolve(import.meta.dirname, '..')
const packageDir = join(root, 'packages/dsh-tui')

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    name: { type: 'string' },
    dsh: { type: 'string' },
    verify: { type: 'boolean', default: true },
    'no-verify': { type: 'boolean', default: false },
  },
  allowPositionals: false,
})
const out = resolve(root, values.out ?? 'dist')
const publishName = values.name ?? DEFAULT_NAME
const dshVersion = values.dsh ?? DSH_VERSION
const verify = values.verify !== false && values['no-verify'] !== true

function step(message: string): void {
  process.stdout.write(`\n▶ ${message}\n`)
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${String(result.status)})`)
}

function capture(command: string, args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' })
  if (result.error !== undefined) throw result.error
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

// ---------------------------------------------------------------------------
// 1. Build the compiled entry points the tarball ships.
// ---------------------------------------------------------------------------
step('building lib/')
run('npx', ['tsc', '-p', 'packages/dsh-tui/tsconfig.build.json'], root)

// ---------------------------------------------------------------------------
// 2. Stage the package with the publish edits.
// ---------------------------------------------------------------------------
step(`staging ${publishName}`)
const staging = mkdtempSync(join(tmpdir(), 'dshcodecli-npm-'))
const stagedPackage = join(staging, 'package')
mkdirSync(stagedPackage, { recursive: true })

type Manifest = Record<string, unknown> & {
  name: string
  version: string
  private?: boolean
  files?: string[]
  dependencies?: Record<string, string>
  scripts?: Record<string, string>
}
const source = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Manifest

// Copy exactly what `files` promises, so the staged tree cannot ship more than
// the workspace package would.
for (const pattern of source.files ?? []) {
  const base = pattern.split('/')[0] ?? pattern
  const from = join(packageDir, base)
  try {
    cpSync(from, join(stagedPackage, base), { recursive: true })
  } catch {
    // A `files` entry with no matching path is npm's problem to report, not a
    // reason to fail here.
  }
}
copyFileSync(join(packageDir, 'package.json'), join(stagedPackage, 'package.json'))

const published: Manifest = {
  ...source,
  name: publishName,
  dependencies: {
    ...source.dependencies,
    '@deepseek-ai/dsh': dshVersion,
    // The rc.8 CLI graph imports these runtime peers without carrying them at
    // its root. Pinning the verified closure avoids npm 11's peer-tree search
    // and keeps deterministic installs from producing a broken command.
    '@deepseek-ai/cordis-plugin-group': '1.0.1',
    '@deepseek-ai/dsh-atomic-write': dshVersion,
    '@deepseek-ai/dsh-fs': dshVersion,
    '@deepseek-ai/dsh-sandbox': dshVersion,
    '@deepseek-ai/dsh-scope': dshVersion,
    '@deepseek-ai/dsh-session-telemetry': dshVersion,
    '@deepseek-ai/dsh-session-title-llm': dshVersion,
    '@deepseek-ai/dsh-shell': dshVersion,
    '@deepseek-ai/dsh-timeout': dshVersion,
  },
  publishConfig: { access: 'public' },
}
delete published.private
delete published.scripts
writeFileSync(join(stagedPackage, 'package.json'), `${JSON.stringify(published, null, 2)}\n`)

// ---------------------------------------------------------------------------
// 3. Pack.
// ---------------------------------------------------------------------------
step('packing')
mkdirSync(out, { recursive: true })
run('npm', ['pack', '--pack-destination', out], stagedPackage)
const tarball = readdirSync(out)
  .filter(entry => entry.endsWith('.tgz') && entry.includes(publishName.replace(/^@/, '').replace('/', '-')))
  .sort()
  .at(-1)
if (tarball === undefined) throw new Error('npm pack produced no tarball')
const tarballPath = join(out, tarball)

// ---------------------------------------------------------------------------
// 4. Install it the way a user would and drive the command.
// ---------------------------------------------------------------------------
if (verify) {
  step('installing the tarball into a throwaway project')
  const project = mkdtempSync(join(tmpdir(), 'dshcodecli-npm-verify-'))
  writeFileSync(join(project, 'package.json'), `${JSON.stringify({
    name: 'dshcodecli-verify', private: true, version: '0.0.0',
  }, null, 2)}\n`)
  // Harness has a large plugin graph with intentionally scoped peers. npm 11
  // can spend minutes exploring equivalent peer placements, especially when a
  // machine-level mirror serves mixed prerelease metadata. The runtime peer
  // this profile needs is explicit in the staged manifest above, so the legacy
  // resolver is deterministic without omitting a required package.
  run('npm', [
    'install', '--legacy-peer-deps', '--registry', NPM_REGISTRY, tarballPath,
  ], project)

  const binary = join(project, 'node_modules/.bin/dshcodecli')
  // The CLI must have come along as a dependency; without it the command
  // resolves nothing and the failure only shows up on the user's machine.
  if (!statSync(join(project, 'node_modules/@deepseek-ai/dsh')).isDirectory()) {
    throw new Error('installing the tarball did not bring @deepseek-ai/dsh with it')
  }
  const version = capture(binary, ['--version'], project)
  if (version.status !== 0 || !version.stdout.includes('installed mode')) {
    throw new Error(`--version did not report installed mode: ${version.stdout}${version.stderr}`)
  }
  const help = capture(binary, ['--help'], project)
  if (help.status !== 0 || !help.stdout.includes('Usage: dshcodecli')) {
    throw new Error(`--help failed (${String(help.status)}): ${help.stdout}${help.stderr}`)
  }
  const nonTty = capture(binary, ['npm smoke'], project)
  if (nonTty.status === 0 || !`${nonTty.stdout}${nonTty.stderr}`.includes('headless')) {
    throw new Error(`the installed command did not refuse a non-TTY run: ${nonTty.stderr}`)
  }
  process.stdout.write('  dsh installed alongside + installed mode + help + non-TTY refusal\n')
  rmSync(project, { recursive: true, force: true })
}

rmSync(staging, { recursive: true, force: true })

step('done')
process.stdout.write(`  tarball  ${relative(root, tarballPath)}  (${(statSync(tarballPath).size / 1024).toFixed(0)} KiB)\n`)
process.stdout.write(`  sha256   ${createHash('sha256').update(readFileSync(tarballPath)).digest('hex')}\n`)
process.stdout.write(`  name     ${publishName}@${source.version}, depending on @deepseek-ai/dsh ${dshVersion}\n`)
process.stdout.write('\nTo publish (this script deliberately does not):\n')
process.stdout.write('  npm login\n')
process.stdout.write(`  npm publish ${relative(root, tarballPath)} --access public\n`)
