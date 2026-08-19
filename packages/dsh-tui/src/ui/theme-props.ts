/**
 * Tone-to-Ink-prop translation.
 *
 * Every view asks the theme the same question — "what props does this tone
 * mean here?" — so the answer lives once. Props with no value are omitted
 * entirely rather than passed as `undefined`: an explicit `undefined` is still
 * a prop, and the no-colour smoke asserts the renderer emits no SGR sequence
 * at all.
 */

import type { RowTone } from '../styling.ts'
import type { Theme } from '../theme.ts'

export interface ToneProps {
  color?: string
  backgroundColor?: string
}

export function themed(theme: Theme, tone: RowTone): ToneProps {
  const color = theme.color(tone)
  const background = theme.background(tone)
  return {
    ...color === undefined ? {} : { color },
    ...background === undefined ? {} : { backgroundColor: background },
  }
}
