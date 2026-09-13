// THE RELEASE GATE MUST READ THE LIVE REGISTRIES — AND MUST NOT CALL AN
// UNREACHABLE ONE "IN SYNC".
//
// Hermetic: every registry response here is mocked. The real-network run lives in
// the `live-registry` workflow, not in `npm test` (a registry blip must not turn
// an unrelated PR red — see ci.yml).
//
// 🎯 The POSITIVE control (live == main → exit 0) is load-bearing: a gate that
// always says BEHIND, or always refuses, passes every other test in this file.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readNpm, readMcpRegistry, classify, exitCodeFor, compareSemver, NPM_URL, MCP_URL,
  type ChannelVerdict,
} from "../scripts/check-live-registry.js";

const PKG = "radmail-mcp";
const MCP = "ai.radmail/radmail-mcp";
const NOW = new Date("2026-09-13T12:00:00Z");

type Route = { status: number; body: string } | Error;
function mockFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    const r = routes[url];
    if (!r) throw new Error(`unmocked url ${url}`);
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => r.body };
  };
  return { f, calls };
}
const npmBody = (latest: string) =>
  JSON.stringify({ name: PKG, "dist-tags": { latest }, time: { [latest]: "2026-08-11T03:57:30.892Z" } });
const mcpBody = (version: string, isLatest = true) =>
  JSON.stringify({
    server: { name: MCP, version },
    _meta: { "io.modelcontextprotocol.registry/official": { isLatest, publishedAt: "2026-08-17T03:35:34.685Z" } },
  });

async function verdictsFor(main: string, npm: Route, mcp: Route): Promise<ChannelVerdict[]> {
  const { f } = mockFetch({ [NPM_URL(PKG)]: npm, [MCP_URL(MCP)]: mcp });
  const reads = await Promise.all([readNpm(f, PKG), readMcpRegistry(f, MCP)]);
  return reads.map((r) => classify(main, r, { sha: "6dee50306b45", date: "2026-08-29T15:00:29-07:00", commits: 7 }, NOW));
}

describe("the three states, never collapsed", () => {
  test("POSITIVE CONTROL: live == main on both channels → PUBLISHED-CURRENT, exit 0", async () => {
    const v = await verdictsFor("0.5.1", { status: 200, body: npmBody("0.5.1") }, { status: 200, body: mcpBody("0.5.1") });
    assert.deepEqual(v.map((x) => x.state), ["PUBLISHED-CURRENT", "PUBLISHED-CURRENT"]);
    assert.equal(exitCodeFor(v), 0);
  });

  test("TODAY'S REAL SHAPE: main 0.5.1, both channels 0.5.0 → BEHIND with distance and dates, exit 1", async () => {
    const v = await verdictsFor("0.5.1", { status: 200, body: npmBody("0.5.0") }, { status: 200, body: mcpBody("0.5.0") });
    assert.deepEqual(v.map((x) => x.state), ["BEHIND", "BEHIND"]);
    assert.match(v[0].detail, /main 0\.5\.1 is 1 patch ahead of live 0\.5\.0/);
    assert.match(v[0].detail, /live published 2026-08-11 \(33d ago\)/);
    assert.match(v[1].detail, /live published 2026-08-17 \(27d ago\)/);
    assert.match(v[0].detail, /main moved past it at 6dee503 on 2026-08-29, 7 commit/);
    assert.equal(exitCodeFor(v), 1);
  });

  test("one channel current, the other behind → BEHIND is not hidden by the current one", async () => {
    const v = await verdictsFor("0.5.1", { status: 200, body: npmBody("0.5.1") }, { status: 200, body: mcpBody("0.5.0") });
    assert.deepEqual(v.map((x) => x.state), ["PUBLISHED-CURRENT", "BEHIND"]);
    assert.equal(exitCodeFor(v), 1);
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
      assert.equal(exitCodeFor(v), 2);
    });
  }

  test("CANNOT-VERIFY: MCP registry unreachable → exit 2", async () => {
    const v = await verdictsFor("0.5.1", { status: 200, body: npmBody("0.5.1") }, new Error("The operation was aborted due to timeout"));
    assert.equal(v[1].state, "CANNOT-VERIFY");
    assert.equal(exitCodeFor(v), 2);
  });

  test("CANNOT-VERIFY: a 'latest' record marked isLatest:false is not trusted", async () => {
    const v = await verdictsFor("0.5.1", { status: 200, body: npmBody("0.5.1") }, { status: 200, body: mcpBody("0.5.1", false) });
    assert.equal(v[1].state, "CANNOT-VERIFY");
    assert.equal(exitCodeFor(v), 2);
  });

  test("both unreachable → exit 2 (the all-unknown case must not read as clean)", async () => {
    const v = await verdictsFor("0.5.1", new Error("offline"), new Error("offline"));
    assert.deepEqual(v.map((x) => x.state), ["CANNOT-VERIFY", "CANNOT-VERIFY"]);
    assert.equal(exitCodeFor(v), 2);
  });

  test("a proven BEHIND outranks an unknown: npm behind + MCP unreachable → exit 1, both states still reported", async () => {
    const v = await verdictsFor("0.5.1", { status: 200, body: npmBody("0.5.0") }, { status: 429, body: "" });
    assert.deepEqual(v.map((x) => x.state), ["BEHIND", "CANNOT-VERIFY"]);
    assert.equal(exitCodeFor(v), 1);
  });

  test("LIVE-AHEAD (live newer than main) is named, not folded into current", async () => {
    const v = await verdictsFor("0.5.1", { status: 200, body: npmBody("0.6.0") }, { status: 200, body: mcpBody("0.5.1") });
    assert.equal(v[0].state, "LIVE-AHEAD");
    assert.equal(exitCodeFor(v), 1);
  });

  test("an empty verdict list is not a pass", () => {
    assert.equal(exitCodeFor([]), 2);
  });
});

describe("semver", () => {
  test("numeric, not lexical: 0.10.0 > 0.9.0", () => assert.ok(compareSemver("0.10.0", "0.9.0") > 0));
  test("release > its prerelease", () => assert.ok(compareSemver("0.5.1", "0.5.1-rc.1") > 0));
  test("unparseable throws rather than guessing", () => assert.throws(() => compareSemver("latest", "0.5.0")));
});

describe("the CLI exits 2 when it cannot reach anything", () => {
  test("a 1ms timeout against the real URLs → exit 2 and the words CANNOT-VERIFY, never exit 0", () => {
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/check-live-registry.ts", "--timeout-ms", "1"], {
      cwd: ROOT, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(r.status, 2, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /CANNOT-VERIFY/);
    assert.doesNotMatch(r.stdout, /PUBLISHED-CURRENT on every channel/);
  });

  test("an unknown flag is usage (64), not a silent pass", () => {
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/check-live-registry.ts", "--nope"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 64);
  });
});
