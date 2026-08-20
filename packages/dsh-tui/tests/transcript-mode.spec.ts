import { describe, expect, it } from 'vitest'
import {
  commitTranscriptSearch, copyTranscriptText, jumpTranscriptMatch, moveTranscriptCursor,
  openTranscriptMode, transcriptMatches, visibleTranscriptLines,
} from '../src/transcript-mode.ts'
import type { TranscriptLine } from '../src/transcript-view.ts'

const lines: readonly TranscriptLine[] = [
  { entryId: 'a', text: 'first alpha', tone: 'user', header: true },
  { entryId: 'a', text: 'alpha detail', tone: 'user', header: false },
  { entryId: 'b', text: 'middle', tone: 'assistant', header: true },
  { entryId: 'c', text: 'last alpha', tone: 'tool', header: true },
]

describe('transcript mode', () => {
  it('opens at the tail and keeps cursor movement visible', () => {
    const opened = openTranscriptMode(lines.length, 2)
    expect(opened).toMatchObject({ cursor: 3, top: 2 })
    const moved = moveTranscriptCursor(opened, -2, lines.length, 2)
    expect(moved).toMatchObject({ cursor: 1, top: 1 })
    expect(visibleTranscriptLines(moved, lines, 2).map(line => line.text))
      .toEqual(['alpha detail', 'middle'])
  })

  it('searches case-insensitively and wraps n/N navigation', () => {
    expect(transcriptMatches(lines, 'ALPHA')).toEqual([0, 1, 3])
    const searched = commitTranscriptSearch(
      { ...openTranscriptMode(lines.length, 2), searchDraft: 'alpha' }, lines, 2,
    )
    expect(searched.cursor).toBe(3)
    expect(jumpTranscriptMatch(searched, lines, 1, 2).cursor).toBe(0)
    expect(jumpTranscriptMatch(searched, lines, -1, 2).cursor).toBe(1)
  })

  it('copies either the selected row or its whole entry', () => {
    const state = { ...openTranscriptMode(lines.length, 2), cursor: 1 }
    expect(copyTranscriptText(state, lines, false)).toBe('alpha detail')
    expect(copyTranscriptText(state, lines, true)).toBe('first alpha\nalpha detail')
  })
})
