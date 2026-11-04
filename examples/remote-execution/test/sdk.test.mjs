import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CopilotClient, RuntimeConnection, defineTool } from "@github/copilot-sdk";
import { createExecutor } from "../executor.mjs";
import { SandboxClient } from "../client.mjs";
import { withToolExecutionAllowlist } from "../../../packages/sdk/dist/permissions.js";
import { createModel } from "./model-fixture.mjs";
import { close, listen } from "../http.mjs";

const allowOnlySandboxTool = withToolExecutionAllowlist(undefined, new Set(["sandbox_exec"])).onPreToolUse;

test("real Copilot SDK/CLI calls separate executor through deterministic model, then cold-resumes", { timeout: 90_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ps-remote-sdk-"));
    const executor = await createExecutor({ root: path.join(root, "executor"), sessionId: "alice", token: "local" });
    const executorUrl = await listen(executor.server, 0);
    const model = createModel();
    const modelUrl = await listen(model, 0);
    const sandbox = new SandboxClient({ url: executorUrl, token: "local", sessionId: "alice" });
    const clients = [];
    try {
        const calls = [];
        const config = {
            model: "gpt-5.4", streaming: true,
            provider: { type: "openai", baseUrl: modelUrl + "/v1", apiKey: "synthetic" },
            hooks: { onPreToolUse: allowOnlySandboxTool },
            onPermissionRequest: () => ({ kind: "approve-once" }),
            tools: [defineTool("sandbox_exec", {
                description: "Run a command in the executor.",
                parameters: { type: "object", properties: { command: { type: "string" }, timeoutMs: { type: "integer" } }, required: ["command", "timeoutMs"] },
                handler: async (input, invocation) => {
                    calls.push(invocation.toolCallId);
                    return JSON.stringify(await sandbox.execute(invocation.toolCallId, input));
                },
            })],
        };
        const newClient = () => {
            const client = new CopilotClient({
                useLoggedInUser: false, logLevel: "error", connection: RuntimeConnection.forStdio(),
                env: { ...process.env, COPILOT_HOME: path.join(root, "copilot") },
            });
            clients.push(client);
            return client;
        };
        const first = newClient();
        const session = await first.createSession(config);
        const prompt = command => "REMOTE_EXEC:" + Buffer.from(command).toString("base64");
        const result = await session.sendAndWait({ prompt: prompt("printf sdk-proof > proof; cat proof") }, 30_000);
        assert.match(result.data.content, /sdk-proof/);
        await session.disconnect();
        await first.stop();
        const resumed = await newClient().resumeSession(session.sessionId, config);
        const second = await resumed.sendAndWait({ prompt: prompt("cat proof") }, 30_000);
        assert.match(second.data.content, /sdk-proof/);
        assert.equal(calls.length, 2);
        assert.ok(calls.every(Boolean));
        await resumed.disconnect();
    } finally {
        await Promise.all(clients.map(client => client.stop()));
        await executor.stop();
        await close(model);
        await rm(root, { recursive: true, force: true });
    }
});

test("real CLI cannot execute a worker-local native shell through the tool policy", { timeout: 45_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ps-remote-deny-"));
    const model = createModel({ toolName: "bash" });
    const url = await listen(model, 0);
    const client = new CopilotClient({
        useLoggedInUser: false, logLevel: "error", connection: RuntimeConnection.forStdio(),
        env: { ...process.env, COPILOT_HOME: path.join(root, "copilot") },
    });
    const observed = [];
    try {
        const session = await client.createSession({
            model: "gpt-5.4", streaming: true,
            provider: { type: "openai", baseUrl: url + "/v1", apiKey: "synthetic" },
            hooks: { onPreToolUse: input => { observed.push(input.toolName); return allowOnlySandboxTool(input); } },
            onPermissionRequest: () => ({ kind: "approve-once" }),
        });
        const filename = path.join(root, "must-not-exist");
        const command = `touch '${filename}'`;
        await session.sendAndWait({ prompt: "REMOTE_EXEC:" + Buffer.from(command).toString("base64") }, 30_000);
        assert.ok(observed.includes("bash"), "native shell must reach the deny hook");
        await assert.rejects(access(filename), { code: "ENOENT" });
        await session.disconnect();
    } finally {
        await client.stop();
        await close(model);
        await rm(root, { recursive: true, force: true });
    }
});
