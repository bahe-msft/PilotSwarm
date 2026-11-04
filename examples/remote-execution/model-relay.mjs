import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { authorized, json, listen, readJson } from "./http.mjs";

/** Development relay: the host bridge holds model credentials; pods receive only a relay capability. */
export function createModelRelay({ token, timeoutMs = 120_000 }) {
    if (!token) throw new Error("relay token required");
    const jobs = new Map();
    return createServer(async (request, response) => {
        try {
            if (request.method === "GET" && request.url === "/health") return json(response, 200, { ready: true });
            if (!authorized(request, token)) return json(response, 401, { error: "unauthorized" });
            if (request.method === "POST" && request.url === "/v1/chat/completions") {
                if (jobs.size >= 8) return json(response, 429, { error: "relay busy" });
                const body = await readJson(request, 8 * 1024 * 1024);
                const id = randomUUID();
                const timer = setTimeout(() => {
                    jobs.delete(id);
                    if (!response.destroyed) json(response, 504, { error: "host model bridge timed out" });
                }, timeoutMs);
                jobs.set(id, { id, body, response, claimed: false, timer });
                response.on("close", () => { clearTimeout(timer); jobs.delete(id); });
                return;
            }
            if (request.method === "GET" && request.url === "/bridge/next") {
                const job = [...jobs.values()].find(job => !job.claimed);
                if (job) job.claimed = true;
                return json(response, 200, { job: job ? { id: job.id, body: job.body } : null });
            }
            const match = /^\/bridge\/jobs\/([\w-]+)$/.exec(request.url);
            if (request.method === "PUT" && match) {
                const result = await readJson(request, 16 * 1024 * 1024);
                if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599
                    || typeof result.body !== "string"
                    || !["application/json", "text/event-stream"].includes(result.contentType)) {
                    return json(response, 400, { error: "invalid model response" });
                }
                const job = jobs.get(match[1]);
                if (!job) return json(response, 410, { error: "job no longer active" });
                clearTimeout(job.timer);
                jobs.delete(job.id);
                job.response.writeHead(result.status, { "content-type": result.contentType, "cache-control": "no-store" });
                job.response.end(result.body);
                return json(response, 200, { delivered: true });
            }
            json(response, 404, { error: "not found" });
        } catch (error) {
            json(response, error.status ?? 500, { error: "model relay request failed" });
        }
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await listen(createModelRelay({ token: process.env.MODEL_RELAY_TOKEN }), Number(process.env.PORT ?? 8081), "0.0.0.0");
    console.log("model relay ready");
}
