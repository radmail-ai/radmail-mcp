#!/usr/bin/env node
// Local stdio entry — `npx radmail-mcp` or `node dist/index.js`. Speaks the MCP
// stdio transport so a desktop agent host (Claude Desktop, etc.) can run RadMail
// locally. The Vercel deployment uses api/mcp.ts (streamable-HTTP) instead.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error("radmail-mcp (sandbox engine) running on stdio");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("radmail-mcp failed to start:", err);
  process.exit(1);
});
