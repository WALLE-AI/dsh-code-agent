/**
 * Collapsing runs of entries into one.
 *
 * A turn that greps once and then reads eight files spends nine cards and forty
 * rows saying so, and pushes the answer it was working towards off the screen.
 * None of those cards is wrong; there are just too many of them for what they
 * are worth, which is "it looked at these files".
 *
 * So a run of them becomes one entry whose body lists what was touched. The
 * result is an ordinary foldable card — `ctrl+o` opens it like any other — which
 * is why this file adds no fold machinery of its own.
 *
 * Three rules keep it honest, and they are the whole design:
 *
 * - **Only settled, only successful.** A call that is still running has a moving
 *   status glyph, and a call that failed is the one thing on screen worth
 *   reading. Neither is ever hidden.
 * - **Only kinds whose body is not the point.** A read and a search are
 *   collapsible because *which* files matters more than their contents; a
 *   command's output, a diff and a fetched page are not. The kind comes from the
 *   card the tool declared, never from its name.
 * - **Only a real run.** Below {@link MIN_RUN} a group saves nothing and costs a
 *   click, so a lone read is left exactly as it was.
 *
 * A group's id is derived from its first member, never from its position: the
 * transcript is re-projected on every append, and an index-derived id would
 * change identity under the row cache and the scrollback split every time
 * anything before it moved.
 */

import { UNICODE_GLYPHS, type GlyphSet } from './glyphs.ts'
import type { RowTone } from './styling.ts'
import type { TranscriptEntry } from './transcript-view.ts'
import type { ToolCardLocation } from './tool-card.ts'

/** Fewer than this many in a row is not a run, and is left alone. */
export const MIN_RUN = 3

/**
 * The card kinds whose run may be folded, and what to call them.
 *
 * Read from `statusTone`, which `transcript-view` sets from the card the tool
 * declared. A tool this profile has never heard of renders a `generic` card,
 * carries no tone, and is therefore never collapsed — which is the safe default.
 */
const COLLAPSIBLE: Readonly<Partial<Record<RowTone, { one: string; many: string }>>> =
  Object.freeze({
    'tool-read': { one: 'read', many: 'reads' },
    'tool-search': { one: 'search', many: 'searches' },
  })

export interface CollapseRule {
  readonly id: string
  /**
   * How many consecutive entries starting at `index` this rule claims. Zero
   * means it does not apply, and the entry is emitted unchanged.
   */
  match(entries: readonly TranscriptEntry[], index: number): number
  fold(group: readonly TranscriptEntry[], glyphs: GlyphSet): TranscriptEntry
}

/** True when this entry may join a run at all. */
function collapsible(entry: TranscriptEntry | undefined): boolean {
  return entry !== undefined
    && entry.nodeKind === 'tool'
    // A nested call belongs under its parent; folding it would break the tree.
    && entry.depth === 0
    && entry.status === 'succeeded'
    && entry.statusTone !== undefined
    && COLLAPSIBLE[entry.statusTone] !== undefined
}

/** `8 reads · 2 searches`, in the order the kinds first appeared. */
function summarize(group: readonly TranscriptEntry[]): string {
  const counts = new Map<RowTone, number>()
  for (const entry of group) {
    if (entry.statusTone === undefined) continue
    counts.set(entry.statusTone, (counts.get(entry.statusTone) ?? 0) + 1)
  }
  return [...counts].map(([tone, count]) => {
    const label = COLLAPSIBLE[tone]
    if (label === undefined) return String(count)
    return `${String(count)} ${count === 1 ? label.one : label.many}`
  }).join(' · ')
}

/**
 * The member's title without its own status glyph. Every member succeeded — the
 * group header says so once, and eight ticks under it are noise.
 */
function memberLabel(entry: TranscriptEntry, glyphs: GlyphSet): string {
  const prefix = `${glyphs.succeeded} `
  const title = entry.header.startsWith(prefix)
    ? entry.header.slice(prefix.length)
    : entry.header
  return entry.badge === undefined ? title : `${title}  [${entry.badge}]`
}

function dedupedLocations(group: readonly TranscriptEntry[]): readonly ToolCardLocation[] {
  const seen = new Set<string>()
  const out: ToolCardLocation[] = []
  for (const entry of group) {
    for (const location of entry.locations) {
      if (seen.has(location.path)) continue
      seen.add(location.path)
      out.push(location)
    }
  }
  return out
}

/** Fold a run of successful read and search cards into one foldable entry. */
export const READ_SEARCH_RUN: CollapseRule = {
  id: 'read-search-run',
  match(entries, index) {
    if (!collapsible(entries[index])) return 0
    let length = 1
    while (collapsible(entries[index + length])) length++
    return length < MIN_RUN ? 0 : length
  },
  fold(group, glyphs) {
    const first = group[0]
    const tones = new Set(group.map(entry => entry.statusTone))
    return {
      // Derived from the first member, so the group keeps its identity across
      // re-projections however much moved above it.
      id: `group:read-search:${first?.id ?? ''}`,
      nodeKind: 'tool',
      tone: 'tool',
      depth: 0,
      header: `${glyphs.succeeded} ${summarize(group)}`,
      detail: group.map(entry => ({ text: memberLabel(entry, glyphs) })),
      foldable: true,
      // Always folded to begin with: a group that opened by default would cost
      // the rows it exists to save.
      foldedByDefault: true,
      locations: dedupedLocations(group),
      status: 'succeeded',
      collapsedFrom: group.length,
      // A mixed run has no one kind to colour the dot with, so it takes none.
      ...(tones.size === 1 && first?.statusTone !== undefined
        ? { statusTone: first.statusTone }
        : {}),
    }
  },
}

export const DEFAULT_COLLAPSE_RULES: readonly CollapseRule[] = Object.freeze([READ_SEARCH_RUN])

/**
 * Apply the rules left to right, longest claim first at each position.
 *
 * The walk never revisits what a rule has claimed, so rules cannot nest and the
 * output length is bounded by the input length — a pass is O(n) in the number of
 * entries, which matters because it runs on every append.
 */
export function collapseEntries(
  entries: readonly TranscriptEntry[],
  rules: readonly CollapseRule[] = DEFAULT_COLLAPSE_RULES,
  glyphs: GlyphSet = UNICODE_GLYPHS,
): readonly TranscriptEntry[] {
  if (rules.length === 0) return entries
  const out: TranscriptEntry[] = []
  let index = 0
  let collapsed = false
  while (index < entries.length) {
    let claimed = 0
    let winner: CollapseRule | undefined
    for (const rule of rules) {
      const length = rule.match(entries, index)
      if (length > claimed) {
        claimed = length
        winner = rule
      }
    }
    if (winner === undefined || claimed < 2) {
      const entry = entries[index]
      if (entry !== undefined) out.push(entry)
      index++
      continue
    }
    out.push(winner.fold(entries.slice(index, index + claimed), glyphs))
    collapsed = true
    index += claimed
  }
  // Nothing matched: hand back the original array so the caller's caches and
  // reference-equality checks are untouched on the common path.
  return collapsed ? out : entries
}
