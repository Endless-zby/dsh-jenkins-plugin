/**
 * Browser half: contributes the Jenkins build panel to the conversation header.
 * The bundle is a lazy module-graph factory, so nothing here runs until the
 * panel is first rendered.
 * @module dsh-jenkins-plugin/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { JenkinsPanel } from './Panel.js'

/** Client services this plugin needs. */
export const inject = ['slots']

/**
 * Register the panel into the session header's action list.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'jenkins',
    order: 60,
  }, JenkinsPanel))
}
