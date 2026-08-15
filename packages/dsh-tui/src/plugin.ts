import { createInkView } from './app.tsx'
import { ApprovalQueue } from './approval-queue.ts'
import { QuestionQueue } from './question-queue.ts'
import { AgentInputRouter } from './input-router.ts'
import type { AgentController } from './agent-controller.ts'
import type { TuiActions, TuiView } from './contracts.ts'
import { executeHarnessTask, type HarnessContext } from './harness-adapter.ts'
import { TuiStore } from './state.ts'

export const name = 'tui-runner'
export const inject = [
  'agentDefaultModel', 'agents', 'sessions', 'sessionProjections',
  'tools', 'commands', 'approval', 'userQuestions',
]

export interface Config {
  task: string
  alternateScreen?: boolean
  interactive?: boolean
  color?: boolean
  maxEvents?: number
}

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
  const questions = new QuestionQueue(store)
  const screen = new AlternateScreen(internals.stdout, config.alternateScreen ?? false)
  let cancel = (): void => {}
  let cancelRequested = false
  let finishInteractive = (): void => {}
  let activeController: AgentController | undefined
  let submissions = Promise.resolve()
  let view: TuiView | undefined
  let exitCode = 1
  const actions: TuiActions = {
    cancel: () => {
      cancelRequested = true
      cancel()
      finishInteractive()
    },
    decideApproval: allowed => { approvals.decide(allowed) },
    answerQuestion: answer => { questions.answer(answer) },
    submit: text => {
      const controller = activeController
      if (controller === undefined) return store.setError('session is not ready for input')
      submissions = submissions.then(async () => {
        store.setError(undefined)
        store.setNotice(undefined)
        if (text.trim() === '/quit') return finishInteractive()
        if (text.trim() === '/help') {
          const names = store.snapshot().commands.map(command => `/${command.name}`).join(', ')
          return store.setNotice(`Commands: ${names}`)
        }
        const result = await new AgentInputRouter(controller).submit(text)
        if (result.kind === 'unknown-command') return store.setError(result.text)
        if (result.kind === 'command' && result.execution.result.kind === 'error') {
          return store.setError(result.execution.result.text)
        }
        if (result.kind === 'message') await controller.whenIdle()
        if (!await controller.flush()) throw new Error('session input was not persisted')
      }).catch((error: unknown) => {
        store.setError(error instanceof Error ? error.message : String(error))
      })
    },
  }
  try {
    screen.enter()
    view = internals.createView(
      store, actions, internals.stdin, internals.stdout, internals.stderr, config.color ?? true,
    )
    exitCode = await executeHarnessTask(ctx, config.task, {
      event: event => store.append(event),
      rebuild: events => store.rebuild(events),
      projection: snapshot => { store.setRegisteredProjections(snapshot) },
      status: status => { store.setStatus(status) },
      approval: (input, signal) => approvals.ask(input, signal),
      question: (items, signal) => questions.ask(items, signal),
      ready: action => {
        cancel = action
        if (cancelRequested) cancel()
      },
    }, config.interactive === true ? async controller => {
      activeController = controller
      store.setCommands([
        { name: 'help', description: 'List available commands' },
        { name: 'quit', description: 'Flush and exit this TUI session' },
        ...controller.listCommands().filter(command => command.name !== 'help' && command.name !== 'quit'),
      ])
      store.setInteractive(true)
      await new Promise<void>(resolve => {
        finishInteractive = resolve
        if (cancelRequested) resolve()
      })
      await submissions
      store.setInteractive(false)
      store.setCommands([])
      activeController = undefined
    } : undefined)
    if (cancelRequested) exitCode = 130
  } finally {
    approvals.close()
    questions.close()
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
