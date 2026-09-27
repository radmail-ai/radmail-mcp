// Pins for scripts/install-engine-into.mjs — the engine installs from a TAG,
// never from the working tree, and engine.json agrees with the bundler.
//
// Each tag-path test builds a throwaway git repo that looks like this one
// (engine.json, package.json, src/engine/*, engine-dist/*), so the tests do not
// depend on which tags this checkout happens to have fetched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildBundle, ENGINE_ORDER, OUT_FILE, HASH_FILE } from "../scripts/bundle-engine.mjs";
import {
  ENGINE_ROOT, resolveSource, planInstall, applyInstall, bodyHash, claimedHash, stampedVersion,
} from "../scripts/install-engine-into.mjs";

const REAL_DESC = JSON.parse(readFileSync(join(ENGINE_ROOT, "engine.json"), "utf8"));
const realSrc = (rel: string) => readFileSync(join(ENGINE_ROOT, "src", rel), "utf8");

function g(dir: string, ...args: string[]) {
  return execFileSync("git", ["-C", dir, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "tag.gpgSign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A fixture engine repo. `version` goes in package.json; `withDescriptor` controls engine.json. */
function fixtureRepo({ version = "0.5.1", withDescriptor = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "radmail-engine-src-"));
  g(dir, "init", "-q");
  mkdirSync(join(dir, "src", "engine"), { recursive: true });
  mkdirSync(join(dir, "engine-dist"), { recursive: true });
  for (const rel of ENGINE_ORDER) writeFileSync(join(dir, "src", rel), realSrc(rel));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "radmail-mcp", version }, null, 2));
  if (withDescriptor) writeFileSync(join(dir, "engine.json"), JSON.stringify(REAL_DESC, null, 2));
  regen(dir, version);
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "fixture");
  return dir;
}
function regen(dir: string, version: string) {
  const b = buildBundle((rel: string) => readFileSync(join(dir, "src", rel), "utf8"), version);
  writeFileSync(join(dir, "engine-dist", "radmail-engine.bundle.ts"), b.contents);
  writeFileSync(join(dir, "engine-dist", "RADMAIL-ENGINE.sha256"), `${b.hash}  radmail-engine.bundle.ts  radmail-mcp@${version}\n`);
  return b;
}
const target = () => mkdtempSync(join(tmpdir(), "radmail-engine-dst-"));

// ── engine.json agrees with the bundler ────────────────────────────────────
test("engine.json names exactly the files, sources and sentinel the bundler produces", () => {
  assert.equal(join(ENGINE_ROOT, REAL_DESC.bundle), OUT_FILE);
  assert.equal(join(ENGINE_ROOT, REAL_DESC.manifest), HASH_FILE);
  assert.deepEqual(REAL_DESC.sources, ENGINE_ORDER.map((r: string) => `src/${r}`));
  assert.equal(REAL_DESC.engine, "radmail");
  assert.match(REAL_DESC.tagPrefix, /^radmail-engine-v$/);
  // the sentinel is where the hashed body starts: the header's claim must equal the hash from the sentinel on
  const onDisk = readFileSync(OUT_FILE, "utf8");
  assert.equal(bodyHash(onDisk, REAL_DESC.sentinel), claimedHash(onDisk));
  assert.equal(bodyHash(onDisk, REAL_DESC.sentinel), buildBundle().hash);
});

test("the buildBundle refactor did not move a byte: default output == engine-dist on disk", () => {
  assert.equal(buildBundle().contents, readFileSync(OUT_FILE, "utf8"));
});

// ── POSITIVE CONTROL: a good tag installs, byte for byte ───────────────────
test("POSITIVE CONTROL: a clean engine tag installs, and re-running is a no-op", () => {
  const src = fixtureRepo();
  g(src, "tag", "radmail-engine-v0.5.1");
  const r = resolveSource(src);
  assert.equal(r.ok, true, (r as any).message);
  assert.equal(r.source, "refs/tags/radmail-engine-v0.5.1");
  assert.equal(r.unreleased, false);
  // Same sources + same version ⇒ the same bytes this repo tracks (and VRG carries).
  assert.equal(r.bundle, readFileSync(OUT_FILE, "utf8"));
  assert.equal(r.manifestLine, readFileSync(HASH_FILE, "utf8"));

  const dst = target();
  const plan = planInstall(r, dst);
  assert.equal(plan.action, "create");
  assert.equal(applyInstall(r, plan).ok, true);
  assert.equal(readFileSync(join(dst, "vendor", "radmail-engine.bundle.ts"), "utf8"), r.bundle);
  assert.equal(readFileSync(join(dst, "vendor", "RADMAIL-ENGINE.sha256"), "utf8"), r.manifestLine);
  assert.equal(planInstall(r, dst).action, "same");
  rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true });
});

// ── THE PROPERTY: the working tree is never what ships ─────────────────────
test("a dirty, regenerated working tree is IGNORED — the tag's bytes install", () => {
  const src = fixtureRepo();
  g(src, "tag", "radmail-engine-v0.5.1");
  const tagged = readFileSync(join(src, "engine-dist", "radmail-engine.bundle.ts"), "utf8");
  // Somebody edits the engine on this laptop and regenerates, without committing or tagging.
  const f = join(src, "src", "engine", "send-disposition.ts");
  writeFileSync(f, readFileSync(f, "utf8") + "\nexport const UNTAGGED_LOCAL_EDIT = 1;\n");
  regen(src, "0.5.1");
  const r = resolveSource(src);
  assert.equal(r.ok, true, (r as any).message);
  assert.equal(r.bundle, tagged);
  assert.doesNotMatch(r.bundle, /UNTAGGED_LOCAL_EDIT/);
  rmSync(src, { recursive: true, force: true });
});

test("the NEWEST engine tag is chosen (version order, not creation order), and non-engine tags are ignored", () => {
  const src = fixtureRepo({ version: "0.5.2" });
  g(src, "tag", "radmail-engine-v0.5.2");
  g(src, "tag", "v9.9.9"); // an npm/package tag must never be read as an engine release
  const r = resolveSource(src);
  assert.equal(r.ok, true, (r as any).message);
  assert.equal(r.version, "0.5.2");
  rmSync(src, { recursive: true, force: true });
});

// ── REFUSALS ───────────────────────────────────────────────────────────────
test("no engine tag ⇒ CANNOT-VERIFY (exit 2), never a fallback to the tree", () => {
  const src = fixtureRepo();
  g(src, "tag", "v0.4.0"); // this repo's real state: a package tag, no engine tag
  const r = resolveSource(src);
  assert.equal(r.ok, false);
  assert.equal((r as any).exit, 2);
  assert.match((r as any).message, /NO ENGINE RELEASE TAG/);
  assert.match((r as any).message, /--allow-unreleased/);
  rmSync(src, { recursive: true, force: true });
});

test("a tag that predates engine.json ⇒ CANNOT-VERIFY (exit 2)", () => {
  const src = fixtureRepo({ withDescriptor: false });
  g(src, "tag", "radmail-engine-v0.5.1");
  writeFileSync(join(src, "engine.json"), JSON.stringify(REAL_DESC)); // descriptor exists in the TREE only
  const r = resolveSource(src);
  assert.equal(r.ok, false);
  assert.equal((r as any).exit, 2);
  assert.match((r as any).message, /predates engine\.json/);
  rmSync(src, { recursive: true, force: true });
});

test("a tag whose engine-dist/ was never regenerated ⇒ REFUSED as STALE (exit 1)", () => {
  const src = fixtureRepo();
  const f = join(src, "src", "engine", "send-disposition.ts");
  writeFileSync(f, readFileSync(f, "utf8") + "\nexport const CHANGED_BUT_NOT_BUNDLED = 1;\n");
  g(src, "commit", "-qam", "src moved, bundle did not");
  g(src, "tag", "radmail-engine-v0.5.1");
  const r = resolveSource(src);
  assert.equal(r.ok, false);
  assert.equal((r as any).exit, 1);
  assert.match((r as any).message, /STALE/);
  rmSync(src, { recursive: true, force: true });
});

test("a tag named for a different version than package.json AT THE TAG ⇒ REFUSED (exit 1)", () => {
  const src = fixtureRepo({ version: "0.5.1" });
  g(src, "tag", "radmail-engine-v0.5.2");
  const r = resolveSource(src);
  assert.equal(r.ok, false);
  assert.equal((r as any).exit, 1);
  assert.match((r as any).message, /package\.json AT THAT TAG says 0\.5\.1/);
  rmSync(src, { recursive: true, force: true });
});

test("an existing copy EDITED IN PLACE is refused; --force replaces it", () => {
  const src = fixtureRepo();
  g(src, "tag", "radmail-engine-v0.5.1");
  const r = resolveSource(src) as any;
  const dst = target();
  mkdirSync(join(dst, "vendor"));
  writeFileSync(join(dst, "vendor", "radmail-engine.bundle.ts"), r.bundle.replace("export function", "// local hack\nexport function"));
  const p = planInstall(r, dst);
  assert.equal(p.action, "refuse");
  assert.match(p.message, /EDITED IN PLACE/);
  assert.equal(planInstall(r, dst, { force: true }).action, "replace");
  rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true });
});

// 🩸 Review of #17: the "same" verdict compared only the body hash (sentinel onward)
// and the hash line, so code added ABOVE the sentinel read as "identical bytes".
// That verdict is what RELEASE-NOTES tells a person to rely on to prove VRG's copy.
test("code added ABOVE the sentinel is NOT identical — a body-hash match with different bytes is REFUSED", () => {
  const src = fixtureRepo();
  g(src, "tag", "radmail-engine-v0.5.1");
  const r = resolveSource(src) as any;
  const i = r.bundle.indexOf(r.sentinel);
  assert.ok(i > 0, "fixture must have a header above the sentinel");
  const injected = r.bundle.slice(0, i) + "export const exfil = globalThis.fetch;\n" + r.bundle.slice(i);
  // the mutation really is invisible to the body hash — otherwise this test proves nothing
  assert.equal(bodyHash(injected, r.sentinel), r.hash);
  assert.equal(claimedHash(injected), r.hash);
  const dst = target();
  mkdirSync(join(dst, "vendor"));
  writeFileSync(join(dst, "vendor", "radmail-engine.bundle.ts"), injected);
  writeFileSync(join(dst, "vendor", "RADMAIL-ENGINE.sha256"), r.manifestLine);
  const p = planInstall(r, dst);
  assert.notEqual(p.action, "same");
  assert.equal(p.action, "refuse");
  assert.equal((p as any).exit, 1);
  assert.match(p.message, /EDITED IN PLACE/);
  assert.match(p.message, /not proof/);
  // --force is still the deliberate way past it, and it discards the edit
  assert.equal(planInstall(r, dst, { force: true }).action, "replace");
  // the honest-other-release allowance (version stamp only) must not launder an injection
  const newer = buildBundle(realSrc, "0.6.0").contents;
  const j = newer.indexOf(r.sentinel);
  writeFileSync(join(dst, "vendor", "radmail-engine.bundle.ts"), newer.slice(0, j) + "export const exfil = globalThis.fetch;\n" + newer.slice(j));
  const p2 = planInstall(r, dst);
  assert.equal(p2.action, "refuse");
  assert.match(p2.message, /not proof/);
  rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true });
});

test("POSITIVE CONTROL for the byte check: an exact copy is 'same'; a copy whose only difference is the hash line is 'replace', not refused", () => {
  const src = fixtureRepo();
  g(src, "tag", "radmail-engine-v0.5.1");
  const r = resolveSource(src) as any;
  const dst = target();
  mkdirSync(join(dst, "vendor"));
  writeFileSync(join(dst, "vendor", "radmail-engine.bundle.ts"), r.bundle);
  writeFileSync(join(dst, "vendor", "RADMAIL-ENGINE.sha256"), r.manifestLine);
  assert.equal(planInstall(r, dst).action, "same");
  writeFileSync(join(dst, "vendor", "RADMAIL-ENGINE.sha256"), r.manifestLine.trimEnd() + "  UNRELEASED:deadbeef\n");
  const p = planInstall(r, dst);
  assert.equal(p.action, "replace");
  assert.match(p.message, /hash line differs/);
  rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true });
});

test("a DOWNGRADE is refused; --force allows it", () => {
  const src = fixtureRepo();
  g(src, "tag", "radmail-engine-v0.5.1");
  const r = resolveSource(src) as any;
  const newer = buildBundle(realSrc, "0.6.0").contents; // an honest, unedited copy of a newer release
  assert.equal(stampedVersion(newer), "0.6.0");
  const dst = target();
  mkdirSync(join(dst, "vendor"));
  writeFileSync(join(dst, "vendor", "radmail-engine.bundle.ts"), newer);
  const p = planInstall(r, dst);
  assert.equal(p.action, "refuse");
  assert.match(p.message, /DOWNGRADE the copy from 0\.6\.0 to 0\.5\.1/);
  assert.equal(planInstall(r, dst, { force: true }).action, "replace");
  rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true });
});

// ── THE ESCAPE announces itself ────────────────────────────────────────────
test("--allow-unreleased reads the tree, and stamps UNRELEASED into the copy's hash line", () => {
  const r = resolveSource(ENGINE_ROOT, { allowUnreleased: true }) as any;
  assert.equal(r.ok, true, r.message);
  assert.equal(r.unreleased, true);
  assert.match(r.source, /^WORKING TREE @ .*\(--allow-unreleased\)$/);
  assert.match(r.manifestLine, /  UNRELEASED:\S+\n$/);
});

test("CLI: --allow-unreleased prefixes EVERY stdout line; an unknown flag is usage (64)", () => {
  const dst = target();
  const out = execFileSync("node", [join(ENGINE_ROOT, "scripts", "install-engine-into.mjs"), dst, "--allow-unreleased"], { encoding: "utf8" });
  const lines = out.split("\n").filter((l) => l.length > 0);
  assert.ok(lines.length >= 4);
  for (const l of lines) assert.match(l, /^⚠️ UNRELEASED │/);
  assert.equal(existsSync(join(dst, "vendor")), false, "dry run wrote nothing");
  let code = 0;
  try { execFileSync("node", [join(ENGINE_ROOT, "scripts", "install-engine-into.mjs"), dst, "--aply"], { stdio: "pipe" }); } catch (e: any) { code = e.status; }
  assert.equal(code, 64);
  rmSync(dst, { recursive: true, force: true });
});
