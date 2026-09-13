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
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ChannelState = "PUBLISHED-CURRENT" | "BEHIND" | "LIVE-AHEAD" | "CANNOT-VERIFY";

export interface LiveRead {
  channel: "npm" | "mcp-registry";
  url: string;
  ok: boolean;
  version?: string;
  publishedAt?: string;
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
  return { channel: "npm", url, ok: true, version: latest, publishedAt: json?.time?.[latest] };
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
  if (meta && meta.isLatest === false) {
    return { channel: "mcp-registry", url, ok: false, error: `the "latest" endpoint returned ${s.version} marked isLatest:false` };
  }
  return { channel: "mcp-registry", url, ok: true, version: s.version, publishedAt: meta?.publishedAt };
}

// ── classification (pure) ────────────────────────────────────────────────────
export interface AheadSince { sha: string; date: string; commits: number }

export function classify(mainVersion: string, read: LiveRead, since?: AheadSince | null, now = new Date()): ChannelVerdict {
  if (!read.ok || !read.version) {
    return { ...read, state: "CANNOT-VERIFY", detail: `could not read the live version — ${read.error ?? "no version"}. This is NOT "in sync".` };
  }
  const c = compareSemver(mainVersion, read.version);
  if (c === 0) return { ...read, state: "PUBLISHED-CURRENT", detail: `live ${read.version} == main ${mainVersion}` };
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

  let pkg: { name?: string; version?: string; mcpName?: string };
  try { pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")); } catch {
    console.error("\n[check-live-registry] ⚪️ CANNOT-VERIFY — package.json unreadable.\n"); process.exit(2);
  }
  if (!pkg.name || !pkg.mcpName || !pkg.version || !parseSemver(pkg.version)) {
    console.error(`\n[check-live-registry] ⚪️ CANNOT-VERIFY — package.json needs name, mcpName and a semver version (got ${JSON.stringify({ name: pkg.name, mcpName: pkg.mcpName, version: pkg.version })}).\n`);
    process.exit(2);
  }

  const f = fetch as unknown as FetchLike;
  const reads = await Promise.all([readNpm(f, pkg.name, timeoutMs), readMcpRegistry(f, pkg.mcpName, timeoutMs)]);
  const verdicts = reads.map((r) => classify(pkg.version!, r, r.ok && r.version ? aheadSince(ROOT, r.version) : null));

  // The manifest that `mcp-publisher publish` would send. If it lags package.json,
  // publishing to the MCP registry from this tree re-publishes the OLD version.
  let serverJsonVersion: string | undefined;
  try { serverJsonVersion = JSON.parse(readFileSync(join(ROOT, "server.json"), "utf8")).version; } catch { /* reported below */ }
  const code = exitCodeFor(verdicts);

  if (json) {
    console.log(JSON.stringify({ mainVersion: pkg.version, serverJsonVersion: serverJsonVersion ?? null, verdicts, exit: code }, null, 2));
  } else {
    const icon: Record<ChannelState, string> = { "PUBLISHED-CURRENT": "✅", BEHIND: "🔴", "LIVE-AHEAD": "🟠", "CANNOT-VERIFY": "⚪️" };
    console.log(`\n[check-live-registry] main (package.json) = ${pkg.version}`);
    for (const v of verdicts) console.log(`  ${icon[v.state]} ${v.channel.padEnd(12)} ${v.state.padEnd(17)} ${v.detail}\n     read from ${v.url}`);
    if (serverJsonVersion === undefined) console.log("  ⚪️ server.json unreadable — cannot say what an MCP-registry publish from this tree would send");
    else if (serverJsonVersion !== pkg.version) console.log(`  🟠 server.json says ${serverJsonVersion}, package.json says ${pkg.version} — an MCP-registry publish from this tree would re-send ${serverJsonVersion}`);
    const summary = code === 0 ? "PUBLISHED-CURRENT on every channel" : code === 1 ? "main is NOT what the public channels serve" : "COULD NOT VERIFY — this is not a pass";
    console.log(`  ⇒ exit ${code}: ${summary}. This gate publishes nothing.\n`);
  }
  process.exit(code);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`\n[check-live-registry] ⚪️ CANNOT-VERIFY — crashed: ${(e as Error)?.stack ?? e}\n`); process.exit(2); });
}
