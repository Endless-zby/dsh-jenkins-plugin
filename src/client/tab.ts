/**
 * The tab type identity for the Jenkins panel.
 *
 * Stage one of the right-Sidebar's two-stage registration: what the type IS.
 * Stage two is the keyed `sidebar.right.pane.tab` body registered under the
 * same id, which lives in `index.tsx`. There is exactly one Jenkins panel per
 * session, so the type is a page type (no `patterns`) and not `multiple`.
 * @module dsh-jenkins-plugin/client/tab
 */

import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/** This implementation's identity, and the key its body registers under. */
export const JENKINS_TAB_ID = 'jenkins-build'

/** The type discriminator `ctx.sidebarRight.openTab` names. */
export const JENKINS_TAB_KIND = 'jenkins-build'

/**
 * Build the tab definition.
 *
 * The title resolves through the registered dictionary, so it is read again on
 * every use and a language change needs no re-registration. The registry's
 * signature is deliberately namespace-agnostic (`key` is a plain string), so
 * the binder is wrapped rather than cast.
 * @param t - copy binder for this plugin's namespace.
 * @returns the definition to register.
 */
export function jenkinsTabDefinition(t: (key: string) => string): SidebarRightTabDefinition {
  return {
    id: JENKINS_TAB_ID,
    kind: JENKINS_TAB_KIND,
    title: () => t('tabTitle'),
    // Offers the panel on the sidebar's guide page, which is where a user looks
    // for a column that has no tab of this type open yet.
    guide: [{
      id: 'jenkins-build',
      order: 60,
      title: () => t('tabTitle'),
      description: () => t('tabDescription'),
    }],
  }
}
