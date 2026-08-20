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
  /** Present-tense tool-owned phrase for the working line. */
  readonly activity?: string
  readonly detail: readonly DetailLine[]
  readonly foldable: boolean
  /** Fold policy before any user override, judged on line count alone. */
  readonly foldedByDefault: boolean
  /**
   * Terminal rows this entry's body may occupy before it folds regardless of
   * how few logical lines it has. Only tool cards carry it: their body is
   * evidence, which a reader dips into, while prose is the answer and is never
   * folded for being long.
   */
  readonly foldAboveRows?: number
  readonly locations: readonly ToolCardLocation[]
  readonly status?: ToolNode['status']
  readonly diffStats?: { readonly added: number; readonly removed: number }
  /** Wall-clock start of a tool call, for the elapsed field on a running card. */
  readonly startedAtMs?: number
  /**
   * Tone of the status dot, when it differs from the entry's own. Only tool
   * cards set it, and only from the card kind the tool itself declared.
   */
  readonly statusTone?: RowTone
  /**
   * How many entries this one stands for, when it is a collapsed run.
   *
   * Absent on an ordinary entry. It is what lets the scrollback split tell a
   * group apart from a card without reading its id: a group can still change
   * after the entries before it have settled, and an entry that a later
   * settlement could rewrite must not be handed to the terminal.
   */
  readonly collapsedFrom?: number
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
 * Budget for a call that has not succeeded — still running, failed, or
 * interrupted. Each earns more rows than a success: for a failure the output is
 * the evidence for what went wrong, and for a running call it is the only sign
 * of progress. It is still a budget. A command that fails after printing a
 * thousand lines must not cost a thousand rows, which is exactly what an
 * unbounded failure did: one `node -e` writing a JSON response to stderr buried
 * every earlier turn on the screen.
 */
const UNSETTLED_FOLD_ABOVE = 8

/**
 * Folding one row away costs a row to say so, so it is never worth it. A card
 * only folds once it would hide at least two.
 */
const FOLD_MARGIN = 1

/**
 * Status-dot tone per card kind, so a glance down the transcript separates the
 * commands from the edits from the reading. Keyed by `string`, not by
 * `ToolCardKind`: the declared intent is untrusted input from the tool, so an
 * unknown kind must miss rather than fail to compile. `generic` is absent on
 * purpose too — a card the profile could not classify keeps the plain tool
 * colour rather than borrowing a meaning it has not earned.
 */
const CARD_TONE: Readonly<Record<string, RowTone | undefined>> = Object.freeze({
  terminal: 'tool-terminal',
  diff: 'tool-diff',
  search: 'tool-search',
  read: 'tool-read',
  web: 'tool-web',
})

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

function textEntry(
  node: Exclude<TranscriptNode, ToolNode>,
  glyphs: GlyphSet,
  preamble = false,
): TranscriptEntry {
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
      // Assistant prose is the only text that carries markup worth rendering.
      // The renderer emits one line per source line, so the header and the
      // detail rows still line up with the split above — but the text is the
      // rendered form now, markers consumed, tables laid out.
      const rows = renderMarkdown(sanitizeText(node.text), glyphs).slice(0, detail.length + 1)
      const first = rows[0]
      return {
        id: node.id, nodeKind: 'text', tone: 'assistant', depth: 0,
        header: `${glyphs.bullet} ${first?.text ?? header}`,
        // The bullet is a plain run so the styled text still sums to the row.
        ...(first === undefined
          ? {}
          : { headerSegments: [{ text: `${glyphs.bullet} ` }, ...first.segments] }),
        detail: detail.map((line, index) => {
          const row = rows[index + 1]
          return row === undefined ? line : { ...line, text: row.text, segments: row.segments }
        }),
        foldable: detail.length > 0,
        // A preamble is what the model said on its way to doing something, and
        // from the second turn on it is narration the reader has already read.
        // It folds only when folding actually buys a row: hiding a single line
        // costs that line back to say so.
        foldedByDefault: preamble && detail.length > FOLD_MARGIN,
        locations: [],
      }
    }
  }
}

/**
 * Which text blocks are preambles, by node index.
 *
 * A *preamble* is an assistant block with a tool call still to come in the same
 * turn — the model narrating its intent, as opposed to the answer it arrives at.
 * Both halves of that definition need the whole node list, which is why this is
 * a pass rather than a property of the node: whether a block is a preamble
 * depends on what comes after it, and which turn it is in depends on what came
 * before.
 *
 * The first turn is exempt. There the narration is orientation — it says what
 * the session is about to do, and often carries the caveat the answer rests on.
 */
function preambleFlags(nodes: readonly TranscriptNode[]): readonly boolean[] {
  const flags = new Array<boolean>(nodes.length).fill(false)
  // A user message starts a turn, matching how the store counts them.
  let turn = 0
  const turnOf = nodes.map((node) => {
    if (node.kind === 'user') turn++
    return turn
  })
  let toolAhead = false
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index]
    if (node === undefined) continue
    if (node.kind === 'user') {
      toolAhead = false
      continue
    }
    flags[index] = node.kind === 'assistant' && toolAhead && (turnOf[index] ?? 0) > 1
    if (node.kind === 'tool') toolAhead = true
  }
  return flags
}

function toolEntry(
  node: ToolNode,
  presentation: ToolPresentation,
  depth: number,
  options: TranscriptOptions,
): TranscriptEntry {
  const card = buildToolCard(node, presentation, options)
  const declaredTone = CARD_TONE[presentation.result?.card ?? presentation.call.card]
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
    ?? (node.status === 'succeeded'
      ? FOLD_ABOVE[card.card] ?? FOLD_ABOVE.default ?? 3
      : UNSETTLED_FOLD_ABOVE)
  const startedAtMs = node.status === 'pending' ? options.startedAt?.(node.callId) : undefined
  return {
    id: node.id,
    nodeKind: 'tool',
    tone: node.status === 'failed' ? 'error' : 'tool',
    depth,
    header: `${statusGlyph(node.status, options.glyphs ?? UNICODE_GLYPHS)} ${card.title}`,
    ...(card.activity === undefined ? {} : { activity: card.activity }),
    ...(card.badge === undefined ? {} : { badge: card.badge }),
    detail,
    foldable: detail.length > 0,
    // The line-count rule is the width-independent half of the policy; the row
    // budget below catches the case it cannot see, where a handful of lines are
    // each long enough to wrap across the whole screen.
    foldedByDefault: detail.length > foldAbove + FOLD_MARGIN,
    foldAboveRows: foldAbove,
    locations: card.locations,
    status: node.status,
    // The kind is read from the *declared* intent rather than from the built
    // card, which degrades to `generic` while a call has no result yet: the dot
    // must not change colour halfway through a call it already classified.
    // A failure outranks it — the dot's first job is to say what went wrong.
    ...(node.status === 'failed' || declaredTone === undefined ? {} : { statusTone: declaredTone }),
    ...(card.diffStats === undefined ? {} : { diffStats: card.diffStats }),
    ...(startedAtMs === undefined ? {} : { startedAtMs }),
  }
}

function signatureOf(node: TranscriptNode, depth: number, preamble: boolean): string {
  return node.kind === 'tool'
    ? `tool|${String(depth)}|${String(node.lastSeq)}|${node.status}|${node.name}|${String(node.input.length)}|${String(node.output.length)}`
    // Preamble-ness is not a property of the block's own text — it turns true
    // when a tool call arrives after it. Leaving it out of the signature is
    // what would keep a stale, unfolded entry alive for the rest of the session.
    : `${node.kind}|${String(node.lastSeq)}|${String(node.text.length)}|${preamble ? 'p' : '-'}`
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
  const preambles = preambleFlags(nodes)
  const entries = nodes.map((node, index) => {
    const depth = node.kind === 'tool' && node.parentCallId !== undefined && callIds.has(node.parentCallId)
      ? 1
      : 0
    const preamble = preambles[index] === true
    const signature = signatureOf(node, depth, preamble)
    live.add(node.id)
    const cached = cache?.get(node.id)
    if (cached?.signature === signature) return cached.entry
    let entry: TranscriptEntry
    if (node.kind !== 'tool') {
      entry = textEntry(node, options.glyphs ?? UNICODE_GLYPHS, preamble)
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

/**
 * Whether an entry's body would occupy more than `budget` terminal rows at this
 * width, stopping as soon as the answer is known so a thousand-line body costs
 * a handful of comparisons rather than a thousand.
 *
 * The per-line cost is the plain ceiling of the row's width, which is a *lower*
 * bound on what wrapping actually produces: `wrapWords` breaks at word
 * boundaries and the gutter narrows the continuations, so both push the real
 * count up, never down. Under-counting is the safe direction — it folds only
 * what is certainly too tall.
 */
function exceedsRows(entry: TranscriptEntry, columns: number, budget: number): boolean {
  if (columns <= 0) return entry.detail.length > budget
  let rows = 0
  for (const line of entry.detail) {
    rows += Math.max(1, Math.ceil(displayWidth(line.text) / columns))
    if (rows > budget) return true
  }
  return false
}

/**
 * The fold policy for an entry at a given width, before any user override.
 *
 * Counting logical lines is not enough on its own: one line of a 2,000-character
 * JSON response is a single line by that measure and nineteen rows on screen, so
 * a card that never reached the line threshold could still bury the rest of the
 * conversation. The row budget is what the reader actually experiences.
 *
 * It applies to tool cards only. An assistant's long answer is the thing the
 * user asked for; folding it for being long would hide the reply behind a
 * keystroke.
 */
export function foldedByDefaultAt(entry: TranscriptEntry, columns: number): boolean {
  if (!entry.foldable) return false
  if (entry.foldedByDefault) return true
  if (entry.nodeKind !== 'tool' || entry.foldAboveRows === undefined) return false
  return exceedsRows(entry, columns, entry.foldAboveRows + FOLD_MARGIN)
}

/**
 * True when an entry renders collapsed given the user's fold overrides.
 * @param columns - render width; `0` means "unknown", which falls back to the
 * width-independent line count.
 */
export function entryFolded(
  entry: TranscriptEntry,
  overrides: ReadonlySet<string>,
  columns = 0,
): boolean {
  if (!entry.foldable) return false
  // The override flips whatever the default is *at this width*, so ctrl+o on a
  // card folded by the row budget opens it rather than folding it again.
  const byDefault = foldedByDefaultAt(entry, columns)
  return overrides.has(entry.id) ? !byDefault : byDefault
}

/** Prepend the row indent as a plain run so segments still sum to the text. */
function indented(
  indent: string,
  segments: readonly StyledSegment[],
): readonly StyledSegment[] {
  return indent === '' ? segments : [{ text: indent }, ...segments]
}

/**
 * Whether a blank row should introduce this entry.
 *
 * A short answer pressed straight against a tall tool card reads as part of it.
 * One blank row is enough to separate the two, and it is added only for that
 * one transition: a card followed by another card is a list and should stay
 * tight, and a block followed by the tool it triggered is one thought and must
 * not be cut in half.
 */
function needsMargin(
  previous: TranscriptEntry | undefined,
  entry: TranscriptEntry,
): boolean {
  return previous?.nodeKind === 'tool'
    && entry.nodeKind === 'text'
    && entry.tone === 'assistant'
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
  for (const [index, entry] of entries.entries()) {
    const folded = entryFolded(entry, overrides, columns)
    // The margin depends on the entry *before* this one, which is not part of
    // this entry's identity — folding the card above changes nothing about the
    // answer itself, but it can change whether the answer is still preceded by
    // a card. Without it in the key the cache keeps a stale spacer.
    const margin = needsMargin(entries[index - 1], entry)
    const key = `${String(columns)}|${String(folded)}|${String(entry.startedAtMs ?? 0)}`
      + `|${String(margin)}`
    live.add(entry.id)
    const cached = cache?.get(entry.id)
    // The entry object is replaced whenever its content changes, so identity
    // plus the width, fold state and margin is a complete key.
    if (cached?.key === key && cached.entry === entry) {
      all.push(...cached.lines)
      continue
    }
    const lines = entryLines(entry, folded, columns, glyphs, margin)
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
  margin = false,
): readonly TranscriptLine[] {
  const lines: TranscriptLine[] = []
  // The spacer belongs to the block it introduces, never to the card above it:
  // rows leave for the terminal's scrollback an entry at a time, and a spacer
  // that left with the card would strand the answer against the previous row.
  if (margin) lines.push({ entryId: entry.id, text: '', tone: entry.tone, header: false })
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
    const firstPass = wrapWords(line.text, columns)
    // A hanging indent consumes room on continuation rows. Re-wrap those rows
    // to the smaller budget before adding it, otherwise a full-width CJK row
    // followed by two spaces would exceed the terminal by two cells.
    const hanging = displayWidth(indent) < columns ? indent : ''
    const continuationColumns = columns - displayWidth(hanging)
    const wrapped = firstPass.flatMap((text, index) => index === 0
      ? [text]
      : wrapWords(text.trimStart(), continuationColumns))
    const styled = line.segments === undefined
      ? undefined
      : wrapSegments(line.segments, wrapped)
    // Only the first row keeps the running-card parts: the glyph and the
    // elapsed field belong to the header line, not its continuations.
    const { running, segments, ...rest } = line
    wrapped.forEach((text, index) => {
      // A continuation keeps the row's indent so the block still reads as one.
      const body = index === 0 ? text : `${hanging}${text}`
      const rowSegments = styled?.[index]
      lines.push({
        ...rest,
        text: body,
        ...(index === 0 && running !== undefined ? { running } : {}),
        ...(rowSegments === undefined
          ? {}
          : { segments: index === 0 ? rowSegments : [{ text: hanging }, ...rowSegments] }),
      })
    })
  }
  {
    const indent = '  '.repeat(entry.depth)
    const text = sanitizeLine(
      `${indent}${entry.header}${entry.badge === undefined ? '' : `  [${entry.badge}]`}`,
    )
    // Text headers start with a semantic marker and a space (`> `, `● `,
    // `∴ `). Their continuations hang under the content after that marker.
    // Tool cards retain their structural depth indent: their body gutter already
    // provides the visual hierarchy this rule adds to prose.
    const markerEnd = entry.nodeKind === 'text' ? entry.header.indexOf(' ') + 1 : 0
    const headerIndent = markerEnd <= 0
      ? indent
      : `${indent}${' '.repeat(displayWidth(entry.header.slice(0, markerEnd)))}`
    emit({
      entryId: entry.id,
      indent: headerIndent,
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
      // The status dot is one cell wide and sits right after the indent, so it
      // splits off as its own run without measuring anything. The rest of the
      // header — title and badge alike — stays a single plain run in the
      // entry's own tone.
      ...(entry.statusTone === undefined ? {} : {
        segments: [
          { text: text.slice(0, indent.length + 1), tone: entry.statusTone },
          { text: text.slice(indent.length + 1) },
        ],
      }),
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
