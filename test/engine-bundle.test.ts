// Pins for the vendorable engine bundle (scripts/bundle-engine.mjs).
// The bundle must be loadable on its own, expose the BEC detector, and hash
// to what its header claims — a copy nobody can check drifts silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildBundle, OUT_FILE, ENGINE_ORDER } from "../scripts/bundle-engine.mjs";

test("the bundle strips every cross-module import and keeps the module bodies verbatim", () => {
  const { contents } = buildBundle();
  assert.doesNotMatch(contents.replace(/^\/\/.*$/gm, ""), /^\s*import\s/m, "no live import lines");
  for (const rel of ENGINE_ORDER) assert.match(contents, new RegExp(`// ═══ module: src/${rel.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} ═══`));
  assert.match(contents, /export function detectSourceRiskSignals\(/);
  assert.match(contents, /export function commitmentSendDisposition\(/);
});

test("the header hash is the sha256 of the body that follows it", () => {
  const { contents, hash } = buildBundle();
  const body = contents.slice(contents.indexOf("// ═══ module:"));
  assert.equal(createHash("sha256").update(body).digest("hex"), hash);
  assert.match(contents, new RegExp(`// sha256\\(body\\): ${hash}`));
});

test("engine-dist/ on disk is the bundle the source implies (commit it when it moves)", () => {
  assert.ok(existsSync(OUT_FILE), "engine-dist/radmail-engine.bundle.ts exists");
  assert.equal(readFileSync(OUT_FILE, "utf8"), buildBundle().contents);
});

test("the bundled detector runs standalone and fires on a changed-banking ask", async () => {
  const mod = await import(OUT_FILE);
  const r = mod.detectSourceRiskSignals("Updated remittance details", "Please note our bank account has changed — use the new wire instructions attached.");
  assert.equal(r.hasNewBankingSignal, true);
  assert.equal(r.hasMoneySignal, true);
  const clean = mod.detectSourceRiskSignals("Lunch Thursday?", "Are you free at noon?");
  assert.deepEqual(clean, { hasMoneySignal: false, hasNewBankingSignal: false, hasDecisionSignal: false, injectionSignal: false });
});
