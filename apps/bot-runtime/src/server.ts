import { createServer } from "node:http";
import { createDefaultDeps } from "./runtime";
import { createBotRuntimeApp } from "./app";

const app = createBotRuntimeApp(createDefaultDeps(process.env));
const port = Number(process.env.PORT ?? "8787");
const maxRequestBodyBytes = 5 * 1024 * 1024;

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `127.0.0.1:${port}`}`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxRequestBodyBytes) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Request body is too large" }));
      return;
    }
    chunks.push(buffer);
  }
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  const response = await app.fetch(
    new Request(url, {
      method: req.method,
      headers: req.headers as HeadersInit,
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
}).listen(port, "0.0.0.0", () => {
  console.log(`meeting bot runtime listening on ${port}`);
});
