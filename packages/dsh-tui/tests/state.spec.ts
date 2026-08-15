import { describe, expect, it, vi } from 'vitest'
import { ApprovalQueue } from '../src/approval-queue.ts'
import { QuestionQueue } from '../src/question-queue.ts'
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

  it('carries registered session projections without rendering policy', () => {
    const store = new TuiStore(10)
    store.setRegisteredProjections({ asOfSeq: 4, values: { 'tool/todo': { items: ['ship'] } } })
    expect(store.snapshot().registeredProjections).toEqual({
      asOfSeq: 4,
      values: { 'tool/todo': { items: ['ship'] } },
    })
    expect(store.snapshot().lines).toEqual([])
  })

  it('publishes a detached command catalog', () => {
    const store = new TuiStore(10)
    const commands = [{ name: 'compact', description: 'Compact context' }]
    store.setCommands(commands)
    commands[0] = { name: 'mutated', description: 'Wrong' }
    expect(store.snapshot().commands).toEqual([{ name: 'compact', description: 'Compact context' }])
  })

  it('rebuilds and bounds a 10000-event transcript', () => {
    const store = new TuiStore(10_000)
    const events = Array.from({ length: 10_000 }, (_, seq) => ({
      seq,
      kind: 'user' as const,
      text: `line-${String(seq)}`,
    }))
    expect(store.rebuild(events)).toBeUndefined()
    expect(store.snapshot()).toMatchObject({ transcriptRevision: 1 })
    expect(store.snapshot().lines).toHaveLength(10_000)
    expect(store.snapshot().lines.at(-1)).toBe('You: line-9999')
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

describe('question queue', () => {
  it('answers structured questions once and advances FIFO prompts', async () => {
    const store = new TuiStore(10)
    const queue = new QuestionQueue(store)
    const first = queue.ask([{ id: 'mode', question: 'Mode?', options: [{ label: 'Fast' }] }])
    const second = queue.ask([{ id: 'note', question: 'Note?' }])
    expect(store.snapshot().question?.questions[0]?.id).toBe('mode')
    queue.answer({ answers: [{ id: 'mode', selected: ['Fast'] }] })
    await expect(first).resolves.toEqual({ answers: [{ id: 'mode', selected: ['Fast'] }] })
    expect(store.snapshot().question?.questions[0]?.id).toBe('note')
    queue.answer({ answers: [{ id: 'note', selected: [], custom: 'ship it' }] })
    await expect(second).resolves.toEqual({ answers: [{ id: 'note', selected: [], custom: 'ship it' }] })
  })

  it('rejects abort and teardown without leaving a prompt', async () => {
    const store = new TuiStore(10)
    const queue = new QuestionQueue(store)
    const abort = new AbortController()
    const cancelled = queue.ask([{ id: 'a', question: 'A?' }], abort.signal)
    abort.abort()
    await expect(cancelled).rejects.toThrow('aborted')
    const unavailable = queue.ask([{ id: 'b', question: 'B?' }])
    queue.close()
    await expect(unavailable).rejects.toThrow('unavailable')
    expect(store.snapshot().question).toBeUndefined()
  })

  it('keeps the prompt pending when an answer is incomplete or invalid', async () => {
    const store = new TuiStore(10)
    const queue = new QuestionQueue(store)
    const answer = queue.ask([
      { id: 'mode', question: 'Mode?', options: [{ label: 'Fast' }, { label: 'Careful' }] },
      { id: 'note', question: 'Note?' },
    ])
    expect(() => queue.answer({ answers: [{ id: 'mode', selected: ['Unknown'] }] }))
      .toThrow('cover every requested question')
    expect(() => queue.answer({ answers: [
      { id: 'mode', selected: ['Unknown'] },
      { id: 'note', selected: [], custom: 'ok' },
    ] })).toThrow('invalid option')
    expect(store.snapshot().question).toBeDefined()
    queue.answer({ answers: [
      { id: 'mode', selected: ['Fast'] },
      { id: 'note', selected: [], custom: 'ok' },
    ] })
    await expect(answer).resolves.toEqual({ answers: [
      { id: 'mode', selected: ['Fast'] },
      { id: 'note', selected: [], custom: 'ok' },
    ] })
  })
})
