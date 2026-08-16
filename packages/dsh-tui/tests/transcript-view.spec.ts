import { describe, expect, it } from 'vitest'
import type { ToolNode, ToolPresentation, TranscriptNode } from '../src/contracts.ts'
import {
  buildTranscriptEntries, currentToolEntryId, entryFolded, transcriptLines,
} from '../src/transcript-view.ts'

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
    expect(lines[1]?.text).toContain('hidden line(s), Ctrl+O to expand')
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

  it('survives a throwing tool presenter', () => {
    const entries = buildTranscriptEntries([tool({ callId: 'c', id: 'tool:c' })], () => {
      throw new Error('presenter exploded')
    })
    expect(entries[0]?.header).toBe('✓ bash')
  })
})
