import { describe, expect, it } from 'vitest'
import { MOUSE_OFF, MOUSE_ON, readMouse, WHEEL_ROWS } from '../src/mouse.ts'

const ESC = String.fromCharCode(0x1b)

describe('readMouse', () => {
  it('reads a wheel-up notch as a step towards older rows', () => {
    // Ink strips the leading escape before `useInput` sees the chunk.
    expect(readMouse('[<64;10;5M')).toEqual({ consumed: true, notches: [{ direction: -1 }] })
    expect(readMouse(`${ESC}[<64;10;5M`)).toEqual({ consumed: true, notches: [{ direction: -1 }] })
  })

  it('reads a wheel-down notch as a step towards newer rows', () => {
    expect(readMouse('[<65;10;5M')).toEqual({ consumed: true, notches: [{ direction: 1 }] })
  })

  it('reads every notch of a fast roll, which arrives as one chunk', () => {
    const chunk = '[<64;10;5M[<64;10;5M[<64;10;5M'
    expect(readMouse(chunk).notches).toEqual([
      { direction: -1 }, { direction: -1 }, { direction: -1 },
    ])
  })

  it('keeps modified notches scrolling', () => {
    // Shift adds 4, meta 8, ctrl 16; none of them change the axis.
    for (const button of [68, 72, 80]) {
      expect(readMouse(`[<${String(button)};1;1M`).notches).toEqual([{ direction: -1 }])
    }
  })

  it('swallows clicks and drags without scrolling', () => {
    // A click must never reach the composer as text, but there is nothing for
    // it to move either.
    for (const report of ['[<0;10;5M', '[<0;10;5m', '[<32;11;6M']) {
      expect(readMouse(report)).toEqual({ consumed: true, notches: [] })
    }
  })

  it('drops horizontal notches, which the transcript cannot follow', () => {
    // The transcript wraps rather than scrolling sideways.
    expect(readMouse('[<66;10;5M')).toEqual({ consumed: true, notches: [] })
    expect(readMouse('[<67;10;5M')).toEqual({ consumed: true, notches: [] })
  })

  it('leaves ordinary typing alone', () => {
    for (const input of ['a', '[<', '', `${ESC}[A`, '[A', '/mouse']) {
      expect(readMouse(input).consumed, input).toBe(false)
    }
  })

  it('refuses a chunk that starts as a report but does not end as one', () => {
    // Handing back half a chunk would type the rest into the draft; a whole
    // unread chunk is the safer failure.
    expect(readMouse('[<64;10;5M[<64;10').consumed).toBe(false)
    expect(readMouse('[<64;10;5M hello').consumed).toBe(false)
  })

  it('turns reporting off in the reverse order it turned it on', () => {
    expect(MOUSE_ON).toBe(`${ESC}[?1000h${ESC}[?1006h`)
    expect(MOUSE_OFF).toBe(`${ESC}[?1006l${ESC}[?1000l`)
    expect(WHEEL_ROWS).toBeGreaterThan(0)
  })
})
