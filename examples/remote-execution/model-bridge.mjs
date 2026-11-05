import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export async function runModelBridge({ url, token, complete, signal }) {
    if (!token || typeof complete !== "function") throw new Error("relay token and complete(body, {signal}) required");
    const request = async (route, options = {}) => {
        const response = await fetch(url + route, {
            ...options, redirect: "error",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        });
        if (!response.ok) throw new Error(`model relay HTTP ${response.status}`);
        return response.json();
    };
    while (!signal.aborted) {
        const { job } = await request("/bridge/next");
        if (!job) { await sleep(100, undefined, { signal }); continue; }
        let result;
        try {
            result = await complete(job.body, { signal: AbortSignal.any([signal, AbortSignal.timeout(110_000)]) });
        } catch {
            // Do not serialize credential-chain exceptions or endpoint diagnostics into model responses.
            result = { status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "host model provider unavailable" } }) };
        }
        await request(`/bridge/jobs/${job.id}`, { method: "PUT", body: JSON.stringify(result) });
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const modulePath = process.env.MODEL_BRIDGE_MODULE;
    if (!modulePath || !path.isAbsolute(modulePath)) throw new Error("absolute MODEL_BRIDGE_MODULE required");
    const provider = await import(pathToFileURL(modulePath).href);
    const token = (await readFile(process.env.MODEL_RELAY_TOKEN_FILE, "utf8")).trim();
    const stop = new AbortController();
    for (const name of ["SIGTERM", "SIGINT"]) process.once(name, () => stop.abort());
    try {
        await runModelBridge({ url: process.env.MODEL_RELAY_URL ?? "http://127.0.0.1:18081", token, complete: provider.complete, signal: stop.signal });
    } catch (error) {
        if (!stop.signal.aborted) throw error;
    }
}
