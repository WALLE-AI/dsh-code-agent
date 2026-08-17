import { describe, expect, it } from 'vitest'
import { historyLine, parseHistory, serializeHistory } from '../src/history-store.ts'

describe('draft history', () => {
  it('round-trips through the line format', () => {
    const entries = ['fix the flush race', '第一行\nsecond line', '/permission read-only']
    expect(parseHistory(serializeHistory(entries))).toEqual(entries)
  })

  it('skips a truncated or malformed tail instead of failing', () => {
    const contents = `${historyLine('kept')}{"draft": "half`
    expect(parseHistory(contents)).toEqual(['kept'])
  })

  it('ignores lines that carry no usable draft', () => {
    const contents = [
      historyLine('kept'),
      '{"draft": 42}\n',
      '{"draft": ""}\n',
      '["not an object"]\n',
      '\n',
    ].join('')
    expect(parseHistory(contents)).toEqual(['kept'])
  })

  it('collapses a repeat of the previous entry', () => {
    expect(parseHistory(`${historyLine('same')}${historyLine('same')}${historyLine('next')}`))
      .toEqual(['same', 'next'])
  })

  it('keeps the newest entries when the file exceeds the limit', () => {
    const entries = Array.from({ length: 30 }, (_, index) => `draft-${String(index)}`)
    const parsed = parseHistory(serializeHistory(entries, 10), 10)
    expect(parsed).toHaveLength(10)
    expect(parsed.at(-1)).toBe('draft-29')
    expect(parsed[0]).toBe('draft-20')
  })

  it('reads an absent or empty file as no history', () => {
    expect(parseHistory('')).toEqual([])
  })
})
