#!/usr/bin/env node
// EMIT ONE FILE AN ORG CAN VENDOR — RadMail's pure engine core — and a hash that
// proves which version it is.
//
//   node scripts/bundle-engine.mjs           # writes engine-dist/ and prints the hash
//   node scripts/bundle-engine.mjs --check   # exit 1 if engine-dist/ is stale (CI)
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// The hosted product cannot serve a regulated org whose regime forbids its
// subprocessors (VRG: CUI; GreenWellness: PHI) — the lane decision blocks the
// push rail. But the part of RadMail those orgs need most on their own inbox
// surfaces — the BEC hard-stop detector (changed banking, money, decision,
// prompt injection) — is pure TypeScript with no network, no DB, no model.
// It can run IN-PROCESS inside the org's own app, so no email content leaves.
//
// Same pattern as the feedback-engine: one concatenated file, a sha256 over
// the SOURCE modules stamped in its header, an installer that copies it into
// `<repo>/vendor/` with the hash beside it, and a verify line the consumer can
// run. Unverifiable vendoring drifts silently; a copy with a hash drifts loudly.
//
// ── WHAT IS IN IT ───────────────────────────────────────────────────────────
// ORDER matters: later modules may reference earlier ones. Imports between
// them are stripped (they are all one file now); nothing else is rewritten,
// so the bundled text is byte-identical to the modules it came from.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ENGINE_ORDER = ["engine/types.ts", "engine/send-disposition.ts"];
export const OUT_DIR = join(ROOT, "engine-dist");
export const OUT_FILE = join(OUT_DIR, "radmail-engine.bundle.ts");
export const HASH_FILE = join(OUT_DIR, "RADMAIL-ENGINE.sha256");

const IMPORT_LINE = /^import\s[\s\S]*?from\s+["'][^"']+["'];?[ \t]*(\/\/.*)?$/gm;

export function buildBundle(readModule = (rel) => readFileSync(join(ROOT, "src", rel), "utf8")) {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const parts = ENGINE_ORDER.map((rel) => {
    const src = readModule(rel);
    const stripped = src.replace(IMPORT_LINE, (m) => `// (bundled — import removed: ${m.replace(/\s+/g, " ").slice(0, 90)})`);
    return `// ═══ module: src/${rel} ═══\n${stripped.trim()}\n`;
  });
  const body = parts.join("\n");
  const hash = createHash("sha256").update(body).digest("hex");
  const header = [
    "// RADMAIL ENGINE — VENDORED BUNDLE. DO NOT EDIT IN PLACE.",
    "// Fix upstream in radmail-ai/radmail-mcp (src/engine/*), re-run",
    "// `node scripts/bundle-engine.mjs`, and re-install with",
    "// `node scripts/install-engine-into.mjs <repo> --apply`.",
    `// radmail-mcp ${pkg.version} · modules: ${ENGINE_ORDER.join(", ")}`,
    `// sha256(body): ${hash}`,
    "// Pure: no network, no DB, no model. Safe to run inside a regulated org's",
    "// own process — no email content leaves the app that calls it.",
    "",
  ].join("\n");
  return { contents: header + body, hash, version: pkg.version };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const check = process.argv.includes("--check");
  const { contents, hash, version } = buildBundle();
  if (check) {
    const onDisk = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, "utf8") : "";
    if (onDisk !== contents) {
      console.error(`🛑 engine-dist/radmail-engine.bundle.ts is STALE — run node scripts/bundle-engine.mjs and commit it.`);
      process.exit(1);
    }
    console.log(`✓ engine-dist/radmail-engine.bundle.ts is current (sha256 ${hash.slice(0, 16)}…)`);
    process.exit(0);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, contents);
  writeFileSync(HASH_FILE, `${hash}  radmail-engine.bundle.ts  radmail-mcp@${version}\n`);
  console.log(`✅ engine-dist/radmail-engine.bundle.ts — ${ENGINE_ORDER.length} modules · ${(contents.length / 1024).toFixed(1)} KB · sha256 ${hash}`);
}
