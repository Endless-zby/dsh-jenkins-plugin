/**
 * The panel's drill-down: one job's build history, and one build's detail.
 *
 * Everything here is rendered inside the plugin's own panel — no view sends the
 * browser to the Jenkins UI. The single exception is an artifact's download
 * link, because a binary is not something a panel should inline.
 * @module dsh-jenkins-plugin/client/Builds
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { abortBuild, fetchBuild, fetchJob, fetchLog, isFailure, parseParameters, triggerBuild } from './api.js'
import type { ApiFailure, BuildDetailRow, BuildRow, JobDetailRow, LogPageRow } from './api.js'
import { Dot, Meta, Mono, Notice, outcomeTone, Pill, Row, Section, Tag, durationText, timeText } from './ui.js'
import { WriteAction } from './WriteAction.js'
import type { JenkinsKey } from './locales.js'

/** Copy binder for this plugin's namespace. */
type Translate = (key: JenkinsKey, params?: Record<string, unknown>) => string

/** How long the log waits between follow-ups while the build runs. */
const LOG_FOLLOW_MS = 1500

/** Builds fetched per history page. */
const HISTORY_PAGE = 20

/**
 * The trigger form: a job's parameters, then a confirmation.
 *
 * Parameters are free text rather than a generated form because Jenkins does not
 * expose a job's parameter definitions through the endpoints this panel already
 * reads; asking for `name=value` lines keeps the action honest instead of
 * inventing a form from a list the plugin cannot see.
 * @param props - copy binder, instance id, job path, and a success callback.
 * @returns the trigger action.
 */
function TriggerAction({ t, instanceId, jobPath, onTriggered }: {
  t: Translate
  instanceId: string
  jobPath: string
  onTriggered: () => void
}): ReactNode {
  const [text, setText] = useState('')

  const run = useCallback(async (): Promise<string> => {
    const parsed = parseParameters(text)
    if (!parsed.ok) {
      // Reported rather than guessed: a build triggered with the wrong
      // parameters is worse than one that was not triggered at all.
      throw new Error(t('write.badLine', { line: parsed.line }))
    }
    const answer = await triggerBuild(instanceId, jobPath, parsed.parameters)
    if (isFailure(answer)) throw new Error(answer.message)
    onTriggered()
    return answer.queueId === undefined
      ? t('write.triggered', { job: jobPath })
      : t('write.triggeredQueued', { job: jobPath, queue: answer.queueId })
  }, [instanceId, jobPath, onTriggered, t, text])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 'var(--dsw-font-xxxs-11)' }}>
        {t('write.parametersHint')}
      </div>
      <textarea
        value={text}
        onChange={(event) => { setText(event.target.value) }}
        placeholder={'BRANCH=main\nDEPLOY=false'}
        rows={2}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          resize: 'vertical',
          padding: '6px 8px',
          borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-l1)',
          color: 'var(--dsw-alias-label-primary)',
          fontFamily: 'var(--dsw-font-mono)',
          fontSize: 'var(--dsw-font-xxxs-11)',
        }}
      />
      <WriteAction
        t={t}
        label={t('write.trigger')}
        question={t('write.confirmTrigger', { job: jobPath })}
        onRun={run}
      />
    </div>
  )
}

/**
 * The job view: build history with paging.
 * @param props - copy binder, instance id, job path, back navigation, and build opening.
 * @returns the history view.
 */
export function JobView({ t, instanceId, jobPath, onBack, onOpenBuild }: {
  t: Translate
  instanceId: string
  jobPath: string
  onBack: () => void
  onOpenBuild: (build: number) => void
}): ReactNode {
  const [detail, setDetail] = useState<JobDetailRow | undefined>(undefined)
  const [failure, setFailure] = useState<ApiFailure | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (offset: number) => {
    setBusy(true)
    const answer = await fetchJob(instanceId, jobPath, HISTORY_PAGE, offset)
    setBusy(false)
    if (isFailure(answer)) {
      setFailure(answer)
      return
    }
    setFailure(undefined)
    setDetail((current) => {
      if (current === undefined || offset === 0) return answer.detail
      return { ...answer.detail, builds: [...current.builds, ...answer.detail.builds] }
    })
  }, [instanceId, jobPath])

  useEffect(() => { void load(0) }, [load])

  const header = (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '8px 12px',
      borderBottom: '1px solid var(--dsw-alias-border-l2)',
    }}
    >
      <Pill label={`← ${t('builds.back')}`} onClick={onBack} />
      <Mono text={jobPath} />
      {detail?.totalBuilds !== undefined ? <Meta text={`${detail.totalBuilds}`} /> : null}
      <Pill label={t('builds.reload')} onClick={() => { void load(0) }} disabled={busy} />
    </div>
  )

  if (failure !== undefined) {
    return <div>{header}<Notice title={t('error.title')} body={failure.message} tone="error" /></div>
  }

  if (detail === undefined) {
    return <div>{header}<Notice title={t('loading')} /></div>
  }

  const builds = detail.builds
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {header}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
        <TriggerAction
          t={t}
          instanceId={instanceId}
          jobPath={jobPath}
          onTriggered={() => { void load(0) }}
        />
      </div>
      {builds.length === 0
        ? <Notice title={t('builds.empty')} />
        : (
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', overflowY: 'auto', minHeight: 0 }}>
              {builds.map(build => (
                <BuildHistoryRow key={build.number} t={t} build={build} onOpen={onOpenBuild} />
              ))}
            </ul>
          )}
      {builds.length > 0 && (detail.totalBuilds === undefined || builds.length < detail.totalBuilds)
        ? (
            <div style={{ padding: '8px 12px', borderTop: '1px solid var(--dsw-alias-border-l2)' }}>
              <Pill
                label={busy ? t('builds.loadingMore') : t('builds.more')}
                onClick={() => { void load(builds.length) }}
                disabled={busy}
              />
            </div>
          )
        : null}
    </div>
  )
}

/**
 * One build-history row, which navigates to that build's detail.
 *
 * The whole row is the target rather than a nested link: reading a build must
 * not leave the conversation, which is the point of this panel.
 * @param props - copy binder, the build, and the open callback.
 * @returns the row.
 */
function BuildHistoryRow({ t, build, onOpen }: {
  t: Translate
  build: BuildRow
  onOpen: (build: number) => void
}): ReactNode {
  return (
    <Row onClick={() => { onOpen(build.number) }}>
      <Dot status={build.outcome} />
      <span style={{
        flex: 'none',
        color: 'var(--dsw-alias-label-primary-bluish)',
        fontSize: 'var(--dsw-font-xxs-12)',
        fontWeight: 600,
      }}
      >
        #{build.number}
      </span>
      <Mono text={build.displayName ?? build.description ?? ''} />
      <Tag text={t(`state.${build.outcome}` as JenkinsKey)} tone={outcomeTone(build.outcome)} />
      <Meta text={durationText(build.duration)} />
      <Meta text={timeText(build.timestamp)} />
    </Row>
  )
}

/**
 * The build view: header, progress, stages, log, and result area.
 * @param props - copy binder, instance id, job path, build selector, and back navigation.
 * @returns the build detail view.
 */
export function BuildView({ t, instanceId, jobPath, build, onBack }: {
  t: Translate
  instanceId: string
  jobPath: string
  build: string
  onBack: () => void
}): ReactNode {
  const [detail, setDetail] = useState<BuildDetailRow | undefined>(undefined)
  const [failure, setFailure] = useState<ApiFailure | undefined>(undefined)

  const load = useCallback(async () => {
    const answer = await fetchBuild(instanceId, jobPath, build)
    if (isFailure(answer)) {
      setFailure(answer)
      return
    }
    setFailure(undefined)
    setDetail(answer.detail)
  }, [instanceId, jobPath, build])

  useEffect(() => { void load() }, [load])

  const header = (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '8px 12px',
      borderBottom: '1px solid var(--dsw-alias-border-l2)',
    }}
    >
      <Pill label={`← ${t('builds.back')}`} onClick={onBack} />
      <Mono text={`${jobPath} #${build}`} />
      {detail !== undefined
        ? <Tag text={t(`state.${detail.outcome}` as JenkinsKey)} tone={outcomeTone(detail.outcome)} />
        : null}
      <Pill label={t('builds.reload')} onClick={() => { void load() }} />
    </div>
  )

  if (failure !== undefined) {
    return <div>{header}<Notice title={t('error.title')} body={failure.message} tone="error" /></div>
  }
  if (detail === undefined) {
    return <div>{header}<Notice title={t('loading')} /></div>
  }

  const progress = detail.progress.total === 0
    ? 0
    : Math.round((detail.progress.completed / detail.progress.total) * 100)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflowY: 'auto' }}>
      {header}

      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '12px',
        padding: '8px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l2)',
      }}
      >
        <WriteAction
          t={t}
          label={t('write.rebuild')}
          question={t('write.confirmRebuild', { target: `${jobPath} #${detail.number}` })}
          onRun={async () => {
            // The same parameters the build ran with, when Jenkins reported
            // them; a job that takes none is triggered the same way.
            const answer = await triggerBuild(instanceId, jobPath, detail.parameters ?? {})
            if (isFailure(answer)) throw new Error(answer.message)
            return answer.queueId === undefined
              ? t('write.triggered', { job: jobPath })
              : t('write.triggeredQueued', { job: jobPath, queue: answer.queueId })
          }}
        />
        {detail.building
          ? (
              <WriteAction
                t={t}
                label={t('write.abort')}
                question={t('write.confirmAbort', { target: `${jobPath} #${detail.number}` })}
                onRun={async () => {
                  const answer = await abortBuild(instanceId, jobPath, detail.number)
                  if (isFailure(answer)) throw new Error(answer.message)
                  void load()
                  return answer.aborted
                    ? t('write.aborted', { target: `${jobPath} #${detail.number}` })
                    : t('write.alreadyFinished', { target: `${jobPath} #${detail.number}` })
                }}
              />
            )
          : null}
      </div>

      <Section title={t('build.summary')}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
          <Meta text={`${t('build.duration')} ${durationText(detail.duration)}`} />
          <Meta text={`${t('build.started')} ${timeText(detail.timestamp)}`} />
          {detail.estimatedDuration > 0
            ? <Meta text={`${t('build.estimated')} ${durationText(detail.estimatedDuration)}`} />
            : null}
        </div>
        {detail.cause !== undefined
          ? (
              <div style={{ marginTop: '6px', color: 'var(--dsw-alias-label-secondary)', fontSize: 'var(--dsw-font-xxs-12)' }}>
                {detail.cause}
              </div>
            )
          : null}
        {detail.parameters === undefined
          ? null
          : (
              <div style={{ marginTop: '6px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {Object.entries(detail.parameters).map(([name, value]) => (
                  <Tag key={name} text={`${name}=${value}`} tone="neutral" />
                ))}
              </div>
            )}
      </Section>

      {/* Stages: a Pipeline reports them, a Freestyle or Maven job does not, and
          the second case is stated rather than drawn as an empty bar. */}
      <Section title={t('build.stages')}>
        {detail.hasStages
          ? (
              <>
                <div style={{
                  height: '6px',
                  borderRadius: '3px',
                  background: 'var(--dsw-alias-fill-l2)',
                  overflow: 'hidden',
                }}
                >
                  <div style={{
                    width: `${progress}%`,
                    height: '100%',
                    background: detail.outcome === 'failure'
                      ? 'var(--dsw-alias-state-error-primary)'
                      : detail.outcome === 'unstable'
                        ? 'var(--dsw-alias-state-warn-primary)'
                        : 'var(--dsw-alias-state-success-primary)',
                  }}
                  />
                </div>
                <div style={{ marginTop: '4px' }}>
                  <Meta text={`${detail.progress.completed}/${detail.progress.total} · ${progress}%`} />
                </div>
                <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none' }}>
                  {detail.stages.map(stage => (
                    <li key={stage.name} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0' }}>
                      <Dot status={stageTone(stage.status)} size={7} />
                      <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--dsw-font-xxs-12)' }}>{stage.name}</span>
                      <Meta text={t(`stage.${stage.status}` as JenkinsKey) === `stage.${stage.status}`
                        ? stage.status
                        : t(`stage.${stage.status}` as JenkinsKey)}
                      />
                      <Meta text={durationText(stage.durationMs ?? 0)} />
                    </li>
                  ))}
                </ul>
              </>
            )
          : (
              <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 'var(--dsw-font-xxs-12)' }}>
                {t('build.noStages')}
              </div>
            )}
      </Section>

      <LogSection t={t} instanceId={instanceId} jobPath={jobPath} build={build} building={detail.building} />

      {detail.tests !== null
        ? (
            <Section title={t('build.tests')}>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <Tag text={`${t('build.tests.total')} ${detail.tests.total}`} />
                <Tag text={`${t('build.tests.passed')} ${detail.tests.passed}`} tone="ok" />
                <Tag text={`${t('build.tests.failed')} ${detail.tests.failed}`} tone={detail.tests.failed > 0 ? 'bad' : 'neutral'} />
                <Tag text={`${t('build.tests.skipped')} ${detail.tests.skipped}`} tone="warn" />
              </div>
            </Section>
          )
        : (
            <Section title={t('build.tests')}>
              <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 'var(--dsw-font-xxs-12)' }}>
                {t('build.noTests')}
              </div>
            </Section>
          )}

      {detail.changes.length > 0
        ? (
            <Section title={`${t('build.changes')} (${detail.changes.length})`}>
              <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                {detail.changes.slice(0, 30).map((change, index) => (
                  <li key={`${change.commitId}-${index}`} style={{ padding: '3px 0', fontSize: 'var(--dsw-font-xxs-12)' }}>
                    <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>{change.author}</span>
                    <span style={{ margin: '0 6px', color: 'var(--dsw-alias-label-quaternary)', fontFamily: 'var(--dsw-font-mono)' }}>
                      {change.commitId.slice(0, 8)}
                    </span>
                    <span>{change.message}</span>
                  </li>
                ))}
              </ul>
              {detail.changes.length > 30
                ? <div style={{ marginTop: '4px' }}><Meta text={`+${detail.changes.length - 30}`} /></div>
                : null}
            </Section>
          )
        : null}

      {detail.artifacts.length > 0
        ? (
            <Section title={`${t('build.artifacts')} (${detail.artifacts.length})`}>
              <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                {detail.artifacts.map(artifact => (
                  <li key={artifact.path} style={{ display: 'flex', gap: '8px', padding: '3px 0' }}>
                    {/* The one link out of the panel: a binary has to be fetched
                        by the browser, not rendered by this component. */}
                    <a
                      href={artifact.url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ flex: 1, minWidth: 0, color: 'var(--dsw-alias-label-primary-bluish)', fontSize: 'var(--dsw-font-xxs-12)' }}
                    >
                      <Mono text={artifact.path} />
                    </a>
                  </li>
                ))}
              </ul>
            </Section>
          )
        : null}
    </div>
  )
}

/** Map a Jenkins stage status to a dot status. */
function stageTone(status: string): string {
  switch (status) {
    case 'SUCCESS': return 'success'
    case 'FAILED':
    case 'ABORTED': return 'failure'
    case 'UNSTABLE': return 'unstable'
    case 'IN_PROGRESS':
    case 'PAUSED': return 'running'
    default: return 'idle'
  }
}

/**
 * The console log, followed while the build runs.
 *
 * The log is the one thing worth polling on its own cadence, so this component
 * owns its timer and tears it down whenever the user pauses or the build ends.
 * @param props - copy binder, instance id, job path, build selector, and whether the build still runs.
 * @returns the log block.
 */
function LogSection({ t, instanceId, jobPath, build, building }: {
  t: Translate
  instanceId: string
  jobPath: string
  build: string
  building: boolean
}): ReactNode {
  const [page, setPage] = useState<LogPageRow | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [following, setFollowing] = useState(true)
  const [copied, setCopied] = useState(false)
  // The byte offset to continue from, kept in a ref so the polling effect does
  // not restart on every page and lose its cadence.
  const offset = useRef(0)
  const box = useRef<HTMLPreElement | null>(null)

  const pull = useCallback(async (reset: boolean) => {
    const from = reset ? 0 : offset.current
    const answer = await fetchLog(instanceId, jobPath, build, from)
    if (isFailure(answer)) {
      setFailure(answer.message)
      return
    }
    setFailure(undefined)
    offset.current = answer.page.nextOffset
    setPage((current) => {
      if (reset || current === undefined) return answer.page
      return { ...answer.page, text: current.text + answer.page.text }
    })
  }, [instanceId, jobPath, build])

  useEffect(() => {
    offset.current = 0
    void pull(true)
  }, [pull])

  // Follow only while the build runs and the user has not paused: an idle log is
  // the same bytes forever, and polling it would be pure waste.
  useEffect(() => {
    if (!building || !following) return
    const timer = setInterval(() => { void pull(false) }, LOG_FOLLOW_MS)
    return () => { clearInterval(timer) }
  }, [building, following, pull])

  // A followed log should show its tail, so the box scrolls to the bottom after
  // each append unless the user has paused.
  useEffect(() => {
    if (!following || box.current === null) return
    box.current.scrollTop = box.current.scrollHeight
  }, [page, following])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(page?.text ?? '')
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 1500)
    } catch {
      setCopied(false)
    }
  }, [page])

  return (
    <Section title={t('build.log')}>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '6px', alignItems: 'center' }}>
        <Pill
          label={following ? t('log.pause') : t('log.follow')}
          onClick={() => { setFollowing(value => !value) }}
          disabled={!building}
        />
        <Pill label={copied ? t('log.copied') : t('log.copy')} onClick={() => { void copy() }} />
        {building ? <Tag text={t('log.live')} tone="info" /> : null}
        {page?.truncated === true ? <Tag text={t('log.truncated')} tone="warn" /> : null}
      </div>
      {failure !== undefined
        ? <Notice title={t('error.title')} body={failure} tone="error" />
        : (
            <pre
              ref={box}
              style={{
                margin: 0,
                maxHeight: '260px',
                overflow: 'auto',
                padding: '8px',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: '8px',
                background: 'var(--dsw-alias-bg-l2)',
                color: 'var(--dsw-alias-label-secondary)',
                fontFamily: 'var(--dsw-font-mono)',
                fontSize: 'var(--dsw-font-xxxs-11)',
                lineHeight: 1.45,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {page === undefined ? t('loading') : page.text.length === 0 ? t('log.empty') : page.text}
            </pre>
          )}
    </Section>
  )
}
