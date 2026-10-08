/**
 * `jenkins_jobs` — discovery tool. It lists jobs with their coarse status and,
 * on request, the most recent builds of each match, so the model can pick a
 * build to inspect without a second round trip.
 * @module dsh-jenkins-plugin/tools/jobs
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.js'
import type { InstanceRegistry } from '../connection.js'
import type { JenkinsBuildSummary, JenkinsJobRef } from '../jenkins/types.js'

/** Jobs one listing may return before it reports truncation. */
const MAX_LISTED_JOBS = 100

/** Matched jobs whose build history is fetched in one call. */
const MAX_HISTORY_JOBS = 25

/**
 * One build row exactly as this tool declares it.
 *
 * Deliberately narrower than the client's `JenkinsBuildSummary`: the tool's
 * schema is a published contract the model reads, so it must not silently widen
 * when the client grows a field for the panel's benefit.
 */
interface JobsBuildRow {
  number: number
  result: string | null
  building: boolean
  timestamp: number
  duration: number
  url: string
}

/** Canonical result of one `jenkins_jobs` call. */
interface JobsResult {
  jobs: Array<JenkinsJobRef & { builds?: JobsBuildRow[] }>
  total: number
  truncated: boolean
}

/** Narrow a client build summary to this tool's declared row. */
function toRow(build: JenkinsBuildSummary): JobsBuildRow {
  return {
    number: build.number,
    result: build.result,
    building: build.building,
    timestamp: build.timestamp,
    duration: build.duration,
    url: build.url,
  }
}

/** Match a job against the caller's filters. */
function matches(job: JenkinsJobRef, query: string, folder: string): boolean {
  if (folder.length > 0 && !job.path.startsWith(folder.endsWith('/') ? folder : `${folder}/`)) return false
  if (query.length > 0 && !job.path.toLowerCase().includes(query.toLowerCase())) return false
  return true
}

/** Render one build row for the model. */
function buildLine(build: JobsBuildRow): string {
  const state = build.building ? 'running' : build.result ?? 'unknown'
  return `#${build.number} ${state}`
}

/** Render the canonical value as model-facing text. */
function renderJobs(value: JobsResult): string {
  if (value.jobs.length === 0) return 'No Jenkins job matched.'
  const lines = value.jobs.map((job) => {
    const history = job.builds === undefined || job.builds.length === 0
      ? ''
      : ` — ${job.builds.map(buildLine).join(', ')}`
    return `${job.path} [${job.status}]${history}`
  })
  const suffix = value.truncated ? `\n(truncated: showing ${value.jobs.length} of ${value.total} matches)` : ''
  return `${lines.join('\n')}${suffix}`
}

/**
 * Register `jenkins_jobs`.
 * @param ctx - plugin context carrying the tool registry.
 * @param registry - reads the effective instance for this call.
 * @param config - validated plugin configuration.
 */
export function registerJenkinsJobsTool(ctx: Context, registry: InstanceRegistry, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'jenkins_jobs',
    description: 'List Jenkins jobs with their current status, optionally with recent builds.',
    parameters: {
      instance: {
        type: 'string',
        description: 'Configured Jenkins instance id to query; defaults to the instance marked as default in Settings.',
      },
      query: { type: 'string', description: 'Case-insensitive substring matched against the job path.' },
      folder: { type: 'string', description: 'Restrict results to this folder path and its children.' },
      include_history: { type: 'boolean', description: 'Include the most recent builds of every matched job.' },
      history_count: { type: 'integer', description: 'Recent builds per job (default from configuration, max 50).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                name: { type: 'string', required: true },
                url: { type: 'string', required: true },
                status: {
                  type: 'string',
                  required: true,
                  enum: ['success', 'failure', 'unstable', 'running', 'aborted', 'disabled', 'not-built', 'unknown'],
                },
                builds: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      number: { type: 'integer', required: true },
                      result: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                      building: { type: 'boolean', required: true },
                      timestamp: { type: 'integer', required: true },
                      duration: { type: 'integer', required: true },
                      url: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
          total: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderJobs(value) }],
    },
    async execute(args, exec): Promise<JobsResult> {
      // Resolved per call: the settings page may have changed the instance list
      // since the tool was registered, and a missing one must report as
      // configuration rather than as an unreachable server.
      const { client } = await registry.require(args.instance)
      const all = await client.listJobs({ signal: exec.signal })
      const query = args.query ?? ''
      const folder = args.folder ?? ''
      const matched = all.filter(job => matches(job, query, folder))
      // The panel renders `lastBuild` on every row; this tool's contract carries
      // history only when the caller asks for it, so the field is dropped here
      // rather than silently widening the declared output schema.
      const listed: JenkinsJobRef[] = matched.slice(0, MAX_LISTED_JOBS).map(({ lastBuild: _lastBuild, ...job }) => job)
      if (args.include_history !== true) {
        return { jobs: listed, total: matched.length, truncated: matched.length > listed.length }
      }
      const count = Math.max(1, Math.min(50, Math.trunc(args.history_count ?? config.historyCount)))
      const withHistory: JobsResult['jobs'] = []
      for (const job of listed.slice(0, MAX_HISTORY_JOBS)) {
        const builds = await client.jobBuilds(job.path, count, { signal: exec.signal })
        withHistory.push({ ...job, builds: builds.map(toRow) })
      }
      for (const job of listed.slice(MAX_HISTORY_JOBS)) withHistory.push({ ...job })
      return { jobs: withHistory, total: matched.length, truncated: matched.length > listed.length }
    },
  }))
}
