import { summarizeActivity, type ActivityCounters, type ActivitySummary } from './activity.ts'
import type {
  AgentStatus,
  ApprovalPrompt,
  FileCandidate,
  QuestionPrompt,
  ProjectionIssue,
  RegisteredProjectionSnapshot,
  TerminalEvent,
  ToolNode,
  ToolPresentation,
  TuiCommandDescriptor,
  TuiSessionSummary,
  TuiSnapshot,
} from './contracts.ts'
import { ConversationProjection } from './conversation-projection.ts'
import {
  buildTranscriptEntries, transcriptLines,
  type TranscriptEntry, type TranscriptEntryCache, type TranscriptLine,
  type TranscriptLineCache, type TranscriptOptions,
} from './transcript-view.ts'
import type { DetailLine } from './styling.ts'
import { collapseEntries, DEFAULT_COLLAPSE_RULES, type CollapseRule } from './collapse.ts'
import {
  clearNotices, dropNotice as dropNoticeFrom, emptyNoticeQueue,
  pushNotice as pushNoticeInto, textNotice, tickNotices as tickNoticesIn,
  type Notice, type NoticeQueue,
} from './notifications.ts'

type Listener = () => void

const EMPTY_ACTIVITY: ActivitySummary = Object.freeze({ planActive: false })
const EMPTY_COUNTERS: ActivityCounters = Object.freeze({
  tools: 0, filesAdded: 0, filesRemoved: 0, approvals: 0,
})

function genericPresentation(node: ToolNode): ToolPresentation {
  return { call: { card: 'generic', title: node.name, rawInput: node.input } }
}

function countersOf(entries: readonly TranscriptEntry[]): ActivityCounters {
  let tools = 0
  let filesAdded = 0
  let filesRemoved = 0
  let approvals = 0
  for (const entry of entries) {
    if (entry.nodeKind === 'tool') tools++
    if (entry.diffStats !== undefined) {
      filesAdded += entry.diffStats.added
      filesRemoved += entry.diffStats.removed
    }
    if (entry.tone === 'system' && entry.header.startsWith('• Approval')) approvals++
  }
  return { tools, filesAdded, filesRemoved, approvals }
}

/** Bounded view state for one terminal session; durable facts stay in the projection. */
export class TuiStore {
  private readonly listeners = new Set<Listener>()
  private readonly projection: ConversationProjection
  private readonly cache: TranscriptEntryCache = new Map()
  private readonly rows: TranscriptLineCache = new Map()
  private readonly folds = new Set<string>()
  private present: (node: ToolNode) => ToolPresentation = genericPresentation
  private notices: NoticeQueue = emptyNoticeQueue
  private value: TuiSnapshot = {
    status: 'starting',
    interactive: false,
    transcriptRevision: 0,
    nodes: [],
    entries: [],
    lines: [],
    commands: [],
    registeredProjections: { asOfSeq: -1, values: Object.freeze({}) },
    activity: EMPTY_ACTIVITY,
    counters: EMPTY_COUNTERS,
    sessions: [],
    modelPickerOpen: false,
    modelPickerLoading: false,
    commandPaletteRequest: 0,
    files: [],
    history: [],
    workspace: {},
    turn: { index: 0, startedAtMs: 0 },
    outputAtMs: 0,
    hasMoreHistory: false,
    noticesQueued: 0,
  }

  /** Nodes currently rendered; grows one page at a time via {@link expandWindow}. */
  private window: number

  /** Terminal width the rows were wrapped to; 0 until the view reports one. */
  private columns = 0

  /**
   * Banner rows prepended to the transcript. They live here rather than in a
   * pinned region so the viewport counts them and they scroll away with the
   * history instead of costing rows on every frame.
   */
  private header: readonly DetailLine[] = []
  private splash?: (columns: number) => readonly DetailLine[]

  /**
   * @param maxEvents - nodes rendered before the user pages further back.
   * @param transcript - card and fold options.
   * @param retainedNodes - upper bound on folded nodes kept available for paging.
   */
  /** First time each call was seen live; absent for calls folded from a log. */
  private readonly startedAt = new Map<string, number>()

  /** Turn count and start, for the working line. */
  private turns = 0
  private turnStartedAtMs = 0

  constructor(
    private readonly maxEvents: number,
    transcript: TranscriptOptions = {},
    private readonly retainedNodes = maxEvents * 20,
    private readonly clock: () => number = Date.now,
    /** Pass an empty list to render every card on its own, as before. */
    private readonly collapseRules: readonly CollapseRule[] = DEFAULT_COLLAPSE_RULES,
  ) {
    this.window = maxEvents
    this.projection = new ConversationProjection(Math.max(maxEvents, retainedNodes))
    this.transcript = { ...transcript, startedAt: callId => this.startedAt.get(callId) }
  }

  private readonly transcript: TranscriptOptions

  /**
   * Page one more screen of retained history into the window.
   * @returns whether the window actually grew.
   */
  expandWindow(): boolean {
    if (!this.value.hasMoreHistory) return false
    this.window = Math.min(this.window + this.maxEvents, this.retainedNodes)
    // History arriving above the viewport is not new content, so the revision
    // stays put and the unread counter is left alone.
    this.publishProjection(false)
    return true
  }

  snapshot = (): TuiSnapshot => this.value

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  setStatus(status: AgentStatus): void {
    // A run that starts without a fresh user message (a resume, or the opening
    // task) still needs a clock to count from.
    if (status === 'running' && this.turnStartedAtMs === 0) this.turnStartedAtMs = this.clock()
    this.publish({ ...this.value, status, turn: { index: this.turns, startedAtMs: this.turnStartedAtMs } })
  }

  setInteractive(interactive: boolean): void { this.publish({ ...this.value, interactive }) }

  setCommands(commands: readonly TuiCommandDescriptor[]): void {
    this.publish({ ...this.value, commands: Object.freeze(structuredClone(commands)) })
  }

  /** Bind the tool presenter of the live Agent; cards rebuild against it. */
  setToolPresenter(present: (node: ToolNode) => ToolPresentation): void {
    this.present = present
    this.cache.clear()
    this.publishProjection()
  }

  /**
   * Re-flow the transcript for a new terminal width. Row counts change, so the
   * viewport's anchor shifts — the same thing a real resize does to scrollback.
   */
  setColumns(columns: number): void {
    const next = Math.max(0, Math.floor(columns))
    if (next === this.columns) return
    this.columns = next
    if (this.splash !== undefined) this.header = this.splash(next)
    this.publish({ ...this.value, lines: this.renderLines(this.value.entries) })
  }

  /**
   * Install the banner as a function of width, so a resize re-flows it with the
   * rest of the transcript instead of leaving a stale frame behind.
   */
  setHeader(build: (columns: number) => readonly DetailLine[]): void {
    this.splash = build
    this.header = build(this.columns)
    this.publish({ ...this.value, lines: this.renderLines(this.value.entries) })
  }

  setSessions(sessions: readonly TuiSessionSummary[]): void {
    this.publish({ ...this.value, sessions: Object.freeze(structuredClone(sessions)) })
  }

  setModelPicker(open: boolean, loading = false): void {
    this.publish({ ...this.value, modelPickerOpen: open, modelPickerLoading: loading })
  }

  setModelDirectory(directory: TuiSnapshot['modelDirectory']): void {
    this.publish({
      ...this.value,
      ...(directory === undefined ? {} : { modelDirectory: Object.freeze(structuredClone(directory)) }),
      modelPickerLoading: false,
    })
  }

  requestCommandPalette(): void {
    this.publish({ ...this.value, commandPaletteRequest: this.value.commandPaletteRequest + 1 })
  }

  setFiles(files: readonly FileCandidate[]): void {
    this.publish({ ...this.value, files: Object.freeze(structuredClone(files)) })
  }

  /** Seed the composer's up-arrow walk with drafts from earlier sessions. */
  setHistory(history: readonly string[]): void {
    this.publish({ ...this.value, history: Object.freeze([...history]) })
  }

  setModel(model: string): void {
    this.publish({ ...this.value, model })
  }

  setWorkspace(workspace: TuiSnapshot['workspace']): void {
    this.publish({ ...this.value, workspace: Object.freeze({ ...workspace }) })
  }

  setRegisteredProjections(snapshot: RegisteredProjectionSnapshot): void {
    this.publish({
      ...this.value,
      registeredProjections: snapshot,
      activity: Object.freeze(summarizeActivity(snapshot.values)),
    })
  }

  /** Flip the fold state of one transcript entry away from its default policy. */
  toggleFold(entryId: string): void {
    if (this.folds.has(entryId)) this.folds.delete(entryId)
    else this.folds.add(entryId)
    this.publish({ ...this.value, lines: this.renderLines(this.value.entries) })
  }

  append(event: TerminalEvent): ProjectionIssue | undefined {
    // A user message starts a turn; the working line counts from here and the
    // verb is picked from the turn index.
    if (event.kind === 'user') {
      this.turnStartedAtMs = this.clock()
      this.turns++
    }
    // Wall-clock start times live here, not in the projection: the durable fold
    // must stay replay-deterministic, and a resumed call has no live start.
    if (event.callId !== undefined) {
      if (event.kind === 'tool-call' && !this.startedAt.has(event.callId)) {
        this.startedAt.set(event.callId, this.clock())
      }
      // A settled call has no elapsed field, so the entry can go.
      if (event.kind === 'tool-result') this.startedAt.delete(event.callId)
    }
    if (!this.projection.append(event)) return this.projection.snapshot().issue
    return this.publishProjection()
  }

  rebuild(events: readonly TerminalEvent[]): ProjectionIssue | undefined {
    this.projection.rebuild(events)
    this.cache.clear()
    return this.publishProjection()
  }

  private renderLines(entries: readonly TranscriptEntry[]): readonly TranscriptLine[] {
    const rows = transcriptLines(
      entries, this.folds, this.columns, this.rows, this.transcript.glyphs,
    )
    if (this.header.length === 0) return rows
    return [
      ...this.header.map(line => ({
        entryId: 'splash',
        text: line.text,
        tone: line.tone ?? ('system' as const),
        header: false,
        // The banner's art *is* its styled runs: the whale and the wordmark are
        // half-blocks whose colours carry the shape. Dropping the runs here left
        // a grey slab on screen.
        ...(line.segments === undefined ? {} : { segments: line.segments }),
      })),
      ...rows,
    ]
  }

  private publishProjection(bumpRevision = true): ProjectionIssue | undefined {
    const projected = this.projection.snapshot()
    const nodes = projected.nodes.slice(-this.window)
    const built = buildTranscriptEntries(nodes, this.present, this.transcript, this.cache)
    // Runs of settled read and search cards become one entry, so a turn that
    // looked at nine files does not spend forty rows saying so.
    const entries = collapseEntries(built, this.collapseRules, this.transcript.glyphs)
    const next: TuiSnapshot = {
      ...this.value,
      nodes,
      entries,
      lines: this.renderLines(entries),
      // Counted on what actually ran, not on what is shown: collapsing is a
      // display decision and must not change the tool tally in the status row.
      counters: countersOf(built),
      // Stamped whenever the projection produced something new, which is what
      // "the model is still talking" means from the view's side.
      ...(bumpRevision ? { outputAtMs: this.clock() } : {}),
      hasMoreHistory: projected.nodes.length > nodes.length,
      transcriptRevision: this.value.transcriptRevision + (bumpRevision ? 1 : 0),
    }
    if (projected.issue === undefined) delete next.error
    else next.error = projected.issue.message
    this.publish(next)
    return projected.issue
  }

  setApproval(approval: ApprovalPrompt | undefined): void {
    const next = { ...this.value }
    if (approval === undefined) delete next.approval
    else next.approval = approval
    this.publish(next)
  }

  setQuestion(question: QuestionPrompt | undefined): void {
    const next = { ...this.value }
    if (question === undefined) delete next.question
    else next.question = question
    this.publish(next)
  }

  setError(error: string | undefined): void {
    const next = { ...this.value }
    if (error === undefined) delete next.error
    else next.error = error
    this.publish(next)
  }

  /**
   * Show a plain string, or clear the row and everything waiting for it.
   *
   * The ad-hoc call sites still send bare text; {@link pushNotice} is the form
   * that can say how long, how loudly, and what it retracts.
   */
  setNotice(notice: string | undefined): void {
    if (notice === undefined) {
      this.notices = clearNotices()
      this.publishNotices()
      return
    }
    this.pushNotice(textNotice(notice))
  }

  /** Queue a notice with its own priority, timeout and retractions. */
  pushNotice(notice: Notice): void {
    this.notices = pushNoticeInto(this.notices, notice, this.clock())
    this.publishNotices()
  }

  /** Drop one notice by key, wherever it is. */
  dropNotice(key: string): void {
    this.notices = dropNoticeFrom(this.notices, key, this.clock())
    this.publishNotices()
  }

  /**
   * Retire the showing notice once its time is up, and promote the next.
   *
   * Nothing here schedules: the view calls this while there is something to
   * expire, so an idle session holds no timer.
   */
  tickNotices(): void {
    const next = tickNoticesIn(this.notices, this.clock())
    if (next === this.notices) return
    this.notices = next
    this.publishNotices()
  }

  private publishNotices(): void {
    const next = { ...this.value }
    const current = this.notices.current
    if (current === undefined) {
      delete next.notice
      delete next.noticeTone
    } else {
      next.notice = current.text
      if (current.tone === undefined) delete next.noticeTone
      else next.noticeTone = current.tone
    }
    next.noticesQueued = this.notices.queue.length
    this.publish(next)
  }

  private publish(value: TuiSnapshot): void {
    this.value = Object.freeze(value)
    for (const listener of this.listeners) listener()
  }
}
