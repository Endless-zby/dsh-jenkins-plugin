/**
 * The panel's one write control: a button that turns into its own confirmation.
 *
 * SPEC §5.3 requires the person to confirm every write, and an inline prompt is
 * what that looks like in a narrow sidebar column: it can name the exact job and
 * the exact parameters being sent, where a modal would cover the very thing being
 * confirmed. The prompt is also where a refusal lands — a policy refusal
 * (`denyJobs`, `allow.*`) or a Jenkins error is shown against the action that
 * caused it rather than as a page-level banner.
 *
 * Shared by the job and build views and by the followed-job cards, because the
 * three of them perform the same writes and must not drift in how they ask.
 * @module dsh-jenkins-plugin/client/WriteAction
 */

import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { Pill } from './ui.js'
import type { JenkinsKey } from './locales.js'

/** Copy binder for this plugin's namespace. */
type Translate = (key: JenkinsKey, params?: Record<string, unknown>) => string

/**
 * One write, as a button that becomes its own confirmation.
 * @param props - copy binder, label, question, the write, and whether it runs on the first click.
 * @returns the button, its confirmation, and its outcome.
 */
export function WriteAction({ t, label, question, onRun, disabled, immediate }: {
  t: Translate
  label: string
  question: string
  onRun: () => Promise<string>
  disabled?: boolean
  /**
   * Skip the confirmation step.
   *
   * Set only for an action that changes nothing on the controller — asking the
   * model to look at a failed build, where the click *is* the intent and the
   * button reports what it did. Everything that triggers, aborts, or otherwise
   * changes a build confirms first (SPEC §5.3).
   */
  immediate?: boolean
}): ReactNode {
  const [stage, setStage] = useState<'idle' | 'confirm' | 'busy'>('idle')
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)

  /** Run the write and keep whatever it answered on screen. */
  const run = useCallback(async () => {
    setStage('busy')
    try {
      setMessage(await onRun())
      setFailed(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
      setFailed(true)
    }
    setStage('idle')
  }, [onRun])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        {stage === 'confirm'
          ? (
              <>
                <span style={{ fontSize: 'var(--dsw-font-xxxs-11)', color: 'var(--dsw-alias-label-secondary)' }}>
                  {question}
                </span>
                <Pill label={t('write.confirm')} onClick={() => { void run() }} />
                <Pill label={t('write.cancel')} onClick={() => { setStage('idle') }} />
              </>
            )
          : (
              <Pill
                label={stage === 'busy' ? t('write.working') : label}
                onClick={() => {
                  setMessage(undefined)
                  if (immediate === true) void run()
                  else setStage('confirm')
                }}
                disabled={disabled === true || stage === 'busy'}
              />
            )}
      </div>
      {message === undefined
        ? null
        : (
            <div style={{
              fontSize: 'var(--dsw-font-xxxs-11)',
              color: failed ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
            }}
            >
              {message}
            </div>
          )}
    </div>
  )
}
