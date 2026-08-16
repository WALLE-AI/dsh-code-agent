/**
 * Transcript view model: durable projection nodes become sanitized, foldable
 * terminal entries. Rendering policy lives here; the Ink layer only paints rows.
 */

import type { ToolNode, ToolPresentation, TranscriptNode } from './contracts.ts'
import { sanitizeLine, sanitizeText } from './terminal-text.ts'
import { buildToolCard, type ToolCardLocation, type ToolCardOptions } from './tool-card.ts'

export type TranscriptTone = 'user' | 'assistant' | 'reasoning' | 'system' | 'tool' | 'error'

export interface TranscriptEntry {
  readonly id: string
  readonly nodeKind: 'text' | 'tool'
  readonly tone: TranscriptTone
  readonly depth: number
  readonly header: string
  readonly badge?: string
  readonly detail: readonly string[]
  readonly foldable: boolean
  /** Fold policy before any user override. */
  readonly foldedByDefault: boolean
  readonly locations: readonly ToolCardLocation[]
  readonly status?: ToolNode['status']
  readonly diffStats?: { readonly added: number; readonly removed: number }
}

/** Reusable per-node entry cache so a live append does not rebuild every card. */
export type TranscriptEntryCache = Map<string, { signature: string; entry: TranscriptEntry }>

export interface TranscriptLine {
  readonly entryId: string
  readonly text: string
  readonly tone: TranscriptTone
  readonly header: boolean
}

export interface TranscriptOptions extends ToolCardOptions {
  /** Successful tool cards longer than this fold by default. */
  readonly foldDetailAbove?: number
}

const FOLD_ABOVE = 8

const STATUS_SYMBOL: Record<ToolNode['status'], string> = {
  pending: '▸',
  succeeded: '✓',
  failed: '✗',
  interrupted: '⚠',
}

function splitText(value: string): { header: string; detail: readonly string[] } {
  const lines = sanitizeText(value).split('\n')
  while (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return { header: lines[0] ?? '', detail: lines.slice(1) }
}

function textEntry(node: Exclude<TranscriptNode, ToolNode>): TranscriptEntry {
  const { header, detail } = splitText(node.text)
  switch (node.kind) {
    case 'user':
      return {
        id: node.id, nodeKind: 'text', tone: 'user', depth: 0,
        header: `> ${header}`, detail, foldable: detail.length > 0,
        foldedByDefault: false, locations: [],
      }
    case 'reasoning':
      return {
        id: node.id, nodeKind: 'text', tone: 'reasoning', depth: 0,
        header: `~ ${header}`, detail, foldable: true, foldedByDefault: true, locations: [],
      }
    case 'marker':
      return {
        id: node.id, nodeKind: 'text', tone: 'system', depth: 0,
        header: `• ${header}`, detail, foldable: detail.length > 0,
        foldedByDefault: false, locations: [],
      }
    case 'turn':
      return {
        id: node.id, nodeKind: 'text', tone: header.startsWith('error') ? 'error' : 'system', depth: 0,
        header: `── turn ${header}`, detail, foldable: detail.length > 0,
        foldedByDefault: false, locations: [],
      }
    default:
      return {
        id: node.id, nodeKind: 'text', tone: 'assistant', depth: 0,
        header, detail, foldable: detail.length > 0, foldedByDefault: false, locations: [],
      }
  }
}

function toolEntry(
  node: ToolNode,
  presentation: ToolPresentation,
  depth: number,
  options: TranscriptOptions,
): TranscriptEntry {
  const card = buildToolCard(node, presentation, options)
  const detail = [
    ...(card.subtitle === undefined ? [] : [card.subtitle]),
    ...card.body,
    ...(card.dropped > 0 ? [`… ${String(card.dropped)} more line(s) not shown (output capped)`] : []),
  ]
  const foldAbove = options.foldDetailAbove ?? FOLD_ABOVE
  return {
    id: node.id,
    nodeKind: 'tool',
    tone: node.status === 'failed' ? 'error' : 'tool',
    depth,
    header: `${STATUS_SYMBOL[node.status]} ${card.title}`,
    ...(card.badge === undefined ? {} : { badge: card.badge }),
    detail,
    foldable: detail.length > 0,
    foldedByDefault: node.status === 'succeeded' && detail.length > foldAbove,
    locations: card.locations,
    status: node.status,
    ...(card.diffStats === undefined ? {} : { diffStats: card.diffStats }),
  }
}

function signatureOf(node: TranscriptNode, depth: number): string {
  return node.kind === 'tool'
    ? `tool|${String(depth)}|${String(node.lastSeq)}|${node.status}|${node.name}|${String(node.input.length)}|${String(node.output.length)}`
    : `${node.kind}|${String(node.lastSeq)}|${String(node.text.length)}`
}

/** Project durable transcript nodes into terminal entries. */
export function buildTranscriptEntries(
  nodes: readonly TranscriptNode[],
  present: (node: ToolNode) => ToolPresentation,
  options: TranscriptOptions = {},
  cache?: TranscriptEntryCache,
): readonly TranscriptEntry[] {
  const callIds = new Set(nodes.flatMap(node => node.kind === 'tool' ? [node.callId] : []))
  const live = new Set<string>()
  const entries = nodes.map((node) => {
    const depth = node.kind === 'tool' && node.parentCallId !== undefined && callIds.has(node.parentCallId)
      ? 1
      : 0
    const signature = signatureOf(node, depth)
    live.add(node.id)
    const cached = cache?.get(node.id)
    if (cached?.signature === signature) return cached.entry
    let entry: TranscriptEntry
    if (node.kind !== 'tool') {
      entry = textEntry(node)
    } else {
      let presentation: ToolPresentation
      try {
        presentation = present(node)
      } catch {
        presentation = { call: { card: 'generic', title: node.name } }
      }
      entry = toolEntry(node, presentation, depth, options)
    }
    cache?.set(node.id, { signature, entry })
    return entry
  })
  if (cache !== undefined) {
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id)
  }
  return entries
}

/** True when an entry renders collapsed given the user's fold overrides. */
export function entryFolded(entry: TranscriptEntry, overrides: ReadonlySet<string>): boolean {
  if (!entry.foldable) return false
  return overrides.has(entry.id) ? !entry.foldedByDefault : entry.foldedByDefault
}

/** Flatten entries into display rows, honouring indentation and fold state. */
export function transcriptLines(
  entries: readonly TranscriptEntry[],
  overrides: ReadonlySet<string> = new Set(),
): readonly TranscriptLine[] {
  const lines: TranscriptLine[] = []
  for (const entry of entries) {
    const indent = '  '.repeat(entry.depth)
    lines.push({
      entryId: entry.id,
      tone: entry.tone,
      header: true,
      text: sanitizeLine(`${indent}${entry.header}${entry.badge === undefined ? '' : `  [${entry.badge}]`}`),
    })
    if (entryFolded(entry, overrides)) {
      if (entry.detail.length > 0) {
        lines.push({
          entryId: entry.id,
          tone: 'system',
          header: false,
          text: `${indent}  … ${String(entry.detail.length)} hidden line(s), Ctrl+O to expand`,
        })
      }
      continue
    }
    for (const line of entry.detail) {
      lines.push({ entryId: entry.id, tone: entry.tone, header: false, text: `${indent}  ${line}` })
    }
  }
  return lines
}

/** Identify the tool card a fold or editor shortcut applies to. */
export function currentToolEntryId(
  entries: readonly TranscriptEntry[],
  lines: readonly TranscriptLine[],
  visibleEnd: number,
): string | undefined {
  const visible = new Set(lines.slice(0, Math.max(0, visibleEnd)).map(line => line.entryId))
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry?.nodeKind === 'tool' && visible.has(entry.id)) return entry.id
  }
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.nodeKind === 'tool') return entries[index]?.id
  }
  return undefined
}
