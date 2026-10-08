/**
 * The browser half's typed view of the plugin's own same-origin routes.
 *
 * Every call goes through one place so the surfaces (the settings page and the
 * panel) cannot drift in how they read a failure, and so a route's shape has a
 * single declaration. No token ever crosses these calls: the settings page
 * writes secrets through the credentials Remote namespace instead.
 * @module dsh-jenkins-plugin/client/api
 */

/** One configured instance as the routes describe it. */
export interface InstanceView {
  id: string
  name: string
  baseUrl: string
  username: string
  tokenRef: string
  /** Whether a token is currently resolvable for {@link tokenRef}. */
  tokenConfigured: boolean
  /** Whether tools use this instance when none is named. */
  isDefault: boolean
}

/** One build row. */
export interface BuildRow {
  number: number
  result: string | null
  outcome: string
  building: boolean
  timestamp: number
  duration: number
  url: string
  displayName?: string
  description?: string
}

/** One job row. */
export interface JobRow {
  path: string
  name: string
  url: string
  status: string
  lastBuild?: BuildRow
}

/** One job with its history page. */
export interface JobDetailRow {
  job: JobRow
  builds: BuildRow[]
  totalBuilds?: number
}

/** One Pipeline stage. */
export interface StageRow {
  name: string
  status: string
  startedAt?: number
  durationMs?: number
}

/** One commit in a build's change set. */
export interface ChangeRow {
  commitId: string
  author: string
  message: string
  timestamp: number
}

/** Test totals of a build. */
export interface TestRow {
  total: number
  failed: number
  skipped: number
  passed: number
}

/** One artifact of a build. */
export interface ArtifactRow {
  name: string
  path: string
  size: number
  url: string
}

/** A build's full detail as the panel draws it. */
export interface BuildDetailRow extends BuildRow {
  stages: StageRow[]
  progress: { completed: number, total: number }
  hasStages: boolean
  changes: ChangeRow[]
  tests: TestRow | null
  artifacts: ArtifactRow[]
  estimatedDuration: number
  cause?: string
  /** The parameters the build ran with, when it was parameterized. */
  parameters?: Record<string, string>
}

/** A page of console log. */
export interface LogPageRow {
  text: string
  nextOffset: number
  moreData: boolean
  truncated: boolean
  totalSize?: number
}

/** Every failure this client reports, normalized. */
export interface ApiFailure {
  ok: false
  /** Failure category; `no-instances`/`no-token` are states, not faults. */
  code: string
  message: string
  instanceId?: string
  /** Per-instance failures when a save was rejected. */
  failures?: Array<{ id: string, message: string }>
}

/** The connection facts the panel header shows. */
export interface ConnectionRow {
  instanceId: string
  name: string
  baseUrl: string
  username: string
  source: string
  identity: { id: string, fullName: string }
}

/** The panel's state payload. */
export interface StatePayload {
  ok: true
  connection: ConnectionRow
  jobs?: JobRow[]
  denyJobs: string[]
}

/** One instance's payload as the settings page submits it. */
export interface InstanceInput {
  id: string
  name: string
  baseUrl: string
  username: string
  tokenRef: string
  /** Omitted or empty means "keep the stored token". */
  token?: string
}

/** The settings page's payload. */
export interface InstancesPayload {
  ok: true
  instances: InstanceView[]
  source: string
  defaultInstanceId?: string
  identities?: Record<string, { id: string, fullName: string }>
}

/** Build a failure value from a non-OK response body. */
function failureOf(body: unknown, fallback: string): ApiFailure {
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>
    return {
      ok: false,
      code: typeof record.code === 'string' ? record.code : 'unknown',
      message: typeof record.message === 'string' ? record.message : fallback,
      ...typeof record.instanceId === 'string' ? { instanceId: record.instanceId } : {},
      ...Array.isArray(record.failures)
        ? { failures: record.failures as Array<{ id: string, message: string }> }
        : {},
    }
  }
  return { ok: false, code: 'unknown', message: fallback }
}

/**
 * Perform one same-origin JSON request.
 *
 * A transport failure and a domain failure are reported the same way, because
 * every caller renders both as a banner and neither is distinguishable to the
 * person reading it.
 * @param path - route path.
 * @param init - fetch options; a body is sent as JSON.
 * @returns the decoded payload, or a normalized failure.
 */
async function request<T>(path: string, init?: { method?: string, body?: unknown }): Promise<T | ApiFailure> {
  try {
    const response = await fetch(path, {
      method: init?.method ?? 'GET',
      credentials: 'same-origin',
      ...init?.body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) },
    })
    const text = await response.text()
    let body: unknown
    try {
      body = text.length === 0 ? {} : JSON.parse(text)
    } catch {
      return { ok: false, code: 'http', message: `unexpected response from ${path} (HTTP ${response.status})` }
    }
    if (typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true) {
      return body as T
    }
    return failureOf(body, `request to ${path} failed (HTTP ${response.status})`)
  } catch (error) {
    return {
      ok: false,
      code: 'network',
      message: error instanceof Error ? error.message : 'request failed',
    }
  }
}

/** Whether a response is a failure. */
export function isFailure<T>(value: T | ApiFailure): value is ApiFailure {
  return (value as { ok?: unknown }).ok === false
}

/** Read one instance's panel state. */
export async function fetchState(instanceId?: string, includeJobs = true): Promise<StatePayload | ApiFailure> {
  const query = new URLSearchParams()
  if (instanceId !== undefined && instanceId.length > 0) query.set('instance', instanceId)
  if (!includeJobs) query.set('jobs', '0')
  const suffix = query.size === 0 ? '' : `?${query.toString()}`
  return await request<StatePayload>(`/jenkins-plugin/state${suffix}`)
}

/** Read every configured instance. */
export async function fetchInstances(): Promise<InstancesPayload | ApiFailure> {
  return await request<InstancesPayload>('/jenkins-plugin/instances')
}

/** Replace the instance list; the host probes every row before storing it. */
export async function saveInstances(
  instances: InstanceInput[],
  defaultInstanceId?: string,
): Promise<InstancesPayload | ApiFailure> {
  return await request<InstancesPayload>('/jenkins-plugin/instances', {
    method: 'POST',
    body: { instances, ...defaultInstanceId === undefined ? {} : { defaultInstanceId } },
  })
}

/** Verify one candidate instance without storing anything. */
export async function probeInstance(
  instance: InstanceInput,
): Promise<{ ok: true, identity: { id: string, fullName: string }, jobCount: number } | ApiFailure> {
  return await request('/jenkins-plugin/probe', { method: 'POST', body: instance })
}

/** Choose the instance one session's panel shows. */
export async function selectInstance(instanceId: string): Promise<{ ok: true, instanceId: string } | ApiFailure> {
  return await request('/jenkins-plugin/select', { method: 'POST', body: { instanceId } })
}

/** One build's progress as the panel draws it. */
export interface ProgressRow {
  /** `stages`, `estimate`, `indeterminate`, or `finished`. */
  kind: string
  /** 0..1 when known. */
  fraction?: number
  completed?: number
  total?: number
  elapsedMs?: number
  estimatedMs?: number
}

/** One favorited job with its live state. */
export interface FavoriteRow {
  path: string
  name: string
  addedAt: number
  /** Absent when the job is no longer on the controller. */
  job?: JobRow
  progress?: ProgressRow
  /** Project version of the current build, for a Maven job that reported one. */
  mavenVersion?: string
}

/** The favorites payload. */
export interface FavoritesPayload {
  ok: true
  instanceId: string
  favorites: FavoriteRow[]
}

/** Read one instance's favorited jobs, with their current build and progress. */
export async function fetchFavorites(instanceId?: string): Promise<FavoritesPayload | ApiFailure> {
  const query = instanceId === undefined || instanceId.length === 0
    ? ''
    : `?instance=${encodeURIComponent(instanceId)}`
  return await request<FavoritesPayload>(`/jenkins-plugin/favorites${query}`)
}

/** Add or remove one favorite. */
export async function toggleFavorite(
  instanceId: string,
  path: string,
  name: string,
  favorited: boolean,
): Promise<{ ok: true, instanceId: string, favorites: FavoriteRow[] } | ApiFailure> {
  return await request('/jenkins-plugin/favorites/toggle', {
    method: 'POST',
    body: { instance: instanceId, path, name, favorited },
  })
}

/** One tracked build as the event stream reports it. */
export interface TrackedRow {
  id: string
  instanceId: string
  jobPath: string
  /** Absent while the build is still waiting in the queue. */
  buildNumber?: number
  /** The queue item a trigger answered, while there is no build number yet. */
  queueId?: number
  state: string
  outcome?: string
  /** Why a record is no longer followed, when it was detached. */
  note?: string
  progress?: ProgressRow
  stages?: StageRow[]
  /** Newest commits in this build, newest first (bounded by the host). */
  changes?: ChangeRow[]
  /** How many commits the build carries in total. */
  changeCount?: number
  polledAt: number
  intervalMs: number
}

/**
 * Parse the panel's parameter box, which holds one `name=value` per line.
 *
 * Jenkins takes build parameters as a flat form, so free text has to become a
 * string map. A line without a usable `name=` is reported rather than guessed
 * at: silently dropping it would trigger a build with the wrong parameters,
 * which is the one outcome a confirmation is there to prevent.
 * @param text - the box's contents.
 * @returns the parameters, or which line could not be read.
 */
export function parseParameters(
  text: string,
): { ok: true, parameters: Record<string, string> } | { ok: false, line: number, kind: 'no-equals' | 'empty-name' } {
  const parameters: Record<string, string> = {}
  const lines = text.split('\n')
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    // Blank lines and `#` comments are how a person groups a longer list, and a
    // parameter can never legitimately start with `#`.
    if (line.length === 0 || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 0) return { ok: false, line: index + 1, kind: 'no-equals' }
    const name = line.slice(0, separator).trim()
    if (name.length === 0) return { ok: false, line: index + 1, kind: 'empty-name' }
    parameters[name] = line.slice(separator + 1).trim()
  }
  return { ok: true, parameters }
}

/** What a build write answered. */
export interface TriggerPayload {
  ok: true
  instanceId: string
  job: string
  state: string
  queueId?: number
  url?: string
}

/** What an abort answered. */
export interface AbortPayload {
  ok: true
  instanceId: string
  job: string
  build: number
  aborted: boolean
  state: string
}

/** What handing a failed build to the model answered. */
export interface AnalyzePayload {
  ok: true
  instanceId: string
  sessionId: string
  job: string
  build: number
  outcome: string
  /** Bytes of log that were handed over. */
  logBytes: number
  /** Size of the whole log, when Jenkins stated it. */
  totalBytes?: number
  /** Whether only the tail was handed over. */
  truncated: boolean
}

/**
 * Start a build from the panel.
 *
 * The host answers with the queue item rather than a build, exactly as Jenkins
 * does, and follows it from there — so the build appears in the panel on its own.
 * @param instanceId - instance to build on.
 * @param jobPath - the job to build.
 * @param parameters - build parameters, empty for a job that takes none.
 * @returns the queue item, or a normalized failure (including a policy refusal).
 */
export async function triggerBuild(
  instanceId: string,
  jobPath: string,
  parameters: Readonly<Record<string, string>> = {},
): Promise<TriggerPayload | ApiFailure> {
  return await request('/jenkins-plugin/trigger', {
    method: 'POST',
    body: { instance: instanceId, job: jobPath, parameters },
  })
}

/**
 * Abort a running build from the panel.
 *
 * A build that already ended comes back as `aborted: false` rather than as an
 * error: the intent is satisfied either way.
 * @param instanceId - instance the build is on.
 * @param jobPath - the job the build belongs to.
 * @param build - the build number.
 * @returns the outcome, or a normalized failure (including a policy refusal).
 */
export async function abortBuild(
  instanceId: string,
  jobPath: string,
  build: number,
): Promise<AbortPayload | ApiFailure> {
  return await request('/jenkins-plugin/abort', {
    method: 'POST',
    body: { instance: instanceId, job: jobPath, build: String(build) },
  })
}

/**
 * Hand a failed build to the model, in this panel's own session.
 *
 * The answer does not come back here: the host queues a turn in the conversation
 * the panel belongs to, which is where a person is already reading. All this
 * returns is what was handed over, so the panel can say so.
 * @param instanceId - instance the build is on.
 * @param jobPath - the job the build belongs to.
 * @param build - the build number.
 * @param sessionId - the conversation to answer in.
 * @returns what was handed over, or a normalized failure.
 */
export async function analyzeFailure(
  instanceId: string,
  jobPath: string,
  build: number,
  sessionId: string,
): Promise<AnalyzePayload | ApiFailure> {
  return await request('/jenkins-plugin/analyze', {
    method: 'POST',
    body: { instance: instanceId, job: jobPath, build: String(build), session: sessionId },
  })
}

/**
 * Subscribe to the host's live build channel.
 *
 * The connection **is** the subscription: opening it arms the host poller and
 * closing it stops the polling, which is how "no subscribers, no polling" holds
 * without the panel having to say so. `builds` names what to follow, as
 * `<jobPath>#<buildNumber>` entries.
 * @param instanceId - instance to follow builds on.
 * @param builds - the builds to track; an empty list tracks nothing yet, which
 *   is still a valid subscription for a panel that has no build selected.
 * @param onSnapshot - called with each full snapshot the host sends.
 * @param onStatus - told when the stream opens and when it drops; the panel
 *   shows this rather than pretending stale figures are live.
 * @returns a function closing the stream.
 */
export function subscribeEvents(
  instanceId: string,
  builds: readonly string[],
  onSnapshot: (tracked: TrackedRow[]) => void,
  onStatus?: (state: 'open' | 'closed') => void,
): () => void {
  const query = new URLSearchParams({ instance: instanceId })
  if (builds.length > 0) query.set('builds', builds.join(','))
  const source = new EventSource(`/jenkins-plugin/events?${query.toString()}`)
  source.onopen = () => { onStatus?.('open') }
  // The browser retries on its own, so a drop is reported, not acted on: the
  // panel only has to stop labelling what it shows as live.
  source.onerror = () => { onStatus?.('closed') }
  source.addEventListener('snapshot', (event) => {
    try {
      onSnapshot(JSON.parse((event as MessageEvent).data) as TrackedRow[])
    } catch {
      // A malformed frame is dropped rather than tearing the panel down; the
      // next snapshot is a full one, so nothing is lost for good.
    }
  })
  return () => { source.close() }
}

/** Read one job with a page of its build history. */
export async function fetchJob(
  instanceId: string,
  jobPath: string,
  limit = 20,
  offset = 0,
): Promise<{ ok: true, detail: JobDetailRow, instanceId: string } | ApiFailure> {
  const query = new URLSearchParams({
    instance: instanceId,
    job: jobPath,
    limit: String(limit),
    offset: String(offset),
  })
  return await request(`/jenkins-plugin/job?${query.toString()}`)
}

/** Read one build's full detail. */
export async function fetchBuild(
  instanceId: string,
  jobPath: string,
  build: string,
): Promise<{ ok: true, detail: BuildDetailRow, instanceId: string } | ApiFailure> {
  const query = new URLSearchParams({ instance: instanceId, job: jobPath, build })
  return await request(`/jenkins-plugin/build?${query.toString()}`)
}

/** Read a page of one build's console log. */
export async function fetchLog(
  instanceId: string,
  jobPath: string,
  build: string,
  offset: number,
): Promise<{ ok: true, page: LogPageRow } | ApiFailure> {
  const query = new URLSearchParams({
    instance: instanceId,
    job: jobPath,
    build,
    offset: String(offset),
  })
  return await request(`/jenkins-plugin/log?${query.toString()}`)
}
