/**
 * Budgets for the row-building path.
 *
 * Wrapping made row construction the expensive part of a frame, and a streamed
 * response rebuilds rows on every delta. These are deliberately loose: they
 * catch a regression from "memoized" to "re-wraps everything", not a few
 * percent of drift on a busy machine.
 */

import { describe, expect, it } from 'vitest'
import type { TerminalEvent } from '../src/contracts.ts'
import { TuiStore } from '../src/state.ts'

const COLUMNS = 80
const PROSE = 'the quick brown fox jumps over the lazy dog and keeps on running '

function elapsed(work: () => void): number {
  const start = process.hrtime.bigint()
  work()
  return Number(process.hrtime.bigint() - start) / 1e6
}

function seeded(count: number): TuiStore {
  const store = new TuiStore(count)
  store.setColumns(COLUMNS)
  for (let seq = 0; seq < count; seq++) {
    store.append({ seq, kind: 'user', text: PROSE.repeat(4) })
  }
  return store
}

describe('row building cost', () => {
  it('wraps a large transcript once, in bounded time', () => {
    const count = 2_000
    const build = elapsed(() => { seeded(count) })
    // ~1.1s on the reference machine; a regression here means no memoization.
    expect(build).toBeLessThan(3_000)
    const store = seeded(count)
    // Each source row is far wider than the terminal, so wrapping really ran.
    expect(store.snapshot().lines.length).toBeGreaterThan(count * 2)
    for (const line of store.snapshot().lines) {
      expect(line.text.length).toBeLessThanOrEqual(COLUMNS)
    }
  })

  it('re-wraps only the entry a streamed delta touched', () => {
    const store = seeded(2_000)
    const event: TerminalEvent = {
      seq: 2_000, kind: 'assistant-delta', text: 'x', messageId: 'm1',
    }
    store.append(event)
    // Appending to one message must not cost anything like a full rebuild.
    const perDelta = elapsed(() => {
      for (let step = 1; step <= 50; step++) {
        store.append({ ...event, seq: 2_000 + step })
      }
    }) / 50
    // ~1ms memoized against ~500ms if every entry re-wrapped.
    expect(perDelta).toBeLessThan(8)
  })

  it('re-flows the whole transcript on resize, then caches the new width', () => {
    const store = seeded(1_000)
    const reflow = elapsed(() => { store.setColumns(60) })
    // A resize is the one case that must re-wrap everything; ~50ms.
    expect(reflow).toBeLessThan(600)
    // The same width again is a no-op, not a second pass.
    expect(elapsed(() => { store.setColumns(60) })).toBeLessThan(reflow + 1)
  })
})
