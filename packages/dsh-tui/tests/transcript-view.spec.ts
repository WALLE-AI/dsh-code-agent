import { describe, expect, it } from 'vitest'
import type { ToolNode, ToolPresentation, TranscriptNode } from '../src/contracts.ts'
import {
  buildTranscriptEntries, currentToolEntryId, entryFolded, transcriptLines,
} from '../src/transcript-view.ts'
import { displayWidth } from '../src/terminal-text.ts'

function generic(node: ToolNode): ToolPresentation {
  return { call: { card: 'generic', title: node.name, rawInput: node.input } }
}

function tool(overrides: Partial<ToolNode>): ToolNode {
  return {
    id: `tool:${overrides.callId ?? 'c'}`, kind: 'tool', callId: 'c', name: 'bash',
    input: '', output: '', status: 'succeeded', firstSeq: 1, lastSeq: 2, ...overrides,
  }
}

const longOutput = Array.from({ length: 20 }, (_, index) => `row-${String(index)}`).join('\n')

describe('transcript entries', () => {
  it('folds long tools by default, a failure only past its larger budget', () => {
    const shortFailure = Array.from({ length: 6 }, (_, index) => `row-${String(index)}`).join('\n')
    const nodes: readonly TranscriptNode[] = [
      tool({ callId: 'ok', id: 'tool:ok', output: longOutput }),
      tool({ callId: 'bad', id: 'tool:bad', output: longOutput, status: 'failed' }),
      tool({ callId: 'small', id: 'tool:small', output: shortFailure, status: 'failed' }),
    ]
    const entries = buildTranscriptEntries(nodes, generic)
    expect(entries[0]?.foldedByDefault).toBe(true)
    // A failure earns more rows than a success, but not unlimited ones: twenty
    // lines of stderr used to render in full and bury the turns above it.
    expect(entries[1]?.foldedByDefault).toBe(true)
    expect(entries[1]?.tone).toBe('error')
    // Small enough to read at a glance, so it stays open — the evidence for a
    // failure is worth the rows when there are few of them.
    expect(entries[2]?.foldedByDefault).toBe(false)

    const folded = new Set<string>()
    expect(entryFolded(entries[0]!, folded)).toBe(true)
    folded.add('tool:ok')
    expect(entryFolded(entries[0]!, folded)).toBe(false)
  })

  it('folds a card whose few lines are wide enough to fill the screen', () => {
    // The `node -e fetch(...)` card from the bug report: two logical lines, one
    // of them a 2,000-character JSON response, which the line-count rule cannot
    // see and which wraps across most of a terminal.
    const blob = `status:200 ct:application/json\n${'x'.repeat(2_000)}`
    const entries = buildTranscriptEntries([tool({ callId: 'j', id: 'tool:j', output: blob })], generic)
    const entry = entries[0]!
    // Unchanged by line count alone; the row budget is what catches it.
    expect(entry.foldedByDefault).toBe(false)
    expect(entryFolded(entry, new Set())).toBe(false)
    expect(entryFolded(entry, new Set(), 140)).toBe(true)
    expect(transcriptLines([entry], new Set(), 140)).toHaveLength(2)
    // ctrl+o still opens it: the override flips the default that applies at
    // this width, rather than the width-independent one.
    expect(transcriptLines([entry], new Set(['tool:j']), 140).length).toBeGreaterThan(10)
  })

  it('keeps earlier turns on screen through a tool-heavy turn', () => {
    // The reported session: a first exchange, then a turn that made eight calls
    // — four searches, two shell probes, one failing `node -e` with a stack, and
    // one printing a 2 KB JSON response as a single line. Unfolded those came to
    // 66 rows, so on a 45-row terminal the opening question was gone.
    const nodes: readonly TranscriptNode[] = [
      { id: 'u0', kind: 'user', text: '你是谁', firstSeq: 0, lastSeq: 0 },
      { id: 'a0', kind: 'assistant', text: '我是 DeepSeek 的 AI 助手。', firstSeq: 1, lastSeq: 1 },
      { id: 'u1', kind: 'user', text: '查一下 trending', firstSeq: 2, lastSeq: 2 },
      ...Array.from({ length: 6 }, (_, index) => tool({
        callId: `c${String(index)}`, id: `tool:${String(index)}`,
        output: Array.from({ length: 10 }, (_, row) => `source ${String(row)}`).join('\n'),
      })),
      tool({
        callId: 'cf', id: 'tool:f', status: 'failed',
        output: Array.from({ length: 40 }, (_, row) => `  at frame ${String(row)}`).join('\n'),
      }),
      tool({ callId: 'cj', id: 'tool:j', output: `status:200\n${'x'.repeat(2_000)}` }),
    ]
    const rows = transcriptLines(buildTranscriptEntries(nodes, generic), new Set(), 140)
    // Two rows per folded card, and the opening exchange still on a 45-row screen.
    expect(rows.filter(row => row.entryId.startsWith('tool:'))).toHaveLength(16)
    expect(rows.slice(-45).map(row => row.entryId)).toContain('u0')
  })

  it('never folds an assistant answer for being long', () => {
    const text = Array.from({ length: 40 }, (_, index) => `paragraph ${String(index)}`).join('\n')
    const entries = buildTranscriptEntries([
      { id: 'a1', kind: 'assistant', text, firstSeq: 1, lastSeq: 1 },
    ], generic)
    expect(entryFolded(entries[0]!, new Set(), 80)).toBe(false)
  })

  it('renders assistant markdown without shifting a line', () => {
    const text = [
      '## 文件与代码操作',
      '| 工具 | 用途 |',
      '|------|------|',
      '| **read** | 读取文本文件内容 |',
    ].join('\n')
    const entries = buildTranscriptEntries([
      { id: 'm1', kind: 'assistant', text, firstSeq: 1, lastSeq: 1 },
    ], generic)
    const entry = entries[0]
    // One row per source line: the header takes the first, the detail rows the
    // rest, and the fold count is that length.
    expect(entry?.detail).toHaveLength(3)
    expect(entry?.header).toBe('● 文件与代码操作')
    const rendered = [entry?.header ?? '', ...(entry?.detail ?? []).map(row => row.text)].join('\n')
    for (const marker of ['##', '**', '|---']) expect(rendered).not.toContain(marker)
    expect(entry?.detail[1]?.text).toMatch(/^─+┼─+$/)
    // The columns are aligned, so the separator sits on one terminal column in
    // both rows — `工具` is two characters and four cells wide, `read` four of each.
    const column = (row: string): number => displayWidth(row.slice(0, row.indexOf('│')))
    expect(column(entry?.detail[0]?.text ?? '')).toBe(column(entry?.detail[2]?.text ?? ''))
  })

  it('collapses reasoning and marks interrupted tools', () => {
    const entries = buildTranscriptEntries([
      { id: 'r1', kind: 'reasoning', text: 'thinking', firstSeq: 1, lastSeq: 1 },
      tool({ callId: 'x', id: 'tool:x', status: 'interrupted', output: 'partial' }),
    ], generic)
    expect(entries[0]).toMatchObject({ tone: 'reasoning', foldedByDefault: true })
    expect(entries[1]?.header).toBe('⚠ bash')
  })

  it('indents Code Mode sub-calls under their parent call', () => {
    const entries = buildTranscriptEntries([
      tool({ callId: 'root', id: 'tool:root', name: 'run_code' }),
      tool({ callId: 'sub', id: 'tool:sub', name: 'read', parentCallId: 'root' }),
      tool({ callId: 'orphan', id: 'tool:orphan', name: 'grep', parentCallId: 'missing' }),
    ], generic)
    expect(entries.map(entry => entry.depth)).toEqual([0, 1, 0])
    const lines = transcriptLines(entries)
    expect(lines[1]?.text.startsWith('  ✓ read')).toBe(true)
  })

  it('renders a fold hint instead of hidden detail rows', () => {
    const entries = buildTranscriptEntries([tool({ callId: 'ok', id: 'tool:ok', output: longOutput })], generic)
    const lines = transcriptLines(entries)
    expect(lines).toHaveLength(2)
    expect(lines[1]?.text).toContain('+20 lines (ctrl+o to expand)')
    expect(transcriptLines(entries, new Set(['tool:ok']))).toHaveLength(21)
  })

  it('reuses cached entries until a node signature changes', () => {
    const cache = new Map<string, { signature: string; entry: ReturnType<typeof buildTranscriptEntries>[number] }>()
    const first = buildTranscriptEntries([tool({ callId: 'c', id: 'tool:c' })], generic, {}, cache)
    const second = buildTranscriptEntries([tool({ callId: 'c', id: 'tool:c' })], generic, {}, cache)
    expect(second[0]).toBe(first[0])
    const changed = buildTranscriptEntries(
      [tool({ callId: 'c', id: 'tool:c', output: 'new', lastSeq: 3 })], generic, {}, cache,
    )
    expect(changed[0]).not.toBe(first[0])
    expect(cache.size).toBe(1)
  })

  it('targets the last visible tool card for fold and editor shortcuts', () => {
    const entries = buildTranscriptEntries([
      tool({ callId: 'a', id: 'tool:a' }),
      { id: 'u1', kind: 'user', text: 'hi', firstSeq: 3, lastSeq: 3 },
      tool({ callId: 'b', id: 'tool:b' }),
    ], generic)
    const lines = transcriptLines(entries)
    expect(currentToolEntryId(entries, lines, lines.length)).toBe('tool:b')
    expect(currentToolEntryId(entries, lines, 1)).toBe('tool:a')
    expect(currentToolEntryId([], [], 0)).toBeUndefined()
  })

  it('tones the status dot by the card kind the tool declared', () => {
    const present = (card: 'terminal' | 'read' | 'generic') => (node: ToolNode): ToolPresentation =>
      ({ call: { card, title: node.name } })
    const [run] = buildTranscriptEntries([tool({ callId: 'a', id: 'tool:a' })], present('terminal'))
    const [read] = buildTranscriptEntries([tool({ callId: 'b', id: 'tool:b' })], present('read'))
    expect(run?.statusTone).toBe('tool-terminal')
    expect(read?.statusTone).toBe('tool-read')
    // An unclassified card borrows no meaning, and a failure stays red.
    expect(buildTranscriptEntries([tool({ callId: 'c', id: 'tool:c' })], generic)[0]?.statusTone)
      .toBeUndefined()
    expect(buildTranscriptEntries(
      [tool({ callId: 'd', id: 'tool:d', status: 'failed' })], present('terminal'),
    )[0]?.statusTone).toBeUndefined()
  })

  it('keeps a declared activity phrase on the tool entry', () => {
    const [entry] = buildTranscriptEntries(
      [tool({ callId: 'a', id: 'tool:a', status: 'pending' })],
      (): ToolPresentation => ({
        call: { card: 'terminal', title: 'Read src/a.ts', activity: 'Reading src/a.ts' },
      }),
    )
    expect(entry?.activity).toBe('Reading src/a.ts')
  })

  it('splits the dot into its own run without disturbing the row text', () => {
    const entries = buildTranscriptEntries(
      [tool({ callId: 'a', id: 'tool:a', output: 'done' })],
      (node): ToolPresentation => ({ call: { card: 'terminal', title: node.name } }),
    )
    const header = transcriptLines(entries)[0]
    expect(header?.segments?.[0]).toEqual({ text: '✓', tone: 'tool-terminal' })
    expect(header?.segments?.map(segment => segment.text).join('')).toBe(header?.text)
  })

  it('survives a throwing tool presenter', () => {
    const entries = buildTranscriptEntries([tool({ callId: 'c', id: 'tool:c' })], () => {
      throw new Error('presenter exploded')
    })
    expect(entries[0]?.header).toBe('✓ bash')
  })
})

/** A user message, which is what starts a turn. */
function user(seq: number, text = 'go'): TranscriptNode {
  return { id: `user:${String(seq)}`, kind: 'user', text, firstSeq: seq, lastSeq: seq }
}

/**
 * An assistant block. Three lines by default: folding one costs a row to say so,
 * so a block only folds once it hides at least two.
 */
function say(
  seq: number,
  text = 'I will look.\nGive me a moment.\nSearching the workspace now.',
): TranscriptNode {
  return { id: `assistant:${String(seq)}`, kind: 'assistant', text, firstSeq: seq, lastSeq: seq }
}

describe('preamble folding', () => {
  it('shows the first turn preamble in full and folds it from the second turn on', () => {
    const nodes: readonly TranscriptNode[] = [
      user(1), say(2), tool({ callId: 'a', id: 'tool:a' }), say(4, 'First answer.'),
      user(5), say(6), tool({ callId: 'b', id: 'tool:b' }), say(8, 'Second answer.'),
    ]
    const entries = buildTranscriptEntries(nodes, generic)
    // Turn 1: the model's narration of intent is orientation worth reading.
    expect(entries[1]?.foldedByDefault).toBe(false)
    // Turn 2: the same narration is noise, and folds away behind ctrl+o.
    expect(entries[5]?.foldedByDefault).toBe(true)
    // The answers — nothing follows them but the next turn — never fold.
    expect(entries[3]?.foldedByDefault).toBe(false)
    expect(entries[7]?.foldedByDefault).toBe(false)
  })

  it('folds every preamble of a later turn, not just the first', () => {
    const nodes: readonly TranscriptNode[] = [
      user(1), say(2, 'turn one'),
      user(3), say(4), tool({ callId: 'a', id: 'tool:a' }),
      say(6), tool({ callId: 'b', id: 'tool:b' }), say(8, 'Answer.'),
    ]
    const entries = buildTranscriptEntries(nodes, generic)
    expect(entries[3]?.foldedByDefault).toBe(true)
    expect(entries[5]?.foldedByDefault).toBe(true)
    expect(entries[7]?.foldedByDefault).toBe(false)
  })

  it('leaves a short preamble alone, because folding it would save nothing', () => {
    const nodes: readonly TranscriptNode[] = [
      user(1), say(2, 'turn one'),
      user(3), say(4, 'Searching.'), tool({ callId: 'a', id: 'tool:a' }), say(6, 'Answer.'),
    ]
    const entries = buildTranscriptEntries(nodes, generic)
    expect(entries[3]?.foldedByDefault).toBe(false)
  })

  it('opens a folded preamble through the ordinary fold override', () => {
    const nodes: readonly TranscriptNode[] = [
      user(1), say(2, 'turn one'),
      user(3), say(4), tool({ callId: 'a', id: 'tool:a' }), say(6, 'Answer.'),
    ]
    const entries = buildTranscriptEntries(nodes, generic)
    const preamble = entries[3]
    expect(preamble).toBeDefined()
    expect(entryFolded(preamble!, new Set())).toBe(true)
    expect(entryFolded(preamble!, new Set([preamble!.id]))).toBe(false)
  })

  it('re-folds a block once a tool arrives after it', () => {
    // The cache regression. Whether a block is a preamble depends on nodes that
    // come *after* it, so a signature keyed only on the block's own text keeps
    // the stale unfolded entry for ever.
    const cache = new Map()
    const before: readonly TranscriptNode[] = [user(1), say(2, 'turn one'), user(3), say(4)]
    expect(buildTranscriptEntries(before, generic, {}, cache)[3]?.foldedByDefault).toBe(false)
    const after: readonly TranscriptNode[] = [...before, tool({ callId: 'a', id: 'tool:a' })]
    expect(buildTranscriptEntries(after, generic, {}, cache)[3]?.foldedByDefault).toBe(true)
  })
})

describe('the margin between a tool and the answer that follows it', () => {
  it('separates a tool card from the assistant block after it', () => {
    const nodes: readonly TranscriptNode[] = [
      user(1), tool({ callId: 'a', id: 'tool:a' }), say(3, 'Answer.'),
    ]
    const lines = transcriptLines(buildTranscriptEntries(nodes, generic))
    const at = lines.findIndex(line => line.text.includes('Answer.'))
    expect(at).toBeGreaterThan(0)
    expect(lines[at - 1]?.text).toBe('')
    // The blank row belongs to the block it introduces, not to the card above:
    // rows leave for the terminal's scrollback by entry, and a spacer that left
    // with the card would strand the answer against the previous row.
    expect(lines[at - 1]?.entryId).toBe(lines[at]?.entryId)
  })

  it('adds no margin where the transition already reads as one', () => {
    const nodes: readonly TranscriptNode[] = [
      user(1), say(2, 'Looking.'),
      tool({ callId: 'a', id: 'tool:a' }), tool({ callId: 'b', id: 'tool:b' }),
    ]
    const lines = transcriptLines(buildTranscriptEntries(nodes, generic))
    expect(lines.filter(line => line.text === '')).toHaveLength(0)
  })

  it('keeps exactly one margin when the card above it is folded and reopened', () => {
    // The other cache regression: whether a block gets a margin depends on the
    // entry *before* it, which is not part of that block's own row-cache key.
    const nodes: readonly TranscriptNode[] = [
      user(1), tool({ callId: 'a', id: 'tool:a', output: longOutput }), say(3, 'Answer.'),
    ]
    const entries = buildTranscriptEntries(nodes, generic)
    const cache = new Map()
    const card = entries[1]
    expect(card).toBeDefined()
    for (const overrides of [new Set<string>(), new Set([card!.id]), new Set<string>()]) {
      const lines = transcriptLines(entries, overrides, 0, cache)
      expect(lines.filter(line => line.text === '')).toHaveLength(1)
      const at = lines.findIndex(line => line.text.includes('Answer.'))
      expect(lines[at - 1]?.text).toBe('')
    }
  })
})

describe('wrapped text headers', () => {
  it('hangs continuations under the content after the marker', () => {
    const nodes: readonly TranscriptNode[] = [
      user(1, 'A user message long enough to wrap across several terminal rows.'),
      say(2, 'An assistant answer long enough to wrap across several terminal rows.'),
    ]
    const lines = transcriptLines(buildTranscriptEntries(nodes, generic), new Set(), 20)
    for (const id of ['user:1', 'assistant:2']) {
      const rows = lines.filter(line => line.entryId === id)
      expect(rows.length).toBeGreaterThan(1)
      expect(rows[0]?.text.startsWith('  ')).toBe(false)
      for (const row of rows.slice(1)) {
        expect(row.text.startsWith('  ')).toBe(true)
        expect(displayWidth(row.text)).toBeLessThanOrEqual(20)
      }
    }
  })

  it('keeps styled header segments identical to the indented row text', () => {
    const nodes: readonly TranscriptNode[] = [
      say(1, '**A bold assistant heading that wraps onto another terminal row.**'),
    ]
    const lines = transcriptLines(buildTranscriptEntries(nodes, generic), new Set(), 20)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(line.segments?.map(segment => segment.text).join('')).toBe(line.text)
    }
    expect(lines[1]?.text.startsWith('  ')).toBe(true)
  })
})
