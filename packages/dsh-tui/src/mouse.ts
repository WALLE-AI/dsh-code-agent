/**
 * Mouse wheel reports.
 *
 * The frame is repainted in place, so the terminal's own scrollback never
 * receives a single row of it: rolling the wheel scrolled past the banner into
 * whatever the shell had printed before launch. With wheel reporting on, those
 * notches arrive as input instead, and the transcript viewport — which does hold
 * the whole history, banner included — scrolls under them.
 *
 * Only the SGR encoding (`CSI < button ; column ; row M|m`, mode `?1006`) is
 * read. It is the one encoding that stays unambiguous past column 223, and the
 * only one this profile turns on. Ink strips the leading `ESC` of a chunk before
 * `useInput` sees it, and a fast wheel delivers several reports in one chunk, so
 * the parser accepts a leading escape or none and scans to the end.
 *
 * Every report is consumed, not just the wheel: a click or a drag must never
 * reach the composer as text.
 */

const ESC = String.fromCharCode(0x1b)

/** `CSI <` with the escape optional, as Ink hands it over. */
const REPORT = new RegExp(`^${ESC}?\\[<(\\d+);(\\d+);(\\d+)[Mm]`)

/** Wheel bit in the SGR button field; the low two bits then give the axis. */
const WHEEL = 0b100_0000

export interface WheelNotch {
  /** -1 rolls towards older rows, 1 towards newer — the sign `scrollViewport` takes. */
  readonly direction: -1 | 1
}

export interface MouseInput {
  /** Whether the input was mouse reports and nothing else. */
  readonly consumed: boolean
  /** Vertical notches, in the order they arrived. */
  readonly notches: readonly WheelNotch[]
}

const NOTHING: MouseInput = Object.freeze({ consumed: false, notches: Object.freeze([]) })

/**
 * Read mouse reports out of one chunk of terminal input.
 *
 * @returns `consumed: false` for input that is not a mouse report at all, so the
 *   caller can go on treating it as a keypress.
 */
export function readMouse(input: string): MouseInput {
  if (!input.startsWith('[<') && !input.startsWith(`${ESC}[<`)) return NOTHING
  const notches: WheelNotch[] = []
  let rest = input
  while (rest !== '') {
    const report = REPORT.exec(rest)
    // A chunk that starts as a report but does not end as one is not ours to
    // interpret: handing back the whole chunk is safer than eating half of it.
    if (report === null) return NOTHING
    const button = Number(report[1])
    // Horizontal notches (buttons 66 and 67) are dropped: the transcript wraps
    // rather than scrolling sideways, so there is nothing for them to move.
    if ((button & WHEEL) !== 0 && (button & 0b11) < 2) {
      notches.push({ direction: (button & 0b1) === 0 ? -1 : 1 })
    }
    rest = rest.slice(report[0].length)
  }
  return { consumed: true, notches }
}

/** Rows one notch moves. Three is the common terminal default for a wheel step. */
export const WHEEL_ROWS = 3

/** Turn wheel reporting on (`?1000` button events, `?1006` SGR encoding). */
export const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`

/**
 * Turn it back off. Sent in the reverse order and on every exit path: a terminal
 * left in reporting mode prints the raw sequences into the user's shell.
 */
export const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1000l`
