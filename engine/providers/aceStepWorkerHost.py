from __future__ import annotations

import argparse
import contextlib
import gc
import hashlib
import importlib.metadata
import json
import math
import numbers
import os
import platform
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import unquote, urlparse


PROTOCOL_VERSION = "1"
PROFILE_ID = "windows-x64-cpython-3-11-pytorch-2-7-1-cu128-ace-step-1-5-0"
PROVIDER_ID = "local-ace-step"
PROVIDER_VERSION = "1.5.0"
PROVIDER_CODE_REVISION = "dce621408bee8c31b4fcf4811682eb9359e1bc94"
TASK_ID = "guide-audio-to-vocals"
TEXT_TO_MUSIC_TASK_ID = "text-to-music"
COVER_TASK_ID = "audio-cover"
MODEL_ID = "acestep-v15-base"
MODEL_REVISION = "e432212fec32b8965a14ffa57ae653438d6abd14"
SUPPORT_MODEL_REVISION = "19671f406d603126926c1b7e2adc169acbcade22"
PYTORCH_VERSION = "2.7.1+cu128"
TORCHAUDIO_VERSION = "2.7.1+cu128"
CUDA_VERSION = "12.8"
TARGET_GPU_NAME = "NVIDIA GeForce RTX 4060 Ti"
MINIMUM_GPU_MEMORY_MIB = 15 * 1024
SAMPLE_RATE = 48_000
SUPPORTED_GUIDE_SAMPLE_RATES = frozenset({44_100, SAMPLE_RATE})
CHANNELS = 2
MIN_DURATION_SECONDS = 10
MAX_DURATION_SECONDS = 600
INFERENCE_STEPS = 64
GUIDANCE_SCALE = 8.0
USE_ADG = True
CFG_INTERVAL_START = 0.0
CFG_INTERVAL_END = 1.0
SHIFT = 3.0
DCW_ENABLED = False
INSTRUCTION = "Generate the VOCALS track based on the audio context:"
TEXT_TO_MUSIC_INSTRUCTION = "Fill the audio semantic mask based on the given conditions:"
COVER_INSTRUCTION = "Generate audio semantic tokens based on the given conditions:"
MAX_REQUEST_BYTES = 64 * 1024
MAX_INPUT_BYTES = 512 * 1024 * 1024
MAX_LYRICS_BYTES = 16 * 1024
HASH_BUFFER_BYTES = 8 * 1024 * 1024
EXPECTED_JOB_KEYS = {
    "inputArtifacts",
    "jobId",
    "modelId",
    "modelRevision",
    "output",
    "parameters",
    "providerId",
    "taskId",
}
SEND_MESSAGE_LOCK = threading.Lock()
PROTOCOL_OUTPUT = sys.stdout
PARAMETER_KEYS = {
    "audioFormat",
    "batchSize",
    "caption",
    "channels",
    "durationSeconds",
    "sampleRate",
    "seed",
    "targetTrack",
    "taskType",
    "thinking",
    "vocalLanguage",
}
TEXT_TO_MUSIC_PARAMETER_KEYS = {
    "audioFormat",
    "batchSize",
    "bpm",
    "caption",
    "channels",
    "durationSeconds",
    "guidanceScale",
    "inferenceSteps",
    "instrumental",
    "keyscale",
    "sampleRate",
    "seed",
    "taskType",
    "thinking",
    "timesignature",
    "vocalLanguage",
}
COVER_PARAMETER_KEYS = {
    "audioCoverStrength",
    "audioFormat",
    "batchSize",
    "caption",
    "channels",
    "coverNoiseStrength",
    "durationSeconds",
    "guidanceScale",
    "inferenceSteps",
    "instrumental",
    "sampleRate",
    "seed",
    "taskType",
    "thinking",
    "vocalLanguage",
}
EFFECTIVE_MODEL_FILES = (
    ("apg_guidance.py", 627, "f51c7c8ed2fcd55e24b9a8226824679a48456feafed0f34e116e5b2c24e9b967"),
    ("config.json", 1_940, "9bb4f832f2e5e6c8bf7bddab3c6a6da1b13c01d072efbf0ed3c830536c473359"),
    ("configuration_acestep_v15.py", 217, "a48cf207b12b24913fa680b085a410855a628e48841ab885d90c23f0ccb44dd6"),
    ("model.safetensors", 4_787_825_604, "4177f600501a6d4bd81cadaa0abac557ffd15c54e5c8cb52053cdb24a0844d6b"),
    ("modeling_acestep_v15_base.py", 110_932, "dd8857d821f0c9cd0a04b35ca876cca332515a81bf8c4a8177770e2f074bc060"),
    ("silence_latent.pt", 3_841_215, "a778e9dd942f5e8b2c09c55370782d318834432b03dabbcdf70e6ed49ad6358b"),
)
SUPPORT_MODEL_FILES = (
    ("Qwen3-Embedding-0.6B/added_tokens.json", 707, "c0284b582e14987fbd3d5a2cb2bd139084371ed9acbae488829a1c900833c680"),
    ("Qwen3-Embedding-0.6B/chat_template.jinja", 4_116, "87a2728cb8dc9fe424d624542f6060ec05a1d285ebbec578bb078900e33396b5"),
    ("Qwen3-Embedding-0.6B/config.json", 1_359, "bb23c1607cfe059a58d8f0196cf1cebb52082b1056b8e358a579da80a5759420"),
    ("Qwen3-Embedding-0.6B/merges.txt", 1_671_853, "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5"),
    ("Qwen3-Embedding-0.6B/model.safetensors", 1_191_586_416, "0437e45c94563b09e13cb7a64478fc406947a93cb34a7e05870fc8dcd48e23fd"),
    ("Qwen3-Embedding-0.6B/special_tokens_map.json", 613, "76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd"),
    ("Qwen3-Embedding-0.6B/tokenizer.json", 11_423_705, "def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a"),
    ("Qwen3-Embedding-0.6B/tokenizer_config.json", 5_404, "443bfa629eb16387a12edbf92a76f6a6f10b2af3b53d87ba1550adfcf45f7fa0"),
    ("Qwen3-Embedding-0.6B/vocab.json", 2_776_833, "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910"),
    ("vae/config.json", 425, "14e019904df567f26df750317a70e2bd08f9f8f3c40ff4a24c97d1cd3f20ccd2"),
    ("vae/diffusion_pytorch_model.safetensors", 337_431_388, "da17edb604c40deaf09e9b24974e590d1ca83a374070e5d0884cfa4bed9a99b0"),
)


class AceStepHostError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class AceStepHost:
    def __init__(self, checkpoints_root: Path) -> None:
        self._checkpoints_root = checkpoints_root
        self._handler: Any = None
        self._loaded_at: str | None = None
        self._torch: Any = None
        self._torchaudio: Any = None

    def inspect(self) -> dict[str, Any]:
        verify_offline_environment(self._checkpoints_root)
        verify_runtime_profile()
        verify_provider_checkout()
        validate_snapshots(self._checkpoints_root, verify_hashes=False)
        return {
            "cfgIntervalEnd": CFG_INTERVAL_END,
            "cfgIntervalStart": CFG_INTERVAL_START,
            "dcwEnabled": DCW_ENABLED,
            "guidanceScale": GUIDANCE_SCALE,
            "inferenceSteps": INFERENCE_STEPS,
            "instruction": INSTRUCTION,
            "modelId": MODEL_ID,
            "modelRevision": MODEL_REVISION,
            "offline": True,
            "profileId": PROFILE_ID,
            "providerCodeRevision": PROVIDER_CODE_REVISION,
            "providerVersion": PROVIDER_VERSION,
            "pytorchVersion": PYTORCH_VERSION,
            "status": "READY",
            "supportModelRevision": SUPPORT_MODEL_REVISION,
            "torchaudioVersion": TORCHAUDIO_VERSION,
            "shift": SHIFT,
            "useAdg": USE_ADG,
        }

    def load_model(self, payload: Any) -> dict[str, Any]:
        require_model_identity(payload)
        if self._handler is not None and self._loaded_at is not None:
            return self._loaded_result()

        self.inspect()
        validate_snapshots(self._checkpoints_root, verify_hashes=True)
        try:
            with contextlib.redirect_stdout(sys.stderr):
                import torch
                import torchaudio
                from acestep.handler import AceStepHandler

                handler = AceStepHandler()
                status_message, initialized = handler.initialize_service(
                    project_root="",
                    config_path=MODEL_ID,
                    device="cuda",
                    use_flash_attention=False,
                    compile_model=False,
                    offload_to_cpu=True,
                    offload_dit_to_cpu=False,
                    quantization=None,
                    prefer_source=None,
                    use_mlx_dit=False,
                )
                if not initialized:
                    raise RuntimeError(status_message)
                torch.cuda.synchronize()
        except AceStepHostError:
            raise
        except Exception as error:
            raise AceStepHostError(
                "ACE_STEP_MODEL_LOAD_FAILED",
                "ACE-Step could not load the pinned offline Model.",
            ) from error

        self._handler = handler
        self._torch = torch
        self._torchaudio = torchaudio
        self._loaded_at = utc_now()
        return self._loaded_result()

    def execute(
        self,
        payload: Any,
        progress_callback: Callable[[dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        if self._handler is None or self._torch is None or self._torchaudio is None:
            fail("MODEL_NOT_LOADED", "Load the ACE-Step Model before execution.")

        job = validate_job(payload)
        is_text_to_music = job["taskId"] == TEXT_TO_MUSIC_TASK_ID
        is_cover = job["taskId"] == COVER_TASK_ID
        guide_path = None if is_text_to_music else Path(job["inputArtifacts"][0]["path"])
        lyrics_path = Path(job["inputArtifacts"][0 if is_text_to_music else 1]["path"])
        staging_path = Path(job["output"]["stagingPath"])
        partial_wav_path = Path(job["output"]["partialWavPath"])
        parameters = job["parameters"]
        input_snapshot = validate_inputs(
            guide_path,
            lyrics_path,
            parameters["durationSeconds"],
            self._torchaudio,
            self._torch,
        )
        validate_execution_paths(staging_path, partial_wav_path)
        lyrics = read_lyrics(lyrics_path)
        generation_directory: Path | None = None
        last_reported_percent = -1

        def report_progress(ratio: Any, desc: Any = None) -> None:
            nonlocal last_reported_percent
            if progress_callback is None or not finite_number(ratio):
                return
            percent = round(min(1.0, max(0.0, float(ratio))) * 100)
            if percent <= last_reported_percent:
                return
            last_reported_percent = percent
            progress_callback({
                "accuracy": "ESTIMATED",
                "percent": percent,
            })

        try:
            generation_directory = Path(
                tempfile.mkdtemp(
                    prefix=f".ace-step-{job['jobId']}-",
                    dir=staging_path.parent,
                )
            )
            validate_directory(generation_directory, "ACE_STEP_STAGING_INVALID")
            with contextlib.redirect_stdout(sys.stderr):
                from acestep.inference import GenerationConfig, GenerationParams, generate_music

                if is_text_to_music:
                    params = GenerationParams(
                        task_type="text2music",
                        instruction=TEXT_TO_MUSIC_INSTRUCTION,
                        src_audio=None,
                        caption=parameters["caption"],
                        lyrics=lyrics,
                        instrumental=parameters["instrumental"],
                        vocal_language=parameters["vocalLanguage"],
                        bpm=parameters["bpm"],
                        keyscale=parameters["keyscale"],
                        timesignature=parameters["timesignature"],
                        duration=parameters["durationSeconds"],
                        inference_steps=parameters["inferenceSteps"],
                        guidance_scale=parameters["guidanceScale"],
                        use_adg=USE_ADG,
                        cfg_interval_start=CFG_INTERVAL_START,
                        cfg_interval_end=CFG_INTERVAL_END,
                        shift=SHIFT,
                        dcw_enabled=DCW_ENABLED,
                        seed=parameters["seed"],
                        repainting_start=0.0,
                        repainting_end=-1,
                        thinking=False,
                        use_cot_metas=False,
                        use_cot_caption=False,
                        use_cot_lyrics=False,
                        use_cot_language=False,
                    )
                elif is_cover:
                    params = GenerationParams(
                        task_type="cover",
                        instruction=COVER_INSTRUCTION,
                        src_audio=str(guide_path),
                        caption=parameters["caption"],
                        lyrics=lyrics,
                        instrumental=parameters["instrumental"],
                        vocal_language=parameters["vocalLanguage"],
                        duration=parameters["durationSeconds"],
                        inference_steps=parameters["inferenceSteps"],
                        guidance_scale=parameters["guidanceScale"],
                        use_adg=USE_ADG,
                        cfg_interval_start=CFG_INTERVAL_START,
                        cfg_interval_end=CFG_INTERVAL_END,
                        shift=SHIFT,
                        dcw_enabled=DCW_ENABLED,
                        seed=parameters["seed"],
                        audio_cover_strength=parameters["audioCoverStrength"],
                        cover_noise_strength=parameters["coverNoiseStrength"],
                        repainting_start=0.0,
                        repainting_end=-1,
                        thinking=False,
                        use_cot_metas=False,
                        use_cot_caption=False,
                        use_cot_lyrics=False,
                        use_cot_language=False,
                    )
                else:
                    params = GenerationParams(
                        task_type="lego",
                        instruction=INSTRUCTION,
                        src_audio=str(guide_path),
                        caption=parameters["caption"],
                        lyrics=lyrics,
                        instrumental=False,
                        vocal_language=parameters["vocalLanguage"],
                        duration=parameters["durationSeconds"],
                        inference_steps=INFERENCE_STEPS,
                        guidance_scale=GUIDANCE_SCALE,
                        use_adg=USE_ADG,
                        cfg_interval_start=CFG_INTERVAL_START,
                        cfg_interval_end=CFG_INTERVAL_END,
                        shift=SHIFT,
                        dcw_enabled=DCW_ENABLED,
                        seed=parameters["seed"],
                        repainting_start=0.0,
                        repainting_end=-1,
                        thinking=False,
                        use_cot_metas=False,
                        use_cot_caption=False,
                        use_cot_lyrics=False,
                        use_cot_language=False,
                    )
                config = GenerationConfig(
                    batch_size=1,
                    allow_lm_batch=False,
                    use_random_seed=False,
                    seeds=[parameters["seed"]],
                    audio_format="wav",
                )
                result = generate_music(
                    self._handler,
                    None,
                    params,
                    config,
                    save_dir=str(generation_directory),
                    progress=report_progress,
                )
                self._torch.cuda.synchronize()

            generated_path = validate_generation_result(
                result,
                generation_directory,
                parameters["durationSeconds"],
                self._torch,
            )
            validate_unchanged_inputs(guide_path, lyrics_path, input_snapshot)
            os.replace(generated_path, partial_wav_path)
            output = inspect_wave(partial_wav_path)
            validate_output_wave(output, parameters["durationSeconds"])
            validate_saved_output_samples(
                partial_wav_path,
                parameters["durationSeconds"],
                self._torchaudio,
                self._torch,
            )
            fsync_file(partial_wav_path)
            validate_unchanged_inputs(guide_path, lyrics_path, input_snapshot)
            validate_reserved_staging_path(staging_path)
            os.replace(partial_wav_path, staging_path)
            output_sha256 = sha256(staging_path)
            output_size = staging_path.stat().st_size
        except AceStepHostError:
            raise
        except Exception as error:
            raise AceStepHostError(
                "ACE_STEP_INFERENCE_FAILED",
                "ACE-Step generation failed.",
            ) from error
        finally:
            try:
                partial_wav_path.unlink(missing_ok=True)
            except OSError:
                pass
            if generation_directory is not None:
                shutil.rmtree(generation_directory, ignore_errors=True)

        return {
            "bytesWritten": output_size,
            "channels": output["channels"],
            "durationSeconds": output["durationSeconds"],
            "mimeType": "audio/wav",
            "sampleRate": output["sampleRate"],
            "sha256": output_sha256,
            "stagingPath": str(staging_path),
        }

    def unload_model(self) -> dict[str, Any]:
        was_loaded = self._handler is not None
        self._release_model()
        return {
            **({"modelId": MODEL_ID, "revision": MODEL_REVISION} if was_loaded else {}),
            "status": "UNLOADED",
            "unloadedAt": utc_now(),
        }

    def shutdown(self) -> dict[str, str]:
        self._release_model()
        return {"status": "SHUTDOWN"}

    def _loaded_result(self) -> dict[str, str]:
        if self._loaded_at is None:
            fail("ACE_STEP_HOST_STATE_INVALID", "ACE-Step Model state is invalid.")
        return {
            "loadedAt": self._loaded_at,
            "modelId": MODEL_ID,
            "revision": MODEL_REVISION,
            "status": "LOADED",
        }

    def _release_model(self) -> None:
        torch_module = self._torch
        self._handler = None
        self._torch = None
        self._torchaudio = None
        self._loaded_at = None
        gc.collect()
        if torch_module is not None:
            try:
                torch_module.cuda.empty_cache()
            except Exception:
                pass


def verify_offline_environment(checkpoints_root: Path) -> None:
    if (
        os.environ.get("HF_HUB_OFFLINE") != "1"
        or os.environ.get("TRANSFORMERS_OFFLINE") != "1"
        or os.environ.get("HF_DATASETS_OFFLINE") != "1"
        or os.environ.get("ACESTEP_CHECKPOINTS_DIR") != str(checkpoints_root)
    ):
        fail("ACE_STEP_OFFLINE_REQUIRED", "ACE-Step requires the fixed offline environment.")


def verify_runtime_profile() -> None:
    try:
        import torch
        import torchaudio

        python_ok = (
            sys.platform == "win32"
            and platform.machine().lower() in {"amd64", "x86_64"}
            and platform.python_implementation() == "CPython"
            and sys.version_info[:2] == (3, 11)
        )
        versions_ok = (
            importlib.metadata.version("ace-step") == PROVIDER_VERSION
            and torch.__version__ == PYTORCH_VERSION
            and torchaudio.__version__ == TORCHAUDIO_VERSION
            and torch.version.cuda == CUDA_VERSION
        )
        cuda_ok = torch.cuda.is_available()
        if cuda_ok:
            device = torch.cuda.current_device()
            properties = torch.cuda.get_device_properties(device)
            cuda_ok = (
                properties.name == TARGET_GPU_NAME
                and properties.total_memory // (1024 * 1024) >= MINIMUM_GPU_MEMORY_MIB
            )
        if not python_ok or not versions_ok or not cuda_ok:
            raise ValueError("runtime profile mismatch")
    except Exception as error:
        raise AceStepHostError(
            "ACE_STEP_RUNTIME_INVALID",
            "ACE-Step Runtime does not match the pinned target profile.",
        ) from error


def verify_provider_checkout() -> None:
    try:
        distribution = importlib.metadata.distribution("ace-step")
        direct_url_text = distribution.read_text("direct_url.json")
        if direct_url_text is None or len(direct_url_text) > 16 * 1024:
            raise ValueError("direct URL metadata unavailable")
        direct_url = json.loads(direct_url_text)
        parsed_url = urlparse(direct_url["url"])
        if (
            parsed_url.scheme != "file"
            or parsed_url.netloc not in {"", "localhost"}
            or parsed_url.query
            or parsed_url.fragment
            or direct_url.get("dir_info") != {"editable": True}
        ):
            raise ValueError("provider installation is not pinned")

        path_text = unquote(parsed_url.path)
        if re.match(r"^/[A-Za-z]:/", path_text):
            path_text = path_text[1:]
        provider_root = Path(path_text)
        if not provider_root.is_absolute():
            raise ValueError("provider checkout is relative")
        validate_directory(provider_root, "ACE_STEP_PROVIDER_INVALID")
        validate_directory(provider_root / ".git", "ACE_STEP_PROVIDER_INVALID")
        validate_regular_file(provider_root / "acestep" / "__init__.py", None, provider_root)

        git_path_text = shutil.which("git")
        if git_path_text is None:
            raise ValueError("Git unavailable")
        git_environment = dict(os.environ)
        git_environment["GIT_OPTIONAL_LOCKS"] = "0"
        git_environment["GIT_TERMINAL_PROMPT"] = "0"
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        safe_directory = provider_root.as_posix()
        revision = subprocess.run(
            [
                git_path_text,
                "-c",
                f"safe.directory={safe_directory}",
                "-C",
                str(provider_root),
                "rev-parse",
                "--verify",
                "HEAD",
            ],
            capture_output=True,
            check=False,
            creationflags=creation_flags,
            env=git_environment,
            text=True,
            timeout=10,
        )
        status = subprocess.run(
            [
                git_path_text,
                "-c",
                f"safe.directory={safe_directory}",
                "-C",
                str(provider_root),
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
            ],
            capture_output=True,
            check=False,
            creationflags=creation_flags,
            env=git_environment,
            text=True,
            timeout=10,
        )
        if (
            revision.returncode != 0
            or revision.stdout.strip() != PROVIDER_CODE_REVISION
            or revision.stderr
            or status.returncode != 0
            or status.stdout
            or status.stderr
        ):
            raise ValueError("provider checkout mismatch")
    except AceStepHostError:
        raise
    except Exception as error:
        raise AceStepHostError(
            "ACE_STEP_PROVIDER_INVALID",
            "ACE-Step Provider checkout does not match the pinned revision.",
        ) from error


def validate_snapshots(checkpoints_root: Path, verify_hashes: bool) -> None:
    validate_directory(checkpoints_root, "ACE_STEP_MODEL_INVALID")
    if checkpoints_root.name != SUPPORT_MODEL_REVISION:
        fail("ACE_STEP_MODEL_INVALID", "ACE-Step Checkpoints Root must use the pinned revision directory.")
    validate_snapshot_files(checkpoints_root, SUPPORT_MODEL_FILES, verify_hashes)
    model_root = checkpoints_root / MODEL_ID
    validate_directory(model_root, "ACE_STEP_MODEL_INVALID")
    validate_snapshot_files(model_root, EFFECTIVE_MODEL_FILES, verify_hashes)


def validate_snapshot_files(
    root: Path,
    files: tuple[tuple[str, int, str], ...],
    verify_hashes: bool,
) -> None:
    for relative_path, expected_size, expected_sha256 in files:
        file_path = root.joinpath(*relative_path.split("/"))
        validate_regular_file(file_path, expected_size, root)
        if verify_hashes and sha256(file_path) != expected_sha256:
            fail("ACE_STEP_MODEL_INVALID", "ACE-Step Model file SHA-256 does not match the pinned snapshot.")


def validate_job(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != EXPECTED_JOB_KEYS:
        fail("ACE_STEP_JOB_INVALID", "ACE-Step Job is invalid.")
    if (
        value.get("providerId") != PROVIDER_ID
        or value.get("taskId") not in {TASK_ID, TEXT_TO_MUSIC_TASK_ID, COVER_TASK_ID}
        or value.get("modelId") != MODEL_ID
        or value.get("modelRevision") != MODEL_REVISION
        or not valid_identity(value.get("jobId"))
    ):
        fail("ACE_STEP_JOB_UNSUPPORTED", "ACE-Step Job identity is unsupported.")

    artifacts = value.get("inputArtifacts")
    if value.get("taskId") == TEXT_TO_MUSIC_TASK_ID:
        artifacts_valid = (
            isinstance(artifacts, list)
            and len(artifacts) == 1
            and valid_path_artifact(artifacts[0], "lyrics")
        )
    else:
        artifacts_valid = (
            isinstance(artifacts, list)
            and len(artifacts) == 2
            and valid_path_artifact(artifacts[0], "audio")
            and valid_path_artifact(artifacts[1], "lyrics")
        )
    if not artifacts_valid:
        fail("ACE_STEP_JOB_ARTIFACTS_INVALID", "ACE-Step inputs do not match the requested Task.")
    output = value.get("output")
    if (
        not isinstance(output, dict)
        or set(output) != {"kind", "partialWavPath", "stagingPath"}
        or output.get("kind") != "audio"
        or not isinstance(output.get("stagingPath"), str)
        or not isinstance(output.get("partialWavPath"), str)
    ):
        fail("ACE_STEP_JOB_ARTIFACTS_INVALID", "ACE-Step requires one staged audio output.")
    validate_parameters(value.get("parameters"), value.get("taskId"))
    return value


def validate_parameters(parameters: Any, task_id: str) -> None:
    if task_id == TEXT_TO_MUSIC_TASK_ID:
        validate_text_to_music_parameters(parameters)
        return
    if task_id == COVER_TASK_ID:
        validate_cover_parameters(parameters)
        return
    if not isinstance(parameters, dict) or set(parameters) != PARAMETER_KEYS:
        fail("ACE_STEP_PARAMETERS_INVALID", "ACE-Step parameters are invalid.")
    if (
        parameters.get("audioFormat") != "wav"
        or parameters.get("batchSize") != 1
        or parameters.get("channels") != CHANNELS
        or parameters.get("sampleRate") != SAMPLE_RATE
        or parameters.get("targetTrack") != "vocals"
        or parameters.get("taskType") != "lego"
        or parameters.get("thinking") is not False
    ):
        fail("ACE_STEP_PARAMETERS_INVALID", "ACE-Step output and task parameters are invalid.")
    caption = parameters.get("caption")
    duration = parameters.get("durationSeconds")
    seed = parameters.get("seed")
    language = parameters.get("vocalLanguage")
    if (
        not isinstance(caption, str)
        or not caption
        or caption.strip() != caption
        or len(caption) > 2_000
        or not finite_number(duration)
        or duration < MIN_DURATION_SECONDS
        or duration > MAX_DURATION_SECONDS
        or not isinstance(seed, int)
        or isinstance(seed, bool)
        or seed < 0
        or seed > 0xFFFFFFFF
        or not isinstance(language, str)
        or (language != "unknown" and re.fullmatch(r"[a-z]{2}", language) is None)
    ):
        fail("ACE_STEP_PARAMETERS_INVALID", "ACE-Step generation parameters are invalid.")


def validate_text_to_music_parameters(parameters: Any) -> None:
    if not isinstance(parameters, dict) or set(parameters) != TEXT_TO_MUSIC_PARAMETER_KEYS:
        fail("ACE_STEP_PARAMETERS_INVALID", "ACE-Step Text to Music parameters are invalid.")
    if (
        parameters.get("audioFormat") != "wav"
        or parameters.get("batchSize") != 1
        or parameters.get("channels") != CHANNELS
        or parameters.get("sampleRate") != SAMPLE_RATE
        or parameters.get("taskType") != "text2music"
        or parameters.get("thinking") is not False
        or parameters.get("inferenceSteps") != INFERENCE_STEPS
        or parameters.get("guidanceScale") != GUIDANCE_SCALE
        or parameters.get("timesignature") != "4/4"
        or not isinstance(parameters.get("instrumental"), bool)
    ):
        fail("ACE_STEP_PARAMETERS_INVALID", "ACE-Step Text to Music output and fixed v0.1 parameters are invalid.")
    caption = parameters.get("caption")
    bpm = parameters.get("bpm")
    duration = parameters.get("durationSeconds")
    keyscale = parameters.get("keyscale")
    seed = parameters.get("seed")
    language = parameters.get("vocalLanguage")
    if (
        not isinstance(caption, str)
        or not caption
        or caption.strip() != caption
        or len(caption) > 2_000
        or not finite_number(bpm)
        or bpm < 20
        or bpm > 300
        or not finite_number(duration)
        or duration < MIN_DURATION_SECONDS
        or duration > MAX_DURATION_SECONDS
        or not isinstance(keyscale, str)
        or not keyscale
        or keyscale.strip() != keyscale
        or len(keyscale) > 64
        or not isinstance(seed, int)
        or isinstance(seed, bool)
        or seed < 0
        or seed > 0xFFFFFFFF
        or not isinstance(language, str)
        or (language != "unknown" and re.fullmatch(r"[a-z]{2}", language) is None)
    ):
        fail("ACE_STEP_PARAMETERS_INVALID", "ACE-Step Text to Music generation parameters are invalid.")


def validate_cover_parameters(parameters: Any) -> None:
    if not isinstance(parameters, dict) or set(parameters) != COVER_PARAMETER_KEYS:
        fail("ACE_STEP_PARAMETERS_INVALID", "ACE-Step Cover parameters are invalid.")
    if (
        parameters.get("audioFormat") != "wav"
        or parameters.get("batchSize") != 1
        or parameters.get("channels") != CHANNELS
        or parameters.get("sampleRate") != SAMPLE_RATE
        or parameters.get("taskType") != "cover"
        or parameters.get("thinking") is not False
        or parameters.get("inferenceSteps") != INFERENCE_STEPS
        or parameters.get("guidanceScale") != GUIDANCE_SCALE
        or parameters.get("coverNoiseStrength") != 0.0
        or not isinstance(parameters.get("instrumental"), bool)
    ):
        fail("ACE_STEP_PARAMETERS_INVALID", "ACE-Step Cover output and fixed v0.1 parameters are invalid.")
    caption = parameters.get("caption")
    cover_strength = parameters.get("audioCoverStrength")
    duration = parameters.get("durationSeconds")
    seed = parameters.get("seed")
    language = parameters.get("vocalLanguage")
    if (
        not isinstance(caption, str)
        or not caption
        or caption.strip() != caption
        or len(caption) > 2_000
        or not finite_number(cover_strength)
        or cover_strength < 0
        or cover_strength > 1
        or not finite_number(duration)
        or duration < MIN_DURATION_SECONDS
        or duration > MAX_DURATION_SECONDS
        or not isinstance(seed, int)
        or isinstance(seed, bool)
        or seed < 0
        or seed > 0xFFFFFFFF
        or not isinstance(language, str)
        or (language != "unknown" and re.fullmatch(r"[a-z]{2}", language) is None)
    ):
        fail("ACE_STEP_PARAMETERS_INVALID", "ACE-Step Cover generation parameters are invalid.")


def validate_inputs(
    guide_path: Path | None,
    lyrics_path: Path,
    duration_seconds: float,
    torchaudio_module: Any,
    torch_module: Any,
) -> dict[str, Any]:
    validate_regular_lyrics_input(lyrics_path)
    if guide_path is None:
        return {"lyrics": file_identity(lyrics_path)}
    validate_regular_audio_input(guide_path)
    try:
        waveform, sample_rate = torchaudio_module.load(str(guide_path))
    except Exception as error:
        raise AceStepHostError("ACE_STEP_INPUT_INVALID", "ACE-Step Guide Audio could not be decoded.") from error
    if (
        sample_rate not in SUPPORTED_GUIDE_SAMPLE_RATES
        or waveform.ndim != 2
        or waveform.shape[0] not in {1, 2}
        or waveform.shape[1] <= 0
        or not torch_module.isfinite(waveform).all().item()
        or not waveform.abs().max().item() > 1e-8
        or abs(waveform.shape[1] / sample_rate - duration_seconds) > 0.1
    ):
        fail("ACE_STEP_INPUT_INVALID", "ACE-Step Guide Audio does not match the requested duration and profile.")
    return {
        "guide": file_identity(guide_path),
        "lyrics": file_identity(lyrics_path),
    }


def validate_regular_audio_input(path: Path) -> None:
    if not path.is_absolute() or path.suffix.lower() != ".wav":
        fail("ACE_STEP_INPUT_INVALID", "ACE-Step Guide Audio must be an absolute WAV path.")
    validate_regular_file(path, None, None, maximum_size=MAX_INPUT_BYTES)


def validate_regular_lyrics_input(path: Path) -> None:
    if not path.is_absolute() or path.suffix.lower() != ".txt":
        fail("ACE_STEP_INPUT_INVALID", "ACE-Step Lyrics must be an absolute TXT path.")
    validate_regular_file(path, None, None, maximum_size=MAX_LYRICS_BYTES)


def read_lyrics(path: Path) -> str:
    try:
        raw_bytes = path.read_bytes()
        if raw_bytes.startswith(b"\xef\xbb\xbf"):
            raise ValueError("BOM is not allowed")
        lyrics = raw_bytes.decode("utf-8")
    except (OSError, UnicodeError, ValueError) as error:
        raise AceStepHostError("ACE_STEP_INPUT_INVALID", "ACE-Step Lyrics must be BOM-less UTF-8.") from error
    if not lyrics.strip() or len(lyrics) > 4_096:
        fail("ACE_STEP_INPUT_INVALID", "ACE-Step Lyrics must contain 1 through 4096 characters.")
    return lyrics


def validate_execution_paths(staging_path: Path, partial_wav_path: Path) -> None:
    validate_reserved_staging_path(staging_path)
    if (
        not partial_wav_path.is_absolute()
        or str(partial_wav_path).lower() != f"{str(staging_path).lower()}.wav"
        or not str(partial_wav_path).lower().endswith(".partial.wav")
        or partial_wav_path.parent != staging_path.parent
        or os.path.lexists(partial_wav_path)
    ):
        fail("ACE_STEP_STAGING_INVALID", "ACE-Step partial WAV staging path is invalid.")


def validate_reserved_staging_path(staging_path: Path) -> None:
    if not staging_path.is_absolute() or not str(staging_path).lower().endswith(".partial"):
        fail("ACE_STEP_STAGING_INVALID", "ACE-Step output must use an absolute .partial reservation.")
    validate_directory(staging_path.parent, "ACE_STEP_STAGING_INVALID")
    try:
        staging_stat = os.lstat(staging_path)
    except OSError as error:
        raise AceStepHostError("ACE_STEP_STAGING_INVALID", "ACE-Step staging reservation is unavailable.") from error
    if (
        not stat.S_ISREG(staging_stat.st_mode)
        or is_reparse_point(staging_stat)
        or staging_path.is_symlink()
        or staging_stat.st_size != 0
    ):
        fail("ACE_STEP_STAGING_INVALID", "ACE-Step staging reservation is invalid.")


def validate_generation_result(
    result: Any,
    generation_directory: Path,
    duration_seconds: float,
    torch_module: Any,
) -> Path:
    if not getattr(result, "success", False) or len(getattr(result, "audios", [])) != 1:
        fail("ACE_STEP_RESULT_INVALID", "ACE-Step did not return exactly one successful audio result.")
    audio = result.audios[0]
    tensor = audio.get("tensor") if isinstance(audio, dict) else None
    path_value = audio.get("path") if isinstance(audio, dict) else None
    sample_rate = audio.get("sample_rate") if isinstance(audio, dict) else None
    if (
        tensor is None
        or sample_rate != SAMPLE_RATE
        or tensor.ndim != 2
        or tensor.shape[0] != CHANNELS
        or tensor.shape[1] <= 0
        or not torch_module.isfinite(tensor).all().item()
        or not tensor.abs().max().item() > 1e-8
        or abs(tensor.shape[1] / SAMPLE_RATE - duration_seconds) > 0.1
        or not isinstance(path_value, str)
    ):
        fail("ACE_STEP_RESULT_INVALID", "ACE-Step generated audio samples are invalid.")
    generated_path = Path(path_value)
    if not generated_path.is_absolute():
        fail("ACE_STEP_RESULT_INVALID", "ACE-Step generated output path is invalid.")
    validate_regular_file(generated_path, None, generation_directory)
    if generated_path.parent.resolve() != generation_directory.resolve():
        fail("ACE_STEP_RESULT_INVALID", "ACE-Step generated output escaped its temporary directory.")
    output_files = [path for path in generation_directory.iterdir() if path.is_file()]
    if output_files != [generated_path] or generated_path.suffix.lower() != ".wav":
        fail("ACE_STEP_RESULT_INVALID", "ACE-Step generated an unexpected output set.")
    return generated_path


def validate_saved_output_samples(
    path: Path,
    duration_seconds: float,
    torchaudio_module: Any,
    torch_module: Any,
) -> None:
    try:
        waveform, sample_rate = torchaudio_module.load(str(path))
    except Exception as error:
        raise AceStepHostError(
            "ACE_STEP_RESULT_INVALID",
            "ACE-Step staged output could not be decoded.",
        ) from error
    if (
        sample_rate != SAMPLE_RATE
        or waveform.ndim != 2
        or waveform.shape[0] != CHANNELS
        or waveform.shape[1] <= 0
        or not torch_module.isfinite(waveform).all().item()
        or not waveform.abs().max().item() > 1e-8
        or abs(waveform.shape[1] / sample_rate - duration_seconds) > 0.1
    ):
        fail(
            "ACE_STEP_RESULT_INVALID",
            "ACE-Step staged output samples are invalid.",
        )


def inspect_wave(path: Path) -> dict[str, Any]:
    try:
        size_bytes = path.stat().st_size
        with path.open("rb") as source:
            header = source.read(12)
            if (
                len(header) != 12
                or header[:4] != b"RIFF"
                or header[8:] != b"WAVE"
                or struct.unpack_from("<I", header, 4)[0] + 8 != size_bytes
            ):
                raise ValueError("invalid RIFF header")
            format_fields = None
            data_size = None
            offset = 12
            while offset + 8 <= size_bytes:
                source.seek(offset)
                chunk_header = source.read(8)
                chunk_id = chunk_header[:4]
                chunk_size = struct.unpack_from("<I", chunk_header, 4)[0]
                chunk_start = offset + 8
                padded_end = chunk_start + chunk_size + (chunk_size % 2)
                if padded_end > size_bytes:
                    raise ValueError("incomplete WAVE chunk")
                if chunk_id == b"fmt ":
                    if format_fields is not None or chunk_size < 16:
                        raise ValueError("invalid format chunk")
                    source.seek(chunk_start)
                    format_fields = struct.unpack("<HHIIHH", source.read(16))
                elif chunk_id == b"data":
                    if data_size is not None or chunk_size == 0:
                        raise ValueError("invalid data chunk")
                    data_size = chunk_size
                offset = padded_end
            if offset != size_bytes or format_fields is None or data_size is None:
                raise ValueError("incomplete WAVE")
    except (OSError, ValueError, struct.error) as error:
        raise AceStepHostError("ACE_STEP_RESULT_INVALID", "ACE-Step output is not a supported WAVE file.") from error

    format_tag, channels, sample_rate, byte_rate, block_align, bits_per_sample = format_fields
    return {
        "bitsPerSample": bits_per_sample,
        "blockAlign": block_align,
        "byteRate": byte_rate,
        "channels": channels,
        "dataSize": data_size,
        "durationSeconds": data_size / byte_rate if byte_rate > 0 else 0,
        "formatTag": format_tag,
        "sampleRate": sample_rate,
    }


def validate_output_wave(output: dict[str, Any], duration_seconds: float) -> None:
    supported_format = (output["formatTag"], output["bitsPerSample"]) in {(1, 16), (3, 32)}
    expected_block_align = output["channels"] * output["bitsPerSample"] // 8
    if (
        not supported_format
        or output["channels"] != CHANNELS
        or output["sampleRate"] != SAMPLE_RATE
        or output["blockAlign"] != expected_block_align
        or output["byteRate"] != SAMPLE_RATE * expected_block_align
        or output["dataSize"] % expected_block_align != 0
        or abs(output["durationSeconds"] - duration_seconds) > 0.1
    ):
        fail("ACE_STEP_RESULT_INVALID", "ACE-Step output WAVE metadata is invalid.")


def file_identity(path: Path) -> tuple[int, int, int, str]:
    file_stat = path.stat()
    return (file_stat.st_size, file_stat.st_mtime_ns, file_stat.st_ctime_ns, sha256(path))


def validate_unchanged_inputs(
    guide_path: Path | None,
    lyrics_path: Path,
    snapshot: dict[str, Any],
) -> None:
    guide_changed = guide_path is not None and file_identity(guide_path) != snapshot.get("guide")
    if guide_changed or file_identity(lyrics_path) != snapshot["lyrics"]:
        fail("ACE_STEP_INPUT_CHANGED", "ACE-Step inputs changed during execution.")


def validate_directory(path: Path, code: str) -> None:
    try:
        path_stat = os.lstat(path)
    except OSError as error:
        raise AceStepHostError(code, "ACE-Step required directory is unavailable.") from error
    if not stat.S_ISDIR(path_stat.st_mode) or is_reparse_point(path_stat) or path.is_symlink():
        fail(code, "ACE-Step required directory is invalid.")


def validate_regular_file(
    path: Path,
    expected_size: int | None,
    containment_root: Path | None,
    maximum_size: int | None = None,
) -> None:
    if containment_root is not None:
        try:
            relative_parts = path.relative_to(containment_root).parts
        except ValueError as error:
            raise AceStepHostError("ACE_STEP_FILE_INVALID", "ACE-Step file escaped its declared root.") from error
        current_path = containment_root
        for part in relative_parts[:-1]:
            current_path = current_path / part
            validate_directory(current_path, "ACE_STEP_FILE_INVALID")
    try:
        path_stat = os.lstat(path)
    except OSError as error:
        raise AceStepHostError("ACE_STEP_FILE_INVALID", "ACE-Step required file is unavailable.") from error
    if (
        not stat.S_ISREG(path_stat.st_mode)
        or is_reparse_point(path_stat)
        or path.is_symlink()
        or path_stat.st_size <= 0
        or (expected_size is not None and path_stat.st_size != expected_size)
        or (maximum_size is not None and path_stat.st_size > maximum_size)
    ):
        fail("ACE_STEP_FILE_INVALID", "ACE-Step required file metadata is invalid.")
    if containment_root is not None:
        try:
            path.resolve().relative_to(containment_root.resolve())
        except ValueError as error:
            raise AceStepHostError("ACE_STEP_FILE_INVALID", "ACE-Step file escaped its declared root.") from error


def is_reparse_point(path_stat: os.stat_result) -> bool:
    return bool(getattr(path_stat, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(HASH_BUFFER_BYTES), b""):
                digest.update(chunk)
    except OSError as error:
        raise AceStepHostError("ACE_STEP_FILE_UNREADABLE", "ACE-Step could not read a required file.") from error
    return digest.hexdigest()


def fsync_file(path: Path) -> None:
    try:
        with path.open("r+b") as output_file:
            output_file.flush()
            os.fsync(output_file.fileno())
    except OSError as error:
        raise AceStepHostError("ACE_STEP_STAGING_INVALID", "ACE-Step could not synchronize staged output.") from error


def require_model_identity(payload: Any) -> None:
    if (
        not isinstance(payload, dict)
        or set(payload) != {"modelId", "revision"}
        or payload.get("modelId") != MODEL_ID
        or payload.get("revision") != MODEL_REVISION
    ):
        fail("MODEL_INCOMPATIBLE", "ACE-Step host cannot load the requested Model or revision.")


def valid_path_artifact(value: Any, kind: str) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == {"artifactId", "kind", "path"}
        and valid_identity(value.get("artifactId"))
        and value.get("kind") == kind
        and isinstance(value.get("path"), str)
    )


def valid_identity(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) <= 128
        and re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value) is not None
    )


def finite_number(value: Any) -> bool:
    return isinstance(value, numbers.Real) and not isinstance(value, bool) and math.isfinite(value)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def fail(code: str, message: str) -> None:
    raise AceStepHostError(code, message)


def send_message(message: dict[str, Any]) -> None:
    line = json.dumps(message, separators=(",", ":"), allow_nan=False)
    with SEND_MESSAGE_LOCK:
        PROTOCOL_OUTPUT.write(line)
        PROTOCOL_OUTPUT.write("\n")
        PROTOCOL_OUTPUT.flush()


def send_progress(request_id: str, progress: dict[str, Any]) -> None:
    send_message({
        "event": "progress",
        "progress": progress,
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
    })


def send_success(request_id: str, result: Any) -> None:
    send_message({"ok": True, "protocolVersion": PROTOCOL_VERSION, "requestId": request_id, "result": result})


def send_failure(request_id: str, code: str, message: str) -> None:
    send_message({
        "error": {"code": code, "message": message},
        "ok": False,
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
    })


def handle_request(host: AceStepHost, message: Any) -> bool:
    if not isinstance(message, dict):
        return True
    request_id = message.get("requestId")
    if not isinstance(request_id, str) or not request_id:
        return True
    if message.get("protocolVersion") != PROTOCOL_VERSION:
        send_failure(request_id, "ACE_STEP_PROTOCOL_INVALID", "ACE-Step Python host protocol version is invalid.")
        return True

    try:
        operation = message.get("operation")
        if operation == "inspect":
            result = host.inspect()
        elif operation == "load-model":
            result = host.load_model(message.get("payload"))
        elif operation == "execute":
            result = host.execute(
                message.get("payload"),
                lambda progress: send_progress(request_id, progress),
            )
        elif operation == "unload-model":
            result = host.unload_model()
        elif operation == "shutdown":
            result = host.shutdown()
        else:
            fail("ACE_STEP_OPERATION_UNSUPPORTED", "ACE-Step Python host operation is unsupported.")
        send_success(request_id, result)
        return operation != "shutdown"
    except AceStepHostError as error:
        send_failure(request_id, error.code, str(error))
    except BaseException:
        send_failure(request_id, "ACE_STEP_HOST_FAILED", "ACE-Step Python host operation failed.")
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoints-root", required=True)
    args = parser.parse_args()
    checkpoints_root = Path(args.checkpoints_root)
    if not checkpoints_root.is_absolute():
        raise SystemExit("ACE-Step Checkpoints Root must be absolute.")
    host = AceStepHost(checkpoints_root)

    while True:
        raw_line = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
        if not raw_line:
            host.shutdown()
            return 0
        if len(raw_line) > MAX_REQUEST_BYTES or not raw_line.endswith(b"\n"):
            host.shutdown()
            return 1
        try:
            message = json.loads(raw_line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            host.shutdown()
            return 1
        if not handle_request(host, message):
            return 0


if __name__ == "__main__":
    raise SystemExit(main())
