#!/usr/bin/env node
// Local stdio entry — `npx radmail-mcp` or `node dist/index.js`. Speaks the MCP
// stdio transport so a desktop agent host (Claude Desktop, etc.) can run RadMail
// locally. The Vercel deployment uses api/mcp.ts (streamable-HTTP) instead.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startupBanner } from "./lib/mode.js";
import { createServer } from "./server.js";
import { sendToolRequested } from "./lib/send.js";
import { triageToolsEnabled } from "./lib/inbox-actions.js";

async function main(): Promise<void> {
  // RADMAIL_SEND_TOOL=1 turns on the opt-in send_email tool — LOCAL entries only.
  // RADMAIL_TRIAGE_TOOLS=1 + RADMAIL_TRIAGE_API_KEY turn on the inbox-action tools — LOCAL entries only.
  const server = createServer({ enableSend: sendToolRequested(), enableTriage: triageToolsEnabled() });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error(startupBanner("running on stdio"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("radmail-mcp failed to start:", err);
  process.exit(1);
});
