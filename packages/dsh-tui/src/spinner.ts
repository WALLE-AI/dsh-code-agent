/**
 * Frame selection and duration formatting for running work.
 *
 * Both are pure functions of elapsed time, so a frame is reproducible from a
 * timestamp and the view needs no animation state of its own — the clock only
 * has to make the component re-render.
 */

/** Frame period. Slow enough to stay cheap, fast enough to read as motion. */
export const SPINNER_INTERVAL_MS = 80

const UNICODE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
// A terminal without box-drawing support still gets a turning bar.
const ASCII_FRAMES = ['|', '/', '-', '\\'] as const

/** The frame showing at `elapsedMs` into a run. */
export function spinnerFrame(elapsedMs: number, unicode = true): string {
  const frames = unicode ? UNICODE_FRAMES : ASCII_FRAMES
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0
  const index = Math.floor(elapsed / SPINNER_INTERVAL_MS) % frames.length
  return frames[index] ?? frames[0]
}

/**
 * A compact duration: `4s`, `1m12s`, `2h05m`. Seconds are dropped past an hour
 * because at that scale they are noise, and the field must not grow.
 */
export function formatElapsed(elapsedMs: number): string {
  const total = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0
  if (total < 60) return `${String(total)}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${String(minutes)}m${String(total % 60).padStart(2, '0')}s`
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60).padStart(2, '0')}m`
}
