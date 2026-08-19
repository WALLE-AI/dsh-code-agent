import { describe, expect, it } from 'vitest'
import type { ToolNode, ToolPresentation, TranscriptNode } from '../src/contracts.ts'
import { emptyScrollback, settledEntryIds, splitScrollback } from '../src/scrollback.ts'
import { buildTranscriptEntries, transcriptLines } from '../src/transcript-view.ts'

function generic(node: ToolNode): ToolPresentation {
  return { call: { card: 'generic', title: node.name, rawInput: node.input } }
}

function tool(callId: string, status: ToolNode['status']): ToolNode {
  return {
    id: `tool:${callId}`, kind: 'tool', callId, name: 'bash',
    input: '', output: 'out', status, firstSeq: 1, lastSeq: 2,
  }
}

function project(nodes: readonly TranscriptNode[], columns = 80) {
  const entries = buildTranscriptEntries(nodes, generic)
  return { entries, lines: transcriptLines(entries, new Set(), columns) }
}

describe('settledEntryIds', () => {
  it('never settles the last entry, which is where streaming lands', () => {
    const { entries } = project([
      { id: 'u1', kind: 'user', text: 'one', firstSeq: 1, lastSeq: 1 },
      { id: 'a1', kind: 'assistant', text: 'two', firstSeq: 2, lastSeq: 2 },
    ])
    expect([...settledEntryIds(entries)]).toEqual(['u1'])
  })

  it('stops at a pending call, however settled the entries behind it are', () => {
    const { entries } = project([
      { id: 'u1', kind: 'user', text: 'one', firstSeq: 1, lastSeq: 1 },
      tool('running', 'pending'),
      tool('done', 'succeeded'),
      { id: 'u2', kind: 'user', text: 'two', firstSeq: 5, lastSeq: 5 },
    ])
    // Scrollback is append-only, so one unsettled entry pins everything after it.
    expect([...settledEntryIds(entries)]).toEqual(['u1'])
  })
})

describe('splitScrollback', () => {
  const nodes: readonly TranscriptNode[] = [
    { id: 'u1', kind: 'user', text: 'question', firstSeq: 1, lastSeq: 1 },
    { id: 'a1', kind: 'assistant', text: 'answer', firstSeq: 2, lastSeq: 2 },
    { id: 'u2', kind: 'user', text: 'still typing', firstSeq: 3, lastSeq: 3 },
  ]

  it('flushes the settled prefix and keeps the rest live', () => {
    const { entries, lines } = project(nodes)
    const split = splitScrollback(lines, entries, emptyScrollback)
    expect(split.appended.map(row => row.text)).toEqual(['> question', '● answer'])
    expect(split.live.map(row => row.text)).toEqual(['> still typing'])
  })

  it('emits each row exactly once, however often it is asked', () => {
    const { entries, lines } = project(nodes)
    const first = splitScrollback(lines, entries, emptyScrollback)
    const second = splitScrollback(lines, entries, first.next)
    expect(second.appended).toEqual([])
    expect(second.next.rows).toEqual(first.next.rows)
    // Idempotent for the live side too, so a re-render paints the same frame.
    expect(second.live).toEqual(first.live)
  })

  it('does not re-emit a row when a resize re-wraps the projection', () => {
    const wide = project(nodes, 80)
    const flushed = splitScrollback(wide.lines, wide.entries, emptyScrollback)
    // The same conversation, re-wrapped narrow. Rows already handed to the
    // terminal belong to it now; only the live tail is painted at the new width.
    const narrow = project(nodes, 20)
    const after = splitScrollback(narrow.lines, narrow.entries, flushed.next)
    expect(after.appended).toEqual([])
    expect(after.next.rows).toEqual(flushed.next.rows)
  })

  it('carries the banner out first and never again', () => {
    const { entries, lines } = project(nodes)
    const withBanner = [
      { entryId: 'splash', text: '  DEEPSEEK', tone: 'system' as const, header: false },
      ...lines,
    ]
    const split = splitScrollback(withBanner, entries, emptyScrollback)
    expect(split.appended[0]?.text).toBe('  DEEPSEEK')
    expect(splitScrollback(withBanner, entries, split.next).appended).toEqual([])
  })

  it('flushes nothing while the only entry is still the newest one', () => {
    const { entries, lines } = project([nodes[0] as TranscriptNode])
    const split = splitScrollback(lines, entries, emptyScrollback)
    expect(split.appended).toEqual([])
    expect(split.live.map(row => row.text)).toEqual(['> question'])
  })
})
