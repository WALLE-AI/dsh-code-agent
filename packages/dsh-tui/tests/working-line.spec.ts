import { describe, expect, it } from 'vitest'
import { displayWidth } from '../src/terminal-text.ts'
import {
  buildWorkingLine, nextDisplayedTokenCount, STALL_AFTER_MS, TOKENS_AFTER_MS, workingVerb,
  type WorkingLineInput,
} from '../src/working-line.ts'

/** The rendered row; the stall flag is asserted on its own where it matters. */
const line = (input: WorkingLineInput, columns: number): string =>
  buildWorkingLine(input, columns).text

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
    expect(line(BASE, 80)).toBe('⠋ Working… · 4s')
  })

  it('holds the token count back until the wait is long enough to want it', () => {
    expect(line({ ...BASE, tokens: 1_234 }, 80)).toBe('⠋ Working… · 4s')
    expect(line({ ...BASE, tokens: 1_234, elapsedMs: TOKENS_AFTER_MS }, 80))
      .toBe('⠋ Working… · 30s · 1.2k tokens')
  })

  it('omits tokens the projection never reported', () => {
    expect(line({ ...BASE, elapsedMs: 60_000 }, 80)).toBe('⠋ Working… · 1m00s')
  })

  it('uses the separator it was given, so ASCII terminals stay ASCII', () => {
    expect(line({ ...BASE, frame: '|', separator: '-' }, 80)).toBe('| Working… - 4s')
  })

  it('stays inside the terminal width at every size', () => {
    for (let columns = 0; columns <= 60; columns++) {
      const row = line({ ...BASE, tokens: 90_000, elapsedMs: 90_000, silentMs: 60_000 }, columns)
      expect(displayWidth(row)).toBeLessThanOrEqual(columns)
    }
  })

  it('eases token counts monotonically without overshooting either direction', () => {
    expect(nextDisplayedTokenCount(0, 1_000, 100)).toBe(200)
    expect(nextDisplayedTokenCount(900, 1_000, 1_000)).toBe(1_000)
    expect(nextDisplayedTokenCount(1_000, 0, 100)).toBe(800)
    expect(nextDisplayedTokenCount(10, 10, 100)).toBe(10)
  })

  it('adds a width-bounded child-agent tree row', () => {
    const built = buildWorkingLine({
      ...BASE, subagent: 'researching a very long dependency graph', treePrefix: '\\-',
    }, 20)
    expect(built.subagentText).toContain('researching')
    expect(displayWidth(built.subagentText ?? '')).toBeLessThanOrEqual(20)
  })
})

describe('what the run is actually doing', () => {
  it('names the running call rather than inventing a verb', () => {
    expect(line({ ...BASE, activity: 'Read src/app.tsx', toolRunning: true }, 80))
      .toBe('⠋ Read src/app.tsx · 4s')
  })

  it('falls back to the verb when nothing has declared itself', () => {
    expect(line(BASE, 80)).toContain('Working…')
  })
})

describe('a run that has gone quiet', () => {
  it('says so once the silence is long enough to worry about', () => {
    const quiet = { ...BASE, elapsedMs: 60_000, silentMs: STALL_AFTER_MS }
    const built = buildWorkingLine(quiet, 80)
    expect(built.stalled).toBe(true)
    expect(built.text).toBe('⠋ Working… · no output for 10s · 1m00s')
  })

  it('is not stalled while a tool is in flight, however quiet it is', () => {
    // The tool is the work, and its own card is already saying so. Calling that
    // a stall would paint a warning over every long command.
    const built = buildWorkingLine(
      { ...BASE, silentMs: 10 * STALL_AFTER_MS, toolRunning: true },
      80,
    )
    expect(built.stalled).toBe(false)
    expect(built.text).not.toContain('no output')
  })

  it('is not stalled before the threshold', () => {
    expect(buildWorkingLine({ ...BASE, silentMs: STALL_AFTER_MS - 1 }, 80).stalled).toBe(false)
  })

  it('keeps the stall when the terminal is too narrow for anything else', () => {
    // Fields are dropped from the end, and the stall is the one field that
    // changes what the reader should do about the wait.
    const built = buildWorkingLine(
      { ...BASE, elapsedMs: 90_000, tokens: 90_000, silentMs: 30_000 },
      34,
    )
    expect(built.text).toContain('no output for 30s')
    expect(built.text).not.toContain('tokens')
  })
})
