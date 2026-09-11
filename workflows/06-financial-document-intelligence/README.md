# 06 Financial Document Intelligence Agent

> Invoice extraction with arithmetic reconciliation, duplicate fingerprinting against a ledger, an explicit exception taxonomy, verification and escalation to Governance.

**Status:** LIVE VERIFIED · **25 nodes** (22 executable)

## The problem

Invoice extraction that only checks 'did the model return JSON' misses the failure that matters: a well-formed record whose numbers do not add up.

## How it works

1. Extract fields with the `finance/invoice-extractor` prompt through the Model Router, or accept a supplied extraction for deterministic testing.
2. **Reconcile arithmetically**: line items summed against the subtotal, subtotal plus tax against the total, quantity times unit price against each line amount — all to a 0.02 tolerance.
3. Validate document type, required fields, ISO 4217 currency, date sanity and implied tax rate.
4. Fingerprint on `vendor | invoice number | currency | total` and check the ledger for duplicates.
5. Score system confidence, verify, and escalate anything with an exception to Governance.

## Platform services it calls

- **02 Model Router**
- **05 Governance**
- **08 Prompt Registry**
- **09 Verification**

## Safety properties

The prompt explicitly tells the extractor **not** to correct a printed total that disagrees with the line items — silently fixing it would hide exactly the discrepancy this workflow exists to find. System confidence starts at 1.0 and is only ever reduced by evidence.

## Triggers

- `Document Request`
- `Test Suite Trigger`

## Verification

- **12/12 passed** — [`tests/results-2026-09-08.json`](tests/results-2026-09-08.json) (n8n execution `262`)
  - All vendor names, invoice numbers and amounts are invented. Eleven cases supply a pre-parsed extraction so the reconciliation, duplicate and exception logic is exercised without model variance; I12 runs the real extraction path.

Every figure came from a run on a live n8n instance; the linked files are the raw results.

## Connections required

- None beyond the platform services above.

Full setup: [docs/CONNECTIONS.md](../../docs/CONNECTIONS.md)

## Limitations

- Text in, no OCR or vision stage. Feed it text extracted upstream.
- Single currency per document; no FX conversion.
- The duplicate fingerprint is exact — a re-issued invoice with a changed number is not caught.

## Import

```bash
python scripts/import-workflows.py --only 06
```

Or import [`workflow.json`](workflow.json) in the n8n editor. Sub-workflow references carry the placeholder `REPLACE_WITH_YOUR_WORKFLOW_ID` and must be relinked — the import script does this automatically.
