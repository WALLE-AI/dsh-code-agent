/**
 * Terminal capability detection. Every reduced capability is reported as an
 * explicit note so the release matrix records degradation instead of guessing.
 */

export type ColorLevel = 'none' | 'basic' | 'ansi256' | 'truecolor'

export interface TerminalCapabilities {
  readonly interactive: boolean
  readonly columns: number
  readonly rows: number
  readonly colorLevel: ColorLevel
  readonly alternateScreen: boolean
  readonly hyperlinks: boolean
  readonly multiplexer?: 'tmux' | 'screen'
  readonly remote: boolean
  readonly notes: readonly string[]
}

export interface TerminalProbe {
  readonly isTTY?: boolean
  readonly columns?: number | undefined
  readonly rows?: number | undefined
}

const MINIMUM_COLUMNS = 20
const MINIMUM_ROWS = 4

function truthy(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0'
}

function colorOf(env: NodeJS.ProcessEnv, term: string, interactive: boolean): ColorLevel {
  if (env.FORCE_COLOR === '0' || truthy(env.NO_COLOR) || term === 'dumb') return 'none'
  if (!interactive && !truthy(env.FORCE_COLOR)) return 'none'
  const colorTerm = (env.COLORTERM ?? '').toLowerCase()
  if (colorTerm === 'truecolor' || colorTerm === '24bit') return 'truecolor'
  if (truthy(env.WT_SESSION) || term.includes('kitty') || term.includes('direct')) return 'truecolor'
  if (term.includes('256')) return 'ansi256'
  return 'basic'
}

/** Derive the usable terminal feature set from the environment and streams. */
export function detectTerminal(
  env: NodeJS.ProcessEnv,
  stdin: TerminalProbe,
  stdout: TerminalProbe,
  platform: NodeJS.Platform = process.platform,
): TerminalCapabilities {
  const notes: string[] = []
  const term = (env.TERM ?? '').toLowerCase()
  const interactive = stdin.isTTY === true && stdout.isTTY === true
  if (!interactive) notes.push('stdin or stdout is not a TTY; interactive rendering is unavailable')

  const columns = stdout.columns ?? 80
  const rows = stdout.rows ?? 24
  if (interactive && (columns < MINIMUM_COLUMNS || rows < MINIMUM_ROWS)) {
    notes.push(`terminal reports ${columns}x${rows}; layout falls back to the minimum single-row budget`)
  }

  const colorLevel = colorOf(env, term, interactive)
  if (colorLevel === 'none' && interactive) notes.push('color output is disabled for this terminal')

  const multiplexer = truthy(env.TMUX) || term.startsWith('tmux')
    ? 'tmux' as const
    : term.startsWith('screen') ? 'screen' as const : undefined
  if (multiplexer !== undefined) {
    notes.push(`${multiplexer} detected; OSC hyperlinks and clipboard passthrough are disabled`)
  }

  const remote = truthy(env.SSH_CONNECTION) || truthy(env.SSH_TTY) || truthy(env.SSH_CLIENT)
  if (remote) notes.push('remote SSH session detected; editor launch uses the remote host environment')

  const alternateScreen = interactive && term !== 'dumb' && term !== ''
  if (interactive && !alternateScreen) {
    notes.push('TERM is unset or dumb; the alternate screen buffer is disabled')
  }

  if (platform === 'win32' && !truthy(env.WT_SESSION)) {
    notes.push('legacy Windows console detected; ConPTY resize and Unicode support may be limited')
  }

  return Object.freeze({
    interactive,
    columns,
    rows,
    colorLevel,
    alternateScreen,
    hyperlinks: colorLevel !== 'none' && multiplexer === undefined && !remote,
    ...(multiplexer === undefined ? {} : { multiplexer }),
    remote,
    notes: Object.freeze(notes),
  })
}
