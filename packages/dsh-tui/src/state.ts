import type { AgentStatus, ApprovalPrompt, TerminalEvent, TuiSnapshot } from './contracts.ts'

type Listener = () => void

/** Small bounded projection used to validate the live Harness event path. */
export class TuiStore {
  private readonly listeners = new Set<Listener>()
  private value: TuiSnapshot = { status: 'starting', lines: [] }

  constructor(private readonly maxEvents: number) {}

  snapshot = (): TuiSnapshot => this.value

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  setStatus(status: AgentStatus): void { this.publish({ ...this.value, status }) }

  append(event: TerminalEvent): void {
    const prefix = event.kind === 'user' ? 'You: '
      : event.kind === 'tool-call' ? 'Tool: '
        : event.kind === 'tool-result' ? 'Result: '
          : event.kind === 'reasoning-delta' ? 'Reasoning: '
            : event.kind === 'turn-end' ? 'Turn: '
              : ''
    this.publish({ ...this.value, lines: [...this.value.lines, prefix + event.text].slice(-this.maxEvents) })
  }

  setApproval(approval: ApprovalPrompt | undefined): void {
    const next = { ...this.value }
    if (approval === undefined) delete next.approval
    else next.approval = approval
    this.publish(next)
  }

  setError(error: string): void { this.publish({ ...this.value, error }) }

  private publish(value: TuiSnapshot): void {
    this.value = Object.freeze(value)
    for (const listener of this.listeners) listener()
  }
}
