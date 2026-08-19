/**
 * The frame's derived state, as one pure function.
 *
 * `app.tsx` used to compute all of this inline, between its hooks and its JSX,
 * which meant the answers to "which surface owns the keyboard?", "does the
 * completion list fit?" and "what is the drop order for the status row?" could
 * only be observed by rendering a terminal. They are decisions, not painting,
 * so they live here: one call, one snapshot, testable without Ink.
 *
 * Everything in {@link ViewModel} is a function of {@link ViewModelInput}
 * alone. The view paints it and the input dispatcher reads it; neither derives
 * anything of its own.
 */

import { caretLine, emptyComposer, type ComposerState } from './composer.ts'
import type { TranscriptEntry, TranscriptLine } from './transcript-view.ts'
import { currentToolEntryId } from './transcript-view.ts'
import type {
  QuestionItem, QuestionPrompt, TuiCommandDescriptor, TuiSessionSummary, TuiSnapshot,
} from './contracts.ts'
import {
  acceptCompletion, mentionTokenAt, rankCommands, rankFiles, slashTokenAt,
  type CompletionItem, type CompletionToken,
} from './draft-completion.ts'
import { displayWidth, truncateToWidth, wrapToWidth } from './terminal-text.ts'
import { buildStatusModel, renderContextBar, renderSegments, type StatusModel } from './status-line.ts'
import {
  ASCII_TODO_GLYPHS, buildTodoPanel, todoPanelRows, UNICODE_TODO_GLYPHS,
  type TodoPanelRow,
} from './todo-panel.ts'
import { buildWorkingLine } from './working-line.ts'
import { glyphSet, type GlyphSet } from './glyphs.ts'
import { spinnerFrame } from './spinner.ts'
import { emptyViewport, viewportLines, type ViewportState } from './viewport.ts'
import { createQuestionForm, type QuestionFormState } from './question-form.ts'
import { terminalLayout, terminalLayoutPolicy, type TerminalLayout } from './terminal-layout.ts'
import {
  approvalOptions, defaultApprovalChoice, type ApprovalOption,
} from './approval-options.ts'
import type { UiSurface } from './keymap.ts'
import type { RowTone } from './styling.ts'
import { buildOverlay, fitHint, type OverlayRow, type OverlayView } from './overlay.ts'
import {
  browserEmptyText, browserFocusIndex, browserMatches, type BrowserState,
} from './session-browser.ts'
import { formatSessionRow } from './session-selector.ts'

/** Preview rows taken from the pending call's own card. */
export const APPROVAL_PREVIEW_ROWS = 3

/** How wide the terminal must be before the browser shows a detail column. */
export { SPLIT_MIN_COLUMNS } from './session-browser.ts'

/**
 * Everything the frame holds that the store does not. One object rather than
 * ten props so adding a surface does not re-thread every call site.
 */
export interface UiState {
  readonly composer: ComposerState
  readonly viewport: ViewportState
  readonly questionForm?: QuestionFormState
  readonly confirm?: 'cancel'
  readonly palette?: { readonly query: string; readonly index: number }
  readonly focus: 'composer' | 'transcript'
  readonly completion: number
  /**
   * Highlighted approval answer, once the user has moved. Absent means "the
   * default", which is computed from the answer list rather than pinned to an
   * index, because the list is no longer a fixed length.
   */
  readonly approvalChoice?: number
  /** The rejection reason being typed, when that row was chosen. */
  readonly approvalFeedback?: string
  readonly helpOpen: boolean
  readonly browser?: BrowserState
  /** Token start the completion list was dismissed for, if any. */
  readonly dismissed?: number
}

export const emptyUiState: UiState = Object.freeze({
  composer: emptyComposer,
  viewport: emptyViewport,
  focus: 'composer',
  completion: 0,
  helpOpen: false,
})

export interface ViewModelInput {
  readonly state: TuiSnapshot
  readonly ui: UiState
  readonly rows: number
  readonly columns: number
  /** Rows still owned by the repainted frame, after the scrollback split. */
  readonly liveLines: readonly TranscriptLine[]
  /** A single clock read keeps every row of one frame consistent. */
  readonly now: number
  /** Off for a terminal that cannot animate, and for deterministic tests. */
  readonly animate: boolean
}

export interface ViewModel {
  // --- modal precedence -------------------------------------------------
  readonly surface: UiSurface
  readonly modalFree: boolean
  readonly browserOpen: boolean
  readonly helpVisible: boolean
  readonly paletteOpen: boolean
  readonly composerVisible: boolean
  // --- question form ----------------------------------------------------
  readonly questionPrompt?: QuestionPrompt
  readonly activeQuestionForm?: QuestionFormState
  readonly activeQuestion?: QuestionItem
  readonly visibleQuestion?: QuestionItem
  readonly customVisible: boolean
  readonly optionStart: number
  /** An approval outranks a questionnaire, but the form must not vanish. */
  readonly queuedPrompts: boolean
  // --- approval ---------------------------------------------------------
  readonly approvalPreview: readonly string[]
  readonly approvalOptions: readonly ApprovalOption[]
  readonly approvalChoice: number
  /** The rejection reason being typed, when that row is open. */
  readonly approvalFeedback?: string
  // --- completion -------------------------------------------------------
  readonly completionToken?: CompletionToken
  /** Set only while an `@` mention owns the caret, so files are fetched once. */
  readonly mentionNeedle?: string
  readonly completionMatches: readonly CompletionItem[]
  readonly completionOpen: boolean
  readonly completionExact: boolean
  readonly completionIndex: number
  readonly completionView?: OverlayView
  readonly completionHint?: string
  // --- palette ----------------------------------------------------------
  readonly paletteMatches: readonly TuiCommandDescriptor[]
  readonly paletteIndex: number
  readonly overlay?: OverlayView
  // --- session browser --------------------------------------------------
  readonly browserRows: readonly TuiSessionSummary[]
  readonly browserFocus: number
  readonly browserView?: OverlayView
  // --- composer ---------------------------------------------------------
  readonly draftRows: readonly string[]
  readonly draftStart: number
  readonly caret: { readonly row: number; readonly column: number }
  // --- transcript -------------------------------------------------------
  readonly visibleLines: readonly TranscriptLine[]
  readonly currentTool?: string
  readonly running: boolean
  // --- status region ----------------------------------------------------
  readonly layout: TerminalLayout
  readonly glyphs: GlyphSet
  readonly status: StatusModel
  readonly workingLine?: string
  readonly todoPanel: readonly TodoPanelRow[]
  readonly notice?: string
  readonly noticeTone: RowTone
  /** How many more notices are waiting behind the one on the row. */
  readonly noticesQueued: number
  readonly statusLeft: string
  readonly statusHint: string
  readonly statusRight: string
  readonly contextBar?: string
  readonly helpView?: OverlayView
}

/**
 * Locate the caret in the wrapped draft. `wrapToWidth` is greedy and per
 * logical line, so wrapping the text before the caret yields the same rows the
 * full draft produces — the last of them is the caret's row.
 */
export function caretPosition(
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

/** Re-export so the composer view need not reach past the model. */
export { acceptCompletion }

export function buildViewModel(input: ViewModelInput): ViewModel {
  const { state, ui, rows, columns, liveLines, now, animate } = input

  // --- question form, and who outranks whom ------------------------------
  const questionPrompt = state.question
  const activeQuestionForm = questionPrompt !== undefined
    && ui.questionForm?.promptId === questionPrompt.id
    ? ui.questionForm
    : questionPrompt === undefined ? undefined : createQuestionForm(questionPrompt)
  const activeQuestion = activeQuestionForm === undefined
    ? undefined
    : questionPrompt?.questions[activeQuestionForm.index]
  const visibleQuestion = state.approval === undefined ? activeQuestion : undefined
  const modalFree = state.approval === undefined && visibleQuestion === undefined
  // A screen replaces the conversation; a prompt still outranks it, because the
  // Agent is blocked until it is answered.
  const browserOpen = ui.browser !== undefined && modalFree
  const helpVisible = ui.helpOpen && modalFree && !browserOpen
  const paletteOpen = ui.palette !== undefined && modalFree && !helpVisible
  const composerVisible = state.interactive && modalFree && !paletteOpen
    && !helpVisible && !browserOpen

  // --- completion --------------------------------------------------------
  // Completion works off the caret: a slash command owns the first token, a
  // mention can sit anywhere. Only one can be active at a time.
  const slashToken = !composerVisible
    ? undefined
    : slashTokenAt(ui.composer.draft, ui.composer.cursor)
  const mentionToken = !composerVisible || slashToken !== undefined
    ? undefined
    : mentionTokenAt(ui.composer.draft, ui.composer.cursor)
  const completionToken = slashToken ?? mentionToken
  const completionMatches = slashToken !== undefined
    ? rankCommands(slashToken.needle, state.commands)
    : mentionToken !== undefined ? rankFiles(mentionToken.needle, state.files) : []
  // Esc dismisses the list for the token it was showing, not for the draft:
  // typing on into the same mention must not resurrect it.
  const completionOpen = completionToken !== undefined
    && completionMatches.length > 0
    && ui.dismissed !== completionToken.start
  const completionLimit = terminalLayoutPolicy(rows).commandLimit
  const completionIndex = completionMatches.length === 0
    ? 0
    : Math.min(ui.completion, completionMatches.length - 1)
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
  const completionExact = completionToken !== undefined
    && completionMatches[completionIndex]?.value
      === ui.composer.draft.slice(completionToken.start, completionToken.end)

  // --- palette -----------------------------------------------------------
  const paletteMatches = !paletteOpen
    ? []
    : state.commands.filter(command =>
      command.name.toLowerCase().includes((ui.palette?.query ?? '').toLowerCase()))
  const paletteIndex = paletteMatches.length === 0
    ? 0
    : Math.min(ui.palette?.index ?? 0, paletteMatches.length - 1)

  // --- approval ----------------------------------------------------------
  const customVisible = visibleQuestion !== undefined && activeQuestionForm !== undefined
    && ((visibleQuestion.options?.length ?? 0) === 0
      || (activeQuestionForm.custom[visibleQuestion.id]?.length ?? 0) > 0)
  // The armed-cancel warning is not a notice: it belongs to a key the user is
  // half-way through pressing, so it takes the row outright rather than queueing.
  const armed = ui.confirm === 'cancel'
  const notice = armed ? 'Press again to stop the current run' : state.notice
  const noticeTone: RowTone = armed ? 'heading' : state.noticeTone ?? 'heading'
  const noticesQueued = armed ? 0 : state.noticesQueued
  // The decision belongs to a streamed call: show that card's own summary.
  const approvalEntry: TranscriptEntry | undefined = state.approval?.callId === undefined
    ? undefined
    : state.entries.find(entry => entry.id === `tool:${state.approval?.callId ?? ''}`)
  // The decision needs the call itself, not a one-line summary of it: a command
  // or a diff is what the answer actually turns on.
  const approvalPreview = state.approval === undefined ? [] : [
    ...(approvalEntry?.header === undefined ? [] : [approvalEntry.header]),
    ...(approvalEntry?.detail ?? []).slice(0, APPROVAL_PREVIEW_ROWS).map(line => line.text),
    ...(state.approval.reason === undefined ? [] : [`reason: ${state.approval.reason}`]),
  ]
  const queuedPrompts = state.approval !== undefined && activeQuestion !== undefined
  // The wider answers are the first thing to go on a terminal that cannot spend
  // four rows on them; `allow once` and `reject` always survive.
  const approvalAnswers = state.approval === undefined
    ? []
    : approvalOptions(state.activity.permission, terminalLayoutPolicy(rows).compact)
  const approvalChoice = Math.max(0, Math.min(
    ui.approvalChoice ?? defaultApprovalChoice(approvalAnswers),
    Math.max(0, approvalAnswers.length - 1),
  ))

  // --- composer ----------------------------------------------------------
  // The prompt marker occupies two cells and the cursor block one more.
  const draftWidth = Math.max(1, columns - 2)
  // The trailing space is the cell the caret occupies when it sits at the end.
  const draftRows = composerVisible ? wrapToWidth(`${ui.composer.draft} `, draftWidth) : ['']
  const caret = caretPosition(ui.composer, draftWidth)

  // --- status ------------------------------------------------------------
  // Something is running whenever the Agent is busy or a card is still open.
  const running = state.status === 'running'
    || state.entries.some(entry => entry.status === 'pending')
  const glyphs = glyphSet(animate)
  const status = buildStatusModel(state.activity, state.counters, {
    ...(state.model === undefined ? {} : { model: state.model }),
    ...(state.workspace.branch === undefined ? {} : { branch: state.workspace.branch }),
    ...(state.workspace.directory === undefined ? {} : { directory: state.workspace.directory }),
    running,
    paused: ui.viewport.offsetFromBottom > 0,
    unread: ui.viewport.unread,
  })
  const layout = terminalLayout({
    rows,
    composerRows: draftRows.length,
    interactive: composerVisible,
    approval: state.approval !== undefined,
    approvalPreviewRows: approvalPreview.length,
    approvalChoiceRows: approvalAnswers.length,
    approvalFeedback: ui.approvalFeedback !== undefined,
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

  // --- session browser ---------------------------------------------------
  const browserRows = ui.browser === undefined
    ? []
    : browserMatches(state.sessions, ui.browser.query)
  const browserFocus = ui.browser === undefined ? 0 : browserFocusIndex(browserRows, ui.browser)

  // --- overlays ----------------------------------------------------------
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

  // --- transcript window -------------------------------------------------
  const visibleLines = viewportLines(liveLines, ui.viewport, layout.viewportRows)
  const visibleEnd = Math.max(0, liveLines.length - ui.viewport.offsetFromBottom)
  const currentTool = currentToolEntryId(state.entries, liveLines, visibleEnd)

  // --- keyboard ownership ------------------------------------------------
  const surface: UiSurface = state.approval !== undefined
    ? ui.approvalFeedback === undefined ? 'approval' : 'approval-feedback'
    : activeQuestion !== undefined && activeQuestionForm !== undefined
      && questionPrompt !== undefined
      ? 'question'
      : browserOpen
        ? 'browser'
        : helpVisible
          ? 'help'
          : paletteOpen
            ? 'palette'
            : ui.focus === 'transcript' ? 'transcript' : 'composer'

  // --- status row --------------------------------------------------------
  // The status row must never wrap: a second row would break the layout budget.
  // Fields are fitted right to left, so the activity segments absorb the slack.
  const hint = !state.interactive
    ? 'one-shot session'
    : ui.focus === 'transcript' ? 'j/k scroll · Tab back to input' : status.hint
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

  return {
    surface,
    modalFree,
    browserOpen,
    helpVisible,
    paletteOpen,
    composerVisible,
    ...(questionPrompt === undefined ? {} : { questionPrompt }),
    ...(activeQuestionForm === undefined ? {} : { activeQuestionForm }),
    ...(activeQuestion === undefined ? {} : { activeQuestion }),
    ...(visibleQuestion === undefined ? {} : { visibleQuestion }),
    customVisible,
    optionStart,
    queuedPrompts,
    approvalPreview,
    approvalOptions: approvalAnswers,
    approvalChoice,
    ...(ui.approvalFeedback === undefined ? {} : { approvalFeedback: ui.approvalFeedback }),
    ...(completionToken === undefined ? {} : { completionToken }),
    ...(mentionToken === undefined ? {} : { mentionNeedle: mentionToken.needle }),
    completionMatches,
    completionOpen,
    completionExact,
    completionIndex,
    ...(completionView === undefined ? {} : { completionView }),
    ...(completionHint === undefined ? {} : { completionHint }),
    paletteMatches,
    paletteIndex,
    ...(overlay === undefined ? {} : { overlay }),
    browserRows,
    browserFocus,
    draftRows,
    draftStart,
    caret,
    visibleLines,
    ...(currentTool === undefined ? {} : { currentTool }),
    running,
    layout,
    glyphs,
    status,
    ...(workingLine === undefined ? {} : { workingLine }),
    todoPanel,
    ...(notice === undefined ? {} : { notice }),
    noticeTone,
    noticesQueued,
    statusLeft,
    statusHint,
    statusRight,
    ...(contextBar === undefined ? {} : { contextBar }),
  }
}

/**
 * The session browser's own list view. Built separately from
 * {@link buildViewModel} because it needs the split-column width, which only
 * the screen that draws it knows.
 */
export function buildBrowserView(
  sessions: readonly TuiSessionSummary[],
  focus: number,
  query: string,
  listColumns: number,
  rowBudget: number,
  now: number,
  /** The hint sits on the header row, which spans the terminal, not the list. */
  hintColumns: number = listColumns,
): OverlayView {
  return buildOverlay(
    sessions.map(session => ({
      id: session.id,
      text: formatSessionRow(session, Math.max(1, listColumns - 2), now),
      lines: 1,
    })),
    focus,
    {
      title: 'Sessions',
      hint: fitHint(
        ['type to filter · ↑↓ move · Enter resume · Esc close', '↑↓ · Enter · Esc', 'Esc'],
        Math.max(0, hintColumns - 12),
      ),
      columns: listColumns,
      rowBudget,
      emptyText: browserEmptyText(query),
    },
  )
}

/** Context the key resolver needs, derived from the same model the view paints. */
export function keyContextOf(
  state: TuiSnapshot,
  ui: UiState,
  vm: ViewModel,
): {
  interactive: boolean
  cancelArmed: boolean
  questionHasOptions: boolean
  approvalOptionCount: number
  draftEmpty: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  completionOpen: boolean
  completionExact: boolean
} {
  const line = caretLine(ui.composer)
  return {
    interactive: state.interactive,
    cancelArmed: ui.confirm === 'cancel',
    questionHasOptions: (vm.activeQuestion?.options?.length ?? 0) > 0,
    approvalOptionCount: vm.approvalOptions.length,
    draftEmpty: ui.composer.draft === '',
    canMoveUp: line.index > 0,
    canMoveDown: line.index < line.count - 1,
    completionOpen: vm.completionOpen,
    completionExact: vm.completionExact,
  }
}
