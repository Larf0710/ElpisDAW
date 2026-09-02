# Clip Type Color Policy

Timeline Clip colors identify the Clip data type. They do not inherit PatchTab
colors or change between Manual, Generated, and Edited Takes.

| Clip types | Fixed color |
| --- | --- |
| `hum-audio`, `instrument-audio`, `vocal-audio`, `ai-fill-audio` | Red `#ff4d5d` |
| `midi-notes`, `edited-midi` | Blue `#4d6dff` |
| `arrangement` | Amber `#ffb000` |
| `mixdown`, `master` | White `#f5f7ff` |

Take origin and editing state must be communicated through labels, badges,
patterns, and borders instead of changing the Clip type color.

`src/clipTypeColors.ts` is the authority. Its exhaustive `ClipType` mapping
requires every new Clip type to receive a fixed color before TypeScript can
build successfully.

The persisted `Clip.color` field remains for project compatibility. Project
normalization and Timeline rendering apply the authoritative Clip type color,
so older projects with legacy colors migrate consistently when loaded.
