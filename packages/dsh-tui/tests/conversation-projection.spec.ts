import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConversationProjection } from '../src/conversation-projection.ts'
import type { TerminalEvent, ToolNode } from '../src/contracts.ts'

const fixture = JSON.parse(readFileSync(
  join(import.meta.dirname, 'fixtures/conversation-events.json'),
  'utf8',
)) as TerminalEvent[]

describe('conversation projection', () => {
  it('produces the same snapshot from a seed fold and live events', () => {
    const seeded = new ConversationProjection()
    seeded.rebuild(fixture)
    const live = new ConversationProjection()
    for (const event of fixture) live.append(event)

    expect(live.snapshot()).toEqual(seeded.snapshot())
    expect(live.snapshot().status).toBe('healthy')
    expect(live.snapshot().nodes.find(node => node.id === 'assistant:a1')).toMatchObject({
      kind: 'assistant',
      text: 'Fixed the test.',
      firstSeq: 11,
      lastSeq: 22,
    })
    const tools = live.snapshot().nodes.filter((node): node is ToolNode => node.kind === 'tool')
    expect(tools.map(tool => [tool.callId, tool.status])).toEqual([
      ['shell-1', 'failed'],
      ['read-1', 'succeeded'],
      ['diff-1', 'succeeded'],
    ])
    expect(tools[1]?.parentCallId).toBe('code-mode-1')
  })

  it('merges Unicode chunks without changing code points', () => {
    const projection = new ConversationProjection()
    projection.append({ seq: 1, kind: 'assistant-delta', text: '你' })
    projection.append({ seq: 2, kind: 'assistant-delta', text: '好' })
    projection.append({ seq: 3, kind: 'assistant-final', messageId: 'a', text: '你好，世界' })
    expect(projection.snapshot().nodes).toHaveLength(1)
    expect(projection.snapshot().nodes[0]).toMatchObject({ id: 'assistant:a', text: '你好，世界' })
  })

  it('is idempotent for exact duplicates and pauses on conflicting duplicates', () => {
    const projection = new ConversationProjection()
    const event = { seq: 1, kind: 'user', text: 'one' } as const
    expect(projection.append(event)).toBe(true)
    expect(projection.append(event)).toBe(false)
    expect(projection.snapshot().nodes).toHaveLength(1)
    expect(projection.append({ ...event, text: 'changed' })).toBe(true)
    expect(projection.snapshot().issue?.kind).toBe('duplicate-conflict')
  })

  it('pauses on a sequence gap and can recover through a full rebuild', () => {
    const projection = new ConversationProjection()
    projection.append({ seq: 4, kind: 'user', text: 'first' })
    projection.append({ seq: 6, kind: 'assistant-final', text: 'late' })
    expect(projection.snapshot().issue).toMatchObject({ kind: 'gap', seq: 6 })

    projection.rebuild([
      { seq: 4, kind: 'user', text: 'first' },
      { seq: 5, kind: 'ignored', text: 'known optional event' },
      { seq: 6, kind: 'assistant-final', text: 'late' },
    ])
    expect(projection.snapshot()).toMatchObject({ status: 'healthy', lastSeq: 6 })
  })

  it('pauses on unknown required semantics and interrupts unfinished tools at turn end', () => {
    const unknown = new ConversationProjection()
    unknown.append({ seq: 1, kind: 'unknown-required', text: 'new/session/fact' })
    expect(unknown.snapshot().issue?.kind).toBe('unknown-required')

    const interrupted = new ConversationProjection()
    interrupted.append({ seq: 1, kind: 'tool-call', callId: 'pending', name: 'bash', text: 'sleep 10' })
    interrupted.append({ seq: 2, kind: 'turn-end', text: 'cancelled' })
    expect(interrupted.snapshot().nodes[0]).toMatchObject({ status: 'interrupted', lastSeq: 2 })
  })

  it('bounds retained nodes for the terminal view', () => {
    const projection = new ConversationProjection(2)
    projection.append({ seq: 1, kind: 'user', text: 'one' })
    projection.append({ seq: 2, kind: 'user', text: 'two' })
    projection.append({ seq: 3, kind: 'user', text: 'three' })
    expect(projection.snapshot().nodes.map(node => node.kind === 'tool' ? node.output : node.text))
      .toEqual(['two', 'three'])
  })
})
