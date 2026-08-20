import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  credentialEnv,
  detectMode,
  envSearchPath,
  loadEnvFile,
  parseEnvFile,
  prepareProfile,
  resolveDshCli,
  resolveLoader,
  resolveSpawn,
  supportedRuntime,
} from '../bin/launch.mjs'
import {
  canonicalWorkspace,
  readTrustedWorkspaces,
  reduceWorkspaceTrust,
  renderWorkspaceTrust,
  trustWorkspace,
  workspaceNeedsTrust,
} from '../bin/workspace-trust.mjs'

const HARNESS = 'opensource/deepseek-harness/deepseek-harness-master'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'dshcodecli-'))
}

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

describe('workspace trust preflight', () => {
  it('persists canonical paths and fails closed on a damaged store', () => {
    const root = scratch()
    const store = join(root, 'tui/trusted-workspaces.json')
    const workspace = canonicalWorkspace(root)
    expect(workspaceNeedsTrust(workspace, store)).toBe(true)
    trustWorkspace(store, workspace)
    expect(workspaceNeedsTrust(workspace, store)).toBe(false)
    expect([...readTrustedWorkspaces(store)]).toEqual([workspace])
    writeFileSync(store, '{damaged')
    expect(workspaceNeedsTrust(workspace, store)).toBe(true)
  })

  it('models navigation, confirmation, rejection, and cancellation', () => {
    expect(reduceWorkspaceTrust(0, Buffer.from('\x1b[B'))).toEqual({ selected: 1 })
    expect(reduceWorkspaceTrust(1, Buffer.from('\x1b[A'))).toEqual({ selected: 0 })
    expect(reduceWorkspaceTrust(0, Buffer.from('\r'))).toEqual({ selected: 0, result: 'accepted' })
    expect(reduceWorkspaceTrust(1, Buffer.from('\r'))).toEqual({ selected: 1, result: 'rejected' })
    expect(reduceWorkspaceTrust(0, Buffer.from('\x03'))).toEqual({ selected: 0, result: 'cancelled' })
  })

  it('bounds every prompt row to a narrow terminal', () => {
    const frame = renderWorkspaceTrust('/a/very/long/workspace/path/that/must/wrap', 0, 24)
    expect(frame.split('\n').every(row => row.length <= 24)).toBe(true)
    expect(frame).toContain('> Yes, use this folder')
  })
})

describe('parseEnvFile', () => {
  it('reads KEY=value, keeping everything after the first equals sign', () => {
    const values = parseEnvFile([
      '# a comment',
      '',
      'DEEPSEEK_API=sk-abc',
      '  DEEPSEEK_URL=https://example.test/v1?a=1&b=2  ',
    ].join('\n'))
    expect(values).toEqual({
      DEEPSEEK_API: 'sk-abc',
      DEEPSEEK_URL: 'https://example.test/v1?a=1&b=2',
    })
  })

  it('ignores lines that are not assignments to a valid name', () => {
    expect(parseEnvFile('just words\n=novalue\nexport A=1\nB=2')).toEqual({ B: '2' })
  })

  it('finds .env in the first directory that has one', () => {
    const first = scratch()
    const second = scratch()
    writeFileSync(join(second, '.env'), 'DEEPSEEK_API=from-second\n')
    expect(loadEnvFile([first, second]).values).toEqual({ DEEPSEEK_API: 'from-second' })
    expect(loadEnvFile([first]).values).toEqual({})
  })

  it('layers the files it finds, the earlier directory winning per key', () => {
    const project = scratch()
    const home = scratch()
    writeFileSync(join(project, '.env'), 'DEEPSEEK_URL=https://project.test\n')
    writeFileSync(join(home, '.env'), 'DEEPSEEK_URL=https://home.test\nDEEPSEEK_API=sk-home\n')
    const loaded = loadEnvFile([project, home])
    expect(loaded.values).toEqual({ DEEPSEEK_URL: 'https://project.test', DEEPSEEK_API: 'sk-home' })
    expect(loaded.path).toBe(join(project, '.env'))
    expect(loaded.paths).toEqual([join(project, '.env'), join(home, '.env')])
  })
})

describe('envSearchPath', () => {
  it('walks the working directory up to the filesystem root before the home', () => {
    const searched = envSearchPath({ cwd: '/a/b/c', home: '/home/u/.dsh' })
    expect(searched).toEqual(['/a/b/c', '/a/b', '/a', '/', '/home/u/.dsh'])
  })

  it('keeps the dev repository root between the ancestors and the home', () => {
    expect(envSearchPath({ cwd: '/a/b', home: '/h/.dsh', repoRoot: '/repo' }))
      .toEqual(['/a/b', '/a', '/', '/repo', '/h/.dsh'])
  })

  it('finds a project .env from a subdirectory of that project', () => {
    const project = scratch()
    const nested = join(project, 'packages/thing')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(project, '.env'), 'DEEPSEEK_API=sk-project\n')
    const loaded = loadEnvFile(envSearchPath({ cwd: nested, home: scratch() }))
    expect(loaded.values['DEEPSEEK_API']).toBe('sk-project')
  })
})

describe('credentialEnv', () => {
  it('maps the legacy names and defaults the base URL', () => {
    const { env } = credentialEnv({ DEEPSEEK_API: 'sk-abc' }, {}, 24)
    expect(env['DEEPSEEK_API_KEY']).toBe('sk-abc')
    expect(env['DEEPSEEK_BASE_URL']).toBe('https://api.deepseek.com')
  })

  it('never overwrites a variable the caller already exported', () => {
    const { env } = credentialEnv(
      { DEEPSEEK_API: 'from-file', DEEPSEEK_URL: 'https://file.test' },
      { DEEPSEEK_API_KEY: 'from-shell', DEEPSEEK_BASE_URL: 'https://shell.test' },
      24,
    )
    expect(env['DEEPSEEK_API_KEY']).toBeUndefined()
    expect(env['DEEPSEEK_BASE_URL']).toBeUndefined()
  })

  it('leaves the base URL alone when there is no key to go with it', () => {
    expect(credentialEnv({}, {}, 24).env).toEqual({})
  })

  it('names a file to write when no key is reachable at all', () => {
    const { notices } = credentialEnv({}, {}, 24, { homeEnvPath: '/h/.dsh/.env' })
    expect(notices.join(' ')).toContain('/h/.dsh/.env')
  })

  it('stays quiet when a key is reachable, whatever supplies it', () => {
    expect(credentialEnv({ DEEPSEEK_API: 'sk-abc' }, {}, 24).notices).toEqual([])
    expect(credentialEnv({}, { DEEPSEEK_API_KEY: 'sk-abc' }, 24).notices).toEqual([])
    expect(credentialEnv({}, {}, 24, { stored: true }).notices).toEqual([])
  })

  it('adds --use-env-proxy only when a proxy is set and the runtime supports it', () => {
    const proxied = { HTTPS_PROXY: 'http://127.0.0.1:7890' }
    expect(credentialEnv({}, proxied, 24).env['NODE_OPTIONS']).toBe('--use-env-proxy')
    expect(credentialEnv({}, {}, 24).env['NODE_OPTIONS']).toBeUndefined()
  })

  it('explains itself instead of passing a flag Node 22 would reject', () => {
    const result = credentialEnv({}, { http_proxy: 'http://127.0.0.1:7890' }, 22)
    expect(result.env['NODE_OPTIONS']).toBeUndefined()
    expect(result.notices.join(' ')).toContain('--use-env-proxy')
  })

  it('does not add the flag twice', () => {
    const result = credentialEnv({}, {
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NODE_OPTIONS: '--use-env-proxy',
    }, 24)
    expect(result.env['NODE_OPTIONS']).toBeUndefined()
  })
})

describe('supportedRuntime', () => {
  it('accepts the runtimes engines allows and rejects the ones below it', () => {
    expect(supportedRuntime('v22.19.0')).toBe(true)
    expect(supportedRuntime('v24.18.0')).toBe(true)
    expect(supportedRuntime('v22.18.0')).toBe(false)
    expect(supportedRuntime('v20.11.0')).toBe(false)
  })
})

describe('detectMode', () => {
  it('reports dev mode from anywhere inside a checkout that can run from source', () => {
    const root = scratch()
    write(join(root, HARNESS, 'apps/cli/src/bin.ts'), '')
    mkdirSync(join(root, 'node_modules/tsx'), { recursive: true })
    const nested = join(root, 'packages/dsh-tui')
    mkdirSync(nested, { recursive: true })
    const detected = detectMode(nested)
    expect(detected.mode).toBe('dev')
    expect(detected.mode === 'dev' && detected.repoRoot).toBe(root)
  })

  it('reports installed mode when the vendored harness is absent', () => {
    expect(detectMode(scratch()).mode).toBe('installed')
  })

  it('reports installed mode when the harness is there but tsx is not', () => {
    const root = scratch()
    write(join(root, HARNESS, 'apps/cli/src/bin.ts'), '')
    expect(detectMode(root).mode).toBe('installed')
  })

  it('resolves this repository as dev mode', () => {
    expect(detectMode(join(import.meta.dirname, '..')).mode).toBe('dev')
  })
})

describe('resolveDshCli', () => {
  it('prefers an explicit DSH_CLI', () => {
    const root = scratch()
    const entry = join(root, 'my-dsh.js')
    writeFileSync(entry, '')
    const resolved = resolveDshCli({ processEnv: { DSH_CLI: entry }, resolveFrom: root })
    expect(resolved.prefix).toEqual([entry])
  })

  it('rejects a DSH_CLI that does not exist rather than failing later', () => {
    expect(() => resolveDshCli({ processEnv: { DSH_CLI: '/nope/dsh.js' }, resolveFrom: '/' }))
      .toThrow(/does not exist/)
  })

  it('resolves the dsh package installed beside this one', () => {
    const root = scratch()
    const pkg = join(root, 'node_modules/@deepseek-ai/dsh')
    write(join(pkg, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh', version: '0.0.0', bin: { dsh: 'lib/bin.js' },
    }))
    write(join(pkg, 'lib/bin.js'), '')
    writeFileSync(join(root, 'package.json'), '{}')
    const resolved = resolveDshCli({ processEnv: {}, resolveFrom: join(root, 'package.json') })
    expect(resolved.prefix).toEqual([join(pkg, 'lib/bin.js')])
  })

  it('falls back to a dsh on PATH', () => {
    const root = scratch()
    writeFileSync(join(root, 'dsh'), '')
    const resolved = resolveDshCli({ processEnv: { PATH: root }, resolveFrom: '/' })
    expect(resolved.command).toBe(join(root, 'dsh'))
    expect(resolved.prefix).toEqual([])
  })

  it('says how to fix it when nothing is installed', () => {
    expect(() => resolveDshCli({ processEnv: { PATH: scratch() }, resolveFrom: '/' }))
      .toThrow(/@deepseek-ai\/dsh|DSH_CLI/)
  })
})

describe('resolveSpawn', () => {
  const dev = {
    mode: 'dev',
    loader: 'file:///repo/tsx.mjs',
    entry: '/repo/harness/bin.ts',
    tsconfig: '/repo/harness/tsconfig.json',
  } as const

  it('starts the vendored CLI from source in dev mode', () => {
    const spawn = resolveSpawn({ ...dev, cwd: '/work' }, ['-i', 'task'])
    expect(spawn.args).toEqual([
      '--import', 'file:///repo/tsx.mjs', '--conditions=development', '/repo/harness/bin.ts',
      '--profile', 'tui', '-i', 'task',
    ])
  })

  // The workspace the agent edits is the directory the command was typed in,
  // not wherever the checkout happens to live.
  it('runs in the user directory in both modes', () => {
    expect(resolveSpawn({ ...dev, cwd: '/work' }, []).cwd).toBe('/work')
    expect(resolveSpawn(
      { mode: 'installed', cli: { command: 'dsh', prefix: [] }, cwd: '/work' }, [],
    ).cwd).toBe('/work')
  })

  it('resolves the loader to an absolute URL so the cwd cannot change it', () => {
    expect(resolveLoader(resolve(import.meta.dirname, '../../..'))).toMatch(/^file:\/\/.*tsx/)
  })

  // Without this, tsx picks the tsconfig nearest the user's directory and the
  // harness's workspace imports resolve to lib/ builds that do not exist.
  it('pins the tsx tsconfig to the checkout in dev mode', () => {
    expect(resolveSpawn({ ...dev, cwd: '/work' }, []).env['TSX_TSCONFIG_PATH'])
      .toBe('/repo/harness/tsconfig.json')
  })

  it('defers to the installed binary and keeps the user directory in installed mode', () => {
    const spawn = resolveSpawn(
      { mode: 'installed', cli: { command: '/bin/node', prefix: ['/opt/dsh.js'] }, cwd: '/work' },
      ['--resume', 'latest'],
    )
    expect(spawn.command).toBe('/bin/node')
    expect(spawn.args).toEqual(['/opt/dsh.js', '--profile', 'tui', '--resume', 'latest'])
    expect(spawn.cwd).toBe('/work')
  })

  // npm installs `dsh` on Windows as a `dsh.cmd` shim, and Node has refused to
  // execute batch files without a shell since the 2024 argument-injection fix.
  it('runs a Windows .cmd shim through a shell, and nothing else', () => {
    const shim = resolveSpawn(
      { mode: 'installed', cli: { command: 'C:\\npm\\dsh.cmd', prefix: [] }, cwd: '/work' }, [],
    )
    expect(shim.shell).toBe(true)
    expect(shim.command).toBe('"C:\\npm\\dsh.cmd"')
    expect(resolveSpawn(
      { mode: 'installed', cli: { command: '/bin/node', prefix: ['/opt/dsh.js'] }, cwd: '/work' }, [],
    ).shell).toBe(false)
    expect(resolveSpawn({ ...dev, cwd: '/work' }, []).shell).toBe(false)
  })

  it('forwards arguments verbatim, including ones it would otherwise recognise', () => {
    const spawn = resolveSpawn({ ...dev, cwd: '/work' }, ['--profile', 'other', '--', '-x'])
    expect(spawn.args.slice(-4)).toEqual(['--profile', 'other', '--', '-x'])
  })
})

describe('prepareProfile', () => {
  it('writes a manifest naming both bundles and links this package in', () => {
    const home = scratch()
    const profile = prepareProfile({ home, tuiPackage: join(import.meta.dirname, '..') })
    expect(profile).toBe(join(home, 'profiles/tui'))
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui'])
    expect(existsSync(join(profile, 'node_modules/@deepseek-ai/dsh-tui/package.json'))).toBe(true)
  })

  it('is idempotent and leaves an existing user patch alone', () => {
    const home = scratch()
    const tuiPackage = join(import.meta.dirname, '..')
    const profile = prepareProfile({ home, tuiPackage })
    writeFileSync(join(profile, 'cordis.patch.yml'), '- edited by hand\n')
    prepareProfile({ home, tuiPackage })
    expect(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).toBe('- edited by hand\n')
  })
})
