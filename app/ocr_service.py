from dataclasses import dataclass
from io import BytesIO
import os
from pathlib import Path
from threading import Lock
from typing import Any

import numpy as np
from PIL import Image

os.environ.setdefault("FLAGS_enable_pir_api", "0")

from paddleocr import PaddleOCR

from app.config import Settings, get_settings


@dataclass(frozen=True)
class OCRLine:
    text: str
    confidence: float


class OCRService:
    def __init__(self) -> None:
        settings = get_settings()
        model_options = self._model_options(settings)

        try:
            self.pipeline = PaddleOCR(
                lang=settings.ocr_language,
                ocr_version=settings.ocr_version,
                text_detection_model_name=settings.ocr_text_detection_model_name,
                text_recognition_model_name=settings.ocr_text_recognition_model_name,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                enable_mkldnn=False,
                cpu_threads=settings.ocr_cpu_threads,
                device=settings.ocr_device,
                text_det_limit_type=settings.ocr_text_det_limit_type,
                text_det_limit_side_len=settings.ocr_text_det_limit_side_len,
                text_rec_score_thresh=settings.ocr_text_rec_score_thresh,
                **model_options,
            )
        except Exception as exc:
            raise RuntimeError(
                "PaddleOCR initialization failed. "
                "Check PaddlePaddle, PaddleOCR, and local model files."
            ) from exc
        # Paddle's predictor is not safe for concurrent calls in one process.
        # Serialize inference so concurrent API requests cannot crash native code.
        self._predict_lock = Lock()

    @staticmethod
    def _model_options(settings: Settings) -> dict[str, str]:
        if not settings.ocr_require_local_models:
            # false explicitly enables PaddleOCR's model download behavior.
            # A missing local directory is never silently used as a fallback.
            return {}

        model_dirs = {
            "text_detection_model_dir": settings.ocr_text_detection_model_dir,
            "text_recognition_model_dir": settings.ocr_text_recognition_model_dir,
        }
        for option_name, model_dir in model_dirs.items():
            if model_dir is None:
                raise RuntimeError(
                    f"{option_name} must be configured when "
                    "OCR_REQUIRE_LOCAL_MODELS=true"
                )
            OCRService._validate_model_dir(model_dir, option_name)

        return {
            option_name: str(model_dir)
            for option_name, model_dir in model_dirs.items()
            if model_dir is not None
        }

    @staticmethod
    def _validate_model_dir(model_dir: Path, option_name: str) -> None:
        if not model_dir.is_dir():
            raise RuntimeError(
                f"{option_name} does not exist or is not a directory: "
                f"{model_dir}"
            )

        files = [item for item in model_dir.rglob("*") if item.is_file()]
        if not files:
            raise RuntimeError(f"{option_name} is empty: {model_dir}")

        has_weights = any(
            item.name.lower().endswith((".pdiparams", ".pdmodel"))
            for item in files
        )
        has_config = any(
            item.name.lower()
            in {
                "inference.yml",
                "inference.yaml",
                "inference.json",
                "model.yml",
                "model.yaml",
                "model.json",
            }
            for item in files
        )
        if not has_weights or not has_config:
            raise RuntimeError(
                f"{option_name} is not a complete Paddle inference model: "
                f"{model_dir}"
            )

    def recognize(self, image_bytes: bytes) -> list[OCRLine]:
        image = Image.open(BytesIO(image_bytes)).convert("RGB")
        with self._predict_lock:
            results = self.pipeline.predict(np.asarray(image))
        lines: list[OCRLine] = []

        for result in results:
            payload = result.json
            data: dict[str, Any] = payload.get("res", payload)
            texts = data.get("rec_texts", [])
            scores = data.get("rec_scores", [])
            for text, score in zip(texts, scores):
                text = str(text).strip()
                if text:
                    lines.append(
                        OCRLine(
                            text=text,
                            confidence=round(float(score), 6),
                        )
                    )
        return lines
