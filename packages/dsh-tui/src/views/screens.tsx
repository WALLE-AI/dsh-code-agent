/**
 * Screens: the two surfaces that replace the conversation rather than floating
 * over it.
 *
 * Rendering them as an early return — after every hook — is what makes that
 * literal. There is no transcript underneath to repaint, scroll, or bleed
 * through.
 */

import React from 'react'
import { Box, Text } from 'ink'
import { keyBindingDocs } from '../keymap.ts'
import { DEFAULT_KEYMAP, type Keymap } from '../keybindings.ts'
import { buildOverlay, fitHint, helpRows } from '../overlay.ts'
import { truncateToWidth } from '../terminal-text.ts'
import type { Theme } from '../theme.ts'
import { themed } from '../ui/theme-props.ts'
import { OverlayList, OverlayRows } from '../ui/list.tsx'
import { buildBrowserView, SPLIT_MIN_COLUMNS, type ViewModel } from '../view-model.ts'
import type { BrowserState } from '../session-browser.ts'

export function HelpScreen({ theme, rows, columns, keys = DEFAULT_KEYMAP }: {
  theme: Theme
  rows: number
  columns: number
  keys?: Keymap
}): React.ReactElement {
  // Built from the effective bindings, so a rebound key shows its new chord
  // here without anything else having to be told about it.
  const sheet = buildOverlay(helpRows(keyBindingDocs(keys)), 0, {
    marker: ' ',
    title: 'Shortcuts',
    hint: fitHint(['any key to close', 'Esc'], Math.max(0, columns - 12)),
    columns,
    // One row for the title, one for each scroll hint, one of headroom.
    rowBudget: Math.max(1, rows - 4),
  })
  return <Box flexDirection="column">
    <OverlayList view={sheet} theme={theme} />
  </Box>
}

export function SessionBrowserScreen({ vm, browser, theme, rows, columns, now }: {
  vm: ViewModel
  browser: BrowserState
  theme: Theme
  rows: number
  columns: number
  now: number
}): React.ReactElement {
  const budget = Math.max(1, rows - 4)
  const split = columns >= SPLIT_MIN_COLUMNS
  const listColumns = split ? Math.floor(columns * 0.55) : columns
  const view = buildBrowserView(
    vm.browserRows, vm.browserFocus, browser.query, listColumns, budget, now, columns,
  )
  const focused = vm.browserRows[vm.browserFocus]
  return <Box flexDirection="column">
    <Box justifyContent="space-between">
      <Text {...themed(theme, 'heading')} bold>
        {truncateToWidth(`Sessions  ${browser.query}`, Math.max(1, columns - 12))}
      </Text>
      <Text dimColor>{browser.resuming ? 'resuming…' : view.hint}</Text>
    </Box>
    <Box>
      <Box flexDirection="column" width={listColumns}>
        <OverlayRows view={view} theme={theme} />
      </Box>
      {!split || focused === undefined ? null : <Box flexDirection="column" marginLeft={2}>
        <Text dimColor>{truncateToWidth(focused.id, columns - listColumns - 2)}</Text>
        <Text dimColor>{truncateToWidth(focused.cwd ?? '', columns - listColumns - 2)}</Text>
        <Text dimColor>{focused.live ? 'live' : 'persisted'}</Text>
      </Box>}
    </Box>
  </Box>
}
