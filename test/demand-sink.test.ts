// Demand-sink emitter tests (v0.3.1) — the durable mirror of the in-memory
// learning store. Proves the telemetry contract:
//   (a) each in-memory record fires exactly the documented POST shape;
//   (b) failures are swallowed silently (telemetry never breaks a tool call);
//   (c) RADMAIL_TELEMETRY=off disables it entirely;
//   (d) the API key NEVER goes on the wire — only the tmk_live_ + 4 prefix;
//   (e) RADMAIL_DEMAND_SINK_URL overrides the target.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  emitDemandEvent,
  telemetryEnabled,
  safeKeyPrefix,
  __setDemandFetchForTests,
  DEFAULT_SINK_URL,
} from "../src/lib/demand-sink.js";
import { recordCall, recordNeed, recordCapability, _resetLearning } from "../src/lib/learning.js";

interface Captured {
  url: string;
  init: RequestInit;
}

let captured: Captured[] = [];

function mockFetch(status = 202): void {
  __setDemandFetchForTests(async (url, init) => {
    captured.push({ url, init });
    return new Response(JSON.stringify({ ok: status === 202 }), { status });
  });
}

/** The emitter is fire-and-forget; let its detached promise settle. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

const LIVE_KEY = "tmk_live_3f9a" + "b".repeat(36);

beforeEach(() => {
  captured = [];
  _resetLearning();
  delete process.env.RADMAIL_TELEMETRY;
  delete process.env.RADMAIL_DEMAND_SINK_URL;
  delete process.env.RADMAIL_API_KEY;
  mockFetch();
});

afterEach(() => {
  __setDemandFetchForTests(null);
  delete process.env.RADMAIL_TELEMETRY;
  delete process.env.RADMAIL_DEMAND_SINK_URL;
  delete process.env.RADMAIL_API_KEY;
});

test("emitDemandEvent posts the documented shape to the default sink", async () => {
  emitDemandEvent({ event: "call", tool: "triage_inbox", agentId: "agent-1" });
  await settle();
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, DEFAULT_SINK_URL);
  assert.equal(captured[0].init.method, "POST");
  const body = JSON.parse(String(captured[0].init.body));
  assert.deepEqual(body, {
    source: "sandbox-package",
    event: "call",
    tool: "triage_inbox",
    agent_id: "agent-1",
  });
});

test("in-memory records mirror to the sink: call / need / capability", async () => {
  recordCall("a1", "search");
  recordNeed("a1", "wish: calendar view");
  recordCapability("a1", "snooze_email");
  await settle();
  const events = captured.map((c) => JSON.parse(String(c.init.body)));
  // recordNeed/recordCapability also count a tool call (mirrors the in-memory
  // structure exactly): call(search), call(report_need)+need,
  // call(request_capability)+capability.
  assert.deepEqual(
    events.map((e) => e.event),
    ["call", "call", "need", "call", "capability"],
  );
  const need = events.find((e) => e.event === "need");
  assert.equal(need.note, "wish: calendar view");
  const cap = events.find((e) => e.event === "capability");
  assert.equal(cap.note, "snooze_email");
  for (const e of events) assert.equal(e.source, "sandbox-package");
});

test("fetch failure is swallowed silently — caller never throws", async () => {
  __setDemandFetchForTests(async () => {
    throw new Error("network down");
  });
  assert.doesNotThrow(() => emitDemandEvent({ event: "call", tool: "search" }));
  assert.doesNotThrow(() => recordCall("a1", "search"));
  await settle();
});

test("sync-throwing fetch is swallowed too", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __setDemandFetchForTests((() => {
    throw new Error("sync boom");
  }) as any);
  assert.doesNotThrow(() => emitDemandEvent({ event: "call", tool: "search" }));
  await settle();
});

test("RADMAIL_TELEMETRY=off disables the emitter entirely", async () => {
  process.env.RADMAIL_TELEMETRY = "off";
  assert.equal(telemetryEnabled(), false);
  emitDemandEvent({ event: "call", tool: "search" });
  recordNeed("a1", "should not be sent");
  await settle();
  assert.equal(captured.length, 0);
});

test("connected mode: source=package and ONLY the safe key prefix on the wire", async () => {
  process.env.RADMAIL_API_KEY = LIVE_KEY;
  emitDemandEvent({ event: "call", tool: "search", agentId: "a1" });
  await settle();
  assert.equal(captured.length, 1);
  const { init } = captured[0];
  const body = JSON.parse(String(init.body));
  assert.equal(body.source, "package");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer tmk_live_3f9a");
  // The full key appears NOWHERE in the outgoing request.
  const wire = JSON.stringify({ url: captured[0].url, init });
  assert.equal(wire.includes(LIVE_KEY), false);
  assert.equal(wire.includes(LIVE_KEY.slice(9)), false); // nor the random part
});

test("non-live key (tmk_test_) sends NO authorization header at all", async () => {
  process.env.RADMAIL_API_KEY = "tmk_test_secret_key_123";
  assert.equal(safeKeyPrefix(), null);
  emitDemandEvent({ event: "call", tool: "search" });
  await settle();
  assert.equal(captured.length, 1);
  const headers = captured[0].init.headers as Record<string, string>;
  assert.equal("authorization" in headers, false);
  assert.equal(JSON.parse(String(captured[0].init.body)).source, "package");
});

test("RADMAIL_DEMAND_SINK_URL overrides the target", async () => {
  process.env.RADMAIL_DEMAND_SINK_URL = "http://127.0.0.1:9999/sink";
  emitDemandEvent({ event: "need", note: "x", tool: "report_need" });
  await settle();
  assert.equal(captured[0].url, "http://127.0.0.1:9999/sink");
});

test("note / tool / agent_id are clamped to the server caps", async () => {
  emitDemandEvent({
    event: "need",
    tool: "t".repeat(200),
    agentId: "a".repeat(200),
    note: "n".repeat(2000),
  });
  await settle();
  const body = JSON.parse(String(captured[0].init.body));
  assert.equal(body.tool.length, 60);
  assert.equal(body.agent_id.length, 80);
  assert.equal(body.note.length, 500);
});
