/**
 * The configured Jenkins instances and the client bound to each.
 *
 * Nothing here may be captured once at plugin load: the settings page can add,
 * remove, or re-point an instance at any moment, and a token can be rotated
 * without a restart (SPEC §10). Every request therefore asks for the instance
 * as it stands *now*.
 *
 * A client is cached per instance id and rebuilt only when that instance's
 * address, login, or token reference changes, so the CSRF crumb survives
 * ordinary requests instead of being refetched on each call.
 * @module dsh-jenkins-plugin/connection
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import { JenkinsClient, JenkinsError } from './jenkins/client.js'
import type { FavoriteJob, JenkinsInstance, JenkinsSettings } from './settings.js'
import {
  clearSettings,
  instanceFromConfig,
  loadSettings,
  saveSettings,
  settingsPath,
} from './settings.js'

/** Where the effective instance list came from, for the settings page to explain. */
export type InstanceSource = 'settings' | 'config' | 'none'

/** One usable instance plus the client bound to it. */
export interface ResolvedInstance {
  /** The instance as configured. */
  instance: JenkinsInstance
  /** Whether its token is currently resolvable. */
  tokenConfigured: boolean
  /** Which layer supplied the instance. */
  source: Exclude<InstanceSource, 'none'>
  /** Client bound to exactly this address and login. */
  client: JenkinsClient
}

/**
 * Why an instance cannot be used, in the settings page's vocabulary.
 * - `no-instances` — nothing is configured at all; show the empty state.
 * - `unknown-instance` — a caller named an id that is not configured.
 * - `no-token` — the instance exists but its secret is missing.
 */
export type InstanceGap = 'no-instances' | 'unknown-instance' | 'no-token'

/** Resolution failed for a reason the page can act on. */
export class InstanceUnavailable extends Error {
  /**
   * @param gap - which fact is missing.
   * @param message - operator-facing explanation.
   * @param instanceId - the instance the caller asked for, when it named one.
   */
  constructor(
    readonly gap: InstanceGap,
    message: string,
    readonly instanceId?: string,
  ) {
    super(message)
    this.name = 'InstanceUnavailable'
  }
}

/** One instance's cached client, keyed by the values that identify it. */
interface CachedClient {
  baseUrl: string
  username: string
  tokenRef: string
  client: JenkinsClient
}

/**
 * Holds the effective instance list and hands out a client per instance.
 *
 * One instance per plugin load; the settings page and every tool share it.
 */
export class InstanceRegistry {
  private settings: JenkinsSettings | undefined
  private loaded = false
  private readonly clients = new Map<string, CachedClient>()

  /**
   * @param ctx - plugin context carrying the credential seam.
   * @param config - validated static configuration, the fallback layer.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  /** Absolute path of the settings file. */
  get file(): string {
    return settingsPath(this.config.settingsFile)
  }

  /**
   * Read the stored settings, caching one successful read.
   *
   * Cached because every request needs it and it changes only when this plugin
   * writes it; {@link replace} refreshes the cache so the page sees its own
   * write immediately.
   * @returns the stored settings, or `undefined` when none are stored.
   */
  private async stored(): Promise<JenkinsSettings | undefined> {
    if (!this.loaded) {
      this.settings = await loadSettings(this.file)
      this.loaded = true
    }
    return this.settings
  }

  /** Which layer currently supplies the instance list. */
  async source(): Promise<InstanceSource> {
    if (await this.stored() !== undefined) return 'settings'
    return instanceFromConfig(this.config).length > 0 ? 'config' : 'none'
  }

  /**
   * Every configured instance, in display order.
   *
   * The static configuration is the fallback only while nothing is stored, so a
   * settings page that saved an empty list is honoured rather than silently
   * resurrecting the config row.
   * @returns the instances and which layer they came from.
   */
  async list(): Promise<{ instances: JenkinsInstance[], defaultInstanceId?: string, source: InstanceSource }> {
    const stored = await this.stored()
    if (stored !== undefined) {
      return {
        instances: stored.instances,
        ...stored.defaultInstanceId === undefined ? {} : { defaultInstanceId: stored.defaultInstanceId },
        source: 'settings',
      }
    }
    const fromConfig = instanceFromConfig(this.config)
    return {
      instances: fromConfig,
      ...fromConfig[0] === undefined ? {} : { defaultInstanceId: fromConfig[0].id },
      source: fromConfig.length === 0 ? 'none' : 'config',
    }
  }

  /**
   * One instance's favorited jobs, in the order they were added.
   *
   * Favorites live in the same file as the instance list but are keyed by
   * instance, so a path is never interpreted against the wrong controller.
   * @param instanceId - the instance whose favorites to read.
   * @returns the favorite entries; empty when none are stored.
   */
  async favorites(instanceId: string): Promise<FavoriteJob[]> {
    const stored = await this.stored()
    return stored?.favorites?.[instanceId] ?? []
  }

  /**
   * Persist one instance's favorites, leaving every other field alone.
   *
   * Reads the current settings first rather than taking a whole object, so a
   * caller cannot accidentally drop a field it did not know about — which is
   * exactly how saving the instance list once wiped every favorite.
   * @param instanceId - the instance the favorites belong to.
   * @param favorites - that instance's favorites, after the change.
   */
  private async storeFavorites(instanceId: string, favorites: FavoriteJob[]): Promise<void> {
    const current = await this.list()
    const stored = await this.stored()
    const all = { ...stored?.favorites ?? {} }
    if (favorites.length === 0) delete all[instanceId]
    else all[instanceId] = favorites
    await this.replace({
      instances: current.instances,
      ...current.defaultInstanceId === undefined ? {} : { defaultInstanceId: current.defaultInstanceId },
      ...Object.keys(all).length === 0 ? {} : { favorites: all },
    })
  }

  /**
   * Add or remove one favorite, preserving everything else in the file.
   *
   * The whole list is rewritten because the settings file has no update-in-place
   * path; a read-modify-write is safe here because this plugin is the only
   * writer and the call is awaited before the cache advances.
   *
   * Re-favoriting a job that is already followed refreshes the recorded name and
   * session instead of leaving them stale: following a job from another
   * conversation has to move where its failure wake goes, or the notice would
   * keep arriving in a session the person has left.
   * @param instanceId - the instance the path belongs to.
   * @param jobPath - the job path to toggle.
   * @param name - display name to record when adding.
   * @param favorited - the desired state.
   * @param sessionId - session that followed it, when the caller knows one.
   * @returns the instance's favorites after the change.
   */
  async setFavorite(
    instanceId: string,
    jobPath: string,
    name: string,
    favorited: boolean,
    sessionId?: string,
  ): Promise<FavoriteJob[]> {
    const forInstance = await this.favorites(instanceId)
    const recorded = { ...sessionId === undefined ? {} : { sessionId } }
    const next = favorited
      ? forInstance.some(entry => entry.path === jobPath)
        ? forInstance.map(entry => (entry.path === jobPath ? { ...entry, name, ...recorded } : entry))
        : [...forInstance, { path: jobPath, name, addedAt: Date.now(), ...recorded }]
      : forInstance.filter(entry => entry.path !== jobPath)
    await this.storeFavorites(instanceId, next)
    return next
  }

  /**
   * Persist a new instance list, keeping every other setting.
   *
   * Instance editing and favoriting both end up in one file, so each must
   * preserve the other's data: this method carries the stored favorites across
   * the write instead of replacing the whole document.
   * @param instances - the instance list to store.
   * @param defaultInstanceId - the instance tools and the panel prefer.
   */
  async saveInstances(instances: JenkinsInstance[], defaultInstanceId?: string): Promise<void> {
    const stored = await this.stored()
    await this.replace({
      instances,
      ...defaultInstanceId === undefined ? {} : { defaultInstanceId },
      ...stored?.favorites === undefined ? {} : { favorites: stored.favorites },
    })
  }

  /**
   * Persist a new instance list and adopt it immediately.
   *
   * The write is awaited before the cache is updated, so a failed write never
   * leaves the running plugin claiming a configuration it could not store.
   * Every cached client is dropped, because any id may have been re-pointed.
   * @param settings - the list to store.
   */
  async replace(settings: JenkinsSettings): Promise<void> {
    await saveSettings(this.file, settings)
    this.settings = settings
    this.loaded = true
    this.clients.clear()
  }

  /** Remove the stored list, falling back to the static configuration. */
  async reset(): Promise<void> {
    await clearSettings(this.file)
    this.settings = undefined
    this.loaded = true
    this.clients.clear()
  }

  /**
   * Whether one instance's token is resolvable right now.
   *
   * Read through the seam's own description, which reports source and
   * writability without ever exposing the value.
   * @param instance - the instance to check.
   * @returns true when resolution would currently produce a value.
   */
  async tokenConfigured(instance: JenkinsInstance): Promise<boolean> {
    const info = await this.ctx.credentials.describe(credentialRef(instance.tokenRef))
    return info.configured
  }

  /**
   * Resolve one instance, or explain what is missing.
   *
   * The token is deliberately not fetched here: this answers "can this instance
   * be used", and one probe should not cost two credential reads. The client
   * resolves the token per request.
   * @param id - the instance to resolve; the configured default when omitted.
   * @returns the usable instance.
   * @throws {InstanceUnavailable} when the page must ask for configuration.
   */
  async require(id?: string): Promise<ResolvedInstance> {
    const { instances, defaultInstanceId, source } = await this.list()
    if (instances.length === 0) {
      throw new InstanceUnavailable(
        'no-instances',
        'No Jenkins instance is configured yet; add one in Settings.',
      )
    }
    const wanted = id ?? defaultInstanceId ?? instances[0]?.id
    const instance = instances.find(candidate => candidate.id === wanted)
    if (instance === undefined) {
      throw new InstanceUnavailable(
        'unknown-instance',
        `No Jenkins instance is configured with id "${wanted}".`,
        wanted,
      )
    }
    if (!await this.tokenConfigured(instance)) {
      throw new InstanceUnavailable(
        'no-token',
        `No API token is stored for instance "${instance.name}" (${instance.tokenRef}); set one in Settings.`,
        instance.id,
      )
    }
    return {
      instance,
      tokenConfigured: true,
      source: source === 'none' ? 'settings' : source,
      client: this.clientFor(instance),
    }
  }

  /** The client for one instance, reused while its identity stays the same. */
  private clientFor(instance: JenkinsInstance): JenkinsClient {
    const cached = this.clients.get(instance.id)
    if (
      cached !== undefined
      && cached.baseUrl === instance.baseUrl
      && cached.username === instance.username
      && cached.tokenRef === instance.tokenRef
    ) {
      return cached.client
    }
    const client = new JenkinsClient(
      { ...this.config, baseUrl: instance.baseUrl, username: instance.username },
      async () => {
        const hit = await this.ctx.credentials.resolve(credentialRef(instance.tokenRef))
        if (hit === undefined || hit.value.length === 0) {
          throw new JenkinsError(`credential "${instance.tokenRef}" is not configured`, 'config')
        }
        return hit.value
      },
    )
    this.clients.set(instance.id, {
      baseUrl: instance.baseUrl,
      username: instance.username,
      tokenRef: instance.tokenRef,
      client,
    })
    return client
  }
}
