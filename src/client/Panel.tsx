/**
 * The Jenkins panel: the right Sidebar's tab body.
 *
 * Two modules share the tab: **Favorites**, a card per followed job with its
 * live build progress, and **All jobs**, which stays collapsed by default so the
 * followed set is what the eye lands on. Each row in the full list can be
 * followed or unfollowed in place.
 *
 * Nothing here sends the browser to the Jenkins UI except an artifact download,
 * which a panel cannot render anyway. Data arrives only through the plugin's own
 * authenticated routes, so no Host RPC namespace is involved — a plugin cannot
 * mint one.
 * @module dsh-jenkins-plugin/client/Panel
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only, for the `SessionStandardProps` merge that types `sessionId` on every
// session-scoped slot body. The sidebar tab is one, and the panel needs its own
// session id to hand a failed build to the model *in that conversation*.
import type {} from '@deepseek-ai/dsh-client-ui-session'
import { analyzeFailure, fetchBuild, fetchFavorites, fetchInstances, fetchState, isFailure, selectInstance, subscribeEvents, toggleFavorite, triggerBuild } from './api.js'
import type { ApiFailure, FavoriteRow, JobRow, ProgressRow, StatePayload, TrackedRow } from './api.js'
import { anyStateChanged, buildsToFollow, cardState, changeSummary, favoritesOf, queuedFor, recordsFor, trackedFor, wantRebuild } from './live.js'
import type { FavoriteSnapshot } from './live.js'
import { BuildView, JobView } from './Builds.js'
import { bytesText, Dot, Meta, Mono, Notice, Pill, ProgressBar, Row, SearchInput, Section, Tag, durationText, outcomeTone } from './ui.js'
import { WriteAction } from './WriteAction.js'
import type { JenkinsKey } from './locales.js'

/** Copy binder for this plugin's namespace. */
type Translate = (key: JenkinsKey, params?: Record<string, unknown>) => string

/** Which view the tab is showing. */
type View =
  | { kind: 'home' }
  | { kind: 'job', jobPath: string }
  | { kind: 'build', jobPath: string, build: number }

/** Jobs rendered in the full list before the rest are left to the filter box. */
const MAX_ROWS = 500

/**
 * The right Sidebar's Jenkins tab body.
 * @param props - slot runtime props, including the copy binder.
 * @returns the active view.
 */
export function JenkinsPanel({ t, sessionId }: PropsRuntime<'sidebar.right.pane.tab'> & { t: Translate }): ReactNode {
  const [state, setState] = useState<StatePayload | ApiFailure | undefined>(undefined)
  const [view, setView] = useState<View>({ kind: 'home' })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (instanceId?: string) => {
    setBusy(true)
    const answer = await fetchState(instanceId)
    setBusy(false)
    setState(answer)
  }, [])

  useEffect(() => { void load() }, [load])

  const switchTo = useCallback(async (instanceId: string) => {
    setBusy(true)
    const answer = await selectInstance(instanceId)
    setBusy(false)
    if (!isFailure(answer)) {
      setView({ kind: 'home' })
      await load(instanceId)
    }
  }, [load])

  if (state === undefined) return <Notice title={t('loading')} />

  if (isFailure(state)) {
    const known = state.code === 'no-instances' || state.code === 'no-token'
    return (
      <Notice
        title={known ? t('panel.needsSetup') : t('error.title')}
        body={known ? t('panel.openSettings') : state.message}
        tone={known ? 'neutral' : 'error'}
      />
    )
  }

  const instanceId = state.connection.instanceId

  if (view.kind === 'job') {
    return (
      <JobView
        t={t}
        instanceId={instanceId}
        jobPath={view.jobPath}
        onBack={() => { setView({ kind: 'home' }) }}
        onOpenBuild={(build) => { setView({ kind: 'build', jobPath: view.jobPath, build }) }}
      />
    )
  }

  if (view.kind === 'build') {
    return (
      <BuildView
        t={t}
        instanceId={instanceId}
        jobPath={view.jobPath}
        build={String(view.build)}
        onBack={() => { setView({ kind: 'job', jobPath: view.jobPath }) }}
      />
    )
  }

  return (
    <Home
      t={t}
      state={state}
      busy={busy}
      instanceId={instanceId}
      sessionId={sessionId}
      onReload={() => { void load(instanceId) }}
      onOpenJob={(jobPath) => { setView({ kind: 'job', jobPath }) }}
      onSwitchInstance={(id) => { void switchTo(id) }}
    />
  )
}

/**
 * The panel's landing view: favorites, then the collapsed full list.
 * @param props - copy binder, current state, the session to answer in, and navigation callbacks.
 * @returns the two modules.
 */
function Home({ t, state, busy, instanceId, sessionId, onReload, onOpenJob, onSwitchInstance }: {
  t: Translate
  state: StatePayload
  busy: boolean
  instanceId: string
  sessionId: string
  onReload: () => void
  onOpenJob: (jobPath: string) => void
  onSwitchInstance: (id: string) => void
}): ReactNode {
  const [snapshot, setSnapshot] = useState<FavoriteSnapshot | undefined>(undefined)
  const [jobsOpen, setJobsOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [toast, setToast] = useState<string | undefined>(undefined)
  const [live, setLive] = useState<ReadonlyMap<string, TrackedRow>>(new Map())

  // The listing is tagged with the instance it came from, so the render right
  // after an instance switch cannot use the previous controller's jobs.
  const favorites = favoritesOf(snapshot, instanceId)

  /** The followed paths, as the full job list needs them for its star buttons. */
  const followed = new Set(favorites.map(row => row.path))

  const loadFavorites = useCallback(async () => {
    const answer = await fetchFavorites(instanceId)
    // Tagged with the instance asked for, never with whatever is current by the
    // time the answer lands.
    setSnapshot({ instanceId, rows: isFailure(answer) ? [] : answer.favorites })
  }, [instanceId])

  useEffect(() => { void loadFavorites() }, [loadFavorites])

  // Nothing is followed until a followed job has a build running; see
  // `buildsToFollow` for why a finished build is not worth a subscription.
  const subscribed = buildsToFollow(favorites).join(',')

  // The stream is the subscription: opening it arms the host's poller and
  // closing it stops the polling, so the panel never has to say "stop". It is
  // opened even with nothing running, because a build the panel is about to
  // trigger has to be able to appear — and a stream with no records to report
  // costs the controller exactly nothing, since the poller only ever reads
  // records that exist.
  const lastStates = useRef<ReadonlyMap<string, string>>(new Map())
  const [liveOpen, setLiveOpen] = useState(false)
  const everOpened = useRef(false)
  useEffect(() => {
    // Every subscription starts a fresh comparison: the records a new stream
    // reports have never been seen by this one, and counting them as changes
    // would re-read the followed list once per subscription for nothing.
    lastStates.current = new Map()
    return subscribeEvents(instanceId, subscribed.length === 0 ? [] : subscribed.split(','), (tracked) => {
      const mine = recordsFor(tracked, instanceId)
      const states = new Map([...mine].map(([id, record]) => [id, record.state]))
      // A state change is the moment the followed list can be stale: a build
      // that just ended may have been followed by a new one, and a queue item
      // that just became a build is one the panel has never seen.
      const changed = anyStateChanged(lastStates.current, states)
      lastStates.current = states
      setLive(mine)
      if (changed) void loadFavorites()
    }, (state) => {
      if (state === 'open') {
        // A second open means the stream dropped and came back, which is what a
        // restarted host or a sleeping laptop looks like. The followed list is
        // read again rather than kept: its build numbers belonged to that host,
        // and asking for a number the controller does not have is how a card
        // ends up describing a build that no longer exists.
        if (everOpened.current) void loadFavorites()
        everOpened.current = true
      }
      setLiveOpen(state === 'open')
    })
  }, [instanceId, subscribed, loadFavorites])

  // Whether anything is actually moving, which is when the live badge means
  // something: the channel is always open, but an idle panel should not claim
  // to be streaming anything.
  const moving = subscribed.length > 0 || [...live.values()].some(record => record.state === 'queued')

  /** Follow or unfollow one job, then refresh the cards. */
  const toggle = useCallback(async (job: JobRow) => {
    const wantFollowed = !followed.has(job.path)
    const answer = await toggleFavorite(instanceId, job.path, job.name, wantFollowed)
    if (isFailure(answer)) {
      setToast(answer.message)
      setTimeout(() => { setToast(undefined) }, 4000)
      return
    }
    setToast(wantFollowed ? t('favorites.added', { name: job.name }) : t('favorites.removed', { name: job.name }))
    setTimeout(() => { setToast(undefined) }, 2500)
    await loadFavorites()
  }, [followed, instanceId, loadFavorites, t])

  // The followed list itself is only re-read when a followed build ends, so a
  // card's own numbers never go stale while it is running.

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontWeight: 600, fontSize: 'var(--dsw-font-sm-13)' }}>{t('panel.title')}</span>
          <span
            title={`${state.connection.name} — ${state.connection.baseUrl}`}
            style={{
              flex: 1,
              minWidth: 0,
              color: 'var(--dsw-alias-label-tertiary)',
              fontSize: 'var(--dsw-font-xxxs-11)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {state.connection.name} · {state.connection.identity.fullName || state.connection.username}
          </span>
          <Pill label={t('jobs.reload')} onClick={onReload} disabled={busy} />
        </div>
        {moving
          ? (
              <div style={{
                marginTop: '6px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                color: 'var(--dsw-alias-label-tertiary)',
                fontSize: 'var(--dsw-font-xxxs-11)',
              }}
              >
                <Dot status={liveOpen ? 'running' : 'idle'} size={6} />
                {liveOpen ? t('live.open') : t('live.closed')}
              </div>
            )
          : null}
        {toast !== undefined
          ? (
              <div style={{ marginTop: '6px', color: 'var(--dsw-alias-label-secondary)', fontSize: 'var(--dsw-font-xxxs-11)' }}>
                {toast}
              </div>
            )
          : null}
      </div>

      <div style={{ overflowY: 'auto', minHeight: 0, flex: 1 }}>
        <Section title={`${t('favorites.title')} (${favorites?.length ?? 0})`}>
          {favorites === undefined
            ? <Meta text={t('loading')} />
            : favorites.length === 0
              ? (
                  <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 'var(--dsw-font-xxs-12)', lineHeight: 1.5 }}>
                    {t('favorites.empty')}
                  </div>
                )
              : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {favorites.map(row => (
                      <FavoriteCard
                        key={row.path}
                        t={t}
                        instanceId={instanceId}
                        sessionId={sessionId}
                        row={row}
                        live={trackedFor(live, instanceId, row)}
                        queued={queuedFor(live, instanceId, row.path)}
                        onRebuilt={() => { void loadFavorites() }}
                        onOpen={() => { onOpenJob(row.path) }}
                        onToggle={() => {
                          const job = row.job
                          if (job !== undefined) void toggle(job)
                        }}
                      />
                    ))}
                  </div>
                )}
        </Section>

        <Section title="">
          <button
            type="button"
            onClick={() => { setJobsOpen(value => !value) }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              width: '100%',
              padding: 0,
              border: 0,
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary)',
              font: 'inherit',
              fontSize: 'var(--dsw-font-sm-13)',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <span style={{
              display: 'inline-block',
              transition: 'transform 120ms ease',
              transform: jobsOpen ? 'rotate(90deg)' : 'none',
              fontSize: 'var(--dsw-font-xxxs-11)',
            }}
            >
              ▶
            </span>
            {t('jobs.title', { count: state.jobs?.length ?? 0 })}
          </button>

          {jobsOpen
            ? (
                <div style={{ marginTop: '8px' }}>
                  <SearchInput value={filter} placeholder={t('jobs.search')} onChange={setFilter} />
                </div>
              )
            : null}
        </Section>

        {jobsOpen
          ? (
              <JobList
                t={t}
                jobs={state.jobs ?? []}
                filter={filter}
                followed={followed}
                onOpen={onOpenJob}
                onToggle={(job) => { void toggle(job) }}
              />
            )
          : null}
      </div>

      <InstanceSwitcher t={t} current={instanceId} onPick={onSwitchInstance} />
    </div>
  )
}

/**
 * One followed job as a card: state, current build, progress, and actions.
 *
 * The card is the reason favorites exist — it shows whether the job is worth
 * opening without opening it. While the build runs the numbers come from the
 * live stream; the card falls back to the listing's figures for a build that is
 * already over, because a finished build's numbers do not move.
 *
 * It also carries the two things that decide whether opening it is necessary at
 * all: what the build is building (its newest commit, and the project version
 * for a Maven job) and, when it failed, a way to run it again.
 * @param props - copy binder, instance id, the favorite, its live record, and its actions.
 * @returns the card.
 */
function FavoriteCard({ t, instanceId, sessionId, row, live, queued, onRebuilt, onOpen, onToggle }: {
  t: Translate
  instanceId: string
  sessionId: string
  row: FavoriteRow
  live?: TrackedRow
  queued?: TrackedRow
  onRebuilt: () => void
  onOpen: () => void
  onToggle: () => void
}): ReactNode {
  const job = row.job
  const build = job?.lastBuild
  const state = cardState(row, live)
  const status = state.building ? 'running' : job?.status ?? 'unknown'
  const change = changeSummary(live?.changes, live?.changeCount)
  return (
    <div style={{
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: '12px',
      padding: '10px 12px',
      background: 'var(--dsw-alias-bg-l1)',
    }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Dot status={status} size={9} />
        <span
          onClick={onOpen}
          title={row.path}
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: 'var(--dsw-font-mono)',
            fontSize: 'var(--dsw-font-xxs-12)',
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            cursor: 'pointer',
          }}
        >
          {job === undefined ? row.name : row.path}
        </span>
        {build !== undefined
          ? (
              <Tag
                text={`#${build.number} ${t(`state.${state.outcome ?? 'building'}` as JenkinsKey)}`}
                tone={outcomeTone(state.outcome ?? 'building')}
              />
            )
          : <Meta text={t('jobs.notBuilt')} />}
        <Pill label="★" title={t('favorites.remove')} onClick={onToggle} />
      </div>

      {job === undefined
        ? (
            <div style={{ marginTop: '6px', color: 'var(--dsw-alias-label-tertiary)', fontSize: 'var(--dsw-font-xxxs-11)' }}>
              {t('favorites.missing')}
            </div>
          )
        : (
            <div style={{ marginTop: '8px' }}>
              {row.mavenVersion === undefined
                ? null
                : (
                    <div style={{ marginBottom: '6px' }}>
                      <Tag text={`Maven ${row.mavenVersion}`} tone="neutral" />
                    </div>
                  )}
              {queued !== undefined
                ? (
                    <div style={{
                      marginBottom: '6px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: 'var(--dsw-font-xxxs-11)',
                      color: 'var(--dsw-alias-label-secondary)',
                    }}
                    >
                      <Dot status="queued" size={6} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t('favorites.queued')}
                        {queued.queueId === undefined ? '' : ` · #${queued.queueId}`}
                      </span>
                    </div>
                  )
                : null}
              {change === undefined
                ? null
                : (
                    <div
                      title={change.full}
                      style={{
                        marginBottom: '6px',
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: '6px',
                        minWidth: 0,
                        fontSize: 'var(--dsw-font-xxxs-11)',
                        color: 'var(--dsw-alias-label-secondary)',
                      }}
                    >
                      <Mono text={change.id} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {change.message}
                      </span>
                      {change.more === 0
                        ? null
                        : (
                            <span style={{ flex: 'none', color: 'var(--dsw-alias-label-tertiary)' }}>
                              {t('favorites.moreChanges', { count: change.more })}
                            </span>
                          )}
                    </div>
                  )}
              {state.stage === undefined
                ? null
                : (
                    <div style={{
                      marginBottom: '5px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: 'var(--dsw-font-xxxs-11)',
                      color: 'var(--dsw-alias-label-secondary)',
                    }}
                    >
                      <Dot status="running" size={6} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {state.stage}
                      </span>
                    </div>
                  )}
              <ProgressBar
                progress={state.progress}
                outcome={state.building ? 'building' : state.outcome}
                t={(key, params) => t(key as JenkinsKey, params)}
              />
              {wantRebuild(state.outcome)
                ? (
                    <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <WriteAction
                        t={t}
                        label={t('write.rebuild')}
                        question={t('write.confirmRebuildShort', { job: row.path })}
                        onRun={async () => {
                          // The build's own parameters, read fresh: a rebuild that
                          // guessed would be worse than no button at all, and a
                          // job that takes parameters refuses a bare trigger.
                          const detail = await fetchBuild(instanceId, row.path, String(build?.number ?? 'last'))
                          if (isFailure(detail)) throw new Error(detail.message)
                          const answer = await triggerBuild(instanceId, row.path, detail.detail.parameters ?? {})
                          if (isFailure(answer)) throw new Error(answer.message)
                          onRebuilt()
                          return answer.queueId === undefined
                            ? t('write.triggered', { job: row.path })
                            : t('write.triggeredQueued', { job: row.path, queue: answer.queueId })
                        }}
                      />
                      {/* No confirmation: this changes nothing on the controller.
                          The click is the intent, and the log it hands over is
                          bounded, so the cost is bounded with it. */}
                      <WriteAction
                        t={t}
                        immediate
                        label={t('analyze.ask')}
                        question={t('analyze.asking')}
                        onRun={async () => {
                          const answer = await analyzeFailure(
                            instanceId,
                            row.path,
                            build?.number ?? 0,
                            sessionId,
                          )
                          if (isFailure(answer)) throw new Error(answer.message)
                          const size = bytesText(answer.logBytes)
                          return answer.truncated && answer.totalBytes !== undefined
                            ? t('analyze.doneTruncated', { size, total: bytesText(answer.totalBytes) })
                            : t('analyze.done', { size })
                        }}
                      />
                    </div>
                  )
                : null}
            </div>
          )}
    </div>
  )
}

/** The full job list, filtered and capped, with follow buttons. */
function JobList({ t, jobs, filter, followed, onOpen, onToggle }: {
  t: Translate
  jobs: JobRow[]
  filter: string
  followed: ReadonlySet<string>
  onOpen: (jobPath: string) => void
  onToggle: (job: JobRow) => void
}): ReactNode {
  const term = filter.trim().toLowerCase()
  const shown = term.length === 0 ? jobs : jobs.filter(job => job.path.toLowerCase().includes(term))

  if (shown.length === 0) {
    return <Notice title={jobs.length === 0 ? t('jobs.empty') : t('jobs.noMatch')} />
  }

  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
      {shown.slice(0, MAX_ROWS).map(job => (
        <Row key={job.path}>
          <Dot status={job.status} />
          <span
            onClick={() => { onOpen(job.path) }}
            title={job.path}
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: 'var(--dsw-font-mono)',
              fontSize: 'var(--dsw-font-xxs-12)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              cursor: 'pointer',
            }}
          >
            {job.path}
          </span>
          {job.lastBuild !== undefined
            ? <Tag text={`#${job.lastBuild.number} ${t(`state.${job.lastBuild.outcome}` as JenkinsKey)}`} tone={outcomeTone(job.lastBuild.outcome)} />
            : <Meta text={t('jobs.notBuilt')} />}
          {job.lastBuild !== undefined && !job.lastBuild.building && job.lastBuild.duration > 0
            ? <Meta text={durationText(job.lastBuild.duration)} />
            : null}
          <Pill
            label={followed.has(job.path) ? '★' : '☆'}
            title={followed.has(job.path) ? t('favorites.remove') : t('favorites.add')}
            onClick={() => { onToggle(job) }}
          />
        </Row>
      ))}
    </ul>
  )
}

/**
 * The instance picker, which stays out of the way when only one is configured.
 * @param props - copy binder, the instance currently shown, and the pick callback.
 * @returns the switcher, or nothing when it has no choice to offer.
 * @remarks The instance you are on is drawn green (`active`), not greyed out: a dimmed pill next to
 *   live ones reads as "unavailable", which is the opposite of "currently selected".
 */
function InstanceSwitcher({ t, current, onPick }: {
  t: Translate
  current: string
  onPick: (id: string) => void
}): ReactNode {
  const [instances, setInstances] = useState<Array<{ id: string, name: string }>>([])

  useEffect(() => {
    let live = true
    void (async () => {
      const answer = await fetchInstances()
      if (!live || isFailure(answer)) return
      setInstances(answer.instances.map(row => ({ id: row.id, name: row.name })))
    })()
    return () => { live = false }
  }, [current])

  if (instances.length < 2) return null
  return (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '6px',
      padding: '8px 12px',
      borderTop: '1px solid var(--dsw-alias-border-l2)',
    }}
    >
      <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 'var(--dsw-font-xxxs-11)' }}>
        {t('panel.instance')}
      </span>
      {instances.map(instance => (
        <Pill
          key={instance.id}
          label={instance.id === current ? `● ${instance.name}` : instance.name}
          onClick={() => { onPick(instance.id) }}
          disabled={instance.id === current}
          active={instance.id === current}
        />
      ))}
    </div>
  )
}

/** Re-export so the progress row type stays visible to callers of this module. */
export type { ProgressRow }
