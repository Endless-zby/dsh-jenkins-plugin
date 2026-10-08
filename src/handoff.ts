/**
 * Delivering a plugin-authored message into a session.
 *
 * Two callers want the same thing: the panel's "hand it to the AI" route, where
 * a person clicked, and the failure watcher, which wakes the session that
 * followed the job. Both need "reach this session's live agent, or say precisely
 * why not", so the lookup and the message construction live here rather than
 * being written twice — a hand-rolled message shape is exactly the kind of thing
 * that drifts from what the platform actually accepts.
 *
 * The three outcomes are distinct on purpose: a composition without an agent
 * runtime is a different situation from a session whose agent has gone away, and
 * the route answers them with different statuses.
 * @module dsh-jenkins-plugin/handoff
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** The part of one agent this plugin uses. */
export interface AgentLike {
  /** Queue a message in this agent's conversation. */
  followup(message: unknown): void
}

/**
 * The agent runtime, as seen through `ctx.get('agents')`.
 *
 * Declared structurally rather than imported so a composition that mounts no
 * agent runtime still loads this plugin: the lookup then reports `no-service`.
 */
export interface AgentService {
  /**
   * The live agent for a session.
   * @param sessionId - durable session identity.
   * @returns the agent, or undefined when that session has none.
   */
  get(sessionId: string): AgentLike | undefined
}

/** How the plugin names itself in a message's provenance. */
const PLUGIN_ID = 'jenkins-plugin'

/** Whether a session can be reached, and how. */
export type FollowupLookup =
  | { kind: 'ok', followup: (prompt: string) => void }
  | { kind: 'no-service' }
  | { kind: 'no-session' }

/**
 * Resolve the message sink for one session.
 *
 * A missing session is not an error: a favorite may have been added in a
 * conversation that has since been closed, and waking nothing is the correct
 * answer there.
 * @param ctx - plugin context, read for the optional agent runtime.
 * @param sessionId - the session to deliver into.
 * @returns the sink, or which half of the chain is missing.
 */
export function followupFor(ctx: Context, sessionId: string): FollowupLookup {
  const agents = ctx.get('agents') as AgentService | undefined
  if (agents === undefined) return { kind: 'no-service' }
  const agent = agents.get(sessionId)
  if (agent === undefined) return { kind: 'no-session' }
  return {
    kind: 'ok',
    followup: (prompt: string) => {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        // Tagged as this plugin's own message, so the conversation shows where
        // it came from and the model can tell it apart from the operator.
        source: { kind: 'plugin', plugin: PLUGIN_ID },
      }))
    },
  }
}
