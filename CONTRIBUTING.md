# Contributing to ElpisDAW

## Current Intake Status

Public code contribution intake is not open yet.

ElpisDAW has selected MPL-2.0 for the Core, but the project has not selected a
DCO, CLA, copyright assignment, or other contributor-rights process. Do not
submit code on the assumption that one of those policies applies. This document
must be updated when project governance approves contribution intake and the
applicable rights process.

Documentation review, architecture discussion, and reproducible defect reports
may be prepared for the future public repository, but no external contribution
is accepted until the public repository and rights process are opened.

## Contribution Principles

When contribution intake opens:

- keep changes small, readable, testable, and limited to the approved scope;
- preserve Project and protocol compatibility unless a migration is approved;
- keep user data, Provider credentials, models, and local paths out of commits;
- do not bundle third-party code or assets without a verified license record;
- do not weaken path containment, authentication, atomic persistence, or
  fail-closed validation;
- use English for code, comments, filenames, commits, documentation, and UI
  copy; and
- explain incomplete verification honestly.

## Core and Extension Licensing

ElpisDAW-owned Core source is licensed under MPL-2.0. A contribution that
modifies or adds MPL-covered Core source must be compatible with that license.

The future Extension SDK, Provider API, Custom PatchTab, Custom Dock, and
Community Provider license boundaries are not implemented yet. Do not assume
that a current `shared/**` or Provider contract file is an independently
licensed SDK.

Authors must have the right to submit every contribution. Do not copy code,
tests, prompts, lyrics, samples, model files, UI assets, or documentation from a
source with unclear or incompatible terms.

## Development Checks

The current development workflow targets Windows. After installing the locked
dependencies, run the checks relevant to the change:

```powershell
pnpm test
pnpm build
```

For a narrow repair, run focused tests first and then the required aggregate.
Documentation-only changes normally require link, formatting, privacy, and
`git diff --check` validation rather than an unrelated full product test run.

## Change Submission

When public contribution intake is explicitly opened:

1. Start from the documented public repository and supported branch.
2. Describe the problem and the smallest useful solution.
3. Add or update behavior tests when runtime behavior changes.
4. Keep generated files, caches, logs, model weights, and personal evidence out
   of the commit.
5. Record verification results and remaining evidence gaps.
6. Accept review feedback without expanding the change into unrelated work.

Submitting code does not grant permission to use the ElpisDAW name, logo,
Official Provider label, or Verified Extension label for an independent fork or
product.
