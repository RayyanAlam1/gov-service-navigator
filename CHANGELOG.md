# Changelog

Notable changes to this project. Format follows [Keep a Changelog][kac], and
versions follow [Semantic Versioning][semver].

[kac]: https://keepachangelog.com/en/1.1.0/
[semver]: https://semver.org/spec/v2.0.0.html

## [Unreleased]

## [1.0.0] - 2026-09-01

First complete release. The system is deployed, evaluated and reproducible from
a clean checkout.

### Added

- Adaptive interview that asks only questions whose answer can change the
  outcome, measured by information gain over the rule set rather than by a
  shortened form. Averages 4.5 questions per citizen.
- Deterministic eligibility engine built on three-valued logic, so "not yet
  asked" is never confused with "no".
- Hybrid retrieval over PostgreSQL full-text search and pgvector, fused with
  reciprocal rank fusion, with separate thresholds for showing evidence and for
  claiming a topic is documented.
- Output verifier that rejects any rendered currency, duration, count or URL
  that cannot be traced to a stored fact, including digits that drift during
  translation.
- Provenance tiers — `verified`, `unverified`, `synthetic`, `deprecated` —
  surfaced in the interface rather than kept in the database.
- Evaluation harness covering 51 scripted citizen paths across 3 services and 3
  languages, including prompt-injection scenarios.
- English, Urdu and Roman Urdu throughout, with script-aware language detection.
- Provider chain with key pooling, rate-limit handling, circuit breaking and a
  deterministic fallback enforced by the type signature.
- Container image and Compose stack that provision and seed their own database.
- Continuous integration covering typecheck, lint, unit tests, integration
  tests, the evaluation suite, a production build and a container smoke test.
- Post-deployment verification that exercises the live deployment rather than
  trusting a green build.

### Measured at release

| Metric | Result |
| --- | --- |
| Service identification | 100% |
| Scenario identification | 100% |
| Document F1 | 100% |
| Unsupported claims | 0 |
| Average questions asked | 4.5 |
| Unit and integration tests | 110 passing |

[Unreleased]: https://github.com/RayyanAlam1/gov-service-navigator/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/RayyanAlam1/gov-service-navigator/releases/tag/v1.0.0
