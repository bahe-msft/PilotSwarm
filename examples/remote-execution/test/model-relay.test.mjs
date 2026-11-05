import assert from "node:assert/strict";
import { test } from "node:test";
import { createModelRelay } from "../model-relay.mjs";
import { runModelBridge } from "../model-bridge.mjs";
import { close, listen } from "../http.mjs";

test("host bridge forwards real request bodies and streaming responses without model credentials in the relay", async t => {
    const server = createModelRelay({ token: "local-relay" });
    const url = await listen(server, 0);
    const stop = new AbortController();
    let received;
    const bridge = runModelBridge({
        url, token: "local-relay", signal: stop.signal,
        complete: async body => {
            received = body;
            return { status: 200, contentType: "text/event-stream", body: "data: bridge-result\n\ndata: [DONE]\n\n" };
        },
    }).catch(error => { if (!stop.signal.aborted) throw error; });
    t.after(async () => { stop.abort(); await bridge; await close(server); });
    const response = await fetch(url + "/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer local-relay", "content-type": "application/json" },
        body: JSON.stringify({ model: "local", messages: [{ role: "user", content: "test prompt" }], stream: true }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /bridge-result/);
    assert.equal(received.messages[0].content, "test prompt");
    assert.equal(received.authorization, undefined);
    assert.equal((await fetch(url + "/bridge/next", { headers: { authorization: "Bearer wrong" } })).status, 401);
});

test("relay fails closed when no host provider responds", async t => {
    const server = createModelRelay({ token: "local-relay", timeoutMs: 50 });
    const url = await listen(server, 0);
    t.after(() => close(server));
    const response = await fetch(url + "/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer local-relay" }, body: "{}",
    });
    assert.equal(response.status, 504);
});
