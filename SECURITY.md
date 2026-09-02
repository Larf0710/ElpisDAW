# Security Policy

## Current Support Status

ElpisDAW does not yet have a supported public release.

| Version | Supported |
| --- | --- |
| Public releases | None available |
| Pre-release source | Not supported for end users |

Security support begins only after a public release candidate, reporting
channel, and response process are explicitly approved.

## Reporting a Vulnerability

Do not disclose a suspected vulnerability in a public issue, discussion, pull
request, social post, or shared Project file.

Before the public repository opens, GitHub private vulnerability reporting must
be enabled. Once enabled, use the repository's **Security** page and select
**Report a vulnerability**. Do not send secrets, access tokens, private Projects,
model weights, or unrelated personal data with a report.

No public security-reporting address has been approved at the current
pre-public stage. Until the private channel exists, external security report
intake remains closed. This file must be updated before publication if the
approved repository does not provide private vulnerability reporting.

## Useful Report Content

When reporting becomes available, include only the minimum evidence required:

- affected ElpisDAW version or commit;
- operating system and architecture;
- affected component and Provider boundary;
- reproducible steps using non-sensitive test data;
- expected and actual behavior;
- security impact;
- whether the issue affects Project files or external assets; and
- a proposed disclosure timeline, if applicable.

Remove usernames, workstation paths, tokens, private audio, prompts, lyrics,
Projects, and model credentials unless they are essential to reproduce the
issue. Replace them with safe fixtures whenever possible.

## Security Scope

Relevant areas include:

- Local Engine authentication, origin validation, and loopback exposure;
- Project Root containment and canonical-path validation;
- Project persistence, recovery, import, export, and deletion behavior;
- generated-audio reads, staging, finalization, and cleanup;
- Provider process isolation and environment-variable handling;
- release manifests, checksums, signatures, updates, and rollback; and
- dependency, runtime, model, and optional-download integrity.

Provider model quality, upstream training data, and third-party service terms
are important product and licensing concerns, but they are not automatically an
ElpisDAW Core security vulnerability.

## Response Expectations

No response-time or remediation SLA is promised before the public security
process is opened. Once a report is accepted, maintainers should acknowledge it
privately, reproduce it without exposing user data, classify its severity,
prepare a bounded repair, and coordinate disclosure after affected users have a
reasonable mitigation path.
