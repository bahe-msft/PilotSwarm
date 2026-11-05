import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

export const portalUrl = process.env.REMOTE_PORTAL_URL ?? "http://127.0.0.1:13001";
export async function api(route, user = "alice", options = {}) {
    const response = await fetch(portalUrl + "/api/v1" + route, {
        ...options,
        headers: { authorization: `Bearer dev:${user}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(190_000),
    });
    const body = await response.json();
    if (!response.ok || body.ok === false) throw new Error(`portal API HTTP ${response.status}: ${body.error?.message ?? "request failed"}`);
    return body.result;
}

export function remoteJobs(value, depth = 0) {
    if (depth > 12 || value == null) return [];
    if (typeof value === "string") {
        try { return remoteJobs(JSON.parse(value), depth + 1); } catch { return []; }
    }
    if (typeof value !== "object") return [];
    if (value.state === "completed" && typeof value.stdout === "string" && typeof value.executor === "string") return [value];
    return Object.values(value).flatMap(child => remoteJobs(child, depth + 1));
}

export async function events(sessionId, user = "alice", afterSeq = 0) {
    return api(`/management/sessions/${sessionId}/events?afterSeq=${afterSeq}&limit=1000`, user);
}

export async function waitForRemoteResult(sessionId, user, afterSeq, expected) {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
        const history = await events(sessionId, user, afterSeq);
        const jobs = history.filter(event => event.eventType === "tool.execution_complete").flatMap(event => remoteJobs(event.data));
        const job = jobs.find(job => job.stdout.includes(expected));
        if (job) {
            assert.equal(job.exitCode, 0, "remote shell must succeed");
            return { job, history };
        }
        if (history.some(event => event.eventType === "session.error")) throw new Error("agent turn failed; inspect local worker/model diagnostics");
        await sleep(500);
    }
    throw new Error("no successful remote tool result before deadline");
}
