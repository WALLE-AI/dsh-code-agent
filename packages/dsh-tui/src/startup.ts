import { Command } from 'commander'
import type { HarnessContext } from './harness-adapter.ts'

export const name = 'tui-startup'
export const inject = ['cmdlineArgs']

export interface TuiModelSelection {
  provider?: string
  model?: string
  reasoningEffort?: string
}

export interface TuiStartupValues {
  task: string
  resume?: string
  permission?: string
  model?: TuiModelSelection
  diagnosticLog?: string
  alternateScreen: boolean
  interactive: boolean
  color: boolean
}

/** Permission presets this profile configures; also drives shell completion. */
export const TUI_PRESETS = ['read-only', 'workspace-write', 'danger-full-access'] as const

/** Every TUI flag, in the order `--help` prints them; drives shell completion. */
export const TUI_OPTIONS = [
  '--alternate-screen', '--interactive', '--no-color',
  '--resume', '--permission', '--model', '--diagnostic-log', '--help',
] as const

const PRESETS: readonly string[] = TUI_PRESETS

/**
 * Parse `--model provider/model[:effort]`, `model[:effort]`, or `provider/model`.
 * @throws when the value is empty or carries an empty component.
 */
export function parseModelSelection(value: string): TuiModelSelection {
  const trimmed = value.trim()
  if (trimmed === '') throw new Error('model must not be empty')
  const [route, effort, ...rest] = trimmed.split(':')
  if (rest.length > 0) throw new Error(`model ${value} has more than one reasoning-effort suffix`)
  if (effort !== undefined && effort.trim() === '') throw new Error(`model ${value} has an empty reasoning effort`)
  const parts = (route ?? '').split('/')
  if (parts.length > 2) throw new Error(`model ${value} has more than one provider separator`)
  const [first, second] = parts
  if (parts.some(part => part.trim() === '')) throw new Error(`model ${value} has an empty component`)
  return {
    ...(second === undefined ? {} : { provider: first as string }),
    model: (second ?? first) as string,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  }
}

/**
 * Validate a permission preset name before the terminal enters raw mode.
 * @throws when the preset is not one of the presets this profile configures.
 */
export function parsePermissionPreset(value: string): string {
  const preset = value.trim()
  if (!PRESETS.includes(preset)) {
    throw new Error(`unknown permission preset ${value}; expected one of ${PRESETS.join(', ')}`)
  }
  return preset
}

interface RawOptions {
  alternateScreen: boolean
  interactive: boolean
  color: boolean
  /** Commander reports a valueless `--resume` as `true`, which means "latest". */
  resume?: string | boolean
  permission?: string
  model?: string
  diagnosticLog?: string
}

/**
 * Fold parsed argv into the immutable startup contract.
 * @throws when a value is invalid; startup fails before any terminal mutation.
 */
export function startupValues(parts: readonly string[], options: RawOptions): TuiStartupValues {
  const task = parts.join(' ')
  if (task.trim() === '' && options.resume === undefined) {
    throw new Error('a task is required unless --resume selects an existing session')
  }
  const resume = options.resume === undefined
    ? undefined
    : options.resume === true || String(options.resume).trim() === ''
      ? 'latest'
      : String(options.resume).trim()
  return {
    task,
    ...(resume === undefined ? {} : { resume }),
    ...(options.permission === undefined
      ? {}
      : { permission: parsePermissionPreset(options.permission) }),
    ...(options.model === undefined ? {} : { model: parseModelSelection(options.model) }),
    ...(options.diagnosticLog === undefined ? {} : { diagnosticLog: options.diagnosticLog }),
    alternateScreen: options.alternateScreen,
    interactive: options.interactive,
    color: options.color,
  }
}

export function apply(ctx: HarnessContext): void {
  const command = new Command()
    .name('dsh --profile tui')
    .description('Run coding tasks in the lightweight terminal UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--alternate-screen', 'use the alternate screen buffer', false)
    .option('--interactive', 'keep the session open for follow-up input', false)
    .option('--no-color', 'disable semantic terminal colors')
    .option('--resume [session]', 'resume a session by id, id prefix, or "latest"')
    .option('--permission <preset>', `session permission preset (${PRESETS.join(' | ')})`)
    .option('--model <route>', 'model override as provider/model[:reasoning-effort]')
    .option('--diagnostic-log <path>', 'write a redacted diagnostic log to this file')
    .argument('[task...]', 'task text')
  command.action((parts: string[], options: RawOptions) => {
    try {
      ctx.provide('tuiStartup', startupValues(parts, options) satisfies TuiStartupValues)
    } catch (error) {
      command.error(`error: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  const args = ctx.get('cmdlineArgs') as { get(): readonly string[] } | undefined
  const exit = ctx.get('appExit') as ((code: number) => void) | undefined
  if (args === undefined || exit === undefined) throw new Error('tui-startup requires launcher cmdlineArgs and appExit services')
  command.exitOverride()
  try {
    command.parse([...args.get()], { from: 'user' })
  } catch (error) {
    if (error instanceof Error && error.name === 'CommanderError') return exit((error as Error & { exitCode: number }).exitCode)
    throw error
  }
}
