/**
 * Semantic palette.
 *
 * A tone names a *meaning*; this module is the only place that decides what it
 * looks like, and it degrades with the terminal rather than assuming truecolor.
 * Under `NO_COLOR`, `TERM=dumb` or a non-interactive stream every tone resolves
 * to `undefined`, which is what keeps the no-colour smoke test honest: the
 * renderer emits no SGR sequence at all rather than a "colourless" one.
 */

import type { ColorLevel } from './terminal-capabilities.ts'
import type { RowTone } from './styling.ts'

/** Ink accepts a colour name, a `#rrggbb` string, or `undefined` for none. */
export type ThemeColor = string | undefined

export interface Theme {
  /** False when the terminal gets no SGR colour at all. */
  readonly enabled: boolean
  readonly color: (tone: RowTone) => ThemeColor
  /** Fill behind a row. `undefined` for every tone but the user's message. */
  readonly background: (tone: RowTone) => ThemeColor
  /** Rows that should be dimmed regardless of their colour. */
  readonly dim: (tone: RowTone) => boolean
}

type Palette = Readonly<Record<RowTone, ThemeColor>>

/** Basic ANSI names: the only thing a 16-colour terminal can be trusted with. */
const BASIC: Palette = Object.freeze({
  user: 'green',
  assistant: undefined,
  reasoning: undefined,
  system: undefined,
  tool: 'cyan',
  error: 'red',
  'diff-add': 'green',
  'diff-remove': 'red',
  'diff-hunk': 'cyan',
  code: 'yellow',
  heading: 'cyan',
  quote: undefined,
  bullet: 'cyan',
  badge: 'magenta',
  warning: 'yellow',
  'tool-terminal': 'yellow',
  'tool-diff': 'green',
  'tool-search': 'magenta',
  'tool-read': 'cyan',
  'tool-web': 'blue',
  'mode-restricted': 'cyan',
  'mode-danger': 'red',
})

/**
 * True colour. The greens and reds are muted relative to the ANSI defaults so a
 * large diff does not vibrate, and `assistant` stays unset so ordinary prose
 * inherits the user's own foreground.
 */
const TRUECOLOR: Palette = Object.freeze({
  user: '#7da1de',
  assistant: undefined,
  reasoning: '#8d95a6',
  system: '#8d95a6',
  tool: '#6cb6c9',
  error: '#e06c75',
  'diff-add': '#7fb37f',
  'diff-remove': '#cf7f7f',
  'diff-hunk': '#8d95a6',
  code: '#d8b070',
  heading: '#7da1de',
  quote: '#8d95a6',
  bullet: '#6cb6c9',
  badge: '#b48ead',
  warning: '#d8b070',
  'tool-terminal': '#d8b070',
  'tool-diff': '#7fb37f',
  'tool-search': '#b48ead',
  'tool-read': '#6cb6c9',
  'tool-web': '#7da1de',
  'mode-restricted': '#6cb6c9',
  'mode-danger': '#e06c75',
})

/**
 * Backgrounds, which almost nothing has.
 *
 * A filled row is the loudest thing a terminal can do, so exactly one tone gets
 * one: the user's own message, which needs to be findable while scrolling past
 * screens of tool output. It is a near-foreground slate — enough to bound the
 * text, not enough to fight it — and below truecolor there is no such shade to
 * be had, so a 16-colour terminal gets none rather than a solid blue slab.
 */
const BACKGROUND: Partial<Record<RowTone, ThemeColor>> = Object.freeze({
  user: '#232a36',
})

/** Tones that read as secondary content whatever the palette. */
const DIM_TONES: ReadonlySet<RowTone> = new Set<RowTone>(['reasoning', 'system', 'quote', 'diff-hunk'])

const NONE: Theme = Object.freeze({
  enabled: false,
  color: () => undefined,
  background: () => undefined,
  // Without colour, dimming is the only remaining way to rank a row — but a
  // terminal that refused colour outright is told to render nothing special.
  dim: (tone: RowTone) => DIM_TONES.has(tone),
})

/**
 * Resolve the palette for a terminal.
 *
 * @param colorLevel - as detected by {@link detectTerminal}.
 * @param enabled - the `--no-color` flag, which overrides detection.
 */
export function resolveTheme(colorLevel: ColorLevel, enabled = true): Theme {
  if (!enabled || colorLevel === 'none') return NONE
  // 256-colour terminals take the basic names: an approximated hex would be
  // quantized by the terminal anyway, and the names respect the user's scheme.
  const palette = colorLevel === 'truecolor' ? TRUECOLOR : BASIC
  return Object.freeze({
    enabled: true,
    color: (tone: RowTone) => palette[tone],
    background: (tone: RowTone) => colorLevel === 'truecolor' ? BACKGROUND[tone] : undefined,
    dim: (tone: RowTone) => DIM_TONES.has(tone),
  })
}
