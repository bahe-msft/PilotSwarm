import path from "node:path";
import { pathToFileURL } from "node:url";

export class Allocations {
    constructor(provider) {
        if (typeof provider.ensure !== "function") throw new Error("provider must export ensure(sessionId)");
        this.provider = provider;
        this.pending = new Map();
    }

    ensure(sessionId) {
        if (typeof sessionId !== "string" || !/^[\w-]{1,128}$/.test(sessionId)) throw new Error("invalid durable session ID");
        const existing = this.pending.get(sessionId);
        if (existing) return existing;
        const allocation = Promise.resolve().then(() => this.provider.ensure(sessionId)).then(result => {
            if (!result?.allocationId || typeof result.allocationId !== "string"
                || typeof result.client?.execute !== "function" || typeof result.client?.health !== "function") {
                throw new Error("provider must return {allocationId, client: {execute, health}}");
            }
            if (result.environment !== undefined) {
                if (!result.environment || typeof result.environment !== "object") throw new Error("provider environment must be an object");
                const { workspaceId, generation, restored } = result.environment;
                if (typeof workspaceId !== "string" || !workspaceId || !Number.isSafeInteger(generation)
                    || generation < 1 || typeof restored !== "boolean") {
                    throw new Error("provider environment requires workspaceId, positive generation and restored flag");
                }
            }
            return result;
        }).finally(() => {
            if (this.pending.get(sessionId) === allocation) this.pending.delete(sessionId);
        });
        this.pending.set(sessionId, allocation);
        return allocation;
    }
}

export async function loadAllocations(modulePath, stateDir) {
    if (!path.isAbsolute(modulePath) || !path.isAbsolute(stateDir)) throw new Error("absolute provider module and state directory paths required");
    const module = await import(pathToFileURL(modulePath).href);
    if (typeof module.createProvider !== "function") throw new Error("provider module must export createProvider({stateDir})");
    return new Allocations(await module.createProvider({ stateDir }));
}
