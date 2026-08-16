import { createInkView } from './app.tsx'
import { ApprovalQueue } from './approval-queue.ts'
import { QuestionQueue } from './question-queue.ts'
import { AgentInputRouter, routeUserInput } from './input-router.ts'
import type { AgentController } from './agent-controller.ts'
import type { TuiActions, TuiView } from './contracts.ts'
import {
  createDiagnosticLog, fileSink, silentDiagnosticLog, type DiagnosticLog,
} from './diagnostic-log.ts'
import { detachedSpawn, EditorLauncher } from './editor-launcher.ts'
import {
  executeHarnessTask, listHarnessSessions,
  type HarnessContext, type HarnessHooks, type HarnessRunRequest, type ModelOverride,
} from './harness-adapter.ts'
import { formatSessionRow, resolveSessionSelection, selectableSessions } from './session-selector.ts'
import { exitCodeFor, ShutdownCoordinator } from './shutdown.ts'
import { TuiStore } from './state.ts'
import { detectTerminal } from './terminal-capabilities.ts'

export const name = 'tui-runner'
export const inject = [
  'agentDefaultModel', 'agents', 'sessions', 'sessionProjections', 'sessionQuery',
  'tools', 'commands', 'approval', 'userQuestions',
]

export interface Config {
  task: string
  resume?: string
  permission?: string
  model?: ModelOverride
  diagnosticLog?: string
  alternateScreen?: boolean
  interactive?: boolean
  color?: boolean
  maxEvents?: number
  editor?: readonly string[]
  maxInlineOutputBytes?: number
  cancelGraceMs?: number
}

type TerminalInput = NodeJS.ReadStream
type TerminalOutput = NodeJS.WriteStream

export const internals: {
  stdin: TerminalInput
  stdout: TerminalOutput
  stderr: NodeJS.WriteStream
  createView: typeof createInkView
} = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, createView: createInkView }

const DEFAULT_CANCEL_GRACE_MS = 5_000
const DANGER_PRESET = 'danger-full-access'
const CSI = `${String.fromCharCode(0x1b)}[`

/**
 * Terminal state the TUI mutates and must restore on every exit path,
 * including signals and fatal errors.
 */
class TerminalGuard {
  private entered = false
  constructor(private readonly output: TerminalOutput, private readonly alternateScreen: boolean) {}

  enter(): void {
    if (this.entered) return
    this.entered = true
    if (this.alternateScreen) this.output.write(`${CSI}?1049h`)
  }

  restore(): void {
    if (!this.entered) return
    this.entered = false
    // Show the cursor and stop bracketed paste before leaving the buffer.
    this.output.write(`${CSI}?25h${CSI}?2004l`)
    if (this.alternateScreen) this.output.write(`${CSI}?1049l`)
  }
}

async function sessionsNotice(ctx: HarnessContext): Promise<string> {
  const sessions = selectableSessions(await listHarnessSessions(ctx)).slice(0, 5)
  if (sessions.length === 0) return 'no resumable sessions'
  const now = Date.now()
  return sessions.map(session => formatSessionRow(session, 60, now)).join('  |  ')
}

async function run(ctx: HarnessContext, config: Config, exit: (code: number) => void): Promise<void> {
  const capabilities = detectTerminal(process.env, internals.stdin, internals.stdout)
  if (!capabilities.interactive) {
    throw new Error('TUI requires interactive stdin and stdout; use --profile headless for redirected IO')
  }
  if (config.task.trim() === '' && config.resume === undefined) {
    throw new Error('task must not be empty unless --resume selects a session')
  }
  const diagnostics: DiagnosticLog = config.diagnosticLog === undefined
    ? silentDiagnosticLog
    : createDiagnosticLog(fileSink(config.diagnosticLog))
  diagnostics.record('startup', {
    resume: config.resume,
    permission: config.permission,
    model: config.model,
    interactive: config.interactive,
    capabilities,
  })
  const store = new TuiStore(config.maxEvents ?? 200, {
    ...(config.maxInlineOutputBytes === undefined
      ? {}
      : { maxInlineBytes: config.maxInlineOutputBytes }),
  })
  const approvals = new ApprovalQueue(store)
  const questions = new QuestionQueue(store)
  const editor = new EditorLauncher({
    workspace: process.cwd(),
    ...(config.editor === undefined ? {} : { editor: config.editor }),
    spawn: detachedSpawn(),
  })
  const guard = new TerminalGuard(
    internals.stdout,
    (config.alternateScreen ?? false) && capabilities.alternateScreen,
  )
  let cancel = (): void => {}
  let whenIdle = async (): Promise<void> => {}
  let closing = false
  let finishInteractive = (): void => {}
  let activeController: AgentController | undefined
  let dangerConfirmation: string | undefined
  let pendingSwitch: HarnessRunRequest | undefined
  let submissions = Promise.resolve()
  let view: TuiView | undefined
  let taskCode = 1

  const shutdown = new ShutdownCoordinator({
    stopInput: () => {
      closing = true
      store.setInteractive(false)
      store.setStatus('closing')
    },
    settleInteractions: () => {
      approvals.close()
      questions.close()
    },
    cancel: () => { cancel() },
    whenIdle: () => whenIdle(),
    finish: () => { finishInteractive() },
  }, {
    graceMs: config.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
    onStep: (step, detail) => {
      diagnostics.record(step, detail === undefined ? {} : { detail })
    },
  })

  const onSignal = (signal: NodeJS.Signals): void => {
    diagnostics.record('signal', { signal })
    void shutdown.request('signal')
  }
  // A closed terminal ends stdin; that is an exit request, not a hang.
  const onEndOfInput = (): void => {
    diagnostics.record('stdin-eof', {})
    void shutdown.request('eof')
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  internals.stdin.on('end', onEndOfInput)
  internals.stdin.on('close', onEndOfInput)

  const actions: TuiActions = {
    cancel: () => { void shutdown.request('cancel') },
    decideApproval: (allowed) => {
      diagnostics.record('approval-decided', { allowed })
      approvals.decide(allowed)
    },
    answerQuestion: (answer) => {
      diagnostics.record('question-answered', { count: answer.answers.length })
      questions.answer(answer)
    },
    toggleFold: (entryId) => { store.toggleFold(entryId) },
    expandTranscript: () => { store.expandWindow() },
    listSessions: () => {
      void listHarnessSessions(ctx)
        .then((records) => { store.setSessions(selectableSessions(records)) })
        .catch((error: unknown) => {
          store.setError(error instanceof Error ? error.message : String(error))
        })
    },
    resumeSession: (sessionId) => {
      if (closing || activeController === undefined) return
      pendingSwitch = { task: '', resumeSessionId: sessionId }
      diagnostics.record('session-switch', { kind: 'picker' })
      finishInteractive()
    },
    openLocation: (location) => {
      try {
        store.setNotice(editor.open(location))
      } catch (error) {
        store.setError(error instanceof Error ? error.message : String(error))
      }
    },
    submit: (text) => {
      const controller = activeController
      if (closing) return
      if (controller === undefined) return store.setError('session is not ready for input')
      // Steering must reach the running step now; queueing it behind the
      // current turn would turn it into an ordinary follow-up.
      if (routeUserInput(controller.status, text) === 'steer') {
        store.setError(undefined)
        diagnostics.record('steer', {})
        controller.steer(text)
        return store.setNotice('queued for the current step')
      }
      submissions = submissions.then(async () => {
        store.setError(undefined)
        store.setNotice(undefined)
        const line = text.trim()
        if (line === '/quit') return void shutdown.request('quit')
        if (line === '/help') {
          const names = store.snapshot().commands.map(command => `/${command.name}`).join(', ')
          return store.setNotice(`Commands: ${names}`)
        }
        if (line === '/sessions') return store.setNotice(await sessionsNotice(ctx))
        if (line === '/new') {
          pendingSwitch = { task: '' }
          diagnostics.record('session-switch', { kind: 'new' })
          return finishInteractive()
        }
        if (line === '/resume' || line.startsWith('/resume ')) {
          const requested = line.slice('/resume'.length).trim()
          const sessionId = resolveSessionSelection(
            await listHarnessSessions(ctx),
            requested === '' ? 'latest' : requested,
          )
          pendingSwitch = { task: '', resumeSessionId: sessionId }
          diagnostics.record('session-switch', { kind: 'resume' })
          return finishInteractive()
        }
        // Entering the unrestricted preset always takes a second, explicit step.
        if (line.startsWith('/permission') && line.includes(DANGER_PRESET) && dangerConfirmation !== line) {
          dangerConfirmation = line
          return store.setNotice(
            `${DANGER_PRESET} removes approval prompts; send the same command again to confirm`,
          )
        }
        dangerConfirmation = undefined
        const result = await new AgentInputRouter(controller).submit(text)
        if (result.kind === 'unknown-command') return store.setError(result.text)
        if (result.kind === 'command' && result.execution.result.kind === 'error') {
          return store.setError(result.execution.result.text)
        }
        if (result.kind === 'message') await controller.whenIdle()
        if (!await controller.flush()) throw new Error('session input was not persisted')
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        diagnostics.record('submit-failed', { message })
        store.setError(message)
      })
    },
  }

  try {
    const resumeSessionId = config.resume === undefined
      ? undefined
      : resolveSessionSelection(await listHarnessSessions(ctx), config.resume)
    guard.enter()
    view = internals.createView(
      store, actions, internals.stdin, internals.stdout, internals.stderr,
      (config.color ?? true) && capabilities.colorLevel !== 'none',
      (region, message) => {
        diagnostics.record('render-failed', { region, message })
        store.setError(`${region} render failed: ${message}`)
      },
    )
    if (capabilities.notes.length > 0) store.setNotice(capabilities.notes[0])
    if (resumeSessionId !== undefined) store.setNotice(`resumed session ${resumeSessionId}`)
    let request: HarnessRunRequest = {
      task: config.task,
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      ...(config.permission === undefined ? {} : { permissionPreset: config.permission }),
      ...(config.model === undefined ? {} : { model: config.model }),
    }
    const hooks: HarnessHooks = {
      event: event => store.append(event),
      rebuild: events => store.rebuild(events),
      projection: (snapshot) => { store.setRegisteredProjections(snapshot) },
      status: (status) => { if (!closing) store.setStatus(status) },
      approval: (input, signal) => {
        diagnostics.record('approval-requested', { toolName: input.toolName })
        return approvals.ask(input, signal)
      },
      question: (items, signal) => questions.ask(items, signal),
      diagnostic: (message) => {
        diagnostics.record('runtime-diagnostic', { message })
        store.setError(message)
      },
      ready: (controls) => {
        cancel = () => { controls.cancel() }
        whenIdle = () => controls.whenIdle()
        store.setToolPresenter(node => controls.presentTool(node))
        if (shutdown.requested) void shutdown.request('cancel')
      },
    }
    const interactiveSession = config.interactive === true ? async (controller: AgentController) => {
      activeController = controller
      const local = [
        { name: 'help', description: 'List available commands' },
        { name: 'sessions', description: 'List resumable sessions' },
        { name: 'new', description: 'Flush this session and start a fresh one' },
        {
          name: 'resume',
          description: 'Flush this session and resume another',
          input: { hint: '[session id | latest]' },
        },
        { name: 'quit', description: 'Flush and exit this TUI session' },
      ]
      const reserved = new Set(local.map(command => command.name))
      store.setCommands([
        ...local,
        ...controller.listCommands().filter(command => !reserved.has(command.name)),
      ])
      store.setInteractive(true)
      await new Promise<void>((resolve) => {
        finishInteractive = resolve
        if (shutdown.requested) resolve()
      })
      await submissions
      store.setInteractive(false)
      store.setCommands([])
      activeController = undefined
    } : undefined
    // One process can walk several sessions: /new and /resume settle the current
    // one durably, then the loop attaches the next.
    for (;;) {
      taskCode = await executeHarnessTask(ctx, request, hooks, interactiveSession)
      const next = pendingSwitch
      pendingSwitch = undefined
      if (next === undefined || shutdown.requested || taskCode !== 0) break
      request = { ...next, ...(config.model === undefined ? {} : { model: config.model }) }
      store.setNotice(next.resumeSessionId === undefined
        ? 'started a new session'
        : `resumed session ${next.resumeSessionId}`)
    }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    internals.stdin.off('end', onEndOfInput)
    internals.stdin.off('close', onEndOfInput)
    approvals.close()
    questions.close()
    store.setStatus('closing')
    view?.unmount()
    guard.restore()
  }
  const code = exitCodeFor(shutdown.reason, taskCode)
  diagnostics.record('exit', { code, reason: shutdown.reason, cancelTimedOut: shutdown.cancelTimedOut })
  exit(code)
}

export function apply(ctx: HarnessContext, config: Config): void {
  const exit = ctx.get('appExit') as ((code: number) => void) | undefined
  if (exit === undefined) throw new Error('tui-runner requires the dsh launcher appExit service')
  void run(ctx, config, exit).catch((error: unknown) => {
    internals.stderr.write(`dsh-tui: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(1)
  })
}
