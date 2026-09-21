# ElpisDAW

ElpisDAW is a Windows desktop digital audio workstation for keeping AI-assisted
music creation editable, inspectable, and under the user's control.

> **Status:** [ElpisDAW 0.1.0 Preview 1](https://github.com/Larf0710/ElpisDAW/releases/tag/v0.1.0-preview.1)
> is publicly available as a portable Windows 11 x64 pre-release. It is not a
> stable release or a one-click installer.

## Product Direction

ElpisDAW is built around a few durable principles:

- Projects and editable production stages remain under the user's control.
- AI generation is one part of a DAW workflow, not a replacement for editing.
- Provider-specific runtimes and models stay replaceable and independently
  licensed.
- The ElpisDAW Core remains a shared commons under MPL-2.0.
- Future independent Extensions should be able to use separately selected
  licenses after the SDK and API boundaries are approved.

## Current V0.1 Scope

The current implementation includes:

- Project, Timeline, Track, Clip, Take, and source-lineage workflows;
- audio import, recording, editing, splitting, trimming, playback, and export;
- humming-to-MIDI integration through an external Basic Pitch runtime;
- MIDI editing and SoundFont rendering through an optional FluidSynth runtime;
- Stable Audio 3 T2A and A2A integration through a user-supplied runtime;
- ACE-Step T2M and Cover integration through a user-supplied runtime;
- Mixer playback processing, Raw Mixdown, Stem Print, and final export paths;
- authenticated loopback communication with the Local Engine; and
- atomic Project persistence and guarded generated-audio file operations.

External Provider availability, model quality, and redistribution rights are
separate from ElpisDAW Core readiness. Model weights and Provider environments
are not included in this repository.

## User Guide and LLM Tutorials

Read the standalone [ElpisDAW User Guide and LLM Tutorial Companion](./docs/ElpisDAW_LLM_User_Guide.md)
for workspace concepts, saving and reopening, audio/MIDI workflows, optional
AI generation, mixing, final WAV export, and troubleshooting.

You can also attach that Markdown file to an LLM and ask for a step-by-step
tutorial in your preferred language. No particular LLM is required. The guide
is included at `docs/ElpisDAW_LLM_User_Guide.md` by the portable packaging workflow;
it is not an in-app chat integration.

**LLM explanation accuracy and tutorial quality vary by model, version,
settings, and conversation context.** Check advice against the actual app and
its messages, especially before saving over existing work, deleting files, or
installing anything. Do not upload private Projects, audio, or credentials just
to ask a usage question.

## AI-Generated Outputs

Provider and model terms remain separate from ElpisDAW. Before publishing,
monetizing, distributing, or reusing AI-generated material, read the
[AI-Generated Output Notice](./docs/AI_Generated_Output_Notice.md). ElpisDAW
does not grant or warrant output-specific rights.

**Powered by Stability AI.** Stable Audio 3 support uses a separately obtained
model under the [Stability AI license](https://stability.ai/license) and
[Acceptable Use Policy](https://stability.ai/use-policy). Commercial use
requires [registration with Stability AI](https://stability.ai/community-license),
and an Enterprise license may be required.

## Release Status

This repository contains a reviewed, sanitized public source snapshot with new
history. The private development history used to prepare V0.1 is not published
because it contains private development metadata.

The first public binary is
[ElpisDAW 0.1.0 Preview 1](https://github.com/Larf0710/ElpisDAW/releases/tag/v0.1.0-preview.1),
a portable Windows 11 x64 pre-release. A one-click installer is deferred until
the portable package passes broader clean-machine, upgrade, uninstall,
rollback, licensing, and data-safety acceptance.

## Windows Preview Compatibility

The public portable preview targets 64-bit Windows 11. Its Core package is
designed to include the runtime required to launch ElpisDAW without a separate
Node.js, pnpm, Git, Python, .NET SDK, or C# compiler installation. Optional AI
Provider runtimes, model weights, FluidSynth, and SoundFonts are not part of the
portable Core package and must not prevent the Core application from starting.

Compatibility across every Windows build, account policy, security product,
GPU, and optional Provider environment cannot be guaranteed before the software
is exercised on those systems. Prerelease users may therefore encounter
machine-specific issues that were not reproduced on the development host.

The current public preview uses an Authenticode signature from a self-signed
preview certificate, not a publicly trusted publisher certificate. Windows
SmartScreen or other security software may therefore warn about or block it.
Do not install the preview certificate into Trusted Root Certification
Authorities or Trusted Publishers, and do not permanently disable Windows
security or antivirus protection to run ElpisDAW. Verify the artifact name and
published SHA-256 first, retain the exact warning, and report the problem
instead of applying a broad security exclusion.

ElpisDAW should explain when an optional Provider is unavailable and keep the
Core workflow usable. Installing a Provider, obtaining model access, accepting
its terms, and meeting its hardware requirements remain separate user choices.
Provider compatibility on one GPU or runtime profile does not establish support
for every configuration.

Choosing AI model storage on first launch creates folders only. It does not
download model weights or install Provider runtimes. Use the
[manual Provider setup guide](docs/ElpisDAW_LLM_User_Guide.md#install-optional-ai-providers-manually),
follow only the linked official upstream instructions, and accept any gated
model terms yourself. Fully exit ElpisDAW from its tray menu and relaunch it
after setup; before Provider execution, the Local Engine validates the installed
revision, files, and runtime profile without downloading or repairing them.

The portable launcher keeps mutable product data in `ElpisDAW-Data` beside the
verified `ElpisDAW-Core` application folder. After ElpisDAW is closed, the outer
directory may be renamed when `ElpisDAW-Core` and `ElpisDAW-Data` remain
siblings and move together.
SoundFonts, FluidSynth, Basic Pitch, browser state, settings, large AI models,
and reserved LoRA storage therefore survive replacement of the Core folder.
Large AI models default to
`ElpisDAW-Data\Models`; users may choose an external model library instead.
This storage setup does not bypass Provider access, license, integrity, or
compatibility checks, and the reserved LoRA folder does not imply LoRA runtime
support.

### Recommended Portable Project Layout

The outer portable folder and optional project-container folder may use any
names. The following layout keeps replaceable application files, preserved
product data, and user Projects visibly separate:

```text
ElpisDAW/
|-- ElpisDAW-Core/
|-- ElpisDAW-Data/
`-- ElpisDAW-Root/
    |-- Song One/
    |-- Song Two/
    `-- Song Three/
```

`ElpisDAW-Root` is only an optional container in this example. Do not select it
as the Project Root for multiple songs. Select an individual song folder such
as `Song One`; each selected Project Root represents one Project. During a
manual update, replace only `ElpisDAW-Core`. Preserve `ElpisDAW-Data`, every
Project Root, and their backups. Deleting the entire outer portable folder also
deletes any Projects stored inside it.

The first Project Root selection derives the Project JSON filename from that
folder name. Renaming the Project inside ElpisDAW does not rename its folder or
Project JSON file. Renaming the Project Root folder after the first save is not
currently migrated automatically and can prevent the remembered Root or saved
Project JSON from reopening. Choose the folder name before the first save and
keep it stable. If it was renamed accidentally, close ElpisDAW and restore the
previous folder name before reopening the Project; do not rename or delete the
Project JSON independently.

## Reporting a Compatibility Problem

For a launch, save, restart, security-warning, or Provider compatibility issue,
include the following when it is safe to do so:

- Windows edition, version, build number, and x64 architecture confirmation;
- Microsoft Edge version;
- exact ElpisDAW artifact filename and SHA-256;
- whether SmartScreen or security software warned, blocked, or quarantined a
  file, including the exact product name and message;
- the last successful step and the smallest repeatable sequence that fails;
- whether the Core application starts when optional Providers are unavailable;
- the affected Provider name, configured runtime version, and GPU model when
  the problem is Provider-specific; and
- relevant screenshots and redacted logs.

Do not attach private Projects, recordings, generated audio, model weights,
Provider credentials, access tokens, or unredacted local paths unless a private
support channel explicitly requests a safe minimal sample. Reproducible reports
help the project distinguish an ElpisDAW defect from an unsupported or
machine-specific environment; responsibility for investigating and fixing
ElpisDAW defects remains with the project.

## Repository Boundary

This repository contains the public ElpisDAW product source and the build and
test tooling required to inspect it. Release-control automation used to
assemble and audit sanitized source snapshots is maintained separately and is
intentionally not published here.

Retained audit evidence, private development history, local paths, Provider
environments, model weights, SoundFonts, generated media, and machine-specific
artifacts are outside this repository. Their absence does not expand what may
be bundled: any binary release must pass separate packaging, licensing,
clean-machine, security, rollback, and data-safety acceptance.

## Development Workflow

The current development workflow targets Windows and requires Node.js, pnpm,
PowerShell, and the native helper build prerequisites. It is not the future
end-user installation path.

Install the locked dependencies:

```powershell
pnpm install --frozen-lockfile
```

Run the automated checks:

```powershell
pnpm test
pnpm build
```

Start the development launcher:

```powershell
pnpm launch
```

The launcher performs development-time native builds and optional Provider or
SoundFont readiness checks. Do not describe it as a production launcher or a
one-click installer.

## Compatibility Name

The public product name is **ElpisDAW**. The internal name `HumStudio` remains
in protocol identifiers, environment variables, package metadata, native helper
names, and saved-project compatibility fields. Do not rename those identifiers
without an approved compatibility migration.

## Contributions and Security

Public contribution intake is not open yet. Read [CONTRIBUTING.md](./CONTRIBUTING.md)
before preparing a change and follow [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
for project interactions.

Do not report security vulnerabilities in a public issue. Follow
[SECURITY.md](./SECURITY.md) for the current private-reporting status.

The source license and project branding are separate. Read
[TRADEMARKS.md](./TRADEMARKS.md) before using the ElpisDAW name, logo, or an
official-status label for a fork, Provider, Extension, product, or service.

## License

ElpisDAW-owned Core source is licensed under the
[Mozilla Public License 2.0](./LICENSE), SPDX identifier `MPL-2.0`, unless a file
contains a valid independent license notice.

This license does not relicense third-party dependencies, Provider code, model
weights, SoundFonts, generated media, or other external material. Their terms
remain independent.

No trademark permission or claim of official ElpisDAW status is granted by the
source license. The limited referential uses described in
[TRADEMARKS.md](./TRADEMARKS.md) remain available under that policy.
