import { describe, expect, it } from 'vitest'
import {
  displayWidth, sanitizeLine, sanitizeText, truncateToWidth, wrapToWidth,
} from '../src/terminal-text.ts'

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)

function fromCodes(...codes: readonly number[]): string {
  return codes.map(code => String.fromCodePoint(code)).join('')
}

describe('terminal text safety', () => {
  it('removes window title, hyperlink, and styling sequences', () => {
    const hostile = [
      `${ESC}]0;pwned${BEL}`,
      `${ESC}]8;;https://evil.example${BEL}click${ESC}]8;;${BEL}`,
      `${ESC}[31mred${ESC}[0m`,
      `${ESC}]52;c;cGF5bG9hZA==${ESC}\\`,
    ].join('')
    expect(sanitizeText(hostile)).toBe('clickred')
  })

  it('drops unterminated string sequences instead of leaking them', () => {
    expect(sanitizeText(`safe${ESC}]0;never terminated`)).toBe('safe')
    expect(sanitizeText(`safe${ESC}[38;2;1;2`)).toBe('safe')
    expect(sanitizeText(`safe${ESC}`)).toBe('safe')
  })

  it('removes C0, C1, DEL, and invisible reordering marks', () => {
    const hostile = fromCodes(
      0x61, 0x00, 0x08, 0x62, 0x9b, 0x63, 0x7f, 0x64,
      0x200b, 0x65, 0x202e, 0x66, 0xfeff, 0x67,
    )
    expect(sanitizeText(hostile)).toBe('abcdefg')
  })

  it('keeps newlines, expands tabs, and normalizes carriage returns', () => {
    expect(sanitizeText('a\tb')).toBe('a    b')
    expect(sanitizeText('a\r\nb\rc')).toBe('a\nb\nc')
    expect(sanitizeLine('a\nb')).toBe('a b')
  })

  it('preserves combining marks, emoji, and CJK content', () => {
    const combining = fromCodes(0x65, 0x0301)
    expect(sanitizeText(`${combining} 修复 🚀`)).toBe(`${combining} 修复 🚀`)
  })
})

describe('terminal width', () => {
  it('counts wide, narrow, and zero-width cells', () => {
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('修复')).toBe(4)
    expect(displayWidth(fromCodes(0x65, 0x0301))).toBe(1)
    expect(displayWidth('🚀')).toBe(2)
    expect(displayWidth('ｆｕｌｌ')).toBe(8)
  })

  it('truncates without splitting a wide cell', () => {
    expect(truncateToWidth('abcdef', 10)).toBe('abcdef')
    expect(truncateToWidth('abcdef', 4)).toBe('abc…')
    // Three wide cells cannot fit in five columns once the ellipsis is reserved.
    expect(truncateToWidth('修复问题', 5)).toBe('修复…')
    expect(displayWidth(truncateToWidth('修复问题', 5))).toBeLessThanOrEqual(5)
    expect(truncateToWidth('修复', 1)).toBe('')
    expect(truncateToWidth('abc', 0)).toBe('')
  })

  it('stands in for a cell wider than the row instead of overflowing', () => {
    // A single-column terminal cannot show a wide glyph at all.
    expect(wrapToWidth('𠀀', 1)).toEqual(['…'])
    expect(wrapToWidth('a𠀀b', 1)).toEqual(['a', '…', 'b'])
    for (const row of wrapToWidth('修复𠀀', 1)) expect(displayWidth(row)).toBeLessThanOrEqual(1)
  })

  it('wraps rows to the column budget', () => {
    expect(wrapToWidth('abcdef', 3)).toEqual(['abc', 'def'])
    expect(wrapToWidth('修复问题', 3)).toEqual(['修', '复', '问', '题'])
    expect(wrapToWidth('a\nb', 5)).toEqual(['a', 'b'])
    for (const row of wrapToWidth('修复问题abc', 5)) {
      expect(displayWidth(row)).toBeLessThanOrEqual(5)
    }
  })
})
