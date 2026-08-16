import { describe, expect, it } from 'vitest'
import { createDiagnosticLog, redactDiagnostic, silentDiagnosticLog } from '../src/diagnostic-log.ts'

describe('diagnostic redaction', () => {
  it('removes credentials and never keeps prompt or tool payloads', () => {
    const redacted = redactDiagnostic({
      apiKey: 'sk-live-1234',
      DEEPSEEK_API_KEY: 'sk-live-1234',
      authorization: 'Bearer abc',
      content: 'private repository source',
      prompt: 'system persona',
      arguments: '{"path":"/etc/passwd"}',
      output: 'command output',
      toolName: 'bash',
      exitCode: 0,
    }) as Record<string, unknown>
    expect(redacted.apiKey).toBe('[redacted]')
    expect(redacted.DEEPSEEK_API_KEY).toBe('[redacted]')
    expect(redacted.authorization).toBe('[redacted]')
    expect(redacted.content).toBe('[25 chars]')
    expect(redacted.prompt).toBe('[14 chars]')
    expect(redacted.arguments).toBe('[22 chars]')
    expect(redacted.output).toBe('[14 chars]')
    expect(redacted.toolName).toBe('bash')
    expect(redacted.exitCode).toBe(0)
    expect(JSON.stringify(redacted)).not.toContain('sk-live')
    expect(JSON.stringify(redacted)).not.toContain('passwd')
  })

  it('bounds long strings, deep objects, and large arrays', () => {
    expect(redactDiagnostic('a'.repeat(500))).toBe('[500 chars]')
    expect(redactDiagnostic({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }))
      .toEqual({ a: { b: { c: { d: { e: { f: '[depth limit]' } } } } } })
    const long = redactDiagnostic(Array.from({ length: 40 }, (_, index) => index)) as unknown[]
    expect(long).toHaveLength(33)
    expect(long.at(-1)).toBe('[+8 more]')
  })
})

describe('diagnostic log', () => {
  it('writes redacted JSONL to the sink only', () => {
    const lines: string[] = []
    const log = createDiagnosticLog(line => lines.push(line), () => 0)
    log.record('startup', { model: 'deepseek-v4', apiKey: 'secret' })
    log.record('exit', { code: 0 })
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0] as string) as Record<string, unknown>
    expect(first).toMatchObject({ event: 'startup', at: '1970-01-01T00:00:00.000Z' })
    expect(first.detail).toEqual({ model: 'deepseek-v4', apiKey: '[redacted]' })
    expect(JSON.parse(lines[1] as string)).toMatchObject({ event: 'exit', detail: { code: 0 } })
  })

  it('counts sink failures instead of breaking the session', () => {
    const log = createDiagnosticLog(() => { throw new Error('disk full') })
    log.record('startup')
    expect(log.failures).toBe(1)
    expect(() => silentDiagnosticLog.record('startup', { a: 1 })).not.toThrow()
  })
})
