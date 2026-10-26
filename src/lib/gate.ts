// Gate client — asks RadMail whether an email should be sent, WITHOUT sending
// it (POST /api/v1/gate on app.radmail.ai, read scope). For an agent that sends
// through its OWN provider (Resend, SES, SMTP, Gmail, another inbox API).
//
// ── WHAT THE ROUTE DOES ─────────────────────────────────────────────────────
// RadMail runs the checks POST /v1/send runs before anything leaves — the
// regime content scrubber, the suppression list, the deterministic checklist
// and the tier gate — and answers pass | review | human_only with reasons. It
// sends nothing, stores no send request and contacts no mail provider (the only
// writes are the key's last-used stamp and its rate-limit bucket, as on every
// v1 route). `pass` is NOT a clearance: it means no known risk pattern matched.
//
// ── WHAT THIS FILE MUST NEVER DO ────────────────────────────────────────────
// 🛑 Turn a non-answer into a verdict. A 404 (switched off), 401, 403, 400,
//    5xx, timeout, network error or a 200 without a recognisable verdict is
//    UNCHECKED — `verdict: null` — never pass. A test plants each one.
// 🛑 Pass the server's response through. Fields are copied by NAME, and the
//    few that carry text are checked: a reason's evidence excerpt reaches the
//    agent only when it is a piece of the text the agent itself submitted, and
//    a first-contact address only when it is one of the agent's own recipients.
//    A field the server grows tomorrow (or a credential) never reaches the agent.
// 🛑 Lower a verdict. The mapping can only TIGHTEN what RadMail said: a
//    hard_stop tier or a first-contact recipient is at least human_only, a
//    sensitive tier or any reason is at least review — the same floor the
//    server applies to itself, applied again here.
// 🛑 Ask for the LLM review leg. The route refuses `review: "llm"` (a paid
//    model call on a read-scope route); this client never sends `review`.
// 🛑 Send attachment bytes. Metadata only (filename, size, type); the payload
//    is built field by field, so nothing else can ride along.
// 🛑 Log or echo the key. It appears in one header and nowhere else.
//
// It lives apart from src/lib/connected.ts on purpose: that client is GET-only
// by construction and says so. This one makes exactly one POST, to GATE_PATH.

import { taint, type Tainted } from "./taint.js";

/** The only path this client ever requests. */
export const GATE_PATH = "/api/v1/gate";
const TIMEOUT_MS = 15_000;

export interface GateConfig {
  apiKey: string;
  apiUrl: string;
}

export interface GateAttachmentMeta {
  filename: string;
  sizeBytes?: number;
  contentType?: string;
}

/** What the agent submits — the message exactly as it would go out. */
export interface GateInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  from?: string;
  attachments?: GateAttachmentMeta[];
}

export type GateVerdict = "pass" | "review" | "human_only";
export type GateTier = "normal" | "sensitive" | "hard_stop";
export type IdentityChecks = "ran" | "unreadable" | "off";

export interface GateReason {
  /** RadMail's machine code for the reason; null when it sent something that is not a short token. */
  code: string | null;
  /** RadMail's own sentence, whitespace-collapsed and capped. */
  message: string;
  /** Where in the SUBMITTED text it matched — present only when the excerpt is the agent's own text. */
  evidence?: { field: string; start: number; end: number; excerpt: Tainted<string> };
}

export type GateOutcome =
  | {
      checked: true;
      sent: false;
      verdict: GateVerdict;
      /** Present only when this client raised RadMail's verdict to the floor its own tier implies. */
      verdictRaised?: { from: GateVerdict; because: string };
      tier: GateTier | null;
      reasons: GateReason[];
      reasonsOmitted?: number;
      evidenceWithheld?: number;
      /** Recipients RadMail has no record of corresponding with; null = not checked. */
      firstContact: string[] | null;
      firstContactWithheld?: number;
      checks: { identity: IdentityChecks | null };
      /** RadMail's own note on the verdict, capped. */
      radmailNote: string | null;
    }
  | {
      checked: false;
      sent: false;
      verdict: null;
      error: { kind: string; status: number | null; code?: string; message: string };
    };

// ─── fetch seam (tests swap this; production uses global fetch) ─────────────
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init);

/** Test-only: inject a mock fetch (pass null to restore global fetch). */
export function __setGateFetchForTests(f: FetchLike | null): void {
  fetchImpl = f ?? ((url, init) => globalThis.fetch(url, init));
}

let timeoutMs = TIMEOUT_MS;
/** Test-only: shorten the deadline (pass null to restore). */
export function __setGateTimeoutForTests(ms: number | null): void {
  timeoutMs = ms ?? TIMEOUT_MS;
}

// ─── the request ─────────────────────────────────────────────────────────────

/** The JSON body, built field by field. No `review`, no attachment bytes, nothing else. PURE. */
export function gatePayload(input: GateInput): Record<string, unknown> {
  return {
    to: input.to,
    cc: input.cc ?? [],
    bcc: input.bcc ?? [],
    subject: input.subject,
    body: input.body,
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
    ...(input.from ? { from: input.from } : {}),
    ...(input.attachments && input.attachments.length > 0
      ? {
          attachments: input.attachments.map((a) => ({
            filename: a.filename,
            ...(typeof a.sizeBytes === "number" ? { sizeBytes: a.sizeBytes } : {}),
            ...(typeof a.contentType === "string" && a.contentType ? { contentType: a.contentType } : {}),
          })),
        }
      : {}),
  };
}

const UNCHECKED = "UNCHECKED — not a pass. Nothing was sent.";

/** Ask once. Never throws; never retries; never reports a verdict it did not receive. */
export async function checkBeforeSend(input: GateInput, cfg: GateConfig): Promise<GateOutcome> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.apiUrl}${GATE_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(gatePayload(input)),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const timedOut = e instanceof Error && e.name === "AbortError";
    return timedOut
      ? unchecked(
          "timeout",
          null,
          null,
          `RadMail did not answer within ${timeoutMs / 1000}s, so this message is unchecked — do not treat it as pass. ${UNCHECKED}`,
        )
      : unchecked(
          "network",
          null,
          null,
          `Could not reach RadMail at ${cfg.apiUrl}, so this message is unchecked — do not treat it as pass. ${UNCHECKED}`,
        );
  }

  let body: Record<string, unknown> | null = null;
  try {
    const text = (await res.text()).slice(0, 512 * 1024);
    const parsed: unknown = JSON.parse(text);
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      clearTimeout(timer);
      return unchecked(
        "timeout",
        res.status,
        null,
        `RadMail did not finish answering within ${timeoutMs / 1000}s, so this message is unchecked — do not treat it as pass. ${UNCHECKED}`,
      );
    }
    body = null;
  } finally {
    clearTimeout(timer);
  }
  return mapGateResponse(res.status, body, input);
}

// ─── the answer ──────────────────────────────────────────────────────────────

/** A server error code is a short machine token. Anything else is not repeated. */
const CODE_RE = /^[a-z][a-z0-9_:.-]{0,79}$/;
const MESSAGE_MAX = 600;
const DETAIL_MAX = 300;
const NOTE_MAX = 400;
/** Reasons beyond this are counted, never dropped silently. */
export const REASONS_MAX = 60;

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const code = (v: unknown): string | null => (typeof v === "string" && CODE_RE.test(v) ? v : null);
const prose = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s ? (s.length > max ? `${s.slice(0, max)}…` : s) : null;
};

function unchecked(kind: string, status: number | null, serverCode: string | null, message: string): GateOutcome {
  return {
    checked: false,
    sent: false,
    verdict: null,
    error: { kind, status, ...(serverCode ? { code: serverCode } : {}), message },
  };
}

const VERDICTS: readonly GateVerdict[] = ["pass", "review", "human_only"];
const TIERS: readonly GateTier[] = ["normal", "sensitive", "hard_stop"];
const IDENTITY: readonly IdentityChecks[] = ["ran", "unreadable", "off"];
const LEVEL: Record<GateVerdict, number> = { pass: 0, review: 1, human_only: 2 };

/** The fields an evidence span may point at — each one is text the agent submitted. */
const EVIDENCE_FIELD_RE = /^(subject|body|bodyAsRead|from|(to|cc|bcc)\[\d{1,3}\]|attachments\[(\d{1,3})\]\.filename)$/;

/** The submitted text an evidence field refers to, or null when it names nothing the agent sent. */
function submittedTextFor(field: string, input: GateInput): string | null {
  const m = EVIDENCE_FIELD_RE.exec(field);
  if (!m) return null;
  if (field === "subject") return input.subject;
  // "bodyAsRead" is the body as the recipient reads it (markup rendered): RadMail's
  // rendering of the agent's own body. Its excerpt is accepted only where it is
  // also a piece of the body as submitted.
  if (field === "body" || field === "bodyAsRead") return input.body;
  if (field === "from") return input.from ?? null;
  if (m[2] === "to") return input.to.join("\n");
  if (m[2] === "cc") return (input.cc ?? []).join("\n");
  if (m[2] === "bcc") return (input.bcc ?? []).join("\n");
  const i = Number(m[3]);
  return input.attachments?.[i]?.filename ?? null;
}

const isOffset = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000_000;

/**
 * Keep an evidence span only when its excerpt is a piece of what the agent
 * itself submitted in that field (RadMail appends "…" past 120 characters; the
 * comparison ignores case). Anything else — another person's address, text the
 * agent never wrote — is withheld. The excerpt is taint-wrapped: it is the
 * agent's own draft text, and the reasons it is quoted for include text aimed
 * at an AI that the draft most likely picked up from mail.
 */
function evidenceFrom(v: unknown, input: GateInput): GateReason["evidence"] | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  const field = str(e.field);
  const excerpt = str(e.excerpt);
  if (!field || !excerpt || !isOffset(e.start) || !isOffset(e.end) || e.end < e.start) return null;
  const source = submittedTextFor(field, input);
  if (source === null) return null;
  const core = excerpt.endsWith("…") ? excerpt.slice(0, -1) : excerpt;
  if (!core || core.length > 200 || !source.toLowerCase().includes(core.toLowerCase())) return null;
  return { field, start: e.start, end: e.end, excerpt: taint(excerpt) };
}

/** Every address the agent submitted, lower-cased, for the first-contact check. */
function submittedRecipients(input: GateInput): Set<string> {
  return new Set([...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])].map((a) => a.trim().toLowerCase()));
}

/** Plain words for every way the route can decline to give a verdict. */
function refusal(status: number, b: Record<string, unknown> | null): GateOutcome {
  const c = code(b?.error);
  const detail = prose(b?.detail, DETAIL_MAX);
  if (status === 404) {
    if (c === "gate_api_disabled") {
      return unchecked(
        "gate_not_enabled",
        404,
        c,
        `Checking before send is not enabled on this RadMail workspace yet — treat the message as unchecked, not as pass. ${UNCHECKED}`,
      );
    }
    return unchecked(
      "not_available",
      404,
      c,
      `This RadMail deployment does not offer the check yet (HTTP 404) — treat the message as unchecked, not as pass. ${UNCHECKED}`,
    );
  }
  if (status === 401) {
    return unchecked(
      "auth",
      401,
      c,
      "RadMail rejected this server's API key (401): it is invalid, revoked, or mistyped. Fix the key and ask again. " +
        `Until then the message is unchecked, not a pass. ${UNCHECKED}`,
    );
  }
  if (status === 403) {
    if (c === "mailbox_scope_not_supported_on_this_route") {
      return unchecked(
        "mailbox_confined_key",
        403,
        c,
        "This RadMail key is limited to one mailbox, and the check reads the whole workspace, so RadMail refuses it. " +
          `Use a key that is not limited to one mailbox. Until then the message is unchecked, not a pass. ${UNCHECKED}`,
      );
    }
    return unchecked(
      c && c.startsWith("missing_scope") ? "missing_scope" : "entitlement",
      403,
      c,
      `RadMail refused this key for the check (403${c ? ` ${c}` : ""})${detail ? `: ${detail}` : ""}. ` +
        `The message is unchecked, not a pass. ${UNCHECKED}`,
    );
  }
  if (status === 400) {
    return unchecked(
      "invalid_request",
      400,
      c,
      `RadMail could not check the message as given (400${c ? ` ${c}` : ""})${detail ? `: ${detail}` : ""}. ` +
        `Fix the input and ask again; until then it is unchecked, not a pass. ${UNCHECKED}`,
    );
  }
  if (status === 429) {
    return unchecked(
      "rate_limited",
      429,
      c,
      `RadMail is rate-limiting this key (429). The message is unchecked, not a pass — ask again later. ${UNCHECKED}`,
    );
  }
  if (status >= 500) {
    return unchecked(
      "not_checked",
      status,
      c,
      `RadMail could not check this message (HTTP ${status}${c ? ` ${c}` : ""}), so there is no verdict — do not treat it as pass. ${UNCHECKED}`,
    );
  }
  return unchecked(
    "unexpected_status",
    status,
    c,
    `RadMail answered HTTP ${status}${c ? ` ${c}` : ""} without a verdict — treat the message as unchecked, not as pass. ${UNCHECKED}`,
  );
}

/**
 * Map one /v1/gate response to an outcome. PURE — every branch is pinned.
 * `input` is what the agent submitted: the only text an excerpt or a
 * first-contact address may be drawn from.
 */
export function mapGateResponse(status: number, body: Record<string, unknown> | null, input: GateInput): GateOutcome {
  if (status !== 200) return refusal(status, body);
  const b = body ?? {};
  const said = VERDICTS.find((v) => v === b.verdict) ?? null;
  // A 200 is a verdict only when it says it is one, in the shape the route documents.
  if (b.ok !== true || b.sent !== false || said === null) {
    return unchecked(
      "unrecognized_response",
      200,
      null,
      `RadMail answered without a verdict this server recognises — treat the message as unchecked, not as pass. ${UNCHECKED}`,
    );
  }

  const tier = TIERS.find((t) => t === b.tier) ?? null;

  const rawReasons = Array.isArray(b.reasons) ? b.reasons : [];
  let evidenceWithheld = 0;
  const reasons: GateReason[] = [];
  for (const r of rawReasons.slice(0, REASONS_MAX)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const message = prose(o.message, MESSAGE_MAX);
    const c = code(o.code);
    if (!message && !c) continue;
    const reason: GateReason = { code: c, message: message ?? "" };
    if (o.evidence !== undefined && o.evidence !== null) {
      const ev = evidenceFrom(o.evidence, input);
      if (ev) reason.evidence = ev;
      else evidenceWithheld += 1;
    }
    reasons.push(reason);
  }
  const reasonsOmitted = Math.max(0, rawReasons.length - REASONS_MAX);

  let firstContact: string[] | null = null;
  let firstContactWithheld = 0;
  if (Array.isArray(b.firstContact)) {
    const mine = submittedRecipients(input);
    firstContact = [];
    for (const a of b.firstContact.slice(0, 50)) {
      if (typeof a === "string" && mine.has(a.trim().toLowerCase())) firstContact.push(a.trim());
      else firstContactWithheld += 1;
    }
    firstContactWithheld += Math.max(0, b.firstContact.length - 50);
  }

  const checksObj = b.checks && typeof b.checks === "object" ? (b.checks as Record<string, unknown>) : {};
  const identity = IDENTITY.find((v) => v === checksObj.identity) ?? null;

  // 🔑 The floor: never report less than what RadMail's own tier and reasons imply.
  const floors: Array<[GateVerdict, string, boolean]> = [
    ["human_only", "RadMail's tier for this message is hard_stop", tier === "hard_stop"],
    ["human_only", "RadMail named a first-contact recipient", (firstContact?.length ?? 0) > 0 || firstContactWithheld > 0],
    ["review", "RadMail's tier for this message is sensitive", tier === "sensitive"],
    ["review", "RadMail named at least one reason", reasons.length > 0 || reasonsOmitted > 0],
  ];
  const floor = floors.find(([v, , applies]) => applies && LEVEL[v] > LEVEL[said]);
  const verdict: GateVerdict = floor ? floor[0] : said;

  return {
    checked: true,
    sent: false,
    verdict,
    ...(floor ? { verdictRaised: { from: said, because: floor[1] } } : {}),
    tier,
    reasons,
    ...(reasonsOmitted > 0 ? { reasonsOmitted } : {}),
    ...(evidenceWithheld > 0 ? { evidenceWithheld } : {}),
    firstContact,
    ...(firstContactWithheld > 0 ? { firstContactWithheld } : {}),
    checks: { identity },
    radmailNote: prose(b.note, NOTE_MAX),
  };
}
