/**
 * Build the single-file `dshcodecli` executable.
 *
 * Takes the offline bundle (`scripts/package-offline.ts`), packs it into one
 * archive, and injects that archive plus `scripts/sea/main.cjs` into a copy of
 * the Node binary as a single-executable application. The result needs nothing
 * on the target machine — not even Node.
 *
 * The tree is unpacked into a cache directory on first run, because the Harness
 * resolves profiles through real directories; `scripts/sea/main.cjs` explains
 * that and the in-process CLI hosting it forces.
 *
 * The executable is built for **the platform and architecture it is built on**.
 * `--node <path>` accepts another platform's `node` binary, but that path is
 * only sound where the copy needs no re-signing — a macOS target built off-host
 * will not be signed, and macOS will refuse to run it.
 *
 * Usage:
 *   node --import tsx/esm scripts/package-sea.ts
 *   node --import tsx/esm scripts/package-sea.ts --bundle dist/dshcodecli-0.1.0
 *   node --import tsx/esm scripts/package-sea.ts --no-verify
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { packDirectory } from './sea/archive.mjs'

/** postject's sentinel, fixed by Node's own SEA documentation. */
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

const root = resolve(import.meta.dirname, '..')
const packageDir = join(root, 'packages/dsh-tui')

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    bundle: { type: 'string' },
    node: { type: 'string' },
    // `parseArgs` has no negation of its own, so `--no-verify` is its own
    // option rather than a `--verify` form.
    verify: { type: 'boolean', default: true },
    'no-verify': { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

const out = resolve(root, values.out ?? 'dist')
const version = (JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version: string }).version
const bundle = resolve(root, values.bundle ?? join(out, `dshcodecli-${version}`))
const nodeBinary = resolve(values.node ?? process.execPath)

function step(message: string): void {
  process.stdout.write(`\n▶ ${message}\n`)
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${String(result.status)})`)
}

function capture(command: string, args: string[], cwd: string, env: Record<string, string> = {}): {
  status: number | null; stdout: string; stderr: string
} {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  if (result.error !== undefined) throw result.error
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function human(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

// ---------------------------------------------------------------------------
// 1. The bundle. Build it if it is not there, so this script stands alone.
// ---------------------------------------------------------------------------
if (!existsSync(join(bundle, 'MANIFEST.json'))) {
  step(`building the offline bundle first (${relative(root, bundle)} is missing)`)
  run(process.execPath, [
    '--import', 'tsx/esm', 'scripts/package-offline.ts',
    '--out', relative(root, out), '--no-archive',
  ], root)
}
const manifestPath = join(bundle, 'MANIFEST.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dshVersion: string; profileVersion: string }

// ---------------------------------------------------------------------------
// 2. Pack the bundle into the archive the executable carries.
// ---------------------------------------------------------------------------
step('packing the runtime archive')
const staging = mkdtempSync(join(tmpdir(), 'dshcodecli-sea-'))
const packed = packDirectory(bundle)
const archivePath = join(staging, 'runtime.dshc')
writeFileSync(archivePath, packed.archive)
process.stdout.write(
  `  ${String(packed.fileCount)} files, ${human(packed.rawBytes)} → ${human(packed.archive.length)}\n`,
)

// ---------------------------------------------------------------------------
// 3. Blob.
// ---------------------------------------------------------------------------
step('building the SEA blob')
cpSync(join(root, 'scripts/sea/main.cjs'), join(staging, 'main.cjs'))
copyFileSync(manifestPath, join(staging, 'manifest.json'))
writeFileSync(join(staging, 'sea-config.json'), `${JSON.stringify({
  main: 'main.cjs',
  output: 'sea.blob',
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: { runtime: 'runtime.dshc', manifest: 'manifest.json' },
}, null, 2)}\n`)
run(process.execPath, ['--experimental-sea-config', 'sea-config.json'], staging)

// ---------------------------------------------------------------------------
// 4. Inject into a copy of the Node binary.
// ---------------------------------------------------------------------------
step('injecting into the Node binary')
const suffix = process.platform === 'win32' ? '.exe' : ''
const executable = join(out, `dshcodecli-${version}-${process.platform}-${process.arch}${suffix}`)
mkdirSync(out, { recursive: true })
rmSync(executable, { force: true })
copyFileSync(nodeBinary, executable)
chmodSync(executable, 0o755)
// macOS refuses to run a binary whose signature no longer matches its contents,
// so the copy is unsigned before injection and ad-hoc signed after.
if (process.platform === 'darwin') run('codesign', ['--remove-signature', executable], root)
// The devDependency is run directly rather than through `npx`, so the build
// never reaches the network for a tool that is already installed.
run(process.execPath, [
  createRequire(import.meta.url).resolve('postject/dist/cli.js'),
  executable, 'NODE_SEA_BLOB', join(staging, 'sea.blob'),
  '--sentinel-fuse', SENTINEL,
  ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
], root)
if (process.platform === 'darwin') run('codesign', ['--sign', '-', executable], root)

// ---------------------------------------------------------------------------
// 5. Drive it, with the runtime cache pointed somewhere disposable.
// ---------------------------------------------------------------------------
if (values.verify !== false && values['no-verify'] !== true) {
  step('verifying the executable')
  const runtime = join(mkdtempSync(join(tmpdir(), 'dshcodecli-sea-runtime-')), 'runtime')
  const home = mkdtempSync(join(tmpdir(), 'dshcodecli-sea-home-'))
  const workspace = mkdtempSync(join(tmpdir(), 'dshcodecli-sea-work-'))
  const environment = { DSHCODECLI_RUNTIME: runtime, DSH_HOME: home, NODE_OPTIONS: '', DSH_CLI: '' }

  const first = capture(executable, ['--version'], workspace, environment)
  if (first.status !== 0 || !first.stdout.includes(version)) {
    throw new Error(`--version failed (${String(first.status)}): ${first.stdout}${first.stderr}`)
  }
  if (!first.stderr.includes('unpacking the runtime')) {
    throw new Error('the first run did not unpack anything; the cache was not honoured')
  }
  const second = capture(executable, ['--version'], workspace, environment)
  if (second.stderr.includes('unpacking the runtime')) {
    throw new Error('the second run unpacked again; the cache marker is not working')
  }
  const help = capture(executable, ['--help'], workspace, environment)
  if (help.status !== 0 || !help.stdout.includes('Usage: dshcodecli')) {
    throw new Error(`--help failed (${String(help.status)}): ${help.stdout}${help.stderr}`)
  }
  const nonTty = capture(executable, ['sea smoke'], workspace, environment)
  if (nonTty.status === 0 || !`${nonTty.stdout}${nonTty.stderr}`.includes('headless')) {
    throw new Error(`the executable did not refuse a non-TTY run (${String(nonTty.status)}): ${nonTty.stderr}`)
  }
  if (!existsSync(join(home, 'profiles/tui/package.json'))) {
    throw new Error('the executable did not write the profile manifest')
  }
  process.stdout.write('  unpack once + reuse + help + non-TTY refusal + profile written\n')
}

rmSync(staging, { recursive: true, force: true })

step('done')
const size = statSync(executable).size
process.stdout.write(`  executable ${relative(root, executable)}  (${human(size)})\n`)
process.stdout.write(`  sha256     ${createHash('sha256').update(readFileSync(executable)).digest('hex')}\n`)
process.stdout.write(`  carries    @deepseek-ai/dsh ${manifest.dshVersion}, profile ${version}\n`)
process.stdout.write('  target     runs with no Node installed; unpacks to $XDG_CACHE_HOME/dshcodecli on first run\n')
