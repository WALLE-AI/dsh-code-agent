/**
 * Transcript view model: durable projection nodes become sanitized, foldable
 * terminal entries. Rendering policy lives here; the Ink layer only paints rows.
 */

import type { ToolNode, ToolPresentation, TranscriptNode } from './contracts.ts'
import { UNICODE_GLYPHS, type GlyphSet } from './glyphs.ts'
import { renderMarkdown } from './markdown.ts'
import {
  plainLines, wrapSegments,
  type DetailLine, type RowTone, type StyledSegment, type TranscriptTone,
} from './styling.ts'
import { displayWidth, sanitizeLine, sanitizeText, wrapWords } from './terminal-text.ts'

export type { DetailLine, RowTone, StyledSegment, TranscriptTone }
import { buildToolCard, type ToolCardLocation, type ToolCardOptions } from './tool-card.ts'


export interface TranscriptEntry {
  readonly id: string
  readonly nodeKind: 'text' | 'tool'
  readonly tone: TranscriptTone
  readonly depth: number
  readonly header: string
  /** Styled runs of the header row, when the entry carries inline markup. */
  readonly headerSegments?: readonly StyledSegment[]
  readonly badge?: string
  readonly detail: readonly DetailLine[]
  readonly foldable: boolean
  /** Fold policy before any user override. */
  readonly foldedByDefault: boolean
  readonly locations: readonly ToolCardLocation[]
  readonly status?: ToolNode['status']
  readonly diffStats?: { readonly added: number; readonly removed: number }
  /** Wall-clock start of a tool call, for the elapsed field on a running card. */
  readonly startedAtMs?: number
}

/** Reusable per-node entry cache so a live append does not rebuild every card. */
export type TranscriptEntryCache = Map<string, { signature: string; entry: TranscriptEntry }>

/**
 * Per-entry row cache. Wrapping is the expensive part of building a frame, so
 * rows are memoized against the entry identity, its fold state and the width;
 * a streamed delta then re-wraps only the entry it touched.
 */
export type TranscriptLineCache = Map<
  string,
  { key: string; entry: TranscriptEntry; lines: readonly TranscriptLine[] }
>

export interface TranscriptLine {
  readonly entryId: string
  readonly text: string
  readonly tone: RowTone
  readonly header: boolean
  /** Styled runs of this row; `text` stays the exact concatenation. */
  readonly segments?: readonly StyledSegment[]
  /**
   * Set on the header row of a call that is still running. `text` stays the
   * static form; the view swaps the status glyph for an animated frame and
   * appends the elapsed time, so nothing else has to know about the clock.
   */
  readonly running?: {
    /** Indent before the status glyph. */
    readonly indent: string
    /** Everything after the glyph and its trailing space. */
    readonly rest: string
    readonly startedAtMs?: number
  }
}

export interface TranscriptOptions extends ToolCardOptions {
  /** Successful tool cards longer than this fold by default. */
  readonly foldDetailAbove?: number
  /**
   * Wall-clock start of a call, by call id. Kept outside the projection so the
   * durable event fold stays replay-deterministic.
   */
  readonly startedAt?: (callId: string) => number | undefined
  /** Status and structure markers; ASCII stand-ins on a degraded terminal. */
  readonly glyphs?: GlyphSet
}

/**
 * Rows a card shows before folding, by card kind. A diff earns more than prose
 * because its rows are the answer, not a preview of it.
 */
const FOLD_ABOVE: Readonly<Record<string, number>> = { diff: 8, default: 3 }

/**
 * Folding one row away costs a row to say so, so it is never worth it. A card
 * only folds once it would hide at least two.
 */
const FOLD_MARGIN = 1

function statusGlyph(status: ToolNode['status'], glyphs: GlyphSet): string {
  switch (status) {
    case 'pending': return glyphs.pending
    case 'succeeded': return glyphs.succeeded
    case 'failed': return glyphs.failed
    case 'interrupted': return glyphs.interrupted
  }
}

function splitText(value: string): { header: string; detail: readonly DetailLine[] } {
  const lines = sanitizeText(value).split('\n')
  while (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return { header: lines[0] ?? '', detail: plainLines(lines.slice(1)) }
}

function textEntry(node: Exclude<TranscriptNode, ToolNode>, glyphs: GlyphSet): TranscriptEntry {
  const { header, detail } = splitText(node.text)
  switch (node.kind) {
    case 'user':
      return {
        id: node.id, nodeKind: 'text', tone: 'user', depth: 0,
        header: `${glyphs.user} ${header}`, detail, foldable: detail.length > 0,
        foldedByDefault: false, locations: [],
      }
    case 'reasoning':
      return {
        id: node.id, nodeKind: 'text', tone: 'reasoning', depth: 0,
        // The folded form names what is hidden and how to see it; the marker
        // differs from the assistant's so a fold reads as a fold.
        header: `${glyphs.thinking} Thinking`,
        detail: [{ text: header }, ...detail],
        foldable: true, foldedByDefault: true, locations: [],
      }
    case 'marker':
      return {
        id: node.id, nodeKind: 'text', tone: 'system', depth: 0,
        header: `${glyphs.marker} ${header}`, detail, foldable: detail.length > 0,
        foldedByDefault: false, locations: [],
      }
    case 'turn':
      return {
        id: node.id, nodeKind: 'text', tone: header.startsWith('error') ? 'error' : 'system', depth: 0,
        header: `${glyphs.rule} turn ${header}`, detail, foldable: detail.length > 0,
        foldedByDefault: false, locations: [],
      }
    default: {
      // Assistant prose is the only text that carries markup worth styling.
      const styled = renderMarkdown(sanitizeText(node.text))
      const rows = styled.slice(0, detail.length + 1)
      return {
        id: node.id, nodeKind: 'text', tone: 'assistant', depth: 0,
        header: `${glyphs.bullet} ${header}`,
        // The bullet is a plain run so the styled text still sums to the row.
        ...(rows[0] === undefined
          ? {}
          : { headerSegments: [{ text: `${glyphs.bullet} ` }, ...rows[0].segments] }),
        detail: detail.map((line, index) => {
          const segments = rows[index + 1]?.segments
          return segments === undefined ? line : { ...line, segments }
        }),
        foldable: detail.length > 0, foldedByDefault: false, locations: [],
      }
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
  const detail: readonly DetailLine[] = [
    ...(card.subtitle === undefined ? [] : [{ text: card.subtitle, tone: 'heading' as const }]),
    ...card.body,
    ...(card.dropped > 0
      ? [{
        text: `… ${String(card.dropped)} more line(s) not shown (output capped)`,
        tone: 'system' as const,
      }]
      : []),
  ]
  const foldAbove = options.foldDetailAbove
    ?? FOLD_ABOVE[card.card] ?? FOLD_ABOVE.default ?? 3
  const startedAtMs = node.status === 'pending' ? options.startedAt?.(node.callId) : undefined
  return {
    id: node.id,
    nodeKind: 'tool',
    tone: node.status === 'failed' ? 'error' : 'tool',
    depth,
    header: `${statusGlyph(node.status, options.glyphs ?? UNICODE_GLYPHS)} ${card.title}`,
    ...(card.badge === undefined ? {} : { badge: card.badge }),
    detail,
    foldable: detail.length > 0,
    foldedByDefault: node.status === 'succeeded' && detail.length > foldAbove + FOLD_MARGIN,
    locations: card.locations,
    status: node.status,
    ...(card.diffStats === undefined ? {} : { diffStats: card.diffStats }),
    ...(startedAtMs === undefined ? {} : { startedAtMs }),
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
      entry = textEntry(node, options.glyphs ?? UNICODE_GLYPHS)
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

/** Prepend the row indent as a plain run so segments still sum to the text. */
function indented(
  indent: string,
  segments: readonly StyledSegment[],
): readonly StyledSegment[] {
  return indent === '' ? segments : [{ text: indent }, ...segments]
}

/** Flatten entries into display rows, honouring indentation and fold state. */
export function transcriptLines(
  entries: readonly TranscriptEntry[],
  overrides: ReadonlySet<string> = new Set(),
  columns = 0,
  cache?: TranscriptLineCache,
  glyphs: GlyphSet = UNICODE_GLYPHS,
): readonly TranscriptLine[] {
  const all: TranscriptLine[] = []
  const live = new Set<string>()
  for (const entry of entries) {
    const folded = entryFolded(entry, overrides)
    const key = `${String(columns)}|${String(folded)}|${String(entry.startedAtMs ?? 0)}`
    live.add(entry.id)
    const cached = cache?.get(entry.id)
    // The entry object is replaced whenever its content changes, so identity
    // plus the width and fold state is a complete key.
    if (cached?.key === key && cached.entry === entry) {
      all.push(...cached.lines)
      continue
    }
    const lines = entryLines(entry, folded, columns, glyphs)
    cache?.set(entry.id, { key, entry, lines })
    all.push(...lines)
  }
  if (cache !== undefined) {
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id)
  }
  return all
}

function entryLines(
  entry: TranscriptEntry,
  folded: boolean,
  columns: number,
  glyphs: GlyphSet,
): readonly TranscriptLine[] {
  const lines: TranscriptLine[] = []
  /**
   * Emit one logical row as however many terminal rows it needs. `columns <= 0`
   * means "do not wrap", which is what the tests and the pre-resize first frame
   * use; continuation rows are indented under their own row's indent.
   */
  const emit = (
    row: Omit<TranscriptLine, 'text'> & { text: string; indent: string },
  ): void => {
    const { indent, ...line } = row
    if (columns <= 0 || displayWidth(line.text) <= columns) {
      lines.push(line)
      return
    }
    const wrapped = wrapWords(line.text, columns)
    const styled = line.segments === undefined
      ? undefined
      : wrapSegments(line.segments, wrapped)
    // Only the first row keeps the running-card parts: the glyph and the
    // elapsed field belong to the header line, not its continuations.
    const { running, segments, ...rest } = line
    wrapped.forEach((text, index) => {
      // A continuation keeps the row's indent so the block still reads as one.
      const body = index === 0 ? text : `${indent}${text.trimStart()}`
      const rowSegments = styled?.[index]
      lines.push({
        ...rest,
        text: body,
        ...(index === 0 && running !== undefined ? { running } : {}),
        ...(rowSegments === undefined
          ? {}
          : { segments: index === 0 ? rowSegments : [{ text: indent }, ...rowSegments] }),
      })
    })
  }
  {
    const indent = '  '.repeat(entry.depth)
    const text = sanitizeLine(
      `${indent}${entry.header}${entry.badge === undefined ? '' : `  [${entry.badge}]`}`,
    )
    emit({
      entryId: entry.id,
      indent,
      tone: entry.tone,
      header: true,
      text,
      // The indent is spaces and the glyph is one cell, so sanitizing cannot
      // have moved either: the rest starts right after `glyph + space`.
      ...(entry.status !== 'pending' ? {} : {
        running: {
          indent,
          rest: text.slice(indent.length + 2),
          ...(entry.startedAtMs === undefined ? {} : { startedAtMs: entry.startedAtMs }),
        },
      }),
      // A badge is appended after the styled runs, so the header only keeps its
      // segments when there is none to append.
      ...(entry.headerSegments === undefined || entry.badge !== undefined
        ? {}
        : { segments: indented(indent, entry.headerSegments) }),
    })
    if (folded) {
      if (entry.detail.length > 0) {
        emit({
          entryId: entry.id,
          indent: `${indent}  `,
          tone: 'system',
          header: false,
          text: `${indent}  ${glyphs.fold} +${String(entry.detail.length)} lines (ctrl+o to expand)`,
        })
      }
      return lines
    }
    entry.detail.forEach((line, index) => {
      // Tool bodies hang under a gutter so a card reads as one block; text
      // entries keep the plain indent.
      const lead = entry.nodeKind !== 'tool'
        ? '  '
        : index === 0 ? glyphs.gutterFirst : glyphs.gutterRest
      emit({
        entryId: entry.id,
        indent: `${indent}${' '.repeat(lead.length)}`,
        // A row that declared its own tone keeps it; a diff's added lines must
        // not inherit the card's colour.
        tone: line.tone ?? entry.tone,
        header: false,
        text: `${indent}${lead}${line.text}`,
        ...(line.segments === undefined
          ? {}
          : { segments: indented(`${indent}${lead}`, line.segments) }),
      })
    })
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
