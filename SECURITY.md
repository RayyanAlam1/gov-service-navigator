# Security policy

## Reporting a vulnerability

Report security issues privately to **hafizrayyanalam@gmail.com**, or through
GitHub's [private vulnerability reporting][gh] on this repository. Please do not
open a public issue for anything exploitable.

Include what you did, what happened, and what you expected. A proof of concept
helps but is not required. Expect an acknowledgement within 72 hours.

[gh]: https://github.com/RayyanAlam1/gov-service-navigator/security/advisories/new

## What this project treats as a security concern

This system tells people what to do at a government counter. That shapes the
threat model, and two categories matter more here than in a typical web app.

**Ungrounded output.** A fabricated fee, deadline or document name is a security
issue in this project, not merely a bug. It costs someone a wasted trip, and at
scale it erodes the trust the system depends on. If you find a path that puts an
unverified figure on screen without its "not verified" treatment, report it.

**Prompt injection.** User text and retrieved documents both reach the model. An
input that causes the system to ignore its instructions, exfiltrate another
session's data, or present attacker-controlled text as an official source is in
scope. The evaluation suite includes injection scenarios, but it is not
exhaustive.

Also in scope, as usual: authentication and session handling, SQL injection,
XSS, SSRF, dependency vulnerabilities with a practical exploit path, and
anything that discloses one user's session data to another.

## Out of scope

- Missing hardening headers with no demonstrated impact
- Volumetric denial of service
- Reports produced solely by an automated scanner, with no verified exploit
- Data marked `synthetic` or `unverified` being inaccurate — that is disclosed
  on screen by design; see [docs/DATA_PROVENANCE.md](docs/DATA_PROVENANCE.md)

## Handling of secrets

No credential belongs in this repository. Configuration is read from the
environment and documented in [`.env.example`](.env.example), which holds
placeholders only. Deployment credentials live in the hosting provider and in
GitHub Actions secrets.

If a key is ever committed, rotate it first and rewrite history second — a
revoked key in a public commit is an artefact, an active one is an incident.
