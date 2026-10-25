// MCP server factory — registers the RadMail tools onto an McpServer from
// @modelcontextprotocol/sdk. Used by both the stdio entries (src/index.ts,
// src/stdio.ts) and the Vercel streamable-HTTP handler (api/mcp.ts).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_DEFS, SEND_TOOL_DEF, TRIAGE_TOOL_DEFS, type ToolDef, type ToolContext } from "./tools.js";
import { SAFETY_BLOCK, setSendSurfaceActive, setTriageSurfaceActive } from "./lib/taint.js";
import { assertToolManifest } from "./lib/manifest.js";
import { getConnectedConfig, type ConnectedConfig } from "./lib/connected.js";
import { getTriageConfig } from "./lib/inbox-actions.js";
import { TOOL_MANIFEST } from "./tool-manifest.js";
import { SEND_TOOL_MANIFEST } from "./send-tool-manifest.js";
import { TRIAGE_TOOL_MANIFEST } from "./triage-tool-manifest.js";
import {
  SERVER_INFO,
  SERVER_INSTRUCTIONS,
  SEND_INSTRUCTIONS_ADDENDUM,
  TRIAGE_INSTRUCTIONS_ADDENDUM,
} from "./server-info.js";

// Identity + instructions live in server-info.ts (a leaf module with no
// dependency on the frozen manifest artifact) so manifest:regen can import
// them even when src/tool-manifest.ts does not exist yet. Re-exported here for
// existing consumers.
export { SERVER_INFO, SERVER_INSTRUCTIONS };

export interface CreateServerOptions {
  /**
   * Register the opt-in `send_email` tool. ONLY the local stdio entries pass
   * this, and only when RADMAIL_SEND_TOOL=1. The hosted HTTP entries
   * (api/mcp.ts, src/http.ts) never pass it, so a shared endpoint can never
   * send as whoever's key is in its environment.
   */
  enableSend?: boolean;
  /**
   * Register the opt-in inbox-action tools (archive / snooze / read state /
   * labels). ONLY the local stdio entries pass this, and only when
   * RADMAIL_TRIAGE_TOOLS=1 AND RADMAIL_TRIAGE_API_KEY is set. The hosted entries
   * never pass it: the hosted surface stays non-destructive.
   */
  enableTriage?: boolean;
  /**
   * The read key for connected mode, decided by the CALLER.
   *   undefined (omitted) → read RADMAIL_API_KEY from the environment (local servers)
   *   null                → sandbox only, whatever the environment holds
   *   a config            → this key only (the hosted endpoint passes the
   *                         request's own bearer here, or null without one)
   */
  connected?: ConnectedConfig | null;
  /** The shared hosted endpoint: tools that would write to this machine refuse. */
  hosted?: boolean;
}

export function createServer(opts: CreateServerOptions = {}): McpServer {
  // Anti-poisoning gate (OWASP ASI02/ASI04): recompute the sha256 of every
  // tool's name + description + published input schema (+ annotations) and
  // compare against the checked-in frozen manifest (src/tool-manifest.ts). Any
  // divergence — a tampered install, a poisoned description, or an unblessed
  // edit — throws here, BEFORE a single tool is registered: fail closed, serve
  // nothing.
  assertToolManifest(TOOL_DEFS, SERVER_INSTRUCTIONS, TOOL_MANIFEST);

  // Each opt-in surface is frozen in its OWN manifest, so turning it on cannot
  // smuggle an unblessed description in, and leaving it off changes nothing.
  const enableSend = opts.enableSend === true;
  const enableTriage = opts.enableTriage === true;
  if (enableSend) assertToolManifest([SEND_TOOL_DEF], SEND_INSTRUCTIONS_ADDENDUM, SEND_TOOL_MANIFEST);
  if (enableTriage) assertToolManifest(TRIAGE_TOOL_DEFS, TRIAGE_INSTRUCTIONS_ADDENDUM, TRIAGE_TOOL_MANIFEST);
  const defs: ToolDef[] = [
    ...TOOL_DEFS,
    ...(enableSend ? [SEND_TOOL_DEF] : []),
    ...(enableTriage ? TRIAGE_TOOL_DEFS : []),
  ];
  // Every response's safety block must tell the truth about THIS server.
  setSendSurfaceActive(enableSend);
  setTriageSurfaceActive(enableTriage);

  // One context per server, built once. On the hosted endpoint `connected` is
  // the request's own bearer (or null) — never a process-wide key.
  const ctx: ToolContext = {
    connected: opts.connected !== undefined ? opts.connected : getConnectedConfig(),
    triage: enableTriage ? getTriageConfig() : null,
    hosted: opts.hosted === true,
  };

  const instructions = [
    SERVER_INSTRUCTIONS,
    ...(enableSend ? [SEND_INSTRUCTIONS_ADDENDUM] : []),
    ...(enableTriage ? [TRIAGE_INSTRUCTIONS_ADDENDUM] : []),
  ].join(" ");

  const server = new McpServer(SERVER_INFO, {
    instructions,
    capabilities: { tools: {} },
  });

  // FREEZE SCOPE: the manifest freezes exactly what this loop registers from
  // TOOL_DEFS — name, description, input schema, annotations — plus the
  // instructions. Registration-call fields NOT sourced from TOOL_DEFS (a
  // `title`, an extra registerTool() outside this loop) would publish
  // agent-facing text OUTSIDE the freeze. Don't add them here without
  // extending the manifest to cover them.
  for (const def of defs) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.inputSchema,
        ...(def.annotations ? { annotations: { ...def.annotations } } : {}),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (args: any) => {
        const result = await def.handler(args, ctx);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      },
    );
  }

  return server;
}

// Re-export the safety contract so consumers / a /.well-known route can serve it.
export { SAFETY_BLOCK };
