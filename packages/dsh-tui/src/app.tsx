import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { Box, render, Text, useInput } from 'ink'
import {
  backspaceComposer, emptyComposer, historyComposer, insertComposer,
  newlineComposer, submitComposer,
} from './composer.ts'
import type { TuiActions, TuiView } from './contracts.ts'
import type { TuiStore } from './state.ts'
import {
  emptyViewport, scrollViewport, syncViewport, viewportLines,
} from './viewport.ts'
import {
  advanceQuestionForm, appendQuestionCustom, backspaceQuestionCustom,
  chooseQuestionOption, createQuestionForm, moveQuestionOption, questionAnswered,
  type QuestionFormState,
} from './question-form.ts'
import { terminalLayout, terminalLayoutPolicy } from './terminal-layout.ts'

function useTerminalRows(stdout: NodeJS.WriteStream): number {
  const [rows, setRows] = useState(stdout.rows ?? 24)
  useEffect(() => {
    const resize = (): void => { setRows(stdout.rows ?? 24) }
    stdout.on('resize', resize)
    return () => { stdout.off('resize', resize) }
  }, [stdout])
  return rows
}

export function TuiApp({
  store, actions, stdout, color,
}: {
  store: TuiStore
  actions: TuiActions
  stdout: NodeJS.WriteStream
  color: boolean
}): React.JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  const [composer, setComposer] = useState(emptyComposer)
  const [viewport, setViewport] = useState(emptyViewport)
  const [questionForm, setQuestionForm] = useState<QuestionFormState>()
  const rows = useTerminalRows(stdout)
  const questionPrompt = state.question
  const activeQuestionForm = questionPrompt !== undefined && questionForm?.promptId === questionPrompt.id
    ? questionForm
    : questionPrompt === undefined ? undefined : createQuestionForm(questionPrompt)
  const activeQuestion = activeQuestionForm === undefined
    ? undefined
    : questionPrompt?.questions[activeQuestionForm.index]
  const visibleQuestion = state.approval === undefined ? activeQuestion : undefined
  const composerVisible = state.interactive && state.approval === undefined && visibleQuestion === undefined
  const commandNeedle = composerVisible && composer.draft.startsWith('/')
    ? composer.draft.slice(1).split(/\s/, 1)[0]?.toLowerCase() ?? ''
    : undefined
  const commandMatches = commandNeedle === undefined ? [] : state.commands
    .filter(command => command.name.toLowerCase().startsWith(commandNeedle))
    .slice(0, terminalLayoutPolicy(rows).commandLimit)
  const customVisible = visibleQuestion !== undefined && activeQuestionForm !== undefined
    && ((visibleQuestion.options?.length ?? 0) === 0
      || (activeQuestionForm.custom[visibleQuestion.id]?.length ?? 0) > 0)
  const layout = terminalLayout({
    rows,
    interactive: composerVisible,
    approval: state.approval !== undefined,
    approvalReason: state.approval?.reason !== undefined,
    ...visibleQuestion === undefined ? {} : { question: {
      detail: visibleQuestion.detail !== undefined,
      optionCount: visibleQuestion.options?.length ?? 0,
      customVisible,
    } },
    commandCount: commandMatches.length,
    notice: state.notice !== undefined,
    error: state.error !== undefined,
  })
  const optionStart = visibleQuestion?.options === undefined || activeQuestionForm === undefined
    ? 0
    : Math.max(0, Math.min(
      activeQuestionForm.optionIndex - Math.floor(layout.optionWindowSize / 2),
      visibleQuestion.options.length - layout.optionWindowSize,
    ))
  useEffect(() => {
    if (questionPrompt === undefined) setQuestionForm(undefined)
    else if (questionForm?.promptId !== questionPrompt.id) setQuestionForm(createQuestionForm(questionPrompt))
  }, [questionPrompt, questionForm?.promptId])
  useEffect(() => {
    setViewport(current => syncViewport(
      current, state.lines.length, state.transcriptRevision, layout.viewportRows,
    ))
  }, [state.lines.length, state.transcriptRevision, layout.viewportRows])
  const visibleLines = viewportLines(state.lines, viewport, layout.viewportRows)
  useInput((input, key) => {
    if (key.ctrl && input === 'c') return actions.cancel()
    const isReturn = key.return || /^[\r\n]+$/.test(input)
    if (state.approval !== undefined) {
      if (input.toLowerCase() === 'y') actions.decideApproval(true)
      if (input.toLowerCase() === 'n' || key.escape || key.return) actions.decideApproval(false)
      return
    }
    if (questionPrompt !== undefined && activeQuestionForm !== undefined && activeQuestion !== undefined) {
      const finish = (next: QuestionFormState): void => {
        const advanced = advanceQuestionForm(next, questionPrompt)
        if (advanced.answer !== undefined) {
          actions.answerQuestion(advanced.answer)
          setQuestionForm(undefined)
        } else setQuestionForm(advanced.state)
      }
      if (key.upArrow) return setQuestionForm(moveQuestionOption(activeQuestionForm, activeQuestion, -1))
      if (key.downArrow) return setQuestionForm(moveQuestionOption(activeQuestionForm, activeQuestion, 1))
      if (key.backspace || key.delete) {
        return setQuestionForm(backspaceQuestionCustom(activeQuestionForm, activeQuestion))
      }
      const numericOption = /^[1-9]$/.test(input) ? Number(input) - 1 : -1
      if (numericOption >= 0 && activeQuestion.options?.[numericOption] !== undefined) {
        const next = chooseQuestionOption(activeQuestionForm, activeQuestion, numericOption)
        if (activeQuestion.multiSelect === true) setQuestionForm(next)
        else finish(next)
        return
      }
      if (input === ' ' && (activeQuestion.options?.length ?? 0) > 0) {
        return setQuestionForm(chooseQuestionOption(activeQuestionForm, activeQuestion))
      }
      if (isReturn) {
        if ((activeQuestion.options?.length ?? 0) > 0
          && activeQuestion.multiSelect !== true
          && !questionAnswered(activeQuestionForm, activeQuestion)) {
          return finish(chooseQuestionOption(activeQuestionForm, activeQuestion))
        }
        if ((activeQuestion.options?.length ?? 0) > 0
          && activeQuestion.multiSelect === true
          && !questionAnswered(activeQuestionForm, activeQuestion)) {
          return setQuestionForm(chooseQuestionOption(activeQuestionForm, activeQuestion))
        }
        finish(activeQuestionForm)
        return
      }
      if (!key.ctrl && !key.meta && input !== '') {
        setQuestionForm(appendQuestionCustom(activeQuestionForm, activeQuestion, input))
      }
      return
    }
    if (key.pageUp) return setViewport(current => scrollViewport(
      current, -1, layout.viewportRows, layout.viewportRows,
    ))
    if (key.pageDown) return setViewport(current => scrollViewport(
      current, 1, layout.viewportRows, layout.viewportRows,
    ))
    if (!state.interactive) return
    if (key.upArrow) return setComposer(current => historyComposer(current, -1))
    if (key.downArrow) return setComposer(current => historyComposer(current, 1))
    if (key.backspace || key.delete) return setComposer(backspaceComposer)
    if (isReturn && (key.ctrl || key.meta)) return setComposer(newlineComposer)
    if (isReturn) {
      setComposer(current => {
        const submitted = submitComposer(current)
        if (submitted.text !== undefined) actions.submit(submitted.text)
        return submitted.state
      })
      return
    }
    if (!key.ctrl && !key.meta && input !== '') setComposer(current => insertComposer(current, input))
  })
  return <Box flexDirection="column">
    {!layout.showHeader ? null : <Box justifyContent="space-between">
      <Text bold>DeepSeek Harness TUI</Text><Text>{state.status}</Text>
    </Box>}
    <Box flexDirection="column" marginTop={1} height={layout.viewportRows}>
      {visibleLines.map((line, index) =>
        <Text wrap="truncate-end" key={`${String(index)}:${line}`}>{line}</Text>)}
    </Box>
    {state.approval === undefined ? null : <Box flexDirection="column" marginTop={1}>
      <Text {...color ? { color: 'yellow' } : {}}>Approve {state.approval.toolName}? [y/N]</Text>
      {!layout.showApprovalReason ? null
        : <Text dimColor wrap="truncate-end">{state.approval.reason}</Text>}
    </Box>}
    {visibleQuestion === undefined || activeQuestionForm === undefined || questionPrompt === undefined
      ? null : <Box flexDirection="column" marginTop={1}>
      <Text {...color ? { color: 'cyan' } : {}} bold>{visibleQuestion.header
        ?? `Question ${String(activeQuestionForm.index + 1)}/${String(questionPrompt.questions.length)}`}</Text>
      <Text wrap="truncate-end">{visibleQuestion.question}</Text>
      {!layout.showQuestionDetail ? null
        : <Text dimColor wrap="truncate-end">{visibleQuestion.detail}</Text>}
      {visibleQuestion.options?.slice(
        optionStart,
        optionStart + layout.optionWindowSize,
      ).map((option) => {
        const index = visibleQuestion.options?.indexOf(option) ?? 0
        const selected = activeQuestionForm.selected[visibleQuestion.id]?.includes(option.label) === true
        return <Text key={option.label} {...color && index === activeQuestionForm.optionIndex ? { color: 'cyan' } : {}}>
          {selected ? '[x]' : '[ ]'} {index + 1}. {option.label}
        </Text>
      })}
      {!customVisible ? null
        : <Text><Text dimColor>Other: </Text>{activeQuestionForm.custom[visibleQuestion.id] ?? ''}<Text inverse> </Text></Text>
      }
    </Box>}
    {!state.interactive || state.approval !== undefined || state.question !== undefined ? null
      : <Box marginTop={1}><Text {...color ? { color: 'green' } : {}}>{'> '}</Text><Text>{composer.draft}</Text><Text inverse> </Text></Box>}
    {commandMatches.length === 0 ? null : <Box flexDirection="column">
      {commandMatches.map(command => <Text key={command.name} wrap="truncate-end">
        <Text {...color ? { color: 'cyan' } : {}}>/{command.name}</Text>{`  ${command.description}`}
      </Text>)}
    </Box>}
    {!layout.showNotice ? null
      : <Text {...color ? { color: 'cyan' } : {}} wrap="truncate-end">{state.notice}</Text>}
    {state.error === undefined ? null
      : <Text {...color ? { color: 'red' } : {}} wrap="truncate-end">{state.error}</Text>}
    {!layout.showStatus ? null : <Box justifyContent="space-between">
      <Text dimColor>{layout.compact
        ? composerVisible ? 'Enter send' : state.status
        : state.interactive ? 'Enter send | PgUp/PgDn transcript | Up/Down history' : 'one-shot session'}</Text>
      <Text dimColor>{viewport.offsetFromBottom === 0
        ? `${state.nodes.length} nodes`
        : `paused${viewport.unread === 0 ? '' : ` | ${viewport.unread} unread`}`}</Text>
    </Box>}
  </Box>
}

export function createInkView(
  store: TuiStore,
  actions: TuiActions,
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
  color = true,
): TuiView {
  const instance = render(<TuiApp store={store} actions={actions} stdout={stdout} color={color} />, {
    stdin, stdout, stderr,
  })
  return { unmount: () => { instance.unmount() } }
}
