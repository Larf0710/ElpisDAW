from __future__ import annotations

import argparse
import contextlib
import copy
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
import subprocess
import sys
import threading
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import unquote, urlparse


PROTOCOL_VERSION = "1"
PROFILE_ID = (
    "windows-x64-cpython-3-10-pytorch-2-7-1-cu126-"
    "flash-attention-2-8-3"
)
PROVIDER_ID = "local-stable-audio-3"
PROVIDER_VERSION = "0.1.0"
PROVIDER_CODE_REVISION = "9ae61a0ae72fb22c80caf00378c61882fff25921"
AUDIO_TO_AUDIO_TASK_ID = "audio-to-audio"
TEXT_TO_AUDIO_TASK_ID = "text-to-audio"
SUPPORTED_TASK_IDS = frozenset({AUDIO_TO_AUDIO_TASK_ID, TEXT_TO_AUDIO_TASK_ID})
MODEL_ID = "stable-audio-3-medium"
MODEL_REPOSITORY = "stabilityai/stable-audio-3-medium"
MODEL_REVISION = "27b5a21b791b1b033d193a9e1e3ce78493f102f9"
PYTORCH_VERSION = "2.7.1"
TORCHAUDIO_VERSION = "2.7.1"
FLASH_ATTENTION_VERSION = "2.8.3"
CUDA_VERSION = "12.6"
TARGET_GPU_NAME = "NVIDIA GeForce RTX 4060 Ti"
MINIMUM_GPU_MEMORY_MIB = 12 * 1024
SAMPLE_RATE = 44_100
CHANNELS = 2
MAX_DURATION_SECONDS = 380
MAX_INPUT_BYTES = 512 * 1024 * 1024
MAX_REQUEST_BYTES = 64 * 1024
HASH_BUFFER_BYTES = 8 * 1024 * 1024
INFERENCE_STEPS = 8
CFG_SCALE = 1.0
CHUNKED_DECODE = True
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
AUDIO_TO_AUDIO_PARAMETER_KEYS = {
    "channels",
    "durationSeconds",
    "prompt",
    "sampleRate",
    "seed",
    "sourceEndSeconds",
    "sourceStartSeconds",
    "strength",
}
TEXT_TO_AUDIO_PARAMETER_KEYS = {
    "channels",
    "durationSeconds",
    "prompt",
    "sampleRate",
    "seed",
}
MODEL_FILES = (
    (
        ".gitattributes",
        1716,
        "ad05eef8ec7bef9177cb5c4fca74241860ee9d5355a845608490d6d0af4e5628",
    ),
    (
        "LICENSE.md",
        11852,
        "d6f6b1a4dce5c852bd6d7d9482d002baf0ccdb71e662250b73be9eec8764ee8d",
    ),
    (
        "LICENSE_GEMMA.md",
        10541,
        "e77acc0d3163bb7534675045c584b4d04b387b529239fc4b3647da0a01ba4745",
    ),
    (
        "NOTICE",
        97,
        "66f856d7da72797f528fca46b7c80634ab481f917bfe020960e123d84b19f75f",
    ),
    (
        "README.md",
        6086,
        "ac3429a3b331d9846ebab26cc5ae6a0469efda9640c367e1f47c018d894c1452",
    ),
    (
        "Stable_Audio_3.0_Thumbnail_1x1.png",
        1462873,
        "a9834815023e381f367ed5e63a4cf6276a75b876b6fd6076f633e3135b786512",
    ),
    (
        "model.safetensors",
        9222116660,
        "48d9c65e290e7bcd5194e0633bfc2424a59ee9683f5c2d58762d997b7d8ce0b5",
    ),
    (
        "model_config.json",
        10360,
        "4f8846649df59167e1792d134acb6fc2bb7105227c5455300bad6cb107e20c88",
    ),
    (
        "t5gemma-b-b-ul2/.gitattributes",
        1570,
        "34448b82c17d60fec9b65b1f093c115ddbaadc04beb1b0140b6bfed2e012a930",
    ),
    (
        "t5gemma-b-b-ul2/README.md",
        18296,
        "6a96748c87d323d6080d037191346e68c3eda39c34c0530cb4f7f3bd8cc20319",
    ),
    (
        "t5gemma-b-b-ul2/config.json",
        2540,
        "575334409716886ac2952f5a275ed92868deef8a0ea560258d9970a431c6fb3a",
    ),
    (
        "t5gemma-b-b-ul2/generation_config.json",
        156,
        "1068b94599a94ceea097dd3936819f108c2e70806d7c6cc5ec425610af347625",
    ),
    (
        "t5gemma-b-b-ul2/model.safetensors",
        1183022944,
        "9b05ea5a4f211d023832f706fb2c0e83e4fc721b6da35ab69ceb0b55eb7800d3",
    ),
    (
        "t5gemma-b-b-ul2/special_tokens_map.json",
        636,
        "baec30ea10906f16adb8c18af7a34023002c1746542612b8b41c9f09e1351351",
    ),
    (
        "t5gemma-b-b-ul2/tokenizer.json",
        34362429,
        "7794135caa3ea73918949c902a781cc61dab674a4b59c17d85931c77c1114cbd",
    ),
    (
        "t5gemma-b-b-ul2/tokenizer.model",
        4241003,
        "61a7b147390c64585d6c3543dd6fc636906c9af3865a5548f27f31aee1d4c8e2",
    ),
    (
        "t5gemma-b-b-ul2/tokenizer_config.json",
        46437,
        "9546baec0dfefec0e29873edea9488ecde153f846e18c06ea48cb44587bf408f",
    ),
)


class StableAudio3HostError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class StableAudio3Host:
    def __init__(self, model_root: Path) -> None:
        self._loaded_at: str | None = None
        self._model: Any = None
        self._model_root = model_root
        self._torch: Any = None
        self._torchaudio: Any = None

    def inspect(self) -> dict[str, Any]:
        verify_offline_environment()
        verify_runtime_profile()
        verify_provider_checkout()
        validate_model_root(self._model_root, verify_hashes=False)
        return {
            "cfgScale": CFG_SCALE,
            "chunkedDecode": CHUNKED_DECODE,
            "flashAttentionVersion": FLASH_ATTENTION_VERSION,
            "inferenceSteps": INFERENCE_STEPS,
            "modelId": MODEL_ID,
            "modelRevision": MODEL_REVISION,
            "offline": True,
            "profileId": PROFILE_ID,
            "providerCodeRevision": PROVIDER_CODE_REVISION,
            "providerVersion": PROVIDER_VERSION,
            "pytorchVersion": PYTORCH_VERSION,
            "status": "READY",
            "torchaudioVersion": TORCHAUDIO_VERSION,
        }

    def load_model(self, payload: Any) -> dict[str, Any]:
        require_model_identity(payload)

        if self._model is not None and self._loaded_at is not None:
            return self._loaded_result()

        self.inspect()
        validate_model_root(self._model_root, verify_hashes=True)
        model_config = create_local_model_config(self._model_root)

        try:
            with contextlib.redirect_stdout(sys.stderr):
                import torch
                import torchaudio
                from stable_audio_3 import StableAudioModel
                from stable_audio_3.loading_utils import load_diffusion_cond

                raw_model = load_diffusion_cond(
                    model_config,
                    str(self._model_root / "model.safetensors"),
                    device="cuda",
                    model_half=True,
                )
                model = StableAudioModel(raw_model, model_config, "cuda", True)
                torch.cuda.synchronize()
        except StableAudio3HostError:
            raise
        except Exception as error:
            raise StableAudio3HostError(
                "STABLE_AUDIO_3_MODEL_LOAD_FAILED",
                "Stable Audio 3 could not load the pinned offline Model.",
            ) from error

        self._model = model
        self._torch = torch
        self._torchaudio = torchaudio
        self._loaded_at = utc_now()
        return self._loaded_result()

    def execute(
        self,
        payload: Any,
        progress_callback: Callable[[dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        if self._model is None or self._torch is None or self._torchaudio is None:
            fail("MODEL_NOT_LOADED", "Load the Stable Audio 3 Model before execution.")

        job = validate_job(payload)
        input_path = (
            Path(job["inputArtifacts"][0]["path"])
            if job["taskId"] == AUDIO_TO_AUDIO_TASK_ID
            else None
        )
        staging_path = Path(job["output"]["stagingPath"])
        partial_wav_path = Path(job["output"]["partialWavPath"])
        validate_execution_paths(input_path, staging_path, partial_wav_path)
        parameters = job["parameters"]
        last_reported_step = 0

        def report_progress(callback_info: Any) -> None:
            nonlocal last_reported_step
            if progress_callback is None or not isinstance(callback_info, dict):
                return
            step_index = callback_info.get("i")
            if (
                not isinstance(step_index, numbers.Integral)
                or isinstance(step_index, bool)
                or step_index < 0
                or step_index >= INFERENCE_STEPS
            ):
                return
            current_step = int(step_index) + 1
            if current_step <= last_reported_step:
                return
            last_reported_step = current_step
            progress_callback({
                "accuracy": "MEASURED",
                "currentStep": current_step,
                "percent": round(current_step / INFERENCE_STEPS * 100),
                "totalSteps": INFERENCE_STEPS,
            })

        try:
            generation_arguments = {
                "prompt": parameters["prompt"],
                "duration": parameters["durationSeconds"],
                "steps": INFERENCE_STEPS,
                "cfg_scale": CFG_SCALE,
                "seed": parameters["seed"],
                "batch_size": 1,
                "sample_size": self._model.model_config["sample_size"],
                "chunked_decode": CHUNKED_DECODE,
                "callback": report_progress,
            }

            if input_path is not None:
                waveform, input_sample_rate = self._torchaudio.load(str(input_path))
                selected_waveform = select_source_range(
                    waveform,
                    input_sample_rate,
                    parameters["sourceStartSeconds"],
                    parameters["sourceEndSeconds"],
                    self._torch,
                )
                generation_arguments["init_audio"] = (
                    input_sample_rate,
                    selected_waveform,
                )
                generation_arguments["init_noise_level"] = parameters["strength"]

            with contextlib.redirect_stdout(sys.stderr):
                generated = self._model.generate(**generation_arguments)
                self._torch.cuda.synchronize()

            if generated.ndim != 3 or generated.shape[0] != 1:
                fail(
                    "STABLE_AUDIO_3_RESULT_INVALID",
                    "Stable Audio 3 generated audio tensor shape is invalid.",
                )

            output_tensor = generated[0].detach().to(self._torch.float32).cpu()
            if (
                output_tensor.ndim != 2
                or output_tensor.shape[0] != CHANNELS
                or output_tensor.numel() == 0
                or not self._torch.isfinite(output_tensor).all().item()
            ):
                fail(
                    "STABLE_AUDIO_3_RESULT_INVALID",
                    "Stable Audio 3 generated audio samples are invalid.",
                )

            self._torchaudio.save(
                str(partial_wav_path),
                output_tensor,
                SAMPLE_RATE,
                format="wav",
                encoding="PCM_S",
                bits_per_sample=16,
            )
            output = inspect_wave(partial_wav_path)
            validate_output_wave(output, parameters["durationSeconds"])
            fsync_file(partial_wav_path)
            validate_reserved_staging_path(staging_path)
            os.replace(partial_wav_path, staging_path)
            output_sha256 = sha256(staging_path)
            output_size = staging_path.stat().st_size
        except StableAudio3HostError:
            raise
        except Exception as error:
            raise StableAudio3HostError(
                "STABLE_AUDIO_3_INFERENCE_FAILED",
                "Stable Audio 3 audio generation failed.",
            ) from error
        finally:
            try:
                partial_wav_path.unlink(missing_ok=True)
            except OSError:
                pass

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
        was_loaded = self._model is not None
        self._release_model()
        return {
            **(
                {"modelId": MODEL_ID, "revision": MODEL_REVISION}
                if was_loaded
                else {}
            ),
            "status": "UNLOADED",
            "unloadedAt": utc_now(),
        }

    def shutdown(self) -> dict[str, str]:
        self._release_model()
        return {"status": "SHUTDOWN"}

    def _loaded_result(self) -> dict[str, str]:
        if self._loaded_at is None:
            fail(
                "STABLE_AUDIO_3_HOST_STATE_INVALID",
                "Stable Audio 3 Model state is invalid.",
            )

        return {
            "loadedAt": self._loaded_at,
            "modelId": MODEL_ID,
            "revision": MODEL_REVISION,
            "status": "LOADED",
        }

    def _release_model(self) -> None:
        torch_module = self._torch
        self._model = None
        self._torch = None
        self._torchaudio = None
        self._loaded_at = None
        gc.collect()

        if torch_module is not None:
            try:
                torch_module.cuda.empty_cache()
            except Exception:
                pass


def verify_offline_environment() -> None:
    if (
        os.environ.get("HF_HUB_OFFLINE") != "1"
        or os.environ.get("TRANSFORMERS_OFFLINE") != "1"
    ):
        fail(
            "STABLE_AUDIO_3_OFFLINE_REQUIRED",
            "Stable Audio 3 requires offline model loading.",
        )


def verify_runtime_profile() -> None:
    if sys.implementation.name != "cpython" or sys.version_info[:2] != (3, 10):
        fail(
            "STABLE_AUDIO_3_RUNTIME_INVALID",
            "Stable Audio 3 requires CPython 3.10.",
        )
    if sys.maxsize <= 2**32 or sys.platform != "win32":
        fail(
            "STABLE_AUDIO_3_RUNTIME_INVALID",
            "Stable Audio 3 requires 64-bit Windows.",
        )
    if platform.machine().lower() not in {"amd64", "x86_64"}:
        fail(
            "STABLE_AUDIO_3_RUNTIME_INVALID",
            "Stable Audio 3 requires an x64 host.",
        )

    expected_versions = {
        "stable-audio-3": PROVIDER_VERSION,
        "torch": PYTORCH_VERSION,
        "torchaudio": TORCHAUDIO_VERSION,
    }

    try:
        installed_versions = {
            package: base_version(importlib.metadata.version(package))
            for package in expected_versions
        }
        flash_attention_version = read_flash_attention_version()
    except importlib.metadata.PackageNotFoundError as error:
        raise StableAudio3HostError(
            "STABLE_AUDIO_3_RUNTIME_INVALID",
            "Stable Audio 3 runtime packages are incomplete.",
        ) from error

    if installed_versions != expected_versions or flash_attention_version != FLASH_ATTENTION_VERSION:
        fail(
            "STABLE_AUDIO_3_RUNTIME_INVALID",
            "Stable Audio 3 runtime package versions do not match the pinned profile.",
        )

    try:
        with contextlib.redirect_stdout(sys.stderr):
            import flash_attn
            import torch

        if (
            base_version(torch.__version__) != PYTORCH_VERSION
            or torch.version.cuda != CUDA_VERSION
            or not torch.cuda.is_available()
            or torch.cuda.device_count() != 1
        ):
            fail(
                "STABLE_AUDIO_3_RUNTIME_INVALID",
                "Stable Audio 3 CUDA runtime does not match the pinned profile.",
            )

        device = torch.cuda.get_device_properties(0)
        total_memory_mib = device.total_memory // (1024 * 1024)
        if device.name != TARGET_GPU_NAME or total_memory_mib < MINIMUM_GPU_MEMORY_MIB:
            fail(
                "STABLE_AUDIO_3_RUNTIME_INVALID",
                "Stable Audio 3 GPU does not match the pinned profile.",
            )

        if base_version(flash_attn.__version__) != FLASH_ATTENTION_VERSION:
            fail(
                "STABLE_AUDIO_3_RUNTIME_INVALID",
                "Stable Audio 3 Flash Attention import does not match the pinned profile.",
            )
    except StableAudio3HostError:
        raise
    except Exception as error:
        raise StableAudio3HostError(
            "STABLE_AUDIO_3_RUNTIME_INVALID",
            "Stable Audio 3 CUDA runtime validation failed.",
        ) from error


def read_flash_attention_version() -> str:
    for package in ("flash-attn", "flash_attn"):
        try:
            return base_version(importlib.metadata.version(package))
        except importlib.metadata.PackageNotFoundError:
            continue
    raise importlib.metadata.PackageNotFoundError("flash-attn")


def verify_provider_checkout() -> None:
    try:
        distribution = importlib.metadata.distribution("stable-audio-3")
        direct_url_text = distribution.read_text("direct_url.json")
        if direct_url_text is None or len(direct_url_text) > 16 * 1024:
            raise ValueError("direct URL metadata is unavailable")
        direct_url = json.loads(direct_url_text)
        parsed_url = urlparse(direct_url["url"])
        if (
            parsed_url.scheme != "file"
            or parsed_url.netloc not in {"", "localhost"}
            or parsed_url.query
            or parsed_url.fragment
            or direct_url.get("dir_info") != {"editable": True}
        ):
            raise ValueError("provider installation is not the pinned checkout")

        provider_path_text = unquote(parsed_url.path)
        if re.match(r"^/[A-Za-z]:/", provider_path_text):
            provider_path_text = provider_path_text[1:]
        provider_root = Path(provider_path_text)
        if not provider_root.is_absolute():
            raise ValueError("provider checkout path is not absolute")
        validate_directory(provider_root, "STABLE_AUDIO_3_PROVIDER_INVALID")
        validate_directory(provider_root / ".git", "STABLE_AUDIO_3_PROVIDER_INVALID")
        provider_init_path = provider_root / "stable_audio_3" / "__init__.py"
        provider_init_stat = os.lstat(provider_init_path)
        if (
            not stat.S_ISREG(provider_init_stat.st_mode)
            or is_reparse_point(provider_init_stat)
            or provider_init_path.is_symlink()
        ):
            raise ValueError("provider package path is invalid")

        git_path_text = shutil.which("git")
        if git_path_text is None:
            raise ValueError("Git is unavailable")
        git_path = Path(git_path_text)
        git_stat = os.lstat(git_path)
        if not stat.S_ISREG(git_stat.st_mode) or is_reparse_point(git_stat):
            raise ValueError("Git executable is invalid")

        git_environment = dict(os.environ)
        git_environment["GIT_OPTIONAL_LOCKS"] = "0"
        git_environment["GIT_TERMINAL_PROMPT"] = "0"
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        revision = subprocess.run(
            [str(git_path), "-C", str(provider_root), "rev-parse", "--verify", "HEAD"],
            capture_output=True,
            check=False,
            creationflags=creation_flags,
            env=git_environment,
            text=True,
            timeout=10,
        )
        status = subprocess.run(
            [
                str(git_path),
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
            or len(revision.stdout) > 128
            or len(status.stdout) > 64 * 1024
        ):
            raise ValueError("provider checkout identity mismatch")
    except StableAudio3HostError:
        raise
    except Exception as error:
        raise StableAudio3HostError(
            "STABLE_AUDIO_3_PROVIDER_INVALID",
            "Stable Audio 3 Provider checkout does not match the pinned revision.",
        ) from error


def validate_model_root(model_root: Path, verify_hashes: bool) -> None:
    validate_directory(model_root, "STABLE_AUDIO_3_MODEL_INVALID")
    if model_root.name != MODEL_REVISION:
        fail(
            "STABLE_AUDIO_3_MODEL_INVALID",
            "Stable Audio 3 Model Root must use the pinned revision directory.",
        )

    for relative_path, expected_size, expected_sha256 in MODEL_FILES:
        model_path = model_root.joinpath(*relative_path.split("/"))
        validate_model_file(model_root, model_path, expected_size)
        if verify_hashes and sha256(model_path) != expected_sha256:
            fail(
                "STABLE_AUDIO_3_MODEL_INVALID",
                "Stable Audio 3 Model file SHA-256 does not match the pinned revision.",
            )


def validate_model_file(model_root: Path, model_path: Path, expected_size: int) -> None:
    current_path = model_root
    relative_parts = model_path.relative_to(model_root).parts

    for part in relative_parts[:-1]:
        current_path = current_path / part
        validate_directory(current_path, "STABLE_AUDIO_3_MODEL_INVALID")

    try:
        model_stat = os.lstat(model_path)
    except OSError as error:
        raise StableAudio3HostError(
            "STABLE_AUDIO_3_MODEL_INVALID",
            "Stable Audio 3 pinned Model files are unavailable.",
        ) from error

    if (
        not stat.S_ISREG(model_stat.st_mode)
        or is_reparse_point(model_stat)
        or model_path.is_symlink()
        or model_stat.st_size != expected_size
    ):
        fail(
            "STABLE_AUDIO_3_MODEL_INVALID",
            "Stable Audio 3 pinned Model file metadata does not match.",
        )


def create_local_model_config(model_root: Path) -> dict[str, Any]:
    try:
        with (model_root / "model_config.json").open("r", encoding="utf-8") as source:
            model_config = copy.deepcopy(json.load(source))
        conditioner_configs = model_config["model"]["conditioning"]["configs"]
        prompt_configs = [
            entry
            for entry in conditioner_configs
            if entry.get("id") == "prompt" and entry.get("type") == "t5gemma"
        ]
        if len(prompt_configs) != 1:
            raise ValueError("prompt conditioner mismatch")
        prompt_config = prompt_configs[0]["config"]
        if (
            prompt_config.get("repo_id") != MODEL_REPOSITORY
            or prompt_config.get("subfolder") != "t5gemma-b-b-ul2"
        ):
            raise ValueError("text encoder identity mismatch")
        prompt_config.pop("repo_id")
        prompt_config.pop("subfolder")
        prompt_config["model_path"] = str(model_root / "t5gemma-b-b-ul2")
        return model_config
    except Exception as error:
        raise StableAudio3HostError(
            "STABLE_AUDIO_3_MODEL_INVALID",
            "Stable Audio 3 pinned Model configuration is invalid.",
        ) from error


def validate_job(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != EXPECTED_JOB_KEYS:
        fail("STABLE_AUDIO_3_JOB_INVALID", "Stable Audio 3 Job is invalid.")
    task_id = value.get("taskId")
    if (
        value.get("providerId") != PROVIDER_ID
        or task_id not in SUPPORTED_TASK_IDS
        or value.get("modelId") != MODEL_ID
        or value.get("modelRevision") != MODEL_REVISION
        or not valid_identity(value.get("jobId"))
    ):
        fail(
            "STABLE_AUDIO_3_JOB_UNSUPPORTED",
            "Stable Audio 3 Job identity is unsupported.",
        )

    input_artifacts = value.get("inputArtifacts")
    if task_id == AUDIO_TO_AUDIO_TASK_ID and (
        not isinstance(input_artifacts, list)
        or len(input_artifacts) != 1
        or not isinstance(input_artifacts[0], dict)
        or set(input_artifacts[0]) != {"artifactId", "kind", "path"}
        or not valid_identity(input_artifacts[0].get("artifactId"))
        or input_artifacts[0].get("kind") != "audio"
        or not isinstance(input_artifacts[0].get("path"), str)
    ):
        fail(
            "STABLE_AUDIO_3_JOB_ARTIFACTS_INVALID",
            "Stable Audio 3 Audio-to-Audio requires one path-backed audio input.",
        )
    if task_id == TEXT_TO_AUDIO_TASK_ID and input_artifacts != []:
        fail(
            "STABLE_AUDIO_3_JOB_ARTIFACTS_INVALID",
            "Stable Audio 3 Text-to-Audio requires no input artifacts.",
        )

    output = value.get("output")
    if (
        not isinstance(output, dict)
        or set(output) != {"kind", "partialWavPath", "stagingPath"}
        or output.get("kind") != "audio"
        or not isinstance(output.get("stagingPath"), str)
        or not isinstance(output.get("partialWavPath"), str)
    ):
        fail(
            "STABLE_AUDIO_3_JOB_ARTIFACTS_INVALID",
            "Stable Audio 3 requires one staged audio output.",
        )

    validate_parameters(value.get("parameters"), task_id)
    return value


def validate_parameters(parameters: Any, task_id: str) -> None:
    expected_keys = (
        AUDIO_TO_AUDIO_PARAMETER_KEYS
        if task_id == AUDIO_TO_AUDIO_TASK_ID
        else TEXT_TO_AUDIO_PARAMETER_KEYS
    )
    if not isinstance(parameters, dict) or set(parameters) != expected_keys:
        fail(
            "STABLE_AUDIO_3_PARAMETERS_INVALID",
            "Stable Audio 3 parameters are invalid.",
        )
    if parameters.get("channels") != CHANNELS or parameters.get("sampleRate") != SAMPLE_RATE:
        fail(
            "STABLE_AUDIO_3_PARAMETERS_INVALID",
            "Stable Audio 3 output audio profile is invalid.",
        )

    prompt = parameters.get("prompt")
    duration = parameters.get("durationSeconds")
    seed = parameters.get("seed")
    if (
        not isinstance(prompt, str)
        or not prompt
        or prompt.strip() != prompt
        or len(prompt) > 2000
        or not finite_number(duration)
        or duration <= 0
        or duration > MAX_DURATION_SECONDS
        or not isinstance(seed, int)
        or isinstance(seed, bool)
        or seed < 0
        or seed > 0xFFFFFFFF
    ):
        fail(
            "STABLE_AUDIO_3_PARAMETERS_INVALID",
            "Stable Audio 3 generation parameters are invalid.",
        )

    if task_id == AUDIO_TO_AUDIO_TASK_ID:
        strength = parameters.get("strength")
        source_start = parameters.get("sourceStartSeconds")
        source_end = parameters.get("sourceEndSeconds")
        if (
            not unit_interval(strength)
            or not finite_number(source_start)
            or source_start < 0
            or not finite_number(source_end)
            or source_end <= source_start
            or source_end - source_start > MAX_DURATION_SECONDS
        ):
            fail(
                "STABLE_AUDIO_3_PARAMETERS_INVALID",
                "Stable Audio 3 Audio-to-Audio parameters are invalid.",
            )


def validate_execution_paths(
    input_path: Path | None,
    staging_path: Path,
    partial_wav_path: Path,
) -> None:
    if input_path is not None:
        validate_regular_wav_input(input_path)
    validate_reserved_staging_path(staging_path)
    if (
        not partial_wav_path.is_absolute()
        or str(partial_wav_path).lower() != f"{str(staging_path).lower()}.wav"
        or not str(partial_wav_path).lower().endswith(".partial.wav")
        or partial_wav_path.parent != staging_path.parent
        or os.path.lexists(partial_wav_path)
    ):
        fail(
            "STABLE_AUDIO_3_STAGING_INVALID",
            "Stable Audio 3 partial WAV staging path is invalid.",
        )


def validate_regular_wav_input(input_path: Path) -> None:
    if not input_path.is_absolute() or input_path.suffix.lower() != ".wav":
        fail(
            "STABLE_AUDIO_3_INPUT_INVALID",
            "Stable Audio 3 input must be an absolute WAV path.",
        )
    try:
        input_stat = os.lstat(input_path)
    except OSError as error:
        raise StableAudio3HostError(
            "STABLE_AUDIO_3_INPUT_INVALID",
            "Stable Audio 3 input audio is unavailable.",
        ) from error
    if (
        not stat.S_ISREG(input_stat.st_mode)
        or is_reparse_point(input_stat)
        or input_path.is_symlink()
        or input_stat.st_size <= 44
        or input_stat.st_size > MAX_INPUT_BYTES
    ):
        fail(
            "STABLE_AUDIO_3_INPUT_INVALID",
            "Stable Audio 3 input must be a supported regular WAV file.",
        )


def validate_reserved_staging_path(staging_path: Path) -> None:
    if not staging_path.is_absolute() or not str(staging_path).lower().endswith(".partial"):
        fail(
            "STABLE_AUDIO_3_STAGING_INVALID",
            "Stable Audio 3 output must use an absolute .partial reservation.",
        )
    validate_directory(staging_path.parent, "STABLE_AUDIO_3_STAGING_INVALID")
    try:
        staging_stat = os.lstat(staging_path)
    except OSError as error:
        raise StableAudio3HostError(
            "STABLE_AUDIO_3_STAGING_INVALID",
            "Stable Audio 3 staging reservation is unavailable.",
        ) from error
    if (
        not stat.S_ISREG(staging_stat.st_mode)
        or is_reparse_point(staging_stat)
        or staging_path.is_symlink()
        or staging_stat.st_size != 0
    ):
        fail(
            "STABLE_AUDIO_3_STAGING_INVALID",
            "Stable Audio 3 staging reservation is invalid.",
        )


def select_source_range(
    waveform: Any,
    sample_rate: int,
    start_seconds: float,
    end_seconds: float,
    torch_module: Any,
) -> Any:
    if (
        not isinstance(sample_rate, int)
        or sample_rate <= 0
        or waveform.ndim != 2
        or waveform.shape[0] <= 0
        or waveform.shape[1] <= 0
        or not torch_module.isfinite(waveform).all().item()
    ):
        fail(
            "STABLE_AUDIO_3_INPUT_INVALID",
            "Stable Audio 3 input audio samples are invalid.",
        )

    frame_count = waveform.shape[1]
    duration_seconds = frame_count / sample_rate
    if start_seconds >= duration_seconds or end_seconds > duration_seconds + 1 / sample_rate:
        fail(
            "STABLE_AUDIO_3_SOURCE_RANGE_INVALID",
            "Stable Audio 3 source range exceeds the input audio.",
        )

    start_frame = math.floor(start_seconds * sample_rate)
    end_frame = min(frame_count, math.ceil(end_seconds * sample_rate))
    if end_frame <= start_frame:
        fail(
            "STABLE_AUDIO_3_SOURCE_RANGE_INVALID",
            "Stable Audio 3 source range contains no audio frames.",
        )
    return waveform[:, start_frame:end_frame]


def inspect_wave(path: Path) -> dict[str, Any]:
    try:
        with wave.open(str(path), "rb") as source:
            channels = source.getnchannels()
            sample_rate = source.getframerate()
            frame_count = source.getnframes()
            sample_width = source.getsampwidth()
            compression_type = source.getcomptype()
    except (OSError, wave.Error) as error:
        raise StableAudio3HostError(
            "STABLE_AUDIO_3_RESULT_INVALID",
            "Stable Audio 3 output is not a supported WAVE file.",
        ) from error
    return {
        "channels": channels,
        "compressionType": compression_type,
        "durationSeconds": frame_count / sample_rate if sample_rate > 0 else 0,
        "frameCount": frame_count,
        "sampleRate": sample_rate,
        "sampleWidthBytes": sample_width,
    }


def validate_output_wave(output: dict[str, Any], duration_seconds: float) -> None:
    if (
        output["channels"] != CHANNELS
        or output["sampleRate"] != SAMPLE_RATE
        or output["sampleWidthBytes"] != 2
        or output["compressionType"] != "NONE"
        or output["frameCount"] <= 0
        or abs(output["durationSeconds"] - duration_seconds) > 1 / SAMPLE_RATE
    ):
        fail(
            "STABLE_AUDIO_3_RESULT_INVALID",
            "Stable Audio 3 output WAVE metadata is invalid.",
        )


def validate_directory(path: Path, code: str) -> None:
    try:
        directory_stat = os.lstat(path)
    except OSError as error:
        raise StableAudio3HostError(
            code,
            "Stable Audio 3 required directory is unavailable.",
        ) from error
    if (
        not stat.S_ISDIR(directory_stat.st_mode)
        or is_reparse_point(directory_stat)
        or path.is_symlink()
    ):
        fail(code, "Stable Audio 3 required directory is invalid.")


def is_reparse_point(path_stat: os.stat_result) -> bool:
    file_attributes = getattr(path_stat, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(file_attributes & reparse_flag)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(HASH_BUFFER_BYTES), b""):
                digest.update(chunk)
    except OSError as error:
        raise StableAudio3HostError(
            "STABLE_AUDIO_3_FILE_UNREADABLE",
            "Stable Audio 3 could not read a required file.",
        ) from error
    return digest.hexdigest()


def fsync_file(path: Path) -> None:
    try:
        with path.open("r+b") as output_file:
            os.fsync(output_file.fileno())
    except OSError as error:
        raise StableAudio3HostError(
            "STABLE_AUDIO_3_STAGING_INVALID",
            "Stable Audio 3 could not synchronize staged output.",
        ) from error


def require_model_identity(payload: Any) -> None:
    if (
        not isinstance(payload, dict)
        or set(payload) != {"modelId", "revision"}
        or payload.get("modelId") != MODEL_ID
        or payload.get("revision") != MODEL_REVISION
    ):
        fail(
            "MODEL_INCOMPATIBLE",
            "Stable Audio 3 host cannot load the requested Model or revision.",
        )


def valid_identity(value: Any) -> bool:
    return isinstance(value, str) and 0 < len(value) <= 128 and value.strip() == value


def finite_number(value: Any) -> bool:
    return (
        isinstance(value, numbers.Real)
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def unit_interval(value: Any) -> bool:
    return finite_number(value) and 0 <= value <= 1


def base_version(value: str) -> str:
    return value.split("+", maxsplit=1)[0]


def utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def fail(code: str, message: str) -> None:
    raise StableAudio3HostError(code, message)


def send_success(request_id: str, result: Any) -> None:
    send_message(
        {
            "ok": True,
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "result": result,
        }
    )


def send_failure(request_id: str, code: str, message: str) -> None:
    send_message(
        {
            "error": {"code": code, "message": message},
            "ok": False,
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
        }
    )


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


def handle_request(host: StableAudio3Host, message: Any) -> bool:
    if not isinstance(message, dict):
        return True

    request_id = message.get("requestId")
    if not isinstance(request_id, str) or not request_id:
        return True

    if message.get("protocolVersion") != PROTOCOL_VERSION:
        send_failure(
            request_id,
            "STABLE_AUDIO_3_PROTOCOL_INVALID",
            "Stable Audio 3 Python host protocol version is invalid.",
        )
        return True

    operation = message.get("operation")

    try:
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
            fail(
                "WORKER_OPERATION_UNSUPPORTED",
                "Stable Audio 3 Python host operation is not supported.",
            )

        send_success(request_id, result)
        return operation != "shutdown"
    except StableAudio3HostError as error:
        send_failure(request_id, error.code, str(error))
        return True
    except Exception:
        send_failure(
            request_id,
            "STABLE_AUDIO_3_HOST_FAILED",
            "Stable Audio 3 Python host operation failed.",
        )
        return True


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--model-root", required=True)
    arguments = parser.parse_args()
    model_root = Path(arguments.model_root)
    if not model_root.is_absolute():
        fail(
            "STABLE_AUDIO_3_MODEL_INVALID",
            "Stable Audio 3 Model Root must be absolute.",
        )
    arguments.model_root = model_root
    return arguments


def main() -> None:
    arguments = parse_arguments()
    host = StableAudio3Host(arguments.model_root)

    for raw_line in sys.stdin:
        if len(raw_line.encode("utf-8")) > MAX_REQUEST_BYTES:
            continue

        try:
            message = json.loads(raw_line)
        except json.JSONDecodeError:
            continue

        if not handle_request(host, message):
            break


if __name__ == "__main__":
    main()
