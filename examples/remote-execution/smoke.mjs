import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PilotSwarmClient } from "pilotswarm-sdk";
import { api, events, portalUrl, waitForRemoteResult } from "./smoke-support.mjs";

const phase = process.argv[2];
assert.ok(["first", "resume"].includes(phase), "expected first or resume");
const filename = process.env.REMOTE_EVIDENCE_FILE;
assert.ok(filename, "REMOTE_EVIDENCE_FILE required");
const clients = new Map();
const getClient = async user => {
    if (!clients.has(user)) {
        const client = new PilotSwarmClient({ apiUrl: portalUrl, getAccessToken: async () => `dev:${user}` });
        await client.start();
        clients.set(user, client);
    }
    return clients.get(user);
};
try {
    let records = phase === "first" ? [] : JSON.parse(await readFile(filename, "utf8"));
    for (const user of ["alice", "bob"]) {
        const client = await getClient(user);
        let record = records.find(record => record.user === user);
        const session = phase === "first"
            ? await client.createSessionForAgent("remote-coder", { title: `Remote execution ${user}` })
            : await client.resumeSession(record.sessionId);
        const nonce = record?.nonce ?? `proof-${randomUUID()}`;
        const before = await events(session.sessionId, user);
        const afterSeq = Math.max(0, ...before.map(event => event.seq));
        const prompt = phase === "first"
            ? `Use sandbox_exec to run exactly: printf '%s' '${nonce}' > proof.txt; cat proof.txt; hostname. Report the file contents after checking the tool result.`
            : "Use sandbox_exec to read proof.txt from the existing remote working folder and run hostname. Do not write or recreate the file. Report its contents.";
        const answer = await session.sendAndWait(prompt, 180_000);
        assert.ok(answer.includes(nonce), "real model answer must include the verified file contents");
        const { job, history } = await waitForRemoteResult(session.sessionId, user, afterSeq, nonce);
        if (phase === "first") {
            record = { user, sessionId: session.sessionId, nonce, executor: job.executor };
            records.push(record);
        } else {
            assert.equal(job.executor, record.executor, "cold worker must reuse the existing executor");
            assert.ok(history.some(event => event.eventType === "session.hydrated"), "conversation must hydrate after worker replacement");
        }
        record.lastSeq = Math.max(...history.map(event => event.seq));
        console.log(JSON.stringify({ phase, user, sessionId: session.sessionId, executor: job.executor, remoteExecution: "PASS" }));
    }
    assert.notEqual(records[0].sessionId, records[1].sessionId);
    assert.notEqual(records[0].executor, records[1].executor, "sessions need distinct executors");
    const denied = await fetch(`${portalUrl}/api/v1/sessions/${records[0].sessionId}`, { headers: { authorization: "Bearer dev:bob" }, signal: AbortSignal.timeout(10_000) });
    assert.equal(denied.status, 404, "Bob must not read Alice's private session");
    await writeFile(filename, JSON.stringify(records), { mode: 0o600 });
    console.log(JSON.stringify({ phase, ownerIsolation: "PASS", liveModel: "PASS" }));
} finally {
    await Promise.all([...clients.values()].map(client => client.stop()));
}
