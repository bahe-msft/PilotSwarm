# Portal-driven remote execution

Run the normal PilotSwarm browser portal with a real model and a session-specific remote working folder. The worker keeps Duroxide, PostgreSQL access, and Copilot SDK/CLI; `sandbox_exec` runs shell/file operations in a separate executor. A worker-owned tool allowlist blocks native worker-side tool execution for every session, including new sessions and cold resumes.

```text
Browser / Web SDK -> Portal API -> PostgreSQL -> Worker + Copilot SDK/CLI
                                                   |
                                                   +-> operator-supplied runtime provider -> executor
                                                   |
                                                   +-> model relay -> host model bridge -> real model
```

The runtime provider and model connection are **local inputs**, not bundled integrations. Their implementation, credentials, endpoints, and deployment settings stay outside the published source and container images. `.local/` is excluded from Git and Docker build contexts.

## Prerequisites

- The repository's supported Node version, `npm ci`, and a built SDK.
- Docker or rootless Podman, Kind, kubectl, and a dedicated `pilotswarm-*` development Kind cluster with storage provisioning.
- A local runtime-provider directory containing `provider.mjs` and any supporting local files.
- A host-side model module exporting `complete(body, {signal})` for a configured real Chat Completions provider.
- Browser verification additionally requires Playwright's Chromium: `npx playwright install chromium --only-shell`.

The cluster's runtime provisioning service is an operator prerequisite. This example does not install one or supply its images/configuration.

## Runtime-provider contract

The worker loads `REMOTE_PROVIDER_MODULE` from a read-only Secret volume. The module exports:

```javascript
export async function createProvider({ stateDir }) {
    return {
        async ensure(sessionId) {
            // Provision or resume this exact durable session's allocation.
            // Return an opaque identifier and a client for the executor protocol.
            return { allocationId, client };
        },
    };
}
```

`client` must implement:

- `execute(invocationId, {command, timeoutMs})`: return the executor job result.
- `health()`: return `{executor: "opaque-hostname"}`.

`client.mjs` supplies `SandboxClient` for HTTP endpoints. Its optional `transport` function lets an operator adapt routing and authentication without adding provider-specific behavior here. The worker derives `sessionId` and tool-call identity from the trusted SDK invocation, not model arguments.

The provider must persist allocation bindings under `stateDir`, serialize concurrent creation, and recover the same allocation after worker replacement. It must not issue another blind create when a previous result is uncertain. Missing, inaccessible, or expired allocations require an explicit provider policy; this example does not silently fall back to local execution. In-process caching deduplicates concurrent calls but is not a distributed allocation lease.

### Executor image and environment

The image built from `deploy/kind/remote-execution/Dockerfile.executor` contains only the public executor implementation and Node. Use that image as a local input to the provider's own provisioning configuration.

Set these variables in the executor:

| Variable | Meaning |
| --- | --- |
| `REMOTE_SESSION_ID` | Exact durable session ID |
| `REMOTE_EXECUTOR_ROOT` | Writable absolute directory for workspace, home, and job journal |
| `REMOTE_EXECUTOR_TOKEN` | Per-allocation application capability; never a model/database credential |
| `REMOTE_AUTH_HEADER` | Optional: `authorization` or `x-remote-executor-authorization` |
| `PORT` | Optional application port, default 3000 |

Entrypoint: `node /app/examples/remote-execution/executor.mjs`.

The executor binds one session. Immutable job IDs deduplicate cooperative retries; conflicting input returns 409. Commands have bounded output and a maximum 30-second timeout. Interrupted journal entries become unknown on restart instead of being replayed. Shell code can alter files in its own executor, including its journal: this is not trusted accounting or an external-effects fence.

## Host model module

The host bridge keeps upstream credentials out of pods and avoids depending on pod-to-host routing. A module exports:

```javascript
export async function complete(body, { signal }) {
    // Use the operator's configured credential chain and fixed model endpoint.
    return { status, contentType, body: responseText };
}
```

Return content type `application/json` or `text/event-stream`. The module is responsible for translating the generic Chat Completions request to its configured provider. Do not select upstream destinations from model-controlled fields. Do not log or persist access tokens.

The development relay buffers each upstream response, including SSE, before delivering it to the SDK. It requires a generated relay capability and fails closed if the host bridge is absent. It does not substitute a model fixture. The relay capability is a local development credential, not an upstream model access token.

## Run

From the repository root, configure local inputs. Keep adapter and credential files under `.local/` or outside the checkout:

```bash
export REMOTE_KIND_CLUSTER=pilotswarm-development
export CONTAINER_ENGINE=podman # or docker
export REMOTE_PROVIDER_DIR="$PWD/.local/runtime-provider"
export MODEL_BRIDGE_MODULE="$PWD/.local/model-provider.mjs"

bash deploy/kind/remote-execution/run.sh up
```

The script builds public worker/portal and executor images, imports them into Kind, creates PostgreSQL and persistent worker storage, and mounts the runtime module separately. It writes a private kubeconfig under `${XDG_STATE_HOME:-$HOME/.local/state}/pilotswarm-remote/`; it does not change the default Kubernetes context.

In separate terminals:

```bash
bash deploy/kind/remote-execution/run.sh bridge
bash deploy/kind/remote-execution/run.sh portal
```

Open http://127.0.0.1:13001 (`REMOTE_PORTAL_PORT` selects another local port if needed). Select a development persona, create a **remote-coder** session, and ask it to create/read a file with `sandbox_exec`. Every new durable session gets a separate allocation on first remote-tool use; there is no fixed demonstration session ID.

The development authentication roster is not real identity authentication. The database uses a public test password. All Services are ClusterIP; port forwards bind to loopback. Do not expose this configuration to shared or public networks. Standard Kind networking alone does not enforce NetworkPolicy.

## End-to-end verification

With the host model bridge running:

```bash
bash deploy/kind/remote-execution/run.sh test
```

The test uses the real portal Web API and live model, then:

1. Creates independent sessions for Alice and Bob.
2. Requires actual remote tool-completion results with different executor hostnames and independently written file contents.
3. Checks that Bob receives 404 for Alice's private session.
4. Abruptly replaces the worker, discarding its local CLI state cache.
5. Resumes both conversations, requires hydration events, and reads the retained files from the same executors.
6. Opens the real browser UI, creates another session through its model/agent picker, sends a prompt through the composer, and verifies a live remote tool result.

Evidence is saved in the private local state directory. No test traces, screenshots, runtime adapters, or deployment inputs belong in a public commit. Allocations remain for inspection; their TTL, release, and cleanup policy belongs to the supplied runtime provider. Do not discard provider bindings before confirming allocation cleanup.

`run.sh status` prints scoped pod diagnostics. The example uses its own database schemas and can coexist with other workers in the dedicated cluster.

## Offline tests

```bash
npm run test:remote-execution
```

These tests cover protocol bounds, authentication, cancellation, duplicate/lost responses, allocation isolation, model relay behavior, the worker allowlist, and real Copilot SDK/CLI calls against an explicitly synthetic provider fixture. They do not claim live model or runtime-provider acceptance; the end-to-end command above performs those checks.

## Scope

- Copilot SDK/CLI stays on the trusted worker; only shell/file execution moves remotely.
- Remote files are accessed through `sandbox_exec`; the portal Workspace pane is not remotely mounted.
- Conversation snapshots persist on the worker volume. Workspace lifetime depends on the runtime provider.
- Committed-turn recovery is tested. Active-turn takeover, arbitrary external-effect idempotency, multi-worker allocation fencing, and production network isolation need separate validation.
