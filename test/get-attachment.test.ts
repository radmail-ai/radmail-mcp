// get_attachment — the connected-mode bridge to one file on a real email
// (Doug, 2026-10-25: read the bookkeeper's monthly tax-report attachments).
//
// Proves: the right v1 path and Bearer auth; the bytes land on disk under a
// name built from the email id + index (never the sender's filename); the
// sender's filename is tainted; a server refusal comes back as the server's
// own reason with nothing written; 401 fails closed without the key; no
// folder configured → refused before any request; no key → setup pointer.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAttachmentTool, ATTACHMENT_DIR_ENV } from "../src/tools.js";
import { __setFetchForTests } from "../src/lib/connected.js";
import { isTainted, PERMANENT_HARD_STOPS } from "../src/lib/taint.js";

const KEY = "tmk_test_secret_key_456";
const ID = "33333333-3333-4333-8333-333333333333";
const PDF = Buffer.from("%PDF-1.4 fake tax report");

let dir = "";
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["RADMAIL_API_KEY", "RADMAIL_API_URL", ATTACHMENT_DIR_ENV]) saved[k] = process.env[k];
  delete process.env.RADMAIL_API_URL;
  process.env.RADMAIL_API_KEY = KEY;
  dir = mkdtempSync(join(tmpdir(), "radmail-att-"));
  process.env[ATTACHMENT_DIR_ENV] = dir;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __setFetchForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function assertSafety(r: unknown) {
  const s = (r as { safety?: { permanentHardStops?: readonly string[] } }).safety;
  assert.ok(s, "response must carry a top-level safety block");
  assert.deepEqual(s!.permanentHardStops, PERMANENT_HARD_STOPS);
}

test("get_attachment: fetches the right path with the key, saves the bytes, returns the path", async () => {
  let seenUrl = "";
  let seenAuth = "";
  __setFetchForTests(async (url, init) => {
    seenUrl = String(url);
    seenAuth = String((init.headers as Record<string, string>).Authorization);
    return new Response(PDF, {
      status: 200,
      headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="../../July 2026 Tax Report.pdf"' },
    });
  });
  const r = (await getAttachmentTool({ id: ID, index: 1 })) as Record<string, any>;
  assertSafety(r);
  assert.equal(r.ok, true);
  assert.match(seenUrl, new RegExp(`/api/v1/emails/${ID}/attachments/1$`));
  assert.equal(seenAuth, `Bearer ${KEY}`);
  assert.equal(r.savedTo, join(dir, `${ID}-1.pdf`), "saved under id + index, never the sender's path");
  assert.deepEqual(readFileSync(r.savedTo), PDF);
  assert.deepEqual(readdirSync(dir), [`${ID}-1.pdf`], "nothing written outside the folder");
  assert.equal(r.bytes, PDF.byteLength);
  assert.equal(r.contentType, "application/pdf");
  assert.ok(isTainted(r.filename), "the sender's filename is tainted");
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test("get_attachment: a server refusal carries the server's reason and writes nothing", async () => {
  __setFetchForTests(async () =>
    new Response(JSON.stringify({ ok: false, error: "sender_not_allowed", message: "Attachments are served only from allowlisted senders." }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }),
  );
  const r = (await getAttachmentTool({ id: ID, index: 0 })) as Record<string, any>;
  assertSafety(r);
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.equal(r.status, 403);
  assert.equal(r.error, "sender_not_allowed");
  assert.deepEqual(readdirSync(dir), []);
});

test("get_attachment: 401 fails closed, no key in the message, nothing written", async () => {
  __setFetchForTests(async () => new Response("{}", { status: 401 }));
  const r = (await getAttachmentTool({ id: ID, index: 0 })) as Record<string, any>;
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, "auth");
  assert.ok(!JSON.stringify(r).includes(KEY));
  assert.deepEqual(readdirSync(dir), []);
});

test("get_attachment: no folder configured → refused before any request", async () => {
  delete process.env[ATTACHMENT_DIR_ENV];
  let called = false;
  __setFetchForTests(async () => {
    called = true;
    return new Response(PDF);
  });
  const r = (await getAttachmentTool({ id: ID, index: 0 })) as Record<string, any>;
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, "config");
  assert.equal(called, false);
});

test("get_attachment: without a key → the setup pointer, no request", async () => {
  delete process.env.RADMAIL_API_KEY;
  let called = false;
  __setFetchForTests(async () => {
    called = true;
    return new Response(PDF);
  });
  const r = (await getAttachmentTool({ id: ID, index: 0 })) as Record<string, any>;
  assertSafety(r);
  assert.equal(r.connected, false);
  assert.equal(called, false);
  assert.equal(existsSync(join(dir, `${ID}-0.bin`)), false);
});
