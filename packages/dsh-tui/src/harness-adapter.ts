/**
 * The only source-level dependency on the mutable Harness checkout.
 * Runtime module locations and structural contracts are normalized here.
 */

import { randomUUID } from 'node:crypto'
import { AgentController, type AgentControllerPort, type ControlledAgentHandle } from './agent-controller.ts'
import type {
  AgentCancelCause,
  ApprovalDecision,
  AgentStatus,
  ProjectionIssue,
  QuestionAnswer,
  QuestionItem,
  RegisteredProjectionSnapshot,
  TerminalEvent,
  ToolNode,
  ToolPresentation,
  TuiCommandDescriptor,
  TuiCommandExecution,
} from './contracts.ts'
import type { TuiSessionSummary } from './session-selector.ts'
import { presentTool } from './tool-presentation.ts'

interface HarnessContext {
  get(name: string): unknown
  provide(name: string, value: unknown): void
}

export interface RuntimeEvent {
  seq: number
  type: string
  data: Record<string, any>
  ignorable?: true
}

interface AgentLike {
  status: AgentStatus
  session: { id: string; seq: number; events: RuntimeEvent[] }
  cancel(cause: AgentCancelCause): void
  whenIdle(): Promise<void>
  followup(message: unknown): void
  steer(message: unknown): void
}

interface AgentContext extends HarnessContext {
  agent?: AgentLike
  on(name: string, callback: (...args: any[]) => unknown): void
}

interface AgentHandle { agent: AgentLike; dispose(): Promise<void> }

interface HarnessServices {
  agents: {
    create(options: Record<string, unknown>): Promise<AgentHandle>
    resume(options: Record<string, unknown>): Promise<AgentHandle>
  }
  defaultModel: { currentSelection(): { provider: string; model: string } }
  sessions: { flush(session: AgentLike['session']): Promise<boolean> }
  projections: {
    snapshot(session: AgentLike['session']): { asOfSeq: number; values: Record<string, unknown> }
    onChanged(listener: (
      session: AgentLike['session'], key: string, value: unknown, seq: number,
    ) => void): () => void
  }
  commands: {
    list(agent: AgentLike): readonly TuiCommandDescriptor[]
    execute(agent: AgentLike, line: string, signal: AbortSignal): Promise<TuiCommandExecution | undefined>
  }
  tools: {
    get(name: string, scope?: AgentLike): {
      presentCall?(args: unknown): unknown
      presentResult?(args: unknown, result: unknown): unknown
    } | undefined
  }
}

export type { HarnessContext }

export interface HarnessHooks {
  event(event: TerminalEvent): ProjectionIssue | undefined
  rebuild(events: readonly TerminalEvent[]): ProjectionIssue | undefined
  projection(snapshot: RegisteredProjectionSnapshot): void
  status(status: AgentStatus): void
  approval(
    input: { toolName: string; reason?: string; callId?: string },
    signal?: AbortSignal,
  ): Promise<ApprovalDecision>
  question(questions: readonly QuestionItem[], signal?: AbortSignal): Promise<QuestionAnswer>
  /** Report a diagnosable runtime fault that the user must see. */
  diagnostic(message: string): void
  ready(controls: TuiSessionControls): void
}

/** Live capabilities handed to the view once the Agent is attached. */
export interface TuiSessionControls {
  cancel(): void
  whenIdle(): Promise<void>
  presentTool(node: ToolNode): ToolPresentation
}

/** Exit code used when the session could not be made durable before exit. */
export const NOT_DURABLE_EXIT_CODE = 74

function upstream(relative: string): string {
  return new URL(`../../../opensource/deepseek-harness/${relative}`, import.meta.url).href
}

/**
 * Resolve one upstream module. An installed profile resolves the published
 * package; the pinned source checkout is the development fallback, so both
 * layouts load the same module instance the running Agent uses.
 */
async function loadUpstreamModule(
  specifier: string,
  sourcePath: string,
): Promise<Record<string, unknown>> {
  try {
    return await import(specifier) as Record<string, unknown>
  } catch (error) {
    try {
      return await import(upstream(sourcePath)) as Record<string, unknown>
    } catch (fallbackError) {
      throw new AggregateError(
        [error, fallbackError],
        `cannot load upstream module ${specifier}; neither the installed package nor the pinned checkout resolved`,
      )
    }
  }
}

async function loadRuntime(): Promise<{
  installModelSelection(ctx: AgentContext, selection: unknown): void
  createUserMessage(input: unknown): unknown
  SessionId(id: string): string
  knownSessionEventTypes: ReadonlySet<string>
}> {
  const [agent, llm, session] = await Promise.all([
    loadUpstreamModule('@deepseek-ai/dsh-agent', 'packages/core/agent/src/index.ts'),
    loadUpstreamModule('@deepseek-ai/dsh-llm', 'packages/llm/llm/src/index.ts'),
    loadUpstreamModule('@deepseek-ai/dsh-session', 'packages/core/session/src/index.ts'),
  ]) as [Record<string, any>, Record<string, any>, Record<string, any>]
  return {
    installModelSelection: agent.installModelSelection,
    createUserMessage: llm.createUserMessage,
    SessionId: session.SessionId,
    knownSessionEventTypes: session.KNOWN_SESSION_EVENT_TYPES,
  }
}

function services(ctx: HarnessContext): HarnessServices {
  const agents = ctx.get('agents') as HarnessServices['agents'] | undefined
  const defaultModel = ctx.get('agentDefaultModel') as HarnessServices['defaultModel'] | undefined
  const sessions = ctx.get('sessions') as HarnessServices['sessions'] | undefined
  const projections = ctx.get('sessionProjections') as HarnessServices['projections'] | undefined
  const commands = ctx.get('commands') as HarnessServices['commands'] | undefined
  const tools = ctx.get('tools') as HarnessServices['tools'] | undefined
  if (agents === undefined || defaultModel === undefined || sessions === undefined || projections === undefined
    || commands === undefined || tools === undefined) {
    throw new Error(
      'Harness services did not settle: agents, agentDefaultModel, sessions, sessionProjections, commands, or tools is missing',
    )
  }
  return { agents, defaultModel, sessions, projections, commands, tools }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.flatMap((block: unknown) => {
    if (typeof block !== 'object' || block === null) return []
    const value = block as { type?: unknown; text?: unknown; content?: unknown }
    if (value.type === 'text' && typeof value.text === 'string') return [value.text]
    return value.content === undefined ? [] : [textOf(value.content)]
  }).join('')
}

interface RuntimeSession {
  events: RuntimeEvent[]
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? structuredClone(value as Record<string, unknown>)
    : undefined
}

function resultFailed(data: Record<string, any>): boolean {
  if (data.error !== undefined || data.isError === true || data.failed === true) return true
  return Array.isArray(data.message?.content)
    && data.message.content.some((block: unknown) => recordOf(block)?.isError === true)
}

export function normalizeEvent(event: RuntimeEvent, knownEventTypes: ReadonlySet<string>): TerminalEvent {
  const base = { seq: event.seq }
  switch (event.type) {
    case 'user/message':
      if (event.data.source?.kind !== 'user') return { ...base, kind: 'ignored', text: event.type }
      const messageId = optionalString(event.data.id)
      return {
        ...base,
        kind: 'user',
        text: textOf(event.data.content),
        ...(messageId === undefined ? {} : { messageId }),
      }
    case 'assistant/chunk': {
      const chunk = event.data.chunk
      const messageId = optionalString(event.data.messageId ?? chunk.messageId)
      if (chunk.type === 'text-delta') return {
        ...base, kind: 'assistant-delta', text: String(chunk.text ?? ''),
        ...(messageId === undefined ? {} : { messageId }),
      }
      if (chunk.type === 'reasoning-delta') return {
        ...base, kind: 'reasoning-delta', text: String(chunk.text ?? ''),
        ...(messageId === undefined ? {} : { messageId }),
      }
      return { ...base, kind: 'ignored', text: event.type }
    }
    case 'assistant/message': {
      const messageId = optionalString(event.data.id ?? event.data.message?.id)
      return {
        ...base,
        kind: 'assistant-final',
        text: textOf(event.data.content ?? event.data.message?.content),
        ...(messageId === undefined ? {} : { messageId }),
      }
    }
    case 'tool/call': {
      const callId = optionalString(event.data.callId ?? event.data.toolCallId ?? event.data.id)
      const parentCallId = optionalString(event.data.parentCallId)
      return {
        ...base,
        kind: 'tool-call',
        text: String(event.data.arguments ?? ''),
        name: String(event.data.name ?? 'unknown'),
        ...(callId === undefined ? {} : { callId }),
        ...(parentCallId === undefined ? {} : { parentCallId }),
      }
    }
    case 'tool/result': {
      const callId = optionalString(
        event.data.callId
        ?? event.data.toolCallId
        ?? event.data.message?.source?.callId
        ?? event.data.message?.callId
        ?? event.data.id,
      )
      const metadata = recordOf(event.data.meta ?? event.data.message?.meta)
      return {
        ...base,
        kind: 'tool-result',
        text: textOf(event.data.message?.content ?? event.data.content),
        ...(callId === undefined ? {} : { callId }),
        ...(resultFailed(event.data) ? { failed: true } : {}),
        ...(metadata === undefined ? {} : { metadata }),
      }
    }
    case 'tool/code-dispatch-start': {
      const callId = optionalString(event.data.subCallId)
      const parentCallId = optionalString(event.data.parentCallId ?? event.data.rootCallId)
      return {
        ...base,
        kind: 'tool-call',
        text: JSON.stringify(event.data.arguments ?? {}),
        name: String(event.data.name ?? 'unknown'),
        ...(callId === undefined ? {} : { callId }),
        ...(parentCallId === undefined ? {} : { parentCallId }),
      }
    }
    case 'tool/code-dispatch': {
      const callId = optionalString(event.data.subCallId)
      return {
        ...base,
        kind: 'tool-result',
        text: textOf(event.data.content),
        ...(callId === undefined ? {} : { callId }),
        ...(event.data.isError === true ? { failed: true } : {}),
      }
    }
    case 'compaction/end':
      return { ...base, kind: 'marker', text: 'Conversation compacted' }
    case 'approval/decided':
      return {
        ...base,
        kind: 'marker',
        text: `Approval ${String(event.data.outcome ?? 'decided')}`,
      }
    case 'turn/end': {
      const reason = event.data.reason
      const detail = reason.kind === 'error'
        ? `error: ${String(reason.error?.code ?? 'UNKNOWN')} ${String(reason.error?.message ?? '')}`.trim()
        : String(reason.kind)
      return { ...base, kind: 'turn-end', text: detail }
    }
    case 'session/end-seed':
    case 'step/start':
    case 'step/end':
      return { ...base, kind: 'ignored', text: event.type }
    default:
      if (knownEventTypes.has(event.type) || event.ignorable === true) {
        return { ...base, kind: 'ignored', text: event.type }
      }
      return {
        ...base,
        kind: 'unknown-required',
        text: `unrecognized required session event type: ${event.type}`,
      }
  }
}

/** Deliver one live event and recover projection ordering faults from the authoritative session log. */
export function deliverSessionEvent(
  session: RuntimeSession,
  event: RuntimeEvent,
  knownEventTypes: ReadonlySet<string>,
  hooks: Pick<HarnessHooks, 'event' | 'rebuild'>,
): ProjectionIssue | undefined {
  const issue = hooks.event(normalizeEvent(event, knownEventTypes))
  if (issue?.kind !== 'gap' && issue?.kind !== 'duplicate-conflict') return issue
  return hooks.rebuild(session.events.map(item => normalizeEvent(item, knownEventTypes)))
}

function userMessage(runtime: Awaited<ReturnType<typeof loadRuntime>>, text: string): unknown {
  return runtime.createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

function setupAgent(
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
  selection: unknown,
  hooks: HarnessHooks,
): (agentCtx: AgentContext) => void {
  return (agentCtx) => {
    runtime.installModelSelection(agentCtx, { current: selection, assembled: undefined })
    const questions = agentCtx.get('userQuestions') as {
      registerProvider(provider: { ask(request: {
        questions: readonly QuestionItem[]
        agent?: AgentLike
        signal?: AbortSignal
      }): Promise<QuestionAnswer> }): () => void
    } | undefined
    if (questions === undefined) throw new Error('Harness userQuestions service is missing in agent setup')
    questions.registerProvider({
      ask: request => {
        if (agentCtx.agent === undefined || request.agent !== agentCtx.agent) {
          throw new Error('human questions are available only to the exact root TUI agent')
        }
        return hooks.question(request.questions, request.signal)
      },
    })
    agentCtx.on('session/event', (session: RuntimeSession, event: RuntimeEvent) => {
      deliverSessionEvent(session, event, runtime.knownSessionEventTypes, hooks)
    })
    agentCtx.on('agent/status', ({ status }: { status: AgentStatus }) => { hooks.status(status) })
    agentCtx.on('approval/request', (
      request: {
        agent: AgentLike
        toolName: string
        reason?: string
        callId?: string
        signal?: AbortSignal
      },
      next: () => Promise<ApprovalDecision>,
    ) => {
      if (agentCtx.agent === undefined || request.agent !== agentCtx.agent) return next()
      return hooks.approval({
        toolName: request.toolName,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        ...(request.callId === undefined ? {} : { callId: request.callId }),
      }, request.signal)
    })
  }
}

async function disposeHarnessHandle(
  disposeProjection: (() => void) | undefined,
  upstreamHandle: AgentHandle,
): Promise<void> {
  const errors: unknown[] = []
  try {
    disposeProjection?.()
  } catch (error) {
    errors.push(error)
  }
  try {
    await upstreamHandle.dispose()
  } catch (error) {
    errors.push(error)
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'projection and agent teardown both failed')
}

async function controlledHandle(
  upstreamHandle: AgentHandle,
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
  services: HarnessServices,
  hooks: HarnessHooks,
): Promise<ControlledAgentHandle> {
  const { agent } = upstreamHandle
  const readProjections = (): RegisteredProjectionSnapshot => {
    const snapshot = services.projections.snapshot(agent.session)
    return Object.freeze({
      asOfSeq: snapshot.asOfSeq,
      values: Object.freeze(structuredClone(snapshot.values)),
    })
  }
  let disposeProjection: (() => void) | undefined
  try {
    disposeProjection = services.projections.onChanged((session) => {
      if (session === agent.session) hooks.projection(readProjections())
    })
    hooks.rebuild(agent.session.events.map(event => normalizeEvent(event, runtime.knownSessionEventTypes)))
    hooks.projection(readProjections())
    hooks.status(agent.status)
  } catch (error) {
    try {
      await disposeHarnessHandle(disposeProjection, upstreamHandle)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'agent projection initialization and rollback both failed')
    }
    throw error
  }
  return {
    get status() { return agent.status },
    get session() {
      return {
        id: agent.session.id,
        seq: agent.session.seq,
        events: agent.session.events.map(event => normalizeEvent(event, runtime.knownSessionEventTypes)),
        registeredProjections: readProjections(),
      }
    },
    followup: text => { agent.followup(userMessage(runtime, text)) },
    steer: text => { agent.steer(userMessage(runtime, text)) },
    cancel: cause => { agent.cancel(cause) },
    whenIdle: () => agent.whenIdle(),
    flush: () => services.sessions.flush(agent.session),
    listCommands: () => services.commands.list(agent),
    executeCommand: (line, signal) => services.commands.execute(agent, line, signal),
    presentTool: node => presentTool(node, services.tools.get(node.name, agent)),
    dispose: () => disposeHarnessHandle(disposeProjection, upstreamHandle),
  }
}

/** A `--model` override applied to this run only; the stored default is untouched. */
export interface ModelOverride {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

/** Create a reusable upstream-neutral controller backed by the live Harness services. */
export async function createHarnessAgentController(
  ctx: HarnessContext,
  hooks: HarnessHooks,
  override?: ModelOverride,
): Promise<AgentController> {
  const loader = ctx.get('loader') as { await(): Promise<void> } | undefined
  await loader?.await()
  const harnessServices = services(ctx)
  const runtime = await loadRuntime()
  const selection = { ...harnessServices.defaultModel.currentSelection(), ...override }
  const setup = setupAgent(runtime, selection, hooks)
  const options = (identity: Record<string, unknown>): Record<string, unknown> => ({
    ...identity,
    agentOptions: { provider: selection.provider, model: selection.model },
    setup,
  })
  const port: AgentControllerPort = {
    create: async (sessionId) => controlledHandle(await harnessServices.agents.create(options({
      sessionId: runtime.SessionId(sessionId),
      meta: { cwd: process.cwd() },
    })), runtime, harnessServices, hooks),
    resume: async (sessionId) => controlledHandle(await harnessServices.agents.resume(options({
      resumeSessionId: runtime.SessionId(sessionId),
    })), runtime, harnessServices, hooks),
  }
  return new AgentController(port)
}

/** List the sessions the resume selector may offer, via the official query service. */
export async function listHarnessSessions(
  ctx: HarnessContext,
  signal?: AbortSignal,
): Promise<readonly TuiSessionSummary[]> {
  const query = ctx.get('sessionQuery') as {
    listSessions(signal?: AbortSignal): Promise<readonly {
      header: { id: string; createdAt: number; cwd?: string; origin?: string }
      live: boolean
      persisted: boolean
    }[]>
  } | undefined
  if (query === undefined) throw new Error('Harness sessionQuery service is missing; cannot list sessions')
  const records = await query.listSessions(signal)
  return records.map(record => ({
    id: String(record.header.id),
    createdAt: record.header.createdAt,
    live: record.live,
    persisted: record.persisted,
    ...(record.header.cwd === undefined ? {} : { cwd: record.header.cwd }),
    ...(record.header.origin === undefined ? {} : { origin: record.header.origin }),
  }))
}

/** One TUI run: a new or resumed session, an optional preset, and an optional first task. */
export interface HarnessRunRequest {
  readonly task?: string
  readonly resumeSessionId?: string
  readonly permissionPreset?: string
  readonly model?: ModelOverride
}

/** Drive one run using public Harness services and retain ownership until durable teardown. */
export async function executeHarnessTask(
  ctx: HarnessContext,
  request: HarnessRunRequest,
  hooks: HarnessHooks,
  continueSession?: (controller: AgentController) => Promise<void>,
): Promise<number> {
  const controller = await createHarnessAgentController(ctx, hooks, request.model)
  let code = 1
  const session = async (): Promise<number> => {
    if (request.resumeSessionId === undefined) await controller.create(`session-${randomUUID()}`)
    else await controller.resume(request.resumeSessionId)
    hooks.ready({
      cancel: () => { controller.cancel({ kind: 'user' }) },
      whenIdle: () => controller.whenIdle(),
      presentTool: node => controller.presentTool(node),
    })
    await controller.whenIdle()
    if (request.permissionPreset !== undefined) {
      const outcome = await controller.executeCommand(
        `/permission ${request.permissionPreset}`,
        new AbortController().signal,
      )
      if (outcome === undefined || outcome.result.kind === 'error') {
        throw new Error(`permission preset ${request.permissionPreset} was rejected by the Harness command`)
      }
    }
    const task = request.task?.trim() ?? ''
    if (task !== '') {
      const firstSeq = controller.session?.seq ?? 0
      controller.followup(task)
      await controller.whenIdle()
      if (!await controller.flush()) {
        throw new Error(`no persistence listener flushed session ${controller.session?.id ?? 'unknown'}`)
      }
      const events = controller.session?.events ?? []
      let reason: string | undefined
      for (const event of events) {
        if (event.seq >= firstSeq && event.kind === 'turn-end') reason = event.text
      }
      if (reason !== 'completed') return 1
    } else if (!await controller.flush()) {
      throw new Error(`no persistence listener flushed session ${controller.session?.id ?? 'unknown'}`)
    }
    await continueSession?.(controller)
    return 0
  }
  try {
    code = await session()
  } finally {
    // Durability is settled before the handle removes the live session.
    if (controller.state === 'active') {
      try {
        if (!await controller.flush()) {
          hooks.diagnostic('session was not flushed: no persistence listener participated')
          if (code === 0) code = NOT_DURABLE_EXIT_CODE
        }
      } catch (error) {
        hooks.diagnostic(`session flush failed: ${error instanceof Error ? error.message : String(error)}`)
        if (code === 0) code = NOT_DURABLE_EXIT_CODE
      }
    }
    await controller.dispose()
  }
  return code
}
