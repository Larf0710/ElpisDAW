# Stable Audio 3 Runtime

## Status

The HumStudio Stable Audio 3 Provider has a `COMPATIBLE` Runtime contract for
one exact verified native Windows profile. A production-isolated Provider
Worker, Python host, Queue Job Executor, and authenticated Local Engine route
now accept separate `audio-to-audio` and source-free `text-to-audio` Jobs. The
A2A backend production Auto Patch Driver is connected, and the Module Rack
exposes its visible `SA3 A2A` Macro PatchTab. The T2A output-placement and Job
plans plus atomic successful Project settlement exist, but the frontend Runner
is not yet connected to the application and a visible `SA3 T2A` PatchTab does
not exist. Exact model weights and the isolated Python environment remain
outside the repository.

The 2026-09-05 V0.1 redistribution review accepts only a `USER_SUPPLIED`
boundary. The configured local virtual-environment launcher currently cannot
start because its retained CPython 3.10 base interpreter is unavailable. The
accepted 2026-08-05 compatibility evidence remains historical evidence for the
exact profile; it does not establish current Runtime liveness. The environment
must be rebuilt or repaired before another live generation run.

This is intentional. A bounded real Audio-to-Audio generation and independent
file verification passed on the target Windows GPU. The evidence is
`ACCEPTED_FOR_REVIEW` and `FILES_VERIFIED`; those statuses did not automatically
promote the Runtime. An explicit review on 2026-08-05 promoted only the matching
Runtime contract. The later Worker slice added process isolation and tested
lifecycle semantics without rerunning the external model. The T2A Worker branch
is covered by deterministic boundary tests, but has not yet received a separate
real-model acceptance run.

## Pinned candidate

The promoted 2026-08-05 compatibility profile records:

- Provider code: `Stability-AI/stable-audio-3`
- Provider package version: `0.1.0`
- Provider code revision: `9ae61a0ae72fb22c80caf00378c61882fff25921`
- Model: `stabilityai/stable-audio-3-medium`
- Model revision: `27b5a21b791b1b033d193a9e1e3ce78493f102f9`
- Real-probe Task: `audio-to-audio`
- Additional implemented Task: `text-to-audio` (real-model acceptance pending)
- Official output contract: stereo, 44.1 kHz
- Published maximum Medium duration: 380 seconds
- Official Python requirement: 3.10 or newer
- Pinned PyTorch and TorchAudio dependencies: `2.7.1`

The A2A Provider contract snapshots one path-backed Audio Artifact, Prompt,
Strength, explicit Seed, source range, duration, model identity, and one staged
WAV output. The T2A contract requires no input Artifact or parent lineage and
omits A2A-only Strength and source-range parameters. Both contracts require an
actual selected Seed; random sentinel values are not accepted.

## Windows evidence

The official repository currently declares its CUDA 12.6 PyTorch package source
only for Linux x86-64. Stable Audio 3 Medium requires Flash Attention 2, while
the documented prebuilt wheel example is Linux-specific. The optimized
TensorRT route is also documented for Linux. A Windows CPU TFLite route exists,
but it is not evidence that Medium CUDA works natively on the target PC.

Target snapshot refreshed on 2026-08-05:

- Windows x64
- NVIDIA GeForce RTX 4060 Ti
- 16,380 MiB dedicated GPU memory reported by `nvidia-smi`
- NVIDIA driver `610.88`
- CUDA UMD `13.3`
- CPython `3.10.6` detected by the Windows Python launcher
- machine-default CUDA Toolkit `12.4`
- isolated build CUDA Toolkit `12.6.3`
- isolated build MSVC `14.35.32215`

The official Medium table reports a peak allocation from 5.07 GB through 6.52
GB on H200 depending on duration. The target-PC spike measured `9,384 MiB`
peak reserved GPU memory for the bounded run. Native Windows import, CUDA
operation, model loading, and generation are therefore verified for this exact
isolated profile. Production Worker hard cancellation, cleanup, and evidence
handling are covered separately by deterministic tests; the real model has not
yet been executed through the checked-in Worker. Subjective output quality
remains outside both proofs.

## License boundary

The components remain separate:

1. The `stable-audio-3` inference library is MIT-licensed.
2. Stable Audio 3 Medium weights use the Stability AI Community License; Master
   accepted the gated access terms for this probe.
3. The model card identifies T5Gemma under separate Gemma Terms of Use; Master
   accepted those terms for this probe.
4. The retained environment contains `54` installed distributions and `68`
   license or notice evidence files. This snapshot is not a reproducible
   release lock, and one installed tokenizers distribution contains no license
   file beside its Apache license metadata.

Stability AI's current license page describes commercial registration and a
USD 1,000,000 annual-revenue threshold for the Community License. HumStudio
does not treat this technical review as legal or redistribution approval. Model
weights must not be bundled until all applicable model, product-use,
attribution, registration, and distribution requirements are complete.

## V0.1 Redistribution Result

The path-free 2026-09-05 review evidence has SHA-256
`f197aa8baa1b36351c437837f35cb2927a3d9b7f2cdfcf8bfbcc59682c86e2e2`.
It verifies the clean pinned Provider checkout, `54` installed package
identities, `68` installed license or notice files, and the exact `17`-file
model snapshot totaling `10,445,316,196` bytes. The main Stable Audio 3 and
T5Gemma model hashes still match the retained generation evidence.

ElpisDAW V0.1 distributes only its Provider adapter, protocols, and runtime
profile. The Python/CUDA environment is `USER_SUPPLIED`; Stable Audio 3 Medium
and T5Gemma remain `EXCLUDED`. ElpisDAW does not download these artifacts or
accept their terms for the user. This closes the external-byte boundary only.
The model terms also address distribution of a product that uses the model, so
the required agreement copy, NOTICE attribution, prominent `Powered by
Stability AI` display, commercial registration state, and incorporated-policy
review remain release gates. Future bundling or an optional downloader also
remains blocked pending an exact reproducible artifact, complete notices and
SBOM, and clean-machine acceptance.

## Execution policy

`providerDeclaresJob` answers whether Provider, Model, revision, Task, and
Artifact shapes match. `providerSupportsJob` additionally requires a
`COMPATIBLE` Runtime. An `UNVERIFIED` Runtime therefore cannot accidentally be
reported as executable. The checked-in descriptor now passes this technical
gate only for the fixed profile reviewed against the retained evidence; Worker
availability remains a separate boundary.

The Stable Audio 3 definition uses:

- Model compatibility: `PARTIAL_SUPPORT`, because the official Medium API
  declares both generation forms while only A2A has passed the bounded real
  probe; T2A settlement, redistribution review, and subjective quality remain
  incomplete.
- Runtime compatibility: `COMPATIBLE` for the exact reviewed native Windows
  dependency profile and no other profile.
- Cancellation support: `true`, implemented by terminating the isolated Node
  Worker and its Python child, with Job Executor cleanup of both staging paths.

## Production Worker boundary

`StableAudio3ProviderWorkerController` owns one exact Model lifecycle behind the
generic Provider Worker protocol. `StableAudio3PythonHostClient` starts a single
isolated, bytecode-disabled, JSON-line Python child with one in-flight request,
a 30-minute operation timeout, a 16 MiB stdout limit, and a 16 KiB stderr tail.
Host error codes and messages are length-bounded before they cross the Worker
boundary. Known Hugging Face token variables are removed from the child
environment, while `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1` are forced.

The Worker has no machine-specific default installation. Execution requires two
absolute external paths:

```powershell
$env:HUMSTUDIO_STABLE_AUDIO_3_PYTHON = `
  '<absolute-provider-python-path>'
$env:HUMSTUDIO_STABLE_AUDIO_3_MODEL_ROOT = `
  '<absolute-model-snapshot-path>'
```

Missing, relative, linked, or non-regular paths fail closed. The Python host
revalidates CPython, package, CUDA, GPU, and Flash Attention identities. It also
resolves the editable Provider metadata, requires the pinned clean Git checkout,
and checks the sizes and SHA-256 values of all 17 retained Model files before
loading the weights. It rewrites only the in-memory T5Gemma configuration to the
pinned local folder and performs no network fallback.

`StableAudio3JobExecutor` accepts one immutable Project-relative allowlisted WAV,
resolves it through the active Project Root, rejects links and path escape,
streams its SHA-256 before execution, and passes only the canonical input path to
the Worker. The input size and hash are checked again after execution. The Python
host selects the requested source range, uses fixed 8-step, CFG `1.0`, chunked
decoding, and writes PCM output to an internal `.partial.wav`. It synchronizes
that file and atomically replaces the Engine's reserved `.partial` path. The Job
Executor independently parses the resulting RIFF/WAVE, verifies the
provider-native stereo 44.1 kHz PCM, duration and byte count, and streams
SHA-256. It then normalizes the registered artifact to HumStudio's canonical
48 kHz stereo PCM16 WAV contract before asking `GeneratedArtifactFinalizer` to
rename the reservation to its final `.wav`.

Worker failure, timeout, Queue cancellation, or shutdown first disconnects IPC
so the Node Worker can terminate its Python child, then falls back to forced
Windows process-tree termination if cleanup stalls. The Job Executor removes both
`.partial.wav` and `.partial` files. Completed results retain the established
registration-compatible `artifact` and `generation` shape, with immutable input
Artifact ID, input size and SHA-256, Runtime Profile, inference settings, sample
rate, Model revision, and output SHA-256 evidence.

Tests exercise the Node Worker `inspect` path without starting Python, exact
Model lifecycle validation, malformed host output rejection, Project path
authorization, physical WAV verification, atomic finalization, failure cleanup,
and Queue hard cancellation. They use fake generation hosts. No checked-in test
loads the gated weights or claims a successful real-model Worker run.

## Job request snapshot

`shared/stableAudio3Protocol.js` is the single cross-process source for the
v0.1 Provider, Task, Model, output destination, channel, sample-rate, and
duration-limit constants. The Engine Provider definition and the frontend Job
contract consume the same identities so they cannot silently drift.

`createStableAudio3JobRequest()` builds an immutable Queue request from one
resolved Active Audio Take. The snapshot contains exactly one Project-relative
WAV input, one parent Artifact and ClipTake, Prompt, strength, explicit seed,
source range, output duration, fixed stereo 44.1 kHz output, and selected Model
identity. It accepts every existing explicit Project audio directory, so the
contract can support both instrument transformation and later Raw Mixdown
Master processing without becoming instrument-only.

The builder revalidates Artifact, Clip, Active Take, descriptor, file metadata,
allowlisted relative path, timing, and lineage even when the caller presents a
typed object. It rejects the unpinned Model sentinel and requires an
exact lowercase 40-character Model commit revision. The checked-in Runtime
Profile pins the verified revision. The contract does not enqueue a Job,
connect a Worker, or access model weights.

## Authenticated Job transport boundary

`LocalEngineClient.enqueueStableAudio3Job()` serializes one typed Stable Audio
3 Job request through the existing authenticated versioned Jobs API. The
transport reuses the same response parser as the other GPU Job clients, so an
invalid Job envelope cannot enter frontend state.

Transport availability is not Runtime capability. The Local Engine now
registers `StableAudio3JobExecutor` with its routed GPU Queue. Exact authenticated
requests are validated synchronously before allocation and then execute through
the isolated Worker. Invalid Model, revision, Task, input descriptor, output, or
lineage request shapes fail before Queue allocation; physical source
authorization remains an execution boundary. Integration tests cover completed,
failed, and canceled Jobs with injected Workers; they do not load external model
weights. The backend production Auto Patch Driver now consumes this route; UI
exposure remains disconnected.

## Isolated Stage Runner boundary

`runStableAudio3StagePlan()` submits one immutable Stage plan through the typed
client transport, follows only the returned Job ID, and revalidates every
observed Job through the shared Stage outcome boundary. It never searches for
a Job by Provider or request similarity.

Completed, canceled, and failed Jobs remain distinct. A polling-budget limit
returns `JOB_PENDING`, not a false Job failure. An abort before enqueue creates
no Job; an aborted queued Job is removed; active cancellation is requested only
when the exact Runtime Profile declares it supported. `CANCEL_REQUESTED`
continues polling until terminal state, while `SAVING` may complete and win the
cancellation race. If active cancellation is unsupported, the exact Job is
identified by Job ID with its pending outcome so Engine-owned work can be
recovered instead of being misreported or forgotten.

Progress callback, transport, missing-Job, cancellation, and polling failures
are Runner failures rather than Engine-reported Job failures. The result keeps
the immutable Stage identity and Job ID whenever one was allocated.

The production Auto Patch Driver calls this Runner only through its Coordinator
bridge and forces terminal polling, so finite poll-budget exhaustion cannot leak
out as a falsely completed or failed production run. The default isolated mode
still returns `JOB_PENDING` at its finite budget. The Runner does not itself
modify Project state, settle output, advance a Runtime Coordinator, access model
weights, or add UI.

## Isolated Stage execution boundary

`executeStableAudio3StagePlan()` composes the isolated Runner and settlement
boundaries for one already-approved immutable Stage plan. A completed exact Job
is settled atomically into the Project. Poll-budget exhaustion remains
`STAGE_PENDING`; pre-enqueue, queued, and terminal Job cancellation remain
`STAGE_CANCELED`; Runner or settlement errors remain `STAGE_FAILED`.

Only successful settlement can return a changed Project. Pending, cancellation,
transport failure, Engine failure, identity mismatch, and stale Active Take
resolution all return the exact input Project reference. The result retains the
Runner details, and successful or failed completed-Job settlement retains the
settlement details for recovery and diagnostics.

This boundary accepts only a prebuilt Stage plan. It does not create or approve
a Runtime Profile, bypass the planning verification gates, advance a Runtime
Coordinator, register a PatchTab, connect the production Auto Patch Driver,
access model weights, or make the current Engine Provider executable.

## Isolated Stage orchestration boundary

`orchestrateStableAudio3Stage()` composes Adapter planning and Stage execution
without registering a production Stage. The caller supplies one immutable
Dispatch and one exact Runtime Profile snapshot. Planning rejection returns
`STAGE_BLOCKED` with the Adapter cause and never contacts the Engine.

Only a plan accepted through the existing Runtime, Model, identity, source,
and request gates can reach Stage execution. Execution preserves distinct
`STAGE_PENDING`, `STAGE_CANCELED`, `STAGE_FAILED`, and `STAGE_COMPLETED`
results, including the accepted plan and lower-boundary diagnostics where
available. Only `STAGE_COMPLETED` may return a changed Project.

A caller-supplied `COMPATIBLE` profile is evidence input, not certification by
this function. The checked-in Runtime is now `COMPATIBLE`, so its exact matching
profile may advance through planning. This boundary does not create a Profile,
alter the Provider descriptor, advance a Runtime Coordinator, register a
PatchTab, connect the production Auto Patch Driver, access weights, or add UI.

## Current Stage Runtime Profile

`CURRENT_STABLE_AUDIO_3_STAGE_RUNTIME_PROFILE` is the immutable Stage-facing
snapshot of the checked-in Engine Provider state. Provider package version and
Runtime Profile ID come from `shared/stableAudio3Protocol.js`, so the Engine and
TypeScript Stage boundary cannot silently declare different identities.

The current snapshot deliberately declares:

- Model compatibility: `PARTIAL_SUPPORT`
- Model revision: `27b5a21b791b1b033d193a9e1e3ce78493f102f9`
- Runtime compatibility: `COMPATIBLE`
- Active cancellation support: `true`

Passing this exact profile to `orchestrateStableAudio3Stage()` now advances past
the compatibility gate into source and request validation. The isolated Worker
can now produce application audio through an explicitly submitted Local Engine
Job when the external Runtime and Model roots are configured. The profile
records the reviewed compatibility state; it does not accept terms, download
weights, connect the production Auto Patch Driver, or expose UI.

## Output registration boundary

`createStableAudio3Registration()` accepts only one completed Job whose exact
request still matches the current Active source Audio Take. It then delegates
generic parsing, conflict detection, immutable Project updates, and idempotence
to the existing completed-Audio registration boundary.

The SA3-specific layer additionally requires a finalized stereo WAV under
`renders/stable-audio-3/`, exact Provider/Model/Task provenance, matching Job
parameters, and one parent Artifact and ClipTake. A stale source Take, malformed
result, reused Artifact or Job, unsupported target, or mismatched lineage is not
registered.

Instrument transformation may add a Take to its Instrument Audio Clip or a
derived Instrument Audio target. Raw Mixdown processing may register only on a
Master Clip that explicitly derives from the selected Mixdown. Repeating the
same completed Job is idempotent even after its SA3 output becomes Active. This
boundary updates Project state only; it does not create files, enqueue work, or
register the isolated Worker with application dispatch.

## Stage planning boundary

`createStableAudio3StageAdapterPlan()` is an isolated planning-only boundary.
It accepts an immutable Stage dispatch, the current Project, and an exact
Runtime Profile snapshot. It re-resolves the current Active Audio Take, rejects
stale Artifact or ClipTake lineage, requires matching Provider, Task, Model, and
revision identities, and delegates the final request snapshot to the Job
contract.

The boundary explicitly rejects `UNVERIFIED` or `INCOMPATIBLE` Runtime and Model
profiles. The checked-in Windows Runtime is promoted, the model revision is
pinned, and the model remains executable `PARTIAL_SUPPORT`, so the exact current
profile can materialize a Stage plan.

This planning module does not register itself with the production Auto Patch
driver, enqueue a Job, start a Worker, handle cancellation, register output, or
modify Project state. The backend PatchTab contract and production dispatch are
implemented by separate boundaries.

## Stage completion boundary

`completeStableAudio3StagePlan()` accepts only a completed Local Engine Job
envelope whose Adapter, Run, attempt, fingerprint, scope, Provider, Task, Model,
revision, and full request match the immutable Stage plan. It delegates
finalized WAV and lineage validation to the output
registration boundary, then persists one completed TabFlow Stage Result with
the exact fingerprint and scope.

The update is atomic from the caller's perspective. A stale Active source Take,
malformed output, reused identity, invalid result ID, or conflicting persistent
Stage Result returns failure without changing the input Project. Repeating the
same valid Job and Stage Result is idempotent and does not duplicate the
Artifact or ClipTake.

This completion boundary still does not advance a Runtime Coordinator or enqueue
or run a Job. The production Coordinator bridge owns those responsibilities and
may direct registration to the uniquely resolved upstream Audio Clip while
preserving the Root Flow target scope.

## Stage Job outcome boundary

`resolveStableAudio3StageJobOutcome()` converts one exact matching Local Engine
Job snapshot into a deterministic Stage outcome. `QUEUED`, `LOADING_MODEL`,
`PROCESSING`, and `SAVING` remain pending. `CANCEL_REQUESTED` also remains
pending until the Engine reports a terminal state; it never produces completed
output. `CANCELED` becomes a canceled Stage, while `FAILED`, `INTERRUPTED`, and
`PAUSED` become terminal failure.

Only a matching `COMPLETED` Job with a valid finish time receives the immutable
completed envelope accepted by the Stage completion boundary. Provider, Task,
Model, revision, or full-request drift fails before output registration.

The current Runtime Profile declares process-level cancellation support as
`true`. This boundary observes and normalizes Engine state only; the Stage Runner
sends cancellation while the Job Executor owns hard Worker termination and
staging cleanup.

## Stage settlement boundary

`settleStableAudio3StageJob()` composes the Job outcome and completion
boundaries without connecting a Runner. Pending, canceled, failed, mismatched,
or completion-rejected Jobs return the exact input Project. Only one matching
completed Job can produce a new Project containing the finalized Artifact,
ClipTake, and persistent completed Stage Result.

The settlement result preserves distinct `STAGE_PENDING`, `STAGE_CANCELED`,
`STAGE_FAILED`, and `STAGE_COMPLETED` outcomes. This prevents polling state or
cancel intent from being mistaken for a persistent failure or successful
output. Completion failures retain the completed Job outcome for diagnostics.
Repeating the same completed Job remains idempotent.

This is an isolated composition boundary. It does not enqueue or poll a Job,
send cancellation, update a Runtime Coordinator, or register an SA3 PatchTab
with the production Auto Patch driver.

## Environment probe

Inspect an existing isolated Python environment without installing packages,
downloading weights, accepting gated terms, or writing into the environment:

```powershell
node scripts\Verify-StableAudio3Runtime.mjs `
  '<absolute-provider-python-path>'
```

The one-shot Probe starts Python with isolated mode and bytecode writes
disabled. It validates CPython 3.10, `stable-audio-3==0.1.0`, PyTorch and
TorchAudio `2.7.1`, importable Flash Attention 2, CUDA 12.6, the target GPU,
and a 12,288 MiB minimum memory gate. It returns only package versions,
import-error types, CUDA facts, and deterministic blocker codes. It never
returns the Python executable path.

`READY_FOR_MODEL_PROBE` means only that the dependency environment may proceed
to a gated model download and short generation probe. It does not itself change
Provider compatibility, approve redistribution, or prove output quality. The
CLI exits with code 2 when blockers remain so automation cannot mistake a
diagnostic report for acceptance.

A 2026-08-02 bounded run against an existing comparison CPython 3.12.13
environment returned `UNVERIFIED`. Windows x64 was detected correctly, while
the pinned Python version, `stable-audio-3`, PyTorch, TorchAudio, Flash
Attention, and CUDA gates remained blocked. This proves the one-shot process,
schema validation, and deterministic blocker reporting only. It is not a
Stable Audio 3 environment or generation acceptance.

The retained Basic Pitch spike venv could not be used as a comparison because
its launcher referenced a base CPython installation that is no longer
available. The Probe CLI converted that subprocess failure into a sanitized
`PROBE_FAILED` envelope without printing the selected executable path. The
Probe did not modify or repair that unrelated environment.

### 2026-08-04 native Windows dependency compatibility run

A new full Git-containing backup was verified before the run. The probe used an
isolated external checkout and virtual environment outside the repository; it
did not install into HumStudio, Basic Pitch, or the system Python environment.
The official Provider checkout remained detached at
`9ae61a0ae72fb22c80caf00378c61882fff25921`.

The initial HumStudio Runtime Probe verified these boundaries:

- CPython `3.10.6`: passed;
- `stable-audio-3==0.1.0`: installed and importable;
- PyTorch `2.7.1+cu126`: installed and importable;
- TorchAudio `2.7.1+cu126`: installed and importable;
- PyTorch CUDA build `12.6`: available;
- target `NVIDIA GeForce RTX 4060 Ti`: detected with `16,379 MiB`;
- Flash Attention 2: initially blocked; and
- Runtime assessment before the toolchain update: `UNVERIFIED` with
  `FLASH_ATTENTION_MISSING`.

Native Windows source-build attempts used official sources only. Flash
Attention `2.6.3` from the official PyPI source distribution reached the CUDA
extension build but failed with MSVC `C3861` for `_addcarry_u64` and `C2373` for
`cusparseGetErrorString` against the installed CUDA Toolkit `12.4`. The official
Flash Attention `v2.8.3` checkout at
`060c9188beec3a8b62b33a3bfa6d5d2d44975fab` included Windows compiler flags and
avoided the package-extraction path issue when built from a short checkout, but
still failed with the same `_addcarry_u64` compiler error when paired with the
original toolchain. No unofficial Windows wheel or source patch was used. The
exact official lock, license files, and reproduction logs are retained as evidence set
`StableAudio3_native_windows_probe_2026-08-04_checkpoint-2363b2a`.

An approved additive toolchain update then installed CUDA Toolkit `12.6.3`
alongside the existing toolkits and selected MSVC `14.35.32215` for the isolated
build. Machine `CUDA_PATH` was restored to `12.4`, and machine and user `Path`
values still match the captured baseline. The official Flash Attention source
at the same revision built successfully with `FLASH_ATTN_CUDA_ARCHS=80` into:

- wheel tag: `cp310-cp310-win_amd64`;
- byte size: `56,438,297`; and
- SHA-256:
  `74e2409ecafcfe1a5f07e64acfd309d87f0f1a69cdc557861c72787767031a28`.

The exact wheel was installed with `--no-index --no-deps` only in the isolated
Stable Audio 3 probe environment. Import and CUDA operation checks passed on the
target GPU for fixed-length, causal, and variable-length attention. The
reference maximum absolute error was `0.0003864765167236328`, all outputs were
finite, and padding round-trip verification passed.

The post-install HumStudio Runtime Probe returned `READY_FOR_MODEL_PROBE` with
no dependency blockers. A separate ComfyUI startup check returned HTTP `200`;
its CPython `3.10.6`, PyTorch `2.5.1+cu121`, CUDA `12.1`, and absence of Flash
Attention remained unchanged. All eight captured ComfyUI, ComfyTube, and A1111
configuration files retained their original lengths and SHA-256 values. Build,
installation, operation, and isolation evidence is retained as evidence set
`StableAudio3_toolchain_update_2026-08-04_16-39-18_checkpoint-66d7f57_retry-1`.

### 2026-08-05 real model generation run

After Master accepted the Stable Audio 3 and T5Gemma terms, the fixed model
revision was downloaded into the external model cache. The verified manifest
contains 17 files totaling `10,445,316,196` bytes. The main model SHA-256 is
`48d9c65e290e7bcd5194e0633bfc2424a59ee9683f5c2d58762d997b7d8ce0b5`;
the T5Gemma model SHA-256 is
`9b05ea5a4f211d023832f706fb2c0e83e4fc721b6da35ab69ceb0b55eb7800d3`.

The first real inference completed model loading and generation but could not
save its temporary output because the SoundFile backend inferred the temporary
`.partial` suffix as an unsupported audio format. No final output or acceptance
evidence was produced. The failure evidence was retained, and the retry changed
only the temporary filename to end in `.partial.wav`.

The retry used one existing real 10.752-second, 48 kHz mono PCM input, offline
model loading, an 8-second output duration, 8 inference steps, CFG `1.0`, seed
`20260805`, initial noise level `0.5`, and chunked decoding. It produced an
8-second, 44.1 kHz stereo PCM WAV. Model loading took `21,758 ms`, generation
took `3,159 ms`, total elapsed time was `25,039 ms`, and the recorded peak GPU
memory was `9,384 MiB`. The pinned synchronous Provider API exposed no
cancellation control, so cancellation is correctly recorded as `UNSUPPORTED`.

The generated output SHA-256 is
`621a2977a4bef6bf196c4d0522bce06af90f8d63b710ea0358ce9f48cf752230`.
HumStudio's read-only verification CLI independently rehashed the input, output,
and all 17 model files and returned exit code `0`, assessment
`ACCEPTED_FOR_REVIEW`, and final status `FILES_VERIFIED`. Success evidence is
retained as evidence set
`StableAudio3_real_model_probe_2026-08-05_checkpoint-66d7f57_retry-2`;
the earlier save-format failure remains in its adjacent non-retry directory.

The post-generation ComfyUI regression again returned HTTP `200` and stopped
all processes it started. Its Python `3.10.6`, PyTorch `2.5.1+cu121`, CUDA
`12.1`, and lack of Flash Attention remained unchanged. The same eight ComfyUI,
ComfyTube, and A1111 configuration files still match their baseline byte sizes
and SHA-256 values, and machine `CUDA_PATH` remains `12.4`.

This proves bounded native Windows generation for the exact captured profile.
It does not prove that the later checked-in Worker can run the real model,
redistribution approval, or subjective output quality. The 2026-08-05 review
used this evidence to promote only the matching Runtime contract to
`COMPATIBLE`. Worker lifecycle, hard cancellation, and cleanup are now covered
by deterministic process-boundary and Queue tests, not by this retained probe.

The promotion record pins the retained `generation-evidence.json` SHA-256 as
`198cc2d2af32eec6764e69b0f9f7718029b324bdaa4cae8b09f9b14915ad0047`
and the independent `generation-verification.json` SHA-256 as
`2d85635d2e67c8863b4ebd8847e7c2796e4010eff2570e28ee548facdd161c34`.
The historical evidence source Profile ID retains its `unverified` suffix
because the evidence file is immutable. The promoted execution Profile uses a
new configuration-based ID shared by the Engine and Stage contracts.

## Generation acceptance evidence boundary

`assessStableAudio3GenerationAcceptance()` validates the evidence envelope
that a future bounded target-GPU generation probe must produce. It requires
exact, versioned fields for:

- the source Runtime Profile and pinned Provider identities;
- one lowercase 40-character model commit revision;
- unique, sorted model-file paths with byte sizes and SHA-256 values;
- the complete dependency Runtime Probe report;
- input and output SHA-256 values;
- completed RIFF/WAVE output properties;
- elapsed time and peak GPU memory; and
- an observed supported or unsupported cancellation outcome.

The assessment re-runs the dependency Runtime gates and rejects identity drift,
an unpinned model, unsupported output properties, invalid measurements, unsafe
model paths, or malformed/extra fields. A technically complete envelope returns
`ACCEPTED_FOR_REVIEW`, never `COMPATIBLE`. Cancellation support is recorded as
evidence instead of being guessed.

This boundary does not execute Python, read or download model weights, accept
gated terms, approve licensing or redistribution, inspect an output file by
path, change the checked-in Runtime Profile, create a Provider Worker, or
connect Auto Patch or UI. Runtime promotion is a separate human-reviewed
checkpoint; the retained evidence passed that checkpoint on 2026-08-05.

## Generation evidence file verification

`verifyStableAudio3GenerationEvidenceFiles()` performs the separate filesystem
check for an `ACCEPTED_FOR_REVIEW` envelope. The caller supplies explicit
absolute locations for the source input WAV, generated output WAV, and model
root. Rejected generation evidence fails before any supplied path is inspected.

The verifier:

- requires regular, non-symlink files and a regular, non-symlink model root;
- resolves canonical model paths and rejects every target outside that root;
- streams each file through SHA-256 instead of loading model weights in memory;
- compares model and output byte sizes with the evidence envelope;
- parses bounded RIFF/WAVE input and output files, including chunk boundaries,
  PCM or IEEE-float format consistency, and non-empty audio data;
- compares measured output channels, sample rate, and duration with evidence;
- detects size or timestamp changes during verification; and
- returns hashes, byte sizes, relative model paths, and WAVE facts without
  returning any absolute path.

Input and output must be different files. Matching hashes alone do not make a
malformed WAV acceptable. `FILES_VERIFIED` means only that the supplied files
match the already validated technical envelope. The verifier does not execute
inference, write or delete files, accept terms, approve licensing, promote the
Runtime, create a Worker, or connect Auto Patch or UI.

### Read-only verification CLI

Run the complete envelope and file check only after a real external generation
probe has produced every required file and the versioned evidence JSON:

```powershell
node scripts\Verify-StableAudio3GenerationEvidence.mjs `
  '<absolute-evidence-json-path>' `
  '<absolute-input-wav-path>' `
  '<absolute-model-root-path>' `
  '<absolute-output-wav-path>'
```

The CLI requires exactly four absolute paths. Evidence JSON must be a regular,
non-symlink UTF-8 file from 1 byte through 1 MiB. Its output is sanitized JSON
containing no supplied absolute path. Exit codes are:

- `0`: envelope and files returned `FILES_VERIFIED`;
- `2`: evidence or files were available but rejected; and
- `1`: invocation, JSON loading, or verifier execution failed.

An invalid verifier response is never printed as success. Error output retains
one stable code but replaces internal details with a fixed message, so a path
embedded in an unexpected filesystem error cannot leak through the CLI. The
command is read-only and does not start a generation process or change Runtime
compatibility.

## Production Auto Patch Driver boundary

The backend-first slice defined one Stable Audio 3 `audio-in` to `audio-out`
Stage before the Macro PatchTab was exposed. Production preflight requires
exactly Prompt, Duration, Seed, and Strength parameters, one Audio Artifact and
ClipTake input, no resource inputs, and the promoted Provider, task, package,
model, and model revision identities. Invalid parameters or profile drift block
before Driver identity allocation or Job enqueue.

The production Driver reserves only the Stage Result ID. Local Engine remains
the owner of Job, Artifact, and ClipTake identities. The Coordinator bridge
begins the immutable attempt, resolves the upstream Artifact and ClipTake to one
current Active Audio Clip, and runs the existing Adapter, Runner, settlement,
and registration stack. This matters after MIDI Edit and Instrument: the
Coordinator scope continues to name the Root MIDI target, while the SA3 request
and output registration correctly use the generated Instrument Audio Clip.

Successful settlement appends the generated Audio identity and availability to
the Root runtime target, advances the Coordinator, and requires the Project and
Coordinator Stage Result indexes to remain identical. Failure or cancellation
records one failed attempt without deleting finalized upstream outputs. Queued
cancellation removes the exact Job; active cancellation continues through the
existing Engine cancellation contract. Production polling continues until a
terminal Job state and remains abort-aware.

Deterministic tests cover three-Stage success, exact Instrument-to-SA3 lineage,
Provider failure with upstream output preservation, queued cancellation, fixed
runtime-profile preparation, and parameter rejection. They use fake Engine Jobs
and do not start Python, load gated weights, or claim a real-model Worker run.

## Authenticated production route integration

The backend now has one authenticated end-to-end integration harness that
starts from production preparation and an Engine-discovered SoundFont
catalog entry backed by a test fixture file.
It rejects an invalid launch token, runs MIDI Edit, MIDI TO AUDIO, and Stable
Audio 3 through the loopback Local Engine, and preserves the single-Flow-Family
execution contract. FluidSynth rendering and Stable Audio 3 inference use
injected test implementations, while the production request validation, GPU
Job queue, Artifact finalization, source-path resolution, Stage settlement, and
Project registration paths remain real.

The harness verifies exact Instrument-to-SA3 lineage, both finalized WAV files,
Engine-reported generated-audio availability, completed Run History, and the
explicit Project commit boundary. It then starts a fresh Local Engine against
the same Project Root, loads the saved Project file, rechecks both generated
sources and the SoundFont catalog, and prepares a new three-Stage run from the
recovered state. Existing focused suites continue to cover Provider failure and
cancellation with finalized upstream-output preservation.

This harness does not start Python, invoke FluidSynth, load gated weights, or
claim real-model compatibility. It verifies production orchestration and
persistence with controlled test execution only.

## SA3 A2A Macro PatchTab

The Module Rack now exposes an `SA3 A2A` Macro PatchTab backed by the existing
production `audio-to-audio` contract. Adding it to a Project creates one Audio
input, one Audio output, and editable Prompt, Duration, Seed, and Init Noise
Level controls. Prompt is free text rather than a preset selector. Seed uses an
exact integer field; the other numeric controls retain bounded sliders.

The template is catalog-only and does not mutate the initial sample Project.
Connecting a TabFlow route updates the destination Port's explicit Connection
Input Binding, replacing another source kind on that Port. Removing the route
removes that binding without silently inventing a fallback. The legacy
`Stable Audio 3` name still migrates to the same built-in node contract.

Execution remains the global Production Auto Patch action. `SA3 A2A` requires
exactly one upstream Audio source and registers successful output as a new
non-destructive Take on the resolved source Clip. This UI slice does not add
T2A, Empty Clip or Generation Region semantics, Negative Prompt, Timeline
Context prompt import, inpainting, continuation, or arbitrary output routing.
Those require separate domain and product contracts rather than UI-only
controls.

Deterministic tests continue to use fake Engine inference. This slice does not
start Python, load gated weights, run the real model, or change the reviewed
Runtime compatibility evidence.

## Audio Generation Region planning boundary

`createAudioGenerationRegionPlan()` defines the source-free placement contract
required before `SA3 T2A` can be exposed. A Region has an explicit ID and name,
starts either at the current playhead or at one exact Timeline Tick, and uses a
whole-Bar length under HumStudio's current fixed 4/4, 960-PPQ Timeline.

The plan snapshots current Project Tempo and Key. Its seconds duration is
derived exactly for the current constant-tempo Timeline as
`Bars * 4 * 60 / BPM`; the musical Tick length remains unchanged if Tempo later
changes. Provider-specific duration limits remain a later T2A capability gate.
The generic Region contract does not silently shorten a request to fit a model.

Output is explicit. A Region may target one uniquely resolved Blank, Audio, or
Generated Audio Track without overlapping another Clip, or reserve one new
Generated Audio Track identity. A Blank target becomes Generated Audio; an
existing Audio or Generated Audio Track keeps its type. The Region reserves an
`ai-fill-audio` Clip identity, and successful generation is defined to register
the first non-destructive Clip Take on that Region. Whole-Bar Timeline extension
is planned when needed, but the 512-Bar Timeline maximum is never exceeded.

`applyAudioGenerationRegionPlan()` revalidates that immutable plan against the
current Project before changing state. A matching plan adds one empty,
serializable `ai-fill-audio` Timeline Clip, selects it as the sole Project
selection, applies the planned whole-Bar Timeline extension, and either updates
the existing target Track or appends the planned Generated Audio Track. New
Tracks use -6 dB and no parent Group. The original Project object is never
mutated. A changed Tempo, Track, overlap, identity, or plan field blocks the
application and returns the current Project unchanged. Applying the same plan
twice is therefore blocked instead of duplicating the Region.

The created Clip intentionally has no source file, Artifact, Clip Take, or
Active Take. It is stored in normal Project state and survives normal JSON
serialization, but this application function does not write the Project file
to disk.

`executeAudioGenerationRegionWorkspaceCommand()` lifts that application into
the existing Session Edit History boundary. It always revalidates against the
Project in the current History frame, updates both Project selection and the
Workspace `selectedClipId`, preserves unrelated Workspace fields, and commits
one `clip` Edit entry. Edit timestamp, identity uniqueness, and History limit
are validated before Project application. A blocked command returns the exact
current Workspace and History references. The ordinary History contract then
restores the pre-Region Workspace on Undo and the same selected Region on Redo.

No visible placement action, empty-Clip Auto Patch target, T2A cross-process
Job protocol, queue operation, or `SA3 T2A` control exists yet. The plan source
remains explicitly `empty`, so it cannot be confused with the existing `SA3
A2A` Active Audio Take contract.

## SA3 T2A output placement policy

The initial `SA3 T2A` product flow will always write successful output to one
new Generated Audio Track. It will not depend on a selected Clip or Track and
will not reuse an existing Track. Its `Generation Position` control has exactly
two choices:

- `Playhead` captures the current Project playhead when execution is requested;
- `Timeline Start` resolves to Tick 0 regardless of the current playhead.

`createStableAudio3TextToAudioOutputPlan()` encodes that policy on top of the
Audio Generation Region planner. It snapshots the Playhead, resolves the exact
start Tick, reserves unique output Track and Clip identities, and always
requests a new Generated Audio Track. The output plan is immutable and declares
`after-generation-success` materialization. Planning never changes the Project.

The execution path therefore delays adding the Track and Clip until Stable
Audio 3 generation succeeds. A failed or canceled T2A Job leaves no empty
output Track or Clip. `settleStableAudio3TextToAudioJob()` atomically adds the
new Track, places its first Clip at the resolved Tick, registers the generated
Artifact and first Clip Take, selects that Clip, and commits one undoable
Workspace edit. The original Workspace and History references are returned for
every blocked path. Reprocessing the same exact registered Job is idempotent,
while an explicit Undo is respected instead of recreating the output.

Settlement revalidates the immutable T2A Job request, captured output plan,
current Project Tempo and identity availability, finalized Stable Audio 3 WAV
metadata, empty source lineage, and one exact first Clip Take before committing.
The existing empty Generation Region application remains a verified internal
foundation; the initial T2A flow does not expose a separate `+ REGION` action
or apply an empty Region before inference.

The position policy does not yet expose UI or enqueue a Job. It prevents the
future PatchTab and Driver from independently interpreting `Playhead` or
`Timeline Start`, and it keeps source-free output separate from the existing
`SA3 A2A` Active Audio Take contract.

## SA3 T2A Job and capability boundary

The source-free Job contract uses the separate `text-to-audio` task identity.
Its `inputArtifacts`, parent Artifact lineage, and parent Clip Take lineage are
all exactly empty. Its generation parameters are Prompt, Duration, Seed, the
fixed stereo channel count, and the fixed sample rate. It does not reuse the
A2A-only Strength or source-range parameters. Provider, model, pinned model
revision, output destination, and WAV extension must match the exact Stable
Audio 3 protocol constants.

Duration is not entered independently at this boundary. The capability gate
creates the output placement plan from current Project state and passes its
exact Bars-and-Tempo-derived seconds duration into the Job request. A musical
request may remain valid for the Timeline while exceeding the Provider's
380-second limit; that case is blocked before enqueue rather than shortened or
silently changing Bars.

The capability gate also requires an exact `text-to-audio` declaration for the
pinned Provider version, model revision, and Runtime Profile. Runtime must be
`COMPATIBLE`; model compatibility may be `COMPATIBLE` or `PARTIAL_SUPPORT`.
`UNVERIFIED` and incompatible states fail closed. An A2A execution identity or
A2A-only capability cannot be routed through T2A. A successful immutable plan
contains both the source-free queue request and the delayed-success output plan.

The Provider descriptor, Local Engine executor, and Python Worker now branch on
the exact Task identity. A2A still requires one path-backed WAV, validates and
hashes that input, and passes `init_audio` plus `init_noise_level`. T2A requires
empty input and lineage, skips input resolution and input evidence, and calls
the same pinned model without either init argument. Both paths retain the same
Project Root, staged-WAV, output validation, finalization, cancellation, and
cleanup boundaries.

Deterministic tests cover the source-free request through the Provider Worker
and Queue executor with a fake host/output. This slice does not run Python or
load external weights, so it does not claim a real T2A generation acceptance.
No visible PatchTab or control is added by this slice.

`runStableAudio3TextToAudioPlan()` now owns the non-visual Local Engine transport
loop. It enqueues only the immutable source-free request, rejects identity or
request drift on every observation, reports distinct Queue state changes, and
returns the exact terminal Job for later settlement against the latest
Workspace. It never mutates Project state.

Cancellation is state-aware: an aborted queued Job is removed, a supported
active Job receives one cancellation request and remains observed until a
terminal state, and a Job already saving is allowed to finish. Poll, callback,
wait, cancellation, and Engine failures remain typed non-success results. A
finite default polling budget covers the current 30-minute Worker operation
timeout and returns the exact still-pending Job rather than treating it as
generated output.

## Next production slice

Review and approve the visible product flow before connecting the Runner and
settlement command to the application. The proposed `SA3 T2A` Macro PatchTab
exposes Prompt, Bars, Seed, and `Generation Position`, then shows Queue progress
and selects the generated Clip only after atomic settlement. Failed, canceled,
pending, or stale output leaves the current Project unchanged. A real-model
Worker acceptance run remains a separate, explicitly approved operation because
it loads gated external weights. Model redistribution remains out of scope.

## Official references

- https://github.com/Stability-AI/stable-audio-3
- https://github.com/Stability-AI/stable-audio-3/blob/9ae61a0ae72fb22c80caf00378c61882fff25921/pyproject.toml
- https://github.com/Stability-AI/stable-audio-3/blob/9ae61a0ae72fb22c80caf00378c61882fff25921/LICENSE
- https://github.com/Stability-AI/stable-audio-3/blob/main/docs/workflows/inference.md
- https://huggingface.co/stabilityai/stable-audio-3-medium
- https://huggingface.co/stabilityai/stable-audio-3-medium/blob/main/LICENSE.md
- https://stability.ai/license
- https://ai.google.dev/gemma/terms
