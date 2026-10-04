// send_email — the opt-in tool that hands mail to RadMail's outbound gate.
//
// Proves: (a) each outcome — sent / held / refused — maps from what the API
// actually returns; (b) a hold carries an app link and NEVER a credential, even
// if the server sent one; (c) no key → a clear refusal, and no request is made;
// (d) NOTHING in the tool can reach a release endpoint — by reading the code
// AND by recording every URL it fetches across every outcome; (e) the tool is
// absent from the default and hosted surfaces and present only when asked for.

import { test, beforeEach, afterEach, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sendEmailTool, SEND_TOOL_DEF, TOOL_DEFS } from "../src/tools.js";
import {
  __setSendFetchForTests,
  mapSendResponse,
  reviewUrlFor,
  SEND_PATH,
  sendToolRequested,
} from "../src/lib/send.js";
import { SAFETY_BLOCK, SAFETY_BLOCK_SEND_ENABLED, setSendSurfaceActive } from "../src/lib/taint.js";
import { createServer } from "../src/server.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "tmk_send_secret_456";
const API = "https://app.radmail.ai";
const REQ = "0b4f8a8e-6d2c-4f3a-9c1e-2a7d5b9e1f00";

const ARGS = {
  from: "doug@seattlecannabis.co",
  to: ["kat@seattlecannabis.co"],
  subject: "Thursday delivery",
  markdown: "Hi Kat — Thursday works. Thanks!",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const calls: Array<{ url: string; method: string; auth: string | null; body: string }> = [];
function serve(res: () => Response) {
  __setSendFetchForTests(async (url, init) => {
    const h = new Headers(init.headers);
    calls.push({ url, method: String(init.method), auth: h.get("authorization"), body: String(init.body ?? "") });
    return res();
  });
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  calls.length = 0;
  for (const k of ["RADMAIL_SEND_API_KEY", "RADMAIL_API_KEY", "RADMAIL_API_URL", "RADMAIL_SEND_TOOL"]) saved[k] = process.env[k];
  process.env.RADMAIL_SEND_API_KEY = KEY;
  delete process.env.RADMAIL_API_URL;
  delete process.env.RADMAIL_API_KEY;
});
afterEach(() => {
  __setSendFetchForTests(null);
  setSendSurfaceActive(false);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("outcomes", () => {
  test("sent: a 201 from the gate", async () => {
    serve(() => json({ ok: true, status: "sent", requestId: REQ, sendId: "s_1" }, 201));
    const r = (await sendEmailTool(ARGS)) as Record<string, unknown>;
    assert.equal(r.outcome, "sent");
    assert.equal(r.requestId, REQ);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${API}${SEND_PATH}`);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].auth, `Bearer ${KEY}`, "uses the SEND key");
    assert.deepEqual(JSON.parse(calls[0].body).to, ARGS.to);
    assert.ok(r.safety, "every response carries a safety block");
  });

  test("held: a 202 becomes an app link, and nothing that could release it", async () => {
    serve(() =>
      json(
        {
          ok: true,
          status: "held",
          requestId: REQ,
          tier: "normal",
          holdReasons: ["not_on_no_tap_list: new@stranger.com"],
          reviewPath: `/sends/${REQ}`,
          expiresAt: "2026-10-04T00:00:00.000Z",
          // A credential the server must never send — and if it ever did, it
          // must not reach the agent.
          confirmToken: "ctk_SHOULD_NEVER_SURFACE",
          renderedHtml: "<p>…</p>",
        },
        202,
      ),
    );
    const r = (await sendEmailTool(ARGS)) as Record<string, unknown>;
    assert.equal(r.outcome, "held");
    assert.equal(r.reviewUrl, `${API}/sends/${REQ}`);
    assert.deepEqual(r.holdReasons, ["not_on_no_tap_list: new@stranger.com"]);
    const wire = JSON.stringify(r);
    assert.doesNotMatch(wire, /ctk_|confirmToken|token/i, "a hold must carry no credential");
    assert.match(String(r.note), /no tool can release it/);
  });

  test("held: a reviewPath that is not a /sends link is replaced, never followed", () => {
    assert.equal(reviewUrlFor(API, `/api/v1/send/${REQ}/confirm`), `${API}/sends`);
    assert.equal(reviewUrlFor(API, "https://evil.example/sends/x"), `${API}/sends`);
    assert.equal(reviewUrlFor(API, `/sends/${REQ}`), `${API}/sends/${REQ}`);
  });

  test("refused: an API refusal is reported, with the server's reason", async () => {
    serve(() => json({ ok: false, error: "recipient_suppressed", detail: "x@y.com is on the suppression list." }, 409));
    const r = (await sendEmailTool(ARGS)) as Record<string, unknown>;
    assert.equal(r.outcome, "refused");
    assert.equal(r.error, "recipient_suppressed");
    assert.equal(r.httpStatus, 409);
  });

  test("refused: sending switched off on the server reads as that, not as a broken path", () => {
    const r = mapSendResponse(404, { ok: false, error: "send_api_disabled" }, API) as Record<string, unknown>;
    assert.equal(r.outcome, "refused");
    assert.match(String(r.detail), /switched off/);
  });

  test("refused: a key without the send scope says so", () => {
    const r = mapSendResponse(403, { ok: false, error: "missing_scope:send" }, API) as Record<string, unknown>;
    assert.match(String(r.detail), /send` scope/);
  });

  test("duplicate of a sent request → sent (never re-sent); of a held one → held", () => {
    const s = mapSendResponse(200, { ok: true, status: "duplicate", requestId: REQ, priorStatus: "sent", sendId: "s_1" }, API);
    assert.equal(s.outcome, "sent");
    const h = mapSendResponse(200, { ok: true, status: "duplicate", requestId: REQ, priorStatus: "held" }, API);
    assert.equal(h.outcome, "held");
    assert.equal((h as { reviewUrl: string }).reviewUrl, `${API}/sends/${REQ}`);
  });

  test("a timeout is 'outcome unknown', and the client does not retry", async () => {
    __setSendFetchForTests(async (url, init) => {
      calls.push({ url, method: String(init.method), auth: null, body: "" });
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    });
    const r = (await sendEmailTool(ARGS)) as Record<string, unknown>;
    assert.equal(r.outcome, "refused");
    assert.equal(r.error, "outcome_unknown_timeout");
    assert.equal(calls.length, 1, "a send is never retried automatically");
  });

  test("no send key configured → refused with a clear message, and no request is made", async () => {
    delete process.env.RADMAIL_SEND_API_KEY;
    process.env.RADMAIL_API_KEY = "tmk_read_only_key"; // the READ key must not be used to send
    serve(() => json({}, 201));
    const r = (await sendEmailTool(ARGS)) as Record<string, unknown>;
    assert.equal(r.outcome, "refused");
    assert.equal(r.error, "no_send_key_configured");
    assert.match(String(r.detail), /RADMAIL_SEND_API_KEY/);
    assert.equal(calls.length, 0);
  });

  test("the key never appears in any outcome", async () => {
    for (const [status, body] of [
      [201, { status: "sent" }],
      [202, { status: "held", reviewPath: `/sends/${REQ}` }],
      [401, { error: "invalid_api_key" }],
      [500, { error: "send_request_failed" }],
    ] as const) {
      serve(() => json(body, status));
      const r = await sendEmailTool(ARGS);
      assert.doesNotMatch(JSON.stringify(r), new RegExp(KEY));
    }
  });
});

describe("🛑 nothing in the tool can release a held send", () => {
  test("every URL the tool fetches, across every outcome, is the send path — never /confirm", async () => {
    const responses: Array<[number, unknown]> = [
      [201, { status: "sent", requestId: REQ }],
      [202, { status: "held", requestId: REQ, reviewPath: `/sends/${REQ}` }],
      [200, { status: "duplicate", requestId: REQ, priorStatus: "held" }],
      [403, { error: "human_release_required" }],
      [422, { error: "from_mailbox_not_connected" }],
    ];
    for (const [status, body] of responses) {
      serve(() => json(body, status));
      await sendEmailTool(ARGS);
    }
    assert.equal(calls.length, responses.length);
    for (const c of calls) {
      assert.equal(c.url, `${API}${SEND_PATH}`);
      assert.equal(c.method, "POST");
      assert.doesNotMatch(c.url, /confirm/i);
    }
  });

  test("the code of the client and the tool never names a confirm/release route", () => {
    // Comments may explain the absence; CODE may not contain it. Line comments
    // are dropped before the search.
    const code = (f: string) =>
      readFileSync(join(ROOT, f), "utf8")
        .split("\n")
        .filter((l) => !/^\s*\/\//.test(l))
        .join("\n");
    const client = code("src/lib/send.ts");
    const tools = code("src/tools.ts");
    const sendSection = tools.slice(tools.indexOf("export async function sendEmailTool"));
    for (const [name, src] of [
      ["src/lib/send.ts", client],
      ["send_email in src/tools.ts", sendSection],
    ] as const) {
      assert.doesNotMatch(src, /\/confirm\b/i, `${name} names a confirm path`);
      assert.doesNotMatch(src, /\brelease\w*\(/i, `${name} calls something that releases`);
    }
    assert.equal(SEND_PATH, "/api/v1/send");
    // 🎯 CONTROL: the search can see a confirm path when one is present.
    assert.match(`${SEND_PATH}/x/confirm`, /\/confirm\b/i);
  });

  test("the input schema has no field that could name a request to act on", () => {
    const fields = Object.keys(SEND_TOOL_DEF.inputSchema).sort();
    assert.deepEqual(fields, ["agentId", "bcc", "cc", "from", "idempotencyKey", "inReplyTo", "markdown", "subject", "to"]);
    // No requestId, no token, nothing that points at an existing send.
    for (const f of fields) assert.doesNotMatch(f, /request|token|confirm|release/i);
  });
});

describe("where the tool exists", () => {
  test("it is NOT in the default published surface", () => {
    assert.equal(TOOL_DEFS.some((d) => d.name === "send_email"), false);
  });

  test("only RADMAIL_SEND_TOOL=1 asks for it", () => {
    assert.equal(sendToolRequested({}), false);
    assert.equal(sendToolRequested({ RADMAIL_SEND_TOOL: "true" }), false);
    assert.equal(sendToolRequested({ RADMAIL_SEND_TOOL: "1" }), true);
  });

  test("the hosted HTTP entries never ask for it, whatever the environment", () => {
    for (const f of ["api/mcp.ts", "src/http.ts"]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      assert.match(src, /createServer\(\)/, `${f} should call createServer() with no options`);
      assert.doesNotMatch(src, /enableSend|sendToolRequested/, `${f} must not be able to turn on send`);
    }
  });

  test("createServer() with no options leaves the default safety block in force", () => {
    createServer();
    serve(() => json({ status: "sent" }, 201));
    // Any tool response — use the send tool's refusal path as a probe.
    delete process.env.RADMAIL_SEND_API_KEY;
    return sendEmailTool(ARGS).then((r) => {
      assert.deepEqual((r as { safety: unknown }).safety, SAFETY_BLOCK);
    });
  });

  test("createServer({ enableSend: true }) passes its frozen manifest and tells the truth in the safety block", async () => {
    assert.doesNotThrow(() => createServer({ enableSend: true }));
    delete process.env.RADMAIL_SEND_API_KEY;
    const r = (await sendEmailTool(ARGS)) as { safety: Record<string, unknown> };
    assert.deepEqual(r.safety, SAFETY_BLOCK_SEND_ENABLED);
    assert.equal("neverAutoSends" in r.safety, false, "a send-enabled server must not claim it never sends");
  });
});
