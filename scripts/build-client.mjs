/**
 * Bundle the browser half into the client module system's lazy factory format:
 * `window.__ModuleLoader__.load({ id, factory })`. Baseline modules (React,
 * Cordis, and the static UI libraries) stay external and are resolved through
 * the `require` the shell hands the factory; anything else is inlined.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'

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

const result = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: BASELINE_MODULES,
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  logLevel: 'info',
})

const [output] = result.outputFiles
if (output === undefined) throw new Error('esbuild produced no output for the client half')

const body = output.text
const wrapped = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
  'const module = { exports: {} };',
  'const exports = module.exports;',
  body,
  'return module.exports;',
  '} });',
  '',
].join('\n')

await mkdir('lib', { recursive: true })
await writeFile('lib/client.js', wrapped)
console.log(`[dsh-jenkins-plugin] lib/client.js written (${wrapped.length} bytes)`)
