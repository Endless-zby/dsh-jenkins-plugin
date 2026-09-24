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
  /** Jenkins result, or null while the build runs. */
  result: string | null
  /** Whether the build is still running. */
  building: boolean
  /** Start time as epoch milliseconds. */
  timestamp: number
  /** Duration in milliseconds, zero while running. */
  duration: number
  /** Absolute Jenkins URL of the build. */
  url: string
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

/** Stage statuses that count as finished for {@link JenkinsProgress}. */
const TERMINAL_STAGE_STATUSES = new Set(['SUCCESS', 'FAILED', 'ABORTED', 'UNSTABLE', 'NOT_EXECUTED', 'SKIPPED'])

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
