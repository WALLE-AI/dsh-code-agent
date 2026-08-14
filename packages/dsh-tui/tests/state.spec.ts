import { describe, expect, it, vi } from 'vitest'
import { ApprovalQueue } from '../src/approval-queue.ts'
import { TuiStore } from '../src/state.ts'

describe('phase-zero terminal state', () => {
  it('keeps only the configured event tail', () => {
    const store = new TuiStore(2)
    store.append({ seq: 1, kind: 'user', text: 'one' })
    store.append({ seq: 2, kind: 'assistant-delta', text: 'two' })
    store.append({ seq: 3, kind: 'tool-call', text: 'three' })
    expect(store.snapshot().lines).toEqual(['two', 'Tool: three'])
  })

  it('publishes reference-stable snapshots only when state changes', () => {
    const store = new TuiStore(10)
    const listener = vi.fn()
    store.subscribe(listener)
    const before = store.snapshot()
    store.setStatus('running')
    expect(store.snapshot()).not.toBe(before)
    expect(listener).toHaveBeenCalledOnce()
  })
})

describe('approval queue', () => {
  it('answers once and advances FIFO prompts', async () => {
    const store = new TuiStore(10)
    const queue = new ApprovalQueue(store)
    const first = queue.ask({ toolName: 'bash', reason: 'write' })
    const second = queue.ask({ toolName: 'fs' })
    expect(store.snapshot().approval?.toolName).toBe('bash')
    queue.decide(true)
    expect(await first).toBe('allowed-once')
    expect(store.snapshot().approval?.toolName).toBe('fs')
    queue.decide(false)
    expect(await second).toBe('rejected')
  })

  it('settles abort and teardown without a hanging promise', async () => {
    const store = new TuiStore(10)
    const queue = new ApprovalQueue(store)
    const abort = new AbortController()
    const cancelled = queue.ask({ toolName: 'bash' }, abort.signal)
    abort.abort()
    expect(await cancelled).toBe('cancelled')
    const unavailable = queue.ask({ toolName: 'fs' })
    queue.close()
    expect(await unavailable).toBe('unavailable')
    expect(store.snapshot().approval).toBeUndefined()
  })
})
