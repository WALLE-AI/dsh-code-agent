import type {
  AgentStatus,
  ApprovalPrompt,
  QuestionPrompt,
  ProjectionIssue,
  RegisteredProjectionSnapshot,
  TerminalEvent,
  TuiCommandDescriptor,
  TuiSnapshot,
} from './contracts.ts'
import { ConversationProjection } from './conversation-projection.ts'

type Listener = () => void

/** Small bounded projection used to validate the live Harness event path. */
export class TuiStore {
  private readonly listeners = new Set<Listener>()
  private readonly projection: ConversationProjection
  private value: TuiSnapshot = {
    status: 'starting',
    interactive: false,
    transcriptRevision: 0,
    nodes: [],
    lines: [],
    commands: [],
    registeredProjections: { asOfSeq: -1, values: Object.freeze({}) },
  }

  constructor(private readonly maxEvents: number) {
    this.projection = new ConversationProjection(maxEvents)
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

  setRegisteredProjections(snapshot: RegisteredProjectionSnapshot): void {
    this.publish({ ...this.value, registeredProjections: snapshot })
  }

  append(event: TerminalEvent): ProjectionIssue | undefined {
    if (!this.projection.append(event)) return this.projection.snapshot().issue
    return this.publishProjection()
  }

  rebuild(events: readonly TerminalEvent[]): ProjectionIssue | undefined {
    this.projection.rebuild(events)
    return this.publishProjection()
  }

  private publishProjection(): ProjectionIssue | undefined {
    const projected = this.projection.snapshot()
    const nodes = projected.nodes.slice(-this.maxEvents)
    const lines = nodes.map(node => node.kind === 'tool'
      ? `Tool: ${node.name === 'unknown' ? '' : `${node.name} `}${node.input}${node.output === '' ? '' : `\nResult: ${node.output}`}`
      : node.kind === 'user' ? `You: ${node.text}`
        : node.kind === 'reasoning' ? `Reasoning: ${node.text}`
          : node.kind === 'marker' ? `System: ${node.text}`
          : node.kind === 'turn' ? `Turn: ${node.text}`
            : node.text).flatMap(line => line.split('\n'))
    const next = { ...this.value, nodes, lines, transcriptRevision: this.value.transcriptRevision + 1 }
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
