/**
 * Property tests for the invariants the plan calls non-negotiable: seed/live
 * equivalence, idempotence, gap detection, and terminal-text safety and width.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { TerminalEvent } from '../src/contracts.ts'
import { ConversationProjection } from '../src/conversation-projection.ts'
import { displayWidth, sanitizeText, truncateToWidth, wrapToWidth } from '../src/terminal-text.ts'

type EventTag =
  | { readonly tag: 'user'; readonly text: string }
  | { readonly tag: 'delta'; readonly text: string; readonly message: number }
  | { readonly tag: 'final'; readonly text: string; readonly message: number }
  | { readonly tag: 'reasoning'; readonly text: string }
  | { readonly tag: 'call'; readonly call: number; readonly name: string }
  | { readonly tag: 'result'; readonly call: number; readonly failed: boolean }
  | { readonly tag: 'marker'; readonly text: string }
  | { readonly tag: 'turn' }
  | { readonly tag: 'ignored' }

const tags: fc.Arbitrary<EventTag> = fc.oneof(
  fc.record({ tag: fc.constant('user' as const), text: fc.string() }),
  fc.record({
    tag: fc.constant('delta' as const),
    text: fc.string(),
    message: fc.integer({ min: 0, max: 3 }),
  }),
  fc.record({
    tag: fc.constant('final' as const),
    text: fc.string(),
    message: fc.integer({ min: 0, max: 3 }),
  }),
  fc.record({ tag: fc.constant('reasoning' as const), text: fc.string() }),
  fc.record({
    tag: fc.constant('call' as const),
    call: fc.integer({ min: 0, max: 5 }),
    name: fc.constantFrom('bash', 'read', 'edit', 'grep'),
  }),
  fc.record({
    tag: fc.constant('result' as const),
    call: fc.integer({ min: 0, max: 5 }),
    failed: fc.boolean(),
  }),
  fc.record({ tag: fc.constant('marker' as const), text: fc.string() }),
  fc.record({ tag: fc.constant('turn' as const) }),
  fc.record({ tag: fc.constant('ignored' as const) }),
)

/** Turn abstract tags into a contiguous, well-formed event log. */
function toEvents(items: readonly EventTag[]): TerminalEvent[] {
  return items.map((item, index): TerminalEvent => {
    const seq = index
    switch (item.tag) {
      case 'user': return { seq, kind: 'user', text: item.text }
      case 'delta':
        return { seq, kind: 'assistant-delta', text: item.text, messageId: `m${String(item.message)}` }
      case 'final':
        return { seq, kind: 'assistant-final', text: item.text, messageId: `m${String(item.message)}` }
      case 'reasoning': return { seq, kind: 'reasoning-delta', text: item.text }
      case 'call':
        return {
          seq, kind: 'tool-call', text: '{}', name: item.name, callId: `c${String(item.call)}`,
        }
      case 'result':
        return {
          seq, kind: 'tool-result', text: 'done', callId: `c${String(item.call)}`,
          ...(item.failed ? { failed: true } : {}),
        }
      case 'marker': return { seq, kind: 'marker', text: item.text }
      case 'turn': return { seq, kind: 'turn-end', text: 'completed' }
      case 'ignored': return { seq, kind: 'ignored', text: 'step/start' }
    }
  })
}

const logs = fc.array(tags, { minLength: 1, maxLength: 60 }).map(toEvents)

describe('projection invariants', () => {
  it('folds a live stream into the same state as a one-shot rebuild', () => {
    fc.assert(fc.property(logs, (events) => {
      const live = new ConversationProjection()
      for (const event of events) live.append(event)
      const seeded = new ConversationProjection()
      seeded.rebuild(events)
      expect(live.snapshot()).toEqual(seeded.snapshot())
    }), { numRuns: 200 })
  })

  it('is idempotent for an exactly repeated delivery', () => {
    fc.assert(fc.property(logs, fc.nat(), (events, pick) => {
      const projection = new ConversationProjection()
      for (const event of events) projection.append(event)
      const before = projection.snapshot()
      const repeated = events[pick % events.length]
      if (repeated === undefined) return
      projection.append(repeated)
      expect(projection.snapshot()).toEqual(before)
      expect(projection.snapshot().status).toBe('healthy')
    }), { numRuns: 200 })
  })

  it('pauses instead of guessing when a sequence number is skipped', () => {
    fc.assert(fc.property(logs, fc.integer({ min: 1, max: 5 }), (events, skip) => {
      const projection = new ConversationProjection()
      for (const event of events) projection.append(event)
      projection.append({ seq: events.length + skip, kind: 'user', text: 'gap' })
      const snapshot = projection.snapshot()
      expect(snapshot.status).toBe('paused')
      expect(snapshot.issue?.kind).toBe('gap')
    }), { numRuns: 100 })
  })

  it('never leaves a tool pending once its result arrives before the turn ends', () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 1, maxLength: 8 }),
      (calls) => {
        const unique = [...new Set(calls)]
        const events: TerminalEvent[] = [
          ...unique.map((call, index): TerminalEvent => ({
            seq: index, kind: 'tool-call', text: '{}', name: 'bash', callId: `c${String(call)}`,
          })),
          ...unique.map((call, index): TerminalEvent => ({
            seq: unique.length + index, kind: 'tool-result', text: 'ok', callId: `c${String(call)}`,
          })),
        ]
        const projection = new ConversationProjection()
        for (const event of events) projection.append(event)
        const nodes = projection.snapshot().nodes
        expect(nodes).toHaveLength(unique.length)
        expect(nodes.every(node => node.kind === 'tool' && node.status === 'succeeded')).toBe(true)
      },
    ), { numRuns: 100 })
  })

  it('keeps the transcript within the retention bound', () => {
    fc.assert(fc.property(logs, fc.integer({ min: 1, max: 10 }), (events, bound) => {
      const projection = new ConversationProjection(bound)
      for (const event of events) projection.append(event)
      expect(projection.snapshot().nodes.length).toBeLessThanOrEqual(bound)
    }), { numRuns: 100 })
  })
})

describe('terminal text invariants', () => {
  it('emits no escape or control characters for any input', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary' }), (text) => {
      const clean = sanitizeText(text)
      for (const character of clean) {
        const code = character.codePointAt(0) ?? 0
        expect(code === 0x0a || code >= 0x20).toBe(true)
        expect(code === 0x7f || (code >= 0x80 && code <= 0x9f)).toBe(false)
      }
    }), { numRuns: 300 })
  })

  it('never truncates or wraps beyond the column budget', () => {
    fc.assert(fc.property(
      fc.string({ unit: 'binary' }),
      fc.integer({ min: 1, max: 40 }),
      (text, columns) => {
        const clean = sanitizeText(text).replace(/\n/g, ' ')
        expect(displayWidth(truncateToWidth(clean, columns))).toBeLessThanOrEqual(columns)
        for (const row of wrapToWidth(clean, columns)) {
          expect(displayWidth(row)).toBeLessThanOrEqual(columns)
        }
      },
    ), { numRuns: 300 })
  })

  it('keeps sanitized text stable under a second pass', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary' }), (text) => {
      const once = sanitizeText(text)
      expect(sanitizeText(once)).toBe(once)
    }), { numRuns: 300 })
  })
})
