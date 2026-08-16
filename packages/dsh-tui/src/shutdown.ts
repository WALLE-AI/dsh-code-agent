/**
 * Bounded shutdown. Every exit path — quit, Ctrl+C, SIGINT/SIGTERM, EOF and
 * fatal errors — runs the same ordered sequence exactly once. A timeout only
 * limits waiting; it never skips a step or relaxes a safety default.
 */

export type ShutdownReason = 'quit' | 'cancel' | 'signal' | 'eof' | 'error'

export interface ShutdownSteps {
  /** Stop accepting new user input. */
  stopInput(): void
  /** Settle pending approvals and questions as unavailable (fail closed). */
  settleInteractions(): void
  /** Ask the Agent to cancel; must not throw. */
  cancel(): void
  /** Resolve when the Agent reaches idle. */
  whenIdle(): Promise<void>
  /** Release the interactive session so its owner can flush and dispose. */
  finish(): void
}

export interface ShutdownOptions {
  readonly graceMs: number
  readonly onStep?: (step: string, detail?: string) => void
  /** Injected for tests; defaults to a real timer that never keeps the loop alive. */
  readonly delay?: (ms: number) => Promise<'timeout'>
}

function defaultDelay(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve('timeout') }, ms)
    timer.unref?.()
  })
}

/** Owns the single, ordered, idempotent shutdown sequence for one TUI session. */
export class ShutdownCoordinator {
  private started: Promise<void> | undefined
  private cause: ShutdownReason | undefined
  private timedOut = false

  constructor(
    private readonly steps: ShutdownSteps,
    private readonly options: ShutdownOptions,
  ) {}

  get reason(): ShutdownReason | undefined { return this.cause }
  get requested(): boolean { return this.started !== undefined }
  /** True when the Agent did not reach idle inside the grace window. */
  get cancelTimedOut(): boolean { return this.timedOut }

  /** Run the sequence; later calls join the first one instead of repeating it. */
  request(reason: ShutdownReason): Promise<void> {
    if (this.started !== undefined) return this.started
    this.cause = reason
    this.started = this.run(reason)
    return this.started
  }

  private async run(reason: ShutdownReason): Promise<void> {
    const step = (name: string, detail?: string): void => {
      this.options.onStep?.(name, detail)
    }
    step('shutdown-start', reason)
    this.safely('stop-input', () => { this.steps.stopInput() })
    this.safely('settle-interactions', () => { this.steps.settleInteractions() })
    this.safely('cancel', () => { this.steps.cancel() })
    const delay = this.options.delay ?? defaultDelay
    const outcome = await Promise.race([
      this.steps.whenIdle().then(() => 'idle' as const).catch(() => 'idle' as const),
      delay(this.options.graceMs),
    ])
    if (outcome === 'timeout') {
      this.timedOut = true
      step('cancel-timeout', `${String(this.options.graceMs)}ms`)
    } else {
      step('idle')
    }
    this.safely('finish', () => { this.steps.finish() })
    step('shutdown-handoff')
  }

  private safely(name: string, action: () => void): void {
    try {
      action()
      this.options.onStep?.(name)
    } catch (error) {
      // A failing step must not stop the remaining teardown.
      this.options.onStep?.(`${name}-failed`, error instanceof Error ? error.message : String(error))
    }
  }
}

/** Exit code for one shutdown reason; the durability failure code wins over it. */
export function exitCodeFor(reason: ShutdownReason | undefined, taskCode: number): number {
  switch (reason) {
    case 'cancel': case 'signal': return 130
    case 'error': return 1
    case 'eof': case 'quit': return taskCode
    default: return taskCode
  }
}
