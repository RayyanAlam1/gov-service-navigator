# Sample documents

Synthetic demo documents for the document checker. **None of these correspond
to a real person.** Names are invented and every identifier is already masked
with `#`, so nothing here is or resembles a real CNIC, passport or B-Form.

They exist so the "Document Intelligence" step of the demo can be shown without
anyone uploading a real identity document — which is the point. The checker's
OCR is an interface with a mock implementation (`src/lib/documents/ocr.ts`);
real OCR drops in behind it unchanged.

## Format

Plain text, one `Key: value` per line, with a `Type:` header naming the
requirement's `document_type`:

```
Type: police_report
Report Number: FIR-####-2026
Issued Date: 2026-08-01
```

## Files

| File | Demonstrates |
|---|---|
| `police-report-valid.txt` | A clean match on the lost-CNIC path |
| `b-form-expired.txt` | Expiry detection — fails even though fields match |
| `passport-wrong-type.txt` | Type mismatch — uploaded against the wrong requirement |
| `unreadable.txt` | No parseable fields; returns `unreadable`, never a pass |
