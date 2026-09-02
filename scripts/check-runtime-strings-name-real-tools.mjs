#!/usr/bin/env node
// A RUNTIME STRING THAT NAMES A TOOL MUST NAME ONE THAT EXISTS.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🩸 THE CLASS, THREE TIMES IN ONE DAY (2026-09-02)
//
//   · SERVER_INSTRUCTIONS told every connecting agent to call `inbox_pulse`
//     — the real batch tool is `triage_inbox`. Fixed in #9.
//   · agent-safety.json described the review path as `draft_followup`
//     — the real tool is `draft_reply`. Fixed in #9.
//   · `triage_inbox`'s own RESPONSE NOTE said "Discharge a commitment with
//     `draft_followup`" — found only by CALLING the tool and reading what came
//     back. Fixed here.
//
// 🔑 AN AGENT DOES NOT RETRY DIFFERENTLY WHEN A NAMED CALL FAILS — IT REPORTS
// THE CAPABILITY AS ABSENT. That is how "there is no way to send through
// RadMail" got said about a live endpoint. A wrong tool name in a response is
// not a typo; it is an instruction that cannot be followed.
//
// ⚖️ SCOPE: backticked snake_case tokens in RUNTIME strings (line comments are
// stripped — prose may discuss a name that was removed, and this session has
// already paid five times for absence checks matching the comment explaining
// the absence). There are 9 such tokens today: 6 tools, 2 domain values, 1 bug.
//
//   node scripts/check-runtime-strings-name-real-tools.mjs
//
// Exit: 0 clean · 1 a string names a non-tool · 2 could not look · 64 usage.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const a of process.argv.slice(2)) {
  if (a === "--help" || a === "-h") { console.log("usage: node scripts/check-runtime-strings-name-real-tools.mjs"); process.exit(0); }
  console.error(`\n  🛑 unknown flag: ${a}\n     known: --help\n`);
  process.exit(64);
}

/**
 * snake_case vocabulary that is NOT a tool name and legitimately appears in
 * runtime prose. Each entry states what it is, so the list cannot quietly
 * become a place to hide a real phantom.
 */
const NON_TOOL_VOCABULARY = new Map([
  ["hard_stop", "a SendDisposition value, not a tool"],
  ["needs_approval", "a SendDisposition value, not a tool"],
]);

// The tool names, read from the source of truth rather than restated.
const toolsSrc = readFileSync(join(ROOT, "src/tools.ts"), "utf8");
const TOOL_NAMES = new Set([...toolsSrc.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]));
if (TOOL_NAMES.size < 5) {
  console.error(`\n[check-runtime-strings-name-real-tools] ⚪️ CANNOT LOOK — parsed ${TOOL_NAMES.size} tool name(s) from TOOL_DEFS.`);
  console.error(`     This server exposes 13; a low count means the parser broke, not that the tools left.\n`);
  process.exit(2);
}

const files = execFileSync("git", ["-C", ROOT, "ls-files", "src"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f.endsWith(".ts") && !f.includes("test"));

const bad = [];
let scanned = 0;
for (const rel of files) {
  let txt;
  try { txt = readFileSync(join(ROOT, rel), "utf8"); } catch { continue; }
  const lines = txt.split("\n");
  lines.forEach((line, i) => {
    // 🪤 Strip line comments — prose legitimately names a tool that was removed.
    if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return;
    for (const m of line.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
      scanned += 1;
      const tok = m[1];
      if (TOOL_NAMES.has(tok) || NON_TOOL_VOCABULARY.has(tok)) continue;
      bad.push({ file: rel, line: i + 1, tok, text: line.trim().slice(0, 90) });
    }
  });
}

if (scanned === 0) {
  console.error(`\n[check-runtime-strings-name-real-tools] ⚪️ CANNOT LOOK — found no backticked tokens at all.`);
  console.error(`     There are ~9 in this repo; zero means the scan broke.\n`);
  process.exit(2);
}

if (bad.length > 0) {
  console.error(`\n[check-runtime-strings-name-real-tools] 🚨 ${bad.length} runtime string(s) name something that is not a tool:\n`);
  for (const b of bad) console.error(`  🔴 ${b.file}:${b.line}  \`${b.tok}\`\n     ${b.text}\n`);
  console.error(`  🔑 An agent does not retry differently when a named call fails — it reports`);
  console.error(`     the capability as ABSENT. A wrong tool name in a response is not a typo;`);
  console.error(`     it is an instruction that cannot be followed.`);
  console.error(`  ▶️ Use the real name, or add it to NON_TOOL_VOCABULARY with what it IS.\n`);
  process.exit(1);
}

console.log(
  `[check-runtime-strings-name-real-tools] OK — ${scanned} backticked token(s) in runtime strings; ` +
    `all name one of ${TOOL_NAMES.size} real tools or ${NON_TOOL_VOCABULARY.size} declared non-tool value(s).`,
);
process.exit(0);
