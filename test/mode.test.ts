// Pin: the startup banner names the mode the process is actually in.
// MEASURED 2026-09-24: a CONNECTED server announced itself as "sandbox engine".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { engineMode, startupBanner } from "../src/lib/mode.js";

test("engineMode: a non-empty RADMAIL_API_KEY is connected; absent/blank is sandbox", () => {
  assert.equal(engineMode({}), "sandbox");
  assert.equal(engineMode({ RADMAIL_API_KEY: "" }), "sandbox");
  assert.equal(engineMode({ RADMAIL_API_KEY: "   " }), "sandbox");
  assert.equal(engineMode({ RADMAIL_API_KEY: "tmk_live_abc" }), "connected");
});

test("startupBanner says CONNECTED when a key is present and never prints the key", () => {
  const b = startupBanner("ready on stdio", { RADMAIL_API_KEY: "tmk_live_secretsecret" });
  assert.match(b, /CONNECTED/);
  assert.match(b, /read-only/);
  assert.doesNotMatch(b, /secretsecret/);
  assert.doesNotMatch(b, /sandbox/);
});

test("startupBanner says sandbox, and why, when there is no key", () => {
  const b = startupBanner("ready on stdio", {});
  assert.match(b, /sandbox engine/);
  assert.match(b, /no RADMAIL_API_KEY/);
  assert.doesNotMatch(b, /CONNECTED/);
});

test("every entry point prints the derived banner — no hardcoded 'sandbox engine' line survives (code, not comments)", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  for (const f of ["src/stdio.ts", "src/http.ts", "src/index.ts"]) {
    const src = strip(readFileSync(f, "utf8"));
    assert.doesNotMatch(src, /\(sandbox engine\)/, `${f} still hardcodes the sandbox banner`);
    assert.match(src, /startupBanner\(/, `${f} does not use startupBanner`);
  }
});
