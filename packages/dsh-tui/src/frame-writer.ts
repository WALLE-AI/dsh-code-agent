/**
 * Differential frame painting on top of stock Ink.
 *
 * Ink's `log-update` (`ink/build/log-update.js`) repaints by erasing every row
 * of the previous frame and writing the new one:
 *
 *     eraseLines(previousLineCount) + output
 *
 * with `eraseLines` emitting one `ESC[2K` per row. A frame that fills the
 * terminal therefore blanks the whole screen on *every* render, and the
 * terminal paints part of that blank before the rewrite lands. While a spinner
 * runs, that is ten whole-screen erases a second — the flicker reported against
 * a pending approval, where the transcript, the working line and the panel
 * together reach the terminal height.
 *
 * The frame itself is not the problem: between two spinner ticks perhaps three
 * of its forty rows differ. So this module intercepts Ink's write, keeps the
 * rows it last painted, and rewrites only the ones that actually changed —
 * unchanged rows are skipped with a bare newline, which costs the terminal
 * nothing and paints nothing. No row is ever erased before being overwritten,
 * so there is no blank state for the terminal to show.
 *
 * This is a transformation of Ink's own output, not a replacement for its
 * renderer: anything that does not match the shape above is passed through
 * untouched, and so is a frame whose height changed (the row-to-row alignment
 * the diff depends on no longer holds).
 */

const ESC = String.fromCharCode(0x1b)
const ERASE_LINE = `${ESC}[2K`
const CURSOR_UP_ONE = `${ESC}[1A`
const CURSOR_LEFT = `${ESC}[G`
/**
 * Close any style the row opened before erasing to its end: `ESC[K` fills with
 * the *current* background, so erasing under an unclosed background colour
 * would smear it across the rest of the row.
 */
const CLEAR_TO_END = `${ESC}[0m${ESC}[K`

export interface FramePaint {
  /** What to write in place of the original chunk. */
  readonly output: string
  /** The rows now on screen, to diff the next frame against. */
  readonly rows: readonly string[]
}

interface InkFrame {
  /** Rows Ink asked to erase: the frame's rows plus the one the cursor sits on. */
  readonly erased: number
  readonly body: string
}

/** Recognise `eraseLines(n) + output`; anything else is not ours to rewrite. */
function splitInkWrite(chunk: string): InkFrame | undefined {
  if (!chunk.startsWith(ERASE_LINE)) return undefined
  let at = 0
  let erased = 0
  for (;;) {
    if (!chunk.startsWith(ERASE_LINE, at)) return undefined
    erased++
    at += ERASE_LINE.length
    if (!chunk.startsWith(CURSOR_UP_ONE, at)) break
    at += CURSOR_UP_ONE.length
  }
  if (!chunk.startsWith(CURSOR_LEFT, at)) return undefined
  return { erased, body: chunk.slice(at + CURSOR_LEFT.length) }
}

/**
 * Rewrite one Ink write against the rows currently on screen.
 *
 * The cursor starts on the blank row below the frame — that is where Ink left
 * it — so reaching the frame's first row is one move up per row.
 */
export function repaintFrame(chunk: string, rows: readonly string[]): FramePaint {
  const frame = splitInkWrite(chunk)
  // Without the prologue there is nothing to say which rows this write lands
  // on — Ink's own first frame, a cursor sequence, a static flush. It goes out
  // as it is, and the screen counts as unknown until the next full frame
  // re-establishes it. That costs one erase at startup and none after.
  if (frame === undefined) return { output: chunk, rows: [] }
  if (frame.body === '') return { output: chunk, rows: [] }
  const next = frame.body.endsWith('\n') ? frame.body.slice(0, -1).split('\n') : frame.body.split('\n')
  // A frame of a different height cannot be diffed row against row, and one
  // that does not account for every erased row is not the shape assumed here.
  if (frame.erased !== next.length + 1 || rows.length !== next.length) {
    return { output: chunk, rows: next }
  }
  if (next.every((row, index) => row === rows[index])) return { output: '', rows }
  const parts: string[] = []
  // The cursor sits on the blank row *below* the frame, so the first row is a
  // full frame height above it — the same distance Ink's own prologue walks.
  parts.push(`${ESC}[${String(next.length)}A`, CURSOR_LEFT)
  for (const [index, row] of next.entries()) {
    // An unchanged row is left exactly as it is; the newline steps over it.
    if (row !== rows[index]) parts.push(row, CLEAR_TO_END)
    parts.push('\n')
  }
  return { output: parts.join(''), rows: next }
}

/**
 * Wrap a terminal stream so Ink's frames are painted differentially. Every
 * other member — `columns`, `rows`, `on('resize')`, the rest of the stream
 * contract — resolves against the real stream, so callers cannot tell the
 * difference except by watching the bytes.
 */
export function paintInPlace<T extends NodeJS.WriteStream>(stream: T): T {
  let rows: readonly string[] = []
  const write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk !== 'string') return (stream.write as (...args: unknown[]) => boolean)(chunk, ...rest)
    const paint = repaintFrame(chunk, rows)
    rows = paint.rows
    if (paint.output === '') return true
    return (stream.write as (...args: unknown[]) => boolean)(paint.output, ...rest)
  }) as T['write']
  return new Proxy(stream, {
    get(target, property): unknown {
      if (property === 'write') return write
      // Resolved against the stream itself, not the proxy: a getter must not be
      // re-entered through this trap.
      const value = Reflect.get(target, property) as unknown
      // Bound, so a method called on the proxy still mutates the real stream:
      // an Ink `resize` listener has to reach the terminal's own emitter.
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}
