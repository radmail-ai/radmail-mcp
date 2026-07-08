/**
 * RadMail MCP — Streamable-HTTP entry.
 *
 * For remote agents connecting over HTTP. Implements the MCP Streamable HTTP
 * transport: POST /mcp (client->server + streamed responses), GET /mcp
 * (server->client SSE stream), DELETE /mcp (session teardown). Stateful: a
 * session id is minted on `initialize` and echoed via the Mcp-Session-Id
 * header; we keep one McpServer + transport per session.
 *
 * Auth/tenant: the per-call resolver reads the tenant token + agent id from
 * the request headers (Authorization: Bearer / X-RadMail-Token /
 * X-RadMail-Agent) OR from tool args. Header-derived context flows through MCP
 * `extra.requestInfo.headers` into the tool callbacks. No header is required —
 * an agent can still go zero -> triage in one call (auto-provision).
 *
 *   node dist/http.js          # PORT defaults to 8787
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

/** Live sessions: sessionId -> transport (each owns one McpServer). */
const transports = new Map<string, StreamableHTTPServerTransport>();

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function sessionIdOf(req: IncomingMessage): string | undefined {
  const v = req.headers["mcp-session-id"];
  return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sid = sessionIdOf(req);

  if (req.method === "POST") {
    const body = await readBody(req);
    let transport = sid ? transports.get(sid) : undefined;

    if (!transport && isInitializeRequest(body)) {
      // New session: spin up a fresh server + transport.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          transports.set(id, transport!);
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) transports.delete(transport!.sessionId);
      };
      const server = createServer();
      await server.connect(transport);
    }

    if (!transport) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "No session. Send an initialize request first." },
          id: null,
        }),
      );
      return;
    }
    await transport.handleRequest(req, res, body);
    return;
  }

  if (req.method === "GET" || req.method === "DELETE") {
    const transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      res.writeHead(400).end("Unknown or missing Mcp-Session-Id");
      return;
    }
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(405).end("Method Not Allowed");
}

const http = createHttpServer((req, res) => {
  const url = (req.url ?? "").split("?")[0];

  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, server: "radmail-mcp", engine: "sandbox", sessions: transports.size }));
    return;
  }

  if (url === MCP_PATH) {
    handleMcp(req, res).catch((err) => {
      process.stderr.write(`radmail-mcp http error: ${String(err)}\n`);
      if (!res.headersSent) res.writeHead(500).end("Internal error");
    });
    return;
  }

  res.writeHead(404).end("Not found");
});

http.listen(PORT, () => {
  process.stderr.write(`radmail-mcp (sandbox engine) listening on http://localhost:${PORT}${MCP_PATH}\n`);
});
