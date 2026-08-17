/**
 * A structural stand-in for the Harness services the TUI consumes. It mirrors
 * the shapes `harness-adapter.ts` reads, so composition-level tests can drive
 * the real plugin without a live Agent runtime.
 */

import { vi } from 'vitest'
import type { HarnessContext, HarnessHooks, RuntimeEvent } from '../../src/harness-adapter.ts'

export interface FakeHarnessOptions {
  readonly flush?: () => Promise<boolean>
  readonly turnReason?: string
  readonly commandResult?: 'success' | 'error' | 'missing'
  readonly sessions?: readonly {
    header: { id: string; createdAt: number; cwd?: string; origin?: string }
    live: boolean
    persisted: boolean
  }[]
  /** Status reported by the fake Agent, so steering can be exercised. */
  readonly status?: 'idle' | 'running'
}

export function fakeHarness(options: FakeHarnessOptions = {}) {
  const events: RuntimeEvent[] = []
  const session = { id: 'fake-session', seq: 0, events }
  const agent = {
    status: options.status ?? ('idle' as const),
    session,
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
    followup: vi.fn(() => {
      events.push({
        seq: session.seq++,
        type: 'turn/end',
        data: { reason: { kind: options.turnReason ?? 'completed' } },
      })
    }),
    steer: vi.fn(),
  }
  const dispose = vi.fn(async () => {})
  const flush = vi.fn(options.flush ?? (async () => true))
  const create = vi.fn(async () => ({ agent, dispose }))
  const resume = vi.fn(async () => ({ agent, dispose }))
  const execute = vi.fn(async () => {
    if (options.commandResult === 'missing') return undefined
    return {
      commandId: 'cmd-1',
      result: options.commandResult === 'error'
        ? { kind: 'error' as const, text: 'command rejected' }
        : { kind: 'success' as const },
    }
  })
  const listSessions = vi.fn(async () => options.sessions ?? [
    { header: { id: 'session-older', createdAt: 1_000, cwd: '/repo' }, live: false, persisted: true },
    { header: { id: 'session-newer', createdAt: 2_000, cwd: '/repo' }, live: false, persisted: true },
  ])
  const services = new Map<string, unknown>([
    ['loader', { await: async () => {} }],
    ['agents', { create, resume }],
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) }],
    ['sessions', { flush }],
    ['sessionProjections', { snapshot: () => ({ asOfSeq: 0, values: {} }), onChanged: () => () => {} }],
    ['sessionQuery', { listSessions }],
    ['commands', { list: () => [{ name: 'compact', description: 'Compact context' }], execute }],
    ['tools', { get: () => undefined }],
  ])
  const ctx: HarnessContext = {
    get: name => services.get(name),
    provide: (name, value) => { services.set(name, value) },
  }
  return { ctx, agent, dispose, flush, create, resume, execute, listSessions, services }
}

export function fakeHooks(overrides: Partial<HarnessHooks> = {}): HarnessHooks {
  return {
    event: vi.fn(() => undefined),
    rebuild: vi.fn(() => undefined),
    projection: vi.fn(),
    status: vi.fn(),
    approval: vi.fn(async () => 'rejected' as const),
    question: vi.fn(async () => ({ answers: [] })),
    diagnostic: vi.fn(),
    ready: vi.fn(),
  model: vi.fn(),
    ...overrides,
  }
}
