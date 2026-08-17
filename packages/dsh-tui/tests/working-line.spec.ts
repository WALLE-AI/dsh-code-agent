import { describe, expect, it } from 'vitest'
import { displayWidth } from '../src/terminal-text.ts'
import {
  buildWorkingLine, TOKENS_AFTER_MS, workingVerb, type WorkingLineInput,
} from '../src/working-line.ts'

const BASE: WorkingLineInput = {
  frame: '⠋', turn: 0, elapsedMs: 4_000, separator: '·',
}

describe('working verb', () => {
  it('is stable for a turn and varies across turns', () => {
    expect(workingVerb(3)).toBe(workingVerb(3))
    const seen = new Set(Array.from({ length: 10 }, (_, index) => workingVerb(index)))
    expect(seen.size).toBeGreaterThan(1)
  })

  it('wraps rather than running off the end of the list', () => {
    expect(workingVerb(1_000)).toBe(workingVerb(1_000 % 10))
    expect(workingVerb(-3)).toBe(workingVerb(3))
  })
})

describe('working line', () => {
  it('shows the frame, the verb and how long it has been going', () => {
    expect(buildWorkingLine(BASE, 80)).toBe('⠋ Working… · 4s')
  })

  it('holds the token count back until the wait is long enough to want it', () => {
    expect(buildWorkingLine({ ...BASE, tokens: 1_234 }, 80)).toBe('⠋ Working… · 4s')
    expect(buildWorkingLine({ ...BASE, tokens: 1_234, elapsedMs: TOKENS_AFTER_MS }, 80))
      .toBe('⠋ Working… · 30s · 1.2k tokens')
  })

  it('omits tokens the projection never reported', () => {
    expect(buildWorkingLine({ ...BASE, elapsedMs: 60_000 }, 80)).toBe('⠋ Working… · 1m00s')
  })

  it('uses the separator it was given, so ASCII terminals stay ASCII', () => {
    expect(buildWorkingLine({ ...BASE, frame: '|', separator: '-' }, 80))
      .toBe('| Working… - 4s')
  })

  it('stays inside the terminal width at every size', () => {
    for (let columns = 0; columns <= 60; columns++) {
      const line = buildWorkingLine({ ...BASE, tokens: 90_000, elapsedMs: 90_000 }, columns)
      expect(displayWidth(line)).toBeLessThanOrEqual(columns)
    }
  })
})
