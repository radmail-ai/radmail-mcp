#!/usr/bin/env node
// Tool-contract check — the WORLD_CLASS leading metric, operationalized.
// Fails (exit 1) if the canonical tool names we ADVERTISE (mcp.json + llms.txt),
// REGISTER (the package server), and the LIVE hosted sandbox EXPOSES ever diverge.
// An agent that follows our published docs must find every canonical tool it's told to call.
//
// Run:  node scripts/check-tool-contract.mjs            (checks files + package + live hosted)
//       SKIP_LIVE=1 node scripts/check-tool-contract.mjs (offline: files + package only)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOSTED = "https://radmail.ai/api/mcp/sandbox";

// The canonical surface every advertised path must expose (matches the live hosted sandbox).
// NOTE (v0.3.0): `search`, `list_right_now`, and `list_commitments` are DUAL-MODE — they exist
// key-less in the sandbox (pass `messages`) so they stay LIVE-canonical here, and additionally
// go connected (real inbox, read-only) when RADMAIL_API_KEY is set on the package server.
const CANONICAL = [
  "triage_inbox",
  "list_right_now",
  "why_surfaced",
  "draft_reply",
  "list_commitments",
  "search",
];

// Canonical on the PACKAGE surface only. Connected mode (RADMAIL_API_KEY) rides the
// local npm/stdio package; the zero-auth hosted sandbox stays key-less by design, so
// these must be advertised (mcp.json + llms.txt) and registered by the package, but
// are NOT required of the live hosted sandbox. `read_email` is the only connected-ONLY
// tool (it has no sandbox mode) — the other connected tools live in CANONICAL above.
// `check_send_domain` is zero-auth (read-only DNS, no key) but ships in the package
// first; move it to CANONICAL once the hosted sandbox redeploys with it.
const PACKAGE_CANONICAL = ["read_email", "check_send_domain"];

const fail = [];
// ── 🔑 "I COULD NOT LOOK" IS NOT "I LOOKED AND IT DIVERGED" ─────────────────
// These were the same list until 2026-08-28. A missing `dist/` — the ordinary
// state of a fresh checkout — was counted among the CONTRACT BROKEN
// divergences, so the output said the published surface had drifted when the
// truth was that nothing had been built yet. The remedy text was right and the
// heading above it was wrong, which is the worse half to get wrong.
//
// Exit codes now follow the fleet contract:
//   0 = looked, and everything agrees
//   1 = looked, and something genuinely diverged
//   2 = could not look (no dist, sandbox unreachable)
//
// 1 outranks 2 when both happen, for the same reason `false` outranks `null` in
// migration-drift: both are bad, only one is actionable, and the caller should
// be told the thing it can act on.
const cannotVerify = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { fail.push(m); console.log(`  ✗ ${m}`); };
const blind = (m) => { cannotVerify.push(m); console.log(`  ⚠️  ${m}`); };

// 1. mcp.json advertises every canonical name
const mcpJson = JSON.parse(readFileSync(join(ROOT, "public/.well-known/mcp.json"), "utf8"));
const advertised = new Set(mcpJson.tools || []);
console.log("mcp.json advertised tools:");
for (const t of [...CANONICAL, ...PACKAGE_CANONICAL]) advertised.has(t) ? ok(t) : bad(`mcp.json missing canonical tool "${t}"`);

// 2. llms.txt mentions every canonical name
const llms = readFileSync(join(ROOT, "llms.txt"), "utf8");
console.log("llms.txt mentions:");
for (const t of [...CANONICAL, ...PACKAGE_CANONICAL]) llms.includes(`\`${t}\``) ? ok(t) : bad(`llms.txt missing canonical tool "${t}"`);

// 3. the package server actually registers every canonical name
console.log("package server registers (dist):");
let registered = new Set();
try {
  const mod = await import(join(ROOT, "dist/src/tools.js"));
  registered = new Set((mod.TOOL_DEFS || []).map((d) => d.name));
  for (const t of [...CANONICAL, ...PACKAGE_CANONICAL]) registered.has(t) ? ok(t) : bad(`server does not register canonical tool "${t}"`);
} catch (e) {
  blind(`could not import dist/src/tools.js — nothing was checked here (run \`npm run build\` first): ${e.message}`);
}

// 3b. THE BUILT ARTIFACT IS THE THING USERS RUN, AND IT WAS NEVER CHECKED.
//
// 🩸 Measured 2026-08-28 against the live registry: the published
// `radmail-mcp@0.5.0` tarball carries `package.json` at 0.5.0 and
// `dist/src/server-info.js` at **0.4.0**. So the server announced itself as a
// version two minors stale, for 16 days, to every agent that connected.
//
// 🔑 A test WAS pinning the version — test/manifest.test.ts asserts
// SERVER_INFO.version === package.json === public/.well-known/mcp.json — and it
// passed the entire time. It reads the SOURCE. `npm publish` ships `dist/`.
// A check can be perfectly rigorous about the wrong proposition.
//
// This closes that gap at the one place that already requires a real build.
console.log("built artifact is fresh (dist vs package.json):");
try {
  const pkgVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const info = await import(join(ROOT, "dist/src/server-info.js"));
  const built = info.SERVER_INFO?.version;
  if (built === pkgVersion) {
    ok(`dist/src/server-info.js reports ${built}, matching package.json`);
  } else {
    bad(
      `dist/src/server-info.js reports "${built}" but package.json is "${pkgVersion}" — ` +
        `dist is STALE. Publishing now would ship a server that misreports its own version, ` +
        `which is exactly what shipped as 0.5.0. Run \`npm run build\`.`,
    );
  }
} catch (e) {
  blind(`could not import dist/src/server-info.js — freshness unchecked: ${e.message}`);
}

// 4. the LIVE hosted sandbox exposes every canonical name
if (process.env.SKIP_LIVE) {
  console.log("live hosted sandbox: SKIPPED (SKIP_LIVE set)");
} else {
  console.log(`live hosted sandbox (${HOSTED}):`);
  try {
    const res = await fetch(HOSTED, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const text = await res.text();
    // Handle either plain JSON or an SSE "data:" frame.
    const jsonStr = text.includes("data:") ? text.split("data:").pop().trim() : text.trim();
    const live = new Set((JSON.parse(jsonStr).result?.tools || []).map((t) => t.name));
    for (const t of CANONICAL) live.has(t) ? ok(t) : bad(`live hosted sandbox does NOT expose canonical tool "${t}"`);
    console.log(`  (package-only tools not required live: ${PACKAGE_CANONICAL.join(", ")} — connected mode is key-gated, the hosted sandbox stays key-less)`);
  } catch (e) {
    // Same distinction: an unreachable sandbox is a fact about the network or
    // the deployment, not evidence that the tool list diverged.
    blind(`could not reach/parse live hosted sandbox — the live leg was NOT checked: ${e.message}`);
  }
}

console.log("");
if (fail.length) {
  // ⚠️ Deliberately no longer says "an agent would hit tool-not-found" as the
  // blanket reason. That is true of a missing TOOL and false of a stale dist
  // version, and a summary line that misdescribes half its own cases teaches
  // people to skim it.
  console.error(`CONTRACT BROKEN — ${fail.length} divergence(s) between what we publish and what we ship:`);
  for (const f of fail) console.error(`  ✗ ${f}`);
  if (cannotVerify.length) {
    console.error("");
    console.error(`…and ${cannotVerify.length} thing(s) could not be checked at all (listed below). Fix the divergence first.`);
    for (const c of cannotVerify) console.error(`  ⚠️  ${c}`);
  }
  process.exit(1);
}
if (cannotVerify.length) {
  console.error("");
  console.error(`CANNOT VERIFY — ${cannotVerify.length} check(s) could not run. This is NOT a passing contract,`);
  console.error(`and it is NOT a divergence either. Nothing was found wrong because nothing was looked at:`);
  for (const c of cannotVerify) console.error(`  ⚠️  ${c}`);
  process.exit(2);
}
console.log("CONTRACT OK — advertised = registered = live for all canonical tools, and dist matches package.json.");
