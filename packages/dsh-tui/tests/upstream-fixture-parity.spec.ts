import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConversationProjection } from '../src/conversation-projection.ts'
import { normalizeEvent, type RuntimeEvent } from '../src/harness-adapter.ts'
import type { ToolNode, TranscriptNode } from '../src/contracts.ts'

interface CorpusEntry {
  name: string
  path: string
  webSnapshot?: string
}

const workspace = join(import.meta.dirname, '../../..')
const harness = join(workspace, 'opensource/deepseek-harness/deepseek-harness-master')
const corpus = JSON.parse(readFileSync(
  join(import.meta.dirname, 'fixtures/upstream-session-corpus.json'),
  'utf8',
)) as CorpusEntry[]
const replay = await import(new URL(
  '../../../opensource/deepseek-harness/deepseek-harness-master/packages/test-support/llm-replay/src/index.ts',
  import.meta.url,
).href) as { parseSessionLog(text: string): RuntimeEvent[] }
const sessionRuntime = await import(new URL(
  '../../../opensource/deepseek-harness/deepseek-harness-master/packages/core/session/src/index.ts',
  import.meta.url,
).href) as { KNOWN_SESSION_EVENT_TYPES: ReadonlySet<string> }

function project(entry: CorpusEntry): { raw: RuntimeEvent[]; nodes: readonly TranscriptNode[] } {
  const raw = replay.parseSessionLog(readFileSync(join(harness, entry.path), 'utf8'))
  expect(raw.map(event => event.seq)).toEqual(raw.map((_, index) => index))
  const events = raw.map(event => normalizeEvent(event, sessionRuntime.KNOWN_SESSION_EVENT_TYPES))
  const seeded = new ConversationProjection(10_000)
  seeded.rebuild(events)
  const live = new ConversationProjection(10_000)
  for (const event of events) live.append(event)
  expect(seeded.snapshot().status).toBe('healthy')
  expect(live.snapshot()).toEqual(seeded.snapshot())
  return { raw, nodes: seeded.snapshot().nodes }
}

function tools(nodes: readonly TranscriptNode[]): ToolNode[] {
  return nodes.filter((node): node is ToolNode => node.kind === 'tool')
}

describe('fixed Harness session fixture parity', () => {
  it('pins eight upstream raw-session scenarios', () => {
    expect(corpus.map(entry => entry.name)).toEqual([
      'text', 'parallel-tools', 'code-mode', 'failed-shell',
      'diff', 'compaction', 'subagent', 'approval-rejected',
    ])
    for (const entry of corpus) expect(project(entry).raw.length).toBeGreaterThan(0)
  })

  it('preserves text and parallel tool semantics', () => {
    const text = project(corpus[0] as CorpusEntry).nodes
    expect(text.some(node => node.kind === 'assistant' && node.text.includes('PONG'))).toBe(true)

    const parallel = tools(project(corpus[1] as CorpusEntry).nodes).filter(node => node.name === 'read')
    expect(parallel.map(node => node.status)).toEqual(['succeeded', 'succeeded'])
    expect(new Set(parallel.map(node => node.callId)).size).toBe(2)
  })

  it('matches the Web Code Mode snapshot on critical nested-call semantics', () => {
    const entry = corpus[2] as CorpusEntry
    const codeTools = tools(project(entry).nodes)
    const root = codeTools.find(node => node.name === 'run_code')
    const children = codeTools.filter(node => node.parentCallId === root?.callId)
    expect(children.map(node => [node.name, node.status])).toEqual([
      ['bash', 'succeeded'],
      ['read', 'failed'],
    ])
    expect(children[0]?.output).toContain('CODE_ROUND_OK')
    expect(children[1]?.output).toContain('not found')

    const web = readFileSync(join(harness, entry.webSnapshot as string), 'utf8')
    for (const semantic of ['Code Run', 'Bash', 'Read Error:', 'CODE_ROUND_OK', 'DONE']) {
      expect(web).toContain(semantic)
    }
    expect(project(entry).nodes.some(node => node.kind === 'assistant' && node.text.includes('DONE'))).toBe(true)
  })

  it('preserves failed shell and diff metadata', () => {
    const failed = tools(project(corpus[3] as CorpusEntry).nodes)
    expect(failed.some(node => node.name === 'bash' && node.status === 'failed')).toBe(true)

    const edit = tools(project(corpus[4] as CorpusEntry).nodes).find(node => node.name === 'edit')
    expect(edit).toMatchObject({ status: 'succeeded' })
    expect(edit?.metadata?.diffs).toEqual([
      expect.objectContaining({ path: 'config.txt', oldText: expect.any(String), newText: expect.any(String) }),
    ])
  })

  it('preserves compaction, subagent, and rejected approval markers', () => {
    const compacted = project(corpus[5] as CorpusEntry).nodes
    expect(compacted.some(node => node.kind === 'marker' && node.text === 'Conversation compacted')).toBe(true)

    const delegated = tools(project(corpus[6] as CorpusEntry).nodes)
    expect(delegated.some(node => node.name === 'subagent' && node.status === 'succeeded')).toBe(true)

    const rejected = project(corpus[7] as CorpusEntry).nodes
    expect(rejected.some(node => node.kind === 'marker' && node.text === 'Approval rejected')).toBe(true)
    expect(tools(rejected).some(node => node.name === 'bash' && node.status === 'failed')).toBe(true)
  })
})
