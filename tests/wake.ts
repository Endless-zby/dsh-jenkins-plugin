/**
 * Assertions for the failure wake.
 *
 * "A failed build wakes the conversation that followed the job, exactly once"
 * spans three modules — the routing on the favorite, the once-per-build decision
 * in `watch.ts`, and the hand-off in `analyze.ts` — and every way of getting it
 * wrong is invisible until a person notices they were never told. The watcher is
 * driven here with fakes for cordis, the registry and Jenkins, so the assertions
 * cover the real code path rather than a copy of its rules.
 *
 * Run with `node tests/wake.ts` after `tsc`.
 * @module dsh-jenkins-plugin/tests/wake
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config } from '../lib/config.js'
import type { InstanceRegistry } from '../lib/connection.js'
import { FollowWatcher } from '../lib/follow.js'
import { followupFor } from '../lib/handoff.js'
import type { FavoriteJob } from '../lib/settings.js'
import { jobNoticeKey, noticeKey, pendingNotices, shouldWake, wakeRoutes } from '../lib/watch.js'

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
 * Build a configuration with only the wake fields named.
 * @param fields - overrides for the defaults.
 * @returns the validated configuration.
 */
function config(fields: Record<string, unknown> = {}): Config {
  return Config({
    settingsFile: 'unused.json',
    baseUrl: '',
    username: '',
    notifyOnComplete: true,
    notifyWakeOnFailure: true,
    allowAnalyze: true,
    ...fields,
  })
}

/** What the fakes recorded during one scenario. */
interface Recorder {
  /** Prompts queued into the agent, in order. */
  prompts: string[]
  /** Labels handed to the platform job service. */
  labels: string[]
  /** Jenkins reads performed, as `method:args`. */
  reads: string[]
  /** How many times the instance list was read. */
  listCalls: number
}

/** One followed job's newest build, as the fake controller reports it. */
interface FakeBuild {
  /** Build number. */
  number: number
  /** Terminal outcome, or undefined while it runs. */
  outcome?: string
  /** Whether it still runs. */
  building?: boolean
}

/**
 * Stand up a watcher over fakes.
 * @param options - favorites, the build the controller reports, and the services present.
 * @returns the watcher plus everything it did.
 */
function harness(options: {
  favorites?: FavoriteJob[]
  build?: FakeBuild
  notify?: Config
  withJobs?: boolean
  withAgents?: boolean
  liveSession?: boolean
  failing?: boolean
} = {}): { watcher: FollowWatcher, recorder: Recorder, tick(): Promise<void> } {
  const recorder: Recorder = { prompts: [], labels: [], reads: [], listCalls: 0 }
  const favorites = options.favorites ?? [{ path: 'ai-eval', name: 'ai-eval', addedAt: 1, sessionId: 'session-a' }]
  const build = options.build ?? { number: 6, outcome: 'failure', building: false }

  const jobs = {
    start(spec: { label: string }) {
      recorder.labels.push(spec.label)
      return 'job-1'
    },
  }
  const agents = {
    get: (sessionId: string) => (options.liveSession === false
      ? undefined
      : { followup: (message: unknown) => { recorder.prompts.push(String((message as { content: { text: string }[] }).content[0].text)) } }),
  }

  const services: Record<string, unknown> = {}
  if (options.withJobs !== false) services.jobs = jobs
  if (options.withAgents !== false) services.agents = agents
  // Only the lookup is used, so the fake implements exactly that.
  const ctx = { get: (name: string) => services[name] } as unknown as Context

  const registry = {
    list: async () => {
      recorder.listCalls += 1
      return { instances: [{ id: 'ci', name: 'Company CI', baseUrl: 'http://ci/', username: 'u', tokenRef: 'T' }] }
    },
    favorites: async () => favorites,
    require: async () => ({
      instance: { id: 'ci', name: 'Company CI', baseUrl: 'http://ci/', username: 'u', tokenRef: 'T' },
      client: {
        listJobs: async () => [{ path: 'ai-eval', lastBuild: build }],
        buildDetail: async (jobPath: string, selector: string) => {
          recorder.reads.push(`buildDetail:${jobPath}#${selector}`)
          if (options.failing === true) throw new Error('controller is down')
          return {
            number: Number(selector),
            outcome: 'failure',
            duration: 1000,
            building: false,
            stages: [{ name: 'Package', status: 'FAILED' }],
            changes: [{ commitId: 'a1b2c3d', message: 'fix rounding', author: 'Ann' }],
          }
        },
        consoleLog: async (jobPath: string, selector: string, offset: number, maxBytes: number) => {
          recorder.reads.push(`consoleLog:${jobPath}#${selector}@${offset}+${maxBytes}`)
          return { text: 'boom: test failed', offset: 0, nextOffset: 18, totalSize: 18, truncated: false }
        },
      },
    }),
  } as unknown as InstanceRegistry

  const watcher = new FollowWatcher(ctx, registry, options.notify ?? config())
  return { watcher, recorder, tick: async () => { await watcher.tick() } }
}

/**
 * Let pending microtasks and one timer turn run, so an immediate first tick that
 * `start()` fires can be observed.
 * @returns a promise resolving after the flush.
 */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) await new Promise(resolve => { setTimeout(resolve, 0) })
}

console.log('1) only a real failure deserves a wake')
check('failure', shouldWake('failure'), true)
check('success', shouldWake('success'), false)
check('unstable is not a failure', shouldWake('unstable'), false)
check('aborted is not a failure', shouldWake('aborted'), false)
check('not-built', shouldWake('not-built'), false)

console.log('\n2) the route key a favorite uses is the one a notice derives')
{
  const notices = pendingNotices([{ instanceId: 'ci', jobPath: 'team/service/api', buildNumber: 42, outcome: 'failure', building: false }], new Set())
  const notice = notices[0]
  check('a notice was produced', notice !== undefined, true)
  if (notice !== undefined) {
    check('the notice key starts with the job route key', noticeKey(notice.instanceId, notice.jobPath, notice.buildNumber), `${jobNoticeKey('ci', 'team/service/api')}#42`)
    check('and the favorite routes to that same prefix', jobNoticeKey('ci', 'team/service/api'), 'ci/team/service/api')
  }
}

console.log('\n3) a favorite with no recorded session routes nowhere')
{
  const routes = wakeRoutes('ci', [
    { path: 'ai-eval', sessionId: 'session-a' },
    { path: 'smoke' },
    { path: 'maven-web', sessionId: 'session-b' },
  ])
  check('the two sessions are routed', [...routes.entries()].sort(), [['ci/ai-eval', 'session-a'], ['ci/maven-web', 'session-b']])
  check('the session-less favorite is absent', routes.has('ci/smoke'), false)
  check('an empty session id is treated as absent', wakeRoutes('ci', [{ path: 'smoke', sessionId: '' }]).size, 0)
}

console.log('\n4) a failed build wakes the session that followed it, once')
{
  const { watcher, recorder, tick } = harness()
  await tick()
  check('one prompt was queued', recorder.prompts.length, 1)
  check('it is about this job and build', recorder.prompts[0]?.includes('ai-eval 构建 #6') ?? false, true)
  check('it carries the log tail', recorder.prompts[0]?.includes('boom: test failed') ?? false, true)
  check('it names the failed stage', recorder.prompts[0]?.includes('Package') ?? false, true)
  check('it names the instance', recorder.prompts[0]?.includes('Company CI') ?? false, true)
  check('the completion notice was delivered too', recorder.labels, ['Jenkins ai-eval #6 failure'])
  check('the reads were one detail and one log tail', recorder.reads, ['buildDetail:ai-eval#6', 'consoleLog:ai-eval#6@0+16384'])

  await tick()
  check('re-reading the same build does not wake again', recorder.prompts.length, 1)
  check('and does not announce again', recorder.labels.length, 1)

  await tick()
  check('still one wake after three ticks', recorder.prompts.length, 1)
  watcher.start()()
}

console.log('\n5) outcomes that are not failures never wake')
for (const outcome of ['success', 'unstable', 'aborted']) {
  const { recorder, tick } = harness({ build: { number: 6, outcome, building: false } })
  await tick()
  check(`${outcome}: no wake`, recorder.prompts.length, 0)
  check(`${outcome}: but still announced`, recorder.labels, [`Jenkins ai-eval #6 ${outcome}`])
}

console.log('\n6) a running build wakes nobody, and is not announced')
{
  const { recorder, tick } = harness({ build: { number: 6, building: true } })
  await tick()
  check('no wake', recorder.prompts.length, 0)
  check('no notice', recorder.labels.length, 0)
}

console.log('\n7) the session has to exist')
{
  const { recorder, tick } = harness({ liveSession: false })
  await tick()
  check('no prompt when the session has no live agent', recorder.prompts.length, 0)
  check('the notice is still delivered', recorder.labels.length, 1)
  await tick()
  check('and it is not retried forever', recorder.prompts.length, 0)
}

console.log('\n8) favorites without a session stay silent')
{
  const { recorder, tick } = harness({ favorites: [{ path: 'ai-eval', name: 'ai-eval', addedAt: 1 }] })
  await tick()
  check('no prompt', recorder.prompts.length, 0)
  check('no reads beyond the listing', recorder.reads, [])
  check('notice still delivered', recorder.labels.length, 1)
}

console.log('\n9) both switches must be on')
{
  const off = harness({ notify: config({ notifyWakeOnFailure: false }) })
  await off.tick()
  check('notifyWakeOnFailure off: no wake', off.recorder.prompts.length, 0)
  check('notifyWakeOnFailure off: notice still delivered', off.recorder.labels.length, 1)

  const noAnalyze = harness({ notify: config({ allowAnalyze: false }) })
  await noAnalyze.tick()
  check('allowAnalyze off: no wake (the same log would go to a model)', noAnalyze.recorder.prompts.length, 0)
  check('allowAnalyze off: notice still delivered', noAnalyze.recorder.labels.length, 1)
}

console.log('\n10) a missing service degrades quietly')
{
  const noAgents = harness({ withAgents: false })
  await noAgents.tick()
  check('no agent runtime: no prompt', noAgents.recorder.prompts.length, 0)
  check('no agent runtime: notice still delivered', noAgents.recorder.labels.length, 1)

  const noJobs = harness({ withJobs: false })
  await noJobs.tick()
  check('no job service: the wake still happens', noJobs.recorder.prompts.length, 1)
  check('no job service: no notice', noJobs.recorder.labels.length, 0)
}

console.log('\n11) a controller that fails mid-hand-off does not storm')
{
  const { recorder, tick } = harness({ failing: true })
  await tick()
  check('the failing read was attempted', recorder.reads, ['buildDetail:ai-eval#6'])
  check('no prompt', recorder.prompts.length, 0)
  check('notice still delivered', recorder.labels.length, 1)
  await tick()
  check('the next tick does not retry the wake', recorder.prompts.length, 0)
  check('and does not re-read the build', recorder.reads.length, 1)
}

console.log('\n12) the watcher only arms when something can be delivered')
{
  const armed = harness()
  const stop = armed.watcher.start()
  await flush()
  check('armed: it polled immediately', armed.recorder.listCalls > 0, true)
  stop()

  const idle = harness({ notify: config({ notifyOnComplete: false, notifyWakeOnFailure: false }) })
  const idleStop = idle.watcher.start()
  await flush()
  check('both channels off: it never polls', idle.recorder.listCalls, 0)
  idleStop()

  const noticesOnly = harness({ notify: config({ notifyWakeOnFailure: false }) })
  const noticesStop = noticesOnly.watcher.start()
  await flush()
  check('notices on: it polls', noticesOnly.recorder.listCalls > 0, true)
  noticesStop()

  const wakeOnly = harness({ notify: config({ notifyOnComplete: false }) })
  const wakeStop = wakeOnly.watcher.start()
  await flush()
  check('wake on without notices: it polls', wakeOnly.recorder.listCalls > 0, true)
  await flush()
  check('and it woke the session', wakeOnly.recorder.prompts.length, 1)
  wakeStop()

  const nothing = harness({ withJobs: false, withAgents: false })
  const nothingStop = nothing.watcher.start()
  await flush()
  check('no service at all: it never polls', nothing.recorder.listCalls, 0)
  nothingStop()
}

console.log('\n13) the session sink reports which half is missing')
{
  const withAgents = { get: () => ({ followup: () => {} }) }
  const ok = followupFor({ get: (name: string) => (name === 'agents' ? withAgents : undefined) } as unknown as Context, 's')
  check('a live session yields a sink', ok.kind, 'ok')
  const noAgent = followupFor({ get: () => ({ get: () => undefined }) } as unknown as Context, 's')
  check('an unknown session is told apart', noAgent.kind, 'no-session')
  const noService = followupFor({ get: () => undefined } as unknown as Context, 's')
  check('a composition without agents is told apart', noService.kind, 'no-service')
}

const failed = results.filter(result => !result).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exitCode = 1
