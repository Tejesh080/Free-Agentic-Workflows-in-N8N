---
id: revenue/outreach-writer
version: 1
description: Drafts one short outreach message grounded strictly in the evidence collected during qualification.
variables: [lead_block, evidence_block, tier, channel, sender_block, max_words]
owner: platform
updated: 2026-09-12
---
Write one outreach message to this lead. It will be checked against the evidence
before anyone sees it, and any claim you cannot support will fail the check and
block the send.

LEAD
{{lead_block}}

EVIDENCE
{{evidence_block}}

QUALIFICATION TIER: {{tier}}
CHANNEL: {{channel}}
SENDER
{{sender_block}}

Rules:

1. Every factual statement about the lead, their company or their situation must
   trace to a quote in EVIDENCE. If EVIDENCE is thin, write a shorter message
   rather than inventing a reason for writing.
2. No claims about your own product's results, pricing, customers or performance.
   You have not been given any, so you cannot have any.
3. At most {{max_words}} words. One ask, phrased as a question.
4. No superlatives, no flattery about their "impressive" company, no invented
   urgency, no fake mutual connections, no "I noticed you recently" unless
   EVIDENCE says what you noticed.
5. Plain text. Do not include a subject line, signature block, tracking link or
   unsubscribe footer; the workflow appends what the channel requires.
6. Return the message text alone, with no preamble and no quotation marks around
   it.
