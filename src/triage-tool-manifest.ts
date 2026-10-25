// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Frozen manifest of the OPT-IN inbox-action tools (archive_email,
// snooze_email, mark_read, label_email, act_on_emails) and the instructions
// addendum a triage-enabled server appends. Verified by
// createServer({ enableTriage: true }) before the tools are registered; a
// mismatch refuses to serve. Regenerate with
//   npm run manifest:regen   — then review + commit this file.

import type { FrozenManifest } from "./lib/manifest.js";

export const TRIAGE_TOOL_MANIFEST: FrozenManifest = {
  "version": 1,
  "algorithm": "sha256/canonical-json/zod-to-json-schema",
  "converterVersion": "3.25.2",
  "serverInstructionsSha256": "83ac2af99d8c516450542f6a60c4f7e5f90b90c500c3c749c3d72cf3d5939673",
  "tools": [
    {
      "name": "act_on_emails",
      "sha256": "1c28341cbb02c4c5a24d5c72afec11116728209f630bd7860b9279c521a17e31"
    },
    {
      "name": "archive_email",
      "sha256": "c311d25c8778becdf5d5f47d1c8c763409cf10de2d2d4b4da7132d2cf75e36f9"
    },
    {
      "name": "label_email",
      "sha256": "f71bbb3886337d64be594007511acf003d41c86eb93c14ca38e8fe7daf36da1f"
    },
    {
      "name": "mark_read",
      "sha256": "d3579da5e23820ca7fa86544aefd5b17a0ad135ea95d0dc7e9637b4ccfe11aad"
    },
    {
      "name": "snooze_email",
      "sha256": "650192345f39eb594cac720e57d39e4cfeba107767b790b142edd93c291d5b65"
    }
  ],
  "manifestSha256": "a5a83c83d926e96def62c3b3d218160a41dfa4343aac3bfbae3936844b26c49b"
};
