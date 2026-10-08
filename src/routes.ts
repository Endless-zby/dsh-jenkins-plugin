/**
 * Same-origin HTTP routes the settings page and the panel call. Every handler
 * runs the composition's browser request-trust check first, because the bare
 * HTTP server carries no authentication or origin policy of its own.
 *
 * The routes own the instance list (address and login) and never touch a token:
 * the settings page writes secrets through the credentials Remote namespace,
 * and this server only ever reports whether one is present.
 *
 * Endpoints:
 * - `GET  /jenkins-plugin/state`     — connection state plus the job list of one instance.
 * - `GET  /jenkins-plugin/instances` — the configured instances, secrets excluded.
 * - `POST /jenkins-plugin/instances` — replace the instance list after probing each one.
 * - `POST /jenkins-plugin/probe`     — verify one candidate instance without storing it.
 * - `POST /jenkins-plugin/select`    — choose the instance this session's panel shows.
 * - `POST /jenkins-plugin/trigger`   — start a build, then follow its queue item.
 * - `POST /jenkins-plugin/abort`     — abort a running build.
 * - `POST /jenkins-plugin/analyze`   — hand a failed build to the model.
 * @module dsh-jenkins-plugin/routes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { analysisKey, handOverFailure } from './analyze.js'
import type { Config } from './config.js'
import { InstanceUnavailable } from './connection.js'
import type { InstanceRegistry } from './connection.js'
import { followupFor } from './handoff.js'
import { JenkinsClient, JenkinsError } from './jenkins/client.js'
import { buildProgress } from './jenkins/types.js'
import type { JenkinsBuildProgress, JenkinsJobRef } from './jenkins/types.js'
import { checkWritePolicy } from './policy.js'
import type { JenkinsInstance } from './settings.js'
import type { BuildTracker } from './tracker.js'
import { tokenRefFor } from './settings.js'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** GET route returning the panel's connection state and, when connected, its jobs. */
export const STATE_ROUTE = '/jenkins-plugin/state'

/** GET/POST route owning the instance list. */
export const INSTANCES_ROUTE = '/jenkins-plugin/instances'

/** POST route verifying one candidate instance without storing it. */
export const PROBE_ROUTE = '/jenkins-plugin/probe'

/** POST route choosing which instance a session's panel shows. */
export const SELECT_ROUTE = '/jenkins-plugin/select'

/** GET route returning one job with a page of its build history. */
export const JOB_ROUTE = '/jenkins-plugin/job'

/** GET route returning one build's full detail. */
export const BUILD_ROUTE = '/jenkins-plugin/build'

/** GET route returning a page of one build's console log. */
export const LOG_ROUTE = '/jenkins-plugin/log'

/** GET/POST route owning the favorited jobs of one instance. */
export const FAVORITES_ROUTE = '/jenkins-plugin/favorites'

/**
 * POST route starting a build on behalf of the panel.
 *
 * A separate path from {@link BUILD_ROUTE}, which reads one build: the two are
 * different methods on different concerns, and an exact-path route owns its
 * whole response, so they cannot share a path.
 */
export const TRIGGER_ROUTE = '/jenkins-plugin/trigger'

/** POST route aborting a running build on behalf of the panel. */
export const ABORT_ROUTE = '/jenkins-plugin/abort'

/**
 * POST route handing a failed build to the model for analysis.
 *
 * Separate from the write routes because it writes nothing: it reads the failing
 * build's log and opens a model turn in the calling session. It is a route rather
 * than a tool because the person clicking the button is not the model, and the
 * answer belongs in the conversation they are already reading.
 */
export const ANALYZE_ROUTE = '/jenkins-plugin/analyze'

/**
 * GET route streaming tracked-build updates as Server-Sent Events.
 *
 * The trackers subscribe to this route rather than polling, which is also what
 * arms the host-side poller: the connection is the subscription, so closing the
 * panel stops the polling (SPEC §10).
 */
export const EVENTS_ROUTE = '/jenkins-plugin/events'

/** One instance as submitted by the settings page. */
interface InstanceInput {
  id: string
  name: string
  baseUrl: string
  username: string
  tokenRef: string
  /** Token to store; omitted or empty means "keep whatever is already stored". */
  token?: string
}

/** Request bodies here are small JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * How many Maven versions the favorites route remembers.
 *
 * A version is read once per build and never changes, so this only needs to be
 * large enough for the builds a person is likely to look at in one session.
 */
const MAX_VERSION_CACHE = 500

/**
 * Maven versions already read, keyed `instanceId/jobPath#buildNumber`.
 *
 * `undefined` is a value here: it records "asked, and this job reports none",
 * which is what keeps a Freestyle job from costing a 404 on every refresh.
 */
const mavenVersions = new Map<string, string | undefined>()

/** Browser request-trust surface the Web composition provides. */
interface BrowserTrust {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/**
 * Builds whose analysis has been requested and not yet queued.
 *
 * Short-lived by construction: an entry exists only for the duration of reading
 * the build, which is what makes a double click harmless without a time window to
 * configure.
 */
const inFlight = new Set<string>()

/**
 * The composition's browser-trust service, when this profile has one.
 *
 * `connection` is a browser-side service this plugin deliberately does not
 * declare in `inject`: doing so would make the Host half unloadable in every
 * non-Web composition. Reading an undeclared service through `ctx.connection`
 * throws (`cannot get property "connection" without inject`), so the store is
 * read through `ctx.get`, which is the documented lookup that returns
 * `undefined` instead. Every request then fails closed: no trust service means
 * no panel traffic.
 * @param ctx - the context carrying the composition's services.
 * @returns the trust surface, or `undefined` when the profile has none.
 */
function trustOf(ctx: Context): BrowserTrust | undefined {
  return ctx.get('connection') as BrowserTrust | undefined
}

/** Write one JSON payload and end the response. */
function sendJson(res: ServerResponse, payload: unknown, status = 200): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Write one failure payload the page renders as a banner. */
function sendFailure(res: ServerResponse, error: unknown): void {
  if (error instanceof InstanceUnavailable) {
    // "Nothing configured yet" is a state, not a fault: the settings page shows
    // its empty state for `no-instances` and a token field for `no-token`.
    sendJson(res, { ok: false, code: error.gap, message: error.message, instanceId: error.instanceId })
    return
  }
  if (error instanceof JenkinsError) {
    sendJson(res, { ok: false, code: error.code, message: error.message })
    return
  }
  sendJson(res, {
    ok: false,
    code: 'unknown',
    message: error instanceof Error ? error.message : 'unexpected failure',
  })
}

/** Collect a bounded request body as UTF-8 text; `undefined` past the ceiling. */
async function readBoundedBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      // Drain the remainder so the refusal is a readable response, not a socket cut.
      req.resume()
      return undefined
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Read and parse a JSON object body, or answer the request with why it could not be.
 *
 * A body that is missing entirely counts as `{}`, because a route whose fields
 * are all optional is still a legitimate request; a body that is not JSON, or
 * that is too large, is refused here so no handler has to.
 * @param req - the request to read.
 * @param res - the response, written when the body is unusable.
 * @returns the parsed object, or `undefined` when a response was already sent.
 */
async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
  const text = await readBoundedBody(req)
  if (text === undefined) {
    sendJson(res, { ok: false, code: 'http', message: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413)
    return undefined
  }
  if (text.trim().length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    sendJson(res, { ok: false, code: 'config', message: 'body is not JSON' })
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendJson(res, { ok: false, code: 'config', message: 'body must be a JSON object' })
    return undefined
  }
  return parsed as Record<string, unknown>
}

/** Read one required string field out of a parsed body. */
function requiredField(body: Record<string, unknown>, name: string): string {
  const value = body[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new JenkinsError(`"${name}" is required`, 'config')
  }
  return value.trim()
}

/** Read an optional `parameters` object of strings. */
function parametersOf(body: Record<string, unknown>): Record<string, string> {
  const raw = body.parameters
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new JenkinsError('"parameters" must be an object of string values', 'config')
  }
  const parameters: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new JenkinsError(`parameter "${key}" must be a string`, 'config')
    }
    parameters[key] = value
  }
  return parameters
}

/** Parse one candidate instance out of an unknown value. */function parseInstance(value: unknown, index: number): { instance: InstanceInput } | { problem: string } {
  if (typeof value !== 'object' || value === null) return { problem: `instances[${index}] is not an object` }
  const record = value as Record<string, unknown>
  const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim() : ''
  const username = typeof record.username === 'string' ? record.username.trim() : ''
  if (baseUrl.length === 0) return { problem: `instances[${index}].baseUrl is required` }
  if (username.length === 0) return { problem: `instances[${index}].username is required` }
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return { problem: `instances[${index}].baseUrl is not a URL: ${baseUrl}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { problem: `instances[${index}].baseUrl must use http or https` }
  }
  // The id only has to be unique and URL-safe; the credential reference derived
  // from it is folded into the credential grammar separately.
  const rawId = typeof record.id === 'string' ? record.id.trim() : ''
  const id = rawId.length === 0 ? `instance-${index + 1}` : rawId
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    return { problem: `instances[${index}].id may only contain letters, digits, dot, dash and underscore` }
  }
  const name = typeof record.name === 'string' && record.name.trim().length > 0 ? record.name.trim() : id
  const tokenRef = typeof record.tokenRef === 'string' && record.tokenRef.trim().length > 0
    ? record.tokenRef.trim()
    : tokenRefFor(id)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenRef)) {
    return {
      problem: `instances[${index}].tokenRef "${tokenRef}" is not a valid credential name`
      + ' (letters, digits and underscore, not starting with a digit)',
    }
  }
  const token = typeof record.token === 'string' && record.token.length > 0 ? record.token : undefined
  return { instance: { id, name, baseUrl, username, tokenRef, ...token === undefined ? {} : { token } } }
}

/** The settings page's view of one instance; never includes a token. */
interface InstanceView extends Omit<InstanceInput, 'token'> {
  /** Whether a token is currently resolvable for {@link tokenRef}. */
  tokenConfigured: boolean
  /** Whether this is the instance tools use when none is named. */
  isDefault: boolean
}

/**
 * Register the settings and panel routes on the injected web server.
 * @param ctx - the context carrying `webServer`.
 * @param registry - reads and writes the effective instance list.
 * @param config - validated plugin configuration.
 */
export function registerJenkinsRoutes(
  ctx: Context,
  registry: InstanceRegistry,
  config: Config,
  tracker: BuildTracker,
): void {
  /** Instances the browser has selected, by session cookie. */
  const selected = new Map<string, string>()

  /** Reject an untrusted caller; true when the response is already written. */
  const rejected = (req: IncomingMessage, res: ServerResponse): boolean => {
    const rejection = trustOf(ctx)?.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  /** Build a client for a candidate instance, using its token or a stored one. */
  const clientFor = (input: InstanceInput): JenkinsClient => new JenkinsClient(
    { ...config, baseUrl: input.baseUrl, username: input.username },
    async () => {
      if (input.token !== undefined) return input.token
      const hit = await ctx.credentials.resolve(credentialRef(input.tokenRef))
      if (hit === undefined || hit.value.length === 0) {
        throw new JenkinsError(`credential "${input.tokenRef}" is not configured`, 'config')
      }
      return hit.value
    },
  )

  /** View every instance with its token presence and default flag. */
  const views = async (): Promise<{ instances: InstanceView[], source: string, defaultInstanceId?: string }> => {
    const { instances, defaultInstanceId, source } = await registry.list()
    const built = await Promise.all(instances.map(async (instance): Promise<InstanceView> => ({
      ...instance,
      tokenConfigured: await registry.tokenConfigured(instance),
      isDefault: instance.id === defaultInstanceId,
    })))
    return { instances: built, source, ...defaultInstanceId === undefined ? {} : { defaultInstanceId } }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATE_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (rejected(req, res)) return
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('allow', 'GET')
          res.end()
          return
        }
        const url = new URL(req.url ?? STATE_ROUTE, 'http://localhost')
        const cookie = cookieOf(req.headers.cookie)
        const requested = url.searchParams.get('instance') ?? selected.get(cookie) ?? undefined
        const includeJobs = url.searchParams.get('jobs') !== '0'
        const resolved = await registry.require(requested)
        const identity = await resolved.client.whoAmI()
        if (requested !== undefined) selected.set(cookie, requested)
        const jobs = includeJobs ? await resolved.client.listJobs() : undefined
        sendJson(res, {
          ok: true,
          connection: {
            instanceId: resolved.instance.id,
            name: resolved.instance.name,
            baseUrl: resolved.instance.baseUrl,
            username: resolved.instance.username,
            source: resolved.source,
            identity,
          },
          ...jobs === undefined ? {} : { jobs },
          denyJobs: config.denyJobs,
        })
      } catch (error) {
        sendFailure(res, error)
      }
    },
  }), `jenkins: GET ${STATE_ROUTE}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: INSTANCES_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (rejected(req, res)) return
        if (req.method === 'GET') {
          sendJson(res, { ok: true, ...await views(), denyJobs: config.denyJobs })
          return
        }
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('allow', 'GET, POST')
          res.end()
          return
        }
        const text = await readBoundedBody(req)
        if (text === undefined) {
          sendJson(res, { ok: false, code: 'http', message: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413)
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          sendJson(res, { ok: false, code: 'config', message: 'body is not JSON' })
          return
        }
        const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>
        const listed = Array.isArray(record.instances) ? record.instances : undefined
        if (listed === undefined) {
          sendJson(res, { ok: false, code: 'config', message: 'instances must be an array' })
          return
        }
        const inputs: InstanceInput[] = []
        const seen = new Set<string>()
        for (const [index, entry] of listed.entries()) {
          const outcome = parseInstance(entry, index)
          if ('problem' in outcome) {
            sendJson(res, { ok: false, code: 'config', message: outcome.problem })
            return
          }
          if (seen.has(outcome.instance.id)) {
            sendJson(res, { ok: false, code: 'config', message: `duplicate instance id "${outcome.instance.id}"` })
            return
          }
          seen.add(outcome.instance.id)
          inputs.push(outcome.instance)
        }

        // Every instance is probed before anything is written, so a typo cannot
        // be stored as if it worked. Failures are collected rather than thrown,
        // because the page has to show which row is wrong.
        const failures: Array<{ id: string, message: string }> = []
        const identities = new Map<string, { id: string, fullName: string }>()
        for (const input of inputs) {
          try {
            identities.set(input.id, await clientFor(input).whoAmI())
          } catch (error) {
            failures.push({
              id: input.id,
              message: error instanceof Error ? error.message : String(error),
            })
          }
        }
        if (failures.length > 0) {
          sendJson(res, {
            ok: false,
            code: 'auth',
            message: `Cannot connect to: ${failures.map(entry => `${entry.id} (${entry.message})`).join('; ')}`,
            failures,
          })
          return
        }

        // Credentials first: a stored instance whose token could not be written
        // would be a configuration that looks saved and does not work.
        for (const input of inputs) {
          if (input.token !== undefined) await ctx.credentials.set(credentialRef(input.tokenRef), input.token)
        }
        const wantedDefault = typeof record.defaultInstanceId === 'string' ? record.defaultInstanceId : undefined
        const defaultInstanceId = inputs.some(input => input.id === wantedDefault)
          ? wantedDefault
          : inputs[0]?.id
        // Through the registry rather than a whole-object write, so the stored
        // favorites survive an instance edit.
        await registry.saveInstances(
          inputs.map(({ token: _token, ...rest }): JenkinsInstance => rest),
          defaultInstanceId,
        )
        sendJson(res, { ok: true, ...await views(), identities: Object.fromEntries(identities) })
      } catch (error) {
        sendFailure(res, error)
      }
    },
  }), `jenkins: ${INSTANCES_ROUTE}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PROBE_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (rejected(req, res)) return
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('allow', 'POST')
          res.end()
          return
        }
        const text = await readBoundedBody(req)
        if (text === undefined) {
          sendJson(res, { ok: false, code: 'http', message: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413)
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          sendJson(res, { ok: false, code: 'config', message: 'body is not JSON' })
          return
        }
        const outcome = parseInstance(parsed, 0)
        if ('problem' in outcome) {
          sendJson(res, { ok: false, code: 'config', message: outcome.problem })
          return
        }
        // Probe-only: nothing is written, which is what makes the page's "Test
        // connection" button safe to press before saving.
        const identity = await clientFor(outcome.instance).whoAmI()
        const jobs = await clientFor(outcome.instance).listJobs()
        sendJson(res, { ok: true, identity, jobCount: jobs.length })
      } catch (error) {
        sendFailure(res, error)
      }
    },
  }), `jenkins: POST ${PROBE_ROUTE}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SELECT_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (rejected(req, res)) return
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('allow', 'POST')
          res.end()
          return
        }
        const text = await readBoundedBody(req)
        if (text === undefined) {
          sendJson(res, { ok: false, code: 'http', message: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413)
          return
        }
        const parsed = JSON.parse(text) as { instanceId?: unknown }
        const instanceId = typeof parsed.instanceId === 'string' ? parsed.instanceId : undefined
        // Verified before it is remembered, so a stale id cannot become the
        // session's selection and then fail on every later request.
        const resolved = await registry.require(instanceId)
        selected.set(cookieOf(req.headers.cookie), resolved.instance.id)
        sendJson(res, { ok: true, instanceId: resolved.instance.id })
      } catch (error) {
        sendFailure(res, error)
      }
    },
  }), `jenkins: POST ${SELECT_ROUTE}`)

  /**
   * One read-only route per panel view. They share a shape: resolve the named
   * instance, take the required query fields, and answer with the client's own
   * normalized value. Anything Jenkins cannot answer becomes the shared failure
   * payload, so the panel has one error path.
   */
  const readRoute = (
    path: string,
    handle: (
      url: URL,
      resolved: Awaited<ReturnType<InstanceRegistry['require']>>,
    ) => Promise<unknown>,
  ): void => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          if (rejected(req, res)) return
          if (req.method !== 'GET') {
            res.statusCode = 405
            res.setHeader('allow', 'GET')
            res.end()
            return
          }
          const url = new URL(req.url ?? path, 'http://localhost')
          const instanceId = url.searchParams.get('instance') ?? undefined
          const resolved = await registry.require(instanceId)
          sendJson(res, { ok: true, instanceId: resolved.instance.id, ...await handle(url, resolved) as object })
        } catch (error) {
          sendFailure(res, error)
        }
      },
    }), `jenkins: GET ${path}`)
  }

  /** Read one required query field, or throw the config failure the page shows. */
  const required = (url: URL, name: string): string => {
    const value = url.searchParams.get(name)
    if (value === null || value.length === 0) {
      throw new JenkinsError(`missing required query parameter "${name}"`, 'config')
    }
    return value
  }

  readRoute(JOB_ROUTE, async (url, resolved) => {
    const jobPath = required(url, 'job')
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10)
    const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10)
    const detail = await resolved.client.jobDetail(
      jobPath,
      Number.isFinite(limit) ? limit : 20,
      Number.isFinite(offset) ? offset : 0,
    )
    return { detail }
  })

  /**
   * The favorited jobs of one instance, each with its current build.
   *
   * One job listing answers every card: a favorite is addressed by path, and the
   * listing already carries each job's `lastBuild` — including the estimate the
   * progress bar needs — so N favorites cost one request rather than N.
   *
   * A Maven build's project version does cost one request per favorite, because
   * it lives on a different endpoint. Those answers are cached by build, since a
   * build's version never changes once Jenkins has reported it — and a job that
   * is not Maven answers 404, which is remembered as "not Maven" so the wasted
   * request happens once per job rather than once per refresh.
   */
  const favoritesView = async (instanceId?: string): Promise<{
    instanceId: string
    favorites: Array<{
      path: string
      name: string
      addedAt: number
      job?: JenkinsJobRef
      progress?: JenkinsBuildProgress
      mavenVersion?: string
    }>
  }> => {
    const resolved = await registry.require(instanceId)
    const stored = await registry.favorites(resolved.instance.id)
    if (stored.length === 0) return { instanceId: resolved.instance.id, favorites: [] }
    const jobs = await resolved.client.listJobs()
    const byPath = new Map(jobs.map(job => [job.path, job]))
    const now = Date.now()
    const versionOf = async (jobPath: string, buildNumber: number): Promise<string | undefined> => {
      const key = `${resolved.instance.id}/${jobPath}#${buildNumber}`
      if (mavenVersions.has(key)) return mavenVersions.get(key)
      const version = await resolved.client.mavenVersion(jobPath, buildNumber)
      // Bounded the same way the tracker bounds its own table: this is a read
      // cache for a card, not a record worth keeping for the process's life.
      if (mavenVersions.size >= MAX_VERSION_CACHE) {
        const oldest = mavenVersions.keys().next().value
        if (oldest !== undefined) mavenVersions.delete(oldest)
      }
      mavenVersions.set(key, version)
      return version
    }
    const rows = await Promise.all(stored.map(async (favorite) => {
      const job = byPath.get(favorite.path)
      const build = job?.lastBuild
      const mavenVersion = build === undefined ? undefined : await versionOf(favorite.path, build.number)
      return {
        path: favorite.path,
        name: favorite.name,
        addedAt: favorite.addedAt,
        ...job === undefined ? {} : { job },
        // Progress is derived from the build the listing already returned; a
        // job that vanished from the controller keeps its card and loses only
        // its live numbers.
        ...build === undefined ? {} : { progress: buildProgress(build, [], now) },
        ...mavenVersion === undefined ? {} : { mavenVersion },
      }
    }))
    return { instanceId: resolved.instance.id, favorites: rows }
  }

  readRoute(FAVORITES_ROUTE, async (url, resolved) => await favoritesView(resolved.instance.id))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${FAVORITES_ROUTE}/toggle`,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (rejected(req, res)) return
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('allow', 'POST')
          res.end()
          return
        }
        const text = await readBoundedBody(req)
        if (text === undefined) {
          sendJson(res, { ok: false, code: 'http', message: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413)
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          sendJson(res, { ok: false, code: 'config', message: 'body is not JSON' })
          return
        }
        const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>
        const jobPath = typeof record.path === 'string' ? record.path.trim() : ''
        if (jobPath.length === 0) {
          sendJson(res, { ok: false, code: 'config', message: 'path is required' })
          return
        }
        const favorited = record.favorited === true
        const name = typeof record.name === 'string' && record.name.trim().length > 0
          ? record.name.trim()
          : jobPath.split('/').at(-1) ?? jobPath
        const instanceId = typeof record.instance === 'string' ? record.instance : undefined
        // Recorded so a failure of this job can wake the conversation it was
        // followed from; the panel sends the session it is rendering.
        const sessionId = typeof record.session === 'string' && record.session.trim().length > 0
          ? record.session.trim()
          : undefined
        const resolved = await registry.require(instanceId)
        // Verified before it is stored: favoriting a path that does not exist
        // would produce a card that can never resolve.
        if (favorited) {
          const jobs = await resolved.client.listJobs()
          if (!jobs.some(job => job.path === jobPath)) {
            sendJson(res, {
              ok: false,
              code: 'not-found',
              message: `no job named "${jobPath}" on instance "${resolved.instance.name}"`,
            })
            return
          }
        }
        const favorites = await registry.setFavorite(resolved.instance.id, jobPath, name, favorited, sessionId)
        sendJson(res, { ok: true, instanceId: resolved.instance.id, favorites })
      } catch (error) {
        sendFailure(res, error)
      }
    },
  }), `jenkins: POST ${FAVORITES_ROUTE}/toggle`)

  /**
   * The live channel.
   *
   * The connection itself is the subscription: it arms the host poller on open
   * and releases it on close, so an unwatched plugin costs Jenkins nothing
   * (SPEC §10). Every write is a fresh snapshot rather than a diff, because a
   * reconnecting client then needs no replay logic.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: EVENTS_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (rejected(req, res)) return
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('allow', 'GET')
          res.end()
          return
        }

        // What to follow arrives with the subscription, so the connection is the
        // whole contract: `instance=<id>&builds=<jobPath>#<n>,<jobPath>#<n>`.
        // Tracking from a single read also means the host never polls a build
        // nobody is drawing.
        const parameters = new URL(req.url ?? EVENTS_ROUTE, 'http://localhost').searchParams
        // Resolved before the stream opens, so every record carries the id of an
        // instance that really exists: a record stamped with a stale or empty id
        // would be polled against whichever instance happened to be selected, and
        // would then 404 on a job that belongs to another controller.
        const resolved = await registry.require(parameters.get('instance') ?? undefined)
        for (const entry of (parameters.get('builds') ?? '').split(',')) {
          const trimmed = entry.trim()
          const separator = trimmed.lastIndexOf('#')
          if (separator <= 0) continue
          const jobPath = trimmed.slice(0, separator)
          const buildNumber = Number.parseInt(trimmed.slice(separator + 1), 10)
          if (!Number.isFinite(buildNumber)) continue
          tracker.track(resolved.instance.id, jobPath, buildNumber)
        }

        res.statusCode = 200
        res.setHeader('content-type', 'text/event-stream; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.setHeader('connection', 'keep-alive')
        // Proxies buffer responses by default, which would hold every event until
        // the stream ended — that is, never.
        res.setHeader('x-accel-buffering', 'no')

        /** Write one SSE frame. */
        const send = (): void => {
          if (res.writableEnded) return
          res.write(`event: snapshot\ndata: ${JSON.stringify(tracker.snapshot())}\n\n`)
        }

        send()
        const detach = tracker.subscribe({ notify: send })
        // A comment frame keeps idle connections from being reaped by an
        // intermediary that times out a silent stream.
        const keepAlive = setInterval(() => {
          if (!res.writableEnded) res.write(': keep-alive\n\n')
        }, 20_000)

        const release = (): void => {
          clearInterval(keepAlive)
          detach()
        }
        res.on('close', release)
        req.on('error', release)
      } catch (error) {
        // The instance could not be resolved, so there is no stream to open: the
        // page gets the same failure shape every other route uses.
        sendFailure(res, error)
      }
    },
  }), `jenkins: GET ${EVENTS_ROUTE}`)

  readRoute(BUILD_ROUTE, async (url, resolved) => {
    const detail = await resolved.client.buildDetail(
      required(url, 'job'),
      url.searchParams.get('build') ?? 'last',
    )
    return { detail }
  })

  readRoute(LOG_ROUTE, async (url, resolved) => {
    const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10)
    const page = await resolved.client.consoleLog(
      required(url, 'job'),
      url.searchParams.get('build') ?? 'last',
      Number.isFinite(offset) ? offset : 0,
      config.maxLogBytes,
    )
    return { page }
  })

  /**
   * Hand a failed build to the model.
   *
   * The panel cannot call a tool and cannot open a model turn by itself, so this
   * route does the two things a person would otherwise have to type: it reads the
   * failing build's log — the tail, bounded by `analyzeLogBytes`, because the
   * failing lines are at the end and the whole log can be megabytes — and it
   * queues one user message in the session the panel belongs to. The answer then
   * arrives in that conversation like any other turn.
   *
   * `agents` is looked up rather than injected: it is a core service, but this
   * plugin also loads in compositions without an agent runtime (the tools and the
   * background tracking work there), and a hard requirement would make the Host
   * half unloadable in them. When there is no agent runtime, or no live agent for
   * the named session, the refusal says exactly that.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ANALYZE_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (rejected(req, res)) return
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('allow', 'POST')
          res.end()
          return
        }
        const body = await readJsonBody(req, res)
        if (body === undefined) return
        const jobPath = requiredField(body, 'job')
        const build = requiredField(body, 'build')
        const sessionId = requiredField(body, 'session')
        const buildNumber = Number.parseInt(build, 10)
        if (!Number.isFinite(buildNumber)) {
          throw new JenkinsError(`"${build}" is not a build number`, 'config')
        }

        if (!config.allowAnalyze) {
          sendJson(res, {
            ok: false,
            code: 'forbidden',
            message: 'handing a build to the model is disabled by allowAnalyze',
          }, 403)
          return
        }
        const sink = followupFor(ctx, sessionId)
        if (sink.kind === 'no-service') {
          sendJson(res, {
            ok: false,
            code: 'unavailable',
            message: 'this composition has no agent runtime, so no model can be asked',
          }, 503)
          return
        }
        if (sink.kind === 'no-session') {
          sendJson(res, {
            ok: false,
            code: 'no-session',
            message: `session "${sessionId}" has no live agent; send a message there first, then try again`,
          }, 409)
          return
        }

        // One hand-off at a time per build: a double click must not buy two model
        // turns. The key is released when the turn has been queued.
        const key = analysisKey(sessionId, jobPath, buildNumber)
        if (inFlight.has(key)) {
          sendJson(res, {
            ok: false,
            code: 'busy',
            message: 'this build is already being handed to the model',
          }, 409)
          return
        }
        inFlight.add(key)
        try {
          const instanceId = typeof body.instance === 'string' ? body.instance : undefined
          const resolved = await registry.require(instanceId)
          const handed = await handOverFailure({
            client: resolved.client,
            jobPath,
            buildNumber,
            logBytes: config.analyzeLogBytes,
            instanceName: resolved.instance.name,
            // The hand-off stays a pure decision about *what* to say; the sink
            // that says it in this composition's session is `handoff.ts`, shared
            // with the failure watcher.
            followup: sink.followup,
          })
          sendJson(res, {
            ok: true,
            instanceId: resolved.instance.id,
            sessionId,
            job: jobPath,
            ...handed,
          })
        } finally {
          inFlight.delete(key)
        }
      } catch (error) {
        sendFailure(res, error)
      }
    },
  }), `jenkins: POST ${ANALYZE_ROUTE}`)

  /**
   * The panel's write routes.
   *
   * These perform the same two writes the model tool does and obey the same
   * configuration, but they deliberately stop at the configuration check.
   * `ctx.approval` requires its caller to be inside an unfinished turn, and a
   * click in the panel is not — which is why SPEC §7 gives the panel a different
   * gate: a confirmation in the browser plus `denyJobs` and the `allow.*`
   * switches. Sharing `checkWritePolicy` with the tool is what keeps the two
   * paths from drifting apart.
   *
   * A refusal is answered as HTTP 403 with the same `{ok:false, code, message}`
   * shape every other failure uses, so the panel has one way to render it.
   */
  const writeRoute = (
    path: string,
    handle: (
      resolved: Awaited<ReturnType<InstanceRegistry['require']>>,
      body: Record<string, unknown>,
    ) => Promise<{ refused: string } | { payload: Record<string, unknown> }>,
  ): void => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          if (rejected(req, res)) return
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }
          const body = await readJsonBody(req, res)
          if (body === undefined) return
          const instanceId = typeof body.instance === 'string' ? body.instance : undefined
          const resolved = await registry.require(instanceId)
          const outcome = await handle(resolved, body)
          if ('refused' in outcome) {
            sendJson(res, { ok: false, code: 'forbidden', message: outcome.refused }, 403)
            return
          }
          sendJson(res, { ok: true, instanceId: resolved.instance.id, ...outcome.payload })
        } catch (error) {
          sendFailure(res, error)
        }
      },
    }), `jenkins: POST ${path}`)
  }

  writeRoute(TRIGGER_ROUTE, async (resolved, body) => {
    const jobPath = requiredField(body, 'job')
    const policy = checkWritePolicy(config, jobPath, 'trigger')
    if (!policy.allowed) return { refused: policy.reason }
    const triggered = await resolved.client.trigger(jobPath, parametersOf(body))
    // The queue item is followed from here, so the build the operator just
    // started shows up in the panel on its own — first as a queued row, then as
    // a running build once Jenkins assigns it a number (SPEC §8).
    if (triggered.queueId !== undefined) {
      tracker.trackQueue(resolved.instance.id, jobPath, triggered.queueId)
    }
    return {
      payload: {
        job: jobPath,
        state: 'queued',
        ...triggered.queueId === undefined ? {} : { queueId: triggered.queueId },
        ...triggered.queueUrl.length === 0 ? {} : { url: triggered.queueUrl },
      },
    }
  })

  writeRoute(ABORT_ROUTE, async (resolved, body) => {
    const jobPath = requiredField(body, 'job')
    const build = requiredField(body, 'build')
    const policy = checkWritePolicy(config, jobPath, 'cancel')
    if (!policy.allowed) return { refused: policy.reason }
    const number = Number.parseInt(build, 10)
    if (!Number.isFinite(number)) {
      throw new JenkinsError(`"${build}" is not a build number`, 'config')
    }
    try {
      await resolved.client.cancel(jobPath, number)
    } catch (error) {
      // A build that already ended is a fact rather than a failure: the intent
      // ("this build should not be running") is satisfied either way, and the
      // panel reports it as such instead of as an error.
      if (error instanceof JenkinsError && error.code === 'not-found') {
        return { payload: { job: jobPath, build: number, aborted: false, state: 'already-finished' } }
      }
      throw error
    }
    return { payload: { job: jobPath, build: number, aborted: true, state: 'aborted' } }
  })
}

/** Read the cookie header as one opaque session key; the fence already authenticated it. */
function cookieOf(header: string | undefined): string {
  return header ?? 'anonymous'
}
