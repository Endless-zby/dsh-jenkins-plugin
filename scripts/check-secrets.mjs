/**
 * Publish gate: scan the files git actually tracks for credential-shaped
 * literals, so a release cannot ship a token that only ever lived in the
 * working tree's untracked files.
 *
 * Three outcomes, and the distinction matters:
 *   FAIL  a credential-shaped literal — a release must not contain it.
 *   WARN  a private hostname echoed in engineering notes. Not a credential, but
 *         publishing it tells the world about an internal system, so a human
 *         decides per line instead of the script deciding for them.
 *   note  a value the repository documents as a fake (the stub's own token).
 *
 * Only tracked files are read: an untracked `.e2e/` harness or a local `.env`
 * cannot leak through npm or a git push, so flagging them would train the
 * reader to ignore this check.
 *
 * Usage: node scripts/check-secrets.mjs [--quiet]
 * @module dsh-jenkins-plugin/scripts/check-secrets
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Values this repository documents as deliberate fakes. */
const ALLOWED = [/^stub-token$/]

/** Credential-shaped literals: a match fails the gate. */
const FAILURES = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['npm token', /npm_[A-Za-z0-9]{30,}/],
  ['basic auth header', /Basic [A-Za-z0-9+/]{16,}={0,2}/],
  ['password literal', /(?<![A-Za-z])password\s*[:=]\s*["']?[^\s"',}]{4,}/i],
  ['token literal', /(?:api[_-]?token|auth[_-]?token|secret|credential)\s*[:=]\s*["'][A-Za-z0-9_\-.]{8,}["']/i],
  ['bearer literal', /Bearer\s+[A-Za-z0-9_\-.]{20,}/],
]

/** Private infrastructure or personal absolute paths named in prose: a match warns. */
const WARNINGS = [/ci\.jinhui365\.cn/, /[A-Za-z]:\\Users\\(?!<)[^\\\s"']+/]

const quiet = process.argv.includes('--quiet')

/**
 * List the files a commit would carry: tracked plus untracked-but-not-ignored.
 * The untracked half is the point — new work is exactly where a token typed
 * into a fresh file hides, and it is invisible to `git ls-files` alone.
 * @returns the repository-relative candidate paths.
 */
function trackedFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((path, index, all) => all.indexOf(path) === index)
}

let failed = 0
let warned = 0
let noted = 0
const files = trackedFiles()

for (const file of files) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  text.split(/\r?\n/).forEach((line, index) => {
    for (const [label, pattern] of FAILURES) {
      const match = pattern.exec(line)
      if (match === null) continue
      if (ALLOWED.some(allowed => allowed.test(match[0]))) continue
      failed += 1
      console.log(`FAIL  ${label}  ${file}:${index + 1}  ${line.trim().slice(0, 140)}`)
    }
    for (const pattern of WARNINGS) {
      if (!pattern.test(line)) continue
      warned += 1
      console.log(`WARN  private hostname  ${file}:${index + 1}  ${line.trim().slice(0, 140)}`)
    }
    if (line.includes('stub-token')) noted += 1
  })
}

if (!quiet) {
  console.log(`\nscanned ${files.length} tracked file(s): ${failed} failure(s), ${warned} warning(s), ${noted} documented fake(s).`)
  if (warned > 0) {
    console.log('Warnings are a publishing decision, not a leak: decide whether these notes ship.')
  }
  if (failed === 0) console.log('No credential-shaped literal is tracked.')
}
if (failed > 0) process.exitCode = 1
