/**
 * Draft history persistence.
 *
 * The format is JSONL so a partially written tail — a kill during a flush —
 * costs one entry rather than the whole file. Parsing is total: an unreadable
 * line is skipped, never fatal, because losing history must not stop a session
 * from starting.
 */

export const HISTORY_LIMIT = 200

/** Parse a history file, oldest first, bounded to the most recent `limit`. */
export function parseHistory(contents: string, limit = HISTORY_LIMIT): readonly string[] {
  const entries: string[] = []
  for (const line of contents.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const draft = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).draft
      : undefined
    if (typeof draft !== 'string' || draft === '') continue
    // A repeat of the previous entry is noise in an up-arrow walk.
    if (entries.at(-1) === draft) continue
    entries.push(draft)
  }
  return entries.slice(-limit)
}

/** One appendable line for a submitted draft. */
export function historyLine(draft: string): string {
  return `${JSON.stringify({ draft })}\n`
}

/** Rewrite the file body once it has grown past the limit. */
export function serializeHistory(entries: readonly string[], limit = HISTORY_LIMIT): string {
  return entries.slice(-limit).map(entry => historyLine(entry)).join('')
}
