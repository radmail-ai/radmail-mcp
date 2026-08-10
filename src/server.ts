// MCP server factory — registers all 9 RadMail tools onto an McpServer from
// @modelcontextprotocol/sdk. Used by both the stdio entry (src/index.ts) and the
// Vercel streamable-HTTP handler (api/mcp.ts).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_DEFS } from "./tools.js";
import { SAFETY_BLOCK } from "./lib/taint.js";
import { assertToolManifest } from "./lib/manifest.js";
import { TOOL_MANIFEST } from "./tool-manifest.js";
import { SERVER_INFO, SERVER_INSTRUCTIONS } from "./server-info.js";

// Identity + instructions live in server-info.ts (a leaf module with no
// dependency on the frozen manifest artifact) so manifest:regen can import
// them even when src/tool-manifest.ts does not exist yet. Re-exported here for
// existing consumers.
export { SERVER_INFO, SERVER_INSTRUCTIONS };

export function createServer(): McpServer {
  // Anti-poisoning gate (OWASP ASI02/ASI04): recompute the sha256 of every
  // tool's name + description + published input schema and compare against the
  // checked-in frozen manifest (src/tool-manifest.ts). Any divergence — a
  // tampered install, a poisoned description, or an unblessed edit — throws
  // here, BEFORE a single tool is registered: fail closed, serve nothing.
  assertToolManifest(TOOL_DEFS, SERVER_INSTRUCTIONS, TOOL_MANIFEST);

  const server = new McpServer(SERVER_INFO, {
    instructions: SERVER_INSTRUCTIONS,
    capabilities: { tools: {} },
  });

  // FREEZE SCOPE: the manifest freezes exactly what this loop registers from
  // TOOL_DEFS — name, description, input schema — plus SERVER_INSTRUCTIONS.
  // Registration-call fields NOT sourced from TOOL_DEFS (a `title`, an
  // `annotations` object, an extra registerTool() outside this loop) would
  // publish agent-facing text OUTSIDE the freeze. Don't add them here without
  // extending the manifest to cover them.
  for (const def of TOOL_DEFS) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.inputSchema },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (args: any) => {
        const result = await def.handler(args);
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
