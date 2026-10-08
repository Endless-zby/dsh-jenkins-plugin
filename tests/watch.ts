/**
 * Assertions for the completion-notice rules.
 *
 * "Announce each finished build exactly once" is the whole promise of following a
 * job, and every way of getting it wrong is quiet: a duplicate notice is noise, a
 * missed one means the operator waited for nothing, and both look identical to a
 * code reviewer. The rules are pure, so they are asserted directly.
 *
 * Run with `node tests/watch.ts` after `tsc`.
 * @module dsh-jenkins-plugin/tests/watch
 */

import { NoticeLog, isTerminal, noticeKey, noticeLabel, pendingNotices } from '../lib/watch.js'
import type { WatchedJob } from '../lib/watch.js'

/** Collected pass/fail results. */
const results: boolean[] = []

/**
 * Assert one value.
 * @param label - what is being checked.
 * @param actual - the value produced.
 * @param expected - the value expected.
 */
function check(label: string, actual: unknown, expected: unknown): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  results.push(pass)
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${pass ? '' : ` (expected ${JSON.stringify(expected)})`}`)
}

/**
 * One followed job as the watcher sees it.
 * @param fields - the fields to set.
 * @returns the job.
 */
function job(fields: Partial<WatchedJob> = {}): WatchedJob {
  return { instanceId: 'ci', jobPath: 'ai-eval', buildNumber: 6, outcome: 'success', building: false, ...fields }
}

/** The keys of the notices a call produced, which is what the assertions compare. */
function keys(notices: readonly { key: string }[]): string[] {
  return notices.map(notice => notice.key)
}

console.log('1) a build that is still running is never announced')
check('no notice for a building', pendingNotices([job({ building: true, outcome: undefined })], new Set()), [])
// The listing can still carry the *previous* run's outcome while a new build runs;
// announcing then would report the old build as if it had just finished.
check('a stale outcome on a running build is ignored', pendingNotices([job({ building: true, outcome: 'success' })], new Set()), [])
check('a job that never built', pendingNotices([job({ buildNumber: undefined })], new Set()), [])
check('an unknown outcome', pendingNotices([job({ outcome: undefined })], new Set()), [])
check('an outcome that is not terminal', pendingNotices([job({ outcome: 'building' })], new Set()), [])

console.log('\n2) a finished build is announced exactly once')
const done = job()
check('the notice', keys(pendingNotices([done], new Set())), ['ci/ai-eval#6'])
check('the same build again, once announced', pendingNotices([done], new Set(['ci/ai-eval#6'])), [])
check('the notice carries what the label needs', pendingNotices([done], new Set())[0], {
  instanceId: 'ci',
  jobPath: 'ai-eval',
  buildNumber: 6,
  outcome: 'success',
  key: 'ci/ai-eval#6',
})

console.log('\n3) the next build of the same job is a new announcement')
check('build 7 after build 6', keys(pendingNotices([job({ buildNumber: 7 })], new Set(['ci/ai-eval#6']))), ['ci/ai-eval#7'])
check(
  'and the older one stays announced',
  keys(pendingNotices([job({ buildNumber: 7 }), job({ buildNumber: 6 })], new Set(['ci/ai-eval#6']))),
  ['ci/ai-eval#7'],
)

console.log('\n4) a build that ended while nobody watched is still announced')
// The operator followed the job to hear about this build; that it finished a
// moment before the watcher first looked does not make it uninteresting.
check('first sight, already finished', keys(pendingNotices([job()], new Set())), ['ci/ai-eval#6'])

console.log('\n5) instances and jobs do not share keys')
const two = pendingNotices(
  [
    job({ instanceId: 'ci' }),
    job({ instanceId: 'stub' }),
    job({ instanceId: 'ci', jobPath: 'other' }),
  ],
  new Set(),
)
check('three jobs, three keys', keys(two), ['ci/ai-eval#6', 'stub/ai-eval#6', 'ci/other#6'])
check('only the announced one is suppressed', keys(pendingNotices(two.map(entry => job(entry)), new Set(['stub/ai-eval#6']))), ['ci/ai-eval#6', 'ci/other#6'])

console.log('\n6) every terminal outcome counts, and only those')
for (const outcome of ['success', 'failure', 'unstable', 'aborted', 'not-built']) {
  check(`${outcome} is terminal`, isTerminal(outcome), true)
}
check('undefined is not', isTerminal(undefined), false)
check('an unknown word is not', isTerminal('queued'), false)
check('an empty outcome is not', isTerminal(''), false)

console.log('\n7) the key and the label')
check('the key names instance, job and build', noticeKey('ci', 'team/service/api-build', 42), 'ci/team/service/api-build#42')
check(
  'the label reads like a sentence',
  noticeLabel({ instanceId: 'ci', jobPath: 'ai-eval', buildNumber: 6, outcome: 'success', key: 'ci/ai-eval#6' }),
  'Jenkins ai-eval #6 success',
)

console.log('\n8) the announcement log is bounded and idempotent')
const log = new NoticeLog(3)
log.add('a')
log.add('a')
check('adding twice remembers once', [...log.snapshot()], ['a'])
log.add('b')
log.add('c')
check('has()', [log.has('a'), log.has('z')], [true, false])
log.add('d')
check('the oldest key is evicted at the bound', [...log.snapshot()], ['b', 'c', 'd'])
// Which is the point of the bound: the window that survives is the recent one,
// and that is where a duplicate would come from.
log.add(noticeKey('ci', 'ai-eval', 3))
check('a remembered build is not announced again', keys(pendingNotices([job({ buildNumber: 3 })], log.snapshot())), [])
check(
  'a build that fell out of the window would be',
  keys(pendingNotices([job({ buildNumber: 1 })], log.snapshot())),
  ['ci/ai-eval#1'],
)

console.log('\n9) the log hands the watcher exactly what it needs')
const shared = new NoticeLog()
for (const notice of pendingNotices([job(), job({ buildNumber: 7 })], shared.snapshot())) shared.add(notice.key)
check('nothing is owed a second time', keys(pendingNotices([job(), job({ buildNumber: 7 })], shared.snapshot())), [])
check('but the next build is', keys(pendingNotices([job({ buildNumber: 8 })], shared.snapshot())), ['ci/ai-eval#8'])

const failed = results.filter(pass => !pass).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exitCode = 1
