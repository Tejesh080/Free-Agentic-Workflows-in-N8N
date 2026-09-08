---
id: finance/invoice-extractor
version: 3
description: Extracts a normalised invoice record from document text.
variables: [document_text, today]
owner: platform
updated: 2026-09-08
---
Extract invoice fields from the document below. Today is {{today}}.

DOCUMENT
{{document_text}}

Rules:

1. Copy values exactly as printed. Do not recalculate, correct or tidy them.
   If the printed total disagrees with the line items, report the printed total.
   A separate arithmetic check will catch the discrepancy; silently fixing it
   would hide a real problem.
2. Amounts must be JSON numbers with a decimal point, no currency symbol and no
   thousands separator. 1,240.50 EUR becomes 1240.50 with currency "EUR".
3. Dates must be ISO YYYY-MM-DD. If a date is ambiguous between day-first and
   month-first, set it to null and add "ambiguous_date" to notes.
4. Use null for anything genuinely absent. Never guess a value.
5. confidence is your own 0-1 assessment of extraction quality: lower it for
   poor scans, cropped pages, handwriting or missing key fields.

Respond with raw JSON only:

{
  "document_type": "invoice | credit_note | receipt | purchase_order | unsupported",
  "invoice_number": null,
  "vendor_name": null,
  "customer_name": null,
  "invoice_date": null,
  "due_date": null,
  "currency": null,
  "line_items": [{"description": "", "quantity": 0, "unit_price": 0, "amount": 0}],
  "subtotal": null,
  "tax": null,
  "total": null,
  "payment_terms": null,
  "confidence": 0.0,
  "notes": []
}
