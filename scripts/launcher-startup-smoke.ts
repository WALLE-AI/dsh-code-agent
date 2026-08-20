import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const cli = join(root, 'packages/dsh-tui/bin/dshcodecli.mjs')
const ptyModule = await import('node-pty') as {
  spawn(file: string, args: string[], options: Record<string, unknown>): {
    onData(callback: (data: string) => void): { dispose(): void }
    onExit(callback: (event: { exitCode: number }) => void): { dispose(): void }
    write(data: string): void
    kill(): void
  }
}

const fixture = mkdtempSync(join(tmpdir(), 'dsh-launcher-startup-'))
const home = join(fixture, 'home')
const acceptedWorkspace = join(fixture, 'accepted')
const rejectedWorkspace = join(fixture, 'rejected')
const stub = join(fixture, 'fake-dsh.mjs')
writeFileSync(stub, [
  "import { writeFileSync } from 'node:fs'",
  "writeFileSync(process.env.ARGV_LOG, JSON.stringify(process.argv.slice(2)))",
  "process.stdout.write('FAKE_HARNESS_STARTED\\n')",
  'process.exit(17)',
].join('\n'))
mkdirSync(acceptedWorkspace, { recursive: true })
mkdirSync(rejectedWorkspace, { recursive: true })

interface Scenario {
  readonly name: string
  readonly workspace: string
  readonly input?: string
  readonly expectedExit: number
  readonly expectPrompt: boolean
  readonly expectChild: boolean
}

async function runScenario(scenario: Scenario): Promise<string> {
  const argvLog = join(fixture, `${scenario.name}.json`)
  return await new Promise((resolvePromise, rejectPromise) => {
    const terminal = ptyModule.spawn(process.execPath, [cli], {
      cwd: scenario.workspace,
      cols: 50,
      rows: 16,
      env: { ...process.env, DSH_HOME: home, DSH_CLI: stub, ARGV_LOG: argvLog },
    })
    let transcript = ''
    let answered = false
    const timeout = setTimeout(() => {
      terminal.kill()
      rejectPromise(new Error(`${scenario.name} timed out\n${transcript}`))
    }, 15_000)
    terminal.onData(data => {
      transcript += data
      if (!answered && transcript.includes('Yes, use this folder') && scenario.input !== undefined) {
        if (existsSync(argvLog)) {
          clearTimeout(timeout)
          terminal.kill()
          rejectPromise(new Error(`${scenario.name} started Harness before workspace confirmation`))
          return
        }
        answered = true
        terminal.write(scenario.input)
      }
    })
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout)
      try {
        if (exitCode !== scenario.expectedExit) {
          throw new Error(`${scenario.name} exited ${String(exitCode)}, expected ${String(scenario.expectedExit)}\n${transcript}`)
        }
        if (transcript.includes('Yes, use this folder') !== scenario.expectPrompt) {
          throw new Error(`${scenario.name} prompt visibility was wrong\n${transcript}`)
        }
        if (existsSync(argvLog) !== scenario.expectChild) {
          throw new Error(`${scenario.name} child visibility was wrong\n${transcript}`)
        }
        if (scenario.expectChild) {
          const args = JSON.parse(readFileSync(argvLog, 'utf8')) as string[]
          if (args.join(' ') !== '--profile tui') {
            throw new Error(`${scenario.name} injected a task into empty startup: ${args.join(' ')}`)
          }
        }
        resolvePromise(transcript)
      } catch (error) {
        rejectPromise(error)
      }
    })
  })
}

await runScenario({
  name: 'accept', workspace: acceptedWorkspace, input: '\r', expectedExit: 17,
  expectPrompt: true, expectChild: true,
})
await runScenario({
  name: 'fast-path', workspace: acceptedWorkspace, expectedExit: 17,
  expectPrompt: false, expectChild: true,
})
await runScenario({
  name: 'reject', workspace: rejectedWorkspace, input: '\x1b[B\r', expectedExit: 1,
  expectPrompt: true, expectChild: false,
})

process.stdout.write('dshcodecli workspace trust and empty interactive startup accepted\n')
