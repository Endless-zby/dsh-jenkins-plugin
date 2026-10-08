/**
 * Watched-build bookkeeping.
 *
 * The panel follows a set of jobs; this decides which of their builds deserve a
 * completion notice. It is deliberately pure — no clock, no network, no cordis —
 * so the transition rules can be tested directly, because "notice exactly once
 * per finished build" is the kind of rule that is easy to get subtly wrong.
 *
 * A notice is owed when a followed job's newest build reaches a terminal state
 * and that exact build has not been announced yet. State is keyed by
 * `instanceId/jobPath#buildNumber` rather than by job, so a job that runs twice
 * announces twice while a job that is merely re-read announces once.
 * @module dsh-jenkins-plugin/watch
 */

/** One followed job as the watcher needs to see it. */
export interface WatchedJob {
  /** Instance the job belongs to. */
  instanceId: string
  /** Job path. */
  jobPath: string
  /** Latest build number, absent when the job never ran. */
  buildNumber?: number
  /** Latest build's outcome. */
  outcome?: string
  /** Whether the latest build still runs. */
  building?: boolean
}

/** One build that just finished and has not been announced. */
export interface BuildNotice {
  /** Instance the job belongs to. */
  instanceId: string
  /** Job path. */
  jobPath: string
  /** The build that finished. */
  buildNumber: number
  /** Terminal outcome. */
  outcome: string
  /** Key to record once the notice is delivered. */
  key: string
}

/** Outcomes that mean a build will not change again. */
const TERMINAL = new Set(['success', 'failure', 'unstable', 'aborted', 'not-built'])

/**
 * The key one build is remembered under.
 * @param instanceId - instance id.
 * @param jobPath - job path.
 * @param buildNumber - build number.
 * @returns the announcement key.
 */
export function noticeKey(instanceId: string, jobPath: string, buildNumber: number): string {
  return `${instanceId}/${jobPath}#${buildNumber}`
}

/**
 * Whether a build outcome is terminal.
 * @param outcome - the outcome to test.
 * @returns true when the build will not change again.
 */
export function isTerminal(outcome: string | undefined): boolean {
  return outcome !== undefined && TERMINAL.has(outcome)
}

/**
 * Decide which followed builds owe a completion notice.
 *
 * A build is announced only when its outcome is terminal **and** it is not
 * already in `announced`. A build first seen already finished (because it ended
 * while the plugin was not watching) is announced too: the operator followed the
 * job to hear about this build, and the fact that it finished a moment before
 * the watcher looked does not make it uninteresting.
 * @param jobs - the followed jobs' current state.
 * @param announced - keys already announced.
 * @returns the notices to deliver, in the order given.
 */
export function pendingNotices(
  jobs: readonly WatchedJob[],
  announced: ReadonlySet<string>,
): BuildNotice[] {
  const notices: BuildNotice[] = []
  for (const job of jobs) {
    if (job.buildNumber === undefined) continue
    // A running build has no outcome to report yet, whatever `outcome` says
    // about its previous run.
    if (job.building === true) continue
    if (!isTerminal(job.outcome)) continue
    const key = noticeKey(job.instanceId, job.jobPath, job.buildNumber)
    if (announced.has(key)) continue
    notices.push({
      instanceId: job.instanceId,
      jobPath: job.jobPath,
      buildNumber: job.buildNumber,
      outcome: job.outcome as string,
      key,
    })
  }
  return notices
}

/**
 * Render the one-line notice text for a finished build.
 * @param notice - the build that finished.
 * @returns the label shown in the job list and the completion notice.
 */
export function noticeLabel(notice: BuildNotice): string {
  return `Jenkins ${notice.jobPath} #${notice.buildNumber} ${notice.outcome}`
}

/**
 * Remember announced builds, bounded so a long-lived process cannot grow
 * without limit.
 *
 * Oldest keys are dropped first: a build that finished long ago is not going to
 * be re-announced, and keeping the most recent window is what protects against a
 * duplicate notice in practice.
 */
export class NoticeLog {
  private readonly keys: string[] = []
  private readonly seen = new Set<string>()

  /**
   * @param limit - how many keys to remember.
   */
  constructor(private readonly limit = 500) {}

  /** Whether a key has been announced. */
  has(key: string): boolean {
    return this.seen.has(key)
  }

  /** Every remembered key, for handing to {@link pendingNotices}. */
  snapshot(): ReadonlySet<string> {
    return this.seen
  }

  /** Record one key, evicting the oldest when the bound is reached. */
  add(key: string): void {
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.keys.push(key)
    while (this.keys.length > this.limit) {
      const oldest = this.keys.shift()
      if (oldest !== undefined) this.seen.delete(oldest)
    }
  }
}
