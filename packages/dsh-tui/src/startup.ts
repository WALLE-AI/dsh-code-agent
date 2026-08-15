import { Command } from 'commander'
import type { HarnessContext } from './harness-adapter.ts'

export const name = 'tui-startup'
export const inject = ['cmdlineArgs']

export interface TuiStartupValues {
  task: string
  alternateScreen: boolean
  interactive: boolean
  color: boolean
}

export function apply(ctx: HarnessContext): void {
  const command = new Command()
    .name('dsh --profile tui')
    .description('Run one coding task in the lightweight terminal UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--alternate-screen', 'use the alternate screen buffer', false)
    .option('--interactive', 'keep the session open for follow-up input', false)
    .option('--no-color', 'disable semantic terminal colors')
    .argument('[task...]', 'task text')
  command.action((parts: string[], options: { alternateScreen: boolean; interactive: boolean; color: boolean }) => {
    const task = parts.join(' ')
    if (task.trim() === '') command.error('error: a task is required')
    ctx.provide('tuiStartup', {
      task, alternateScreen: options.alternateScreen, interactive: options.interactive, color: options.color,
    } satisfies TuiStartupValues)
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
