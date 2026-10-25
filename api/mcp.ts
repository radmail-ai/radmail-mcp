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
//
// ── CONNECTED MODE, PER REQUEST (preview, 0.6.0) — DARK BY DEFAULT ─────────
// 🛑 OFF unless RADMAIL_HOSTED_BEARER is exactly "1". Merging this file
// Vercel-deploys it, and the published agent-safety contract says the hosted
// endpoint is sandbox-only, so the capability ships switched off: with the
// flag unset (or anything but "1") a bearer is IGNORED exactly as before this
// change — no connected mode, no 401 — and the endpoint is sandbox-only.
// Doug turns it on. Nothing in this repo sets the variable.
//
// With the flag on, a request carrying `Authorization: Bearer tmk_…` gets a server whose
// connected read tools use THAT key, for THAT request only. There is no
// process-wide key on this endpoint: a request without a bearer is sandbox-only
// exactly as before, even if RADMAIL_API_KEY happens to be set on the
// deployment. The opt-in send and inbox-action tools are never registered here,
// whatever the environment says, so the hosted surface stays non-destructive.
// 🛑 The key is never logged, echoed or put in any response — not even a prefix.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "../src/server.js";
import { SERVER_INSTRUCTIONS } from "../src/server-info.js";
import { TOOL_DEFS } from "../src/tools.js";
import { DEFAULT_API_URL, type ConnectedConfig } from "../src/lib/connected.js";
import { TOOL_MANIFEST } from "../src/tool-manifest.js";
import { verifyToolManifest, type ManifestVerification } from "../src/lib/manifest.js";
import { checkRateLimit, clientIp } from "../src/lib/rate-limit.js";

/** The switch. Exactly "1" turns the hosted bearer on; anything else (unset, "true", "0", "") is off. */
export const HOSTED_BEARER_FLAG = "RADMAIL_HOSTED_BEARER";
export function hostedBearerEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[HOSTED_BEARER_FLAG] === "1";
}

/** The documented RadMail key shape: tmk_live_ or tmk_test_ + 40 hex characters. */
const RADMAIL_KEY_RE = /^tmk_(?:live|test)_[0-9a-f]{40}$/;

export type BearerResolution =
  | { kind: "none" }
  | { kind: "connected"; cfg: ConnectedConfig }
  | { kind: "malformed" };

/**
 * Decide what this ONE request's Authorization header means. Exported for tests.
 *   · the hosted-bearer flag is off → sandbox, whatever the header says (as before)
 *   · no header, or a bearer that is not a RadMail key (`tmk_…`) → sandbox, as before
 *   · a well-formed RadMail key → connected read tools with that key, this request only
 *   · something that starts like a RadMail key but is malformed → refused (401), so a
 *     typo is never silently served the demo inbox as if it were the user's
 * The API host comes from RADMAIL_API_URL (a host, not a secret) or the default.
 */
export function resolveBearer(
  req: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
): BearerResolution {
  // DARK: with the flag off the header is not even read, so the request is
  // handled exactly as it was before the hosted bearer existed.
  if (!hostedBearerEnabled(env)) return { kind: "none" };
  const header = req.headers.get("authorization");
  if (!header) return { kind: "none" };
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  if (!m) return { kind: "none" };
  const token = m[1];
  if (!token.startsWith("tmk_")) return { kind: "none" };
  if (!RADMAIL_KEY_RE.test(token)) return { kind: "malformed" };
  const apiUrl = (env.RADMAIL_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
  return { kind: "connected", cfg: { apiKey: token, apiUrl } };
}

/** 401 for a malformed RadMail key. Names the expected shape, never the value sent. */
export function malformedBearerResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message:
          "The Authorization header carries something that starts like a RadMail API key but is not one " +
          "(expected tmk_live_ or tmk_test_ followed by 40 hex characters). Nothing was read. Copy the key again " +
          "from https://app.radmail.ai/settings/api-keys, or send no Authorization header for the sandbox.",
      },
      id: null,
    }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

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
      connectedPreview: {
        status: hostedBearerEnabled() ? "preview" : "off",
        enabled: hostedBearerEnabled(),
        flag: `${HOSTED_BEARER_FLAG}=1 turns it on; while off, a bearer is ignored and this endpoint is sandbox-only`,
        how: "when on: send Authorization: Bearer tmk_… (a RadMail API key) on each POST; that request's connected read tools use that key",
        tools: "read tools only (search, read_email, read_thread, list_emails, list_right_now, list_commitments, list_prepared_drafts, list_watched_threads)",
        never: "no send and no inbox-action tool is registered on this endpoint, with or without a key; no key is stored, logged or echoed",
      },
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

  // Per-request connected mode: this request's own bearer, or none. Never a
  // process-wide key, and never the opt-in send / inbox-action tools.
  const bearer = resolveBearer(req);
  if (bearer.kind === "malformed") return malformedBearerResponse();
  const connected = bearer.kind === "connected" ? bearer.cfg : null;

  // createServer() runs the fail-closed manifest gate and THROWS on drift —
  // keep it inside a try so the refusal reaches the client as a JSON-RPC
  // -32000 "server disabled", not a bare platform 500.
  let server: McpServer;
  try {
    server = createServer({ connected, hosted: true });
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
