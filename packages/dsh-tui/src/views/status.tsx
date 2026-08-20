/**
 * The status region: everything between the composer and the bottom of the
 * frame that reports on the run rather than taking part in it.
 *
 * The order is the reading order and also the drop order the layout budget
 * applies — working line, goal panel, notice, error, context bar, status row.
 */

import React from 'react'
import { Box, Text } from 'ink'
import { sanitizeLine, truncateToWidth } from '../terminal-text.ts'
import type { Theme } from '../theme.ts'
import { themed } from '../ui/theme-props.ts'
import type { ViewModel } from '../view-model.ts'

export function WorkingLine({ vm, theme }: {
  vm: ViewModel
  theme: Theme
}): React.ReactElement | null {
  if (vm.workingLine === undefined) return null
  // A stall is not an error — the model is slow, not broken — so it takes the
  // warning tone rather than the red one an actual failure gets.
  return <Box flexDirection="column">
    <Text {...themed(theme, vm.workingLine.stalled ? 'warning' : 'tool')}>
      {vm.workingLine.text}
    </Text>
    {vm.layout.workingRows < 2 || vm.workingLine.subagentText === undefined
      ? null
      : <Text dimColor>{vm.workingLine.subagentText}</Text>}
  </Box>
}

export function TodoPanel({ vm, theme }: {
  vm: ViewModel
  theme: Theme
}): React.ReactElement | null {
  if (vm.todoPanel.length === 0) return null
  return <Box flexDirection="column">
    {vm.todoPanel.map((row, index) => <Text
      key={String(index)}
      {...row.active ? themed(theme, 'heading') : {}}
      {...row.active ? {} : { dimColor: true }}
    >{row.text}</Text>)}
  </Box>
}

export function StatusRegion({ vm, theme, columns, error }: {
  vm: ViewModel
  theme: Theme
  columns: number
  error: string | undefined
}): React.ReactElement {
  return <>
    {!vm.layout.showNotice || vm.notice === undefined ? null
      // The queue depth is on the same row: a notice that hides three others
      // must not read as the only thing that happened.
      : <Text {...themed(theme, vm.noticeTone)}>{truncateToWidth(
        vm.noticesQueued === 0
          ? sanitizeLine(vm.notice)
          : `${sanitizeLine(vm.notice)}  +${String(vm.noticesQueued)}`,
        columns,
      )}</Text>}
    {error === undefined ? null
      : <Text {...themed(theme, 'error')}>{truncateToWidth(sanitizeLine(error), columns)}</Text>}
    {vm.contextBar === undefined ? null : <Text dimColor>{vm.contextBar}</Text>}
    {!vm.layout.showStatus ? null : <Box justifyContent="space-between">
      <Text dimColor>{vm.statusLeft}</Text>
      <Text dimColor>{vm.statusHint}</Text>
      <Text dimColor>{vm.statusRight}</Text>
    </Box>}
  </>
}
