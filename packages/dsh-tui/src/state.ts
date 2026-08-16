import { summarizeActivity, type ActivityCounters, type ActivitySummary } from './activity.ts'
import type {
  AgentStatus,
  ApprovalPrompt,
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
  type TranscriptEntry, type TranscriptEntryCache, type TranscriptOptions,
} from './transcript-view.ts'

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
  private readonly folds = new Set<string>()
  private present: (node: ToolNode) => ToolPresentation = genericPresentation
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
    hasMoreHistory: false,
  }

  /** Nodes currently rendered; grows one page at a time via {@link expandWindow}. */
  private window: number

  /**
   * @param maxEvents - nodes rendered before the user pages further back.
   * @param transcript - card and fold options.
   * @param retainedNodes - upper bound on folded nodes kept available for paging.
   */
  constructor(
    private readonly maxEvents: number,
    private readonly transcript: TranscriptOptions = {},
    private readonly retainedNodes = maxEvents * 20,
  ) {
    this.window = maxEvents
    this.projection = new ConversationProjection(Math.max(maxEvents, retainedNodes))
  }

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

  setStatus(status: AgentStatus): void { this.publish({ ...this.value, status }) }

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

  setSessions(sessions: readonly TuiSessionSummary[]): void {
    this.publish({ ...this.value, sessions: Object.freeze(structuredClone(sessions)) })
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
    this.publish({ ...this.value, lines: transcriptLines(this.value.entries, this.folds) })
  }

  append(event: TerminalEvent): ProjectionIssue | undefined {
    if (!this.projection.append(event)) return this.projection.snapshot().issue
    return this.publishProjection()
  }

  rebuild(events: readonly TerminalEvent[]): ProjectionIssue | undefined {
    this.projection.rebuild(events)
    this.cache.clear()
    return this.publishProjection()
  }

  private publishProjection(bumpRevision = true): ProjectionIssue | undefined {
    const projected = this.projection.snapshot()
    const nodes = projected.nodes.slice(-this.window)
    const entries = buildTranscriptEntries(nodes, this.present, this.transcript, this.cache)
    const next: TuiSnapshot = {
      ...this.value,
      nodes,
      entries,
      lines: transcriptLines(entries, this.folds),
      counters: countersOf(entries),
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

  setNotice(notice: string | undefined): void {
    const next = { ...this.value }
    if (notice === undefined) delete next.notice
    else next.notice = notice
    this.publish(next)
  }

  private publish(value: TuiSnapshot): void {
    this.value = Object.freeze(value)
    for (const listener of this.listeners) listener()
  }
}
