import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { json, listen, readJson } from "../http.mjs";

/** Deterministic Chat Completions fixture. The Copilot SDK/CLI and tool execution remain real. */
export function createModel({ toolName = "sandbox_exec" } = {}) {
    const incarnation = randomUUID();
    let requests = 0;
    return createServer(async (request, response) => {
        try {
            if (request.method === "GET" && request.url === "/health") return json(response, 200, { requests });
            if (request.method !== "POST" || request.url !== "/v1/chat/completions") return json(response, 404, { error: "not found" });
            const body = await readJson(request, 8 * 1024 * 1024);
            requests++;
            const last = body.messages?.at(-1);
            const marker = /REMOTE_EXEC:([A-Za-z0-9+/=]+)/.exec(JSON.stringify(last?.content ?? ""));
            const useTool = last?.role === "user" && Boolean(marker);
            if (useTool && !body.tools?.some(tool => tool.function?.name === toolName)) {
                return json(response, 400, { error: "requested tool declaration missing" });
            }
            const message = useTool ? {
                role: "assistant", content: null,
                tool_calls: [{
                    id: `remote-call-${incarnation}-${requests}`, type: "function",
                    function: { name: toolName, arguments: JSON.stringify({
                        command: Buffer.from(marker[1], "base64").toString(),
                        ...(toolName === "sandbox_exec" ? { timeoutMs: 10_000 } : { description: "Remote execution worker-local denial probe" }),
                    }) },
                }],
            } : {
                role: "assistant",
                content: last?.role === "tool" ? `REMOTE_RESULT ${last.content}` : "Remote execution sandbox test",
            };
            const finish_reason = useTool ? "tool_calls" : "stop";
            const envelope = { id: `remote-${incarnation}-${requests}`, created: Math.floor(Date.now() / 1000), model: body.model };
            const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 };
            if (!body.stream) return json(response, 200, {
                ...envelope, object: "chat.completion", choices: [{ index: 0, message, finish_reason }], usage,
            });
            response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
            const delta = useTool ? { ...message, tool_calls: message.tool_calls.map(call => ({ index: 0, ...call })) } : message;
            for (const [part, finish] of [[delta, null], [{}, finish_reason]]) {
                response.write(`data: ${JSON.stringify({
                    ...envelope, object: "chat.completion.chunk",
                    choices: [{ index: 0, delta: part, finish_reason: finish }], ...(finish ? { usage } : {}),
                })}\n\n`);
            }
            response.end("data: [DONE]\n\n");
        } catch {
            json(response, 400, { error: "invalid model request" });
        }
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await listen(createModel(), Number(process.env.PORT ?? 8081), "0.0.0.0");
    console.log("deterministic model fixture ready");
}
