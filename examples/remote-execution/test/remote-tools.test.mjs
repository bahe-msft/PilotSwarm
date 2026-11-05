import assert from "node:assert/strict";
import { test } from "node:test";
import { executeRemote, executorInfo } from "../remote-tools.mjs";

const invocation = { durableSessionId: "session", toolCallId: "tool" };
function fixture(environment) {
    const executions = [];
    return { executions, allocations: { async ensure(id) {
        assert.equal(id, "session");
        return { allocationId: "allocation", environment, client: {
            async execute(id, input) { executions.push({ id, input }); return { state: "completed", stdout: "proof" }; },
            async health() { return { executor: "host" }; },
        } };
    } } };
}

test("first environment executes with a durable identity and default deadline", async () => {
    const environment = { workspaceId: "workspace", generation: 1, restored: false };
    const { allocations, executions } = fixture(environment);
    const result = await executeRemote(allocations, { command: "cat proof" }, invocation);
    assert.deepEqual(executions, [{ id: "session:tool", input: { command: "cat proof", timeoutMs: 10000 } }]);
    assert.deepEqual(result.environment, environment);
});

test("restoration notice precedes any command and requires the current generation", async () => {
    const environment = { workspaceId: "workspace", generation: 2, restored: true };
    const { allocations, executions } = fixture(environment);
    for (const environmentGeneration of [undefined, 1, 3]) {
        const result = await executeRemote(allocations, { command: "restart server", environmentGeneration }, invocation);
        assert.equal(result.state, "environment_changed");
        assert.equal(result.commandExecuted, false);
        assert.match(result.notice, /previous processes/i);
        assert.equal(executions.length, 0);
    }
    const result = await executeRemote(allocations, { command: "cat proof", timeoutMs: 2000, environmentGeneration: 2 }, invocation);
    assert.equal(result.state, "completed");
    assert.equal(executions.length, 1);
    assert.deepEqual(executions[0].input, { command: "cat proof", timeoutMs: 2000 });
});

test("executor inspection exposes the generation without executing a command", async () => {
    const environment = { workspaceId: "workspace", generation: 7, restored: true };
    const { allocations, executions } = fixture(environment);
    assert.deepEqual(await executorInfo(allocations, invocation), { allocationId: "allocation", executor: "host", environment });
    assert.equal(executions.length, 0);
});

test("providers without retention metadata execute but cannot accept a guessed generation", async () => {
    const { allocations, executions } = fixture(undefined);
    assert.equal((await executeRemote(allocations, { command: "pwd" }, invocation)).state, "completed");
    await assert.rejects(executeRemote(allocations, { command: "pwd", environmentGeneration: 2 }, invocation), /does not expose/);
    assert.equal(executions.length, 1);
});

test("missing durable identities and unavailable providers never execute", async () => {
    const { allocations, executions } = fixture(undefined);
    await assert.rejects(executeRemote(allocations, { command: "pwd" }, { durableSessionId: "session" }), /durable invocation/);
    await assert.rejects(executorInfo(allocations, {}), /durable invocation/);
    await assert.rejects(executeRemote({ async ensure() { throw new Error("workspace missing"); } }, { command: "pwd" }, invocation), /workspace missing/);
    assert.equal(executions.length, 0);
});
