import type { QuestionAnswer, QuestionItem, QuestionPrompt } from './contracts.ts'
import type { TuiStore } from './state.ts'

interface PendingQuestion {
  prompt: QuestionPrompt
  signal?: AbortSignal
  settle(answer: QuestionAnswer): void
  reject(error: Error): void
}

function validateAnswer(prompt: QuestionPrompt, answer: QuestionAnswer): void {
  if (answer.answers.length !== prompt.questions.length) {
    throw new Error('question answer must cover every requested question exactly once')
  }
  const answers = new Map(answer.answers.map(item => [item.id, item]))
  if (answers.size !== answer.answers.length) throw new Error('question answer contains duplicate ids')
  for (const question of prompt.questions) {
    const item = answers.get(question.id)
    if (item === undefined) throw new Error(`question answer is missing ${question.id}`)
    const allowed = new Set(question.options?.map(option => option.label) ?? [])
    if (new Set(item.selected).size !== item.selected.length
      || item.selected.some(label => !allowed.has(label))) {
      throw new Error(`question answer for ${question.id} contains an invalid option`)
    }
    if (question.multiSelect !== true && item.selected.length > 1) {
      throw new Error(`question answer for ${question.id} selects more than one option`)
    }
    if (item.selected.length === 0 && (item.custom?.trim().length ?? 0) === 0) {
      throw new Error(`question answer for ${question.id} is empty`)
    }
  }
}

/** FIFO root-agent questions with abort- and teardown-safe settlement. */
export class QuestionQueue {
  private nextId = 1
  private readonly pending: PendingQuestion[] = []

  constructor(private readonly store: TuiStore) {}

  ask(questions: readonly QuestionItem[], signal?: AbortSignal): Promise<QuestionAnswer> {
    if (signal?.aborted === true) return Promise.reject(new Error('question was aborted'))
    return new Promise((resolve, reject) => {
      const prompt = { id: this.nextId++, questions: structuredClone(questions) }
      const entry: PendingQuestion = {
        prompt,
        ...(signal === undefined ? {} : { signal }),
        settle: answer => { finish(); resolve(structuredClone(answer)) },
        reject: error => { finish(); reject(error) },
      }
      const finish = (): void => {
        signal?.removeEventListener('abort', abort)
        const index = this.pending.indexOf(entry)
        if (index !== -1) this.pending.splice(index, 1)
        this.present()
      }
      const abort = (): void => { entry.reject(new Error('question was aborted')) }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.push(entry)
      this.present()
    })
  }

  answer(answer: QuestionAnswer): void {
    const current = this.pending[0]
    if (current === undefined) return
    validateAnswer(current.prompt, answer)
    current.settle(answer)
  }

  close(): void {
    while (this.pending.length > 0) this.pending[0]?.reject(new Error('question provider is unavailable'))
  }

  private present(): void { this.store.setQuestion(this.pending[0]?.prompt) }
}
