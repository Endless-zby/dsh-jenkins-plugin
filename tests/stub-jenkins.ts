/**
 * Zero-dependency stub Jenkins controller for end-to-end verification.
 *
 * It answers exactly the REST surface the plugin's client touches —
 * `crumbIssuer/api/json`, folder/job `api/json?tree=jobs[...]`,
 * `/<job>/api/json?tree=builds[...]`, `/<job>/<n>/api/json`,
 * `/<job>/<n>/wfapi/describe`, and the write side
 * (`POST /<job>/build`, `POST /<job>/buildWithParameters`, `POST /<job>/<n>/stop`,
 * `GET /queue/item/<id>/api/json`) — with a two-level folder tree so the client's
 * recursive listing is exercised rather than assumed. Every request is logged
 * to stdout with its authorization outcome, which is what makes the run
 * evidence of the plugin really reaching Jenkins instead of rendering an
 * empty local state.
 *
 * A trigger mutates the tree, so the stub is stateful: it hands out a queue item
 * that resolves to a build number after {@link QUEUE_DELAY_MS}, which is what
 * lets the `queued → running` path be observed at all.
 *
 * Run directly (`node tests/stub-jenkins.ts`); `PORT` and `REQUIRE_AUTH`
 * (set to `0` to accept any credential) configure it.
 * @module dsh-jenkins-plugin/tests/stub-jenkins
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** One stubbed job: its class decides folder recursion, its color the status. */
interface StubJob {
  name: string
  color: string
  className: string
  buildCount: number
  building: boolean
  result: string
  stages: ReadonlyArray<{ name: string; status: string; durationMillis: number }>
  /** Epoch ms the running build started, so its elapsed time is real. */
  startedAt?: number
  /**
   * Whether this job was triggered through the stub's own write endpoint.
   *
   * A triggered build needs a stage list that matches "still running", which the
   * static list below does not: the static list describes a build that has
   * finished, and reporting it for a live build would draw a full progress bar
   * for a build that is barely started.
   */
  triggered?: boolean
  /** Project version this job's builds report, for a Maven job. */
  mavenVersion?: string
  /**
   * The parameters the newest build ran with.
   *
   * Set by a trigger from whatever it was sent, exactly as Jenkins records them
   * on the build — which is what makes "rebuild reuses the last parameters"
   * something a test can actually observe rather than assume.
   */
  parameters?: Record<string, string>
  /**
   * Results of individual builds, by number.
   *
   * Jenkins records a result per build; without this the stub's shared `result`
   * made history move retroactively — aborting the newest build rewrote what the
   * older ones reported, which is both wrong and confusing to debug.
   */
  results?: Record<number, string>
}

/** One queue item, so a triggered build can be followed before it has a number. */
interface StubQueueItem {
  id: number
  jobPath: string
  buildNumber: number
  /** Epoch ms the item stops waiting and gains an `executable`. */
  resolveAt: number
  /** Whether the item was cancelled while it still waited. */
  cancelled: boolean
}

/** A folder's children, matching the shape `collectJobs` walks. */
interface StubFolder {
  name: string
  className: string
  children: StubNode[]
}

type StubNode = StubJob | StubFolder

/** Whether a node is a folder rather than a buildable job. */
function isFolder(node: StubNode): node is StubFolder {
  return 'children' in node
}

/** The controller tree: one nested folder, one flat folder, one root job. */
const TREE: StubFolder = {
  name: '',
  className: 'hudson.model.Hudson',
  children: [
    {
      name: 'team',
      className: 'com.cloudbees.hudson.plugins.folder.Folder',
      children: [
        {
          name: 'service',
          className: 'com.cloudbees.hudson.plugins.folder.Folder',
          children: [
            {
              name: 'api-build',
              color: 'blue_anime',
              className: 'org.jenkinsci.plugins.workflow.job.WorkflowJob',
              buildCount: 42,
              building: true,
              result: 'SUCCESS',
              stages: [
                { name: 'Checkout', status: 'SUCCESS', durationMillis: 4200 },
                { name: 'Build', status: 'SUCCESS', durationMillis: 21_500 },
                { name: 'Test', status: 'IN_PROGRESS', durationMillis: 0 },
                { name: 'Deploy', status: 'PENDING', durationMillis: 0 },
              ],
            },
            {
              name: 'api-nightly',
              color: 'red',
              className: 'org.jenkinsci.plugins.workflow.job.WorkflowJob',
              buildCount: 7,
              building: false,
              result: 'FAILURE',
              stages: [
                { name: 'Checkout', status: 'SUCCESS', durationMillis: 3900 },
                { name: 'Build', status: 'FAILED', durationMillis: 12_100 },
              ],
            },
          ],
        },
      ],
    },
    {
      name: 'infra',
      className: 'com.cloudbees.hudson.plugins.folder.Folder',
      children: [
        {
          name: 'deploy-prod',
          color: 'notbuilt',
          className: 'org.jenkinsci.plugins.workflow.job.WorkflowJob',
          buildCount: 0,
          building: false,
          result: 'NOT_BUILT',
          stages: [],
        },
      ],
    },
    {
      name: 'smoke',
      color: 'yellow',
      className: 'org.jenkinsci.plugins.workflow.job.WorkflowJob',
      buildCount: 3,
      building: false,
      result: 'UNSTABLE',
      stages: [
        { name: 'Run', status: 'UNSTABLE', durationMillis: 8000 },
      ],
    },
    {
      // A Maven job that failed, which is what makes a card offer to rebuild it
      // — and the only job here that reports a project version.
      name: 'maven-web',
      color: 'red',
      className: 'hudson.maven.MavenModuleSet',
      buildCount: 5,
      building: false,
      result: 'FAILURE',
      stages: [
        { name: 'Checkout', status: 'SUCCESS', durationMillis: 3200 },
        { name: 'Package', status: 'FAILED', durationMillis: 18_400 },
      ],
      mavenVersion: '1.4.2',
      // A parameterized job, so a rebuild has something real to carry over.
      parameters: { BRANCH: 'main', DEPLOY: 'true' },
    },
  ],
}

/**
 * The port the stub listens on.
 *
 * The default avoids 8003-8102 and 7898-7997, which Windows reserves on this
 * machine (`netsh int ipv4 show excludedportrange protocol=tcp`); binding
 * inside a reserved range fails with `EACCES` regardless of privileges.
 */
const port = Number.parseInt(process.env.PORT ?? '18090', 10)

/** Whether the stub enforces the `username:token` Basic credential. */
const requireAuth = (process.env.REQUIRE_AUTH ?? '1') !== '0'

/** Credential the stub accepts when {@link requireAuth} is on. */
const expected = `Basic ${Buffer.from('stub-user:stub-token', 'utf8').toString('base64')}`

/**
 * Resolve a request path against the tree, consuming as many `job/<name>`
 * pairs as the tree actually contains.
 *
 * Jenkins mixes the job path with a trailing build selector
 * (`/job/a/job/b/42/wfapi/describe`), and the selector breaks the `job/<name>`
 * alternation, so the split cannot be decided by syntax alone: a name belongs
 * to the job path only when the tree has a child by that name. This walks
 * greedily and returns what is left over. A path that does not start with the
 * `job` keyword is left entirely to the caller as an unmatched remainder.
 * @param segments - decoded, non-empty path segments.
 * @returns the deepest matched node, its job path, the unmatched remainder,
 *   and the first `job/<name>` whose child the tree does not have.
 */
function resolve(segments: readonly string[]): {
  node: StubNode
  jobPath: string
  rest: string[]
  missing: string | undefined
} {
  let node: StubNode = TREE
  const names: string[] = []
  let index = 0
  let missing: string | undefined
  while (segments[index] === 'job' && isFolder(node)) {
    const name = segments[index + 1]
    if (name === undefined) break
    const next = node.children.find(child => child.name === name)
    // A selector such as a build number is not a child, so the walk stops and
    // the remainder is the caller's to interpret.
    if (next === undefined) {
      missing = name
      break
    }
    node = next
    names.push(name)
    index += 2
  }
  return { node, jobPath: names.join('/'), rest: segments.slice(index), missing }
}

/**
 * Find a buildable job by its `folder/sub/job` path.
 * @param jobPath - the path to walk.
 * @returns the job, or undefined when the path names no job.
 */
function findJob(jobPath: string): StubJob | undefined {
  let node: StubNode = TREE
  for (const name of jobPath.split('/').filter(segment => segment.length > 0)) {
    if (!isFolder(node)) return undefined
    const next = node.children.find(child => child.name === name)
    if (next === undefined) return undefined
    node = next
  }
  return isFolder(node) ? undefined : node
}

/** Absolute URL of a job or folder path as this stub publishes it. */
function jobUrl(jobPath: string): string {
  return `${base()}${jobPath
    .split('/')
    .filter(segment => segment.length > 0)
    .map(segment => `/job/${encodeURIComponent(segment)}`)
    .join('')}/`
}

/** Site-relative URL of a job or folder path, for the browsable pages. */
function jobHref(jobPath: string): string {
  return jobPath
    .split('/')
    .filter(segment => segment.length > 0)
    .map(segment => `/job/${encodeURIComponent(segment)}`)
    .join('') + '/'
}

/** Root URL of the stub as advertised in payloads. */
function base(): string {
  return `http://127.0.0.1:${port}`
}

/** Render one folder's `jobs[...]` list. */
function folderPayload(folder: StubFolder, jobPath: string): unknown {
  return {
    _class: folder.className,
    jobs: folder.children.map((child) => {
      const childPath = jobPath.length === 0 ? child.name : `${jobPath}/${child.name}`
      return {
        name: child.name,
        url: jobUrl(childPath),
        color: isFolder(child) ? undefined : child.color,
        _class: child.className,
        // Real Jenkins answers the `lastBuild[...]` field of the tree query; a
        // job that never ran has none, which the panel renders as "not built yet".
        lastBuild: isFolder(child) || child.buildCount === 0
          ? undefined
          : buildRow(child, child.buildCount, childPath),
      }
    }),
  }
}

/**
 * How long the stub's running build has been going.
 *
 * A running build's timestamp has to be relative to the moment it is asked for,
 * or the elapsed time a progress bar derives from it is the age of a hard-coded
 * date rather than the length of a build — which reads as a broken panel rather
 * than as a stub.
 */
const RUNNING_AGE_MS = 95_000

/**
 * How long a triggered build waits in the queue before it is assigned a number.
 *
 * Real Jenkins waits for an executor, which can be seconds or minutes; the stub
 * needs the wait to be long enough that a first read really does see a waiting
 * item — otherwise the `queued → running` path would never be exercised.
 */
const QUEUE_DELAY_MS = 2_500

/** Queue items handed out by triggers, newest last. */
const queue: StubQueueItem[] = []

/** The next queue id, matching Jenkins' habit of never reusing one. */
let nextQueueId = 1

/** Synthesize one build row; the newest build is the running one. */
function buildRow(job: StubJob, number: number, jobPath: string): unknown {
  const newest = number === job.buildCount
  const running = newest && job.building
  const parameters = job.parameters ?? {}
  // A recorded result wins; the job's own `result` describes only its newest
  // build, so it is the fallback for builds this stub never touched.
  const result = running ? null : job.results?.[number] ?? job.result
  return {
    number,
    result,
    building: running,
    timestamp: running ? job.startedAt ?? Date.now() - RUNNING_AGE_MS : 1_700_000_000_000 + number * 60_000,
    duration: running ? 0 : 30_000 + number * 100,
    url: `${jobUrl(jobPath)}${number}/`,
    // Jenkins records a parameterized build's parameters as an action, which is
    // where the panel reads them from to rebuild with the same ones.
    ...newest && Object.keys(parameters).length > 0
      ? {
          actions: [
            {
              _class: 'hudson.model.ParametersAction',
              parameters: Object.entries(parameters).map(([name, value]) => ({ name, value })),
            },
          ],
        }
      : {},
    // Older builds carry fewer commits, so a history page shows a difference and
    // a card has something real to name.
    changeSet: {
      items: [
        {
          commitId: `a1b2c3d${number}`,
          msg: `fix: correct rounding in order total (#${number * 7})`,
          author: { fullName: 'Stub Committer' },
          timestamp: 1_700_000_000_000 + number * 60_000,
        },
        {
          commitId: `e4f5a6b${number}`,
          msg: 'chore: bump dependencies',
          author: { fullName: 'Stub Committer' },
          timestamp: 1_700_000_000_000 + number * 60_000 - 600_000,
        },
        {
          commitId: `c7d8e9f${number}`,
          msg: 'test: cover the empty basket case',
          author: { fullName: 'Stub Committer' },
          timestamp: 1_700_000_000_000 + number * 60_000 - 1_200_000,
        },
      ].slice(0, number === 1 ? 1 : 3),
    },
  }
}

/** Render a job's `builds[...]` history, newest first. */
function buildsPayload(job: StubJob, jobPath: string, limit: number): unknown {
  const numbers: number[] = []
  for (let number = job.buildCount; number > Math.max(0, job.buildCount - limit); number -= 1) numbers.push(number)
  return { _class: job.className, builds: numbers.map(number => buildRow(job, number, jobPath)) }
}

/**
 * The stage list of a build that is still running.
 *
 * Everything but the last stage has passed and the last one is in progress,
 * which is the shape a Pipeline reports mid-run and the shape a progress bar and
 * an "active stage" line are both drawn from.
 * @param stages - the job's stage definitions.
 * @returns the stages as a running build would report them.
 */
function runningStages(stages: StubJob['stages']): StubJob['stages'] {
  const last = stages.length - 1
  return stages.map((stage, index) => index === last
    ? { ...stage, status: 'IN_PROGRESS', durationMillis: 0 }
    : { ...stage, status: 'SUCCESS', durationMillis: stage.durationMillis > 0 ? stage.durationMillis : 4_000 })
}

/** Render the Blue Ocean `wfapi/describe` stage list. */
function stagesPayload(job: StubJob): unknown {
  // A build this stub triggered is mid-run, so it reports stages that are: the
  // static list describes a finished build and would show a full bar.
  const stages = job.triggered === true && job.building ? runningStages(job.stages) : job.stages
  return {
    name: job.name,
    status: job.result,
    stages: stages.map(stage => ({
      name: stage.name,
      status: stage.status,
      startTimeMillis: job.building ? job.startedAt ?? Date.now() - RUNNING_AGE_MS : 1_700_000_000_000,
      durationMillis: stage.durationMillis,
    })),
  }
}

/**
 * Synthesize a build's console log.
 *
 * Long enough to be worth reading and to exercise tailing, and its last line
 * names the build so a caller can tell a tail from a head at a glance.
 * @param job - the job the build belongs to.
 * @param jobPath - its path.
 * @param number - the build number.
 * @returns the log text.
 */
function consoleText(job: StubJob, jobPath: string, number: number): string {
  const lines = [
    `Started by user stub at ${new Date(job.startedAt ?? Date.now() - RUNNING_AGE_MS).toISOString()}`,
    `Building in workspace /var/jenkins/workspace/${jobPath}`,
  ]
  for (const stage of job.stages) {
    lines.push(`[${job.name}] stage ${stage.name}: ${stage.status}`)
  }
  for (let index = 1; index <= 30; index += 1) {
    lines.push(`[${job.name}] step ${String(index).padStart(2, '0')} of 30 done`)
  }
  lines.push(`Finished: ${job.building === true && number === job.buildCount ? 'still running' : job.result}`)
  lines.push(`stub log for ${jobPath} #${number}`)
  return `${lines.join('\n')}\n`
}

/** Write one HTML response. */
function html(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

/** Escape text for safe interpolation into the stub's HTML pages. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Wrap page content in the stub's minimal Jenkins-like chrome. */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)} — stub Jenkins</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#1f2328}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:24px 0 8px}
.note{color:#59636e;margin:0 0 16px}ul{margin:0;padding-left:20px}li{margin:2px 0}
a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}
code{background:#f0f1f3;padding:1px 5px;border-radius:4px}</style></head>
<body>${body}</body></html>
`
}

/** Render the controller root as a browsable tree of folders and jobs. */
function rootPage(node: StubFolder): string {
  const items = node.children.map((child) => {
    const suffix = isFolder(child) ? ' (folder)' : ` — ${child.color}`
    return `<li><a href="${jobHref(child.name)}">${escapeHtml(child.name)}</a>${escapeHtml(suffix)}</li>`
  }).join('')
  return page('Jobs', `<h1>stub Jenkins</h1>
<p class="note">A test double for the plugin's REST client; it serves no build UI.</p>
<h2>Jobs</h2><ul>${items}</ul>`)
}

/** Render a folder's children. */
function folderPage(folder: StubFolder, jobPath: string): string {
  const items = folder.children.map((child) => {
    const childPath = `${jobPath}/${child.name}`
    return `<li><a href="${jobHref(childPath)}">${escapeHtml(child.name)}</a></li>`
  }).join('')
  return page(jobPath, `<h1>${escapeHtml(jobPath)}</h1><p class="note">folder</p>
<h2>Children</h2><ul>${items}</ul>`)
}

/** Render a job's page with links to its recent builds. */
function jobPage(job: StubJob, jobPath: string): string {
  const builds = buildsPayload(job, jobPath, 10) as { builds: Array<{ number: number, result: string | null, building: boolean, url: string }> }
  const items = builds.builds.map(build =>
    `<li><a href="${build.url}">#${build.number}</a> — ${escapeHtml(build.building ? 'building' : build.result ?? 'unknown')}</li>`,
  ).join('')
  return page(job.name, `<h1>${escapeHtml(jobPath)}</h1>
<p class="note">stub job — status <code>${escapeHtml(job.color)}</code>, ${job.buildCount} builds</p>
<h2>Builds</h2><ul>${items}</ul>`)
}

/** Render one build's page with its Pipeline stages. */
function buildPage(job: StubJob, jobPath: string, number: number): string {
  const stages = job.stages.map(stage =>
    `<li>${escapeHtml(stage.name)} — ${escapeHtml(stage.status)} (${stage.durationMillis}ms)</li>`,
  ).join('')
  return page(`${job.name} #${number}`, `<h1>${escapeHtml(jobPath)} #${number}</h1>
<p class="note">stub build — result <code>${escapeHtml(job.result)}</code></p>
<h2>Stages</h2><ul>${stages === '' ? '<li>(no stages)</li>' : stages}</ul>`)
}

/** Log one request line so the run shows what Jenkins was actually asked. */
function log(method: string, url: string, outcome: string): void {
  const stamp = new Date().toISOString().slice(11, 23)
  console.log(`[stub] ${stamp} ${method} ${url} -> ${outcome}`)
}

/** Write one JSON response. */
function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', base())
  const path = decodeURIComponent(url.pathname)

  // The credential wall covers the REST surface only, which is what the
  // plugin's client is tested against. The browsable HTML pages below stay
  // open so that clicking a job link in the panel shows a real page instead of
  // the browser's credential dialog (a Basic challenge cannot explain itself).
  // A trigger carries no `/api/json` tail but is protected just the same, so
  // every POST is behind the wall too.
  const isApi = path.includes('/api/json')
  if (requireAuth && (isApi || req.method === 'POST') && req.headers.authorization !== expected) {
    log(req.method ?? 'GET', path, '401 (bad credential)')
    res.statusCode = 401
    res.setHeader('www-authenticate', 'Basic realm="stub"')
    res.end()
    return
  }

  if (path === '/crumbIssuer/api/json') {
    log(req.method ?? 'GET', path, '200 crumb')
    json(res, 200, { crumbRequestField: 'Jenkins-Crumb', crumb: 'stub-crumb-value' })
    return
  }

  // The identity probe the panel's "connect" action runs. Jenkins answers this
  // only to an authenticated caller, so it is what proves a URL/login/token
  // triple before any job listing.
  if (path === '/me/api/json') {
    log(req.method ?? 'GET', path, '200 identity')
    json(res, 200, { id: 'stub-user', fullName: 'Stub User' })
    return
  }

  // A queue item is what a trigger answers; a caller follows it until it carries
  // an `executable`, which is the only way to learn the build number.
  if (path.startsWith('/queue/item/')) {
    const id = Number.parseInt(path.split('/')[3] ?? '', 10)
    const item = queue.find(entry => entry.id === id)
    if (item === undefined) {
      log(req.method ?? 'GET', path, `404 (no queue item ${id})`)
      json(res, 404, { message: `no queue item ${id}` })
      return
    }
    const waiting = !item.cancelled && Date.now() < item.resolveAt
    log(req.method ?? 'GET', path, waiting ? '200 waiting in queue' : `200 assigned #${item.buildNumber}`)
    json(res, 200, {
      id: item.id,
      why: item.cancelled ? 'stub cancelled this item' : waiting ? 'Waiting for next available executor' : null,
      cancelled: item.cancelled,
      blocked: false,
      buildable: true,
      executable: waiting ? null : { number: item.buildNumber, url: `${jobUrl(item.jobPath)}${item.buildNumber}/` },
    })
    return
  }

  // Split the path into job path plus trailing selector; see `resolve`.
  const segments = path.split('/').filter(segment => segment.length > 0)
  const { node, jobPath, rest, missing } = resolve(segments)
  if (missing !== undefined) {
    log(req.method ?? 'GET', path, `404 (no such job: ${missing})`)
    json(res, 404, { message: `no such job: ${missing}` })
    return
  }
  const isApiJson = rest.length === 2 && rest[0] === 'api' && rest[1] === 'json'
  const isWfDescribe = rest.length === 3 && rest[1] === 'wfapi' && rest[2] === 'describe'
  const isBuildApiJson = rest.length === 3 && rest[1] === 'api' && rest[2] === 'json'
  // `/job/<path>/<n>/mavenArtifacts/api/json`, which is two segments longer than
  // the build's own `api/json` and so cannot collide with it.
  const isMavenArtifacts = rest.length === 4 && rest[1] === 'mavenArtifacts' && rest[2] === 'api' && rest[3] === 'json'
  const isConsoleText = rest.length === 2 && rest[1] === 'consoleText'
  const isTrigger = rest.length === 1 && (rest[0] === 'build' || rest[0] === 'buildWithParameters')
  const isStop = rest.length === 2 && rest[1] === 'stop' && Number.isFinite(Number.parseInt(rest[0] as string, 10))

  // A trigger answers a queue item rather than a build, exactly as Jenkins does:
  // the build number does not exist until an executor picks the item up.
  if (isTrigger && !isFolder(node)) {
    if (req.method !== 'POST') {
      log(req.method ?? 'GET', path, '405 (trigger needs POST)')
      res.statusCode = 405
      res.setHeader('allow', 'POST')
      res.end()
      return
    }
    let body = ''
    for await (const chunk of req) body += String(chunk)
    node.buildCount += 1
    node.building = true
    node.triggered = true
    node.result = 'SUCCESS'
    node.startedAt = Date.now()
    // Whatever the trigger carried becomes this build's parameters, so the next
    // caller (a rebuild) reads back exactly what was sent.
    node.parameters = Object.fromEntries(new URLSearchParams(body))
    // Recorded per build: this build will report SUCCESS once it stops, and the
    // history it joins keeps whatever each of those builds actually reported.
    node.results = { ...node.results, [node.buildCount]: 'SUCCESS' }
    const item: StubQueueItem = {
      id: nextQueueId,
      jobPath,
      buildNumber: node.buildCount,
      resolveAt: Date.now() + QUEUE_DELAY_MS,
      cancelled: false,
    }
    nextQueueId += 1
    queue.push(item)
    log(req.method, path, `201 queued #${node.buildCount} as item ${item.id}${body.length === 0 ? '' : ` (${body.length}b of parameters)`}`)
    res.statusCode = 201
    res.setHeader('location', `${base()}/queue/item/${item.id}/`)
    res.end()
    return
  }

  if (isStop && !isFolder(node)) {
    if (req.method !== 'POST') {
      log(req.method ?? 'GET', path, '405 (stop needs POST)')
      res.statusCode = 405
      res.setHeader('allow', 'POST')
      res.end()
      return
    }
    const number = Number.parseInt(rest[0] as string, 10)
    if (number !== node.buildCount || !node.building) {
      // Jenkins answers 404 for a build that is already over, which the client
      // reports as "nothing to abort" rather than as a failure.
      log(req.method, path, `404 (build #${number} is not running)`)
      json(res, 404, { message: `build #${number} is not running` })
      return
    }
    node.building = false
    node.result = 'ABORTED'
    // Recorded against this build only: the builds before it keep their own
    // results, as they do on a real controller.
    node.results = { ...node.results, [number]: 'ABORTED' }
    log(req.method, path, `200 aborted #${number}`)
    json(res, 200, {})
    return
  }

  if (isApiJson) {
    if (isFolder(node)) {
      log(req.method ?? 'GET', path, `200 folder (${node.children.length} children)`)
      json(res, 200, folderPayload(node, jobPath))
      return
    }
    const limit = Number.parseInt(url.searchParams.get('tree')?.match(/\{0,(\d+)\}/)?.[1] ?? '10', 10)
    log(req.method ?? 'GET', path, `200 job builds (limit ${limit})`)
    json(res, 200, buildsPayload(node, jobPath, limit))
    return
  }

  if (isBuildApiJson) {
    const selector = rest[0] as string
    const number = selector === 'last' ? node.buildCount : Number.parseInt(selector, 10)
    // A build that does not exist is a 404, as it is on Jenkins. Answering for
    // any number at all would let a caller follow a build that was never there —
    // and would hide exactly the case worth catching, a build number from a
    // controller that has since been restarted.
    if (isFolder(node) || !Number.isFinite(number) || number < 1 || number > node.buildCount) {
      log(req.method ?? 'GET', path, `404 (no build #${number})`)
      json(res, 404, { message: `no build #${number}` })
      return
    }
    log(req.method ?? 'GET', path, `200 build #${number}`)
    json(res, 200, buildRow(node, number, jobPath))
    return
  }

  if (isWfDescribe && !isFolder(node)) {
    const selector = Number.parseInt(rest[0] as string, 10)
    if (!Number.isFinite(selector) || selector < 1 || selector > node.buildCount) {
      log(req.method ?? 'GET', path, `404 (no stages for #${selector})`)
      json(res, 404, { message: `no build #${selector}` })
      return
    }
    log(req.method ?? 'GET', path, `200 stages (${node.stages.length})`)
    json(res, 200, stagesPayload(node))
    return
  }

  if (isMavenArtifacts) {
    const selector = Number.parseInt(rest[0] as string, 10)
    // 404 for a job that is not a Maven project, which is what the real endpoint
    // does and what the plugin relies on to decide there is no version to show.
    if (isFolder(node) || node.mavenVersion === undefined || !Number.isFinite(selector) || selector < 1 || selector > node.buildCount) {
      log(req.method ?? 'GET', path, '404 (not a Maven build)')
      json(res, 404, { message: 'not a Maven build' })
      return
    }
    const version = node.mavenVersion
    log(req.method ?? 'GET', path, `200 maven artifacts (version ${version})`)
    json(res, 200, {
      _class: 'hudson.maven.reporters.MavenArtifactRecord',
      moduleRecords: [
        {
          mainArtifact: {
            _class: 'hudson.maven.reporters.MavenArtifact',
            groupId: 'com.example',
            artifactId: node.name,
            version,
            fileName: `${node.name}-${version}.jar`,
          },
          pomArtifact: { artifactId: node.name, version },
        },
      ],
    })
    return
  }

  if (isConsoleText && !isFolder(node)) {
    const selector = rest[0] as string
    const number = Number.parseInt(selector, 10)
    if (!Number.isFinite(number) || number < 1 || number > node.buildCount) {
      log(req.method ?? 'GET', path, `404 (no log for #${selector})`)
      json(res, 404, { message: `no build #${selector}` })
      return
    }
    // Deliberately unhelpful in the same way the measured controller is:
    // `?start=` is ignored and no `x-text-size` is sent, so the client has to do
    // the windowing itself. The stub would otherwise hide that requirement.
    const body = consoleText(node, jobPath, number)
    log(req.method ?? 'GET', path, `200 console log (${body.length}B, start ignored)`)
    res.statusCode = 200
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.setHeader('content-length', Buffer.byteLength(body))
    res.end(body)
    return
  }

  // Browsable HTML pages, reached by the panel's "open in Jenkins" links.
  // Matching is shape-driven and ordered most-specific first, because the
  // greedy job-path walk leaves different leftovers for the same node:
  //   /job/a/job/b/            -> node=b (folder), rest=[]
  //   /job/a/job/b             -> node=b (folder), rest=["b"]
  //   /job/a/job/b/job/c/      -> node=c (job),    rest=[]
  //   /job/a/job/b/job/c       -> node=c (job),    rest=["c"]
  //   /job/a/job/b/job/c/42/   -> node=c (job),    rest=["42"]
  // A numeric leftover is therefore always a build, and only a folder may be
  // addressed with a trailing separator.
  const selector = rest.length > 0 ? Number.parseInt(rest[rest.length - 1] as string, 10) : Number.NaN

  if (rest.length === 3 && rest[1] === 'wfapi' && rest[2] === 'describe' && !isFolder(node)) {
    log(req.method ?? 'GET', path, '200 html build page')
    html(res, 200, buildPage(node, jobPath, Number.parseInt(rest[0] as string, 10)))
    return
  }
  if (!isFolder(node) && Number.isFinite(selector)) {
    log(req.method ?? 'GET', path, '200 html build page')
    html(res, 200, buildPage(node, jobPath, selector))
    return
  }
  if (isFolder(node) && (rest.length === 0 || (rest.length === 1 && rest[0] === node.name))) {
    log(req.method ?? 'GET', path, '200 html folder page')
    html(res, 200, jobPath.length === 0 ? rootPage(node) : folderPage(node, jobPath))
    return
  }
  if (!isFolder(node) && (rest.length === 0 || (rest.length === 1 && rest[0] === node.name))) {
    log(req.method ?? 'GET', path, '200 html job page')
    html(res, 200, jobPage(node, jobPath))
    return
  }

  log(req.method ?? 'GET', path, '404 (unrouted)')
  json(res, 404, { message: `stub has no route for ${path}` })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[stub] stub Jenkins listening on ${base()} (requireAuth=${requireAuth})`)
  console.log(`[stub] jobs: team/service/api-build, team/service/api-nightly, infra/deploy-prod, smoke, maven-web (Maven)`)
  console.log(`[stub] writes: POST /job/<path>/build|buildWithParameters, POST /job/<path>/<n>/stop, GET /queue/item/<id>/api/json`)
  console.log(`[stub] reads: /<job>/<n>/{api,wfapi/describe,consoleText,mavenArtifacts/api}/json`)
})
