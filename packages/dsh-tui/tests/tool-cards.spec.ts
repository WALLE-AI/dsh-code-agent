import { describe, expect, it } from 'vitest'
import type { ToolNode, ToolPresentation } from '../src/contracts.ts'
import { buildFileDiff } from '../src/diff-view.ts'
import { buildToolCard } from '../src/tool-card.ts'

const ESC = String.fromCharCode(0x1b)

function node(overrides: Partial<ToolNode> = {}): ToolNode {
  return {
    id: 'tool:c1', kind: 'tool', callId: 'c1', name: 'bash', input: '{}', output: '',
    status: 'succeeded', firstSeq: 1, lastSeq: 2, ...overrides,
  }
}

describe('terminal cards', () => {
  it('shows command, cwd, exit code, and the output tail', () => {
    const presentation: ToolPresentation = {
      call: { card: 'terminal', title: 'pnpm vitest run', cwd: '/repo', description: 'run tests' },
      result: { card: 'terminal', output: 'a\nb\nc\n', exitCode: 0 },
    }
    const card = buildToolCard(node({ output: 'ignored' }), presentation, { maxBodyLines: 2 })
    expect(card).toMatchObject({
      card: 'terminal', title: 'pnpm vitest run', subtitle: 'cwd /repo  run tests', badge: 'exit 0',
    })
    expect(card.body).toEqual(['b', 'c'])
    expect(card.dropped).toBe(1)
  })

  it('reports signals, running state, and sanitizes hostile output', () => {
    const running = buildToolCard(node({ status: 'pending' }), {
      call: { card: 'terminal', title: 'sleep 30' },
    })
    expect(running.badge).toBe('running')

    const killed = buildToolCard(node({ status: 'failed' }), {
      call: { card: 'terminal', title: 'sleep 30' },
      result: { card: 'terminal', output: `${ESC}]0;title${String.fromCharCode(7)}done`, signal: 'SIGTERM' },
    })
    expect(killed.badge).toBe('signal SIGTERM')
    expect(killed.body).toEqual(['done'])
  })

  it('bounds a very large output by bytes and rows', () => {
    const output = Array.from({ length: 5_000 }, (_, index) => `line-${String(index)}`).join('\n')
    const card = buildToolCard(node({ output }), {
      call: { card: 'terminal', title: 'cat big' },
      result: { card: 'terminal', output, exitCode: 0 },
    }, { maxBodyLines: 10, maxInlineBytes: 1_000 })
    expect(card.body).toHaveLength(10)
    expect(card.dropped).toBeGreaterThan(0)
    expect(card.body.at(-1)).toBe('line-4999')
  })
})

describe('diff cards', () => {
  it('renders unified hunks with line numbers and add/remove counts', () => {
    const card = buildToolCard(node({ name: 'edit' }), {
      call: { card: 'diff', title: 'Edit src/a.ts', diffs: [] },
      result: {
        card: 'diff',
        title: 'Edit src/a.ts',
        diffs: [{ path: 'src/a.ts', oldText: 'one\ntwo\nthree\n', newText: 'one\n2\nthree\n' }],
      },
    })
    expect(card).toMatchObject({ card: 'diff', badge: '+1 -1' })
    expect(card.diffStats).toEqual({ added: 1, removed: 1 })
    expect(card.locations).toEqual([{ path: 'src/a.ts' }])
    expect(card.body[0]).toBe('src/a.ts  +1 -1')
    expect(card.body.some(line => line.includes('-') && line.includes('two'))).toBe(true)
    expect(card.body.some(line => line.trimStart().startsWith('+') && line.includes('2'))).toBe(true)
  })

  it('marks created and binary files', () => {
    const created = buildFileDiff('new.ts', null, 'a\n')
    expect(created).toMatchObject({ created: true, added: 1, removed: 0, binary: false })

    const binary = buildFileDiff('blob.bin', null, `a${String.fromCharCode(0)}b`)
    expect(binary.binary).toBe(true)
    expect(binary.rows[0]?.text).toBe('binary file not shown')
  })

  it('falls back to a whole-file replacement above the diff cell guard', () => {
    const before = Array.from({ length: 60 }, (_, index) => `a${String(index)}`).join('\n')
    const after = Array.from({ length: 60 }, (_, index) => `b${String(index)}`).join('\n')
    const view = buildFileDiff('big.ts', before, after, { maxDiffCells: 100 })
    expect(view.added).toBe(60)
    expect(view.removed).toBe(60)
  })
})

describe('search, read, and generic cards', () => {
  it('groups search matches, keeps locations, and flags capping', () => {
    const card = buildToolCard(node({ name: 'grep' }), {
      call: { card: 'generic', title: 'Search "flush"', kind: 'search' },
      result: {
        card: 'search',
        shape: 'matches',
        total: 17,
        truncated: true,
        files: [{ path: 'src/a.ts', matches: [{ lineNumber: 12, line: 'await flush()' }] }],
      },
    })
    expect(card).toMatchObject({ card: 'search', badge: '17 matches (capped)' })
    expect(card.body).toEqual(['src/a.ts', '  12: await flush()'])
    expect(card.locations).toEqual([{ path: 'src/a.ts', line: 12 }])
  })

  it('lists glob paths with their total', () => {
    const card = buildToolCard(node({ name: 'glob' }), {
      call: { card: 'generic', title: 'Find *.ts' },
      result: { card: 'search', shape: 'paths', total: 2, truncated: false, paths: ['a.ts', 'b.ts'] },
    })
    expect(card.badge).toBe('2 paths')
    expect(card.body).toEqual(['a.ts', 'b.ts'])
  })

  it('numbers read windows and points the editor at the offset', () => {
    const card = buildToolCard(node({ name: 'read' }), {
      call: { card: 'generic', title: 'Read src/a.ts', kind: 'read' },
      result: {
        card: 'read', path: 'src/a.ts', offset: 10, totalLines: 400,
        lines: [{ number: 10, text: 'const a = 1' }],
      },
    })
    expect(card).toMatchObject({ card: 'read', subtitle: 'src/a.ts', badge: '1 of 400 lines' })
    expect(card.body).toEqual(['   10 const a = 1'])
    expect(card.locations).toEqual([{ path: 'src/a.ts', line: 10 }])
  })

  it('degrades unknown, absent, and malformed intents to the generic card', () => {
    const generic = buildToolCard(node({ input: '{"path":"a.ts"}', output: 'done' }), {
      call: { card: 'generic', title: 'Custom tool', rawInput: { path: 'a.ts' } },
    })
    expect(generic).toMatchObject({ card: 'generic', title: 'Custom tool', subtitle: '{"path":"a.ts"}' })
    expect(generic.body).toEqual(['done'])

    const malformed = buildToolCard(node({ output: 'raw' }), {
      call: { card: 'diff', title: 'Broken' },
      result: { card: 'diff', get diffs(): never { throw new Error('boom') } },
    })
    expect(malformed.card).toBe('generic')
    expect(malformed.title).toBe('bash')
  })
})
