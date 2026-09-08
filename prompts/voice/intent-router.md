---
id: voice/intent-router
version: 2
description: Classifies a voice transcript into a supported intent with slots.
variables: [transcript, supported_intents]
owner: platform
updated: 2026-09-08
---
Classify this voice transcript.

TRANSCRIPT
{{transcript}}

SUPPORTED INTENTS
{{supported_intents}}

Rules:

1. intent must be one of the supported intents, or "unsupported". Never invent
   an intent name.
2. Transcripts arrive from speech-to-text and will contain misrecognitions. If
   the transcript is too garbled to classify confidently, use "unsupported" with
   a low confidence rather than guessing.
3. Extract only slots the speaker actually said. Do not fill a slot from context
   or assumption.
4. Set needs_confirmation to true when the intent would change or send anything,
   when a required slot is missing, or when confidence is below 0.7.

Respond with raw JSON only:

{
  "intent": "check_status",
  "confidence": 0.0,
  "slots": {},
  "missing_slots": [],
  "needs_confirmation": false,
  "spoken_reply_hint": "one short sentence to say back to the speaker"
}
