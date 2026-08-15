import { describe, expect, it } from 'vitest'
import type { QuestionPrompt } from '../src/contracts.ts'
import {
  advanceQuestionForm, appendQuestionCustom, backspaceQuestionCustom,
  chooseQuestionOption, createQuestionForm, moveQuestionOption,
} from '../src/question-form.ts'

const prompt: QuestionPrompt = {
  id: 7,
  questions: [
    { id: 'mode', question: 'Mode?', options: [{ label: 'Fast' }, { label: 'Careful' }] },
    {
      id: 'signals', question: 'Signals?', multiSelect: true,
      options: [{ label: 'Tests' }, { label: 'Types' }, { label: 'Review' }],
    },
    { id: 'note', question: 'Note?' },
  ],
}

describe('question form', () => {
  it('blocks unanswered questions and completes single, multi, and custom answers', () => {
    let state = createQuestionForm(prompt)
    expect(advanceQuestionForm(state, prompt)).toEqual({ state })

    state = chooseQuestionOption(state, prompt.questions[0] as NonNullable<typeof prompt.questions[0]>, 1)
    state = advanceQuestionForm(state, prompt).state
    expect(state.index).toBe(1)

    state = chooseQuestionOption(state, prompt.questions[1] as NonNullable<typeof prompt.questions[1]>, 0)
    state = chooseQuestionOption(state, prompt.questions[1] as NonNullable<typeof prompt.questions[1]>, 2)
    state = chooseQuestionOption(state, prompt.questions[1] as NonNullable<typeof prompt.questions[1]>, 0)
    expect(state.selected.signals).toEqual(['Review'])
    state = advanceQuestionForm(state, prompt).state

    state = appendQuestionCustom(state, prompt.questions[2] as NonNullable<typeof prompt.questions[2]>, '发布好')
    state = backspaceQuestionCustom(state, prompt.questions[2] as NonNullable<typeof prompt.questions[2]>)
    state = appendQuestionCustom(state, prompt.questions[2] as NonNullable<typeof prompt.questions[2]>, '了')
    expect(advanceQuestionForm(state, prompt).answer).toEqual({
      answers: [
        { id: 'mode', selected: ['Careful'] },
        { id: 'signals', selected: ['Review'] },
        { id: 'note', selected: [], custom: '发布了' },
      ],
    })
  })

  it('clamps option navigation and replaces a single selection', () => {
    const question = prompt.questions[0] as NonNullable<typeof prompt.questions[0]>
    let state = createQuestionForm(prompt)
    state = moveQuestionOption(state, question, -1)
    expect(state.optionIndex).toBe(0)
    state = moveQuestionOption(state, question, 1)
    state = moveQuestionOption(state, question, 1)
    expect(state.optionIndex).toBe(1)
    state = chooseQuestionOption(state, question, 0)
    state = chooseQuestionOption(state, question, 1)
    expect(state.selected.mode).toEqual(['Careful'])
  })
})
