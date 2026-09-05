# Basic Pitch Runtime

HumStudio's first production Hum-to-MIDI candidate is Basic Pitch 0.4.0 using
its bundled ICASSP 2022 ONNX model and ONNX Runtime CPU execution on Windows.

## Current status

The Provider boundary, production Worker adapter, Local Engine Queue executor,
and typed authenticated Client enqueue boundary are implemented. Basic Pitch is
not yet selected by the visible Hum-to-MIDI workflow, which continues to use the
Mock Provider.

- Runtime compatibility: `COMPATIBLE` on the verified Windows x64 profile
- Model compatibility: `PARTIAL_SUPPORT` until real humming is accepted
- Cooperative cancellation: unsupported by the current Provider contract;
  Queue cancellation uses hard Worker termination
- Distribution: not approved
- Transitive dependency license review: pending

The distinction is intentional: a runtime can execute correctly while the
model's product quality is still unproven.

## Pinned profile

Profile ID: `windows-x64-python-3-10-onnx-cpu`

| Component | Pinned value |
| --- | --- |
| Host | Windows x64 |
| Python | CPython 3.10; verified with 3.10.6 |
| Provider package | `basic-pitch==0.4.0` |
| Inference runtime | `onnxruntime==1.23.2` |
| Execution Provider | `CPUExecutionProvider` |
| Model | `saved_models/icassp_2022/nmp.onnx` |
| Model SHA-256 | `2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec` |

The complete environment resolved by the spike is pinned in
`engine/providers/basicPitchRuntime.requirements.txt`. It must be installed in a
Basic Pitch-specific virtual environment. It must not be installed into another
Provider's runtime or the system Python environment.

## Verification

Create or select an isolated Python 3.10 x64 virtual environment, install the
lock, and run the verifier with that environment's Python executable:

```powershell
py -3.10 -m venv C:\path\to\humstudio-basic-pitch
& C:\path\to\humstudio-basic-pitch\Scripts\python.exe -m pip install -r engine\providers\basicPitchRuntime.requirements.txt
& C:\path\to\humstudio-basic-pitch\Scripts\python.exe scripts\Verify-BasicPitchRuntime.py
```

The verifier rejects the wrong platform, Python family, Python version,
architecture, package lock, model hash, or execution Provider. It then creates a
temporary three-second A4 hum-like WAV, loads the explicit ONNX model, requires a
sustained MIDI note 69 result, and removes the temporary input.

The 2026-08-01 compatibility spike on the target PC completed a cold synthetic
inference in 16.582 seconds and returned one sustained MIDI note 69 event. This
proves installation and ONNX CPU inference only. It does not prove real humming
quality, timing quality, recovery, or production Queue behavior.

Verify the complete Node IPC adapter, long-lived Python host, selected source
range, ONNX inference, and inline MIDI conversion with:

```powershell
node scripts\Verify-BasicPitchProviderWorker.mjs C:\path\to\humstudio-basic-pitch\Scripts\python.exe
```

After the Worker check passes, verify the production Project Root, Queue states,
Worker execution, inline MIDI Artifact, and exact lineage boundary with:

```powershell
node scripts\Verify-BasicPitchQueue.mjs C:\path\to\humstudio-basic-pitch\Scripts\python.exe
```

The 2026-08-02 production Queue verification completed in 3.193 seconds. It
traversed all five Queue states, returned one MIDI note 69 with confidence
`0.875308037`, and preserved the exact parent Recording Artifact and ClipTake
lineage. This remains a synthetic signal check, not real-vocal acceptance.

Verify failure recovery by forcing one unavailable-runtime failure and retrying
the same immutable Job with the pinned runtime:

```powershell
node scripts\Verify-BasicPitchRecovery.mjs C:\path\to\humstudio-basic-pitch\Scripts\python.exe
```

The 2026-08-02 recovery verification recorded
`BASIC_PITCH_RUNTIME_UNAVAILABLE` on attempt 1, retried the same Job with the
pinned runtime, and completed attempt 2 in 3.398 seconds with the expected MIDI
note 69. The failed attempt remained in Job history instead of being hidden or
rewritten.

Run the final technical boundary against one real HumStudio recording with:

```powershell
node scripts\Verify-BasicPitchHummingAcceptance.mjs `
  C:\path\to\humstudio-basic-pitch\Scripts\python.exe `
  C:\path\to\recording.wav `
  0 `
  3.5 `
  120
```

The optional trailing values are source start seconds, source end seconds, and
Project BPM. The verifier accepts only a regular HumStudio mono 16-bit PCM WAV,
copies it into a temporary Project Root, runs the production Queue, and prints
the complete inline MIDI Artifact plus note-count, pitch-range, and confidence
summary. A zero exit code proves the runtime, Queue, Artifact, and lineage
boundaries only. The result intentionally remains
`MANUAL_REVIEW_REQUIRED` until a person checks note and timing quality against
the recording.

A 2026-08-02 technical run used an existing 10.752-second HumStudio recording
candidate at 48 kHz mono. It completed in 3.343 seconds and produced 10 notes
from MIDI pitch 49 through 64 with average confidence `0.500297523`. Runtime,
Queue, Artifact, and lineage checks passed. This is not a real-vocal quality
acceptance because the expected melody and source content were not independently
confirmed.

The Worker uses `HUMSTUDIO_BASIC_PITCH_PYTHON` internally to select the isolated
runtime. If it is not set, the default future installation location is
`engine/bin/basic-pitch/0.4.0/Scripts/python.exe`. The Worker never invokes a
shell and never installs or modifies Python packages.

## Provider contract

The Provider identity is `local-basic-pitch`; the Task is `hum-to-midi`; the
Model is `basic-pitch-icassp-2022@0.4.0-onnx`.

The Provider accepts exactly one path-backed audio Artifact and produces inline
MIDI. Its exact parameter boundary contains project BPM, source range, 960 ticks
per quarter, Basic Pitch onset/frame thresholds, note-length and frequency
limits, the Melodia flag, and an explicit disabled pitch-bend flag. Mock-only
parameters such as `seed` are rejected.

The Worker validates the exact Task contract again before crossing into Python.
The Python host revalidates the runtime versions, ONNX execution Provider, model
SHA-256, audio range, and inference result. It extracts the requested Recording
range into a temporary mono PCM WAV, converts seconds to 960-PPQ ticks with an
explicit half-up rule, emits deterministic note IDs, and removes the temporary
audio before returning.

The Worker does not create or register a Project Artifact, Clip Take, or Job
Record. The Queue executor owns the Job lifecycle and converts only a validated
completed Worker response into an inline MIDI Artifact. Project registration
remains a separate transaction so JobRecord, Artifact, and ClipTake ownership do
not collapse into one record. Cooperative inference cancellation is not
implemented; the current capability remains explicitly `false`.

## Local Engine Queue boundary

The `local-basic-pitch` Queue route accepts exactly one Project-relative
`recordings/*.wav` input, one matching parent Recording Artifact ID, and one
parent ClipTake ID. Before the Worker starts, the executor requires the selected
Project Root, resolves the recording without accepting traversal or absolute
paths, rejects symbolic links and empty files, and verifies that the canonical
file remains inside the active Project Root.

The executor passes only the canonical path-backed audio input to the Worker. It
revalidates the completed MIDI response, copies the exact request lineage and
Provider provenance into the inline MIDI Artifact, and moves the Job through
`LOADING_MODEL`, `PROCESSING`, `SAVING`, and `COMPLETED`. Invalid MIDI never
becomes a completed Job result.

Project-side registration then resolves the parent Artifact and ClipTake against
the current Project. A stale or mismatched lineage is rejected instead of being
registered as a musical Take. This second check is intentional because the Local
Engine Queue owns execution state, not the mutable in-memory Project document.

## License records

Licenses are recorded per component instead of being inferred from the Provider
name.

| Component | License record | Distribution state |
| --- | --- | --- |
| Basic Pitch code | Apache-2.0; retain `LICENSE` and `NOTICE` | `USER_SUPPLIED`; not bundled in V0.1 |
| `nmp.onnx` model | Apache-2.0 basis from the tagged repository and wheel distribution; no separate model license file was found | `USER_SUPPLIED`; future bundling blocked |
| ONNX Runtime 1.23.2 | MIT plus installed third-party notices | `USER_SUPPLIED`; not bundled in V0.1 |
| Transitive Python dependencies | `40` pinned distributions and `63` installed license or notice files reviewed | V0.1 `USER_SUPPLIED` boundary complete; future bundling blocked |

The model license entry is an explicit repository-distribution inference, not a
claim that a separate model license exists. The V0.1 redistribution review
matched all `40` pinned package identities and versions, hashed `63` installed
license or notice files, and retained a path-free evidence report with SHA-256
`5bb1d366f8bc0d5e1f8326dfe742a05259ffab383cede8e48e032c83be94f4b9`.
The review accepts only the non-bundled `USER_SUPPLIED` boundary. A future
packaging slice must re-audit the exact source, wheel contents, native files,
transitive distributions, and required notices before copying any runtime or
model into an ElpisDAW distribution. Vocadito test audio mentioned by Basic
Pitch's notice is not used or bundled.

Official references:

- Basic Pitch v0.4.0 repository: https://github.com/spotify/basic-pitch/tree/v0.4.0
- Basic Pitch license: https://github.com/spotify/basic-pitch/blob/v0.4.0/LICENSE
- Basic Pitch notice: https://github.com/spotify/basic-pitch/blob/v0.4.0/NOTICE
- Basic Pitch PyPI release: https://pypi.org/project/basic-pitch/0.4.0/
- ONNX Runtime v1.23.2 license: https://github.com/microsoft/onnxruntime/blob/v1.23.2/LICENSE

## Next production slice

Run the real-humming acceptance verifier with Master's recording and review note
and timing quality. The visible workflow must remain on the Mock Provider until
that acceptance passes and the production UI wiring is approved.
