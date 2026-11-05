import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { createExecutor } from "../executor.mjs";
import { SandboxClient } from "../client.mjs";
import { close, listen } from "../http.mjs";

async function harness(t) {
    const root = await mkdtemp(path.join(tmpdir(), "ps-remote-"));
    const executor = await createExecutor({ root, sessionId: "alice", token: "local-test-token" });
    const url = await listen(executor.server, 0);
    t.after(async () => { await executor.stop(); await rm(root, { recursive: true, force: true }); });
    return { root, executor, url, client: new SandboxClient({ url, sessionId: "alice", token: "local-test-token", pollMs: 10 }) };
}
const command = text => ({ command: text, timeoutMs: 2000 });

test("shell runs in executor workspace without inherited credentials", async t => {
    process.env.REMOTE_CREDENTIAL_SENTINEL = "must-not-reach-child";
    t.after(() => delete process.env.REMOTE_CREDENTIAL_SENTINEL);
    const { client, root } = await harness(t);
    const result = await client.execute("one", command("printf proof > proof.txt; pwd; printf '%s' \"${REMOTE_CREDENTIAL_SENTINEL-unset}\""));
    assert.equal(result.exitCode, 0);
    assert.equal(result.state, "completed");
    assert.match(result.stdout, /unset$/);
    assert.ok(result.stdout.includes(path.join(root, "workspace")));
    assert.equal(await readFile(path.join(root, "workspace/proof.txt"), "utf8"), "proof");
});

test("parallel duplicate submissions execute one job", async t => {
    const { client, root } = await harness(t);
    const results = await Promise.all(Array.from({ length: 5 }, () => client.execute("same", command("printf x >> count; sleep 0.1; cat count"))));
    assert.ok(results.every(result => result.stdout === "x"));
    assert.equal(await readFile(path.join(root, "workspace/count"), "utf8"), "x");
});

test("reuse of a job ID with different input is rejected", async t => {
    const { client } = await harness(t);
    await client.execute("same", command("printf first"));
    await assert.rejects(client.execute("same", command("printf second")), /HTTP 409/);
});

test("wrong session, token, traversal, and unknown fields are rejected", async t => {
    const { client, url } = await harness(t);
    const wrongOwner = new SandboxClient({ url, token: "local-test-token", sessionId: "bob" });
    const wrongToken = new SandboxClient({ url, token: "wrong", sessionId: "alice" });
    await assert.rejects(wrongOwner.execute("x", command("true")), /HTTP 404/);
    await assert.rejects(wrongToken.execute("x", command("true")), /HTTP 401/);
    await assert.rejects(client.execute("x", { ...command("true"), cwd: "/" }), /HTTP 400/);
    await assert.rejects(client.execute("x", { ...command("true"), timeoutMs: 30_001 }), /HTTP 400/);
    const response = await fetch(url + "/v1/sessions/alice/jobs/..%2fother", { headers: { authorization: "Bearer local-test-token" } });
    assert.equal(response.status, 404);
});

test("timeout and output bounds terminate commands", async t => {
    const { client } = await harness(t);
    const timeout = await client.execute("slow", { command: "sleep 30", timeoutMs: 100 });
    assert.equal(timeout.timedOut, true);
    assert.equal(timeout.signal, "SIGKILL");
    const output = await client.execute("loud", command("yes loud"));
    assert.equal(output.truncated, true);
    assert.ok(Buffer.byteLength(output.stdout) <= 65_536);
});

test("abort cancels the executor process group", async t => {
    const { client } = await harness(t);
    const cancellation = new AbortController();
    const pending = client.execute("cancel", command("sleep 30 & wait"), { signal: cancellation.signal });
    await sleep(100);
    cancellation.abort();
    await assert.rejects(pending);
    // Wait for the process exit to be journaled, then resubmit the same ID to observe it.
    await sleep(100);
    const observed = await client.execute("cancel", command("sleep 30 & wait"));
    assert.equal(observed.state, "cancelled");
});

test("lost submission response and polling disconnect do not repeat execution", async t => {
    const { root, url } = await harness(t);
    let droppedPut = false;
    let droppedGet = false;
    const proxy = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const upstream = await fetch(url + request.url, {
            method: request.method, headers: request.headers,
            ...(request.method === "PUT" ? { body: Buffer.concat(chunks) } : {}),
        });
        const body = await upstream.text();
        if ((!droppedPut && request.method === "PUT") || (!droppedGet && request.method === "GET")) {
            if (request.method === "PUT") droppedPut = true;
            else droppedGet = true;
            response.destroy();
            return;
        }
        response.writeHead(upstream.status, { "content-type": "application/json" });
        response.end(body);
    });
    const proxyUrl = await listen(proxy, 0);
    t.after(() => close(proxy));
    const client = new SandboxClient({ url: proxyUrl, token: "local-test-token", sessionId: "alice", pollMs: 10 });
    const result = await client.execute("lost", command("printf x >> count; sleep 0.2; cat count"));
    assert.equal(result.stdout, "x");
    assert.equal(await readFile(path.join(root, "workspace/count"), "utf8"), "x");
    assert.ok(droppedPut && droppedGet);
});

test("completed journal survives executor restart; unfinished jobs are not replayed", async t => {
    const root = await mkdtemp(path.join(tmpdir(), "ps-remote-restart-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const config = { root, token: "test", sessionId: "alice" };
    const first = await createExecutor(config);
    const firstUrl = await listen(first.server, 0);
    const client = new SandboxClient({ url: firstUrl, token: "test", sessionId: "alice", pollMs: 10 });
    await client.execute("done", command("printf x >> count; cat count"));
    await first.stop();
    const id = "unfinished";
    await mkdir(path.join(root, "jobs"), { recursive: true });
    await writeFile(path.join(root, "jobs", `${id}.json`), JSON.stringify({ id, state: "running", input: command("printf bad >> count") }));
    const second = await createExecutor(config);
    const url = await listen(second.server, 0);
    t.after(() => second.stop());
    const resumed = new SandboxClient({ url, token: "test", sessionId: "alice", pollMs: 10 });
    assert.equal((await resumed.execute("done", command("printf x >> count; cat count"))).stdout, "x");
    assert.equal((await resumed.request("GET", "unfinished")).state, "unknown");
    assert.equal(await readFile(path.join(root, "workspace/count"), "utf8"), "x");
});
