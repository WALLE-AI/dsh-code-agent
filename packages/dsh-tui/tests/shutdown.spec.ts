import { describe, expect, it, vi } from 'vitest'
import { exitCodeFor, ShutdownCoordinator } from '../src/shutdown.ts'

function steps(whenIdle: () => Promise<void>, order: string[]) {
  return {
    stopInput: vi.fn(() => { order.push('stopInput') }),
    settleInteractions: vi.fn(() => { order.push('settleInteractions') }),
    cancel: vi.fn(() => { order.push('cancel') }),
    whenIdle: vi.fn(() => { order.push('whenIdle'); return whenIdle() }),
    finish: vi.fn(() => { order.push('finish') }),
  }
}

describe('bounded shutdown', () => {
  it('runs the ordered sequence exactly once for concurrent requests', async () => {
    const order: string[] = []
    const plan = steps(async () => {}, order)
    const coordinator = new ShutdownCoordinator(plan, { graceMs: 50 })
    await Promise.all([
      coordinator.request('quit'),
      coordinator.request('signal'),
      coordinator.request('cancel'),
    ])
    await coordinator.request('quit')
    expect(order).toEqual(['stopInput', 'settleInteractions', 'cancel', 'whenIdle', 'finish'])
    expect(coordinator.reason).toBe('quit')
    expect(coordinator.requested).toBe(true)
    expect(coordinator.cancelTimedOut).toBe(false)
  })

  it('continues teardown when the Agent misses the grace window', async () => {
    const order: string[] = []
    const plan = steps(() => new Promise<void>(() => {}), order)
    const coordinator = new ShutdownCoordinator(plan, {
      graceMs: 10,
      delay: async () => 'timeout' as const,
    })
    await coordinator.request('signal')
    expect(coordinator.cancelTimedOut).toBe(true)
    expect(plan.finish).toHaveBeenCalledOnce()
  })

  it('keeps going when a step throws and reports it', async () => {
    const order: string[] = []
    const plan = steps(async () => {}, order)
    plan.cancel.mockImplementation(() => { throw new Error('cancel exploded') })
    const onStep = vi.fn()
    const coordinator = new ShutdownCoordinator(plan, { graceMs: 10, onStep })
    await coordinator.request('error')
    expect(plan.finish).toHaveBeenCalledOnce()
    expect(onStep).toHaveBeenCalledWith('cancel-failed', 'cancel exploded')
  })

  it('maps reasons to exit codes without hiding a task failure', () => {
    expect(exitCodeFor('cancel', 0)).toBe(130)
    expect(exitCodeFor('signal', 0)).toBe(130)
    expect(exitCodeFor('quit', 0)).toBe(0)
    expect(exitCodeFor('quit', 74)).toBe(74)
    expect(exitCodeFor(undefined, 1)).toBe(1)
    expect(exitCodeFor('error', 0)).toBe(1)
  })
})
