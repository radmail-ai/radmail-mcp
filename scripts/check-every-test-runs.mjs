#!/usr/bin/env node
// A TEST FILE THAT IS NOT IN THE LIST NEVER RUNS.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🩸 MEASURED 2026-09-02, BY WALKING INTO IT
//
// `npm test` enumerates its files EXPLICITLY:
//
//   node --test --import tsx test/firewall.test.ts test/taint.test.ts …
//
// A new test file added to `test/` is therefore not run, and nothing says so.
// While writing `agent-safety-contract-matches-the-code.test.ts` — seven tests,
// passing locally — the suite total stayed at **155**. The file was present,
// green, and dead. Adding it to the list took it to 162.
//
// 🔑 THE FAILURE IS SILENT IN THE WORST DIRECTION. A test nobody runs does not
// fail; it reports nothing, and its absence looks exactly like coverage. This
// repo's whole safety story rests on pinned behaviour — a pin that does not run
// is a pin that is not there.
//
// ⚖️ BOTH DIRECTIONS ARE CHECKED. A file on disk missing from the list is dead
// coverage; a file in the list missing from disk is a suite that will not start
// at all. Neither should be discovered by accident.
//
// 🛑 WHY NOT JUST GLOB IN THE TEST SCRIPT? Because the explicit list is
// deliberate here — ORDER matters for a couple of these, and a glob would also
// sweep any future fixture named `*.test.ts` into the run. The list stays; what
// changes is that it can no longer drift from the directory silently.
//
//   node scripts/check-every-test-runs.mjs
//
// Exit: 0 clean · 1 the list and the disk disagree · 2 could not look · 64 usage.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const a of process.argv.slice(2)) {
  if (a === "--help" || a === "-h") { console.log("usage: node scripts/check-every-test-runs.mjs"); process.exit(0); }
  console.error(`\n  🛑 unknown flag: ${a}\n     known: --help\n`);
  process.exit(64);
}

let pkg;
try {
  pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
} catch {
  console.error(`\n[check-every-test-runs] ⚪️ CANNOT LOOK — package.json unreadable.\n`);
  process.exit(2);
}

const testScript = pkg.scripts?.test;
if (typeof testScript !== "string" || testScript.length === 0) {
  console.error(`\n[check-every-test-runs] ⚪️ CANNOT LOOK — no "test" script to compare against.\n`);
  process.exit(2);
}

/** Every *.test.ts on disk, repo-relative. */
function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.test\.tsx?$/.test(name)) acc.push(relative(ROOT, p));
  }
  return acc;
}

const onDisk = [...walk(join(ROOT, "test")), ...walk(join(ROOT, "src"))].sort();
const listed = testScript.split(/\s+/).filter((t) => /\.test\.tsx?$/.test(t)).sort();

// 🛑 FINDING NOTHING IS A BROKEN PROBE. This repo has had test files since its
// first commit; zero means the walk stopped working, not that the tests left.
if (onDisk.length === 0) {
  console.error(`\n[check-every-test-runs] ⚪️ CANNOT LOOK — found no *.test.ts on disk.\n     Broken probe, not a clean result.\n`);
  process.exit(2);
}

const notRun = onDisk.filter((f) => !listed.includes(f));
const missing = listed.filter((f) => !existsSync(join(ROOT, f)));

if (notRun.length || missing.length) {
  console.error(`\n[check-every-test-runs] 🚨 the test list and the directory disagree:\n`);
  for (const f of notRun) console.error(`  🔴 ${f} — on disk, NOT in the "test" script. It never runs.`);
  for (const f of missing) console.error(`  🔴 ${f} — in the "test" script, NOT on disk. The suite cannot start.`);
  console.error(`\n  🔑 A test nobody runs does not fail — it reports nothing, and its absence`);
  console.error(`     looks exactly like coverage. This repo's safety story rests on pinned`);
  console.error(`     behaviour; a pin that does not run is a pin that is not there.`);
  console.error(`  ▶️ Add it to the "test" script in package.json (the list is explicit on`);
  console.error(`     purpose — order matters — so it must be maintained, not globbed).\n`);
  process.exit(1);
}

console.log(`[check-every-test-runs] OK — all ${onDisk.length} test file(s) on disk are in the "test" script, and every listed file exists.`);
process.exit(0);
