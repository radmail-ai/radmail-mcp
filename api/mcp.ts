// Vercel serverless function — RadMail MCP over streamable-HTTP.
//
// The live radmail-mcp project is a Node serverless deployment. Each request
// gets a fresh server + transport in STATELESS mode (no sessionIdGenerator)
// with JSON responses — the clean shape for a stateless serverless function.
// Endpoint: POST /api/mcp.
//
// NOTE: uses the Web-handler signature via NAMED method exports (GET/POST).
// Current @vercel/node invokes a DEFAULT export in Node (req,res) style and
// ignores a returned web `Response` (the function then 504s); named method
// exports select the web signature unambiguously.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "../src/server.js";

export async function GET(): Promise<Response> {
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

export async function POST(req: Request): Promise<Response> {
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

export async function DELETE(): Promise<Response> {
  // Stateless server — there is no session to tear down.
  return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
}
