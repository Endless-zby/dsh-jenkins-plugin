/**
 * Small presentation kit shared by the Jenkins panel and the settings page.
 *
 * The browser half is bundled without a CSS pipeline, so every component here
 * styles itself inline from the platform's design tokens (`--dsw-*`). That keeps
 * the surfaces themed by the shell (including dark mode) without this plugin
 * needing its own stylesheet.
 * @module dsh-jenkins-plugin/client/ui
 */

import type { ReactNode } from 'react'

/** The platform's five semantic dot states. */
export type DotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'

/**
 * Map one of the plugin's status words to the platform's dot vocabulary.
 * @param status - a job or build outcome.
 * @returns the dot state to draw.
 */
export function dotStateOf(status: string): DotState {
  switch (status) {
    case 'success': return 'done'
    case 'unstable': return 'warning'
    case 'failure': return 'error'
    case 'running':
    case 'building':
    case 'in-progress': return 'ongoing'
    // Everything else — including `queued`, a build waiting for an executor —
    // is idle: drawing a waiting build as running would claim progress that is
    // not happening.
    default: return 'idle'
  }
}

/** Fill colour per dot state, read from the platform's semantic tokens. */
const DOT_FILL: Readonly<Record<DotState, string>> = {
  done: 'var(--dsw-alias-state-success-primary)',
  warning: 'var(--dsw-alias-state-warn-primary)',
  error: 'var(--dsw-alias-state-error-primary)',
  ongoing: 'var(--dsw-static-deepseek-450, var(--dsw-alias-state-business-primary))',
  idle: 'var(--dsw-alias-label-quaternary)',
}

/**
 * One status dot.
 * @param props.status - the plugin's status word.
 * @param props.size - diameter in pixels.
 * @returns the dot.
 */
export function Dot({ status, size = 8 }: { status: string, size?: number }): ReactNode {
  return (
    <span
      aria-hidden
      style={{
        flex: 'none',
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: '50%',
        background: DOT_FILL[dotStateOf(status)],
      }}
    />
  )
}

/**
 * Render a duration in the coarsest useful unit.
 * @param ms - milliseconds.
 * @returns the display text.
 */
export function durationText(ms: number): string {
  if (ms <= 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * Render a byte count in the coarsest useful unit.
 *
 * Used where a size is a fact the person needs (how much log was handed to the
 * model), so it stays honest about what was measured rather than rounding to a
 * friendlier number.
 * @param bytes - the count.
 * @returns the display text.
 */
export function bytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)}KB`
  return `${(kb / 1024).toFixed(1)}MB`
}

/**
 * Render an absolute time as a short local timestamp.
 * @param epochMs - epoch milliseconds; zero renders as a dash.
 * @returns the display text.
 */
export function timeText(epochMs: number): string {
  if (epochMs <= 0) return '—'
  const date = new Date(epochMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** One message block used for every empty, loading, and error state. */
export function Notice({ title, body, tone = 'neutral' }: {
  title: string
  body?: string
  tone?: 'neutral' | 'error'
}): ReactNode {
  return (
    <div style={{ padding: '12px' }}>
      <div style={{
        color: tone === 'error' ? 'var(--dsw-alias-label-error)' : 'var(--dsw-alias-label-primary)',
        fontSize: 'var(--dsw-font-sm-13)',
      }}
      >
        {title}
      </div>
      {body !== undefined
        ? (
            <p style={{
              margin: '4px 0 0',
              color: 'var(--dsw-alias-label-tertiary)',
              fontSize: 'var(--dsw-font-xxs-12)',
              lineHeight: 1.5,
            }}
            >
              {body}
            </p>
          )
        : null}
    </div>
  )
}

/**
 * A compact pill button.
 * @param props - the label, the click handler, and the optional disabled/title/active flags.
 * @returns the button.
 * @remarks `active` is the "this is the one you are on" state, drawn in the success colour.
 *   It is independent of `disabled` on purpose: picking the current instance is a no-op, but the
 *   selected pill must read as chosen rather than as unavailable, so `active` keeps it at full
 *   opacity.
 */
export function Pill({ label, onClick, disabled, title, active }: {
  label: string
  onClick: () => void
  disabled?: boolean
  title?: string
  active?: boolean
}): ReactNode {
  const on = active === true
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        flex: 'none',
        height: '24px',
        maxWidth: '160px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        padding: '0 10px',
        border: `1px solid ${on ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-border-l2)'}`,
        borderRadius: '6px',
        background: on ? 'var(--dsw-alias-state-success-tertiary)' : 'transparent',
        color: on ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
        font: 'inherit',
        fontSize: 'var(--dsw-font-xxxs-11)',
        fontWeight: on ? 600 : undefined,
        cursor: disabled === true ? 'default' : 'pointer',
        opacity: disabled === true && !on ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  )
}

/** A small tag, used for statuses and counts. */
export function Tag({ text, tone = 'neutral' }: { text: string, tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' }): ReactNode {
  const color = tone === 'ok'
    ? 'var(--dsw-alias-state-success-primary)'
    : tone === 'warn'
      ? 'var(--dsw-alias-state-warn-primary)'
      : tone === 'bad'
        ? 'var(--dsw-alias-state-error-primary)'
        : tone === 'info'
          ? 'var(--dsw-alias-state-business-primary)'
          : 'var(--dsw-alias-label-tertiary)'
  return (
    <span style={{
      flex: 'none',
      padding: '1px 6px',
      border: `1px solid ${color}`,
      borderRadius: '5px',
      color,
      fontSize: 'var(--dsw-font-xxxs-11)',
      lineHeight: '16px',
    }}
    >
      {text}
    </span>
  )
}

/** Map a build outcome to a tag tone. */
export function outcomeTone(outcome: string): 'ok' | 'warn' | 'bad' | 'info' | 'neutral' {
  switch (outcome) {
    case 'success': return 'ok'
    case 'unstable': return 'warn'
    case 'failure': return 'bad'
    case 'building': return 'info'
    default: return 'neutral'
  }
}

/** One row in the panel: a single-line record with a leading dot. */
export function Row({ children, onClick }: { children: ReactNode, onClick?: () => void }): ReactNode {
  return (
    <li
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l2)',
        cursor: onClick === undefined ? 'default' : 'pointer',
      }}
    >
      {children}
    </li>
  )
}

/** A text input styled for the panel's header row. */
export function SearchInput({ value, placeholder, onChange }: {
  value: string
  placeholder: string
  onChange: (next: string) => void
}): ReactNode {
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(event) => { onChange(event.target.value) }}
      style={{
        boxSizing: 'border-box',
        width: '100%',
        height: '28px',
        padding: '0 8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 'var(--dsw-font-xxs-12)',
      }}
    />
  )
}

/** A monospace path/label that truncates instead of wrapping. */
export function Mono({ text, flex = 1 }: { text: string, flex?: number | string }): ReactNode {
  return (
    <span
      title={text}
      style={{
        flex,
        minWidth: 0,
        fontFamily: 'var(--dsw-font-mono)',
        fontSize: 'var(--dsw-font-xxs-12)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </span>
  )
}

/** A muted, fixed-width annotation on a row. */
export function Meta({ text }: { text: string }): ReactNode {
  return (
    <span style={{
      flex: 'none',
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: 'var(--dsw-font-xxxs-11)',
      fontVariantNumeric: 'tabular-nums',
    }}
    >
      {text}
    </span>
  )
}

/** A section heading inside a detail view. */
export function Section({ title, children }: { title: string, children: ReactNode }): ReactNode {
  return (
    <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
      {title.length === 0 ? null : (
        <div style={{
          marginBottom: '6px',
          color: 'var(--dsw-alias-label-tertiary)',
          fontSize: 'var(--dsw-font-xxxs-11)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
        >
          {title}
        </div>
      )}
      {children}
    </div>
  )
}

/** The colour a progress bar takes for a build outcome. */
function progressFill(outcome: string | undefined, kind: string): string {
  if (kind === 'indeterminate') return 'var(--dsw-alias-label-quaternary)'
  switch (outcome) {
    case 'failure': return 'var(--dsw-alias-state-error-primary)'
    case 'unstable': return 'var(--dsw-alias-state-warn-primary)'
    case 'building': return 'var(--dsw-static-deepseek-450, var(--dsw-alias-state-business-primary))'
    default: return 'var(--dsw-alias-state-success-primary)'
  }
}

/**
 * One build's progress, as a bar plus the numbers behind it.
 *
 * Four shapes are distinguished rather than collapsed into one percentage: an
 * exact stage count, an estimate, a running build with no estimate at all, and a
 * finished build. A Freestyle or Maven job only ever has the last three, which
 * is why the bar cannot assume stages exist.
 * @param props.progress - the computed progress, or undefined when the job has no build.
 * @param props.outcome - the build outcome, which colours the fill.
 * @param props.t - copy binder.
 * @returns the bar and its caption.
 */
export function ProgressBar({ progress, outcome, t }: {
  progress?: {
    kind: string
    fraction?: number
    completed?: number
    total?: number
    elapsedMs?: number
    estimatedMs?: number
  }
  outcome?: string
  t: (key: string, params?: Record<string, unknown>) => string
}): ReactNode {
  if (progress === undefined) return <Meta text={t('progress.none')} />

  const fill = progressFill(outcome, progress.kind)
  const width = progress.kind === 'indeterminate' ? 100 : `${Math.round((progress.fraction ?? 0) * 100)}%`

  return (
    <div>
      <div style={{
        position: 'relative',
        height: '6px',
        borderRadius: '3px',
        background: 'var(--dsw-alias-fill-l2)',
        overflow: 'hidden',
      }}
      >
        <div style={{
          width,
          height: '100%',
          background: fill,
          opacity: progress.kind === 'indeterminate' ? 0.35 : 1,
          borderRadius: '3px',
          transition: 'width 400ms ease',
        }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', gap: '8px' }}>
        <Meta text={progressCaption(progress, t)} />
        {progress.elapsedMs !== undefined && progress.elapsedMs > 0
          ? <Meta text={durationText(progress.elapsedMs)} />
          : null}
      </div>
    </div>
  )
}

/**
 * The caption under a progress bar.
 * @param progress - the computed progress.
 * @param t - copy binder.
 * @returns the caption text.
 */
function progressCaption(
  progress: { kind: string, completed?: number, total?: number, estimatedMs?: number },
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  switch (progress.kind) {
    case 'stages':
      return t('progress.stages', { completed: progress.completed ?? 0, total: progress.total ?? 0 })
    case 'estimate':
      return t('progress.estimate', { estimated: durationText(progress.estimatedMs ?? 0) })
    case 'indeterminate':
      return t('progress.indeterminate')
    case 'finished':
      return t('progress.finished')
    default:
      return ''
  }
}
