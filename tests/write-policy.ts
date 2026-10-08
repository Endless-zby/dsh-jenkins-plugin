/**
 * Assertions for the shared write policy.
 *
 * The rule that matters is the ordering SPEC §7 fixes: `denyJobs` and the
 * `allow.*` switches are decided before anything else, so a forbidden job can
 * never reach an approval prompt. That is asserted here rather than inferred
 * from the tool's behaviour, because the panel's write routes call the same
 * function and must inherit exactly the same refusals.
 *
 * Run with `node tests/write-policy.ts` after `tsc`.
 * @module dsh-jenkins-plugin/tests/write-policy
 */

import { readFileSync } from 'node:fs'
import { Config } from '../lib/config.js'
import { checkWritePolicy } from '../lib/policy.js'

/** Collected pass/fail results. */
const results: boolean[] = []

/**
 * Assert one value.
 * @param label - what is being checked.
 * @param actual - the value produced.
 * @param expected - the value expected.
 */
function check(label: string, actual: unknown, expected: unknown): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  results.push(pass)
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${pass ? '' : ` (expected ${JSON.stringify(expected)})`}`)
}

/**
 * Build a configuration with only the policy fields named.
 * @param fields - overrides for the defaults.
 * @returns the validated configuration.
 */
function config(fields: Record<string, unknown> = {}): Config {
  return Config({
    settingsFile: 'unused.json',
    baseUrl: '',
    username: '',
    allowTrigger: true,
    allowCancel: false,
    denyJobs: [],
    ...fields,
  })
}

/** The verdict as one comparable value, so a whole answer can be asserted. */
function verdict(result: { allowed: boolean, reason?: string }): string {
  return result.allowed ? 'allowed' : `refused: ${result.reason}`
}

console.log('1) the defaults: triggering is allowed, cancelling is not')
check('trigger', verdict(checkWritePolicy(config(), 'team/service/api-build', 'trigger')), 'allowed')
check(
  'cancel',
  verdict(checkWritePolicy(config(), 'team/service/api-build', 'cancel')),
  'refused: cancelling builds is disabled by allowCancel',
)

console.log('\n2) the allow switches decide on their own')
check(
  'trigger with allowTrigger=false',
  verdict(checkWritePolicy(config({ allowTrigger: false }), 'smoke', 'trigger')),
  'refused: triggering builds is disabled by allowTrigger',
)
check(
  'cancel with allowCancel=true',
  verdict(checkWritePolicy(config({ allowCancel: true }), 'smoke', 'cancel')),
  'allowed',
)

console.log('\n3) denyJobs: an exact path, and a folder prefix')
const denied = config({ allowCancel: true, denyJobs: ['infra/*', 'smoke'] })
check(
  'a job under a denied folder',
  verdict(checkWritePolicy(denied, 'infra/deploy-prod', 'trigger')),
  'refused: "infra/deploy-prod" is on this plugin\'s denyJobs list, so it can never be triggered',
)
check(
  'the denylist applies to cancelling too',
  verdict(checkWritePolicy(denied, 'infra/deploy-prod', 'cancel')),
  'refused: "infra/deploy-prod" is on this plugin\'s denyJobs list, so it can never be cancelled',
)
check(
  'an exact denied path',
  verdict(checkWritePolicy(denied, 'smoke', 'trigger')),
  'refused: "smoke" is on this plugin\'s denyJobs list, so it can never be triggered',
)

console.log('\n4) denyJobs outranks the allow switches, so a denied job is refused even when writes are on')
check(
  'denied job with everything allowed',
  verdict(checkWritePolicy(config({ allowTrigger: true, allowCancel: true, denyJobs: ['smoke'] }), 'smoke', 'trigger')).startsWith('refused:'),
  true,
)
// The order is what keeps an operator from being asked to approve a job the
// configuration already forbids; the reason naming denyJobs (not the switch) is
// how that ordering is observable at all.
check(
  'the refusal names the denylist, not the switch',
  verdict(checkWritePolicy(config({ allowTrigger: false, denyJobs: ['smoke'] }), 'smoke', 'trigger')).includes('denyJobs'),
  true,
)

console.log('\n5) a job is not matched by a folder that merely shares its prefix')
const prefix = config({ denyJobs: ['infra/*'] })
check('a sibling with a longer name is still allowed', verdict(checkWritePolicy(prefix, 'infrastructure/x', 'trigger')), 'allowed')
check('the folder itself is not the prefix match', verdict(checkWritePolicy(prefix, 'infra', 'trigger')), 'allowed')
check('a nested job under the folder is matched', verdict(checkWritePolicy(prefix, 'infra/a/b', 'trigger')).startsWith('refused:'), true)

console.log('\n6) the panel write path never reaches for the approval seam')
// SPEC §7 gives the panel a different gate, because `ctx.approval` requires the
// caller to be inside an unfinished turn and a click in the panel is not. That
// is enforced by the route file simply not using the seam, which is invisible in
// behaviour until somebody wires it up and every panel write starts failing on a
// missing approval — so it is asserted here, on the source, comments excluded.
const routes = readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8')
const code = routes.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
check('routes.ts does not use ctx.approval', /approval/.test(code), false)
check('it does use the shared policy', /checkWritePolicy\(/.test(code), true)

const failed = results.filter(pass => !pass).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exitCode = 1
