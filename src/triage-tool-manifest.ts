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
      "sha256": "1172d72d3a08ac22cc86ee6fe77142619b7cd204be7323f4ee5a1eb758114ed1"
    },
    {
      "name": "archive_email",
      "sha256": "a1c70261d4d33286021a0aa6e640f9b5d3063f22a9a92ee1e0583825d6a7df18"
    },
    {
      "name": "label_email",
      "sha256": "bd98132bd10fa1a70149283275cac7b2497e55b12ac9f009dc677d3af4d01b93"
    },
    {
      "name": "mark_read",
      "sha256": "c54b56fb99a8eb765edbd0dbb822341d9c5f1f36d212e54cfc6c05c9f96b71c8"
    },
    {
      "name": "snooze_email",
      "sha256": "fddb1c0bef5fb940464d9a7e4ec78b0653dfed394d8d4d7637618b5b7eb15efc"
    }
  ],
  "manifestSha256": "69fe1ba0e098a407be44d0d2b9d4ab72113c3dbf1e687147118654c03ff319f4"
};
