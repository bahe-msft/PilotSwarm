function durableSession(invocation) {
    if (!invocation.durableSessionId || !invocation.toolCallId) throw new Error("durable invocation identity required");
    return invocation.durableSessionId;
}

export async function executeRemote(allocations, input, invocation) {
    const sessionId = durableSession(invocation);
    const allocation = await allocations.ensure(sessionId);
    const environment = allocation.environment;
    if (input.environmentGeneration !== undefined && !environment) {
        throw new Error("provider does not expose environment generations");
    }
    if (environment && ((environment.restored && input.environmentGeneration !== environment.generation)
        || (input.environmentGeneration !== undefined && input.environmentGeneration !== environment.generation))) {
        return {
            state: "environment_changed", commandExecuted: false, environment,
            notice: "The workspace is attached to a different execution environment. Files were retained, but previous processes, connections and temporary files were not restored. Inspect the workspace and restart anything you need. Retry with environmentGeneration set to the current generation; this command has not run.",
        };
    }
    const result = await allocation.client.execute(`${sessionId}:${invocation.toolCallId}`, {
        command: input.command, timeoutMs: input.timeoutMs ?? 10_000,
    });
    return { ...result, ...(environment ? { environment } : {}) };
}

export async function executorInfo(allocations, invocation) {
    const allocation = await allocations.ensure(durableSession(invocation));
    const health = await allocation.client.health();
    return { allocationId: allocation.allocationId, executor: health.executor,
        ...(allocation.environment ? { environment: allocation.environment } : {}) };
}
