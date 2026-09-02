from __future__ import annotations

import contextlib
import hashlib
import importlib.metadata
import json
import logging
import math
import numbers
import os
import platform
import stat
import sys
import tempfile
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROTOCOL_VERSION = "1"
PROFILE_ID = "windows-x64-python-3-10-onnx-cpu"
PROVIDER_ID = "local-basic-pitch"
PROVIDER_VERSION = "0.4.0"
TASK_ID = "hum-to-midi"
MODEL_ID = "basic-pitch-icassp-2022"
MODEL_REVISION = "0.4.0-onnx"
MODEL_SHA256 = (
    "2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec"
)
ONNX_RUNTIME_VERSION = "1.23.2"
TICKS_PER_QUARTER = 960
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_SAFE_INTEGER = 9_007_199_254_740_991
EXPECTED_PARAMETER_KEYS = {
    "frameThreshold",
    "maximumFrequencyHz",
    "melodiaTrick",
    "minimumFrequencyHz",
    "minimumNoteLengthMs",
    "multiplePitchBends",
    "onsetThreshold",
    "projectBpm",
    "sourceEndSeconds",
    "sourceStartSeconds",
    "ticksPerQuarter",
}


class BasicPitchHostError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class BasicPitchHost:
    def __init__(self) -> None:
        self._loaded_at: str | None = None
        self._model: Any = None
        self._numpy: Any = None
        self._predict: Any = None
        self._soundfile: Any = None

    def inspect(self) -> dict[str, Any]:
        verify_runtime_profile()
        return {
            "profileId": PROFILE_ID,
            "providerVersion": PROVIDER_VERSION,
            "runtimeVersion": ONNX_RUNTIME_VERSION,
            "status": "READY",
        }

    def load_model(self, payload: Any) -> dict[str, Any]:
        require_model_identity(payload)

        if self._model is not None and self._loaded_at is not None:
            return self._loaded_result()

        verify_runtime_profile()
        logging.disable(logging.WARNING)

        try:
            with contextlib.redirect_stdout(sys.stderr):
                import basic_pitch
                import numpy
                import onnxruntime
                import soundfile
                from basic_pitch.inference import Model, predict

            package_path = Path(basic_pitch.__file__).resolve().parent
            model_path = (
                package_path / "saved_models" / "icassp_2022" / "nmp.onnx"
            )
            validate_model_file(model_path)

            if "CPUExecutionProvider" not in onnxruntime.get_available_providers():
                fail(
                    "BASIC_PITCH_RUNTIME_INVALID",
                    "ONNX Runtime CPUExecutionProvider is unavailable.",
                )

            with contextlib.redirect_stdout(sys.stderr):
                model = Model(model_path)
        except BasicPitchHostError:
            raise
        except Exception as error:
            raise BasicPitchHostError(
                "BASIC_PITCH_MODEL_LOAD_FAILED",
                "Basic Pitch could not load the pinned ONNX model.",
            ) from error

        self._model = model
        self._numpy = numpy
        self._predict = predict
        self._soundfile = soundfile
        self._loaded_at = utc_now()
        return self._loaded_result()

    def execute(self, payload: Any) -> dict[str, Any]:
        if self._model is None or self._predict is None:
            fail("MODEL_NOT_LOADED", "Load the Basic Pitch Model before execution.")

        job = validate_job(payload)

        try:
            with tempfile.TemporaryDirectory(
                prefix="humstudio-basic-pitch-worker-"
            ) as temporary_directory:
                selected_audio_path = (
                    Path(temporary_directory) / "selected-recording-range.wav"
                )
                self._write_selected_audio_range(
                    Path(job["inputArtifacts"][0]["path"]),
                    selected_audio_path,
                    job["parameters"]["sourceStartSeconds"],
                    job["parameters"]["sourceEndSeconds"],
                )
                parameters = job["parameters"]

                with contextlib.redirect_stdout(sys.stderr):
                    _, _, note_events = self._predict(
                        selected_audio_path,
                        self._model,
                        onset_threshold=parameters["onsetThreshold"],
                        frame_threshold=parameters["frameThreshold"],
                        minimum_note_length=parameters["minimumNoteLengthMs"],
                        minimum_frequency=parameters["minimumFrequencyHz"],
                        maximum_frequency=parameters["maximumFrequencyHz"],
                        multiple_pitch_bends=parameters["multiplePitchBends"],
                        melodia_trick=parameters["melodiaTrick"],
                        midi_tempo=parameters["projectBpm"],
                    )
        except BasicPitchHostError:
            raise
        except Exception as error:
            raise BasicPitchHostError(
                "BASIC_PITCH_INFERENCE_FAILED",
                "Basic Pitch inference failed.",
            ) from error

        return {
            "notes": convert_note_events(
                note_events,
                job["parameters"]["projectBpm"],
                job["parameters"]["ticksPerQuarter"],
            )
        }

    def unload_model(self) -> dict[str, Any]:
        was_loaded = self._model is not None
        self._model = None
        self._numpy = None
        self._predict = None
        self._soundfile = None
        self._loaded_at = None
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
        self._model = None
        self._numpy = None
        self._predict = None
        self._soundfile = None
        self._loaded_at = None
        return {"status": "SHUTDOWN"}

    def _loaded_result(self) -> dict[str, str]:
        if self._loaded_at is None:
            fail(
                "BASIC_PITCH_HOST_STATE_INVALID",
                "Basic Pitch Model state is invalid.",
            )

        return {
            "loadedAt": self._loaded_at,
            "modelId": MODEL_ID,
            "revision": MODEL_REVISION,
            "status": "LOADED",
        }

    def _write_selected_audio_range(
        self,
        input_path: Path,
        output_path: Path,
        start_seconds: float,
        end_seconds: float,
    ) -> None:
        validate_recording_path(input_path)

        try:
            with self._soundfile.SoundFile(str(input_path), mode="r") as source:
                sample_rate = source.samplerate
                frame_count = len(source)

                if sample_rate <= 0 or frame_count <= 0 or source.channels <= 0:
                    fail(
                        "BASIC_PITCH_INPUT_INVALID",
                        "Basic Pitch input recording metadata is invalid.",
                    )

                duration_seconds = frame_count / sample_rate
                frame_tolerance = 1 / sample_rate

                if (
                    start_seconds >= duration_seconds
                    or end_seconds > duration_seconds + frame_tolerance
                ):
                    fail(
                        "BASIC_PITCH_SOURCE_RANGE_INVALID",
                        "Basic Pitch source range exceeds the input recording.",
                    )

                start_frame = math.floor(start_seconds * sample_rate)
                end_frame = min(frame_count, math.ceil(end_seconds * sample_rate))

                if end_frame <= start_frame:
                    fail(
                        "BASIC_PITCH_SOURCE_RANGE_INVALID",
                        "Basic Pitch source range contains no audio frames.",
                    )

                source.seek(start_frame)
                samples = source.read(
                    end_frame - start_frame,
                    dtype="float32",
                    always_2d=True,
                )

            if samples.shape[0] != end_frame - start_frame:
                fail(
                    "BASIC_PITCH_INPUT_INVALID",
                    "Basic Pitch could not read the complete source range.",
                )

            mono_samples = self._numpy.mean(samples, axis=1, dtype=self._numpy.float32)
            self._soundfile.write(
                str(output_path),
                mono_samples,
                sample_rate,
                format="WAV",
                subtype="PCM_16",
            )
        except BasicPitchHostError:
            raise
        except Exception as error:
            raise BasicPitchHostError(
                "BASIC_PITCH_INPUT_INVALID",
                "Basic Pitch input must be a readable regular WAV recording.",
            ) from error


def verify_runtime_profile() -> None:
    if sys.implementation.name != "cpython" or sys.version_info[:2] != (3, 10):
        fail(
            "BASIC_PITCH_RUNTIME_INVALID",
            "Basic Pitch requires CPython 3.10.",
        )
    if sys.maxsize <= 2**32 or sys.platform != "win32":
        fail(
            "BASIC_PITCH_RUNTIME_INVALID",
            "Basic Pitch requires 64-bit Windows.",
        )
    if platform.machine().lower() not in {"amd64", "x86_64"}:
        fail("BASIC_PITCH_RUNTIME_INVALID", "Basic Pitch requires an x64 host.")

    try:
        provider_version = importlib.metadata.version("basic-pitch")
        runtime_version = importlib.metadata.version("onnxruntime")
    except importlib.metadata.PackageNotFoundError as error:
        raise BasicPitchHostError(
            "BASIC_PITCH_RUNTIME_INVALID",
            "Basic Pitch runtime packages are incomplete.",
        ) from error

    if provider_version != PROVIDER_VERSION or runtime_version != ONNX_RUNTIME_VERSION:
        fail(
            "BASIC_PITCH_RUNTIME_INVALID",
            "Basic Pitch runtime package versions do not match the pinned profile.",
        )


def validate_model_file(model_path: Path) -> None:
    try:
        model_stat = os.lstat(model_path)
    except OSError as error:
        raise BasicPitchHostError(
            "BASIC_PITCH_MODEL_INVALID",
            "Pinned Basic Pitch ONNX model is unavailable.",
        ) from error

    if not stat.S_ISREG(model_stat.st_mode) or model_path.is_symlink():
        fail(
            "BASIC_PITCH_MODEL_INVALID",
            "Pinned Basic Pitch ONNX model must be a regular file.",
        )

    digest = hashlib.sha256()
    with model_path.open("rb") as model_file:
        for chunk in iter(lambda: model_file.read(1024 * 1024), b""):
            digest.update(chunk)

    if digest.hexdigest() != MODEL_SHA256:
        fail(
            "BASIC_PITCH_MODEL_INVALID",
            "Pinned Basic Pitch ONNX model SHA-256 does not match.",
        )


def validate_recording_path(input_path: Path) -> None:
    if not input_path.is_absolute() or input_path.suffix.lower() != ".wav":
        fail(
            "BASIC_PITCH_INPUT_INVALID",
            "Basic Pitch input must be an absolute WAV recording path.",
        )

    try:
        input_stat = os.lstat(input_path)
    except OSError as error:
        raise BasicPitchHostError(
            "BASIC_PITCH_INPUT_INVALID",
            "Basic Pitch input recording is unavailable.",
        ) from error

    if not stat.S_ISREG(input_stat.st_mode) or input_path.is_symlink():
        fail(
            "BASIC_PITCH_INPUT_INVALID",
            "Basic Pitch input recording must be a regular file.",
        )


def validate_job(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail("BASIC_PITCH_JOB_INVALID", "Basic Pitch Job must be an object.")

    if (
        value.get("providerId") != PROVIDER_ID
        or value.get("taskId") != TASK_ID
        or value.get("modelId") != MODEL_ID
        or value.get("modelRevision") != MODEL_REVISION
    ):
        fail(
            "BASIC_PITCH_JOB_INVALID",
            "Basic Pitch Job identity does not match the loaded Provider Model.",
        )

    inputs = value.get("inputArtifacts")
    if (
        not isinstance(inputs, list)
        or len(inputs) != 1
        or not isinstance(inputs[0], dict)
        or inputs[0].get("kind") != "audio"
        or not isinstance(inputs[0].get("path"), str)
    ):
        fail(
            "BASIC_PITCH_JOB_INVALID",
            "Basic Pitch Job requires one path-backed audio input.",
        )

    if value.get("output") != {"kind": "midi"}:
        fail(
            "BASIC_PITCH_JOB_INVALID",
            "Basic Pitch Job requires one inline MIDI output.",
        )

    parameters = value.get("parameters")
    validate_parameters(parameters)
    return value


def validate_parameters(parameters: Any) -> None:
    if not isinstance(parameters, dict) or set(parameters) != EXPECTED_PARAMETER_KEYS:
        fail(
            "BASIC_PITCH_PARAMETERS_INVALID",
            "Basic Pitch parameters do not match the pinned Task contract.",
        )

    if not unit_interval(parameters["onsetThreshold"]) or not unit_interval(
        parameters["frameThreshold"]
    ):
        fail(
            "BASIC_PITCH_PARAMETERS_INVALID",
            "Basic Pitch thresholds must be from 0 through 1.",
        )

    minimum_note_length = parameters["minimumNoteLengthMs"]
    if (
        not finite_number(minimum_note_length)
        or minimum_note_length <= 0
        or minimum_note_length > 5_000
    ):
        fail(
            "BASIC_PITCH_PARAMETERS_INVALID",
            "Basic Pitch minimum note length is invalid.",
        )

    minimum_frequency = parameters["minimumFrequencyHz"]
    maximum_frequency = parameters["maximumFrequencyHz"]
    if (
        not finite_number(minimum_frequency)
        or not finite_number(maximum_frequency)
        or minimum_frequency < 20
        or maximum_frequency <= minimum_frequency
        or maximum_frequency > 5_000
    ):
        fail(
            "BASIC_PITCH_PARAMETERS_INVALID",
            "Basic Pitch frequency range is invalid.",
        )

    if (
        not isinstance(parameters["melodiaTrick"], bool)
        or parameters["multiplePitchBends"] is not False
    ):
        fail(
            "BASIC_PITCH_PARAMETERS_INVALID",
            "Basic Pitch pitch processing flags are invalid.",
        )

    project_bpm = parameters["projectBpm"]
    if not finite_number(project_bpm) or project_bpm < 40 or project_bpm > 240:
        fail("BASIC_PITCH_PARAMETERS_INVALID", "Basic Pitch Project BPM is invalid.")

    source_start = parameters["sourceStartSeconds"]
    source_end = parameters["sourceEndSeconds"]
    if (
        not finite_number(source_start)
        or not finite_number(source_end)
        or source_start < 0
        or source_end <= source_start
    ):
        fail(
            "BASIC_PITCH_PARAMETERS_INVALID",
            "Basic Pitch source range is invalid.",
        )

    if parameters["ticksPerQuarter"] != TICKS_PER_QUARTER:
        fail(
            "BASIC_PITCH_PARAMETERS_INVALID",
            "Basic Pitch ticks per quarter is invalid.",
        )


def convert_note_events(
    note_events: Any,
    project_bpm: float,
    ticks_per_quarter: int,
) -> list[dict[str, Any]]:
    if not isinstance(note_events, (list, tuple)):
        fail(
            "BASIC_PITCH_RESULT_INVALID",
            "Basic Pitch note events are invalid.",
        )

    normalized_events: list[tuple[float, float, int, float, int]] = []

    for source_index, event in enumerate(note_events):
        if not isinstance(event, (list, tuple)) or len(event) < 4:
            fail(
                "BASIC_PITCH_RESULT_INVALID",
                "Basic Pitch returned a malformed note event.",
            )

        start_seconds, end_seconds, pitch, confidence = event[:4]
        if (
            not finite_number(start_seconds)
            or not finite_number(end_seconds)
            or start_seconds < 0
            or end_seconds <= start_seconds
            or not isinstance(pitch, numbers.Integral)
            or isinstance(pitch, bool)
            or pitch < 0
            or pitch > 127
            or not finite_number(confidence)
            or confidence < 0
            or confidence > 1
        ):
            fail(
                "BASIC_PITCH_RESULT_INVALID",
                "Basic Pitch returned an invalid note event.",
            )

        normalized_events.append(
            (
                float(start_seconds),
                float(end_seconds),
                int(pitch),
                float(confidence),
                source_index,
            )
        )

    normalized_events.sort(
        key=lambda event: (event[0], event[2], event[1], event[4])
    )
    ticks_per_second = project_bpm * ticks_per_quarter / 60
    notes: list[dict[str, Any]] = []

    for note_index, event in enumerate(normalized_events, start=1):
        start_seconds, end_seconds, pitch, confidence, _ = event
        start_tick = round_half_up(start_seconds * ticks_per_second)
        end_tick = round_half_up(end_seconds * ticks_per_second)
        length_ticks = max(1, end_tick - start_tick)

        if start_tick + length_ticks > MAX_SAFE_INTEGER:
            fail(
                "BASIC_PITCH_RESULT_INVALID",
                "Basic Pitch MIDI note exceeds the safe tick range.",
            )

        notes.append(
            {
                "confidence": round(confidence, 9),
                "id": f"note-{note_index:04d}",
                "lengthTicks": length_ticks,
                "pitch": pitch,
                "startTick": start_tick,
                "velocity": max(1, min(127, round_half_up(confidence * 127))),
            }
        )

    return notes


def require_model_identity(payload: Any) -> None:
    if (
        not isinstance(payload, dict)
        or payload.get("modelId") != MODEL_ID
        or payload.get("revision") != MODEL_REVISION
    ):
        fail(
            "MODEL_INCOMPATIBLE",
            "Basic Pitch host cannot load the requested Model or revision.",
        )


def finite_number(value: Any) -> bool:
    return (
        isinstance(value, numbers.Real)
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def unit_interval(value: Any) -> bool:
    return finite_number(value) and 0 <= value <= 1


def round_half_up(value: float) -> int:
    return math.floor(value + 0.5)


def utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def fail(code: str, message: str) -> None:
    raise BasicPitchHostError(code, message)


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
    sys.stdout.write(json.dumps(message, separators=(",", ":"), allow_nan=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def handle_request(host: BasicPitchHost, message: Any) -> bool:
    if not isinstance(message, dict):
        return True

    request_id = message.get("requestId")
    if not isinstance(request_id, str) or not request_id:
        return True

    if message.get("protocolVersion") != PROTOCOL_VERSION:
        send_failure(
            request_id,
            "BASIC_PITCH_PROTOCOL_INVALID",
            "Basic Pitch Python host protocol version is invalid.",
        )
        return True

    operation = message.get("operation")

    try:
        if operation == "inspect":
            result = host.inspect()
        elif operation == "load-model":
            result = host.load_model(message.get("payload"))
        elif operation == "execute":
            result = host.execute(message.get("payload"))
        elif operation == "unload-model":
            result = host.unload_model()
        elif operation == "shutdown":
            result = host.shutdown()
        else:
            fail(
                "WORKER_OPERATION_UNSUPPORTED",
                "Basic Pitch Python host operation is not supported.",
            )

        send_success(request_id, result)
        return operation != "shutdown"
    except BasicPitchHostError as error:
        send_failure(request_id, error.code, str(error))
        return True
    except Exception:
        traceback.print_exc(file=sys.stderr)
        send_failure(
            request_id,
            "BASIC_PITCH_HOST_FAILED",
            "Basic Pitch Python host operation failed.",
        )
        return True


def main() -> None:
    host = BasicPitchHost()

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
