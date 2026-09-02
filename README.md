# ElpisDAW

ElpisDAW is a Windows desktop digital audio workstation for keeping AI-assisted
music creation editable, inspectable, and under the user's control.

> **Status:** ElpisDAW V0.1 is MVP Feature Complete and Release Acceptance
> Pending. No public binary or supported end-user release is available yet.

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

## Release Status

The private development history used to prepare V0.1 will not be published
directly because it contains private development metadata. The first public
source repository will be created from a reviewed, sanitized snapshot with new
history.

The first planned binary is a portable Windows 11 x64 prerelease. A one-click
installer is deferred until the portable package passes clean-machine, upgrade,
uninstall, rollback, licensing, and data-safety acceptance.

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

## License

ElpisDAW-owned Core source is licensed under the
[Mozilla Public License 2.0](./LICENSE), SPDX identifier `MPL-2.0`, unless a file
contains a valid independent license notice.

This license does not relicense third-party dependencies, Provider code, model
weights, SoundFonts, generated media, or other external material. Their terms
remain independent.

No trademark permission or claim of official ElpisDAW status is granted by the
source license.
