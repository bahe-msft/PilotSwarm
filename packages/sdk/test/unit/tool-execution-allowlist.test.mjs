import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withToolExecutionAllowlist } from "../../dist/permissions.js";
import { SessionManager } from "../../dist/session-manager.js";

const input = toolName => ({ toolName, toolArgs: {}, timestamp: Date.now(), cwd: "/tmp" });

test("omitted worker allowlist preserves hook identity and behavior", () => {
    const hooks = { onPreToolUse: () => ({ permissionDecision: "allow" }) };
    assert.equal(withToolExecutionAllowlist(hooks, undefined), hooks);
    assert.equal(withToolExecutionAllowlist(undefined, undefined), undefined);
});

test("empty worker allowlist denies all tools; session allow cannot override it", async () => {
    let called = false;
    const hooks = withToolExecutionAllowlist({ onPreToolUse: () => { called = true; return { permissionDecision: "allow" }; } }, new Set());
    assert.equal((await hooks.onPreToolUse(input("bash"), {})).permissionDecision, "deny");
    assert.equal(called, false);
});

test("worker allows only exact names and preserves session denials and other hooks", async () => {
    const ended = () => {};
    const hooks = withToolExecutionAllowlist({ onSessionEnd: ended, onPreToolUse: () => ({ permissionDecision: "deny" }) }, new Set(["sandbox_exec"]));
    assert.equal(hooks.onSessionEnd, ended);
    assert.equal((await hooks.onPreToolUse(input("sandbox_exec"), {})).permissionDecision, "deny");
    for (const name of ["bash", "Sandbox_exec", "sandbox_exec_extra", "view"]) {
        assert.equal((await hooks.onPreToolUse(input(name), {})).permissionDecision, "deny");
    }
    assert.deepEqual(await withToolExecutionAllowlist(undefined, new Set(["sandbox_exec"])).onPreToolUse(input("sandbox_exec"), {}), {});
});

test("auxiliary and recovery SDK sessions receive the policy; omitted policy preserves options", async t => {
    const directory = mkdtempSync(join(tmpdir(), "ps-aux-guard-"));
    const manager = new SessionManager(undefined, null, { toolExecutionAllowlist: new Set(["sandbox_exec"]) }, directory);
    const unguarded = new SessionManager(undefined, null, {}, directory);
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const options = { model: "test-model" };
    assert.equal(unguarded.applyToolExecutionPolicy(options), options);
    const auxiliary = manager.applyToolExecutionPolicy(options);
    assert.equal((await auxiliary.hooks.onPreToolUse(input("bash"), {})).permissionDecision, "deny");
    let resumed;
    await manager._resumeCopilotSession({ resumeSession: async (_id, config) => { resumed = config; } }, "recovery", {});
    assert.equal((await resumed.hooks.onPreToolUse(input("bash"), {})).permissionDecision, "deny");
});

test("SessionManager applies the worker guard to every new session without per-session setup", async t => {
    const directory = mkdtempSync(join(tmpdir(), "ps-tool-guard-"));
    const captured = [];
    const manager = new SessionManager(undefined, null, { toolExecutionAllowlist: new Set(["sandbox_exec"]) }, directory);
    manager.ensureClient = async () => ({
        createSession: async config => {
            captured.push(config);
            return { sessionId: config.sessionId, on: () => () => {}, disconnect: async () => {} };
        },
    });
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }), storeFact: async () => ({}), deleteFact: async () => ({}) });
    t.after(async () => { await manager.shutdown(); rmSync(directory, { recursive: true, force: true }); });
    for (const id of ["one", "two"]) {
        manager.setConfig(id, { hooks: { onPreToolUse: () => ({ permissionDecision: "allow" }) } });
        await manager.getOrCreate(id, {}, { turnIndex: 0 });
    }
    assert.equal(captured.length, 2);
    for (const config of captured) {
        assert.equal((await config.hooks.onPreToolUse(input("bash"), {})).permissionDecision, "deny");
        assert.equal((await config.hooks.onPreToolUse(input("sandbox_exec"), {})).permissionDecision, "allow");
    }
});
