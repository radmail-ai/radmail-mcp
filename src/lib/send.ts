// Send client — the ONE write this package can make, and only when an operator
// turns it on. Submits a composed email to RadMail's outbound gate
// (POST /api/v1/send on app.radmail.ai) with a SEPARATE, send-scoped key.
//
// ── WHAT DECIDES WHETHER MAIL LEAVES ────────────────────────────────────────
// Not this file and not the calling agent. RadMail runs its own gate on every
// request: the regime scrubber, the suppression list, a deterministic
// checklist, an LLM review, the BEC tier (money / changed-banking /
// first-contact / decision / injection, and regulator / government / court /
// bank recipients ALWAYS hold) and the no-tap list (only the owner's own team
// and established two-way contacts may send without a person). Anything else
// is HELD, and a held send is released by a PERSON signed in to the RadMail
// app. This client can only report which of three things happened:
//
//   sent     — RadMail's gate released it; it left the owner's mailbox.
//   held     — waiting for the owner. We hand back a link to the app page.
//   refused  — not sent and not held (bad input, switched off, no key, …).
//
// ── WHAT THIS FILE MUST NEVER DO ────────────────────────────────────────────
// 🛑 Release a hold. There is no release endpoint on the API (the old confirm
//    route refuses every call since 2026-09-21) and this client never names
//    one. The only URL it ever builds is SEND_PATH. A test reads this file and
//    every URL the client fetches to keep it that way.
// 🛑 Retry. A POST that timed out may have SENT. RadMail de-duplicates an
//    identical retry by content hash, but "retry automatically" is still the
//    wrong reflex on a send; we say "outcome unknown" and point at the app.
// 🛑 Pass the server's response through. Fields are copied by NAME. If the
//    API ever grew a credential on a hold, it would not reach the agent.
// 🛑 Log or echo the key.

export const DEFAULT_API_URL = "https://app.radmail.ai";
/** The only path this client ever requests. */
export const SEND_PATH = "/api/v1/send";
const TIMEOUT_MS = 30_000;

export interface SendConfig {
  apiKey: string;
  apiUrl: string;
}

/**
 * Has the operator asked for the send tool on THIS server? Both must be true:
 * the explicit opt-in flag, and a local transport (decided by the caller — the
 * hosted HTTP entry never passes it through).
 */
export function sendToolRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RADMAIL_SEND_TOOL?.trim() === "1";
}

/** The send-scoped key, or null. Deliberately NOT RADMAIL_API_KEY (the read key). */
export function getSendConfig(env: NodeJS.ProcessEnv = process.env): SendConfig | null {
  const apiKey = env.RADMAIL_SEND_API_KEY?.trim();
  if (!apiKey) return null;
  const apiUrl = (env.RADMAIL_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
  return { apiKey, apiUrl };
}

export interface SendInput {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  markdown: string;
  inReplyTo?: string;
  requestedBy?: string;
  idempotencyKey?: string;
}

export type SendOutcome =
  | {
      outcome: "sent";
      requestId: string | null;
      sendId: string | null;
      duplicate: boolean;
    }
  | {
      outcome: "held";
      requestId: string | null;
      tier: string | null;
      holdReasons: string[];
      reviewUrl: string;
      expiresAt: string | null;
      duplicate: boolean;
    }
  | {
      outcome: "refused";
      httpStatus: number | null;
      error: string;
      detail: string;
    };

// ─── fetch seam (tests swap this; production uses global fetch) ─────────────
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init);

/** Test-only: inject a mock fetch (pass null to restore global fetch). */
export function __setSendFetchForTests(f: FetchLike | null): void {
  fetchImpl = f ?? ((url, init) => globalThis.fetch(url, init));
}

const REVIEW_PATH_RE = /^\/sends\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The app page where the owner releases a hold. Only ever a /sends link. PURE. */
export function reviewUrlFor(apiUrl: string, reviewPath: unknown): string {
  return typeof reviewPath === "string" && REVIEW_PATH_RE.test(reviewPath)
    ? `${apiUrl}${reviewPath}`
    : `${apiUrl}/sends`;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 20) : [];

/** Plain-language refusals for the statuses an operator can fix. */
function refusalDetail(status: number, error: string, detail: string | null): string {
  if (status === 404 && error === "send_api_disabled") {
    return "Sending through the API is switched off on this RadMail deployment (RADMAIL_SEND_API_ENABLED). Nothing was sent.";
  }
  if (status === 401) {
    return "RadMail rejected RADMAIL_SEND_API_KEY (missing, malformed, or revoked). Nothing was sent.";
  }
  if (status === 403 && error.startsWith("missing_scope")) {
    return "RADMAIL_SEND_API_KEY does not carry the `send` scope. Mint a key with send scope in RadMail settings. Nothing was sent.";
  }
  return detail ?? `RadMail refused the send (${status} ${error}). Nothing was sent.`;
}

/** Map one /v1/send response to an outcome. PURE — every branch is pinned. */
export function mapSendResponse(status: number, body: Record<string, unknown> | null, apiUrl: string): SendOutcome {
  const b = body ?? {};
  const st = str(b.status);
  if (status === 201 && st === "sent") {
    return { outcome: "sent", requestId: str(b.requestId), sendId: str(b.sendId), duplicate: false };
  }
  if (status === 202 && st === "held") {
    return {
      outcome: "held",
      requestId: str(b.requestId),
      tier: str(b.tier),
      holdReasons: strList(b.holdReasons),
      reviewUrl: reviewUrlFor(apiUrl, b.reviewPath),
      expiresAt: str(b.expiresAt),
      duplicate: false,
    };
  }
  if (status === 200 && st === "duplicate") {
    // An identical request already ran. Report what it became; never re-send.
    const prior = str(b.priorStatus);
    const requestId = str(b.requestId);
    if (prior === "sent" || prior === "releasing") {
      return { outcome: "sent", requestId, sendId: str(b.sendId), duplicate: true };
    }
    if (prior === "held") {
      return {
        outcome: "held",
        requestId,
        tier: null,
        holdReasons: [],
        reviewUrl: reviewUrlFor(apiUrl, requestId ? `/sends/${requestId}` : null),
        expiresAt: null,
        duplicate: true,
      };
    }
    return {
      outcome: "refused",
      httpStatus: status,
      error: `duplicate_of_${prior ?? "unknown"}`,
      detail: `An identical request already ran and ended as "${prior ?? "unknown"}". Nothing was re-sent.`,
    };
  }
  const error = str(b.error) ?? `http_${status}`;
  return {
    outcome: "refused",
    httpStatus: status,
    error,
    detail: refusalDetail(status, error, str(b.detail)),
  };
}

/** Submit one email. Never throws; never retries. */
export async function submitSend(input: SendInput, cfg: SendConfig): Promise<SendOutcome> {
  const url = `${cfg.apiUrl}${SEND_PATH}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;
  const payload = {
    from: input.from,
    to: input.to,
    cc: input.cc ?? [],
    bcc: input.bcc ?? [],
    subject: input.subject,
    markdown: input.markdown,
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
    requestedBy: input.requestedBy ?? "radmail-mcp send_email",
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(payload), signal: ctrl.signal });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "AbortError";
    return {
      outcome: "refused",
      httpStatus: null,
      error: timedOut ? "outcome_unknown_timeout" : "network_error",
      detail: timedOut
        ? `RadMail did not answer within ${TIMEOUT_MS / 1000}s, so this server cannot tell whether the email left. ` +
          `Check ${cfg.apiUrl}/sends before trying again; an identical retry is de-duplicated by RadMail and will report what happened.`
        : `Could not reach RadMail at ${cfg.apiUrl}. Nothing is known to have been sent.`,
    };
  } finally {
    clearTimeout(timer);
  }

  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await res.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  return mapSendResponse(res.status, body, cfg.apiUrl);
}
