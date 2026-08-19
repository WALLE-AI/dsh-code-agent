/**
 * The approval panel.
 *
 * It shows the call itself rather than a summary of it, because a command or a
 * diff is what the answer actually turns on, and it fails closed: the default
 * highlight is reject.
 */

import React from 'react'
import { Box, Text } from 'ink'
import { sanitizeLine, truncateToWidth } from '../terminal-text.ts'
import type { Theme } from '../theme.ts'
import { themed } from '../ui/theme-props.ts'
import type { ViewModel } from '../view-model.ts'
import type { TuiSnapshot } from '../contracts.ts'

export function ApprovalPanel({ state, vm, theme, columns }: {
  state: TuiSnapshot
  vm: ViewModel
  theme: Theme
  columns: number
}): React.ReactElement | null {
  if (state.approval === undefined) return null
  const preset = state.activity.permission === undefined
    ? ''
    : ` (${state.activity.permission.current})`
  return <Box flexDirection="column" marginTop={vm.layout.showApprovalMargin ? 1 : 0}>
    <Box justifyContent="space-between">
      <Text {...themed(theme, 'badge')} bold>{truncateToWidth(
        `Approve ${state.approval.toolName}?${preset}`,
        columns,
      )}</Text>
      {!vm.queuedPrompts ? null : <Text dimColor>1 more prompt queued</Text>}
    </Box>
    {vm.approvalPreview.slice(0, vm.layout.approvalPreviewRows).map((line, index) =>
      <Text key={String(index)} dimColor>
        {truncateToWidth(sanitizeLine(line), columns)}
      </Text>)}
    {vm.approvalOptions.map((option, index) => <Text
      key={option.id}
      {...index === vm.approvalChoice ? themed(theme, 'heading') : {}}
    >{truncateToWidth(
      `${index === vm.approvalChoice ? '>' : ' '} ${String(index + 1)} ${option.label}`,
      columns,
    )}</Text>)}
    {vm.approvalFeedback === undefined ? null
      // The field is the row the answer promised; the block caret makes it read
      // as somewhere to type rather than as another label.
      : <Text><Text dimColor>reason: </Text>{truncateToWidth(
        vm.approvalFeedback, Math.max(1, columns - 9),
      )}<Text inverse> </Text></Text>}
  </Box>
}
