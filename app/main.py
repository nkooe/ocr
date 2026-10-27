from __future__ import annotations

import asyncio
import json
import logging
import random
import re
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from PIL import UnidentifiedImageError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.access_config import (
    AccessConfig,
    AccessConfigError,
    exact_domain_match,
    load_access_config,
)
from app.config import Settings, get_settings
from app.captcha_preprocess import (
    build_helipay_enhanced_image,
    is_helipay_style_image,
)
from app.helipay_service import parse_helipay_text
from app.math_service import ExpressionError, evaluate_expression
from app.ocr_service import OCRService
from app.remote_image import (
    RemoteImageError,
    decode_base64_image,
    fetch_remote_image,
)


logger = logging.getLogger(__name__)
_ARITHMETIC_OPERATORS = re.compile(r"[+\-*/×✕＊÷／]")


class InvalidRequestError(ValueError):
    pass


class DomainDeniedError(ValueError):
    pass


@dataclass(frozen=True)
class OCRRequest:
    source: str
    url: Optional[str]
    image_base64: Optional[str]


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.ocr_service = OCRService()
    yield


app = FastAPI(
    title="OCR API",
    version="2.0.12",
    description="Single POST endpoint for image OCR and arithmetic recognition.",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)


def _add_cors_headers(
    response: JSONResponse,
    request: Request,
    access: AccessConfig,
) -> JSONResponse:
    origin = request.headers.get("origin")
    if not origin:
        return response

    if not access.caller_domain_whitelist_enabled:
        response.headers["Access-Control-Allow-Origin"] = origin
    else:
        try:
            origin_domain = _header_domain(origin, "origin")
        except DomainDeniedError:
            return response
        if exact_domain_match(origin_domain, access.caller_allowed_domains):
            response.headers["Access-Control-Allow-Origin"] = origin
        else:
            return response

    response.headers["Vary"] = "Origin"
    response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Accept"
    return response


@app.middleware("http")
async def cors_and_preflight(request: Request, call_next):
    try:
        access = load_access_config()
        if request.method == "OPTIONS":
            _check_caller_domain(request, access)
            return _add_cors_headers(
                _response(200, "success", "ok", "ok"),
                request,
                access,
            )

        response = await call_next(request)
        return _add_cors_headers(response, request, access)
    except DomainDeniedError as exc:
        return _response(
            access.response_codes.domain_denied,
            str(exc),
        )
    except AccessConfigError as exc:
        logger.error("Access configuration is invalid: %s", exc)
        return _response(205, "Access configuration is invalid")


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(
    request: Request,
    exc: StarletteHTTPException,
) -> JSONResponse:
    access = None
    try:
        access = load_access_config()
    except AccessConfigError:
        pass
    return _empty_response(
        access,
        "invalid_request",
        str(exc.detail) if exc.detail else "Request failed",
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(
    request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    access = None
    try:
        access = load_access_config()
    except AccessConfigError:
        pass
    return _empty_response(access, "invalid_request", "Invalid request")


def _response(
    code: int,
    message: str,
    result: Optional[str] = None,
    answer: Optional[str] = None,
) -> JSONResponse:
    return JSONResponse(
        status_code=200,
        headers={"Content-Type": "application/json; charset=utf-8"},
        content={
            "code": code,
            "message": message,
            "result": result,
            "answer": answer,
        },
    )


def _empty_response(
    access: Optional[AccessConfig],
    kind: str,
    message: str,
):
    codes = access.response_codes if access else None
    if kind == "invalid_request":
        code = codes.invalid_request if codes else 201
    elif kind == "domain_denied":
        code = codes.domain_denied if codes else 203
    else:
        code = codes.service_error if codes else 205
    return _response(code, message)


def _header_domain(
    value: Optional[str],
    header_name: str,
) -> Optional[str]:
    if not value:
        return None
    value = value.strip()
    if not value or value.lower() == "null":
        raise DomainDeniedError("Caller domain is required")

    parsed = urlsplit(value)
    try:
        parsed.port
    except ValueError as exc:
        raise DomainDeniedError("Caller domain is invalid") from exc
    if (
        parsed.scheme.lower() not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.fragment
        or (
            header_name == "origin"
            and (
                parsed.path not in {"", "/"}
                or parsed.query
            )
        )
    ):
        raise DomainDeniedError("Caller domain is invalid")
    return parsed.hostname.lower()


def _check_caller_domain(
    request: Request,
    access: AccessConfig,
) -> None:
    if not access.caller_domain_whitelist_enabled:
        return

    origin_header = request.headers.get("origin")
    referer_header = request.headers.get("referer")
    domains = []

    if origin_header:
        domains.append(_header_domain(origin_header, "origin"))
    if referer_header:
        domains.append(_header_domain(referer_header, "referer"))
    if not domains:
        raise DomainDeniedError("Caller domain is required")

    if any(
        domain is None
        or not exact_domain_match(domain, access.caller_allowed_domains)
        for domain in domains
    ):
        raise DomainDeniedError("Caller domain is not in the whitelist")


def _parse_request(payload: object) -> OCRRequest:
    if not isinstance(payload, dict):
        raise InvalidRequestError("JSON body must be an object")

    source = payload.get("source")
    if not isinstance(source, str) or not source.strip():
        raise InvalidRequestError("source is required")
    source = source.strip().lower()
    if source not in {"image", "url", "helipay", "ahrcu"}:
        raise InvalidRequestError(
            "source must be one of: image, url, helipay, ahrcu"
        )

    url = payload.get("url")
    image_base64 = payload.get("image_base64")
    if url is not None and not isinstance(url, str):
        raise InvalidRequestError("url must be a string")
    if image_base64 is not None and not isinstance(image_base64, str):
        raise InvalidRequestError("image_base64 must be a string")

    if source == "image" and not image_base64:
        raise InvalidRequestError("image_base64 is required for image source")
    if source == "url" and not url:
        raise InvalidRequestError("url is required for url source")

    return OCRRequest(
        source=source,
        url=url.strip() if isinstance(url, str) else None,
        image_base64=(
            image_base64.strip()
            if isinstance(image_base64, str)
            else None
        ),
    )


def _ahrcu_request_url(access: AccessConfig) -> str:
    if not access.ahrcu_cache_buster:
        return access.ahrcu_url
    separator = "&" if "?" in access.ahrcu_url else "?"
    return f"{access.ahrcu_url}{separator}{random.random():.16f}"


def _helipay_headers(access: AccessConfig) -> dict[str, str]:
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Origin": access.helipay_origin,
        "Referer": access.helipay_referer,
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0"
        ),
        "istoken": access.helipay_istoken,
    }
    if access.helipay_cookie:
        headers["Cookie"] = access.helipay_cookie
    return headers


def _ahrcu_headers(access: AccessConfig) -> dict[str, str]:
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Origin": access.ahrcu_origin,
        "Referer": access.ahrcu_referer,
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0"
        ),
    }
    if access.ahrcu_cookie:
        headers["Cookie"] = access.ahrcu_cookie
    return headers


def _fetch_source(
    request_data: OCRRequest,
    access: AccessConfig,
) -> bytes:
    if request_data.source == "image":
        try:
            return decode_base64_image(request_data.image_base64)
        except RemoteImageError as exc:
            raise InvalidRequestError(str(exc)) from exc

    if request_data.source == "url":
        remote = fetch_remote_image(
            request_data.url,
            access,
        )
        return remote.image_bytes

    if request_data.source == "helipay":
        remote = fetch_remote_image(
            access.helipay_url,
            access,
            extra_headers=_helipay_headers(access),
        )
        return remote.image_bytes

    target_url = _ahrcu_request_url(access)
    remote = fetch_remote_image(
        target_url,
        access,
        extra_headers=_ahrcu_headers(access),
        method="POST",
        request_body=b"{}",
        allow_legacy_tls=True,
        resolve_ips=access.ahrcu_resolve_ips,
    )
    return remote.image_bytes


def _recognize_lines(image_bytes: bytes):
    try:
        return app.state.ocr_service.recognize(image_bytes)
    except UnidentifiedImageError as exc:
        raise InvalidRequestError("Unsupported image file") from exc


def _recognize_line_text(image_bytes: bytes) -> str:
    return "\n".join(line.text for line in _recognize_lines(image_bytes)).strip()


def _recognize_text(image_bytes: bytes, source: str) -> tuple[str, Optional[str]]:
    result = _recognize_line_text(image_bytes)
    use_helipay_pipeline = source == "helipay"
    if source in {"image", "url"}:
        try:
            use_helipay_pipeline = is_helipay_style_image(image_bytes)
        except UnidentifiedImageError as exc:
            raise InvalidRequestError("Unsupported image file") from exc

    if not use_helipay_pipeline:
        return result, _build_answer(result)

    parsed = parse_helipay_text(result)
    if parsed is not None:
        return parsed.result, parsed.answer

    enhanced_result = _recognize_line_text(
        build_helipay_enhanced_image(image_bytes)
    )
    parsed = parse_helipay_text(enhanced_result)
    if parsed is not None:
        return parsed.result, parsed.answer
    if not result and enhanced_result:
        result = enhanced_result

    return result, _build_answer(result)


def _build_answer(result: str) -> Optional[str]:
    if not result:
        return None
    if not _ARITHMETIC_OPERATORS.search(result):
        return result

    try:
        _, value = evaluate_expression(result)
    except ExpressionError:
        return result
    return str(value)


@app.post("/api/v1/ocr/recognize")
async def recognize(request: Request) -> JSONResponse:
    access = None
    try:
        access = load_access_config()
        _check_caller_domain(request, access)

        try:
            payload = await request.json()
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise InvalidRequestError("Request body must be valid JSON") from exc

        request_data = _parse_request(payload)
        settings: Settings = get_settings()
        image_bytes = await asyncio.to_thread(
            _fetch_source,
            request_data,
            access,
        )
        if len(image_bytes) > settings.max_image_bytes:
            raise InvalidRequestError("Image is too large")

        result, answer = await asyncio.to_thread(
            _recognize_text,
            image_bytes,
            request_data.source,
        )
        return _response(
            access.response_codes.success,
            "success",
            result,
            answer,
        )
    except DomainDeniedError as exc:
        return _empty_response(access, "domain_denied", str(exc))
    except AccessConfigError as exc:
        logger.error("Access configuration is invalid: %s", exc)
        return _response(205, "Access configuration is invalid")
    except InvalidRequestError as exc:
        return _empty_response(access, "invalid_request", str(exc))
    except (RemoteImageError, TimeoutError) as exc:
        return _empty_response(access, "service_error", str(exc))
    except Exception:
        logger.exception("OCR request failed")
        return _empty_response(access, "service_error", "OCR service failed")


@app.get("/health")
async def health() -> JSONResponse:
    return _response(200, "success", "ok")
