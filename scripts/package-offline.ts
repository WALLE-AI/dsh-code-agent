/**
 * Build an offline, self-contained `dshcodecli` bundle.
 *
 * The output is a directory (and a `.tar.gz` of it) that carries this profile,
 * the upstream `dsh` CLI, and every runtime dependency of both. A target
 * machine needs nothing but Node — no registry, no pnpm, no checkout.
 *
 * The build machine does need the registry: the closure is assembled by running
 * a real `npm install` into a staging directory, which is the only way to get a
 * dependency set that npm itself agrees is complete. Everything installed is
 * `--omit=dev`.
 *
 * ## Why the upstream CLI comes from the registry
 *
 * The vendored checkout under `opensource/` is the pinned `0.1.0-rc.5`, and
 * building it here is not currently possible: `npm run build:lib:host` fails in
 * upstream's own bundling step (`@deepseek-ai/dsh-root: Cannot find entry
 * lib/types/{index,invariant,startup}.js`), and rc.5 was never published. The
 * bundle therefore ships a published version, which is a real difference from
 * the checkout the gates verify — so `--verify` drives the staged bundle after
 * building it, and the version it used is recorded in the bundle's MANIFEST.
 *
 * Usage:
 *   node --import tsx/esm scripts/package-offline.ts
 *   node --import tsx/esm scripts/package-offline.ts --dsh 0.1.0-rc.7 --out dist
 *   node --import tsx/esm scripts/package-offline.ts --no-verify --no-archive
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

/**
 * The upstream release the bundle carries.
 *
 * Not the pinned rc.5 — see the file header. Bump this deliberately: a version
 * that cannot load the profile will be caught by the verification step, but one
 * that merely behaves differently will not.
 */
const DEFAULT_DSH_VERSION = '0.1.0-rc.7'

/** The lowest Node the bundle will run on, from both manifests' `engines`. */
const NODE_REQUIREMENT = '22.19.0'

const root = resolve(import.meta.dirname, '..')
const packageDir = join(root, 'packages/dsh-tui')

interface Options {
  out: string
  dshVersion: string
  verify: boolean
  archive: boolean
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      dsh: { type: 'string' },
      // `parseArgs` has no negation of its own, so the off switches are their
      // own options rather than `--no-` forms of these two.
      verify: { type: 'boolean', default: true },
      archive: { type: 'boolean', default: true },
      'no-verify': { type: 'boolean', default: false },
      'no-archive': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })
  return {
    out: resolve(root, values.out ?? 'dist'),
    dshVersion: values.dsh ?? DEFAULT_DSH_VERSION,
    verify: values.verify !== false && values['no-verify'] !== true,
    archive: values.archive !== false && values['no-archive'] !== true,
  }
}

function step(message: string): void {
  process.stdout.write(`\n▶ ${message}\n`)
}

/** Run a command, inheriting stdio, and fail loudly on a non-zero status. */
function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${String(result.status)}`)
  }
}

/** Run a command and capture its output instead of showing it. */
function capture(command: string, args: string[], cwd: string, env: Record<string, string> = {}): {
  status: number | null; stdout: string; stderr: string
} {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) throw result.error
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/**
 * The installed packages that declare an `os`/`cpu`/`libc` restriction — i.e.
 * the ones that make this bundle specific to the machine it was built on. They
 * are npm `optionalDependencies` with one variant per platform, so a bundle
 * built here simply has no copy of the variants other platforms need.
 */
function nativeClosure(modules: string): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = join(directory, entry.name)
      if (entry.name.startsWith('@')) { walk(full); continue }
      const descriptor = join(full, 'package.json')
      if (existsSync(descriptor)) {
        const meta = readJson<{ name?: string; os?: string[]; cpu?: string[]; libc?: string[] }>(descriptor)
        if (meta.os !== undefined || meta.cpu !== undefined || meta.libc !== undefined) {
          found.push([meta.name ?? entry.name,
            [...meta.os ?? [], ...meta.cpu ?? [], ...meta.libc ?? []].join('/')].join(' '))
        }
      }
      if (existsSync(join(full, 'node_modules'))) walk(join(full, 'node_modules'))
    }
  }
  walk(modules)
  return found.sort()
}

/** Total size of a directory tree, in bytes. */
function treeSize(directory: string): number {
  let total = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) total += treeSize(full)
    else if (entry.isFile()) total += statSync(full).size
  }
  return total
}

function human(bytes: number): string {
  const megabytes = bytes / 1024 / 1024
  return megabytes >= 1024 ? `${(megabytes / 1024).toFixed(2)} GiB` : `${megabytes.toFixed(1)} MiB`
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const options = parseOptions()
const version = readJson<{ version: string }>(join(packageDir, 'package.json')).version
const bundleName = `dshcodecli-${version}`
const bundle = join(options.out, bundleName)

// ---------------------------------------------------------------------------
// 1. Compile this package and pack it, so the bundle installs the same artifact
//    a consumer would get from a publish rather than a copy of the working tree.
// ---------------------------------------------------------------------------
step('building lib/')
run('npx', ['tsc', '-p', 'tsconfig.build.json'], packageDir)

step('packing the profile')
const packStaging = mkdtempSync(join(tmpdir(), 'dshcodecli-pack-'))
run('npm', ['pack', '--pack-destination', packStaging], packageDir)
const tarball = readdirSync(packStaging).find(entry => entry.endsWith('.tgz'))
if (tarball === undefined) throw new Error('npm pack produced no tarball')

// ---------------------------------------------------------------------------
// 2. Install the closure: our tarball plus the upstream CLI, production only.
// ---------------------------------------------------------------------------
step(`installing the runtime closure (@deepseek-ai/dsh@${options.dshVersion})`)
rmSync(bundle, { recursive: true, force: true })
mkdirSync(bundle, { recursive: true })
copyTarball()
writeFileSync(join(bundle, 'package.json'), `${JSON.stringify({
  name: 'dshcodecli-bundle',
  version,
  private: true,
  type: 'module',
  engines: { node: `>=${NODE_REQUIREMENT}` },
  dependencies: {
    '@deepseek-ai/dsh': options.dshVersion,
    '@deepseek-ai/dsh-tui': `file:./${tarball}`,
  },
}, null, 2)}\n`)
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel', 'error'], bundle)

/** Put our tarball inside the bundle so the install has a stable file: source. */
function copyTarball(): void {
  cpSync(join(packStaging, tarball ?? ''), join(bundle, tarball ?? ''))
}

// ---------------------------------------------------------------------------
// 3. Launchers. npm already wrote node_modules/.bin/dshcodecli; these are the
//    same thing at the top level, so the bundle is obvious to a newcomer and
//    usable without putting .bin on PATH.
// ---------------------------------------------------------------------------
step('writing launchers')
const entry = 'node_modules/@deepseek-ai/dsh-tui/bin/dshcodecli.mjs'
const shell = join(bundle, 'dshcodecli')
writeFileSync(shell, [
  '#!/usr/bin/env bash',
  '# Offline dshcodecli launcher. The bundle is relocatable: everything it needs',
  '# is resolved relative to this file.',
  'set -euo pipefail',
  'here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
  `exec node "$here/${entry}" "$@"`,
  '',
].join('\n'))
chmodSync(shell, 0o755)
writeFileSync(join(bundle, 'dshcodecli.cmd'), [
  '@echo off',
  'setlocal',
  `node "%~dp0${entry.replace(/\//g, '\\')}" %*`,
  '',
].join('\r\n'))

// ---------------------------------------------------------------------------
// 4. Manifest and README, so the bundle says what it is without this repository.
// ---------------------------------------------------------------------------
const installedDsh = readJson<{ version: string }>(
  join(bundle, 'node_modules/@deepseek-ai/dsh/package.json'),
).version
// npm installs only the optional dependencies that match the machine it runs
// on, so the bundle is as portable as its native packages are — which is a
// question about the closure, not something this script gets to assert. Read it
// off the tree that was actually installed.
const nativePackages = nativeClosure(join(bundle, 'node_modules'))
const target = `${process.platform}-${process.arch}`
const manifest = {
  bundle: bundleName,
  profileVersion: version,
  dshVersion: installedDsh,
  builtWithNode: process.version,
  requiresNode: `>=${NODE_REQUIREMENT}`,
  platform: nativePackages.length === 0 ? 'any (no platform-specific packages)' : target,
  nativePackages,
  note: 'Built from the published dsh release, not the pinned rc.5 checkout — see scripts/package-offline.ts.',
}
writeFileSync(join(bundle, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`)
writeFileSync(join(bundle, 'README.txt'), `dshcodecli ${version} — offline bundle
=========================================

Requires: Node >=${NODE_REQUIREMENT}, on ${target}. Nothing else — no npm install,
          no network.
Carries:  @deepseek-ai/dsh ${installedDsh} + this terminal profile + all runtime
          dependencies.

Platform
--------
${nativePackages.length === 0
  ? 'Nothing in this bundle is platform-specific; it runs anywhere Node does.'
  : `This bundle is ${target}-only. ${String(nativePackages.length)} of its packages ship a
compiled binary and npm installed only the variant matching the build machine:

${nativePackages.map(name => `  ${name}`).join('\n')}

Another platform (or musl libc, e.g. Alpine) needs its own bundle, built by
running this script there. The Node requirement above is necessary, not
sufficient.`}

Run it
------
  ./dshcodecli "fix the race in the login module"   # one-shot task
  ./dshcodecli -i "review the working tree"          # interactive session
  ./dshcodecli -i --resume latest                    # resume the last session
  dshcodecli.cmd -i "..."                            # Windows

The directory you run it in is the workspace the agent reads and edits.
Sessions are written to $DSH_HOME (default ~/.dsh); set DSH_HOME=\$(mktemp -d)
for a throwaway one. Both stdin and stdout must be a TTY.

Credentials
-----------
Put a .env next to where you run it (or export the variables yourself):

  DEEPSEEK_API=<key>        # DEEPSEEK_API_KEY is also accepted
  DEEPSEEK_URL=<base url>   # optional, defaults to https://api.deepseek.com

Exported environment variables always win over the file. With a proxy set
(HTTP_PROXY/HTTPS_PROXY) the launcher adds --use-env-proxy on Node 24+, since
Node's built-in fetch ignores those variables otherwise.

Install it on PATH (optional)
-----------------------------
  ln -s "$PWD/dshcodecli" ~/.local/bin/dshcodecli

MANIFEST.json records the exact versions this bundle was built from.
`)

// ---------------------------------------------------------------------------
// 5. Drive the thing we just built.
// ---------------------------------------------------------------------------
if (options.verify) {
  step('verifying the bundle')
  const home = mkdtempSync(join(tmpdir(), 'dshcodecli-bundle-home-'))
  const workspace = mkdtempSync(join(tmpdir(), 'dshcodecli-bundle-work-'))
  // A clean environment: nothing from this checkout may leak into the run, or
  // the verification would prove the checkout works rather than the bundle.
  const clean: Record<string, string> = { DSH_HOME: home, NODE_OPTIONS: '', DSH_CLI: '' }

  const help = capture(process.execPath, [join(bundle, entry), '--help'], workspace, clean)
  if (help.status !== 0 || !help.stdout.includes('Usage: dshcodecli')) {
    throw new Error(`bundle --help failed (${String(help.status)}): ${help.stdout}${help.stderr}`)
  }
  const nonTty = capture(process.execPath, [join(bundle, entry), 'bundle smoke'], workspace, clean)
  if (nonTty.status === 0 || !`${nonTty.stdout}${nonTty.stderr}`.includes('headless')) {
    throw new Error(`bundle did not refuse a non-TTY run (${String(nonTty.status)}): ${nonTty.stderr}`)
  }
  // The profile was loaded from the bundle's own copy, not from this checkout.
  const loaded = join(home, 'profiles/tui/node_modules/@deepseek-ai/dsh-tui')
  if (!capture('readlink', ['-f', loaded], workspace).stdout.trim().startsWith(resolve(bundle))) {
    throw new Error('the bundle linked a profile from outside itself')
  }
  process.stdout.write('  help + non-TTY refusal + self-contained profile link\n')
}

// ---------------------------------------------------------------------------
// 6. Archive.
// ---------------------------------------------------------------------------
let archive: string | undefined
if (options.archive) {
  step('creating the archive')
  archive = join(options.out, `${bundleName}.tar.gz`)
  rmSync(archive, { force: true })
  run('tar', ['-czf', archive, '-C', options.out, bundleName], root)
}

rmSync(packStaging, { recursive: true, force: true })

step('done')
process.stdout.write(`  directory  ${relative(root, bundle)}  (${human(treeSize(bundle))})\n`)
if (archive !== undefined) {
  process.stdout.write(`  archive    ${relative(root, archive)}  (${human(statSync(archive).size)})\n`)
  process.stdout.write(`  sha256     ${sha256(archive)}\n`)
}
process.stdout.write(`  carries    @deepseek-ai/dsh ${installedDsh}, profile ${version}, needs Node >=${NODE_REQUIREMENT}\n`)
