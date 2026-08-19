/**
 * Gate for the `dshcodecli` command itself.
 *
 * `check:profile` already proves the profile boots when the upstream CLI is
 * invoked by hand; this proves the launcher in front of it — that it finds the
 * checkout, writes the profile, names itself in `--help`, forwards arguments
 * unchanged, and hands the child's exit code back.
 *
 * The installed-mode case cannot use a real published `dsh`, so it points
 * `DSH_CLI` at a stub that records the argv it was handed. That is the whole
 * contract of that path: which binary is started, with which arguments, in
 * which directory.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { TUI_OPTIONS } from '../packages/dsh-tui/src/startup.ts'

const root = resolve(import.meta.dirname, '..')
const cli = join(root, 'packages/dsh-tui/bin/dshcodecli.mjs')

interface Run { status: number | null; stdout: string; stderr: string }

function run(args: string[], options: { env?: Record<string, string>; cwd?: string } = {}): Run {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tui-cli-smoke-'))
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd ?? root,
    env: { ...process.env, DSH_HOME: home, ...options.env },
    encoding: 'utf8',
  })
  if (result.error !== undefined) throw result.error
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function fail(what: string, result: Run): never {
  throw new Error(`${what} (${String(result.status)}): ${result.stdout}${result.stderr}`)
}

// 1. --help names the command the user typed, and still lists every option.
const help = run(['--help'])
if (help.status !== 0 || !help.stdout.includes('Usage: dshcodecli')) {
  fail('dshcodecli --help did not identify itself', help)
}
for (const option of TUI_OPTIONS) {
  if (!help.stdout.includes(option)) fail(`dshcodecli --help omits ${option}`, help)
}
if (!help.stdout.includes('-i, --interactive')) fail('dshcodecli --help omits the -i alias', help)

// 2. A one-shot run without a TTY is refused, pointing at the headless profile.
const nonTty = run(['smoke-task'])
if (nonTty.status !== 1 || !nonTty.stderr.includes('--profile headless')) {
  fail('dshcodecli did not refuse a non-TTY run', nonTty)
}

// 3. An invalid preset fails before anything touches the terminal.
const badPreset = run(['--permission', 'nope', 'smoke-task'])
if (badPreset.status === 0 || !badPreset.stderr.includes('nope')) {
  fail('dshcodecli accepted an unknown permission preset', badPreset)
}

// 4. Installed mode: the launcher starts the CLI it was pointed at, with the
//    profile selected and the user's own arguments after it.
const stubHome = mkdtempSync(join(tmpdir(), 'dsh-tui-cli-stub-'))
const stub = join(stubHome, 'fake-dsh.mjs')
const argvLog = join(stubHome, 'argv.json')
writeFileSync(stub, [
  "import { writeFileSync } from 'node:fs'",
  `writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify({`,
  '  args: process.argv.slice(2), cwd: process.cwd(),',
  "  program: process.env.DSH_TUI_PROGRAM ?? '', home: process.env.DSH_HOME ?? '',",
  '}))',
  'process.exit(17)',
].join('\n'))

const workspace = mkdtempSync(join(tmpdir(), 'dsh-tui-cli-work-'))
const installedHome = mkdtempSync(join(tmpdir(), 'dsh-tui-cli-home-'))
const installed = spawnSync(process.execPath, [cli, '--help'], {
  cwd: workspace,
  // Naming DSH_CLI selects the installed path even inside the checkout, which
  // is what lets this run exercise resolveDshCli and the spawn wiring without a
  // published package.
  env: { ...process.env, DSH_HOME: installedHome, DSH_CLI: stub },
  encoding: 'utf8',
})
if (installed.error !== undefined) throw installed.error
if (!existsSync(argvLog)) {
  throw new Error(`installed mode never reached DSH_CLI: ${installed.stdout}${installed.stderr}`)
}
const recorded = JSON.parse(readFileSync(argvLog, 'utf8')) as {
  args: string[]; cwd: string; program: string; home: string
}
if (recorded.args.join(' ') !== '--profile tui --help') {
  throw new Error(`installed mode passed the wrong argv: ${recorded.args.join(' ')}`)
}
if (recorded.cwd !== resolve(workspace)) {
  throw new Error(`installed mode ran in ${recorded.cwd}, not the user's directory`)
}
if (recorded.program !== 'dshcodecli') {
  throw new Error(`installed mode did not announce the program name: ${recorded.program}`)
}
if (installed.status !== 17) {
  throw new Error(`installed mode dropped the child exit code: ${String(installed.status)}`)
}
if (!existsSync(join(installedHome, 'profiles/tui/package.json'))) {
  throw new Error('installed mode did not write the profile manifest')
}

process.stdout.write('dshcodecli smoke accepted (help + non-TTY + bad preset + installed wiring)\n')
