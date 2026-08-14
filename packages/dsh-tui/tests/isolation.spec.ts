import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('upstream isolation boundary', () => {
  it('keeps deepseek-harness source imports in one adapter', () => {
    const sourceRoot = join(import.meta.dirname, '../src')
    for (const file of ['app.tsx', 'approval-queue.ts', 'contracts.ts', 'plugin.ts', 'startup.ts', 'state.ts']) {
      expect(readFileSync(join(sourceRoot, file), 'utf8')).not.toContain('opensource/deepseek-harness')
    }
    expect(readFileSync(join(sourceRoot, 'harness-adapter.ts'), 'utf8')).toContain('opensource/deepseek-harness')
  })
})
