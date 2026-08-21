import { randomUUID } from 'node:crypto'
import type {
  AgentCancelCause,
  AgentStatus,
  RegisteredProjectionSnapshot,
  TerminalEvent,
  ToolNode,
  ToolPresentation,
  TuiCommandDescriptor,
  TuiCommandExecution,
} from './contracts.ts'
import type { TuiModelDirectory, TuiModelSelection } from './model-selection.ts'

export interface ControlledSession {
  readonly id: string
  readonly seq: number
  readonly events: readonly TerminalEvent[]
  readonly registeredProjections: RegisteredProjectionSnapshot
}

export interface ControlledAgentHandle {
  readonly status: AgentStatus
  readonly session: ControlledSession
  followup(text: string): void
  steer(text: string): void
  cancel(cause: AgentCancelCause): void
  whenIdle(): Promise<void>
  flush(): Promise<boolean>
  listCommands(): readonly TuiCommandDescriptor[]
  executeCommand(line: string, signal: AbortSignal): Promise<TuiCommandExecution | undefined>
  currentModel(): TuiModelSelection
  listModels(signal?: AbortSignal): Promise<TuiModelDirectory>
  presentTool(node: ToolNode): ToolPresentation
  dispose(): Promise<void>
}

export interface AgentControllerPort {
  create(sessionId: string): Promise<ControlledAgentHandle>
  resume(sessionId: string): Promise<ControlledAgentHandle>
}

export type AgentControllerState = 'empty' | 'attaching' | 'active' | 'disposed'

/** Own exactly one Harness agent handle while keeping upstream types behind a port. */
export class AgentController {
  private currentState: AgentControllerState = 'empty'
  private handle: ControlledAgentHandle | undefined
  private attachment: Promise<ControlledAgentHandle> | undefined
  private disposal: Promise<void> | undefined

  constructor(private readonly port: AgentControllerPort) {}

  get state(): AgentControllerState { return this.currentState }
  get status(): AgentStatus | undefined { return this.handle?.status }
  get session(): ControlledSession | undefined { return this.handle?.session }

  create(sessionId = `session-${randomUUID()}`): Promise<string> {
    return this.attach('create', sessionId)
  }

  resume(sessionId: string): Promise<string> {
    if (sessionId.trim() === '') throw new Error('resume session id must not be empty')
    return this.attach('resume', sessionId)
  }

  followup(text: string): void { this.active('followup').followup(text) }
  steer(text: string): void { this.active('steer').steer(text) }
  cancel(cause: AgentCancelCause): void { this.active('cancel').cancel(cause) }
  whenIdle(): Promise<void> { return this.active('whenIdle').whenIdle() }
  flush(): Promise<boolean> { return this.active('flush').flush() }
  listCommands(): readonly TuiCommandDescriptor[] { return this.active('listCommands').listCommands() }
  executeCommand(line: string, signal: AbortSignal): Promise<TuiCommandExecution | undefined> {
    return this.active('executeCommand').executeCommand(line, signal)
  }
  currentModel(): TuiModelSelection { return this.active('currentModel').currentModel() }
  listModels(signal?: AbortSignal): Promise<TuiModelDirectory> {
    return this.active('listModels').listModels(signal)
  }
  presentTool(node: ToolNode): ToolPresentation { return this.active('presentTool').presentTool(node) }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposal = this.disposeOwnedHandle()
    return this.disposal
  }

  private async attach(kind: 'create' | 'resume', sessionId: string): Promise<string> {
    if (this.currentState !== 'empty') {
      throw new Error(`cannot ${kind} while AgentController is ${this.currentState}`)
    }
    this.currentState = 'attaching'
    let attachment: Promise<ControlledAgentHandle>
    try {
      attachment = this.port[kind](sessionId)
    } catch (error) {
      this.currentState = 'empty'
      throw error
    }
    this.attachment = attachment
    try {
      const handle = await attachment
      if (this.state === 'disposed') {
        throw new Error(`AgentController was disposed while ${kind} was attaching`)
      }
      this.handle = handle
      this.currentState = 'active'
      return handle.session.id
    } catch (error) {
      if (this.state !== 'disposed') this.currentState = 'empty'
      throw error
    } finally {
      this.attachment = undefined
    }
  }

  private active(operation: string): ControlledAgentHandle {
    if (this.currentState !== 'active' || this.handle === undefined) {
      throw new Error(`cannot ${operation} while AgentController is ${this.currentState}`)
    }
    return this.handle
  }

  private async disposeOwnedHandle(): Promise<void> {
    const attachment = this.attachment
    const handle = this.handle
    this.handle = undefined
    this.currentState = 'disposed'
    if (handle !== undefined) {
      await handle.dispose()
      return
    }
    if (attachment === undefined) return
    let attached: ControlledAgentHandle
    try {
      attached = await attachment
    } catch {
      // A failed attachment owns no live handle.
      return
    }
    await attached.dispose()
  }
}
