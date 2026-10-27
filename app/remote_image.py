import base64
import binascii
import ipaddress
import json
import socket
import ssl
from dataclasses import dataclass
from http.client import HTTPSConnection
from typing import Mapping, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import (
    HTTPRedirectHandler,
    HTTPSHandler,
    Request,
    build_opener,
)

from app.access_config import AccessConfig


class RemoteImageError(ValueError):
    pass


@dataclass(frozen=True)
class RemoteImage:
    image_bytes: bytes


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers):
        return None


class _PinnedIPHTTPSConnection(HTTPSConnection):
    def __init__(
        self,
        host,
        port=None,
        *,
        timeout=socket._GLOBAL_DEFAULT_TIMEOUT,
        source_address=None,
        context=None,
        blocksize=8192,
        server_hostname=None,
        connect_ip=None,
    ):
        super().__init__(
            host,
            port=port,
            timeout=timeout,
            source_address=source_address,
            context=context,
            blocksize=blocksize,
        )
        self._server_hostname = server_hostname or host
        self._connect_ip = connect_ip or host

    def connect(self):
        self.sock = socket.create_connection(
            (self._connect_ip, self.port),
            self.timeout,
            self.source_address,
        )
        self.sock = self._context.wrap_socket(
            self.sock,
            server_hostname=self._server_hostname,
        )


class _PinnedIPHTTPSHandler(HTTPSHandler):
    def __init__(
        self,
        *,
        context: ssl.SSLContext,
        server_hostname: str,
        connect_ip: str,
    ):
        super().__init__(context=context)
        self._server_hostname = server_hostname
        self._connect_ip = connect_ip

    def https_open(self, request):
        return self.do_open(self._connection_factory, request)

    def _connection_factory(self, host, **kwargs):
        return _PinnedIPHTTPSConnection(
            host,
            context=self._context,
            server_hostname=self._server_hostname,
            connect_ip=self._connect_ip,
            **kwargs,
        )


def _is_private_address(address: str) -> bool:
    ip = ipaddress.ip_address(address)
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _allowed_ip(address: str, allowed_ips: frozenset[str]) -> bool:
    ip = ipaddress.ip_address(address)
    for item in allowed_ips:
        try:
            if ip == ipaddress.ip_address(item):
                return True
        except ValueError:
            try:
                if ip in ipaddress.ip_network(item, strict=False):
                    return True
            except ValueError as exc:
                raise RemoteImageError(f"Invalid allowed IP: {item}") from exc
    return False


def _resolve_addresses(hostname: str, port: int) -> set[str]:
    try:
        results = socket.getaddrinfo(
            hostname,
            port,
            type=socket.SOCK_STREAM,
        )
    except socket.gaierror as exc:
        raise RemoteImageError("Target hostname could not be resolved") from exc
    return {result[4][0] for result in results}


def _validate_target_url(raw_url: str, access: AccessConfig) -> str:
    parsed = urlsplit(raw_url)
    if parsed.scheme.lower() not in {"http", "https"}:
        raise RemoteImageError("Only http and https URLs are supported")
    if parsed.username or parsed.password or parsed.fragment:
        raise RemoteImageError("URL credentials and fragments are not allowed")
    if not parsed.hostname:
        raise RemoteImageError("Target URL must include a hostname")

    hostname = parsed.hostname.rstrip(".").lower()
    try:
        host_ip = ipaddress.ip_address(hostname)
    except ValueError:
        host_ip = None

    if host_ip is None:
        if hostname not in access.upstream_allowed_domains:
            raise RemoteImageError("Target domain is not in the allowlist")
    elif not _allowed_ip(hostname, access.upstream_allowed_ips):
        raise RemoteImageError("Target IP is not in the allowlist")

    try:
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    except ValueError as exc:
        raise RemoteImageError("Target URL contains an invalid port") from exc

    # Validate every DNS result before the server makes the outbound request.
    resolved_addresses = _resolve_addresses(hostname, port)
    if not access.allow_private_ips and any(
        _is_private_address(address) for address in resolved_addresses
    ):
        raise RemoteImageError("Target resolves to a private or reserved IP")

    return parsed.geturl()


def _decode_base64_image(value: object) -> bytes:
    if not isinstance(value, str) or not value.strip():
        raise RemoteImageError("Upstream image field is empty")

    encoded = value.strip()
    if "," in encoded and encoded.lower().startswith("data:"):
        encoded = encoded.split(",", 1)[1]

    try:
        return base64.b64decode("".join(encoded.split()), validate=True)
    except (ValueError, binascii.Error) as exc:
        raise RemoteImageError("Upstream image field is not valid Base64") from exc


def decode_base64_image(value: object) -> bytes:
    """Decode a caller-provided Base64 image using the same validation as upstream data."""
    return _decode_base64_image(value)


def _extract_image(body: bytes, content_type: str) -> RemoteImage:
    # Some captcha services return JSON with a Base64 image field.
    if "json" in content_type.lower() or body.lstrip().startswith(b"{"):
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RemoteImageError("Upstream JSON response is invalid") from exc
        if not isinstance(payload, dict):
            raise RemoteImageError("Upstream JSON response must be an object")

        for field in ("img", "image", "image_base64", "base64"):
            if field in payload:
                return RemoteImage(
                    image_bytes=_decode_base64_image(payload[field]),
                )
        raise RemoteImageError("Upstream JSON does not contain a Base64 image")

    return RemoteImage(image_bytes=body)


def _build_ssl_context(allow_legacy_tls: bool) -> ssl.SSLContext:
    context = ssl.create_default_context()
    if allow_legacy_tls:
        legacy_option = getattr(ssl, "OP_LEGACY_SERVER_CONNECT", 0)
        if legacy_option:
            context.options |= legacy_option
    return context


def _build_opener(
    allow_legacy_tls: bool,
    connect_ip: Optional[str],
    server_hostname: str,
):
    handlers = [_NoRedirectHandler()]
    if connect_ip:
        handlers.append(
            _PinnedIPHTTPSHandler(
                context=_build_ssl_context(allow_legacy_tls),
                server_hostname=server_hostname,
                connect_ip=connect_ip,
            )
        )
    elif allow_legacy_tls:
        context = _build_ssl_context(allow_legacy_tls)
        handlers.append(HTTPSHandler(context=context))
    return build_opener(*handlers)


def fetch_remote_image(
    raw_url: str,
    access: AccessConfig,
    extra_headers: Optional[Mapping[str, str]] = None,
    method: str = "GET",
    request_body: Optional[bytes] = None,
    allow_legacy_tls: bool = False,
    resolve_ips: Optional[frozenset[str]] = None,
) -> RemoteImage:
    target_url = _validate_target_url(raw_url, access)
    parsed = urlsplit(target_url)
    if not parsed.hostname:
        raise RemoteImageError("Target URL must include a hostname")

    headers = {
        "Accept": "application/json,image/*;q=0.9,*/*;q=0.1",
        "Cache-Control": "no-cache",
        "User-Agent": "ocr-service/1.0",
    }
    if extra_headers:
        headers.update(extra_headers)

    request = Request(
        target_url,
        data=request_body,
        headers=headers,
        method=method.upper(),
    )

    connect_ips = sorted(resolve_ips or [])
    if not connect_ips:
        connect_ips = [None]

    last_error: Optional[Exception] = None
    for connect_ip in connect_ips:
        try:
            return _open_remote_image(
                request,
                access,
                allow_legacy_tls=allow_legacy_tls,
                connect_ip=connect_ip,
                server_hostname=parsed.hostname,
            )
        except RemoteImageError as exc:
            last_error = exc
            continue

    if last_error:
        raise last_error
    raise RemoteImageError("Upstream request failed")


def _open_remote_image(
    request: Request,
    access: AccessConfig,
    *,
    allow_legacy_tls: bool,
    connect_ip: Optional[str],
    server_hostname: str,
) -> RemoteImage:
    opener = _build_opener(allow_legacy_tls, connect_ip, server_hostname)
    try:
        with opener.open(request, timeout=access.request_timeout_seconds) as response:
            content_length = response.headers.get("Content-Length")
            if content_length:
                try:
                    if int(content_length) > access.max_upstream_bytes:
                        raise RemoteImageError("Upstream response is too large")
                except ValueError as exc:
                    raise RemoteImageError("Upstream Content-Length is invalid") from exc

            body = response.read(access.max_upstream_bytes + 1)
            if len(body) > access.max_upstream_bytes:
                raise RemoteImageError("Upstream response is too large")
            result = _extract_image(
                body,
                response.headers.get_content_type(),
            )
            return result
    except RemoteImageError:
        raise
    except HTTPError as exc:
        if 300 <= exc.code < 400:
            raise RemoteImageError("Upstream redirects are not allowed") from exc
        raise RemoteImageError(f"Upstream returned HTTP {exc.code}") from exc
    except (TimeoutError, socket.timeout) as exc:
        raise RemoteImageError("Upstream request timed out") from exc
    except URLError as exc:
        reason = getattr(exc, "reason", exc)
        if isinstance(reason, TimeoutError):
            raise RemoteImageError("Upstream request timed out") from exc
        if isinstance(reason, OSError):
            raise RemoteImageError(f"Upstream network error: {reason}") from exc
        raise RemoteImageError(f"Upstream request failed: {reason}") from exc
