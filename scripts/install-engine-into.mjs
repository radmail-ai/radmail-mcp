#!/usr/bin/env node
// VENDOR THE RADMAIL ENGINE INTO AN ORG'S REPO, VERIFIABLY. Dry run unless --apply.
//
//   node scripts/install-engine-into.mjs ../vrg-app            # show what would happen
//   node scripts/install-engine-into.mjs ../vrg-app --apply
//
// Copies engine-dist/radmail-engine.bundle.ts and its hash line into
// <repo>/vendor/, then re-hashes the copy and refuses to report success unless
// the bytes on the far side match. Never edits anything else in the target.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { buildBundle, OUT_FILE, HASH_FILE } from "./bundle-engine.mjs";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const target = argv.find((a) => !a.startsWith("--"));
if (!target) { console.error("usage: install-engine-into.mjs <repo-path> [--apply]"); process.exit(64); }
const repo = resolve(target);
if (!existsSync(repo) || !statSync(repo).isDirectory()) { console.error(`🛑 not a directory: ${repo}`); process.exit(1); }
if (!existsSync(OUT_FILE)) { console.error("🛑 engine-dist/ missing — run node scripts/bundle-engine.mjs first."); process.exit(1); }

// The bundle on disk must be the bundle the source implies — never ship a stale one.
const { contents: fresh, hash } = buildBundle();
const onDisk = readFileSync(OUT_FILE, "utf8");
if (onDisk !== fresh) { console.error("🛑 engine-dist/ is STALE vs src/engine — run node scripts/bundle-engine.mjs and commit."); process.exit(1); }

const vendorDir = join(repo, "vendor");
const destBundle = join(vendorDir, "radmail-engine.bundle.ts");
const destHash = join(vendorDir, "RADMAIL-ENGINE.sha256");
const existing = existsSync(destBundle) ? readFileSync(destBundle, "utf8") : null;
const existingHash = existing ? createHash("sha256").update(existing.slice(existing.indexOf("// ═══ module:"))).digest("hex") : null;

console.log(`\ntarget   : ${repo}`);
console.log(`bundle   : ${(fresh.length / 1024).toFixed(1)} KB · sha256 ${hash.slice(0, 16)}…`);
console.log(`existing : ${existing ? (existingHash === hash ? "same version — nothing to do" : `different (${existingHash?.slice(0, 16)}…) — will be replaced`) : "none — will be created"}`);
if (existing && existingHash === hash) process.exit(0);
if (!APPLY) { console.log("\nDRY RUN — re-run with --apply to write.\n"); process.exit(0); }

mkdirSync(vendorDir, { recursive: true });
writeFileSync(destBundle, fresh);
writeFileSync(destHash, readFileSync(HASH_FILE, "utf8"));
const back = readFileSync(destBundle, "utf8");
const backHash = createHash("sha256").update(back.slice(back.indexOf("// ═══ module:"))).digest("hex");
if (backHash !== hash) { console.error("🛑 the copy does not hash to the bundle — refusing to report success."); process.exit(1); }
console.log(`\n✅ vendored to ${destBundle}\n   verify any time: node -e "const s=require('fs').readFileSync('vendor/radmail-engine.bundle.ts','utf8');console.log(require('crypto').createHash('sha256').update(s.slice(s.indexOf('// ═══ module:'))).digest('hex'))"\n   expected: ${hash}\n`);
