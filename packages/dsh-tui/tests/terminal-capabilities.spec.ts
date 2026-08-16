import { describe, expect, it } from 'vitest'
import { detectTerminal } from '../src/terminal-capabilities.ts'

const tty = { isTTY: true, columns: 120, rows: 40 }
const pipe = { isTTY: false }

describe('terminal capability detection', () => {
  it('reports a modern truecolor terminal without degradation notes', () => {
    const capabilities = detectTerminal(
      { TERM: 'xterm-256color', COLORTERM: 'truecolor' }, tty, tty, 'linux',
    )
    expect(capabilities).toMatchObject({
      interactive: true, colorLevel: 'truecolor', alternateScreen: true,
      hyperlinks: true, remote: false, notes: [],
    })
    expect(capabilities.multiplexer).toBeUndefined()
  })

  it('falls back to 256 colors and basic colors from TERM alone', () => {
    expect(detectTerminal({ TERM: 'xterm-256color' }, tty, tty, 'linux').colorLevel).toBe('ansi256')
    expect(detectTerminal({ TERM: 'xterm' }, tty, tty, 'linux').colorLevel).toBe('basic')
  })

  it('disables color for NO_COLOR, FORCE_COLOR=0, dumb terminals, and pipes', () => {
    expect(detectTerminal({ TERM: 'xterm', NO_COLOR: '1' }, tty, tty, 'linux').colorLevel).toBe('none')
    expect(detectTerminal({ TERM: 'xterm', FORCE_COLOR: '0' }, tty, tty, 'linux').colorLevel).toBe('none')
    expect(detectTerminal({ TERM: 'dumb' }, tty, tty, 'linux')).toMatchObject({
      colorLevel: 'none', alternateScreen: false,
    })
    expect(detectTerminal({ TERM: 'xterm' }, pipe, pipe, 'linux')).toMatchObject({
      interactive: false, colorLevel: 'none',
    })
  })

  it('records multiplexer and remote degradation instead of assuming support', () => {
    const tmux = detectTerminal({ TERM: 'tmux-256color', TMUX: '/tmp/tmux-1000/default,1,0' }, tty, tty, 'linux')
    expect(tmux.multiplexer).toBe('tmux')
    expect(tmux.hyperlinks).toBe(false)
    expect(tmux.notes.join(' ')).toContain('tmux')

    const screen = detectTerminal({ TERM: 'screen.xterm-256color' }, tty, tty, 'linux')
    expect(screen.multiplexer).toBe('screen')

    const ssh = detectTerminal({ TERM: 'xterm-256color', SSH_CONNECTION: '10.0.0.1 22' }, tty, tty, 'linux')
    expect(ssh.remote).toBe(true)
    expect(ssh.hyperlinks).toBe(false)
    expect(ssh.notes.join(' ')).toContain('SSH')
  })

  it('notes tiny terminals and legacy Windows consoles', () => {
    const tiny = detectTerminal({ TERM: 'xterm' }, tty, { isTTY: true, columns: 10, rows: 3 }, 'linux')
    expect(tiny.notes.join(' ')).toContain('10x3')

    const legacy = detectTerminal({ TERM: 'xterm' }, tty, tty, 'win32')
    expect(legacy.notes.join(' ')).toContain('ConPTY')
    expect(detectTerminal({ TERM: 'xterm', WT_SESSION: 'abc' }, tty, tty, 'win32').notes).toEqual([])
  })
})
