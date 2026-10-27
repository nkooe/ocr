from __future__ import annotations

import ipaddress
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, FrozenSet, List, Mapping


PROJECT_ROOT = Path(__file__).resolve().parent.parent
ACCESS_FILE = PROJECT_ROOT / "ocr_access.json"
_DOMAIN_PATTERN = re.compile(
    r"(?=.{1,253}\Z)"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    r"(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\Z"
)


class AccessConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class ResponseCodes:
    success: int
    invalid_request: int
    domain_denied: int
    service_error: int


@dataclass(frozen=True)
class AccessConfig:
    caller_domain_whitelist_enabled: bool
    caller_allowed_domains: FrozenSet[str]
    response_codes: ResponseCodes
    request_timeout_seconds: float
    max_upstream_bytes: int
    upstream_allowed_domains: FrozenSet[str]
    upstream_allowed_ips: FrozenSet[str]
    allow_private_ips: bool
    helipay_url: str
    helipay_referer: str
    helipay_origin: str
    helipay_istoken: str
    helipay_cookie: str
    ahrcu_url: str
    ahrcu_referer: str
    ahrcu_origin: str
    ahrcu_cookie: str
    ahrcu_cache_buster: bool
    ahrcu_resolve_ips: FrozenSet[str]


def _read_bool(data: Mapping[str, Any], name: str, default: bool) -> bool:
    value = data.get(name, default)
    if not isinstance(value, bool):
        raise AccessConfigError(f"{name} must be a boolean")
    return value


def _read_string_list(data: Mapping[str, Any], name: str) -> List[str]:
    value = data.get(name, [])
    if not isinstance(value, list) or not all(
        isinstance(item, str) for item in value
    ):
        raise AccessConfigError(f"{name} must be a list of strings")
    return [item.strip() for item in value if item.strip()]


def _normalize_exact_domain(value: str) -> str:
    domain = value.strip().lower()
    if (
        not domain
        or "*" in domain
        or "://" in domain
        or "/" in domain
        or ":" in domain
        or domain.endswith(".")
    ):
        raise AccessConfigError(f"Invalid exact domain: {value}")

    try:
        ipaddress.ip_address(domain)
    except ValueError:
        pass
    else:
        raise AccessConfigError(f"IP address is not an exact domain: {value}")

    if not _DOMAIN_PATTERN.fullmatch(domain):
        raise AccessConfigError(f"Invalid exact domain: {value}")
    return domain


def _read_exact_domains(
    data: Mapping[str, Any],
    name: str,
) -> FrozenSet[str]:
    return frozenset(
        _normalize_exact_domain(item)
        for item in _read_string_list(data, name)
    )


def _normalize_ip_rule(value: str) -> str:
    rule = value.strip()
    try:
        return str(ipaddress.ip_address(rule))
    except ValueError:
        try:
            return str(ipaddress.ip_network(rule, strict=False))
        except ValueError as exc:
            raise AccessConfigError(f"Invalid upstream IP rule: {value}") from exc


def _read_ip_rules(
    data: Mapping[str, Any],
    name: str,
) -> FrozenSet[str]:
    return frozenset(
        _normalize_ip_rule(item)
        for item in _read_string_list(data, name)
    )


def _read_response_codes(data: Mapping[str, Any]) -> ResponseCodes:
    raw_codes = data.get("response_codes", {})
    if not isinstance(raw_codes, dict):
        raise AccessConfigError("response_codes must be an object")

    values = {}
    for name, default in (
        ("success", 200),
        ("invalid_request", 201),
        ("domain_denied", 203),
        ("service_error", 205),
    ):
        value = raw_codes.get(name, default)
        if isinstance(value, bool) or not isinstance(value, int):
            raise AccessConfigError(f"response_codes.{name} must be an integer")
        if value < 100 or value > 599:
            raise AccessConfigError(
                f"response_codes.{name} must be between 100 and 599"
            )
        values[name] = value

    return ResponseCodes(**values)


def _read_nested_string(
    data: Mapping[str, Any],
    group_name: str,
    name: str,
    default: str,
) -> str:
    group = data.get(group_name, {})
    if not isinstance(group, dict):
        raise AccessConfigError(f"{group_name} must be an object")
    value = group.get(name, default)
    if not isinstance(value, str):
        raise AccessConfigError(f"{group_name}.{name} must be a string")
    return value.strip()


def load_access_config() -> AccessConfig:
    if not ACCESS_FILE.is_file():
        raise AccessConfigError(
            f"Missing global access configuration: {ACCESS_FILE}"
        )

    try:
        raw = json.loads(ACCESS_FILE.read_text(encoding="utf-8"))
    except OSError as exc:
        raise AccessConfigError(
            f"Cannot read global access configuration: {ACCESS_FILE}"
        ) from exc
    except json.JSONDecodeError as exc:
        raise AccessConfigError(
            f"Invalid JSON in global access configuration: {ACCESS_FILE.name}"
        ) from exc

    if not isinstance(raw, dict):
        raise AccessConfigError(f"{ACCESS_FILE.name} must contain a JSON object")

    timeout = raw.get("request_timeout_seconds", 10)
    max_bytes = raw.get("max_upstream_bytes", 5242880)
    if (
        isinstance(timeout, bool)
        or not isinstance(timeout, (int, float))
        or timeout <= 0
    ):
        raise AccessConfigError(
            "request_timeout_seconds must be greater than zero"
        )
    if isinstance(max_bytes, bool) or not isinstance(max_bytes, int):
        raise AccessConfigError("max_upstream_bytes must be an integer")
    if max_bytes <= 0:
        raise AccessConfigError("max_upstream_bytes must be greater than zero")

    ahrcu_group = raw.get("ahrcu", {})
    if not isinstance(ahrcu_group, dict):
        raise AccessConfigError("ahrcu must be an object")

    return AccessConfig(
        caller_domain_whitelist_enabled=_read_bool(
            raw,
            "caller_domain_whitelist_enabled",
            False,
        ),
        caller_allowed_domains=_read_exact_domains(
            raw,
            "caller_allowed_domains",
        ),
        response_codes=_read_response_codes(raw),
        request_timeout_seconds=float(timeout),
        max_upstream_bytes=max_bytes,
        upstream_allowed_domains=_read_exact_domains(
            raw,
            "upstream_allowed_domains",
        ),
        upstream_allowed_ips=_read_ip_rules(raw, "upstream_allowed_ips"),
        allow_private_ips=_read_bool(raw, "allow_private_ips", False),
        helipay_url=_read_nested_string(
            raw,
            "helipay",
            "url",
            "https://upstream-a.example.com/api/captcha",
        ),
        helipay_referer=_read_nested_string(
            raw,
            "helipay",
            "referer",
            "https://upstream-a.example.com/login",
        ),
        helipay_origin=_read_nested_string(
            raw,
            "helipay",
            "origin",
            "https://upstream-a.example.com",
        ),
        helipay_istoken=_read_nested_string(
            raw,
            "helipay",
            "istoken",
            "false",
        ),
        helipay_cookie=_read_nested_string(
            raw,
            "helipay",
            "cookie",
            "",
        ),
        ahrcu_url=_read_nested_string(
            raw,
            "ahrcu",
            "url",
            "https://upstream-b.example.com:1443/api/captcha",
        ),
        ahrcu_referer=_read_nested_string(
            raw,
            "ahrcu",
            "referer",
            "https://upstream-b.example.com:1443/login/",
        ),
        ahrcu_origin=_read_nested_string(
            raw,
            "ahrcu",
            "origin",
            "https://upstream-b.example.com:1443",
        ),
        ahrcu_cookie=_read_nested_string(
            raw,
            "ahrcu",
            "cookie",
            "",
        ),
        ahrcu_cache_buster=_read_bool(ahrcu_group, "cache_buster", True),
        ahrcu_resolve_ips=_read_ip_rules(ahrcu_group, "resolve_ips"),
    )


def exact_domain_match(
    domain: str,
    allowed_domains: FrozenSet[str],
) -> bool:
    return domain.lower() in allowed_domains
