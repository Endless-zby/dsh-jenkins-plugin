/**
 * Completion notifications for followed jobs.
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
 * @module dsh-jenkins-plugin/follow
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import type { InstanceRegistry } from './connection.js'
import { NoticeLog, noticeLabel, pendingNotices } from './watch.js'
import type { WatchedJob } from './watch.js'

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
   * @param ctx - plugin context, used to reach the optional job service.
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
   * Does nothing when the operator turned completion notices off or when the
   * composition mounts no job service — both are ordinary compositions, not
   * errors, and a watcher with nowhere to deliver would only burn requests.
   * @returns a disposer stopping the watcher.
   */
  start(): () => void {
    if (!this.config.notifyOnComplete) return () => {}
    if (this.ctx.get('jobs') === undefined) return () => {}
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
      const jobs = await this.followedStates()
      if (jobs.length === 0) return
      for (const notice of pendingNotices(jobs, this.announced.snapshot())) {
        // Recorded before delivery: the record must not depend on a delivery
        // succeeding, or a throwing job service would announce the same build
        // again on the next tick.
        this.announced.add(notice.key)
        this.deliver(noticeLabel(notice))
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
   * @returns one row per followed job.
   */
  private async followedStates(): Promise<WatchedJob[]> {
    const { instances } = await this.registry.list()
    const out: WatchedJob[] = []
    for (const instance of instances) {
      const favorites = await this.registry.favorites(instance.id)
      if (favorites.length === 0) continue
      // One listing per instance answers every followed job on it, which is the
      // bound that keeps this cheap on a large controller.
      const resolved = await this.registry.require(instance.id)
      const jobs = await resolved.client.listJobs()
      const byPath = new Map(jobs.map(job => [job.path, job]))
      for (const favorite of favorites) {
        const job = byPath.get(favorite.path)
        if (job === undefined) continue
        const build = job.lastBuild
        out.push({
          instanceId: instance.id,
          jobPath: favorite.path,
          ...build === undefined ? {} : { buildNumber: build.number, outcome: build.outcome, building: build.building },
        })
      }
    }
    return out
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
