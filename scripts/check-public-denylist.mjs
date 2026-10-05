#!/usr/bin/env node
// PUBLIC-SURFACE DENYLIST GATE. This repository and its npm tarball are public.
// Nothing that identifies a real person, mailbox, customer, private repository
// or internal record may ship in either.
//
//   node scripts/check-public-denylist.mjs              # scan every git-tracked file
//   node scripts/check-public-denylist.mjs --pack       # also scan the real `npm pack` tarball
//   node scripts/check-public-denylist.mjs --self-test  # positive + negative controls
//   node check-public-denylist.mjs --root <repo-dir> [--pack]  # scan ANOTHER repo
//
// REUSABLE: this file has no dependencies and no repo-relative imports, so any
// public repository can run it against itself — see
// .github/workflows/public-denylist.yml (a `workflow_call` workflow other repos
// call with `uses:`), which checks this script out and passes `--root`.
//
// Exit: 0 clean · 1 a hit (or a forbidden path in the tarball) · 2 could not run.
//
// ── WHAT IT REFUSES ─────────────────────────────────────────────────────────
// Structural rules, which need no secret:
//   1. An email address outside the reserved documentation domains
//      (example.com / example.org / example.net and their subdomains, and the
//      reserved TLDs .example / .invalid / .test — RFC 2606), unless it is in
//      ALLOWED_ADDRESSES (the product's own published contact addresses).
//   2. An absolute home-directory path on macOS.
//   3. An internal finding-id shape: `<slug>-YYYYMMDDhhmmss`.
// Term rules, from a secret:
//   4. Every term in $RADMAIL_PUBLIC_DENYLIST (pipe-separated, case-insensitive,
//      matched on alphanumeric boundaries): internal org slugs, private
//      repository names, staff names, store names and domains.
//
// 🔑 THE TERM LIST IS NOT IN THIS REPOSITORY, DELIBERATELY. A committed list of
// the names this gate protects would itself be the disclosure. CI reads it from
// the `PUBLIC_DENYLIST` repository secret. When the list is absent, the term
// half of this gate CANNOT FAIL, so it says so loudly instead of passing
// quietly; the structural half still runs and still fails.
//
// ⚖️ The scope is EXCLUSIONARY: every tracked file, not a list of directories.
// A new directory is covered the day it is created.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const ALLOWED_ADDRESSES = new Set(["security@radmail.ai"]);
const RESERVED_DOMAINS = ["example.com", "example.org", "example.net"];
const RESERVED_TLDS = ["example", "invalid", "test", "localhost"];

// Built from parts so this file does not match its own rule.
const HOME_PATH_RE = new RegExp("/" + "Users/[A-Za-z0-9._-]+", "g");
const EMAIL_RE = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;
const FINDING_ID_RE = /\b[a-z][a-z0-9]*-20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[0-2]\d[0-5]\d[0-5]\d\b/g;

/** Paths that must never appear in the published tarball. */
export const FORBIDDEN_PACK_PATHS = [/^test\//, /^scripts\//, /^engine-dist\//, /^dist\/test\//, /^dist\/scripts\//, /\.test\.[cm]?[jt]s$/, /^PUBLISH_BLITZ\.md$/, /^src\//];

export function isAllowedDomain(domain) {
  const d = domain.toLowerCase().replace(/\.$/, "");
  if (RESERVED_DOMAINS.some((r) => d === r || d.endsWith("." + r))) return true;
  const tld = d.slice(d.lastIndexOf(".") + 1);
  return RESERVED_TLDS.includes(tld);
}

export function parseDenylist(raw) {
  return String(raw ?? "")
    .split(/[|\n]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scan one text. Returns [{rule, line, excerpt}]. Excerpts are REDACTED for the
 * term rule: a CI log is public too, so the gate never prints a denylisted term.
 */
export function scanText(text, { terms = [] } = {}) {
  const hits = [];
  const lines = text.split("\n");
  const termRes = terms.map((t) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(t)}(?![A-Za-z0-9])`, "i"));
  lines.forEach((line, i) => {
    for (const m of line.matchAll(EMAIL_RE)) {
      if (ALLOWED_ADDRESSES.has(m[0].toLowerCase())) continue;
      if (isAllowedDomain(m[1])) continue;
      hits.push({ rule: "email-outside-example-domains", line: i + 1, excerpt: `…@${m[1].replace(/^[^.]+/, "***")}` });
    }
    if (line.match(HOME_PATH_RE)) hits.push({ rule: "absolute-home-path", line: i + 1, excerpt: "(a home-directory path)" });
    if (line.match(FINDING_ID_RE)) hits.push({ rule: "internal-finding-id", line: i + 1, excerpt: "(a finding-id shape)" });
    termRes.forEach((re, k) => {
      if (re.test(line)) hits.push({ rule: "denylisted-term", line: i + 1, excerpt: `(denylist entry #${k + 1})` });
    });
  });
  return hits;
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

/** Scan a list of files (absolute paths), reporting paths relative to `base`. */
export function scanFiles(files, base, opts) {
  const out = [];
  for (const f of files) {
    let buf;
    try {
      buf = readFileSync(f);
    } catch {
      continue; // deleted in the working tree but still in the index
    }
    if (isBinary(buf)) continue;
    for (const h of scanText(buf.toString("utf8"), opts)) out.push({ file: relative(base, f), ...h });
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

export function trackedFiles(root = ROOT) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .map((f) => join(root, f));
}

/** Pack the real tarball, extract it, return {dir, files, cleanup}. */
export function packTarball(root = ROOT) {
  const tmp = mkdtempSync(join(tmpdir(), "radmail-pack-"));
  const json = execFileSync("npm", ["pack", "--json", "--pack-destination", tmp], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const name = JSON.parse(json)[0].filename;
  const ex = join(tmp, "x");
  mkdirSync(ex);
  execFileSync("tar", ["-xzf", join(tmp, name), "-C", ex]);
  const dir = join(ex, "package");
  return { dir, files: walk(dir), cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

function report(label, hits) {
  if (hits.length === 0) {
    console.log(`✅ ${label}: clean`);
    return 0;
  }
  console.error(`🛑 ${label}: ${hits.length} hit(s)`);
  for (const h of hits) console.error(`   ${h.file}:${h.line}  ${h.rule}  ${h.excerpt}`);
  return 1;
}

function selfTest() {
  let failed = 0;
  const check = (name, cond) => {
    console.log(`${cond ? "✅" : "❌"} ${name}`);
    if (!cond) failed++;
  };
  const planted = "jordan.lee" + "@" + "northwind-supply.co";
  check("NEGATIVE control: a planted real-looking address is refused", scanText(`to: "${planted}"`).length === 1);
  check("NEGATIVE control: a home-directory path is refused", scanText("// " + "/" + "Users/someone/dev/x.ts").length === 1);
  check("NEGATIVE control: a finding-id shape is refused", scanText("closes acme-" + "20260102030405").length === 1);
  check(
    "NEGATIVE control: a denylisted term is refused in ANY case",
    scanText("ships to Northwind today", { terms: parseDenylist("northwind") }).length === 1,
  );
  check("NEGATIVE control: the term excerpt never prints the term", !JSON.stringify(scanText("Northwind", { terms: ["northwind"] })).toLowerCase().includes("northwind"));
  check("POSITIVE control: example.com / .example / allowed addresses pass", scanText('a@example.com b@shop.example.org c@known.example d@x.invalid security@radmail.ai').length === 0);
  check("POSITIVE control: a term inside a longer word does not fire", scanText("northwindows", { terms: ["northwind"] }).length === 0);
  check("POSITIVE control: npm specifiers and versions are not addresses", scanText('"zod-to-json-schema@3.25.2" radmail-mcp@0.5.1 @modelcontextprotocol/sdk').length === 0);

  const dir = mkdtempSync(join(tmpdir(), "radmail-denylist-"));
  try {
    writeFileSync(join(dir, "clean.ts"), 'export const from = "pat@example.com";\n');
    check("POSITIVE control: a clean tree passes", scanFiles(walk(dir), dir, {}).length === 0);
    writeFileSync(join(dir, "dirty.ts"), `export const from = "${planted}";\n`);
    check("NEGATIVE control: the same tree with one planted address fails", scanFiles(walk(dir), dir, {}).length === 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed === 0 ? "self-test: all controls held" : `self-test: ${failed} control(s) FAILED`);
  return failed === 0 ? 0 : 1;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) process.exit(selfTest());

  const ri = args.indexOf("--root");
  const root = ri >= 0 ? args[ri + 1] : ROOT;
  if (!root) {
    console.error("usage: --root <repo-dir>");
    process.exit(64);
  }
  const terms = parseDenylist(process.env.RADMAIL_PUBLIC_DENYLIST);
  if (terms.length === 0) {
    console.warn("⚠️  RADMAIL_PUBLIC_DENYLIST is not set — THE TERM HALF OF THIS GATE DID NOT RUN.");
    console.warn("    Structural rules (addresses, home paths, finding ids) still ran.");
  } else {
    console.log(`denylist: ${terms.length} term(s) loaded`);
  }

  let exit = 0;
  let tracked;
  try {
    tracked = trackedFiles(root);
  } catch (e) {
    console.error(`🛑 could not list tracked files in ${root}: ${e.message}`);
    process.exit(2);
  }
  if (tracked.length === 0) {
    console.error(`🛑 ${root}: zero tracked files — an empty scan is not a clean one.`);
    process.exit(2);
  }
  exit |= report(`source (${tracked.length} tracked files)`, scanFiles(tracked, root, { terms }));

  if (args.includes("--pack")) {
    let pack;
    try {
      pack = packTarball(root);
    } catch (e) {
      console.error(`🛑 could not run npm pack: ${e.message}`);
      process.exit(2);
    }
    try {
      const rel = pack.files.map((f) => relative(pack.dir, f));
      const forbidden = rel.filter((p) => FORBIDDEN_PACK_PATHS.some((re) => re.test(p)));
      if (forbidden.length) {
        console.error(`🛑 tarball: ${forbidden.length} file(s) that must not ship:`);
        for (const p of forbidden) console.error(`   ${p}`);
        exit |= 1;
      }
      if (!rel.includes("dist/src/index.js")) {
        console.error("🛑 tarball: dist/src/index.js is missing — run `npm run build` first; an empty tarball is not a clean one.");
        exit |= 1;
      }
      exit |= report(`npm tarball (${rel.length} files)`, scanFiles(pack.files, pack.dir, { terms }));
    } finally {
      pack.cleanup();
    }
  }
  process.exit(exit);
}

function isEntry() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? "");
  } catch {
    return false;
  }
}
if (isEntry()) main();
