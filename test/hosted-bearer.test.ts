// HOSTED ENDPOINT, PER-REQUEST CONNECTED MODE (api/mcp.ts, preview in 0.6.0).
//
// Proves, against a FAKE RadMail API (no network, no real key):
//   (a) a request with `Authorization: Bearer tmk_…` gets connected READ tools
//       that use THAT key — and the key never appears in the response, in any
//       console line, or on stdout/stderr;
//   (b) a request without a bearer is sandbox-only, EVEN WHEN RADMAIL_API_KEY is
//       set on the deployment (no process-wide key) — with the positive control
//       that a local createServer() does use that env key;
//   (c) concurrent requests with different bearers never see each other's key;
//   (d) a bearer shaped like a RadMail key but malformed is refused (401), never
//       silently served the demo inbox; a non-RadMail bearer stays sandbox;
//   (e) the hosted surface stays non-destructive: no send, no inbox-action tool,
//       whatever the environment says; get_attachment refuses there;
//   (f) health advertises the preview honestly.

import { test, beforeEach, afterEach, describe } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { POST, GET, resolveBearer } from "../api/mcp.js";
import { __setFetchForTests, DEFAULT_API_URL } from "../src/lib/connected.js";
import { __setActionsFetchForTests } from "../src/lib/inbox-actions.js";
import { __setSendFetchForTests } from "../src/lib/send.js";
import { createServer } from "../src/server.js";
import { setSendSurfaceActive, setTriageSurfaceActive } from "../src/lib/taint.js";

const KEY_A = "tmk_test_1111111111111111111111111111111111111111";
const KEY_B = "tmk_live_2222222222222222222222222222222222222222";
const ENV_KEY = "tmk_live_3333333333333333333333333333333333333333";
const EMAIL_ID = "3f1c2b9a-6d1e-4c3b-9a2f-0e8d7c6b5a41";

const READ_TOOLS = ["search", "read_email", "read_thread", "list_emails", "list_right_now", "list_commitments", "list_prepared_drafts", "list_watched_threads"];
const WRITE_TOOLS = ["send_email", "archive_email", "snooze_email", "mark_read", "label_email", "act_on_emails"];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let rpcId = 0;
function rpc(method: string, params: unknown, headers: Record<string, string> = {}): Request {
  rpcId += 1;
  return new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": `10.0.0.${rpcId % 250}`, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
  });
}
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

async function call(name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await POST(rpc("tools/call", { name, arguments: args }, headers));
  const text = await res.text();
  const parsed = JSON.parse(text);
  const inner = parsed.result?.structuredContent ?? (parsed.result?.content?.[0]?.text ? JSON.parse(parsed.result.content[0].text) : null);
  return { status: res.status, text, result: inner as Record<string, any> | null };
}

// Every fetch the read client makes, with the key it carried.
const fetched: Array<{ url: string; auth: string | null }> = [];
let writeAttempts = 0;

// Capture everything printed while a request runs (passed through, never swallowed).
const printed: string[] = [];
const originals = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info,
  out: process.stdout.write.bind(process.stdout),
  err: process.stderr.write.bind(process.stderr),
};

const ENV = ["RADMAIL_API_KEY", "RADMAIL_API_URL", "RADMAIL_SEND_TOOL", "RADMAIL_SEND_API_KEY", "RADMAIL_TRIAGE_TOOLS", "RADMAIL_TRIAGE_API_KEY", "RADMAIL_ATTACHMENT_DIR"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  fetched.length = 0;
  printed.length = 0;
  writeAttempts = 0;
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  __setFetchForTests(async (url, init) => {
    const auth = new Headers(init.headers).get("authorization");
    fetched.push({ url: String(url), auth });
    // A 401 for any key the fake does not know — so an error path is exercised too.
    if (auth !== `Bearer ${KEY_A}` && auth !== `Bearer ${KEY_B}` && auth !== `Bearer ${ENV_KEY}`) {
      return json({ ok: false, error: "invalid_api_key" }, 401);
    }
    const tag = auth === `Bearer ${KEY_A}` ? "A" : auth === `Bearer ${KEY_B}` ? "B" : "ENV";
    return json({
      ok: true,
      data: [{ id: EMAIL_ID, from: "pat@vendor.example.com", subject: `inbox ${tag}`, snippet: "…", matchedIn: ["subject"], messageId: "<x@mail.example.com>" }],
      pagination: { limit: 10, offset: 0, total: 1, hasMore: false, nextCursor: null },
    });
  });
  __setActionsFetchForTests(async () => {
    writeAttempts += 1;
    return json({ ok: true });
  });
  __setSendFetchForTests(async () => {
    writeAttempts += 1;
    return json({ ok: true, status: "sent" }, 201);
  });
  const grab =
    (orig: (...a: any[]) => any) =>
    (...a: any[]) => {
      printed.push(a.map(String).join(" "));
      return orig(...a);
    };
  console.log = grab(originals.log);
  console.error = grab(originals.error);
  console.warn = grab(originals.warn);
  console.info = grab(originals.info);
  process.stdout.write = grab(originals.out) as typeof process.stdout.write;
  process.stderr.write = grab(originals.err) as typeof process.stderr.write;
});

afterEach(() => {
  console.log = originals.log;
  console.error = originals.error;
  console.warn = originals.warn;
  console.info = originals.info;
  process.stdout.write = originals.out as typeof process.stdout.write;
  process.stderr.write = originals.err as typeof process.stderr.write;
  __setFetchForTests(null);
  __setActionsFetchForTests(null);
  __setSendFetchForTests(null);
  setSendSurfaceActive(false);
  setTriageSurfaceActive(false);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function assertKeyNowhere(key: string, ...texts: string[]) {
  for (const t of texts) assert.equal(t.includes(key), false, "the key appeared in a response");
  assert.equal(printed.some((p) => p.includes(key)), false, "the key appeared in printed output");
}

// ─── (d) resolving the header ────────────────────────────────────────────────

describe("resolveBearer", () => {
  const req = (h?: string) => new Request("http://localhost/api/mcp", { method: "POST", headers: h ? { authorization: h } : {} });
  test("no header → sandbox; a non-RadMail bearer → sandbox (as before)", () => {
    assert.deepEqual(resolveBearer(req()), { kind: "none" });
    assert.deepEqual(resolveBearer(req("Bearer rmt_sandbox_tenant_token")), { kind: "none" });
    assert.deepEqual(resolveBearer(req("Basic abc")), { kind: "none" });
  });
  test("a well-formed RadMail key → connected, default host; RADMAIL_API_URL overrides the HOST only", () => {
    assert.deepEqual(resolveBearer(req(`Bearer ${KEY_A}`), {}), { kind: "connected", cfg: { apiKey: KEY_A, apiUrl: DEFAULT_API_URL } });
    assert.deepEqual(resolveBearer(req(`bearer ${KEY_B}`), { RADMAIL_API_URL: "https://staging.radmail.ai/" }), {
      kind: "connected",
      cfg: { apiKey: KEY_B, apiUrl: "https://staging.radmail.ai" },
    });
  });
  test("starts like a RadMail key but is not one → malformed", () => {
    for (const bad of ["tmk_live_short", `tmk_prod_${"a".repeat(40)}`, `${KEY_A}x`, `tmk_live_${"G".repeat(40)}`]) {
      assert.equal(resolveBearer(req(`Bearer ${bad}`)).kind, "malformed", bad);
    }
  });
});

// ─── (a) a bearer reaches the real (fake) inbox ──────────────────────────────

describe("with a bearer", () => {
  test("connected search uses THAT key, and the key appears nowhere", async () => {
    const { status, text, result } = await call("search", { query: "delivery" }, bearer(KEY_A));
    assert.equal(status, 200);
    assert.equal(result!.engineMode, "connected");
    assert.equal(result!.results[0].subject.value, "inbox A");
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0].auth, `Bearer ${KEY_A}`);
    assert.equal(new URL(fetched[0].url).origin, DEFAULT_API_URL);
    assertKeyNowhere(KEY_A, text);
  });

  test("the new read tools work over the bearer too (list_emails)", async () => {
    const { text, result } = await call("list_emails", { limit: 10 }, bearer(KEY_B));
    assert.equal(result!.emails[0].subject.value, "inbox B");
    assert.equal(fetched[0].auth, `Bearer ${KEY_B}`);
    assert.equal(new URL(fetched[0].url).pathname, "/api/v1/emails");
    assertKeyNowhere(KEY_B, text);
  });

  test("a key RadMail rejects fails closed with a key-free message", async () => {
    const unknown = "tmk_test_9999999999999999999999999999999999999999";
    const { text, result } = await call("search", { query: "x" }, bearer(unknown));
    assert.equal(result!.ok, false);
    assert.equal(result!.error.kind, "auth");
    assertKeyNowhere(unknown, text);
  });

  test("(c) concurrent requests with different keys never see each other's", async () => {
    const [a, b, none] = await Promise.all([
      call("search", { query: "x" }, bearer(KEY_A)),
      call("search", { query: "x" }, bearer(KEY_B)),
      call("search", { query: "x" }),
    ]);
    assert.equal(a.result!.results[0].subject.value, "inbox A");
    assert.equal(b.result!.results[0].subject.value, "inbox B");
    assert.equal(none.result!.connected, false, "the request with no bearer stayed sandbox");
    assert.equal(fetched.length, 2);
    assert.deepEqual(fetched.map((f) => f.auth).sort(), [`Bearer ${KEY_A}`, `Bearer ${KEY_B}`].sort());
    assert.equal(a.text.includes(KEY_B) || b.text.includes(KEY_A), false);
  });
});

// ─── (b) no bearer → sandbox, whatever the environment holds ─────────────────

describe("without a bearer", () => {
  test("🛑 sandbox only even with RADMAIL_API_KEY set on the deployment — no process-wide key", async () => {
    process.env.RADMAIL_API_KEY = ENV_KEY;
    const { text, result } = await call("search", { query: "x" });
    assert.equal(result!.connected, false, "the setup pointer, not a connected result");
    assert.equal(fetched.length, 0, "no request to RadMail at all");
    assertKeyNowhere(ENV_KEY, text);
  });

  test("🎯 CONTROL: a LOCAL createServer() with the same env key IS connected", async () => {
    process.env.RADMAIL_API_KEY = ENV_KEY;
    const server = createServer();
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(x), client.connect(y)]);
    const r = (await client.callTool({ name: "search", arguments: { query: "x" } })) as { structuredContent: Record<string, any> };
    await client.close();
    await server.close();
    assert.equal(r.structuredContent.engineMode, "connected");
    assert.equal(fetched[0].auth, `Bearer ${ENV_KEY}`);
  });

  test("the sandbox path still works exactly as before (messages passed)", async () => {
    const { result } = await call("triage", { from: "a@b.example", body: "Can you confirm Thursday?", knownSender: true });
    assert.equal(result!.engineMode, "sandbox");
    assert.equal(fetched.length, 0);
  });
});

// ─── (d) malformed → 401 ─────────────────────────────────────────────────────

test("a malformed RadMail-shaped bearer is refused (401) and never echoed; no request is made", async () => {
  const bad = "tmk_live_thisisnotarealkey";
  const res = await POST(rpc("tools/call", { name: "search", arguments: { query: "x" } }, bearer(bad)));
  const text = await res.text();
  assert.equal(res.status, 401);
  assert.match(text, /tmk_live_ or tmk_test_ followed by 40 hex/);
  assert.equal(fetched.length, 0);
  assertKeyNowhere(bad, text);
});

// ─── (e) non-destructive hosted surface ──────────────────────────────────────

describe("the hosted surface stays non-destructive", () => {
  test("with a bearer AND every opt-in variable set, tools/list has the read tools and no write tool", async () => {
    Object.assign(process.env, {
      RADMAIL_SEND_TOOL: "1",
      RADMAIL_SEND_API_KEY: ENV_KEY,
      RADMAIL_TRIAGE_TOOLS: "1",
      RADMAIL_TRIAGE_API_KEY: ENV_KEY,
    });
    const res = await POST(rpc("tools/list", {}, bearer(KEY_A)));
    const body = JSON.parse(await res.text());
    const tools = body.result.tools as Array<{ name: string; annotations?: Record<string, boolean> }>;
    const names = tools.map((t) => t.name);
    for (const n of READ_TOOLS) {
      assert.ok(names.includes(n), `${n} missing`);
      assert.equal(tools.find((t) => t.name === n)!.annotations?.readOnlyHint, true, `${n} read-only`);
    }
    for (const n of WRITE_TOOLS) assert.equal(names.includes(n), false, `${n} must never be on the hosted endpoint`);
  });

  test("calling an action tool by name on the hosted endpoint does nothing", async () => {
    process.env.RADMAIL_TRIAGE_TOOLS = "1";
    process.env.RADMAIL_TRIAGE_API_KEY = ENV_KEY;
    const res = await POST(rpc("tools/call", { name: "archive_email", arguments: { id: EMAIL_ID } }, bearer(KEY_A)));
    const text = await res.text();
    assert.match(text, /not found|unknown tool|-32602|isError/i);
    assert.equal(writeAttempts, 0);
  });

  test("get_attachment refuses on the hosted endpoint, even with a bearer and a folder configured", async () => {
    process.env.RADMAIL_ATTACHMENT_DIR = "/nonexistent-hosted-dir";
    const { result } = await call("get_attachment", { id: EMAIL_ID, index: 0 }, bearer(KEY_A));
    assert.equal(result!.error.kind, "not_on_hosted");
    assert.equal(fetched.length, 0);
  });
});

// ─── (f) health ──────────────────────────────────────────────────────────────

test("health advertises the bearer preview and its limits", async () => {
  const res = await GET();
  const body = (await res.json()) as Record<string, any>;
  assert.equal(body.toolManifest, "verified");
  assert.equal(body.connectedPreview.status, "preview");
  assert.match(body.connectedPreview.how, /Authorization: Bearer/);
  assert.match(body.connectedPreview.never, /no send and no inbox-action tool/);
});
