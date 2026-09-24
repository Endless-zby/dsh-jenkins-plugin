# dsh-jenkins-plugin

Jenkins integration for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a live build-progress panel in the Web GUI plus model-facing tools for triggering builds, reading stages and console logs, and browsing a build's workspace.

功能基线见 [SPEC.md](SPEC.md)。

## Status

Vertical slice under construction. Working today:

- Validated configuration with credentials kept out of `cordis.yml`.
- `jenkins_jobs` — list jobs with their coarse status and optional recent builds.
- A session-header panel that reads the plugin's own authenticated state route.

Not implemented yet: build triggering, stage/log tracking, workspace and artifact browsing, the right-sidebar build panel, background jobs, and the completion notice. See SPEC.md §11 for the staged plan.

## Install

Build first, then install the checkout into a profile:

```sh
npm install
npm run build
dsh plugin --profile <name> add /absolute/path/to/dsh-jenkins-plugin
```

`dsh plugin add` accepts a published package name, a tarball, a git address, or an absolute local path. Only built artifacts are loaded, so a source checkout must be built first.

## Configuration

```yaml
- id: jenkins
  name: dsh-jenkins-plugin
  config:
    baseUrl: https://ci.example.com/jenkins
    username: ci-bot
    tokenRef: JENKINS_TOKEN
    denyJobs: []
```

The API token is never written here: `tokenRef` names a credential the harness resolves per request, so rotating it applies to the next call without a restart.

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | — | Jenkins root URL (required) |
| `username` | — | Login name paired with the token (required) |
| `tokenRef` | `JENKINS_TOKEN` | Credential reference holding the API token |
| `tlsMode` | `verify` | `verify` validates the certificate; `allowSelfSigned` does not |
| `tlsCaFile` | — | PEM bundle used to validate the certificate under `verify` |
| `timeoutMs` | `15000` | Bound on one HTTP request |
| `crumbMode` | `auto` | `auto` fetches a CSRF crumb before mutating requests |
| `denyJobs` | `[]` | Job paths that may never be triggered or cancelled |
| `allowTrigger` | `true` | Whether the model may trigger builds |
| `allowCancel` | `false` | Whether the model may cancel builds |
| `progressIntervalMs` | `3000` | Stage polling interval for tracked builds |
| `logIntervalMs` | `1500` | Console-log polling interval for the shown build |
| `idleBackoffMaxMs` | `30000` | Upper bound of the idle backoff |
| `queueTimeoutMs` | `300000` | How long a build may stay queued before it reports a timeout |
| `maxTrackedBuilds` | `5` | Tracked builds one session may hold |
| `retainMs` | `600000` | How long a finished build stays tracked |
| `historyCount` | `10` | Default build-history rows per job |
| `maxLogBytes` | `262144` | Byte cap on one console-log response |
| `maxWorkspaceEntries` | `500` | Entry cap on one directory listing |
| `maxReadFileBytes` | `1048576` | Byte cap on one workspace file read |
| `notifyOnComplete` | `true` | Whether a finished build is announced in its session |
| `notifyWakeOnFailure` | `false` | Whether a failed build wakes the owning agent |
| `uiAutoOpenOnTrigger` | `true` | Whether triggering a build opens the panel |

## How the two halves fit

- **Host** (`src/`) resolves the token per call, talks to the Jenkins REST API over `node:http`/`node:https` (custom CA and untrusted-certificate modes need transport control `fetch` cannot express), registers model tools, and serves the panel's same-origin routes behind the composition's browser request-trust check.
- **Browser** (`src/client/`) is bundled into the client module system's lazy factory format and registers a panel through the slot system. It reaches the Host only through the plugin's own routes; harness RPC namespaces are fixed at build time and cannot be extended out of tree.

## Development

```sh
npm install
npm run typecheck
npm run build      # tsc for the Host half, then esbuild for the browser bundle
```

The browser half is bundled into `lib/client.js` as `window.__ModuleLoader__.load({ id, factory })`; React, Cordis, and the static UI libraries stay external and resolve through the injected `require`.
