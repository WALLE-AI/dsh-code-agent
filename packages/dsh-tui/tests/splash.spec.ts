import { describe, expect, it } from 'vitest'
import { ASCII_GLYPHS, UNICODE_GLYPHS } from '../src/glyphs.ts'
import { buildSplash, type SplashFacts } from '../src/splash.ts'
import { displayWidth } from '../src/terminal-text.ts'

const FACTS: SplashFacts = {
  title: 'DeepSeek Harness TUI',
  model: 'deepseek-chat · max effort',
  directory: 'dsh-code-agent',
  branch: 'main',
  tips: ['/help for commands', 'Tab completes', '? for shortcuts'],
}

function texts(...args: Parameters<typeof buildSplash>): readonly string[] {
  return buildSplash(...args).map(row => row.text)
}

describe('splash', () => {
  it('frames the title and states what the session knows', () => {
    const rows = texts(FACTS, 80, UNICODE_GLYPHS)
    expect(rows[0]?.startsWith('╭')).toBe(true)
    expect(rows[1]).toContain('DeepSeek Harness TUI')
    expect(rows[2]?.startsWith('╰')).toBe(true)
    expect(rows).toContain('deepseek-chat · max effort')
    expect(rows.some(row => row.includes('dsh-code-agent') && row.includes('main'))).toBe(true)
    expect(rows.some(row => row.startsWith('Tip:'))).toBe(true)
  })

  it('omits a model line the run was never given', () => {
    const { model: _model, ...withoutModel } = FACTS
    const rows = texts(withoutModel, 80, UNICODE_GLYPHS)
    expect(rows.some(row => row.includes('deepseek'))).toBe(false)
    // No placeholder stands in for it.
    expect(rows.some(row => row.includes('unknown') || row.includes('—'))).toBe(false)
  })

  it('drops the frame and the tips on a narrow terminal', () => {
    const rows = texts(FACTS, 30, UNICODE_GLYPHS)
    expect(rows[0]).toBe('DeepSeek Harness TUI')
    expect(rows.some(row => row.startsWith('Tip:'))).toBe(false)
  })

  it('draws the frame in ASCII when wide glyphs are unavailable', () => {
    const rows = texts(FACTS, 80, ASCII_GLYPHS)
    expect(rows[0]?.startsWith('+')).toBe(true)
    expect(rows[0]).not.toContain('╭')
  })

  it('stays inside the terminal width at every size', () => {
    for (let columns = 1; columns <= 100; columns++) {
      for (const row of buildSplash(FACTS, columns, UNICODE_GLYPHS)) {
        expect(displayWidth(row.text)).toBeLessThanOrEqual(columns)
      }
    }
  })

  it('renders nothing at all when there is no room', () => {
    expect(buildSplash(FACTS, 0, UNICODE_GLYPHS)).toEqual([])
  })
})
