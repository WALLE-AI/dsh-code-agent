import type { ApprovalDecision, ApprovalPrompt } from './contracts.ts'
import type { TuiStore } from './state.ts'

interface Pending {
  prompt: ApprovalPrompt
  signal?: AbortSignal
  settle(decision: ApprovalDecision): void
}

/** FIFO one-shot approvals. Every withdrawal and teardown fails closed. */
export class ApprovalQueue {
  private nextId = 1
  private readonly pending: Pending[] = []

  constructor(private readonly store: TuiStore) {}

  ask(input: Omit<ApprovalPrompt, 'id'>, signal?: AbortSignal): Promise<ApprovalDecision> {
    if (signal?.aborted === true) return Promise.resolve('cancelled')
    return new Promise((resolve) => {
      const prompt: ApprovalPrompt = { id: this.nextId++, ...input }
      const entry: Pending = {
        prompt,
        ...(signal === undefined ? {} : { signal }),
        settle: (decision) => {
          signal?.removeEventListener('abort', cancel)
          const index = this.pending.indexOf(entry)
          if (index !== -1) this.pending.splice(index, 1)
          resolve(decision)
          this.present()
        },
      }
      const cancel = (): void => { entry.settle('cancelled') }
      signal?.addEventListener('abort', cancel, { once: true })
      this.pending.push(entry)
      this.present()
    })
  }

  decide(allowed: boolean): void {
    this.pending[0]?.settle(allowed ? 'allowed-once' : 'rejected')
  }

  close(): void {
    while (this.pending.length > 0) this.pending[0]?.settle('unavailable')
  }

  private present(): void { this.store.setApproval(this.pending[0]?.prompt) }
}
