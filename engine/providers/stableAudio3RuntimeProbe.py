import contextlib
import importlib
import importlib.metadata
import io
import json
import platform
import sys


PROBE_VERSION = "1"


def inspect_package(distribution_names, module_name):
    version = None

    for distribution_name in distribution_names:
        try:
            version = importlib.metadata.version(distribution_name)
            break
        except importlib.metadata.PackageNotFoundError:
            continue

    imported_module = None
    import_error_type = None

    try:
        with contextlib.redirect_stdout(io.StringIO()):
            with contextlib.redirect_stderr(io.StringIO()):
                imported_module = importlib.import_module(module_name)
    except BaseException as error:
        import_error_type = type(error).__name__

    return (
        {
            "available": version is not None,
            "importable": imported_module is not None,
            "importErrorType": import_error_type,
            "version": version,
        },
        imported_module,
    )


stable_audio_3, _ = inspect_package(["stable-audio-3"], "stable_audio_3")
torch, torch_module = inspect_package(["torch"], "torch")
torchaudio, _ = inspect_package(["torchaudio"], "torchaudio")
flash_attention, _ = inspect_package(
    ["flash-attn", "flash_attn"],
    "flash_attn",
)

cuda = {
    "available": False,
    "buildVersion": None,
    "deviceName": None,
    "probeErrorType": None,
    "totalMemoryMiB": None,
}

if torch_module is not None:
    try:
        cuda["buildVersion"] = torch_module.version.cuda
        cuda["available"] = bool(torch_module.cuda.is_available())

        if cuda["available"]:
            device = torch_module.cuda.current_device()
            properties = torch_module.cuda.get_device_properties(device)
            cuda["deviceName"] = properties.name
            cuda["totalMemoryMiB"] = int(properties.total_memory // (1024 * 1024))
    except BaseException as error:
        cuda["available"] = False
        cuda["deviceName"] = None
        cuda["probeErrorType"] = type(error).__name__
        cuda["totalMemoryMiB"] = None

report = {
    "architecture": platform.machine(),
    "cuda": cuda,
    "packages": {
        "flashAttention": flash_attention,
        "stableAudio3": stable_audio_3,
        "torch": torch,
        "torchaudio": torchaudio,
    },
    "platform": sys.platform,
    "probeVersion": PROBE_VERSION,
    "python": {
        "implementation": platform.python_implementation(),
        "version": platform.python_version(),
    },
}

sys.stdout.write(json.dumps(report, separators=(",", ":"), sort_keys=True) + "\n")
