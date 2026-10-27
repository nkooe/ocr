from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen


PROJECT_ROOT = Path(__file__).resolve().parent
RUNTIME_SITE = PROJECT_ROOT / ".runtime" / "site-packages"
RUNTIME_TMP = PROJECT_ROOT / ".runtime" / "tmp"
RUNTIME_CACHE = PROJECT_ROOT / ".runtime" / "pip-cache"
RUNTIME_ABI_MARKER = RUNTIME_SITE / ".ocr-python-abi"
RUNTIME_INSTALL_LOCK = PROJECT_ROOT / ".runtime" / "install.lock"
REQUIREMENTS_FILE = PROJECT_ROOT / "requirements.txt"
GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"


class _InstallLock:
    def __init__(self, timeout_seconds: int = 7200) -> None:
        self.timeout_seconds = timeout_seconds
        self._handle = None

    def __enter__(self):
        RUNTIME_INSTALL_LOCK.parent.mkdir(parents=True, exist_ok=True)
        self._handle = RUNTIME_INSTALL_LOCK.open("a+", encoding="ascii")
        self._handle.seek(0, os.SEEK_END)
        if self._handle.tell() == 0:
            self._handle.write("0")
            self._handle.flush()
        deadline = time.monotonic() + self.timeout_seconds
        if os.name == "nt":
            import msvcrt

            while True:
                try:
                    self._handle.seek(0)
                    msvcrt.locking(self._handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        self._handle.close()
                        raise TimeoutError("Timed out waiting for the install lock")
                    time.sleep(1)
        else:
            import fcntl

            while True:
                try:
                    fcntl.flock(
                        self._handle.fileno(),
                        fcntl.LOCK_EX | fcntl.LOCK_NB,
                    )
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        self._handle.close()
                        raise TimeoutError(
                            "Timed out waiting for the install lock"
                        )
                    time.sleep(1)
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        if self._handle is None:
            return
        if os.name == "nt":
            import msvcrt

            self._handle.seek(0)
            msvcrt.locking(self._handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
        self._handle.close()


def _python_abi() -> str:
    return getattr(sys.implementation, "cache_tag", None) or (
        f"python-{sys.version_info.major}.{sys.version_info.minor}"
    )


def _runtime_has_foreign_abi(expected_abi: str) -> bool:
    expected_tag = expected_abi.removeprefix("cpython-")
    extension_tag = re.compile(r"\.cpython-(\d+)[-.]")
    for pattern in ("*.so", "*.pyd"):
        for extension in RUNTIME_SITE.rglob(pattern):
            match = extension_tag.search(extension.name)
            if match and match.group(1) != expected_tag:
                return True
    return False


def _ensure_runtime_abi() -> None:
    expected_abi = _python_abi()
    recorded_abi = ""
    if RUNTIME_ABI_MARKER.is_file():
        recorded_abi = RUNTIME_ABI_MARKER.read_text(
            encoding="utf-8",
        ).strip()

    if (
        (recorded_abi and recorded_abi != expected_abi)
        or _runtime_has_foreign_abi(expected_abi)
    ):
        shutil.rmtree(RUNTIME_SITE, ignore_errors=True)

    RUNTIME_SITE.mkdir(parents=True, exist_ok=True)
    RUNTIME_ABI_MARKER.write_text(expected_abi + "\n", encoding="utf-8")


def _load_project_env() -> None:
    env_file = PROJECT_ROOT / ".env"
    if not env_file.is_file():
        return

    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("\"'")
        if key and key not in os.environ:
            os.environ[key] = value


def _runtime_environment() -> dict[str, str]:
    RUNTIME_TMP.mkdir(parents=True, exist_ok=True)
    environment = os.environ.copy()
    current_python_path = environment.get("PYTHONPATH", "")
    paths = [str(RUNTIME_SITE)]
    if current_python_path:
        paths.append(current_python_path)
    environment["PYTHONPATH"] = os.pathsep.join(paths)
    environment["TMPDIR"] = str(RUNTIME_TMP)
    environment["TEMP"] = str(RUNTIME_TMP)
    environment["TMP"] = str(RUNTIME_TMP)
    RUNTIME_CACHE.mkdir(parents=True, exist_ok=True)
    environment["PIP_CACHE_DIR"] = str(RUNTIME_CACHE)
    return environment


def _probe_dependencies() -> str | None:
    probe = subprocess.run(
        [
            sys.executable,
            "-c",
            "import fastapi, numpy, PIL, uvicorn, paddleocr",
        ],
        cwd=PROJECT_ROOT,
        env=_runtime_environment(),
        capture_output=True,
        text=True,
    )
    if probe.returncode == 0:
        return None
    return (probe.stderr or probe.stdout or "dependency probe failed").strip()


def _download_get_pip() -> Path:
    RUNTIME_TMP.mkdir(parents=True, exist_ok=True)
    tempfile.tempdir = str(RUNTIME_TMP)
    handle = tempfile.NamedTemporaryFile(
        prefix="ocr-get-pip-",
        suffix=".py",
        delete=False,
    )
    installer = Path(handle.name)
    try:
        with urlopen(GET_PIP_URL, timeout=30) as response:
            shutil.copyfileobj(response, handle)
    finally:
        handle.close()
    return installer


def _run_pip(arguments: list[str]) -> None:
    command = [
        sys.executable,
        "-m",
        "pip",
        "--disable-pip-version-check",
        *arguments,
    ]
    environment = _runtime_environment()
    try:
        subprocess.run(command, cwd=PROJECT_ROOT, env=environment, check=True)
    except subprocess.CalledProcessError:
        subprocess.run(
            [*command, "--break-system-packages"],
            cwd=PROJECT_ROOT,
            env=environment,
            check=True,
        )


def _ensure_pip() -> None:
    if subprocess.run(
        [sys.executable, "-m", "pip", "--version"],
        cwd=PROJECT_ROOT,
        env=_runtime_environment(),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0:
        return

    installer = _download_get_pip()
    try:
        command = [
            sys.executable,
            str(installer),
            "--target",
            str(RUNTIME_SITE),
            "--disable-pip-version-check",
        ]
        try:
            subprocess.run(
                command,
                cwd=PROJECT_ROOT,
                env=_runtime_environment(),
                check=True,
            )
        except subprocess.CalledProcessError:
            subprocess.run(
                [*command, "--break-system-packages"],
                cwd=PROJECT_ROOT,
                env=_runtime_environment(),
                check=True,
            )
    finally:
        installer.unlink(missing_ok=True)


def _install_python_dependencies() -> None:
    if not REQUIREMENTS_FILE.is_file():
        raise RuntimeError(f"Missing requirements file: {REQUIREMENTS_FILE}")

    RUNTIME_SITE.mkdir(parents=True, exist_ok=True)
    _ensure_pip()
    arguments = [
        "install",
        "--no-input",
        "--upgrade",
        "--target",
        str(RUNTIME_SITE),
        "-r",
        str(REQUIREMENTS_FILE),
    ]
    index_url = os.getenv("OCR_PIP_INDEX_URL", "").strip()
    if index_url:
        arguments[1:1] = ["--index-url", index_url]
    _run_pip(arguments)


def _native_library_error(message: str) -> bool:
    lowered = message.lower()
    return any(
        marker in lowered
        for marker in (
            "libgl",
            "libgomp",
            "glib",
            "libstdc++",
            "cannot open shared object file",
        )
    )


def _install_linux_libraries() -> bool:
    if not sys.platform.startswith("linux"):
        return False
    if hasattr(os, "geteuid") and os.geteuid() != 0:
        return False

    if shutil.which("apt-get"):
        subprocess.run(["apt-get", "update"], check=True)
        packages = ["libgl1", "libglib2.0-0", "libgomp1"]
        result = subprocess.run(
            ["apt-get", "install", "-y", "--no-install-recommends", *packages],
            check=False,
        )
        if result.returncode != 0:
            subprocess.run(
                [
                    "apt-get",
                    "install",
                    "-y",
                    "--no-install-recommends",
                    "libgl1",
                    "libglib2.0-0t64",
                    "libgomp1",
                ],
                check=True,
            )
        return True

    for package_manager, packages in (
        ("dnf", ["mesa-libGL", "glib2", "libgomp"]),
        ("yum", ["mesa-libGL", "glib2", "libgomp"]),
    ):
        if shutil.which(package_manager):
            subprocess.run(
                [package_manager, "install", "-y", *packages],
                check=True,
            )
            return True
    return False


def _prepare_runtime() -> None:
    with _InstallLock():
        _ensure_runtime_abi()
        RUNTIME_TMP.mkdir(parents=True, exist_ok=True)
        dependency_error = _probe_dependencies()
        if dependency_error is None:
            return

        if _native_library_error(dependency_error):
            _install_linux_libraries()
            dependency_error = _probe_dependencies()
            if dependency_error is None:
                return

        _install_python_dependencies()
        dependency_error = _probe_dependencies()
        if dependency_error is not None and _native_library_error(dependency_error):
            _install_linux_libraries()
            dependency_error = _probe_dependencies()
        if dependency_error is not None:
            raise RuntimeError(
                "OCR runtime preparation failed:\n"
                f"{dependency_error}"
            )


def main() -> None:
    os.chdir(PROJECT_ROOT)
    _load_project_env()
    _prepare_runtime()
    sys.path.insert(0, str(RUNTIME_SITE))

    import uvicorn

    port = int(os.getenv("OCR_PORT", "47259"))
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=port,
        log_level=os.getenv("UVICORN_LOG_LEVEL", "info"),
    )


if __name__ == "__main__":
    main()
