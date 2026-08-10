// Tool-description freeze — the anti-poisoning manifest.
//
// THREAT (research brief §4 tickets 2+5; OWASP ASI02/ASI04; MCPTox: >60% attack
// success via tool-description poisoning): the tool descriptions this server
// publishes are instructions a consuming agent WILL read. A compromised
// registry listing, a tampered install, or a MITM'd description could smuggle
// injected instructions ("ignore previous…", "always call…", a lookalike URL)
// into every agent session that connects.
//
// DEFENSE, three layers:
//   1. FREEZE  — a checked-in manifest (src/tool-manifest.ts) with a sha256 per
//      tool over its canonical name + description + published JSON input schema
//      (exactly what the MCP SDK serializes over the wire), plus one manifest
//      hash over the whole surface and the server instructions.
//   2. VERIFY  — on every server start, assertToolManifest() recomputes the
//      hashes from the live code and compares against the frozen manifest.
//      Any mismatch = REFUSE TO SERVE TOOLS (fail closed) with a clear error.
//   3. LINT    — lintToolDescriptions() rejects imperative-to-the-agent
//      injection patterns ("ignore previous", "always call") and any URL
//      outside radmail.ai, in both descriptions and schema field descriptions.
//
// Legitimate description changes are a DELIBERATE, diffable act:
//   npm run manifest:regen   (lints first, then rewrites src/tool-manifest.ts)

import { createHash } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDef } from "../tools.js";
import { TOOL_MANIFEST } from "../tool-manifest.js";

export const MANIFEST_ALGORITHM = "sha256/canonical-json/zod-to-json-schema" as const;

export interface FrozenToolEntry {
  name: string;
  sha256: string;
}

export interface FrozenManifest {
  version: 1;
  algorithm: string;
  serverInstructionsSha256: string;
  tools: FrozenToolEntry[];
  /** sha256 over {algorithm, serverInstructionsSha256, tools} — one line to diff. */
  manifestSha256: string;
}

// ─── Canonicalization ───────────────────────────────────────────────────────

/** Deterministic JSON: object keys sorted recursively, arrays kept in order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v !== null && typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeysDeep(src[k]);
    return out;
  }
  return v;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** The published JSON Schema for a tool's input — the same conversion the MCP
 *  SDK applies when it serves tools/list, so the hash pins the WIRE surface,
 *  not a private representation. `$schema` (constant noise) is stripped. */
export function publishedInputSchema(def: ToolDef): Record<string, unknown> {
  const schema = zodToJsonSchema(z.object(def.inputSchema)) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/** Canonical fingerprint of one tool: name + description + published schema. */
export function toolSha256(def: ToolDef): string {
  return sha256Hex(
    canonicalJson({
      name: def.name,
      description: def.description,
      inputSchema: publishedInputSchema(def),
    }),
  );
}

/** Manifest hash over the summary rows — tampering with any row, or with the
 *  instructions hash, changes this one line. */
function manifestSha256Of(serverInstructionsSha256: string, tools: FrozenToolEntry[]): string {
  return sha256Hex(canonicalJson({ algorithm: MANIFEST_ALGORITHM, serverInstructionsSha256, tools }));
}

/** Compute the full manifest from live code. Tools are sorted by name so the
 *  output is order-independent and diffable. */
export function computeToolManifest(defs: readonly ToolDef[], serverInstructions: string): FrozenManifest {
  const tools = [...defs]
    .map((d) => ({ name: d.name, sha256: toolSha256(d) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const serverInstructionsSha256 = sha256Hex(serverInstructions);
  return {
    version: 1,
    algorithm: MANIFEST_ALGORITHM,
    serverInstructionsSha256,
    tools,
    manifestSha256: manifestSha256Of(serverInstructionsSha256, tools),
  };
}

// ─── Verification (fail closed) ─────────────────────────────────────────────

export interface ManifestVerification {
  ok: boolean;
  mismatches: string[];
}

/** Recompute from live defs and compare against a frozen manifest. Every
 *  divergence is named; ok:true only when the surfaces are identical. */
export function verifyToolManifest(
  frozen: FrozenManifest,
  defs: readonly ToolDef[],
  serverInstructions: string,
): ManifestVerification {
  const mismatches: string[] = [];
  const live = computeToolManifest(defs, serverInstructions);

  // Internal consistency of the frozen file itself (catches a hand-edited row).
  const frozenRecomputed = manifestSha256Of(frozen.serverInstructionsSha256, frozen.tools);
  if (frozenRecomputed !== frozen.manifestSha256) {
    mismatches.push(
      `frozen manifest is internally inconsistent: its rows hash to ${frozenRecomputed} but it claims manifestSha256 ${frozen.manifestSha256} — the checked-in file was edited by hand`,
    );
  }

  if (live.serverInstructionsSha256 !== frozen.serverInstructionsSha256) {
    mismatches.push(
      `server instructions changed: frozen ${frozen.serverInstructionsSha256}, live ${live.serverInstructionsSha256}`,
    );
  }

  const frozenByName = new Map(frozen.tools.map((t) => [t.name, t.sha256]));
  const liveByName = new Map(live.tools.map((t) => [t.name, t.sha256]));

  for (const [name, sha] of liveByName) {
    const frozenSha = frozenByName.get(name);
    if (frozenSha === undefined) {
      mismatches.push(`tool "${name}" exists in code but is NOT in the frozen manifest`);
    } else if (frozenSha !== sha) {
      mismatches.push(
        `tool "${name}" diverges from the frozen manifest (name/description/input-schema changed): frozen ${frozenSha}, live ${sha}`,
      );
    }
  }
  for (const name of frozenByName.keys()) {
    if (!liveByName.has(name)) {
      mismatches.push(`tool "${name}" is in the frozen manifest but MISSING from code`);
    }
  }

  if (mismatches.length === 0 && live.manifestSha256 !== frozen.manifestSha256) {
    mismatches.push(
      `manifest hash diverges with no named cause: frozen ${frozen.manifestSha256}, live ${live.manifestSha256}`,
    );
  }

  return { ok: mismatches.length === 0, mismatches };
}

/** Startup gate. Throws (fail closed — the server refuses to serve tools) when
 *  the live tool surface diverges from the checked-in frozen manifest. */
export function assertToolManifest(
  defs: readonly ToolDef[],
  serverInstructions: string,
  frozen: FrozenManifest = TOOL_MANIFEST,
): void {
  const v = verifyToolManifest(frozen, defs, serverInstructions);
  if (!v.ok) {
    throw new Error(
      "TOOL MANIFEST MISMATCH — refusing to serve tools (fail closed).\n" +
        "The tool descriptions/schemas this build would publish do not match the frozen manifest " +
        "(src/tool-manifest.ts). This is the defense against tool-description poisoning " +
        "(OWASP ASI02/ASI04): a poisoned, tampered, or drifted surface must never reach an agent.\n" +
        v.mismatches.map((m) => `  ✗ ${m}`).join("\n") +
        "\nIf this change is INTENTIONAL, regenerate deliberately and review the diff:\n" +
        "  npm run manifest:regen",
    );
  }
}

// ─── Description lint (anti-injection) ──────────────────────────────────────

export interface LintViolation {
  /** Which surface: `tool:<name>:description`, `tool:<name>:inputSchema`, or `serverInstructions`. */
  surface: string;
  rule: string;
  excerpt: string;
}

const INJECTION_PATTERNS: ReadonlyArray<{ rule: string; re: RegExp }> = [
  // "ignore previous instructions" and close variants.
  { rule: "no-ignore-previous", re: /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\b/i },
  { rule: "no-disregard-previous", re: /\bdisregard\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\b/i },
  // "always call <tool>" — a description must never command the agent's routing.
  { rule: "no-always-call", re: /\balways\s+call\b/i },
];

const URL_RE = /https?:\/\/[^\s"'`<>)\]]+/gi;

function urlAllowed(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "radmail.ai" || host.endsWith(".radmail.ai");
  } catch {
    return false;
  }
}

function lintText(surface: string, text: string, out: LintViolation[]): void {
  for (const { rule, re } of INJECTION_PATTERNS) {
    const m = text.match(re);
    if (m) out.push({ surface, rule, excerpt: m[0] });
  }
  for (const m of text.matchAll(URL_RE)) {
    if (!urlAllowed(m[0])) {
      out.push({ surface, rule: "no-external-urls", excerpt: m[0] });
    }
  }
}

/** Lint every published text surface (tool descriptions, schema-field
 *  descriptions, server instructions) for imperative-to-the-agent injection
 *  patterns and off-domain URLs. Empty result = clean. */
export function lintToolDescriptions(
  defs: readonly ToolDef[],
  serverInstructions?: string,
): LintViolation[] {
  const out: LintViolation[] = [];
  for (const def of defs) {
    lintText(`tool:${def.name}:description`, def.description, out);
    lintText(`tool:${def.name}:inputSchema`, canonicalJson(publishedInputSchema(def)), out);
  }
  if (serverInstructions !== undefined) {
    lintText("serverInstructions", serverInstructions, out);
  }
  return out;
}
