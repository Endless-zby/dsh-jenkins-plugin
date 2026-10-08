/**
 * Browser half: contributes the Jenkins panel as a right-Sidebar tab, plus a
 * session-header button that opens it.
 *
 * The bundle is a lazy module-graph factory, so nothing here runs until the
 * containing plugin is first applied. Registration is the two-stage sidebar
 * path: the tab type into `ctx.sidebarRightTabs`, then the keyed body and chip
 * title under the type's own id.
 * @module dsh-jenkins-plugin/client
 */

import type { ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { JenkinsPanel } from './Panel.js'
import { JenkinsSettingsSection } from './SettingsSection.js'
import { JENKINS_TAB_ID, JENKINS_TAB_KIND, jenkinsTabDefinition } from './tab.js'
import { en, NS, zh, type JenkinsKey } from './locales.js'

export type { JenkinsKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Jenkins panel copy. */
    'jenkins': JenkinsKey
  }
}

/** Client services this plugin needs. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight']/** Session-header action id, fixed by the plugin's own contract. */
const HEADER_ACTION_ID = 'jenkins-build'

/** What the header button needs from the host composition. */
interface OpenPanelInjected {
  /** Open (and reveal) the Jenkins panel tab in this session's column. */
  open: () => void
}

/**
 * The session-header entry: one button that opens the panel tab.
 *
 * It opens rather than toggles because the panel is also reachable from the
 * sidebar's own strip and guide; a toggle here would fight those.
 * @param props - slot runtime props, the copy binder, and the open action.
 * @returns the header button.
 */
function OpenPanelButton({ t, open }: { t: (key: JenkinsKey) => string } & OpenPanelInjected): ReactNode {
  return (
    <button
      type="button"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 10px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-border, #d0d5dd)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      }}
      onClick={open}
    >
      {t('tabTitle')}
    </button>
  )
}

/**
 * Register the panel with the browser composition.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'jenkins: dictionaries')

  const bind = ctx.locale.bind(NS)
  // The tab registry takes a namespace-agnostic `(key: string) => string`; the
  // binder is narrowed to this namespace's key domain, so it is wrapped rather
  // than cast — an unknown key stays a type error at every call site below.
  const copy = (key: string): string => bind(key as JenkinsKey)

  ctx.effect(() => ctx.sidebarRightTabs.register(jenkinsTabDefinition(copy)), 'jenkins: sidebar tab type')

  // The settings page owns the instance list, so it carries the same namespace
  // binder the panel's registrations do and gets its copy through the `t` seat.
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'jenkins',
    order: 40,
    label: () => copy('settings.nav'),
    locale: NS,
    inject: () => ({ t: bind }),
  }, JenkinsSettingsSection)), 'jenkins: settings section')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: JENKINS_TAB_ID, locale: NS },
    JenkinsPanel,
  )), 'jenkins: sidebar tab body')

  // No `.title` registration: the chip shows the text the registry captured at
  // open time, which is already this plugin's own copy.
  ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: HEADER_ACTION_ID,
    order: 60,
    locale: NS,
    inject: (): OpenPanelInjected => ({
      open: () => { ctx.sidebarRight.openTab(JENKINS_TAB_KIND) },
    }),
  }, OpenPanelButton)), 'jenkins: session header action')
}
