// Connected-mode client — the READ-ONLY bridge to the user's REAL RadMail inbox
// (the app.radmail.ai v1 REST API, Bearer `tmk_...` API key).
//
// A key switches the connected read tools from the in-memory sandbox to the
// live inbox: `search` / `list_right_now` / `list_commitments` (when `messages`
// is omitted), and `read_email`, `read_thread`, `list_emails`,
// `list_prepared_drafts`, `list_watched_threads`, `get_attachment`. The key
// comes from RADMAIL_API_KEY on a local server, or from the request's own
// `Authorization: Bearer` header on the hosted endpoint (api/mcp.ts) — never
// from a process-wide variable there. Deliberately tiny:
//
//   · global fetch, 10s timeout, at most ONE retry (plain network errors only —
//     never on a timeout, never on an HTTP status)
//   · the API key is NEVER logged, echoed, or included in any response/error
//   · fail-closed: any auth / entitlement / timeout / parse problem surfaces as
//     a typed ConnectedApiError — results are never fabricated
//   · READ-ONLY by construction: this client only issues GETs. The opt-in
//     inbox-action tools use their OWN client (src/lib/inbox-actions.ts) with a
//     separate triage-scoped key, so nothing here can change mail, and the BEC
//     hard-stop contract (money / changed-banking / first-contact / decision /
//     injection = human-only forever) is preserved exactly as in the sandbox.
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
  // The server's own error code (e.g. not_found, invalid_cursor), when it sent one.
  readonly code: string | null;
  constructor(kind: ConnectedErrorKind, message: string, status: number | null = null, code: string | null = null) {
    super(message);
    this.name = "ConnectedApiError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

/** A server error code is a short machine token. Anything else is not repeated. */
const SERVER_CODE_RE = /^[a-z][a-z0-9_:.-]{0,79}$/;
/** Server-written refusal detail, capped: it is the server's prose, but never unbounded. */
const SERVER_DETAIL_MAX = 300;

/** Read `{ error, detail }` off a refusal body, defensively (never more than 64 KB, never throws). */
async function refusalOf(res: Response): Promise<{ code: string | null; detail: string | null }> {
  try {
    const text = (await res.text()).slice(0, 64 * 1024);
    const body = JSON.parse(text) as Record<string, unknown>;
    const code = typeof body.error === "string" && SERVER_CODE_RE.test(body.error) ? body.error : null;
    const rawDetail = typeof body.detail === "string" ? body.detail : typeof body.message === "string" ? body.message : null;
    const detail = rawDetail ? rawDetail.replace(/\s+/g, " ").trim().slice(0, SERVER_DETAIL_MAX) : null;
    return { code, detail };
  } catch {
    return { code: null, detail: null };
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
        `Check the key this server was given — RADMAIL_API_KEY on a local server, or the Authorization: Bearer header ` +
        `on the hosted endpoint (keys start with tmk_) — manage keys at ${API_KEYS_URL}. ` +
        "Fail-closed: no results.",
      401,
    );
  }
  if (res.status === 403) {
    const { code } = await refusalOf(res);
    const why =
      code === "mailbox_scope_not_supported_on_this_route"
        ? "this key is confined to named mailboxes, and RadMail does not serve this route to a confined key"
        : code && code.startsWith("missing_scope")
          ? `the key does not carry the scope this route needs (${code})`
          : "the key is valid but the account's plan or the key's scope does not allow this operation";
    throw new ConnectedApiError(
      "entitlement",
      `RadMail API key not entitled (403): ${why}. Review the plan/key at ${API_KEYS_URL}. Fail-closed: no results.`,
      403,
      code,
    );
  }
  if (!res.ok) {
    const { code, detail } = await refusalOf(res);
    throw new ConnectedApiError(
      "api",
      `RadMail API error (HTTP ${res.status}${code ? ` ${code}` : ""}) on GET ${path}` +
        (detail ? `: ${detail}` : "") +
        ". Fail-closed: no results fabricated. Retry, or contact security@radmail.ai if it persists.",
      res.status,
      code,
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
  /** RFC 5322 Message-ID (RadMail #896); absent on servers that predate it. */
  messageId?: string | null;
  attachmentCount?: number;
  attachments?: RemoteAttachments | null;
}

/** Attachment METADATA on a list/search/thread row — names, types, sizes; never bytes. */
export type RemoteAttachments =
  | { recorded: true; items?: Array<{ filename?: string | null; contentType?: string | null; sizeBytes?: number | null }>; omitted?: number }
  | { recorded: false; count?: number | null; reason?: string | null };

export interface RemotePagination {
  limit?: number;
  offset?: number;
  total?: number;
  hasMore?: boolean;
  /** GET /emails only: pass back as ?cursor= for the next page; null when there is none. */
  nextCursor?: string | null;
}

export interface RemoteSearchParams {
  query: string;
  limit?: number;
  offset?: number;
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
    { q: p.query, limit: p.limit, offset: p.offset, from: p.from, after: p.after, before: p.before },
    cfg,
  );
  return {
    hits: Array.isArray(body.data) ? (body.data as RemoteSearchHit[]) : [],
    pagination: (body.pagination as RemotePagination | undefined) ?? null,
  };
}

/** Full email detail from GET /api/v1/emails/{id} — includes textBody. */
export interface RemoteEmailDetail extends RemoteSearchHit {
  to?: string | null;
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
      // Capped: a refusal is a few hundred bytes; a huge "error" body must not fill memory.
      const raw = await readCapped(res, 64 * 1024, path);
      const body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
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
  /** RFC 5322 Message-ID — /right-now has always returned it. */
  messageId?: string | null;
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
  /** The email the commitment was found in (RadMail #896); null once that email is gone. */
  emailId?: string | null;
  /** Its conversation (RadMail #896); null when none was recorded. */
  threadId?: string | null;
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

// ─── v0.6.0 reads (RadMail #896 + the existing draft / watch routes) ─────────

/** GET /api/v1/emails — the newest-first list, metadata only, with since + keyset cursor. */
export interface RemoteListEmailsParams {
  limit?: number;
  offset?: number;
  since?: string;
  cursor?: string;
}

export async function listEmails(
  p: RemoteListEmailsParams,
  cfg: ConnectedConfig,
): Promise<{ emails: RemoteSearchHit[]; pagination: RemotePagination | null }> {
  const body = await apiGet(
    "/api/v1/emails",
    { limit: p.limit, offset: p.offset, since: p.since, cursor: p.cursor },
    cfg,
  );
  return {
    emails: Array.isArray(body.data) ? (body.data as RemoteSearchHit[]) : [],
    pagination: (body.pagination as RemotePagination | undefined) ?? null,
  };
}

/** One message inside GET /api/v1/threads/{id}. */
export interface RemoteThreadEmail extends RemoteSearchHit {
  to?: string | null;
  inReplyTo?: string | null;
}

export interface RemoteThread {
  id?: string;
  subject?: string | null;
  counterpartyEmail?: string | null;
  counterpartyDomain?: string | null;
  stats?: Record<string, unknown> | null;
  statsWithheld?: string;
}

export interface RemoteThreadRead {
  thread: RemoteThread | null;
  emails: RemoteThreadEmail[];
  coverage: Record<string, unknown> | null;
  pagination: RemotePagination | null;
  scope: Record<string, unknown> | null;
}

/** GET /api/v1/threads/{id} — one conversation, oldest first, metadata only. */
export async function getThread(
  id: string,
  p: RemotePageParams,
  cfg: ConnectedConfig,
): Promise<RemoteThreadRead> {
  const body = await apiGet(`/api/v1/threads/${encodeURIComponent(id)}`, { limit: p.limit, offset: p.offset }, cfg);
  const data = (body.data ?? {}) as Record<string, unknown>;
  return {
    thread: (data.thread as RemoteThread | undefined) ?? null,
    emails: Array.isArray(data.emails) ? (data.emails as RemoteThreadEmail[]) : [],
    coverage: (data.coverage as Record<string, unknown> | undefined) ?? null,
    pagination: (body.pagination as RemotePagination | undefined) ?? null,
    scope: (body.scope as Record<string, unknown> | undefined) ?? null,
  };
}

/** One of RadMail's own AI-prepared reply drafts. `body` is model text written FROM an email. */
export interface RemotePreparedDraft {
  id?: string;
  emailId?: string | null;
  style?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  createdAt?: string | null;
  body?: string | null;
  from?: string | null;
  subject?: string | null;
}

/** GET /api/v1/prepared-drafts — read-only; RadMail never sends these on its own. */
export async function listPreparedDrafts(
  p: RemotePageParams & { emailId?: string },
  cfg: ConnectedConfig,
): Promise<{ drafts: RemotePreparedDraft[]; pagination: RemotePagination | null }> {
  const body = await apiGet(
    "/api/v1/prepared-drafts",
    { emailId: p.emailId, limit: p.limit, offset: p.offset },
    cfg,
  );
  return {
    drafts: Array.isArray(body.data) ? (body.data as RemotePreparedDraft[]) : [],
    pagination: (body.pagination as RemotePagination | undefined) ?? null,
  };
}

/** One watched thread from the last-word tracker. */
export interface RemoteWatchedThread {
  threadId?: string;
  subject?: string | null;
  counterpartyEmail?: string | null;
  watchedAt?: string | null;
  followUpDays?: number | null;
  state?: string | null;
  lastSelfAt?: string | null;
  lastCounterpartyAt?: string | null;
  basis?: string | null;
  reasonCode?: string | null;
  computedAt?: string | null;
  stalled?: boolean | null;
  latestEmailId?: string | null;
}

/** GET /api/v1/watched-threads — note the envelope is { ok, items, total }, not { data }. */
export async function listWatchedThreads(
  cfg: ConnectedConfig,
): Promise<{ items: RemoteWatchedThread[]; total: number | null }> {
  const body = await apiGet("/api/v1/watched-threads", {}, cfg);
  return {
    items: Array.isArray(body.items) ? (body.items as RemoteWatchedThread[]) : [],
    total: typeof body.total === "number" ? body.total : null,
  };
}
