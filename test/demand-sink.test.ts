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
  // The event SHAPE is unchanged; what travels in `note` is not. Agent-authored
  // free text (report_need) is now opt-IN because it is a PHI hazard on the
  // SHARED sink; a capability LABEL still travels, because that is the signal.
  const need = events.find((e) => e.event === "need");
  assert.equal(need.note, undefined, "report_need free text must be opt-in (RADMAIL_TELEMETRY_NOTES=on)");
  const cap = events.find((e) => e.event === "capability");
  assert.equal(cap.note, "snooze_email", "capability label must survive — dropping it darkens the demand signal");
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
  // `need` free text only travels when explicitly opted in — assert the clamp on
  // the path that can actually carry it, rather than deleting the coverage.
  process.env.RADMAIL_TELEMETRY_NOTES = "on";
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
  delete process.env.RADMAIL_TELEMETRY_NOTES;
});

test("capability labels are clamped TIGHTER (200) so they cannot become a free-text channel", async () => {
  captured = [];
  mockFetch();
  delete process.env.RADMAIL_TELEMETRY_NOTES; // opt-in OFF — label must still travel
  emitDemandEvent({ event: "capability", tool: "request_capability", note: "c".repeat(2000) });
  await settle();
  const body = JSON.parse(String(captured[0].init.body));
  assert.equal(body.note.length, 200, "a capability label must not be usable as a 500-char prose field");
});

// ── PHI: free-text notes are opt-IN, capability labels are not ──────────────
// These assert the BODY SHAPE, not the absence of an error. Every sink failure
// is swallowed by design, so "it didn't throw" proves nothing about what was
// actually put on the wire — the only real evidence is the captured request.

test("report_need free text is DROPPED by default (PHI hazard, opt-in)", async () => {
  _resetLearning();
  captured = [];
  mockFetch();
  delete process.env.RADMAIL_TELEMETRY_NOTES;

  recordNeed("agent-1", "Patient Jane Doe asked about her MRI results on 3/14");
  await settle();

  const need = captured.find((c) => JSON.parse(String(c.init.body)).event === "need");
  assert.ok(need, "the need event should still be emitted");
  const body = JSON.parse(String(need!.init.body)) as Record<string, unknown>;
  assert.equal(body.note, undefined, "agent free text must NOT reach the shared sink by default");
  assert.equal(body.event, "need", "the demand signal itself must survive");
});

test("request_capability label SURVIVES the drop — the signal is not darkened", async () => {
  _resetLearning();
  captured = [];
  mockFetch();
  delete process.env.RADMAIL_TELEMETRY_NOTES;

  recordCapability("agent-1", "bulk-archive");
  await settle();

  const cap = captured.find((c) => JSON.parse(String(c.init.body)).event === "capability");
  assert.ok(cap, "capability event should be emitted");
  const body = JSON.parse(String(cap!.init.body)) as Record<string, unknown>;
  assert.equal(body.note, "bulk-archive", "capability NAME travels in note and must be preserved");
});

test("RADMAIL_TELEMETRY_NOTES=on restores free text; anything else does not", async () => {
  for (const [value, expectNote] of [["on", true], ["true", false], ["1", false], ["ON", true]] as const) {
    _resetLearning();
    captured = [];
    mockFetch();
    process.env.RADMAIL_TELEMETRY_NOTES = value;

    recordNeed("agent-1", "a plain product request");
    await settle();

    const need = captured.find((c) => JSON.parse(String(c.init.body)).event === "need");
    const body = JSON.parse(String(need!.init.body)) as Record<string, unknown>;
    assert.equal(
      body.note !== undefined,
      expectNote,
      `RADMAIL_TELEMETRY_NOTES="${value}" should ${expectNote ? "enable" : "NOT enable"} free text`,
    );
  }
  delete process.env.RADMAIL_TELEMETRY_NOTES;
});
