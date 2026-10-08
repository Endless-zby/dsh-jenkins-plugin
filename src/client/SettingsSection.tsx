/**
 * The Jenkins settings page.
 *
 * It owns the instance list — display name, controller URL, login name, and the
 * credential reference holding each token — and writes secrets through the
 * credentials Remote namespace, never through this plugin's own routes. Every
 * save is verified against the controller first, so a typo cannot be persisted
 * as a working connection.
 * @module dsh-jenkins-plugin/client/SettingsSection
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  fetchInstances,
  isFailure,
  probeInstance,
  saveInstances,
} from './api.js'
import type { InstanceInput, InstanceView } from './api.js'
import type { JenkinsKey } from './locales.js'

/** A row being edited; a fresh row has no id yet. */
interface DraftRow extends InstanceInput {
  /** Whether the row's editor is open. */
  open: boolean
  /** Whether a credential is already stored for this row's reference. */
  tokenConfigured: boolean
  /** Result of the row's last test, if any. */
  tested?: string
}

/** Copy binder for this plugin's namespace. */
type Translate = (key: JenkinsKey, params?: Record<string, unknown>) => string

/** Turn a view into an editable draft, leaving the token field empty. */
function draftOf(view: InstanceView): DraftRow {
  return {
    id: view.id,
    name: view.name,
    baseUrl: view.baseUrl,
    username: view.username,
    tokenRef: view.tokenRef,
    open: false,
    tokenConfigured: view.tokenConfigured,
  }
}

/**
 * Derive a stable, URL-safe id from a display name.
 * @param name - the operator's label.
 * @param taken - ids already in use.
 * @returns an unused id.
 */
function idFrom(name: string, taken: ReadonlySet<string>): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  const stem = base.length === 0 ? 'jenkins' : base
  if (!taken.has(stem)) return stem
  for (let index = 2; index < 1000; index += 1) {
    if (!taken.has(`${stem}-${index}`)) return `${stem}-${index}`
  }
  return `${stem}-${Date.now()}`
}

/** Left-aligned field label. */
function Label({ text, htmlFor }: { text: string, htmlFor: string }): ReactNode {
  return (
    <label
      htmlFor={htmlFor}
      style={{
        display: 'block',
        margin: '0 0 4px',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 'var(--dsw-font-xxs-12)',
      }}
    >
      {text}
    </label>
  )
}

/** One text field. */
function Field({ id, label, value, placeholder, type, onChange }: {
  id: string
  label: string
  value: string
  placeholder?: string
  type?: string
  onChange: (next: string) => void
}): ReactNode {
  return (
    <div style={{ marginBottom: '12px' }}>
      <Label text={label} htmlFor={id} />
      <input
        id={id}
        type={type ?? 'text'}
        value={value}
        placeholder={placeholder}
        onChange={(event) => { onChange(event.target.value) }}
        style={{
          boxSizing: 'border-box',
          width: '100%',
          height: '32px',
          padding: '0 10px',
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: '8px',
          background: 'var(--dsw-alias-bg-base)',
          color: 'var(--dsw-alias-label-primary)',
          font: 'inherit',
          fontSize: 'var(--dsw-font-sm-13)',
        }}
      />
    </div>
  )
}

/** One button, styled from the same tokens the platform's own chrome uses. */
function Action({ label, onClick, tone = 'quiet', disabled }: {
  label: string
  onClick: () => void
  tone?: 'quiet' | 'primary' | 'danger'
  disabled?: boolean
}): ReactNode {
  const fill = tone === 'primary'
    ? 'var(--dsw-alias-button-primary-fill)'
    : 'transparent'
  const color = tone === 'primary'
    ? 'var(--dsw-alias-label-primary-foreground)'
    : tone === 'danger'
      ? 'var(--dsw-alias-label-error)'
      : 'var(--dsw-alias-label-secondary)'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        height: '28px',
        padding: '0 12px',
        border: tone === 'primary' ? 'none' : '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
        background: fill,
        color,
        font: 'inherit',
        fontSize: 'var(--dsw-font-xs-13)',
        cursor: disabled === true ? 'default' : 'pointer',
        opacity: disabled === true ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  )
}

/**
 * The Jenkins settings section.
 * @param props - slot runtime props, including the copy binder.
 * @returns the instance list and its editors.
 */
export function JenkinsSettingsSection({ t }: PropsRuntime<'settings.section'> & { t: Translate }): ReactNode {
  const [rows, setRows] = useState<DraftRow[] | undefined>(undefined)
  const [defaultId, setDefaultId] = useState<string | undefined>(undefined)
  const [source, setSource] = useState<string>('none')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const load = useCallback(async () => {
    const answer = await fetchInstances()
    if (isFailure(answer)) {
      setError(answer.message)
      setRows([])
      return
    }
    setRows(answer.instances.map(draftOf))
    setDefaultId(answer.defaultInstanceId)
    setSource(answer.source)
  }, [])

  useEffect(() => { void load() }, [load])

  /** Patch one row. */
  const patch = useCallback((index: number, changes: Partial<DraftRow>) => {
    setRows((current) => current?.map((row, at) => (at === index ? { ...row, ...changes } : row)))
  }, [])

  const addRow = useCallback(() => {
    setRows((current) => {
      const taken = new Set((current ?? []).map(row => row.id))
      const id = idFrom(t('settings.instance.newName'), taken)
      return [
        ...(current ?? []),
        {
          id,
          name: t('settings.instance.newName'),
          baseUrl: 'http://',
          username: '',
          tokenRef: '',
          open: true,
          // A row that has never been saved has no credential yet; the empty
          // token field is therefore a required field, not a "keep" field.
          tokenConfigured: false,
        },
      ]
    })
  }, [t])

  const removeRow = useCallback((index: number) => {
    setRows((current) => (current ?? []).filter((_row, at) => at !== index))
  }, [])

  const testRow = useCallback(async (index: number) => {
    const row = rows?.[index]
    if (row === undefined) return
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    const answer = await probeInstance({
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl,
      username: row.username,
      tokenRef: row.tokenRef,
      ...row.token === undefined || row.token.length === 0 ? {} : { token: row.token },
    })
    setBusy(false)
    if (isFailure(answer)) {
      patch(index, { tested: `${t('settings.test.failed')}: ${answer.message}` })
      return
    }
    patch(index, {
      tested: t('settings.test.ok', { user: answer.identity.fullName, count: answer.jobCount }),
    })
  }, [rows, patch, t])

  const save = useCallback(async () => {
    if (rows === undefined) return
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    const answer = await saveInstances(
      rows.map((row): InstanceInput => ({
        id: row.id,
        name: row.name,
        baseUrl: row.baseUrl,
        username: row.username,
        tokenRef: row.tokenRef,
        ...row.token === undefined || row.token.length === 0 ? {} : { token: row.token },
      })),
      defaultId,
    )
    setBusy(false)
    if (isFailure(answer)) {
      setError(answer.message)
      return
    }
    setRows(answer.instances.map(draftOf))
    setDefaultId(answer.defaultInstanceId)
    setSource(answer.source)
    setNotice(t('settings.saved'))
  }, [rows, defaultId, t])

  const heading = (
    <div style={{ marginBottom: '4px', color: 'var(--dsw-alias-label-primary)', fontSize: 'var(--dsw-font-s-strong-14)' }}>
      {t('settings.title')}
    </div>
  )

  if (rows === undefined) {
    return <div style={{ padding: '4px 0', color: 'var(--dsw-alias-label-tertiary)' }}>{t('loading')}</div>
  }

  return (
    <div>
      {heading}
      <p style={{ margin: '0 0 16px', color: 'var(--dsw-alias-label-tertiary)', fontSize: 'var(--dsw-font-xxs-12)' }}>
        {t('settings.intro')}
      </p>

      {source === 'config'
        ? (
            <p style={{ margin: '0 0 12px', color: 'var(--dsw-alias-label-tertiary)', fontSize: 'var(--dsw-font-xxs-12)' }}>
              {t('settings.fromConfig')}
            </p>
          )
        : null}

      {error !== undefined
        ? (
            <div style={{
              marginBottom: '12px',
              padding: '8px 10px',
              border: '1px solid var(--dsw-alias-state-error-primary)',
              borderRadius: '8px',
              color: 'var(--dsw-alias-label-error)',
              fontSize: 'var(--dsw-font-xxs-12)',
            }}
            >
              {error}
            </div>
          )
        : null}

      {notice !== undefined
        ? (
            <div style={{
              marginBottom: '12px',
              color: 'var(--dsw-alias-state-success-primary)',
              fontSize: 'var(--dsw-font-xxs-12)',
            }}
            >
              {notice}
            </div>
          )
        : null}

      {rows.length === 0
        ? (
            <p style={{ margin: '0 0 12px', color: 'var(--dsw-alias-label-tertiary)', fontSize: 'var(--dsw-font-sm-13)' }}>
              {t('settings.empty')}
            </p>
          )
        : null}

      <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {rows.map((row, index) => (
          <li
            key={`${row.id}-${index}`}
            style={{
              marginBottom: '8px',
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: '12px',
              overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px' }}>
              <span
                aria-hidden
                style={{
                  flex: 'none',
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  background: row.tokenConfigured === true
                    ? 'var(--dsw-alias-state-success-primary)'
                    : 'var(--dsw-alias-label-quaternary)',
                }}
                title={row.tokenConfigured === true ? t('settings.token.set') : t('settings.token.unset')}
              />
              <span style={{ flex: 1, minWidth: 0, color: 'var(--dsw-alias-label-primary)', fontSize: 'var(--dsw-font-sm-13)' }}>
                <span style={{ fontWeight: 600 }}>{row.name}</span>
                <span style={{ marginLeft: '8px', color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'var(--dsw-font-mono)', fontSize: 'var(--dsw-font-xxs-12)' }}>
                  {row.baseUrl}
                </span>
              </span>
              {defaultId === row.id
                ? (
                    <span style={{
                      flex: 'none',
                      padding: '0 6px',
                      borderRadius: '5px',
                      background: 'var(--dsw-alias-fill-l2)',
                      color: 'var(--dsw-alias-label-secondary)',
                      fontSize: 'var(--dsw-font-xxxs-11)',
                    }}
                    >
                      {t('settings.default')}
                    </span>
                  )
                : (
                    <Action label={t('settings.makeDefault')} onClick={() => { setDefaultId(row.id) }} />
                  )}
              <Action
                label={row.open ? t('settings.collapse') : t('settings.edit')}
                onClick={() => { patch(index, { open: !row.open }) }}
              />
              <Action label={t('settings.remove')} tone="danger" onClick={() => { removeRow(index) }} />
            </div>

            {row.open
              ? (
                  <div style={{ padding: '4px 12px 12px', borderTop: '1px solid var(--dsw-alias-border-l2)' }}>
                    <Field
                      id={`jenkins-name-${index}`}
                      label={t('settings.field.name')}
                      value={row.name}
                      onChange={(next) => { patch(index, { name: next }) }}
                    />
                    <Field
                      id={`jenkins-url-${index}`}
                      label={t('settings.field.url')}
                      value={row.baseUrl}
                      placeholder={t('settings.field.urlHint')}
                      onChange={(next) => { patch(index, { baseUrl: next }) }}
                    />
                    <Field
                      id={`jenkins-user-${index}`}
                      label={t('settings.field.username')}
                      value={row.username}
                      onChange={(next) => { patch(index, { username: next }) }}
                    />
                    <Field
                      id={`jenkins-token-${index}`}
                      label={t('settings.field.token')}
                      type="password"
                      value={row.token ?? ''}
                      placeholder={row.tokenConfigured === true ? t('settings.field.tokenKeep') : ''}
                      onChange={(next) => { patch(index, { token: next }) }}
                    />
                    <Field
                      id={`jenkins-ref-${index}`}
                      label={t('settings.field.tokenRef')}
                      value={row.tokenRef}
                      placeholder={t('settings.field.tokenRefHint')}
                      onChange={(next) => { patch(index, { tokenRef: next }) }}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Action label={t('settings.test')} onClick={() => { void testRow(index) }} disabled={busy} />
                      {row.tested !== undefined
                        ? (
                            <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 'var(--dsw-font-xxs-12)' }}>
                              {row.tested}
                            </span>
                          )
                        : null}
                    </div>
                  </div>
                )
              : null}
          </li>
        ))}
      </ul>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px' }}>
        <Action label={t('settings.add')} onClick={addRow} />
        <Action label={busy ? t('settings.saving') : t('settings.save')} tone="primary" onClick={() => { void save() }} disabled={busy} />
      </div>
    </div>
  )
}
