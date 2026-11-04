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
