/**
 * Publish the `dshcodecli` tarball to npm.
 *
 * `package-npm.ts` deliberately stops at the tarball: building and publishing
 * are different acts, and the build runs in places (CI, a dry checkout) that
 * must never push a name to a public registry. This script is the other half,
 * and it is the *only* thing in the repository that publishes.
 *
 * Everything that can go wrong with a publish goes wrong before the upload, so
 * that is where the checks are:
 *
 * 1. **The registry.** A machine configured against a mirror
 *    (`registry.npmmirror.com` and friends) cannot publish — the mirror is a
 *    read-only cache, and `npm publish` against one fails late with a confusing
 *    error. The publish registry is therefore passed explicitly on every npm
 *    call rather than inherited from the user's config.
 * 2. **Authentication**, checked with `npm whoami` against that same registry,
 *    because being logged into a mirror is not being logged into npm.
 * 3. **The version.** npm refuses to replace a published version, and unpublishing
 *    is only possible for 72 hours. Publishing `x` when `x` is already up is the
 *    single most common failure, so it is caught here with a message that says
 *    which versions exist and what to bump to.
 * 4. **The working tree**, unless `--allow-dirty`: a tarball built from
 *    uncommitted changes cannot be reproduced from the tag it claims to be.
 *
 * Only then does it publish — and only with `--yes`. Without it the script runs
 * `npm publish --dry-run`, which does everything except upload, so the default
 * invocation is safe to run to see exactly what would happen.
 *
 * Usage:
 *   node --import tsx/esm scripts/publish-npm.ts              # dry run
 *   node --import tsx/esm scripts/publish-npm.ts --yes        # actually publish
 *   node --import tsx/esm scripts/publish-npm.ts --yes --tag next
 *   node --import tsx/esm scripts/publish-npm.ts --yes --otp 123456
 *   node --import tsx/esm scripts/publish-npm.ts --tarball dist/dshcodecli-0.1.2.tgz
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

/** The published name; `@deepseek-ai/dsh-tui` stays the bundle identity. */
const DEFAULT_NAME = 'dshcodecli'
/** The real registry. Never the user's configured one — that may be a mirror. */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
/** Registry hosts that serve reads but reject writes, named so the error can be specific. */
const READ_ONLY_HOSTS = ['npmmirror.com', 'taobao.org', 'cnpmjs.org', 'yarnpkg.com']

const root = resolve(import.meta.dirname, '..')
const packageDir = join(root, 'packages/dsh-tui')

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    tag: { type: 'string', default: 'latest' },
    registry: { type: 'string' },
    otp: { type: 'string' },
    tarball: { type: 'string' },
    yes: { type: 'boolean', default: false },
    'skip-build': { type: 'boolean', default: false },
    'no-verify': { type: 'boolean', default: false },
    'allow-dirty': { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

const publishName = values.name ?? DEFAULT_NAME
const registry = values.registry ?? DEFAULT_REGISTRY
const tag = values.tag ?? 'latest'
const live = values.yes === true

function step(message: string): void {
  process.stdout.write(`\n▶ ${message}\n`)
}

function note(message: string): void {
  process.stdout.write(`  ${message}\n`)
}

/** Fail with a message that says what to do, not just what broke. */
function fail(headline: string, ...remedy: string[]): never {
  process.stderr.write(`\n✗ ${headline}\n`)
  for (const line of remedy) process.stderr.write(`  ${line}\n`)
  process.exit(1)
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${String(result.status)})`)
}

function capture(command: string, args: string[]): { status: number | null, stdout: string, stderr: string } {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' })
  if (result.error !== undefined) throw result.error
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

// ---------------------------------------------------------------------------
// 0. What is being published.
// ---------------------------------------------------------------------------
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version: string }
const version = manifest.version
step(`publishing ${publishName}@${version} to ${registry} under tag "${tag}"`)
if (!live) note('DRY RUN — pass --yes to actually upload')

// ---------------------------------------------------------------------------
// 1. The registry has to be one that accepts writes.
// ---------------------------------------------------------------------------
const readOnly = READ_ONLY_HOSTS.find(host => registry.includes(host))
if (readOnly !== undefined) {
  fail(`${registry} is a read-only mirror (${readOnly}); it serves installs but rejects publishes.`,
    `Publish against ${DEFAULT_REGISTRY} instead:`,
    `  npm run publish:npm -- --yes --registry ${DEFAULT_REGISTRY}`)
}
const configured = capture('npm', ['config', 'get', 'registry']).stdout
if (configured !== '' && !registry.startsWith(configured.replace(/\/$/, ''))) {
  note(`your npm config registry is ${configured}; this publish uses ${registry} explicitly`)
}

// ---------------------------------------------------------------------------
// 2. The version must be free. npm never lets a published version be replaced.
//
// This runs before the login check because reading the registry needs no
// credentials, and a taken version is the more actionable failure: it is fixed
// with a version bump rather than by going and finding an npm password.
// ---------------------------------------------------------------------------
step('checking the version is free')
const existing = capture('npm', ['view', publishName, 'versions', '--json', '--registry', registry])
// A missing package is not an error here — the first publish creates the name —
// and npm prints a bare string rather than an array when only one version exists.
const parsed: unknown = existing.status === 0 && existing.stdout !== ''
  ? JSON.parse(existing.stdout)
  : []
const published: string[] = Array.isArray(parsed) ? parsed as string[] : [String(parsed)]
if (published.includes(version)) {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number)
  fail(`${publishName}@${version} is already published and npm will not replace it.`,
    `Published: ${published.join(', ')}`,
    'Bump the version first, then re-run:',
    `  npm --prefix packages/dsh-tui version ${major}.${minor}.${patch + 1} --no-git-tag-version`)
}
note(published.length === 0
  ? `${publishName} has no published versions yet — this is the first`
  : `latest published is ${published.at(-1) ?? '(none)'}; ${version} is free`)

// ---------------------------------------------------------------------------
// 3. Authentication, against the publish registry rather than the configured one.
// ---------------------------------------------------------------------------
step('checking authentication')
const who = capture('npm', ['whoami', '--registry', registry])
if (who.status !== 0) {
  fail(`not logged in to ${registry}.`,
    'Log in first — it is interactive, so it cannot happen inside this script:',
    `  npm login --registry ${registry}`,
    'In CI, set an automation token instead:',
    `  npm config set //${registry.replace(/^https?:\/\//, '')}/:_authToken \${NPM_TOKEN}`)
}
note(`logged in as ${who.stdout}`)

// ---------------------------------------------------------------------------
// 4. A tarball must be reproducible from what is committed.
// ---------------------------------------------------------------------------
if (values['allow-dirty'] !== true) {
  const status = capture('git', ['status', '--porcelain'])
  if (status.status === 0 && status.stdout !== '') {
    const lines = status.stdout.split('\n')
    fail('the working tree has uncommitted changes, so the tarball could not be rebuilt from history.',
      ...lines.slice(0, 10).map(line => `  ${line}`),
      ...lines.length > 10 ? [`  … and ${lines.length - 10} more`] : [],
      'Commit them, or pass --allow-dirty if you mean to publish this exact tree.')
  }
}

// ---------------------------------------------------------------------------
// 5. Build the tarball (the same script the release gate uses), unless given one.
// ---------------------------------------------------------------------------
let tarballPath: string
if (values.tarball !== undefined) {
  tarballPath = resolve(root, values.tarball)
  if (!existsSync(tarballPath)) fail(`no tarball at ${tarballPath}`)
} else if (values['skip-build'] === true) {
  const out = join(root, 'dist')
  const found = readdirSync(out)
    .filter(entry => entry.startsWith(`${publishName.replace(/^@/, '').replace('/', '-')}-`) && entry.endsWith('.tgz'))
    .sort()
    .at(-1)
  if (found === undefined) fail(`--skip-build was given but ${relative(root, out)} has no ${publishName} tarball`)
  tarballPath = join(out, found)
} else {
  step('building the tarball')
  run('node', [
    '--import', 'tsx/esm', 'scripts/package-npm.ts',
    '--name', publishName,
    ...values['no-verify'] === true ? ['--no-verify'] : [],
  ], root)
  const out = join(root, 'dist')
  const built = readdirSync(out)
    .filter(entry => entry.startsWith(`${publishName.replace(/^@/, '').replace('/', '-')}-`) && entry.endsWith('.tgz'))
    .sort()
    .at(-1)
  if (built === undefined) throw new Error('package-npm.ts produced no tarball')
  tarballPath = join(out, built)
}

// The tarball has to be the version this run checked against the registry; a
// stale one from `dist/` would otherwise sail past every check above.
if (!tarballPath.includes(version)) {
  fail(`${relative(root, tarballPath)} is not version ${version}.`,
    'Rebuild it (drop --skip-build/--tarball), or point --tarball at the right file.')
}
note(`tarball  ${relative(root, tarballPath)} (${(statSync(tarballPath).size / 1024).toFixed(0)} KiB)`)
note(`sha256   ${createHash('sha256').update(readFileSync(tarballPath)).digest('hex')}`)

// ---------------------------------------------------------------------------
// 6. Publish.
// ---------------------------------------------------------------------------
step(live ? 'publishing' : 'dry run (nothing is uploaded)')
run('npm', [
  'publish', tarballPath,
  '--access', 'public',
  '--tag', tag,
  '--registry', registry,
  ...values.otp === undefined ? [] : ['--otp', values.otp],
  ...live ? [] : ['--dry-run'],
], root)

if (!live) {
  process.stdout.write(`\n▶ dry run complete — nothing was uploaded\n`)
  process.stdout.write('  Re-run with --yes to publish:\n')
  process.stdout.write(`    npm run publish:npm -- --yes${tag === 'latest' ? '' : ` --tag ${tag}`}\n`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 7. Confirm the registry actually has it, rather than trusting the exit code.
// ---------------------------------------------------------------------------
step('verifying the registry has it')
// A publish is not readable the instant it is accepted — npm's CDN takes a few
// seconds to serve the new version. Failing on the first miss would report a
// successful publish as a failure, so this polls before giving up, and even then
// says the upload probably worked rather than implying it did not.
const DEADLINE_MS = 60_000
const started = Date.now()
let confirmed = capture('npm', ['view', `${publishName}@${version}`, 'version', '--registry', registry])
while ((confirmed.status !== 0 || confirmed.stdout !== version) && Date.now() - started < DEADLINE_MS) {
  note('not readable yet; waiting for the registry to propagate…')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000)
  confirmed = capture('npm', ['view', `${publishName}@${version}`, 'version', '--registry', registry])
}
if (confirmed.status !== 0 || confirmed.stdout !== version) {
  fail(`npm publish was accepted but ${publishName}@${version} is still not readable after`
    + ` ${Math.round((Date.now() - started) / 1000)}s.`,
    'The upload most likely succeeded and is only slow to propagate — do not re-run',
    'this script until you have checked, or you will hit the already-published guard:',
    `  npm view ${publishName} versions --registry ${registry}`)
}

step('done')
note(`${publishName}@${version} is live under tag "${tag}"`)
note(`install  npm i -g ${publishName}@${version}`)
note(`tags     ${capture('npm', ['view', publishName, 'dist-tags', '--registry', registry]).stdout.replace(/\s+/g, ' ')}`)
