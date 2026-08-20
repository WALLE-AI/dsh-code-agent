import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { createInkView } from './app.tsx'
import { ApprovalQueue } from './approval-queue.ts'
import {
  DEFAULT_KEYMAP, describeIssues, parseKeybindings, type Keymap,
} from './keybindings.ts'
import { QuestionQueue } from './question-queue.ts'
import { AgentInputRouter, routeUserInput } from './input-router.ts'
import type { AgentController } from './agent-controller.ts'
import type { TuiActions, TuiView } from './contracts.ts'
import {
  createDiagnosticLog, fileSink, silentDiagnosticLog, type DiagnosticLog,
} from './diagnostic-log.ts'
import { detachedSpawn, EditorLauncher } from './editor-launcher.ts'
import { glyphSet } from './glyphs.ts'
import { MOUSE_OFF, MOUSE_ON } from './mouse.ts'
import { buildSplash } from './splash.ts'
import {
  historyLine, HISTORY_LIMIT, parseHistory, serializeHistory,
} from './history-store.ts'
import {
  executeHarnessTask, listHarnessSessions,
  type HarnessContext, type HarnessHooks, type HarnessRunRequest, type ModelOverride,
} from './harness-adapter.ts'
import { formatSessionRow, resolveSessionSelection, selectableSessions } from './session-selector.ts'
import { exitCodeFor, ShutdownCoordinator } from './shutdown.ts'
import { TuiStore } from './state.ts'
import { detectTerminal } from './terminal-capabilities.ts'
import { resolveTheme } from './theme.ts'
import { listWorkspaceFiles, type DirectoryEntry } from './workspace-files.ts'

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
/**
 * One key for every acknowledgement of a user action.
 *
 * The row shows the answer to the *most recent* thing the user did, so a second
 * command replaces the first one's reply instead of queueing behind it — and a
 * stale answer can never resurface after its question has been superseded.
 */
const ACTION_NOTICE = 'action'
const CSI = `${String.fromCharCode(0x1b)}[`

/**
 * Terminal state the TUI mutates and must restore on every exit path,
 * including signals and fatal errors.
 */
class TerminalGuard {
  private entered = false
  private mouseOn = false
  private overlayScreen = false
  constructor(
    private readonly output: TerminalOutput,
    private readonly alternateScreen: boolean,
    /** Whether the terminal can be asked for wheel reports at all. */
    private readonly mouseCapable: boolean,
  ) {}

  enter(): void {
    if (this.entered) return
    this.entered = true
    if (this.alternateScreen) this.output.write(`${CSI}?1049h`)
    // Bracketed paste lets the composer tell a paste from typing, so multi-line
    // clipboard text lands in the draft instead of submitting line by line.
    this.output.write(`${CSI}?2004h`)
    // The wheel stays the terminal's. Settled rows are written into its
    // scrollback, so the terminal's own scrolling reaches the whole session —
    // including on consoles that never forward wheel reports, where claiming
    // them left the wheel doing nothing at all. `/mouse` takes them if the
    // in-frame viewport is what you want to scroll instead.
    this.setMouse(this.alternateScreen)
  }

  /**
   * Turn wheel reporting on or off.
   *
   * @returns whether reporting is on afterwards — `false` on a terminal that
   *   cannot report, so `/mouse` can say so instead of claiming a mode it has
   *   not got.
   */
  setMouse(on: boolean): boolean {
    const wanted = on && this.mouseCapable && this.entered
    if (wanted !== this.mouseOn) {
      this.output.write(wanted ? MOUSE_ON : MOUSE_OFF)
      this.mouseOn = wanted
    }
    return this.mouseOn
  }

  get mouseEnabled(): boolean {
    return this.mouseOn
  }

  enterScreen(): boolean {
    if (!this.entered || !this.mouseCapable) return false
    if (!this.alternateScreen && !this.overlayScreen) {
      this.output.write(`${CSI}?1049h`)
      this.overlayScreen = true
    }
    return true
  }

  exitScreen(): void {
    if (!this.overlayScreen) return
    this.overlayScreen = false
    this.output.write(`${CSI}?1049l`)
  }

  restore(): void {
    if (!this.entered) return
    // Reporting must stop before the buffer goes away, or the shell inherits a
    // terminal that prints `[<64;…M` at every scroll.
    this.setMouse(false)
    this.exitScreen()
    this.entered = false
    // Show the cursor and stop bracketed paste before leaving the buffer.
    this.output.write(`${CSI}?25h${CSI}?2004l`)
    if (this.alternateScreen) this.output.write(`${CSI}?1049l`)
  }
}

/**
 * Read the checked-out branch from `.git/HEAD`, walking up to the repository
 * root. Reading the file rather than spawning `git` keeps startup free of a
 * subprocess, and a detached HEAD or a missing repository simply yields nothing.
 */
function detectBranch(workspace: string): { branch?: string } {
  let directory = workspace
  for (;;) {
    try {
      const head = readFileSync(join(directory, '.git', 'HEAD'), 'utf8').trim()
      const match = /^ref: refs\/heads\/(.+)$/.exec(head)
      return match?.[1] === undefined ? {} : { branch: match[1] }
    } catch {
      const parent = dirname(directory)
      if (parent === directory) return {}
      directory = parent
    }
  }
}

/**
 * Open the draft history file, tolerating every failure. History is a
 * convenience: an unwritable home directory must not stop a session.
 */
/**
 * Read the user's key overrides, if there are any.
 *
 * A missing file is the normal case and says nothing; an unreadable one is
 * reported through the notice row rather than thrown, for the same reason the
 * draft history is: losing a preference must not stop a session from starting.
 */
function loadKeybindings(path: string): { keymap: Keymap; notice?: string } {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch {
    return { keymap: DEFAULT_KEYMAP }
  }
  const { keymap, issues } = parseKeybindings(contents)
  const notice = describeIssues(issues)
  return { keymap, ...(notice === undefined ? {} : { notice }) }
}

function createDraftHistory(path: string): {
  readonly entries: readonly string[]
  record(draft: string): void
} {
  let entries: readonly string[] = []
  let writable = true
  try {
    entries = parseHistory(readFileSync(path, 'utf8'))
  } catch {
    entries = []
  }
  return {
    get entries() { return entries },
    record(draft: string) {
      if (!writable || draft.trim() === '' || entries.at(-1) === draft) return
      entries = [...entries, draft].slice(-HISTORY_LIMIT)
      try {
        mkdirSync(dirname(path), { recursive: true })
        // Rewrite once the bound is reached so the file cannot grow without end.
        if (entries.length < HISTORY_LIMIT) appendFileSync(path, historyLine(draft))
        else writeFileSync(path, serializeHistory(entries))
      } catch {
        // One failed write is enough: stop retrying on every submission.
        writable = false
      }
    },
  }
}

/** Render a model override the way it was written on the command line. */
function formatModelRoute(model: ModelOverride): string | undefined {
  const route = [model.provider, model.model]
    .filter((part): part is string => part !== undefined && part !== '')
    .join('/')
  if (route === '') return undefined
  return model.reasoningEffort === undefined ? route : `${route} · ${model.reasoningEffort}`
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
  if (config.task.trim() === '' && config.resume === undefined && config.interactive !== true) {
    throw new Error('task must not be empty outside an interactive or resumed session')
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
    glyphs: glyphSet(capabilities.unicode),
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
    // Same test as the alternate screen: a TTY whose TERM is neither unset nor
    // `dumb` is one that understands private mode sets.
    capabilities.alternateScreen,
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

  // Draft history and key overrides live beside the session store so they
  // follow $DSH_HOME.
  const dshHome = process.env.DSH_HOME?.trim() ?? join(homedir(), '.dsh')
  const history = createDraftHistory(join(dshHome, 'tui', 'history.jsonl'))
  store.setHistory(history.entries)
  const keys = loadKeybindings(join(dshHome, 'keybindings.json'))

  const workspace = process.cwd()
  const workspaceFacts = { directory: basename(workspace), ...detectBranch(workspace) }
  store.setWorkspace(workspaceFacts)
  // The banner states only what this run was actually told; an unset --model
  // leaves the line out rather than guessing a default.
  const model = config.model === undefined ? undefined : formatModelRoute(config.model)
  store.setHeader(width => buildSplash({
    title: 'DeepSeek Harness TUI',
    ...(model === undefined ? {} : { model }),
    ...workspaceFacts,
    tips: ['/help for commands', 'Tab completes', '? for shortcuts'],
    // `--no-color` must reach the art too, not just the palette: the theme
    // would blank the colours and leave a slab of half-blocks behind.
  }, width, glyphSet(capabilities.unicode),
  config.color === false ? 'none' : capabilities.colorLevel))
  // Mention completion never leaves the workspace: `resolve` on a joined path
  // collapses any `..` the prefix smuggled in, and a result outside is dropped.
  const workspaceReader = (relativePath: string): readonly DirectoryEntry[] => {
    const target = resolve(workspace, relativePath)
    if (target !== workspace && !target.startsWith(`${workspace}${sep}`)) return []
    return readdirSync(target, { withFileTypes: true })
      .map(entry => ({ name: entry.name, directory: entry.isDirectory() }))
  }

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
    listFiles: (prefix) => {
      try {
        store.setFiles(listWorkspaceFiles(prefix, workspaceReader))
      } catch {
        // A mention menu is a convenience; an unreadable workspace just yields
        // no candidates rather than an error row over the transcript.
        store.setFiles([])
      }
    },
    resumeSession: (sessionId) => {
      if (closing || activeController === undefined) return
      pendingSwitch = { task: '', resumeSessionId: sessionId }
      diagnostics.record('session-switch', { kind: 'picker' })
      finishInteractive()
    },
    openLocation: (location) => {
      try {
        store.pushNotice({
          key: ACTION_NOTICE,
          text: editor.open(location),
          priority: 'immediate',
        })
      } catch (error) {
        store.setError(error instanceof Error ? error.message : String(error))
      }
    },
    submit: (text) => {
      const controller = activeController
      if (closing) return
      history.record(text)
      if (controller === undefined) return store.setError('session is not ready for input')
      // Steering must reach the running step now; queueing it behind the
      // current turn would turn it into an ordinary follow-up.
      if (routeUserInput(controller.status, text) === 'steer') {
        store.setError(undefined)
        diagnostics.record('steer', {})
        controller.steer(text)
        return store.pushNotice({
          key: ACTION_NOTICE,
          text: 'queued for the current step',
          priority: 'immediate',
          timeoutMs: 4_000,
        })
      }
      submissions = submissions.then(async () => {
        store.setError(undefined)
        store.setNotice(undefined)
        const line = text.trim()
        if (line === '/quit') return void shutdown.request('quit')
        if (line === '/help') {
          const names = store.snapshot().commands.map(command => `/${command.name}`).join(', ')
          // A reference list is read, not glanced at: it holds the row longer
          // than an event would, and outranks whatever was already there.
          return store.pushNotice({
            key: ACTION_NOTICE,
            text: `Commands: ${names}`,
            priority: 'immediate',
            timeoutMs: 20_000,
          })
        }
        if (line === '/sessions') {
          return store.pushNotice({
            key: ACTION_NOTICE,
            text: await sessionsNotice(ctx),
            priority: 'immediate',
            timeoutMs: 20_000,
          })
        }
        if (line === '/mouse') {
          // Off hands the wheel back to the terminal — scrollback and drag-select
          // work as usual, and the transcript pages with PgUp/PgDn only.
          const on = guard.setMouse(!guard.mouseEnabled)
          return store.pushNotice({
            key: ACTION_NOTICE,
            text: on
              ? 'mouse wheel scrolls the live rows; hold Shift to select text'
              : 'mouse wheel released to the terminal; it scrolls the whole session',
            priority: 'immediate',
          })
        }
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
          // The one notice that may not wait its turn: it gates a security
          // decision the user is half-way through making.
          return store.pushNotice({
            key: ACTION_NOTICE,
            text: `${DANGER_PRESET} removes approval prompts; send the same command again to confirm`,
            tone: 'error',
            priority: 'immediate',
            timeoutMs: 15_000,
          })
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
      resolveTheme(capabilities.colorLevel, config.color ?? true),
      (region, message) => {
        diagnostics.record('render-failed', { region, message })
        store.setError(`${region} render failed: ${message}`)
      },
      // A terminal that cannot draw the frames gets the static status glyph
      // instead of a spinner that would only churn the screen.
      capabilities.unicode,
      Date.now,
      keys.keymap,
      {
        enter: () => guard.enterScreen(),
        exit: () => { guard.exitScreen() },
        copy: text => {
          if (capabilities.multiplexer !== undefined || capabilities.remote) return false
          const encoded = Buffer.from(text, 'utf8').toString('base64')
          internals.stdout.write(`\x1b]52;c;${encoded}\x07`)
          return true
        },
      },
    )
    // A typo in the overrides is reported and then ignored: the file is edited
    // from a terminal, so a bad file must never be what stops one from opening.
    if (keys.notice !== undefined) {
      store.pushNotice({
        key: 'keybindings',
        text: keys.notice,
        tone: 'error',
        priority: 'high',
        timeoutMs: 15_000,
      })
    }
    // What the session *is* comes first; what the terminal cannot do follows.
    // Both are shown now — the capability note used to be written over by the
    // resume line one statement later, and never reached the screen at all.
    if (resumeSessionId !== undefined) {
      store.pushNotice({
        key: 'session',
        text: `resumed session ${resumeSessionId}`,
        priority: 'medium',
      })
    }
    // Ambient: context about the terminal, not a reply to anything. Each note
    // yields the row to whatever the user does next, and comes back after.
    capabilities.notes.forEach((note, index) => {
      store.pushNotice({
        key: `capability:${String(index)}`,
        text: note,
        priority: 'low',
        timeoutMs: 12_000,
      })
    })
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
      model: (route) => {
        const text = formatModelRoute(route)
        if (text !== undefined) store.setModel(text)
      },
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
        { name: 'mouse', description: 'Toggle whether the wheel scrolls the transcript' },
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
      store.pushNotice({
        key: 'session',
        text: next.resumeSessionId === undefined
          ? 'started a new session'
          : `resumed session ${next.resumeSessionId}`,
        priority: 'medium',
      })
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
