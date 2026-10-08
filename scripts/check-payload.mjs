/**
 * Publish gate: read the tarball npm would actually upload and assert that it
 * carries the built plugin and nothing else.
 *
 * `files` is easy to get subtly wrong — a missing `lib/client.js` ships a
 * browser half that cannot load, and a stray `src/` or `.e2e/` ships
 * engineering notes nobody asked for. Both are invisible until someone
 * installs the package, so this reads the manifest npm prints for
 * `npm pack --dry-run --json` instead of trusting the field by eye.
 *
 * Usage: node scripts/check-payload.mjs
 * @module dsh-jenkins-plugin/scripts/check-payload
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Files the published package must contain, and why. */
const REQUIRED = [
  ['package.json', 'npm metadata and the dsh.bundle / dsh.client declarations'],
  ['cordis.patch.yml', 'the bundle layer dsh applies at boot'],
  ['lib/index.js', 'the Host half the Loader imports'],
  ['lib/client.js', 'the browser half the module table fetches'],
  ['README.md', 'the install instructions a registry visitor reads'],
  ['LICENSE', 'the license npm links from the package page'],
]

/** Path prefixes that must never reach the registry. */
const FORBIDDEN = [
  ['src/', 'TypeScript sources are not needed at runtime'],
  ['node_modules/', 'dependencies are resolved by the installer'],
  ['.e2e/', 'the local verification harness is not part of the plugin'],
  ['scripts/', 'build and publish gates are repository tooling'],
  ['AGENTS.md', 'internal engineering notes'],
  ['SPEC.md', 'internal functional baseline'],
]

/**
 * Ask npm which files the tarball would carry.
 *
 * `--ignore-scripts` is not an optimization: this package's `prepare` script
 * runs on `npm pack` and prints its build line to stdout, which lands *before*
 * the JSON and makes the output unparsable. The caller builds first (or runs
 * `npm run check`, which does), and the assertions below still read the built
 * `lib/client.js` from disk.
 * @returns the tarball's file paths.
 * @throws {Error} when npm cannot be run or its output is not the expected JSON.
 */
function packedFiles() {
  // A single fixed command string rather than an args array: Windows needs a
  // shell to run npm's `.cmd` shim, and Node warns (DEP0190) when a shell is
  // combined with an argument array. The command is a literal, so there is
  // nothing user-supplied to escape.
  const result = spawnSync('npm pack --dry-run --json --ignore-scripts', { encoding: 'utf8', shell: true })
  if (result.error !== undefined) {
    throw new Error(`could not run npm pack (${result.error.message}); run this in a normal shell`)
  }
  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run failed (exit ${String(result.status)}): ${result.stderr.trim().split('\n').slice(-3).join(' ')}`)
  }
  const parsed = JSON.parse(result.stdout)
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  if (!Array.isArray(entry?.files)) throw new Error('npm pack --dry-run --json returned no file list')
  return entry.files.map(file => file.path)
}

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
let failures = 0

const files = packedFiles()
console.log(`the tarball would carry ${files.length} file(s)`)

for (const [path, why] of REQUIRED) {
  if (files.includes(path)) continue
  failures += 1
  console.log(`FAIL  missing ${path} — ${why}`)
}

for (const path of files) {
  const hit = FORBIDDEN.find(([prefix]) => path === prefix || path.startsWith(prefix))
  if (hit === undefined) continue
  failures += 1
  console.log(`FAIL  unexpected ${path} — ${hit[1]}`)
}

// The browser half is wrapped at build time; an unwrapped lib/client.js means
// the bundle step did not run and the module table would reject the script.
const PLUGIN_ID = manifest.name
if (files.includes('lib/client.js')) {
  const client = readFileSync('lib/client.js', 'utf8')
  if (!client.startsWith(`window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)},`)) {
    failures += 1
    console.log(`FAIL  lib/client.js is not the lazy module-graph factory for ${PLUGIN_ID} — run the build`)
  }
}

if (manifest.private === true) {
  failures += 1
  console.log('FAIL  package.json still declares private: true — npm publish would refuse')
}
if (manifest.dsh?.bundle?.patch === undefined) {
  failures += 1
  console.log('FAIL  package.json declares no dsh.bundle.patch — dsh plugin add would install it as a plain dependency')
}
if (manifest.dsh?.client?.platform === undefined) {
  failures += 1
  console.log('FAIL  package.json declares no dsh.client.platform — the browser half would never load')
}

console.log(failures === 0
  ? '\nThe packed payload is complete and carries no repository internals.'
  : `\n${failures} problem(s) to fix before publishing.`)
if (failures > 0) process.exitCode = 1
