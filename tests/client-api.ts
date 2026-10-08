/**
 * Assertions for the panel's half of the HTTP contract.
 *
 * Every panel action is a `fetch` to a plugin-owned route, and the host parses
 * those bodies by hand — so a renamed field, a number sent where the host reads a
 * string, or an unencoded `#` in the event-stream URL fails silently: the request
 * still goes out, the host answers 400, and the panel shows a generic banner.
 * The routes are covered by `.e2e` probes against a real server, but those need a
 * stub controller and a dev token; this file pins the same contract in the
 * repository's own gates, where CI runs it.
 *
 * Run with `node tests/client-api.ts` after `tsc`.
 * @module dsh-jenkins-plugin/tests/client-api
 */

import {
  abortBuild, analyzeFailure, fetchBuild, fetchFavorites, fetchJob, fetchLog, fetchState,
  isFailure, subscribeEvents, toggleFavorite, triggerBuild,
} from '../lib/client/api.js'

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

/** One request the panel made. */
interface Call {
  /** Route path, as passed to fetch. */
  path: string
  /** Method the panel used. */
  method: string
  /** Parsed JSON body, or undefined for a GET. */
  body: Record<string, unknown> | undefined
  /** Whether credentials were requested. */
  credentials: string | undefined
  /** Content type the panel declared, when it sent a body. */
  contentType: string | undefined
}

const calls: Call[] = []
/** What the next fake response should be. */
let next: { status: number, text: string } | { throws: string } = { status: 200, text: '{"ok":true}' }

globalThis.fetch = (async (path: string, init: { method?: string, body?: string, credentials?: string, headers?: Record<string, string> } = {}) => {
  calls.push({
    path,
    method: init.method ?? 'GET',
    body: init.body === undefined ? undefined : JSON.parse(init.body),
    credentials: init.credentials,
    contentType: init.headers?.['content-type'],
  })
  if ('throws' in next) throw new Error(next.throws)
  const { status, text } = next
  return { status, text: async () => text }
}) as unknown as typeof fetch

/** The most recent call. */
const last = (): Call => calls[calls.length - 1] as Call

/** A stand-in for the browser's EventSource, so the stream URL can be asserted. */
class FakeSource {
  /** The most recently constructed source. */
  static last: FakeSource | undefined
  /** The URL the panel opened. */
  url: string
  /** Called when the stream opens. */
  onopen: (() => void) | undefined
  /** Called when the stream drops. */
  onerror: (() => void) | undefined
  /** Whether the panel closed it. */
  closed = false
  private readonly listeners = new Map<string, (event: unknown) => void>()

  /**
   * @param url - the stream URL.
   */
  constructor(url: string) {
    this.url = url
    FakeSource.last = this
  }

  /**
   * Register a named listener.
   * @param type - event name.
   * @param handler - called with the event.
   */
  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.set(type, handler)
  }

  /** Close the stream. */
  close(): void {
    this.closed = true
  }

  /**
   * Fire one event at the panel.
   * @param type - event name.
   * @param payload - the event.
   */
  emit(type: string, payload?: unknown): void {
    this.listeners.get(type)?.(payload)
  }
}

globalThis.EventSource = FakeSource as unknown as typeof EventSource

console.log('1) reads name the instance and encode the query')
calls.length = 0
await fetchState()
check('state with no instance has no query', last().path, '/jenkins-plugin/state')
check('and it is a GET', last().method, 'GET')
check('and it asks for same-origin credentials', last().credentials, 'same-origin')
await fetchState('stub')
check('state with an instance', last().path, '/jenkins-plugin/state?instance=stub')
await fetchState('stub', false)
// The host reads `jobs !== '0'`, so the flag is the string '0', not 'false'.
check('state can skip the job list', last().path, '/jenkins-plugin/state?instance=stub&jobs=0')
await fetchFavorites('stub')
check('favorites names the instance', last().path, '/jenkins-plugin/favorites?instance=stub')
await fetchFavorites()
check('favorites without an instance falls back to the default', last().path, '/jenkins-plugin/favorites')
await fetchJob('stub', 'team/service/api', 5, 10)
check('a job page carries path, limit and offset', last().path, '/jenkins-plugin/job?instance=stub&job=team%2Fservice%2Fapi&limit=5&offset=10')
await fetchBuild('stub', 'team/service/api', 'last')
check('a build read carries the selector', last().path, '/jenkins-plugin/build?instance=stub&job=team%2Fservice%2Fapi&build=last')
await fetchLog('stub', 'team/service/api', '7', 2048)
check('a log page carries the offset', last().path, '/jenkins-plugin/log?instance=stub&job=team%2Fservice%2Fapi&build=7&offset=2048')

console.log('\n2) the follow toggle records who followed the job')
calls.length = 0
await toggleFavorite('stub', 'maven-web', 'maven-web', true, 'session-a')
check('it posts to the toggle route', last().path, '/jenkins-plugin/favorites/toggle')
check('as a POST', last().method, 'POST')
check('with a JSON content type', last().contentType, 'application/json')
check('and the whole body the host parses', last().body, { instance: 'stub', path: 'maven-web', name: 'maven-web', favorited: true, session: 'session-a' })
await toggleFavorite('stub', 'maven-web', 'maven-web', false)
check('a toggle without a session sends no session field', 'session' in (last().body ?? {}), false)
check('so the host leaves the stored one alone', last().body, { instance: 'stub', path: 'maven-web', name: 'maven-web', favorited: false })

console.log('\n3) the write routes send what the host parses')
calls.length = 0
await triggerBuild('stub', 'smoke', { BRANCH: 'main' })
check('trigger posts to its route', last().path, '/jenkins-plugin/trigger')
check('with the job and its parameters', last().body, { instance: 'stub', job: 'smoke', parameters: { BRANCH: 'main' } })
await abortBuild('stub', 'smoke', 7)
check('abort posts the build as a string', last().body, { instance: 'stub', job: 'smoke', build: '7' })
await analyzeFailure('stub', 'maven-web', 5, 'session-a')
check('analyze posts the session with the build', last().body, { instance: 'stub', job: 'maven-web', build: '5', session: 'session-a' })

console.log('\n4) failures come back as one shape, never as a throw')
next = { status: 403, text: '{"ok":false,"code":"forbidden","message":"denied by denyJobs"}' }
const denied = await analyzeFailure('stub', 'infra/deploy-prod', 3, 'session-a')
check('a refusal is a failure value', isFailure(denied), true)
check('with the host code', (denied as { code: string }).code, 'forbidden')
check('and the host message, not a generic one', (denied as { message: string }).message, 'denied by denyJobs')
next = { status: 200, text: 'not json' }
const garbled = await fetchState()
check('a non-JSON body is a failure', isFailure(garbled), true)
check('reported as an http problem naming the route', (garbled as { code: string, message: string }).code, 'http')
next = { status: 200, text: '{"ok":false}' }
const silent = await fetchState()
check('a body without ok:true is a failure', isFailure(silent), true)
check('and still names the route', (silent as { message: string }).message, 'request to /jenkins-plugin/state failed (HTTP 200)')
next = { throws: 'socket hang up' }
const offline = await fetchState()
check('a transport error is a failure', isFailure(offline), true)
check('reported as a network problem', (offline as { code: string }).code, 'network')
next = { status: 200, text: '{"ok":true,"connection":{}}' }
check('and the next success still succeeds', isFailure(await fetchState()), false)

console.log('\n5) the event-stream URL carries what it must, encoded')
{
  let snapshots: unknown[] = []
  const states: string[] = []
  const close = subscribeEvents(
    'stub',
    ['team/service/api-build#42', 'smoke#3'],
    tracked => { snapshots = tracked as unknown[] },
    state => { states.push(state) },
  )
  const source = FakeSource.last as FakeSource
  const url = new URL(source.url, 'http://localhost')
  check('the route is the event stream', url.pathname, '/jenkins-plugin/events')
  check('the instance is named', url.searchParams.get('instance'), 'stub')
  check('the builds survive the round trip', url.searchParams.get('builds'), 'team/service/api-build#42,smoke#3')
  // An unencoded '#' would make everything after it a fragment, and the host
  // would then subscribe to nothing at all.
  check('and no bare # reaches the wire', source.url.includes('#'), false)
  check('the # is percent-encoded', source.url.includes('%23'), true)

  source.emit('snapshot', { data: JSON.stringify([{ id: 'stub/smoke#3', state: 'running' }]) })
  check('a snapshot frame reaches the panel', snapshots, [{ id: 'stub/smoke#3', state: 'running' }])
  source.emit('snapshot', { data: 'not json' })
  check('a malformed frame is dropped, not thrown', snapshots, [{ id: 'stub/smoke#3', state: 'running' }])
  source.onopen?.()
  source.onerror?.()
  check('the panel is told the stream opened and dropped', states, ['open', 'closed'])
  close()
  check('and closing it closes the stream', source.closed, true)

  const empty = subscribeEvents('stub', [], () => {})
  const emptyUrl = new URL((FakeSource.last as FakeSource).url, 'http://localhost')
  check('an empty subscription omits builds entirely', emptyUrl.searchParams.has('builds'), false)
  empty()
}

const failed = results.filter(result => !result).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exitCode = 1
