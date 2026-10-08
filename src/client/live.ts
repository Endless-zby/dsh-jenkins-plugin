/**
 * The rules that turn the host's live snapshots into what a card draws.
 *
 * These live apart from the React component so they can be asserted directly.
 * Which builds are worth following, which record belongs to which card, and when
 * the followed list has itself gone stale are decisions rather than rendering,
 * and they are the part of the panel that is easy to get subtly wrong.
 * @module dsh-jenkins-plugin/client/live
 */

import type { ChangeRow, FavoriteRow, ProgressRow, StageRow, TrackedRow } from './api.js'

/** One listing of followed jobs, tagged with the instance it came from. */
export interface FavoriteSnapshot {
  /** Instance the listing was read from. */
  instanceId: string
  /** The followed jobs, as that instance reported them. */
  rows: FavoriteRow[]
}

/**
 * The followed jobs the panel may draw for the instance it is showing.
 *
 * The panel holds one snapshot of the followed list, and a switch of instance
 * leaves it one render behind: for the render right after the switch, the
 * instance id is already the new one while the rows are still the old
 * controller's. Using them would ask the new controller about jobs it has never
 * heard of — one 404 per poll, which is how a card that stayed "queued" forever
 * was eventually explained. Tagging the snapshot makes that state unrepresentable
 * rather than merely unlikely.
 * @param snapshot - the last listing the panel read, if any.
 * @param instanceId - the instance actually being drawn.
 * @returns that instance's followed jobs, or none when the snapshot is from another.
 */
export function favoritesOf(snapshot: FavoriteSnapshot | undefined, instanceId: string): FavoriteRow[] {
  if (snapshot === undefined || snapshot.instanceId !== instanceId) return []
  return snapshot.rows
}

/**
 * The builds worth asking the host to follow.
 *
 * Only builds that are still running: a finished build's numbers already came
 * with the listing and never move again, so following one would cost the
 * controller a request per card and tell the panel nothing. On a controller with
 * many followed jobs that is the difference between an idle panel and a busy
 * one.
 * @param favorites - the followed jobs as the last listing reported them.
 * @returns `<jobPath>#<buildNumber>` keys, sorted so the subscription URL is stable.
 */
export function buildsToFollow(favorites: readonly FavoriteRow[] | undefined): string[] {
  return (favorites ?? [])
    .flatMap((row) => {
      const build = row.job?.lastBuild
      return build === undefined || build.building !== true ? [] : [`${row.path}#${build.number}`]
    })
    .sort()
}

/**
 * The records belonging to one instance, keyed by the tracker's id.
 *
 * The host keeps a single table for every configured controller, so one
 * snapshot carries other instances' builds too. Drawing them would put another
 * controller's numbers on this instance's cards.
 * @param tracked - every record in the snapshot.
 * @param instanceId - instance the panel is showing.
 * @returns the records for that instance.
 */
export function recordsFor(tracked: readonly TrackedRow[], instanceId: string): Map<string, TrackedRow> {
  return new Map(
    tracked.filter(record => record.instanceId === instanceId).map(record => [record.id, record]),
  )
}

/**
 * The line a card shows for the commits a build carries.
 *
 * One line, because that is all a card in a narrow column can hold: the newest
 * commit's short id and the first line of its message, plus how many more there
 * were. A commit message's body is where the noise lives, so only its first line
 * is used — and the full text is left for the caller to put in a tooltip.
 * @param changes - the commits as the live record holds them, newest first.
 * @param total - how many the build carries in total, when it said.
 * @returns the line's parts, or undefined when the build reported no commits.
 */
export function changeSummary(
  changes: readonly ChangeRow[] | undefined,
  total?: number,
): { id: string, message: string, more: number, full: string } | undefined {
  const newest = changes?.[0]
  if (newest === undefined) return undefined
  const lines = newest.message.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  const first = lines[0] ?? newest.message.trim()
  if (first.length === 0) return undefined
  const count = total ?? changes?.length ?? 0
  return {
    id: newest.commitId.slice(0, 7),
    message: first,
    more: Math.max(0, count - 1),
    // The whole commit message, newlines and all, for the hover text: a header
    // line with the id and author, then the message after a blank line.
    full: `${[newest.commitId.slice(0, 7), newest.author].filter(part => part.length > 0).join('\n')}\n\n${newest.message}`,
  }
}

/**
 * Whether a card should offer to rebuild the job.
 *
 * Only a build that failed: an aborted or unstable build is not a failure, and
 * an unfinished one has nothing to rebuild yet. The panel's rebuild asks for the
 * build's own parameters before triggering, so this is only about when the
 * button is worth showing.
 * @param outcome - the outcome the card is drawing.
 * @returns true when a rebuild is the obvious next thing to try.
 */
export function wantRebuild(outcome: string | undefined): boolean {
  return outcome === 'failure'
}

/**
 * The tracker record behind one favorite's current build.
 * @param live - records from the last snapshot, keyed by id.
 * @param instanceId - instance the panel is showing.
 * @param favorite - the followed job.
 * @returns the record, or undefined when nothing is following that build.
 */
export function trackedFor(
  live: ReadonlyMap<string, TrackedRow>,
  instanceId: string,
  favorite: FavoriteRow,
): TrackedRow | undefined {
  const build = favorite.job?.lastBuild
  if (build === undefined) return undefined
  return live.get(`${instanceId}/${favorite.path}#${build.number}`)
}

/**
 * Whether any tracked build changed state since the previous snapshot.
 *
 * Every state change is worth one re-read of the followed list, because the
 * listing is what the cards draw and what decides which builds are worth
 * subscribing to. Two changes matter in practice: a build that just ended (the
 * same job may already have started its next one) and a queue item that just
 * became a build (the job's `lastBuild` is now a build the panel has never
 * seen). Comparing states rather than trusting the record alone also keeps a
 * record that was already finished when the stream opened from triggering a
 * pointless re-read.
 * @param previous - states from the previous snapshot.
 * @param current - states from this snapshot.
 * @returns whether anything changed.
 */
export function anyStateChanged(
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): boolean {
  return [...current].some(([id, state]) => previous.get(id) !== state)
}

/**
 * The queue item a job is waiting in, when this plugin triggered it.
 *
 * A triggered build is queued before it is a build, so it has no number for a
 * card to match against; without this the card would keep showing the previous
 * build as though nothing had happened. A queued record is deliberately *not*
 * matched by {@link trackedFor}, which is keyed on a number that does not exist
 * yet.
 * @param live - records from the last snapshot.
 * @param instanceId - instance the panel is showing.
 * @param jobPath - the job's path.
 * @returns the queued record for that job, or undefined.
 */
export function queuedFor(
  live: ReadonlyMap<string, TrackedRow>,
  instanceId: string,
  jobPath: string,
): TrackedRow | undefined {
  for (const record of live.values()) {
    if (record.instanceId !== instanceId || record.jobPath !== jobPath) continue
    if (record.state === 'queued') return record
  }
  return undefined
}

/**
 * The name of the stage a build is inside, if the controller reports stages.
 *
 * A Freestyle or Maven job reports none, so undefined is the ordinary answer on
 * most controllers rather than a failure.
 * @param stages - the stages last observed for the build.
 * @returns the running stage's name, or undefined.
 */
export function activeStageOf(stages: readonly StageRow[] | undefined): string | undefined {
  return stages?.find(stage => stage.status === 'IN_PROGRESS' || stage.status === 'PAUSED')?.name
}

/** What one followed job's card should draw. */
export interface CardState {
  /** Whether the build is still running. */
  building: boolean
  /** The outcome to colour the card with. */
  outcome?: string
  /** The progress to draw, live while it runs. */
  progress?: ProgressRow
  /** The stage the build is inside, when the controller reports stages. */
  stage?: string
}

/**
 * What one card should draw, given both sources the panel has.
 *
 * The live record wins whenever the two disagree, because the listing is a
 * snapshot from when the panel last read it and the record is a moment old. That
 * matters exactly once per build: between the build ending and the followed list
 * being re-read, the listing still says "building" while the tracker has already
 * seen the result — and a card that kept saying "building" for that window would
 * be the one thing a progress panel must not do.
 * @param favorite - the followed job as the listing reported it.
 * @param live - the tracker record for its current build, when there is one.
 * @returns the card's state.
 */
export function cardState(favorite: FavoriteRow, live: TrackedRow | undefined): CardState {
  const build = favorite.job?.lastBuild
  const settled = live !== undefined && live.state !== 'running'
  const building = build?.building === true && !settled
  const state: CardState = { building }

  const progress = live?.progress ?? favorite.progress
  if (progress !== undefined) state.progress = progress

  if (building) {
    const stage = activeStageOf(live?.stages)
    if (stage !== undefined) state.stage = stage
  } else {
    const outcome = live?.outcome ?? build?.outcome
    if (outcome !== undefined) state.outcome = outcome
  }
  return state
}
