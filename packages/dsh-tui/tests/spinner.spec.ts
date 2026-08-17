import { describe, expect, it } from 'vitest'
import { formatElapsed, spinnerFrame, SPINNER_INTERVAL_MS } from '../src/spinner.ts'

describe('spinner frames', () => {
  it('advances one frame per interval and wraps', () => {
    const first = spinnerFrame(0)
    expect(spinnerFrame(SPINNER_INTERVAL_MS)).not.toBe(first)
    expect(spinnerFrame(SPINNER_INTERVAL_MS * 10)).toBe(first)
    // Within one interval the frame is stable, so a re-render cannot flicker.
    expect(spinnerFrame(SPINNER_INTERVAL_MS - 1)).toBe(first)
  })

  it('falls back to ASCII when the terminal has no box drawing', () => {
    expect(spinnerFrame(0, false)).toBe('|')
    expect(spinnerFrame(SPINNER_INTERVAL_MS, false)).toBe('/')
  })

  it('is one cell wide in both sets', () => {
    for (let step = 0; step < 12; step++) {
      expect(Array.from(spinnerFrame(step * SPINNER_INTERVAL_MS))).toHaveLength(1)
      expect(Array.from(spinnerFrame(step * SPINNER_INTERVAL_MS, false))).toHaveLength(1)
    }
  })

  it('never throws on a nonsense elapsed time', () => {
    expect(spinnerFrame(-1)).toBe(spinnerFrame(0))
    expect(spinnerFrame(Number.NaN)).toBe(spinnerFrame(0))
  })
})

describe('elapsed formatting', () => {
  it('grows one unit at a time and stays narrow', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(4_600)).toBe('4s')
    expect(formatElapsed(59_999)).toBe('59s')
    expect(formatElapsed(60_000)).toBe('1m00s')
    expect(formatElapsed(72_000)).toBe('1m12s')
    expect(formatElapsed(3_599_000)).toBe('59m59s')
    expect(formatElapsed(3_600_000)).toBe('1h00m')
    expect(formatElapsed(7_500_000)).toBe('2h05m')
  })

  it('never exceeds six columns, so the status field cannot grow', () => {
    for (const ms of [0, 1_000, 59_000, 61_000, 3_600_000, 86_400_000]) {
      expect(formatElapsed(ms).length).toBeLessThanOrEqual(6)
    }
  })

  it('reads a negative or non-finite duration as zero', () => {
    expect(formatElapsed(-5_000)).toBe('0s')
    expect(formatElapsed(Number.NaN)).toBe('0s')
  })
})
