/**
 * Bundle the browser half into the client module system's lazy factory format:
 * `window.__ModuleLoader__.load({ id, factory })`. Baseline modules (React,
 * Cordis, and the static UI libraries) stay external and are resolved through
 * the `require` the shell hands the factory; anything else is inlined.
 *
 * The esbuild *binary* is invoked directly instead of esbuild's JavaScript API:
 * the API starts a long-lived service process over piped stdio, and `execFile`
 * always pipes, while a `spawn` with inherited stdio works under a confined
 * sandbox. The wrapper is applied here with plain file I/O.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/** The module identity the shell resolves for this package's client half. */
const PLUGIN_ID = 'dsh-jenkins-plugin'

/** Shell-seeded module-table keys, externalized for every dynamic bundle. */
const BASELINE_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Intermediate CommonJS output, wrapped and then removed. */
const BODY_FILE = 'lib/client.body.cjs'

/**
 * Locate the platform-specific esbuild binary.
 * @returns the absolute path of the binary.
 */
function esbuildBinary() {
  const packageRoot = dirname(dirname(require.resolve('esbuild')))
  const nodeModules = dirname(packageRoot)
  const platformRoot = join(nodeModules, '@esbuild', `${process.platform}-${process.arch}`)
  const candidate = process.platform === 'win32'
    ? join(platformRoot, 'esbuild.exe')
    : join(platformRoot, 'bin', 'esbuild')
  if (!existsSync(candidate)) {
    throw new Error(`esbuild binary not found at ${candidate}; run the package manager install again`)
  }
  return candidate
}

await mkdir('lib', { recursive: true })
await new Promise((resolve, reject) => {
  const child = spawn(esbuildBinary(), [
    'src/client/index.tsx',
    '--bundle',
    '--format=cjs',
    '--platform=browser',
    '--target=es2022',
    '--jsx=automatic',
    `--outfile=${BODY_FILE}`,
    '--define:process.env.NODE_ENV="production"',
    '--legal-comments=none',
    ...BASELINE_MODULES.map(name => `--external:${name}`),
  ], { stdio: 'inherit' })
  child.on('error', reject)
  child.on('exit', (code) => {
    if (code === 0) resolve(undefined)
    else reject(new Error(`esbuild exited with code ${code}`))
  })
})

const body = await readFile(BODY_FILE, 'utf8')
const wrapped = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
  'const module = { exports: {} };',
  'const exports = module.exports;',
  body,
  'return module.exports;',
  '} });',
  '',
].join('\n')

await writeFile('lib/client.js', wrapped)
await rm(BODY_FILE, { force: true })

const packageManifest = JSON.parse(readFileSync('package.json', 'utf8'))
console.log(`[${packageManifest.name}] lib/client.js written (${wrapped.length} bytes)`)
