/**
 * Assertions for the failure-analysis prompt.
 *
 * What this feature costs is tokens, and what it produces is a model answer
 * shaped by the instruction it was given. So the prompt is the contract: it must
 * carry the failing build's own facts, it must be honest that the log it carries
 * is a tail, and it must ask for a diagnosis plus a fix rather than a summary.
 * All of that is asserted here, without a controller or a model.
 *
 * Run with `node tests/analyze.ts` after `tsc`.
 * @module dsh-jenkins-plugin/tests/analyze
 */

import { analysisKey, failurePrompt, handOverFailure } from '../lib/analyze.js'
import type { AnalyzeReads, FailureContext } from '../lib/analyze.js'

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
 * A failed build, with whatever the case wants to vary.
 * @param fields - overrides.
 * @returns the context.
 */
function context(fields: Partial<FailureContext> = {}): FailureContext {
  return {
    jobPath: 'team/service/api-build',
    buildNumber: 42,
    outcome: 'failure',
    log: '[ERROR] Cannot resolve dependency\nBUILD FAILURE',
    truncated: false,
    ...fields,
  }
}

console.log('1) the build it is about, and how it ended')
const plain = failurePrompt(context())
check('names the job and build', plain.includes('team/service/api-build 构建 #42'), true)
check('states the outcome', plain.includes('结果：failure'), true)
check('carries the log verbatim', plain.includes('[ERROR] Cannot resolve dependency\nBUILD FAILURE'), true)
check('fences the log, so the model can tell it apart from the instruction', plain.includes('```'), true)

console.log('\n2) an absent fact is stated, not silently omitted')
// A Freestyle or Maven job reports no stages at all; the reader of the analysis
// needs to know whether Jenkins said nothing or the plugin did not look.
check('says the stage was not reported', plain.includes('失败阶段：未报告'), true)
check(
  'names the failed stage when there is one',
  failurePrompt(context({ failedStage: 'Package' })).includes('失败阶段：Package'),
  true,
)
check('omits a cause it does not have', plain.includes('触发原因'), false)
check(
  'includes the cause it does have',
  failurePrompt(context({ cause: 'Started by user bob' })).includes('触发原因：Started by user bob'),
  true,
)
check('omits an instance it does not know', plain.includes('实例：'), false)
check('names the instance when given', failurePrompt(context({ instanceName: '公司 CI' })).includes('实例：公司 CI'), true)

console.log('\n3) truncation is disclosed, with the real size')
const truncated = failurePrompt(context({ truncated: true, totalBytes: 102_664 }))
check('says the log is a tail', truncated.includes('只给了最后一段'), true)
check('and how big the whole log is', truncated.includes('102664 字节'), true)
check('an untruncated log makes no such claim', failurePrompt(context({ totalBytes: 400 })).includes('只给了最后一段'), false)

console.log('\n4) the commits, newest first and bounded')
const many = Array.from({ length: 9 }, (_, index) => ({
  commitId: `commit${index}0000`,
  author: 'Ann',
  message: `change ${index}`,
  timestamp: 0,
}))
const withCommits = failurePrompt(context({ changes: many }))
check('lists the newest commit first', withCommits.includes('- commit0 change 0 (Ann)'), true)
check('caps the list', withCommits.includes('change 5'), false)
check('no commits means no section', plain.includes('本次构建的提交'), false)
check(
  'a multi-line commit message is cut to its first line',
  failurePrompt(context({
    changes: [{ commitId: 'abcdef1234', author: '', message: 'fix: thing\n\nbody nobody wants', timestamp: 0 }],
  })).includes('- abcdef1 fix: thing\n'),
  true,
)
check(
  'and a very long first line is cut too',
  failurePrompt(context({
    changes: [{ commitId: 'abcdef1234', author: '', message: 'x'.repeat(400), timestamp: 0 }],
  })).includes('…'),
  true,
)

console.log('\n5) what it asks for')
check('a cause', plain.includes('最可能的失败原因'), true)
check('a fix', plain.includes('最简洁的修复指引'), true)
check('it forbids restating the log', plain.includes('不要复述日志'), true)
check('it forbids unsupported advice', plain.includes('不要给与日志无关的通用建议'), true)
// The model has the plugin's own tools; telling it so is what turns "the log is
// not enough" into a follow-up read rather than a guess.
check('it points at the tools for more detail', plain.includes('jenkins_log'), true)
check('including how to ask for more lines', plain.includes('tail_lines'), true)

console.log('\n6) the reservation key is per session, job, and build')
check('the key', analysisKey('session-abc', 'team/service/api-build', 42), 'session-abc/team/service/api-build#42')
check('another build is a different key', analysisKey('session-abc', 'team/service/api-build', 43) !== analysisKey('session-abc', 'team/service/api-build', 42), true)
check('another session is a different key', analysisKey('session-def', 'team/service/api-build', 42) !== analysisKey('session-abc', 'team/service/api-build', 42), true)

console.log('\n7) the hand-off: two reads, one queued prompt')
/** What the fake controller was asked for. */
const calls: Array<{ what: string, args: unknown[] }> = []
/** The detail a fake controller returns. */
function detailOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    outcome: 'failure',
    building: false,
    stages: [
      { name: 'Checkout', status: 'SUCCESS', durationMs: 10 },
      { name: 'Package', status: 'FAILED', durationMs: 20 },
    ],
    changes: [],
    ...overrides,
  }
}
/**
 * A controller that answers from a fixed log.
 * @param log - the log text.
 * @param totalSize - the size it states, when it states one.
 * @param truncated - whether it says it only returned part.
 * @returns the reads a hand-off needs.
 */
function reads(log: string, totalSize?: number, truncated = false): AnalyzeReads {
  return {
    async buildDetail(jobPath, selector, options) {
      calls.push({ what: 'buildDetail', args: [jobPath, selector, options] })
      return detailOf() as never
    },
    async consoleLog(jobPath, selector, offset, maxBytes) {
      calls.push({ what: 'consoleLog', args: [jobPath, selector, offset, maxBytes] })
      return {
        text: log,
        nextOffset: log.length,
        moreData: truncated,
        truncated,
        ...totalSize === undefined ? {} : { totalSize },
      }
    },
  }
}

calls.length = 0
const prompts: string[] = []
const handOff = await handOverFailure({
  client: reads('line 1\n[ERROR] boom\nBUILD FAILURE\n'),
  jobPath: 'team/service/api-build',
  buildNumber: 42,
  logBytes: 4096,
  instanceName: '公司 CI',
  followup: prompt => prompts.push(prompt),
})
check('the build detail was read for this build', calls[0], {
  what: 'buildDetail',
  args: ['team/service/api-build', '42', { maxBytes: 65_536 }],
})
check('the log was read as a tail, bounded by the configured size', calls[1], {
  what: 'consoleLog',
  args: ['team/service/api-build', '42', 0, 4096],
})
check('exactly one prompt was queued', prompts.length, 1)
check('it is about this job and build', prompts[0]?.includes('team/service/api-build 构建 #42'), true)
check('it names the instance', prompts[0]?.includes('实例：公司 CI'), true)
check('it names the failed stage, not the successful one', prompts[0]?.includes('失败阶段：Package'), true)
check('the log reached the prompt', prompts[0]?.includes('[ERROR] boom'), true)
check('and the whole hand-off was reported back', handOff, {
  buildNumber: 42,
  outcome: 'failure',
  // The byte count of 'line 1\n[ERROR] boom\nBUILD FAILURE\n'.
  logBytes: 34,
  truncated: false,
  promptChars: prompts[0]?.length ?? 0,
})

console.log('\n8) a truncated log is described as one, with its real size')
const truncatedPrompts: string[] = []
const tailOnly = await handOverFailure({
  client: reads('tail only\nBUILD FAILURE\n', 102_664, true),
  jobPath: 'demo',
  buildNumber: 7,
  logBytes: 4096,
  followup: prompt => truncatedPrompts.push(prompt),
})
check('the result says it truncated', tailOnly.truncated, true)
check('and carries the real size', tailOnly.totalBytes, 102_664)
check('the prompt says so too', truncatedPrompts[0]?.includes('只给了最后一段'), true)
check('and states how big the whole log is', truncatedPrompts[0]?.includes('102664 字节'), true)

console.log('\n9) a log that is not there is still an honest prompt')
const emptyPrompts: string[] = []
const empty = await handOverFailure({
  client: reads(''),
  jobPath: 'demo',
  buildNumber: 8,
  logBytes: 4096,
  followup: prompt => emptyPrompts.push(prompt),
})
check('zero bytes reported', empty.logBytes, 0)
check('the prompt still carries the instruction', emptyPrompts[0]?.includes('最可能的失败原因'), true)

const failed = results.filter(pass => !pass).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exitCode = 1
