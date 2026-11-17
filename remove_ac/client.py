"""remove.ac Official Zero-Dependency Python SDK + 1:1 removebg drop-in client."""
from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import os
import socket
import struct
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Callable, Dict, List, Literal, Optional, Sequence, Tuple, Union

__version__ = "1.3.0"
SDK_VERSION = __version__
USER_AGENT = f"remove-ac-python-sdk/{SDK_VERSION}"

DEFAULT_BASE_URL = "https://remove.ac"
DIRECT_THRESHOLD_BYTES = 4 * 1024 * 1024
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
DIRECT_RGBA_PNG_PIXELS = 5_000_000
DIRECT_CROPPED_RGBA_PNG_PIXELS = 10_000_000

VALID_SIZES: Tuple[str, ...] = (
    "auto",
    "preview",
    "small",
    "regular",
    "medium",
    "hd",
    "4k",
    "25mp",
    "50mp",
    "full",
)
VALID_FORMATS: Tuple[str, ...] = ("auto", "png", "jpg", "jpeg", "webp", "zip")
VALID_CHANNELS: Tuple[str, ...] = ("rgba", "alpha")
VALID_TYPES: Tuple[str, ...] = (
    "auto",
    "person",
    "product",
    "car",
    "animal",
    "graphic",
    "transportation",
)
VALID_SHADOW_TYPES: Tuple[str, ...] = (
    "auto",
    "car",
    "drop",
    "soft",
    "contact",
    "reflection",
    "none",
)

SizeLiteral = Literal[
    "auto",
    "preview",
    "small",
    "regular",
    "medium",
    "hd",
    "4k",
    "25mp",
    "50mp",
    "full",
]


def parse_image_dimensions(data: bytes) -> Optional[Tuple[int, int]]:
    if not data or len(data) < 10:
        return None
    if len(data) >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
        w, h = struct.unpack(">II", data[16:24])
        return (w, h) if 0 < w <= 1_000_000 and 0 < h <= 1_000_000 else None
    if data[:6] in (b"GIF87a", b"GIF89a"):
        w, h = struct.unpack("<HH", data[6:10])
        return (w, h) if w > 0 and h > 0 else None
    if len(data) >= 25 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        chunk = data[12:16]
        if chunk == b"VP8 " and len(data) >= 30 and data[23:26] == b"\x9d\x01\x2a":
            w, h = struct.unpack("<HH", data[26:30])
            w &= 0x3FFF
            h &= 0x3FFF
            return (w, h) if w > 0 and h > 0 else None
        if chunk == b"VP8L" and data[20] == 0x2F:
            b0, b1, b2, b3 = data[21], data[22], data[23], data[24]
            w = 1 + (b0 | ((b1 & 0x3F) << 8))
            h = 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0F) << 10))
            return (w, h) if w > 0 and h > 0 else None
        if chunk == b"VP8X" and len(data) >= 30:
            w = 1 + (data[24] | (data[25] << 8) | (data[26] << 16))
            h = 1 + (data[27] | (data[28] << 8) | (data[29] << 16))
            return (w, h) if w > 0 and h > 0 else None
    if data[:2] == b"\xff\xd8":
        pos = 2
        steps = 0
        while steps < 512 and pos + 3 < len(data):
            steps += 1
            if data[pos] != 0xFF:
                break
            while pos < len(data) and data[pos] == 0xFF:
                pos += 1
            if pos >= len(data):
                break
            marker = data[pos]
            pos += 1
            if marker in (0xD9, 0xDA):
                break
            if marker in (0x00, 0x01) or (0xD0 <= marker <= 0xD7):
                continue
            if pos + 1 >= len(data):
                break
            seg_len = (data[pos] << 8) | data[pos + 1]
            if seg_len < 2:
                break
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                if pos + 6 >= len(data):
                    break
                h = (data[pos + 3] << 8) | data[pos + 4]
                w = (data[pos + 5] << 8) | data[pos + 6]
                return (w, h) if w > 0 and h > 0 else None
            pos += seg_len
    return None


def _should_preflight_via_ticket(
    img_bytes: Optional[bytes], size: str, fmt: str, channels: str, crop: bool
) -> bool:
    if not img_bytes:
        return False
    if fmt not in ("png", "auto", "zip") or channels == "alpha":
        return False
    dims = parse_image_dimensions(img_bytes)
    if not dims:
        return False
    input_px = dims[0] * dims[1]
    if size in ("preview", "small", "regular"):
        eff = min(input_px, 250_000)
    elif size == "medium":
        eff = min(input_px, 1_500_000)
    elif size == "hd":
        eff = min(input_px, 4_000_000)
    elif size == "4k":
        eff = min(input_px, 10_000_000)
    elif size == "25mp":
        eff = min(input_px, 25_000_000)
    elif size == "50mp":
        eff = min(input_px, 50_000_000)
    else:
        eff = input_px
    return eff > (DIRECT_CROPPED_RGBA_PNG_PIXELS if crop else DIRECT_RGBA_PNG_PIXELS)


class RemoveAcError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(f"[HTTP {status_code}] {message}")
        self.status_code = status_code


def derive_sub_idempotency_key(idem: str, suffix: str) -> str:
    trimmed = (idem or "").strip()
    if not trimmed or len(trimmed) > 255:
        raise RemoveAcError(400, "idempotency_key must be between 1 and 255 characters")
    direct = f"{trimmed}:{suffix}"
    if len(direct) <= 255:
        return direct
    digest = hashlib.sha256(trimmed.encode("utf-8")).hexdigest()[:32]
    return f"{trimmed[:180]}:{digest}:{suffix}"


def _infer_mime_type(data: bytes, filename: str = "") -> str:
    if data and len(data) >= 12:
        if data[:4] == b"\x89PNG":
            return "image/png"
        if data[:2] == b"\xff\xd8":
            return "image/jpeg"
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            return "image/webp"
        if data[:4] == b"GIF8":
            return "image/gif"
    ext = os.path.splitext(filename or "")[1].lower()
    if ext == ".png":
        return "image/png"
    if ext in (".jpg", ".jpeg"):
        return "image/jpeg"
    if ext == ".webp":
        return "image/webp"
    if ext == ".gif":
        return "image/gif"
    return "application/octet-stream"


def _decode_base64_image(raw_b64: str, label: str) -> Tuple[str, bytes]:
    trimmed = (raw_b64 or "").strip()
    payload = trimmed
    if payload.lower().startswith("data:image/"):
        comma_idx = payload.find(",")
        if comma_idx == -1 or ";base64" not in payload[:comma_idx].lower():
            raise RemoveAcError(400, f"Invalid {label}: malformed data URI")
        payload = payload[comma_idx + 1 :]
    compact = "".join(payload.split())
    if not compact or len(compact) % 4 == 1:
        raise RemoveAcError(400, f"Invalid {label}: malformed base64 payload")
    padded = compact if len(compact) % 4 == 0 else compact + ("=" * (4 - (len(compact) % 4)))
    try:
        decoded = base64.b64decode(padded, validate=True)
    except Exception as exc:
        raise RemoveAcError(400, f"Invalid {label}: malformed base64 payload") from exc
    if len(decoded) == 0:
        raise RemoveAcError(400, f"{label} must not be empty")
    if len(decoded) > MAX_UPLOAD_BYTES:
        raise RemoveAcError(413, f"{label} exceeds 25 MB maximum upload size (26214400 bytes)")
    return trimmed, decoded


def _encode_multipart(
    fields: Dict[str, str],
    file_tuple: Optional[Tuple[str, str, bytes]] = None,
    extra_files: Optional[Sequence[Tuple[str, str, bytes]]] = None,
) -> Tuple[bytes, str]:
    boundary = f"----RemoveAcBoundary{uuid.uuid4().hex}"
    chunks = []
    for key, val in fields.items():
        safe_key = str(key).replace('"', "_").replace("\r", "_").replace("\n", "_")
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(f'Content-Disposition: form-data; name="{safe_key}"\r\n\r\n'.encode("utf-8"))
        chunks.append(f"{val}\r\n".encode("utf-8"))
    all_files: List[Tuple[str, str, bytes]] = []
    if file_tuple is not None:
        all_files.append(file_tuple)
    if extra_files:
        all_files.extend(extra_files)
    for field_name, filename, raw_bytes in all_files:
        safe_field = str(field_name).replace('"', "_").replace("\r", "_").replace("\n", "_")
        safe_name = str(filename).replace('"', "_").replace("\r", "_").replace("\n", "_")
        mime = _infer_mime_type(raw_bytes, safe_name)
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(
            f'Content-Disposition: form-data; name="{safe_field}"; filename="{safe_name}"\r\n'
            f"Content-Type: {mime}\r\n\r\n".encode("utf-8")
        )
        chunks.append(raw_bytes)
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


TransportFn = Callable[[str, str, Dict[str, str], Optional[bytes], int], Tuple[int, Dict[str, str], bytes]]
ResolverFn = Callable[[str], Sequence[str]]

_CGNAT_NET = ipaddress.ip_network("100.64.0.0/10")
_BENCHMARK_NET = ipaddress.ip_network("198.18.0.0/15")
_DISCARD_V6_NET = ipaddress.ip_network("100::/64")
_NAT64_LOCAL_NET = ipaddress.ip_network("64:ff9b:1::/48")


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def http_error_302(self, req, fp, code, msg, headers):
        raise urllib.error.HTTPError(req.full_url, code, msg, headers, fp)

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, msg, headers, fp)


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirectHandler())


def _is_disallowed_ip(raw_ip: str) -> bool:
    clean = raw_ip.strip().strip("[]").split("%", 1)[0]
    try:
        ip_obj = ipaddress.ip_address(clean)
    except ValueError:
        return True

    if isinstance(ip_obj, ipaddress.IPv6Address):
        if ip_obj.ipv4_mapped is not None:
            return _is_disallowed_ip(str(ip_obj.ipv4_mapped))
        ip_int = int(ip_obj)
        # Well-known NAT64 64:ff9b::/96
        if (ip_int >> 32) == 0x0064FF9B0000000000000000:
            return _is_disallowed_ip(str(ipaddress.IPv4Address(ip_int & 0xFFFFFFFF)))
        if ip_obj in _NAT64_LOCAL_NET or ip_obj in _DISCARD_V6_NET:
            return True
        # IPv4-compatible ::w.x.y.z or SIIT ::ffff:0:w.x.y.z
        if (ip_int >> 32) in (0, 0xFFFF0000) and ip_int > 1:
            return _is_disallowed_ip(str(ipaddress.IPv4Address(ip_int & 0xFFFFFFFF)))
        return (
            not ip_obj.is_global
            or ip_obj.is_private
            or ip_obj.is_loopback
            or ip_obj.is_link_local
            or ip_obj.is_multicast
            or ip_obj.is_reserved
            or ip_obj.is_unspecified
            or ip_obj.is_site_local
        )

    if ip_obj in _CGNAT_NET or ip_obj in _BENCHMARK_NET:
        return True
    return (
        not ip_obj.is_global
        or ip_obj.is_private
        or ip_obj.is_loopback
        or ip_obj.is_link_local
        or ip_obj.is_multicast
        or ip_obj.is_reserved
        or ip_obj.is_unspecified
    )


def _default_resolver(host: str) -> List[str]:
    infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    return [str(entry[4][0]) for entry in infos if entry and len(entry) >= 5 and entry[4]]


def _is_loopback_test_origin(raw_url: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(raw_url.strip())
    except Exception:
        return False
    if parsed.scheme.lower() != "http":
        return False
    host = (parsed.hostname or "").lower()
    return host in ("127.0.0.1", "::1", "localhost")


def validate_https_endpoint_url(
    raw_url: str,
    *,
    allow_loopback_origin: bool = False,
    resolver: Optional[ResolverFn] = None,
    label: str = "directEndpoint",
) -> Optional[str]:
    try:
        parsed = urllib.parse.urlsplit((raw_url or "").strip())
    except Exception:
        return f"Invalid {label} URL"
    if parsed.username or parsed.password:
        return f"{label} must not contain embedded credentials"
    if allow_loopback_origin and _is_loopback_test_origin(raw_url):
        return None
    if parsed.scheme.lower() != "https":
        return f"{label} must use https://"
    host = (parsed.hostname or "").lower()
    if (
        not host
        or host == "localhost"
        or host.endswith(".localhost")
        or host.endswith(".local")
        or host.endswith(".internal")
        or host.endswith(".home.arpa")
    ):
        return f"Disallowed {label} (local or internal hostname)"

    clean_host = host.split("%", 1)[0]
    try:
        ipaddress.ip_address(clean_host)
        is_literal = True
    except ValueError:
        is_literal = False

    if is_literal:
        if _is_disallowed_ip(clean_host):
            return f"Disallowed {label} (private, loopback, or reserved IP address)"
        return None

    if "." not in host or host.isdigit() or host.startswith("0x"):
        return f"Disallowed {label} (single-label or numeric hostname)"

    resolve_fn = resolver or _default_resolver
    try:
        addrs = list(resolve_fn(host))
    except Exception:
        return f"Disallowed {label} (unable to resolve hostname '{host}')"
    if not addrs:
        return f"Disallowed {label} (hostname '{host}' returned no DNS records)"
    allow_tun_fake_ip = host == "remove.ac" or host.endswith(".remove.ac")
    for addr in addrs:
        if not addr:
            return f"Disallowed {label} (hostname '{host}' resolves to a private, loopback, or reserved IP)"
        clean_addr = str(addr).strip().strip("[]").split("%", 1)[0]
        try:
            addr_obj = ipaddress.ip_address(clean_addr)
        except ValueError:
            return f"Disallowed {label} (hostname '{host}' resolves to an invalid IP)"
        if allow_tun_fake_ip and isinstance(addr_obj, ipaddress.IPv4Address) and addr_obj in _BENCHMARK_NET:
            continue
        if _is_disallowed_ip(clean_addr):
            return f"Disallowed {label} (hostname '{host}' resolves to a private, loopback, or reserved IP)"
    return None


def _ensure_user_agent(headers: Dict[str, str]) -> Dict[str, str]:
    merged = dict(headers or {})
    if not any(k.lower() == "user-agent" for k in merged):
        merged["User-Agent"] = USER_AGENT
    return merged


def _default_transport(
    method: str,
    url: str,
    headers: Dict[str, str],
    body: Optional[bytes],
    timeout: int,
) -> Tuple[int, Dict[str, str], bytes]:
    req = urllib.request.Request(
        url,
        data=body,
        headers=_ensure_user_agent(headers),
        method=method,
    )
    try:
        with _NO_REDIRECT_OPENER.open(req, timeout=timeout) as resp:
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            return resp.status, resp_headers, resp.read()
    except urllib.error.HTTPError as exc:
        try:
            err_body = exc.read() if exc.fp else b""
            resp_headers = {k.lower(): v for k, v in (exc.headers.items() if exc.headers else [])}
            return exc.code, resp_headers, err_body
        finally:
            exc.close()


class RemoveAcClient:
    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        transport: Optional[TransportFn] = None,
        resolver: Optional[ResolverFn] = None,
    ):
        self.api_key = (
            api_key
            or os.environ.get("REMOVE_AC_API_KEY")
            or os.environ.get("REMOVE_BG_API_KEY")
            or ""
        )
        resolved_base = base_url or os.environ.get("REMOVE_AC_BASE_URL") or DEFAULT_BASE_URL
        self.base_url = resolved_base.rstrip("/")
        self._transport = transport or _default_transport
        self._resolver = resolver

    def _release_ticket_hold(
        self, hold_id: Optional[str], release_token: Optional[str]
    ) -> bool:
        if not hold_id or not release_token or not self.api_key:
            return False
        try:
            r_status, _, _ = self._transport(
                "POST",
                f"{self.base_url}/v1.0/removebg/ticket/release",
                _ensure_user_agent(
                    {
                        "Content-Type": "application/json",
                        "X-Api-Key": self.api_key,
                    }
                ),
                json.dumps({"holdId": hold_id, "releaseToken": release_token}).encode("utf-8"),
                5,
            )
            return 200 <= r_status < 300
        except Exception:
            return False

    def get_account(self, timeout: int = 15) -> Dict[str, Any]:
        if not self.api_key:
            raise RemoveAcError(403, "Missing remove.ac API key")
        status, _, body = self._transport(
            "GET",
            f"{self.base_url}/v1.0/account",
            _ensure_user_agent({"X-Api-Key": self.api_key}),
            None,
            timeout,
        )
        if status < 200 or status >= 300:
            raise RemoveAcError(status, body.decode("utf-8", errors="replace"))
        return json.loads(body.decode("utf-8"))

    def remove_background(
        self,
        image: Union[str, bytes, bytearray, os.PathLike],
        *,
        size: Union[SizeLiteral, str] = "auto",
        format: str = "png",
        channels: str = "rgba",
        type: str = "auto",
        type_level: Optional[str] = None,
        roi: Optional[str] = None,
        scale: Optional[str] = None,
        position: Optional[str] = None,
        bg_color: Optional[str] = None,
        bg_image_url: Optional[str] = None,
        bg_image_file: Optional[Union[str, bytes, bytearray, os.PathLike]] = None,
        bg_image_file_b64: Optional[str] = None,
        crop: bool = False,
        crop_margin: Optional[str] = None,
        add_shadow: bool = False,
        shadow_type: Optional[str] = None,
        shadow_opacity: Optional[float] = None,
        semitransparency: bool = True,
        direct: bool = False,
        idempotency_key: Optional[str] = None,
        timeout: int = 90,
    ) -> bytes:
        if not self.api_key:
            raise RemoveAcError(403, "Missing remove.ac API key")

        norm_size = str(size or "auto").strip().lower()
        if norm_size not in VALID_SIZES:
            raise RemoveAcError(
                400, f"Unsupported size '{size}'. Expected one of: {', '.join(VALID_SIZES)}"
            )
        norm_format = str(format or "png").strip().lower()
        if norm_format not in VALID_FORMATS:
            raise RemoveAcError(
                400, f"Unsupported format '{format}'. Expected one of: {', '.join(VALID_FORMATS)}"
            )
        norm_channels = str(channels or "rgba").strip().lower()
        if norm_channels not in VALID_CHANNELS:
            raise RemoveAcError(
                400, f"Unsupported channels '{channels}'. Expected one of: {', '.join(VALID_CHANNELS)}"
            )
        norm_type = str(type or "auto").strip().lower()
        if norm_type not in VALID_TYPES:
            raise RemoveAcError(
                400, f"Unsupported type '{type}'. Expected one of: {', '.join(VALID_TYPES)}"
            )
        norm_shadow_type: Optional[str] = None
        if shadow_type is not None and str(shadow_type).strip() != "":
            norm_shadow_type = str(shadow_type).strip().lower()
            if norm_shadow_type not in VALID_SHADOW_TYPES:
                raise RemoveAcError(
                    400,
                    f"Unsupported shadow_type '{shadow_type}'. Expected one of: {', '.join(VALID_SHADOW_TYPES)}",
                )

        clean_bg_color = str(bg_color).strip() if bg_color is not None else ""
        clean_bg_url = str(bg_image_url).strip() if bg_image_url is not None else ""
        has_bg_file = bg_image_file is not None
        if bg_image_file_b64 is not None and not isinstance(bg_image_file_b64, str):
            raise RemoveAcError(400, "bg_image_file_b64 must be a base64 string")
        clean_bg_b64_input = bg_image_file_b64.strip() if bg_image_file_b64 is not None else ""
        if bg_image_file_b64 is not None and not clean_bg_b64_input:
            raise RemoveAcError(400, "bg_image_file_b64 must not be empty")

        bg_source_count = (
            (1 if clean_bg_color else 0)
            + (1 if clean_bg_url else 0)
            + (1 if has_bg_file else 0)
            + (1 if clean_bg_b64_input else 0)
        )
        if bg_source_count > 1:
            raise RemoveAcError(
                400,
                "Specify at most one of bg_color, bg_image_url, bg_image_file, or bg_image_file_b64",
            )

        if idempotency_key is not None:
            trimmed_idem = idempotency_key.strip()
            if not trimmed_idem or len(trimmed_idem) > 255:
                raise RemoveAcError(400, "idempotency_key must be between 1 and 255 characters")
            idem = trimmed_idem
        else:
            idem = f"pysdk-{uuid.uuid4()}"

        bg_bytes: Optional[bytes] = None
        bg_name = "bg-image.png"
        bg_b64_clean = ""
        bg_b64_decoded: Optional[bytes] = None

        if has_bg_file:
            if isinstance(bg_image_file, (bytes, bytearray)):
                bg_bytes = bytes(bg_image_file)
            elif isinstance(bg_image_file, (str, os.PathLike)):
                bg_path_str = os.fspath(bg_image_file)
                if not isinstance(bg_path_str, str):
                    bg_path_str = os.fsdecode(bg_path_str)
                trimmed_bg_path = bg_path_str.strip()
                if not trimmed_bg_path or "\x00" in trimmed_bg_path:
                    raise RemoveAcError(400, "bg_image_file path must not be empty")
                if isinstance(bg_image_file, str) and trimmed_bg_path.lower().startswith(
                    ("http://", "https://")
                ):
                    raise RemoveAcError(
                        400,
                        "bg_image_file expects a local file path or bytes; use bg_image_url for remote URLs",
                    )
                bg_name = os.path.basename(trimmed_bg_path) or "bg-image.png"
                with open(trimmed_bg_path, "rb") as bg_fh:
                    bg_bytes = bg_fh.read()
            else:
                raise RemoveAcError(400, "Unsupported bg_image_file input")

            if len(bg_bytes) == 0:
                raise RemoveAcError(400, "bg_image_file must not be empty")
            if len(bg_bytes) > MAX_UPLOAD_BYTES:
                raise RemoveAcError(
                    413, "bg_image_file exceeds 25 MB maximum upload size (26214400 bytes)"
                )
        elif clean_bg_b64_input:
            bg_b64_clean, bg_b64_decoded = _decode_base64_image(
                clean_bg_b64_input, "bg_image_file_b64"
            )

        img_bytes: Optional[bytes] = None
        img_name = "image.png"
        img_url: Optional[str] = None

        if isinstance(image, (bytes, bytearray)):
            img_bytes = bytes(image)
        elif isinstance(image, str) and image.startswith(("http://", "https://")):
            img_url = image
        elif isinstance(image, (str, os.PathLike)):
            img_path_str = os.fspath(image)
            if not isinstance(img_path_str, str):
                img_path_str = os.fsdecode(img_path_str)
            img_name = os.path.basename(img_path_str) or "image.png"
            with open(img_path_str, "rb") as fh:
                img_bytes = fh.read()
        else:
            raise RemoveAcError(400, "Unsupported image input")

        ticket_bg_bytes = bg_bytes if bg_bytes is not None else bg_b64_decoded

        def _via_ticket(suffix: str) -> bytes:
            if img_bytes is None:
                raise RemoveAcError(413, "Ticket mode requires binary input")
            payload: Dict[str, Any] = {
                "foregroundSha256": hashlib.sha256(img_bytes).hexdigest(),
                "foregroundByteLength": len(img_bytes),
                "size": norm_size,
                "format": norm_format,
                "channels": norm_channels,
                "semitransparency": semitransparency,
            }
            if norm_type and norm_type != "auto":
                payload["type"] = norm_type
            if type_level:
                payload["type_level"] = type_level
            if roi:
                payload["roi"] = roi
            if scale:
                payload["scale"] = scale
            if position:
                payload["position"] = position
            if clean_bg_color:
                payload["bg_color"] = clean_bg_color
            if clean_bg_url:
                payload["bg_image_url"] = clean_bg_url
            if ticket_bg_bytes is not None:
                payload["bgImageSha256"] = hashlib.sha256(ticket_bg_bytes).hexdigest()
                payload["bgImageByteLength"] = len(ticket_bg_bytes)
            if crop:
                payload["crop"] = True
            if crop_margin:
                payload["crop_margin"] = crop_margin
            if add_shadow:
                payload["add_shadow"] = True
            if norm_shadow_type:
                payload["shadow_type"] = norm_shadow_type
            if shadow_opacity is not None:
                payload["shadow_opacity"] = shadow_opacity

            t_status, _, t_body = self._transport(
                "POST",
                f"{self.base_url}/v1.0/removebg/ticket",
                _ensure_user_agent(
                    {
                        "Content-Type": "application/json",
                        "X-Api-Key": self.api_key,
                        "Idempotency-Key": derive_sub_idempotency_key(idem, suffix),
                    }
                ),
                json.dumps(payload).encode("utf-8"),
                30,
            )
            if t_status < 200 or t_status >= 300:
                raise RemoveAcError(t_status, t_body.decode("utf-8", errors="replace"))
            try:
                parsed_ticket = json.loads(t_body.decode("utf-8"))
            except Exception as exc:
                raise RemoveAcError(502, "Invalid JSON in /v1.0/removebg/ticket response") from exc
            t_data = parsed_ticket.get("data") if isinstance(parsed_ticket, dict) else None
            ticket_tok = t_data.get("ticket") if isinstance(t_data, dict) else None
            direct_ep = t_data.get("directEndpoint") if isinstance(t_data, dict) else None
            raw_hold_id = (
                (t_data.get("holdId") or t_data.get("lock_id")) if isinstance(t_data, dict) else None
            )
            raw_release_tok = (
                (t_data.get("releaseToken") or t_data.get("release_token"))
                if isinstance(t_data, dict)
                else None
            )
            hold_id = raw_hold_id.strip() if isinstance(raw_hold_id, str) and raw_hold_id.strip() else None
            release_tok = (
                raw_release_tok.strip()
                if isinstance(raw_release_tok, str) and raw_release_tok.strip()
                else None
            )

            if (
                not isinstance(ticket_tok, str)
                or not ticket_tok.strip()
                or not isinstance(direct_ep, str)
                or not direct_ep.strip()
            ):
                self._release_ticket_hold(hold_id, release_tok)
                raise RemoveAcError(502, "Missing ticket or directEndpoint in /v1.0/removebg/ticket response")
            ep_err = validate_https_endpoint_url(
                direct_ep,
                allow_loopback_origin=_is_loopback_test_origin(self.base_url),
                resolver=self._resolver,
                label="directEndpoint",
            )
            if ep_err:
                self._release_ticket_hold(hold_id, release_tok)
                raise RemoveAcError(502, ep_err)
            direct_extra_files = (
                [("bg_image_file", bg_name, ticket_bg_bytes)] if ticket_bg_bytes is not None else None
            )
            mp_body, mp_ct = _encode_multipart(
                {}, ("image_file", img_name, img_bytes), direct_extra_files
            )
            try:
                d_status, _, d_body = self._transport(
                    "POST",
                    direct_ep,
                    _ensure_user_agent(
                        {
                            "Authorization": f"Bearer {ticket_tok}",
                            "Content-Type": mp_ct,
                        }
                    ),
                    mp_body,
                    timeout,
                )
            except Exception:
                self._release_ticket_hold(hold_id, release_tok)
                raise
            if d_status < 200 or d_status >= 300:
                if (300 <= d_status < 400) or d_status in (502, 503, 504):
                    self._release_ticket_hold(hold_id, release_tok)
                raise RemoveAcError(d_status, d_body.decode("utf-8", errors="replace"))
            return d_body

        sync_bg_wire_len = (
            len(bg_bytes)
            if bg_bytes is not None
            else (len(bg_b64_clean.encode("utf-8")) if bg_b64_clean else 0)
        )

        if img_bytes is not None and (
            direct
            or len(img_bytes) > DIRECT_THRESHOLD_BYTES
            or (ticket_bg_bytes is not None and len(ticket_bg_bytes) > DIRECT_THRESHOLD_BYTES)
            or (len(img_bytes) + sync_bg_wire_len > DIRECT_THRESHOLD_BYTES)
            or _should_preflight_via_ticket(img_bytes, norm_size, norm_format, norm_channels, crop)
        ):
            return _via_ticket("direct")

        fields: Dict[str, str] = {
            "size": norm_size,
            "format": norm_format,
            "channels": norm_channels,
            "semitransparency": str(semitransparency).lower(),
        }
        if img_url:
            fields["image_url"] = img_url
        if norm_type and norm_type != "auto":
            fields["type"] = norm_type
        if type_level:
            fields["type_level"] = type_level
        if roi:
            fields["roi"] = roi
        if scale:
            fields["scale"] = scale
        if position:
            fields["position"] = position
        if clean_bg_color:
            fields["bg_color"] = clean_bg_color
        if clean_bg_url:
            fields["bg_image_url"] = clean_bg_url
        if bg_b64_clean:
            fields["bg_image_file_b64"] = bg_b64_clean
        if crop:
            fields["crop"] = "true"
        if crop_margin:
            fields["crop_margin"] = crop_margin
        if add_shadow:
            fields["add_shadow"] = "true"
        if norm_shadow_type:
            fields["shadow_type"] = norm_shadow_type
        if shadow_opacity is not None:
            fields["shadow_opacity"] = str(shadow_opacity)

        file_tuple = ("image_file", img_name, img_bytes) if img_bytes is not None else None
        extra_files = [("bg_image_file", bg_name, bg_bytes)] if bg_bytes is not None else None
        mp_body, mp_ct = _encode_multipart(fields, file_tuple, extra_files)
        status, _, body = self._transport(
            "POST",
            f"{self.base_url}/v1.0/removebg",
            _ensure_user_agent(
                {
                    "X-Api-Key": self.api_key,
                    "Idempotency-Key": idem,
                    "Content-Type": mp_ct,
                }
            ),
            mp_body,
            timeout,
        )
        if (
            status == 409
            and idempotency_key is None
            and b"idempotency_replay_unavailable" in body
        ):
            status, _, body = self._transport(
                "POST",
                f"{self.base_url}/v1.0/removebg",
                _ensure_user_agent(
                    {
                        "X-Api-Key": self.api_key,
                        "Idempotency-Key": f"pysdk-{uuid.uuid4()}",
                        "Content-Type": mp_ct,
                    }
                ),
                mp_body,
                timeout,
            )
        if status == 413 and img_bytes is not None:
            return _via_ticket("fallback413")
        if status < 200 or status >= 300:
            raise RemoveAcError(status, body.decode("utf-8", errors="replace"))
        return body

    def submit_improve(
        self,
        image: Union[str, bytes, bytearray, os.PathLike],
        *,
        tag: Optional[str] = None,
        description: Optional[str] = None,
        filename: Optional[str] = None,
        timeout: int = 30,
    ) -> Dict[str, Any]:
        if not self.api_key:
            raise RemoveAcError(403, "Missing remove.ac API key")

        img_bytes: Optional[bytes] = None
        img_name = os.path.basename(filename.strip()) if filename and filename.strip() else "image.png"
        img_url: Optional[str] = None

        if isinstance(image, (bytes, bytearray)):
            img_bytes = bytes(image)
        elif isinstance(image, str) and image.strip().startswith(("http://", "https://")):
            img_url = image.strip()
        elif isinstance(image, (str, os.PathLike)):
            img_path_str = os.fspath(image)
            if not isinstance(img_path_str, str):
                img_path_str = os.fsdecode(img_path_str)
            trimmed_path = img_path_str.strip()
            if not trimmed_path or "\x00" in trimmed_path:
                raise RemoveAcError(400, "Unsupported image input")
            if not (filename and filename.strip()):
                img_name = os.path.basename(trimmed_path) or "image.png"
            with open(trimmed_path, "rb") as fh:
                img_bytes = fh.read()
        else:
            raise RemoveAcError(400, "Unsupported image input")

        if img_bytes is not None:
            if len(img_bytes) == 0:
                raise RemoveAcError(400, "Image input must not be empty")
            if len(img_bytes) > MAX_UPLOAD_BYTES:
                raise RemoveAcError(
                    413, "Image input exceeds 25 MB maximum upload size (26214400 bytes)"
                )

        fields: Dict[str, str] = {}
        if img_url:
            fields["image_url"] = img_url
        if tag is not None and str(tag).strip():
            fields["tag"] = str(tag).strip()
        if description is not None and str(description).strip():
            fields["description"] = str(description).strip()

        file_tuple = ("image_file", img_name, img_bytes) if img_bytes is not None else None
        mp_body, mp_ct = _encode_multipart(fields, file_tuple)
        status, _, body = self._transport(
            "POST",
            f"{self.base_url}/v1.0/improve",
            _ensure_user_agent(
                {
                    "X-Api-Key": self.api_key,
                    "Content-Type": mp_ct,
                }
            ),
            mp_body,
            timeout,
        )
        if status < 200 or status >= 300:
            raise RemoveAcError(status, body.decode("utf-8", errors="replace"))
        parsed = json.loads(body.decode("utf-8"))
        if isinstance(parsed, dict) and isinstance(parsed.get("data"), dict) and "id" not in parsed:
            return dict(parsed["data"])
        return parsed


class RemoveBg:
    """1:1 drop-in replacement for brilam/remove-bg Python package."""

    def __init__(
        self,
        api_key: str,
        error_log_file: Optional[str] = None,
        base_url: str = DEFAULT_BASE_URL,
        transport: Optional[TransportFn] = None,
        resolver: Optional[ResolverFn] = None,
    ):
        self.client = RemoveAcClient(
            api_key=api_key,
            base_url=base_url,
            transport=transport,
            resolver=resolver,
        )
        self.error_log_file = error_log_file

    def remove_background_from_img_file(
        self,
        img_file_path: Union[str, os.PathLike],
        size: str = "regular",
        new_file_name: str = "no-bg.png",
        bg_color: Optional[str] = None,
        bg_image_file: Optional[Union[str, bytes, bytearray, os.PathLike]] = None,
        bg_image_url: Optional[str] = None,
        bg_image_file_b64: Optional[str] = None,
        **kwargs: Any,
    ) -> bytes:
        out = self.client.remove_background(
            img_file_path,
            size=size,
            bg_color=bg_color,
            bg_image_file=bg_image_file,
            bg_image_url=bg_image_url,
            bg_image_file_b64=bg_image_file_b64,
            **kwargs,
        )
        if new_file_name:
            with open(new_file_name, "wb") as fh:
                fh.write(out)
        return out

    def remove_background_from_img_url(
        self,
        img_url: str,
        size: str = "regular",
        new_file_name: str = "no-bg.png",
        bg_color: Optional[str] = None,
        bg_image_file: Optional[Union[str, bytes, bytearray, os.PathLike]] = None,
        bg_image_url: Optional[str] = None,
        bg_image_file_b64: Optional[str] = None,
        **kwargs: Any,
    ) -> bytes:
        out = self.client.remove_background(
            img_url,
            size=size,
            bg_color=bg_color,
            bg_image_file=bg_image_file,
            bg_image_url=bg_image_url,
            bg_image_file_b64=bg_image_file_b64,
            **kwargs,
        )
        if new_file_name:
            with open(new_file_name, "wb") as fh:
                fh.write(out)
        return out

    def remove_background_from_base64_img(
        self,
        base64_img: str,
        size: str = "regular",
        new_file_name: str = "no-bg.png",
        bg_color: Optional[str] = None,
        bg_image_file: Optional[Union[str, bytes, bytearray, os.PathLike]] = None,
        bg_image_url: Optional[str] = None,
        bg_image_file_b64: Optional[str] = None,
        **kwargs: Any,
    ) -> bytes:
        out = self.client.remove_background(
            base64.b64decode(base64_img),
            size=size,
            bg_color=bg_color,
            bg_image_file=bg_image_file,
            bg_image_url=bg_image_url,
            bg_image_file_b64=bg_image_file_b64,
            **kwargs,
        )
        if new_file_name:
            with open(new_file_name, "wb") as fh:
                fh.write(out)
        return out
