/**
 * `dshcodecli` — the single entry point for the DeepSeek Harness TUI.
 *
 * The command runs in one of two modes, decided by where the binary actually
 * lives rather than by a flag:
 *
 * - **dev**: the binary resolves inside this repository, next to the vendored
 *   Harness checkout and a `tsx` install. The upstream CLI is started from
 *   source with `--conditions=development`, so the profile resolves `src/*.ts`.
 * - **installed**: the package was installed somewhere else. The upstream `dsh`
 *   CLI is located as an installed binary and started against the compiled
 *   `lib/` of this package. Setting `DSH_CLI` selects this mode explicitly.
 *
 * Everything else — writing the profile manifest, linking the package into it,
 * loading `.env` — is the same in both modes.
 *
 * This file is plain ESM rather than TypeScript on purpose: the installed mode
 * must not need a loader to boot. It is still type-checked (`checkJs` in the
 * root tsconfig) through the JSDoc annotations below.
 *
 * It also cannot live under `src/`: it must name the vendored checkout, and
 * `tests/isolation.spec.ts` reserves that privilege for `harness-adapter.ts`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join, parse as parsePath, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  canonicalWorkspace,
  isHomeWorkspace,
  promptWorkspaceTrust,
  trustWorkspace,
  workspaceNeedsTrust,
} from './workspace-trust.mjs'

/** Where the vendored Harness lives inside this repository. */
const HARNESS_RELATIVE = 'opensource/deepseek-harness/deepseek-harness-master'
/** The upstream entry the dev mode starts from source. */
const HARNESS_CLI = 'apps/cli/src/bin.ts'
const PROFILE_NAME = 'tui'
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

/**
 * Parse a dotenv-style file the way `scripts/run-tui.sh` did: `KEY=value`, the
 * value being everything after the first `=`, with blank lines and `#` comments
 * ignored. No quoting or interpolation — the shell version had none either, and
 * inventing some here would change what an existing `.env` means.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const values = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    values[key] = trimmed.slice(separator + 1).trim()
  }
  return values
}

/** Proxy variables Node's fetch only honours with `--use-env-proxy`. */
const PROXY_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']

/**
 * Build the environment additions a run needs: credentials from `.env` and, when
 * a proxy is configured, the flag that makes Node's built-in fetch honour it.
 *
 * Nothing already set in the environment is overwritten — an explicit
 * `DEEPSEEK_API_KEY=... dshcodecli ...` must win over the file on disk.
 *
 * `--use-env-proxy` only exists from Node 24 on, while the package supports 22,
 * so on an older runtime the flag is left out and the caller is told why rather
 * than being handed a process that refuses to start.
 *
 * When no key can be found in any of them, that is said here rather than left
 * for the first turn to report: the runtime's own `MISSING_CREDENTIAL` arrives
 * after the TUI has taken the screen, and it can only name the environment and
 * the web Models page — neither of which is where a terminal-only user would
 * put a key. `homeEnvPath` is that place, so the notice can name a file.
 *
 * @param {Record<string, string>} fileValues parsed `.env` contents
 * @param {NodeJS.ProcessEnv} processEnv
 * @param {number} nodeMajor
 * @param {{ stored?: boolean, homeEnvPath?: string }} [credentials] what the
 * harness home already holds: `stored` when its credentials document exists,
 * and the path a notice should point at.
 * @returns {{ env: Record<string, string>, notices: string[] }}
 */
export function credentialEnv(fileValues, processEnv, nodeMajor, credentials = {}) {
  /** @type {Record<string, string>} */
  const env = {}
  /** @type {string[]} */
  const notices = []
  const apiKey = fileValues['DEEPSEEK_API_KEY'] ?? fileValues['DEEPSEEK_API']
  const baseUrl = fileValues['DEEPSEEK_BASE_URL'] ?? fileValues['DEEPSEEK_URL']
  if (apiKey !== undefined && apiKey !== '' && (processEnv['DEEPSEEK_API_KEY'] ?? '') === '') {
    env['DEEPSEEK_API_KEY'] = apiKey
  }
  if ((processEnv['DEEPSEEK_BASE_URL'] ?? '') === '') {
    if (baseUrl !== undefined && baseUrl !== '') env['DEEPSEEK_BASE_URL'] = baseUrl
    else if (env['DEEPSEEK_API_KEY'] !== undefined) env['DEEPSEEK_BASE_URL'] = 'https://api.deepseek.com'
  }
  if ((processEnv['DEEPSEEK_API_KEY'] ?? '') === ''
    && env['DEEPSEEK_API_KEY'] === undefined
    && credentials.stored !== true) {
    notices.push([
      'no DEEPSEEK_API_KEY found in the environment, in a .env beside or above this directory,',
      `or in the harness credentials store; write DEEPSEEK_API_KEY=sk-... to ${
        credentials.homeEnvPath ?? join('~', '.dsh', '.env')} to set it once for every directory.`,
    ].join(' '))
  }
  const proxied = PROXY_VARIABLES.some(name => (processEnv[name] ?? '') !== '')
  const alreadyFlagged = (processEnv['NODE_OPTIONS'] ?? '').includes('--use-env-proxy')
  if (proxied && !alreadyFlagged) {
    if (nodeMajor >= 24) {
      env['NODE_OPTIONS'] = `${processEnv['NODE_OPTIONS'] ?? ''} --use-env-proxy`.trim()
    } else {
      notices.push('a proxy is configured but Node < 24 has no --use-env-proxy; '
        + "Node's fetch will ignore it")
    }
  }
  return { env, notices }
}

/**
 * Decide which mode this binary is running in by looking for the repository it
 * would have to be part of. Walking up from the real path (not the symlink a
 * global install leaves behind) is what makes `pnpm link --global` still resolve
 * to dev mode.
 *
 * @param {string} from an absolute path inside the installed package
 * @returns {{ mode: 'dev', repoRoot: string, harness: string } | { mode: 'installed' }}
 */
export function detectMode(from) {
  let directory = from
  for (;;) {
    const harness = join(directory, HARNESS_RELATIVE)
    if (existsSync(join(harness, HARNESS_CLI)) && existsSync(join(directory, 'node_modules/tsx'))) {
      return { mode: 'dev', repoRoot: directory, harness }
    }
    const parent = dirname(directory)
    if (parent === directory) return { mode: 'installed' }
    directory = parent
  }
}

/**
 * Locate an installed upstream CLI: an explicit `DSH_CLI`, the `dsh` package
 * resolved from this one, or a `dsh` on `PATH`.
 *
 * @param {{ processEnv: NodeJS.ProcessEnv, resolveFrom: string }} options
 * @returns {{ command: string, prefix: string[] }}
 */
export function resolveDshCli(options) {
  const explicit = options.processEnv['DSH_CLI']?.trim()
  if (explicit !== undefined && explicit !== '') {
    if (!existsSync(explicit)) throw new Error(`DSH_CLI points at ${explicit}, which does not exist`)
    return { command: process.execPath, prefix: [explicit] }
  }
  try {
    const require = createRequire(options.resolveFrom)
    const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
    const manifest = /** @type {{ bin?: string | Record<string, string> }} */ (
      JSON.parse(readFileSync(manifestPath, 'utf8'))
    )
    const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['dsh']
    if (entry !== undefined) {
      const binPath = join(dirname(manifestPath), entry)
      if (existsSync(binPath)) return { command: process.execPath, prefix: [binPath] }
    }
  } catch {
    // Not installed beside us; fall through to PATH.
  }
  const onPath = findOnPath('dsh', options.processEnv)
  if (onPath !== undefined) return { command: onPath, prefix: [] }
  throw new Error([
    'cannot find the dsh CLI this profile runs on.',
    'Install it (npm i -g @deepseek-ai/dsh), or point DSH_CLI at its entry file.',
  ].join(' '))
}

/**
 * @param {string} name
 * @param {NodeJS.ProcessEnv} processEnv
 * @returns {string | undefined}
 */
function findOnPath(name, processEnv) {
  const extensions = process.platform === 'win32' ? ['.cmd', '.exe', '.ps1', ''] : ['']
  for (const directory of (processEnv['PATH'] ?? '').split(delimiter)) {
    if (directory === '') continue
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Create the profile the upstream Loader boots: a manifest naming the base and
 * TUI bundles, and a link to this package so the bundle name resolves. An
 * existing user patch is never overwritten.
 *
 * @param {{ home: string, tuiPackage: string }} options
 * @returns {string} the profile directory
 */
export function prepareProfile(options) {
  const profile = join(options.home, 'profiles', PROFILE_NAME)
  const link = join(profile, 'node_modules/@deepseek-ai/dsh-tui')
  mkdirSync(dirname(link), { recursive: true })
  try {
    symlinkSync(options.tuiPackage, link, LINK_TYPE)
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error
  }
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-tui',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui'] } },
  }, null, 2) + '\n')
  const userPatch = join(profile, 'cordis.patch.yml')
  if (!existsSync(userPatch)) writeFileSync(userPatch, '[]\n')
  return profile
}

/**
 * Build the child process invocation for a mode.
 *
 * Both modes run in the directory the user typed the command in, because that
 * directory is the workspace the agent will read and edit. Nothing about the
 * dev form may therefore depend on the working directory: the loader and the
 * entry are absolute, and `TSX_TSCONFIG_PATH` names the checkout's tsconfig
 * explicitly — tsx would otherwise look for the nearest one to the cwd and fail
 * to map the harness's workspace imports onto their sources.
 *
 * On Windows the located CLI may be the `dsh.cmd` shim npm writes. Node refuses
 * to execute a batch file directly (it has since the 2024 argument-injection
 * fix), so those need `shell: true` — which in turn is why the flag is part of
 * the invocation rather than something the caller guesses.
 *
 * @param {{ mode: 'dev', loader: string, entry: string, tsconfig: string, cwd: string } | { mode: 'installed', cli: { command: string, prefix: string[] }, cwd: string }} target
 * @param {readonly string[]} rest the user's arguments, forwarded verbatim
 * @returns {{ command: string, args: string[], cwd: string, env: Record<string, string>, shell: boolean }}
 */
export function resolveSpawn(target, rest) {
  if (target.mode === 'dev') {
    return {
      command: process.execPath,
      args: [
        '--import', target.loader, '--conditions=development', target.entry,
        '--profile', PROFILE_NAME, ...rest,
      ],
      cwd: target.cwd,
      env: { TSX_TSCONFIG_PATH: target.tsconfig },
      shell: false,
    }
  }
  const batch = /\.(cmd|bat)$/i.test(target.cli.command)
  return {
    command: batch ? `"${target.cli.command}"` : target.cli.command,
    args: [...target.cli.prefix, '--profile', PROFILE_NAME, ...rest],
    cwd: target.cwd,
    env: {},
    shell: batch,
  }
}

/**
 * Resolve `tsx/esm` to an absolute URL. `--import tsx/esm` would be resolved
 * against the working directory, which is the user's project rather than this
 * checkout.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function resolveLoader(repoRoot) {
  const require = createRequire(join(repoRoot, 'package.json'))
  return pathToFileURL(require.resolve('tsx/esm')).href
}

/**
 * Read `.env` from every place that has one, earlier directories winning per
 * key. Layering rather than first-file-wins is what lets a user-level key live
 * in `$DSH_HOME/.env` while a checkout still overrides the endpoint it is meant
 * to talk to; with first-file-wins, a project `.env` carrying only a base URL
 * would hide the only key on the machine.
 *
 * @param {readonly string[]} directories highest priority first
 * @returns {{ values: Record<string, string>, path?: string, paths: string[] }}
 * `path` is the highest-priority file that existed, `paths` all of them.
 */
export function loadEnvFile(directories) {
  /** @type {Record<string, string>} */
  const values = {}
  /** @type {string[]} */
  const paths = []
  const seen = new Set()
  for (const directory of directories) {
    const path = join(directory, '.env')
    if (seen.has(path)) continue
    seen.add(path)
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    paths.push(path)
    for (const [key, value] of Object.entries(parseEnvFile(text))) {
      values[key] ??= value
    }
  }
  return { values, ...paths[0] === undefined ? {} : { path: paths[0] }, paths }
}

/**
 * The directories a run looks for a `.env` in, highest priority first: the
 * directory the command was typed in and each of its ancestors, then the
 * repository root in dev mode, then the harness home.
 *
 * The ancestor walk is why running the command in a subdirectory of a project
 * behaves the same as running it at the project root — the cwd is the workspace
 * the agent edits, not necessarily where the project keeps its credentials. The
 * harness home is last because it is the machine-wide default a project should
 * always be able to override.
 *
 * @param {{ cwd: string, home: string, repoRoot?: string }} options
 * @returns {string[]}
 */
export function envSearchPath(options) {
  const directories = []
  let directory = resolve(options.cwd)
  const root = parsePath(directory).root
  for (;;) {
    directories.push(directory)
    if (directory === root) break
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  if (options.repoRoot !== undefined) directories.push(options.repoRoot)
  directories.push(options.home)
  return directories
}

/** @param {string} version */
function majorOf(version) {
  return Number(version.replace(/^v/, '').split('.')[0] ?? 0)
}

/**
 * Whether a runtime satisfies the `engines` both manifests declare. Worth
 * checking here rather than letting the child fail: an offline bundle can land
 * on a machine with whatever Node it happens to have, and the syntax error that
 * an old runtime produces says nothing about the real problem.
 *
 * @param {string} version e.g. `v22.19.0`
 * @returns {boolean}
 */
export function supportedRuntime(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number)
  if (major === undefined || Number.isNaN(major)) return true
  if (major === 22) return (minor ?? 0) >= 19
  return major >= 23
}

/**
 * @param {readonly string[]} argv
 * @returns {Promise<number>} the exit code this process should carry
 */
export async function main(argv) {
  const packageRoot = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '..')
  const detected = detectMode(packageRoot)
  if (argv[0] === '--version' || argv[0] === '-v') {
    const manifest = /** @type {{ version?: string }} */ (
      JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    )
    process.stdout.write(`dshcodecli ${manifest.version ?? '0.0.0'} (${detected.mode} mode)\n`)
    return 0
  }
  if (!supportedRuntime(process.version)) {
    process.stderr.write(
      `dshcodecli: needs Node ^22.19.0 or >=24, but this is ${process.version}\n`,
    )
    return 1
  }
  const cwd = canonicalWorkspace(process.cwd())
  const home = resolve(process.env['DSH_HOME']?.trim() || join(homedir(), '.dsh'))
  const informational = argv.includes('--help') || argv.includes('-h')
  const trustStore = join(home, 'tui', 'trusted-workspaces.json')
  if (!informational && process.stdin.isTTY && process.stdout.isTTY
    && workspaceNeedsTrust(cwd, trustStore)) {
    const decision = await promptWorkspaceTrust(cwd)
    if (decision !== 'accepted') return decision === 'cancelled' ? 130 : 1
    // Trusting the home directory is deliberately session-only: persisting it
    // would implicitly trust every project and credential beneath it.
    if (!isHomeWorkspace(cwd)) trustWorkspace(trustStore, cwd)
  }
  prepareProfile({ home, tuiPackage: packageRoot })

  const searched = envSearchPath({
    cwd,
    home,
    ...detected.mode === 'dev' ? { repoRoot: detected.repoRoot } : {},
  })
  const envFile = loadEnvFile(searched)
  const { env, notices } = credentialEnv(envFile.values, process.env, majorOf(process.version), {
    stored: existsSync(join(home, '.credentials.yaml')),
    homeEnvPath: join(home, '.env'),
  })
  for (const notice of notices) process.stderr.write(`dshcodecli: ${notice}\n`)

  // Naming a CLI explicitly overrides the mode: if the user says which `dsh` to
  // run, running a different one from source would ignore them.
  const forced = (process.env['DSH_CLI']?.trim() ?? '') !== ''
  const spawnTarget = detected.mode === 'dev' && !forced
    ? /** @type {const} */ ({
      mode: 'dev',
      loader: resolveLoader(detected.repoRoot),
      entry: join(detected.harness, HARNESS_CLI),
      tsconfig: join(detected.harness, 'tsconfig.json'),
      cwd,
    })
    : /** @type {const} */ ({
      mode: 'installed',
      cli: resolveDshCli({ processEnv: process.env, resolveFrom: join(packageRoot, 'package.json') }),
      cwd,
    })
  const invocation = resolveSpawn(spawnTarget, argv)
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    stdio: 'inherit',
    shell: invocation.shell,
    env: {
      ...process.env,
      ...invocation.env,
      ...env,
      DSH_HOME: home,
      // The profile prints its own usage; tell it which command the user typed
      // so `--help` names something they can actually run.
      DSH_TUI_PROGRAM: 'dshcodecli',
    },
  })
  if (result.error !== undefined) throw result.error
  // A cancelled run is reported as a signal, which has no exit status; the
  // profile's own contract calls that 130.
  if (result.signal === 'SIGINT' || result.signal === 'SIGTERM') return 130
  return result.status ?? 1
}
