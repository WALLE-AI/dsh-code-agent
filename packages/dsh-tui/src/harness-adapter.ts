/**
 * The only source-level dependency on the mutable Harness checkout.
 * Runtime module locations and structural contracts are normalized here.
 */

import { randomUUID } from 'node:crypto'
import type { ApprovalDecision, AgentStatus, TerminalEvent } from './contracts.ts'

interface HarnessContext {
  get(name: string): unknown
  provide(name: string, value: unknown): void
}

interface RuntimeEvent {
  seq: number
  type: string
  data: Record<string, any>
}

interface AgentLike {
  status: AgentStatus
  session: { id: string; seq: number; events: RuntimeEvent[] }
  cancel(cause: { kind: 'user' }): void
  whenIdle(): Promise<void>
  followup(message: unknown): void
}

interface AgentContext extends HarnessContext {
  agent?: AgentLike
  on(name: string, callback: (...args: any[]) => unknown): void
}

interface AgentHandle { agent: AgentLike; dispose(): Promise<void> }

interface HarnessServices {
  agents: { create(options: Record<string, unknown>): Promise<AgentHandle> }
  defaultModel: { currentSelection(): { provider: string; model: string } }
  sessions: { flush(session: AgentLike['session']): Promise<boolean> }
}

export type { HarnessContext }

export interface HarnessHooks {
  event(event: TerminalEvent): void
  status(status: AgentStatus): void
  approval(input: { toolName: string; reason?: string }, signal?: AbortSignal): Promise<ApprovalDecision>
  ready(cancel: () => void): void
}

function upstream(relative: string): string {
  return new URL(`../../../opensource/deepseek-harness/deepseek-harness-master/${relative}`, import.meta.url).href
}

async function loadRuntime(): Promise<{
  installModelSelection(ctx: AgentContext, selection: unknown): void
  createUserMessage(input: unknown): unknown
  SessionId(id: string): string
}> {
  const [agent, llm, session] = await Promise.all([
    import(upstream('packages/core/agent/src/index.ts')),
    import(upstream('packages/llm/llm/src/index.ts')),
    import(upstream('packages/core/session/src/index.ts')),
  ])
  return {
    installModelSelection: agent.installModelSelection,
    createUserMessage: llm.createUserMessage,
    SessionId: session.SessionId,
  }
}

function services(ctx: HarnessContext): HarnessServices {
  const agents = ctx.get('agents') as HarnessServices['agents'] | undefined
  const defaultModel = ctx.get('agentDefaultModel') as HarnessServices['defaultModel'] | undefined
  const sessions = ctx.get('sessions') as HarnessServices['sessions'] | undefined
  if (agents === undefined || defaultModel === undefined || sessions === undefined) {
    throw new Error('Harness services did not settle: agents, agentDefaultModel, or sessions is missing')
  }
  return { agents, defaultModel, sessions }
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content.flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : []).join('')
}

function normalizeEvent(event: RuntimeEvent): TerminalEvent | undefined {
  const base = { seq: event.seq }
  switch (event.type) {
    case 'user/message':
      if (event.data.source?.kind !== 'user') return undefined
      return { ...base, kind: 'user', text: textOf(event.data.content) }
    case 'assistant/chunk': {
      const chunk = event.data.chunk
      if (chunk.type === 'text-delta') return { ...base, kind: 'assistant-delta', text: chunk.text }
      if (chunk.type === 'reasoning-delta') return { ...base, kind: 'reasoning-delta', text: chunk.text }
      return undefined
    }
    case 'tool/call': return { ...base, kind: 'tool-call', text: `${String(event.data.name)} ${String(event.data.arguments)}` }
    case 'tool/result': return { ...base, kind: 'tool-result', text: textOf(event.data.message.content[0].content) }
    case 'turn/end': {
      const reason = event.data.reason
      const detail = reason.kind === 'error'
        ? `error: ${String(reason.error?.code ?? 'UNKNOWN')} ${String(reason.error?.message ?? '')}`.trim()
        : String(reason.kind)
      return { ...base, kind: 'turn-end', text: detail }
    }
    default: return undefined
  }
}

function finalExitCode(events: readonly RuntimeEvent[], firstSeq: number): number {
  let reason: string | undefined
  for (const event of events) {
    if (event.seq >= firstSeq && event.type === 'turn/end') reason = event.data.reason.kind
  }
  return reason === 'completed' ? 0 : 1
}

/** Drive one task using public Harness services and retain ownership until durable teardown. */
export async function executeHarnessTask(ctx: HarnessContext, task: string, hooks: HarnessHooks): Promise<number> {
  const loader = ctx.get('loader') as { await(): Promise<void> } | undefined
  await loader?.await()
  const { agents, defaultModel, sessions } = services(ctx)
  const runtime = await loadRuntime()
  const selection = defaultModel.currentSelection()
  let handle: AgentHandle | undefined
  try {
    const created = await agents.create({
      sessionId: runtime.SessionId(`session-${randomUUID()}`),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx: AgentContext) => {
        runtime.installModelSelection(agentCtx, { current: selection, assembled: undefined })
        agentCtx.on('session/event', (_session: unknown, event: RuntimeEvent) => {
          const normalized = normalizeEvent(event)
          if (normalized !== undefined) hooks.event(normalized)
        })
        agentCtx.on('agent/status', ({ status }: { status: AgentStatus }) => { hooks.status(status) })
        agentCtx.on('approval/request', (
          request: { agent: AgentLike; toolName: string; reason?: string; signal?: AbortSignal },
          next: () => Promise<ApprovalDecision>,
        ) => {
          if (agentCtx.agent === undefined || request.agent !== agentCtx.agent) return next()
          return hooks.approval({
            toolName: request.toolName,
            ...(request.reason === undefined ? {} : { reason: request.reason }),
          }, request.signal)
        })
      },
    })
    handle = created
    hooks.ready(() => { created.agent.cancel({ kind: 'user' }) })
    hooks.status(created.agent.status)
    await created.agent.whenIdle()
    const firstSeq = created.agent.session.seq
    created.agent.followup(runtime.createUserMessage({
      content: [{ type: 'text', text: task }],
      source: { kind: 'user' },
    }))
    await created.agent.whenIdle()
    if (!await sessions.flush(created.agent.session)) {
      throw new Error(`no persistence listener flushed session ${created.agent.session.id}`)
    }
    return finalExitCode(created.agent.session.events, firstSeq)
  } finally {
    await handle?.dispose()
  }
}
