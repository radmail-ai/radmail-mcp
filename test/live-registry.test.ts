// THE RELEASE GATE MUST READ THE LIVE REGISTRIES — AND MUST NOT CALL AN
// UNREACHABLE, DELETED, OR MERELY SAME-NUMBERED ONE "IN SYNC".
//
// Hermetic: every registry response is mocked. The real-network run lives in
// the `live-registry` workflow, not in `npm test` (a registry blip must not turn
// an unrelated PR red — see ci.yml).
//
// 🎯 The POSITIVE control (live == main, built from main's code, record active
// and latest → exit 0) is load-bearing: a gate that always says BEHIND, or
// always refuses, passes every other test in this file.
//
// 🪤 Namespace import on purpose: these tests were first run against the pre-
// review gate, and a missing named export would have failed the whole file at
// link time instead of showing each case passing WRONGLY.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as gate from "../scripts/check-live-registry.js";
import type { ChannelVerdict, SourceGap } from "../scripts/check-live-registry.js";

const PKG = "radmail-mcp";
const MCP = "ai.radmail/radmail-mcp";
const NOW = new Date("2026-09-13T12:00:00Z");
const HEAD_AT_PUBLISH = "6dee50306b45709035d751b65c6c2441de36d973";

type Route = { status: number; body: string } | Error;
function mockFetch(routes: Record<string, Route>) {
  return async (url: string) => {
    const r = routes[url];
    if (!r) throw new Error(`unmocked url ${url}`);
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => r.body };
  };
}
const npmBody = (latest: string, gitHead: string | null = HEAD_AT_PUBLISH) =>
  JSON.stringify({
    name: PKG,
    "dist-tags": { latest },
    time: { [latest]: "2026-08-11T03:57:30.892Z" },
    versions: { [latest]: gitHead === null ? { version: latest } : { version: latest, gitHead } },
  });
const OFFICIAL = "io.modelcontextprotocol.registry/official";
const activeLatest = { status: "active", isLatest: true, publishedAt: "2026-08-17T03:35:34.685Z" };
const mcpBody = (version: string, meta: Record<string, unknown> | null = activeLatest, pkgVersion: string | null = version) =>
  JSON.stringify({
    server: {
      name: MCP,
      version,
      ...(pkgVersion === null ? {} : { packages: [{ registryType: "npm", identifier: PKG, version: pkgVersion }] }),
    },
    ...(meta === null ? {} : { _meta: { [OFFICIAL]: meta } }),
  });

const noGap = (): SourceGap => ({ kind: "ancestor", commits: [] });

async function verdictsFor(
  main: string, npm: Route, mcp: Route, sourceGap: ((h: string) => SourceGap) | null = noGap,
): Promise<ChannelVerdict[]> {
  const f = mockFetch({ [gate.NPM_URL(PKG)]: npm, [gate.MCP_URL(MCP)]: mcp });
  const reads = await Promise.all([gate.readNpm(f, PKG), gate.readMcpRegistry(f, MCP)]);
  return reads.map((r) =>
    gate.classify(main, r, { sha: HEAD_AT_PUBLISH, date: "2026-08-29T15:00:29-07:00", commits: 7 }, NOW, sourceGap === null ? {} : { sourceGap }),
  );
}
const states = (v: ChannelVerdict[]) => v.map((x) => x.state);

describe("the three states, never collapsed", () => {
  test("POSITIVE CONTROL: same version, built from main's code, record active+latest → PUBLISHED-CURRENT, exit 0", async () => {
    const v = await verdictsFor("0.5.1", { status: 200, body: npmBody("0.5.1") }, { status: 200, body: mcpBody("0.5.1") });
    assert.deepEqual(states(v), ["PUBLISHED-CURRENT", "PUBLISHED-CURRENT"], v.map((x) => x.detail).join(" | "));
    assert.equal(gate.exitCodeFor(v), 0);
  });

  test("TODAY'S REAL SHAPE: main 0.5.1, both channels 0.5.0 → BEHIND with distance and dates, exit 1", async () => {
    const v = await verdictsFor("0.5.1", { status: 200, body: npmBody("0.5.0") }, { status: 200, body: mcpBody("0.5.0") });
    assert.deepEqual(states(v), ["BEHIND", "BEHIND"]);
    assert.match(v[0].detail, /main 0\.5\.1 is 1 patch ahead of live 0\.5\.0/);
    assert.match(v[0].detail, /live published 2026-08-11 \(33d ago\)/);
    assert.match(v[1].detail, /live published 2026-08-17 \(27d ago\)/);
    assert.match(v[0].detail, /main moved past it at 6dee503 on 2026-08-29, 7 commit/);
    assert.equal(gate.exitCodeFor(v), 1);
  });

  test("one channel current, the other behind → BEHIND is not hidden by the current one", async () => {
    const v = await verdictsFor("0.5.1", { status: 200, body: npmBody("0.5.1") }, { status: 200, body: mcpBody("0.5.0") });
    assert.deepEqual(states(v), ["PUBLISHED-CURRENT", "BEHIND"]);
    assert.equal(gate.exitCodeFor(v), 1);
  });

  for (const [label, route] of [
    ["network unreachable", new Error("getaddrinfo ENOTFOUND registry.npmjs.org")],
    ["auth failure (401)", { status: 401, body: "" }],
    ["forbidden (403)", { status: 403, body: "" }],
    ["rate limit (429)", { status: 429, body: "slow down" }],
    ["registry 503", { status: 503, body: "" }],
    ["404", { status: 404, body: "{}" }],
    ["200 with a captive-portal HTML body", { status: 200, body: "<html>sign in to wifi</html>" }],
    ["200 JSON for a DIFFERENT package", { status: 200, body: JSON.stringify({ name: "other", "dist-tags": { latest: "0.5.1" } }) }],
    ["200 with no dist-tags.latest", { status: 200, body: JSON.stringify({ name: PKG }) }],
  ] as const) {
    test(`CANNOT-VERIFY: npm ${label} → exit 2, never 0, even though the other channel is current`, async () => {
      const v = await verdictsFor("0.5.1", route as Route, { status: 200, body: mcpBody("0.5.1") });
      assert.equal(v[0].state, "CANNOT-VERIFY");
      assert.equal(v[0].ok, false);
      assert.match(v[0].detail, /NOT "in sync"/);
      assert.equal(v[1].state, "PUBLISHED-CURRENT");
      assert.equal(gate.exitCodeFor(v), 2);
    });
  }

  test("CANNOT-VERIFY: MCP registry unreachable → exit 2", async () => {
    const v = await verdictsFor("0.5.1", { status: 200, body: npmBody("0.5.1") }, new Error("The operation was aborted due to timeout"));
    assert.equal(v[1].state, "CANNOT-VERIFY");
    assert.equal(gate.exitCodeFor(v), 2);
  });

  test("both unreachable → exit 2 (the all-unknown case must not read as clean)", async () => {
    const v = await verdictsFor("0.5.1", new Error("offline"), new Error("offline"));
    assert.deepEqual(states(v), ["CANNOT-VERIFY", "CANNOT-VERIFY"]);
    assert.equal(gate.exitCodeFor(v), 2);
  });

  test("a proven BEHIND outranks an unknown: npm behind + MCP unreachable → exit 1, both states still reported", async () => {
    const v = await verdictsFor("0.5.1", { status: 200, body: npmBody("0.5.0") }, { status: 429, body: "" });
    assert.deepEqual(states(v), ["BEHIND", "CANNOT-VERIFY"]);
    assert.equal(gate.exitCodeFor(v), 1);
  });

  test("LIVE-AHEAD (live newer than main) is named, not folded into current", async () => {
    const v = await verdictsFor("0.5.1", { status: 200, body: npmBody("0.6.0") }, { status: 200, body: mcpBody("0.5.1") });
    assert.equal(v[0].state, "LIVE-AHEAD");
    assert.equal(gate.exitCodeFor(v), 1);
  });

  test("an empty verdict list is not a pass", () => {
    assert.equal(gate.exitCodeFor([]), 2);
  });
});

// Review finding 1: the version NUMBER matching is not the CODE matching.
describe("same version number, different code (review finding 1)", () => {
  const sixUnbumped = (): SourceGap => ({
    kind: "ancestor",
    commits: ["ec288d0", "c14a8ab", "d803332", "924df2b", "0f722b0", "7d46df9"].map((sha, i) => ({
      sha, date: `2026-09-0${2 - Math.min(i, 1)}T12:00:00-07:00`, subject: `pr ${i}`,
    })),
  });

  test("main 0.5.1 + six unbumped published-path commits, npm serves 0.5.1 → BEHIND, exit 1 (was PUBLISHED-CURRENT)", async () => {
    const v = await verdictsFor("0.5.1", { status: 200, body: npmBody("0.5.1") }, { status: 200, body: mcpBody("0.5.1") }, sixUnbumped);
    assert.equal(v[0].state, "BEHIND", v[0].detail);
    assert.match(v[0].detail, /6 commit\(s\) touching published paths/);
    assert.match(v[0].detail, /6dee503/);
    assert.equal(gate.exitCodeFor(v), 1);
  });

  test("the served version records NO gitHead → CANNOT-VERIFY, exit 2 (never current)", async () => {
    const v = await verdictsFor("0.5.1", { status: 200, body: npmBody("0.5.1", null) }, { status: 200, body: mcpBody("0.5.1") });
    assert.equal(v[0].state, "CANNOT-VERIFY", v[0].detail);
    assert.equal(gate.exitCodeFor(v), 2);
  });

  test("gitHead names a commit this clone does not have → CANNOT-VERIFY, exit 2", async () => {
    const v = await verdictsFor("0.5.1", { status: 200, body: npmBody("0.5.1") }, { status: 200, body: mcpBody("0.5.1") },
      () => ({ kind: "unknown", why: "commit not in this clone" }));
    assert.equal(v[0].state, "CANNOT-VERIFY", v[0].detail);
    assert.equal(gate.exitCodeFor(v), 2);
  });

  test("no git history available at all → CANNOT-VERIFY, exit 2", async () => {
    const v = await verdictsFor("0.5.1", { status: 200, body: npmBody("0.5.1") }, { status: 200, body: mcpBody("0.5.1") }, null);
    assert.equal(v[0].state, "CANNOT-VERIFY", v[0].detail);
    assert.equal(gate.exitCodeFor(v), 2);
  });

  test("gitHead is not an ancestor of main (published from another branch) → LIVE-AHEAD, exit 1", async () => {
    const v = await verdictsFor("0.5.1", { status: 200, body: npmBody("0.5.1") }, { status: 200, body: mcpBody("0.5.1") },
      () => ({ kind: "not-ancestor" }));
    assert.equal(v[0].state, "LIVE-AHEAD", v[0].detail);
    assert.equal(gate.exitCodeFor(v), 1);
  });
});

// Review finding 2: a deleted or unmarked MCP record is not a served one.
describe("MCP registry record status (review finding 2)", () => {
  for (const [label, meta] of [
    ['status "deleted" with isLatest:true', { status: "deleted", isLatest: true }],
    ['status "deprecated"', { status: "deprecated", isLatest: true }],
    ["official metadata missing entirely", null],
    ["isLatest missing", { status: "active" }],
    ["status missing", { isLatest: true }],
    ["isLatest:false", { status: "active", isLatest: false }],
  ] as const) {
    test(`CANNOT-VERIFY: ${label} at main's version → exit 2 (never PUBLISHED-CURRENT)`, async () => {
      const v = await verdictsFor("0.5.1", { status: 200, body: npmBody("0.5.1") }, { status: 200, body: mcpBody("0.5.1", meta as any) });
      assert.equal(v[1].state, "CANNOT-VERIFY", v[1].detail);
      assert.equal(gate.exitCodeFor(v), 2);
    });
  }

  test("record's npm package pins an OLDER version than its server.version → BEHIND", async () => {
    const v = await verdictsFor("0.5.1", { status: 200, body: npmBody("0.5.1") }, { status: 200, body: mcpBody("0.5.1", activeLatest, "0.5.0") });
    assert.equal(v[1].state, "BEHIND", v[1].detail);
    assert.equal(gate.exitCodeFor(v), 1);
  });

  test("record carries no npm package → CANNOT-VERIFY (cannot tie it to a build)", async () => {
    const v = await verdictsFor("0.5.1", { status: 200, body: npmBody("0.5.1") }, { status: 200, body: mcpBody("0.5.1", activeLatest, null) });
    assert.equal(v[1].state, "CANNOT-VERIFY", v[1].detail);
  });
});

// The real git reader behind finding 1, against a throwaway repository.
describe("sourceGapFromGit against a real repository", () => {
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  const write = (root: string, rel: string, s: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), s); };

  test("counts only commits touching published paths; knows ancestor, non-ancestor and unknown", () => {
    assert.equal(typeof gate.sourceGapFromGit, "function", "sourceGapFromGit is not exported");
    const root = mkdtempSync(join(tmpdir(), "live-registry-git-"));
    try {
      git(root, "init", "-q", "-b", "main");
      git(root, "config", "user.email", "t@example.com"); git(root, "config", "user.name", "t");
      write(root, "package.json", '{"version":"0.5.1","files":["dist","src","README.md"]}');
      write(root, "src/a.ts", "1"); git(root, "add", "-A"); git(root, "commit", "-qm", "release");
      const published = git(root, "rev-parse", "HEAD");
      const paths = gate.publishedPaths({ files: ["dist", "src", "README.md"] });

      assert.deepEqual(gate.sourceGapFromGit(root, published, paths), { kind: "ancestor", commits: [] }, "positive control: nothing since");

      write(root, "test/x.test.ts", "t"); git(root, "add", "-A"); git(root, "commit", "-qm", "test only");
      assert.equal((gate.sourceGapFromGit(root, published, paths) as any).commits.length, 0, "a test-only commit ships nothing");

      write(root, "src/b.ts", "2"); git(root, "add", "-A"); git(root, "commit", "-qm", "unbumped code");
      const g = gate.sourceGapFromGit(root, published, paths) as any;
      assert.equal(g.kind, "ancestor");
      assert.equal(g.commits.length, 1);
      assert.equal(g.commits[0].subject, "unbumped code");

      git(root, "checkout", "-qb", "side", published);
      write(root, "src/c.ts", "3"); git(root, "add", "-A"); git(root, "commit", "-qm", "side");
      const side = git(root, "rev-parse", "HEAD");
      git(root, "checkout", "-q", "main");
      assert.equal(gate.sourceGapFromGit(root, side, paths).kind, "not-ancestor");

      assert.equal(gate.sourceGapFromGit(root, "0123456789abcdef0123456789abcdef01234567", paths).kind, "unknown");
      assert.equal(gate.sourceGapFromGit(root, "not a sha; rm -rf /", paths).kind, "unknown");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Review finding 4: the local manifest a publish would send, both version fields.
describe("local server.json vs package.json (review finding 4)", () => {
  test("reads top-level AND packages[npm].version and returns mismatches as data", () => {
    assert.equal(typeof gate.readLocalManifest, "function", "readLocalManifest is not exported");
    const root = mkdtempSync(join(tmpdir(), "live-registry-manifest-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: PKG, version: "0.5.1" }));
      writeFileSync(join(root, "server.json"), JSON.stringify({ version: "0.5.1", packages: [{ registryType: "npm", identifier: PKG, version: "0.5.0" }] }));
      const m = gate.readLocalManifest(root, "0.5.1", PKG);
      assert.equal(m.serverJsonVersion, "0.5.1");
      assert.equal(m.serverJsonPackageVersion, "0.5.0");
      assert.equal(m.mismatches.length, 1);
      assert.match(m.mismatches[0], /packages.*0\.5\.0/);

      writeFileSync(join(root, "server.json"), JSON.stringify({ version: "0.5.1", packages: [{ registryType: "npm", identifier: PKG, version: "0.5.1" }] }));
      assert.deepEqual(gate.readLocalManifest(root, "0.5.1", PKG).mismatches, [], "positive control: agreeing manifest has no mismatches");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("semver", () => {
  test("numeric, not lexical: 0.10.0 > 0.9.0", () => assert.ok(gate.compareSemver("0.10.0", "0.9.0") > 0));
  test("release > its prerelease", () => assert.ok(gate.compareSemver("0.5.1", "0.5.1-rc.1") > 0));
  test("unparseable throws rather than guessing", () => assert.throws(() => gate.compareSemver("latest", "0.5.0")));
});

describe("the CLI", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  test("a 1ms timeout against the real URLs → exit 2 and the words CANNOT-VERIFY, never exit 0", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/check-live-registry.ts", "--timeout-ms", "1"], {
      cwd: ROOT, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(r.status, 2, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /CANNOT-VERIFY/);
    assert.doesNotMatch(r.stdout, /PUBLISHED-CURRENT on every channel/);
  });

  test("--json carries the local manifest mismatch as a field", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/check-live-registry.ts", "--json", "--timeout-ms", "1"], {
      cwd: ROOT, encoding: "utf8", timeout: 30_000,
    });
    const out = JSON.parse(r.stdout);
    assert.ok(out.localManifest && Array.isArray(out.localManifest.mismatches), `no localManifest.mismatches in: ${r.stdout.slice(0, 400)}`);
    assert.equal(r.status, 2);
  });

  test("an unknown flag is usage (64), not a silent pass", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/check-live-registry.ts", "--nope"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 64);
  });
});
