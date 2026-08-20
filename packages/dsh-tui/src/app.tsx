/**
 * The composition root.
 *
 * Everything that decides is elsewhere: `keymap.ts` resolves a press,
 * `view-model.ts` derives the frame, `input-dispatch.ts` acts, and `views/`
 * paints. What is left here is the wiring that only React can express — the
 * frame's own state, the effects that keep it in step with the store, and the
 * order the regions are stacked in.
 */

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Box, render, Static, useInput } from 'ink'
import { paintInPlace } from './frame-writer.ts'
import { emptyComposer, insertComposer, type ComposerState } from './composer.ts'
import type { TuiActions, TuiScreenController, TuiView } from './contracts.ts'
import { useAnimationClock, useTerminalSize } from './hooks.tsx'
import { dispatchAction, keepsCancelArmed, type PaletteState } from './input-dispatch.ts'
import { emptyKeySequence, fromInkKey, resolveKeySequence } from './keymap.ts'
import { DEFAULT_KEYMAP, type Keymap } from './keybindings.ts'
import { readMouse, WHEEL_ROWS } from './mouse.ts'
import { RenderBoundary } from './render-boundary.tsx'
import { emptyScrollback, splitScrollback, type ScrollbackState } from './scrollback.ts'
import { createQuestionForm, type QuestionFormState } from './question-form.ts'
import { SPINNER_INTERVAL_MS } from './spinner.ts'

/**
 * How often an idle frame checks whether the showing notice has expired. One
 * second is finer than any timeout it has to resolve and coarse enough that a
 * session showing a notice is not a busy loop.
 */
const NOTICE_TICK_MS = 1_000
import type { TuiStore } from './state.ts'
import { resolveTheme, type Theme } from './theme.ts'
import type { TranscriptLine } from './transcript-view.ts'
import { emptyViewport, scrollViewport, syncViewport } from './viewport.ts'
import { buildViewModel, keyContextOf, type UiState } from './view-model.ts'
import { nextDisplayedTokenCount } from './working-line.ts'
import type { BrowserState } from './session-browser.ts'
import { OverlayList } from './ui/list.tsx'
import { TranscriptRow } from './views/transcript.tsx'
import { ApprovalPanel } from './views/approval.tsx'
import { QuestionPanel } from './views/question.tsx'
import { ComposerView, CompletionList } from './views/composer.tsx'
import { StatusRegion, TodoPanel, WorkingLine } from './views/status.tsx'
import { HelpScreen, SessionBrowserScreen } from './views/screens.tsx'
import { TranscriptScreen } from './views/transcript-screen.tsx'
import {
  commitTranscriptSearch, copyTranscriptText, jumpTranscriptMatch, moveTranscriptCursor,
  openTranscriptMode, type TranscriptModeState,
} from './transcript-mode.ts'

export function TuiApp({
  store, actions, stdout, theme, onRenderError, animate = true, clock = Date.now,
  keys = DEFAULT_KEYMAP, screen,
}: {
  store: TuiStore
  actions: TuiActions
  stdout: NodeJS.WriteStream
  theme: Theme
  /** The effective bindings, once a user's overrides have been merged in. */
  keys?: Keymap
  screen?: TuiScreenController
  /** Off for a terminal that cannot animate, and for deterministic tests. */
  animate?: boolean
  clock?: () => number
  onRenderError?: (region: string, message: string) => void
}): React.JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  const [composer, setComposer] = useState<ComposerState>(emptyComposer)
  const [viewport, setViewport] = useState(emptyViewport)
  const [questionForm, setQuestionForm] = useState<QuestionFormState>()
  const [confirm, setConfirm] = useState<'cancel' | undefined>()
  const [palette, setPalette] = useState<PaletteState>()
  const [focus, setFocus] = useState<'composer' | 'transcript'>('composer')
  const [completion, setCompletion] = useState(0)
  const [approvalChoice, setApprovalChoice] = useState<number>()
  const [approvalFeedback, setApprovalFeedback] = useState<string>()
  const [helpOpen, setHelpOpen] = useState(false)
  const [browser, setBrowser] = useState<BrowserState>()
  const [dismissed, setDismissed] = useState<number>()
  const [transcriptMode, setTranscriptMode] = useState<TranscriptModeState>()
  const [transcriptAlternate, setTranscriptAlternate] = useState(false)
  const transcriptEntered = useRef(false)
  const keySequence = useRef(emptyKeySequence)
  const displayedTokens = useRef<{ value: number; at: number } | undefined>(undefined)
  const { rows, columns } = useTerminalSize(stdout)

  // Rows that can no longer change leave for the terminal's own scrollback; the
  // frame keeps only what is still moving. The split has to survive re-renders,
  // so what has already been handed to the terminal lives in a ref rather than
  // in state: appending to it must not itself schedule a render.
  const scrollback = useRef<ScrollbackState>(emptyScrollback)
  const split = splitScrollback(state.lines, state.entries, scrollback.current)
  scrollback.current = split.next
  const liveLines = split.live

  const ui: UiState = {
    composer,
    viewport,
    ...(questionForm === undefined ? {} : { questionForm }),
    ...(confirm === undefined ? {} : { confirm }),
    ...(palette === undefined ? {} : { palette }),
    focus,
    completion,
    ...(approvalChoice === undefined ? {} : { approvalChoice }),
    ...(approvalFeedback === undefined ? {} : { approvalFeedback }),
    helpOpen,
    ...(browser === undefined ? {} : { browser }),
    ...(dismissed === undefined ? {} : { dismissed }),
  }
  // A single clock read keeps every row of one frame consistent with each other.
  const now = clock()
  const tokenTarget = state.activity.tokens?.output ?? 0
  const tokenClock = displayedTokens.current ?? { value: tokenTarget, at: now }
  tokenClock.value = nextDisplayedTokenCount(tokenClock.value, tokenTarget, now - tokenClock.at)
  tokenClock.at = now
  displayedTokens.current = tokenClock
  const vm = buildViewModel({
    state, ui, rows, columns, liveLines, now, animate, displayedTokens: tokenClock.value,
  })

  const questionPrompt = state.question
  useEffect(() => {
    if (questionPrompt === undefined) setQuestionForm(undefined)
    else if (questionForm?.promptId !== questionPrompt.id) {
      setQuestionForm(createQuestionForm(questionPrompt))
    }
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
  useEffect(() => { setCompletion(0) }, [vm.completionToken?.start, vm.completionToken?.needle])
  const mentionNeedle = vm.mentionNeedle
  useEffect(() => {
    if (mentionNeedle !== undefined) actions.listFiles(mentionNeedle)
  }, [mentionNeedle, actions])
  const viewportRows = vm.layout.viewportRows
  useEffect(() => {
    setViewport(current => syncViewport(
      current, liveLines.length, state.transcriptRevision, viewportRows,
    ))
  }, [liveLines.length, state.transcriptRevision, viewportRows])
  useAnimationClock(animate && vm.running, SPINNER_INTERVAL_MS)
  // Notices expire on wall-clock time, not on the run, so they need a tick of
  // their own — but only while there is something left to expire. A settled
  // frame with an empty queue holds no timer, which is the whole point of
  // keeping the scheduling out of `notifications.ts`.
  const noticesPending = state.notice !== undefined || state.noticesQueued > 0
  useEffect(() => {
    if (!noticesPending) return
    const timer = setInterval(() => { store.tickNotices() }, NOTICE_TICK_MS)
    return () => { clearInterval(timer) }
  }, [noticesPending, store])
  useEffect(() => () => {
    if (transcriptEntered.current) screen?.exit()
  }, [screen])

  useInput((input, key) => {
    // Wheel notches arrive as input, not as scrollback: the frame is repainted
    // in place, so the terminal's own buffer never holds a row of it. They drive
    // the same viewport PgUp/PgDn drives, which is what still holds the banner.
    const mouse = readMouse(input)
    if (mouse.consumed) {
      // A report on any other surface is swallowed, never typed into the draft.
      if (vm.surface === 'composer' || vm.surface === 'transcript') {
        for (const notch of mouse.notches) {
          setViewport(current => scrollViewport(current, notch.direction, WHEEL_ROWS, viewportRows))
        }
      }
      return
    }
    const active = transcriptMode === undefined ? vm.surfaces : ['transcript-screen'] as const
    const resolved = resolveKeySequence(
      keySequence.current,
      active,
      fromInkKey(input, key),
      {
        ...keyContextOf(state, ui, vm),
        transcriptSearch: transcriptMode?.searchDraft !== undefined,
      },
      keys,
    )
    keySequence.current = resolved.state
    if (resolved.pending) return
    const action = resolved.action
    if (action?.kind === 'transcript-open') {
      const alternate = screen?.enter() ?? false
      transcriptEntered.current = alternate
      setTranscriptAlternate(alternate)
      setTranscriptMode(openTranscriptMode(state.lines.length, Math.max(1, rows - 2)))
      return
    }
    if (transcriptMode !== undefined && action !== undefined) {
      const capacity = Math.max(1, rows - 2)
      switch (action.kind) {
        case 'transcript-close':
          if (transcriptEntered.current) screen?.exit()
          transcriptEntered.current = false
          setTranscriptMode(undefined)
          return
        case 'transcript-move':
          setTranscriptMode(moveTranscriptCursor(
            transcriptMode, action.delta, state.lines.length, capacity,
          ))
          return
        case 'transcript-search-open':
          setTranscriptMode({ ...transcriptMode, searchDraft: transcriptMode.query, notice: undefined })
          return
        case 'transcript-search-type':
          setTranscriptMode({
            ...transcriptMode,
            searchDraft: (transcriptMode.searchDraft ?? '') + action.text,
            notice: undefined,
          })
          return
        case 'transcript-search-backspace':
          setTranscriptMode({
            ...transcriptMode,
            searchDraft: Array.from(transcriptMode.searchDraft ?? '').slice(0, -1).join(''),
          })
          return
        case 'transcript-search-cancel':
          setTranscriptMode({ ...transcriptMode, searchDraft: undefined })
          return
        case 'transcript-search-commit':
          setTranscriptMode(commitTranscriptSearch(transcriptMode, state.lines, capacity))
          return
        case 'transcript-match':
          setTranscriptMode(jumpTranscriptMatch(
            transcriptMode, state.lines, action.direction, capacity,
          ))
          return
        case 'transcript-copy': {
          const text = copyTranscriptText(transcriptMode, state.lines, action.wholeEntry)
          const copied = text !== '' && (screen?.copy(text) ?? false)
          setTranscriptMode({ ...transcriptMode, notice: copied ? 'copied' : 'clipboard unavailable' })
          return
        }
        case 'transcript-restore-draft': {
          const line = state.lines[transcriptMode.cursor]
          if (line?.tone !== 'user') {
            setTranscriptMode({ ...transcriptMode, notice: 'select a user message' })
            return
          }
          const text = copyTranscriptText(transcriptMode, state.lines, true)
            .replace(/^>\s?/, '')
          setComposer(current => insertComposer({ ...current, draft: '', cursor: 0 }, text))
          if (transcriptEntered.current) screen?.exit()
          transcriptEntered.current = false
          setTranscriptMode(undefined)
          return
        }
        default: return
      }
    }
    if (action === undefined) {
      if ((vm.surface === 'composer' || vm.surface === 'transcript') && confirm !== undefined) {
        setConfirm(undefined)
      }
      return
    }
    // The early-return cascade must not disarm a pending confirmation: moving
    // focus or opening a list is not "some other key was pressed".
    if ((vm.surface === 'composer' || vm.surface === 'transcript')
      && confirm !== undefined && !keepsCancelArmed(action, vm.surface)) {
      setConfirm(undefined)
    }
    dispatchAction(action, {
      state,
      actions,
      vm,
      browser,
      viewport,
      setComposer,
      setViewport,
      setQuestionForm,
      setConfirm,
      setPalette,
      setFocus,
      setCompletion,
      setApprovalChoice,
      setApprovalFeedback,
      setHelpOpen,
      setBrowser,
      setDismissed,
    })
  })

  if (transcriptMode !== undefined) {
    return <TranscriptScreen
      state={transcriptMode}
      lines={state.lines}
      rows={rows}
      columns={columns}
      theme={theme}
      alternate={transcriptAlternate}
    />
  }
  if (vm.helpVisible) {
    return <HelpScreen theme={theme} rows={rows} columns={columns} keys={keys} />
  }
  if (browser !== undefined && vm.browserOpen) {
    return <SessionBrowserScreen
      vm={vm} browser={browser} theme={theme} rows={rows} columns={columns} now={now}
    />
  }

  return <Box flexDirection="column">
    {/*
      Settled rows, handed to the terminal once each. Ink writes `Static`
      children above the repainted frame and never touches them again, which is
      what puts them in the scrollback the wheel already scrolls.
    */}
    <Static items={scrollback.current.rows as TranscriptLine[]}>
      {(line, index) => <Box key={`${String(index)}:${line.entryId}`}>
        <TranscriptRow line={line} columns={columns} theme={theme} now={now} animate={false} />
      </Box>}
    </Static>
    {/*
      No fixed height: the frame is as tall as the rows still moving, so the
      scrollback above it stays on screen instead of being pushed off by blank
      padding. `viewportRows` is still the cap, applied to the rows themselves.
    */}
    <Box flexDirection="column" marginTop={1}>
      <RenderBoundary
        region="transcript"
        {...onRenderError === undefined ? {} : { onError: onRenderError }}
      >
        {vm.visibleLines.map((line, index) => <TranscriptRow
          key={`${String(index)}:${line.entryId}`}
          line={line} columns={columns} theme={theme} now={now} animate={animate}
        />)}
      </RenderBoundary>
    </Box>
    <ApprovalPanel state={state} vm={vm} theme={theme} columns={columns} />
    <QuestionPanel vm={vm} theme={theme} />
    {vm.overlay === undefined ? null
      : <OverlayList view={vm.overlay} theme={theme} marginTop={1} />}
    <WorkingLine vm={vm} theme={theme} />
    <TodoPanel vm={vm} theme={theme} />
    <ComposerView vm={vm} theme={theme} permissionMode={state.activity.permission?.current} />
    <CompletionList vm={vm} theme={theme} />
    <StatusRegion vm={vm} theme={theme} columns={columns} error={state.error} />
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
  keys: Keymap = DEFAULT_KEYMAP,
  screen?: TuiScreenController,
): TuiView {
  // Ink repaints by erasing every row it wrote last time; on a full-height
  // frame with a spinner running that is a whole-screen erase ten times a
  // second. The painter rewrites only the rows that differ.
  const painted = paintInPlace(stdout)
  const controlledScreen = screen === undefined ? undefined : {
    enter: () => {
      painted.invalidateFrame()
      const entered = screen.enter()
      painted.invalidateFrame()
      return entered
    },
    exit: () => {
      screen.exit()
      painted.invalidateFrame()
    },
    copy: (text: string) => screen.copy(text),
  }
  const instance = render(
    <TuiApp
      store={store}
      actions={actions}
      stdout={stdout}
      theme={theme}
      animate={animate}
      clock={clock}
      keys={keys}
      {...controlledScreen === undefined ? {} : { screen: controlledScreen }}
      {...onRenderError === undefined ? {} : { onRenderError }}
    />,
    // Ink would unmount on the first Ctrl+C; cancellation must go through the
    // TUI's own two-step confirmation and the bounded shutdown sequence.
    { stdin, stdout: painted, stderr, exitOnCtrlC: false },
  )
  return { unmount: () => { instance.unmount() } }
}
