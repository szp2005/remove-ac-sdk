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
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union

DEFAULT_BASE_URL = "https://remove.ac"
DIRECT_THRESHOLD_BYTES = 4 * 1024 * 1024
DIRECT_RGBA_PNG_PIXELS = 5_000_000
DIRECT_CROPPED_RGBA_PNG_PIXELS = 10_000_000


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


def _encode_multipart(
    fields: Dict[str, str],
    file_tuple: Optional[Tuple[str, str, bytes]] = None,
) -> Tuple[bytes, str]:
    boundary = f"----RemoveAcBoundary{uuid.uuid4().hex}"
    chunks = []
    for key, val in fields.items():
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode("utf-8"))
        chunks.append(f"{val}\r\n".encode("utf-8"))
    if file_tuple is not None:
        field_name, filename, raw_bytes = file_tuple
        safe_name = filename.replace('"', "_")
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(
            f'Content-Disposition: form-data; name="{field_name}"; filename="{safe_name}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n".encode("utf-8")
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


def _default_transport(
    method: str,
    url: str,
    headers: Dict[str, str],
    body: Optional[bytes],
    timeout: int,
) -> Tuple[int, Dict[str, str], bytes]:
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
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

    def get_account(self, timeout: int = 15) -> Dict[str, Any]:
        if not self.api_key:
            raise RemoveAcError(403, "Missing remove.ac API key")
        status, _, body = self._transport(
            "GET",
            f"{self.base_url}/v1.0/account",
            {"X-Api-Key": self.api_key},
            None,
            timeout,
        )
        if status < 200 or status >= 300:
            raise RemoveAcError(status, body.decode("utf-8", errors="replace"))
        return json.loads(body.decode("utf-8"))

    def remove_background(
        self,
        image: Union[str, bytes],
        *,
        size: str = "auto",
        format: str = "png",
        channels: str = "rgba",
        type: str = "auto",
        type_level: Optional[str] = None,
        roi: Optional[str] = None,
        scale: Optional[str] = None,
        position: Optional[str] = None,
        bg_color: Optional[str] = None,
        bg_image_url: Optional[str] = None,
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
        if idempotency_key is not None:
            trimmed_idem = idempotency_key.strip()
            if not trimmed_idem or len(trimmed_idem) > 255:
                raise RemoveAcError(400, "idempotency_key must be between 1 and 255 characters")
            idem = trimmed_idem
        else:
            idem = f"pysdk-{uuid.uuid4()}"
        img_bytes: Optional[bytes] = None
        img_name = "image.png"
        img_url: Optional[str] = None

        if isinstance(image, (bytes, bytearray)):
            img_bytes = bytes(image)
        elif isinstance(image, str) and image.startswith(("http://", "https://")):
            img_url = image
        elif isinstance(image, str):
            img_name = os.path.basename(image)
            with open(image, "rb") as fh:
                img_bytes = fh.read()
        else:
            raise RemoveAcError(400, "Unsupported image input")

        def _via_ticket(suffix: str) -> bytes:
            if img_bytes is None:
                raise RemoveAcError(413, "Ticket mode requires binary input")
            payload: Dict[str, Any] = {
                "foregroundSha256": hashlib.sha256(img_bytes).hexdigest(),
                "foregroundByteLength": len(img_bytes),
                "size": size,
                "format": format,
                "channels": channels,
                "semitransparency": semitransparency,
            }
            if type and type != "auto":
                payload["type"] = type
            if type_level:
                payload["type_level"] = type_level
            if roi:
                payload["roi"] = roi
            if scale:
                payload["scale"] = scale
            if position:
                payload["position"] = position
            if bg_color:
                payload["bg_color"] = bg_color
            if bg_image_url:
                payload["bg_image_url"] = bg_image_url
            if crop:
                payload["crop"] = True
            if crop_margin:
                payload["crop_margin"] = crop_margin
            if add_shadow:
                payload["add_shadow"] = True
            if shadow_type:
                payload["shadow_type"] = shadow_type
            if shadow_opacity is not None:
                payload["shadow_opacity"] = shadow_opacity

            t_status, _, t_body = self._transport(
                "POST",
                f"{self.base_url}/v1.0/removebg/ticket",
                {
                    "Content-Type": "application/json",
                    "X-Api-Key": self.api_key,
                    "Idempotency-Key": derive_sub_idempotency_key(idem, suffix),
                },
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
            if (
                not isinstance(ticket_tok, str)
                or not ticket_tok.strip()
                or not isinstance(direct_ep, str)
                or not direct_ep.strip()
            ):
                raise RemoveAcError(502, "Missing ticket or directEndpoint in /v1.0/removebg/ticket response")
            ep_err = validate_https_endpoint_url(
                direct_ep,
                allow_loopback_origin=_is_loopback_test_origin(self.base_url),
                resolver=self._resolver,
                label="directEndpoint",
            )
            if ep_err:
                raise RemoveAcError(502, ep_err)
            mp_body, mp_ct = _encode_multipart({}, ("image_file", img_name, img_bytes))
            d_status, _, d_body = self._transport(
                "POST",
                direct_ep,
                {
                    "Authorization": f"Bearer {ticket_tok}",
                    "Content-Type": mp_ct,
                },
                mp_body,
                timeout,
            )
            if d_status < 200 or d_status >= 300:
                raise RemoveAcError(d_status, d_body.decode("utf-8", errors="replace"))
            return d_body

        if img_bytes is not None and (
            direct
            or len(img_bytes) > DIRECT_THRESHOLD_BYTES
            or _should_preflight_via_ticket(img_bytes, size, format, channels, crop)
        ):
            return _via_ticket("direct")

        fields: Dict[str, str] = {
            "size": size,
            "format": format,
            "channels": channels,
            "semitransparency": str(semitransparency).lower(),
        }
        if img_url:
            fields["image_url"] = img_url
        if type and type != "auto":
            fields["type"] = type
        if type_level:
            fields["type_level"] = type_level
        if roi:
            fields["roi"] = roi
        if scale:
            fields["scale"] = scale
        if position:
            fields["position"] = position
        if bg_color:
            fields["bg_color"] = bg_color
        if bg_image_url:
            fields["bg_image_url"] = bg_image_url
        if crop:
            fields["crop"] = "true"
        if crop_margin:
            fields["crop_margin"] = crop_margin
        if add_shadow:
            fields["add_shadow"] = "true"
        if shadow_type:
            fields["shadow_type"] = shadow_type
        if shadow_opacity is not None:
            fields["shadow_opacity"] = str(shadow_opacity)

        file_tuple = ("image_file", img_name, img_bytes) if img_bytes is not None else None
        mp_body, mp_ct = _encode_multipart(fields, file_tuple)
        status, _, body = self._transport(
            "POST",
            f"{self.base_url}/v1.0/removebg",
            {
                "X-Api-Key": self.api_key,
                "Idempotency-Key": idem,
                "Content-Type": mp_ct,
            },
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
                {
                    "X-Api-Key": self.api_key,
                    "Idempotency-Key": f"pysdk-{uuid.uuid4()}",
                    "Content-Type": mp_ct,
                },
                mp_body,
                timeout,
            )
        if status == 413 and img_bytes is not None:
            return _via_ticket("fallback413")
        if status < 200 or status >= 300:
            raise RemoveAcError(status, body.decode("utf-8", errors="replace"))
        return body


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
        img_file_path: str,
        size: str = "regular",
        new_file_name: str = "no-bg.png",
        **kwargs: Any,
    ) -> bytes:
        out = self.client.remove_background(img_file_path, size=size, **kwargs)
        if new_file_name:
            with open(new_file_name, "wb") as fh:
                fh.write(out)
        return out

    def remove_background_from_img_url(
        self,
        img_url: str,
        size: str = "regular",
        new_file_name: str = "no-bg.png",
        **kwargs: Any,
    ) -> bytes:
        out = self.client.remove_background(img_url, size=size, **kwargs)
        if new_file_name:
            with open(new_file_name, "wb") as fh:
                fh.write(out)
        return out

    def remove_background_from_base64_img(
        self,
        base64_img: str,
        size: str = "regular",
        new_file_name: str = "no-bg.png",
        **kwargs: Any,
    ) -> bytes:
        out = self.client.remove_background(base64.b64decode(base64_img), size=size, **kwargs)
        if new_file_name:
            with open(new_file_name, "wb") as fh:
                fh.write(out)
        return out
