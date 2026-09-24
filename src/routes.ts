/**
 * Same-origin HTTP routes the browser panel calls. Every handler runs the
 * composition's browser request-trust check first, because the bare HTTP server
 * carries no authentication or origin policy of its own.
 * @module dsh-jenkins-plugin/routes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Config } from './config.js'
import { JenkinsError } from './jenkins/client.js'
import type { JenkinsClient } from './jenkins/client.js'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** GET route returning the panel's current view of the Jenkins instance. */
export const STATE_ROUTE = '/jenkins-plugin/state'

/** Browser request-trust surface the Web composition provides. */
interface BrowserTrust {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** The composition's connection service, read without a hard package dependency. */
function trustOf(ctx: Context): BrowserTrust | undefined {
  return Reflect.get(ctx, 'connection') as BrowserTrust | undefined
}

/** Write one JSON payload and end the response. */
function sendJson(res: ServerResponse, payload: unknown): void {
  res.statusCode = 200
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Write one failure payload the panel renders as a banner. */
function sendFailure(res: ServerResponse, error: unknown): void {
  if (error instanceof JenkinsError) {
    sendJson(res, { ok: false, code: error.code, message: error.message })
    return
  }
  sendJson(res, {
    ok: false,
    code: 'unknown',
    message: error instanceof Error ? error.message : 'unexpected failure',
  })
}

/**
 * Register the panel's routes on the injected web server.
 * @param ctx - the context carrying `webServer`.
 * @param client - the configured Jenkins client.
 * @param config - validated plugin configuration.
 */
export function registerJenkinsRoutes(ctx: Context, client: JenkinsClient, config: Config): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATE_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const rejection = trustOf(ctx)?.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      try {
        const jobs = await client.listJobs()
        sendJson(res, { ok: true, jobs, denyJobs: config.denyJobs })
      } catch (error) {
        sendFailure(res, error)
      }
    },
  }), `jenkins: GET ${STATE_ROUTE}`)
}
