#!/usr/bin/env -S node --import tsx
// Regenerate the frozen tool manifest — the DELIBERATE act that blesses a
// change to the published tool surface (names, descriptions, input schemas,
// server instructions). Anything else that changes the surface makes the
// server fail closed at startup (src/lib/manifest.ts).
//
// Run:  npm run manifest:regen
// Then: review the diff of src/tool-manifest.ts and commit it WITH the change.
//
// Refuses to freeze a surface that fails the anti-injection lint — a poisoned
// description must not be blessable by reflex.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// IMPORTANT (bootstrap): import SERVER_INSTRUCTIONS from server-info.ts, NOT
// server.ts — server.ts statically imports src/tool-manifest.ts, and this
// script must run when that artifact does not exist yet.
import { TOOL_DEFS, SEND_TOOL_DEF } from "../src/tools.js";
import { SERVER_INSTRUCTIONS, SEND_INSTRUCTIONS_ADDENDUM } from "../src/server-info.js";
import { computeToolManifest, lintToolDescriptions } from "../src/lib/manifest.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "tool-manifest.ts");
const SEND_OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "send-tool-manifest.ts");

const violations = [
  ...lintToolDescriptions(TOOL_DEFS, SERVER_INSTRUCTIONS),
  ...lintToolDescriptions([SEND_TOOL_DEF], SEND_INSTRUCTIONS_ADDENDUM),
];
if (violations.length > 0) {
  console.error("REFUSING to regenerate: the tool surface fails the anti-injection lint:");
  for (const v of violations) {
    console.error(`  ✗ [${v.rule}] ${v.surface}: "${v.excerpt}"`);
  }
  process.exit(1);
}

const manifest = computeToolManifest(TOOL_DEFS, SERVER_INSTRUCTIONS);

const banner = `// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Frozen manifest of the published MCP tool surface: one sha256 per tool over
// its canonical name + description + published JSON input schema, plus the
// server-instructions hash and one manifest hash over everything. On startup
// the server recomputes and compares (src/lib/manifest.ts) and REFUSES to
// serve tools on any mismatch — the fail-closed defense against
// tool-description poisoning (OWASP ASI02/ASI04; MCPTox).
//
// A legitimate change to any tool name/description/schema is a deliberate,
// diffable act:  npm run manifest:regen  — then review + commit this file.
// (No timestamp on purpose: an unchanged surface regenerates to a zero diff.)

import type { FrozenManifest } from "./lib/manifest.js";

export const TOOL_MANIFEST: FrozenManifest = `;

writeFileSync(OUT, banner + JSON.stringify(manifest, null, 2) + ";\n", "utf8");

console.log(`Wrote ${OUT}`);
console.log(`  server instructions  ${manifest.serverInstructionsSha256}`);
for (const t of manifest.tools) console.log(`  ${t.name.padEnd(26)} ${t.sha256}`);
console.log(`  MANIFEST             ${manifest.manifestSha256}`);
console.log("Review the diff of src/tool-manifest.ts and commit it with the surface change.");

// ── The opt-in send tool, frozen on its own ────────────────────────────────
// Kept OUT of the default manifest so a default install's surface (and every
// hash above) is untouched by its existence. Registered only by
// createServer({ enableSend: true }), which re-verifies against THIS file.
const sendManifest = computeToolManifest([SEND_TOOL_DEF], SEND_INSTRUCTIONS_ADDENDUM);
const sendBanner = `// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Frozen manifest of the OPT-IN send_email tool and the instructions addendum
// a send-enabled server appends. Verified by createServer({ enableSend: true })
// before the tool is registered; a mismatch refuses to serve. Regenerate with
//   npm run manifest:regen   — then review + commit this file.

import type { FrozenManifest } from "./lib/manifest.js";

export const SEND_TOOL_MANIFEST: FrozenManifest = `;
writeFileSync(SEND_OUT, sendBanner + JSON.stringify(sendManifest, null, 2) + ";\n", "utf8");
console.log(`Wrote ${SEND_OUT}`);
for (const t of sendManifest.tools) console.log(`  ${t.name.padEnd(26)} ${t.sha256}`);
console.log(`  SEND MANIFEST        ${sendManifest.manifestSha256}`);
