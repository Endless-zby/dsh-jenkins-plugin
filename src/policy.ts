/**
 * Who may write to Jenkins.
 *
 * The plugin has two ways to change a controller — a model tool call and a click
 * in the panel — and both must obey the same configuration. What differs is only
 * what happens *after* configuration has spoken: the tool asks the operator for
 * approval, the panel has already been confirmed in the browser.
 *
 * That split is why this lives on its own. SPEC §7 requires `denyJobs` and the
 * `allow.*` switches to be decided **first and without side effects**, so a
 * forbidden job never produces an approval prompt an operator has to dismiss;
 * keeping the decision in one pure function is what makes that ordering hold for
 * both callers instead of being re-implemented correctly twice.
 * @module dsh-jenkins-plugin/policy
 */

import { isDeniedJob } from './config.js'
import type { Config } from './config.js'

/** The two writes this plugin can perform. */
export type WriteAction = 'trigger' | 'cancel'

/** The verdict on one write. */
export type PolicyVerdict = { allowed: true } | { allowed: false, reason: string }

/**
 * Decide whether configuration permits one write.
 * @param config - validated plugin configuration.
 * @param jobPath - the job being written to, as `folder/sub/job`.
 * @param action - what is about to be done.
 * @returns whether it is permitted, with the reason when it is not.
 */
export function checkWritePolicy(config: Config, jobPath: string, action: WriteAction): PolicyVerdict {
  if (isDeniedJob(config.denyJobs, jobPath)) {
    // Spelled out rather than `${action}ed`, which would read "canceled" — the
    // plugin's own copy says "cancelling", and one refusal should not be the
    // only place with the other spelling.
    const past = action === 'trigger' ? 'triggered' : 'cancelled'
    return {
      allowed: false,
      reason: `"${jobPath}" is on this plugin's denyJobs list, so it can never be ${past}`,
    }
  }
  if (action === 'trigger' && !config.allowTrigger) {
    return { allowed: false, reason: 'triggering builds is disabled by allowTrigger' }
  }
  if (action === 'cancel' && !config.allowCancel) {
    return { allowed: false, reason: 'cancelling builds is disabled by allowCancel' }
  }
  return { allowed: true }
}
