// IS WHAT MAIN SAYS WE SHIP ACTUALLY WHAT THE PUBLIC CHANNELS SERVE?
//
// ─────────────────────────────────────────────────────────────────────────────
// 🩸 MEASURED 2026-09-13
//
//   origin/main package.json            0.5.1   (since 6dee503, 2026-08-29)
//   npm  dist-tags.latest               0.5.0   (published 2026-08-11)
//   MCP registry isLatest               0.5.0   (published 2026-08-17)
//
// Six merged PRs sat on main, CI-green, and reached nobody. The live 0.5.0
// build names tools that never existed, including inside the human-review
// sentence of the safety contract. Every agent that discovers RadMail through
// a registry installs that build.
//
// 🔑 WHY THE EXISTING GATE PASSED. `test/manifest.test.ts` pins package.json
// against SERVER_INFO and .well-known/mcp.json. All three halves live in this
// tree, so the pin passes whether or not anything was distributed — it passed
// at 0.4.0 (see ci.yml: the npm build self-reported 0.4.0 after the fix landed)
// and it passes at 0.5.1 today. This gate asks the only party that knows: the
// registries themselves.
//
// 🩸 AND A MATCHING NUMBER IS NOT MATCHING CODE (review, 2026-09-13). The first
// version of this gate compared version strings, so main 0.5.1 plus six unbumped
// PRs against an npm 0.5.1 read PUBLISHED-CURRENT — the same blindness one level
// up. npm records the commit a version was packed from (`versions[v].gitHead`);
// at an equal version the gate now counts commits on main since that commit that
// touch a PUBLISHED path (package.json `files` minus the gitignored build dir,
// plus package.json itself). Any such commit is BEHIND. No gitHead, a commit this
// clone lacks, or no git history is CANNOT-VERIFY — never current.
// ⚠️ NAMED LIMIT: gitHead is HEAD at pack time. A publish from a DIRTY tree (the
// stale-dist defect of #7) records a clean-looking sha; nothing on the registry
// side can see that.
//
// 🩸 AND A DELETED REGISTRY RECORD IS NOT A SERVED ONE. The MCP registry's
// official metadata carries `status` and `isLatest`; the first version read only
// `isLatest === false`, so {status:"deleted"} and a record with no metadata at all
// both passed. Now status must be "active" AND isLatest must be present and true.
//
// ⚖️ THREE STATES PER CHANNEL, NEVER COLLAPSED:
//   PUBLISHED-CURRENT  live version == main
//   BEHIND             main is ahead of live — says by how much and since when
//   CANNOT-VERIFY      unreachable, non-200 (auth, rate limit, 5xx), a body
//                      that is not the registry record we asked for
// plus LIVE-AHEAD (live > main: published from something main does not carry),
// which is named rather than folded into "current".
//
// 🛑 AN UNREACHABLE REGISTRY IS NOT "IN SYNC". It exits 2, never 0.
// 🛑 THIS GATE PUBLISHES NOTHING. Publishing is a credential action and a human's.
//
//   node --import tsx scripts/check-live-registry.ts [--json] [--timeout-ms N]
//
// Exit: 0 every channel PUBLISHED-CURRENT
//       1 some channel BEHIND or LIVE-AHEAD (a proven gap outranks an unknown)
//       2 otherwise, some channel CANNOT-VERIFY (or main's version unreadable)
//       64 usage

import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ChannelState = "PUBLISHED-CURRENT" | "BEHIND" | "LIVE-AHEAD" | "CANNOT-VERIFY";

export interface LiveRead {
  channel: "npm" | "mcp-registry";
  url: string;
  ok: boolean;
  version?: string;
  publishedAt?: string;
  /** npm only: the commit the served version was packed from. */
  gitHead?: string;
  /** mcp-registry only: the npm package version the record points installers at. */
  packageVersion?: string;
  /** Why it could not be read. Present iff ok === false. */
  error?: string;
}

export interface ChannelVerdict extends LiveRead {
  state: ChannelState;
  detail: string;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export const NPM_URL = (pkg: string) => `https://registry.npmjs.org/${pkg.replace("/", "%2F")}`;
export const MCP_URL = (name: string) =>
  `https://registry.modelcontextprotocol.io/v0/servers/${encodeURIComponent(name)}/versions/latest`;

// ── semver (x.y.z[-pre]) ─────────────────────────────────────────────────────
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseSemver(v: string): [number, number, number, string | null] | null {
  const m = SEMVER.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? null] : null;
}

/** <0 if a<b, 0 if equal, >0 if a>b. Throws on an unparseable version — a caller must not guess. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`unparseable version: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] as number) - (pb[i] as number);
  if (pa[3] === pb[3]) return 0;
  if (pa[3] === null) return 1; // release > prerelease
  if (pb[3] === null) return -1;
  return pa[3] < pb[3] ? -1 : 1;
}

/** Human distance, e.g. "1 patch" / "1 minor". */
export function semverDistance(from: string, to: string): string {
  const a = parseSemver(from)!;
  const b = parseSemver(to)!;
  if (a[0] !== b[0]) return `${b[0] - a[0]} major`;
  if (a[1] !== b[1]) return `${b[1] - a[1]} minor`;
  if (a[2] !== b[2]) return `${b[2] - a[2]} patch`;
  return "prerelease only";
}

// ── reading the registries ───────────────────────────────────────────────────
async function getJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<{ json?: any; error?: string }> {
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  } catch (e) {
    return { error: `unreachable: ${(e as Error)?.message ?? String(e)}` };
  }
  if (res.status !== 200) {
    const why =
      res.status === 401 || res.status === 403 ? "auth refused" :
      res.status === 429 ? "rate limited" :
      res.status === 404 ? "not found (cannot distinguish unpublished from a wrong URL)" :
      res.status >= 500 ? "registry error" : "unexpected status";
    return { error: `HTTP ${res.status} — ${why}` };
  }
  let body = "";
  try {
    body = await res.text();
    return { json: JSON.parse(body) };
  } catch {
    return { error: `HTTP 200 but body is not JSON (${body.slice(0, 60).replace(/\s+/g, " ")}${body.length > 60 ? `… +${body.length - 60} chars` : ""})` };
  }
}

export async function readNpm(fetchImpl: FetchLike, pkgName: string, timeoutMs = 10_000): Promise<LiveRead> {
  const url = NPM_URL(pkgName);
  const { json, error } = await getJson(fetchImpl, url, timeoutMs);
  if (error) return { channel: "npm", url, ok: false, error };
  if (json?.name !== pkgName) return { channel: "npm", url, ok: false, error: `record names ${JSON.stringify(json?.name)}, not ${pkgName}` };
  const latest = json?.["dist-tags"]?.latest;
  if (typeof latest !== "string" || !parseSemver(latest)) {
    return { channel: "npm", url, ok: false, error: `no readable dist-tags.latest (${JSON.stringify(latest)})` };
  }
  const gitHead = json?.versions?.[latest]?.gitHead;
  return {
    channel: "npm", url, ok: true, version: latest, publishedAt: json?.time?.[latest],
    ...(typeof gitHead === "string" && gitHead.length > 0 ? { gitHead } : {}),
  };
}

export async function readMcpRegistry(fetchImpl: FetchLike, serverName: string, timeoutMs = 10_000): Promise<LiveRead> {
  const url = MCP_URL(serverName);
  const { json, error } = await getJson(fetchImpl, url, timeoutMs);
  if (error) return { channel: "mcp-registry", url, ok: false, error };
  const s = json?.server;
  if (s?.name !== serverName) return { channel: "mcp-registry", url, ok: false, error: `record names ${JSON.stringify(s?.name)}, not ${serverName}` };
  if (typeof s?.version !== "string" || !parseSemver(s.version)) {
    return { channel: "mcp-registry", url, ok: false, error: `no readable server.version (${JSON.stringify(s?.version)})` };
  }
  const meta = json?._meta?.["io.modelcontextprotocol.registry/official"];
  if (!meta || typeof meta !== "object") {
    return { channel: "mcp-registry", url, ok: false, error: `record for ${s.version} carries no official registry metadata — cannot tell whether it is served` };
  }
  if (meta.status !== "active") {
    return { channel: "mcp-registry", url, ok: false, error: `record for ${s.version} has status ${JSON.stringify(meta.status)}, not "active"` };
  }
  if (meta.isLatest !== true) {
    return { channel: "mcp-registry", url, ok: false, error: `record for ${s.version} has isLatest ${JSON.stringify(meta.isLatest)}, not true` };
  }
  const npmPkg = Array.isArray(s.packages) ? s.packages.find((p: any) => p?.registryType === "npm") : undefined;
  return {
    channel: "mcp-registry", url, ok: true, version: s.version, publishedAt: meta.publishedAt,
    ...(typeof npmPkg?.version === "string" ? { packageVersion: npmPkg.version } : {}),
  };
}

// ── classification (pure) ────────────────────────────────────────────────────
export interface AheadSince { sha: string; date: string; commits: number }

export type SourceGap =
  | { kind: "ancestor"; commits: { sha: string; date: string; subject: string }[] }
  | { kind: "not-ancestor" }
  | { kind: "unknown"; why: string };

export interface ClassifyOptions {
  /** Commits on main since `gitHead` that touch published paths. Absent = no git history = CANNOT-VERIFY at an equal version. */
  sourceGap?: (gitHead: string) => SourceGap;
}

export function classify(
  mainVersion: string, read: LiveRead, since?: AheadSince | null, now = new Date(), opts: ClassifyOptions = {},
): ChannelVerdict {
  if (!read.ok || !read.version) {
    return { ...read, state: "CANNOT-VERIFY", detail: `could not read the live version — ${read.error ?? "no version"}. This is NOT "in sync".` };
  }
  const c = compareSemver(mainVersion, read.version);
  if (c === 0) return classifyEqualVersion(mainVersion, read, opts);
  if (c < 0) {
    return { ...read, state: "LIVE-AHEAD", detail: `live ${read.version} is AHEAD of main ${mainVersion} — something was published that main does not carry` };
  }
  const parts = [`main ${mainVersion} is ${semverDistance(read.version, mainVersion)} ahead of live ${read.version}`];
  if (read.publishedAt) {
    const days = Math.floor((now.getTime() - Date.parse(read.publishedAt)) / 86_400_000);
    if (Number.isFinite(days)) parts.push(`live published ${read.publishedAt.slice(0, 10)} (${days}d ago)`);
  }
  if (since) parts.push(`main moved past it at ${since.sha.slice(0, 7)} on ${since.date.slice(0, 10)}, ${since.commits} commit(s) on main from there to HEAD inclusive`);
  else parts.push("when main moved past it: unknown (no git history here)");
  return { ...read, state: "BEHIND", detail: parts.join("; ") };
}

const cannot = (read: LiveRead, why: string): ChannelVerdict =>
  ({ ...read, state: "CANNOT-VERIFY", detail: `live ${read.version} == main by NUMBER, but ${why}. This is NOT "in sync".` });

/** Equal version strings prove nothing about the code. Each channel must tie the number to a build. */
function classifyEqualVersion(mainVersion: string, read: LiveRead, opts: ClassifyOptions): ChannelVerdict {
  if (read.channel === "mcp-registry") {
    if (read.packageVersion === undefined) return cannot(read, "the record carries no npm package, so it cannot be tied to a build");
    if (!parseSemver(read.packageVersion)) return cannot(read, `its npm package version ${JSON.stringify(read.packageVersion)} is unreadable`);
    const p = compareSemver(mainVersion, read.packageVersion);
    if (p > 0) return { ...read, state: "BEHIND", detail: `record says ${read.version} but points installers at npm ${read.packageVersion} — main is ${mainVersion}` };
    if (p < 0) return { ...read, state: "LIVE-AHEAD", detail: `record points installers at npm ${read.packageVersion}, ahead of main ${mainVersion}` };
    return { ...read, state: "PUBLISHED-CURRENT", detail: `live ${read.version} (npm package ${read.packageVersion}) == main; code freshness is judged on the npm channel` };
  }
  if (!read.gitHead) return cannot(read, "npm records no gitHead for it, so the served code cannot be tied to a commit");
  if (!opts.sourceGap) return cannot(read, "no git history is available to compare its gitHead against main");
  const g = opts.sourceGap(read.gitHead);
  const sha = read.gitHead.slice(0, 7);
  if (g.kind === "unknown") return cannot(read, `its gitHead ${sha} could not be compared (${g.why})`);
  if (g.kind === "not-ancestor") {
    return { ...read, state: "LIVE-AHEAD", detail: `live ${read.version} was packed from ${sha}, which main does not contain — published from code main does not carry` };
  }
  if (g.commits.length > 0) {
    const oldest = g.commits[g.commits.length - 1]!;
    return {
      ...read, state: "BEHIND",
      detail: `same version number ${mainVersion}, but main has ${g.commits.length} commit(s) touching published paths since the served build (${sha}); oldest unreleased ${oldest.sha.slice(0, 7)} on ${oldest.date.slice(0, 10)} — that code reaches nobody until a version bump is published`,
    };
  }
  return { ...read, state: "PUBLISHED-CURRENT", detail: `live ${read.version} == main, packed from ${sha} with 0 commits touching published paths since (gitHead is HEAD at pack time; a dirty pack tree is not detectable)` };
}

const SHA = /^[0-9a-f]{7,40}$/;

/** Published source paths: package.json `files` minus gitignored build output, plus package.json itself. */
export function publishedPaths(pkg: { files?: unknown }): string[] {
  const files = Array.isArray(pkg.files) ? pkg.files.filter((x): x is string => typeof x === "string") : [];
  const out = files.filter((p) => p !== "dist" && !p.startsWith("dist/"));
  return [...new Set([...out, "package.json"])];
}

export function sourceGapFromGit(root: string, gitHead: string, paths: string[]): SourceGap {
  if (!SHA.test(gitHead)) return { kind: "unknown", why: `gitHead ${JSON.stringify(gitHead.slice(0, 40))} is not a commit sha` };
  const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const shallow = run(["rev-parse", "--is-shallow-repository"]);
  if (shallow.status !== 0) return { kind: "unknown", why: "not a git repository" };
  if (shallow.stdout.trim() === "true") return { kind: "unknown", why: "shallow clone — history is incomplete" };
  if (run(["cat-file", "-e", `${gitHead}^{commit}`]).status !== 0) return { kind: "unknown", why: "commit not in this clone (fetch, then re-run)" };
  // merge-base --is-ancestor: 0 yes · 1 no · anything else is an error, NOT a "no".
  const anc = run(["merge-base", "--is-ancestor", gitHead, "HEAD"]);
  if (anc.status === 1) return { kind: "not-ancestor" };
  if (anc.status !== 0) return { kind: "unknown", why: `merge-base failed (${anc.status})` };
  const log = run(["log", "--format=%H%x09%cI%x09%s", `${gitHead}..HEAD`, "--", ...paths]);
  if (log.status !== 0) return { kind: "unknown", why: "git log failed" };
  const commits = log.stdout.split("\n").filter(Boolean).map((l) => {
    const [sha, date, ...rest] = l.split("\t");
    return { sha: sha!, date: date!, subject: rest.join("\t") };
  });
  return { kind: "ancestor", commits };
}

export interface LocalManifest {
  packageJsonVersion: string;
  serverJsonVersion: string | null;
  serverJsonPackageVersion: string | null;
  mismatches: string[];
}

/** What an MCP-registry publish from this tree would send: top-level version AND the npm package entry. */
export function readLocalManifest(root: string, packageJsonVersion: string, pkgName: string): LocalManifest {
  let sj: any;
  try { sj = JSON.parse(readFileSync(join(root, "server.json"), "utf8")); } catch {
    return { packageJsonVersion, serverJsonVersion: null, serverJsonPackageVersion: null, mismatches: ["server.json unreadable — cannot say what an MCP-registry publish from this tree would send"] };
  }
  const top = typeof sj?.version === "string" ? sj.version : null;
  const npmPkg = Array.isArray(sj?.packages) ? sj.packages.find((p: any) => p?.registryType === "npm" && p?.identifier === pkgName) : undefined;
  const pkgV = typeof npmPkg?.version === "string" ? npmPkg.version : null;
  const mismatches: string[] = [];
  if (top !== packageJsonVersion) mismatches.push(`server.json version is ${JSON.stringify(top)}, package.json is ${packageJsonVersion}`);
  if (pkgV !== packageJsonVersion) mismatches.push(`server.json packages[npm ${pkgName}].version is ${JSON.stringify(pkgV)}, package.json is ${packageJsonVersion}`);
  return { packageJsonVersion, serverJsonVersion: top, serverJsonPackageVersion: pkgV, mismatches };
}

export function exitCodeFor(verdicts: ChannelVerdict[]): 0 | 1 | 2 {
  if (verdicts.some((v) => v.state === "BEHIND" || v.state === "LIVE-AHEAD")) return 1;
  if (verdicts.length === 0 || verdicts.some((v) => v.state !== "PUBLISHED-CURRENT")) return 2;
  return 0;
}

// ── git: when did main's package.json first exceed the live version? ────────
export function aheadSince(root: string, liveVersion: string): AheadSince | null {
  try {
    // A shallow clone would name its OLDEST FETCHED commit as "when main moved past" — a confident wrong date. Say unknown instead.
    if (execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: root, encoding: "utf8" }).trim() === "true") return null;
    const log = execFileSync("git", ["log", "--format=%H %cI", "--", "package.json"], { cwd: root, encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
    let earliestAhead: { sha: string; date: string } | null = null;
    for (const line of log) {
      const [sha, date] = line.split(" ");
      let v: string | undefined;
      try { v = JSON.parse(execFileSync("git", ["show", `${sha}:package.json`], { cwd: root, encoding: "utf8" })).version; } catch { continue; }
      if (!v || !parseSemver(v) || compareSemver(v, liveVersion) <= 0) break;
      earliestAhead = { sha: sha!, date: date! };
    }
    if (!earliestAhead) return null;
    const commits = Number(execFileSync("git", ["rev-list", "--count", `${earliestAhead.sha}..HEAD`], { cwd: root, encoding: "utf8" }).trim()) + 1;
    return { ...earliestAhead, commits };
  } catch {
    return null;
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
async function main() {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  let json = false;
  let timeoutMs = 10_000;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--timeout-ms") timeoutMs = Number(args[++i]);
    else if (a === "--help" || a === "-h") { console.log("usage: node --import tsx scripts/check-live-registry.ts [--json] [--timeout-ms N]"); process.exit(0); }
    else { console.error(`\n  🛑 unknown flag: ${a}\n     known: --json --timeout-ms <n> --help\n`); process.exit(64); }
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { console.error("  🛑 --timeout-ms must be a positive number"); process.exit(64); }

  let pkg: { name?: string; version?: string; mcpName?: string; files?: unknown };
  try { pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")); } catch {
    console.error("\n[check-live-registry] ⚪️ CANNOT-VERIFY — package.json unreadable.\n"); process.exit(2);
  }
  if (!pkg.name || !pkg.mcpName || !pkg.version || !parseSemver(pkg.version)) {
    console.error(`\n[check-live-registry] ⚪️ CANNOT-VERIFY — package.json needs name, mcpName and a semver version (got ${JSON.stringify({ name: pkg.name, mcpName: pkg.mcpName, version: pkg.version })}).\n`);
    process.exit(2);
  }

  const f = fetch as unknown as FetchLike;
  const reads = await Promise.all([readNpm(f, pkg.name, timeoutMs), readMcpRegistry(f, pkg.mcpName, timeoutMs)]);
  const paths = publishedPaths(pkg);
  const verdicts = reads.map((r) =>
    classify(pkg.version!, r, r.ok && r.version ? aheadSince(ROOT, r.version) : null, new Date(), {
      sourceGap: (h) => sourceGapFromGit(ROOT, h, paths),
    }));

  // The manifest that `mcp-publisher publish` would send. If it lags package.json,
  // publishing to the MCP registry from this tree re-publishes the OLD version.
  const localManifest = readLocalManifest(ROOT, pkg.version, pkg.name);
  const code = exitCodeFor(verdicts);

  if (json) {
    console.log(JSON.stringify({ mainVersion: pkg.version, publishedPaths: paths, localManifest, verdicts, exit: code }, null, 2));
  } else {
    const icon: Record<ChannelState, string> = { "PUBLISHED-CURRENT": "✅", BEHIND: "🔴", "LIVE-AHEAD": "🟠", "CANNOT-VERIFY": "⚪️" };
    console.log(`\n[check-live-registry] main (package.json) = ${pkg.version}`);
    for (const v of verdicts) console.log(`  ${icon[v.state]} ${v.channel.padEnd(12)} ${v.state.padEnd(17)} ${v.detail}\n     read from ${v.url}`);
    for (const m of localManifest.mismatches) console.log(`  🟠 local manifest: ${m} — an MCP-registry publish from this tree would send the wrong version`);
    const summary = code === 0 ? "PUBLISHED-CURRENT on every channel" : code === 1 ? "main is NOT what the public channels serve" : "COULD NOT VERIFY — this is not a pass";
    console.log(`  ⇒ exit ${code}: ${summary}. This gate publishes nothing.\n`);
  }
  process.exit(code);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`\n[check-live-registry] ⚪️ CANNOT-VERIFY — crashed: ${(e as Error)?.stack ?? e}\n`); process.exit(2); });
}
