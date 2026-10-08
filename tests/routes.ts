/**
 * Assertions for the plugin's own HTTP routes, driven in-process.
 *
 * Every panel view and every panel write crosses these handlers, and the
 * contract they enforce cannot be seen from either side alone: the
 * browser-trust fence must answer before a body is even read, `POST /instances`
 * must probe every row before storing any of them, and the favorites and
 * instances halves of one settings file must not overwrite each other. Until
 * now that layer was covered only by `.e2e` probes, which need a stub
 * controller, a live `dsh web` and a dev token — so it could not run in CI.
 *
 * The host here is the plugin's own: the real `registerJenkinsRoutes`, the real
 * `InstanceRegistry`, the real `JenkinsClient`, and a real controller answering
 * on an ephemeral loopback port. Only the web server and the request/response
 * objects are fakes, because those belong to the composition rather than to this
 * plugin.
 *
 * Run with `node tests/routes.ts` after `tsc`.
 * @module dsh-jenkins-plugin/tests/routes
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../lib/config.js'
import { InstanceRegistry } from '../lib/connection.js'
import { BuildTracker } from '../lib/tracker.js'
import {
  ABORT_ROUTE, ANALYZE_ROUTE, BUILD_ROUTE, EVENTS_ROUTE, FAVORITES_ROUTE, INSTANCES_ROUTE,
  JOB_ROUTE, LOG_ROUTE, PROBE_ROUTE, SELECT_ROUTE, STATE_ROUTE, TRIGGER_ROUTE,
  registerJenkinsRoutes,
} from '../lib/routes.js'

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

/** A context with only the seams the routes actually reach for. */
type RouteContext = Parameters<typeof registerJenkinsRoutes>[0]
/** What `InstanceRegistry` reads off the context. */
type RegistryContext = ConstructorParameters<typeof InstanceRegistry>[0]
/** A validated plugin configuration. */
type PluginConfig = ReturnType<typeof Config>

/** The cookie the fence accepts; its value is opaque to the plugin. */
const COOKIE = 'dsh-auth-session=opaque'
/** A session id the panel would send along with a favorite. */
const SESSION = 'session-42'

/** The settings file this run owns, inside a directory of its own. */
const home = await mkdtemp(join(tmpdir(), 'dsh-jenkins-routes-'))
const settingsFile = join(home, 'jenkins.json')

/**
 * Build one configuration for this run.
 * @param overrides - fields to vary.
 * @returns the validated configuration.
 */
function makeConfig(overrides: Record<string, unknown> = {}): PluginConfig {
  return Config({
    settingsFile,
    // Empty, so the static layer contributes no instance and every instance in
    // this test comes from the settings file the routes write.
    baseUrl: '',
    username: '',
    timeoutMs: 3_000,
    ...overrides,
  }) as PluginConfig
}

/** One request as a route handler sees it. */
class Request {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string | undefined>
  private readonly body: Buffer

  /**
   * @param method - HTTP method.
   * @param url - path plus query.
   * @param headers - request headers.
   * @param body - raw body text.
   */
  constructor(method: string, url: string, headers: Record<string, string | undefined>, body: string) {
    this.method = method
    this.url = url
    this.headers = headers
    this.body = Buffer.from(body, 'utf8')
  }

  /** Present on the real object; only the oversized-body path calls it. */
  resume(): void {}

  /** The handlers register `error` and `close`; neither fires here. */
  on(): this { return this }

  /** The bounded body reader consumes the request as an async iterable. */
  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    if (this.body.byteLength > 0) yield this.body
  }
}

/** One response as a route handler writes it. */
class Response {
  statusCode = 200
  writableEnded = false
  readonly headers: Record<string, string> = {}
  body = ''
  private readonly closers: Array<() => void> = []

  /**
   * @param name - header name.
   * @param value - header value.
   */
  setHeader(name: string, value: string): void { this.headers[name.toLowerCase()] = String(value) }

  /**
   * @param chunk - a stream frame.
   * @returns whether the write was accepted.
   */
  write(chunk: string): boolean { this.body += chunk; return true }

  /**
   * @param chunk - the final body, when there is one.
   */
  end(chunk?: string): void {
    if (chunk !== undefined) this.body += chunk
    this.writableEnded = true
  }

  /**
   * Register a lifecycle listener; only `close` matters here.
   * @param event - event name.
   * @param handler - listener.
   * @returns this response, as the real one does.
   */
  on(event: string, handler: () => void): this {
    if (event === 'close') this.closers.push(handler)
    return this
  }

  /** The status the handler left behind, which is what most assertions read. */
  get status(): number { return this.statusCode }

  /**
   * Fire the `close` listeners, which is how a stream releases its subscription.
   * Without this the event-stream route would leave its keep-alive interval
   * running and hold the process open.
   */
  close(): void {
    this.writableEnded = true
    for (const handler of this.closers) handler()
  }
}

/** One route as the fake web server received it. */
interface RegisteredRoute {
  /** Exact or prefix, per the platform's own contract. */
  kind: string
  /** Registered path. */
  path: string
  /** The handler under test. */
  handler: (req: unknown, res: unknown) => unknown
}

/**
 * Credential references the plugin stored, standing in for `.credentials.yaml`.
 *
 * Process-wide rather than per host, because that is what the real seam is: an
 * instance saved by one route set must keep working after the plugin restarts,
 * which several of the sections here model by building a fresh host.
 */
const credentials = new Map<string, string>()

/** Everything a test needs to talk to one registered route set. */
interface Host {
  /** The context the routes read their seams off. */
  ctx: unknown
  /** Routes by path. */
  routes: Map<string, RegisteredRoute>
  /** The shared credential store. */
  tokens: Map<string, string>
  /** Messages the plugin queued into a session. */
  delivered: unknown[]
}

/**
 * Build the fake host half: a web server that records routes, a credential seam,
 * and an optional agent runtime.
 * @param options - `trust` off models a composition with no browser-trust
 * service, which must fail closed; `agents` mounts an agent runtime.
 * @returns the host.
 */
function makeHost(options: { trust?: boolean, agents?: boolean } = {}): Host {
  const routes = new Map<string, RegisteredRoute>()
  const tokens = credentials
  const delivered: unknown[] = []
  const agents = options.agents === true
    ? {
        get: (id: string) => (id === SESSION
          ? { followup: (message: unknown) => { delivered.push(message) } }
          : undefined),
      }
    : undefined
  const ctx = {
    credentials: {
      resolve: async (ref: string) => {
        const value = tokens.get(ref)
        return value === undefined ? undefined : { value }
      },
      describe: async (ref: string) => ({ configured: tokens.has(ref) }),
      set: async (ref: string, value: string) => { tokens.set(ref, value) },
    },
    get: (name: string) => {
      if (name === 'connection') {
        if (options.trust === false) return undefined
        return {
          // The composition's fence rejects anything without a session cookie;
          // the plugin must not touch the request before asking it.
          requestRejection: (request: { headers: Record<string, string | undefined> }) =>
            (request.headers.cookie === undefined ? 401 : undefined),
        }
      }
      if (name === 'agents') return agents
      return undefined
    },
    effect: (fn: () => unknown) => { fn(); return () => {} },
    webServer: {
      register: (route: RegisteredRoute) => { routes.set(route.path, route); return () => {} },
    },
  }
  return { ctx, routes, tokens, delivered }
}

/** A registered route set plus the plugin objects behind it. */
interface Running extends Host {
  /** The configuration the routes were registered with. */
  config: PluginConfig
  /** The registry the routes read and write. */
  registry: InstanceRegistry
  /** The tracker the write routes feed. */
  tracker: BuildTracker
}

/**
 * Register the real routes on a fake host.
 * @param overrides - configuration fields to vary.
 * @param options - host options.
 * @returns the host, its configuration, and the plugin's own objects.
 */
function startHost(
  overrides: Record<string, unknown> = {},
  options: { trust?: boolean, agents?: boolean } = {},
): Running {
  const host = makeHost(options)
  const config = makeConfig(overrides)
  const registry = new InstanceRegistry(host.ctx as RegistryContext, config)
  const tracker = new BuildTracker(config)
  registerJenkinsRoutes(host.ctx as RouteContext, registry, config, tracker)
  return { ...host, config, registry, tracker }
}

/**
 * Call one registered route the way the composition's web server would.
 * @param host - the registered route set.
 * @param target - path plus query.
 * @param init - method, body and cookie.
 * @returns the response, for inspection.
 */
async function call(
  host: Host,
  target: string,
  init: { method?: string, body?: unknown, cookie?: string } = {},
): Promise<Response> {
  const url = new URL(target, 'http://panel.test')
  const route = host.routes.get(url.pathname)
  if (route === undefined) throw new Error(`the plugin registers no route for ${url.pathname}`)
  const raw = init.body === undefined
    ? ''
    : typeof init.body === 'string'
      ? init.body
      : JSON.stringify(init.body)
  const headers: Record<string, string | undefined> = {}
  if (init.cookie !== undefined) headers.cookie = init.cookie
  const request = new Request(init.method ?? 'GET', `${url.pathname}${url.search}`, headers, raw)
  const response = new Response()
  await route.handler(request, response)
  return response
}

/**
 * The JSON body of one answer, as a loose record.
 * @param response - the answer to decode.
 * @returns the parsed object, or `{}` when there is none.
 */
function json(response: Response): Record<string, unknown> {
  if (response.body.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(response.body)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/**
 * Read one field of a loose record as a list of records.
 * @param source - the record.
 * @param field - the field to read.
 * @returns the list, empty when the field is not one.
 */
function rows(source: Record<string, unknown>, field: string): Array<Record<string, unknown>> {
  const value = source[field]
  return Array.isArray(value) ? value as Array<Record<string, unknown>> : []
}

/**
 * The settings file's contents, or `undefined` when nothing was ever written.
 * @returns the parsed document, or `undefined`.
 */
async function stored(): Promise<Record<string, unknown> | undefined> {
  const text = await readFile(settingsFile, 'utf8').then(value => value, () => undefined)
  return text === undefined ? undefined : JSON.parse(text) as Record<string, unknown>
}

// --- the controller ------------------------------------------------------------------

/** The one job every assertion in this file is about. */
const JOB = 'smoke'

/** One build row, exactly the fields the client maps. */
function buildRow(): Record<string, unknown> {
  return {
    number: 7,
    result: 'FAILURE',
    building: false,
    timestamp: Date.now() - 60_000,
    duration: 1_000,
    url: 'http://controller/job/smoke/7/',
    displayName: '#7',
  }
}

/** The controller's root listing: one job and one folder. */
function rootJobs(): unknown[] {
  return [
    {
      name: JOB,
      url: 'http://controller/job/smoke',
      color: 'red',
      _class: 'hudson.model.FreeStyleProject',
      lastBuild: buildRow(),
    },
    {
      name: 'infra',
      url: 'http://controller/job/infra',
      color: 'blue',
      _class: 'com.cloudbees.hudson.plugins.folder.Folder',
    },
  ]
}

/** The folder's listing, which is what makes `infra/deploy-prod` a real path. */
function nestedJobs(): unknown[] {
  return [
    {
      name: 'deploy-prod',
      url: 'http://controller/job/infra/job/deploy-prod',
      color: 'blue',
      _class: 'hudson.model.FreeStyleProject',
    },
  ]
}

/** The console log of the failing build, whose tail the analysis must carry. */
const LOG = 'Building smoke\n[ERROR] cannot find symbol\nBUILD FAILED in 1s\n'

/** A fake controller that answers only what these routes read and write. */
interface Controller {
  /** Root URL to configure an instance with. */
  baseUrl: string
  /** Paths of the POSTs it received, in order. */
  posts: string[]
  /** Stop listening. */
  stop: () => void
}

/**
 * Start a controller on an ephemeral loopback port.
 * @returns its URL, the writes it saw, and a stop function.
 */
async function startController(): Promise<Controller> {
  const posts: string[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const reply = (status: number, payload?: unknown): void => {
      res.statusCode = status
      if (payload === undefined) {
        res.end()
        return
      }
      const text = JSON.stringify(payload)
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('content-length', String(Buffer.byteLength(text, 'utf8')))
      res.end(text)
    }

    // No CSRF issuer, as on a controller with the protection off: the client
    // reads the 404 as "this instance needs no crumb".
    if (url.pathname === '/crumbIssuer/api/json') {
      reply(404)
      return
    }
    // Jenkins requires the credential on every REST call, reads included.
    if (typeof req.headers.authorization !== 'string') {
      reply(401)
      return
    }
    if (req.method === 'POST') posts.push(url.pathname)

    if (url.pathname === '/me/api/json') {
      reply(200, { id: 'stub-user', fullName: 'Test Operator' })
      return
    }
    if (url.pathname === '/api/json') {
      reply(200, { jobs: rootJobs() })
      return
    }
    if (url.pathname === '/job/infra/api/json') {
      reply(200, { jobs: nestedJobs() })
      return
    }
    if (url.pathname === '/job/smoke/api/json') {
      reply(200, {
        name: JOB,
        url: 'http://controller/job/smoke',
        color: 'red',
        _class: 'hudson.model.FreeStyleProject',
        nextBuildNumber: 8,
        builds: [buildRow()],
      })
      return
    }
    if (url.pathname === '/job/smoke/7/api/json') {
      reply(200, {
        ...buildRow(),
        actions: [
          { causes: [{ shortDescription: 'Started by user Alice' }] },
          { parameters: [{ name: 'env', value: 'prod' }] },
        ],
        changeSet: {
          items: [{ commitId: 'abc123', author: { fullName: 'Dana' }, msg: 'Break the widget\n\ndetails' }],
        },
        artifacts: [{ fileName: 'report.txt', relativePath: 'out/report.txt', displayPath: 'report.txt' }],
      })
      return
    }
    if (url.pathname === '/job/smoke/7/consoleText') {
      res.statusCode = 200
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(LOG)
      return
    }
    if (req.method === 'POST' && url.pathname === '/job/smoke/build') {
      res.statusCode = 201
      res.setHeader('location', 'http://localhost/queue/item/41/')
      res.end()
      return
    }
    if (req.method === 'POST' && url.pathname === '/job/smoke/7/stop') {
      reply(200)
      return
    }
    // Everything else is absent, which is what a build that no longer exists
    // and a job that is not Maven both look like.
    reply(404)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    posts,
    // Connections are kept alive by the client's own agent, so a bare close()
    // would leave the process waiting on them.
    stop: () => { server.closeAllConnections(); server.close() },
  }
}

const controller = await startController()

/** A row that saves cleanly. */
const goodRow = {
  id: 'stub',
  name: 'Stub CI',
  baseUrl: controller.baseUrl,
  username: 'stub-user',
  token: 'stub-token',
}

// --- 1. the fence comes first --------------------------------------------------------

console.log('1) the browser-trust fence answers before any route does anything')
{
  const host = startHost()
  const everyRoute = [
    STATE_ROUTE, INSTANCES_ROUTE, PROBE_ROUTE, SELECT_ROUTE, JOB_ROUTE, BUILD_ROUTE, LOG_ROUTE,
    FAVORITES_ROUTE, `${FAVORITES_ROUTE}/toggle`, TRIGGER_ROUTE, ABORT_ROUTE, ANALYZE_ROUTE,
    EVENTS_ROUTE,
  ]
  // POST everywhere, so the claim is stronger than "a GET was refused": a write
  // must be refused before its body is read.
  const answers = await Promise.all(everyRoute.map(
    async path => (await call(host, path, { method: 'POST' })).status,
  ))
  check('every route refuses an untrusted caller with 401', answers, everyRoute.map(() => 401))

  const bodies = await Promise.all(everyRoute.map(
    async path => (await call(host, path, { method: 'POST' })).body,
  ))
  check('and none of them writes a body the page could misread', bodies, everyRoute.map(() => ''))
}

console.log('\n2) a composition with no trust service fails closed')
{
  const host = startHost({}, { trust: false })
  const answer = await call(host, STATE_ROUTE, { method: 'GET', cookie: COOKIE })
  check('a route with no fence to ask answers 401', answer.status, 401)
  check('and says nothing else', answer.body, '')
}

// --- 3. test connection stores nothing ------------------------------------------------

console.log('\n3) "test connection" reads, and stores nothing')
{
  const host = startHost()
  const answer = json(await call(host, PROBE_ROUTE, {
    method: 'POST',
    cookie: COOKIE,
    body: { baseUrl: controller.baseUrl, username: 'stub-user', token: 'stub-token' },
  }))
  check('the probe answers with the identity', (answer.identity as Record<string, unknown>)?.fullName, 'Test Operator')
  check('and how many jobs it can see', answer.jobCount, 2)
  check('and still stored nothing at all', await stored(), undefined)
}

// --- 4. saving instances --------------------------------------------------------------

console.log('\n4) POST /instances probes every row before storing any of them')
{
  const host = startHost()
  const refused = json(await call(host, INSTANCES_ROUTE, {
    method: 'POST',
    cookie: COOKIE,
    body: {
      instances: [
        goodRow,
        { id: 'broken', name: 'Broken', baseUrl: 'http://127.0.0.1:1/', username: 'nobody' },
      ],
      defaultInstanceId: 'stub',
    },
  }))
  check('the save is refused', refused.ok, false)
  check('with the auth code, because one row could not be reached', refused.code, 'auth')
  check('naming the row that failed', rows(refused, 'failures').map(entry => entry.id), ['broken'])
  check('and nothing was written, not even the good row', await stored(), undefined)

  const saved = json(await call(host, INSTANCES_ROUTE, {
    method: 'POST',
    cookie: COOKIE,
    body: { instances: [goodRow], defaultInstanceId: 'stub' },
  }))
  check('the good row alone saves', saved.ok, true)
  check('and is reported as the default', saved.defaultInstanceId, 'stub')
  const savedRows = rows(saved, 'instances')
  check('with its token reported as configured', savedRows[0]?.tokenConfigured, true)
  check('and no token anywhere in the answer', JSON.stringify(saved).includes('stub-token'), false)
  check('the token went to the credential seam instead', host.tokens.get('JENKINS_TOKEN_STUB'), 'stub-token')
  const document = await readFile(settingsFile, 'utf8')
  check('and the settings file has no token in it', document.includes('stub-token'), false)
}

console.log('\n5) the routes read the instance back')
{
  const host = startHost()
  const state = json(await call(host, STATE_ROUTE, { cookie: COOKIE }))
  const connection = state.connection as Record<string, unknown>
  check('the panel state resolves the stored instance', connection.instanceId, 'stub')
  check('with the identity Jenkins reported', (connection.identity as Record<string, unknown>)?.fullName, 'Test Operator')
  check('and the job list, folders walked', rows(state, 'jobs').map(job => job.path), ['smoke', 'infra/deploy-prod'])

  const detail = json(await call(host, `${JOB_ROUTE}?instance=stub&job=smoke`, { cookie: COOKIE })).detail as Record<string, unknown>
  check('a read route answers with the job', (detail.job as Record<string, unknown>)?.name, 'smoke')
  check('and its history page', rows(detail, 'builds').map(build => build.number), [7])

  const missing = json(await call(host, JOB_ROUTE, { cookie: COOKIE }))
  check('a read route missing its required field says which one', missing.message, 'missing required query parameter "job"')
  check('as a configuration failure', missing.code, 'config')
}

// --- 6. favorites and instances share one file ----------------------------------------

console.log('\n6) following a job stores the session that followed it')
{
  const host = startHost()
  const toggled = json(await call(host, `${FAVORITES_ROUTE}/toggle`, {
    method: 'POST',
    cookie: COOKIE,
    body: { instance: 'stub', path: 'smoke', name: 'smoke', favorited: true, session: SESSION },
  }))
  check('the job is followed', rows(toggled, 'favorites').map(entry => entry.path), ['smoke'])
  check('with the session recorded, which is where a failure would be reported', rows(toggled, 'favorites')[0]?.sessionId, SESSION)

  const document = await stored() as Record<string, unknown>
  check('the one settings file keeps both halves', [
    Array.isArray(document.instances) ? document.instances.length : 0,
    rows(document.favorites as Record<string, unknown>, 'stub').length,
  ], [1, 1])
  check('and the session id reached the disk', rows(document.favorites as Record<string, unknown>, 'stub')[0]?.sessionId, SESSION)
  check('with still no token in the file', JSON.stringify(document).includes('stub-token'), false)

  const again = json(await call(host, INSTANCES_ROUTE, {
    method: 'POST',
    cookie: COOKIE,
    body: {
      instances: [{ id: 'stub', name: 'Stub CI (renamed)', baseUrl: controller.baseUrl, username: 'stub-user' }],
    },
  }))
  check('an instance edit still saves', again.ok, true)
  const after = await stored() as Record<string, unknown>
  check('and does not wipe the favorites', rows(after.favorites as Record<string, unknown>, 'stub').map(entry => entry.path), ['smoke'])
  check('while the rename landed', rows(after, 'instances')[0]?.name, 'Stub CI (renamed)')

  const view = json(await call(host, `${FAVORITES_ROUTE}?instance=stub`, { cookie: COOKIE }))
  const card = rows(view, 'favorites')[0] as Record<string, unknown>
  check('the favorites view carries the job', (card.job as Record<string, unknown>)?.path, 'smoke')
  check('and its last build, which is what the card draws', ((card.job as Record<string, unknown>)?.lastBuild as Record<string, unknown>)?.number, 7)
  check('a Freestyle job reports no Maven version', 'mavenVersion' in card, false)
}

console.log('\n7) a favorite is verified, and a wake target is never guessed')
{
  const host = startHost()
  const ghost = json(await call(host, `${FAVORITES_ROUTE}/toggle`, {
    method: 'POST',
    cookie: COOKIE,
    body: { instance: 'stub', path: 'ghost', favorited: true, session: SESSION },
  }))
  check('following a job the controller does not have is refused', ghost.code, 'not-found')
  check('with a message naming it', ghost.message, 'no job named "ghost" on instance "Stub CI (renamed)"')
  const afterGhost = await stored() as Record<string, unknown>
  check('and nothing was stored', rows(afterGhost.favorites as Record<string, unknown>, 'stub').map(entry => entry.path), ['smoke'])

  const withoutSession = json(await call(host, `${FAVORITES_ROUTE}/toggle`, {
    method: 'POST',
    cookie: COOKIE,
    body: { instance: 'stub', path: 'infra/deploy-prod', favorited: true },
  }))
  check('a nested job can be followed too', withoutSession.ok, true)
  const afterAdd = await stored() as Record<string, unknown>
  const added = rows(afterAdd.favorites as Record<string, unknown>, 'stub')
    .find(entry => entry.path === 'infra/deploy-prod') as Record<string, unknown>
  check('a favorite added without a session records none', 'sessionId' in added, false)
  check('so a failure there wakes nobody rather than the wrong session', added.sessionId, undefined)
}

// --- 8. the panel's writes ------------------------------------------------------------

console.log('\n8) POST /trigger obeys denyJobs, and Jenkins is never asked')
{
  const host = startHost({ denyJobs: ['infra/*'] })
  const refused = await call(host, TRIGGER_ROUTE, {
    method: 'POST',
    cookie: COOKIE,
    body: { instance: 'stub', job: 'infra/deploy-prod' },
  })
  check('a denied job is refused with 403', refused.status, 403)
  const payload = json(refused)
  check('in the shape every other failure uses', [payload.ok, payload.code], [false, 'forbidden'])
  check('naming the deny list rather than the switch', (payload.message as string).includes('denyJobs'), true)
  check('and the controller saw no request at all', controller.posts, [])
}

console.log('\n9) an allowed trigger queues the build and puts it on the panel')
{
  const host = startHost()
  const triggered = json(await call(host, TRIGGER_ROUTE, {
    method: 'POST',
    cookie: COOKIE,
    body: { instance: 'stub', job: 'smoke' },
  }))
  check('the trigger is accepted', triggered.ok, true)
  check('and reports the queue item', [triggered.state, triggered.queueId], ['queued', 41])
  check('the controller was asked exactly once', controller.posts, ['/job/smoke/build'])

  const tracked = host.tracker.list()
  check('the queue item is on the panel before any poll', tracked.map(record => record.state), ['queued'])
  check('under the queued id, which has no build number in it yet', tracked[0]?.id, 'stub/smoke@41')
}

console.log('\n10) POST /abort obeys allowCancel, and a finished build is a fact')
{
  const off = startHost({ allowCancel: false })
  const refused = await call(off, ABORT_ROUTE, {
    method: 'POST',
    cookie: COOKIE,
    body: { instance: 'stub', job: 'smoke', build: '7' },
  })
  check('cancelling is refused while allowCancel is off', refused.status, 403)
  check('with the switch named', (json(refused).message as string).includes('allowCancel'), true)
  check('and nothing was sent to the controller', controller.posts, ['/job/smoke/build'])

  const on = startHost({ allowCancel: true })
  const aborted = json(await call(on, ABORT_ROUTE, {
    method: 'POST',
    cookie: COOKIE,
    body: { instance: 'stub', job: 'smoke', build: '7' },
  }))
  check('with allowCancel on it goes through', [aborted.ok, aborted.aborted, aborted.state], [true, true, 'aborted'])
  check('and the controller was asked to stop that build', controller.posts, ['/job/smoke/build', '/job/smoke/7/stop'])

  const finished = await call(on, ABORT_ROUTE, {
    method: 'POST',
    cookie: COOKIE,
    body: { instance: 'stub', job: 'smoke', build: '8' },
  })
  check('aborting a build that already ended is not an error', finished.status, 200)
  const gone = json(finished)
  check('it is reported as a fact', [gone.ok, gone.aborted, gone.state], [true, false, 'already-finished'])
}

console.log('\n11) malformed input is a readable refusal, not a crash')
{
  const host = startHost()
  const notJson = json(await call(host, TRIGGER_ROUTE, { method: 'POST', cookie: COOKIE, body: 'not json' }))
  check('a body that is not JSON says so', notJson.message, 'body is not JSON')
  check('as a configuration failure', notJson.code, 'config')

  const wrongMethod = await call(host, TRIGGER_ROUTE, { cookie: COOKIE })
  check('the wrong method is 405', wrongMethod.status, 405)
  check('with the method it does accept', wrongMethod.headers.allow, 'POST')

  const emptyParameters = json(await call(host, TRIGGER_ROUTE, {
    method: 'POST',
    cookie: COOKIE,
    body: { instance: 'stub', job: 'smoke', parameters: { env: 7 } },
  }))
  check('a parameter that is not a string is refused', emptyParameters.message, 'parameter "env" must be a string')
}

// --- 12. handing a failure to the model ------------------------------------------------

console.log('\n12) POST /analyze reports each half of the chain precisely')
{
  const request = { instance: 'stub', job: 'smoke', build: '7', session: SESSION }

  const disabled = startHost({ allowAnalyze: false }, { agents: true })
  const refused = await call(disabled, ANALYZE_ROUTE, { method: 'POST', cookie: COOKIE, body: request })
  check('allowAnalyze off is a 403', refused.status, 403)
  check('naming the switch', (json(refused).message as string).includes('allowAnalyze'), true)

  const noRuntime = startHost({}, { agents: false })
  const unavailable = await call(noRuntime, ANALYZE_ROUTE, { method: 'POST', cookie: COOKIE, body: request })
  check('a composition with no agent runtime is a 503, not a 409', unavailable.status, 503)
  check('with its own code', json(unavailable).code, 'unavailable')

  const gone = startHost({}, { agents: true })
  const orphan = await call(gone, ANALYZE_ROUTE, {
    method: 'POST',
    cookie: COOKIE,
    body: { ...request, session: 'session-that-ended' },
  })
  check('a session with no live agent is a 409', orphan.status, 409)
  check('with the code the panel keys on', json(orphan).code, 'no-session')
  check('and the fix, spelled out', (json(orphan).message as string).includes('send a message there first'), true)
  check('nothing was queued anywhere', gone.delivered.length, 0)

  const live = startHost({}, { agents: true })
  const handed = await call(live, ANALYZE_ROUTE, { method: 'POST', cookie: COOKIE, body: request })
  check('a live session accepts the hand-off', handed.status, 200)
  const report = json(handed)
  check('and the answer reports the build it read', [report.ok, report.buildNumber, report.outcome], [true, 7, 'failure'])
  check('including how many log bytes went to the model', report.logBytes, Buffer.byteLength(LOG, 'utf8'))
  check('exactly one message was queued, not two', live.delivered.length, 1)
  const message = JSON.stringify(live.delivered[0])
  check('the message names the job and build', message.includes('smoke') && message.includes('7'), true)
  check('and carries the failing log line, which is the point of the hand-off', message.includes('cannot find symbol'), true)
  check('tagged as this plugin\'s own message', message.includes('jenkins-plugin'), true)

  const missingSession = json(await call(live, ANALYZE_ROUTE, {
    method: 'POST',
    cookie: COOKIE,
    body: { instance: 'stub', job: 'smoke', build: '7' },
  }))
  check('without a session the route says which field is missing', missingSession.message, '"session" is required')
}

// --- 13. the live channel --------------------------------------------------------------

console.log('\n13) the event stream is the subscription')
{
  const host = startHost()
  const stream = await call(host, `${EVENTS_ROUTE}?instance=stub&builds=smoke%237`, { cookie: COOKIE })
  check('it opens as an event stream', stream.headers['content-type'], 'text/event-stream; charset=utf-8')
  check('unbuffered, so a proxy cannot hold every frame until the end', stream.headers['x-accel-buffering'], 'no')
  check('and sends a snapshot before anything can change', stream.body.startsWith('event: snapshot\ndata: '), true)
  const frame = JSON.parse(stream.body.split('data: ')[1]?.split('\n')[0] ?? '[]') as Array<Record<string, unknown>>
  check('the subscription registered the build it was asked for', frame.map(record => record.id), ['stub/smoke#7'])
  // Releasing the stream is what detaches the subscription on the host, so the
  // process must not be left holding the keep-alive interval.
  stream.close()
  check('closing the stream ends the response', stream.writableEnded, true)
}

// --- wrap up --------------------------------------------------------------------------

controller.stop()
await rm(home, { recursive: true, force: true })

const failed = results.filter(pass => !pass).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exitCode = 1
