import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export class SandboxClient {
    constructor({ url, token, sessionId, requestTimeoutMs = 3000, pollMs = 100, transport = fetch }) {
        const origin = new URL(url);
        if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password
            || origin.pathname !== "/" || origin.search || origin.hash || !token || !/^[\w-]{1,128}$/.test(sessionId)) {
            throw new Error("executor origin, token and sessionId are required");
        }
        Object.assign(this, { url: origin.origin, token, sessionId, requestTimeoutMs, pollMs, transport });
    }

    async request(method, id, body, signal) {
        const response = await this.transport(`${this.url}/v1/sessions/${this.sessionId}/jobs/${id}`, {
            method, redirect: "error",
            headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]) : AbortSignal.timeout(this.requestTimeoutMs),
        });
        const result = await response.json();
        if (!response.ok) throw Object.assign(new Error(`executor HTTP ${response.status}: ${result.error}`), { status: response.status });
        return result;
    }

    async health() {
        const response = await this.transport(this.url + "/health", {
            headers: { authorization: `Bearer ${this.token}` }, redirect: "error",
            signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        if (!response.ok) throw Object.assign(new Error(`executor health HTTP ${response.status}`), { status: response.status });
        return response.json();
    }

    /** Each invocation ID names one immutable job, including after a lost PUT response. */
    async execute(invocationId, input, { timeoutMs = 45_000, signal } = {}) {
        if (typeof invocationId !== "string" || !invocationId) throw new Error("invocation ID is required");
        const id = createHash("sha256").update(invocationId).digest("hex");
        const deadline = AbortSignal.timeout(timeoutMs);
        const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
        let job;
        try {
            try {
                job = await this.request("PUT", id, input, active);
            } catch (error) {
                // A transport failure may hide an accepted PUT. Observe the same job; do not mint another ID.
                if (error.status) throw error;
            }
            for (;;) {
                active.throwIfAborted();
                if (job?.state === "unknown") throw new Error("executor outcome unknown; manual reconciliation required");
                if (job && job.state !== "running") return job;
                await sleep(this.pollMs, undefined, { signal: active });
                try {
                    job = await this.request("GET", id, undefined, active);
                } catch (error) {
                    if (error.status) throw error;
                }
            }
        } catch (error) {
            if (active.aborted) {
                // Bound cleanup independently: the cancelled turn's signal is already unusable.
                try { await this.request("DELETE", id); } catch {}
            }
            throw error;
        }
    }
}
