import { describe, expect, it, vi } from 'vitest'
import {
  createHarnessAgentController,
  deliverSessionEvent,
  normalizeEvent,
  type HarnessContext,
  type HarnessHooks,
  type RuntimeEvent,
} from '../src/harness-adapter.ts'
import { TuiStore } from '../src/state.ts'

const known = new Set([
  'permission/preset',
  'tool/result',
])

describe('Harness session event normalization', () => {
  it('advances known log-only events without presenting them', () => {
    expect(normalizeEvent({
      seq: 1,
      type: 'permission/preset',
      data: { preset: 'workspace-write' },
    }, known)).toEqual({ seq: 1, kind: 'ignored', text: 'permission/preset' })
  })

  it('allows an unknown event only when its envelope marks it ignorable', () => {
    expect(normalizeEvent({ seq: 2, type: 'extension/info', data: {}, ignorable: true }, known))
      .toEqual({ seq: 2, kind: 'ignored', text: 'extension/info' })
    expect(normalizeEvent({ seq: 2, type: 'extension/required', data: {} }, known))
      .toMatchObject({ kind: 'unknown-required' })
  })

  it('pairs tool results through the canonical message call id and error field', () => {
    expect(normalizeEvent({
      seq: 3,
      type: 'tool/result',
      data: {
        message: { callId: 'call-1', content: [{ type: 'text', text: 'failed' }] },
        error: { name: 'ToolError', code: 'FAILED' },
      },
    }, known)).toEqual({
      seq: 3,
      kind: 'tool-result',
      callId: 'call-1',
      text: 'failed',
      failed: true,
    })
  })

  it('pairs persisted tool results through message.source.callId', () => {
    expect(normalizeEvent({
      seq: 6,
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'persisted-call' },
          content: [{
            type: 'tool-result', toolCallId: 'persisted-call', isError: true,
            content: [{ type: 'text', text: 'denied' }],
          }],
        },
        meta: { diffs: [{ path: 'a.ts', oldText: 'a', newText: 'b' }] },
      },
    }, known)).toEqual({
      seq: 6,
      kind: 'tool-result',
      callId: 'persisted-call',
      text: 'denied',
      failed: true,
      metadata: { diffs: [{ path: 'a.ts', oldText: 'a', newText: 'b' }] },
    })
  })

  it('normalizes real Code Mode child dispatches and nested tool failures', () => {
    expect(normalizeEvent({
      seq: 4,
      type: 'tool/code-dispatch-start',
      data: {
        rootCallId: 'root', parentCallId: 'root', subCallId: 'root:code:1',
        name: 'read', arguments: { file_path: 'missing.txt' },
      },
    }, known)).toEqual({
      seq: 4,
      kind: 'tool-call',
      callId: 'root:code:1',
      parentCallId: 'root',
      name: 'read',
      text: '{"file_path":"missing.txt"}',
    })
    expect(normalizeEvent({
      seq: 5,
      type: 'tool/code-dispatch',
      data: {
        subCallId: 'root:code:1', name: 'read', isError: true,
        content: [{ type: 'text', text: 'not found' }],
      },
    }, known)).toEqual({
      seq: 5,
      kind: 'tool-result',
      callId: 'root:code:1',
      text: 'not found',
      failed: true,
    })
  })

  it('recovers a skipped live delivery from the authoritative session event list', () => {
    const store = new TuiStore(20)
    const events: RuntimeEvent[] = [
      { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'one' }] } },
      { seq: 11, type: 'permission/preset', data: { preset: 'workspace-write' } },
      { seq: 12, type: 'assistant/message', data: { content: [{ type: 'text', text: 'two' }] } },
    ]
    const hooks = {
      event: store.append.bind(store),
      rebuild: store.rebuild.bind(store),
    }

    deliverSessionEvent({ events }, events[0] as RuntimeEvent, known, hooks)
    expect(deliverSessionEvent({ events }, events[2] as RuntimeEvent, known, hooks)).toBeUndefined()
    expect(store.snapshot().lines.map(line => line.text)).toEqual(['> one', '● two'])
    expect(store.snapshot().error).toBeUndefined()
  })

  it('stays paused when the authoritative session list is itself incomplete', () => {
    const store = new TuiStore(20)
    const first: RuntimeEvent = {
      seq: 3, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'one' }] },
    }
    const late: RuntimeEvent = {
      seq: 5, type: 'assistant/message', data: { content: [{ type: 'text', text: 'late' }] },
    }
    const hooks = {
      event: store.append.bind(store),
      rebuild: store.rebuild.bind(store),
    }

    deliverSessionEvent({ events: [first, late] }, first, known, hooks)
    expect(deliverSessionEvent({ events: [first, late] }, late, known, hooks)).toMatchObject({
      kind: 'gap',
      seq: 5,
    })
    expect(store.snapshot().error).toContain('expected event 4')
  })

  it('replaces a conflicting duplicate with the authoritative session event', () => {
    const store = new TuiStore(20)
    const stale: RuntimeEvent = {
      seq: 8, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'stale' }] },
    }
    const current: RuntimeEvent = {
      seq: 8, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'current' }] },
    }
    const hooks = {
      event: store.append.bind(store),
      rebuild: store.rebuild.bind(store),
    }

    deliverSessionEvent({ events: [stale] }, stale, known, hooks)
    expect(deliverSessionEvent({ events: [current] }, current, known, hooks)).toBeUndefined()
    expect(store.snapshot().lines.map(line => line.text)).toEqual(['> current'])
    expect(store.snapshot().error).toBeUndefined()
  })

  it('does not rebuild an unknown required event without supported semantics', () => {
    const store = new TuiStore(20)
    const rebuild = vi.fn(store.rebuild.bind(store))
    const event: RuntimeEvent = { seq: 1, type: 'extension/required', data: {} }

    expect(deliverSessionEvent({ events: [event] }, event, known, {
      event: store.append.bind(store),
      rebuild,
    })).toMatchObject({ kind: 'unknown-required' })
    expect(rebuild).not.toHaveBeenCalled()
  })

  it('binds create and resume to the real Harness service contract', async () => {
    const session = {
      id: 'fresh',
      seq: 1,
      events: [{
        seq: 0,
        type: 'user/message',
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'seed' }] },
      }] satisfies RuntimeEvent[],
    }
    const agent = {
      status: 'idle' as const,
      session,
      cancel: vi.fn(),
      whenIdle: vi.fn(async () => {}),
      followup: vi.fn(),
      steer: vi.fn(),
    }
    const dispose = vi.fn(async () => {})
    let createdOptions: Record<string, unknown> | undefined
    const create = vi.fn(async (options: Record<string, unknown>) => {
      createdOptions = options
      return { agent, dispose }
    })
    const resume = vi.fn(async () => ({ agent, dispose }))
    const flush = vi.fn(async () => true)
    const listCommands = vi.fn(() => [{ name: 'compact', description: 'Compact context' }])
    const executeCommand = vi.fn(async () => ({
      commandId: 'cmd-1', result: { kind: 'success' as const },
    }))
    let modelCommand: {
      handler(invocation: { agent: typeof agent; rawInput: string }): Promise<{
        kind: 'success' | 'error'; text?: string
      }> | { kind: 'success' | 'error'; text?: string }
    } | undefined
    const registerCommand = vi.fn((definition: typeof modelCommand) => {
      modelCommand = definition
      return vi.fn()
    })
    const getTool = vi.fn(() => ({ presentCall: () => ({ card: 'generic', title: 'Read file' }) }))
    const disposeProjection = vi.fn()
    let projectionListener:
      | ((target: typeof session, key: string, value: unknown, seq: number) => void)
      | undefined
    const projectionSnapshot = vi.fn((target: typeof session) => ({
      asOfSeq: target.seq - 1,
      values: { 'tool/todo': { items: [{ text: target.id }] } },
    }))
    const saveSelection = vi.fn(async () => {})
    const serviceValues = new Map<string, unknown>([
      ['loader', { await: vi.fn(async () => {}) }],
      ['agents', { create, resume }],
      ['agentDefaultModel', { currentSelection: () => ({
        provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high',
      }), saveSelection }],
      ['llm', {
        listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
        listModels: vi.fn(async () => [{
          provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro',
        }]),
        resolveModelInfo: vi.fn(async (provider: string, model: string) => ({
          provider, id: model, name: model,
        })),
      }],
      ['sessions', { flush }],
      ['sessionProjections', {
        snapshot: projectionSnapshot,
        onChanged: (listener: typeof projectionListener) => {
          projectionListener = listener
          return disposeProjection
        },
      }],
      ['commands', { list: listCommands, execute: executeCommand, register: registerCommand }],
      ['tools', { get: getTool }],
    ])
    const ctx: HarnessContext = {
      get: name => serviceValues.get(name),
      provide: (name, value) => { serviceValues.set(name, value) },
    }
    const hooks: HarnessHooks = {
      event: vi.fn(() => undefined),
      rebuild: vi.fn(() => undefined),
      projection: vi.fn(),
      status: vi.fn(),
      approval: vi.fn(async (): Promise<'allowed-once'> => 'allowed-once'),
      question: vi.fn(async () => ({ answers: [] })),
      diagnostic: vi.fn(),
    model: vi.fn(),
      ready: vi.fn(),
    }

    const created = await createHarnessAgentController(ctx, hooks)
    await created.create('fresh')
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'fresh',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      setup: expect.any(Function),
    }))
    created.followup('hello')
    expect(agent.followup).toHaveBeenCalledWith(expect.objectContaining({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hello' }],
    }))
    expect(created.listCommands()).toEqual([{ name: 'compact', description: 'Compact context' }])
    await expect(created.executeCommand('/compact', new AbortController().signal)).resolves.toMatchObject({
      commandId: 'cmd-1',
    })
    expect(listCommands).toHaveBeenCalledWith(agent)
    expect(executeCommand).toHaveBeenCalledWith(agent, '/compact', expect.any(AbortSignal))
    expect(created.presentTool({
      id: 'tool:read', kind: 'tool', callId: 'read', name: 'read', input: '{}', output: '',
      status: 'pending', firstSeq: 1, lastSeq: 1,
    })).toEqual({ call: { card: 'generic', title: 'Read file' } })
    expect(getTool).toHaveBeenCalledWith('read', agent)

    let questionProvider: { ask(request: Record<string, unknown>): Promise<unknown> } | undefined
    const setup = (createdOptions as { setup?: (scope: unknown) => void } | undefined)?.setup
    expect(setup).toBeTypeOf('function')
    setup?.({
      agent,
      get: (name: string) => name === 'userQuestions' ? {
        registerProvider: (provider: typeof questionProvider) => { questionProvider = provider; return vi.fn() },
      } : serviceValues.get(name),
      provide: vi.fn(),
      on: vi.fn(() => vi.fn()),
    })
    await expect(questionProvider?.ask({
      questions: [{ id: 'mode', question: 'Mode?' }], agent,
    })).resolves.toEqual({ answers: [] })
    expect(hooks.question).toHaveBeenCalledWith([{ id: 'mode', question: 'Mode?' }], undefined)
    expect(() => questionProvider?.ask({
      questions: [{ id: 'child', question: 'Blocked?' }], agent: { ...agent },
    })).toThrow('exact root TUI agent')
    expect(created.currentModel()).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high',
    })
    await expect(created.listModels()).resolves.toMatchObject({
      current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      providers: [{ id: 'deepseek-official', models: [{ id: 'deepseek-v4-pro' }] }],
      failures: [],
    })
    await expect(modelCommand?.handler({ agent, rawInput: 'info' })).resolves.toEqual({
      kind: 'success', text: 'Current model: deepseek-official/deepseek-v4-pro:high',
    })
    await expect(modelCommand?.handler({ agent, rawInput: 'deepseek-official/deepseek-v4-pro' }))
      .resolves.toMatchObject({ kind: 'success' })
    expect(created.currentModel()).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-pro',
    })
    saveSelection.mockRejectedValueOnce(new Error('settings unavailable'))
    await expect(modelCommand?.handler({
      agent, rawInput: 'save deepseek-official/future-model',
    })).resolves.toEqual({ kind: 'error', text: 'settings unavailable' })
    expect(created.currentModel()).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-pro',
    })
    await expect(created.flush()).resolves.toBe(true)
    expect(flush).toHaveBeenCalledWith(session)
    expect(hooks.projection).toHaveBeenCalledWith({
      asOfSeq: 0,
      values: { 'tool/todo': { items: [{ text: 'fresh' }] } },
    })
    const otherSession = { ...session, id: 'other' }
    projectionListener?.(otherSession, 'tool/todo', {}, 1)
    expect(hooks.projection).toHaveBeenCalledTimes(1)
    projectionListener?.(session, 'tool/todo', {}, 1)
    expect(hooks.projection).toHaveBeenLastCalledWith({
      asOfSeq: 0,
      values: { 'tool/todo': { items: [{ text: 'fresh' }] } },
    })
    await created.dispose()
    expect(disposeProjection).toHaveBeenCalledOnce()

    session.id = 'persisted'
    const resumed = await createHarnessAgentController(ctx, hooks)
    await resumed.resume('persisted')
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({
      resumeSessionId: 'persisted',
      setup: expect.any(Function),
    }))
    expect(hooks.rebuild).toHaveBeenCalledWith([
      expect.objectContaining({ seq: 0, kind: 'user', text: 'seed' }),
    ])
    await resumed.dispose()

    dispose.mockClear()
    disposeProjection.mockClear()
    const failingHooks: HarnessHooks = {
      ...hooks,
      projection: vi.fn(() => { throw new Error('projection observer failed') }),
    }
    const failing = await createHarnessAgentController(ctx, failingHooks)
    await expect(failing.create('rollback')).rejects.toThrow('projection observer failed')
    expect(disposeProjection).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    expect(failing.state).toBe('empty')
  })
})
