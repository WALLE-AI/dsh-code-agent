import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConversationProjection } from '../src/conversation-projection.ts'
import type { TerminalEvent, ToolNode, TranscriptNode } from '../src/contracts.ts'

const fixture = JSON.parse(readFileSync(
  join(import.meta.dirname, 'fixtures/conversation-events.json'),
  'utf8',
)) as TerminalEvent[]

/** `[kind, what it says]` — a tool says its name, everything else its text. */
function describeNode(node: TranscriptNode): readonly [string, string] {
  return [node.kind, node.kind === 'tool' ? node.name : node.text]
}

describe('conversation projection', () => {
  it('produces the same snapshot from a seed fold and live events', () => {
    const seeded = new ConversationProjection()
    seeded.rebuild(fixture)
    const live = new ConversationProjection()
    for (const event of fixture) live.append(event)

    expect(live.snapshot()).toEqual(seeded.snapshot())
    expect(live.snapshot().status).toBe('healthy')
    // The fixture is the interleaved shape: the model speaks, calls three
    // tools, and speaks again — all under one message id. The two utterances
    // are two blocks at two positions, and the second one lands *after* the
    // tools it was written in response to.
    const nodes = live.snapshot().nodes
    expect(nodes.map(node => node.kind))
      .toEqual(['user', 'assistant', 'tool', 'tool', 'tool', 'assistant', 'turn'])
    expect(nodes[1]).toMatchObject({ text: 'I will inspect it.', firstSeq: 11, lastSeq: 12 })
    expect(nodes[5]).toMatchObject({ text: 'Fixed the test.', firstSeq: 22, lastSeq: 22 })
    // Two blocks of one message still need two identities.
    expect(new Set(nodes.map(node => node.id)).size).toBe(nodes.length)
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
    expect(projection.snapshot().nodes[0]).toMatchObject({ text: '你好，世界' })
  })

  it('closes a text block as soon as anything is pushed after it', () => {
    const projection = new ConversationProjection()
    projection.append({ seq: 1, kind: 'assistant-delta', text: 'I will search.' })
    projection.append({ seq: 2, kind: 'tool-call', text: '{}', name: 'search', callId: 'c1' })
    projection.append({ seq: 3, kind: 'tool-result', text: '8 sources', callId: 'c1' })
    projection.append({ seq: 4, kind: 'assistant-delta', text: 'Here is what I found.' })
    // Text produced after a tool ran renders after it, rather than being folded
    // back into the paragraph that preceded it.
    expect(projection.snapshot().nodes.map(describeNode))
      .toEqual([
        ['assistant', 'I will search.'],
        ['tool', 'search'],
        ['assistant', 'Here is what I found.'],
      ])
  })

  it('keeps streaming a block that nothing has been pushed after', () => {
    const projection = new ConversationProjection()
    projection.append({ seq: 1, kind: 'assistant-delta', text: 'one ' })
    projection.append({ seq: 2, kind: 'assistant-delta', text: 'two ' })
    projection.append({ seq: 3, kind: 'assistant-delta', text: 'three' })
    // The rule must not shatter streamed prose into a node per delta.
    expect(projection.snapshot().nodes.map(describeNode))
      .toEqual([['assistant', 'one two three']])
  })

  it('splits reasoning the same way, one block per step', () => {
    const projection = new ConversationProjection()
    projection.append({ seq: 1, kind: 'reasoning-delta', text: 'first I will look' })
    projection.append({ seq: 2, kind: 'tool-call', text: '{}', name: 'read', callId: 'c1' })
    projection.append({ seq: 3, kind: 'tool-result', text: 'ok', callId: 'c1' })
    projection.append({ seq: 4, kind: 'reasoning-delta', text: 'now I can answer' })
    expect(projection.snapshot().nodes.map(node => node.kind))
      .toEqual(['reasoning', 'tool', 'reasoning'])
  })

  it('leaves no empty bubble for a message that carried only tool calls', () => {
    const projection = new ConversationProjection()
    // `assistant/message` with no text block normalizes to an empty final. It
    // used to push an empty `●` row in front of the tools it did carry, and
    // that row then swallowed the next step's answer.
    projection.append({ seq: 1, kind: 'assistant-final', messageId: 'm1', text: '' })
    projection.append({ seq: 2, kind: 'tool-call', text: '{}', name: 'read', callId: 'c1' })
    projection.append({ seq: 3, kind: 'tool-result', text: 'ok', callId: 'c1' })
    projection.append({ seq: 4, kind: 'assistant-final', messageId: 'm2', text: 'DONE' })
    expect(projection.snapshot().nodes.map(describeNode))
      .toEqual([['tool', 'read'], ['assistant', 'DONE']])
  })

  it('never lets an empty final erase what the deltas delivered', () => {
    const projection = new ConversationProjection()
    projection.append({ seq: 1, kind: 'assistant-delta', text: 'streamed answer' })
    projection.append({ seq: 2, kind: 'assistant-final', messageId: 'm1', text: '' })
    expect(projection.snapshot().nodes.map(describeNode))
      .toEqual([['assistant', 'streamed answer']])
  })

  it('keeps user, marker and turn as barriers', () => {
    const projection = new ConversationProjection()
    projection.append({ seq: 1, kind: 'assistant-delta', text: 'before' })
    projection.append({ seq: 2, kind: 'marker', text: 'Conversation compacted' })
    projection.append({ seq: 3, kind: 'assistant-delta', text: 'after' })
    expect(projection.snapshot().nodes.map(node => node.kind))
      .toEqual(['assistant', 'marker', 'assistant'])
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
