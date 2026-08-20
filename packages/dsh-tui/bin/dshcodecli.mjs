#!/usr/bin/env node
// Entry point for the `dshcodecli` command. Everything lives in ./launch.mjs so
// that the logic stays importable — and therefore testable — without running it.
import { main } from './launch.mjs'

process.exitCode = await main(process.argv.slice(2))
