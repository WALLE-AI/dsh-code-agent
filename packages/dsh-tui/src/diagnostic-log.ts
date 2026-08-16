/**
 * Opt-in diagnostic log. It never writes to the interactive stdout, and it
 * never records credentials, prompts, model output, or tool payloads.
 */

import { appendFileSync } from 'node:fs'

const SENSITIVE_KEY = /key|token|secret|password|passwd|authorization|credential|cookie|session_id/i
const PAYLOAD_KEY = /^(content|text|prompt|arguments|args|output|stdout|stderr|body|input|draft|message|diff)$/i
const MAX_STRING = 120
const MAX_DEPTH = 6
const MAX_ITEMS = 32

/** Replace secrets and payloads with shape-only summaries. */
export function redactDiagnostic(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `[${String(value.length)} chars]` : value
  }
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function' || typeof value === 'symbol' || value === undefined) return undefined
  if (depth >= MAX_DEPTH) return '[depth limit]'
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map(item => redactDiagnostic(item, depth + 1))
    return value.length > MAX_ITEMS ? [...items, `[+${String(value.length - MAX_ITEMS)} more]`] : items
  }
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      result[key] = '[redacted]'
      continue
    }
    if (PAYLOAD_KEY.test(key)) {
      result[key] = typeof item === 'string'
        ? `[${String(item.length)} chars]`
        : Array.isArray(item) ? `[${String(item.length)} items]` : '[omitted]'
      continue
    }
    const redacted = redactDiagnostic(item, depth + 1)
    if (redacted !== undefined) result[key] = redacted
  }
  return result
}

export interface DiagnosticLog {
  record(event: string, detail?: Record<string, unknown>): void
  readonly failures: number
}

export interface DiagnosticSink {
  (line: string): void
}

/** Create a JSONL diagnostic log; a failing sink degrades to a counter, never to stdout. */
export function createDiagnosticLog(
  sink: DiagnosticSink,
  now: () => number = Date.now,
): DiagnosticLog {
  let failures = 0
  return {
    record(event, detail) {
      try {
        sink(`${JSON.stringify({
          at: new Date(now()).toISOString(),
          event,
          ...(detail === undefined ? {} : { detail: redactDiagnostic(detail) }),
        })}\n`)
      } catch {
        failures++
      }
    },
    get failures() { return failures },
  }
}

/** File sink used by the running TUI. */
export function fileSink(path: string): DiagnosticSink {
  return (line) => { appendFileSync(path, line, 'utf8') }
}

/** A no-op log for runs without `--diagnostic-log`. */
export const silentDiagnosticLog: DiagnosticLog = { record() {}, failures: 0 }
