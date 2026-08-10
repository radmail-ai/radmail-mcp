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
  "serverInstructionsSha256": "4c0e11714b87889452d36e57ab0e830ae57ea2f2c9d30c5fad83ca1eb554b2ef",
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
      "name": "list_commitments",
      "sha256": "92cf179fcbdbed57bdd9b6ba9936989c8669937021372c94092b5ea6889d61b7"
    },
    {
      "name": "list_right_now",
      "sha256": "d86a4da16f14c766458c71bdea9891deabb700b0c2e7e877f52bb17234c4f9f8"
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
      "sha256": "425aa3f0d0b4abd629166eb5569650dca27a1075e653316c4814111216755dc4"
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
      "sha256": "53a7044376c02d57b7e792299b99fcf155fe858e64c1fcfe95f518dc4939950f"
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
  "manifestSha256": "50341c3b74d06ee69f2d6a03c0c589eb5c7355cbdde67603b156e7a0a45f3c2e"
};
