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
import { jobStatusFromColor } from './types.js'
import type { JenkinsBuildSummary, JenkinsJobRef, JenkinsStage } from './types.js'

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
}

/** Raw job row as returned by the Jenkins `tree` query. */
interface RawJob {
  name?: unknown
  url?: unknown
  color?: unknown
  _class?: unknown
}

/** Raw build row as returned by the Jenkins `tree` query. */
interface RawBuild {
  number?: unknown
  result?: unknown
  building?: unknown
  timestamp?: unknown
  duration?: unknown
  url?: unknown
}

/** Caps one job listing so a large controller cannot exhaust memory. */
const MAX_JOBS = 2000

/** Folder nesting the listing walks before it stops descending. */
const MAX_FOLDER_DEPTH = 6

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
      `${jobBase(jobPath)}/api/json?tree=builds[number,result,building,timestamp,duration,url]{0,${bounded}}`,
      options,
    )
    return (payload.builds ?? []).map(build => ({
      number: asNumber(build.number),
      result: typeof build.result === 'string' ? build.result : null,
      building: build.building === true,
      timestamp: asNumber(build.timestamp),
      duration: asNumber(build.duration),
      url: asString(build.url),
    }))
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
      + '?tree=number,result,building,timestamp,duration,url',
      options,
    )
    return {
      number: asNumber(payload.number),
      result: typeof payload.result === 'string' ? payload.result : null,
      building: payload.building === true,
      timestamp: asNumber(payload.timestamp),
      duration: asNumber(payload.duration),
      url: asString(payload.url),
    }
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
    const payload = await this.requestJson<{ jobs?: RawJob[] }>(
      `${folderBase(jobPath)}/api/json?tree=jobs[name,url,color,_class]`,
      options,
    )
    for (const raw of payload.jobs ?? []) {
      if (out.length >= MAX_JOBS) return
      const name = asString(raw.name)
      if (name.length === 0) continue
      const childPath = jobPath.length === 0 ? name : `${jobPath}/${name}`
      const className = asString(raw._class)
      if (className.endsWith('Folder')) {
        await this.collectJobs(childPath, out, options, depth + 1)
        continue
      }
      out.push({
        path: childPath,
        name,
        url: asString(raw.url),
        status: jobStatusFromColor(raw.color),
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
      // A non-JSON body is the only meaning of a parse failure here.
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
      request.end()
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
