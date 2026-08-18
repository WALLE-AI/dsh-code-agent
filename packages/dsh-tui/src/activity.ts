/**
 * Status-line and activity projection. Values come from the registered Harness
 * session projections; the TUI never keeps a second task or permission state.
 */

import { sanitizeLine } from './terminal-text.ts'

export interface PermissionOption {
  readonly value: string
  readonly name: string
  readonly description?: string
}

export interface ActivitySummary {
  readonly title?: string
  readonly goal?: string
  readonly planActive: boolean
  readonly todos?: { readonly total: number; readonly done: number; readonly active?: string }
  readonly permission?: { readonly current: string; readonly options: readonly PermissionOption[] }
  readonly context?: { readonly tokens?: number; readonly window?: number; readonly percent?: number }
  readonly tokens?: {
    readonly input: number
    readonly output: number
    /**
     * Share of billed prompt tokens the provider served from its cache, over
     * the whole durable log. Absent until something has been billed.
     */
    readonly cacheHitPercent?: number
  }
  readonly subagent?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function label(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? sanitizeLine(value.trim()) : undefined
}

function todosOf(value: unknown): ActivitySummary['todos'] {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const items = value.flatMap((item) => {
    const entry = record(item)
    return entry === undefined ? [] : [entry]
  })
  const done = items.filter(item => item.status === 'completed').length
  const active = items.find(item => item.status === 'in_progress')
  const content = label(active?.content)
  return {
    total: items.length,
    done,
    ...(content === undefined ? {} : { active: content }),
  }
}

function permissionsOf(value: unknown): ActivitySummary['permission'] {
  const select = record(value)
  const current = label(select?.currentValue)
  if (current === undefined) return undefined
  const options = (Array.isArray(select?.options) ? select.options : []).flatMap((item) => {
    const option = record(item)
    const optionValue = label(option?.value)
    if (optionValue === undefined) return []
    const description = label(option?.description)
    return [{
      value: optionValue,
      name: label(option?.name) ?? optionValue,
      ...(description === undefined ? {} : { description }),
    }]
  })
  return { current, options }
}

/** Fold the registered projection values the terminal surfaces. */
export function summarizeActivity(values: Readonly<Record<string, unknown>>): ActivitySummary {
  const pressure = record(values.contextPressure)
  const usage = record(values.tokenUsage)
  const plan = record(values.plan)
  const subagent = record(values.subagent)
  const tokens = count(pressure?.projectedTokens) ?? count(pressure?.pressureTokens)
  const window = count(pressure?.contextWindow)
  const input = count(usage?.uncachedInputTokens)
  const output = count(usage?.outputTokens)
  const cacheRead = count(usage?.cacheReadTokens)
  const cacheWrite = count(usage?.cacheWriteTokens)
  // The three prompt-side buckets are disjoint, so their sum is what was billed
  // on the way in — the same definition the Harness's own stats line uses
  // (`ui-conversation/.../StatsLine.tsx:cacheHitPercent`). Nothing is inferred
  // when a bucket is missing: no denominator, no figure.
  const billed = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
  const cacheHitPercent = cacheRead === undefined || billed === 0
    ? undefined
    : Math.round((cacheRead / billed) * 100)
  const goal = record(values.goal)
  const title = label(values.title)
  const goalText = label(goal?.text ?? goal?.title ?? values.goal)
  const todos = todosOf(values.todos)
  const permission = permissionsOf(values.permissions)
  return {
    ...(title === undefined ? {} : { title }),
    ...(goalText === undefined ? {} : { goal: goalText }),
    planActive: plan?.active === true,
    ...(todos === undefined ? {} : { todos }),
    ...(permission === undefined ? {} : { permission }),
    ...(tokens === undefined && window === undefined ? {} : {
      context: {
        ...(tokens === undefined ? {} : { tokens }),
        ...(window === undefined ? {} : { window }),
        ...(tokens === undefined || window === undefined || window === 0
          ? {}
          : { percent: Math.min(100, Math.round((tokens / window) * 100)) }),
      },
    }),
    ...(input === undefined && output === undefined
      ? {}
      : {
        tokens: {
          input: input ?? 0,
          output: output ?? 0,
          ...(cacheHitPercent === undefined ? {} : { cacheHitPercent }),
        },
      }),
    ...(label(subagent?.name) === undefined ? {} : { subagent: label(subagent?.name) as string }),
  }
}

export interface ActivityCounters {
  readonly tools: number
  readonly filesAdded: number
  readonly filesRemoved: number
  readonly approvals: number
}

// The status row itself is built in `status-line.ts`, which folds this summary
// into prioritized segments the layout can drop one at a time.
