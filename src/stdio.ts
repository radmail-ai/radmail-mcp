#!/usr/bin/env node
/**
 * RadMail MCP — stdio entry.
 *
 * For local agents (Claude Desktop, IDE clients, anything that spawns an MCP
 * server as a subprocess). One server instance over one stdio transport.
 *
 *   radmail-mcp        # via bin
 *   node dist/stdio.js
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC channel — diagnostics must go to stderr.
  process.stderr.write("radmail-mcp (sandbox engine) ready on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`radmail-mcp fatal: ${String(err)}\n`);
  process.exit(1);
});
