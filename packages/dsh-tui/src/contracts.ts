/** Upstream-neutral types shared by the runtime projection and Ink view. */

export type AgentStatus = 'idle' | 'running' | 'closing' | 'starting'

export interface TerminalEvent {
  seq: number
  kind: 'user' | 'assistant-delta' | 'reasoning-delta' | 'tool-call' | 'tool-result' | 'turn-end'
  text: string
}

export interface ApprovalPrompt {
  id: number
  toolName: string
  reason?: string
}

export type ApprovalDecision = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface TuiSnapshot {
  status: AgentStatus
  lines: readonly string[]
  approval?: ApprovalPrompt
  error?: string
}

export interface TuiActions {
  cancel(): void
  decideApproval(allowed: boolean): void
}

export interface TuiView {
  unmount(): void
}
