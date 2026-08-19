/**
 * The program inside the single-file `dshcodecli` executable.
 *
 * A Node single-executable application is one CommonJS script plus assets; it
 * cannot be used as a plain `node`, so this file does two things the normal
 * launcher does not have to:
 *
 * 1. **Unpack.** The profile, the upstream CLI and their dependencies are
 *    carried as one embedded archive. The Harness resolves a profile through
 *    real directories on disk, so the tree has to exist somewhere; it is
 *    extracted once into a cache directory and reused on every later run.
 *
 * 2. **Host the CLI in-process.** The normal launcher spawns `process.execPath`
 *    with the CLI as its argument. Here `process.execPath` is this executable,
 *    which would just run this script again — so the CLI is imported instead,
 *    with `process.argv` set to what it would have been given.
 *
 * 3. **Restart itself for `NODE_OPTIONS`.** That variable only takes effect at
 *    process start, and there is no child process here to hand it to, so the
 *    proxy flag costs one restart of the executable.
 *
 * Everything else — writing the profile, reading `.env`, the proxy flag — is
 * the launcher's own logic, imported from the extracted tree rather than
 * duplicated here.
 */

'use strict'

const { getAsset } = require('node:sea')
const { spawnSync } = require('node:child_process')
const { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { dirname, join, resolve } = require('node:path')
const { gunzipSync } = require('node:zlib')
const { pathToFileURL } = require('node:url')

const MAGIC = 'DSHC1\n'

/**
 * Unpack the embedded archive into `destination`. Mirrors
 * `scripts/sea/archive.mjs`; see that file for the layout.
 */
function extract(archive, destination) {
  const magic = archive.subarray(0, MAGIC.length).toString('ascii')
  if (magic !== MAGIC) throw new Error('embedded archive is corrupt: bad magic')
  const indexLength = archive.readUInt32LE(MAGIC.length)
  const indexStart = MAGIC.length + 8
  const index = JSON.parse(gunzipSync(archive.subarray(indexStart, indexStart + indexLength)).toString('utf8'))
  const payload = gunzipSync(archive.subarray(indexStart + indexLength))

  let lastDirectory = ''
  for (const entry of index) {
    const target = join(destination, entry.p)
    const directory = dirname(target)
    if (directory !== lastDirectory) {
      mkdirSync(directory, { recursive: true })
      lastDirectory = directory
    }
    writeFileSync(target, payload.subarray(entry.o, entry.o + entry.l))
    if (entry.x) chmodSync(target, 0o755)
  }
  return index.length
}

/**
 * The directory the runtime tree lives in, keyed by version so a newer
 * executable never reuses an older tree. `DSHCODECLI_RUNTIME` overrides it, for
 * machines where the cache directory is not writable.
 */
function runtimeDirectory(version) {
  const override = (process.env.DSHCODECLI_RUNTIME || '').trim()
  if (override !== '') return resolve(override)
  const base = (process.env.XDG_CACHE_HOME || '').trim() || join(homedir(), '.cache')
  return join(base, 'dshcodecli', version)
}

/**
 * Extract on first run, then reuse. The marker is written last and carries the
 * file count, so a run interrupted midway is redone rather than half-used.
 */
function ensureRuntime(version) {
  const directory = runtimeDirectory(version)
  const marker = join(directory, '.complete')
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === version) return directory

  process.stderr.write(`dshcodecli: unpacking the runtime into ${directory} (first run only)\n`)
  const staging = `${directory}.partial-${String(process.pid)}`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  extract(Buffer.from(getAsset('runtime')), staging)
  writeFileSync(join(staging, '.complete'), `${version}\n`)
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(dirname(directory), { recursive: true })
  renameSync(staging, directory)
  return directory
}

async function main() {
  const version = JSON.parse(getAsset('manifest', 'utf8')).profileVersion
  const runtime = ensureRuntime(version)
  const tuiPackage = join(runtime, 'node_modules/@deepseek-ai/dsh-tui')
  const launcher = await import(pathToFileURL(join(tuiPackage, 'bin/launch.mjs')).href)

  if (!launcher.supportedRuntime(process.version)) {
    process.stderr.write(`dshcodecli: needs Node ^22.19.0 or >=24, but this is ${process.version}\n`)
    process.exitCode = 1
    return
  }

  const argv = process.argv.slice(2)
  if (argv[0] === '--version' || argv[0] === '-v') {
    const manifest = JSON.parse(getAsset('manifest', 'utf8'))
    process.stdout.write(`dshcodecli ${version} (single-file, dsh ${manifest.dshVersion})\n`)
    return
  }

  const home = resolve((process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh'))
  launcher.prepareProfile({ home, tuiPackage })

  const envFile = launcher.loadEnvFile([process.cwd()])
  const nodeMajor = Number(process.version.replace(/^v/, '').split('.')[0])
  const { env, notices } = launcher.credentialEnv(envFile.values, process.env, nodeMajor)
  for (const notice of notices) process.stderr.write(`dshcodecli: ${notice}\n`)
  const previousNodeOptions = process.env.NODE_OPTIONS || ''
  Object.assign(process.env, env, { DSH_HOME: home, DSH_TUI_PROGRAM: 'dshcodecli' })

  // `NODE_OPTIONS` is read when the process starts, and this process is already
  // running — the normal launcher gets this for free by passing the variable to
  // a child, but here the CLI is hosted in-process. So when a proxy flag has to
  // be added, restart the executable once with it in the environment. The guard
  // is the environment itself: the restarted run sees the flag already there and
  // falls through.
  if (env.NODE_OPTIONS !== undefined && env.NODE_OPTIONS !== previousNodeOptions) {
    const restarted = spawnSync(process.execPath, argv, { stdio: 'inherit', env: process.env })
    if (restarted.error) throw restarted.error
    process.exitCode = restarted.status === null ? 130 : restarted.status
    return
  }

  const cli = launcher.resolveDshCli({
    processEnv: process.env,
    resolveFrom: join(tuiPackage, 'package.json'),
  })
  const entry = cli.prefix[0]
  if (entry === undefined) {
    // Only reachable if someone points DSH_CLI at a shell wrapper: this build
    // has no `node` to hand it to, since the executable is the runtime.
    throw new Error('the single-file build can only run a JavaScript dsh entry; unset DSH_CLI')
  }
  process.argv = [process.execPath, entry, '--profile', 'tui', ...argv]
  await import(pathToFileURL(entry).href)
}

main().catch((error) => {
  process.stderr.write(`dshcodecli: ${error && error.stack ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
