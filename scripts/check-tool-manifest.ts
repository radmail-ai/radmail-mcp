#!/usr/bin/env -S node --import tsx
// Pre-prod drift gate — run as `prebuild` (and `npm run manifest:check`).
//
// Without this, a drifted tool surface compiles, deploys, and only then fails
// closed at runtime on every request — an outage discovered in prod. Running
// assertToolManifest at BUILD time turns the same failure into a red build.
//
// Exit 0: the live surface matches the frozen manifest (src/tool-manifest.ts).
// Exit 1: mismatch — the error names every divergence and the remedy
//         (npm run manifest:regen for a deliberate change or converter drift).

import { TOOL_DEFS, SEND_TOOL_DEF, TRIAGE_TOOL_DEFS } from "../src/tools.js";
import { SERVER_INSTRUCTIONS, SEND_INSTRUCTIONS_ADDENDUM, TRIAGE_INSTRUCTIONS_ADDENDUM } from "../src/server-info.js";
import { TOOL_MANIFEST } from "../src/tool-manifest.js";
import { SEND_TOOL_MANIFEST } from "../src/send-tool-manifest.js";
import { TRIAGE_TOOL_MANIFEST } from "../src/triage-tool-manifest.js";
import { assertToolManifest } from "../src/lib/manifest.js";

try {
  assertToolManifest(TOOL_DEFS, SERVER_INSTRUCTIONS, TOOL_MANIFEST);
  // The opt-in send tool is frozen separately; check it here too, or a drifted
  // send_email would build green and fail only when an operator turns it on.
  assertToolManifest([SEND_TOOL_DEF], SEND_INSTRUCTIONS_ADDENDUM, SEND_TOOL_MANIFEST);
  // Same for the opt-in inbox-action tools (RADMAIL_TRIAGE_TOOLS=1).
  assertToolManifest(TRIAGE_TOOL_DEFS, TRIAGE_INSTRUCTIONS_ADDENDUM, TRIAGE_TOOL_MANIFEST);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

console.log(
  `manifest:check OK — ${TOOL_MANIFEST.tools.length} tools + server instructions match the frozen manifest (${TOOL_MANIFEST.manifestSha256.slice(0, 12)}…); ` +
    `opt-in send (${SEND_TOOL_MANIFEST.tools.length}) and inbox-action (${TRIAGE_TOOL_MANIFEST.tools.length}) manifests match too.`,
);
