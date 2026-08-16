import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { Box, render, Text, useInput } from 'ink'
import { activityStatusLine } from './activity.ts'
import { formatSessionRow } from './session-selector.ts'
import {
  backspaceComposer, emptyComposer, historyComposer, insertComposer,
  newlineComposer, submitComposer,
} from './composer.ts'
import type { TuiActions, TuiView } from './contracts.ts'
import type { TuiStore } from './state.ts'
import { displayWidth, sanitizeLine, truncateToWidth, wrapToWidth } from './terminal-text.ts'
import { RenderBoundary } from './render-boundary.tsx'
import { currentToolEntryId, type TranscriptTone } from './transcript-view.ts'
import {
  emptyViewport, scrollViewport, syncViewport, viewportLines,
} from './viewport.ts'
import {
  advanceQuestionForm, appendQuestionCustom, backspaceQuestionCustom,
  chooseQuestionOption, createQuestionForm, moveQuestionOption, questionAnswered,
  type QuestionFormState,
} from './question-form.ts'
import { terminalLayout, terminalLayoutPolicy } from './terminal-layout.ts'

const TONE_COLOR: Record<TranscriptTone, string | undefined> = {
  user: 'green',
  assistant: undefined,
  reasoning: undefined,
  system: undefined,
  tool: 'cyan',
  error: 'red',
}

const DIM_TONES = new Set<TranscriptTone>(['reasoning', 'system'])

function useTerminalSize(stdout: NodeJS.WriteStream): { rows: number; columns: number } {
  const [size, setSize] = useState({ rows: stdout.rows ?? 24, columns: stdout.columns ?? 80 })
  useEffect(() => {
    const resize = (): void => { setSize({ rows: stdout.rows ?? 24, columns: stdout.columns ?? 80 }) }
    stdout.on('resize', resize)
    return () => { stdout.off('resize', resize) }
  }, [stdout])
  return size
}

export function TuiApp({
  store, actions, stdout, color, onRenderError,
}: {
  store: TuiStore
  actions: TuiActions
  stdout: NodeJS.WriteStream
  color: boolean
  onRenderError?: (region: string, message: string) => void
}): React.JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  const [composer, setComposer] = useState(emptyComposer)
  const [viewport, setViewport] = useState(emptyViewport)
  const [questionForm, setQuestionForm] = useState<QuestionFormState>()
  const [confirm, setConfirm] = useState<'cancel' | undefined>()
  const [palette, setPalette] = useState<{ query: string; index: number }>()
  const [picker, setPicker] = useState<{ index: number }>()
  const [focus, setFocus] = useState<'composer' | 'transcript'>('composer')
  const { rows, columns } = useTerminalSize(stdout)
  const questionPrompt = state.question
  const activeQuestionForm = questionPrompt !== undefined && questionForm?.promptId === questionPrompt.id
    ? questionForm
    : questionPrompt === undefined ? undefined : createQuestionForm(questionPrompt)
  const activeQuestion = activeQuestionForm === undefined
    ? undefined
    : questionPrompt?.questions[activeQuestionForm.index]
  const visibleQuestion = state.approval === undefined ? activeQuestion : undefined
  const modalFree = state.approval === undefined && visibleQuestion === undefined
  const paletteOpen = palette !== undefined && modalFree
  const pickerOpen = picker !== undefined && modalFree && !paletteOpen
  const pickerIndex = state.sessions.length === 0
    ? 0
    : Math.min(picker?.index ?? 0, state.sessions.length - 1)
  const paletteMatches = !paletteOpen ? [] : state.commands.filter(command =>
    command.name.toLowerCase().includes(palette.query.toLowerCase()))
  const paletteIndex = paletteMatches.length === 0
    ? 0
    : Math.min(palette?.index ?? 0, paletteMatches.length - 1)
  const composerVisible = state.interactive && modalFree && !paletteOpen && !pickerOpen
  const commandNeedle = composerVisible && composer.draft.startsWith('/')
    ? composer.draft.slice(1).split(/\s/, 1)[0]?.toLowerCase() ?? ''
    : undefined
  const commandMatches = commandNeedle === undefined ? [] : state.commands
    .filter(command => command.name.toLowerCase().startsWith(commandNeedle))
    .slice(0, terminalLayoutPolicy(rows).commandLimit)
  const customVisible = visibleQuestion !== undefined && activeQuestionForm !== undefined
    && ((visibleQuestion.options?.length ?? 0) === 0
      || (activeQuestionForm.custom[visibleQuestion.id]?.length ?? 0) > 0)
  const notice = confirm === 'cancel' ? 'Press again to stop the current run' : state.notice
  // The decision belongs to a streamed call: show that card's own summary.
  const approvalEntry = state.approval?.callId === undefined
    ? undefined
    : state.entries.find(entry => entry.id === `tool:${state.approval?.callId ?? ''}`)
  const approvalDetail = [
    approvalEntry?.header, approvalEntry?.detail[0], state.approval?.reason,
  ].filter((part): part is string => part !== undefined && part !== '').join('  ·  ')
  // The prompt marker occupies two cells and the cursor block one more.
  const draftRows = composerVisible
    ? wrapToWidth(`${composer.draft} `, Math.max(1, columns - 2))
    : ['']
  const layout = terminalLayout({
    rows,
    composerRows: draftRows.length,
    interactive: composerVisible,
    approval: state.approval !== undefined,
    approvalReason: approvalDetail !== '',
    ...visibleQuestion === undefined ? {} : { question: {
      detail: visibleQuestion.detail !== undefined,
      optionCount: visibleQuestion.options?.length ?? 0,
      customVisible,
    } },
    commandCount: commandMatches.length,
    ...(paletteOpen ? { listModal: { count: Math.max(1, paletteMatches.length) } } : {}),
    ...(pickerOpen ? { listModal: { count: Math.max(1, state.sessions.length) } } : {}),
    notice: notice !== undefined,
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
  // A single clock read keeps every picker row consistent within one frame.
  const now = Date.now()
  const visibleLines = viewportLines(state.lines, viewport, layout.viewportRows)
  const visibleEnd = Math.max(0, state.lines.length - viewport.offsetFromBottom)
  const currentTool = currentToolEntryId(state.entries, state.lines, visibleEnd)
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (confirm === 'cancel') {
        setConfirm(undefined)
        return actions.cancel()
      }
      return setConfirm('cancel')
    }
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
    if (paletteOpen) {
      if (key.escape) return setPalette(undefined)
      if (key.upArrow) return setPalette(current => current === undefined
        ? current
        : { ...current, index: Math.max(0, paletteIndex - 1) })
      if (key.downArrow) return setPalette(current => current === undefined
        ? current
        : { ...current, index: Math.min(paletteMatches.length - 1, paletteIndex + 1) })
      if (key.backspace || key.delete) return setPalette(current => current === undefined
        ? current
        : { ...current, query: Array.from(current.query).slice(0, -1).join('') })
      if (isReturn) {
        const chosen = paletteMatches[paletteIndex]
        setPalette(undefined)
        // The draft is prefilled so a command with arguments stays reviewable.
        if (chosen !== undefined) {
          setComposer(current => insertComposer(
            { ...current, draft: '' },
            `/${chosen.name}${chosen.input === undefined ? '' : ' '}`,
          ))
        }
        return
      }
      if (!key.ctrl && !key.meta && input !== '') {
        return setPalette(current => current === undefined
          ? current
          : { query: current.query + input, index: 0 })
      }
      return
    }
    if (pickerOpen) {
      if (key.escape) return setPicker(undefined)
      if (key.upArrow) return setPicker({ index: Math.max(0, pickerIndex - 1) })
      if (key.downArrow) return setPicker({ index: Math.min(state.sessions.length - 1, pickerIndex + 1) })
      if (isReturn) {
        const chosen = state.sessions[pickerIndex]
        setPicker(undefined)
        if (chosen !== undefined) actions.resumeSession(chosen.id)
      }
      return
    }
    if (key.ctrl && input === 'p') {
      if (!state.interactive) return
      return setPalette({ query: '', index: 0 })
    }
    if (key.ctrl && input === 'r') {
      if (!state.interactive) return
      actions.listSessions()
      return setPicker({ index: 0 })
    }
    if (key.tab) {
      // Only two panes exist: the transcript and the composer.
      return setFocus(current => current === 'composer' ? 'transcript' : 'composer')
    }
    if (focus === 'transcript') {
      const step = (direction: -1 | 1): void => {
        if (direction === -1) {
          const atTop = viewport.offsetFromBottom >= Math.max(0, state.lines.length - layout.viewportRows)
          if (atTop && state.hasMoreHistory) actions.expandTranscript()
        }
        setViewport(current => scrollViewport(current, direction, 1, layout.viewportRows))
      }
      if (key.upArrow || input === 'k') return step(-1)
      if (key.downArrow || input === 'j') return step(1)
      if (isReturn || key.escape) return setFocus('composer')
    }
    if (confirm !== undefined) setConfirm(undefined)
    if (key.escape) {
      if (confirm === 'cancel') return actions.cancel()
      return setConfirm('cancel')
    }
    if (key.ctrl && input === 'o') {
      if (currentTool !== undefined) actions.toggleFold(currentTool)
      return
    }
    if (key.ctrl && input === 'e') {
      const entry = state.entries.find(item => item.id === currentTool)
      const location = entry?.locations[0]
      if (location !== undefined) actions.openLocation(location)
      return
    }
    if (key.pageUp) {
      // At the oldest rendered row, page more retained history into the window.
      const atTop = viewport.offsetFromBottom >= Math.max(0, state.lines.length - layout.viewportRows)
      if (atTop && state.hasMoreHistory) actions.expandTranscript()
      return setViewport(current => scrollViewport(
        current, -1, layout.viewportRows, layout.viewportRows,
      ))
    }
    if (key.pageDown) return setViewport(current => scrollViewport(
      current, 1, layout.viewportRows, layout.viewportRows,
    ))
    if (!state.interactive || focus === 'transcript') return
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
  // The status row must never wrap: a second row would break the layout budget.
  const statusRight = activityStatusLine(
    state.activity, state.counters, Math.max(8, Math.floor(columns / 2)),
  )
  const statusLeft = truncateToWidth(
    layout.compact
      ? composerVisible ? 'Enter send' : state.status
      : !state.interactive
          ? 'one-shot session'
          : focus === 'transcript'
            ? 'transcript: j/k scroll | Tab or Enter back to input'
            : 'Enter send | Tab transcript | Ctrl+P commands | Ctrl+R sessions',
    Math.max(0, columns - displayWidth(statusRight) - 1),
  )
  return <Box flexDirection="column">
    {!layout.showHeader ? null : <Box justifyContent="space-between">
      <Text bold>DeepSeek Harness TUI</Text><Text>{state.status}</Text>
    </Box>}
    <Box flexDirection="column" marginTop={1} height={layout.viewportRows}>
      <RenderBoundary region="transcript" {...onRenderError === undefined ? {} : { onError: onRenderError }}>
        {visibleLines.map((line, index) => {
          const tone = TONE_COLOR[line.tone]
          return <Text
            key={`${String(index)}:${line.entryId}`}
            {...color && tone !== undefined ? { color: tone } : {}}
            {...DIM_TONES.has(line.tone) || !line.header ? { dimColor: true } : {}}
            {...line.header && line.tone === 'user' ? { bold: true } : {}}
          >{truncateToWidth(line.text, columns)}</Text>
        })}
      </RenderBoundary>
    </Box>
    {state.approval === undefined ? null : <Box flexDirection="column" marginTop={1}>
      <Text {...color ? { color: 'yellow' } : {}}>{truncateToWidth(
        `Approve ${state.approval.toolName}?`
        + `${state.activity.permission === undefined ? '' : ` (${state.activity.permission.current})`}`
        + ' [y/N]',
        columns,
      )}</Text>
      {!layout.showApprovalReason ? null
        : <Text dimColor>{truncateToWidth(sanitizeLine(approvalDetail ?? ''), columns)}</Text>}
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
    {!paletteOpen ? null : <Box flexDirection="column" marginTop={1}>
      <Text {...color ? { color: 'cyan' } : {}} bold>{truncateToWidth(
        `Commands  ${palette.query === '' ? '(type to filter, Esc to close)' : palette.query}`,
        columns,
      )}</Text>
      {paletteMatches.length === 0
        ? <Text dimColor>no command matches</Text>
        : paletteMatches.slice(
          Math.max(0, Math.min(paletteIndex - 2, paletteMatches.length - layout.paletteLimit)),
          Math.max(0, Math.min(paletteIndex - 2, paletteMatches.length - layout.paletteLimit)) + layout.paletteLimit,
        ).map(command => <Text
          key={command.name}
          {...color && command.name === paletteMatches[paletteIndex]?.name ? { color: 'cyan' } : {}}
        >{truncateToWidth(
          `${command.name === paletteMatches[paletteIndex]?.name ? '>' : ' '} /${command.name}  ${command.description}`,
          columns,
        )}</Text>)}
    </Box>}
    {!pickerOpen ? null : <Box flexDirection="column" marginTop={1}>
      <Text {...color ? { color: 'cyan' } : {}} bold>{truncateToWidth(
        'Resume a session  (Up/Down to select, Enter to switch, Esc to close)',
        columns,
      )}</Text>
      {state.sessions.length === 0
        ? <Text dimColor>no resumable sessions</Text>
        : state.sessions.slice(
          Math.max(0, Math.min(pickerIndex - 2, state.sessions.length - layout.paletteLimit)),
          Math.max(0, Math.min(pickerIndex - 2, state.sessions.length - layout.paletteLimit)) + layout.paletteLimit,
        ).map(session => <Text
          key={session.id}
          {...color && session.id === state.sessions[pickerIndex]?.id ? { color: 'cyan' } : {}}
        >{truncateToWidth(
          `${session.id === state.sessions[pickerIndex]?.id ? '>' : ' '} ${formatSessionRow(session, columns - 2, now)}`,
          columns,
        )}</Text>)}
    </Box>}
    {!composerVisible ? null : <Box flexDirection="column" marginTop={1}>
      {draftRows.slice(-layout.composerRows).map((row, index, shown) => {
        const last = index === shown.length - 1
        const prefix = index > 0 ? '  ' : draftRows.length > shown.length ? '… ' : '> '
        return <Box key={String(index)}>
          <Text {...color ? { color: 'green' } : {}}>{prefix}</Text>
          <Text>{last ? row.slice(0, Math.max(0, row.length - 1)) : row}</Text>
          {last ? <Text inverse> </Text> : null}
        </Box>
      })}
    </Box>}
    {commandMatches.length === 0 ? null : <Box flexDirection="column">
      {commandMatches.map(command => <Text key={command.name} wrap="truncate-end">
        <Text {...color ? { color: 'cyan' } : {}}>/{command.name}</Text>{`  ${command.description}`}
      </Text>)}
    </Box>}
    {!layout.showNotice || notice === undefined ? null
      : <Text {...color ? { color: 'cyan' } : {}}>{truncateToWidth(sanitizeLine(notice), columns)}</Text>}
    {state.error === undefined ? null
      : <Text {...color ? { color: 'red' } : {}}>{truncateToWidth(sanitizeLine(state.error), columns)}</Text>}
    {!layout.showStatus ? null : <Box justifyContent="space-between">
      <Text dimColor>{statusLeft}</Text>
      <Text dimColor>{viewport.offsetFromBottom === 0
        ? statusRight
        : `paused${viewport.unread === 0 ? '' : ` | ${String(viewport.unread)} unread`}`}</Text>
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
  onRenderError?: (region: string, message: string) => void,
): TuiView {
  const instance = render(
    <TuiApp
      store={store}
      actions={actions}
      stdout={stdout}
      color={color}
      {...onRenderError === undefined ? {} : { onRenderError }}
    />,
    // Ink would unmount on the first Ctrl+C; cancellation must go through the
    // TUI's own two-step confirmation and the bounded shutdown sequence.
    { stdin, stdout, stderr, exitOnCtrlC: false },
  )
  return { unmount: () => { instance.unmount() } }
}
