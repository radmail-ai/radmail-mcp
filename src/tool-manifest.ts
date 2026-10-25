// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Frozen manifest of the published MCP tool surface: one sha256 per tool over
// its canonical name + description + published JSON input schema, plus the
// server-instructions hash and one manifest hash over everything. On startup
// the server recomputes and compares (src/lib/manifest.ts) and REFUSES to
// serve tools on any mismatch — the fail-closed defense against
// tool-description poisoning (OWASP ASI02/ASI04; MCPTox).
//
// A legitimate change to any tool name/description/schema is a deliberate,
// diffable act:  npm run manifest:regen  — then review + commit this file.
// (No timestamp on purpose: an unchanged surface regenerates to a zero diff.)

import type { FrozenManifest } from "./lib/manifest.js";

export const TOOL_MANIFEST: FrozenManifest = {
  "version": 1,
  "algorithm": "sha256/canonical-json/zod-to-json-schema",
  "converterVersion": "3.25.2",
  "serverInstructionsSha256": "353cdaee49dae54f3c7dfdc84327e88386df7ba0bd540fedd57285463d065da7",
  "tools": [
    {
      "name": "check_send_domain",
      "sha256": "f7a5724c049431eb017ad12900a8402bfbfeb40bbe498c8a8510ad886725ab77"
    },
    {
      "name": "draft_reply",
      "sha256": "07837e983da31de748d6dd0b803b3ffa6440f461a4d71c4b3c76e056c6f0ecd1"
    },
    {
      "name": "get_attachment",
      "sha256": "d6d512dd0787e5dc78245051e8354c8d2434195902080dd3fc211551fa1c346f"
    },
    {
      "name": "list_commitments",
      "sha256": "2745cb8f5b40027d319a3b87b20d95dda898505c4f05c398c71d7b524f8fb9e4"
    },
    {
      "name": "list_emails",
      "sha256": "a36abd762e133678eb137a8b0ea2542490a5bb3a76b5d02f660c149270a075d3"
    },
    {
      "name": "list_prepared_drafts",
      "sha256": "a8f4e272d7504e98d1bd1a538660837cc3e2e9048e22067f3e7efee2e44504a9"
    },
    {
      "name": "list_right_now",
      "sha256": "136263d4c26e800e75408a76b95fb9848ec3b30ac1e9c0bce020310f914342c2"
    },
    {
      "name": "list_watched_threads",
      "sha256": "52a64b426b59068d9fd7da64797df7b748a081a44e5b1d12ef8120a9039e6a66"
    },
    {
      "name": "provision_sandbox",
      "sha256": "1a22f5c7d307da4b0f96eb3aeab2c3f02c787bf7f7f1421aaefc6967226aa1f3"
    },
    {
      "name": "radmail_learning_insights",
      "sha256": "d2097416f4feb7c437694a4165ef15fe089a78304cc1384e47da3a23ecc21feb"
    },
    {
      "name": "read_email",
      "sha256": "f90b6505ff14e91efa2cd8c71bb2de97d1f947583aea50a22d1b7509125cd121"
    },
    {
      "name": "read_thread",
      "sha256": "387365cf220311bfd9bfe2e8155da05b4c99907fc39fadd5bfc08d8818192bfd"
    },
    {
      "name": "report_need",
      "sha256": "64252a299d05184784e5a2bc36b0913f1cdb5911e1495bd791679171f2ca434b"
    },
    {
      "name": "request_capability",
      "sha256": "28aef5f158df68ddcb4dcd14564efc3166ec5a2a505ebb22eee1957b29a9c8b4"
    },
    {
      "name": "search",
      "sha256": "7d686bf5febade59c5101489da48a6c52d9eafd03c06c0e2f9d00f1d6845bc74"
    },
    {
      "name": "triage",
      "sha256": "891bbacf56b14142b1fc09c73fc573f4a8c16b1aa38000c044257b6e1fa5fa46"
    },
    {
      "name": "triage_inbox",
      "sha256": "af88ddfa82246590ef35dc9785bfaae6b75dcd43253eae403cdedd9deac963a0"
    },
    {
      "name": "why_surfaced",
      "sha256": "ab7388194979a2ff3f309b825e4e686e6be30efdfb118b7b297a65a7ca7eba2f"
    }
  ],
  "manifestSha256": "3bfbb49daf9d6cf00f9b65b8de5aa861311774c905c6b31df57f711946d92465"
};
