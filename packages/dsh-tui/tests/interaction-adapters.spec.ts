import { describe, expect, it, vi } from 'vitest'
import { AgentInputRouter, routeUserInput } from '../src/input-router.ts'
import { presentTool } from '../src/tool-presentation.ts'
import type { ToolNode } from '../src/contracts.ts'

const completedTool: ToolNode = {
  id: 'tool:1', kind: 'tool', callId: '1', name: 'bash',
  input: '{"command":"pwd"}', output: 'D:/repo', status: 'succeeded',
  firstSeq: 1, lastSeq: 2,
}

describe('input routing', () => {
  it('sends ordinary text to the model and slash commands only to commands.execute', async () => {
    const followup = vi.fn()
    const executeCommand = vi.fn(async () => ({
      commandId: 'cmd-1', result: { kind: 'success' as const },
    }))
    const router = new AgentInputRouter({ followup, executeCommand })

    await expect(router.submit('explain this')).resolves.toEqual({ kind: 'message' })
    await expect(router.submit('  /compact  ')).resolves.toMatchObject({ kind: 'command' })
    expect(followup).toHaveBeenCalledExactlyOnceWith('explain this')
    expect(executeCommand).toHaveBeenCalledWith('/compact', expect.any(AbortSignal))
  })

  it('steers a running Agent and follows up an idle one', () => {
    expect(routeUserInput('running', 'also check the logs')).toBe('steer')
    expect(routeUserInput('idle', 'also check the logs')).toBe('followup')
    expect(routeUserInput('starting', 'also check the logs')).toBe('followup')
    expect(routeUserInput(undefined, 'also check the logs')).toBe('followup')
    // A slash command always reaches the command service, even mid-run.
    expect(routeUserInput('running', '  /compact ')).toBe('command')
    expect(routeUserInput('idle', '/compact')).toBe('command')
  })

  it('reports an unmatched slash command without sending it to the model', async () => {
    const followup = vi.fn()
    const router = new AgentInputRouter({ followup, executeCommand: vi.fn(async () => undefined) })
    await expect(router.submit('/missing')).resolves.toEqual({
      kind: 'unknown-command', text: 'unknown or malformed command: /missing',
    })
    expect(followup).not.toHaveBeenCalled()
  })
})

describe('tool presentation adapter', () => {
  it('preserves recognized tool-owned intents', () => {
    expect(presentTool(completedTool, {
      presentCall: () => ({ card: 'terminal', title: 'pwd', cwd: 'D:/repo' }),
      presentResult: () => ({ card: 'terminal', output: 'D:/repo', exitCode: 0 }),
    })).toEqual({
      call: { card: 'terminal', title: 'pwd', cwd: 'D:/repo' },
      result: { card: 'terminal', output: 'D:/repo', exitCode: 0 },
    })
  })

  it('falls back to generic for missing, throwing, or unknown presenters', () => {
    expect(presentTool(completedTool, {
      presentCall: () => { throw new Error('bad presenter') },
      presentResult: () => ({ card: 'future-card' }),
    })).toEqual({
      call: { card: 'generic', title: 'bash', rawInput: { command: 'pwd' } },
      result: { card: 'generic', content: [{ type: 'text', text: 'D:/repo' }] },
    })
  })
})
