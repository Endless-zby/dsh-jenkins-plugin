/**
 * Assertions for reading a Maven project's version off a build.
 *
 * The card shows this next to the job, so it has to be right — and, more
 * importantly, it has to be *absent* rather than wrong: most jobs on a real
 * controller are not Maven, and a version read is decoration that must never be
 * able to affect the build it decorates. Both halves are asserted here against a
 * controller built inside this process, so the shapes are the ones Jenkins
 * actually sends (measured on 2.176.2: `moduleRecords[].mainArtifact.version`,
 * and a 404 for a non-Maven job).
 *
 * Run with `node tests/maven-version.ts` after `tsc`.
 * @module dsh-jenkins-plugin/tests/maven-version
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Config } from '../lib/config.js'
import { JenkinsClient } from '../lib/jenkins/client.js'

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
 * Start a controller whose only job is to answer `mavenArtifacts`.
 * @param status - the status to answer with; 200 sends `payload`.
 * @param payload - the body for a 200.
 * @returns its base URL and a stop function.
 */
async function startController(status: number, payload: unknown = {}): Promise<{ baseUrl: string, stop: () => void }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/crumbIssuer/api/json') {
      res.statusCode = 404
      res.end()
      return
    }
    const body = JSON.stringify(payload)
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('content-length', String(Buffer.byteLength(body)))
    res.end(body)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { baseUrl: `http://127.0.0.1:${port}/`, stop: () => { server.close() } }
}

/**
 * A client pointed at one controller.
 * @param baseUrl - the controller's root URL.
 * @returns the client.
 */
function clientFor(baseUrl: string): JenkinsClient {
  const config = Config({ settingsFile: 'unused.json', baseUrl, username: 'tester', timeoutMs: 5_000 })
  return new JenkinsClient(config, async () => 'token')
}

/**
 * Run one case and stop its controller.
 * @param label - what is being checked.
 * @param status - the status the controller answers with.
 * @param payload - the body for a 200.
 * @param expected - the version expected.
 */
async function readVersion(label: string, status: number, payload: unknown, expected: unknown): Promise<void> {
  const controller = await startController(status, payload)
  try {
    check(label, await clientFor(controller.baseUrl).mavenVersion('demo', 5), expected)
  } finally {
    controller.stop()
  }
}

const mainArtifact = (version: string): unknown => ({ moduleRecords: [{ mainArtifact: { groupId: 'com.example', artifactId: 'demo', version } }] })

console.log('1) the version Jenkins reports')
await readVersion('one module', 200, mainArtifact('1.4.2'), '1.4.2')
await readVersion('a snapshot version', 200, mainArtifact('2.0.10-SNAPSHOT'), '2.0.10-SNAPSHOT')

console.log('\n2) the fallbacks, and the shapes that say "no version"')
await readVersion(
  'a module that only produced a pom',
  200,
  { moduleRecords: [{ pomArtifact: { artifactId: 'demo', version: '3.1.0' } }] },
  '3.1.0',
)
await readVersion(
  'several modules: the first version wins',
  200,
  { moduleRecords: [{ mainArtifact: { version: '1.0.0' } }, { mainArtifact: { version: '1.0.1' } }] },
  '1.0.0',
)
await readVersion(
  'a record with no artifacts at all',
  200,
  { moduleRecords: [{ mainArtifact: { artifactId: 'demo' } }] },
  undefined,
)
await readVersion('no module records', 200, {}, undefined)
await readVersion('an empty module list', 200, { moduleRecords: [] }, undefined)

console.log('\n3) a job that is not Maven, and a controller that misbehaves')
// This is the common case on a real controller, and it must be a quiet `undefined`
// rather than something that could disturb the build's tracking.
await readVersion('404 from a Freestyle job', 404, {}, undefined)
await readVersion('a 500', 500, {}, undefined)
await readVersion('a body that is not what was expected', 200, { moduleRecords: 'nope' }, undefined)

{
  // Nothing listening: a version read must swallow even a connection failure,
  // because one layer up a thrown error would end the build's tracking.
  const unreachable = clientFor('http://127.0.0.1:1/')
  check('an unreachable controller', await unreachable.mavenVersion('demo', 5), undefined)
}

const failed = results.filter(pass => !pass).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exitCode = 1
