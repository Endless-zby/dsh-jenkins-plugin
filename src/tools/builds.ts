/**
 * The read-only model-facing build tools: status, log, and workspace.
 *
 * Each resolves the instance per call (the settings page may have changed it),
 * applies its configured bounds to the **complete** result, and reports every
 * bound it hit as an explicit fact rather than silently trimming (SPEC §4).
 * @module dsh-jenkins-plugin/tools/builds
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.js'
import type { InstanceRegistry } from '../connection.js'
import { checkWritePolicy } from '../policy.js'
import type { BuildTracker } from '../tracker.js'
import { JenkinsError } from '../jenkins/client.js'

/** Console lines a `jenkins_log` call returns when the caller names none. */
const DEFAULT_TAIL_LINES = 200

/** Hard ceiling on `tail_lines`, per SPEC §4.4. */
const MAX_TAIL_LINES = 2000

/** The slice of `ctx.approval` this module uses. */
interface ApprovalService {
  request(request: {
    agent: unknown
    toolName: string
    callId?: unknown
    reason?: string
    signal?: AbortSignal
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

/** The result of the write-gate sequence. */
type GateOutcome =
  | { allowed: true }
  | { allowed: false, reason: string }

/**
 * Decide whether a write may proceed, in the order SPEC §7 requires.
 *
 * The order is the point, not an implementation detail: `denyJobs` and the
 * `allow.*` switches are decided **first and without side effects**, so a
 * forbidden job never produces an approval request the operator would have to
 * dismiss, and only an allowed write reaches `ctx.approval`. A refusal is a
 * domain result rather than an error, so the model can tell "you may not" from
 * "it broke".
 *
 * The configuration half is {@link checkWritePolicy}, shared with the panel's
 * own write routes; what this adds is the approval the panel cannot use.
 * @param ctx - plugin context, used to reach the optional approval service.
 * @param config - validated plugin configuration.
 * @param jobPath - the job being written to.
 * @param action - `trigger` or `cancel`.
 * @param agent - the calling agent, required for an approval request.
 * @param callId - the tool call id, when the caller supplies one.
 * @param signal - the call's cancellation.
 * @returns whether the write is allowed, with the reason when it is not.
 */
async function gateWrite(
  ctx: Context,
  config: Config,
  jobPath: string,
  action: 'trigger' | 'cancel',
  agent: unknown,
  callId: unknown,
  signal: AbortSignal | undefined,
): Promise<GateOutcome> {
  const policy = checkWritePolicy(config, jobPath, action)
  if (!policy.allowed) return policy

  const approval = ctx.get('approval') as ApprovalService | undefined
  if (approval === undefined) {
    // Fail closed: no approval channel means no write. A session whose policy is
    // `never` also lands here, because that policy answers `unavailable`.
    return {
      allowed: false,
      reason: `no approval channel is available, so a model-issued ${action} cannot be authorised`,
    }
  }
  if (agent === undefined) {
    return {
      allowed: false,
      reason: `a ${action} needs an approval, but this call carries no agent to route it through`,
    }
  }
  const outcome = await approval.request({
    agent,
    toolName: 'jenkins_build',
    ...callId === undefined ? {} : { callId },
    reason: `${action} Jenkins job "${jobPath}"`,
    ...signal === undefined ? {} : { signal },
  })
  if (outcome === 'allowed-once') return { allowed: true }
  switch (outcome) {
    case 'rejected':
      return { allowed: false, reason: `the ${action} of "${jobPath}" was rejected by the operator` }
    case 'cancelled':
      return { allowed: false, reason: `the approval for ${action}ing "${jobPath}" was cancelled` }
    default:
      return {
        allowed: false,
        reason: `no approval channel is available for this session (its policy may be "never"),`
        + ` so the ${action} was refused`,
      }
  }
}

/** Commit rows a status answer returns before it reports truncation. */
const MAX_CHANGES = 100

/**
 * The status answer as the tool declares it.
 *
 * Deliberately not the client's `JenkinsBuildDetail`: the schema is a published
 * contract the model reads, so it must not widen when the client grows a field
 * for the panel's benefit.
 */
interface StatusView {
  instanceId: string
  jobPath: string
  buildNumber: number
  result: string | null
  outcome: string
  building: boolean
  url: string
  durationMs: number
  estimatedDurationMs: number
  cause?: string
  stages?: Array<{ name: string, status: string, durationMs?: number }>
  progress: { completed: number, total: number }
  changes: Array<{ commitId: string, author: string, message: string }>
  changesTruncated: boolean
  tests: { total: number, failed: number, skipped: number, passed: number } | null
  artifacts: Array<{ path: string, url: string }>
}

/** The workspace answer as the tool declares it. */
interface WorkspaceView {
  instanceId: string
  jobPath: string
  buildNumber: number
  kind: string
  available: boolean
  note?: string
  entries?: Array<{ path: string, directory: boolean, size: number }>
  total: number
  truncated: boolean
  artifacts?: Array<{ path: string, url: string }>
}

/**
 * Read a `job` argument the schema declares required.
 *
 * The tool seam types every declared parameter as optional, because the
 * generated argument type cannot see which ones the schema marks required; the
 * check below turns a missing one into the same readable refusal a wrong job
 * path produces rather than an `undefined` reaching the URL builder.
 * @param args - the tool's parsed arguments.
 * @returns the job path.
 * @throws {Error} when the caller omitted it.
 */
function requiredJob(args: { job?: string }): string {
  if (args.job === undefined || args.job.trim().length === 0) {
    throw new Error('"job" is required: pass the job path, for example folder/name')
  }
  return args.job.trim()
}

/**
 * Take the last `count` lines of a block of text.
 * @param text - the text to slice.
 * @param count - how many trailing lines to keep.
 * @returns the trailing lines and whether anything was dropped.
 */
function tail(text: string, count: number): { text: string, truncated: boolean } {
  if (count <= 0) return { text: '', truncated: text.length > 0 }
  const lines = text.split('\n')
  if (lines.length <= count) return { text, truncated: false }
  return { text: lines.slice(lines.length - count).join('\n'), truncated: true }
}

/** Render a build's status for the model. */
function renderStatus(value: StatusView): string {
  const lines: string[] = []
  const state = value.building ? 'running' : value.outcome
  lines.push(`${value.url.length > 0 ? value.url : 'build'} — #${value.buildNumber} ${state}`)
  if (value.cause !== undefined) lines.push(`cause: ${value.cause}`)
  lines.push(value.building
    ? `started ${new Date(value.durationMs).toISOString()}, still running`
    : `duration ${Math.round(value.durationMs / 1000)}s (estimated ${Math.round(value.estimatedDurationMs / 1000)}s)`)

  const stages = value.stages ?? []
  if (stages.length > 0) {
    const current = stages.find(stage => stage.status === 'IN_PROGRESS' || stage.status === 'PAUSED')
    const failed = [...stages].reverse().find(stage => stage.status === 'FAILED' || stage.status === 'ABORTED')
    const headline = value.progress ?? { completed: 0, total: 0 }
    lines.push(`progress: ${headline.completed}/${headline.total} stages`
      + (current === undefined ? '' : `, current: ${current.name}`)
      + (failed === undefined ? '' : `, failed at: ${failed.name}`))
    for (const stage of stages) {
      lines.push(`  ${stage.status.padEnd(12)} ${stage.name}${stage.durationMs === undefined ? '' : ` (${Math.round(stage.durationMs / 1000)}s)`}`)
    }
  } else if (value.stages === undefined) {
    lines.push('stages: not requested')
  } else {
    // Stated, not omitted: "no stages" is the answer for a Freestyle or Maven
    // job, and a model that is not told will assume the pipeline is empty.
    lines.push('stages: none reported — this job is not a Pipeline (Freestyle/Maven) or the workflow API is unavailable')
  }

  if (value.changes.length > 0) {
    lines.push(`changes: ${value.changes.length}${value.changesTruncated ? ' (truncated)' : ''}`)
    for (const change of value.changes) {
      lines.push(`  ${change.commitId.slice(0, 8)} ${change.author}: ${change.message}`)
    }
  } else {
    lines.push('changes: none reported')
  }

  lines.push(value.tests === null
    ? 'tests: no test report'
    : `tests: ${value.tests.total} total, ${value.tests.failed} failed, ${value.tests.skipped} skipped, ${value.tests.passed} passed`)
  lines.push(value.artifacts.length === 0
    ? 'artifacts: none'
    : `artifacts: ${value.artifacts.length} — ${value.artifacts.map(artifact => artifact.path).join(', ')}`)
  return lines.join('\n')
}

/**
 * Register `jenkins_build`, the one writing tool.
 * @param ctx - plugin context carrying the tool registry and the approval seam.
 * @param registry - reads the effective instance for this call.
 * @param config - validated plugin configuration.
 * @param tracker - live build tracker, so a build the model starts appears in
 *   the panel without anyone having to re-attach to it.
 */
export function registerJenkinsBuildTool(
  ctx: Context,
  registry: InstanceRegistry,
  config: Config,
  tracker?: BuildTracker,
): void {
  ctx.tools.register(defineTool({
    name: 'jenkins_build',
    description: 'Trigger or cancel a Jenkins build. Both actions require operator approval and respect denyJobs.',
    parameters: {
      instance: { type: 'string', description: 'Configured Jenkins instance id; defaults to the default instance.' },
      job: { type: 'string', description: 'Job path, for example folder/name.' },
      action: { type: 'string', description: 'trigger (default) or cancel.' },
      parameters: {
        type: 'object',
        description: 'Build parameters for a parameterized job; string values only.',
        additionalProperties: true,
      },
      build_number: { type: 'string', description: 'Build to cancel (default last). Ignored when triggering.' },
      wait: { type: 'boolean', description: 'Wait for the build to finish instead of returning immediately (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          allowed: { type: 'boolean', required: true },
          /** Why a write was refused; present only when `allowed` is false. */
          refused: { type: 'string' },
          instanceId: { type: 'string' },
          jobPath: { type: 'string' },
          action: { type: 'string' },
          queueId: { type: 'integer' },
          buildNumber: { type: 'integer' },
          state: { type: 'string', required: true },
          outcome: { type: 'string' },
          url: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.allowed !== true) {
          return [{ type: 'text', text: `Jenkins build refused: ${value.refused ?? 'not permitted'}` }]
        }
        const target = `${value.jobPath ?? ''}${value.buildNumber === undefined ? '' : ` #${value.buildNumber}`}`
        const state = value.state
        const bits = [`${value.action} ${target}: ${state}`]
        if (value.queueId !== undefined) bits.push(`queueId=${value.queueId}`)
        if (value.outcome !== undefined) bits.push(`result=${value.outcome}`)
        if (value.url !== undefined && value.url.length > 0) bits.push(value.url)
        return [{ type: 'text', text: bits.join('\n') }]
      },
    },
    async execute(args, exec) {
      const job = requiredJob(args)
      const action = args.action === 'cancel' ? 'cancel' : 'trigger'
      const { instance, client } = await registry.require(args.instance)

      // SPEC §7: denyJobs and the allow switches first, with no side effects, so
      // a forbidden job never reaches the approval seam.
      const gate = await gateWrite(
        ctx,
        config,
        job,
        action,
        (exec as { agent?: unknown }).agent,
        (exec as { callId?: unknown }).callId,
        exec.signal,
      )
      if (!gate.allowed) {
        return {
          allowed: false,
          refused: gate.reason,
          instanceId: instance.id,
          jobPath: job,
          action,
          state: 'refused',
        }
      }

      if (action === 'cancel') {
        const selector = args.build_number ?? 'last'
        const number = await client.resolveBuildNumber(job, selector, { signal: exec.signal })
        try {
          await client.cancel(job, number, { signal: exec.signal })
        } catch (error) {
          // A build that already ended is a fact, not a failure: the operator's
          // intent is satisfied.
          if (error instanceof JenkinsError && error.code === 'not-found') {
            return {
              allowed: true,
              instanceId: instance.id,
              jobPath: job,
              action,
              buildNumber: number,
              state: 'already-finished',
            }
          }
          throw error
        }
        return {
          allowed: true,
          instanceId: instance.id,
          jobPath: job,
          action,
          buildNumber: number,
          state: 'abort-requested',
        }
      }

      const parameters: Record<string, string> = {}
      for (const [key, value] of Object.entries(args.parameters ?? {})) {
        if (value === undefined || value === null) continue
        parameters[key] = typeof value === 'string' ? value : JSON.stringify(value)
      }
      const { queueUrl, queueId } = await client.trigger(job, parameters, { signal: exec.signal })
      // Tracked from the queue item, because the build number does not exist yet:
      // this is what makes a build the model just started show up in the panel.
      if (queueId !== undefined) tracker?.trackQueue(instance.id, job, queueId)

      if (args.wait !== true) {
        return {
          allowed: true,
          instanceId: instance.id,
          jobPath: job,
          action,
          ...queueId === undefined ? {} : { queueId },
          state: 'queued',
          ...queueUrl.length === 0 ? {} : { url: queueUrl },
        }
      }

      // `wait: true` blocks until the queue item becomes a build and that build
      // ends, bounded by queueTimeoutMs so a job that never gets an executor
      // reports as still queued rather than hanging the turn.
      const deadline = Date.now() + config.queueTimeoutMs
      let buildNumber: number | undefined
      while (Date.now() < deadline) {
        if (queueUrl.length > 0) {
          const item = await client.queueItem(queueUrl, { signal: exec.signal })
          if (!item.waiting) buildNumber = item.buildNumber
        }
        if (buildNumber !== undefined) break
        await delay(config.progressIntervalMs, exec.signal)
      }
      if (buildNumber === undefined) {
        return {
          allowed: true,
          instanceId: instance.id,
          jobPath: job,
          action,
          ...queueId === undefined ? {} : { queueId },
          state: 'still-queued',
          ...queueUrl.length === 0 ? {} : { url: queueUrl },
        }
      }

      let detail = await client.buildDetail(job, String(buildNumber), { signal: exec.signal })
      // The tracker resolves the queue item on its own poll, so nothing has to
      // hand it the number here: the panel and this call agree on the build
      // because both read the same queue item.
      while (detail.building && Date.now() < deadline) {
        await delay(config.progressIntervalMs, exec.signal)
        detail = await client.buildDetail(job, String(buildNumber), { signal: exec.signal })
      }
      return {
        allowed: true,
        instanceId: instance.id,
        jobPath: job,
        action,
        buildNumber,
        state: detail.building ? 'running' : 'finished',
        outcome: detail.outcome,
        url: detail.url,
      }
    },
  }))
}

/**
 * Sleep, honouring cancellation.
 * @param ms - milliseconds to wait.
 * @param signal - the call's cancellation.
 */
async function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(1, ms))
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * Register `jenkins_build_status`.
 * @param ctx - plugin context carrying the tool registry.
 * @param registry - reads the effective instance for this call.
 * @param config - validated plugin configuration.
 */
export function registerJenkinsBuildStatusTool(ctx: Context, registry: InstanceRegistry, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'jenkins_build_status',
    description: 'Read one Jenkins build: result, duration, Pipeline stages, change set, and test summary.',
    parameters: {
      instance: { type: 'string', description: 'Configured Jenkins instance id; defaults to the default instance.' },
      job: { type: 'string', description: 'Job path, for example folder/name.' },
      build_number: { type: 'string', description: 'Build number or last / lastSuccessful / lastFailed. Defaults to last.' },
      include_stages: { type: 'boolean', description: 'Include Pipeline stages (default true).' },
      include_changes: { type: 'boolean', description: 'Include the change set (default false).' },
      include_tests: { type: 'boolean', description: 'Include the test summary (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          instanceId: { type: 'string', required: true },
          jobPath: { type: 'string', required: true },
          buildNumber: { type: 'integer', required: true },
          result: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          outcome: { type: 'string', required: true },
          building: { type: 'boolean', required: true },
          url: { type: 'string', required: true },
          durationMs: { type: 'integer', required: true },
          estimatedDurationMs: { type: 'integer', required: true },
          cause: { type: 'string' },
          stages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                status: { type: 'string', required: true },
                durationMs: { type: 'integer' },
              },
            },
          },
          progress: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              completed: { type: 'integer', required: true },
              total: { type: 'integer', required: true },
            },
          },
          changes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                commitId: { type: 'string', required: true },
                author: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
          changesTruncated: { type: 'boolean', required: true },
          tests: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  total: { type: 'integer', required: true },
                  failed: { type: 'integer', required: true },
                  skipped: { type: 'integer', required: true },
                  passed: { type: 'integer', required: true },
                },
              },
              { type: 'null' },
            ],
            required: true,
          },
          artifacts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                url: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
    },
    async execute(args, exec): Promise<StatusView> {
      const job = requiredJob(args)
      const { instance, client } = await registry.require(args.instance)
      const detail = await client.buildDetail(job, args.build_number ?? 'last', { signal: exec.signal })
      const changes = args.include_changes === true ? detail.changes.slice(0, MAX_CHANGES) : []
      return {
        instanceId: instance.id,
        jobPath: job,
        buildNumber: detail.number,
        result: detail.result,
        outcome: detail.outcome,
        building: detail.building,
        url: detail.url,
        durationMs: detail.duration,
        estimatedDurationMs: detail.estimatedDuration,
        ...detail.cause === undefined ? {} : { cause: detail.cause },
        // `include_stages: false` reports the progress counts but no stage rows,
        // because a caller asking for less detail is not asking to lose the
        // headline; omitting the key entirely is how that is signalled.
        ...args.include_stages === false ? {} : {
          stages: detail.stages.map(stage => ({
            name: stage.name,
            status: stage.status,
            ...stage.durationMs === undefined ? {} : { durationMs: stage.durationMs },
          })),
        },
        progress: detail.progress,
        changes: changes.map(change => ({
          commitId: change.commitId,
          author: change.author,
          message: change.message,
        })),
        changesTruncated: args.include_changes === true && detail.changes.length > changes.length,
        tests: args.include_tests === true ? detail.tests : null,
        artifacts: detail.artifacts.map(artifact => ({ path: artifact.path, url: artifact.url })),
      }
    },
  }))
}

/**
 * Register `jenkins_log`.
 * @param ctx - plugin context carrying the tool registry.
 * @param registry - reads the effective instance for this call.
 * @param config - validated plugin configuration.
 */
export function registerJenkinsLogTool(ctx: Context, registry: InstanceRegistry, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'jenkins_log',
    description: 'Read a Jenkins build console log, from the tail by default or from a byte offset to continue reading.',
    parameters: {
      instance: { type: 'string', description: 'Configured Jenkins instance id; defaults to the default instance.' },
      job: { type: 'string', description: 'Job path, for example folder/name.' },
      build_number: { type: 'string', description: 'Build number or last / lastSuccessful / lastFailed. Defaults to last.' },
      tail_lines: { type: 'integer', description: `Trailing lines to return (default ${DEFAULT_TAIL_LINES}, max ${MAX_TAIL_LINES}).` },
      offset: { type: 'integer', description: 'Byte offset to continue from; pass the previous call\'s next_offset.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          instanceId: { type: 'string', required: true },
          jobPath: { type: 'string', required: true },
          buildNumber: { type: 'integer', required: true },
          text: { type: 'string', required: true },
          nextOffset: { type: 'integer', required: true },
          moreData: { type: 'boolean', required: true },
          truncated: { type: 'boolean', required: true },
          totalSize: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.jobPath} #${value.buildNumber} console`
          + ` (${value.text.split('\n').length} lines`
          + `${value.totalSize === undefined ? '' : ` of a ${value.totalSize}-byte log`}`
          + `${value.moreData ? ', more follows' : ', log end'}`
          + `${value.truncated ? ', truncated' : ''})\n${value.text}`,
      }],
    },
    async execute(args, exec) {
      const job = requiredJob(args)
      const { instance, client } = await registry.require(args.instance)
      const selector = args.build_number ?? 'last'
      const requested = Math.max(1, Math.min(MAX_TAIL_LINES, Math.trunc(args.tail_lines ?? DEFAULT_TAIL_LINES)))
      // A tail request is answered by the client reading the end of the log, so
      // the byte budget stays the configured cap rather than scaling with the
      // requested line count.
      const offset = args.offset ?? 0
      const page = await client.consoleLog(job, selector, offset, config.maxLogBytes, { signal: exec.signal })
      // Applies the line bound to the complete page and states what it dropped.
      const sliced = tail(page.text, requested)
      const number = await client.resolveBuildNumber(job, selector, { signal: exec.signal })
      return {
        instanceId: instance.id,
        jobPath: job,
        buildNumber: number,
        text: sliced.text,
        nextOffset: page.nextOffset,
        // A tail is the end of the log, so nothing follows it unless the page
        // itself was cut short; `page.moreData` describes a head read instead.
        moreData: !page.moreData && !sliced.truncated,
        truncated: page.truncated || sliced.truncated,
        ...page.totalSize === undefined ? {} : { totalSize: page.totalSize },
      }
    },
  }))
}

/**
 * Register `jenkins_workspace`.
 * @param ctx - plugin context carrying the tool registry.
 * @param registry - reads the effective instance for this call.
 * @param config - validated plugin configuration.
 */
export function registerJenkinsWorkspaceTool(ctx: Context, registry: InstanceRegistry, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'jenkins_workspace',
    description: 'List a Jenkins build\'s workspace or artifacts. Reading workspace files needs the Jenkins Workspace API plugin.',
    parameters: {
      instance: { type: 'string', description: 'Configured Jenkins instance id; defaults to the default instance.' },
      job: { type: 'string', description: 'Job path, for example folder/name.' },
      build_number: { type: 'string', description: 'Build number or last / lastSuccessful / lastFailed. Defaults to last.' },
      kind: { type: 'string', description: 'workspace (default) or artifact.' },
      action: { type: 'string', description: 'list (default) or read.' },
      path: { type: 'string', description: 'Workspace-relative directory to list, or file to read.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          instanceId: { type: 'string', required: true },
          jobPath: { type: 'string', required: true },
          buildNumber: { type: 'integer', required: true },
          kind: { type: 'string', required: true },
          available: { type: 'boolean', required: true },
          note: { type: 'string' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                directory: { type: 'boolean', required: true },
                size: { type: 'integer', required: true },
              },
            },
          },
          total: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          artifacts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                url: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: WorkspaceView) => {
        if (!value.available) {
          return [{ type: 'text', text: `${value.jobPath} #${value.buildNumber}: ${value.note ?? 'not available'}` }]
        }
        if (value.kind === 'artifact') {
          const rows = (value.artifacts ?? []).map(artifact => `${artifact.path} -> ${artifact.url}`)
          return [{
            type: 'text',
            text: rows.length === 0
              ? `${value.jobPath} #${value.buildNumber}: no artifacts`
              : `artifacts (${rows.length}):\n${rows.join('\n')}`,
          }]
        }
        const entries = value.entries ?? []
        const rows = entries.map(entry => `${entry.directory ? 'dir ' : 'file'} ${entry.path}${entry.directory ? '' : ` (${entry.size}B)`}`)
        const suffix = value.truncated ? `\n(truncated: showing ${entries.length} of ${value.total})` : ''
        return [{
          type: 'text',
          text: rows.length === 0
            ? `${value.jobPath} #${value.buildNumber}: workspace directory is empty`
            : `workspace (${value.total} entries):\n${rows.join('\n')}${suffix}`,
        }]
      },
    },
    async execute(args, exec): Promise<WorkspaceView> {
      const job = requiredJob(args)
      const { instance, client } = await registry.require(args.instance)
      const selector = args.build_number ?? 'last'
      const number = await client.resolveBuildNumber(job, selector, { signal: exec.signal })
      const kind = args.kind ?? 'workspace'

      if (kind === 'artifact') {
        // Artifacts are listed from the build's own metadata, so they work on a
        // controller with no Workspace API at all.
        const detail = await client.buildDetail(job, selector, { signal: exec.signal })
        return {
          instanceId: instance.id,
          jobPath: job,
          buildNumber: number,
          kind,
          available: true,
          entries: [],
          total: detail.artifacts.length,
          truncated: false,
          artifacts: detail.artifacts.map(artifact => ({ path: artifact.path, url: artifact.url })),
        }
      }

      if ((args.action ?? 'list') === 'read') {
        // SPEC §4.5 excludes artifact reads, and the workspace surface has no
        // file-read endpoint of its own on the controllers this was built for.
        return {
          instanceId: instance.id,
          jobPath: job,
          buildNumber: number,
          kind,
          available: false,
          note: 'reading workspace file contents is not supported; this tool lists directories only',
          entries: [],
          total: 0,
          truncated: false,
        }
      }

      const listing = await client.workspace(job, selector, args.path ?? '', { signal: exec.signal })
      if (!listing.available) {
        return {
          instanceId: instance.id,
          jobPath: job,
          buildNumber: number,
          kind,
          available: false,
          note: 'this Jenkins does not expose the Workspace API (the plugin is not installed), so workspace contents cannot be listed',
          entries: [],
          total: 0,
          truncated: false,
        }
      }
      const limit = config.maxWorkspaceEntries
      const entries = listing.entries.slice(0, limit)
      return {
        instanceId: instance.id,
        jobPath: job,
        buildNumber: number,
        kind,
        available: true,
        entries: entries.map(entry => ({ path: entry.path, directory: entry.directory, size: entry.size })),
        total: listing.entries.length,
        truncated: listing.entries.length > entries.length,
      }
    },
  }))
}
