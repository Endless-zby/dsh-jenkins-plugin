/**
 * Run every assertion test in `tests/` and report one summary line.
 *
 * The suite has no framework: each file is a plain Node script that prints
 * `n/m checks passed` and sets a non-zero exit code when a check failed. This
 * runner only discovers the files and aggregates their exit codes, so a test
 * file stays runnable on its own (`node tests/tracker.ts`) exactly as it is
 * documented to be.
 *
 * Children inherit stdio rather than being piped: capturing a child's output
 * through a pipe is what a confined session refuses, and the per-file output is
 * worth reading anyway.
 *
 * Usage: node scripts/run-tests.mjs
 * @module dsh-jenkins-plugin/scripts/run-tests
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Files in `tests/` that are fixtures rather than tests.
 *
 * `stub-jenkins.ts` is a server the probes and the manual walkthrough start;
 * run on its own it would listen forever instead of asserting anything.
 */
const FIXTURES = new Set(['stub-jenkins.ts'])

const files = readdirSync('tests')
  .filter(name => name.endsWith('.ts'))
  .filter(name => !FIXTURES.has(name))
  .sort()

if (files.length === 0) {
  console.log('no test files found under tests/')
  process.exitCode = 1
} else {
  const failed = []
  for (const file of files) {
    console.log(`\n=== ${file} ===`)
    const result = spawnSync(process.execPath, [join('tests', file)], { stdio: 'inherit' })
    // A signal counts as a failure: the file did not reach its own summary.
    if (result.status !== 0 || result.signal !== null) failed.push(file)
  }

  console.log(`\n${files.length - failed.length}/${files.length} test files passed`)
  if (failed.length > 0) {
    console.log(`failed: ${failed.join(', ')}`)
    process.exitCode = 1
  }
}
