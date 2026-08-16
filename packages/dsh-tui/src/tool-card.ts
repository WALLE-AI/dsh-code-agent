/**
 * Tool card view model. Cards are built from the render intents a tool declares
 * through `presentCall`/`presentResult` — never from tool names — and every card
 * degrades to the generic shape when an intent is missing or malformed.
 */

import type { ToolNode, ToolPresentation, ToolRenderIntent } from './contracts.ts'
import { buildFileDiff, diffRowText, type DiffOptions } from './diff-view.ts'
import { sanitizeLine, sanitizeText, truncateToWidth } from './terminal-text.ts'

export type ToolCardKind = 'generic' | 'terminal' | 'diff' | 'search' | 'read' | 'web'

export interface ToolCardLocation {
  readonly path: string
  readonly line?: number
}

export interface ToolCardView {
  readonly callId: string
  readonly card: ToolCardKind
  readonly title: string
  readonly subtitle?: string
  readonly badge?: string
  readonly status: ToolNode['status']
  readonly body: readonly string[]
  /** Body rows the inline budget dropped; zero means the card is complete. */
  readonly dropped: number
  /** Line statistics for diff cards, so the status line can total file churn. */
  readonly diffStats?: { readonly added: number; readonly removed: number }
  readonly locations: readonly ToolCardLocation[]
  readonly parentCallId?: string
}

export interface ToolCardOptions {
  readonly maxBodyLines?: number
  readonly maxInlineBytes?: number
  readonly titleColumns?: number
  readonly diff?: DiffOptions
}

const DEFAULTS = { maxBodyLines: 200, maxInlineBytes: 256 * 1024, titleColumns: 160 } as const

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? sanitizeLine(value) : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function list(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> =>
    typeof item === 'object' && item !== null)
}

/** Flatten harness content blocks into plain text. */
function contentText(value: unknown): string | undefined {
  const blocks = list(value)
  if (blocks.length === 0) return undefined
  const joined = blocks
    .map(block => typeof block.text === 'string' ? block.text : '')
    .join('')
  return joined === '' ? undefined : joined
}

function locationsOf(value: unknown): ToolCardLocation[] {
  return list(value).flatMap((item) => {
    const path = typeof item.path === 'string' && item.path !== '' ? item.path : undefined
    if (path === undefined) return []
    const line = number(item.line)
    return [{ path: sanitizeLine(path), ...(line === undefined ? {} : { line }) }]
  })
}

interface BoundedBody {
  readonly lines: readonly string[]
  readonly dropped: number
}

/** Bound one card's inline body by row count and byte budget. */
function bounded(
  value: string,
  keep: 'head' | 'tail',
  options: Required<Pick<ToolCardOptions, 'maxBodyLines' | 'maxInlineBytes'>>,
): BoundedBody {
  const clipped = value.length > options.maxInlineBytes
    ? keep === 'tail' ? value.slice(-options.maxInlineBytes) : value.slice(0, options.maxInlineBytes)
    : value
  const all = sanitizeText(clipped).split('\n')
  while (all.length > 0 && all.at(-1) === '') all.pop()
  const bytesDropped = value.length - clipped.length
  if (all.length <= options.maxBodyLines) {
    return { lines: all, dropped: bytesDropped > 0 ? 1 : 0 }
  }
  const lines = keep === 'tail' ? all.slice(-options.maxBodyLines) : all.slice(0, options.maxBodyLines)
  return { lines, dropped: all.length - options.maxBodyLines }
}

function compact(value: unknown, columns: number): string | undefined {
  if (value === undefined || value === null) return undefined
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  if (raw === undefined || raw === '') return undefined
  return truncateToWidth(sanitizeLine(raw), columns)
}

function statusBadge(node: ToolNode): string | undefined {
  if (node.status === 'pending') return 'running'
  if (node.status === 'interrupted') return 'interrupted'
  if (node.status === 'failed') return 'failed'
  return undefined
}

function terminalCard(
  node: ToolNode, call: ToolRenderIntent, result: ToolRenderIntent | undefined,
  options: Required<Omit<ToolCardOptions, 'diff'>>,
): ToolCardView {
  const exitCode = number(result?.exitCode)
  const signal = text(result?.signal)
  const badge = node.status === 'pending'
    ? 'running'
    : signal !== undefined
      ? `signal ${signal}`
      : exitCode !== undefined
        ? `exit ${String(exitCode)}`
        : statusBadge(node)
  const cwd = text(call.cwd)
  const description = text(call.description)
  const subtitle = [cwd === undefined ? undefined : `cwd ${cwd}`, description]
    .filter((part): part is string => part !== undefined).join('  ')
  const output = typeof result?.output === 'string' ? result.output : node.output
  const body = bounded(output, 'tail', options)
  return {
    callId: node.callId,
    card: 'terminal',
    title: text(result?.title) ?? text(call.title) ?? node.name,
    ...(subtitle === '' ? {} : { subtitle }),
    ...(badge === undefined ? {} : { badge }),
    status: node.status,
    body: body.lines,
    dropped: body.dropped,
    locations: locationsOf(call.locations),
    ...(node.parentCallId === undefined ? {} : { parentCallId: node.parentCallId }),
  }
}

function diffCard(
  node: ToolNode, call: ToolRenderIntent, result: ToolRenderIntent | undefined,
  options: Required<Omit<ToolCardOptions, 'diff'>>, diffOptions: DiffOptions,
): ToolCardView {
  const source = list(result?.diffs).length > 0 ? list(result?.diffs) : list(call.diffs)
  const files = source.flatMap((entry) => {
    const path = typeof entry.path === 'string' ? entry.path : undefined
    if (path === undefined) return []
    const oldText = typeof entry.oldText === 'string' ? entry.oldText : null
    const newText = typeof entry.newText === 'string' ? entry.newText : ''
    return [buildFileDiff(sanitizeLine(path), oldText, newText, diffOptions)]
  })
  const added = files.reduce((total, file) => total + file.added, 0)
  const removed = files.reduce((total, file) => total + file.removed, 0)
  const binary = files.some(file => file.binary)
  const rows: string[] = []
  let dropped = 0
  for (const file of files) {
    rows.push(`${file.path}${file.created ? ' (new file)' : ''}  +${String(file.added)} -${String(file.removed)}`)
    for (const row of file.rows) rows.push(sanitizeLine(diffRowText(row, !file.binary)))
    dropped += file.droppedRows
  }
  const trimmed = rows.slice(0, options.maxBodyLines)
  dropped += Math.max(0, rows.length - options.maxBodyLines)
  const locations = locationsOf(call.locations)
  return {
    callId: node.callId,
    card: 'diff',
    title: text(result?.title) ?? text(call.title) ?? node.name,
    badge: binary ? 'binary' : `+${String(added)} -${String(removed)}`,
    status: node.status,
    body: trimmed,
    dropped,
    diffStats: { added, removed },
    locations: locations.length > 0 ? locations : files.map(file => ({ path: file.path })),
    ...(node.parentCallId === undefined ? {} : { parentCallId: node.parentCallId }),
  }
}

function searchCard(
  node: ToolNode, call: ToolRenderIntent, result: ToolRenderIntent,
  options: Required<Omit<ToolCardOptions, 'diff'>>,
): ToolCardView {
  const truncated = result.truncated === true
  const total = number(result.total) ?? 0
  const rows: string[] = []
  const locations: ToolCardLocation[] = []
  if (result.shape === 'paths') {
    for (const path of Array.isArray(result.paths) ? result.paths : []) {
      if (typeof path !== 'string') continue
      rows.push(sanitizeLine(path))
      locations.push({ path: sanitizeLine(path) })
    }
  } else {
    for (const file of list(result.files)) {
      const path = typeof file.path === 'string' ? sanitizeLine(file.path) : undefined
      if (path === undefined) continue
      rows.push(path)
      for (const match of list(file.matches)) {
        const line = number(match.lineNumber)
        rows.push(`  ${String(line ?? '')}: ${sanitizeLine(String(match.line ?? ''))}`)
        locations.push({ path, ...(line === undefined ? {} : { line }) })
      }
    }
  }
  const trimmed = rows.slice(0, options.maxBodyLines)
  const unit = result.shape === 'paths' ? 'paths' : 'matches'
  return {
    callId: node.callId,
    card: 'search',
    title: text(result.title) ?? text(call.title) ?? node.name,
    badge: `${String(total)} ${unit}${truncated ? ' (capped)' : ''}`,
    status: node.status,
    body: trimmed,
    dropped: Math.max(0, rows.length - options.maxBodyLines),
    locations,
    ...(node.parentCallId === undefined ? {} : { parentCallId: node.parentCallId }),
  }
}

function readCard(
  node: ToolNode, call: ToolRenderIntent, result: ToolRenderIntent,
  options: Required<Omit<ToolCardOptions, 'diff'>>,
): ToolCardView {
  const path = text(result.path) ?? ''
  const offset = number(result.offset) ?? 1
  const totalLines = number(result.totalLines)
  const lines = list(result.lines)
  const rows = lines.map((line) => {
    const numbered = number(line.number)
    return `${String(numbered ?? '').padStart(5)} ${sanitizeLine(String(line.text ?? ''))}`
  })
  const trimmed = rows.slice(0, options.maxBodyLines)
  const body = rows.length === 0
    ? bounded(contentText(result.content) ?? node.output, 'head', options)
    : { lines: trimmed, dropped: Math.max(0, rows.length - options.maxBodyLines) }
  return {
    callId: node.callId,
    card: 'read',
    title: text(result.title) ?? text(call.title) ?? node.name,
    ...(path === '' ? {} : { subtitle: path }),
    ...(totalLines === undefined
      ? {}
      : { badge: `${String(lines.length)} of ${String(totalLines)} lines` }),
    status: node.status,
    body: body.lines,
    dropped: body.dropped,
    locations: path === '' ? [] : [{ path, line: offset }],
    ...(node.parentCallId === undefined ? {} : { parentCallId: node.parentCallId }),
  }
}

function webCard(
  node: ToolNode, call: ToolRenderIntent, result: ToolRenderIntent,
  options: Required<Omit<ToolCardOptions, 'diff'>>,
): ToolCardView {
  const truncated = result.truncated === true
  if (result.kind === 'fetch') {
    const status = number(result.statusCode)
    const body = bounded(node.output, 'head', options)
    return {
      callId: node.callId,
      card: 'web',
      title: text(result.title) ?? text(call.title) ?? node.name,
      ...(text(result.url) === undefined ? {} : { subtitle: text(result.url) as string }),
      badge: `HTTP ${String(status ?? '?')}${truncated ? ' (truncated)' : ''}`,
      status: node.status,
      body: body.lines,
      dropped: body.dropped,
      locations: [],
      ...(node.parentCallId === undefined ? {} : { parentCallId: node.parentCallId }),
    }
  }
  const sources = list(result.sources)
  const answer = text(result.answer)
  const rows = [
    ...(answer === undefined ? [] : [answer]),
    ...sources.map(source => `- ${sanitizeLine(String(source.title ?? source.url ?? ''))}  ${sanitizeLine(String(source.url ?? ''))}`),
  ]
  return {
    callId: node.callId,
    card: 'web',
    title: text(result.title) ?? text(call.title) ?? node.name,
    badge: `${String(sources.length)} sources${truncated ? ' (capped)' : ''}`,
    status: node.status,
    body: rows.slice(0, options.maxBodyLines),
    dropped: Math.max(0, rows.length - options.maxBodyLines),
    locations: [],
    ...(node.parentCallId === undefined ? {} : { parentCallId: node.parentCallId }),
  }
}

function genericCard(
  node: ToolNode, call: ToolRenderIntent, result: ToolRenderIntent | undefined,
  options: Required<Omit<ToolCardOptions, 'diff'>>,
): ToolCardView {
  const subtitle = compact(call.rawInput ?? (node.input === '' ? undefined : node.input), options.titleColumns)
  const output = contentText(result?.content) ?? contentText(call.content) ?? node.output
  const body = bounded(output, 'head', options)
  const badge = statusBadge(node)
  return {
    callId: node.callId,
    card: 'generic',
    title: text(result?.title) ?? text(call.title) ?? node.name,
    ...(subtitle === undefined ? {} : { subtitle }),
    ...(badge === undefined ? {} : { badge }),
    status: node.status,
    body: body.lines,
    dropped: body.dropped,
    locations: locationsOf(call.locations),
    ...(node.parentCallId === undefined ? {} : { parentCallId: node.parentCallId }),
  }
}

/** Build the terminal card for one tool node from its declared render intents. */
export function buildToolCard(
  node: ToolNode,
  presentation: ToolPresentation,
  options: ToolCardOptions = {},
): ToolCardView {
  const settings = {
    maxBodyLines: options.maxBodyLines ?? DEFAULTS.maxBodyLines,
    maxInlineBytes: options.maxInlineBytes ?? DEFAULTS.maxInlineBytes,
    titleColumns: options.titleColumns ?? DEFAULTS.titleColumns,
  }
  const call = presentation.call
  const result = presentation.result
  const card = result?.card ?? call.card
  try {
    switch (card) {
      case 'terminal': return terminalCard(node, call, result, settings)
      case 'diff': return diffCard(node, call, result, settings, options.diff ?? {})
      case 'search': return result === undefined
        ? genericCard(node, call, result, settings)
        : searchCard(node, call, result, settings)
      case 'read': return result === undefined
        ? genericCard(node, call, result, settings)
        : readCard(node, call, result, settings)
      case 'web': return result === undefined
        ? genericCard(node, call, result, settings)
        : webCard(node, call, result, settings)
      default: return genericCard(node, call, result, settings)
    }
  } catch {
    // A malformed intent must never take down the transcript.
    return genericCard(node, { card: 'generic', title: node.name }, undefined, settings)
  }
}
