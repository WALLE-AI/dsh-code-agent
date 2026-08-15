/** Upstream-neutral types shared by the runtime projection and Ink view. */

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

export interface ToolRenderIntent { readonly card: string; readonly [key: string]: unknown }

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
  lines: readonly string[]
  commands: readonly TuiCommandDescriptor[]
  registeredProjections: RegisteredProjectionSnapshot
  approval?: ApprovalPrompt
  question?: QuestionPrompt
  error?: string
  notice?: string
}

export interface TuiActions {
  cancel(): void
  decideApproval(allowed: boolean): void
  answerQuestion(answer: QuestionAnswer): void
  submit(text: string): void
}

export interface TuiView {
  unmount(): void
}
