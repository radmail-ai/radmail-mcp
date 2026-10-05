// The public-surface denylist gate: controls in BOTH directions, then the real tree.
// A gate that refuses everything passes every negative control, so the positive
// controls (a clean tree passes) are load-bearing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDenylist, scanFiles, scanText, trackedFiles } from "../scripts/check-public-denylist.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Built from parts so this file does not trip the gate it tests.
const PLANTED = "jordan.lee" + "@" + "northwind-supply.co";

test("NEGATIVE control: a planted real-looking address fails", () => {
  const hits = scanText(`const to = "${PLANTED}";`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rule, "email-outside-example-domains");
});

test("NEGATIVE control: home-directory path and finding-id shapes fail", () => {
  assert.equal(scanText("// " + "/" + "Users/someone/dev/app/x.ts")[0]?.rule, "absolute-home-path");
  assert.equal(scanText("closes acme-" + "20260102030405")[0]?.rule, "internal-finding-id");
});

test("NEGATIVE control: a secret-supplied term fails in any case, and is never echoed", () => {
  const hits = scanText("Ships to NORTHWIND on Thursday", { terms: parseDenylist("northwind|other") });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rule, "denylisted-term");
  assert.ok(!JSON.stringify(hits).toLowerCase().includes("northwind"));
});

test("POSITIVE control: reserved documentation domains and the product contact pass", () => {
  assert.deepEqual(scanText("a@example.com b@shop.example.org c@known.example d@x.invalid security@radmail.ai"), []);
  assert.deepEqual(scanText('"zod-to-json-schema@3.25.2" radmail-mcp@0.5.1'), []);
});

test("a clean tree passes; the same tree with one planted address fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "denylist-test-"));
  try {
    writeFileSync(join(dir, "a.ts"), 'export const from = "pat@example.com";\n');
    assert.deepEqual(scanFiles([join(dir, "a.ts")], dir), []);
    writeFileSync(join(dir, "b.ts"), `export const from = "${PLANTED}";\n`);
    const hits = scanFiles([join(dir, "a.ts"), join(dir, "b.ts")], dir);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, "b.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("this repository's tracked files pass the structural rules", () => {
  const files = trackedFiles(ROOT);
  assert.ok(files.length > 20, `expected the real tree, saw ${files.length} files`);
  const hits = scanFiles(files, ROOT);
  assert.deepEqual(hits, [], hits.map((h) => `${h.file}:${h.line} ${h.rule}`).join("\n"));
});
