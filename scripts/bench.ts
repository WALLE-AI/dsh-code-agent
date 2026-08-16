/**
 * Performance gate for the terminal projection stack (plan section 9.3).
 * Measures the pure object layer: session events -> projection -> transcript
 * entries -> display lines. No API key, no Harness process, no terminal.
 */

import { performance } from 'node:perf_hooks'
import type { TerminalEvent } from '../packages/dsh-tui/src/contracts.ts'
import { TuiStore } from '../packages/dsh-tui/src/state.ts'
import { buildToolCard } from '../packages/dsh-tui/src/tool-card.ts'

interface Budget {
  readonly name: string
  readonly ms: number
  readonly limitMs: number
  readonly detail: string
}

const results: Budget[] = []

function measure(name: string, limitMs: number, detail: string, body: () => void): void {
  const started = performance.now()
  body()
  results.push({ name, ms: performance.now() - started, limitMs, detail })
}

function conversation(count: number): TerminalEvent[] {
  const events: TerminalEvent[] = []
  for (let index = 0; index < count; index++) {
    const seq = index
    const cycle = index % 5
    if (cycle === 0) events.push({ seq, kind: 'user', text: `task ${String(index)}` })
    else if (cycle === 1) {
      events.push({ seq, kind: 'assistant-delta', text: `working on ${String(index)} `, messageId: `m${String(index)}` })
    } else if (cycle === 2) {
      events.push({ seq, kind: 'tool-call', text: '{"command":"pnpm test"}', name: 'bash', callId: `c${String(index)}` })
    } else if (cycle === 3) {
      events.push({ seq, kind: 'tool-result', text: `ok ${String(index)}`, callId: `c${String(index - 1)}` })
    } else events.push({ seq, kind: 'turn-end', text: 'completed' })
  }
  return events
}

function rebuildBench(count: number, limitMs: number): void {
  const events = conversation(count)
  const store = new TuiStore(count)
  measure(`rebuild ${String(count)} events`, limitMs, `${String(count)} events -> first screen`, () => {
    const issue = store.rebuild(events)
    if (issue !== undefined) throw new Error(`projection paused: ${issue.message}`)
  })
  if (store.snapshot().lines.length === 0) throw new Error('rebuild produced no lines')
}

rebuildBench(1_000, 300)
rebuildBench(10_000, 1_500)

/**
 * Steady-state footprint of one live 10k-event session: the events array is
 * released, only the store and its published snapshot stay reachable.
 */
const steadyStateRss = ((): { rss: number; store: TuiStore } => {
  const store = new TuiStore(10_000)
  const load = (): void => {
    const events = conversation(10_000)
    store.rebuild(events)
  }
  load()
  ;(globalThis as { gc?: () => void }).gc?.()
  return { rss: process.memoryUsage().rss / 1_048_576, store }
})()

rebuildBench(100_000, 15_000)

// Live append: every event publishes an immutable snapshot.
{
  const events = conversation(2_000)
  const store = new TuiStore(2_000)
  measure('live append 2000 events', 4_000, 'incremental publication per event', () => {
    for (const event of events) store.append(event)
  })
}

// One 10 MB command output must stay bounded in rows and bytes.
{
  const output = `${'x'.repeat(64)}\n`.repeat(160_000)
  let bodyLines = 0
  measure('10 MB terminal card', 400, `${String(Math.round(output.length / 1_048_576))} MB output`, () => {
    const card = buildToolCard({
      id: 'tool:big', kind: 'tool', callId: 'big', name: 'bash', input: '{}',
      output, status: 'succeeded', firstSeq: 1, lastSeq: 2,
    }, {
      call: { card: 'terminal', title: 'cat big.log' },
      result: { card: 'terminal', output, exitCode: 0 },
    })
    bodyLines = card.body.length
    if (card.dropped <= 0) throw new Error('10 MB output was not reported as capped')
  })
  if (bodyLines > 200) throw new Error(`inline body kept ${String(bodyLines)} rows`)
}

// 100 tool calls completing out of order must still pair by call id.
{
  const events: TerminalEvent[] = []
  for (let index = 0; index < 100; index++) {
    events.push({ seq: index, kind: 'tool-call', text: '{}', name: 'read', callId: `p${String(index)}` })
  }
  for (let index = 0; index < 100; index++) {
    events.push({
      seq: 100 + index, kind: 'tool-result', text: 'done', callId: `p${String(99 - index)}`,
    })
  }
  const store = new TuiStore(500)
  measure('100 parallel tool calls', 500, 'out-of-order completion', () => {
    for (const event of events) store.append(event)
  })
  const pending = store.snapshot().nodes.filter(node => node.kind === 'tool' && node.status === 'pending')
  if (pending.length > 0) throw new Error(`${String(pending.length)} calls never paired`)
}

// Keep the 10k session reachable so its footprint was measured, not collected.
if (steadyStateRss.store.snapshot().lines.length === 0) throw new Error('steady-state store was emptied')
const rssLimit = 200
const peakRss = process.memoryUsage().rss / 1_048_576
const failures = results.filter(result => result.ms > result.limitMs)

process.stdout.write('TUI projection benchmark\n')
for (const result of results) {
  process.stdout.write(`  ${result.name.padEnd(28)} ${result.ms.toFixed(1).padStart(9)} ms `
    + `(limit ${String(result.limitMs)} ms)  ${result.detail}\n`)
}
process.stdout.write(`  ${'10k steady-state RSS'.padEnd(28)} ${steadyStateRss.rss.toFixed(1).padStart(9)} MB `
  + `(limit ${String(rssLimit)} MB)\n`)
process.stdout.write(`  ${'peak RSS (all scenarios)'.padEnd(28)} ${peakRss.toFixed(1).padStart(9)} MB (reported only)\n`)

if (steadyStateRss.rss > rssLimit) {
  failures.push({ name: '10k steady-state RSS', ms: steadyStateRss.rss, limitMs: rssLimit, detail: 'MB' })
}
if (failures.length > 0) {
  process.stderr.write(`benchmark budget exceeded: ${failures.map(item => item.name).join(', ')}\n`)
  process.exit(1)
}
process.stdout.write('all projection budgets met\n')
