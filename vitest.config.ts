import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/dsh-tui/tests/**/*.spec.ts'],
  },
})
