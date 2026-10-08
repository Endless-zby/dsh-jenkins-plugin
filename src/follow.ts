/**
 * Completion notifications for followed jobs, and the failure wake.
 *
 * The operator follows jobs in the panel to hear when they finish, so this is
 * the one place that watches Jenkins on its own initiative. Its rules, in order
 * of how easy they are to get wrong:
 *
 * - **Only followed jobs are polled.** A controller with a thousand jobs must
 *   cost one listing per instance per tick, not one per job.
 * - **A notice is owed once per build.** The bookkeeping is in `watch.ts`; this
 *   module only delivers what that decides, so a build that is merely re-read
 *   cannot announce twice.
 * - **The notice is delivered through the platform's own background-job
 *   mechanism** (`ctx.jobs.start`), which is what turns it into a session
 *   notification the model and the user both see, exactly once (`reported`).
 *   That mechanism resolves the job on the tick it is registered, so the job
 *   exists only to carry the notice.
 * - **A failure also wakes the session that followed the job.** The wake rides
 *   the same once-per-build decision, so it cannot arrive twice for one build;
 *   it goes to the session recorded on the favorite, and it stays silent when
 *   that session has no live agent (a closed conversation is not an error). The
 *   log hand-off itself is the same one the panel's button performs.
 * @module dsh-jenkins-plugin/follow
 */

import type { Context } from '@deepseek-ai/cordis'
import { handOverFailure } from './analyze.js'
import type { AnalyzeReads } from './analyze.js'
import type { Config } from './config.js'
import type { InstanceRegistry } from './connection.js'
import { followupFor } from './handoff.js'
import { NoticeLog, jobNoticeKey, noticeLabel, pendingNotices, shouldWake, wakeRoutes } from './watch.js'
import type { BuildNotice, WatchedJob } from './watch.js'

/**
 * The slice of `ctx.jobs` this module uses.
 *
 * Declared structurally rather than imported so the plugin keeps working in a
 * composition that mounts no job service: `ctx.get('jobs')` then returns
 * `undefined` and the watcher simply never starts.
 */
interface JobsService {
  start(spec: {
    kind: string
    label: string
    run(): { cancel(reason?: string): void, done: Promise<{ status: string, detail?: string, output?: string }> }
  }): string
}

/** The plugin's kind in the platform's job list. */
const JOB_KIND = 'jenkins'

/** A build never takes longer than this to be worth waiting for as a job. */
const NOTICE_LIFETIME_MS = 250

/** Where one followed job's failures should be reported, and through what. */
interface WakeSource {
  /** The Jenkins reads the hand-off needs. */
  client: AnalyzeReads
  /** Instance name, for the prompt's context. */
  instanceName: string
}

/** One tick's findings: what finished, who should hear about it, and how to read it. */
interface FollowedState {
  /** One row per followed job. */
  jobs: WatchedJob[]
  /** Route key to the session that followed the job. */
  sessions: Map<string, string>
  /** Instance id to the client and name a wake needs. */
  sources: Map<string, WakeSource>
}

/**
 * Watches followed jobs and announces finished builds.
 *
 * One instance per plugin load; {@link start} arms it and the returned disposer
 * stops the timer and releases every registration.
 */
export class FollowWatcher {
  private readonly announced = new NoticeLog()
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false

  /**
   * @param ctx - plugin context, used to reach the optional job and agent services.
   * @param registry - reads the instances, the followed set, and their jobs.
   * @param config - validated plugin configuration.
   */
  constructor(
    private readonly ctx: Context,
    private readonly registry: InstanceRegistry,
    private readonly config: Config,
  ) {}

  /**
   * Arm the watcher.
   *
   * Does nothing when neither channel can deliver anything — notices switched
   * off, no job service, wake switched off, no agent runtime — because a watcher
   * that would poll Jenkins and then drop what it found only burns requests.
   * @returns a disposer stopping the watcher.
   */
  start(): () => void {
    if (!this.wantsNotices() && !this.wantsWake()) return () => {}
    this.timer = setInterval(() => { void this.tick() }, this.config.progressIntervalMs)
    // A first tick runs immediately so a build that finished while the plugin
    // was down is announced without waiting a whole interval.
    void this.tick()
    return () => {
      if (this.timer !== undefined) clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /**
   * Whether a finished build should become a platform completion notice.
   * @returns true when the configuration and the composition both allow it.
   */
  private wantsNotices(): boolean {
    return this.config.notifyOnComplete && this.ctx.get('jobs') !== undefined
  }

  /**
   * Whether a failed build should wake the session that followed it.
   *
   * `allowAnalyze` gates this too: it is the switch that says "build logs may be
   * sent to a model", and a wake sends the same log tail the panel's button does.
   * @returns true when the configuration and the composition both allow it.
   */
  private wantsWake(): boolean {
    return this.config.notifyWakeOnFailure
      && this.config.allowAnalyze
      && this.ctx.get('agents') !== undefined
  }

  /**
   * One poll: read every instance's followed jobs and announce what finished.
   *
   * Re-entrancy is prevented with a flag rather than a queue: a tick that
   * overruns its interval has already been superseded, and running two against
   * the same registry would only duplicate work.
   * @returns a promise resolving when the tick has delivered its notices.
   */
  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const followed = await this.followedStates()
      if (followed.jobs.length === 0) return
      for (const notice of pendingNotices(followed.jobs, this.announced.snapshot())) {
        // Recorded before delivery: the record must not depend on a delivery
        // succeeding, or a throwing job service would announce the same build
        // again on the next tick.
        this.announced.add(notice.key)
        if (this.wantsNotices()) this.deliver(noticeLabel(notice))
        // The wake rides the same decision, so one build can never wake twice —
        // not even when the completion notice could not be delivered.
        if (this.wantsWake() && shouldWake(notice.outcome)) await this.wake(notice, followed)
      }
    } catch {
      // Polling is best effort: a controller that is down, a credential that was
      // rotated, or a settings file being rewritten must not kill the watcher.
      // The next tick tries again, and the panel is where failures are shown.
    } finally {
      this.running = false
    }
  }

  /**
   * Read the current build state of every followed job, across every instance.
   * @returns one row per followed job, plus the routing a wake needs.
   */
  private async followedStates(): Promise<FollowedState> {
    const { instances } = await this.registry.list()
    const jobs: WatchedJob[] = []
    const sessions = new Map<string, string>()
    const sources = new Map<string, WakeSource>()
    for (const instance of instances) {
      const favorites = await this.registry.favorites(instance.id)
      if (favorites.length === 0) continue
      // One listing per instance answers every followed job on it, which is the
      // bound that keeps this cheap on a large controller.
      const resolved = await this.registry.require(instance.id)
      const jobsOnInstance = await resolved.client.listJobs()
      const byPath = new Map(jobsOnInstance.map(job => [job.path, job]))
      for (const favorite of favorites) {
        for (const [route, sessionId] of wakeRoutes(instance.id, [favorite])) sessions.set(route, sessionId)
        const job = byPath.get(favorite.path)
        if (job === undefined) continue
        sources.set(instance.id, { client: resolved.client, instanceName: resolved.instance.name })
        const build = job.lastBuild
        jobs.push({
          instanceId: instance.id,
          jobPath: favorite.path,
          ...build === undefined ? {} : { buildNumber: build.number, outcome: build.outcome, building: build.building },
        })
      }
    }
    return { jobs, sessions, sources }
  }

  /**
   * Wake the session that followed a failed build.
   *
   * Every failure mode here is silent by design: a favorite with no recorded
   * session, a session with no live agent, a controller that stopped answering.
   * The build is already recorded as announced, so a wake that could not be
   * delivered is dropped rather than retried on every tick.
   * @param notice - the build that failed.
   * @param followed - this tick's routing.
   */
  private async wake(notice: BuildNotice, followed: FollowedState): Promise<void> {
    const sessionId = followed.sessions.get(jobNoticeKey(notice.instanceId, notice.jobPath))
    if (sessionId === undefined) return
    const source = followed.sources.get(notice.instanceId)
    if (source === undefined) return
    const sink = followupFor(this.ctx, sessionId)
    if (sink.kind !== 'ok') return
    try {
      await handOverFailure({
        client: source.client,
        jobPath: notice.jobPath,
        buildNumber: notice.buildNumber,
        logBytes: this.config.analyzeLogBytes,
        instanceName: source.instanceName,
        followup: sink.followup,
      })
    } catch {
      // A build that failed to hand over stays announced: the alternative is a
      // wake attempt against a broken controller on every single tick.
    }
  }

  /**
   * Hand one finished build to the platform's background-job mechanism.
   *
   * The job settles on the next tick by design: the notice is the payload, and
   * holding it open would make a finished build look like running work in the
   * job list.
   * @param label - the one-line notice text.
   */
  private deliver(label: string): void {
    const jobs = this.ctx.get('jobs') as JobsService | undefined
    if (jobs === undefined) return
    try {
      jobs.start({
        kind: JOB_KIND,
        label,
        run: () => {
          let settle: (outcome: { status: string, output?: string }) => void = () => {}
          const done = new Promise<{ status: string, output?: string }>((resolve) => { settle = resolve })
          const timer = setTimeout(() => { settle({ status: 'completed', output: label }) }, NOTICE_LIFETIME_MS)
          return {
            cancel: () => {
              clearTimeout(timer)
              settle({ status: 'killed' })
            },
            done,
          }
        },
      })
    } catch {
      // A full job list or an absent controller must not break the watcher; the
      // build stays announced, so the operator loses one notice rather than
      // getting an endless stream of retries.
    }
  }
}
