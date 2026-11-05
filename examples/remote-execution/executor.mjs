import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { authorized, close, json, listen, readJson } from "./http.mjs";

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_OUTPUT = 65_536;
export const MAX_TIMEOUT_MS = 30_000;

function validateInput(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some(key => !["command", "timeoutMs"].includes(key))
        || typeof input.command !== "string" || !input.command.trim() || input.command.length > 16_384
        || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > MAX_TIMEOUT_MS) {
        throw Object.assign(new Error("expected command and timeoutMs between 1 and 30000"), { status: 400 });
    }
    return { command: input.command, timeoutMs: input.timeoutMs };
}

/** A single-session executor. Its local journal deduplicates cooperative clients, not malicious shell code. */
export async function createExecutor({ root, sessionId, token, authHeader = "authorization" }) {
    if (!path.isAbsolute(root) || !ID.test(sessionId) || !token) throw new Error("absolute root, sessionId and token are required");
    if (!["authorization", "x-remote-executor-authorization"].includes(authHeader)) throw new Error("unsupported executor auth header");
    const jobsDir = path.join(root, "jobs");
    const workspace = path.join(root, "workspace");
    const home = path.join(root, "home");
    await Promise.all([jobsDir, workspace, home].map(directory => mkdir(directory, { recursive: true, mode: 0o700 })));
    const jobs = new Map();
    const processes = new Map();
    let stopping = false;

    const save = async job => {
        const filename = path.join(jobsDir, `${job.id}.json`);
        await writeFile(`${filename}.tmp`, JSON.stringify(job), { mode: 0o600 });
        await rename(`${filename}.tmp`, filename);
    };
    for (const filename of await readdir(jobsDir)) {
        if (!filename.endsWith(".json")) continue;
        const job = JSON.parse(await readFile(path.join(jobsDir, filename), "utf8"));
        if (!ID.test(job.id) || filename !== `${job.id}.json`) throw new Error("invalid executor journal");
        // A lost process may have produced effects. Never rerun it after server restart.
        if (job.state === "running") {
            job.state = "unknown";
            await save(job);
        }
        jobs.set(job.id, job);
    }

    const kill = child => {
        if (!child.pid) return;
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
            if (error.code !== "ESRCH") throw error;
        }
    };
    const run = job => {
        const child = spawn("/bin/sh", ["-c", job.input.command], {
            cwd: workspace,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            // No spread of process.env: database and model credentials belong to the worker.
            env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, LANG: "C.UTF-8", TMPDIR: "/tmp" },
        });
        const execution = { child, cancelled: false };
        processes.set(job.id, execution);
        let outputBytes = 0;
        const capture = key => bytes => {
            const remaining = Math.max(0, MAX_OUTPUT - outputBytes);
            job[key] += bytes.subarray(0, remaining).toString();
            outputBytes += bytes.length;
            if (outputBytes > MAX_OUTPUT) {
                job.truncated = true;
                kill(child);
            }
        };
        child.stdout.on("data", capture("stdout"));
        child.stderr.on("data", capture("stderr"));
        const timer = setTimeout(() => { job.timedOut = true; kill(child); }, job.input.timeoutMs);
        let spawnFailed = false;
        child.on("error", () => { spawnFailed = true; });
        execution.done = new Promise(resolve => child.once("close", async (code, signal) => {
            clearTimeout(timer);
            // Shell exit can leave detached descendants holding files or stdout open.
            kill(child);
            const finished = {
                ...job, state: execution.cancelled ? "cancelled" : "completed",
                exitCode: spawnFailed ? 127 : code, signal, finishedAt: new Date().toISOString(),
            };
            try {
                await save(finished);
            } catch {
                finished.state = "unknown";
            } finally {
                processes.delete(job.id);
                // Publish terminal state only after persistence and slot release.
                jobs.set(job.id, finished);
                resolve();
            }
        }));
    };

    // Serialize journal mutations so concurrent PUTs cannot both launch the same ID.
    let mutations = Promise.resolve();
    const mutate = operation => {
        const result = mutations.then(operation);
        mutations = result.catch(() => {});
        return result;
    };
    const view = job => ({ ...job, input: undefined });
    const server = createServer(async (request, response) => {
        try {
            if (request.method === "GET" && request.url === "/health") {
                return json(response, 200, {
                    protocol: "pilotswarm.remote-executor.v1", executor: os.hostname(),
                });
            }
            if (!authorized(request, token, authHeader)) return json(response, 401, { error: "unauthorized" });
            const match = /^\/v1\/sessions\/([a-zA-Z0-9_-]+)\/jobs\/([a-zA-Z0-9_-]+)$/.exec(request.url);
            if (!match || match[1] !== sessionId || !ID.test(match[2])) return json(response, 404, { error: "not found" });
            const id = match[2];
            if (request.method === "PUT") {
                const input = validateInput(await readJson(request));
                const job = await mutate(async () => {
                    const existing = jobs.get(id);
                    if (existing) {
                        if (JSON.stringify(existing.input) !== JSON.stringify(input)) {
                            throw Object.assign(new Error("job ID already has different input"), { status: 409 });
                        }
                        return existing;
                    }
                    if (stopping) throw Object.assign(new Error("executor stopping"), { status: 503 });
                    if (processes.size) throw Object.assign(new Error("executor busy"), { status: 409 });
                    const created = {
                        id, input, state: "running", executor: os.hostname(), workspace,
                        stdout: "", stderr: "", timedOut: false, truncated: false,
                        startedAt: new Date().toISOString(),
                    };
                    await save(created);
                    jobs.set(id, created);
                    run(created);
                    return created;
                });
                return json(response, 200, view(job));
            }
            const job = jobs.get(id);
            if (!job) return json(response, 404, { error: "not found" });
            if (request.method === "GET") return json(response, 200, view(job));
            if (request.method === "DELETE") {
                const execution = processes.get(id);
                if (execution) {
                    execution.cancelled = true;
                    kill(execution.child);
                }
                return json(response, 200, view(job));
            }
            json(response, 405, { error: "method not allowed" });
        } catch (error) {
            json(response, error.status ?? 500, { error: error.status ? error.message : "executor failed" });
        }
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    return {
        server,
        async stop() {
            stopping = true;
            await mutations;
            for (const execution of processes.values()) {
                execution.cancelled = true;
                kill(execution.child);
            }
            await Promise.all([...processes.values()].map(execution => execution.done));
            await close(server);
        },
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const executor = await createExecutor({
        root: process.env.REMOTE_EXECUTOR_ROOT,
        sessionId: process.env.REMOTE_SESSION_ID,
        token: process.env.REMOTE_EXECUTOR_TOKEN,
        authHeader: process.env.REMOTE_AUTH_HEADER,
    });
    await listen(executor.server, Number(process.env.PORT ?? 3000), "0.0.0.0");
    console.log("remote executor ready");
    for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => executor.stop().then(() => process.exit(0)));
}
