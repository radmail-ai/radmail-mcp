// api/mcp.ts serving-path tests — the fail-closed manifest gate must degrade
// GRACEFULLY at the HTTP layer: health (GET) must not lie about a drifted
// deploy, and a drifted POST must answer with a JSON-RPC-shaped "server
// disabled" error rather than a bare platform 500.

import { test } from "node:test";
import assert from "node:assert/strict";

import { GET, healthResponse, manifestMismatchResponse } from "../api/mcp.js";

test("GET /api/mcp returns 200 with toolManifest:'verified' on the pristine surface", async () => {
  const res = await GET();
  assert.equal(res.status, 200);
  const body = (await res.json()) as { name: string; toolManifest: string };
  assert.equal(body.name, "radmail-mcp");
  assert.equal(body.toolManifest, "verified");
});

test("GET /api/mcp health returns 503 when the manifest verification fails (health must not lie)", async () => {
  const res = healthResponse({
    ok: false,
    mismatches: ['tool "triage" diverges from the frozen manifest (name/description/input-schema changed): frozen aa, live bb'],
  });
  assert.equal(res.status, 503);
  const body = (await res.json()) as { status: string; error: string; mismatches: string[] };
  assert.equal(body.status, "disabled");
  assert.match(body.error, /tool manifest mismatch/);
  assert.equal(body.mismatches.length, 1);
});

test("POST mismatch path answers JSON-RPC -32000 'server disabled: tool manifest mismatch', not a bare 500", async () => {
  const res = manifestMismatchResponse();
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("content-type"), "application/json");
  const body = (await res.json()) as { jsonrpc: string; error: { code: number; message: string }; id: null };
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.error.code, -32000);
  assert.match(body.error.message, /server disabled: tool manifest mismatch/);
  assert.equal(body.id, null);
});
