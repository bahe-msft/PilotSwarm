import { timingSafeEqual, createHash } from "node:crypto";

export function json(response, status, value) {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
}

export async function readJson(request, maxBytes = 65_536) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBytes) throw Object.assign(new Error("request too large"), { status: 413 });
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString());
    } catch {
        throw Object.assign(new Error("invalid JSON"), { status: 400 });
    }
}

export function authorized(request, token, header = "authorization") {
    const digest = value => createHash("sha256").update(value).digest();
    return timingSafeEqual(digest(request.headers[header] ?? ""), digest(`Bearer ${token}`));
}

export async function listen(server, port, host = "127.0.0.1") {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
    });
    return `http://${host}:${server.address().port}`;
}

export async function close(server) {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
