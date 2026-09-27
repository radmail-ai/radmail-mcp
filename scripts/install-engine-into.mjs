#!/usr/bin/env node
// VENDOR THE RADMAIL ENGINE INTO AN ORG'S REPO, FROM A RELEASE TAG. Dry run unless --apply.
//
//   node scripts/install-engine-into.mjs ../vrg-app              # show what would happen
//   node scripts/install-engine-into.mjs ../vrg-app --apply
//   node scripts/install-engine-into.mjs ../vrg-app --allow-unreleased [--apply]   # testing only
//   node scripts/install-engine-into.mjs ../vrg-app --force --apply  # past an edited copy / a downgrade
//
// Exit: 0 installed or already current · 1 REFUSED (stale tag, edited copy,
// downgrade, copy did not hash back) · 2 CANNOT-VERIFY (no tag, tag predates
// engine.json, a file unreadable at the tag) · 64 usage.
//
// ═════════════════════════════════════════════════════════════════════════════
// 🩸 WHY THIS INSTALLS A TAG AND NEVER THE WORKING TREE — measured 2026-09-26
//
// The first version of this script (#16) built the bundle from whatever sat in
// THIS checkout and copied it out. VRG's main carries the result, stamped
// `radmail-mcp@0.5.1` — and there is no 0.5.1 anywhere a person can check out:
// the newest tag in this repo is v0.4.0 (which predates engine-dist/ entirely)
// and npm serves 0.5.0. The copy happens to be byte-identical to one commit on
// main, but nothing in the copy says which, and the next install from a stale
// or dirty laptop would have looked exactly the same.
//
// feedback-engine paid for this shape first: three orgs on three different
// bundles, all stamped v0.67.0, two of them installed from an unreleased tree.
// Its install-into.mjs was changed to install the newest tag by default; this
// is the same rule, and the same escape.
//
// ⚖️ `--allow-unreleased` STILL EXISTS, because testing a fix in a consumer
// before tagging is legitimate. It must be ASKED FOR, it says so on every line
// it prints, and it writes `UNRELEASED` into the vendored hash line — so the
// copy itself carries the admission, not only this run's scrollback.
//
// ── THE DESCRIPTOR ──────────────────────────────────────────────────────────
// `engine.json` at the repo root describes this engine for a shared, fleet-wide
// installer (fleet design §B1). It is read AT THE TAG. A tag that predates
// engine.json is refused (CANNOT-VERIFY), not guessed at: the first installable
// tag is therefore one cut at or after the commit that added engine.json.
// ═════════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { buildBundle, ENGINE_ORDER } from "./bundle-engine.mjs";

export const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KNOWN_FLAGS = new Set(["--apply", "--force", "--allow-unreleased"]);

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function git(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64e6, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
}
const showAt = (root, ref, path) => git(root, ["show", `refs/tags/${ref}:${path}`]);

/** Body hash of a bundle = sha256 of everything from the sentinel on. null when the sentinel is absent. */
export function bodyHash(contents, sentinel) {
  const i = contents.indexOf(sentinel);
  return i < 0 ? null : sha256(contents.slice(i));
}

/** `// sha256(body): <hex>` from a bundle's header, or null. */
export function claimedHash(contents) {
  return contents.match(/^\/\/ sha256\(body\): ([0-9a-f]{64})$/m)?.[1] ?? null;
}

/** `// radmail-mcp <version> · modules:` from a bundle's header, or null. */
export function stampedVersion(contents) {
  return contents.match(/^\/\/ radmail-mcp (\d+\.\d+\.\d+[^\s]*) · modules:/m)?.[1] ?? null;
}

export function compareSemver(a, b) {
  const pa = a.split(/[.-]/).slice(0, 3).map(Number);
  const pb = b.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Newest-first list of tags carrying the descriptor's prefix. */
export function engineTags(root, prefix) {
  const out = git(root, ["tag", "--list", `${prefix}*`, "--sort=-v:refname"]);
  return out === null ? [] : out.split("\n").map((t) => t.trim()).filter(Boolean);
}

/**
 * Decide WHAT would be installed. Never writes. Returns either
 *   { ok: true, source, version, bundle, manifestLine, hash, sentinel, vendorDir, bundleName, manifestName, unreleased }
 * or
 *   { ok: false, exit: 1|2, message }
 */
export function resolveSource(root, { allowUnreleased = false } = {}) {
  let treeDesc;
  try {
    treeDesc = JSON.parse(readFileSync(join(root, "engine.json"), "utf8"));
  } catch {
    return { ok: false, exit: 2, message: `🛑 CANNOT-VERIFY: ${root}/engine.json is missing or not JSON — it names the tag prefix this installer reads.` };
  }
  const bundleName = treeDesc.bundle.split("/").pop();
  const manifestName = treeDesc.manifest.split("/").pop();

  if (allowUnreleased) {
    const bundlePath = join(root, treeDesc.bundle);
    if (!existsSync(bundlePath)) return { ok: false, exit: 2, message: `🛑 ${treeDesc.bundle} is missing — run node scripts/bundle-engine.mjs.` };
    const fresh = buildBundle();
    const onDisk = readFileSync(bundlePath, "utf8");
    if (onDisk !== fresh.contents) {
      return { ok: false, exit: 1, message: `🛑 ${treeDesc.bundle} is STALE vs src/engine — run node scripts/bundle-engine.mjs and commit.` };
    }
    const head = (git(root, ["rev-parse", "--short=12", "HEAD"]) ?? "no-git").trim();
    const dirty = (git(root, ["status", "--porcelain"]) ?? "").trim() ? "-dirty" : "";
    return {
      ok: true,
      unreleased: true,
      source: `WORKING TREE @ ${head}${dirty} (--allow-unreleased)`,
      version: fresh.version,
      bundle: onDisk,
      hash: fresh.hash,
      manifestLine: `${fresh.hash}  ${bundleName}  radmail-mcp@${fresh.version}  UNRELEASED:${head}${dirty}\n`,
      sentinel: treeDesc.sentinel, vendorDir: treeDesc.vendorDir, bundleName, manifestName,
    };
  }

  // 🛑 NO TAG IS A REFUSAL, NOT A FALLBACK TO THE TREE. A silent fallback would
  // restore the removed behaviour for every clone that has no engine tag yet.
  const tags = engineTags(root, treeDesc.tagPrefix);
  if (tags.length === 0) {
    return {
      ok: false, exit: 2,
      message:
        `🛑 NO ENGINE RELEASE TAG (${treeDesc.tagPrefix}*) in ${root}.\n\n` +
        `   This installs the newest ${treeDesc.tagPrefix}* TAG, not the working tree: a copy vendored from an\n` +
        `   unreleased tree asserts a release nobody can check out (VRG carries one stamped\n` +
        `   radmail-mcp@0.5.1 while the newest tag here is v0.4.0).\n\n` +
        `   ▶️ Cut an engine release tag, or pass --allow-unreleased if you are deliberately testing a\n` +
        `      fix in a consumer before tagging. (Did you fetch tags? git fetch --tags)`,
    };
  }
  const tag = tags[0];
  const version = tag.slice(treeDesc.tagPrefix.length);

  const descAtTag = showAt(root, tag, "engine.json");
  if (descAtTag === null) {
    return { ok: false, exit: 2, message: `🛑 CANNOT-VERIFY: ${tag} predates engine.json, so nothing at the tag says what the engine is. Refusing rather than reading the working tree.` };
  }
  let desc;
  try { desc = JSON.parse(descAtTag); } catch { return { ok: false, exit: 2, message: `🛑 CANNOT-VERIFY: engine.json at ${tag} is not JSON.` }; }
  if (desc.engine !== treeDesc.engine || desc.tagPrefix !== treeDesc.tagPrefix) {
    return { ok: false, exit: 2, message: `🛑 CANNOT-VERIFY: engine.json at ${tag} names engine "${desc.engine}" / prefix "${desc.tagPrefix}", the tree names "${treeDesc.engine}" / "${treeDesc.tagPrefix}".` };
  }
  // The rebuild below uses THIS tree's builder. It can only vouch for a tag whose module list it shares.
  const expectedSources = ENGINE_ORDER.map((rel) => `src/${rel}`);
  if (JSON.stringify(desc.sources) !== JSON.stringify(expectedSources)) {
    return { ok: false, exit: 2, message: `🛑 CANNOT-VERIFY: ${tag} bundles ${JSON.stringify(desc.sources)}; this builder bundles ${JSON.stringify(expectedSources)}, so it cannot re-derive that tag's bytes.` };
  }

  const bundle = showAt(root, tag, desc.bundle);
  const manifestLine = showAt(root, tag, desc.manifest);
  const pkgRaw = showAt(root, tag, "package.json");
  if (bundle === null || manifestLine === null || pkgRaw === null) {
    return { ok: false, exit: 2, message: `🛑 CANNOT-VERIFY: ${tag} exists but ${[bundle === null && desc.bundle, manifestLine === null && desc.manifest, pkgRaw === null && "package.json"].filter(Boolean).join(", ")} could not be read at it. Refusing rather than falling back to the working tree.` };
  }

  // 🪤 Read package.json AT THE TAG: the question is whether the released bytes agree with THEMSELVES.
  const pkgVersion = JSON.parse(pkgRaw).version;
  if (pkgVersion !== version) {
    return { ok: false, exit: 1, message: `🛑 REFUSED: tag ${tag} names ${version}, but package.json AT THAT TAG says ${pkgVersion}. The bundle header would stamp ${pkgVersion} under a tag called ${version}. Re-tag the right commit.` };
  }
  const rebuilt = buildBundle((rel) => showAt(root, tag, `src/${rel}`) ?? "", pkgVersion);
  if (rebuilt.contents !== bundle) {
    return { ok: false, exit: 1, message: `🛑 REFUSED: ${desc.bundle} at ${tag} is STALE — it is not the bundle that tag's own src/engine implies. Tagging a commit whose engine-dist/ was never regenerated ships code the source does not contain.` };
  }
  const hash = bodyHash(bundle, desc.sentinel);
  if (!manifestLine.startsWith(`${hash}  ${bundleName}  radmail-mcp@${version}`)) {
    return { ok: false, exit: 1, message: `🛑 REFUSED: ${desc.manifest} at ${tag} does not name the bundle's body hash and version (${hash.slice(0, 16)}… @${version}).` };
  }
  return {
    ok: true, unreleased: false, source: `refs/tags/${tag}`, version, bundle, hash, manifestLine,
    sentinel: desc.sentinel, vendorDir: desc.vendorDir, bundleName, manifestName,
  };
}

/**
 * Compare the resolved source with what the target already carries. Never writes.
 * { action: "create"|"same"|"replace"|"refuse", exit?, message }
 */
export function planInstall(src, repo, { force = false } = {}) {
  const destBundle = join(repo, src.vendorDir, src.bundleName);
  const destManifest = join(repo, src.vendorDir, src.manifestName);
  if (!existsSync(destBundle)) return { action: "create", destBundle, destManifest, message: "none — will be created" };
  const existing = readFileSync(destBundle, "utf8");
  const existingManifest = existsSync(destManifest) ? readFileSync(destManifest, "utf8") : null;
  const actual = bodyHash(existing, src.sentinel);
  // 🩸 "same" means the WHOLE FILE, byte for byte. The body hash covers only the
  // sentinel onward, so a copy with code added ABOVE the sentinel (an extra export
  // in the header region) hashes identically — and this verdict is what a person
  // is told to rely on to prove a regulated org's copy is a release.
  if (existing === src.bundle && existingManifest === src.manifestLine) {
    return { action: "same", destBundle, destManifest, message: "identical bytes — nothing to do" };
  }
  // ⚖️ The one honest way to share this body with different bytes: an unedited build
  // of ANOTHER release, whose header differs only in its version stamp. Anything
  // else above the sentinel is an edit.
  const stamp = (v) => `// radmail-mcp ${v} · modules:`;
  const otherVersion = stampedVersion(existing);
  const honestOtherRelease = otherVersion !== null && otherVersion !== src.version
    && src.bundle.includes(stamp(src.version))
    && existing === src.bundle.replace(stamp(src.version), stamp(otherVersion));
  if (actual === src.hash && existing !== src.bundle && !honestOtherRelease && !force) {
    return { action: "refuse", exit: 1, destBundle, destManifest, message: `the existing copy was EDITED IN PLACE outside the hashed body: its body hash matches ${src.hash.slice(0, 16)}…, but the file is not byte-identical to the release (the difference is above the sentinel). A body-hash match is not proof. Diff it against the tag, upstream the edit, or pass --force to discard it.` };
  }
  // 🛑 An edited copy is somebody's change. Overwriting it silently destroys it.
  const claimed = claimedHash(existing);
  if (actual !== claimed && !force) {
    return { action: "refuse", exit: 1, destBundle, destManifest, message: `the existing copy was EDITED IN PLACE (header claims ${claimed?.slice(0, 16) ?? "no hash"}…, body hashes to ${actual?.slice(0, 16) ?? "nothing"}…). Upstream the edit, or pass --force to discard it.` };
  }
  // 🛑 No silent downgrade.
  const had = stampedVersion(existing);
  if (had && compareSemver(had, src.version) > 0 && !force) {
    return { action: "refuse", exit: 1, destBundle, destManifest, message: `this would DOWNGRADE the copy from ${had} to ${src.version}. Pass --force if that is deliberate.` };
  }
  return { action: "replace", destBundle, destManifest, message: actual === src.hash ? `same body, hash line differs (${existingManifest?.trim() ?? "missing"}) — will be rewritten` : `different (${had ?? "?"} · ${actual?.slice(0, 16)}…) — will be replaced` };
}

/** Write, then re-read and re-hash. Returns { ok, message }. */
export function applyInstall(src, plan) {
  mkdirSync(dirname(plan.destBundle), { recursive: true });
  writeFileSync(plan.destBundle, src.bundle);
  writeFileSync(plan.destManifest, src.manifestLine);
  const back = readFileSync(plan.destBundle, "utf8");
  if (back !== src.bundle || bodyHash(back, src.sentinel) !== src.hash) {
    return { ok: false, message: "🛑 the copy does not hash to the bundle — refusing to report success." };
  }
  return { ok: true, message: `✅ vendored to ${plan.destBundle}` };
}

function main(argv) {
  const unknown = argv.filter((a) => a.startsWith("--") && !KNOWN_FLAGS.has(a));
  const target = argv.find((a) => !a.startsWith("--"));
  if (unknown.length || !target) {
    console.error(`usage: install-engine-into.mjs <repo-path> [--apply] [--force] [--allow-unreleased]${unknown.length ? `\n🛑 unknown flag(s): ${unknown.join(" ")}` : ""}`);
    return 64;
  }
  const APPLY = argv.includes("--apply");
  const FORCE = argv.includes("--force");
  const UNRELEASED = argv.includes("--allow-unreleased");
  const repo = resolve(target);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) { console.error(`🛑 not a directory: ${repo}`); return 64; }

  const src = resolveSource(ENGINE_ROOT, { allowUnreleased: UNRELEASED });
  if (!src.ok) { console.error(`\n${src.message}\n`); return src.exit; }
  // 📣 Said on EVERY line when unreleased: the whole defect was a source nobody could see.
  const say = (s) => console.log(src.unreleased ? `⚠️ UNRELEASED │ ${s}` : s);

  const plan = planInstall(src, repo, { force: FORCE });
  say("");
  say(`source   : ${src.source}`);
  say(`target   : ${repo}`);
  say(`bundle   : ${(src.bundle.length / 1024).toFixed(1)} KB · radmail-mcp@${src.version} · sha256 ${src.hash.slice(0, 16)}…`);
  say(`existing : ${plan.message}`);
  if (plan.action === "refuse") { console.error(`\n🛑 REFUSED: ${plan.message}\n`); return plan.exit; }
  if (plan.action === "same") return 0;
  if (!APPLY) { say(""); say("DRY RUN — re-run with --apply to write."); say(""); return 0; }
  const res = applyInstall(src, plan);
  if (!res.ok) { console.error(res.message); return 1; }
  say("");
  say(res.message);
  say(`   verify any time: node -e "const s=require('fs').readFileSync('${src.vendorDir}/${src.bundleName}','utf8');console.log(require('crypto').createHash('sha256').update(s.slice(s.indexOf('${src.sentinel}'))).digest('hex'))"`);
  say(`   expected: ${src.hash}`);
  say("");
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) process.exit(main(process.argv.slice(2)));
