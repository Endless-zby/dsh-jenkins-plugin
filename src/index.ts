/**
 * Jenkins plugin for DeepSeek Harness.
 *
 * Host half: owns the effective Jenkins connection (panel settings overriding
 * static configuration), resolves the API token per call so a rotation applies
 * without a restart, exposes model-facing build tools over the shared HTTP
 * client, and mounts the panel's same-origin routes when the composition
 * provides a web server.
 * @module dsh-jenkins-plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.js'
import { InstanceRegistry } from './connection.js'
import { FollowWatcher } from './follow.js'
import { buildProgress } from './jenkins/types.js'
import { BuildTracker, isRecordGone } from './tracker.js'
import type { TrackedBuild } from './tracker.js'
import { registerJenkinsJobsTool } from './tools/jobs.js'
import {
  registerJenkinsBuildStatusTool,
  registerJenkinsBuildTool,
  registerJenkinsLogTool,
  registerJenkinsWorkspaceTool,
} from './tools/builds.js'
import { registerJenkinsRoutes } from './routes.js'

export { Config, isDeniedJob } from './config.js'
export type { Config as JenkinsPluginConfig } from './config.js'
export { InstanceRegistry, InstanceUnavailable } from './connection.js'
export type { InstanceGap, InstanceSource, ResolvedInstance } from './connection.js'
export { tokenRefFor } from './settings.js'
export type { JenkinsInstance, JenkinsSettings } from './settings.js'

export const name = 'jenkins-plugin'

/** Services this plugin needs before it activates. */
export const inject = ['tools', 'credentials']

/**
 * Commits carried per tracked build.
 *
 * A card shows one line and a count, so keeping more than a handful would only
 * make every snapshot frame heavier.
 */
const CHANGE_PREVIEW = 3

/**
 * Mount the Jenkins plugin.
 * @param ctx - plugin context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const registry = new InstanceRegistry(ctx, config)

  // Live build tracking for the panel. The loop only runs while a panel is
  // subscribed to the event stream, so this is free when nobody is looking.
  // It is created before the tools because a build the model triggers has to be
  // tracked too — otherwise the panel would show everything except the build the
  // session just started (SPEC §10, acceptance 1).
  const tracker = new BuildTracker(config)

  /**
   * Read one tracked build and report what it is doing.
   *
   * One detail read answers both questions the tracker has: the summary the
   * progress rule needs, and the stages that make it exact when a Pipeline
   * reports them.
   * @param record - the tracked build to refresh.
   */
  const refresh = async (record: TrackedBuild): Promise<void> => {
    if (record.buildNumber === undefined) return
    const { client } = await registry.require(record.instanceId)
    const detail = await client.buildDetail(record.jobPath, String(record.buildNumber))
    tracker.observe(record.id, {
      stages: detail.stages,
      progress: buildProgress(detail, detail.stages),
      outcome: detail.outcome,
      finished: !detail.building,
      // The change set came with the same response, so a card can say what the
      // build is actually doing without costing another request. Bounded because
      // this rides on every snapshot frame: a build with forty commits only ever
      // needs to show its newest few, and the count says how many there were.
      changes: detail.changes.slice(0, CHANGE_PREVIEW),
      changeCount: detail.changes.length,
    })
  }

  /**
   * Refresh one record, keeping a failure to that record alone.
   *
   * One unreadable build must not stop the others: a single record naming a job
   * the controller does not have would otherwise fail on every tick and, since
   * the whole batch is one call, leave **every** other build unrefreshed — which
   * a person sees as a panel where nothing ever moves. A build Jenkins says is
   * gone is dropped with the reason; anything else is left for the next tick,
   * because a controller that is briefly unreachable is not a reason to forget a
   * build.
   * @param record - the record to refresh.
   */
  const refreshOne = async (record: TrackedBuild): Promise<void> => {
    try {
      // A record with no number is one this plugin triggered and Jenkins has not
      // picked up yet, so the queue item is what is read — and the moment it
      // carries an `executable` the record becomes a build (SPEC §8).
      if (record.queueId !== undefined) {
        const { client } = await registry.require(record.instanceId)
        const item = await client.queueItem(`queue/item/${record.queueId}`)
        if (item.buildNumber === undefined) {
          if (Date.now() - (record.queuedAt ?? Date.now()) > config.queueTimeoutMs) {
            tracker.detach(record.id, item.why ?? 'the queue item never became a build')
          }
          return
        }
        const adopted = tracker.observe(record.id, { buildNumber: item.buildNumber })
        // Read in the same pass, so the panel's first sight of the build already
        // has stages and an estimate to draw instead of an empty bar.
        if (adopted !== undefined) await refresh(adopted)
        return
      }
      if (record.buildNumber === undefined) {
        tracker.detach(record.id, 'this record has no build to follow')
        return
      }
      await refresh(record)
    } catch (error) {
      // A credential problem is not a reason to forget a build: the whole
      // instance is unreachable, and the records are wanted again as soon as it
      // answers. Only "Jenkins does not have this" is permanent.
      if (!isRecordGone(error)) return
      const target = record.buildNumber === undefined ? record.jobPath : `${record.jobPath} #${record.buildNumber}`
      tracker.detach(record.id, `${record.instanceId} does not have ${target}`)
    }
  }

  tracker.start(async (due) => {
    for (const record of due) await refreshOne(record)
  })
  ctx.effect(() => () => { tracker.stop() }, 'jenkins: live build tracker')

  registerJenkinsJobsTool(ctx, registry, config)
  registerJenkinsBuildTool(ctx, registry, config, tracker)
  registerJenkinsBuildStatusTool(ctx, registry, config)
  registerJenkinsLogTool(ctx, registry, config)
  registerJenkinsWorkspaceTool(ctx, registry, config)

  // Followed jobs are watched for completion here rather than in the browser:
  // the notice has to arrive even with no panel open, and it is the operator's
  // follow list — not the tab — that decides what is worth announcing.
  const watcher = new FollowWatcher(ctx, registry, config)
  ctx.effect(() => watcher.start(), 'jenkins: followed-job completion watcher')

  // The routes exist only where the composition provides a web server; every
  // other surface (tools, background tracking) works without one.
  ctx.inject(['webServer'], (webCtx) => {
    registerJenkinsRoutes(webCtx, registry, config, tracker)
  })
}
