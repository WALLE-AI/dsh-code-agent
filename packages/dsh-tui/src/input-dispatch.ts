/**
 * Acting on a resolved {@link UiAction}.
 *
 * `keymap.ts` decides *what* a press means; this decides *what happens*. The
 * split matters because the second half is the part that touches the store, the
 * Harness and ten pieces of frame state — keeping it out of `app.tsx`'s render
 * body is what stopped that file from growing a case per feature.
 *
 * The dispatcher is a plain function over a {@link DispatchContext}: every
 * setter it may call is named there, so what a surface can and cannot do is
 * readable without following a render tree.
 */

import {
  clearComposer, deleteComposer, historyComposer, insertComposer, moveComposer,
  newlineComposer, submitComposer, type ComposerState,
} from './composer.ts'
import type { TuiActions, TuiSnapshot } from './contracts.ts'
import type { UiAction } from './keymap.ts'
import {
  advanceQuestionForm, appendQuestionCustom, backspaceQuestionCustom,
  chooseQuestionOption, moveQuestionOption, questionAnswered,
  type QuestionFormState,
} from './question-form.ts'
import {
  backspaceBrowser, escapeBrowser, moveBrowser, typeBrowser, emptyBrowser,
  type BrowserState,
} from './session-browser.ts'
import {
  acceptModelPicker, backspaceModelPicker, modelPickerRows, moveModelPicker, typeModelPicker,
  type ModelPickerState,
} from './model-picker.ts'
import { scrollViewport, type ViewportState } from './viewport.ts'
import { shortcutApprovalChoice } from './approval-options.ts'
import { acceptCompletion, type ViewModel } from './view-model.ts'

export interface DispatchSetters {
  setComposer: (update: (current: ComposerState) => ComposerState) => void
  setViewport: (update: (current: ViewportState) => ViewportState) => void
  setQuestionForm: (next: QuestionFormState | undefined) => void
  setConfirm: (next: 'cancel' | undefined) => void
  setPalette: (update: (current: PaletteState | undefined) => PaletteState | undefined) => void
  setFocus: (update: (current: 'composer' | 'transcript') => 'composer' | 'transcript') => void
  setCompletion: (index: number) => void
  /** `undefined` restores the computed default, which fails closed. */
  setApprovalChoice: (index: number | undefined) => void
  /** `undefined` closes the rejection-reason field. */
  setApprovalFeedback: (next: string | undefined) => void
  setHelpOpen: (open: boolean) => void
  setBrowser: (update: (current: BrowserState | undefined) => BrowserState | undefined) => void
  setModelPicker: (update: (current: ModelPickerState | undefined) => ModelPickerState | undefined) => void
  setDismissed: (start: number | undefined) => void
}

export interface PaletteState {
  readonly query: string
  readonly index: number
}

export interface DispatchContext extends DispatchSetters {
  readonly state: TuiSnapshot
  readonly actions: TuiActions
  readonly vm: ViewModel
  readonly browser: BrowserState | undefined
  readonly modelPicker: ModelPickerState | undefined
  /** Read back for the "already at the oldest row?" test before paging. */
  readonly viewport: ViewportState
}

/**
 * True for the actions that must not disarm a pending cancel confirmation.
 * Moving focus or opening a list is not "some other key was pressed".
 */
export function keepsCancelArmed(action: UiAction, surface: string): boolean {
  return action.kind === 'open-palette' || action.kind === 'open-picker'
    || action.kind === 'toggle-focus'
    || (surface === 'transcript'
      && (action.kind === 'focus-composer' || (action.kind === 'scroll' && !action.page)))
}

/** Scroll the transcript, paging retained history in when it runs out. */
function scrollBy(context: DispatchContext, direction: -1 | 1, amount: number): void {
  const { state, actions, vm } = context
  if (direction === -1) {
    // At the oldest rendered row, page more retained history into the window.
    const atTop = context.viewport.offsetFromBottom
      >= Math.max(0, state.lines.length - vm.layout.viewportRows)
    if (atTop && state.hasMoreHistory) actions.expandTranscript()
  }
  context.setViewport(current => scrollViewport(current, direction, amount, vm.layout.viewportRows))
}

/** Hand the outcome to the Harness and put the panel back to its default. */
function settleApproval(context: DispatchContext, allowed: boolean): void {
  context.setApprovalFeedback(undefined)
  context.setApprovalChoice(undefined)
  context.actions.decideApproval(allowed)
}

/**
 * Act on one answer.
 *
 * A row that asks for a reason opens the field instead of deciding — the prompt
 * stays open until the user has either typed one or backed out. A row that
 * promises a preset change decides first and submits the command after, so the
 * call that was asked about is granted under the rules that were in force when
 * it was asked.
 */
function answerApproval(context: DispatchContext, index: number): void {
  const option = context.vm.approvalOptions[index]
  if (option === undefined) return
  if (option.acceptsFeedback === true) {
    context.setApprovalChoice(index)
    return context.setApprovalFeedback(context.vm.approvalFeedback ?? '')
  }
  settleApproval(context, option.allowed)
  if (option.thenCommand !== undefined) context.actions.submit(option.thenCommand)
}

export function dispatchAction(action: UiAction, context: DispatchContext): void {
  const { state, actions, vm } = context

  const finishQuestion = (next: QuestionFormState): void => {
    if (vm.questionPrompt === undefined) return
    const advanced = advanceQuestionForm(next, vm.questionPrompt)
    if (advanced.answer !== undefined) {
      actions.answerQuestion(advanced.answer)
      context.setQuestionForm(undefined)
    } else context.setQuestionForm(advanced.state)
  }

  switch (action.kind) {
    case 'cancel-arm': return context.setConfirm('cancel')
    case 'cancel': {
      context.setConfirm(undefined)
      return actions.cancel()
    }
    case 'approval-shortcut':
      return answerApproval(context, shortcutApprovalChoice(vm.approvalOptions, action.allowed))
    case 'approval-select': return answerApproval(context, action.index)
    case 'approval-move': return context.setApprovalChoice(Math.max(
      0, Math.min(vm.approvalOptions.length - 1, vm.approvalChoice + action.delta),
    ))
    case 'approval-confirm': return answerApproval(context, vm.approvalChoice)
    case 'approval-feedback-type':
      return context.setApprovalFeedback((vm.approvalFeedback ?? '') + action.text)
    case 'approval-feedback-backspace': return context.setApprovalFeedback(
      Array.from(vm.approvalFeedback ?? '').slice(0, -1).join(''),
    )
    case 'approval-feedback-cancel': {
      // Back to the answers, having decided nothing: the prompt is still open.
      return context.setApprovalFeedback(undefined)
    }
    case 'approval-feedback-submit': {
      const reason = (vm.approvalFeedback ?? '').trim()
      settleApproval(context, false)
      // The reason follows the decision so it lands as the user's next word on
      // a call that has already been refused, not as a race against it. An
      // empty field is just a rejection, which is what the row promised.
      if (reason !== '') actions.submit(reason)
      return
    }
    case 'question-move': {
      if (vm.activeQuestionForm === undefined || vm.activeQuestion === undefined) return
      return context.setQuestionForm(
        moveQuestionOption(vm.activeQuestionForm, vm.activeQuestion, action.delta),
      )
    }
    case 'question-backspace': {
      if (vm.activeQuestionForm === undefined || vm.activeQuestion === undefined) return
      return context.setQuestionForm(
        backspaceQuestionCustom(vm.activeQuestionForm, vm.activeQuestion),
      )
    }
    case 'question-choose': {
      if (vm.activeQuestionForm === undefined || vm.activeQuestion === undefined) return
      // A digit with no matching option is ordinary text for the "Other" field.
      if (vm.activeQuestion.options?.[action.index] === undefined) {
        return context.setQuestionForm(appendQuestionCustom(
          vm.activeQuestionForm, vm.activeQuestion, String(action.index + 1),
        ))
      }
      const next = chooseQuestionOption(vm.activeQuestionForm, vm.activeQuestion, action.index)
      if (vm.activeQuestion.multiSelect === true) context.setQuestionForm(next)
      else finishQuestion(next)
      return
    }
    case 'question-toggle': {
      if (vm.activeQuestionForm === undefined || vm.activeQuestion === undefined) return
      return context.setQuestionForm(chooseQuestionOption(vm.activeQuestionForm, vm.activeQuestion))
    }
    case 'question-submit': {
      if (vm.activeQuestionForm === undefined || vm.activeQuestion === undefined) return
      const hasOptions = (vm.activeQuestion.options?.length ?? 0) > 0
      if (hasOptions && !questionAnswered(vm.activeQuestionForm, vm.activeQuestion)) {
        const chosen = chooseQuestionOption(vm.activeQuestionForm, vm.activeQuestion)
        if (vm.activeQuestion.multiSelect === true) return context.setQuestionForm(chosen)
        return finishQuestion(chosen)
      }
      return finishQuestion(vm.activeQuestionForm)
    }
    case 'question-type': {
      if (vm.activeQuestionForm === undefined || vm.activeQuestion === undefined) return
      return context.setQuestionForm(
        appendQuestionCustom(vm.activeQuestionForm, vm.activeQuestion, action.text),
      )
    }
    case 'palette-close': return context.setPalette(() => undefined)
    case 'palette-move': return context.setPalette(current => current === undefined
      ? current
      : {
        ...current,
        index: action.delta === -1
          ? Math.max(0, vm.paletteIndex - 1)
          : Math.min(vm.paletteMatches.length - 1, vm.paletteIndex + 1),
      })
    case 'palette-backspace': return context.setPalette(current => current === undefined
      ? current
      : { ...current, query: Array.from(current.query).slice(0, -1).join('') })
    case 'palette-accept': {
      const chosen = vm.paletteMatches[vm.paletteIndex]
      context.setPalette(() => undefined)
      // The draft is prefilled so a command with arguments stays reviewable.
      if (chosen !== undefined) {
        context.setComposer(current => insertComposer(
          { ...current, draft: '' },
          `/${chosen.name}${chosen.input === undefined ? '' : ' '}`,
        ))
      }
      return
    }
    case 'palette-type': return context.setPalette(current => current === undefined
      ? current
      : { query: current.query + action.text, index: 0 })
    case 'open-help': return context.setHelpOpen(true)
    case 'close-help': return context.setHelpOpen(false)
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
    case 'open-palette': return context.setPalette(() => ({ query: '', index: 0 }))
    case 'open-picker': {
      actions.listSessions()
      return context.setBrowser(() => emptyBrowser)
    }
    case 'browser-move': return context.setBrowser(current => current === undefined
      ? current
      : moveBrowser(current, vm.browserRows, action.delta))
    case 'browser-page': return context.setBrowser(current => current === undefined
      ? current
      // Paging is repeated single steps so it always lands on a real row.
      : moveBrowser(current, vm.browserRows, action.delta * Math.max(1, vm.layout.viewportRows - 2)))
    case 'browser-type': return context.setBrowser(current => current === undefined
      ? current
      : typeBrowser(current, action.text))
    case 'browser-backspace': return context.setBrowser(current => current === undefined
      ? current
      : backspaceBrowser(current))
    case 'browser-accept': {
      const chosen = vm.browserRows[vm.browserFocus]
      if (chosen === undefined) return
      // The screen stays open until the resume actually lands, so a failure is
      // visible where it happened rather than behind a closed screen.
      context.setBrowser(current => current === undefined ? current : { ...current, resuming: true })
      return actions.resumeSession(chosen.id)
    }
    case 'browser-escape': {
      if (context.browser === undefined) return
      const next = escapeBrowser(context.browser)
      return context.setBrowser(() => next.close ? undefined : next.state)
    }
    case 'model-move': return context.setModelPicker(current => current === undefined
      ? current
      : moveModelPicker(current, modelPickerRows(state.modelDirectory, current), action.delta))
    case 'model-page': return context.setModelPicker(current => current === undefined
      ? current
      : moveModelPicker(current, modelPickerRows(state.modelDirectory, current),
        action.delta * Math.max(1, vm.layout.viewportRows - 2)))
    case 'model-type': return context.setModelPicker(current => current === undefined
      ? current : typeModelPicker(current, action.text))
    case 'model-backspace': return context.setModelPicker(current => current === undefined
      ? current : backspaceModelPicker(current))
    case 'model-accept': {
      if (context.modelPicker === undefined) return
      const accepted = acceptModelPicker(state.modelDirectory, context.modelPicker)
      context.setModelPicker(() => accepted.state)
      if (accepted.selection !== undefined) actions.selectModel(accepted.selection)
      return
    }
    case 'model-escape': {
      if (context.modelPicker?.effortFor !== undefined) {
        return context.setModelPicker(() => ({ query: '', resuming: false }))
      }
      actions.closeModelPicker()
      return context.setModelPicker(() => undefined)
    }
    // Only two panes exist: the transcript and the composer.
    case 'toggle-focus':
      return context.setFocus(current => current === 'composer' ? 'transcript' : 'composer')
    case 'focus-composer': return context.setFocus(() => 'composer')
    case 'scroll':
      return scrollBy(context, action.direction, action.page ? vm.layout.viewportRows : 1)
    case 'toggle-fold': {
      if (vm.currentTool !== undefined) actions.toggleFold(vm.currentTool)
      return
    }
    case 'open-editor': {
      const entry = state.entries.find(item => item.id === vm.currentTool)
      const location = entry?.locations[0]
      if (location !== undefined) actions.openLocation(location)
      return
    }
    case 'completion-accept': {
      const item = vm.completionMatches[vm.completionIndex]
      if (item === undefined || vm.completionToken === undefined) return
      const token = vm.completionToken
      context.setCompletion(0)
      return context.setComposer(current => acceptCompletion(current, token, item))
    }
    case 'completion-move': return context.setCompletion(action.delta === -1
      ? Math.max(0, vm.completionIndex - 1)
      : Math.min(vm.completionMatches.length - 1, vm.completionIndex + 1))
    case 'completion-dismiss': return context.setDismissed(vm.completionToken?.start)
    case 'history': return context.setComposer(current => historyComposer(current, action.delta))
    case 'composer-move':
      return context.setComposer(current => moveComposer(current, action.motion))
    case 'composer-delete':
      return context.setComposer(current => deleteComposer(current, action.deletion))
    case 'composer-clear': return context.setComposer(clearComposer)
    case 'composer-newline': return context.setComposer(newlineComposer)
    case 'submit': {
      context.setComposer(current => {
        const submitted = submitComposer(current)
        if (submitted.text !== undefined) actions.submit(submitted.text)
        return submitted.state
      })
      return
    }
    case 'composer-insert':
      return context.setComposer(current => insertComposer(current, action.text))
  }
}
