from __future__ import annotations

import argparse
import contextlib
import gc
import hashlib
import importlib.metadata
import json
import math
import os
import struct
import subprocess
import sys
import time
import traceback
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse


PROBE_VERSION = "1"
PROVIDER_CODE_REVISION = "dce621408bee8c31b4fcf4811682eb9359e1bc94"
MODEL_ID = "acestep-v15-base"
MODEL_REVISION = "e432212fec32b8965a14ffa57ae653438d6abd14"
SUPPORT_MODEL_REVISION = "19671f406d603126926c1b7e2adc169acbcade22"
SAMPLE_RATE = 48_000
CHANNELS = 2
DURATION_SECONDS = 10
INFERENCE_STEPS = 64
GUIDANCE_SCALE = 8.0
USE_ADG = True
CFG_INTERVAL_START = 0.0
CFG_INTERVAL_END = 1.0
SHIFT = 3.0
DCW_ENABLED = False
SEED = 1_370_421
INSTRUCTION = "Generate the VOCALS track based on the audio context:"
CAPTION = "solo female lead vocal, clear dry a cappella, no instruments"


class ProbeError(Exception):
    pass


def require_absolute_path(raw_value: str, label: str) -> Path:
    path = Path(raw_value)
    if not path.is_absolute():
        raise ProbeError(f"{label} must be absolute.")
    return path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_wave(path: Path, expected_duration: float) -> dict[str, Any]:
    if not path.is_file() or path.is_symlink():
        raise ProbeError("Audio evidence must be a regular file, not a link.")

    file_bytes = path.read_bytes()
    if (
        len(file_bytes) < 44
        or file_bytes[0:4] != b"RIFF"
        or file_bytes[8:12] != b"WAVE"
        or struct.unpack_from("<I", file_bytes, 4)[0] + 8 != len(file_bytes)
    ):
        raise ProbeError("Audio evidence is not one complete RIFF/WAVE file.")

    format_fields: tuple[int, int, int, int, int, int] | None = None
    audio_bytes: bytes | None = None
    offset = 12
    while offset + 8 <= len(file_bytes):
        chunk_id = file_bytes[offset : offset + 4]
        chunk_size = struct.unpack_from("<I", file_bytes, offset + 4)[0]
        chunk_start = offset + 8
        chunk_end = chunk_start + chunk_size
        padded_end = chunk_end + (chunk_size % 2)
        if padded_end > len(file_bytes):
            raise ProbeError("Audio evidence contains an incomplete WAVE chunk.")
        if chunk_id == b"fmt ":
            if format_fields is not None or chunk_size < 16:
                raise ProbeError("Audio evidence contains an invalid format chunk.")
            format_fields = struct.unpack_from("<HHIIHH", file_bytes, chunk_start)
        elif chunk_id == b"data":
            if audio_bytes is not None or chunk_size == 0:
                raise ProbeError("Audio evidence contains an invalid data chunk.")
            audio_bytes = file_bytes[chunk_start:chunk_end]
        offset = padded_end

    if offset != len(file_bytes) or format_fields is None or audio_bytes is None:
        raise ProbeError("Audio evidence has incomplete WAVE structure.")

    format_tag, channels, sample_rate, byte_rate, block_align, bits_per_sample = (
        format_fields
    )
    supported_format = (format_tag, bits_per_sample) in ((1, 16), (3, 32))
    sample_width = bits_per_sample // 8
    if (
        not supported_format
        or channels != CHANNELS
        or sample_rate != SAMPLE_RATE
        or block_align != channels * sample_width
        or byte_rate != sample_rate * block_align
        or len(audio_bytes) % block_align != 0
    ):
        raise ProbeError("Audio evidence must be uncompressed stereo 48 kHz WAVE.")

    frame_count = len(audio_bytes) // block_align
    duration_seconds = frame_count / sample_rate
    if not math.isclose(duration_seconds, expected_duration, abs_tol=0.1):
        raise ProbeError("Audio evidence duration does not match the probe contract.")
    peak, root_mean_square = inspect_samples(audio_bytes, format_tag)
    if peak <= 1e-8 or root_mean_square <= 1e-9:
        raise ProbeError("Audio evidence is silent or effectively empty.")

    return {
        "audioFormat": "PCM16" if format_tag == 1 else "IEEE_FLOAT32",
        "channels": channels,
        "durationSeconds": duration_seconds,
        "frameCount": frame_count,
        "peakAbsoluteSample": peak,
        "rootMeanSquare": root_mean_square,
        "sampleRate": sample_rate,
        "sampleWidthBytes": sample_width,
        "sha256": sha256(path),
        "sizeBytes": path.stat().st_size,
    }


def inspect_samples(audio_bytes: bytes, format_tag: int) -> tuple[float, float]:
    sample_format = "<h" if format_tag == 1 else "<f"
    scale = 32_768.0 if format_tag == 1 else 1.0
    peak = 0.0
    square_sum = 0.0
    sample_count = 0

    for raw_sample, in struct.iter_unpack(sample_format, audio_bytes):
        sample = raw_sample / scale
        if not math.isfinite(sample):
            raise ProbeError("Audio evidence contains a non-finite sample.")
        absolute_sample = abs(sample)
        peak = max(peak, absolute_sample)
        square_sum += sample * sample
        sample_count += 1

    if sample_count == 0:
        raise ProbeError("Audio evidence contains no samples.")
    return peak, math.sqrt(square_sum / sample_count)


def provider_checkout() -> Path:
    distribution = importlib.metadata.distribution("ace-step")
    raw_direct_url = distribution.read_text("direct_url.json")
    if raw_direct_url is None:
        raise ProbeError("ACE-Step installation has no direct_url.json identity.")
    direct_url = json.loads(raw_direct_url)
    if not direct_url.get("dir_info", {}).get("editable"):
        raise ProbeError("ACE-Step installation must use the pinned editable checkout.")
    parsed_url = urlparse(direct_url.get("url", ""))
    if parsed_url.scheme != "file":
        raise ProbeError("ACE-Step editable checkout URL must use the file scheme.")

    path_text = unquote(parsed_url.path)
    if parsed_url.netloc:
        path_text = f"//{parsed_url.netloc}{path_text}"
    if os.name == "nt" and path_text.startswith("/") and len(path_text) > 2:
        path_text = path_text[1:]
    checkout = Path(path_text).resolve()
    git_environment = {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=checkout,
        env=git_environment,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    status = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=checkout,
        env=git_environment,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if revision != PROVIDER_CODE_REVISION or status:
        raise ProbeError("ACE-Step provider checkout is not the exact clean pinned revision.")
    return checkout


def configure_offline(checkpoints_root: Path) -> None:
    os.environ["ACESTEP_CHECKPOINTS_DIR"] = str(checkpoints_root)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    os.environ["NO_ALBUMENTATIONS_UPDATE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ.pop("HF_TOKEN", None)
    os.environ.pop("HUGGING_FACE_HUB_TOKEN", None)


def run_probe(args: argparse.Namespace) -> dict[str, Any]:
    checkpoints_root = require_absolute_path(args.checkpoints_root, "Checkpoints root")
    guide_path = require_absolute_path(args.guide, "Guide Audio path")
    lyrics_path = require_absolute_path(args.lyrics, "Lyrics path")
    output_directory = require_absolute_path(args.output_directory, "Output directory")

    if not checkpoints_root.is_dir() or checkpoints_root.is_symlink():
        raise ProbeError("Checkpoints root must be a regular directory, not a link.")
    if not lyrics_path.is_file() or lyrics_path.is_symlink():
        raise ProbeError("Lyrics must be a regular file, not a link.")
    if output_directory.exists():
        raise ProbeError("Output directory must not already exist.")

    lyrics = lyrics_path.read_text(encoding="utf-8")
    if not lyrics.strip() or len(lyrics) > 4_096:
        raise ProbeError("Lyrics must contain 1 through 4096 UTF-8 characters.")
    input_wave = inspect_wave(guide_path, DURATION_SECONDS)
    guide_resolved = guide_path.resolve()
    lyrics_resolved = lyrics_path.resolve()
    if guide_resolved == lyrics_resolved:
        raise ProbeError("Guide Audio and Lyrics must be distinct files.")

    configure_offline(checkpoints_root)
    checkout = provider_checkout()
    output_directory.mkdir(parents=False)
    started = time.perf_counter()

    with contextlib.redirect_stdout(sys.stderr):
        import torch
        from acestep.handler import AceStepHandler
        from acestep.inference import GenerationConfig, GenerationParams, generate_music

        if not torch.cuda.is_available():
            raise ProbeError("ACE-Step Lego Probe requires CUDA.")

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
        )
        if not initialized:
            raise ProbeError(f"ACE-Step initialization failed: {status_message}")

        params = GenerationParams(
            task_type="lego",
            instruction=INSTRUCTION,
            src_audio=str(guide_resolved),
            caption=CAPTION,
            lyrics=lyrics,
            instrumental=False,
            vocal_language="en",
            duration=DURATION_SECONDS,
            inference_steps=INFERENCE_STEPS,
            guidance_scale=GUIDANCE_SCALE,
            use_adg=USE_ADG,
            cfg_interval_start=CFG_INTERVAL_START,
            cfg_interval_end=CFG_INTERVAL_END,
            shift=SHIFT,
            dcw_enabled=DCW_ENABLED,
            seed=SEED,
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
            seeds=[SEED],
            audio_format="wav",
        )
        result = generate_music(
            handler,
            None,
            params,
            config,
            save_dir=str(output_directory),
        )

    if not result.success:
        raise ProbeError(f"ACE-Step Lego generation failed: {result.error}")
    if len(result.audios) != 1:
        raise ProbeError("ACE-Step Lego Probe must return exactly one audio result.")

    output_path = Path(result.audios[0].get("path", ""))
    if not output_path.is_absolute() or output_path.parent.resolve() != output_directory.resolve():
        raise ProbeError("ACE-Step Lego Probe returned an unexpected output path.")
    output_wave = inspect_wave(output_path, DURATION_SECONDS)
    elapsed_seconds = time.perf_counter() - started
    cuda_name = torch.cuda.get_device_name(torch.cuda.current_device())

    del result
    del handler
    gc.collect()
    torch.cuda.empty_cache()

    return {
        "environment": {
            "cudaDeviceName": cuda_name,
            "offline": True,
            "providerCheckout": str(checkout),
            "providerCodeRevision": PROVIDER_CODE_REVISION,
        },
        "generation": {
            "caption": CAPTION,
            "cfgIntervalEnd": CFG_INTERVAL_END,
            "cfgIntervalStart": CFG_INTERVAL_START,
            "dcwEnabled": DCW_ENABLED,
            "durationSeconds": DURATION_SECONDS,
            "guidanceScale": GUIDANCE_SCALE,
            "inferenceSteps": INFERENCE_STEPS,
            "instruction": INSTRUCTION,
            "modelId": MODEL_ID,
            "modelRevision": MODEL_REVISION,
            "seed": SEED,
            "shift": SHIFT,
            "supportModelRevision": SUPPORT_MODEL_REVISION,
            "targetTrack": "vocals",
            "taskType": "lego",
            "thinking": False,
            "useAdg": USE_ADG,
            "vocalLanguage": "en",
        },
        "input": {
            "guideAudio": input_wave,
            "lyricsSha256": sha256(lyrics_path),
            "lyricsSizeBytes": lyrics_path.stat().st_size,
        },
        "output": output_wave,
        "probeVersion": PROBE_VERSION,
        "status": "REAL_LEGO_VOCALS_GENERATION_VERIFIED",
        "timing": {"elapsedSeconds": round(elapsed_seconds, 3)},
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("checkpoints_root")
    parser.add_argument("guide")
    parser.add_argument("lyrics")
    parser.add_argument("output_directory")
    parser.add_argument("--log-path", required=True)
    parser.add_argument("--report-path", required=True)
    args = parser.parse_args()

    report_path = require_absolute_path(args.report_path, "Report path")
    log_path = require_absolute_path(args.log_path, "Log path")
    if report_path.parent != log_path.parent or not report_path.parent.is_dir():
        raise ProbeError("Report and log must share one existing evidence directory.")
    if report_path.exists() or log_path.exists():
        raise ProbeError("Report and log paths must not already exist.")

    try:
        with log_path.open("x", encoding="utf-8", newline="\n") as log_file:
            with contextlib.redirect_stderr(log_file):
                try:
                    report = run_probe(args)
                    exit_code = 0
                except BaseException as error:
                    traceback.print_exc()
                    report = {
                        "error": str(error),
                        "errorType": type(error).__name__,
                        "probeVersion": PROBE_VERSION,
                        "status": "PROBE_FAILED",
                    }
                    exit_code = 1
    except BaseException:
        log_path.unlink(missing_ok=True)
        raise

    serialized_report = json.dumps(
        report,
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    ) + "\n"
    with report_path.open("x", encoding="utf-8", newline="\n") as report_file:
        report_file.write(serialized_report)
    sys.stdout.write(serialized_report)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
