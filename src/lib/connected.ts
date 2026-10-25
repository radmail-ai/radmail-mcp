// Connected-mode client — the READ-ONLY bridge to the user's REAL RadMail inbox
// (the app.radmail.ai v1 REST API, Bearer `tmk_...` API key).
//
// Presence of RADMAIL_API_KEY switches `search` / `list_right_now` /
// `list_commitments` (when `messages` is omitted) and `read_email` from the
// in-memory sandbox to the live inbox. Deliberately tiny:
//
//   · global fetch, 10s timeout, at most ONE retry (plain network errors only —
//     never on a timeout, never on an HTTP status)
//   · the API key is NEVER logged, echoed, or included in any response/error
//   · fail-closed: any auth / entitlement / timeout / parse problem surfaces as
//     a typed ConnectedApiError — results are never fabricated
//   · READ-ONLY by construction: this client only issues GETs. There is no
//     connected send / draft / mutate surface, so the BEC hard-stop contract
//     (money / changed-banking / first-contact / decision / injection =
//     human-only forever) is preserved exactly as in the sandbox.
//
// Taint discipline lives at the tool boundary (src/tools.ts): every field this
// client returns that derives from real email content is wrapped with taint()
// before it reaches the consuming agent.

export const DEFAULT_API_URL = "https://app.radmail.ai";
export const API_KEYS_URL = "https://app.radmail.ai/settings/api-keys";
const TIMEOUT_MS = 10_000;

export interface ConnectedConfig {
  apiKey: string;
  apiUrl: string;
}

/** Connected mode is ON iff RADMAIL_API_KEY is set. RADMAIL_API_URL overrides the host. */
export function getConnectedConfig(env: NodeJS.ProcessEnv = process.env): ConnectedConfig | null {
  const apiKey = env.RADMAIL_API_KEY?.trim();
  if (!apiKey) return null;
  const apiUrl = (env.RADMAIL_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
  return { apiKey, apiUrl };
}

export type ConnectedErrorKind = "auth" | "entitlement" | "timeout" | "network" | "api";

/** A typed, honest, key-free failure. The message is safe to show the agent verbatim. */
export class ConnectedApiError extends Error {
  readonly kind: ConnectedErrorKind;
  readonly status: number | null;
  constructor(kind: ConnectedErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "ConnectedApiError";
    this.kind = kind;
    this.status = status;
  }
}

// ─── fetch seam (tests swap this; production uses global fetch) ─────────────
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init);

/** Test-only: inject a mock fetch (pass null to restore global fetch). */
export function __setFetchForTests(f: FetchLike | null): void {
  fetchImpl = f ?? ((url, init) => globalThis.fetch(url, init));
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

async function fetchOnce(url: string, apiKey: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET a v1 API path with query params. Throws ConnectedApiError on any failure —
 * never returns partial/fabricated data. Error messages never contain the key.
 */
export async function apiGet(
  path: string,
  params: Record<string, string | number | undefined>,
  cfg: ConnectedConfig,
): Promise<Record<string, unknown>> {
  const url = new URL(`${cfg.apiUrl}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  const timeoutError = () =>
    new ConnectedApiError(
      "timeout",
      `The RadMail API did not respond within ${TIMEOUT_MS / 1000}s (GET ${path}). ` +
        `Fail-closed: no results. Check connectivity to ${cfg.apiUrl} and retry.`,
    );

  let res: Response;
  try {
    res = await fetchOnce(url.toString(), cfg.apiKey);
  } catch (e) {
    if (isAbortError(e)) throw timeoutError();
    // One retry, network errors only.
    try {
      res = await fetchOnce(url.toString(), cfg.apiKey);
    } catch (e2) {
      if (isAbortError(e2)) throw timeoutError();
      const detail = e2 instanceof Error ? e2.message : String(e2);
      throw new ConnectedApiError(
        "network",
        `Could not reach the RadMail API at ${cfg.apiUrl} (${detail}). Fail-closed: no results.`,
      );
    }
  }

  if (res.status === 401) {
    throw new ConnectedApiError(
      "auth",
      "RadMail API key rejected (401): the key is invalid, revoked, or mistyped. " +
        `Check the RADMAIL_API_KEY env var (keys start with tmk_) — manage keys at ${API_KEYS_URL}. ` +
        "Fail-closed: no results.",
      401,
    );
  }
  if (res.status === 403) {
    throw new ConnectedApiError(
      "entitlement",
      "RadMail API key not entitled (403): the key is valid but the account's plan or the key's scope " +
        `does not allow this operation. Review the plan/key at ${API_KEYS_URL}. Fail-closed: no results.`,
      403,
    );
  }
  if (!res.ok) {
    throw new ConnectedApiError(
      "api",
      `RadMail API error (HTTP ${res.status}) on GET ${path}. Fail-closed: no results fabricated. Retry, or contact security@radmail.ai if it persists.`,
      res.status,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ConnectedApiError(
      "api",
      `RadMail API returned a non-JSON response on GET ${path} (HTTP ${res.status}). Fail-closed: no results.`,
      res.status,
    );
  }

  const obj = body as Record<string, unknown> | null;
  if (!obj || obj.ok !== true) {
    const apiMsg = obj && typeof obj.error === "string" ? obj.error : "unknown error";
    throw new ConnectedApiError(
      "api",
      `RadMail API reported an error on GET ${path}: ${apiMsg}. Fail-closed: no results fabricated.`,
      res.status,
    );
  }
  return obj;
}

// ─── v1 endpoints ────────────────────────────────────────────────────────────

/** One hit from GET /api/v1/search. Fields are UNTRUSTED real-inbox content until tainted. */
export interface RemoteSearchHit {
  id?: string;
  receivedAt?: string;
  from?: string;
  fromName?: string | null;
  subject?: string | null;
  classification?: string | null;
  classificationSource?: string | null;
  isSpam?: boolean;
  needsOwnerEyes?: boolean;
  counterparty?: string | null;
  threadId?: string | null;
  snippet?: string | null;
  matchedIn?: string | string[] | null;
}

export interface RemotePagination {
  limit?: number;
  offset?: number;
  total?: number;
  hasMore?: boolean;
}

export interface RemoteSearchParams {
  query: string;
  limit?: number;
  from?: string;
  after?: string;
  before?: string;
}

/** GET /api/v1/search — search the user's real inbox. */
export async function searchInbox(
  p: RemoteSearchParams,
  cfg: ConnectedConfig,
): Promise<{ hits: RemoteSearchHit[]; pagination: RemotePagination | null }> {
  const body = await apiGet(
    "/api/v1/search",
    { q: p.query, limit: p.limit, from: p.from, after: p.after, before: p.before },
    cfg,
  );
  return {
    hits: Array.isArray(body.data) ? (body.data as RemoteSearchHit[]) : [],
    pagination: (body.pagination as RemotePagination | undefined) ?? null,
  };
}

/** Full email detail from GET /api/v1/emails/{id} — includes textBody. */
export interface RemoteEmailDetail extends RemoteSearchHit {
  textBody?: string | null;
}

/** GET /api/v1/emails/{id} — fetch one full email (incl. textBody). */
export async function getEmail(id: string, cfg: ConnectedConfig): Promise<RemoteEmailDetail | null> {
  const body = await apiGet(`/api/v1/emails/${encodeURIComponent(id)}`, {}, cfg);
  return (body.data as RemoteEmailDetail | undefined) ?? null;
}

/** One attachment's bytes from GET /api/v1/emails/{id}/attachments/{index}. */
export interface RemoteAttachment {
  bytes: Buffer;
  /** From Content-Disposition. UNTRUSTED: the sender chose it. */
  filename: string | null;
  contentType: string | null;
}

/** A refusal the server explained (403/404/409/413/501…). The code and message are the server's own. */
export interface RemoteAttachmentRefusal {
  refused: true;
  status: number;
  error: string;
  message: string;
}

function filenameFromDisposition(h: string | null): string | null {
  if (!h) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(h);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(h);
  return plain ? plain[1].trim() : null;
}

/** Largest attachment this client will accept: the server's own hard ceiling (25 MB). */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
/** One deadline for the WHOLE download, headers and body (review of #21: the
 *  request timer used to stop at the headers, so a stalled body hung forever). */
export const ATTACHMENT_TIMEOUT_MS = 60_000;
let attachmentTimeoutMs = ATTACHMENT_TIMEOUT_MS;
/** Test-only: shorten the download deadline (pass null to restore). */
export function __setAttachmentTimeoutForTests(ms: number | null): void {
  attachmentTimeoutMs = ms ?? ATTACHMENT_TIMEOUT_MS;
}

/** Read a body up to `max` bytes; throws ConnectedApiError("api") past the cap. */
async function readCapped(res: Response, max: number, path: string): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    throw new ConnectedApiError("api", `The attachment is larger than ${max} bytes (GET ${path}). Nothing was saved.`, res.status);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new ConnectedApiError("api", `The attachment is larger than ${max} bytes (GET ${path}). Nothing was saved.`, res.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * GET /api/v1/emails/{id}/attachments/{index} — one attachment's bytes, which
 * the RadMail server fetches from the mail provider for this request and does
 * not store. Every gate is the server's (attachments:read + mailbox-confined
 * key, sender allowlist, regime, size cap); a refusal comes back as a
 * RemoteAttachmentRefusal carrying the server's own reason, never as bytes.
 * 401 and network/timeout failures throw ConnectedApiError like every other read.
 */
export async function getAttachment(
  id: string,
  index: number,
  cfg: ConnectedConfig,
): Promise<RemoteAttachment | RemoteAttachmentRefusal> {
  const path = `/api/v1/emails/${encodeURIComponent(id)}/attachments/${index}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), attachmentTimeoutMs);
  const timeoutError = () =>
    new ConnectedApiError("timeout", `The attachment did not arrive within ${attachmentTimeoutMs / 1000}s (GET ${path}). Nothing was saved.`);
  try {
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.apiUrl}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: ctrl.signal,
    });
  } catch (e) {
    if (isAbortError(e)) throw timeoutError();
    const detail = e instanceof Error ? e.message : String(e);
    throw new ConnectedApiError("network", `Could not reach the RadMail API at ${cfg.apiUrl} (${detail}). Nothing was fetched.`);
  }
  if (res.status === 401) {
    throw new ConnectedApiError(
      "auth",
      `RadMail API key rejected (401): the key is invalid, revoked, or mistyped. Manage keys at ${API_KEYS_URL}. Nothing was fetched.`,
      401,
    );
  }
  if (!res.ok) {
    let error = `http_${res.status}`;
    let message = `RadMail API refused the attachment (HTTP ${res.status}).`;
    try {
      const body = (await res.json()) as Record<string, unknown>;
      if (typeof body.error === "string") error = body.error;
      if (typeof body.message === "string") message = body.message;
    } catch {
      /* a non-JSON refusal keeps the generic message */
    }
    return { refused: true, status: res.status, error, message };
  }
  let bytes: Buffer;
  try {
    bytes = await readCapped(res, ATTACHMENT_MAX_BYTES, path);
  } catch (e) {
    if (isAbortError(e)) throw timeoutError();
    throw e;
  }
  return {
    bytes,
    filename: filenameFromDisposition(res.headers.get("content-disposition")),
    contentType: res.headers.get("content-type"),
  };
  } finally {
    clearTimeout(timer);
  }
}

/** Shared pagination params for the list endpoints. */
export interface RemotePageParams {
  limit?: number;
  offset?: number;
}

/** One item from GET /api/v1/right-now — the user's REAL "can't-miss" lane.
 *  Fields are UNTRUSTED real-inbox content until tainted at the tool boundary. */
export interface RemoteRightNowItem {
  id?: string;
  receivedAt?: string;
  from?: string;
  fromName?: string | null;
  subject?: string | null;
  classification?: string | null;
  classificationSource?: string | null;
  isSpam?: boolean;
  needsOwnerEyes?: boolean;
  counterparty?: string | null;
  threadId?: string | null;
  importance?: number;
  urgency?: number;
  band?: string;
  reasons?: string[];
}

/** GET /api/v1/right-now — the ranked Right Now lane of the user's real inbox. */
export async function getRightNow(
  p: RemotePageParams,
  cfg: ConnectedConfig,
): Promise<{ items: RemoteRightNowItem[]; pagination: RemotePagination | null }> {
  const body = await apiGet("/api/v1/right-now", { limit: p.limit, offset: p.offset }, cfg);
  return {
    items: Array.isArray(body.data) ? (body.data as RemoteRightNowItem[]) : [],
    pagination: (body.pagination as RemotePagination | undefined) ?? null,
  };
}

/** One commitment from GET /api/v1/commitments. party / action / duePhrase are
 *  UNTRUSTED real-mail-derived text until tainted at the tool boundary. */
export interface RemoteCommitment {
  id?: string;
  direction?: "owed_by_us" | "owed_to_us" | string;
  party?: string | null;
  action?: string | null;
  actionType?: string | null;
  dueDate?: string | null;
  duePhrase?: string | null;
  state?: string | null;
  confidence?: number | null;
  counterpartyEmail?: string | null;
}

/** GET /api/v1/commitments — the user's real open promises (both directions). */
export async function getCommitments(
  p: RemotePageParams,
  cfg: ConnectedConfig,
): Promise<{ items: RemoteCommitment[]; pagination: RemotePagination | null }> {
  const body = await apiGet("/api/v1/commitments", { limit: p.limit, offset: p.offset }, cfg);
  return {
    items: Array.isArray(body.data) ? (body.data as RemoteCommitment[]) : [],
    pagination: (body.pagination as RemotePagination | undefined) ?? null,
  };
}
