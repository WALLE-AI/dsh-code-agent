import { createInkView } from './app.tsx'
import { ApprovalQueue } from './approval-queue.ts'
import type { TuiActions, TuiView } from './contracts.ts'
import { executeHarnessTask, type HarnessContext } from './harness-adapter.ts'
import { TuiStore } from './state.ts'

export const name = 'tui-runner'
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'approval']

export interface Config { task: string; alternateScreen?: boolean; maxEvents?: number }

type TerminalInput = NodeJS.ReadStream
type TerminalOutput = NodeJS.WriteStream

export const internals: {
  stdin: TerminalInput
  stdout: TerminalOutput
  stderr: NodeJS.WriteStream
  createView: typeof createInkView
} = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, createView: createInkView }

class AlternateScreen {
  private active = false
  constructor(private readonly output: TerminalOutput, private readonly enabled: boolean) {}
  enter(): void {
    if (!this.enabled || this.active) return
    this.output.write('\u001B[?1049h')
    this.active = true
  }
  restore(): void {
    if (!this.active) return
    this.active = false
    this.output.write('\u001B[?1049l')
  }
}

async function run(ctx: HarnessContext, config: Config, exit: (code: number) => void): Promise<void> {
  if (internals.stdin.isTTY !== true || internals.stdout.isTTY !== true) {
    throw new Error('TUI requires interactive stdin and stdout; use --profile headless for redirected IO')
  }
  if (config.task.trim() === '') throw new Error('task must not be empty')
  const store = new TuiStore(config.maxEvents ?? 200)
  const approvals = new ApprovalQueue(store)
  const screen = new AlternateScreen(internals.stdout, config.alternateScreen ?? false)
  let cancel = (): void => {}
  let cancelRequested = false
  let view: TuiView | undefined
  let exitCode = 1
  const actions: TuiActions = {
    cancel: () => {
      cancelRequested = true
      cancel()
    },
    decideApproval: allowed => { approvals.decide(allowed) },
  }
  try {
    screen.enter()
    view = internals.createView(store, actions, internals.stdin, internals.stdout, internals.stderr)
    exitCode = await executeHarnessTask(ctx, config.task, {
      event: event => { store.append(event) },
      status: status => { store.setStatus(status) },
      approval: (input, signal) => approvals.ask(input, signal),
      ready: action => {
        cancel = action
        if (cancelRequested) cancel()
      },
    })
    if (cancelRequested) exitCode = 130
  } finally {
    approvals.close()
    store.setStatus('closing')
    view?.unmount()
    screen.restore()
  }
  exit(exitCode)
}

export function apply(ctx: HarnessContext, config: Config): void {
  const exit = ctx.get('appExit') as ((code: number) => void) | undefined
  if (exit === undefined) throw new Error('tui-runner requires the dsh launcher appExit service')
  void run(ctx, config, exit).catch((error: unknown) => {
    internals.stderr.write(`dsh-tui: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(1)
  })
}
