import { createServer } from "node:http";
import { createDefaultDeps } from "./runtime";
import { createBotRuntimeApp } from "./app";

const app = createBotRuntimeApp(createDefaultDeps(process.env));
const port = Number(process.env.PORT ?? "8787");
const maxRequestBodyBytes = 5 * 1024 * 1024;

// The handler must never throw: an unhandled rejection would take down the
// whole process and every in-flight meeting recording with it.
createServer(async (req, res) => {
  try {
    req.on("error", () => {
      // Client aborted mid-body; the read loop below rejects and is caught.
    });
    const url = safeRequestUrl(req.url, req.headers.host);
    if (!url) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Invalid request URL" }));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxRequestBodyBytes) {
        res.writeHead(413, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ detail: "Request body is too large" }));
        // The remaining body was not consumed; close the socket so the
        // keep-alive connection cannot deliver it as a phantom request.
        res.destroy();
        return;
      }
      chunks.push(buffer);
    }
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    const response = await app.fetch(
      new Request(url, {
        method: req.method,
        headers: normalizeHeaders(req.headers),
        body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined
      })
    );
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    res.writeHead(response.status, headers);
    const responseBody = response.body ? Buffer.from(await response.arrayBuffer()) : undefined;
    res.end(responseBody);
  } catch (error) {
    console.error("bot runtime request failed", error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ detail: "Internal error" }));
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`meeting bot runtime listening on ${port}`);
});

function safeRequestUrl(path: string | undefined, host: string | undefined): URL | null {
  try {
    return new URL(path ?? "/", `http://${host || `127.0.0.1:${port}`}`);
  } catch {
    return null;
  }
}

function normalizeHeaders(headers: NodeJS.Dict<string | string[]>): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, item);
    } else {
      result.set(key, value);
    }
  }
  return result;
}
