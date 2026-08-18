import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { summarizeActivity, type ActivityCounters, type ActivitySummary } from '../src/activity.ts'
import {
  buildStatusModel, renderContextBar, renderSegments,
  type StatusContext, type StatusSegment,
} from '../src/status-line.ts'
import { displayWidth } from '../src/terminal-text.ts'

const COUNTERS: ActivityCounters = { tools: 12, filesAdded: 40, filesRemoved: 3, approvals: 1 }

const ACTIVITY: ActivitySummary = {
  title: 'fix the flush race',
  planActive: true,
  todos: { total: 5, done: 2 },
  permission: { current: 'workspace-write', options: [] },
  context: { tokens: 45_000, window: 100_000, percent: 45 },
  tokens: { input: 12_400, output: 830 },
  subagent: 'reviewer',
}

const IDLE: StatusContext = {
  branch: 'main', directory: 'dsh-code-agent', running: false, paused: false, unread: 0,
}

describe('status model', () => {
  it('projects the activity summary into ordered segments', () => {
    const model = buildStatusModel(ACTIVITY, COUNTERS, IDLE)
    expect(model.left.map(segment => segment.text)).toEqual([
      'workspace-write', 'plan', 'ctx 45%', 'todo 2/5', 'tools 12',
      'files +40 -3', 'approvals 1', 'subagent reviewer', 'tok 12k→830',
    ])
    expect(model.right.map(segment => segment.text))
      .toEqual(['main', 'dsh-code-agent', 'fix the flush race'])
  })

  it('shows the cache hit share, and drops it before anything else', () => {
    const activity: ActivitySummary = {
      ...ACTIVITY,
      tokens: { input: 12_400, output: 830, cacheHitPercent: 76 },
    }
    const model = buildStatusModel(activity, COUNTERS, IDLE)
    expect(model.left.map(segment => segment.text)).toContain('cache 76%')
    const worst = model.left.reduce((a, b) => (b.priority > a.priority ? b : a))
    expect(worst.text).toBe('cache 76%')
  })

  it('measures context pressure only when a window was reported', () => {
    expect(buildStatusModel(ACTIVITY, COUNTERS, IDLE).bar).toEqual({ used: 45_000, total: 100_000 })
    expect(buildStatusModel({ planActive: false }, COUNTERS, IDLE).bar).toBeUndefined()
  })

  it('says what the next key does, and what scrolling away cost', () => {
    expect(buildStatusModel(ACTIVITY, COUNTERS, IDLE).hint).toBe('ctrl+p commands')
    expect(buildStatusModel(ACTIVITY, COUNTERS, { ...IDLE, running: true }).hint)
      .toBe('esc to interrupt')
    expect(buildStatusModel(ACTIVITY, COUNTERS, { ...IDLE, paused: true, unread: 7 }).hint)
      .toBe('paused · 7 unread')
    expect(buildStatusModel(ACTIVITY, COUNTERS, { ...IDLE, paused: true }).hint).toBe('paused')
  })

  it('omits a field the projection never reported instead of showing a zero', () => {
    const model = buildStatusModel({ planActive: false }, {
      tools: 0, filesAdded: 0, filesRemoved: 0, approvals: 0,
    }, { running: false, paused: false, unread: 0 })
    expect(model.left.map(segment => segment.text)).toEqual(['tools 0'])
    expect(model.right).toEqual([])
  })
})

describe('cache hit share', () => {
  it('divides cache reads by everything billed on the prompt side', () => {
    // The three buckets are disjoint, so 30 of 100 billed input tokens is 30%.
    const summary = summarizeActivity({
      tokenUsage: {
        uncachedInputTokens: 60, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 10,
      },
    })
    expect(summary.tokens?.cacheHitPercent).toBe(30)
  })

  it('reports nothing when the provider has billed no input yet', () => {
    const fresh = summarizeActivity({
      tokenUsage: {
        uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      },
    })
    expect(fresh.tokens).toEqual({ input: 0, output: 0 })
    // An older projection that predates the cache buckets gets no invented zero.
    const partial = summarizeActivity({ tokenUsage: { uncachedInputTokens: 90, outputTokens: 3 } })
    expect(partial.tokens?.cacheHitPercent).toBeUndefined()
  })
})

describe('segment fitting', () => {
  it('drops the least important segment first', () => {
    const model = buildStatusModel(ACTIVITY, COUNTERS, IDLE)
    expect(renderSegments(model.right, 80)).toBe('main · dsh-code-agent · fix the flush race')
    // The title goes before the directory, and the branch outlives both.
    expect(renderSegments(model.right, 25)).toBe('main · dsh-code-agent')
    expect(renderSegments(model.right, 10)).toBe('main')
  })

  it('never keeps the permission preset out to make room for token counts', () => {
    const model = buildStatusModel(ACTIVITY, COUNTERS, IDLE)
    expect(renderSegments(model.left, 24)).toBe('workspace-write · plan')
  })

  it('cuts a single oversized segment rather than rendering nothing', () => {
    const one: readonly StatusSegment[] = [{ text: 'an extremely long branch name', priority: 0 }]
    const rendered = renderSegments(one, 10)
    expect(displayWidth(rendered)).toBeLessThanOrEqual(10)
    expect(rendered).not.toBe('')
  })

  it('stays inside the budget for any segment set and width', () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        text: fc.string({ maxLength: 20 }),
        priority: fc.integer({ min: 0, max: 5 }),
      }), { maxLength: 10 }),
      fc.integer({ min: 0, max: 60 }),
      (segments, columns) => {
        expect(displayWidth(renderSegments(segments, columns))).toBeLessThanOrEqual(columns)
      },
    ))
  })
})

describe('context bar', () => {
  it('fills in proportion to the pressure', () => {
    expect(renderContextBar(0, 100, 10)).toBe(' '.repeat(10))
    expect(renderContextBar(100, 100, 10)).toBe('█'.repeat(10))
    expect(renderContextBar(50, 100, 10)).toBe(`${'█'.repeat(5)}${' '.repeat(5)}`)
  })

  it('shows a partial cell rather than rounding a small load to nothing', () => {
    const bar = renderContextBar(1, 100, 10)
    expect(bar).not.toBe(' '.repeat(10))
    expect(bar.startsWith('█')).toBe(false)
  })

  it('is exactly the requested width for any load', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 200_000 }),
      fc.integer({ min: 1, max: 200_000 }),
      fc.integer({ min: 1, max: 60 }),
      (used, total, width) => {
        expect(displayWidth(renderContextBar(used, total, width))).toBe(width)
      },
    ))
  })

  it('renders nothing when there is no room or no window', () => {
    expect(renderContextBar(5, 10, 0)).toBe('')
    expect(renderContextBar(5, 0, 10)).toBe('')
  })
})
