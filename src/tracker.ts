/**
 * Live build tracking.
 *
 * The panel follows several builds at once and wants them to move without asking
 * constantly, so the host keeps one record per followed build and decides when
 * each may be polled again. Three rules drive every decision here, and all three
 * are cheap to get wrong:
 *
 * - **No subscribers, no polling.** A record is only polled while something is
 *   watching; an idle panel must cost Jenkins nothing (SPEC §10).
 * - **Back off when nothing moves.** A build whose stage list has not changed
 *   since the previous poll is polled at a growing interval, up to
 *   `idleBackoffMaxMs`, so a long build does not cost a request every few
 *   seconds.
 * - **Only the selected build pulls its log.** Progress polling is one request
 *   per tracked build; log polling happens at `logIntervalMs` for the single
 *   build the panel is showing (SPEC §10).
 *
 * The decision function is pure so the backoff can be tested without a clock,
 * a controller, or a timer.
 * @module dsh-jenkins-plugin/tracker
 */

import type { Config } from './config.js'
import { JenkinsError } from './jenkins/client.js'
import type { JenkinsBuildProgress, JenkinsChange, JenkinsStage } from './jenkins/types.js'

/** What a tracked build is doing. */
export type TrackState = 'queued' | 'running' | 'finished' | 'detached'

/** One tracked build. */
export interface TrackedBuild {
  /** Stable identity: `<instanceId>/<jobPath>#<buildNumber>`, or `…@<queueId>` while queued. */
  id: string
  /** Instance the build belongs to. */
  instanceId: string
  /** Job path. */
  jobPath: string
  /** Build number, absent until a queued item is assigned one. */
  buildNumber?: number
  /** Queue item the trigger answered, while the build has no number yet. */
  queueId?: number
  /** Epoch ms the build was queued, which is what the queue timeout counts from. */
  queuedAt?: number
  /** Lifecycle state. */
  state: TrackState
  /** Last known outcome, once terminal. */
  outcome?: string
  /** Why the record is not being followed any more, when it is detached. */
  note?: string
  /** Last known progress. */
  progress?: JenkinsBuildProgress
  /** Last known stages, kept so a snapshot can be served without a poll. */
  stages?: JenkinsStage[]
  /** Newest commits in this build, newest first and bounded. */
  changes?: JenkinsChange[]
  /** How many commits the build carries in total, when it reported any. */
  changeCount?: number
  /** Epoch ms of the last successful poll. */
  polledAt: number
  /** Current interval between polls, in milliseconds. */
  intervalMs: number
  /** Fingerprint of the last stage list, used to detect "nothing changed". */
  fingerprint: string
  /** Epoch ms when this record was last requested by a subscriber. */
  subscribedAt: number
}

/** One subscriber: a panel watching the tracker. */
export interface TrackerSubscriber {
  /** Called whenever any tracked record changes. */
  notify(): void
}

/**
 * Whether a failed poll means the record itself is wrong, rather than the read.
 *
 * The distinction decides whether a record is dropped or retried, and it matters
 * more than it looks: a record naming a job the controller does not have fails
 * on every single tick, so retrying it forever is not merely wasteful — with one
 * poll call for the whole batch, an earlier failure used to leave every other
 * build unrefreshed, which a person sees as a panel where nothing ever moves.
 * A credential or network problem is the opposite case: the whole controller is
 * unreachable, the records are still wanted, and the next tick should try again.
 * @param error - what the poll threw.
 * @returns true when the record should be detached instead of retried.
 */
export function isRecordGone(error: unknown): boolean {
  return error instanceof JenkinsError && (error.code === 'not-found' || error.code === 'config')
}

/**
 * Build the stable id of one tracked build.
 * @param instanceId - instance id.
 * @param jobPath - job path.
 * @param buildNumber - build number.
 * @returns the tracking id.
 */
export function trackingId(instanceId: string, jobPath: string, buildNumber: number): string {
  return `${instanceId}/${jobPath}#${buildNumber}`
}

/**
 * Build the temporary id of a queued build.
 *
 * A triggered build has no number until an executor picks it up, so it is held
 * under its queue item and re-keyed to {@link trackingId} the moment the number
 * is known. The temporary id is deliberately not a build id, so nothing can
 * mistake a queue item for a build.
 * @param instanceId - instance id.
 * @param jobPath - job path.
 * @param queueId - queue item id.
 * @returns the tracking id of the queued record.
 */
export function queueTrackingId(instanceId: string, jobPath: string, queueId: number): string {
  return `${instanceId}/${jobPath}@${queueId}`
}

/**
 * Fingerprint a stage list, so "did anything change" is one comparison.
 * @param stages - the stages as last seen.
 * @returns a string that changes exactly when the visible stage state changes.
 */
export function fingerprintStages(stages: readonly JenkinsStage[]): string {
  return stages.map(stage => `${stage.name}:${stage.status}`).join('|')
}

/**
 * Whether a tracked record may be polled now.
 *
 * A finished or detached record is never polled again, which is what keeps a
 * long-lived tracker from accumulating requests for builds that ended. A queued
 * record is polled like a running one: its queue item is the only way to learn
 * the build number it will become.
 * @param record - the record to test.
 * @param now - current epoch milliseconds.
 * @returns true when the record is due.
 */
export function isDue(record: TrackedBuild, now: number): boolean {
  if (record.state !== 'running' && record.state !== 'queued') return false
  return now - record.polledAt >= record.intervalMs
}

/**
 * The interval to use after one poll.
 *
 * Progress that moved resets the interval to the configured base, because the
 * build is doing something and the panel should keep up. Progress that did not
 * move doubles it up to the configured ceiling, so a build in a slow step stops
 * costing a request every few seconds.
 * @param previous - the interval used for the poll that just finished.
 * @param changed - whether the stage state changed since the previous poll.
 * @param config - validated plugin configuration.
 * @returns the interval for the next poll.
 */
export function nextInterval(previous: number, changed: boolean, config: Config): number {
  if (changed && previous > config.progressIntervalMs) return config.progressIntervalMs
  if (!changed) return Math.min(previous * 2, config.idleBackoffMaxMs)
  return config.progressIntervalMs
}

/**
 * Keep one record per followed build, decide what to poll, and fan changes out
 * to the subscribers.
 *
 * The tracker holds no timer of its own: {@link due} is asked by whoever owns
 * the tick, which keeps this class free of the clock and therefore testable.
 */
export class BuildTracker {
  private readonly records = new Map<string, TrackedBuild>()
  private readonly subscribers = new Set<TrackerSubscriber>()
  private timer: ReturnType<typeof setInterval> | undefined
  private polling = false

  /**
   * @param config - validated plugin configuration.
   */
  constructor(private readonly config: Config) {}

  /**
   * Attach the poll callback and start the loop.
   *
   * The loop lives here, next to the subscriber count, because "no subscribers,
   * no polling" is otherwise a rule every caller has to remember. Starting it
   * with the callback means there is exactly one timer and exactly one place
   * that can stop it.
   * @param poll - called with the records due for a refresh.
   */
  start(poll: (due: readonly TrackedBuild[]) => Promise<void>): void {
    this.poll = poll
    // A tick faster than the base interval, so a record whose interval is the
    // base is picked up promptly rather than up to a tick late.
    const tick = Math.max(250, Math.floor(this.config.progressIntervalMs / 2))
    this.timer = setInterval(() => { void this.runTick() }, tick)
  }

  /** Stop the loop and release the poll callback. */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.poll = undefined
  }

  private poll: ((due: readonly TrackedBuild[]) => Promise<void>) | undefined

  /** One tick: sweep expired records, then refresh whatever is due. */
  private async runTick(): Promise<void> {
    // No subscriber means nobody can see a change, so nothing is fetched and
    // nothing is swept; an unwatched tracker costs exactly zero requests.
    if (!this.watched || this.poll === undefined) return
    // A tick that overruns its interval has been superseded; overlapping ticks
    // would double the request rate rather than speed anything up.
    if (this.polling) return
    this.polling = true
    try {
      this.sweep()
      const due = this.due()
      if (due.length > 0) await this.poll(due)
    } catch {
      // Polling is best effort; the next tick retries with the same records.
      // A failure is surfaced to the panel through the record it did not
      // refresh, not by killing the loop.
    } finally {
      this.polling = false
    }
  }

  /** How many records are held, for diagnostics and tests. */
  get size(): number {
    return this.records.size
  }

  /**
   * Whether anything is watching.
   *
   * This is the gate the whole polling loop reads: with no subscriber there is
   * nothing to draw a snapshot for, so no request is issued.
   * @returns true when at least one subscriber is attached.
   */
  get watched(): boolean {
    return this.subscribers.size > 0
  }

  /**
   * Attach a subscriber, stamping every record as freshly requested.
   * @param subscriber - the subscriber to attach.
   * @returns a detacher.
   */
  subscribe(subscriber: TrackerSubscriber): () => void {
    this.subscribers.add(subscriber)
    const now = Date.now()
    for (const record of this.records.values()) record.subscribedAt = now
    return () => { this.subscribers.delete(subscriber) }
  }

  /**
   * Track one build, or return the record already held for it.
   *
   * Re-tracking is idempotent and does not reset a record's backoff: a panel
   * that re-renders must not make a slow build expensive again.
   * @param instanceId - instance id.
   * @param jobPath - job path.
   * @param buildNumber - build number.
   * @returns the record.
   */
  track(instanceId: string, jobPath: string, buildNumber: number): TrackedBuild {
    const id = trackingId(instanceId, jobPath, buildNumber)
    const existing = this.records.get(id)
    if (existing !== undefined) {
      existing.subscribedAt = Date.now()
      return existing
    }
    const record: TrackedBuild = {
      id,
      instanceId,
      jobPath,
      buildNumber,
      state: 'running',
      polledAt: 0,
      intervalMs: this.config.progressIntervalMs,
      fingerprint: '',
      subscribedAt: Date.now(),
    }
    this.records.set(id, record)
    // Announced, because a record appearing is itself a change a panel draws:
    // without this a build would only reach the panel on its first poll.
    this.publish()
    return record
  }

  /**
   * Track a build that has only just been triggered.
   *
   * The trigger answers a queue item, not a build, so the record starts life
   * without a number and is polled as a queue item until one appears. This is
   * the only way a build the user just started shows up in the panel before
   * Jenkins has assigned it a number (SPEC §8).
   * @param instanceId - instance id.
   * @param jobPath - job path.
   * @param queueId - the queue item the trigger answered.
   * @returns the record.
   */
  trackQueue(instanceId: string, jobPath: string, queueId: number): TrackedBuild {
    const id = queueTrackingId(instanceId, jobPath, queueId)
    const existing = this.records.get(id)
    if (existing !== undefined) {
      existing.subscribedAt = Date.now()
      return existing
    }
    const record: TrackedBuild = {
      id,
      instanceId,
      jobPath,
      queueId,
      queuedAt: Date.now(),
      state: 'queued',
      polledAt: 0,
      intervalMs: this.config.progressIntervalMs,
      fingerprint: '',
      subscribedAt: Date.now(),
    }
    this.records.set(id, record)
    // Announced immediately: the click that triggered this build is what the
    // panel wants to see acknowledged, and waiting for the first poll would leave
    // the card looking as though nothing had happened.
    this.publish()
    return record
  }

  /**
   * Re-key a queued record to the build it became.
   *
   * The identity of a tracked build is its number, and the panel matches records
   * against what the job listing reports — so adoption is what makes a triggered
   * build appear on its card. When the panel had already subscribed to that
   * build, the queued record is merged into the one it named instead of leaving
   * two records for one build.
   * @param id - the queued record's id.
   * @param buildNumber - the number the queue item was assigned.
   * @returns the adopted record, or undefined when nothing was queued under that id.
   */
  adopt(id: string, buildNumber: number): TrackedBuild | undefined {
    const queued = this.records.get(id)
    if (queued === undefined) return undefined
    const adopted = trackingId(queued.instanceId, queued.jobPath, buildNumber)
    if (adopted === id) {
      queued.buildNumber = buildNumber
      queued.queueId = undefined
      queued.queuedAt = undefined
      queued.state = 'running'
      return queued
    }
    this.records.delete(id)
    const existing = this.records.get(adopted)
    if (existing !== undefined && existing.state === 'running') {
      // The panel was already following that build, and its record is the better
      // one: it has been polled, while this one only ever held a queue id.
      existing.subscribedAt = Math.max(existing.subscribedAt, queued.subscribedAt)
      return existing
    }
    // A record for that number that is already over is superseded rather than
    // merged into: this number is live again, so the old record described a build
    // that is no longer what the number refers to. Merging would keep the
    // terminal state and report a running build as finished.
    if (existing !== undefined) this.records.delete(adopted)
    queued.id = adopted
    queued.buildNumber = buildNumber
    queued.queueId = undefined
    queued.queuedAt = undefined
    queued.state = 'running'
    this.records.set(adopted, queued)
    return queued
  }

  /**
   * Stop following one record, keeping it visible.
   *
   * Used when a queue item expires or is cancelled: the record stays in the
   * snapshot so the panel can say what happened instead of the row silently
   * vanishing, and it is never polled again.
   * @param id - the record's id.
   * @param note - why it is no longer followed.
   * @returns the updated record, or undefined when it is not held.
   */
  detach(id: string, note: string): TrackedBuild | undefined {
    const record = this.records.get(id)
    if (record === undefined) return undefined
    record.state = 'detached'
    record.note = note
    record.polledAt = Date.now()
    this.publish()
    return record
  }

  /** Every record, queued first, then newest build first. */
  list(): TrackedBuild[] {
    return [...this.records.values()].sort((left, right) => {
      // Infinity rather than a sentinel number: a queued record has no number
      // and belongs at the top, next to the newest build.
      const leftNumber = left.buildNumber ?? Number.POSITIVE_INFINITY
      const rightNumber = right.buildNumber ?? Number.POSITIVE_INFINITY
      if (leftNumber === rightNumber) return 0
      return rightNumber - leftNumber
    })
  }

  /** One record by id, or undefined. */
  get(id: string): TrackedBuild | undefined {
    return this.records.get(id)
  }

  /**
   * The whole tracked set, ready to serialize onto the wire.
   *
   * A snapshot rather than a diff on purpose: a panel that reconnects after a
   * laptop sleep needs no replay bookkeeping, and the set is small by
   * construction (`maxTrackedBuilds` bounds it).
   * @returns every tracked record, as plain data.
   */
  snapshot(): Array<Record<string, unknown>> {
    return [...this.records.values()].map(record => ({
      id: record.id,
      instanceId: record.instanceId,
      jobPath: record.jobPath,
      // A queued record has no number yet; sending `undefined` would be a field
      // that JSON drops anyway, so it is left out and the panel asks for `state`
      // and `queueId` instead.
      ...record.buildNumber === undefined ? {} : { buildNumber: record.buildNumber },
      ...record.queueId === undefined ? {} : { queueId: record.queueId },
      state: record.state,
      ...record.outcome === undefined ? {} : { outcome: record.outcome },
      ...record.note === undefined ? {} : { note: record.note },
      ...record.progress === undefined ? {} : { progress: record.progress },
      ...record.stages === undefined ? {} : { stages: record.stages },
      ...record.changes === undefined ? {} : { changes: record.changes },
      ...record.changeCount === undefined ? {} : { changeCount: record.changeCount },
      polledAt: record.polledAt,
      intervalMs: record.intervalMs,
    }))
  }

  /**
   * The records that may be polled now.
   *
   * Empty without a subscriber, which is what makes an unwatched tracker free.
   * @param now - current epoch milliseconds.
   * @returns the records due for a poll.
   */
  due(now: number = Date.now()): TrackedBuild[] {
    if (!this.watched) return []
    const out: TrackedBuild[] = []
    for (const record of this.records.values()) {
      if (isDue(record, now)) out.push(record)
    }
    return out
  }

  /**
   * Record the result of one poll.
   *
   * This is where the backoff is decided, so the caller needs no knowledge of
   * intervals: it reports what it saw and the tracker decides when to ask again.
   * @param id - the tracked build's id.
   * @param observation - the stages, outcome, and any build number just observed.
   * @returns the updated record, or undefined when it is no longer tracked.
   */
  observe(
    id: string,
    observation: {
      stages?: JenkinsStage[]
      progress?: JenkinsBuildProgress
      outcome?: string
      finished?: boolean
      /** Commits this build carries, newest first and already bounded by the caller. */
      changes?: JenkinsChange[]
      /** How many commits the build carries in total. */
      changeCount?: number
      /** The number a queued item was just assigned, which re-keys the record. */
      buildNumber?: number
    },
  ): TrackedBuild | undefined {
    // Adoption first: everything below is about a build, and a queued item is
    // not one until this happens.
    const target = observation.buildNumber === undefined
      ? this.records.get(id)
      : this.adopt(id, observation.buildNumber)
    if (target === undefined) return undefined
    const fingerprint = fingerprintStages(observation.stages ?? [])
    const changed = fingerprint !== target.fingerprint
    target.fingerprint = fingerprint
    target.polledAt = Date.now()
    target.intervalMs = nextInterval(target.intervalMs, changed, this.config)
    if (observation.stages !== undefined) target.stages = observation.stages
    if (observation.progress !== undefined) target.progress = observation.progress
    if (observation.outcome !== undefined) target.outcome = observation.outcome
    if (observation.changes !== undefined) target.changes = observation.changes
    if (observation.changeCount !== undefined) target.changeCount = observation.changeCount
    if (observation.finished === true) {
      // Terminal records stop being polled; they stay only until the retained
      // window expires so a late-joining panel can still render them once.
      target.state = target.outcome === undefined ? 'detached' : 'finished'
    }
    this.publish()
    return target
  }

  /**
   * Drop records whose build finished longer ago than `retainMs`.
   *
   * SPEC §8's retention window: a finished build is useful to a panel that was
   * away for a few minutes and useless after that, and keeping it forever would
   * grow the tracker without bound. A queued or running record is never swept —
   * its work is not over, and a queued record that never resolves is ended by
   * the queue timeout instead, which turns it into a detached one that this then
   * collects.
   * @param now - current epoch milliseconds.
   * @returns how many records were dropped.
   */
  sweep(now: number = Date.now()): number {
    let dropped = 0
    for (const [id, record] of this.records) {
      if (record.state === 'running' || record.state === 'queued') continue
      if (now - record.polledAt < this.config.retainMs) continue
      this.records.delete(id)
      dropped += 1
    }
    return dropped
  }

  /** Tell every subscriber that the snapshot changed. */
  private publish(): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber.notify()
      } catch {
        // A subscriber that throws is the subscriber's failure; one broken
        // panel must not stop the others from being told.
      }
    }
  }
}
