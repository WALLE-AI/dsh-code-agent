/** Upstream-neutral types shared by the runtime projection and Ink view. */

import type { ActivityCounters, ActivitySummary } from './activity.ts'
import type { FileCandidate } from './draft-completion.ts'
import type { TuiSessionSummary } from './session-selector.ts'
import type { TuiModelDirectory, TuiModelSelection } from './model-selection.ts'
import type { RowTone } from './styling.ts'
import type { TranscriptEntry, TranscriptLine } from './transcript-view.ts'

export type {
  ActivityCounters, ActivitySummary, FileCandidate, RowTone,
  TranscriptEntry, TranscriptLine, TuiSessionSummary,
  TuiModelDirectory, TuiModelSelection,
}

export type AgentStatus = 'idle' | 'running' | 'closing' | 'starting'

export type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }

export interface TerminalEvent {
  seq: number
  kind:
    | 'user'
    | 'assistant-delta'
    | 'assistant-final'
    | 'reasoning-delta'
    | 'tool-call'
    | 'tool-result'
    | 'marker'
    | 'turn-end'
    | 'ignored'
    | 'unknown-required'
  text: string
  callId?: string
  messageId?: string
  name?: string
  parentCallId?: string
  failed?: boolean
  metadata?: Record<string, unknown>
}

export interface TextNode {
  id: string
  kind: 'user' | 'assistant' | 'reasoning' | 'turn' | 'marker'
  text: string
  firstSeq: number
  lastSeq: number
}

export interface ToolNode {
  id: string
  kind: 'tool'
  callId: string
  name: string
  input: string
  output: string
  status: 'pending' | 'succeeded' | 'failed' | 'interrupted'
  firstSeq: number
  lastSeq: number
  parentCallId?: string
  metadata?: Record<string, unknown>
}

export type TranscriptNode = TextNode | ToolNode

export interface ProjectionIssue {
  kind: 'gap' | 'duplicate-conflict' | 'unknown-required'
  seq: number
  message: string
}

export interface ConversationSnapshot {
  status: 'healthy' | 'paused'
  lastSeq?: number
  nodes: readonly TranscriptNode[]
  issue?: ProjectionIssue
}

export interface RegisteredProjectionSnapshot {
  readonly asOfSeq: number
  readonly values: Readonly<Record<string, unknown>>
}

export interface ApprovalPrompt {
  id: number
  toolName: string
  reason?: string
  /** The streamed tool call this decision belongs to, when the asker has one. */
  callId?: string
}

export interface TuiCommandDescriptor {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
}

export type TuiCommandResult =
  | { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: number }
  | { readonly kind: 'error'; readonly text: string }

export interface TuiCommandExecution {
  readonly commandId: string
  readonly result: TuiCommandResult
}

export type InputSubmission =
  | { readonly kind: 'message' }
  | { readonly kind: 'command'; readonly execution: TuiCommandExecution }
  | { readonly kind: 'unknown-command'; readonly text: string }

export interface QuestionOption {
  readonly label: string
  readonly description?: string
}

export interface QuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly QuestionOption[]
  readonly multiSelect?: boolean
  readonly intent?: { readonly kind: 'plan-review'; readonly approve: string }
}

export interface QuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

export interface QuestionAnswer { readonly answers: readonly QuestionAnswerItem[] }

export interface QuestionPrompt {
  readonly id: number
  readonly questions: readonly QuestionItem[]
}

export interface ToolRenderIntent {
  readonly card: string
  /** One-line tool-owned summary for folded cards and running status. */
  readonly summary?: string
  /** Present-tense description shown while the call is running. */
  readonly activity?: string
  /** A deliberately smaller representation used when the inline body is capped. */
  readonly condensed?: {
    readonly title?: string
    readonly body?: readonly { readonly text: string; readonly tone?: RowTone }[]
  }
  /** The producer omitted result data even if the local row budget did not. */
  readonly truncated?: boolean
  readonly [key: string]: unknown
}

export interface ToolPresentation {
  readonly call: ToolRenderIntent
  readonly result?: ToolRenderIntent
}

export type ApprovalDecision = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface TuiSnapshot {
  status: AgentStatus
  interactive: boolean
  transcriptRevision: number
  nodes: readonly TranscriptNode[]
  entries: readonly TranscriptEntry[]
  lines: readonly TranscriptLine[]
  commands: readonly TuiCommandDescriptor[]
  registeredProjections: RegisteredProjectionSnapshot
  activity: ActivitySummary
  counters: ActivityCounters
  /** Resume candidates, refreshed on demand by the session picker. */
  sessions: readonly TuiSessionSummary[]
  modelDirectory?: TuiModelDirectory
  modelPickerOpen: boolean
  modelPickerLoading: boolean
  /** Monotonic request used by slash commands to open the existing command palette. */
  commandPaletteRequest: number
  /** Workspace paths, refreshed on demand while an `@` mention is being typed. */
  files: readonly FileCandidate[]
  /** Drafts submitted in earlier sessions, oldest first. */
  history: readonly string[]
  /** Where the session is running, detected once at startup. */
  workspace: { readonly branch?: string; readonly directory?: string }
  /** The model route the Harness resolved for this run, once it is known. */
  model?: string
  /** Which turn is in flight and when it began, for the working line. */
  turn: { readonly index: number; readonly startedAtMs: number }
  /**
   * When the transcript last grew, so the working line can say how long the
   * model has been silent. Zero until the first row arrives.
   */
  outputAtMs: number
  /** True when retained history exists above the rendered window. */
  hasMoreHistory: boolean
  approval?: ApprovalPrompt
  question?: QuestionPrompt
  error?: string
  /** Text of the notice holding the row, if any. */
  notice?: string
  /** Its tone, when it asked for one. */
  noticeTone?: RowTone
  /** How many more are waiting, so the row can say it is not the only one. */
  noticesQueued: number
}

export interface TuiActions {
  cancel(): void
  decideApproval(allowed: boolean): void
  answerQuestion(answer: QuestionAnswer): void
  submit(text: string): void
  toggleFold(entryId: string): void
  openLocation(location: { readonly path: string; readonly line?: number }): void
  /** Page one more screen of retained history into the transcript window. */
  expandTranscript(): void
  /** Refresh the resume candidates into the store. */
  listSessions(): void
  /** Refresh the workspace paths a mention prefix could complete to. */
  listFiles(prefix: string): void
  /** Settle the current session and attach the selected one. */
  resumeSession(sessionId: string): void
  listModels(): void
  selectModel(selection: TuiModelSelection): void
  closeModelPicker(): void
}

export interface TuiView {
  unmount(): void
}

export interface TuiScreenController {
  /** Enter a dedicated transcript screen; false means inline fallback. */
  enter(): boolean
  exit(): void
  /** Copy through OSC 52 when the terminal path permits it. */
  copy(text: string): boolean
}
