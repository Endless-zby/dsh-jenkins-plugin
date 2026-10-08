/**
 * Assertions for reading a console log off a controller that will not cooperate.
 *
 * The endpoint's documentation and its behaviour differ, and the difference cost
 * a real bug: the log reader once returned the **head** of a long log and called
 * it the tail, because it trusted `?start=` and a `content-length` that describes
 * only one response. This test drives the client against a controller built to
 * behave the way Jenkins 2.176.2 behind nginx measurably does — `?start=` ignored,
 * no `X-Text-Size`, no `X-More-Data` — so those two mistakes cannot come back
 * unnoticed.
 *
 * The controller is created inside this process on an ephemeral port, so the test
 * needs no fixtures, no other server, and no network.
 *
 * Run with `node tests/console-log.ts` after `tsc`.
 * @module dsh-jenkins-plugin/tests/console-log
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Config } from '../lib/config.js'
import { JenkinsClient, JenkinsError } from '../lib/jenkins/client.js'

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

/** How the fake controller should answer the next `consoleText` request. */
interface Behaviour {
  /** The whole log it holds. */
  log: string
  /** Whether it ignores `?start=`, as the measured controller does. */
  ignoreStart: boolean
  /** Whether it sends `x-text-size` at all. */
  sendTextSize: boolean
  /** Bytes of the log to actually write, to model a truncated response. */
  bodyBytes?: number
}

/** What the fake controller was asked for, which is itself worth asserting. */
interface Observed {
  /** The `start` values it received. */
  starts: number[]
}

/**
 * Build one line of a log, padded so byte arithmetic is easy to reason about.
 * @param number - line number, used as the payload.
 * @param width - characters per line.
 * @returns the line, ending in a newline.
 */
function line(number: number, width: number): string {
  return `${String(number).padStart(4, '0')}${'x'.repeat(width - 5)}\n`
}

/** A log of `count` fixed-width lines. */
function makeLog(count: number, width = 40): string {
  let text = ''
  for (let index = 1; index <= count; index += 1) text += line(index, width)
  return text
}

/**
 * Start a fake controller answering only what this client reads.
 * @param behaviour - how it should answer.
 * @returns its base URL, what it observed, and a stop function.
 */
async function startController(behaviour: Behaviour): Promise<{ baseUrl: string, observed: Observed, stop: () => void }> {
  const observed: Observed = { starts: [] }
  const logBytes = Buffer.byteLength(behaviour.log, 'utf8')
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    // No crumb issuer, as on a controller with CSRF protection off; the client
    // treats the 404 as "this instance needs none".
    if (url.pathname === '/crumbIssuer/api/json') {
      res.statusCode = 404
      res.end()
      return
    }
    if (!url.pathname.endsWith('/consoleText')) {
      res.statusCode = 404
      res.end()
      return
    }
    const start = Number.parseInt(url.searchParams.get('start') ?? '0', 10)
    observed.starts.push(start)
    const from = behaviour.ignoreStart ? 0 : start
    const whole = behaviour.log.slice(from)
    const body = behaviour.bodyBytes === undefined ? whole : whole.slice(0, behaviour.bodyBytes)
    res.statusCode = 200
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    if (behaviour.sendTextSize) res.setHeader('x-text-size', String(logBytes))
    res.setHeader('content-length', String(Buffer.byteLength(body, 'utf8')))
    res.end(body)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    observed,
    stop: () => { server.close() },
  }
}

/**
 * One client pointed at a fake controller.
 * @param baseUrl - the controller's root URL.
 * @param overrides - configuration overrides.
 * @returns the client.
 */
function clientFor(baseUrl: string, overrides: Record<string, unknown> = {}): JenkinsClient {
  const config = Config({
    settingsFile: 'unused.json',
    baseUrl,
    username: 'tester',
    timeoutMs: 5_000,
    ...overrides,
  })
  return new JenkinsClient(config, async () => 'token')
}

const small = makeLog(10)
const smallBytes = Buffer.byteLength(small, 'utf8')

console.log('1) the tail is the tail, even though the controller ignores ?start=')
{
  const controller = await startController({ log: small, ignoreStart: true, sendTextSize: false })
  const page = await clientFor(controller.baseUrl).consoleLog('demo', '5', 0, 120)
  const lines = page.text.split('\n').filter(entry => entry.length > 0)
  check('the page is the end of the log', lines[lines.length - 1]?.startsWith('0010'), true)
  check('it did not come back as the head', page.text.startsWith('0001') && lines.length > 1, false)
  check('nothing more is left', page.moreData, false)
  check('nothing was truncated', page.truncated, false)
  check('the whole log is accounted for', page.totalSize, smallBytes)
  check('only one read was made', controller.observed.starts.length, 1)
  // The client must not depend on server-side offsetting: it asks for 0 because
  // that is the only value this controller honours.
  check('it asked for start=0', controller.observed.starts, [0])
  controller.stop()
}

console.log('\n2) within the read window, an offset is exact')
{
  const controller = await startController({ log: small, ignoreStart: true, sendTextSize: false })
  const page = await clientFor(controller.baseUrl).consoleLog('demo', '5', 40, smallBytes)
  check('the text starts at the requested byte', page.text, small.slice(40))
  check('the next offset is the end of the log', page.nextOffset, smallBytes)
  check('nothing more is left', page.moreData, false)
  controller.stop()
}

console.log('\n3) an offset past the end says so instead of inventing text')
{
  const controller = await startController({ log: small, ignoreStart: true, sendTextSize: false })
  const page = await clientFor(controller.baseUrl).consoleLog('demo', '5', smallBytes + 500, smallBytes)
  check('no text', page.text, '')
  check('it still reports where it was asked from', page.nextOffset, smallBytes + 500)
  check('and that there is nothing past it', page.moreData, false)
  controller.stop()
}

console.log('\n4) x-text-size wins over content-length when both are present')
{
  // The body is cut short while the stated size is the whole log: preferring
  // content-length here would read a truncated body as a complete short log.
  const controller = await startController({ log: small, ignoreStart: true, sendTextSize: true, bodyBytes: 100 })
  const page = await clientFor(controller.baseUrl).consoleLog('demo', '5', 0, 100)
  check('the stated size is the log size', page.totalSize, smallBytes)
  check('the page admits it is truncated', page.truncated, true)
  check('and that more remains', page.moreData, true)
  controller.stop()
}

console.log('\n5) a log larger than the read window is reported as truncated, not as short')
{
  // 600 lines of 40 bytes is 24 KB; the read window is capped at 4 KB, so the
  // client can only ever see the head — and must say so rather than pass it off
  // as the whole log. (The two bounds have configured minimums, hence 4096/1024.)
  const long = makeLog(600)
  const longBytes = Buffer.byteLength(long, 'utf8')
  const controller = await startController({ log: long, ignoreStart: true, sendTextSize: false })
  const page = await clientFor(controller.baseUrl, { logReadBytes: 4_096, maxLogBytes: 1_024 })
    .consoleLog('demo', '5', 0, 1_024)
  check('it is truncated', page.truncated, true)
  check('more data remains', page.moreData, true)
  check('the log is bigger than what was read', page.totalSize > Buffer.byteLength(page.text, 'utf8'), true)
  check('the read window was the configured one, not the page size', controller.observed.starts.length, 1)
  console.log(`     read ${Buffer.byteLength(page.text, 'utf8')} of ${longBytes} bytes, page ${Buffer.byteLength(page.text, 'utf8')} bytes`)
  controller.stop()
}

console.log('\n6) a build with no console log is a fact, not a crash')
{
  const config = Config({ settingsFile: 'unused.json', baseUrl: 'http://127.0.0.1:1/', username: 'tester', timeoutMs: 500 })
  const client = new JenkinsClient(config, async () => 'token')
  const failure = await client.consoleLog('demo', '5', 0, 100).then(() => undefined, (error: unknown) => error)
  check('it is a JenkinsError', failure instanceof JenkinsError, true)
  check('with a stable code', (failure as JenkinsError).code, 'network')
}

const failed = results.filter(pass => !pass).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exitCode = 1
