/**
 * The painter is what stands between stock Ink and a full-screen erase on every
 * spinner tick, so these tests are written against the exact byte shapes Ink
 * emits (`ink/build/log-update.js` and `ansi-escapes`).
 */

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { paintInPlace, repaintFrame } from '../src/frame-writer.ts'

const ESC = String.fromCharCode(0x1b)

/** `ansiEscapes.eraseLines(count)`, byte for byte. */
function eraseLines(count: number): string {
  let out = ''
  for (let index = 0; index < count; index++) {
    out += `${ESC}[2K${index < count - 1 ? `${ESC}[1A` : ''}`
  }
  return count > 0 ? `${out}${ESC}[G` : ''
}

/** One Ink write: erase the previous frame, then the new one plus a newline. */
function inkWrite(previousRows: number, frame: readonly string[]): string {
  return eraseLines(previousRows === 0 ? 0 : previousRows + 1) + frame.join('\n') + '\n'
}

describe('repaintFrame', () => {
  it('rewrites only the rows that changed', () => {
    const first = ['one', 'two', 'three']
    const paint = repaintFrame(inkWrite(3, ['one', 'TWO', 'three']), first)
    // Up to the frame's first row, then one newline per row and the new text
    // exactly once. Nothing is erased ahead of the text.
    expect(paint.output).toBe(`${ESC}[3A${ESC}[G\nTWO${ESC}[0m${ESC}[K\n\n`)
    expect(paint.output).not.toContain(`${ESC}[2K`)
    expect(paint.rows).toEqual(['one', 'TWO', 'three'])
  })

  it('clears to the end of a row it rewrites, so a shorter row leaves no tail', () => {
    const paint = repaintFrame(inkWrite(2, ['a', 'b']), ['a', 'bbbbbbbb'])
    expect(paint.output).toContain(`b${ESC}[0m${ESC}[K`)
  })

  it('writes nothing at all when the frame is identical', () => {
    const rows = ['one', 'two']
    expect(repaintFrame(inkWrite(2, rows), rows).output).toBe('')
  })

  it('hands a frame of a different height back to Ink untouched', () => {
    // Row N of the new frame is not row N of the old one, so there is nothing
    // to diff against; Ink's own erase is the correct painter for that case.
    const chunk = inkWrite(2, ['one', 'two', 'three'])
    const paint = repaintFrame(chunk, ['one', 'two'])
    expect(paint.output).toBe(chunk)
    expect(paint.rows).toEqual(['one', 'two', 'three'])
  })

  it('passes through anything that is not a frame, and forgets the screen', () => {
    for (const chunk of [`${ESC}[?25l`, 'plain text', `${ESC}[2J${ESC}[3J${ESC}[H`]) {
      const paint = repaintFrame(chunk, ['one'])
      expect(paint.output).toBe(chunk)
      // Where that write left the cursor is not knowable from the bytes, so the
      // next full frame re-establishes the screen rather than diffing against a
      // guess.
      expect(paint.rows).toEqual([])
    }
    // A bare erase is `logUpdate.clear()`: the frame really is being taken down.
    const cleared = repaintFrame(eraseLines(3), ['one', 'two'])
    expect(cleared.output).toBe(eraseLines(3))
    expect(cleared.rows).toEqual([])
  })

  it('stops erasing the screen once it knows what is on it', () => {
    let rows: readonly string[] = []
    const erases: number[] = []
    for (let tick = 0; tick < 50; tick++) {
      const frame = ['header', `working ${String(tick)}s`, 'status']
      const paint = repaintFrame(inkWrite(tick === 0 ? 0 : 3, frame), rows)
      rows = paint.rows
      erases.push(paint.output.split(`${ESC}[2K`).length - 1)
    }
    // The opening frame carries no prologue and the one after it re-establishes
    // the screen; from there on the spinner costs no erase at all.
    expect(erases.slice(0, 2)).toEqual([0, 4])
    expect(erases.slice(2).every(count => count === 0)).toBe(true)
  })
})

describe('paintInPlace', () => {
  it('paints through to the stream and leaves the rest of it alone', () => {
    const stream = new EventEmitter() as unknown as NodeJS.WriteStream & { written: string[] }
    stream.written = []
    stream.columns = 80
    stream.rows = 24
    stream.write = ((chunk: string) => { stream.written.push(String(chunk)); return true }) as never
    const painted = paintInPlace(stream)

    expect(painted.columns).toBe(80)
    expect(painted.rows).toBe(24)
    painted.write(inkWrite(0, ['one', 'two']))
    painted.write(inkWrite(2, ['one', 'two']))
    painted.write(inkWrite(2, ['one', 'TWO']))
    expect(stream.written[2]).toBe(`${ESC}[2A${ESC}[G\nTWO${ESC}[0m${ESC}[K\n`)

    // A listener registered through the wrapper has to reach the real stream:
    // Ink's resize handling is one of them.
    let resized = 0
    painted.on('resize', () => { resized++ })
    stream.emit('resize')
    expect(resized).toBe(1)
  })

  it('leaves a non-string write to the stream', () => {
    const stream = new EventEmitter() as unknown as NodeJS.WriteStream & { written: unknown[] }
    stream.written = []
    stream.write = ((chunk: unknown) => { stream.written.push(chunk); return true }) as never
    const buffer = Buffer.from('raw')
    paintInPlace(stream).write(buffer)
    expect(stream.written).toEqual([buffer])
  })
})
