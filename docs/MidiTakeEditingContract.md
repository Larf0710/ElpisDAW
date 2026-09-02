# MIDI Take Editing Contract

## Shared editable Takes

Timeline copies own distinct Take IDs but may reference the same inline MIDI Artifact. Saving changed notes must not overwrite an Artifact referenced by another Take, even when that Take is inactive or belongs to the same Clip.

On the first changed save of a shared Manual or Edited MIDI Take, Piano Roll creates and activates a new Edited Take through the existing Artifact registration path. The previous Take and Artifact remain intact, with the new Artifact's lineage pointing to them. Editing either the original Clip or its copy follows this rule. Other Clips, inactive Takes, source notes, and generation provenance are preserved.

Subsequent edits to the new, unshared Take use normal auto-save: the Take and Artifact IDs stay stable and their revision increments. An unchanged shared save creates nothing. Clip-length-only adjustments also do not fork MIDI content.

Creating the private Edited Take requires a valid, unused `PianoRollTakeIdentity`. Missing, invalid, or conflicting identities fail without changing the input Project. Unshared Manual/Edited saves continue to support callers without a new identity. Explicit `NEW TAKE` and protected Generated Take behavior remain available.

## UI and persistence

Automatic source separation preserves the current Piano Roll note selection and local undo/redo history using the existing automatic-copy transition. A shared edit is recorded as creation of an Edited Take in Project history. The save feedback refers to the protected source Take, which may be Generated, Manual, or Edited.

Save to Root and reopening retain the new active choice, the preserved source Takes, and both independent MIDI contents. This policy does not migrate or repair previously saved mismatched Take/Artifact hashes or revisions. No audio playback, rendering, SoundFont assignment change, or source-WAV rewrite is part of an edit.
