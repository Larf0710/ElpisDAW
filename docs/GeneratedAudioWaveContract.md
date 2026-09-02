# Generated Audio WAV Contract

HumStudio registers generated audio and writes Timeline Audio EXPORT files in one canonical format:

- RIFF/WAVE
- 48,000 Hz
- stereo
- signed PCM16
- `audio/wav`

Provider-native staging output remains provider-specific. Stable Audio 3 currently stages stereo 44.1 kHz PCM16, while ACE-Step may stage stereo 48 kHz PCM16 or IEEE float32. The Local Engine validates that native output first, then `GeneratedWaveNormalizer` resamples and converts the reserved staging file before `GeneratedArtifactFinalizer` registers it in the Project.

The normalizer is bounded and block-based. It accepts mono or stereo PCM16 and IEEE float32 RIFF/WAVE input, rejects malformed or non-finite samples, duplicates mono into stereo, uses linear interpolation for sample-rate conversion, clips only at the final PCM16 boundary, synchronizes the normalized file, and swaps it into the existing reservation without publishing a partial artifact.

Playback and Timeline EXPORT also retain read compatibility with previously registered PCM16 or IEEE float32 WAV files. This lets existing ACE-Step Clips play and export without rewriting saved Project history. Timeline Audio EXPORT always produces the canonical 48 kHz stereo PCM16 format.

## Instrument Audio timing

The first active Take registered on a new MIDI TO AUDIO output Clip uses the rendered Artifact's full duration, including its release tail. The Clip stores an absolute-seconds source range and a rounded Timeline tick length. The source MIDI Clip is unchanged. Manual rendering and Auto Patch use the same registration contract.

Playback and Timeline EXPORT preserve the exact source endpoint when the Clip length is the rounded tick representation of that range. Rounding the visible endpoint must neither discard final samples nor request samples beyond the source. Right-edge trimming back to the full source length restores the exact endpoint.

The Local Engine's MIXDOWN/STEM PRINT event validation accepts this same nearest-tick source duration. Full-Project render length and all other source identity, file-size, and range checks remain unchanged.

Registration rejects a new output whose full source range exceeds Timeline Length or introduces an overlap with a previously non-overlapping following Clip. The caller must make room and retry; registration does not silently truncate the source or extend the Project.

Existing Takes, saved legacy Clips, explicit trims, and idempotent registration retries retain their saved timing. A newly activated Take must contain an explicit retained source range. Legacy MIDI TO AUDIO Clips with shortened ranges are not silently migrated; render a new output to adopt full-source timing.

## Audio Clip splitting

Splitting a source-backed Audio Clip is non-destructive. Both pieces retain the same immutable Audio Artifacts and source-file identity, with adjacent absolute source ranges. The left piece retains its Clip and Take IDs. The right piece receives a new Clip ID and new project-unique IDs for every copied Take, including inactive Takes; its active choice is mapped to the corresponding new Take ID. Take labels, timestamps, and generation provenance are preserved.

Artifact sharing does not permit duplicate Take ownership. Playback, Timeline EXPORT, and Project Root source restoration continue to reject ambiguous Take IDs. Legacy Clips without Takes remain source-backed without inventing Take records. Existing saved Projects are not silently migrated or rewritten by this split operation.

## Audio Clip left trimming

Left trimming moves the retained source start by the requested Timeline delta from its current position. It does not reconstruct the source start from the opposite endpoint and a tick-rounded duration. A no-op preserves the exact source range; shortening and restoring the left edge preserves source samples while keeping the right endpoint and Take identities unchanged. Source-beginning limits are measured from the retained source start, including for legacy Clips with an explicitly shorter Timeline span. Existing saved trim offsets are not automatically migrated.

## Timeline copying and pasting

Ordinary Track copy, selected-Clip copy into a new Track, Group subtree copy, and Timeline clipboard paste allocate project-unique Take IDs for every copied Take, including inactive Audio and MIDI Takes. Each operation reserves existing Take IDs across the entire Project and shares the allocation set across its copied Clips. The copied active choice is remapped; missing or stale choices are not silently replaced.

Copies retain source ranges, Artifact references, labels, timestamps, and generation provenance. Copying does not rewrite Artifact lineage or source files. Shared Audio Artifacts remain protected by the existing file-deletion guard. Source-backed legacy Clips without Takes do not gain Take records. Previously saved duplicate ownership is not automatically migrated or repaired.
