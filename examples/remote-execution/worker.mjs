import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PilotSwarmWorker, FilesystemSessionStore, defineTool } from "pilotswarm-sdk";
import { loadAllocations } from "./allocations.mjs";
import { json, listen, close } from "./http.mjs";

function required(name) {
    if (!process.env[name]) throw new Error(`${name} is required`);
    return process.env[name];
}
const stateDir = required("REMOTE_STATE_DIR");
const sessionStateDir = required("SESSION_STATE_DIR");
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const allocations = await loadAllocations(required("REMOTE_PROVIDER_MODULE"), path.join(stateDir, "allocations"));
const worker = new PilotSwarmWorker({
    store: required("DATABASE_URL"),
    modelProvidersPath: required("PS_MODEL_PROVIDERS_PATH"),
    pluginDirs: [new URL("./plugin", import.meta.url).pathname],
    sessionStateDir,
    sessionStore: new FilesystemSessionStore(path.join(stateDir, "snapshots"), sessionStateDir),
    disableManagementAgents: true, nativeSubagents: "off", workerNodeId: os.hostname(),
    toolExecutionAllowlist: [
        "sandbox_exec", "executor_info", "wait", "cron", "cron_at", "ask_user", "report_cycle",
        "list_available_models", "spawn_agent", "message_agent", "check_agents", "wait_for_agents",
        "complete_agent", "cancel_agent", "stop_agent_turn", "list_sessions", "load_skill",
    ],
    turnTimeoutMs: 180_000,
    workerLockTimeoutMs: 10_000, orchestratorLockTimeoutMs: 10_000, sessionLockTimeoutMs: 10_000,
});
worker.registerTools([
    defineTool("sandbox_exec", {
        description: "Run a shell command in this session's remote working folder. All file reads, writes, scripts, and shell commands must use this tool. The working folder persists across turns while the allocation lives.",
        parameters: {
            type: "object", additionalProperties: false,
            properties: { command: { type: "string", maxLength: 16_384 }, timeoutMs: { type: "integer", minimum: 1, maximum: 30_000 } },
            required: ["command"],
        },
        handler: async (input, invocation) => {
            if (!invocation.durableSessionId || !invocation.toolCallId) throw new Error("durable invocation identity required");
            const allocation = await allocations.ensure(invocation.durableSessionId);
            return JSON.stringify(await allocation.client.execute(`${invocation.durableSessionId}:${invocation.toolCallId}`, {
                command: input.command, timeoutMs: input.timeoutMs ?? 10_000,
            }));
        },
    }),
    defineTool("executor_info", {
        description: "Show the opaque allocation identifier and executor hostname for this session.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        handler: async (_input, invocation) => {
            const allocation = await allocations.ensure(invocation.durableSessionId);
            const health = await allocation.client.health();
            return JSON.stringify({ allocationId: allocation.allocationId, executor: health.executor });
        },
    }),
]);
await worker.start();
const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") return json(response, 200, { ready: worker.isStarted });
    json(response, 404, { error: "not found" });
});
await listen(server, Number(process.env.PORT ?? 8080), "0.0.0.0");
console.log("remote execution worker ready");
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => {
    await close(server);
    await worker.gracefulShutdown();
    process.exit(0);
});
