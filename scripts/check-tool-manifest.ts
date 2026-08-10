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

import { TOOL_DEFS } from "../src/tools.js";
import { SERVER_INSTRUCTIONS } from "../src/server-info.js";
import { TOOL_MANIFEST } from "../src/tool-manifest.js";
import { assertToolManifest } from "../src/lib/manifest.js";

try {
  assertToolManifest(TOOL_DEFS, SERVER_INSTRUCTIONS, TOOL_MANIFEST);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

console.log(
  `manifest:check OK — ${TOOL_MANIFEST.tools.length} tools + server instructions match the frozen manifest (${TOOL_MANIFEST.manifestSha256.slice(0, 12)}…).`,
);
