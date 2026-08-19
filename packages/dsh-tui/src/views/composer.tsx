/**
 * The composer: the wrapped draft window with the caret drawn as an inverse
 * cell, and the completion list that hangs off it.
 */

import React from 'react'
import { Box, Text } from 'ink'
import { promptTone } from '../composer.ts'
import type { Theme } from '../theme.ts'
import { themed } from '../ui/theme-props.ts'
import { OverlayRows } from '../ui/list.tsx'
import type { ViewModel } from '../view-model.ts'

export function ComposerView({ vm, theme, permissionMode }: {
  vm: ViewModel
  theme: Theme
  permissionMode: string | undefined
}): React.ReactElement | null {
  if (!vm.composerVisible) return null
  const window = vm.draftRows.slice(vm.draftStart, vm.draftStart + vm.layout.composerRows)
  return <Box flexDirection="column" marginTop={1}>
    {window.map((row, index) => {
      const rowIndex = vm.draftStart + index
      // A continued row says so on the first visible line only; the rest just
      // align under the prompt marker.
      const prefix = rowIndex > 0 ? (index === 0 ? '… ' : '  ') : '> '
      const cells = Array.from(row)
      return <Box key={String(rowIndex)}>
        <Text {...themed(theme, promptTone(permissionMode))}>{prefix}</Text>
        {rowIndex !== vm.caret.row
          ? <Text>{row}</Text>
          : <>
            <Text>{cells.slice(0, vm.caret.column).join('')}</Text>
            <Text inverse>{cells[vm.caret.column] ?? ' '}</Text>
            <Text>{cells.slice(vm.caret.column + 1).join('')}</Text>
          </>}
      </Box>
    })}
  </Box>
}

export function CompletionList({ vm, theme }: {
  vm: ViewModel
  theme: Theme
}): React.ReactElement | null {
  if (vm.completionView === undefined) return null
  // The scroll hints are folded into one line below the list instead of the
  // two the overlay model would spend on them, so the completion never claims
  // more rows than the layout gave it.
  const rows = {
    title: vm.completionView.title,
    hint: vm.completionView.hint,
    rows: vm.completionView.rows,
  }
  return <Box flexDirection="column">
    <OverlayRows view={rows} theme={theme} />
    {vm.completionHint === undefined ? null : <Text dimColor>{vm.completionHint}</Text>}
  </Box>
}
