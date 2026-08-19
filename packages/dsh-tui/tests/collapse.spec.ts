/**
 * Collapsing runs of entries.
 *
 * The rule is judged on what it costs the reader, so the end-to-end assertions
 * count rows: a run of nine successful look-ups must not push the answer it was
 * working towards off the screen.
 */

import { describe, expect, it } from 'vitest'
import { collapseEntries, MIN_RUN, READ_SEARCH_RUN } from '../src/collapse.ts'
import { UNICODE_GLYPHS } from '../src/glyphs.ts'
import { settledEntryIds } from '../src/scrollback.ts'
import { TuiStore } from '../src/state.ts'
import type { TranscriptEntry } from '../src/transcript-view.ts'
import type { RowTone } from '../src/styling.ts'
import type { ToolNode, ToolPresentation } from '../src/contracts.ts'

function entry(overrides: Partial<TranscriptEntry> & { id: string }): TranscriptEntry {
  return {
    nodeKind: 'tool',
    tone: 'tool',
    depth: 0,
    header: `${UNICODE_GLYPHS.succeeded} Read ${overrides.id}`,
    detail: [],
    foldable: false,
    foldedByDefault: false,
    locations: [],
    status: 'succeeded',
    statusTone: 'tool-read' as RowTone,
    ...overrides,
  }
}

const run = (count: number, tone: RowTone = 'tool-read'): TranscriptEntry[] =>
  Array.from({ length: count }, (_, at) => entry({ id: `t${String(at)}`, statusTone: tone }))

describe('what may be collapsed', () => {
  it('folds a run of successful look-ups into one entry', () => {
    const collapsed = collapseEntries(run(5))
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]?.header).toBe(`${UNICODE_GLYPHS.succeeded} 5 reads`)
    expect(collapsed[0]?.detail).toHaveLength(5)
    expect(collapsed[0]?.foldedByDefault).toBe(true)
  })

  it('leaves a run shorter than the minimum exactly as it was', () => {
    const entries = run(MIN_RUN - 1)
    // Reference equality: nothing matched, so no cache anywhere is disturbed.
    expect(collapseEntries(entries)).toBe(entries)
  })

  it('never hides a call that is still running', () => {
    const entries = [
      ...run(2),
      entry({ id: 'pending', status: 'pending' }),
      ...run(2).map(item => entry({ ...item, id: `${item.id}b` })),
    ]
    expect(collapseEntries(entries)).toBe(entries)
  })

  it('never hides a failure', () => {
    const entries = [
      ...run(4),
      entry({ id: 'boom', status: 'failed', tone: 'error' }),
    ]
    const collapsed = collapseEntries(entries)
    expect(collapsed).toHaveLength(2)
    expect(collapsed[0]?.header).toBe(`${UNICODE_GLYPHS.succeeded} 4 reads`)
    expect(collapsed[1]?.id).toBe('boom')
  })

  it('leaves kinds whose body is the point alone', () => {
    for (const tone of ['tool-terminal', 'tool-diff', 'tool-web'] as const) {
      const entries = run(5, tone)
      expect(collapseEntries(entries), tone).toBe(entries)
    }
  })

  it('leaves a tool it has never heard of alone', () => {
    // No declared card kind means no tone, which means never collapsed.
    const entries = run(5).map(item => {
      const { statusTone: _dropped, ...rest } = item
      return rest
    })
    expect(collapseEntries(entries)).toBe(entries)
  })

  it('leaves a nested call under its parent', () => {
    const entries = run(5).map(item => entry({ ...item, depth: 1 }))
    expect(collapseEntries(entries)).toBe(entries)
  })
})

describe('what the group says', () => {
  it('counts each kind in the order it first appeared', () => {
    const entries = [
      ...run(2, 'tool-search'),
      ...run(3).map(item => entry({ ...item, id: `${item.id}r` })),
    ]
    expect(collapseEntries(entries)[0]?.header)
      .toBe(`${UNICODE_GLYPHS.succeeded} 2 searches · 3 reads`)
  })

  it('drops the repeated tick, which the group header already carries', () => {
    const collapsed = collapseEntries(run(3))
    expect(collapsed[0]?.detail.map(line => line.text))
      .toEqual(['Read t0', 'Read t1', 'Read t2'])
  })

  it('keeps every file it touched reachable from the group', () => {
    const entries = run(3).map((item, at) => entry({
      ...item,
      locations: [{ path: `src/f${String(at)}.ts` }, { path: 'src/shared.ts' }],
    }))
    expect(collapseEntries(entries)[0]?.locations.map(location => location.path))
      .toEqual(['src/f0.ts', 'src/shared.ts', 'src/f1.ts', 'src/f2.ts'])
  })

  it('takes its identity from its first member, never from its position', () => {
    const before = collapseEntries(run(3))
    const after = collapseEntries([entry({ id: 'prelude', statusTone: 'tool-web' }), ...run(3)])
    expect(after[1]?.id).toBe(before[0]?.id)
  })

  it('takes no dot colour when the run mixes kinds', () => {
    expect(collapseEntries(run(3))[0]?.statusTone).toBe('tool-read')
    const mixed = [...run(2), ...run(2, 'tool-search').map(i => entry({ ...i, id: `${i.id}s` }))]
    expect(collapseEntries(mixed)[0]?.statusTone).toBeUndefined()
  })
})

describe('what it saves on screen', () => {
  /** A presenter that declares the card kind the collapse rule reads. */
  function cardPresenter(card: string): (node: ToolNode) => ToolPresentation {
    return node => ({
      call: { card, title: `${node.name} ${node.callId}` },
      ...(node.status === 'pending'
        ? {}
        : { result: { card, content: [{ type: 'text', text: node.output }] } }),
    }) as ToolPresentation
  }

  function readingStore(rules?: []): TuiStore {
    const store = new TuiStore(200, {}, undefined, undefined, rules)
    store.setColumns(80)
    store.setToolPresenter(cardPresenter('read'))
    store.append({ seq: 1, kind: 'user', text: 'where is the flush race?' })
    for (let at = 0; at < 9; at++) {
      const callId = `c${String(at)}`
      store.append({ seq: 2 + at * 2, kind: 'tool-call', text: '{}', name: 'read', callId })
      store.append({
        seq: 3 + at * 2,
        kind: 'tool-result',
        text: `line one\nline two\nline three`,
        callId,
      })
    }
    store.append({ seq: 100, kind: 'assistant-delta', text: 'it is in the flush path' })
    return store
  }

  it('spends three rows on nine look-ups instead of thirty', () => {
    const collapsed = readingStore().snapshot()
    const uncollapsed = readingStore([]).snapshot()
    const toolRows = (store: typeof collapsed): number =>
      store.lines.filter(line => line.entryId.startsWith('group:')
        || store.entries.some(item => item.id === line.entryId && item.nodeKind === 'tool')).length
    expect(toolRows(collapsed)).toBeLessThanOrEqual(3)
    expect(toolRows(uncollapsed)).toBeGreaterThan(9)
  })

  it('opens with the ordinary fold shortcut', () => {
    const store = readingStore()
    const group = store.snapshot().entries.find(item => item.id.startsWith('group:'))
    expect(group).toBeDefined()
    const before = store.snapshot().lines.length
    store.toggleFold(group?.id ?? '')
    expect(store.snapshot().lines.length).toBeGreaterThan(before)
    expect(store.snapshot().lines.some(line => line.text.includes('read c8'))).toBe(true)
  })

  it('does not hand a group to the terminal while it can still grow', () => {
    // A group directly above a pending call can absorb that call once it
    // settles. Flushing it first would leave `3 reads` in a scrollback the
    // frame can no longer reach while the truth had become four.
    const store = new TuiStore(200, {}, undefined, undefined)
    store.setColumns(80)
    store.setToolPresenter(cardPresenter('read'))
    for (let at = 0; at < 3; at++) {
      store.append({ seq: 1 + at * 2, kind: 'tool-call', text: '{}', name: 'read', callId: `c${String(at)}` })
      store.append({ seq: 2 + at * 2, kind: 'tool-result', text: 'ok', callId: `c${String(at)}` })
    }
    store.append({ seq: 7, kind: 'tool-call', text: '{}', name: 'read', callId: 'c3' })
    const pending = store.snapshot()
    const settled = settledEntryIds(pending.entries)
    const group = pending.entries.find(item => item.collapsedFrom !== undefined)
    expect(group).toBeDefined()
    expect(settled.has(group?.id ?? '')).toBe(false)

    // Once the fourth read lands it joins the group, under the same id.
    store.append({ seq: 8, kind: 'tool-result', text: 'ok', callId: 'c3' })
    const grown = store.snapshot().entries.find(item => item.collapsedFrom !== undefined)
    expect(grown?.id).toBe(group?.id)
    expect(grown?.collapsedFrom).toBe(4)
    expect(grown?.header).toBe(`${UNICODE_GLYPHS.succeeded} 4 reads`)
  })

  it('still counts every tool that ran, whatever the transcript shows', () => {
    expect(readingStore().snapshot().counters.tools)
      .toBe(readingStore([]).snapshot().counters.tools)
  })
})

describe('the rule in isolation', () => {
  it('claims nothing at a position it does not apply to', () => {
    expect(READ_SEARCH_RUN.match([entry({ id: 'a', status: 'pending' })], 0)).toBe(0)
    expect(READ_SEARCH_RUN.match(run(MIN_RUN), 0)).toBe(MIN_RUN)
    expect(READ_SEARCH_RUN.match(run(MIN_RUN - 1), 0)).toBe(0)
  })
})
