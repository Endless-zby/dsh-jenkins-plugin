/**
 * The Jenkins panel: a header action that opens a popover listing the jobs the
 * Host can reach, with their coarse status. It reads only the plugin's own
 * authenticated state route, so no Host RPC namespace is involved.
 * @module dsh-jenkins-plugin/client/Panel
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** One job row as the state route reports it. */
interface JobRow {
  path: string
  name: string
  url: string
  status: string
}

/** The state route's payload. */
interface StatePayload {
  ok: boolean
  jobs?: JobRow[]
  code?: string
  message?: string
}

const PANEL_WIDTH = 360

const buttonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '4px 10px',
  borderRadius: '6px',
  border: '1px solid var(--dsw-border, #d0d5dd)',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
} as const

const popoverStyle = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  right: 0,
  width: `${PANEL_WIDTH}px`,
  maxHeight: '420px',
  overflowY: 'auto',
  padding: '8px',
  borderRadius: '8px',
  border: '1px solid var(--dsw-border, #d0d5dd)',
  background: 'var(--dsw-surface, #fff)',
  boxShadow: '0 8px 24px rgba(16, 24, 40, 0.16)',
  zIndex: 40,
} as const

/** Render the payload as rows, a banner, or a loading hint. */
function content(state: StatePayload | undefined, busy: boolean): ReactNode {
  if (busy && state === undefined) return <div style={{ padding: '8px' }}>Loading…</div>
  if (state === undefined) return null
  if (!state.ok) {
    return (
      <div style={{ padding: '8px', color: '#b42318' }}>
        {state.code}: {state.message}
      </div>
    )
  }
  const jobs = state.jobs ?? []
  if (jobs.length === 0) return <div style={{ padding: '8px' }}>No Jenkins job found.</div>
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
      {jobs.map(job => (
        <li key={job.path} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px' }}>
          <span aria-hidden style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#98a2b3' }} />
          <a href={job.url} target="_blank" rel="noreferrer" style={{ flex: 1, color: 'inherit' }}>
            {job.path}
          </a>
          <span style={{ color: '#667085', fontSize: '12px' }}>{job.status}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Session-header action rendering the Jenkins panel.
 * @param _props - the slot's runtime props, unused by this first slice.
 * @returns the header button and its popover.
 */
export function JenkinsPanel(_props: PropsRuntime<'conversation.session.header.actions'>): ReactNode {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<StatePayload | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const response = await fetch('/jenkins-plugin/state', { credentials: 'same-origin' })
      setState(await response.json() as StatePayload)
    } catch (error) {
      setState({
        ok: false,
        code: 'network',
        message: error instanceof Error ? error.message : 'request failed',
      })
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  return (
    <div style={{ position: 'relative' }}>
      <button type="button" style={buttonStyle} onClick={() => { setOpen(value => !value) }}>
        Jenkins
        {state?.ok === true && state.jobs !== undefined ? ` (${state.jobs.length})` : ''}
      </button>
      {open ? <div style={popoverStyle}>{content(state, busy)}</div> : null}
    </div>
  )
}
