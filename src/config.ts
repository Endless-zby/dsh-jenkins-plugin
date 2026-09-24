/**
 * Plugin configuration. Every deployment-varying choice is a validated field so
 * `cordis.yml`, a bundle patch, or the user's own patch can change it without a
 * code edit; secret values never appear here, only the name of a credential.
 * @module dsh-jenkins-plugin/config
 */

import z from '@deepseek-ai/schemastery'

/** Resolved configuration accepted by the Jenkins plugin. */
export interface Config {
  /** Jenkins root URL, for example `https://ci.example.com/jenkins`. */
  baseUrl: string
  /** Login name paired with the API token. */
  username: string
  /** `ctx.credentials` reference holding the API token. */
  tokenRef: string
  /** `verify` validates the server certificate; `allowSelfSigned` accepts an untrusted one. */
  tlsMode: 'verify' | 'allowSelfSigned'
  /** PEM bundle used to validate the server certificate under `verify`. */
  tlsCaFile?: string
  /** Bound on one HTTP request, in milliseconds. */
  timeoutMs: number
  /** `auto` fetches a CSRF crumb before mutating requests; `off` skips it. */
  crumbMode: 'auto' | 'off'
  /** Job paths that may never be triggered or cancelled; a trailing `/*` matches a folder. */
  denyJobs: string[]
  /** Whether the model may trigger builds. */
  allowTrigger: boolean
  /** Whether the model may cancel builds. */
  allowCancel: boolean
  /** Stage polling interval for tracked builds, in milliseconds. */
  progressIntervalMs: number
  /** Console-log polling interval for the build the panel shows, in milliseconds. */
  logIntervalMs: number
  /** Upper bound of the idle backoff applied while a tracked build makes no progress. */
  idleBackoffMaxMs: number
  /** How long a triggered build may stay queued before it is reported as timed out. */
  queueTimeoutMs: number
  /** Tracked builds one session may hold at once. */
  maxTrackedBuilds: number
  /** How long a finished build stays in the tracking table, in milliseconds. */
  retainMs: number
  /** Build-history rows a request returns unless the caller asks for fewer. */
  historyCount: number
  /** Byte cap on one console-log response. */
  maxLogBytes: number
  /** Entry cap on one workspace directory listing. */
  maxWorkspaceEntries: number
  /** Byte cap on one workspace file read. */
  maxReadFileBytes: number
  /** Whether a finished build is announced in the owning session. */
  notifyOnComplete: boolean
  /** Whether a failed build wakes the owning agent with a follow-up message. */
  notifyWakeOnFailure: boolean
  /** Whether triggering a build opens the panel on its own. */
  uiAutoOpenOnTrigger: boolean
}

/** Validated schema for {@link Config}; invalid configuration fails plugin load. */
export const Config: z<Config> = z.object({
  baseUrl: z.string().required(),
  username: z.string().required(),
  tokenRef: z.string().default('JENKINS_TOKEN'),
  tlsMode: z.union(['verify', 'allowSelfSigned'] as const).default('verify'),
  tlsCaFile: z.string(),
  timeoutMs: z.number().min(1).default(15_000),
  crumbMode: z.union(['auto', 'off'] as const).default('auto'),
  denyJobs: z.array(z.string()).default([]),
  allowTrigger: z.boolean().default(true),
  allowCancel: z.boolean().default(false),
  progressIntervalMs: z.number().min(250).default(3000),
  logIntervalMs: z.number().min(250).default(1500),
  idleBackoffMaxMs: z.number().min(1000).default(30_000),
  queueTimeoutMs: z.number().min(1000).default(300_000),
  maxTrackedBuilds: z.number().min(1).default(5),
  retainMs: z.number().min(0).default(600_000),
  historyCount: z.number().min(1).max(50).default(10),
  maxLogBytes: z.number().min(1024).default(262_144),
  maxWorkspaceEntries: z.number().min(1).default(500),
  maxReadFileBytes: z.number().min(1).default(1_048_576),
  notifyOnComplete: z.boolean().default(true),
  notifyWakeOnFailure: z.boolean().default(false),
  uiAutoOpenOnTrigger: z.boolean().default(true),
})

/**
 * Whether a job path is forbidden by the configured deny list.
 * @param denyJobs - configured deny patterns; a trailing `/*` matches a folder.
 * @param jobPath - candidate job path.
 * @returns true when the path matches an entry exactly or by folder prefix.
 */
export function isDeniedJob(denyJobs: readonly string[], jobPath: string): boolean {
  const normalized = jobPath.replace(/^\/+|\/+$/g, '')
  return denyJobs.some((entry) => {
    const pattern = entry.replace(/^\/+|\/+$/g, '')
    if (pattern.endsWith('/*')) return normalized.startsWith(`${pattern.slice(0, -2)}/`)
    return normalized === pattern
  })
}
