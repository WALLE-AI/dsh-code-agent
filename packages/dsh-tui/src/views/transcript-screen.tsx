import React from 'react'
import { Box, Text } from 'ink'
import { truncateToWidth } from '../terminal-text.ts'
import type { Theme } from '../theme.ts'
import {
  transcriptMatches, visibleTranscriptLines, type TranscriptModeState,
} from '../transcript-mode.ts'
import type { TranscriptLine } from '../transcript-view.ts'
import { themed } from '../ui/theme-props.ts'

function HighlightedText({ text, query, theme }: { text: string; query: string; theme: Theme }) {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return <Text>{text}</Text>
  const lower = text.toLocaleLowerCase()
  const parts: React.ReactNode[] = []
  let at = 0
  for (;;) {
    const found = lower.indexOf(needle, at)
    if (found < 0) break
    if (found > at) parts.push(text.slice(at, found))
    parts.push(<Text key={String(found)} {...themed(theme, 'warning')} bold underline>
      {text.slice(found, found + needle.length)}
    </Text>)
    at = found + needle.length
  }
  if (at < text.length) parts.push(text.slice(at))
  return <Text>{parts}</Text>
}

export function TranscriptScreen({ state, lines, rows, columns, theme, alternate }: {
  state: TranscriptModeState
  lines: readonly TranscriptLine[]
  rows: number
  columns: number
  theme: Theme
  alternate: boolean
}): React.ReactElement {
  const capacity = Math.max(1, rows - 2)
  const visible = visibleTranscriptLines(state, lines, capacity)
  const matches = transcriptMatches(lines, state.query)
  const matchAt = matches.indexOf(state.cursor)
  const right = state.searchDraft !== undefined
    ? `/${state.searchDraft}`
    : state.notice ?? (matches.length === 0 ? 'Ctrl+T close' : `${String(matchAt + 1)}/${String(matches.length)}`)
  return <Box flexDirection="column" height={rows}>
    <Box justifyContent="space-between">
      <Text {...themed(theme, 'heading')} bold>Transcript</Text>
      <Text dimColor>{truncateToWidth(right, Math.max(1, Math.floor(columns / 2)))}</Text>
    </Box>
    <Box flexDirection="column" height={capacity}>
      {visible.map((line, index) => {
        const absolute = state.top + index
        const text = truncateToWidth(line.text, Math.max(1, columns - 2))
        return <Box key={`${String(absolute)}:${line.entryId}`}>
          <Text {...themed(theme, absolute === state.cursor ? 'heading' : line.tone)}>
            {absolute === state.cursor ? '> ' : '  '}
          </Text>
          <HighlightedText text={text} query={state.query} theme={theme} />
        </Box>
      })}
    </Box>
    <Text dimColor>{truncateToWidth(
      `${alternate ? 'alt-screen' : 'inline'} · / search · n/N matches · y/Y copy · r draft · q close`, columns,
    )}</Text>
  </Box>
}
