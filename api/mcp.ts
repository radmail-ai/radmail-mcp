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
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "../src/server.js";
import { SERVER_INSTRUCTIONS } from "../src/server-info.js";
import { TOOL_DEFS } from "../src/tools.js";
import { TOOL_MANIFEST } from "../src/tool-manifest.js";
import { verifyToolManifest, type ManifestVerification } from "../src/lib/manifest.js";
import { checkRateLimit, clientIp } from "../src/lib/rate-limit.js";

/** JSON-RPC-shaped fail-closed response for a tool-manifest mismatch. MCP
 *  clients get a named -32000 error instead of a bare platform 500 — fail
 *  loud, not opaque. Exported for tests. */
export function manifestMismatchResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "server disabled: tool manifest mismatch — the published tool surface failed fail-closed " +
          "verification against the frozen manifest (tool-description poisoning defense). " +
          "No tools are served until the surface is re-blessed (npm run manifest:regen) and redeployed.",
      },
      id: null,
    }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}

/** Health/discovery body. The health check runs the SAME manifest verification
 *  the serving path enforces — a drifted deploy must read 503 here, not
 *  "healthy" while every POST fails. Exported (with injectable verification)
 *  for tests. */
export function healthResponse(
  verification: ManifestVerification = verifyToolManifest(TOOL_MANIFEST, TOOL_DEFS, SERVER_INSTRUCTIONS),
): Response {
  if (!verification.ok) {
    return new Response(
      JSON.stringify({
        name: "radmail-mcp",
        status: "disabled",
        error: "server disabled: tool manifest mismatch — fail-closed (tool-description poisoning defense)",
        mismatches: verification.mismatches,
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(
    JSON.stringify({
      name: "radmail-mcp",
      engine: "sandbox",
      transport: "streamable-http",
      endpoint: "/api/mcp",
      toolManifest: "verified",
      note: "POST JSON-RPC MCP requests here. Zero-auth sandbox; tools auto-provision a tenant.",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export async function GET(): Promise<Response> {
  // Health / discovery ping — not the MCP channel itself (which is POST).
  return healthResponse();
}

export async function POST(req: Request): Promise<Response> {
  // Zero-auth endpoint — 60 req/min per IP (matches the radmail-web sandbox
  // MCP's throttle; a normal agent conversation is a few calls/min, so this
  // only bites loops). 429 is a proper JSON-RPC-shaped error so MCP clients
  // fail loud rather than hanging.
  const rl = checkRateLimit(`mcp:${clientIp(req)}`, 60, 60_000);
  if (!rl.ok) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: `Rate limited — retry in ${rl.retryAfterSeconds}s (60 requests/min per IP on the zero-auth sandbox).` },
        id: null,
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(rl.retryAfterSeconds),
        },
      },
    );
  }

  // createServer() runs the fail-closed manifest gate and THROWS on drift —
  // keep it inside a try so the refusal reaches the client as a JSON-RPC
  // -32000 "server disabled", not a bare platform 500.
  let server: McpServer;
  try {
    server = createServer();
  } catch (err) {
    if (err instanceof Error && err.message.includes("TOOL MANIFEST MISMATCH")) {
      return manifestMismatchResponse();
    }
    throw err;
  }

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
