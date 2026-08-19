/**
 * The questionnaire panel: one question at a time, with its option window and
 * the free-text "Other" field when the question allows one.
 */

import React from 'react'
import { Box, Text } from 'ink'
import type { Theme } from '../theme.ts'
import { themed } from '../ui/theme-props.ts'
import type { ViewModel } from '../view-model.ts'

export function QuestionPanel({ vm, theme }: {
  vm: ViewModel
  theme: Theme
}): React.ReactElement | null {
  const question = vm.visibleQuestion
  const form = vm.activeQuestionForm
  const prompt = vm.questionPrompt
  if (question === undefined || form === undefined || prompt === undefined) return null
  return <Box flexDirection="column" marginTop={1}>
    <Text {...themed(theme, 'heading')} bold>{question.header
      ?? `Question ${String(form.index + 1)}/${String(prompt.questions.length)}`}</Text>
    <Text wrap="truncate-end">{question.question}</Text>
    {!vm.layout.showQuestionDetail ? null
      : <Text dimColor wrap="truncate-end">{question.detail}</Text>}
    {question.options?.slice(
      vm.optionStart,
      vm.optionStart + vm.layout.optionWindowSize,
    ).map((option) => {
      const index = question.options?.indexOf(option) ?? 0
      const selected = form.selected[question.id]?.includes(option.label) === true
      return <Text
        key={option.label}
        {...index === form.optionIndex ? themed(theme, 'heading') : {}}
      >
        {selected ? '[x]' : '[ ]'} {index + 1}. {option.label}
      </Text>
    })}
    {!vm.customVisible ? null
      : <Text>
        <Text dimColor>Other: </Text>{form.custom[question.id] ?? ''}<Text inverse> </Text>
      </Text>}
  </Box>
}
