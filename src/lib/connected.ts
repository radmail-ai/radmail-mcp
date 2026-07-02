// Connected-mode client — the READ-ONLY bridge to the user's REAL RadMail inbox
// (the app.radmail.ai v1 REST API, Bearer `tmk_...` API key).
//
// Presence of RADMAIL_API_KEY switches `search` (when `messages` is omitted) and
// `read_email` from the in-memory sandbox to the live inbox. Deliberately tiny:
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
