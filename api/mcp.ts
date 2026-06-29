// Vercel serverless function — RadMail MCP over streamable-HTTP.
//
// The live radmail-mcp project is a Node serverless deployment (Framework Preset
// = Node / "Other"). Each request gets a fresh server + transport in STATELESS
// mode (no sessionIdGenerator) with JSON responses — the clean shape for a
// stateless serverless function. Endpoint: POST /api/mcp.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "../src/server.js";

export const config = { runtime: "nodejs" };

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "GET") {
    // Health / discovery ping — not the MCP channel itself (which is POST).
    return new Response(
      JSON.stringify({
        name: "radmail-mcp",
        engine: "sandbox",
        transport: "streamable-http",
        endpoint: "/api/mcp",
        note: "POST JSON-RPC MCP requests here. Zero-auth sandbox; tools auto-provision a tenant.",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no session id generator. JSON responses (no long-lived SSE) suit
    // a serverless function with a per-request lifecycle.
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // Close the per-request server so it doesn't leak across invocations.
    await server.close().catch(() => {});
  }
}
