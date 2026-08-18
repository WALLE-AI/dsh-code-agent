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
  it('folds long successful tools by default and keeps failures open', () => {
    const nodes: readonly TranscriptNode[] = [
      tool({ callId: 'ok', id: 'tool:ok', output: longOutput }),
      tool({ callId: 'bad', id: 'tool:bad', output: longOutput, status: 'failed' }),
    ]
    const entries = buildTranscriptEntries(nodes, generic)
    expect(entries[0]?.foldedByDefault).toBe(true)
    expect(entries[1]?.foldedByDefault).toBe(false)
    expect(entries[1]?.tone).toBe('error')

    const folded = new Set<string>()
    expect(entryFolded(entries[0]!, folded)).toBe(true)
    folded.add('tool:ok')
    expect(entryFolded(entries[0]!, folded)).toBe(false)
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
