# Security Policy

## Current Support Status

ElpisDAW does not yet have a supported binary or end-user release.

| Version | Supported |
| --- | --- |
| Binary releases | None available |
| Public source snapshot | Not supported for end users |

Security report intake begins only after the public source repository provides
the private reporting channel described below. This does not create product
support or a response-time SLA.

## Reporting a Vulnerability

Do not disclose a suspected vulnerability in a public issue, discussion, pull
request, social post, or shared Project file.

GitHub makes private vulnerability reporting available to public repositories.
Immediately after this repository becomes public, its owner must open
**Settings > Security and quality > Advanced Security** and enable **Private
vulnerability reporting**. Once the repository's **Security** page shows
**Report a vulnerability**, use that form. Do not send secrets, access tokens,
private Projects, model weights, or unrelated personal data with a report.

No public security-reporting address has been approved. Until **Report a
vulnerability** is visible, external security report intake remains closed; do
not disclose vulnerability details in a public issue. Repository visibility
and private vulnerability reporting are separate GitHub settings, so the owner
must verify both immediately after the visibility change.

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
