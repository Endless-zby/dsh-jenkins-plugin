/**
 * Pre-flight for a release: is this version safe to publish right now?
 *
 * Every check here is one of the ways a release has actually gone wrong or
 * nearly did: publishing from a dirty tree (so the tarball does not match any
 * commit), reusing a tag, re-publishing a version the registry already has,
 * shipping a manifest that is not a bundle, or shipping a `lib/client.js` that
 * the module table will reject. None of these is visible from `npm publish`
 * succeeding.
 *
 * It only reads and reports: publishing needs credentials and is done by hand.
 *
 * Usage: node scripts/release-check.mjs
 * @module dsh-jenkins-plugin/scripts/release-check
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const version = manifest.version
const tag = `v${version}`
let blocked = 0

/**
 * Record one pre-flight result.
 * @param {string} label - what was checked.
 * @param {boolean} ok - whether it held.
 * @param {string} detail - value to print.
 */
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'BLOCKED'}  ${label}${detail === '' ? '' : `: ${detail}`}`)
  if (!ok) blocked += 1
}

/**
 * Run git and return its stdout.
 * @param {string[]} args - git arguments.
 * @returns {string} trimmed stdout.
 */
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

console.log(`pre-flight for ${manifest.name}@${version} (tag ${tag})\n`)

console.log('1) the tree that will be packaged is the tree that is committed')
const dirty = git(['status', '--porcelain'])
check('the working tree is clean', dirty.length === 0, dirty.length === 0 ? 'clean' : `${dirty.split('\n').length} path(s) pending`)
const head = git(['rev-parse', '--short', 'HEAD'])
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
console.log(`         head is ${branch} ${head}`)

console.log('\n2) the version and its tag are free')
const tags = git(['tag', '-l']).split('\n').filter(Boolean)
check(`tag ${tag} does not exist yet`, !tags.includes(tag), tags.includes(tag) ? 'already tagged' : `existing tags: ${tags.join(', ') || 'none'}`)
const published = await fetch(`https://registry.npmjs.org/${manifest.name}/${version}`)
check(`${manifest.name}@${version} is not on the registry`, published.status === 404, `registry answered ${published.status}`)

console.log('\n3) the manifest is a publishable bundle')
check('package.json does not set private', manifest.private !== true, manifest.private === true ? 'private: true blocks npm publish' : 'publishable')
check('dsh.bundle.patch is declared', manifest.dsh?.bundle?.patch !== undefined, manifest.dsh?.bundle?.patch ?? 'missing — dsh would install it as a plain dependency')
check('dsh.client.platform is declared', manifest.dsh?.client?.platform !== undefined, manifest.dsh?.client?.platform ?? 'missing — the browser half would never load')
check('the install command this release advertises is in the README', readFileSync('README.md', 'utf8').includes(`dsh plugin --profile web add ${manifest.name}`), `dsh plugin --profile web add ${manifest.name}`)

console.log('\n4) the artifacts that will be packed are built and current')
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
check('package-lock.json carries the same version', lock.version === version && lock.packages?.['']?.version === version, `lock ${lock.version}/${lock.packages?.['']?.version} vs manifest ${version}`)
let client = ''
try {
  client = readFileSync('lib/client.js', 'utf8')
} catch {
  blocked += 1
  console.log('  BLOCKED  lib/client.js exists: missing — run `npm run build`')
}
if (client.length > 0) {
  check('lib/client.js is the lazy module factory for this package', client.startsWith(`window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)},`), 'wrapped at build time')
  // A stale bundle ships the previous panel and looks like a caching bug on the
  // reader's side, so compare against the newest source it is built from.
  const sources = readdirSync('src/client', { recursive: true })
    .filter(name => name.endsWith('.ts') || name.endsWith('.tsx'))
    .map(name => statSync(join('src/client', name)).mtimeMs)
  const newestSource = Math.max(...sources)
  const bundleTime = statSync('lib/client.js').mtimeMs
  check('lib/client.js is newer than every client source', bundleTime >= newestSource, new Date(bundleTime).toISOString())
}
check('the Host half is built', (() => {
  try {
    readFileSync('lib/index.js', 'utf8')
    return true
  } catch {
    return false
  }
})(), 'lib/index.js')

console.log('\n5) the GitHub side is reachable by the people who will install it')
const readme = readFileSync('README.md', 'utf8')
const images = [...readme.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g)].map(match => match[1])
check('README images use absolute URLs', images.length > 0 && images.every(url => url.startsWith('http')), `${images.length} image(s)`)
check('no README image points at raw.githubusercontent.com', images.every(url => !url.includes('raw.githubusercontent.com')), 'jsDelivr is the China-facing host')

console.log(blocked === 0
  ? `\nready to release ${version}. Next:\n`
    + `  git tag -a ${tag} -m "${manifest.name} ${version}"\n`
    + `  npm run check                      # the three gates, one more time\n`
    + `  npm pack                           # install the tarball into a clean profile before publishing\n`
    + `  $env:NPM_TOKEN='<token>'; npm publish --userconfig "$env:TEMP\\dsh-npm-publish\\.npmrc"\n`
    + `  node .e2e/verify-publish.mjs ${version}   # npm has an async processing window\n`
    + `  git push origin main; git push origin ${tag}\n`
  : `\n${blocked} blocker(s): fix them before releasing. See RELEASING.md.`)
if (blocked > 0) process.exitCode = 1
