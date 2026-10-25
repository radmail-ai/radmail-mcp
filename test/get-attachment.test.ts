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

import { getAttachmentTool, ATTACHMENT_DIR_ENV, attachmentExtension } from "../src/tools.js";
import { __setFetchForTests, __setAttachmentTimeoutForTests, ATTACHMENT_MAX_BYTES } from "../src/lib/connected.js";
import { statSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
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
  __setAttachmentTimeoutForTests(null);
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

// ── review of #21 ────────────────────────────────────────────────────────────

test("get_attachment: a body past the size cap is refused and nothing is written", async () => {
  __setFetchForTests(async () => {
    let sent = 0;
    const chunk = new Uint8Array(1024 * 1024);
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent > ATTACHMENT_MAX_BYTES + chunk.byteLength) return c.close();
          sent += chunk.byteLength;
          c.enqueue(chunk);
        },
      }),
      { status: 200, headers: { "content-type": "application/pdf" } },
    );
  });
  const r = (await getAttachmentTool({ id: ID, index: 0 })) as Record<string, any>;
  assert.equal(r.ok, false);
  assert.match(r.error.message, /larger than/);
  assert.deepEqual(readdirSync(dir), []);
});

test("get_attachment: a declared Content-Length over the cap is refused before reading", async () => {
  __setFetchForTests(async () => new Response(PDF, { status: 200, headers: { "content-length": String(ATTACHMENT_MAX_BYTES + 1) } }));
  const r = (await getAttachmentTool({ id: ID, index: 0 })) as Record<string, any>;
  assert.equal(r.ok, false);
  assert.match(r.error.message, /larger than/);
});

test("get_attachment: a body that stalls after the headers times out (the deadline covers the body)", { timeout: 5000 }, async () => {
  __setAttachmentTimeoutForTests(150);
  __setFetchForTests(async (_url, init) => {
    const signal = init.signal as AbortSignal;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([37, 80]));
          signal.addEventListener("abort", () => c.error(Object.assign(new Error("aborted"), { name: "AbortError" })));
        },
      }),
      { status: 200, headers: { "content-type": "application/pdf" } },
    );
  });
  const started = Date.now();
  const r = (await getAttachmentTool({ id: ID, index: 0 })) as Record<string, any>;
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, "timeout");
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(readdirSync(dir), []);
});

test("get_attachment: an id that is not a plain id is refused, never rewritten", async () => {
  let called = false;
  __setFetchForTests(async () => {
    called = true;
    return new Response(PDF);
  });
  for (const id of ["a/b/c", "../x", "!!!", "", "-", "-abc"]) {
    const r = (await getAttachmentTool({ id, index: 0 })) as Record<string, any>;
    assert.equal(r.ok, false, id);
    assert.equal(r.error.kind, "bad_request", id);
  }
  assert.equal(called, false);
});

test("get_attachment: a symlink planted at the target is replaced, not written through; files are 0600", async () => {
  const outside = join(dir, "..", `outside-${process.pid}.txt`);
  writeFileSync(outside, "keep me");
  symlinkSync(outside, join(dir, `${ID}-0.pdf`));
  __setFetchForTests(async () => new Response(PDF, { status: 200, headers: { "content-type": "application/pdf" } }));
  const r = (await getAttachmentTool({ id: ID, index: 0 })) as Record<string, any>;
  assert.equal(r.ok, true);
  assert.equal(readFileSync(outside, "utf8"), "keep me", "the file the symlink pointed at is untouched");
  assert.equal(lstatSync(r.savedTo).isSymbolicLink(), false);
  assert.equal(statSync(r.savedTo).mode & 0o777, 0o600);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0, "no temp file left behind");
  rmSync(outside, { force: true });
});

test("attachmentExtension: the server's content type wins; filename only for octet-stream; else .bin", () => {
  assert.equal(attachmentExtension("application/pdf", "report.html"), "pdf");
  assert.equal(attachmentExtension("text/csv; charset=utf-8", null), "csv");
  assert.equal(attachmentExtension("application/octet-stream", "July Report.XLSX"), "xlsx");
  assert.equal(attachmentExtension("text/html", "x.html"), "bin");
  assert.equal(attachmentExtension(null, null), "bin");
});

test("get_attachment: the UTF-8 filename* form is decoded and still tainted", async () => {
  __setFetchForTests(async () =>
    new Response(PDF, { status: 200, headers: { "content-type": "application/pdf", "content-disposition": "attachment; filename*=UTF-8''Tax%20Report%20%E2%80%93%20July.pdf" } }),
  );
  const r = (await getAttachmentTool({ id: ID, index: 0 })) as Record<string, any>;
  assert.equal(r.ok, true);
  assert.equal(r.filename.value, "Tax Report – July.pdf");
});

test("get_attachment: a huge refusal body is not read past 64 KB; the refusal still comes back", async () => {
  __setFetchForTests(async () => {
    let sent = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent >= 50 * 1024 * 1024) return c.close();
          sent += chunk.byteLength;
          c.enqueue(chunk);
        },
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  });
  const r = (await getAttachmentTool({ id: ID, index: 0 })) as Record<string, any>;
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.equal(r.status, 403);
  assert.equal(r.error, "http_403");
});
