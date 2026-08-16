import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TUI_OPTIONS, TUI_PRESETS } from '../src/startup.ts'

const completions = join(import.meta.dirname, '../completions')
const shells = ['dsh-tui.bash', 'dsh-tui.zsh', 'dsh-tui.fish'] as const

function read(name: string): string {
  return readFileSync(join(completions, name), 'utf8')
}

describe('shell completions', () => {
  it.each(shells)('%s offers every startup option and preset', (name) => {
    const script = read(name)
    for (const option of TUI_OPTIONS) {
      // fish declares flags without the leading dashes.
      const needle = name.endsWith('.fish') ? `-l ${option.replace(/^--/, '')}` : option
      expect(script, `${name} is missing ${option}`).toContain(needle)
    }
    for (const preset of TUI_PRESETS) expect(script, `${name} is missing ${preset}`).toContain(preset)
  })

  it('parses as valid bash', () => {
    expect(() => execFileSync('bash', ['-n', join(completions, 'dsh-tui.bash')])).not.toThrow()
  })

  it('completes flags and presets through a real bash session', () => {
    const script = join(completions, 'dsh-tui.bash').replace(/\\/g, '/')
    const probe = [
      `source '${script}'`,
      'COMP_WORDS=(dsh --permission "")',
      'COMP_CWORD=2',
      '_dsh_tui_complete',
      'printf "%s " "${COMPREPLY[@]}"',
      'echo',
      'COMP_WORDS=(dsh --int)',
      'COMP_CWORD=1',
      '_dsh_tui_complete',
      'printf "%s " "${COMPREPLY[@]}"',
    ].join('\n')
    const output = execFileSync('bash', ['-c', probe], { encoding: 'utf8' })
    const [presets, flags] = output.split('\n')
    for (const preset of TUI_PRESETS) expect(presets).toContain(preset)
    expect(flags).toContain('--interactive')
  })
})
