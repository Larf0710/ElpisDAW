# FluidSynth Runtime

HumStudio uses FluidSynth 2.5.7 for Piano Roll SoundFont monitoring, ephemeral
MIDI Clip Timeline playback, and finalized `MIDI TO AUDIO` rendering.

## Scope

- Runtime: official Windows 10 x64 C++11 release
- Supported SoundFont inputs: `.sf2` and `.sf3`
- Output: stereo 48 kHz, 16-bit PCM WAV
- Live Note Preview: persistent native FluidSynth session with bounded Note On and Note Off commands
- Audition persistence: none
- Timeline MIDI playback cache persistence: none
- `MIDI TO AUDIO` persistence: finalized Project Artifact and Instrument Audio
  Clip Take
- Distribution: the runtime binaries are installed locally under the Git-ignored `engine/bin/fluidsynth/2.5.7/` directory

The HumStudio Launcher installs the pinned MuseScore General assets under the
Git-ignored internal runtime directory and exposes `MuseScore_General.sf3` as
the built-in default. The asset license and sample-source inventory are retained
beside the SoundFont. Users may add other properly licensed `.sf2` or `.sf3`
files to the active Project `soundfonts/` directory; these remain custom
Project resources and are never copied into the HumStudio runtime.

Each default SoundFont asset download has a five-minute total timeout covering
both response startup and body transfer. A timed-out request is aborted, its
partial file is removed, and launcher startup continues with the default
SoundFont reported as unavailable.

## Installation

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Install-FluidSynthRuntime.ps1
```

The installer downloads the official release archive, verifies this pinned
SHA-256, validates every ZIP destination, and copies only `fluidsynth.exe`,
`libfluidsynth-3.dll`, and `sndfile.dll`. It verifies every copied binary,
retains separately verified FluidSynth and libsndfile LGPL license texts, and
verifies the installed FluidSynth version. The upstream archive's unused
`SDL3.dll` is excluded because its MSVC build disables SDL3 and the installed
FluidSynth binaries do not import it.

```text
fd40c259c56afd6c9ed02ca6c543f896524ade2e3eada28894df7839794f24c9
```

Official references:

- Release: https://github.com/FluidSynth/fluidsynth/releases/tag/v2.5.7
- Project: https://www.fluidsynth.org/
- License FAQ: https://www.fluidsynth.org/wiki/LicensingFAQ/

This installer is for a local Git-ignored runtime. It is not an approved
redistribution manifest. The official archives omit complete license and notice
sets for static codec components inside `sndfile.dll`; do not copy this runtime
into an ElpisDAW package or managed download until the full notice, source,
replacement, and final-artifact review passes.

## Live Note Preview lifecycle

1. After Local Engine and Project Root are ready, the UI loads the combined
   built-in and custom SoundFont catalog automatically.
2. HumStudio asynchronously warms the built-in MuseScore General resource with
   Bank 0 and Program 0. This work does not delay the Engine Ready state.
3. Piano Roll uses the Clip assignment when present; otherwise it selects the
   warmed built-in voice. Custom Project SoundFonts remain lazy-loaded.
4. Local Engine revalidates the selected resource and starts one hidden native
   FluidSynth Live Host against the pinned FluidSynth DLL.
5. Placing, selecting, moving, or transposing a note sends bounded Note On and
   Note Off commands to the same session for immediate monitoring.
6. Changing Clip, resource, Bank, or Program replaces the session. Disabling
   preview, starting Timeline playback, leaving Piano Roll, or stopping Local
   Engine closes it. The native host also watches its parent Engine process and
   exits if that parent terminates unexpectedly.

Live Note Preview does not mutate Project data beyond the note edit itself and
does not write a temporary MIDI or WAV file.

## Temporary full-Clip render lifecycle

1. The UI submits the current Active MIDI Take notes plus the selected catalog resource, Bank, and Program.
2. Local Engine revalidates the SoundFont identity and revision inside either
   the pinned internal built-in library or the active Project `soundfonts/`
   directory.
3. Local Engine creates a Standard MIDI File and invokes the pinned FluidSynth executable without a shell.
4. FluidSynth renders a temporary WAV.
5. Local Engine verifies RIFF/WAVE bytes, returns them to the UI, and deletes the complete temporary directory.
6. The browser decodes and plays the WAV without changing Project JSON, Artifacts, Clip Takes, Undo/Redo, or Timeline transport.

The same verified temporary-render boundary supports MIDI Clip Timeline
playback preparation without creating a Project Artifact or Clip Take.

## Mixer SoundFont workflow

The Mixer SoundFont menu is a Clip-scoped assignment surface.
New manual MIDI Clips and newly created Hum-to-MIDI targets receive the current
built-in default assignment when that catalog resource is available.

1. Select one MIDI Clip, or a Track that contains exactly one MIDI Clip.
2. Choose the built-in or a Project SoundFont, Sound, Bank, or Program. Every
   valid selection is written immediately to the MIDI Clip through the normal
   edit-history boundary; use Undo to restore the previous voice.
3. The voice indicator shows the real SoundFont name, preset name, Bank,
   Program, and `DEFAULT`, `APPLIED`, or `OFFLINE` state.
4. Timeline `PLAY` is the full-Clip listening path. Piano Roll Live Note Preview
   remains the immediate note-entry monitoring path.

There is no separate Mixer draft or Apply action. A Track containing multiple
MIDI Clips reports `MULTIPLE VOICES`; select the exact Clip before changing a
voice. Project SoundFonts expose the preset names
reported by the real FluidSynth catalog rather than a hard-coded General MIDI
label list.

The Piano Roll SoundFont menu uses the same immediate assignment and Undo
boundary. SoundFont catalog rescanning is centralized in the SoundFont PatchTab
as `RESCAN`.

## MIDI Clip Timeline playback cache

An assigned MIDI Clip can enter the ordinary Timeline `PLAY` path without first
creating a finalized Instrument Audio Take.

1. The UI resolves the selected Playback target and includes only MIDI Clips
   with an explicit Clip SoundFont assignment.
2. It resolves the Active MIDI Take and the exact current SoundFont resource,
   including its revision, then renders one temporary WAV at the current
   Project BPM.
3. The in-memory cache key includes the Clip, Active Take, MIDI content hash and
   revision, Project BPM, SoundFont revision, Bank, and Program. An unchanged
   second playback reuses the WAV; any musical or resource change creates a new
   cache entry.
   Workspace replacement and App shutdown clear every entry; Clip removal
   prunes that Clip's entry.
4. The cache source enters the same frozen Project Playback Plan, Mixer insert,
   fader, pan, meter, Loop, and transport path as audio Clips.
5. `STOP`, Engine loss, Project drift, an offline SoundFont, invalid MIDI, or an
   invalid WAV cancels or blocks playback without changing Project JSON.

The playback cache is session-only. It does not create an Artifact, Clip Take,
Undo/Redo entry, browser save payload, or Project Root file. `MIDI TO AUDIO`
remains the explicit operation for producing a persistent audio result.

## MIDI TO AUDIO lifecycle

1. The UI resolves the selected MIDI Clip's current Active MIDI Take.
2. The UI resolves the SoundFont in strict priority order: the MIDI Clip's
   applied voice, a connected SoundFont PatchTab, then the MIDI TO AUDIO
   built-in selection. It snapshots the MIDI Artifact ID, Clip Take ID, content
   hash, revision, SoundFont library and identity, SoundFont revision, Bank,
   Program, and renderer parameters.
3. Local Engine validates the complete `local-fluidsynth` Job contract before
   enqueueing it.
4. The shared SoundFont renderer revalidates the SoundFont in its declared
   built-in or Project library and renders the inline MIDI to stereo PCM.
5. Local Engine validates the WAV and atomically finalizes it under
   `renders/instruments/`.
6. The UI rebuilds the current effective render plan and requires it to match
   the completed Job before registering the finalized Artifact and Instrument
   Audio Clip Take.

A missing or changed SoundFont blocks rendering. A Take, Clip voice, connected
SoundFont, or MIDI TO AUDIO fallback changed after enqueueing blocks Project
registration instead of attaching stale audio. Incomplete staging files are
discarded and never become Project Artifacts.
