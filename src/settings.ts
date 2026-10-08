/**
 * Jenkins instance list, persisted where the runtime can read it.
 *
 * An instance records what is *not* a secret — an id, a display name, the
 * controller URL, and the login name — plus the *name* of the credential that
 * holds its token. The token itself never appears here: it is written through
 * `ctx.credentials.set`, which owns its own store, its own file permissions,
 * and its own rotation events.
 *
 * Precedence for the effective instance list is `user file > static config >
 * absent`, so an existing profile configured in `cordis.patch.yml` keeps
 * working untouched and an unattended deployment can stay purely config-driven.
 * The single-instance file written by the first version of this plugin is still
 * readable and is migrated on load.
 * @module dsh-jenkins-plugin/settings
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

/** One configured Jenkins controller. */
export interface JenkinsInstance {
  /** Stable identity, used in URLs and to derive the credential reference. */
  id: string
  /** Display name the settings page and the panel show. */
  name: string
  /** Controller root URL. */
  baseUrl: string
  /** Login name paired with the API token. */
  username: string
  /**
   * `ctx.credentials` reference holding this instance's API token.
   *
   * Stored rather than derived so an operator can point an instance at a token
   * that already exists in the environment, and so renaming an instance does not
   * orphan its secret.
   */
  tokenRef: string
}

/** One favorited job. */
export interface FavoriteJob {
  /** Job path, as everywhere else in the plugin. */
  path: string
  /** Display name captured when it was favorited, so a card can render before Jenkins answers. */
  name: string
  /** When it was favorited, epoch milliseconds. */
  addedAt: number
}

/** The whole persisted configuration. */
export interface JenkinsSettings {
  /** Every configured controller, in the order the settings page shows them. */
  instances: JenkinsInstance[]
  /** Id of the instance tools and the panel use when none is named. */
  defaultInstanceId?: string
  /**
   * Favorited job paths, keyed by instance id.
   *
   * Keyed rather than a flat list because a path only means something within
   * one controller: `service/api` on two instances are two different jobs, and a
   * flat list would make unfavoriting one silently unfavorite the other.
   */
  favorites?: Record<string, FavoriteJob[]>
}

/** Filename inside the harness home. */
const SETTINGS_FILE = 'jenkins.json'

/**
 * Resolve the harness home the way the runtime does.
 *
 * `DSH_HOME` wins over `~/.dsh`, and a blank value counts as unset — the same
 * precedence `@deepseek-ai/dsh-home-paths` applies, restated here so this
 * plugin needs no extra runtime dependency for one join.
 * @returns the absolute harness home path.
 */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME
  const chosen = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')
  return isAbsolute(chosen) ? chosen : join(process.cwd(), chosen)
}

/**
 * Absolute path of the settings file.
 *
 * A relative `settingsFile` config value is resolved against the harness home,
 * so the common case stays a bare filename while a deployment can point it
 * anywhere.
 * @param settingsFile - configured filename or path.
 * @returns the absolute path.
 */
export function settingsPath(settingsFile: string): string {
  return isAbsolute(settingsFile) ? settingsFile : join(dshHome(), settingsFile)
}

/**
 * Derive the default credential reference for an instance id.
 *
 * Credential references are POSIX-style environment-variable names, so anything
 * outside `[A-Za-z0-9_]` is folded to `_` and a leading digit is prefixed. The
 * result is stable for a given id, which is what lets a renamed display name
 * keep its secret.
 * @param id - the instance id.
 * @returns a reference name in the credential grammar.
 */
export function tokenRefFor(id: string): string {
  const folded = id.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()
  const named = folded.length === 0 ? 'DEFAULT' : folded
  const prefixed = /^[0-9]/.test(named) ? `_${named}` : named
  return `JENKINS_TOKEN_${prefixed}`
}

/** Read one non-empty string field from unknown JSON. */
function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field.trim().length > 0 ? field.trim() : undefined
}

/** Validate one instance object, or explain why it is unusable. */
function parseInstance(value: unknown): JenkinsInstance | undefined {
  const id = stringField(value, 'id')
  const baseUrl = stringField(value, 'baseUrl')
  const username = stringField(value, 'username')
  if (id === undefined || baseUrl === undefined || username === undefined) return undefined
  const name = stringField(value, 'name') ?? id
  const tokenRef = stringField(value, 'tokenRef') ?? tokenRefFor(id)
  return { id, name, baseUrl, username, tokenRef }
}

/** Validate one favorited job out of stored JSON. */
function parseFavorite(value: unknown): FavoriteJob | undefined {
  const path = stringField(value, 'path')
  if (path === undefined) return undefined
  const name = stringField(value, 'name') ?? path
  const addedAt = typeof (value as { addedAt?: unknown }).addedAt === 'number'
    ? (value as { addedAt: number }).addedAt
    : 0
  return { path, name, addedAt }
}

/**
 * Read the favorites map, dropping anything unusable.
 *
 * A malformed entry is skipped rather than failing the whole file: favorites are
 * a convenience, and losing every instance because one path was hand-edited
 * would be a poor trade.
 * @param value - the stored `favorites` field.
 * @returns favorites keyed by instance id.
 */
function parseFavorites(value: unknown): Record<string, FavoriteJob[]> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, FavoriteJob[]> = {}
  for (const [instanceId, listed] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(listed)) continue
    const favorites = listed.flatMap((entry) => {
      const favorite = parseFavorite(entry)
      return favorite === undefined ? [] : [favorite]
    })
    if (favorites.length > 0) out[instanceId] = favorites
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Read the settings file.
 *
 * A missing file is the ordinary first-run state, so it reads as absent rather
 * than as an error. A malformed file is also absent: the settings page then
 * starts from the static config, which is a recoverable state, and failing the
 * whole plugin over a hand-edited JSON file would not be.
 * @param path - absolute settings path.
 * @returns the stored settings, or `undefined` when none are usable.
 */
export async function loadSettings(path: string): Promise<JenkinsSettings | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const favorites = parseFavorites((parsed as { favorites?: unknown }).favorites)

  // Version 2: an explicit instance list.
  const listed = (parsed as { instances?: unknown }).instances
  if (Array.isArray(listed)) {
    const instances = listed.flatMap((entry) => {
      const instance = parseInstance(entry)
      return instance === undefined ? [] : [instance]
    })
    if (instances.length === 0) return undefined
    const wanted = stringField(parsed, 'defaultInstanceId')
    const defaultInstanceId = instances.some(instance => instance.id === wanted)
      ? wanted
      : instances[0]?.id
    return {
      instances,
      ...defaultInstanceId === undefined ? {} : { defaultInstanceId },
      ...favorites === undefined ? {} : { favorites },
    }
  }

  // Version 1: one flat `{ baseUrl, username }` object. Migrated rather than
  // rejected so an install that used the earlier panel keeps its connection.
  const baseUrl = stringField(parsed, 'baseUrl')
  const username = stringField(parsed, 'username')
  if (baseUrl === undefined || username === undefined) return undefined
  const id = 'default'
  return {
    instances: [{
      id,
      name: 'Default',
      baseUrl,
      username,
      tokenRef: stringField(parsed, 'tokenRef') ?? 'JENKINS_TOKEN',
    }],
    defaultInstanceId: id,
    ...favorites === undefined ? {} : { favorites },
  }
}

/**
 * Write the settings file, creating the harness home when absent.
 *
 * Written to a sibling temporary file and renamed, so a crash mid-write leaves
 * the previous settings intact rather than a truncated file. Mode `0600`
 * matches the credential store: the file holds no secret, but it does hold
 * account names and internal URLs, which are not public either.
 * @param path - absolute settings path.
 * @param settings - the values to persist.
 */
export async function saveSettings(path: string, settings: JenkinsSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  const body = JSON.stringify({ version: 2, ...settings }, undefined, 2)
  await writeFile(temporary, `${body}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

/**
 * Remove the settings file.
 *
 * Called when the operator clears every instance. Stored tokens are removed
 * separately through the credential seam, because this file never held them.
 * @param path - absolute settings path.
 */
export async function clearSettings(path: string): Promise<void> {
  await rm(path, { force: true })
}

/**
 * Turn the static configuration into an instance list.
 *
 * This is what keeps a `cordis.patch.yml`-configured deployment working: the
 * plugin's own config fields describe exactly one controller, so they become
 * one instance. A deployment that configures nothing yields no instances.
 * @param config - the plugin's validated configuration.
 * @returns zero or one instances.
 */
export function instanceFromConfig(config: {
  baseUrl: string
  username: string
  tokenRef: string
}): JenkinsInstance[] {
  if (config.baseUrl.length === 0 || config.username.length === 0) return []
  return [{
    id: 'config',
    name: 'Configured',
    baseUrl: config.baseUrl,
    username: config.username,
    tokenRef: config.tokenRef,
  }]
}
