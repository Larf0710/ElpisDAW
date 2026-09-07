# ElpisDAW V0.1 Release Readiness

Status: **MVP FEATURE COMPLETE / RELEASE ACCEPTANCE PENDING**

Release boundary:

- Source snapshot: derived from one reviewed release-candidate commit
- Private evidence branch: `main`
- Private-history feature-freeze baseline: `4674972afeaa6767511a17190bded5ad41b1eeed`
- Private-history repaired implementation checkpoint: `48c0e86b96d5b64db7bc49e515255a1ab537e857`
- Implementation subject: `Fix generated audio clip splitting`
- Product-visible name: `ElpisDAW`
- Retained internal and compatibility name: `HumStudio`

The two private-history commit identifiers above are retained evidence labels.
They are not expected to resolve in the separate public repository.

## Public Source Publication Checkpoint

The separate, history-free source repository was established and verified
after the Phase 1N candidate review:

- Initial public-source commit: `99afc94841d8545cf9e0ae262b8dfe642243ce68`
- Initial snapshot contents: `716` files
- Public `main` checkpoint: `462bd1f625f55a262b2c56efbfd0cd65673610bb`
- CI workflow commit: `8d65144a3d27e1316994ae7361c93d368b3eaa9c`
- Verified `main` CI run: `33591925024` — `Validate Windows source` passed
- Merged dependency-adoption PR: `#3`
- Dependency-adoption head: `7154efd75cef34c23fac424a8a2a1f35cceb6bb2`
- Dependency-adoption merge commit: `462bd1f625f55a262b2c56efbfd0cd65673610bb`
- Verified post-merge `main` CI run: `33854272449` — `Validate Windows source` passed in `3m 54s`
- Post-merge Dependabot state: `0` open alerts and `13` closed alerts
- Post-merge pull-request state: `0` open and `3` closed; Dependabot closed superseded PRs `#1` and `#2`
- Repository-boundary documentation checkpoint: `1a6142b2af2353bb4aff2d20f27b2737e3a4e8fd`
- Verified documentation-checkpoint CI run: `33848290728` — `Validate Windows source` passed
- Transitive dependency security checkpoint: `4738025207650f7877bc808c9a0e08296de9fe72`
- Verified security-checkpoint CI run: `33851973579` — `Validate Windows source` passed

This checkpoint authorizes no tag, end-user release, Provider or model
redistribution, or binary package.

## Scope Freeze

V0.1 is feature-frozen. Work after the baseline is limited to:

- confirmed defect repair;
- release verification;
- licensing and redistribution review;
- documentation and packaging corrections;
- accessibility or data-safety repairs required for release.

The following are explicitly deferred and do not block V0.1 MVP completion:

- live Mixer parameter updates during active playback;
- automation lanes;
- ACE LEGO vocal generation;
- repository, protocol, environment-variable, or saved-project namespace migration from `HumStudio` to `ElpisDAW`;
- production-bundle code splitting unless measured startup performance makes it necessary.

## Verified Implementation Checkpoint

The following evidence was recorded against the repaired implementation checkpoint on 2026-09-01:

- Sequential Vitest: `310` files passed; `2,369` tests passed; `2` tests skipped; `0` failed.
- TypeScript: `tsc --noEmit` passed.
- Production frontend: Vite build passed with `259` modules transformed.
- Generated Audio Clip split regression: SA3 T2A, SA3 A2A, ACE T2M, ACE Cover, and ACE Vocal passed.
- Git: the repair commit contains only the three reviewed source/test files and `git diff --check` passed.

The following evidence remains valid from the feature-freeze baseline because the repair did not change the native helper or ACE generation runtime:

- Native helper: `HumStudio.DirectoryPicker.exe` build passed.
- ACE T2M runtime acceptance passed for generation, 48 kHz Take registration, Timeline Clip creation, atomic Project save, Local Engine restart, Project reload, playback start/stop, and exact selected-Clip export.
- The exported ACE T2M WAV was byte-identical to the registered source WAV.

The two conditional test skips require external evidence that is not stored in the repository:

- two retained 268.8-second generated WAV fixtures;
- an explicitly configured ACE Provider checkout.

Their absence is an evidence gap, not a test failure.

## Release Gates

Public release materials included in the source snapshot:

- [ElpisDAW Core license — MPL-2.0](../LICENSE)
- [Public README](../README.md)
- [Security policy](../SECURITY.md)
- [Contributing policy](../CONTRIBUTING.md)
- [Community code of conduct](../CODE_OF_CONDUCT.md)
- [Trademark policy](../TRADEMARKS.md)

Internal release-control assessments, source-boundary procedures,
provisional license matrices, and Windows distribution specifications are
intentionally excluded from the first public snapshot.

Phase 1 currently assesses public release readiness as **FAIL — PUBLIC RELEASE
BLOCKED**. This does not revoke MVP Feature Complete status; it confirms that
release acceptance remains pending.

### Gate 1: Repository Integrity

- [x] Exact baseline recorded.
- [x] Authoritative branch and worktree clean.
- [x] Full sequential test aggregate recorded.
- [x] TypeScript passed.
- [x] Frontend production build passed.
- [x] Native Directory Picker build passed.
- [x] `git diff --check` passed.

### Gate 2: Runtime Smoke

Run each check against the final release candidate. Do not infer one Provider's result from another Provider.

- [ ] Basic Pitch HUM TO MIDI: real runtime readiness, conversion, MIDI Take registration, save, and reload.
- [ ] FluidSynth MIDI TO AUDIO: render, Instrument Audio Take registration, playback, save, and reload.
- [ ] SA3 T2A: real generation, Take registration, playback, save, reload, and export.
- [ ] SA3 A2A: selected-source binding, generation, Take registration, playback, save, reload, and export.
- [x] ACE T2M: real generation, Take registration, save, restart, reload, playback, and exact export.
- [ ] ACE Cover: real generation, Take registration, source timing, save, reload, playback, and export.
- [ ] Mixer: Channel and Master routing, frozen Playback Plan effects, meters, Raw Mixdown, and Stem Print.
- [ ] Project recovery: source-offline reporting, relink or restoration behavior, and non-destructive failure.

Audible or subjective-quality checks require immediate notice and Master's explicit permission before playback.

### Gate 3: Data Safety

- [x] Project Root path containment and canonical-path checks have automated coverage.
- [x] Generated-audio read and deletion paths reject traversal, unsupported directories, non-WAV files, and staging files.
- [x] Project JSON save/open uses the atomic Project file store.
- [x] Generated Artifact finalization and deletion transaction recovery have automated coverage.
- [ ] Run one final cold-restart recovery smoke against the release candidate without overwriting an existing Project Root.

### Gate 4: Licensing and Redistribution

This gate is required before distributing a package that bundles runtimes, models, weights, SoundFonts, or other third-party assets.

The ElpisDAW Core license decision is complete. The optional copyright-holder
notice is intentionally omitted during the pre-public phase. The overall gate
remains open because the third-party redistribution inventory is not complete.

- [x] Confirm that the V0.1 portable Core excludes FluidSynth runtime bytes and repair the local installer to omit unused SDL3, hash-verify its three binaries, and retain separate FluidSynth and libsndfile LGPL texts.
- [ ] Complete the static codec license, exact-source, LGPL replacement, and notice set before any FluidSynth bundling or managed download.
- [x] Retain the default SoundFont license, source inventory, and pinned hashes.
- [x] Master selected `MPL-2.0` for the ElpisDAW Core.
- [x] Install the official, unmodified MPL-2.0 text as the root `LICENSE`.
- [x] Record the current Core source boundary without bulk file-header changes.
- [x] Record the provisional bundled/external Provider distribution boundary.
- [x] Record Master's decision to omit an optional public copyright-holder notice for now without inventing an identity.
- [x] Verify the exact Phase 1J source-candidate license/provenance and Windows npm metadata boundary.
- [x] Complete the Basic Pitch model and transitive dependency review for the V0.1 `USER_SUPPLIED` boundary; keep all future bundling blocked.
- [x] Require the exact Stable Audio 3 Community License as a hash-verified portable-build input, package its required NOTICE, and add prominent `Powered by Stability AI`, license, registration, and Acceptable Use Policy links to the product UI and documentation.
- [ ] Record the Stable Audio 3 commercial registration or Enterprise-license disposition for the intended V0.1 release use; the `USER_SUPPLIED` external-byte boundary is reviewed and all bundling remains blocked.
- [x] Record the ACE-Step code, model, support weights, and transitive dependency boundary for V0.1 `USER_SUPPLIED` operation; keep all bundling and unverified variants blocked.
- [x] Publish and package the ACE-Step generated-output disclosure policy without making commercial-rights, originality, attribution, publication, monetization, or model-training assurances.
- [ ] Produce the final third-party notices and bundled-asset inventory.

Technical compatibility does not grant redistribution permission.

### Gate 5: Product Presentation

- [x] Product-visible branding uses `ElpisDAW`.
- [x] Internal `HumStudio` identifiers remain compatible with saved Projects and installed runtimes.
- [x] Generation progress and liveness are visible in the header.
- [x] Operator progress is written to the Local Engine console.
- [x] Generation cancellation is visible through the existing cancel controls and state.
- [ ] Complete a final visual smoke at the supported release window size.
- [ ] Review keyboard access, focus visibility, status announcements, and disabled-control explanations.

### Gate 6: Public Source and Windows Distribution

- [x] Accept the fail-closed public source inclusion/exclusion boundary as Phase 1B policy.
- [x] Confirm that the private Git history contains personal author metadata and must not be published directly.
- [x] Add the public README, security policy, contribution policy, and code of conduct with external intake closed.
- [x] Define the sanitized snapshot manifest schema and privacy, secret, binary, license, and manual-review procedure.
- [x] Implement and test a deterministic, fail-closed dry-run manifest generator against an exact Git commit.
- [x] Implement and test deterministic transformations for the two public documents that require sanitization.
- [x] Replace machine-specific AI-cache defaults in the public launcher and ACE runtime resolver without breaking private-development compatibility.
- [x] Implement and test exact-commit local candidate materialization with separate internal evidence and no Git initialization.
- [x] Implement and test focused offline candidate/evidence verification with tamper detection and explicit review gaps.
- [x] Classify the exact generic-path metadata finding set with fail-closed drift detection.
- [x] Run a pinned dedicated local secret scanner against the exact candidate and all reachable private history.
- [x] Run the fail-closed source-license/provenance review against the exact candidate and installed Windows npm graph.
- [x] Complete the technical manual source-to-candidate diff for the exact Phase 1K evaluated boundary.
- [x] Specify a production launcher that does not require pnpm or Vite development mode.
- [x] Specify portable-first packaging and defer the one-click installer until portable acceptance.
- [x] Generate and obtain Master approval for the exact public snapshot manifest, transformations, and candidate contents.
- [ ] Enable approved private security and conduct-reporting channels.
- [x] Select DCO 1.1 sign-off as the contributor-rights policy while keeping public contribution intake closed.
- [x] Add a separate pre-public trademark policy for official-name, logo, Provider, and Extension claims.
- [x] Add and verify the public repository CI workflow.
- [x] Re-run and retain the secret, privacy, binary, large-artifact, license, and manual-diff aggregate against the exact Phase 1AD source candidate; Master approval remains pending.
- [x] Implement and verify fail-closed production static UI serving through the Local Engine.
- [x] Implement and verify the native production launcher and child-process lifecycle with an exact-package automated smoke.
- [x] Implement and test deterministic portable-package materialization with pinned runtime provenance, notices, SBOM, exact manifest validation, and atomic output.
- [x] Materialize and independently verify the current internal portable candidate from exact source commit `058c2046c8c2fe471e238656f5ecd0bc0439ad7b`.
- [x] Seal the internal candidate twice as a byte-identical deterministic ZIP with matching external SHA-256 and exact extracted-package validation.
- [x] Pass silent visible Edge app-mode QA from the extracted ZIP, including Engine readiness, empty browser warning/error capture, survival after Edge close, and child cleanup after launcher termination.
- [x] Exercise `Open ElpisDAW` and `Exit ElpisDAW` directly through the Windows notification-area menu against the sealed `c631cff` internal candidate; repeat against the exact final release candidate during clean-machine acceptance.
- [x] Repeat `Open ElpisDAW`, `Exit ElpisDAW`, initial maximization, existing-window foregrounding, Edge-window close/reopen, and dedicated-profile Browser Save restart/restore against the exact committed `69a8646` post-Phase-1AF candidate.
- [x] Adopt the project-owner-supplied official ElpisDAW icon, retain its exact source, and generate reviewed web and multi-resolution Windows assets.
- [x] Embed the official icon into both native executables, load it in the notification area, publish it as the production favicon, and carry the trademark policy in portable packages.
- [x] Materialize the exact post-icon `bf8afa6` candidate and confirm native validation, the focused notification-area icon, and the full-orbit Edge taskbar icon directly on Windows.
- [x] Confirm the Explorer executable icon against exact candidate `bf8afa6`, then fix and directly confirm the Project Root picker taskbar icon against exact candidate `e96e7c9`.
- [ ] Repeat the complete icon check against the final signed clean-machine candidate.
- [x] Add a fail-closed clean-machine preflight runner for sealed ZIP checksum, archive topology, extraction-path, signature, packaged-runtime, launcher, Engine, alternate-port, and path-free evidence checks.
- [x] Verify the preflight runner against the exact sealed internal ZIP across normal, spaced, and non-ASCII extraction paths, occupied-port fallback, corrupted-checksum rejection, unsigned-native rejection, and exact temporary cleanup.
- [x] Add a staged Authenticode materialization boundary with pinned SignTool provenance, explicit certificate selection, RFC 3161 timestamping, post-signature verification, and fail-closed evidence validation.
- [x] Materialize, seal twice, and preflight the exact post-signing-gate unsigned regression candidate; verify missing-certificate failure publishes no package or staging residue.
- [x] Reconfirm Node.js `24.20.0` as the current Krypton LTS and revalidate the pinned official Windows x64 archive and executable SHA-256 values.
- [x] Require deterministic Roslyn compilation for both native helpers and reproduce the complete `7e782e8` internal candidate and sealed ZIP byte-for-byte across two independent runs.
- [ ] Materialize and accept the release-candidate package with the reconfirmed supported Node.js runtime and prebuilt native helpers.
- [ ] Reproduce the exact release manifest, notices, SBOM, and checksums against the accepted release candidate.
- [ ] Pass clean-machine Windows 11 x64 acceptance.
- [ ] Decide and verify Authenticode signing for public binaries.
- [ ] Verify upgrade, uninstall, data retention, and rollback before building the one-click installer.

## Known V0.1 Limitations

- Mixer effects are processed during playback, but effect parameter changes made while playback is active apply to the next Playback Plan.
- Basic Pitch runtime readiness is cached for the Local Engine process. Repairing an unavailable runtime requires a Local Engine restart before reinspection.
- Real-model output quality is Provider-, model-, prompt-, and hardware-dependent and is not proven by automated tests.
- The main production JavaScript chunk currently exceeds Vite's default 500 kB warning threshold. This is a performance optimization candidate, not a confirmed functional defect.

## Defect Policy

Use the following release classifications:

- `P0`: data loss, destructive corruption, credential exposure, or unrecoverable security failure. Blocks all release work.
- `P1`: core workflow failure with no safe workaround. Blocks V0.1 release.
- `P2`: significant workflow defect with a safe workaround. Release decision required.
- `P3`: limited usability, diagnostics, or low-impact correctness issue. Normally deferred unless repair risk is low.

Every defect report must include the exact commit, reproduction sequence, expected behavior, actual behavior, evidence, affected files, and verification after repair.

## Completion Rule

ElpisDAW V0.1 may be labeled **MVP COMPLETE** when:

1. no confirmed P0 or P1 defect remains;
2. every P2 has an explicit release decision;
3. Runtime Smoke, Data Safety, and Product Presentation gates are complete for the intended release form;
4. Licensing and Redistribution is complete for every bundled third-party component;
5. the final release-candidate test, typecheck, build, and clean-tree results are recorded.

Until those gates close, use:

> **ElpisDAW V0.1 — MVP Feature Complete / Release Acceptance Pending**
