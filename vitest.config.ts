import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const harnessRoot = fileURLToPath(
  new URL('./opensource/deepseek-harness/deepseek-harness-master', import.meta.url),
)

/**
 * Resolve the vendored Harness's own packages to their TypeScript sources.
 *
 * The fixture-parity spec replays real session logs through the Harness's
 * `llm-replay` helper, which imports its workspace siblings by package name.
 * Those manifests point at `lib/`, which only exists after a full Harness
 * build — so in a fresh checkout the spec could not even be loaded, and the one
 * test file that proves our projection agrees with upstream was silently dead.
 *
 * Mapping the names to `src/` removes the build step entirely and is the
 * stricter reading of the claim: parity is asserted against the Harness source
 * we pin by digest, not against a build artefact of it. The map is derived from
 * the manifests rather than listed by hand, because the import graph is deep
 * and a hand-list would just fail one package at a time.
 *
 * Only names the Harness itself owns are mapped; our own package is never
 * shadowed even if upstream grows a module of the same name.
 */
function harnessSourceAliases(): Record<string, string> {
  const aliases: Record<string, string> = {}
  const manifests: string[] = []
  const collect = (directory: string, depth: number): void => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue
      const full = join(directory, entry.name)
      if (existsSync(join(full, 'package.json'))) manifests.push(join(full, 'package.json'))
      if (depth > 0) collect(full, depth - 1)
    }
  }
  collect(join(harnessRoot, 'packages'), 1)
  collect(join(harnessRoot, 'vendor'), 0)
  for (const manifest of manifests) {
    const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }
    if (name === undefined || name === '@deepseek-ai/dsh-tui') continue
    const source = join(dirname(manifest), 'src/index.ts')
    if (existsSync(source)) aliases[name] = source
  }
  return aliases
}

export default defineConfig({
  test: {
    include: ['packages/dsh-tui/tests/**/*.spec.ts', 'packages/dsh-tui/tests/**/*.spec.tsx'],
  },
  resolve: { alias: harnessSourceAliases() },
})
