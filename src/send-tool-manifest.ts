// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Frozen manifest of the OPT-IN send_email tool and the instructions addendum
// a send-enabled server appends. Verified by createServer({ enableSend: true })
// before the tool is registered; a mismatch refuses to serve. Regenerate with
//   npm run manifest:regen   — then review + commit this file.

import type { FrozenManifest } from "./lib/manifest.js";

export const SEND_TOOL_MANIFEST: FrozenManifest = {
  "version": 1,
  "algorithm": "sha256/canonical-json/zod-to-json-schema",
  "converterVersion": "3.25.2",
  "serverInstructionsSha256": "a57a7951f9d143bbc54f922f463806202453cac7b9d74509d00393e335aafd13",
  "tools": [
    {
      "name": "send_email",
      "sha256": "00fc22f6c5569c377806620c41e17251e7263c14b95c587746ecbe0762923b57"
    }
  ],
  "manifestSha256": "378067c17a42ba24d262a87262e97a2a6d11df2f443cc75e2904900f9a32c5c6"
};
