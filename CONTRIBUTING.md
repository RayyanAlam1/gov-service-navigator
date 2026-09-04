# Contributing

Thanks for taking a look. This project has one unusual constraint, and reading
it first will save you a rejected pull request.

## The rule that governs every change

> **The language model never supplies a government fact.**

Fees, deadlines, document names, office addresses and eligibility thresholds
come from the database or from a retrieved chunk of an official document — never
from model output. The model detects intent, phrases questions, and translates.

The test for any change touching the answer path: **if you set
`LLM_PROVIDER=mock`, does the evaluation suite still pass?** If your change makes
the answers depend on a live model, it will not be merged.

## Getting set up

```bash
npm ci
cp .env.example .env.local     # placeholders work; no keys needed to run
npm run setup                  # fetch the embedding model, migrate, seed
npm run dev
```

`npm run doctor` reports database, schema, embedding width and provider chain in
one place, and is the fastest way to see what is misconfigured.

Everything runs without an API key. With no credentials the deterministic
provider takes over, and the system stays factually correct — it just stops
paraphrasing.

## Before you open a pull request

```bash
npm run verify        # typecheck + tests + evaluation suite
npm run lint
```

CI runs the same checks plus a container build. All of it must pass.

If you change anything that renders a number, a duration, a count or a URL, run
`npm run eval` and check that **unsupported claims stays at 0**. That number is
the project's core promise; a change that raises it is a change that breaks the
product.

## Adding or changing knowledge base content

Content carries provenance. Every fact is tagged `verified`, `unverified`,
`synthetic` or `deprecated`, and the interface renders each differently.

- Do not promote a fact to `verified` without a citable official source recorded
  alongside it.
- A fee you cannot verify ships as `NULL`, not as a plausible guess. The
  interface has copy for exactly this case.

See [docs/DATA_PROVENANCE.md](docs/DATA_PROVENANCE.md).

## Commit messages

Explain why the change is needed, not what the diff shows. The diff already
shows what changed; it cannot show what you learned that made the change
necessary. Existing history is the style guide.

## AI assistance in this repository

Substantial portions of this codebase and its documentation were written with
an AI coding assistant, directed and reviewed by the maintainer. Two things
follow from that and are worth stating plainly:

- The **architecture positions are held, not generated**: the one rule, the
  deterministic orchestration, three-valued logic, and the refusal to invent
  facts are design decisions this project is built around, and contributions
  are reviewed against them regardless of how they were written.
- The same standard applies to AI-assisted contributions from anyone else:
  the machinery may propose, but a human owns what is merged, and no
  government fact enters the repository from a model's memory — the
  assistant's included.

## Reporting bugs

Use the issue templates. For anything exploitable, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.
