#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
here="$root/deploy/kind/remote-execution"
cluster=${REMOTE_KIND_CLUSTER:?Set REMOTE_KIND_CLUSTER to the dedicated development Kind cluster}
engine=${CONTAINER_ENGINE:-docker}
state=${REMOTE_LOCAL_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/pilotswarm-remote/$cluster}
[[ $cluster =~ ^pilotswarm-[a-z0-9-]+$ ]] || { echo 'Use a dedicated pilotswarm-* Kind cluster' >&2; exit 1; }
[[ $engine == docker || $engine == podman ]] || exit 2
export KIND_EXPERIMENTAL_PROVIDER="$engine" KUBECONFIG="$state/kubeconfig"
if [[ $engine == podman ]]; then export CONTAINERS_CONF_OVERRIDE="$here/containers.conf" CONTAINERS_REGISTRIES_CONF="$here/registries.conf"; fi
mkdir -p "$state"; chmod 700 "$state"
command -v kind >/dev/null
kind get kubeconfig --name "$cluster" > "$KUBECONFIG.$$"; chmod 600 "$KUBECONFIG.$$"
mv "$KUBECONFIG.$$" "$KUBECONFIG"
k() { kubectl --context "kind-$cluster" --request-timeout=15s -n pilotswarm-remote "$@"; }
diagnose() {
    k get pods -o wide || true
    k get events --sort-by=.lastTimestamp || true
    for name in worker portal model postgres; do
        k logs "deployment/$name" --tail=60 2>/dev/null || true
        k logs "deployment/$name" --previous --tail=30 2>/dev/null || true
    done
}
rollout() {
    if ! kubectl --context "kind-$cluster" --request-timeout=65s -n pilotswarm-remote rollout status "deployment/$1" --timeout=60s; then diagnose; return 1; fi
}
load_image() {
    if [[ $engine == podman ]]; then timeout 120s podman save "$1" | timeout 120s podman exec -i "$cluster-control-plane" ctr -n k8s.io images import - >/dev/null;
    else timeout 120s kind load docker-image --name "$cluster" "$1"; fi
}
forward() {
    timeout 14400s kubectl --context "kind-$cluster" --request-timeout=0 -n pilotswarm-remote port-forward --address=127.0.0.1 "$1" "$2"
}
case "${1:-}" in
    up)
        provider=${REMOTE_PROVIDER_DIR:?Set REMOTE_PROVIDER_DIR to a local adapter directory containing provider.mjs}
        [[ $provider == /* && -f $provider/provider.mjs ]] || { echo 'Use an absolute provider directory containing provider.mjs' >&2; exit 1; }
        timeout 15s "$engine" info >/dev/null
        cd "$root"
        timeout 600s "$engine" build -f deploy/Dockerfile.portal -t localhost/pilotswarm-remote-base:dev .
        timeout 120s "$engine" build -f "$here/Dockerfile" -t localhost/pilotswarm-remote:dev .
        timeout 120s "$engine" build -f "$here/Dockerfile.executor" -t localhost/pilotswarm-remote-executor:dev .
        load_image localhost/pilotswarm-remote:dev
        load_image localhost/pilotswarm-remote-executor:dev
        k apply -f "$here/manifest.yaml"
        node -e '
          const fs=require("node:fs"),crypto=require("node:crypto"),p=process.argv[1];
          if(!fs.existsSync(p+"/model-relay-token"))fs.writeFileSync(p+"/model-relay-token",crypto.randomBytes(32).toString("hex"),{mode:0o600});
          fs.writeFileSync(p+"/model-providers.json",JSON.stringify({providers:[{id:"development",type:"openai",baseUrl:"http://model.pilotswarm-remote.svc.cluster.local:8081/v1",apiKey:"env:MODEL_RELAY_TOKEN",wireApi:"completions",models:[{name:"model",toolCatalog:{maxDeclarations:128,overflowStrategy:"typed-dispatch"}}]}],defaultModel:"development:model"}),{mode:0o600});
        ' "$state"
        k create secret generic runtime-provider --from-file="$provider" --dry-run=client -o yaml | k apply -f -
        k create secret generic model-config --from-file="model-providers.json=$state/model-providers.json" --dry-run=client -o yaml | k apply -f -
        k create secret generic model-relay --from-file="token=$state/model-relay-token" --dry-run=client -o yaml | k apply -f -
        rollout postgres
        k rollout restart deployment/model; rollout model
        k scale deployment/worker deployment/portal --replicas=1
        rollout worker; rollout portal
        echo 'Ready. Start bridge with a local MODEL_BRIDGE_MODULE, and portal in another terminal.'
        ;;
    bridge)
        : "${MODEL_BRIDGE_MODULE:?Set MODEL_BRIDGE_MODULE to a local complete(body, {signal}) implementation}"
        forward service/model 18081:8081 > "$state/model-forward.log" 2>&1 & pid=$!
        trap 'kill "$pid" 2>/dev/null || true' EXIT
        for _ in $(seq 1 30); do if node -e 'fetch("http://127.0.0.1:18081/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; then break; fi; sleep 1; done
        MODEL_RELAY_TOKEN_FILE="$state/model-relay-token" timeout 14400s node "$root/examples/remote-execution/model-bridge.mjs"
        ;;
    portal) forward service/portal "${REMOTE_PORTAL_PORT:-13001}:3001" ;;
    test)
        forward service/portal 13002:3001 > "$state/test-forward.log" 2>&1 & pid=$!
        trap 'kill "$pid" 2>/dev/null || true' EXIT
        for _ in $(seq 1 30); do if node -e 'fetch("http://127.0.0.1:13002/api/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; then break; fi; sleep 1; done
        export REMOTE_PORTAL_URL=http://127.0.0.1:13002 REMOTE_EVIDENCE_FILE="$state/e2e.json" REMOTE_BROWSER_SCREENSHOT="$state/portal.png"
        node "$root/examples/remote-execution/smoke.mjs" first
        k delete pod -l app=worker --force --grace-period=0 --wait=true
        rollout worker
        node "$root/examples/remote-execution/smoke.mjs" resume
        node "$root/examples/remote-execution/browser-smoke.mjs"
        ;;
    status) diagnose ;;
    *) echo 'Usage: run.sh up|bridge|portal|test|status' >&2; exit 2 ;;
esac
