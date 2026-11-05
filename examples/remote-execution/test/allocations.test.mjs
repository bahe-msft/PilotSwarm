import assert from "node:assert/strict";
import { test } from "node:test";
import { Allocations } from "../allocations.mjs";

test("concurrent calls share one allocation per durable session, not across sessions", async () => {
    const calls = [];
    const allocations = new Allocations({ async ensure(id) {
        calls.push(id);
        return { allocationId: id, client: { execute() {}, health() {} } };
    } });
    const [one, repeated, two] = await Promise.all([allocations.ensure("one"), allocations.ensure("one"), allocations.ensure("two")]);
    assert.equal(one, repeated);
    assert.notEqual(one, two);
    assert.deepEqual(calls, ["one", "two"]);
    assert.throws(() => allocations.ensure("../other"), /invalid durable session/);
});

test("completed calls are revalidated so a warm worker observes expiry", async () => {
    let generation = 0;
    const allocations = new Allocations({ async ensure() {
        return { allocationId: `allocation-${++generation}`, client: { execute() {}, health() {} } };
    } });
    assert.equal((await allocations.ensure("session")).allocationId, "allocation-1");
    assert.equal((await allocations.ensure("session")).allocationId, "allocation-2");
});

test("environment metadata must identify a valid workspace generation", async () => {
    for (const environment of [null, "invalid", {}, { workspaceId: "workspace", generation: 0, restored: true },
        { workspaceId: "workspace", generation: 2, restored: "yes" }]) {
        const allocations = new Allocations({ async ensure() {
            return { allocationId: "allocation", client: { execute() {}, health() {} }, environment };
        } });
        await assert.rejects(allocations.ensure("session"), /provider environment/);
    }
});

test("provider errors propagate without an alternate allocation identity or fallback", async () => {
    const ids = [];
    const allocations = new Allocations({ async ensure(id) { ids.push(id); throw new Error("allocation outcome uncertain"); } });
    await assert.rejects(allocations.ensure("one"), /outcome uncertain/);
    await assert.rejects(allocations.ensure("one"), /outcome uncertain/);
    assert.deepEqual(ids, ["one", "one"]);
});

test("provider contract violations fail loudly", async () => {
    assert.throws(() => new Allocations({}), /ensure/);
    await assert.rejects(new Allocations({ async ensure() { return {}; } }).ensure("one"), /provider must return/);
});
