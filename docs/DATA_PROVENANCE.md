# Data provenance

## Why this document exists

The product's only real asset is trustworthiness. A citizen reads a checklist, packs a bag, and
travels to an office. If the checklist was wrong, they lose a day — and the ones who can least
afford to lose a day are exactly the ones this is built for.

So the knowledge base ships **structurally complete and factually unverified**, and says so on
every screen. This document explains what that means and how to change it.

---

## The temptation this guards against

When you write a seed file, a migration or a fixture, there is a strong pull to fill in plausible
values:

```ts
// Every line below is INVENTED. None of it is in this repository.
{ code: 'cnic_normal', amountMinor: 75_000, label: 'Standard fee' },   // "PKR 750, sounds right"
{ code: 'cnic_time_normal', minDays: 15, maxDays: 30 },                 // "about two weeks?"
```

A fabricated number in `seed.ts` is **worse than a hallucination at runtime**. It looks
authoritative. It survives code review. It gets copied into a slide. And six weeks later nobody
remembers it was invented, because it is sitting in a file called *data*.

So the rule is absolute: **if you do not have a verified source for a value, it does not get a
value.**

---

## The three tiers

Every citizen-facing row carries a `verification_status`.

| Tier | Meaning | UI treatment |
|---|---|---|
| `verified` | A human opened the cited official source on `last_verified` and confirmed this exact value. | Green shield badge with the verification date |
| `unverified` | Structurally correct and attributed to a real official source, but not yet confirmed by a human. | Amber warning badge |
| `synthetic` | Written for this repository to make the demo coherent. Not official in any sense. | Purple "demo data" badge |
| `deprecated` | Superseded by a newer version. | Excluded from queries entirely |

A row with **no source at all** renders the loudest badge state — red, "source not recorded" — not a
quiet grey one. Absence of provenance is the worst case, so it must not degrade into something
nobody notices.

The seeder enforces this in code, not in review: `requireSource()` in
[`db/seed/run.ts`](../db/seed/run.ts) throws before any requirement, step, rule or fee can be
inserted without a `source_id`, and a final audit query fails the seed if one slipped through by
another path.

---

## What ships today

Run `npm run doctor` or open `/architecture` for live numbers. As seeded:

| Content | Tier | Why |
|---|---|---|
| Services, scenarios, requirements, steps, rules, exceptions | `unverified` | Procedure *shapes* attributed to real NADRA / DGI&P / provincial pages. No human has confirmed each value against the live page. |
| **All fees** | `unverified`, `amount_minor = NULL` | Nobody on this project has confirmed a current fee. Renders as *"not verified — confirm at the counter."* |
| **All processing times** | `unverified`, `min_days`/`max_days` `NULL` | Same reason. |
| Offices | `synthetic` | Structure only: city and province, **no street address, no phone**. Each links to the department's own locator. |
| Retrieval corpus | `synthetic` | Written for this repository. Every document states so in its own first paragraph, so a chunk retrieved out of context still carries the warning. |
| Source URLs | real | `nadra.gov.pk`, `dgip.gov.pk`, `onlinemrp.dgip.gov.pk` are genuine and checkable. What is *not* claimed is that their current content has been read. |

### Why offices have no address

An office finder is only useful if it is right. A plausible-looking address for "NADRA Mega Centre,
Karachi" that nobody verified is worse than no address, because a citizen will travel to it. The
rows carry city and province — enough to rank offices sensibly — and hand off to the official
locator for the address that matters.

---

## Making the data real

### 1. Ingest official text

```bash
npm run ingest -- \
  --url https://www.nadra.gov.pk/identity/ \
  --source nadra-cnic-overview \
  --service cnic \
  --replace
```

This fetches, extracts, chunks, embeds and stores the page, replacing the placeholder corpus for
that source. Chunks inherit their source's provenance, so they still render `unverified` until step 3.

Preview before writing anything:

```bash
npm run ingest -- --url <url> --source <code> --dry-run
```

PDFs are refused with instructions rather than silently mis-extracted — extract with
`pdftotext -layout` and ingest the result, so the extraction is reviewable.

### 2. Fill in the facts you confirmed

Edit the relevant file under [`db/seed/`](../db/seed/) and re-run `npm run db:seed`. The seed is an
upsert, so this is the maintenance path, not just the initialisation path.

```ts
{
  code: 'cnic_normal',
  category: 'normal',
  label: { en: 'Standard processing fee', ur: '…' },
  amountMinor: <the figure you read on the page, in paisa>,
  noteEn: 'Confirmed against the published schedule on 2026-08-27.',
  sourceCode: 'nadra-fees',
  verification: 'verified',   // ← only after you actually read it
}
```

### 3. Mark the source verified

```bash
npm run ingest -- --file ./fee-schedule.txt --source nadra-fees --verified
```

`--verified` stamps `last_verified` to now. It is the only flag in this repository that can turn an
unverified claim into an authoritative-looking one, which is why it is explicit and never implied.

### 4. Confirm

```bash
npm run doctor      # provenance summary
npm run eval        # grounding must stay at 100%
```

---

## Freshness

`last_verified` older than `SOURCE_STALE_AFTER_DAYS` (default 180) marks a source **stale**. Stale
sources still render, with a "needs re-checking" badge and a plan-level caveat, because government
fees and requirements change and a year-old confirmation is not a current one.

A source that has **never** been verified counts as stale. The citizen-facing consequence of *"we
last checked this nine months ago"* and *"nobody has ever checked this"* is the same, and both
deserve the caveat.

---

## What happens at runtime

Provenance is not decoration. It changes behaviour:

1. **Retrieval** returns each chunk with its source title, publisher, URL and staleness.
2. **The rules engine** excludes `deprecated` rows entirely.
3. **The plan builder** emits a caveat when any contributing source is stale, and a different one
   when a fee is `NULL`.
4. **The output verifier** ([`src/lib/guardrails/output.ts`](../src/lib/guardrails/output.ts))
   rejects any rendered number, duration, count or URL that does not trace to a fact in the plan —
   including one that appeared during translation. A fee that becomes `7500` on its way into Urdu is
   caught by comparing digit signatures before and after.
5. **The UI** renders the badge next to the fact, expanded rather than behind a tooltip, because a
   trust caveat behind a hover is one that mobile users never see.

---

## For reviewers

When reviewing a change to `db/seed/`, the question is not "does this look right?" It is:

> **Did a human open the cited source and read this value?**

If the answer is no, the tier is `unverified` and any numeric field is `NULL`. There is no third
option, and "it's just for the demo" is the exact reasoning that puts a wrong fee in front of a
citizen.
