from __future__ import annotations

import hashlib
import importlib.metadata
import json
import logging
import math
import platform
import re
import struct
import sys
import tempfile
import time
import wave
from pathlib import Path


PROFILE_ID = "windows-x64-python-3-10-onnx-cpu"
EXPECTED_MODEL_SHA256 = (
    "2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec"
)
REQUIREMENTS_PATH = (
    Path(__file__).resolve().parents[1]
    / "engine"
    / "providers"
    / "basicPitchRuntime.requirements.txt"
)


def fail(message: str) -> None:
    raise RuntimeError(message)


def normalize_distribution_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def read_locked_requirements() -> dict[str, str]:
    requirements: dict[str, str] = {}

    for line_number, raw_line in enumerate(
        REQUIREMENTS_PATH.read_text(encoding="utf-8").splitlines(),
        start=1,
    ):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.count("==") != 1:
            fail(f"Unsupported requirement at line {line_number}: {line}")
        name, version = line.split("==", maxsplit=1)
        normalized_name = normalize_distribution_name(name)
        if not normalized_name or not version or normalized_name in requirements:
            fail(f"Invalid requirement at line {line_number}: {line}")
        requirements[normalized_name] = version

    if not requirements:
        fail("The Basic Pitch runtime lock is empty.")
    return requirements


def verify_host() -> None:
    if sys.implementation.name != "cpython":
        fail("The Basic Pitch profile requires CPython.")
    if sys.version_info[:2] != (3, 10):
        fail("The Basic Pitch profile requires Python 3.10.")
    if sys.maxsize <= 2**32:
        fail("The Basic Pitch profile requires a 64-bit Python process.")
    if sys.platform != "win32":
        fail("The Basic Pitch profile requires Windows.")
    if platform.machine().lower() not in {"amd64", "x86_64"}:
        fail("The Basic Pitch profile requires an x64 host.")


def verify_locked_environment(requirements: dict[str, str]) -> None:
    installed = {
        normalize_distribution_name(distribution.metadata["Name"]): distribution.version
        for distribution in importlib.metadata.distributions()
        if distribution.metadata["Name"]
    }
    mismatches = [
        f"{name}=={expected} (installed: {installed.get(name, 'missing')})"
        for name, expected in sorted(requirements.items())
        if installed.get(name) != expected
    ]

    if mismatches:
        fail("Runtime lock mismatch: " + "; ".join(mismatches))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def create_hum_like_wav(path: Path) -> None:
    sample_rate = 22_050
    duration_seconds = 3.0
    frame_count = round(sample_rate * duration_seconds)

    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        phase = 0.0
        frames = bytearray()

        for frame_index in range(frame_count):
            time_seconds = frame_index / sample_rate
            vibrato = 2 ** (
                (0.22 * math.sin(2 * math.pi * 5.2 * time_seconds)) / 12
            )
            phase += 2 * math.pi * (440.0 * vibrato) / sample_rate
            attack = min(1.0, time_seconds / 0.08)
            release = min(1.0, (duration_seconds - time_seconds) / 0.12)
            envelope = max(0.0, min(attack, release))
            sample = envelope * (
                0.72 * math.sin(phase)
                + 0.19 * math.sin(phase * 2)
                + 0.09 * math.sin(phase * 3)
            )
            value = max(-32_768, min(32_767, round(sample * 24_000)))
            frames.extend(struct.pack("<h", value))

        output.writeframes(frames)


def main() -> None:
    verify_host()
    requirements = read_locked_requirements()
    verify_locked_environment(requirements)

    logging.disable(logging.WARNING)
    import basic_pitch
    import onnxruntime
    from basic_pitch.inference import Model, predict

    model_path = (
        Path(basic_pitch.__file__).resolve().parent
        / "saved_models"
        / "icassp_2022"
        / "nmp.onnx"
    )
    if not model_path.is_file():
        fail(f"Pinned Basic Pitch ONNX model is missing: {model_path}")

    model_sha256 = sha256_file(model_path)
    if model_sha256 != EXPECTED_MODEL_SHA256:
        fail(
            "Basic Pitch model SHA-256 mismatch: "
            f"expected {EXPECTED_MODEL_SHA256}, received {model_sha256}."
        )

    execution_providers = onnxruntime.get_available_providers()
    if "CPUExecutionProvider" not in execution_providers:
        fail("ONNX Runtime CPUExecutionProvider is unavailable.")

    with tempfile.TemporaryDirectory(
        prefix="humstudio-basic-pitch-verification-"
    ) as temporary_directory:
        audio_path = Path(temporary_directory) / "hum-like-a4.wav"
        create_hum_like_wav(audio_path)
        started_at = time.perf_counter()
        model = Model(model_path)
        _, _, note_events = predict(
            audio_path,
            model,
            minimum_frequency=220.0,
            maximum_frequency=880.0,
            multiple_pitch_bends=False,
            melodia_trick=True,
            midi_tempo=120,
        )
        elapsed_seconds = time.perf_counter() - started_at

    matching_events = [
        event
        for event in note_events
        if int(event[2]) == 69
        and float(event[0]) <= 0.1
        and float(event[1]) >= 2.8
    ]
    if not matching_events:
        fail("Basic Pitch did not produce the expected sustained A4 event.")

    print(
        json.dumps(
            {
                "executionProviders": execution_providers,
                "modelSha256": model_sha256,
                "noteEventCount": len(note_events),
                "profileId": PROFILE_ID,
                "providerVersion": importlib.metadata.version("basic-pitch"),
                "pythonVersion": platform.python_version(),
                "runtimeVersion": importlib.metadata.version("onnxruntime"),
                "status": "VERIFIED",
                "syntheticInferenceSeconds": round(elapsed_seconds, 3),
                "temporaryFilesRemoved": True,
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
