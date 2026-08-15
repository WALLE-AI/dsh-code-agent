import type {
  QuestionAnswer, QuestionItem, QuestionPrompt,
} from './contracts.ts'

export interface QuestionFormState {
  readonly promptId: number
  readonly index: number
  readonly optionIndex: number
  readonly selected: Readonly<Record<string, readonly string[]>>
  readonly custom: Readonly<Record<string, string>>
}

export function createQuestionForm(prompt: QuestionPrompt): QuestionFormState {
  return { promptId: prompt.id, index: 0, optionIndex: 0, selected: {}, custom: {} }
}

export function moveQuestionOption(
  state: QuestionFormState,
  question: QuestionItem,
  direction: -1 | 1,
): QuestionFormState {
  const maximum = Math.max(0, (question.options?.length ?? 1) - 1)
  return { ...state, optionIndex: Math.max(0, Math.min(maximum, state.optionIndex + direction)) }
}

export function chooseQuestionOption(
  state: QuestionFormState,
  question: QuestionItem,
  optionIndex = state.optionIndex,
): QuestionFormState {
  const label = question.options?.[optionIndex]?.label
  if (label === undefined) return state
  const current = state.selected[question.id] ?? []
  const selected = question.multiSelect === true
    ? current.includes(label) ? current.filter(value => value !== label) : [...current, label]
    : [label]
  return {
    ...state,
    optionIndex,
    selected: { ...state.selected, [question.id]: selected },
  }
}

export function appendQuestionCustom(
  state: QuestionFormState,
  question: QuestionItem,
  text: string,
): QuestionFormState {
  return { ...state, custom: { ...state.custom, [question.id]: (state.custom[question.id] ?? '') + text } }
}

export function backspaceQuestionCustom(
  state: QuestionFormState,
  question: QuestionItem,
): QuestionFormState {
  const characters = Array.from(state.custom[question.id] ?? '')
  characters.pop()
  return { ...state, custom: { ...state.custom, [question.id]: characters.join('') } }
}

export function questionAnswered(state: QuestionFormState, question: QuestionItem): boolean {
  return (state.selected[question.id]?.length ?? 0) > 0
    || (state.custom[question.id]?.trim().length ?? 0) > 0
}

function answerOf(state: QuestionFormState, prompt: QuestionPrompt): QuestionAnswer {
  return {
    answers: prompt.questions.map(question => ({
      id: question.id,
      selected: [...(state.selected[question.id] ?? [])],
      ...(state.custom[question.id]?.trim() === undefined || state.custom[question.id]?.trim() === ''
        ? {}
        : { custom: state.custom[question.id]?.trim() as string }),
    })),
  }
}

export function advanceQuestionForm(
  state: QuestionFormState,
  prompt: QuestionPrompt,
): { readonly state: QuestionFormState; readonly answer?: QuestionAnswer } {
  const question = prompt.questions[state.index]
  if (question === undefined || !questionAnswered(state, question)) return { state }
  if (state.index === prompt.questions.length - 1) return { state, answer: answerOf(state, prompt) }
  return { state: { ...state, index: state.index + 1, optionIndex: 0 } }
}
