/**
 * Normalized Jenkins domain vocabulary. Raw Jenkins responses are mapped into
 * these types at the client boundary so tools, routes, and the panel share one
 * vocabulary instead of each restating the Jenkins wire fields.
 * @module dsh-jenkins-plugin/jenkins/types
 */

/** One Jenkins job addressable by its folder path. */
export interface JenkinsJobRef {
  /** Folder path, for example `team/service`. */
  path: string
  /** Last path segment, which is the job's display name. */
  name: string
  /** Absolute Jenkins URL of the job. */
  url: string
  /** Coarse status derived from the job's Jenkins color. */
  status: JenkinsJobStatus
  /** Most recent build, absent for a job that never ran. */
  lastBuild?: JenkinsBuildSummary
}

/** Coarse job status derived from the Jenkins color field. */
export type JenkinsJobStatus =
  | 'success'
  | 'failure'
  | 'unstable'
  | 'running'
  | 'aborted'
  | 'disabled'
  | 'not-built'
  | 'unknown'

/** One build of a job, without stage detail. */
export interface JenkinsBuildSummary {
  /** Build number. */
  number: number
  /** Terminal result, or null while the build runs (or when it was aborted). */
  result: string | null
  /**
   * The result as the panel should read it.
   *
   * Jenkins reports `result: null` both for a running build and for one that was
   * aborted before it could record an outcome, so the two must be told apart by
   * `building` rather than by `result` alone; rendering `null` as "running" is
   * how an aborted build ends up looking alive forever.
   */
  outcome: JenkinsBuildOutcome
  /** Whether the build is still running. */
  building: boolean
  /** Start time as epoch milliseconds. */
  timestamp: number
  /** Duration in milliseconds, zero while running. */
  duration: number
  /** Absolute Jenkins URL of the build. */
  url: string
  /** Human-readable display name, when Jenkins reports one. */
  displayName?: string
  /** Free-text description, when the operator set one. */
  description?: string
  /** Why the build ran, when Jenkins recorded it. */
  cause?: string
  /**
   * Jenkins' own estimate of the total duration, when it has one.
   *
   * This is the only progress signal a non-Pipeline job has: a Freestyle or
   * Maven build reports no stages at all, so its bar has to be built from
   * elapsed-versus-estimated instead of stage counts.
   */
  estimatedDuration?: number
}

/** How a build's progress should be drawn. */
export type JenkinsProgressKind =
  /** Pipeline stages give an exact completed/total count. */
  | 'stages'
  /** A running non-Pipeline build, measured against Jenkins' estimate. */
  | 'estimate'
  /** Nothing to measure against: running, but Jenkins has no estimate. */
  | 'indeterminate'
  /** The build is not running, so it has no progress to show. */
  | 'finished'

/** One build's progress, in the form the panel draws it. */
export interface JenkinsBuildProgress {
  /** Which signal produced {@link fraction}. */
  kind: JenkinsProgressKind
  /** 0..1 when known; absent for `indeterminate` and `finished`. */
  fraction?: number
  /** Stages finished, for `stages`. */
  completed?: number
  /** Stages declared, for `stages`. */
  total?: number
  /** Milliseconds elapsed so far. */
  elapsedMs?: number
  /** Jenkins' estimate, when it has one. */
  estimatedMs?: number
}

/**
 * Decide how to draw one build's progress.
 *
 * Stages win when a Pipeline reports them, because a stage count is exact while
 * an estimate is a guess. A running build with no stages falls back to
 * elapsed-versus-estimated, and one with neither reports `indeterminate` rather
 * than inventing a percentage.
 * @param build - the build summary.
 * @param stages - stages, when the caller already fetched them.
 * @param now - current epoch milliseconds, injectable for tests.
 * @returns the progress to draw.
 */
export function buildProgress(
  build: JenkinsBuildSummary,
  stages: readonly JenkinsStage[] = [],
  now: number = Date.now(),
): JenkinsBuildProgress {
  const elapsed = build.building ? Math.max(0, now - build.timestamp) : build.duration
  if (stages.length > 0) {
    const { completed, total } = stageProgress(stages)
    return {
      kind: 'stages',
      fraction: total === 0 ? 0 : completed / total,
      completed,
      total,
      elapsedMs: elapsed,
      ...build.estimatedDuration === undefined ? {} : { estimatedMs: build.estimatedDuration },
    }
  }
  if (!build.building) return { kind: 'finished', fraction: 1, elapsedMs: elapsed }
  const estimated = build.estimatedDuration
  if (estimated === undefined || estimated <= 0) return { kind: 'indeterminate', elapsedMs: elapsed }
  // Clamped below 1: a build that overruns its estimate is still not finished,
  // and a bar sitting at 100% while the build runs reads as a bug.
  return {
    kind: 'estimate',
    fraction: Math.min(0.99, Math.max(0, elapsed / estimated)),
    elapsedMs: elapsed,
    estimatedMs: estimated,
  }
}

/** How a build reads to a person, once `building` and `result` are combined. */
export type JenkinsBuildOutcome =
  | 'building'
  | 'success'
  | 'failure'
  | 'unstable'
  | 'aborted'
  | 'not-built'
  | 'unknown'

/**
 * Combine Jenkins' `building` flag with its `result` into one outcome.
 * @param result - the raw result, null while running or aborted.
 * @param building - whether Jenkins still considers the build running.
 * @returns the outcome a person should read.
 */
export function buildOutcome(result: string | null, building: boolean): JenkinsBuildOutcome {
  if (building) return 'building'
  if (result === null) return 'aborted'
  switch (result.toUpperCase()) {
    case 'SUCCESS': return 'success'
    case 'FAILURE': return 'failure'
    case 'UNSTABLE': return 'unstable'
    case 'ABORTED': return 'aborted'
    case 'NOT_BUILT': return 'not-built'
    default: return 'unknown'
  }
}

/** One entry in a build's change set. */
export interface JenkinsChange {
  /** Commit identifier, when the SCM reported one. */
  commitId: string
  /** Author as the SCM recorded it. */
  author: string
  /** Commit title. */
  message: string
  /** Commit time as epoch milliseconds, zero when unreported. */
  timestamp: number
}

/** Test totals of one build, absent when the build has no test report. */
export interface JenkinsTestSummary {
  /** Every test the report counted. */
  total: number
  /** Tests that failed. */
  failed: number
  /** Tests skipped. */
  skipped: number
  /** Tests that passed. */
  passed: number
}

/** One artifact produced by a build. */
export interface JenkinsArtifact {
  /** Filename as Jenkins publishes it. */
  name: string
  /** Path relative to the build's artifact root. */
  path: string
  /** Size in bytes. */
  size: number
  /** Absolute download URL. */
  url: string
}

/** One entry of a build's workspace directory. */
export interface JenkinsWorkspaceEntry {
  /** Entry name within its directory. */
  name: string
  /** Path relative to the workspace root. */
  path: string
  /** Whether the entry is a directory. */
  directory: boolean
  /** Size in bytes; zero for directories. */
  size: number
  /** Last-modified time as epoch milliseconds, zero when unreported. */
  modifiedAt: number
}

/** A build's full detail: the summary plus everything the panel's detail view draws. */
export interface JenkinsBuildDetail extends JenkinsBuildSummary {
  /** Pipeline stages; empty for a job type that has none. */
  stages: JenkinsStage[]
  /** Stage counts, which the progress bar reads. */
  progress: JenkinsProgress
  /** Whether the job is a Pipeline at all, so the panel can explain an empty stage list. */
  hasStages: boolean
  /** Commit range, empty when the SCM reported none. */
  changes: JenkinsChange[]
  /** Test totals, null when the build produced no test report. */
  tests: JenkinsTestSummary | null
  /** Produced artifacts, empty when there are none. */
  artifacts: JenkinsArtifact[]
  /** Estimated total duration in milliseconds, zero when Jenkins has no estimate. */
  estimatedDuration: number
  /**
   * The parameters this build ran with, when it was parameterized.
   *
   * Kept so a rebuild can send exactly what the previous build sent rather than
   * asking Jenkins to guess at defaults (SPEC §5.3).
   */
  parameters?: Record<string, string>
}

/** One job with its recent build history, which the panel's detail view opens with. */
export interface JenkinsJobDetail {
  /** The job itself. */
  job: JenkinsJobRef
  /** Recent builds, newest first. */
  builds: JenkinsBuildSummary[]
  /** Total builds Jenkins reports, when it reported one. */
  totalBuilds?: number
}

/** One page of a build's console log. */
export interface JenkinsLogPage {
  /** Log text, from {@link offset}. */
  text: string
  /** Byte offset to pass as `offset` to continue. */
  nextOffset: number
  /** Whether more log exists past {@link nextOffset}. */
  moreData: boolean
  /** Whether this page was cut by the caller's byte cap. */
  truncated: boolean
  /** Total log size in bytes, when Jenkins reported it. */
  totalSize?: number
}

/** Stage statuses that count as finished for {@link JenkinsProgress}. */
const TERMINAL_STAGE_STATUSES = new Set(['SUCCESS', 'FAILED', 'ABORTED', 'UNSTABLE', 'NOT_EXECUTED', 'SKIPPED'])

/** Stages whose status means the pipeline stopped there. */
const FAILED_STAGE_STATUSES = new Set(['FAILED', 'ABORTED', 'UNSTABLE'])

/**
 * Count finished stages of a build.
 * @param stages - stages reported by the Pipeline API.
 * @returns completed and total stage counts.
 */
export function stageProgress(stages: readonly JenkinsStage[]): JenkinsProgress {
  return {
    completed: stages.filter(stage => TERMINAL_STAGE_STATUSES.has(stage.status)).length,
    total: stages.length,
  }
}

/**
 * The stage a pipeline is currently executing, if any.
 * @param stages - stages in execution order.
 * @returns the first in-progress or paused stage.
 */
export function activeStage(stages: readonly JenkinsStage[]): JenkinsStage | undefined {
  return stages.find(stage => stage.status === 'IN_PROGRESS' || stage.status === 'PAUSED')
}

/**
 * The stage that ended the pipeline, if it did.
 * @param stages - stages in execution order.
 * @returns the last stage with a failing status.
 */
export function failedStage(stages: readonly JenkinsStage[]): JenkinsStage | undefined {
  return [...stages].reverse().find(stage => FAILED_STAGE_STATUSES.has(stage.status))
}

/** One Pipeline stage of a build. */
export interface JenkinsStage {
  /** Stage name as declared in the pipeline. */
  name: string
  /** Jenkins stage status, passed through unchanged. */
  status: string
  /** Stage start time in epoch milliseconds when Jenkins reported one. */
  startedAt?: number
  /** Stage duration in milliseconds when Jenkins reported one. */
  durationMs?: number
}

/** Stage progress of a running build. */
export interface JenkinsProgress {
  /** Stages that already reached a terminal status. */
  completed: number
  /** Stages the pipeline declares. */
  total: number
}

/** Map a Jenkins job color to the plugin's coarse status vocabulary. */
export function jobStatusFromColor(color: unknown): JenkinsJobStatus {
  const value = typeof color === 'string' ? color : ''
  if (value.startsWith('blue')) return value.includes('anime') ? 'running' : 'success'
  if (value.startsWith('red')) return value.includes('anime') ? 'running' : 'failure'
  if (value.startsWith('yellow')) return value.includes('anime') ? 'running' : 'unstable'
  if (value === 'aborted' || value === 'aborted_anime') return 'aborted'
  if (value === 'disabled') return 'disabled'
  if (value === 'notbuilt' || value === 'notbuilt_anime') return 'not-built'
  return 'unknown'
}

