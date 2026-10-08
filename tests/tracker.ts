/**
 * Assertions for the live-build tracker.
 *
 * Everything here is a decision the tracker makes rather than a request it
 * sends: what may be polled, how long to wait before asking again, when a
 * triggered build becomes a build, and when a record is finally dropped. Those
 * rules are what keep an idle panel free and a busy one accurate, and each was
 * cheap to get subtly wrong — so they are asserted directly, with no clock, no
 * controller, and no timer involved.
 *
 * Run with `node tests/tracker.ts` after `tsc`.
 * @module dsh-jenkins-plugin/tests/tracker
 */

import { Config } from '../lib/config.js'
import { JenkinsError } from '../lib/jenkins/client.js'
import { BuildTracker, isDue, isRecordGone, nextInterval, queueTrackingId, trackingId } from '../lib/tracker.js'
import type { TrackedBuild } from '../lib/tracker.js'

/** The configuration every case below is judged against. */
const config = Config({
  settingsFile: 'unused.json',
  baseUrl: '',
  username: '',
  progressIntervalMs: 1_000,
  idleBackoffMaxMs: 8_000,
  retainMs: 60_000,
  queueTimeoutMs: 300_000,
})

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
 * A record with the given fields, for the pure decision functions.
 * @param fields - the fields to set.
 * @returns the record.
 */
function record(fields: Partial<TrackedBuild>): TrackedBuild {
  return {
    id: 'ci/demo#1',
    instanceId: 'ci',
    jobPath: 'demo',
    buildNumber: 1,
    state: 'running',
    polledAt: 0,
    intervalMs: 1_000,
    fingerprint: '',
    subscribedAt: 0,
    ...fields,
  }
}

console.log('1) no subscribers, no polling (SPEC §10)')
const tracker = new BuildTracker(config)
tracker.track('ci', 'demo', 7)
check('due() with no subscriber', tracker.due(10_000_000).length, 0)
check('watched', tracker.watched, false)

let notifications = 0
const detach = tracker.subscribe({ notify: () => { notifications += 1 } })
check('watched after subscribing', tracker.watched, true)
check('a fresh record is due immediately', tracker.due(10_000_000).length, 1)

console.log('\n2) nothing changes, so the interval grows to the ceiling')
const intervals = [1_000]
for (let step = 0; step < 4; step += 1) {
  intervals.push(nextInterval(intervals[intervals.length - 1] as number, false, config))
}
check('interval sequence while nothing moves', intervals, [1_000, 2_000, 4_000, 8_000, 8_000])
check('progress that moved resets to the base', nextInterval(8_000, true, config), 1_000)

console.log('\n3) a finished build is never polled again')
check('finished', isDue(record({ state: 'finished' }), 10_000_000), false)
check('detached', isDue(record({ state: 'detached' }), 10_000_000), false)
check('running past its interval', isDue(record({ polledAt: 0, intervalMs: 1_000 }), 1_001), true)

console.log('\n4) a triggered build starts as a queue item, not a build')
const queued = tracker.trackQueue('ci', 'demo', 42)
check('its id names the queue item', queued.id, queueTrackingId('ci', 'demo', 42))
check('it is queued', queued.state, 'queued')
check('it has no build number yet', queued.buildNumber, undefined)
check('it carries the queue id', queued.queueId, 42)
check('a queued record is polled, or it could never resolve', isDue(queued, 10_000_000), true)
check('tracking the same item again is idempotent', tracker.trackQueue('ci', 'demo', 42).id, queued.id)
check('and does not add a second record', tracker.size, 2)
check('the snapshot says what is queued', tracker.snapshot().find(row => row.id === queued.id), {
  id: 'ci/demo@42',
  instanceId: 'ci',
  jobPath: 'demo',
  queueId: 42,
  state: 'queued',
  polledAt: 0,
  intervalMs: 1_000,
})

console.log('\n5) the queue item resolves, and the record becomes the build')
// The queued record is mutated in place, so its id has to be captured before
// adoption re-keys it.
const queuedId = queued.id
const adopted = tracker.adopt(queuedId, 7)
check('it is re-keyed to the build id', adopted?.id, trackingId('ci', 'demo', 7))
check('it has the number', adopted?.buildNumber, 7)
check('it is running', adopted?.state, 'running')
check('the queue id is gone', adopted?.queueId, undefined)
check('and the queued key is no longer held', tracker.get(queuedId), undefined)
// This tracker already held `ci/demo#7`, so adoption must merge rather than
// leave two records describing one build.
check('the two records collapse into one', tracker.size, 1)
check('the surviving record is the build', tracker.get(trackingId('ci', 'demo', 7))?.buildNumber, 7)

console.log('\n6) adopting a build the panel already follows keeps that record')
const other = new BuildTracker(config)
other.subscribe({ notify: () => {} })
const already = other.track('ci', 'demo', 9)
other.observe(already.id, { stages: [{ name: 'Build', status: 'IN_PROGRESS', durationMs: 0 }], progress: { kind: 'stages' } })
const late = other.trackQueue('ci', 'demo', 77)
check('the panel tracked the build first', other.get(trackingId('ci', 'demo', 9))?.stages?.length, 1)
check('adopting returns the record that was polled', other.adopt(late.id, 9)?.id, trackingId('ci', 'demo', 9))
check('the queued record is dropped', other.get(queueTrackingId('ci', 'demo', 77)), undefined)
check('and the polled record kept its stages', other.get(trackingId('ci', 'demo', 9))?.stages?.length, 1)

console.log('\n6b) a terminal record for the same number is superseded, not merged into')
// A controller can be rebuilt, and this stub renumbers after a restart, so the
// same number can become live again. Merging into the old record would keep its
// terminal state and report a running build as finished.
const renumbered = new BuildTracker(config)
renumbered.subscribe({ notify: () => {} })
const stale = renumbered.track('ci', 'demo', 5)
renumbered.observe(stale.id, { outcome: 'aborted', finished: true })
check('the old record is terminal', renumbered.get(stale.id)?.state, 'finished')
const reused = renumbered.trackQueue('ci', 'demo', 3)
const live = renumbered.adopt(reused.id, 5)
check('the number is live again', live?.state, 'running')
check('and the stale record did not survive', renumbered.get(trackingId('ci', 'demo', 5))?.state, 'running')
check('with no outcome carried over', renumbered.get(trackingId('ci', 'demo', 5))?.outcome, undefined)
check('only one record is held', renumbered.size, 1)

console.log('\n7) observing a number resolves the queue item too')
const third = new BuildTracker(config)
const waiting = third.trackQueue('ci', 'nightly', 5)
const waitingId = waiting.id
third.observe(waitingId, { buildNumber: 12 })
check('the record is now the build', third.get(trackingId('ci', 'nightly', 12))?.buildNumber, 12)
check('nothing is left queued', third.get(waitingId), undefined)

console.log('\n8) a queue item that never resolves is detached, not left spinning')
const stuck = third.trackQueue('ci', 'forever', 6)
third.detach(stuck.id, 'Waiting for next available executor')
check('it is detached', third.get(stuck.id)?.state, 'detached')
check('it says why', third.get(stuck.id)?.note, 'Waiting for next available executor')
check('and is never polled again', isDue(third.get(stuck.id) as TrackedBuild, 10_000_000), false)

console.log('\n9) retention sweeps what is over, and only what is over')
const fourth = new BuildTracker(config)
fourth.subscribe({ notify: () => { notifications += 1 } })
const running = fourth.track('ci', 'a', 1)
const queuedLong = fourth.trackQueue('ci', 'b', 2)
const finished = fourth.track('ci', 'c', 3)
fourth.observe(finished.id, { outcome: 'success', finished: true })
check('the finished record is terminal', fourth.get(finished.id)?.state, 'finished')
check('nothing is swept before the window', fourth.sweep(Date.now() + 1_000), 0)
check(
  'past the window only the finished record goes',
  fourth.sweep(Date.now() + 120_000),
  1,
)
check('the running record is still held', fourth.get(running.id) !== undefined, true)
check('and so is the queued one', fourth.get(queuedLong.id) !== undefined, true)

console.log('\n10) a subscriber is told when something changes, and detaching stops it')
const before = notifications
fourth.observe(running.id, { stages: [{ name: 'Test', status: 'IN_PROGRESS', durationMs: 0 }] })
check('observing published', notifications > before, true)
const quiet = notifications
detach()
check('no subscriber', tracker.watched, false)
check('nothing is due for the detached tracker', tracker.due(10_000_000).length, 0)
fourth.observe(running.id, { stages: [] })
check('the other tracker still publishes', notifications > quiet, true)

console.log('\n11) only "Jenkins does not have this" ends a record')
// This is the decision that used to freeze a whole panel: a record naming a job
// the controller does not have fails on every tick, and a batch that stopped at
// the first failure left every other build unrefreshed.
check('a missing job', isRecordGone(new JenkinsError('no such job', 'not-found', 404)), true)
check('a malformed request', isRecordGone(new JenkinsError('bad job path', 'config')), true)
check('a credential problem is retried, not forgotten', isRecordGone(new JenkinsError('401', 'auth', 401)), false)
check('an unreachable controller is retried', isRecordGone(new JenkinsError('ECONNREFUSED', 'network')), false)
check('a timeout is retried', isRecordGone(new JenkinsError('slow', 'timeout')), false)
check('a plain error is retried', isRecordGone(new Error('boom')), false)

const failed = results.filter(pass => !pass).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exitCode = 1
