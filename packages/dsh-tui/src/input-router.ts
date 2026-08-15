import type { InputSubmission, TuiCommandExecution } from './contracts.ts'

export interface InputRouterPort {
  followup(text: string): void
  executeCommand(line: string, signal: AbortSignal): Promise<TuiCommandExecution | undefined>
}

/** Keep slash-command admission separate from model messages. */
export class AgentInputRouter {
  constructor(private readonly port: InputRouterPort) {}

  async submit(text: string, signal = new AbortController().signal): Promise<InputSubmission> {
    const line = text.trim()
    if (line === '') throw new Error('input must not be empty')
    if (!line.startsWith('/')) {
      this.port.followup(text)
      return { kind: 'message' }
    }
    const execution = await this.port.executeCommand(line, signal)
    return execution === undefined
      ? { kind: 'unknown-command', text: `unknown or malformed command: ${line}` }
      : { kind: 'command', execution }
  }
}
