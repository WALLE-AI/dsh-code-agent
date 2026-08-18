import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { Box, render, Text, useInput } from 'ink'
import { paintInPlace } from './frame-writer.ts'
import { formatSessionRow } from './session-selector.ts'
import {
  caretLine, clearComposer, deleteComposer, emptyComposer, historyComposer,
  insertComposer, moveComposer, newlineComposer, promptTone, submitComposer,
} from './composer.ts'
import type { ComposerState } from './composer.ts'
import type { TuiActions, TuiView } from './contracts.ts'
import {
  acceptCompletion, mentionTokenAt, rankCommands, rankFiles, slashTokenAt,
} from './draft-completion.ts'
import type { TuiStore } from './state.ts'
import { displayWidth, sanitizeLine, truncateToWidth, wrapToWidth } from './terminal-text.ts'
import { RenderBoundary } from './render-boundary.tsx'
import { formatElapsed, spinnerFrame, SPINNER_INTERVAL_MS } from './spinner.ts'
import { buildStatusModel, renderContextBar, renderSegments } from './status-line.ts'
import {
  ASCII_TODO_GLYPHS, buildTodoPanel, todoPanelRows, UNICODE_TODO_GLYPHS,
} from './todo-panel.ts'
import { buildWorkingLine } from './working-line.ts'
import { glyphSet } from './glyphs.ts'
import { readMouse, WHEEL_ROWS } from './mouse.ts'
import type { RowTone } from './styling.ts'
import { resolveTheme, type Theme } from './theme.ts'
import { currentToolEntryId, type TranscriptLine } from './transcript-view.ts'
import {
  emptyViewport, scrollViewport, syncViewport, viewportLines,
} from './viewport.ts'
import {
  advanceQuestionForm, appendQuestionCustom, backspaceQuestionCustom,
  chooseQuestionOption, createQuestionForm, moveQuestionOption, questionAnswered,
  type QuestionFormState,
} from './question-form.ts'
import { terminalLayout, terminalLayoutPolicy } from './terminal-layout.ts'
import {
  fromInkKey, KEY_BINDINGS, resolveKey, type UiAction, type UiSurface,
} from './keymap.ts'
import { buildOverlay, fitHint, helpRows, type OverlayRow } from './overlay.ts'
import {
  backspaceBrowser, browserEmptyText, browserFocusIndex, browserMatches,
  emptyBrowser, escapeBrowser, moveBrowser, SPLIT_MIN_COLUMNS, typeBrowser,
  type BrowserState,
} from './session-browser.ts'


/**
 * Locate the caret in the wrapped draft. `wrapToWidth` is greedy and per
 * logical line, so wrapping the text before the caret yields the same rows the
 * full draft produces — the last of them is the caret's row.
 */
function caretPosition(
  composer: ComposerState,
  width: number,
): { row: number; column: number } {
  const before = Array.from(composer.draft).slice(0, composer.cursor).join('')
  const rows = wrapToWidth(before, width)
  const last = rows.at(-1) ?? ''
  // A prefix that exactly fills its row leaves the caret on the next one.
  if (displayWidth(last) >= width) return { row: rows.length, column: 0 }
  return { row: rows.length - 1, column: Array.from(last).length }
}

/**
 * The closed outcome set of an approval. `ApprovalDecision` has no "always"
 * member, so there is deliberately no third row here.
 */
const APPROVAL_CHOICES = [
  { label: 'allow once', allowed: true },
  { label: 'reject', allowed: false },
] as const

/** Preview rows taken from the pending call's own card. */
const APPROVAL_PREVIEW_ROWS = 3

/**
 * Ink props for a tone, omitting each prop entirely when there is none to set —
 * an explicit `undefined` would still be a prop, and the no-colour smoke asserts
 * the renderer emits no SGR sequence at all.
 */
function themed(theme: Theme, tone: RowTone): { color?: string; backgroundColor?: string } {
  const color = theme.color(tone)
  const background = theme.background(tone)
  return {
    ...color === undefined ? {} : { color },
    ...background === undefined ? {} : { backgroundColor: background },
  }
}

/**
 * A running card's header, with the static status glyph replaced by the current
 * spinner frame and the elapsed time appended. Any other row is returned as-is.
 */
function runningText(line: TranscriptLine, now: number, animate: boolean): string {
  if (line.running === undefined) return line.text
  const { indent, rest, startedAtMs } = line.running
  const glyph = animate ? spinnerFrame(now) : line.text.slice(indent.length, indent.length + 1)
  const elapsed = startedAtMs === undefined ? '' : `  ${formatElapsed(now - startedAtMs)}`
  return `${indent}${glyph} ${rest}${elapsed}`
}

/**
 * Re-render on a fixed period while something is running.
 *
 * The timer exists only while `active`, so a settled session holds no interval
 * at all — an idle TUI must not wake the event loop 12 times a second.
 */
function useAnimationClock(active: boolean, periodMs: number): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => { setTick(current => current + 1) }, periodMs)
    return () => { clearInterval(timer) }
  }, [active, periodMs])
  return tick
}

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
  store, actions, stdout, theme, onRenderError, animate = true, clock = Date.now,
}: {
  store: TuiStore
  actions: TuiActions
  stdout: NodeJS.WriteStream
  theme: Theme
  /** Off for a terminal that cannot animate, and for deterministic tests. */
  animate?: boolean
  clock?: () => number
  onRenderError?: (region: string, message: string) => void
}): React.JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  const [composer, setComposer] = useState(emptyComposer)
  const [viewport, setViewport] = useState(emptyViewport)
  const [questionForm, setQuestionForm] = useState<QuestionFormState>()
  const [confirm, setConfirm] = useState<'cancel' | undefined>()
  const [palette, setPalette] = useState<{ query: string; index: number }>()
  const [focus, setFocus] = useState<'composer' | 'transcript'>('composer')
  const [completion, setCompletion] = useState(0)
  /** Highlighted approval answer; reject is the default, as it fails closed. */
  const [approvalChoice, setApprovalChoice] = useState(1)
  const [helpOpen, setHelpOpen] = useState(false)
  const [browser, setBrowser] = useState<BrowserState>()
  /** Token start the completion list was dismissed for, if any. */
  const [dismissed, setDismissed] = useState<number>()
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
  // A screen replaces the conversation; a prompt still outranks it, because the
  // Agent is blocked until it is answered.
  const browserOpen = browser !== undefined && modalFree
  const helpVisible = helpOpen && modalFree && !browserOpen
  const paletteOpen = palette !== undefined && modalFree && !helpVisible
  const paletteMatches = !paletteOpen ? [] : state.commands.filter(command =>
    command.name.toLowerCase().includes(palette.query.toLowerCase()))
  const paletteIndex = paletteMatches.length === 0
    ? 0
    : Math.min(palette?.index ?? 0, paletteMatches.length - 1)
  const composerVisible = state.interactive && modalFree && !paletteOpen
    && !helpVisible && !browserOpen
  // Completion works off the caret: a slash command owns the first token, a
  // mention can sit anywhere. Only one can be active at a time.
  const slashToken = !composerVisible ? undefined : slashTokenAt(composer.draft, composer.cursor)
  const mentionToken = !composerVisible || slashToken !== undefined
    ? undefined
    : mentionTokenAt(composer.draft, composer.cursor)
  const completionToken = slashToken ?? mentionToken
  const completionMatches = slashToken !== undefined
    ? rankCommands(slashToken.needle, state.commands)
    : mentionToken !== undefined ? rankFiles(mentionToken.needle, state.files) : []
  // Esc dismisses the list for the token it was showing, not for the draft:
  // typing on into the same mention must not resurrect it.
  const completionOpen = completionToken !== undefined
    && completionMatches.length > 0
    && dismissed !== completionToken.start
  const completionLimit = terminalLayoutPolicy(rows).commandLimit
  const completionIndex = completionMatches.length === 0
    ? 0
    : Math.min(completion, completionMatches.length - 1)
  // The completion list is the palette's overlay model without the frame: it
  // hangs straight off the composer, where a title would be noise. Sharing the
  // model is what keeps the focused row on screen in a long list — the old
  // `index - 1` slice pushed it off the end.
  const completionView = !completionOpen ? undefined : buildOverlay(
    completionMatches.map(item => ({
      id: item.value,
      text: item.description === undefined ? item.label : `${item.label}  ${item.description}`,
      lines: 1,
    })),
    completionIndex,
    {
      title: '',
      hint: '',
      columns,
      // One row goes back to the hint when there is something to hide, so the
      // list never claims more than the budget it was given.
      rowBudget: Math.max(
        1,
        completionMatches.length > completionLimit ? completionLimit - 1 : completionLimit,
      ),
    },
  )
  const completionHint = completionView === undefined
    || (completionView.above === undefined && completionView.below === undefined)
    ? undefined
    : [completionView.above, completionView.below].filter(part => part !== undefined).join(' · ')
  const customVisible = visibleQuestion !== undefined && activeQuestionForm !== undefined
    && ((visibleQuestion.options?.length ?? 0) === 0
      || (activeQuestionForm.custom[visibleQuestion.id]?.length ?? 0) > 0)
  const notice = confirm === 'cancel' ? 'Press again to stop the current run' : state.notice
  // The decision belongs to a streamed call: show that card's own summary.
  const approvalEntry = state.approval?.callId === undefined
    ? undefined
    : state.entries.find(entry => entry.id === `tool:${state.approval?.callId ?? ''}`)
  // The decision needs the call itself, not a one-line summary of it: a command
  // or a diff is what the answer actually turns on.
  const approvalPreview = state.approval === undefined ? [] : [
    ...(approvalEntry?.header === undefined ? [] : [approvalEntry.header]),
    ...(approvalEntry?.detail ?? []).slice(0, APPROVAL_PREVIEW_ROWS).map(line => line.text),
    ...(state.approval.reason === undefined ? [] : [`reason: ${state.approval.reason}`]),
  ]
  // An approval outranks a questionnaire because it gates a tool about to run,
  // but the questionnaire must not vanish without a trace.
  const queuedPrompts = state.approval !== undefined && activeQuestion !== undefined
  // The prompt marker occupies two cells and the cursor block one more.
  const draftWidth = Math.max(1, columns - 2)
  // The trailing space is the cell the caret occupies when it sits at the end.
  const draftRows = composerVisible ? wrapToWidth(`${composer.draft} `, draftWidth) : ['']
  const caret = caretPosition(composer, draftWidth)
  // Something is running whenever the Agent is busy or a card is still open.
  const running = state.status === 'running'
    || state.entries.some(entry => entry.status === 'pending')
  // A single clock read keeps every row of one frame consistent with each other.
  const now = clock()
  const glyphs = glyphSet(animate)
  const status = buildStatusModel(state.activity, state.counters, {
    ...(state.model === undefined ? {} : { model: state.model }),
    ...(state.workspace.branch === undefined ? {} : { branch: state.workspace.branch }),
    ...(state.workspace.directory === undefined ? {} : { directory: state.workspace.directory }),
    running,
    paused: viewport.offsetFromBottom > 0,
    unread: viewport.unread,
  })
  const layout = terminalLayout({
    rows,
    composerRows: draftRows.length,
    interactive: composerVisible,
    approval: state.approval !== undefined,
    approvalPreviewRows: approvalPreview.length,
    ...visibleQuestion === undefined ? {} : { question: {
      detail: visibleQuestion.detail !== undefined,
      optionCount: visibleQuestion.options?.length ?? 0,
      customVisible,
    } },
    commandCount: (completionView?.rows.length ?? 0) + Number(completionHint !== undefined),
    ...(paletteOpen ? { overlay: { rows: Math.max(1, paletteMatches.length) } } : {}),
    // The pane spends two extra rows on its title and scroll hints.
    notice: notice !== undefined,
    error: state.error !== undefined,
    todoRows: todoPanelRows(state.activity),
    working: running,
    contextBar: status.bar !== undefined,
  })
  // While the Agent is working, one line above the composer says so.
  const workingLine = !running || !layout.showWorking ? undefined : buildWorkingLine({
    frame: animate ? spinnerFrame(now) : glyphs.pending,
    turn: state.turn.index,
    elapsedMs: state.turn.startedAtMs === 0 ? 0 : now - state.turn.startedAtMs,
    ...(state.activity.tokens === undefined ? {} : { tokens: state.activity.tokens.output }),
    separator: glyphs.marker,
  }, columns)
  const todoPanel = buildTodoPanel(
    state.activity, columns, layout.todoRows,
    animate ? UNICODE_TODO_GLYPHS : ASCII_TODO_GLYPHS,
  )
  const browserRows = browser === undefined ? [] : browserMatches(state.sessions, browser.query)
  const browserFocus = browser === undefined ? 0 : browserFocusIndex(browserRows, browser)
  // Both list overlays share one model, one window rule and one region.
  const overlayRows: readonly OverlayRow[] = paletteOpen
    ? paletteMatches.map(command => ({
      id: command.name,
      text: `/${command.name}  ${command.description}`,
      lines: 1,
    }))
    : []
  const overlay = !paletteOpen ? undefined : buildOverlay(
    overlayRows,
    paletteIndex,
    {
      title: 'Commands',
      hint: fitHint(
        [
            'type to filter · ↑↓ select · Enter prefill · Esc close',
            '↑↓ · Enter · Esc',
            'Esc',
          ],
        Math.max(0, columns - 20),
      ),
      columns,
      rowBudget: layout.paletteLimit,
      emptyText: 'no command matches',
    },
  )
  // The window follows the caret so an edit high up in a long draft stays visible.
  const draftStart = Math.max(0, Math.min(
    caret.row - layout.composerRows + 1,
    draftRows.length - layout.composerRows,
  ))
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
  // Rows are wrapped in the store, so a resize re-flows the whole transcript.
  useEffect(() => { store.setColumns(columns) }, [store, columns])
  // Persisted history arrives once, after the first frame; adopt it only while
  // the composer has none of its own so a submitted draft is never displaced.
  useEffect(() => {
    if (state.history.length === 0) return
    setComposer(current => current.history.length > 0
      ? current
      : { ...current, history: state.history })
  }, [state.history])
  // A different token is a different list: start at its first candidate.
  useEffect(() => { setCompletion(0) }, [completionToken?.start, completionToken?.needle])
  const mentionNeedle = mentionToken?.needle
  useEffect(() => {
    if (mentionNeedle !== undefined) actions.listFiles(mentionNeedle)
  }, [mentionNeedle, actions])
  useEffect(() => {
    setViewport(current => syncViewport(
      current, state.lines.length, state.transcriptRevision, layout.viewportRows,
    ))
  }, [state.lines.length, state.transcriptRevision, layout.viewportRows])
  useAnimationClock(animate && running, SPINNER_INTERVAL_MS)
  const visibleLines = viewportLines(state.lines, viewport, layout.viewportRows)
  const visibleEnd = Math.max(0, state.lines.length - viewport.offsetFromBottom)
  const currentTool = currentToolEntryId(state.entries, state.lines, visibleEnd)
  const surface: UiSurface = state.approval !== undefined
    ? 'approval'
    : activeQuestion !== undefined && activeQuestionForm !== undefined && questionPrompt !== undefined
      ? 'question'
      : browserOpen
        ? 'browser'
        : helpVisible
        ? 'help'
        : paletteOpen
          ? 'palette'
          : focus === 'transcript' ? 'transcript' : 'composer'
  // The early-return段 of the open cascade must not disarm a pending confirmation:
  // moving focus or opening a list is not "some other key was pressed".
  const keepsCancelArmed = (action: UiAction): boolean =>
    action.kind === 'open-palette' || action.kind === 'open-picker' || action.kind === 'toggle-focus'
    || (surface === 'transcript'
      && (action.kind === 'focus-composer' || (action.kind === 'scroll' && !action.page)))
  useInput((input, key) => {
    const scrollBy = (direction: -1 | 1, amount: number): void => {
      if (direction === -1) {
        // At the oldest rendered row, page more retained history into the window.
        const atTop = viewport.offsetFromBottom >= Math.max(0, state.lines.length - layout.viewportRows)
        if (atTop && state.hasMoreHistory) actions.expandTranscript()
      }
      setViewport(current => scrollViewport(current, direction, amount, layout.viewportRows))
    }
    // Wheel notches arrive as input, not as scrollback: the frame is repainted in
    // place, so the terminal's own buffer never holds a row of it. They drive the
    // same viewport PgUp/PgDn drives, which is what still holds the banner.
    const mouse = readMouse(input)
    if (mouse.consumed) {
      // A report on any other surface is swallowed, never typed into the draft.
      if (surface === 'composer' || surface === 'transcript') {
        for (const notch of mouse.notches) scrollBy(notch.direction, WHEEL_ROWS)
      }
      return
    }
    const event = fromInkKey(input, key)
    const line = caretLine(composer)
    const action = resolveKey(surface, event, {
      interactive: state.interactive,
      cancelArmed: confirm === 'cancel',
      questionHasOptions: (activeQuestion?.options?.length ?? 0) > 0,
      draftEmpty: composer.draft === '',
      canMoveUp: line.index > 0,
      canMoveDown: line.index < line.count - 1,
      completionOpen,
      completionExact: completionToken !== undefined
        && completionMatches[completionIndex]?.value
          === composer.draft.slice(completionToken.start, completionToken.end),
    })
    if (action === undefined) {
      if ((surface === 'composer' || surface === 'transcript') && confirm !== undefined) {
        setConfirm(undefined)
      }
      return
    }
    if ((surface === 'composer' || surface === 'transcript')
      && confirm !== undefined && !keepsCancelArmed(action)) {
      setConfirm(undefined)
    }
    const finishQuestion = (next: QuestionFormState): void => {
      if (questionPrompt === undefined) return
      const advanced = advanceQuestionForm(next, questionPrompt)
      if (advanced.answer !== undefined) {
        actions.answerQuestion(advanced.answer)
        setQuestionForm(undefined)
      } else setQuestionForm(advanced.state)
    }
    switch (action.kind) {
      case 'cancel-arm': return setConfirm('cancel')
      case 'cancel': {
        setConfirm(undefined)
        return actions.cancel()
      }
      case 'approval-decide': {
        setApprovalChoice(1)
        return actions.decideApproval(action.allowed)
      }
      case 'approval-move': return setApprovalChoice(current => Math.max(
        0, Math.min(APPROVAL_CHOICES.length - 1, current + action.delta),
      ))
      case 'approval-confirm': {
        const choice = APPROVAL_CHOICES[approvalChoice] ?? APPROVAL_CHOICES[1]
        setApprovalChoice(1)
        return actions.decideApproval(choice.allowed)
      }
      case 'question-move': {
        if (activeQuestionForm === undefined || activeQuestion === undefined) return
        return setQuestionForm(moveQuestionOption(activeQuestionForm, activeQuestion, action.delta))
      }
      case 'question-backspace': {
        if (activeQuestionForm === undefined || activeQuestion === undefined) return
        return setQuestionForm(backspaceQuestionCustom(activeQuestionForm, activeQuestion))
      }
      case 'question-choose': {
        if (activeQuestionForm === undefined || activeQuestion === undefined) return
        // A digit with no matching option is ordinary text for the "Other" field.
        if (activeQuestion.options?.[action.index] === undefined) {
          return setQuestionForm(appendQuestionCustom(
            activeQuestionForm, activeQuestion, String(action.index + 1),
          ))
        }
        const next = chooseQuestionOption(activeQuestionForm, activeQuestion, action.index)
        if (activeQuestion.multiSelect === true) setQuestionForm(next)
        else finishQuestion(next)
        return
      }
      case 'question-toggle': {
        if (activeQuestionForm === undefined || activeQuestion === undefined) return
        return setQuestionForm(chooseQuestionOption(activeQuestionForm, activeQuestion))
      }
      case 'question-submit': {
        if (activeQuestionForm === undefined || activeQuestion === undefined) return
        const hasOptions = (activeQuestion.options?.length ?? 0) > 0
        if (hasOptions && !questionAnswered(activeQuestionForm, activeQuestion)) {
          const chosen = chooseQuestionOption(activeQuestionForm, activeQuestion)
          if (activeQuestion.multiSelect === true) return setQuestionForm(chosen)
          return finishQuestion(chosen)
        }
        return finishQuestion(activeQuestionForm)
      }
      case 'question-type': {
        if (activeQuestionForm === undefined || activeQuestion === undefined) return
        return setQuestionForm(appendQuestionCustom(activeQuestionForm, activeQuestion, action.text))
      }
      case 'palette-close': return setPalette(undefined)
      case 'palette-move': return setPalette(current => current === undefined
        ? current
        : {
          ...current,
          index: action.delta === -1
            ? Math.max(0, paletteIndex - 1)
            : Math.min(paletteMatches.length - 1, paletteIndex + 1),
        })
      case 'palette-backspace': return setPalette(current => current === undefined
        ? current
        : { ...current, query: Array.from(current.query).slice(0, -1).join('') })
      case 'palette-accept': {
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
      case 'palette-type': return setPalette(current => current === undefined
        ? current
        : { query: current.query + action.text, index: 0 })
      case 'open-help': return setHelpOpen(true)
      case 'close-help': return setHelpOpen(false)
      case 'cycle-mode': {
        // The preset list comes from the projection; switching goes through the
        // official command so the Harness stays the single source of truth.
        const options = state.activity.permission?.options ?? []
        const current = options.findIndex(
          option => option.value === state.activity.permission?.current,
        )
        const next = options[(current + 1) % Math.max(1, options.length)]
        if (next !== undefined) actions.submit(`/permission ${next.value}`)
        return
      }
      case 'open-palette': return setPalette({ query: '', index: 0 })
      case 'open-picker': {
        actions.listSessions()
        return setBrowser(emptyBrowser)
      }
      case 'browser-move': return setBrowser(current => current === undefined
        ? current
        : moveBrowser(current, browserRows, action.delta))
      case 'browser-page': return setBrowser(current => current === undefined
        ? current
        // Paging is repeated single steps so it always lands on a real row.
        : moveBrowser(current, browserRows, action.delta * Math.max(1, layout.viewportRows - 2)))
      case 'browser-type': return setBrowser(current => current === undefined
        ? current
        : typeBrowser(current, action.text))
      case 'browser-backspace': return setBrowser(current => current === undefined
        ? current
        : backspaceBrowser(current))
      case 'browser-accept': {
        const chosen = browserRows[browserFocus]
        if (chosen === undefined) return
        // The screen stays open until the resume actually lands, so a failure
        // is visible where it happened rather than behind a closed screen.
        setBrowser(current => current === undefined ? current : { ...current, resuming: true })
        return actions.resumeSession(chosen.id)
      }
      case 'browser-escape': {
        if (browser === undefined) return
        const next = escapeBrowser(browser)
        return setBrowser(next.close ? undefined : next.state)
      }
      // Only two panes exist: the transcript and the composer.
      case 'toggle-focus':
        return setFocus(current => current === 'composer' ? 'transcript' : 'composer')
      case 'focus-composer': return setFocus('composer')
      case 'scroll':
        return scrollBy(action.direction, action.page ? layout.viewportRows : 1)
      case 'toggle-fold': {
        if (currentTool !== undefined) actions.toggleFold(currentTool)
        return
      }
      case 'open-editor': {
        const entry = state.entries.find(item => item.id === currentTool)
        const location = entry?.locations[0]
        if (location !== undefined) actions.openLocation(location)
        return
      }
      case 'completion-accept': {
        const item = completionMatches[completionIndex]
        if (item === undefined || completionToken === undefined) return
        setCompletion(0)
        return setComposer(current => acceptCompletion(current, completionToken, item))
      }
      case 'completion-move': return setCompletion(action.delta === -1
        ? Math.max(0, completionIndex - 1)
        : Math.min(completionMatches.length - 1, completionIndex + 1))
      case 'completion-dismiss': return setDismissed(completionToken?.start)
      case 'history': return setComposer(current => historyComposer(current, action.delta))
      case 'composer-move':
        return setComposer(current => moveComposer(current, action.motion))
      case 'composer-delete':
        return setComposer(current => deleteComposer(current, action.deletion))
      case 'composer-clear': return setComposer(clearComposer)
      case 'composer-newline': return setComposer(newlineComposer)
      case 'submit': {
        setComposer(current => {
          const submitted = submitComposer(current)
          if (submitted.text !== undefined) actions.submit(submitted.text)
          return submitted.state
        })
        return
      }
      case 'composer-insert':
        return setComposer(current => insertComposer(current, action.text))
    }
  })
  // The status row must never wrap: a second row would break the layout budget.
  // Fields are fitted right to left, so the activity segments absorb the slack.
  const hint = !state.interactive
    ? 'one-shot session'
    : focus === 'transcript' ? 'j/k scroll · Tab back to input' : status.hint
  const statusRight = renderSegments(status.right, Math.max(0, Math.floor(columns * 0.4)))
  const statusHint = truncateToWidth(
    hint, Math.max(0, columns - displayWidth(statusRight) - 2),
  )
  const statusLeft = renderSegments(status.left, Math.max(
    0, columns - displayWidth(statusRight) - displayWidth(statusHint) - 4,
  ))
  const contextBar = layout.showStatus && layout.showContextBar && status.bar !== undefined
    ? renderContextBar(status.bar.used, status.bar.total, columns)
    : undefined
  if (helpVisible) {
    const sheet = buildOverlay(helpRows(KEY_BINDINGS), 0, {
      marker: ' ',
      title: 'Shortcuts',
      hint: fitHint(['any key to close', 'Esc'], Math.max(0, columns - 12)),
      columns,
      // One row for the title, one for each scroll hint, one of headroom.
      rowBudget: Math.max(1, rows - 4),
    })
    return <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text {...themed(theme, 'heading')} bold>{sheet.title}</Text>
        <Text dimColor>{sheet.hint}</Text>
      </Box>
      {sheet.above === undefined ? null : <Text dimColor>{sheet.above}</Text>}
      {sheet.rows.map((row, index) => <Text key={String(index)}>{row}</Text>)}
      {sheet.below === undefined ? null : <Text dimColor>{sheet.below}</Text>}
    </Box>
  }
  // A screen replaces the conversation rather than floating over it: rendering it
  // as an early return — after every hook above — is what makes that literal.
  // There is no transcript underneath to repaint, scroll, or bleed through.
  if (browser !== undefined && browserOpen) {
    const budget = Math.max(1, rows - 4)
    const split = columns >= SPLIT_MIN_COLUMNS
    const listColumns = split ? Math.floor(columns * 0.55) : columns
    const view = buildOverlay(
      browserRows.map(session => ({
        id: session.id,
        text: formatSessionRow(session, Math.max(1, listColumns - 2), now),
        lines: 1,
      })),
      browserFocus,
      {
        title: 'Sessions',
        hint: fitHint(
          ['type to filter · ↑↓ move · Enter resume · Esc close', '↑↓ · Enter · Esc', 'Esc'],
          Math.max(0, columns - 12),
        ),
        columns: listColumns,
        rowBudget: budget,
        emptyText: browserEmptyText(browser.query),
      },
    )
    const focused = browserRows[browserFocus]
    return <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text {...themed(theme, 'heading')} bold>
          {truncateToWidth(`Sessions  ${browser.query}`, Math.max(1, columns - 12))}
        </Text>
        <Text dimColor>{browser.resuming ? 'resuming…' : view.hint}</Text>
      </Box>
      <Box>
        <Box flexDirection="column" width={listColumns}>
          {view.above === undefined ? null : <Text dimColor>{view.above}</Text>}
          {view.rows.map((row, index) => <Text
            key={String(index)}
            {...row.startsWith('>') ? themed(theme, 'heading') : {}}
          >{row}</Text>)}
          {view.below === undefined ? null : <Text dimColor>{view.below}</Text>}
        </Box>
        {!split || focused === undefined ? null : <Box flexDirection="column" marginLeft={2}>
          <Text dimColor>{truncateToWidth(focused.id, columns - listColumns - 2)}</Text>
          <Text dimColor>{truncateToWidth(focused.cwd ?? '', columns - listColumns - 2)}</Text>
          <Text dimColor>{focused.live ? 'live' : 'persisted'}</Text>
        </Box>}
      </Box>
    </Box>
  }
  return <Box flexDirection="column">
    {!layout.showHeader ? null : <Box justifyContent="space-between">
      <Text bold>DeepSeek Harness TUI</Text><Text>{state.status}</Text>
    </Box>}
    <Box flexDirection="column" marginTop={1} height={layout.viewportRows}>
      <RenderBoundary region="transcript" {...onRenderError === undefined ? {} : { onError: onRenderError }}>
        {visibleLines.map((line, index) => {
          const plain = truncateToWidth(runningText(line, now, animate), columns)
          // Styled runs are only used when the row survived truncation intact;
          // re-slicing segments to a cut width would risk splitting a wide cell.
          const segments = line.segments !== undefined && plain === line.text
            ? line.segments
            : undefined
          return <Text
            key={`${String(index)}:${line.entryId}`}
            {...themed(theme, line.tone)}
            {...(theme.dim(line.tone) || !line.header) && segments === undefined
              ? { dimColor: true } : {}}
            {...line.header && line.tone === 'user' ? { bold: true } : {}}
          >{segments === undefined
            ? plain
            : segments.map((segment, at) => <Text
              key={String(at)}
              {...themed(theme, segment.tone ?? line.tone)}
              {...theme.enabled && segment.color !== undefined ? { color: segment.color } : {}}
              {...theme.enabled && segment.background !== undefined
                ? { backgroundColor: segment.background } : {}}
              {...segment.bold === true ? { bold: true } : {}}
              {...segment.dim === true ? { dimColor: true } : {}}
              {...segment.italic === true ? { italic: true } : {}}
              {...segment.strikethrough === true ? { strikethrough: true } : {}}
            >{segment.text}</Text>)}</Text>
        })}
      </RenderBoundary>
    </Box>
    {state.approval === undefined ? null : <Box
      flexDirection="column"
      marginTop={layout.showApprovalMargin ? 1 : 0}
    >
      <Box justifyContent="space-between">
        <Text {...themed(theme, 'badge')} bold>{truncateToWidth(
          `Approve ${state.approval.toolName}?`
          + `${state.activity.permission === undefined ? '' : ` (${state.activity.permission.current})`}`,
          columns,
        )}</Text>
        {!queuedPrompts ? null : <Text dimColor>1 more prompt queued</Text>}
      </Box>
      {approvalPreview.slice(0, layout.approvalPreviewRows).map((line, index) => <Text key={String(index)} dimColor>
        {truncateToWidth(sanitizeLine(line), columns)}
      </Text>)}
      {APPROVAL_CHOICES.map((choice, index) => <Text
        key={choice.label}
        {...index === approvalChoice ? themed(theme, 'heading') : {}}
      >{truncateToWidth(
        `${index === approvalChoice ? '>' : ' '} ${String(index + 1)} ${choice.label}`,
        columns,
      )}</Text>)}
    </Box>}
    {visibleQuestion === undefined || activeQuestionForm === undefined || questionPrompt === undefined
      ? null : <Box flexDirection="column" marginTop={1}>
      <Text {...themed(theme, 'heading')} bold>{visibleQuestion.header
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
        return <Text key={option.label} {...index === activeQuestionForm.optionIndex ? themed(theme, 'heading') : {}}>
          {selected ? '[x]' : '[ ]'} {index + 1}. {option.label}
        </Text>
      })}
      {!customVisible ? null
        : <Text><Text dimColor>Other: </Text>{activeQuestionForm.custom[visibleQuestion.id] ?? ''}<Text inverse> </Text></Text>
      }
    </Box>}
    {overlay === undefined ? null : <Box flexDirection="column" marginTop={1}>
      <Box justifyContent="space-between">
        <Text {...themed(theme, 'heading')} bold>{overlay.title}</Text>
        <Text dimColor>{overlay.hint}</Text>
      </Box>
      {overlay.above === undefined ? null : <Text dimColor>{overlay.above}</Text>}
      {overlay.rows.map((row, index) => <Text
        key={String(index)}
        {...row.startsWith('>') ? themed(theme, 'heading') : {}}
      >{row}</Text>)}
      {overlay.below === undefined ? null : <Text dimColor>{overlay.below}</Text>}
    </Box>}
    {workingLine === undefined ? null
      : <Text {...themed(theme, 'tool')}>{workingLine}</Text>}
    {todoPanel.length === 0 ? null : <Box flexDirection="column">
      {todoPanel.map((row, index) => <Text
        key={String(index)}
        {...row.active ? themed(theme, 'heading') : {}}
        {...row.active ? {} : { dimColor: true }}
      >{row.text}</Text>)}
    </Box>}
    {!composerVisible ? null : <Box flexDirection="column" marginTop={1}>
      {draftRows.slice(draftStart, draftStart + layout.composerRows).map((row, index) => {
        const rowIndex = draftStart + index
        const prefix = rowIndex > 0 ? (index === 0 ? '… ' : '  ') : '> '
        const cells = Array.from(row)
        return <Box key={String(rowIndex)}>
          <Text {...themed(theme, promptTone(state.activity.permission?.current))}>{prefix}</Text>
          {rowIndex !== caret.row
            ? <Text>{row}</Text>
            : <>
              <Text>{cells.slice(0, caret.column).join('')}</Text>
              <Text inverse>{cells[caret.column] ?? ' '}</Text>
              <Text>{cells.slice(caret.column + 1).join('')}</Text>
            </>}
        </Box>
      })}
    </Box>}
    {completionView === undefined ? null : <Box flexDirection="column">
      {completionView.rows.map((row, index) => <Text
        key={String(index)}
        {...row.startsWith('>') ? themed(theme, 'heading') : {}}
      >{row}</Text>)}
      {completionHint === undefined ? null : <Text dimColor>{completionHint}</Text>}
    </Box>}
    {!layout.showNotice || notice === undefined ? null
      : <Text {...themed(theme, 'heading')}>{truncateToWidth(sanitizeLine(notice), columns)}</Text>}
    {state.error === undefined ? null
      : <Text {...themed(theme, 'error')}>{truncateToWidth(sanitizeLine(state.error), columns)}</Text>}
    {contextBar === undefined ? null : <Text dimColor>{contextBar}</Text>}
    {!layout.showStatus ? null : <Box justifyContent="space-between">
      <Text dimColor>{statusLeft}</Text>
      <Text dimColor>{statusHint}</Text>
      <Text dimColor>{statusRight}</Text>
    </Box>}
  </Box>
}

export function createInkView(
  store: TuiStore,
  actions: TuiActions,
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
  theme: Theme = resolveTheme('basic'),
  onRenderError?: (region: string, message: string) => void,
  animate = true,
  clock: () => number = Date.now,
): TuiView {
  // Ink repaints by erasing every row it wrote last time; on a full-height
  // frame with a spinner running that is a whole-screen erase ten times a
  // second. The painter rewrites only the rows that differ.
  const painted = paintInPlace(stdout)
  const instance = render(
    <TuiApp
      store={store}
      actions={actions}
      stdout={stdout}
      theme={theme}
      animate={animate}
      clock={clock}
      {...onRenderError === undefined ? {} : { onRenderError }}
    />,
    // Ink would unmount on the first Ctrl+C; cancellation must go through the
    // TUI's own two-step confirmation and the bounded shutdown sequence.
    { stdin, stdout: painted, stderr, exitOnCtrlC: false },
  )
  return { unmount: () => { instance.unmount() } }
}
