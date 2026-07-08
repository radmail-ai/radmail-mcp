/**
 * Zod input/output schemas for every tool. Kept in one file so the shapes are
 * auditable in one place. These are raw shapes (Record<string, ZodType>) as
 * required by McpServer.registerTool's inputSchema/outputSchema.
 */

import { z } from "zod";

/** Shared verbosity / focus surface hints — feed the self-learning layer. */
const surfaceHints = {
  agentId: z
    .string()
    .max(80)
    .optional()
    .describe("Stable id for YOUR agent (no PII). Lets RadMail adapt its surface to how you work."),
  verbosity: z
    .enum(["terse", "normal", "rich"])
    .optional()
    .describe("How much detail you want back. RadMail learns your preference and defaults to it."),
  focus: z
    .string()
    .max(60)
    .optional()
    .describe("What you're optimizing for right now (e.g. 'overdue', 'vips', 'fast-triage')."),
};

const messageShape = {
  id: z.string().optional(),
  from: z.string().describe("Sender address or name."),
  to: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().describe("The message body to reason over."),
  receivedAt: z.string().optional().describe("ISO timestamp; defaults to now."),
  knownSender: z.boolean().optional().describe("Has this sender written before? Unknown => first-contact hard-stop."),
  hasReply: z.boolean().optional().describe("Is there already a reply in this thread? (reply-correlation)"),
};

// ---- provision_sandbox ----
export const provisionInput = {
  label: z.string().max(24).optional().describe("Optional human label for the tenant."),
};
export const provisionOutput = {
  token: z.string(),
  tenantId: z.string(),
  mode: z.string(),
  ephemeral: z.boolean(),
  note: z.string(),
};

// ---- triage ----
export const triageInput = {
  token: z.string().optional().describe("Tenant token. OMIT IT and RadMail auto-provisions a free sandbox tenant — zero to triage in one call."),
  ...surfaceHints,
  ...messageShape,
};

// ---- draft_followup ----
export const draftInput = {
  token: z.string().optional(),
  ...surfaceHints,
  ...messageShape,
};

// ---- right_now ----
export const rightNowInput = {
  token: z.string().optional(),
  ...surfaceHints,
  limit: z.number().int().min(1).max(50).optional().describe("Max items in the lane (default 5)."),
  messages: z.array(z.object(messageShape)).describe("The candidate messages to rank into the Right Now lane."),
};

// ---- search ----
// Find a specific message in a batch by sender / subject / content — newest +
// most-relevant first, one result per conversation (ports the local radmail-find
// retrieval). For "where's the thread about X" instead of "rank everything".
export const searchInput = {
  token: z.string().optional().describe("Tenant token. OMIT to auto-provision a free sandbox tenant."),
  ...surfaceHints,
  query: z.string().min(1).max(200).describe("What to find — sender, subject, or content terms (all must match)."),
  limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)."),
  messages: z.array(z.object(messageShape)).describe("The messages to search over."),
};

// ---- inbox_pulse ----
// One round-trip over a batch: the Right Now lane + every open commitment + every
// hard-stop, so an agent gets RadMail's whole wedge on call #1 instead of looping
// triage -> right_now -> draft_followup. The same engine primitives, batched.
export const pulseInput = {
  token: z.string().optional().describe("Tenant token. OMIT IT and RadMail auto-provisions a free sandbox tenant — zero to a full inbox pulse in one call."),
  ...surfaceHints,
  limit: z.number().int().min(1).max(50).optional().describe("Max items in the Right Now lane (default 5)."),
  messages: z.array(z.object(messageShape)).describe("The messages to pulse: ranked lane + open commitments + hard-stops in one pass."),
};

// ---- report_need ----
export const reportNeedInput = {
  agentId: surfaceHints.agentId,
  note: z.string().max(400).describe("What was awkward, missing, or slow. RadMail learns from it."),
};

// ---- request_capability ----
export const requestCapabilityInput = {
  agentId: surfaceHints.agentId,
  capability: z.string().max(200).describe("A capability you wish RadMail exposed. Aggregated into demand that shapes the roadmap + surface."),
};

// ---- radmail_learning_insights ----
export const insightsInput = {
  agentId: z
    .string()
    .max(80)
    .optional()
    .describe("Your stable agent handle. Omit to use the header/tenant-derived id."),
  includeBacklog: z
    .boolean()
    .optional()
    .describe("Also include the cross-agent product backlog (most-requested capabilities)."),
};

export type { z };
