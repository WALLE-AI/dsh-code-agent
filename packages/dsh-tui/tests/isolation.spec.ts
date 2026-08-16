import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourceRoot = join(import.meta.dirname, '../src')
const ADAPTER = 'harness-adapter.ts'

function sourceFiles(): readonly string[] {
  return readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' })
    .filter(entry => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .map(entry => entry.replace(/\\/g, '/'))
}

describe('upstream isolation boundary', () => {
  it('confines every upstream reference to the adapter', () => {
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(10)
    expect(files).toContain(ADAPTER)
    for (const file of files) {
      if (file === ADAPTER) continue
      const source = readFileSync(join(sourceRoot, file), 'utf8')
      expect(source, `${file} must not reach into the Harness checkout`)
        .not.toContain('opensource/deepseek-harness')
      expect(source, `${file} must not import an upstream package`)
        .not.toMatch(/from '@deepseek-ai\//)
    }
  })

  it('keeps the adapter as the single upstream import point', () => {
    const adapter = readFileSync(join(sourceRoot, ADAPTER), 'utf8')
    expect(adapter).toContain('opensource/deepseek-harness')
    expect(adapter).toContain('@deepseek-ai/dsh-agent')
  })

  it('keeps React and Ink out of the runtime core', () => {
    for (const file of sourceFiles()) {
      if (file.endsWith('.tsx')) continue
      const source = readFileSync(join(sourceRoot, file), 'utf8')
      expect(source, `${file} must not import a renderer`).not.toMatch(/from '(react|ink)'/)
    }
  })
})
