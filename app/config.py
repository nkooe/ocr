from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
PROJECT_ENV_FILE = PROJECT_ROOT / ".env"


def load_project_env() -> None:
    if not PROJECT_ENV_FILE.is_file():
        return

    for raw_line in PROJECT_ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("\"'")
        if key and key not in os.environ:
            os.environ[key] = value


load_project_env()


@dataclass(frozen=True)
class Settings:
    max_image_bytes: int
    ocr_language: str
    ocr_version: str
    ocr_device: str
    ocr_cpu_threads: int
    ocr_require_local_models: bool
    ocr_text_detection_model_name: str
    ocr_text_detection_model_dir: Path | None
    ocr_text_recognition_model_name: str
    ocr_text_recognition_model_dir: Path | None
    ocr_text_det_limit_type: str
    ocr_text_det_limit_side_len: int
    ocr_text_rec_score_thresh: float


def _read_bool(name: str, default: bool) -> bool:
    raw_value = os.getenv(name)
    if raw_value is None or not raw_value.strip():
        return default

    value = raw_value.strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{name} must be true or false")


def _read_int(name: str, default: int, minimum: int = 1) -> int:
    raw_value = os.getenv(name)
    value = int(raw_value.strip()) if raw_value and raw_value.strip() else default
    if value < minimum:
        raise RuntimeError(f"{name} must be greater than or equal to {minimum}")
    return value


def _read_float(name: str, default: float, minimum: float = 0.0) -> float:
    raw_value = os.getenv(name)
    value = float(raw_value.strip()) if raw_value and raw_value.strip() else default
    if value < minimum:
        raise RuntimeError(f"{name} must be greater than or equal to {minimum}")
    return value


def _read_path(name: str, default: str) -> Path | None:
    value = os.getenv(name, default).strip()
    if not value:
        return None

    path = Path(value)
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    return path.resolve()


@lru_cache
def get_settings() -> Settings:
    return Settings(
        max_image_bytes=_read_int("OCR_MAX_IMAGE_BYTES", 8388608),
        ocr_language=os.getenv("OCR_LANGUAGE", "ch").strip() or "ch",
        ocr_version=os.getenv("OCR_VERSION", "PP-OCRv5").strip()
        or "PP-OCRv5",
        ocr_device=os.getenv("OCR_DEVICE", "cpu").strip() or "cpu",
        ocr_cpu_threads=_read_int("OCR_CPU_THREADS", 2),
        ocr_require_local_models=_read_bool("OCR_REQUIRE_LOCAL_MODELS", True),
        ocr_text_detection_model_name=os.getenv(
            "OCR_TEXT_DETECTION_MODEL_NAME",
            "PP-OCRv5_server_det",
        ).strip()
        or "PP-OCRv5_server_det",
        ocr_text_detection_model_dir=_read_path(
            "OCR_TEXT_DETECTION_MODEL_DIR",
            "models/PP-OCRv5_server_det_infer",
        ),
        ocr_text_recognition_model_name=os.getenv(
            "OCR_TEXT_RECOGNITION_MODEL_NAME",
            "PP-OCRv5_server_rec",
        ).strip()
        or "PP-OCRv5_server_rec",
        ocr_text_recognition_model_dir=_read_path(
            "OCR_TEXT_RECOGNITION_MODEL_DIR",
            "models/PP-OCRv5_server_rec_infer",
        ),
        ocr_text_det_limit_type=os.getenv(
            "OCR_TEXT_DET_LIMIT_TYPE",
            "min",
        ).strip()
        or "min",
        ocr_text_det_limit_side_len=_read_int(
            "OCR_TEXT_DET_LIMIT_SIDE_LEN",
            64,
        ),
        ocr_text_rec_score_thresh=_read_float(
            "OCR_TEXT_REC_SCORE_THRESH",
            0.0,
        ),
    )
