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
import { Box, render, Static, Text, useInput } from 'ink'
import { paintInPlace } from './frame-writer.ts'
import { emptyComposer, type ComposerState } from './composer.ts'
import type { TuiActions, TuiView } from './contracts.ts'
import { useAnimationClock, useTerminalSize } from './hooks.tsx'
import { dispatchAction, keepsCancelArmed, type PaletteState } from './input-dispatch.ts'
import { fromInkKey, resolveKey } from './keymap.ts'
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
import type { BrowserState } from './session-browser.ts'
import { OverlayList } from './ui/list.tsx'
import { TranscriptRow } from './views/transcript.tsx'
import { ApprovalPanel } from './views/approval.tsx'
import { QuestionPanel } from './views/question.tsx'
import { ComposerView, CompletionList } from './views/composer.tsx'
import { StatusRegion, TodoPanel, WorkingLine } from './views/status.tsx'
import { HelpScreen, SessionBrowserScreen } from './views/screens.tsx'

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
  const vm = buildViewModel({ state, ui, rows, columns, liveLines, now, animate })

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
    const action = resolveKey(vm.surface, fromInkKey(input, key), keyContextOf(state, ui, vm))
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

  if (vm.helpVisible) return <HelpScreen theme={theme} rows={rows} columns={columns} />
  if (browser !== undefined && vm.browserOpen) {
    return <SessionBrowserScreen
      vm={vm} browser={browser} theme={theme} rows={rows} columns={columns} now={now}
    />
  }

  return <Box flexDirection="column">
    {!vm.layout.showHeader ? null : <Box justifyContent="space-between">
      <Text bold>DeepSeek Harness TUI</Text><Text>{state.status}</Text>
    </Box>}
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
