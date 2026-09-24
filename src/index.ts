/**
 * Jenkins plugin for DeepSeek Harness.
 *
 * Host half: resolves the configured API token per call, exposes model-facing
 * build tools over the shared HTTP client, and mounts the panel's same-origin
 * routes when the composition provides a web server.
 * @module dsh-jenkins-plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Config } from './config.js'
import { JenkinsClient, JenkinsError } from './jenkins/client.js'
import { registerJenkinsJobsTool } from './tools/jobs.js'
import { registerJenkinsRoutes } from './routes.js'

export { Config, isDeniedJob } from './config.js'
export type { Config as JenkinsPluginConfig } from './config.js'

export const name = 'jenkins-plugin'

/** Services this plugin needs before it activates. */
export const inject = ['tools', 'credentials']

/**
 * Mount the Jenkins plugin.
 * @param ctx - plugin context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const client = new JenkinsClient(config, async () => {
    const hit = await ctx.credentials.resolve(credentialRef(config.tokenRef))
    if (hit === undefined || hit.value.length === 0) {
      throw new JenkinsError(`credential "${config.tokenRef}" is not configured`, 'config')
    }
    return hit.value
  })

  registerJenkinsJobsTool(ctx, client, config)

  // The routes exist only where the composition provides a web server; every
  // other surface (tools, background tracking) works without one.
  ctx.inject(['webServer'], (webCtx) => {
    registerJenkinsRoutes(webCtx, client, config)
  })
}
