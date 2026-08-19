/**
 * The one list region.
 *
 * The palette, the session browser, the shortcut sheet and the completion list
 * were four hand-copied renderings of the same {@link OverlayView}: a title row
 * with a right-aligned hint, an `↑ n more` line, the rows themselves with the
 * focused one marked, and an `↓ n more` line. Copying it four times is how the
 * four drifted — only one of them highlighted the focused row, and only two
 * showed the scroll hints. One component, four call sites.
 */

import React from 'react'
import { Box, Text } from 'ink'
import type { OverlayView } from '../overlay.ts'
import type { Theme } from '../theme.ts'
import { themed } from './theme-props.ts'

export function OverlayRows({ view, theme }: {
  view: OverlayView
  theme: Theme
}): React.ReactElement {
  return <>
    {view.above === undefined ? null : <Text dimColor>{view.above}</Text>}
    {view.rows.map((row, index) => <Text
      key={String(index)}
      // `buildOverlay` marks the focused row with its marker; the marker is
      // what the highlight follows, so the two cannot disagree.
      {...row.startsWith('>') ? themed(theme, 'heading') : {}}
    >{row}</Text>)}
    {view.below === undefined ? null : <Text dimColor>{view.below}</Text>}
  </>
}

/** A titled list region: the header row plus {@link OverlayRows}. */
export function OverlayList({ view, theme, title, hint, marginTop = 0 }: {
  view: OverlayView
  theme: Theme
  /** Overrides `view.title`, for a screen whose header carries live state. */
  title?: string
  /** Overrides `view.hint`, for a screen with a transient status of its own. */
  hint?: string
  marginTop?: number
}): React.ReactElement {
  return <Box flexDirection="column" marginTop={marginTop}>
    <Box justifyContent="space-between">
      <Text {...themed(theme, 'heading')} bold>{title ?? view.title}</Text>
      <Text dimColor>{hint ?? view.hint}</Text>
    </Box>
    <OverlayRows view={view} theme={theme} />
  </Box>
}
