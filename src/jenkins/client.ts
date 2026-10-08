/**
 * Jenkins REST client. It owns HTTP transport concerns only — authentication,
 * CSRF crumbs, TLS trust, timeouts, byte bounds — and maps Jenkins responses
 * into the normalized vocabulary so callers never parse raw wire fields.
 *
 * `node:http`/`node:https` are used instead of `fetch` because a deployment may
 * need a custom CA or an explicitly untrusted certificate, which the global
 * fetch agent cannot express.
 * @module dsh-jenkins-plugin/jenkins/client
 */

import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { Config } from '../config.js'
import { buildOutcome, jobStatusFromColor, stageProgress } from './types.js'
import type {
  JenkinsArtifact,
  JenkinsBuildDetail,
  JenkinsBuildSummary,
  JenkinsChange,
  JenkinsJobDetail,
  JenkinsJobRef,
  JenkinsLogPage,
  JenkinsStage,
  JenkinsTestSummary,
  JenkinsWorkspaceEntry,
} from './types.js'

/** Why a Jenkins call failed, as a stable machine-readable category. */
export type JenkinsErrorCode = 'config' | 'auth' | 'not-found' | 'network' | 'timeout' | 'http'

/** One failed Jenkins call. */
export class JenkinsError extends Error {
  /** Stable failure category. */
  readonly code: JenkinsErrorCode
  /** HTTP status when the server answered. */
  readonly status: number | undefined

  /**
   * @param message - operator-facing explanation.
   * @param code - stable failure category.
   * @param status - HTTP status when the server answered.
   */
  constructor(message: string, code: JenkinsErrorCode, status?: number) {
    super(message)
    this.name = 'JenkinsError'
    this.code = code
    this.status = status
  }
}

/** Bounded raw response; `truncated` reports that the byte cap cut the body. */
interface JenkinsRawResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
  truncated: boolean
}

/** Per-call options shared by every client method. */
export interface JenkinsCallOptions {
  /** Caller-owned cancellation. */
  signal?: AbortSignal
  /** Byte cap applied to the response body. */
  maxBytes?: number
  /** Form-encoded request body, sent only by the mutating calls. */
  body?: string
}

/** Raw job row as returned by the Jenkins `tree` query. */
interface RawJob {
  name?: unknown
  url?: unknown
  color?: unknown
  _class?: unknown
  lastBuild?: unknown
}

/** Raw build row as returned by the Jenkins `tree` query. */
interface RawBuild {
  number?: unknown
  result?: unknown
  building?: unknown
  timestamp?: unknown
  duration?: unknown
  url?: unknown
  displayName?: unknown
  description?: unknown
  estimatedDuration?: unknown
}

/** Caps one job listing so a large controller cannot exhaust memory. */
const MAX_JOBS = 2000

/** Folder nesting the listing walks before it stops descending. */
const MAX_FOLDER_DEPTH = 6

/**
 * Build aliases and the job field each one names.
 *
 * Jenkins exposes these as separate `lastXBuild` fields on the job, which is
 * what makes them resolvable even on endpoints that reject the alias itself.
 */
const ALIAS_FIELDS: Readonly<Record<string, 'lastBuild' | 'lastSuccessfulBuild' | 'lastFailedBuild'>> = {
  last: 'lastBuild',
  lastSuccessful: 'lastSuccessfulBuild',
  lastFailed: 'lastFailedBuild',
}

/** Build the `/job/<segment>` URL prefix of one job path. */
function jobBase(jobPath: string): string {
  const segments = jobPath.split('/').filter(segment => segment.length > 0)
  if (segments.length === 0) throw new JenkinsError('job path is empty', 'config')
  return segments.map(segment => `/job/${encodeURIComponent(segment)}`).join('')
}

/** Build the URL prefix of one folder path, empty for the controller root. */
function folderBase(jobPath: string): string {
  return jobPath
    .split('/')
    .filter(segment => segment.length > 0)
    .map(segment => `/job/${encodeURIComponent(segment)}`)
    .join('')
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Map one raw build row into the normalized summary. */
function mapBuild(build: RawBuild): JenkinsBuildSummary {
  const result = typeof build.result === 'string' ? build.result : null
  const building = build.building === true
  const displayName = asString(build.displayName)
  const description = asString(build.description)
  const estimated = asNumber(build.estimatedDuration)
  return {
    number: asNumber(build.number),
    result,
    outcome: buildOutcome(result, building),
    building,
    timestamp: asNumber(build.timestamp),
    duration: asNumber(build.duration),
    url: asString(build.url),
    ...displayName.length === 0 ? {} : { displayName },
    ...description.length === 0 ? {} : { description },
    ...estimated <= 0 ? {} : { estimatedDuration: estimated },
  }
}

/** Read one numeric header, ignoring absent or unparsable values. */
function headerNumber(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Read the run cause out of a build's `actions` array.
 *
 * Jenkins buries it in an action whose shape differs per trigger plugin, so the
 * only portable field is the short description the UI itself shows.
 * @param actions - raw `actions` array.
 * @returns the first cause description, or undefined.
 */
function causeOf(actions: unknown): string | undefined {
  if (!Array.isArray(actions)) return undefined
  for (const action of actions) {
    if (typeof action !== 'object' || action === null) continue
    const causes = (action as { causes?: unknown }).causes
    if (!Array.isArray(causes)) continue
    for (const cause of causes) {
      if (typeof cause !== 'object' || cause === null) continue
      const text = asString((cause as { shortDescription?: unknown }).shortDescription)
      if (text.length > 0) return text
    }
  }
  return undefined
}

/**
 * Read the build parameters out of a build's `actions` array.
 *
 * Parameters are what a rebuild has to reuse, and Jenkins reports them as an
 * action with a `parameters` array of `{name, value}` — the same place the UI
 * reads them from. A value is stringified because a boolean or choice parameter
 * comes back as whatever type the plugin decided, and the form this plugin sends
 * is strings.
 * @param actions - raw `actions` array.
 * @returns the parameters, or undefined when the build was not parameterized.
 */
function parametersOf(actions: unknown): Record<string, string> | undefined {
  if (!Array.isArray(actions)) return undefined
  for (const action of actions) {
    if (typeof action !== 'object' || action === null) continue
    const parameters = (action as { parameters?: unknown }).parameters
    if (!Array.isArray(parameters)) continue
    const mapped: Record<string, string> = {}
    for (const parameter of parameters) {
      if (typeof parameter !== 'object' || parameter === null) continue
      const row = parameter as { name?: unknown, value?: unknown }
      const name = asString(row.name)
      if (name.length === 0 || row.value === undefined || row.value === null) continue
      mapped[name] = typeof row.value === 'string' ? row.value : JSON.stringify(row.value)
    }
    if (Object.keys(mapped).length > 0) return mapped
  }
  return undefined
}

/** Map a build's `changeSet` into commit rows. */
function mapChanges(changeSet: unknown): JenkinsChange[] {
  if (typeof changeSet !== 'object' || changeSet === null) return []
  const items = (changeSet as { items?: unknown }).items
  if (!Array.isArray(items)) return []
  return items.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const row = item as {
      commitId?: unknown
      author?: unknown
      msg?: unknown
      comment?: unknown
      timestamp?: unknown
    }
    const author = typeof row.author === 'object' && row.author !== null
      ? asString((row.author as { fullName?: unknown }).fullName)
      : asString(row.author)
    // `msg` is the commit subject; `comment` carries the rest when the SCM sent one.
    const subject = asString(row.msg)
    const comment = asString(row.comment)
    return [{
      commitId: asString(row.commitId),
      author,
      message: subject.length > 0 ? subject : comment,
      timestamp: asNumber(row.timestamp),
    }]
  })
}

/** Map a build's `artifacts` into download rows. */
function mapArtifacts(artifacts: unknown, jobPath: string, buildNumber: number): JenkinsArtifact[] {
  if (!Array.isArray(artifacts)) return []
  const root = `${jobBase(jobPath)}/${buildNumber}/artifact/`
  return artifacts.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const row = entry as { fileName?: unknown, relativePath?: unknown, displayPath?: unknown }
    const name = asString(row.fileName)
    const relative = asString(row.relativePath)
    if (name.length === 0) return []
    return [{
      name,
      path: relative.length === 0 ? name : relative,
      size: 0,
      url: `${root}${relative.length === 0
        ? encodeURIComponent(name)
        : relative.split('/').map(segment => encodeURIComponent(segment)).join('/')}`,
    }]
  })
}

/**
 * Map a workspace listing's `list` array into normalized entries.
 * @param list - raw `list` array from the workspace API.
 * @param directory - the workspace-relative directory these entries sit in.
 * @returns the entries, in Jenkins' order.
 */
function mapWorkspace(list: unknown[] | undefined, directory: string): JenkinsWorkspaceEntry[] {
  return (list ?? []).flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const row = entry as Record<string, unknown>
    const name = asString(row.name)
    if (name.length === 0) return []
    return [{
      name,
      path: directory.length === 0 ? name : `${directory}/${name}`,
      directory: row.type === 'dir',
      size: asNumber(row.size),
      modifiedAt: asNumber(row.lastModified),
    }]
  })
}

/**
 * Read the queue item id out of a `Location` header.
 *
 * Jenkins answers a trigger with `/queue/item/<id>/`, so the id is the segment
 * before the trailing slash.
 * @param location - the response's `Location` header, if any.
 * @returns the numeric id, or undefined when the header is absent or unusual.
 */
function queueIdOf(location: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(location) ? location[0] : location
  if (typeof raw !== 'string') return undefined
  const match = /\/queue\/item\/(\d+)/.exec(raw)
  if (match === null) return undefined
  const parsed = Number.parseInt(match[1] as string, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Recover a job path from a build URL.
 *
 * Jenkins publishes build URLs as `/job/<folder>/job/<name>/<number>/`, so the
 * `job/`-separated segments are the job path and the trailing number is the
 * build. This is the inverse of {@link jobBase} and the only way to learn which
 * job a queue item produced.
 * @param url - the build's absolute or relative URL.
 * @param root - the controller root the URL resolves against.
 * @returns the job path, or undefined when the URL is not a build URL.
 */
function jobPathOf(url: string, root: URL): string | undefined {
  if (url.length === 0) return undefined
  let pathname: string
  try {
    pathname = new URL(url, root).pathname
  } catch {
    return undefined
  }
  const segments = pathname.split('/').filter(segment => segment.length > 0)
  const names: string[] = []
  let index = 0
  while (segments[index] === 'job' && segments[index + 1] !== undefined) {
    names.push(decodeURIComponent(segments[index + 1] as string))
    index += 2
  }
  if (names.length === 0 || index >= segments.length) return undefined
  return names.join('/')
}

/**
 * Encode a `tree` expression for a query string.
 *
 * Jenkins' tree grammar is bracket- and comma-heavy, and a controller that
 * rejects the raw characters answers HTTP 400 — measured against a live
 * Jenkins, where `tree=jobs[name,url]` unencoded is a 400 and the same
 * expression percent-encoded is a 200. Brackets and commas are technically
 * legal in a query string, so every client has to agree to encode them; this
 * one does.
 * @param expression - the human-readable tree expression.
 * @returns the value to place after `tree=`.
 */
function tree(expression: string): string {
  return encodeURIComponent(expression)
}

/** Jenkins REST client bound to one configured instance and credential. */
export class JenkinsClient {
  private readonly root: URL
  private resolvedCrumb: { field: string; value: string } | undefined
  private crumbLookup: Promise<{ field: string; value: string } | undefined> | undefined
  private caFile: Promise<Buffer> | undefined

  /**
   * @param config - validated plugin configuration.
   * @param resolveToken - reads the API token for one call, so a rotated
   *   credential applies to the next request without a restart.
   */
  constructor(
    private readonly config: Config,
    private readonly resolveToken: () => Promise<string>,
  ) {
    this.root = new URL(config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`)
  }

  /** Absolute Jenkins URL of a job path, used for links the panel opens. */
  jobUrl(jobPath: string): string {
    return new URL(`${jobBase(jobPath).replace(/^\//, '')}`, this.root).toString()
  }

  /**
   * List every job reachable from the controller root, walking folders.
   * @param options - cancellation and byte bound.
   * @returns jobs in Jenkins folder order, capped at {@link MAX_JOBS}.
   */
  async listJobs(options: JenkinsCallOptions = {}): Promise<JenkinsJobRef[]> {
    const collected: JenkinsJobRef[] = []
    await this.collectJobs('', collected, options, 0)
    return collected
  }

  /**
   * Read the most recent builds of one job.
   * @param jobPath - folder path of the job.
   * @param limit - maximum builds to return.
   * @param options - cancellation and byte bound.
   * @returns builds newest first.
   */
  async jobBuilds(jobPath: string, limit: number, options: JenkinsCallOptions = {}): Promise<JenkinsBuildSummary[]> {
    const bounded = Math.max(1, Math.min(50, Math.trunc(limit)))
    const payload = await this.requestJson<{ builds?: RawBuild[] }>(
      `${jobBase(jobPath)}/api/json?tree=${tree(`builds[number,result,building,timestamp,duration,url,displayName,description]{0,${bounded}}`)}`,
      options,
    )
    return (payload.builds ?? []).map(build => mapBuild(build))
  }

  /**
   * Read one job with a page of its build history.
   *
   * This is what the panel's job view opens with, so it asks for the job's own
   * metadata and one history page in a single request rather than walking the
   * whole controller again.
   * @param jobPath - folder path of the job.
   * @param limit - build rows to return.
   * @param offset - build rows to skip, for paging deeper into history.
   * @param options - cancellation and byte bound.
   * @returns the job and its history page.
   */
  async jobDetail(
    jobPath: string,
    limit: number,
    offset = 0,
    options: JenkinsCallOptions = {},
  ): Promise<JenkinsJobDetail> {
    const bounded = Math.max(1, Math.min(50, Math.trunc(limit)))
    const skip = Math.max(0, Math.trunc(offset))
    const payload = await this.requestJson<{
      name?: unknown
      url?: unknown
      color?: unknown
      _class?: unknown
      lastBuild?: unknown
      nextBuildNumber?: unknown
      builds?: RawBuild[]
    }>(
      `${jobBase(jobPath)}/api/json?tree=${tree(
        `name,url,color,_class,nextBuildNumber,`
        + `builds[number,result,building,timestamp,duration,url,displayName,description]{${skip},${bounded}}`,
      )}`,
      options,
    )
    const name = asString(payload.name)
    const lastBuild = typeof payload.lastBuild === 'object' && payload.lastBuild !== null
      ? mapBuild(payload.lastBuild as RawBuild)
      : undefined
    const builds = (payload.builds ?? []).map(build => mapBuild(build))
    // Jenkins' `{offset,count}` page does not report the total, so the total is
    // only known when the returned page is short (the end of history) or when
    // the job's own next-build counter brackets it.
    const next = asNumber(payload.nextBuildNumber)
    const reachedEnd = builds.length < bounded
    return {
      job: {
        path: jobPath,
        name: name.length === 0 ? jobPath.split('/').at(-1) ?? jobPath : name,
        url: asString(payload.url),
        status: jobStatusFromColor(payload.color),
        ...lastBuild === undefined ? {} : { lastBuild },
      },
      builds,
      ...reachedEnd || next === 0 ? {} : { totalBuilds: next - 1 },
    }
  }

  /**
   * Resolve a build selector to a concrete number.
   *
   * SPEC §2 allows `last`, `lastSuccessful`, and `lastFailed` as aliases, but
   * Jenkins only honours them on *some* endpoints: `/consoleText` accepts them
   * while `<build>/api/json` does not, and asking it for `last` is a 404 (measured
   * against a live controller). Resolving here means every caller can pass an
   * alias and reach an endpoint that only speaks numbers.
   * @param jobPath - folder path of the job.
   * @param selector - build number or alias.
   * @param options - cancellation and byte bound.
   * @returns the concrete build number.
   */
  async resolveBuildNumber(
    jobPath: string,
    selector: string,
    options: JenkinsCallOptions = {},
  ): Promise<number> {
    const numeric = Number.parseInt(selector, 10)
    if (/^\d+$/.test(selector.trim()) && Number.isFinite(numeric)) return numeric
    const field = ALIAS_FIELDS[selector.trim()]
    if (field === undefined) {
      throw new JenkinsError(
        `"${selector}" is not a build number or one of last/lastSuccessful/lastFailed`,
        'config',
      )
    }
    const payload = await this.requestJson<{ lastBuild?: RawBuild, lastSuccessfulBuild?: RawBuild, lastFailedBuild?: RawBuild }>(
      `${jobBase(jobPath)}/api/json?tree=${tree('lastBuild[number],lastSuccessfulBuild[number],lastFailedBuild[number]')}`,
      options,
    )
    const row = payload[field]
    if (typeof row !== 'object' || row === null) {
      throw new JenkinsError(`job ${jobPath} has no ${selector} build`, 'not-found', 404)
    }
    return asNumber((row as RawBuild).number)
  }

  /**
   * Read one build's full detail: the summary plus stages, changes, tests, and
   * artifacts.
   *
   * Stages come from the workflow API, which only Pipeline jobs have; a job
   * type without it is reported as `hasStages: false` rather than as an error,
   * because "this job has no stages" is a fact the panel has to state.
   * @param jobPath - folder path of the job.
   * @param selector - build number, or an alias such as `last`.
   * @param options - cancellation and byte bound.
   * @returns the detail.
   */
  async buildDetail(
    jobPath: string,
    selector: string,
    options: JenkinsCallOptions = {},
  ): Promise<JenkinsBuildDetail> {
    const number = await this.resolveBuildNumber(jobPath, selector, options)
    const payload = await this.requestJson<RawBuild & {
      displayName?: unknown
      description?: unknown
      estimatedDuration?: unknown
      actions?: unknown
      changeSet?: unknown
      artifacts?: unknown
    }>(
      `${jobBase(jobPath)}/${number}/api/json?tree=${tree(
        'number,result,building,timestamp,duration,estimatedDuration,url,displayName,description,'
        + 'actions[causes[shortDescription],parameters[name,value]],'
        + 'changeSet[items[commitId,author[fullName],msg,comment,timestamp,date]]'
        + ',artifacts[fileName,relativePath,displayPath]',
      )}`,
      options,
    )
    const summary = mapBuild(payload)
    const stages = await this.stages(jobPath, summary.number, options)
    const tests = await this.testSummary(jobPath, summary.number, options)
    const cause = causeOf(payload.actions)
    const parameters = parametersOf(payload.actions)
    return {
      ...summary,
      stages,
      progress: stageProgress(stages),
      hasStages: stages.length > 0,
      changes: mapChanges(payload.changeSet),
      tests,
      artifacts: mapArtifacts(payload.artifacts, jobPath, summary.number),
      estimatedDuration: asNumber(payload.estimatedDuration),
      ...cause === undefined ? {} : { cause },
      ...parameters === undefined ? {} : { parameters },
    }
  }

  /**
   * Read a page of a build's console log.
   *
   * `offset` is a byte offset into the whole log, and `{start}` makes Jenkins
   * answer that slice plus its own `X-Text-Size` and `X-More-Data` headers, so
   * the caller can follow a running build without re-reading what it has.
   * @param jobPath - folder path of the job.
   * @param selector - build number, or a Jenkins alias such as `last`.
   * @param offset - byte offset to start at.
   * @param maxBytes - byte cap on this page.
   * @param options - cancellation and byte bound.
   * @returns the log page.
   */
  /**
   * Read a page of a build's console log.
   *
   * Written against what controllers actually do rather than what the endpoint
   * documents. Measured on Jenkins 2.176.2 behind nginx: `?start=` is **ignored**
   * (a request for `start=2048` returns the same 102,664 bytes as `start=0`), and
   * neither `X-Text-Size` nor `X-More-Data` is sent — only `Content-Length`.
   * Progressive reading therefore cannot be delegated to the server, so this
   * reads one bounded body and slices the requested window out of it locally.
   *
   * Consequences, which callers must respect:
   * - `offset` is applied to the fetched body, so it is exact when the whole log
   *   fits the byte cap and a best effort when it does not.
   * - `moreData` means "the log continued past what was read", which is
   *   knowable from the byte cap or a stated size — never from a header this
   *   controller does not send.
   * @param jobPath - folder path of the job.
   * @param selector - build number, or a Jenkins alias such as `last`.
   * @param offset - byte offset to start at.
   * @param maxBytes - byte cap on the body read.
   * @param options - cancellation and byte bound.
   * @returns the log page.
   */
  async consoleLog(
    jobPath: string,
    selector: string,
    offset: number,
    maxBytes: number,
    options: JenkinsCallOptions = {},
  ): Promise<JenkinsLogPage> {
    const start = Math.max(0, Math.trunc(offset))
    const number = await this.resolveBuildNumber(jobPath, selector, options)
    // The body is read with its OWN cap, not the caller's page size: because the
    // controller ignores `?start=`, a page-sized read would hand back the head of
    // a long log and call it the tail. A generous read window is what makes the
    // requested window computable at all.
    const window = Math.max(maxBytes, this.config.logReadBytes)
    const page = await this.readConsole(number, jobPath, 0, window, options)
    // `x-text-size` is the log's size and wins; `content-length` describes only
    // this response, so it is the fallback for a controller that sends no
    // `x-text-size` (Jenkins 2.176.2 behind nginx sends none). Preferring
    // `content-length` when both exist would read a truncated body as a complete
    // short log — the precise mistake that made a tail return the head.
    const stated = page.totalSize ?? headerNumber(page.headers['content-length'])
    const readBytes = Buffer.byteLength(page.text, 'utf8')

    // A body cut at the read window says nothing about the log's real size, so
    // the known size replaces it rather than being compared against it.
    const totalSize = page.truncated && stated !== undefined && stated !== readBytes
      ? stated
      : stated !== undefined && stated >= readBytes ? stated : readBytes
    const capped = readBytes < totalSize

    const text = page.text
    /** Report a window of the fetched body, or that it lies past it. */
    const slice = (from: number): JenkinsLogPage => {
      if (from >= readBytes) {
        return { text: '', nextOffset: from, moreData: capped, truncated: capped, totalSize }
      }
      const tail = from === 0 ? text : text.slice(from)
      return {
        text: tail,
        nextOffset: from + Buffer.byteLength(tail, 'utf8'),
        moreData: capped,
        truncated: capped,
        totalSize,
      }
    }

    if (start === 0 && maxBytes > 0 && readBytes > maxBytes && !capped) {
      // The tail is what a caller wants by default: the start of a build log is
      // its least interesting part. Slicing by bytes can cut a line in half, so
      // the partial first line is dropped.
      const from = readBytes - maxBytes
      const windowText = text.slice(from)
      const firstBreak = windowText.indexOf('\n')
      const body = firstBreak < 0 ? windowText : windowText.slice(firstBreak + 1)
      return { text: body, nextOffset: readBytes, moreData: false, truncated: false, totalSize }
    }
    return slice(start)
  }

  /** Read one console body and interpret whatever headers came with it. */
  private async readConsole(
    number: number,
    jobPath: string,
    start: number,
    maxBytes: number,
    options: JenkinsCallOptions,
  ): Promise<JenkinsLogPage & { headers: Record<string, string | string[] | undefined> }> {
    const response = await this.send(
      'GET',
      `${jobBase(jobPath)}/${number}/consoleText?start=${start}`,
      { ...options, maxBytes: options.maxBytes ?? maxBytes },
    )
    if (response.status === 401 || response.status === 403) {
      throw new JenkinsError(
        `Jenkins rejected the credential (HTTP ${response.status}); check username and tokenRef`,
        'auth',
        response.status,
      )
    }
    if (response.status === 404) {
      throw new JenkinsError(`Jenkins has no console log at ${jobPath}#${number}`, 'not-found', 404)
    }
    if (response.status < 200 || response.status >= 300) {
      throw new JenkinsError(
        `Jenkins answered HTTP ${response.status} for the console log of ${jobPath}#${number}`,
        'http',
        response.status,
      )
    }
    const bodyBytes = Buffer.byteLength(response.body, 'utf8')
    const sizeHeader = headerNumber(response.headers['x-text-size'])
    return {
      text: response.body,
      nextOffset: sizeHeader ?? bodyBytes,
      moreData: response.truncated,
      truncated: response.truncated,
      ...sizeHeader === undefined ? {} : { totalSize: sizeHeader },
      headers: response.headers,
    }
  }

  /**
   * List one directory of a build's workspace.
   *
   * The workspace REST surface is an optional Jenkins plugin, so a controller
   * without it answers 404 for every workspace path — including the job-level
   * one. That absence is reported as `available: false` rather than thrown:
   * "this Jenkins cannot list workspaces" is a fact the panel and the tool must
   * state, and it is not the same thing as an empty directory.
   * @param jobPath - folder path of the job.
   * @param selector - build number, or a Jenkins alias such as `last`.
   * @param directory - workspace-relative directory; empty for the root.
   * @param options - cancellation and byte bound.
   * @returns the entries plus whether the controller supports the surface.
   */
  async workspace(
    jobPath: string,
    selector: string,
    directory: string,
    options: JenkinsCallOptions = {},
  ): Promise<{ available: boolean, entries: JenkinsWorkspaceEntry[] }> {
    const relative = directory.replace(/^\/+|\/+$/g, '')
    const suffix = relative.length === 0
      ? ''
      : `${relative.split('/').map(segment => encodeURIComponent(segment)).join('/')}/`
    let payload: { list?: unknown[] }
    try {
      payload = await this.requestJson<{ list?: unknown[] }>(
        `${jobBase(jobPath)}/${encodeURIComponent(selector)}/ws/${suffix}api/json`,
        options,
      )
    } catch (error) {
      if (error instanceof JenkinsError && error.code === 'not-found') return { available: false, entries: [] }
      throw error
    }
    return { available: true, entries: mapWorkspace(payload.list, relative) }
  }

  /**
   * Read a build's test totals.
   *
   * Jenkins nests a pass/fail/skip tree under `testReport`; the totals live on
   * the report node, so this walks the tree iteratively rather than recursively
   * — a suite hierarchy can be arbitrarily deep and a recursive walk would put
   * its depth on the stack. A build with no test report answers 404, which is
   * reported as `null`: "no tests" is a fact, not a failure.
   * @param jobPath - folder path of the job.
   * @param buildNumber - numeric build number.
   * @param options - cancellation and byte bound.
   * @returns totals, or null when the build has no test report.
   */
  async testSummary(
    jobPath: string,
    buildNumber: number,
    options: JenkinsCallOptions = {},
  ): Promise<JenkinsTestSummary | null> {
    let payload: { failCount?: unknown, skipCount?: unknown, totalCount?: unknown, childReports?: unknown }
    try {
      payload = await this.requestJson(
        `${jobBase(jobPath)}/${buildNumber}/testReport/api/json?tree=${tree(
          'failCount,skipCount,totalCount,childReports[result[failCount,skipCount,totalCount]]',
        )}`,
        options,
      )
    } catch (error) {
      // No test report at all is a 404 on this endpoint (or an empty body on
      // some versions); both mean the build ran no tests.
      if (error instanceof JenkinsError && (error.code === 'not-found' || error.code === 'http')) return null
      throw error
    }
    let failed = asNumber(payload.failCount)
    let skipped = asNumber(payload.skipCount)
    let total = asNumber(payload.totalCount)
    // A Pipeline build reports its tests through child reports instead, and the
    // parent totals are zero while the children carry the real numbers.
    if (Array.isArray(payload.childReports)) {
      for (const child of payload.childReports) {
        if (typeof child !== 'object' || child === null) continue
        const result = (child as { result?: unknown }).result
        if (typeof result !== 'object' || result === null) continue
        const row = result as { failCount?: unknown, skipCount?: unknown, totalCount?: unknown }
        failed += asNumber(row.failCount)
        skipped += asNumber(row.skipCount)
        total += asNumber(row.totalCount)
      }
    }
    if (total === 0 && failed === 0 && skipped === 0) return null
    return { total, failed, skipped, passed: Math.max(0, total - failed - skipped) }
  }

  /**
   * Read the project version a Maven build reported.
   *
   * A Maven job publishes its modules under `mavenArtifacts`, one record per
   * module with the artifact coordinates; the version is what the panel's card
   * shows. The endpoint answers 404 for a job that is not a Maven project, which
   * is the ordinary case on a controller full of Freestyle jobs, and it reports
   * nothing until the build has produced its artifacts — a running Maven build
   * usually has no version to give yet, and this returns `undefined` rather than
   * guessing one.
   *
   * Nothing here ever throws: a version is decoration on a card, and a failure
   * to read one must not be able to affect the build it decorates (a thrown
   * `not-found` would, one layer up, make the tracker drop the record).
   * @param jobPath - folder path of the job.
   * @param buildNumber - numeric build number.
   * @param options - cancellation and byte bound.
   * @returns the version, or undefined when Jenkins reports none.
   */
  async mavenVersion(
    jobPath: string,
    buildNumber: number,
    options: JenkinsCallOptions = {},
  ): Promise<string | undefined> {
    let payload: { moduleRecords?: unknown }
    try {
      payload = await this.requestJson(`${jobBase(jobPath)}/${buildNumber}/mavenArtifacts/api/json`, options)
    } catch {
      return undefined
    }
    if (!Array.isArray(payload.moduleRecords)) return undefined
    for (const record of payload.moduleRecords) {
      if (typeof record !== 'object' || record === null) continue
      const row = record as { mainArtifact?: unknown, pomArtifact?: unknown }
      // The main artifact is the module's own jar; the pom carries the same
      // version, so it is the fallback for a module that only produced a pom.
      for (const artifact of [row.mainArtifact, row.pomArtifact]) {
        if (typeof artifact !== 'object' || artifact === null) continue
        const version = asString((artifact as { version?: unknown }).version)
        if (version.length > 0) return version
      }
    }
    return undefined
  }

  /**
   * Trigger a build.
   *
   * Jenkins answers a queue item, not a build: the build number does not exist
   * until a executor picks the item up, which is why the caller tracks a
   * `queueId` before it ever sees a `buildNumber` (SPEC §8).
   * @param jobPath - folder path of the job.
   * @param parameters - form parameters for a parameterized job.
   * @param options - cancellation and byte bound.
   * @returns the queue item's absolute URL and its id.
   */
  async trigger(
    jobPath: string,
    parameters: Readonly<Record<string, string>> = {},
    options: JenkinsCallOptions = {},
  ): Promise<{ queueUrl: string, queueId?: number }> {
    const hasParameters = Object.keys(parameters).length > 0
    const path = hasParameters
      ? `${jobBase(jobPath)}/buildWithParameters`
      : `${jobBase(jobPath)}/build`
    const body = new URLSearchParams(parameters).toString()
    const response = await this.send('POST', path, { ...options, body })
    return { ...await this.expectAccepted(response, path), queueId: queueIdOf(response.headers.location) }
  }

  /**
   * Abort a running build.
   *
   * Jenkins answers 200/302/404 here; a 404 means the build already ended, which
   * the caller reports as "nothing to abort" rather than as a failure.
   * @param jobPath - folder path of the job.
   * @param buildNumber - numeric build number.
   * @param options - cancellation and byte bound.
   */
  async cancel(jobPath: string, buildNumber: number, options: JenkinsCallOptions = {}): Promise<void> {
    const path = `${jobBase(jobPath)}/${buildNumber}/stop`
    const response = await this.send('POST', path, options)
    if (response.status === 404) {
      throw new JenkinsError(`build ${jobPath}#${buildNumber} no longer exists`, 'not-found', 404)
    }
    await this.expectAccepted(response, path)
  }

  /**
   * Read a queue item's state, which is how a triggered build is followed until
   * it is assigned a build number.
   * @param queueUrl - the item's absolute or root-relative URL.
   * @param options - cancellation and byte bound.
   * @returns whether the item still waits and the build it became, if any.
   */
  async queueItem(
    queueUrl: string,
    options: JenkinsCallOptions = {},
  ): Promise<{ waiting: boolean, why?: string, buildNumber?: number, jobPath?: string }> {
    const absolute = new URL(queueUrl, this.root)
    const path = `${absolute.pathname.replace(/^\/+/, '')}/api/json?tree=${tree('why,executable[number,url]')}`
    const payload = await this.requestJson<{ why?: unknown, executable?: unknown }>(path, options)
    const why = asString(payload.why)
    const executable = payload.executable
    if (typeof executable !== 'object' || executable === null) {
      return { waiting: true, ...why.length === 0 ? {} : { why } }
    }
    const row = executable as { number?: unknown, url?: unknown }
    const jobPath = jobPathOf(asString(row.url), this.root)
    return {
      waiting: false,
      buildNumber: asNumber(row.number),
      ...jobPath === undefined ? {} : { jobPath },
    }
  }

  /** Map a non-2xx response onto the shared failure vocabulary. */
  private async expectAccepted(response: JenkinsRawResponse, path: string): Promise<{ queueUrl: string }> {
    if (response.status === 401 || response.status === 403) {
      throw new JenkinsError(
        `Jenkins rejected the credential (HTTP ${response.status}); check username and tokenRef`,
        'auth',
        response.status,
      )
    }
    if (response.status === 404) {
      throw new JenkinsError(`Jenkins has no resource at ${path}`, 'not-found', 404)
    }
    if (response.status < 200 || response.status >= 400) {
      throw new JenkinsError(
        `Jenkins answered HTTP ${response.status} for ${path}`
        + (response.body.length === 0 ? '' : `: ${response.body.slice(0, 200)}`),
        'http',
        response.status,
      )
    }
    const location = response.headers.location
    const relative = Array.isArray(location) ? location[0] : location
    return { queueUrl: relative === undefined ? '' : new URL(relative, this.root).toString() }
  }

  /**
   * Confirm the configured credential works and report whose it is.
   *
   * Jenkins answers `/me/api/json` only to an authenticated caller, so this is
   * the probe the panel's "connect" action runs: it distinguishes a wrong token
   * (401/403) from a wrong URL (network) in one request, before any job listing.
   * @param options - cancellation and byte bound.
   * @returns the authenticated identity as Jenkins reports it.
   */
  async whoAmI(options: JenkinsCallOptions = {}): Promise<{ id: string, fullName: string }> {
    const payload = await this.requestJson<{ id?: unknown, fullName?: unknown }>('me/api/json', options)
    return { id: asString(payload.id), fullName: asString(payload.fullName) }
  }

  /**
   * Read one build of a job.
   * @param jobPath - folder path of the job.
   * @param selector - build number, or a Jenkins alias such as `last`.
   * @param options - cancellation and byte bound.
   * @returns the build summary.
   */
  async build(jobPath: string, selector: string, options: JenkinsCallOptions = {}): Promise<JenkinsBuildSummary> {
    const payload = await this.requestJson<RawBuild>(
      `${jobBase(jobPath)}/${encodeURIComponent(selector)}/api/json`
      + `?tree=${tree('number,result,building,timestamp,duration,url')}`,
      options,
    )
    return mapBuild(payload)
  }

  /**
   * Read the Pipeline stages of one build.
   * @param jobPath - folder path of the job.
   * @param buildNumber - numeric build number.
   * @param options - cancellation and byte bound.
   * @returns stages in execution order; empty when the build is not a Pipeline.
   */
  async stages(jobPath: string, buildNumber: number, options: JenkinsCallOptions = {}): Promise<JenkinsStage[]> {
    let payload: { stages?: unknown }
    try {
      payload = await this.requestJson<{ stages?: unknown }>(
        `${jobBase(jobPath)}/${buildNumber}/wfapi/describe`,
        options,
      )
    } catch (error) {
      // A Freestyle build has no workflow API; that absence is a fact, not a failure.
      if (error instanceof JenkinsError && error.code === 'not-found') return []
      throw error
    }
    const raw = Array.isArray(payload.stages) ? payload.stages : []
    return raw.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return []
      const stage = entry as { name?: unknown; status?: unknown; startTimeMillis?: unknown; durationMillis?: unknown }
      const name = asString(stage.name)
      if (name.length === 0) return []
      const startedAt = typeof stage.startTimeMillis === 'number' ? stage.startTimeMillis : undefined
      const durationMs = typeof stage.durationMillis === 'number' ? stage.durationMillis : undefined
      return [{
        name,
        status: asString(stage.status),
        ...startedAt === undefined ? {} : { startedAt },
        ...durationMs === undefined ? {} : { durationMs },
      }]
    })
  }

  /** Walk folders from the controller root, appending non-folder jobs. */
  private async collectJobs(
    jobPath: string,
    out: JenkinsJobRef[],
    options: JenkinsCallOptions,
    depth: number,
  ): Promise<void> {
    if (depth > MAX_FOLDER_DEPTH || out.length >= MAX_JOBS) return
    // One folder's listing is bounded so a very large controller cannot exhaust
    // memory before `MAX_JOBS` stops the walk.
    const payload = await this.requestJson<{ jobs?: RawJob[] }>(
      `${folderBase(jobPath)}/api/json?tree=${tree('jobs[name,url,color,_class,lastBuild[number,result,building,timestamp,duration,estimatedDuration,url]]')}`,
      { ...options, maxBytes: options.maxBytes ?? this.config.maxListingBytes },
    )
    if (payload.jobs === undefined) {
      throw new JenkinsError(
        `Jenkins answered no job list for "${jobPath.length === 0 ? '/' : jobPath}"`,
        'http',
      )
    }
    for (const raw of payload.jobs) {
      if (out.length >= MAX_JOBS) return
      const name = asString(raw.name)
      if (name.length === 0) continue
      const childPath = jobPath.length === 0 ? name : `${jobPath}/${name}`
      const className = asString(raw._class)
      if (className.endsWith('Folder')) {
        await this.collectJobs(childPath, out, options, depth + 1)
        continue
      }
      // A job that never ran has no `lastBuild`; the panel shows "not built yet"
      // for it rather than an invented build number.
      const lastBuild = typeof raw.lastBuild === 'object' && raw.lastBuild !== null
        ? mapBuild(raw.lastBuild as RawBuild)
        : undefined
      out.push({
        path: childPath,
        name,
        url: asString(raw.url),
        status: jobStatusFromColor(raw.color),
        ...lastBuild === undefined ? {} : { lastBuild },
      })
    }
  }

  /** Send one request and decode JSON, mapping status codes to failures. */
  private async requestJson<T>(path: string, options: JenkinsCallOptions): Promise<T> {
    const response = await this.send('GET', path, options)
    if (response.status === 401 || response.status === 403) {
      throw new JenkinsError(
        `Jenkins rejected the credential (HTTP ${response.status}); check username and tokenRef`,
        'auth',
        response.status,
      )
    }
    if (response.status === 404) {
      throw new JenkinsError(`Jenkins has no resource at ${path}`, 'not-found', 404)
    }
    if (response.status < 200 || response.status >= 300) {
      throw new JenkinsError(`Jenkins answered HTTP ${response.status} for ${path}`, 'http', response.status)
    }
    try {
      return JSON.parse(response.body) as T
    } catch {
      // A body cut off at the byte cap parses as nothing, so it is reported as
      // the bound it hit rather than as malformed content — the operator's fix
      // is a larger cap, not a bug report against Jenkins.
      if (response.truncated) {
        throw new JenkinsError(
          `Jenkins response for ${path} passed the ${options.maxBytes ?? 0}-byte cap and could not be decoded;`
          + ' narrow the request or raise the cap',
          'http',
          response.status,
        )
      }
      // Every other parse failure means genuinely non-JSON content.
      throw new JenkinsError(`Jenkins answered non-JSON content for ${path}`, 'http', response.status)
    }
  }

  /** Perform one HTTP request with authentication, crumb, TLS trust, and a deadline. */
  private async send(
    method: 'GET' | 'POST',
    path: string,
    options: JenkinsCallOptions,
  ): Promise<JenkinsRawResponse> {
    const url = new URL(path.replace(/^\/+/, ''), this.root)
    const token = await this.resolveToken()
    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`${this.config.username}:${token}`, 'utf8').toString('base64')}`,
      accept: 'application/json',
    }
    if (method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      const crumb = await this.crumb()
      if (crumb !== undefined) headers[crumb.field] = crumb.value
    }
    // The body is sent with an explicit length: Jenkins answers 411 to a
    // chunked form POST, and the parameters are already a bounded string.
    const payload = method === 'POST' ? Buffer.from(options.body ?? '', 'utf8') : undefined
    if (payload !== undefined) headers['content-length'] = String(payload.byteLength)
    const secure = url.protocol === 'https:'
    const tls = secure ? await this.tlsOptions() : {}
    const signal = options.signal === undefined ? {} : { signal: options.signal }
    return await new Promise<JenkinsRawResponse>((resolve, reject) => {
      const onResponse = (response: IncomingMessage): void => {
        const chunks: Buffer[] = []
        let size = 0
        let truncated = false
        response.on('data', (chunk: Buffer) => {
          const limit = options.maxBytes
          if (limit !== undefined && size >= limit) {
            truncated = true
            return
          }
          const remaining = limit === undefined ? chunk.byteLength : limit - size
          if (chunk.byteLength > remaining) truncated = true
          const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk
          chunks.push(slice)
          size += slice.byteLength
        })
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks, size).toString('utf8'),
            truncated,
          })
        })
        response.on('error', (error: Error) => {
          reject(new JenkinsError(`Jenkins response failed: ${error.message}`, 'network'))
        })
      }
      // Two explicit branches keep each overload's exact option type; a union of
      // the two overloaded functions is not callable under strict TypeScript.
      const request = secure
        ? httpsRequest(url, { method, headers, ...tls, ...signal }, onResponse)
        : httpRequest(url, { method, headers, ...signal }, onResponse)
      request.setTimeout(this.config.timeoutMs, () => {
        request.destroy(new JenkinsError(`Jenkins request timed out after ${this.config.timeoutMs}ms`, 'timeout'))
      })
      request.on('error', (error: Error) => {
        reject(
          error instanceof JenkinsError
            ? error
            : new JenkinsError(`cannot reach ${url.origin}: ${error.message}`, 'network'),
        )
      })
      request.end(payload)
    })
  }

  /** Fetch and cache the CSRF crumb; `undefined` means the instance needs none. */
  private async crumb(): Promise<{ field: string; value: string } | undefined> {
    if (this.config.crumbMode === 'off') return undefined
    if (this.resolvedCrumb !== undefined) return this.resolvedCrumb
    this.crumbLookup ??= (async () => {
      try {
        const payload = await this.requestJson<{ crumbRequestField?: unknown; crumb?: unknown }>(
          'crumbIssuer/api/json',
          {},
        )
        const field = asString(payload.crumbRequestField)
        const value = asString(payload.crumb)
        return field.length > 0 && value.length > 0 ? { field, value } : undefined
      } catch (error) {
        // An instance without the crumb issuer answers 404; any other failure is real.
        if (error instanceof JenkinsError && error.code === 'not-found') return undefined
        throw error
      }
    })()
    this.resolvedCrumb = await this.crumbLookup
    return this.resolvedCrumb
  }

  /** TLS trust for this instance. */
  private async tlsOptions(): Promise<{ rejectUnauthorized: boolean; ca?: Buffer }> {
    if (this.config.tlsMode === 'allowSelfSigned') return { rejectUnauthorized: false }
    const caFile = this.config.tlsCaFile
    if (caFile === undefined || caFile.length === 0) return { rejectUnauthorized: true }
    this.caFile ??= readFile(caFile)
    return { rejectUnauthorized: true, ca: await this.caFile }
  }
}
