/**
 * Asking the model to explain a failed build.
 *
 * The panel's "hand it to the AI" button is one HTTP call and then a model turn,
 * which costs tokens, so what goes into that turn is the whole design: a bounded
 * tail of the console log, the facts the panel already knows (which build, which
 * stage failed, what commits it carried), and an instruction narrow enough that
 * the answer is a diagnosis and a fix rather than a summary of the log.
 *
 * The prompt is built here, as a pure function, because "what exactly did we send
 * the model" is the part worth asserting — the route around it is plumbing.
 * @module dsh-jenkins-plugin/analyze
 */

import type { JenkinsBuildDetail, JenkinsChange, JenkinsLogPage } from './jenkins/types.js'

/** What the panel knows about the failed build when it hands it over. */
export interface FailureContext {
  /** Job path, as `folder/sub/job`. */
  jobPath: string
  /** Build number. */
  buildNumber: number
  /** Terminal outcome, which the caller has already established is a failure. */
  outcome: string
  /** Instance name, so the model can name it back if it needs to. */
  instanceName?: string
  /** The stage Jenkins reported as failed, when the job is a Pipeline. */
  failedStage?: string
  /** What triggered the build, when Jenkins reported it. */
  cause?: string
  /** Commits the build carried, newest first. */
  changes?: readonly JenkinsChange[]
  /** The console log, already sliced to the tail by the caller. */
  log: string
  /** Size of the whole log in bytes, when Jenkins stated it. */
  totalBytes?: number
  /** Whether {@link log} is only the tail of a longer log. */
  truncated: boolean
}

/** How many commits the prompt names before it stops listing them. */
const COMMITS_IN_PROMPT = 5

/** How many characters of one commit message the prompt keeps. */
const COMMIT_MESSAGE_CHARS = 120

/**
 * The key one build's analysis is reserved under.
 *
 * Used to refuse a second hand-off of the same build while the first is still
 * being prepared, so a double click cannot buy two model turns.
 * @param sessionId - the session the answer will appear in.
 * @param jobPath - job path.
 * @param buildNumber - build number.
 * @returns the reservation key.
 */
export function analysisKey(sessionId: string, jobPath: string, buildNumber: number): string {
  return `${sessionId}/${jobPath}#${buildNumber}`
}

/**
 * The two reads one hand-off needs.
 *
 * Narrowed to exactly what is used, so the hand-off can be driven by a fake in a
 * test without standing up a controller.
 */
export interface AnalyzeReads {
  /**
   * One build's detail — outcome, stages, commits.
   * @param jobPath - folder path of the job.
   * @param selector - build number.
   * @param options - byte bound.
   * @returns the detail.
   */
  buildDetail(
    jobPath: string,
    selector: string,
    options: { maxBytes: number },
  ): Promise<JenkinsBuildDetail>
  /**
   * A page of the build's console log.
   * @param jobPath - folder path of the job.
   * @param selector - build number.
   * @param offset - byte offset; zero means "the tail", which is what a failure
   *   analysis wants.
   * @param maxBytes - byte cap on the returned page.
   * @returns the page.
   */
  consoleLog(jobPath: string, selector: string, offset: number, maxBytes: number): Promise<JenkinsLogPage>
}

/** What a completed hand-off reports back to whoever clicked. */
export interface HandOff {
  /** The build that was handed over. */
  buildNumber: number
  /** Its outcome, as Jenkins reported it. */
  outcome: string
  /** Bytes of log actually handed to the model. */
  logBytes: number
  /** Size of the whole log, when Jenkins stated it. */
  totalBytes?: number
  /** Whether only the tail was handed over. */
  truncated: boolean
  /** Characters of prompt queued in the session. */
  promptChars: number
}

/**
 * Read a failed build and queue one prompt about it.
 *
 * The log is read as the **tail**: the failing lines are at the end, and the
 * request is bounded so a hundred-megabyte log cannot turn into a hundred
 * megabytes of context. Everything else rides along from the same read the panel
 * already makes, so one click costs two Jenkins requests and one model turn.
 * @param input.client - the Jenkins reads.
 * @param input.jobPath - job path.
 * @param input.buildNumber - the failed build.
 * @param input.logBytes - byte cap on the log handed over.
 * @param input.followup - queues the prompt in the calling session.
 * @param input.instanceName - instance name, for the prompt's context.
 * @returns what was handed over.
 */
export async function handOverFailure(input: {
  client: AnalyzeReads
  jobPath: string
  buildNumber: number
  logBytes: number
  followup: (prompt: string) => void
  instanceName?: string
}): Promise<HandOff> {
  const detail = await input.client.buildDetail(input.jobPath, String(input.buildNumber), {
    // The detail read is capped independently of the log: a job with thousands of
    // commits must not turn a diagnosis into a history dump.
    maxBytes: Math.max(input.logBytes, 65_536),
  })
  const page = await input.client.consoleLog(input.jobPath, String(input.buildNumber), 0, input.logBytes)
  const failedStage = detail.stages.find(stage => stage.status === 'FAILED')?.name
  const prompt = failurePrompt({
    jobPath: input.jobPath,
    buildNumber: detail.number,
    outcome: detail.outcome,
    ...input.instanceName === undefined ? {} : { instanceName: input.instanceName },
    ...failedStage === undefined ? {} : { failedStage },
    ...detail.cause === undefined ? {} : { cause: detail.cause },
    ...detail.changes.length === 0 ? {} : { changes: detail.changes },
    log: page.text,
    ...page.totalSize === undefined ? {} : { totalBytes: page.totalSize },
    truncated: page.truncated,
  })
  input.followup(prompt)
  return {
    buildNumber: detail.number,
    outcome: detail.outcome,
    logBytes: Buffer.byteLength(page.text, 'utf8'),
    ...page.totalSize === undefined ? {} : { totalBytes: page.totalSize },
    truncated: page.truncated,
    promptChars: prompt.length,
  }
}

/**
 * Build the prompt that asks the model to diagnose one failed build.
 *
 * The instruction is deliberately strict about the shape of the answer: a cause
 * with the log line that shows it, then one to three concrete fixes. Without that
 * the model tends to restate the log or hand back generic advice, which is the
 * one thing a person who has already read the log does not need.
 * @param context - the build, its commits, and the log tail.
 * @returns the message text to hand to a model turn.
 */
export function failurePrompt(context: FailureContext): string {
  const commits = (context.changes ?? []).slice(0, COMMITS_IN_PROMPT)
  const lines: string[] = [
    'Jenkins 构建失败。请分析失败原因，并给出最简洁的修复指引。',
    '',
    `任务：${context.jobPath} 构建 #${context.buildNumber}`,
    `结果：${context.outcome}`,
  ]
  if (context.instanceName !== undefined && context.instanceName.length > 0) {
    lines.push(`实例：${context.instanceName}`)
  }
  lines.push(`失败阶段：${context.failedStage ?? '未报告（该 job 不是 Pipeline，或 Jenkins 没给出阶段）'}`)
  if (context.cause !== undefined && context.cause.length > 0) {
    lines.push(`触发原因：${context.cause}`)
  }
  if (commits.length > 0) {
    lines.push('本次构建的提交：')
    for (const change of commits) {
      const first = change.message.split('\n')[0]?.trim() ?? ''
      const message = first.length > COMMIT_MESSAGE_CHARS ? `${first.slice(0, COMMIT_MESSAGE_CHARS)}…` : first
      lines.push(`- ${change.commitId.slice(0, 7)} ${message}${change.author.length === 0 ? '' : ` (${change.author})`}`)
    }
  }

  const size = context.totalBytes === undefined ? '未知' : `${context.totalBytes} 字节`
  lines.push(
    '',
    `下面是构建日志的尾部${context.truncated ? `（日志共 ${size}，只给了最后一段）` : ''}：`,
    '```',
    context.log.trimEnd(),
    '```',
    '',
    '请按这个顺序回答，不要复述日志：',
    '1. 最可能的失败原因（一句话），并指出日志里支撑它的关键行。',
    '2. 最简洁的修复指引（1-3 条，具体到改哪里/做什么）。',
    '3. 如果这段日志不足以判断，直接说要哪一段，或用 jenkins_log（可加 tail_lines，最多 2000 行）拉取更多；',
    '   需要时还有 jenkins_build_status 和 jenkins_workspace 可用。',
    '不要给与日志无关的通用建议，不要猜测日志里没有依据的东西。',
  )
  return lines.join('\n')
}
