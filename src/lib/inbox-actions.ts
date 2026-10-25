// Inbox-actions client — the opt-in tools that change a message's INBOX STATE
// (archive / unarchive, snooze / unsnooze, read / unread, add / remove a label)
// through RadMail's v1 actions API, with a SEPARATE, triage-scoped key.
//
//   POST /api/v1/emails/{id}/actions   { action, until?, label?, on? }
//   POST /api/v1/emails/actions        { items: [{ id, action, until?, label?, on? }] }   (≤ 50)
//
// ── WHAT DECIDES WHETHER ANYTHING CHANGES ───────────────────────────────────
// RadMail, not this file. The server checks the `triage` scope (never granted
// by default), mailbox confinement, the minting member's mailbox grant, and
// whether the feature is switched on (404 inbox_actions_api_disabled until it
// is). It audits every change under the member AND the key. This client only
// reports what the server said.
//
// ── WHAT THIS FILE MUST NEVER DO ────────────────────────────────────────────
// 🛑 Trash or delete. The action vocabulary below is CLOSED and has no such
//    verb; the server refuses one anyway (400 unknown_action). A test reads
//    this file and every URL and body it sends to keep it that way.
// 🛑 Send. The only paths it builds are the two actions routes.
// 🛑 Pass the server's response through. Fields are copied by NAME.
// 🛑 Log or echo the key. It is deliberately NOT RADMAIL_API_KEY (the read key)
//    and NOT RADMAIL_SEND_API_KEY.

export const DEFAULT_API_URL = "https://app.radmail.ai";
const TIMEOUT_MS = 20_000;

/** The CLOSED action vocabulary. No trash, no untrash, no delete — ever. */
export const INBOX_ACTIONS = ["archive", "unarchive", "snooze", "unsnooze", "mark_read", "mark_unread", "label"] as const;
export type InboxAction = (typeof INBOX_ACTIONS)[number];

/** Most items in one batch — the server's own cap. */
export const BATCH_MAX = 50;

/** The two paths this client ever requests. */
export function singleActionPath(id: string): string {
  return `/api/v1/emails/${encodeURIComponent(id)}/actions`;
}
export const BATCH_ACTION_PATH = "/api/v1/emails/actions";

/** What an agent sees when the workspace has not switched the feature on. */
export const NOT_ENABLED_MESSAGE = "inbox actions are not enabled on this RadMail workspace yet";

export interface TriageConfig {
  apiKey: string;
  apiUrl: string;
}

/** Has the operator asked for the action tools? Exactly "1", like RADMAIL_SEND_TOOL. */
export function triageToolsRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RADMAIL_TRIAGE_TOOLS?.trim() === "1";
}

/** The triage-scoped key, or null. Deliberately NOT RADMAIL_API_KEY (the read key). */
export function getTriageConfig(env: NodeJS.ProcessEnv = process.env): TriageConfig | null {
  const apiKey = env.RADMAIL_TRIAGE_API_KEY?.trim();
  if (!apiKey) return null;
  const apiUrl = (env.RADMAIL_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
  return { apiKey, apiUrl };
}

/**
 * The action tools are REGISTERED only when BOTH are present: the explicit
 * opt-in flag and a separate triage key. Stricter than send_email (which is
 * listed on the flag alone and refuses without its key): a tool that changes a
 * mailbox should not appear on a server that cannot run it.
 */
export function triageToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return triageToolsRequested(env) && getTriageConfig(env) !== null;
}

export interface ActionItem {
  id: string;
  action: InboxAction;
  until?: string;
  label?: string;
  on?: boolean;
}

/** One action's outcome, as the server reported it. Copied by name. */
export interface ActionResult {
  id: string | null;
  ok: boolean;
  status: number | null;
  action: string | null;
  changed: boolean | null;
  /** The state after the action, where the server reports it. */
  archived?: boolean;
  snoozedUntil?: string | null;
  unread?: boolean;
  label?: string;
  on?: boolean;
  /** Whether the provider (Gmail / Outlook) copy changed too, when write-back is on. */
  mailbox?: unknown;
  error?: string;
  detail?: string;
}

export type SingleOutcome =
  | { outcome: "done"; result: ActionResult }
  | { outcome: "not_enabled"; httpStatus: number; error: string; message: string }
  | { outcome: "refused"; httpStatus: number | null; error: string; detail: string };

export type BatchOutcome =
  | {
      outcome: "done";
      results: ActionResult[];
      summary: { total: number | null; succeeded: number | null; failed: number | null; changed: number | null };
    }
  | { outcome: "not_enabled"; httpStatus: number; error: string; message: string }
  | { outcome: "refused"; httpStatus: number | null; error: string; detail: string };

// ─── fetch seam (tests swap this; production uses global fetch) ─────────────
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init);

/** Test-only: inject a mock fetch (pass null to restore global fetch). */
export function __setActionsFetchForTests(f: FetchLike | null): void {
  fetchImpl = f ?? ((url, init) => globalThis.fetch(url, init));
}

const SERVER_CODE_RE = /^[a-z][a-z0-9_:.-]{0,79}$/;
const str = (v: unknown, max = 300): string | null =>
  typeof v === "string" && v.length > 0 ? v.replace(/\s+/g, " ").trim().slice(0, max) : null;
const code = (v: unknown): string | null => (typeof v === "string" && SERVER_CODE_RE.test(v) ? v : null);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The mailbox write-back outcome: a small object of the server's own words. Copied shallowly. */
function mailboxOf(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) return str(v, 120) ?? undefined;
  const out: Record<string, string | boolean | number | null> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 8)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k)) continue;
    if (typeof val === "string") out[k] = val.slice(0, 200);
    else if (typeof val === "boolean" || typeof val === "number" || val === null) out[k] = val;
  }
  return out;
}

/** Map one result body (single route's 200, or one batch row) by NAME. PURE. */
export function mapActionResult(b: Record<string, unknown>, status: number | null, fallbackId: string | null): ActionResult {
  const r: ActionResult = {
    id: str(b.emailId, 100) ?? str(b.id, 100) ?? fallbackId,
    ok: b.ok === true,
    status: num(b.status) ?? status,
    action: code(b.action),
    changed: typeof b.changed === "boolean" ? b.changed : null,
  };
  const archived = bool(b.archived);
  if (archived !== undefined) r.archived = archived;
  if ("snoozedUntil" in b) r.snoozedUntil = str(b.snoozedUntil, 40);
  const unread = bool(b.unread);
  if (unread !== undefined) r.unread = unread;
  if (typeof b.label === "string") r.label = b.label.slice(0, 200);
  const on = bool(b.on);
  if (on !== undefined) r.on = on;
  const mailbox = mailboxOf(b.mailbox);
  if (mailbox !== undefined) r.mailbox = mailbox;
  const err = code(b.error);
  if (err) r.error = err;
  const detail = str(b.detail);
  if (detail) r.detail = detail;
  return r;
}

/** Plain-language refusals for the statuses an operator can fix. */
function refusalDetail(status: number, error: string, rawDetail: string | null): string {
  const detail = rawDetail ? rawDetail.replace(/[.\s]+$/, "") : null;
  if (status === 401) {
    return "RadMail rejected RADMAIL_TRIAGE_API_KEY (missing, malformed, or revoked). Nothing was changed.";
  }
  if (status === 403 && error.startsWith("missing_scope")) {
    return "RADMAIL_TRIAGE_API_KEY does not carry the `triage` scope. Mint a key with the triage scope in RadMail settings. Nothing was changed.";
  }
  if (status === 403 && error === "forbidden") {
    return "The member who minted this key may see that mailbox but may not triage it. Nothing was changed.";
  }
  if (status === 404 && error === "not_found") {
    return "No email with that id is visible to this key (unknown, another workspace's, or outside the key's mailboxes). Nothing was changed.";
  }
  if (status === 503) {
    return `${detail ?? "RadMail could not check mailbox access just now"}. Nothing was changed; retrying is safe because every action is idempotent.`;
  }
  return `${detail ?? `RadMail refused the action (${status} ${error})`}. Nothing was changed.`;
}

/**
 * A 404 that is NOT about the email: the feature (or one of its parts) is
 * switched off on this workspace, or the deployment predates the route (a
 * non-JSON 404). Only `not_found` is about the email itself.
 */
function notEnabled(status: number, error: string): { outcome: "not_enabled"; httpStatus: number; error: string; message: string } | null {
  if (status !== 404 || error === "not_found") return null;
  const message =
    error === "read_state_disabled"
      ? "marking mail read or unread is not enabled on this RadMail workspace yet"
      : error === "labels_disabled"
        ? "labels are not enabled on this RadMail workspace yet"
        : NOT_ENABLED_MESSAGE;
  return { outcome: "not_enabled", httpStatus: status, error, message };
}

async function post(path: string, payload: unknown, cfg: TriageConfig): Promise<{ status: number; body: Record<string, unknown> | null } | { failed: string; detail: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.apiUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "AbortError";
    return timedOut
      ? {
          failed: "outcome_unknown_timeout",
          detail:
            `RadMail did not answer within ${TIMEOUT_MS / 1000}s, so this server cannot tell whether the change was made. ` +
            "Retrying is safe: every inbox action is idempotent, so a repeat reports changed:false if the first one landed.",
        }
      : { failed: "network_error", detail: `Could not reach RadMail at ${cfg.apiUrl}. Nothing is known to have changed.` };
  } finally {
    clearTimeout(timer);
  }
  let body: Record<string, unknown> | null = null;
  try {
    const text = (await res.text()).slice(0, 256 * 1024);
    const parsed: unknown = JSON.parse(text);
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** Wire body for one item. Only the fields the action uses are sent. */
function wireItem(item: ActionItem, withId: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = withId ? { id: item.id, action: item.action } : { action: item.action };
  if (item.action === "snooze" && item.until !== undefined) out.until = item.until;
  if (item.action === "label") {
    if (item.label !== undefined) out.label = item.label;
    if (item.on !== undefined) out.on = item.on;
  }
  return out;
}

/** POST one action. Never throws; never retries. */
export async function submitAction(item: ActionItem, cfg: TriageConfig): Promise<SingleOutcome> {
  const r = await post(singleActionPath(item.id), wireItem(item, false), cfg);
  if ("failed" in r) return { outcome: "refused", httpStatus: null, error: r.failed, detail: r.detail };
  const b = r.body ?? {};
  const error = code(b.error) ?? `http_${r.status}`;
  const off = notEnabled(r.status, r.body ? error : "route_missing");
  if (off) return off;
  if (r.status === 200 && b.ok === true) return { outcome: "done", result: mapActionResult(b, 200, item.id) };
  return { outcome: "refused", httpStatus: r.status, error, detail: refusalDetail(r.status, error, str(b.detail)) };
}

/** POST a batch (1–50 items). Never throws; never retries. Per-item results are the server's. */
export async function submitBatch(items: ActionItem[], cfg: TriageConfig): Promise<BatchOutcome> {
  const r = await post(BATCH_ACTION_PATH, { items: items.map((i) => wireItem(i, true)) }, cfg);
  if ("failed" in r) return { outcome: "refused", httpStatus: null, error: r.failed, detail: r.detail };
  const b = r.body ?? {};
  const error = code(b.error) ?? `http_${r.status}`;
  const off = notEnabled(r.status, r.body ? error : "route_missing");
  if (off) return off;
  if (r.status === 200 && Array.isArray(b.results)) {
    const rows = (b.results as unknown[]).slice(0, BATCH_MAX);
    const results = rows.map((row, i) =>
      row && typeof row === "object" ? mapActionResult(row as Record<string, unknown>, null, items[i]?.id ?? null) : mapActionResult({}, null, items[i]?.id ?? null),
    );
    const s = (b.summary ?? {}) as Record<string, unknown>;
    return {
      outcome: "done",
      results,
      summary: { total: num(s.total), succeeded: num(s.succeeded), failed: num(s.failed), changed: num(s.changed) },
    };
  }
  return { outcome: "refused", httpStatus: r.status, error, detail: refusalDetail(r.status, error, str(b.detail)) };
}
