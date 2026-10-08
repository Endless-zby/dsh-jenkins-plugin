/**
 * Assertions for the panel's live-snapshot rules.
 *
 * These are the decisions behind the followed-job cards: which builds are worth
 * a subscription, which record belongs to which card, and when the followed list
 * itself is stale. They are checked here without React, a browser, or a
 * controller, because each was a judgement call that a rendering test would only
 * catch by accident.
 *
 * Run with `node tests/panel-live.ts` after `tsc` (it imports the built output).
 * @module dsh-jenkins-plugin/tests/panel-live
 */

import { activeStageOf, anyStateChanged, buildsToFollow, cardState, changeSummary, favoritesOf, queuedFor, recordsFor, trackedFor, wantRebuild } from '../lib/client/live.js'
import { parseParameters } from '../lib/client/api.js'
import type { FavoriteRow, TrackedRow } from '../lib/client/api.js'

/** Collected pass/fail results, so the exit code can say whether all held. */
const results: boolean[] = []

/**
 * Stringify with object keys in a fixed order.
 *
 * Two objects that differ only in key order are the same answer, and a rule
 * returning `{building, progress, outcome}` must not read as a failure against
 * `{building, outcome, progress}`.
 * @param value - the value to render.
 * @returns its stable text form.
 */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, held: unknown) => {
    if (held === null || typeof held !== 'object' || Array.isArray(held)) return held
    return Object.fromEntries(
      Object.entries(held as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)),
    )
  })
}

/**
 * Assert one value.
 * @param label - what is being checked.
 * @param actual - the value produced.
 * @param expected - the value expected.
 */
function check(label: string, actual: unknown, expected: unknown): void {
  const pass = stable(actual) === stable(expected)
  results.push(pass)
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}: ${stable(actual)}${pass ? '' : ` (expected ${stable(expected)})`}`)
}

/**
 * Build a followed job, with as much of a listing row as these rules read.
 * @param path - job path.
 * @param build - the current build, or undefined for a job that never built.
 * @returns the favorite.
 */
function favorite(path: string, build?: { number: number, building: boolean, outcome?: string }): FavoriteRow {
  return {
    path,
    name: path,
    addedAt: 0,
    ...build === undefined
      ? {}
      : { job: { path, name: path, lastBuild: { number: build.number, building: build.building, outcome: build.outcome } } },
  } as unknown as FavoriteRow
}

/**
 * Build one record of the host's live snapshot.
 * @param id - tracking id.
 * @param state - record state.
 * @param rest - any further fields the case needs.
 * @returns the record.
 */
function tracked(id: string, state: string, rest: Record<string, unknown> = {}): TrackedRow {
  return { id, instanceId: 'ci', jobPath: 'demo', buildNumber: 1, state, polledAt: 0, intervalMs: 1000, ...rest } as unknown as TrackedRow
}

console.log('1) only a running build is worth a subscription')
check('no favorites', buildsToFollow(undefined), [])
check('empty list', buildsToFollow([]), [])
check('a finished build is not followed', buildsToFollow([favorite('a', { number: 3, building: false })]), [])
check('a job that never built is not followed', buildsToFollow([favorite('b')]), [])
check('a running build is followed', buildsToFollow([favorite('a', { number: 3, building: true })]), ['a#3'])
check('a favorite with no job row is skipped', buildsToFollow([{ path: 'gone', name: 'gone', addedAt: 0 } as FavoriteRow]), [])
check(
  'several running builds come back sorted, so the subscription URL is stable',
  buildsToFollow([favorite('z', { number: 2, building: true }), favorite('a', { number: 9, building: true })]),
  ['a#9', 'z#2'],
)
check(
  'a mixed list follows only what runs',
  buildsToFollow([favorite('a', { number: 1, building: true }), favorite('b', { number: 2, building: false })]),
  ['a#1'],
)

console.log('\n2) one snapshot carries every instance, so it must be filtered')
const snapshot = [
  tracked('ci/demo#1', 'running'),
  { ...tracked('stub/demo#1', 'running'), instanceId: 'stub' } as TrackedRow,
]
check('records for this instance', [...recordsFor(snapshot, 'ci').keys()], ['ci/demo#1'])
check('records for another instance', [...recordsFor(snapshot, 'stub').keys()], ['stub/demo#1'])
check('an unknown instance', recordsFor(snapshot, 'nope').size, 0)

console.log('\n3) a card finds its record by the tracker id the host uses')
const live = recordsFor(snapshot, 'ci')
check('the current build', trackedFor(live, 'ci', favorite('demo', { number: 1, building: true }))?.id, 'ci/demo#1')
check('a different build number has no record', trackedFor(live, 'ci', favorite('demo', { number: 2, building: true })), undefined)
check('a job with no build has no record', trackedFor(live, 'ci', favorite('other')), undefined)
check(
  'a record is never borrowed across instances',
  trackedFor(recordsFor(snapshot, 'stub'), 'ci', favorite('demo', { number: 1, building: true })),
  undefined,
)

console.log('\n4) a state change is what makes the followed list worth re-reading')
check('running then finished', anyStateChanged(new Map([['a', 'running']]), new Map([['a', 'finished']])), true)
check('running then detached', anyStateChanged(new Map([['a', 'running']]), new Map([['a', 'detached']])), true)
// A queue item that just became a build is the other change that matters: the
// job's lastBuild is now a build the panel has never seen.
check('queued then running', anyStateChanged(new Map([['a', 'queued']]), new Map([['a', 'running']])), true)
check('a build appears for the first time', anyStateChanged(new Map(), new Map([['a', 'queued']])), true)
check('already finished when the stream opened', anyStateChanged(new Map(), new Map([['a', 'finished']])), true)
check('still running', anyStateChanged(new Map([['a', 'running']]), new Map([['a', 'running']])), false)
check('finished twice', anyStateChanged(new Map([['a', 'finished']]), new Map([['a', 'finished']])), false)
check('a record that disappeared', anyStateChanged(new Map([['a', 'running']]), new Map()), false)

console.log('\n5) the active stage is the running one, when the controller reports stages')
check('no stages', activeStageOf(undefined), undefined)
check('empty stage list', activeStageOf([]), undefined)
check('a running stage', activeStageOf([{ name: 'Checkout', status: 'SUCCESS' }, { name: 'Test', status: 'IN_PROGRESS' }]), 'Test')
check('a paused stage', activeStageOf([{ name: 'Approve', status: 'PAUSED' }]), 'Approve')
check('only settled stages', activeStageOf([{ name: 'Checkout', status: 'SUCCESS' }]), undefined)

console.log('\n6) what a card draws, given both sources')
const running = favorite('demo', { number: 7, building: true })
const runningRecord = tracked('ci/demo#7', 'running', {
  progress: { kind: 'stages', fraction: 0.5, completed: 2, total: 4 },
  stages: [{ name: 'Test', status: 'IN_PROGRESS' }],
})
check('running with live numbers', cardState(running, runningRecord), {
  building: true,
  progress: { kind: 'stages', fraction: 0.5, completed: 2, total: 4 },
  stage: 'Test',
})
check('running before the first poll falls back to the listing', cardState({ ...running, progress: { kind: 'estimate', fraction: 0.2 } } as FavoriteRow, tracked('ci/demo#7', 'running')), {
  building: true,
  progress: { kind: 'estimate', fraction: 0.2 },
})
// The window this rule exists for: the build has ended, the tracker has seen it,
// and the listing — read a moment earlier — still says it is running.
check('the live record wins over a stale listing that still says building', cardState(running, tracked('ci/demo#7', 'finished', {
  outcome: 'failure',
  progress: { kind: 'finished' },
})), { building: false, outcome: 'failure', progress: { kind: 'finished' } })
check('a settled build with no live record uses the listing', cardState({ ...favorite('demo', { number: 7, building: false, outcome: 'success' }), progress: { kind: 'finished' } } as FavoriteRow, undefined), {
  building: false,
  outcome: 'success',
  progress: { kind: 'finished' },
})
check('a job that never built draws nothing', cardState(favorite('demo'), undefined), { building: false })
check('a missing job row draws nothing', cardState({ path: 'gone', name: 'gone', addedAt: 0 } as FavoriteRow, undefined), { building: false })

console.log('\n7) what a card shows about the build\'s commits')
const commits = [
  { commitId: 'a1b2c3d4e5f6', author: 'Ann', message: 'fix: correct rounding\n\nlong body nobody reads', timestamp: 0 },
  { commitId: 'ffffffffffff', author: 'Bob', message: 'chore: bump', timestamp: 0 },
]
check('the newest commit, shortened', changeSummary(commits, 3), {
  id: 'a1b2c3d',
  message: 'fix: correct rounding',
  more: 2,
  full: 'a1b2c3d\nAnn\n\nfix: correct rounding\n\nlong body nobody reads',
})
// Only the first line: a commit body is where the noise lives, and a card has one
// line to give.
check('the message is one line', changeSummary(commits, 3)?.message.includes('\n'), false)
check('a single commit says nothing more', changeSummary([commits[0] as never], 1)?.more, 0)
check('no total given falls back to what was sent', changeSummary([commits[0] as never])?.more, 0)
check('no commits means no line', changeSummary(undefined, 0), undefined)
check('an empty list means no line', changeSummary([], 0), undefined)
check('a blank message means no line', changeSummary([{ commitId: 'abc', author: '', message: '  \n ', timestamp: 0 }], 1), undefined)
check('a message with no id still reads', changeSummary([{ commitId: '', author: '', message: 'hotfix', timestamp: 0 }], 1)?.message, 'hotfix')

console.log('\n7b) a rebuild is only offered for a build that failed')
check('failure', wantRebuild('failure'), true)
// Unstable and aborted are not failures, and a build that has not finished has
// nothing to rebuild yet.
check('unstable', wantRebuild('unstable'), false)
check('aborted', wantRebuild('aborted'), false)
check('success', wantRebuild('success'), false)
check('building', wantRebuild('building'), false)
check('unknown', wantRebuild(undefined), false)

console.log('\n8) a job waiting in the queue is found by job, not by build number')
const queuedRow = { ...tracked('ci/demo@9', 'queued', { queueId: 9 }), buildNumber: undefined } as unknown as TrackedRow
const mixed = new Map([
  ['ci/demo#7', tracked('ci/demo#7', 'running')],
  [queuedRow.id, queuedRow],
])
check('the queued record for the job', queuedFor(mixed, 'ci', 'demo')?.id, 'ci/demo@9')
check('a job with nothing queued', queuedFor(mixed, 'ci', 'other'), undefined)
check('another instance never answers for this one', queuedFor(mixed, 'stub', 'demo'), undefined)
check('a finished record is not mistaken for a queued one', queuedFor(new Map([['x', tracked('x', 'finished')]]), 'ci', 'demo'), undefined)

console.log('\n9) the followed list is only usable for the instance it came from')
// This is the bug a stuck "queued" card was traced to: for the render right
// after an instance switch the panel held the new instance id and the previous
// controller's jobs, asked the new controller about them, and every poll 404ed.
const ciSnapshot = { instanceId: 'ci', rows: [favorite('ai-eval', { number: 6, building: false })] }
check('its own instance', favoritesOf(ciSnapshot, 'ci').map(row => row.path), ['ai-eval'])
check('another instance gets nothing', favoritesOf(ciSnapshot, 'stub'), [])
check('and no snapshot at all gets nothing', favoritesOf(undefined, 'ci'), [])
check('an empty listing is still the right answer', favoritesOf({ instanceId: 'ci', rows: [] }, 'ci'), [])

console.log('\n10) the parameter box becomes the form Jenkins takes')
check('empty text', parseParameters(''), { ok: true, parameters: {} })
check('one pair per line', parseParameters('BRANCH=main\nDEPLOY=false'), { ok: true, parameters: { BRANCH: 'main', DEPLOY: 'false' } })
check('blank lines and comments are skipped', parseParameters('\n# a note\nBRANCH=main\n\n'), { ok: true, parameters: { BRANCH: 'main' } })
check('the value may contain equals signs', parseParameters('SCRIPT=a=b'), { ok: true, parameters: { SCRIPT: 'a=b' } })
check('a value may be empty', parseParameters('FLAG='), { ok: true, parameters: { FLAG: '' } })
check('surrounding blanks are trimmed', parseParameters('  BRANCH = main  '), { ok: true, parameters: { BRANCH: 'main' } })
// A line that cannot be read stops the whole thing: triggering with the wrong
// parameters is worse than not triggering.
check('a line with no equals', parseParameters('BRANCH=main\nOOPS'), { ok: false, line: 2, kind: 'no-equals' })
check('a line with no name', parseParameters('=main'), { ok: false, line: 1, kind: 'empty-name' })

const failed = results.filter(pass => !pass).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exitCode = 1
