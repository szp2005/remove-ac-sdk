import base64
import json
import unittest
from unittest import mock

from remove_ac import (
    SDK_VERSION,
    USER_AGENT,
    VALID_SIZES,
    RemoveAcClient,
    RemoveAcError,
    RemoveBg,
    SizeLiteral,
    __version__,
    derive_sub_idempotency_key,
    parse_image_dimensions,
    validate_direct_endpoint_url,
    validate_remote_image_url,
)
from remove_ac.client import _fetch_pinned_remote_bytes


class PythonSdkTest(unittest.TestCase):
    def test_standard_removebg_call(self):
        calls = []

        def fake_transport(method, url, headers, body, timeout):
            calls.append((method, url, headers, body))
            return 200, {"content-type": "image/png"}, b"\x89PNG\r\n"

        client = RemoveAcClient(api_key="rac_live_test_example", transport=fake_transport)
        out = client.remove_background(b"abc", size="full", shadow_type="contact")
        self.assertEqual(out, b"\x89PNG\r\n")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], "https://remove.ac/v1.0/removebg")
        self.assertEqual(calls[0][2]["X-Api-Key"], "rac_live_test_example")

    def test_large_file_uses_direct_ticket(self):
        calls = []
        big = b"x" * (4 * 1024 * 1024 + 16)

        def fake_transport(method, url, headers, body, timeout):
            calls.append((method, url, headers))
            if url.endswith("/v1.0/removebg/ticket"):
                payload = json.dumps(
                    {
                        "data": {
                            "ticket": "tkt_123",
                            "directEndpoint": "https://api.remove.ac/v1.0/direct-cutout",
                        }
                    }
                ).encode("utf-8")
                return 200, {"content-type": "application/json"}, payload
            return 200, {"content-type": "image/png"}, b"\x89PNG_DIRECT"

        client = RemoveAcClient(
            api_key="rac_live_test_example",
            transport=fake_transport,
            resolver=lambda _host: ["93.184.216.34"],
        )
        out = client.remove_background(big, size="full")
        self.assertEqual(out, b"\x89PNG_DIRECT")
        self.assertEqual(len(calls), 2)
        self.assertTrue(calls[0][1].endswith("/v1.0/removebg/ticket"))
        self.assertEqual(calls[1][1], "https://api.remove.ac/v1.0/direct-cutout")
        self.assertEqual(calls[1][2]["Authorization"], "Bearer tkt_123")

    def test_removebg_drop_in_shim_and_missing_key(self):
        with self.assertRaises(RemoveAcError):
            RemoveAcClient(api_key="").remove_background(b"abc")

        rmbg = RemoveBg(
            "rac_live_test_example",
            transport=lambda m, u, h, b, t: (200, {"content-type": "image/png"}, b"OK"),
        )
        res = rmbg.remove_background_from_base64_img(
            base64.b64encode(b"raw").decode("ascii"),
            new_file_name="",
        )
        self.assertEqual(res, b"OK")

    def test_high_mp_small_file_preflights_via_ticket(self):
        # Minimal JPEG with SOF0 6000x4000 (24 MP)
        jpeg_24mp = (
            b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
            b"\xff\xc0\x00\x11\x08\x0f\xa0\x17\x70\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00"
        )
        calls = []

        def fake_transport(method, url, headers, body, timeout):
            calls.append(url)
            if url.endswith("/v1.0/removebg/ticket"):
                payload = json.dumps(
                    {
                        "data": {
                            "ticket": "tkt_py_24mp",
                            "directEndpoint": "https://api.remove.ac/v1.0/direct-cutout",
                        }
                    }
                ).encode("utf-8")
                return 200, {"content-type": "application/json"}, payload
            return 200, {"content-type": "image/png"}, b"DIRECT_PY_PNG"

        client = RemoveAcClient(
            api_key="rac_live_test_example",
            transport=fake_transport,
            resolver=lambda _host: ["93.184.216.34"],
        )
        out = client.remove_background(jpeg_24mp, size="auto", format="png")
        self.assertEqual(out, b"DIRECT_PY_PNG")
        self.assertEqual(
            calls,
            [
                "https://remove.ac/v1.0/removebg/ticket",
                "https://api.remove.ac/v1.0/direct-cutout",
            ],
        )

    def test_long_idempotency_key_stays_under_255_chars_on_ticket(self):
        long_250 = "p" * 250
        derived = derive_sub_idempotency_key(long_250, "fallback413")
        self.assertLessEqual(len(derived), 255)
        with self.assertRaises(RemoveAcError):
            derive_sub_idempotency_key("p" * 256, "direct")
        self.assertIsNone(
            parse_image_dimensions(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\xff\xff\xff\xff\x00\x00\x01\x00")
        )

        seen_headers = []

        def fake_transport(method, url, headers, body, timeout):
            seen_headers.append((url, headers))
            if url.endswith("/v1.0/removebg"):
                return 413, {"content-type": "application/json"}, b'{"errors":[{"code":"result_too_large"}]}'
            if url.endswith("/v1.0/removebg/ticket"):
                payload = json.dumps(
                    {
                        "data": {
                            "ticket": "tkt_long_idem",
                            "directEndpoint": "https://api.remove.ac/v1.0/direct-cutout",
                        }
                    }
                ).encode("utf-8")
                return 200, {"content-type": "application/json"}, payload
            return 200, {"content-type": "image/png"}, b"OK_FALLBACK"

        client = RemoveAcClient(
            api_key="rac_live_test_example",
            transport=fake_transport,
            resolver=lambda _host: ["93.184.216.34"],
        )
        res = client.remove_background(b"small_input", idempotency_key=long_250)
        self.assertEqual(res, b"OK_FALLBACK")
        ticket_hdr = seen_headers[1][1]["Idempotency-Key"]
        self.assertLessEqual(len(ticket_hdr), 255)

    def test_mf1_and_mf2_blocks_3xx_redirects_and_unsafe_direct_endpoints(self):
        import http.server
        import threading

        leak_hits = []

        class LeakHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                leak_hits.append(dict(self.headers))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"LEAKED")

            def log_message(self, *args):
                pass

        leak_srv = http.server.HTTPServer(("127.0.0.1", 0), LeakHandler)
        leak_port = leak_srv.server_port

        class RedirectHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(307)
                self.send_header("Location", f"http://127.0.0.1:{leak_port}/steal")
                self.end_headers()

            def log_message(self, *args):
                pass

        redir_srv = http.server.HTTPServer(("127.0.0.1", 0), RedirectHandler)
        redir_port = redir_srv.server_port

        t1 = threading.Thread(target=leak_srv.serve_forever, daemon=True)
        t2 = threading.Thread(target=redir_srv.serve_forever, daemon=True)
        t1.start()
        t2.start()
        try:
            live_client = RemoveAcClient(
                api_key="rac_live_secret_py",
                base_url=f"http://127.0.0.1:{redir_port}",
            )
            with self.assertRaises(RemoveAcError) as ctx:
                live_client.get_account(timeout=5)
            self.assertEqual(ctx.exception.status_code, 307)
            self.assertEqual(len(leak_hits), 0)
        finally:
            redir_srv.shutdown()
            leak_srv.shutdown()
            redir_srv.server_close()
            leak_srv.server_close()

        bad_endpoints = [
            None,
            "http://gpu.remove.ac/v1.0/direct-cutout",
            "https://127.0.0.1/v1.0/direct-cutout",
            "https://[::ffff:169.254.169.254]/latest/meta-data",
            "https://rebind.example.com/v1.0/direct-cutout",
            "https://api.remove.ac/v1.0/direct-cutout",
        ]
        for bad_ep in bad_endpoints:
            calls = []

            def bad_ticket_transport(method, url, headers, body, timeout):
                calls.append(url)
                data_obj = {"ticket": "tkt_bad"}
                if bad_ep is not None:
                    data_obj["directEndpoint"] = bad_ep
                return 200, {"content-type": "application/json"}, json.dumps({"data": data_obj}).encode("utf-8")

            c = RemoveAcClient(
                api_key="rac_live_test",
                base_url="https://remove.ac",
                transport=bad_ticket_transport,
                resolver=lambda _host: ["10.0.0.8"],
            )
            with self.assertRaises(RemoveAcError) as err_ctx:
                c.remove_background(b"abc", direct=True)
            self.assertEqual(err_ctx.exception.status_code, 502)
            self.assertEqual(len(calls), 1)

    def test_25mp_and_50mp_preflight_ticket_routing(self):
        import struct

        # 30 MP PNG header (6000x5000, tiny 64-byte stub): both 25mp and 50mp exceed 5 MP RGBA PNG cap -> ticket mode
        png_30mp = (
            b"\x89PNG\r\n\x1a\n"
            + struct.pack(">I", 13)
            + b"IHDR"
            + struct.pack(">II", 6000, 5000)
            + b"\x08\x06\x00\x00\x00"
            + b"\x00" * 32
        )
        seen_sizes = []

        def mock_transport(method, url, headers, body, timeout):
            if url.endswith("/v1.0/removebg/ticket"):
                payload = json.loads(body.decode("utf-8"))
                seen_sizes.append(payload["size"])
                return (
                    200,
                    {"content-type": "application/json"},
                    json.dumps(
                        {
                            "data": {
                                "ticket": "tkt_50mp",
                                "directEndpoint": "http://127.0.0.1:8787/v1.0/direct-cutout",
                            }
                        }
                    ).encode("utf-8"),
                )
            return 200, {"content-type": "image/png", "x-credits-charged": "1"}, b"PNG_OUT"

        c = RemoveAcClient(
            api_key="rac_live_test",
            base_url="http://127.0.0.1:8787",
            transport=mock_transport,
        )
        out25 = c.remove_background(png_30mp, size="25mp")
        out50 = c.remove_background(png_30mp, size="50mp")
        self.assertEqual(out25, b"PNG_OUT")
        self.assertEqual(out50, b"PNG_OUT")
        self.assertEqual(seen_sizes, ["25mp", "50mp"])

    def test_v120_user_agent_enum_validation_and_ticket_hold_release(self):
        import http.server
        import threading

        self.assertEqual(__version__, "1.3.0")
        self.assertEqual(SDK_VERSION, "1.3.0")
        self.assertEqual(USER_AGENT, "remove-ac-python-sdk/1.3.0")
        self.assertIn("25mp", VALID_SIZES)
        self.assertIn("50mp", VALID_SIZES)
        self.assertIsNotNone(SizeLiteral)

        # Verify real urllib _default_transport sends remove-ac-python-sdk/1.3.0 User-Agent (not Python-urllib)
        captured_uas = []

        class UaHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                captured_uas.append(self.headers.get("User-Agent"))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"data":{"attributes":{"credits":{"total":5}}}}')

            def log_message(self, *args):
                pass

        ua_srv = http.server.HTTPServer(("127.0.0.1", 0), UaHandler)
        t = threading.Thread(target=ua_srv.serve_forever, daemon=True)
        t.start()
        try:
            real_client = RemoveAcClient(
                api_key="rac_live_ua_check",
                base_url=f"http://127.0.0.1:{ua_srv.server_port}",
            )
            acct = real_client.get_account(timeout=5)
            self.assertEqual(acct["data"]["attributes"]["credits"]["total"], 5)
            self.assertEqual(captured_uas, ["remove-ac-python-sdk/1.3.0"])
        finally:
            ua_srv.shutdown()
            ua_srv.server_close()

        # Client-side enum validation rejects invalid values with 0 HTTP calls
        calls = []
        guard_client = RemoveAcClient(
            api_key="rac_live_guard",
            transport=lambda m, u, h, b, to: calls.append(u) or (200, {}, b"OK"),
        )
        for bad_kwargs in (
            {"size": "999mp"},
            {"format": "bmp"},
            {"channels": "cmyk"},
            {"type": "ufo"},
            {"shadow_type": "laser"},
        ):
            with self.assertRaises(RemoveAcError) as ctx:
                guard_client.remove_background(b"abc", **bad_kwargs)
            self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(len(calls), 0)

        # MF-06: Best-effort POST /v1.0/removebg/ticket/release on directEndpoint failure
        released_bodies = []

        def hold_release_transport(method, url, headers, body, timeout):
            self.assertEqual(headers.get("User-Agent"), "remove-ac-python-sdk/1.3.0")
            if url.endswith("/v1.0/removebg/ticket"):
                return (
                    200,
                    {"content-type": "application/json"},
                    json.dumps(
                        {
                            "data": {
                                "ticket": "tkt_py_hold",
                                "directEndpoint": "https://api.remove.ac/v1.0/direct-cutout",
                                "holdId": "hold_py_1",
                                "releaseToken": "rel_py_secret_1",
                            }
                        }
                    ).encode("utf-8"),
                )
            if url.endswith("/v1.0/removebg/ticket/release"):
                released_bodies.append(json.loads(body.decode("utf-8")))
                return 200, {"content-type": "application/json"}, b'{"ok":true}'
            raise ConnectionResetError("simulated 50MP upload reset")

        hold_client = RemoveAcClient(
            api_key="rac_live_hold",
            transport=hold_release_transport,
            resolver=lambda _host: ["93.184.216.34"],
        )
        with self.assertRaises(ConnectionResetError):
            hold_client.remove_background(b"abc", direct=True)
        self.assertEqual(
            released_bodies,
            [{"holdId": "hold_py_1", "releaseToken": "rel_py_secret_1"}],
        )

    def test_v130_bg_image_file_multipart_ticket_removebg_shim_and_submit_improve(self):
        import hashlib
        import os
        import pathlib
        import tempfile

        temp_root = (
            "/Volumes/Expansion/dev-tools/build-temp"
            if os.path.isdir("/Volumes/Expansion/dev-tools/build-temp")
            else None
        )
        with tempfile.TemporaryDirectory(dir=temp_root, prefix="rac-py-v130-") as tmp_dir:
            fg_path = pathlib.Path(tmp_dir) / "fg.png"
            bg_path = pathlib.Path(tmp_dir) / "studio-bg.png"
            fg_bytes = b"\x89PNG\r\n\x1a\nFG_PAYLOAD"
            bg_bytes = b"\x89PNG\r\n\x1a\nBG_PAYLOAD"
            fg_path.write_bytes(fg_bytes)
            bg_path.write_bytes(bg_bytes)

            # 1. Mutual exclusion & empty/oversized guards (0 HTTP calls)
            guard_hits = []
            guard_client = RemoveAcClient(
                api_key="rac_live_py_guard",
                transport=lambda m, u, h, b, t: guard_hits.append(u) or (200, {}, b"OK"),
            )
            for bad_kw in (
                {"bg_color": "FFFFFF", "bg_image_file": bg_bytes},
                {"bg_image_url": "https://example.com/bg.png", "bg_image_file": str(bg_path)},
                {"bg_image_file": bg_bytes, "bg_image_file_b64": base64.b64encode(bg_bytes).decode("ascii")},
                {"bg_image_file": b""},
                {"bg_image_file": "   "},
                {"bg_image_file": "https://example.com/not-local.png"},
                {"bg_image_file_b64": ""},
                {"bg_image_file_b64": "%%%invalid%%%"},
            ):
                with self.assertRaises(RemoveAcError) as ctx:
                    guard_client.remove_background(fg_bytes, **bad_kw)
                self.assertEqual(ctx.exception.status_code, 400)

            with self.assertRaises(RemoveAcError) as big_ctx:
                guard_client.remove_background(
                    fg_bytes, bg_image_file=b"x" * (25 * 1024 * 1024 + 1)
                )
            self.assertEqual(big_ctx.exception.status_code, 413)
            self.assertEqual(len(guard_hits), 0)

            # 2. Sync /v1.0/removebg encodes both image_file and bg_image_file cleanly + RemoveBg shim
            sync_bodies = []

            def sync_transport(method, url, headers, body, timeout):
                self.assertEqual(url, "https://remove.ac/v1.0/removebg")
                sync_bodies.append(body)
                return 200, {"content-type": "image/png"}, b"COMPOSITED_PNG"

            sync_client = RemoveAcClient(api_key="rac_live_py_sync", transport=sync_transport)
            out1 = sync_client.remove_background(fg_path, bg_image_file=bg_path)
            self.assertEqual(out1, b"COMPOSITED_PNG")
            self.assertIn(b'name="image_file"; filename="fg.png"', sync_bodies[0])
            self.assertIn(fg_bytes, sync_bodies[0])
            self.assertIn(b'name="bg_image_file"; filename="studio-bg.png"', sync_bodies[0])
            self.assertIn(bg_bytes, sync_bodies[0])

            rmbg = RemoveBg("rac_live_py_shim", transport=sync_transport)
            out_shim = rmbg.remove_background_from_img_file(
                str(fg_path),
                size="full",
                new_file_name="",
                bg_image_file=bytearray(bg_bytes),
            )
            self.assertEqual(out_shim, b"COMPOSITED_PNG")
            self.assertIn(b'name="bg_image_file"', sync_bodies[1])
            self.assertIn(bg_bytes, sync_bodies[1])

            out_b64 = rmbg.remove_background_from_base64_img(
                base64.b64encode(fg_bytes).decode("ascii"),
                new_file_name="",
                bg_image_file_b64=base64.b64encode(bg_bytes).decode("ascii"),
            )
            self.assertEqual(out_b64, b"COMPOSITED_PNG")
            self.assertIn(b'name="bg_image_file_b64"', sync_bodies[2])

            # 3. Combined >4 MB (2.5 MB fg + 2.5 MB bg) upgrades to /v1.0/removebg/ticket with bgImageSha256
            fg_25 = b"A" * int(2.5 * 1024 * 1024)
            bg_25 = b"B" * int(2.5 * 1024 * 1024)
            ticket_calls = []

            def ticket_transport(method, url, headers, body, timeout):
                ticket_calls.append((url, body))
                if url.endswith("/v1.0/removebg/ticket"):
                    return (
                        200,
                        {"content-type": "application/json"},
                        json.dumps(
                            {
                                "data": {
                                    "ticket": "tkt_py_bg",
                                    "directEndpoint": "https://api.remove.ac/v1.0/direct-cutout",
                                }
                            }
                        ).encode("utf-8"),
                    )
                return 200, {"content-type": "image/png"}, b"TICKET_BG_OK"

            t_client = RemoveAcClient(
                api_key="rac_live_py_ticket",
                transport=ticket_transport,
                resolver=lambda _h: ["93.184.216.34"],
            )
            t_res = t_client.remove_background(fg_25, bg_image_file=bg_25, size="50mp")
            self.assertEqual(t_res, b"TICKET_BG_OK")
            self.assertEqual(len(ticket_calls), 2)
            t_json = json.loads(ticket_calls[0][1].decode("utf-8"))
            self.assertEqual(t_json["bgImageSha256"], hashlib.sha256(bg_25).hexdigest())
            self.assertEqual(t_json["bgImageByteLength"], len(bg_25))
            self.assertIn(b'name="image_file"', ticket_calls[1][1])
            self.assertIn(b'name="bg_image_file"', ticket_calls[1][1])

            # 4. submit_improve supports PathLike/bytes and image_url with tag & description
            improve_reqs = []

            def improve_transport(method, url, headers, body, timeout):
                improve_reqs.append((method, url, headers, body))
                return (
                    200,
                    {"content-type": "application/json"},
                    json.dumps({"data": {"id": f"imp_{len(improve_reqs)}", "status": "received"}}).encode(
                        "utf-8"
                    ),
                )

            imp_client = RemoveAcClient(
                api_key="rac_live_py_imp",
                transport=improve_transport,
                resolver=lambda _h: ["93.184.216.34"],
            )
            imp1 = imp_client.submit_improve(
                fg_path, tag="fur", description="Golden retriever fur edge"
            )
            self.assertEqual(imp1["id"], "imp_1")
            self.assertEqual(imp1["status"], "received")
            self.assertEqual(improve_reqs[0][1], "https://remove.ac/v1.0/improve")
            self.assertIn(b'name="image_file"; filename="fg.png"', improve_reqs[0][3])
            self.assertIn(b'name="tag"\r\n\r\nfur', improve_reqs[0][3])

            imp2 = imp_client.submit_improve("https://example.com/item.jpg", tag="shadow")
            self.assertEqual(imp2["id"], "imp_2")
            self.assertIn(b'name="image_url"\r\n\r\nhttps://example.com/item.jpg', improve_reqs[1][3])

    def test_r2_mf01_and_mf02_ssrf_guards_improve_bounds_envelope_and_hold_release(self):
        import struct

        png_54mp = (
            b"\x89PNG\r\n\x1a\n"
            + struct.pack(">I", 13)
            + b"IHDR"
            + struct.pack(">II", 9000, 6000)
            + b"\x08\x06\x00\x00\x00"
            + b"\x00" * 32
        )

        # 1. MF-01: SSRF URL checks in submit_improve, remove_background, and RemoveBg shim (0 HTTP calls)
        ssrf_hits = []
        ssrf_client = RemoveAcClient(
            api_key="rac_live_py_ssrf",
            transport=lambda m, u, h, b, t: ssrf_hits.append(u) or (200, {}, b'{"id":"x"}'),
            resolver=lambda _h: ["169.254.169.254"],
        )
        disallowed_urls = [
            "http://169.254.169.254/latest/meta-data/",
            "http://127.0.0.1:8080/internal.png",
            "http://[::ffff:127.0.0.1]/secret.png",
            "http://[64:ff9b::169.254.169.254]/secret.png",
            "http://100.64.0.1/cgnat.png",
            "http://localhost/admin.png",
            "http://service.internal/img.png",
            "http://2130706433/decimal.png",
            "http://0x7f000001/hex.png",
            "http://0177.0.0.1/octal.png",
            "http://user:pass@example.com/private.png",
            "ftp://example.com/file.png",
            "file:///etc/passwd",
            "https://rebind.attacker.example/img.png",
        ]
        for bad_u in disallowed_urls:
            with self.assertRaises(RemoveAcError) as c1:
                ssrf_client.submit_improve(bad_u, tag="probe")
            self.assertEqual(c1.exception.status_code, 400)
            with self.assertRaises(RemoveAcError) as c2:
                ssrf_client.remove_background(bad_u)
            self.assertEqual(c2.exception.status_code, 400)
            with self.assertRaises(RemoveAcError) as c3:
                ssrf_client.remove_background(b"fg", bg_image_url=bad_u)
            self.assertEqual(c3.exception.status_code, 400)

        rmbg_shim = RemoveBg(
            "rac_live_py_ssrf",
            transport=lambda m, u, h, b, t: ssrf_hits.append(u) or (200, {}, b"OK"),
        )
        with self.assertRaises(RemoveAcError) as shim_ctx:
            rmbg_shim.remove_background_from_img_url("/etc/passwd", new_file_name="")
        self.assertEqual(shim_ctx.exception.status_code, 400)

        # submit_improve bounds: tag <= 64, description <= 500, 0-byte, >25MB, >50MP
        for bad_imp_kw in (
            {"tag": "t" * 65},
            {"tag": 12345},
            {"description": "d" * 501},
            {"description": ["not-a-str"]},
        ):
            with self.assertRaises(RemoveAcError) as b_ctx:
                ssrf_client.submit_improve(b"valid", **bad_imp_kw)
            self.assertEqual(b_ctx.exception.status_code, 400)
        with self.assertRaises(RemoveAcError) as empty_imp:
            ssrf_client.submit_improve(b"")
        self.assertEqual(empty_imp.exception.status_code, 400)
        with self.assertRaises(RemoveAcError) as big_imp:
            ssrf_client.submit_improve(b"x" * (25 * 1024 * 1024 + 1))
        self.assertEqual(big_imp.exception.status_code, 413)
        with self.assertRaises(RemoveAcError) as mp_imp:
            ssrf_client.submit_improve(png_54mp)
        self.assertEqual(mp_imp.exception.status_code, 400)
        self.assertEqual(len(ssrf_hits), 0)

        # 2. MF-02: Upfront binary/combined <= 30 MB checks (0 HTTP calls) & hold release on ALL non-2xx directEndpoint statuses
        with self.assertRaises(RemoveAcError) as fg_empty:
            ssrf_client.remove_background(b"")
        self.assertEqual(fg_empty.exception.status_code, 400)
        with self.assertRaises(RemoveAcError) as fg_big:
            ssrf_client.remove_background(b"x" * (25 * 1024 * 1024 + 1))
        self.assertEqual(fg_big.exception.status_code, 413)
        with self.assertRaises(RemoveAcError) as fg_mp:
            ssrf_client.remove_background(png_54mp)
        self.assertEqual(fg_mp.exception.status_code, 400)
        with self.assertRaises(RemoveAcError) as bg_mp:
            ssrf_client.remove_background(b"fg", bg_image_file=png_54mp)
        self.assertEqual(bg_mp.exception.status_code, 400)
        with self.assertRaises(RemoveAcError) as combined_big:
            ssrf_client.remove_background(
                b"x" * (18 * 1024 * 1024),
                bg_image_file=b"y" * (16 * 1024 * 1024),
            )
        self.assertEqual(combined_big.exception.status_code, 413)
        self.assertEqual(len(ssrf_hits), 0)

        for status in (400, 401, 403, 413, 415, 422, 429, 500, 502, 503, 504):
            rel_calls = []

            def status_transport(method, url, headers, body, timeout):
                if url.endswith("/v1.0/removebg/ticket"):
                    return (
                        200,
                        {"content-type": "application/json"},
                        json.dumps(
                            {
                                "data": {
                                    "ticket": f"t_{status}",
                                    "directEndpoint": "https://api.remove.ac/v1.0/direct-cutout",
                                    "holdId": f"h_{status}",
                                    "releaseToken": f"r_{status}",
                                }
                            }
                        ).encode("utf-8"),
                    )
                if url.endswith("/v1.0/removebg/ticket/release"):
                    rel_calls.append(json.loads(body.decode("utf-8")))
                    return 200, {"content-type": "application/json"}, b'{"ok":true}'
                return status, {"content-type": "application/json"}, b'{"errors":[{"code":"err"}]}'

            tc = RemoveAcClient(
                api_key="rac_live_py_hold",
                transport=status_transport,
                resolver=lambda _h: ["93.184.216.34"],
            )
            with self.assertRaises(RemoveAcError) as st_ctx:
                tc.remove_background(b"abc", direct=True)
            self.assertEqual(st_ctx.exception.status_code, status)
            self.assertEqual(
                rel_calls,
                [{"holdId": f"h_{status}", "releaseToken": f"r_{status}"}],
            )

    def test_m_p1_07_allow_tun_fake_ip_inverted_boolean_regression(self):
        with mock.patch("remove_ac.client._default_resolver", return_value=["198.18.0.42"]):
            # Arbitrary HTTPS/HTTP domains & plain http://remove.ac MUST be rejected under default resolver
            self.assertIsNotNone(validate_remote_image_url("https://evil.example.com/photo.png"))
            self.assertIsNotNone(validate_remote_image_url("http://internal-mesh.attacker.example/a.png"))
            self.assertIsNotNone(validate_remote_image_url("http://remove.ac/photo.png"))
            self.assertIsNotNone(validate_remote_image_url("https://evil-remove.ac/photo.png"))
            self.assertIsNotNone(validate_remote_image_url("https://198.18.0.42/photo.png"))

            # Only first-party https://remove.ac & https://*.remove.ac are allowed under default resolver
            self.assertIsNone(validate_remote_image_url("https://remove.ac/v1.0/removebg"))
            self.assertIsNone(validate_remote_image_url("https://api.remove.ac/v1.0/direct-cutout"))

            # Explicit custom resolver returning 198.18.x.x MUST still be rejected
            self.assertIsNotNone(
                validate_remote_image_url(
                    "https://remove.ac/v1.0/removebg",
                    resolver=lambda _h: ["198.18.0.42"],
                )
            )

    def test_m_p1_08_strict_direct_endpoint_allowlist_and_pinned_fetch(self):
        import http.server
        import threading

        public_resolver = lambda _h: ["93.184.216.34"]
        self.assertIsNone(
            validate_direct_endpoint_url(
                "https://remove.ac/v1.0/direct-cutout",
                base_url="https://remove.ac",
                resolver=public_resolver,
            )
        )
        self.assertIsNone(
            validate_direct_endpoint_url(
                "https://edge.remove.ac/v1.0/direct-cutout",
                base_url="https://remove.ac",
                resolver=public_resolver,
            )
        )
        self.assertIsNone(
            validate_direct_endpoint_url(
                "https://gateway.corp.example/v1.0/direct-cutout",
                base_url="https://gateway.corp.example",
                resolver=public_resolver,
            )
        )
        for bad_ep in (
            "https://evil.modal.run/v1.0/direct-cutout",
            "https://tenant--gpu-app.modal.run/v1.0/direct-cutout",
            "https://gpu.example.invalid/v1.0/direct-cutout",
            "https://attacker.example.com/v1.0/direct-cutout",
            "https://evil-remove.ac/v1.0/direct-cutout",
            "https://remove.ac:8443/v1.0/direct-cutout",
        ):
            err = validate_direct_endpoint_url(
                bad_ep, base_url="https://remove.ac", resolver=public_resolver
            )
            self.assertIsNotNone(err, f"Expected rejection for {bad_ep}")

        cross_err = validate_direct_endpoint_url(
            "https://other.corp.example/v1.0/direct-cutout",
            base_url="https://gateway.corp.example",
            resolver=public_resolver,
        )
        self.assertIsNotNone(cross_err)
        self.assertIn("untrusted host", cross_err.lower())

        # Ticket flow rejects evil.modal.run with 0 direct uploads and releases hold
        for bad_host_ep in (
            "https://evil.modal.run/v1.0/direct-cutout",
            "https://gpu.example.invalid/v1.0/direct-cutout",
        ):
            releases = []
            direct_uploads = []

            def bad_host_transport(method, url, headers, body, timeout):
                if url.endswith("/v1.0/removebg/ticket"):
                    return (
                        200,
                        {"content-type": "application/json"},
                        json.dumps(
                            {
                                "data": {
                                    "ticket": "tkt_bad_host",
                                    "directEndpoint": bad_host_ep,
                                    "holdId": "hold_bh",
                                    "releaseToken": "rel_bh",
                                }
                            }
                        ).encode("utf-8"),
                    )
                if url.endswith("/v1.0/removebg/ticket/release"):
                    releases.append(json.loads(body.decode("utf-8")))
                    return 200, {"content-type": "application/json"}, b'{"ok":true}'
                direct_uploads.append(url)
                return 200, {"content-type": "image/png"}, b"SHOULD_NOT_HIT"

            c = RemoveAcClient(
                api_key="rac_live_allowlist",
                transport=bad_host_transport,
                resolver=public_resolver,
            )
            with self.assertRaises(RemoveAcError) as ctx:
                c.remove_background(b"\x89PNG\r\n\x1a\nabc", direct=True)
            self.assertEqual(ctx.exception.status_code, 502)
            self.assertEqual(len(direct_uploads), 0)
            self.assertEqual(releases, [{"holdId": "hold_bh", "releaseToken": "rel_bh"}])

        # Pinned HTTP fetch connects strictly to pinned IP, preserves Host header, rejects redirects, hides 5xx body, caps bytes
        tiny_png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        )
        seen_hosts = []

        class PinnedHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen_hosts.append(self.headers.get("Host"))
                if self.path == "/ok.png":
                    self.send_response(200)
                    self.send_header("Content-Type", "image/png")
                    self.end_headers()
                    self.wfile.write(tiny_png)
                    return
                if self.path == "/redir":
                    self.send_response(302)
                    self.send_header("Location", "/ok.png")
                    self.end_headers()
                    return
                if self.path == "/secret-err":
                    self.send_response(500)
                    self.send_header("Content-Type", "text/plain")
                    self.end_headers()
                    self.wfile.write(b"AWS_SECRET_KEY=do_not_leak_py")
                    return
                if self.path == "/oversize":
                    self.send_response(200)
                    self.send_header("Content-Type", "image/png")
                    self.end_headers()
                    self.wfile.write(b"A" * 2048)
                    return
                self.send_response(404)
                self.end_headers()

            def log_message(self, *args):
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), PinnedHandler)
        port = srv.server_port
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        try:
            got = _fetch_pinned_remote_bytes(
                f"http://pinned-py.example:{port}/ok.png",
                ["127.0.0.1"],
                max_bytes=1024,
                timeout=5,
            )
            self.assertEqual(got, tiny_png)
            self.assertEqual(seen_hosts[0], f"pinned-py.example:{port}")

            with self.assertRaises(RemoveAcError) as r_ctx:
                _fetch_pinned_remote_bytes(
                    f"http://pinned-py.example:{port}/redir",
                    ["127.0.0.1"],
                    max_bytes=1024,
                    timeout=5,
                )
            self.assertEqual(r_ctx.exception.status_code, 302)

            with self.assertRaises(RemoveAcError) as e_ctx:
                _fetch_pinned_remote_bytes(
                    f"http://pinned-py.example:{port}/secret-err",
                    ["127.0.0.1"],
                    max_bytes=1024,
                    timeout=5,
                )
            self.assertEqual(e_ctx.exception.status_code, 502)
            self.assertNotIn("AWS_SECRET_KEY", str(e_ctx.exception))

            with self.assertRaises(RemoveAcError) as s_ctx:
                _fetch_pinned_remote_bytes(
                    f"http://pinned-py.example:{port}/oversize",
                    ["127.0.0.1"],
                    max_bytes=512,
                    timeout=5,
                )
            self.assertEqual(s_ctx.exception.status_code, 413)
        finally:
            srv.shutdown()
            srv.server_close()

    def test_m_p0_04_url_mode_413_automatic_ticket_fallback(self):
        import hashlib

        remote_jpg = (
            b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9"
        )
        expected_sha = hashlib.sha256(remote_jpg).hexdigest()
        public_resolver = lambda _h: ["93.184.216.34"]
        calls = []
        ticket_payloads = []
        remote_get_headers = []

        def fallback_transport(method, url, headers, body, timeout):
            calls.append((method, url))
            if url == "https://remove.ac/v1.0/removebg":
                return 413, {"content-type": "application/json"}, b'{"errors":[{"code":"result_too_large"}]}'
            if url == "https://cdn.example.com/12mp.jpg":
                remote_get_headers.append(dict(headers))
                return 200, {"content-type": "image/jpeg"}, remote_jpg
            if url == "https://remove.ac/v1.0/removebg/ticket":
                ticket_payloads.append((headers.get("Idempotency-Key"), json.loads(body.decode("utf-8"))))
                return (
                    200,
                    {"content-type": "application/json"},
                    json.dumps(
                        {
                            "data": {
                                "ticket": "tkt_py_url413",
                                "directEndpoint": "https://api.remove.ac/v1.0/direct-cutout",
                            }
                        }
                    ).encode("utf-8"),
                )
            if url == "https://api.remove.ac/v1.0/direct-cutout":
                self.assertEqual(headers.get("Authorization"), "Bearer tkt_py_url413")
                self.assertIn(remote_jpg, body)
                return 200, {"content-type": "image/png"}, b"PY_URL_413_CUTOUT"
            return 500, {}, b"unexpected"

        client = RemoveAcClient(
            api_key="rac_live_py_413",
            transport=fallback_transport,
            resolver=public_resolver,
        )
        out = client.remove_background(
            "https://cdn.example.com/12mp.jpg",
            size="full",
            idempotency_key="py-url-idem",
        )
        self.assertEqual(out, b"PY_URL_413_CUTOUT")
        self.assertEqual(
            calls,
            [
                ("POST", "https://remove.ac/v1.0/removebg"),
                ("GET", "https://cdn.example.com/12mp.jpg"),
                ("POST", "https://remove.ac/v1.0/removebg/ticket"),
                ("POST", "https://api.remove.ac/v1.0/direct-cutout"),
            ],
        )
        self.assertEqual(ticket_payloads[0][0], "py-url-idem:fallback413")
        self.assertEqual(ticket_payloads[0][1]["foregroundSha256"], expected_sha)
        self.assertEqual(ticket_payloads[0][1]["foregroundByteLength"], len(remote_jpg))
        self.assertNotIn("X-Api-Key", remote_get_headers[0])
        self.assertNotIn("Authorization", remote_get_headers[0])

        # RemoveBg.remove_background_from_img_url also recovers automatically from 413
        rmbg = RemoveBg(
            "rac_live_py_413",
            transport=fallback_transport,
            resolver=public_resolver,
        )
        out_shim = rmbg.remove_background_from_img_url(
            "https://cdn.example.com/12mp.jpg",
            size="full",
            new_file_name="",
        )
        self.assertEqual(out_shim, b"PY_URL_413_CUTOUT")

        # Negative cases: redirect, third-party error body leak, invalid magic bytes, >25 MB cap
        ticket_hits = []

        def make_neg_client(remote_tuple):
            def neg_transport(method, url, headers, body, timeout):
                if url.endswith("/v1.0/removebg"):
                    return 413, {"content-type": "application/json"}, b'{"errors":[{"code":"result_too_large"}]}'
                if url.endswith("/v1.0/removebg/ticket"):
                    ticket_hits.append(url)
                    return 200, {"content-type": "application/json"}, b'{"data":{"ticket":"x","directEndpoint":"https://api.remove.ac/v1.0/direct-cutout"}}'
                return remote_tuple

            return RemoveAcClient(
                api_key="rac_live_py_neg",
                transport=neg_transport,
                resolver=public_resolver,
            )

        with self.assertRaises(RemoveAcError) as redir_ctx:
            make_neg_client((302, {"location": "http://127.0.0.1/secret"}, b"")).remove_background(
                "https://cdn.example.com/redir.jpg"
            )
        self.assertEqual(redir_ctx.exception.status_code, 302)

        with self.assertRaises(RemoveAcError) as leak_ctx:
            make_neg_client((403, {}, b"SUPER_SECRET_INTERNAL_TOKEN")).remove_background(
                "https://cdn.example.com/err.jpg"
            )
        self.assertEqual(leak_ctx.exception.status_code, 502)
        self.assertNotIn("SUPER_SECRET_INTERNAL_TOKEN", str(leak_ctx.exception))

        with self.assertRaises(RemoveAcError) as magic_ctx:
            make_neg_client((200, {"content-type": "text/html"}, b"<html>not an image</html>")).remove_background(
                "https://cdn.example.com/html.jpg"
            )
        self.assertEqual(magic_ctx.exception.status_code, 400)

        with self.assertRaises(RemoveAcError) as size_ctx:
            make_neg_client((200, {"content-length": str(26 * 1024 * 1024)}, b"")).remove_background(
                "https://cdn.example.com/huge.jpg"
            )
        self.assertEqual(size_ctx.exception.status_code, 413)
        self.assertEqual(len(ticket_hits), 0)

    def test_m_p2_16_removebg_data_uri_base64_and_error_log_file(self):
        import os
        import pathlib
        import tempfile

        tiny_png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        )
        # "data:image/png;base64," has 18 base64-alphabet chars; pick payloads testing both len%4==1 crash & silent garbage cases
        data_uri_png = f"data:image/png;base64,{base64.b64encode(tiny_png).decode('ascii')}"
        data_uri_jpg = f"data:image/jpeg;base64,{base64.b64encode(b'\xff\xd8\xff\xd9A').decode('ascii')}"

        uploaded_bodies = []

        def capture_transport(method, url, headers, body, timeout):
            uploaded_bodies.append(body)
            return 200, {"content-type": "image/png"}, b"DATA_URI_OK"

        rmbg = RemoveBg("rac_live_datauri", transport=capture_transport)
        res1 = rmbg.remove_background_from_base64_img(data_uri_png, new_file_name="")
        self.assertEqual(res1, b"DATA_URI_OK")
        # Uploaded multipart must contain exact raw PNG bytes right after header CRLFCRLF (zero prepended garbage)
        self.assertIn(b"\r\n\r\n" + tiny_png + b"\r\n", uploaded_bodies[0])

        res2 = rmbg.remove_background_from_base64_img(data_uri_jpg, new_file_name="")
        self.assertEqual(res2, b"DATA_URI_OK")
        self.assertIn(b"\r\n\r\n\xff\xd8\xff\xd9A\r\n", uploaded_bodies[1])

        # error_log_file records API & validation errors before re-raising RemoveAcError
        temp_root = (
            "/Volumes/Expansion/dev-tools/build-temp"
            if os.path.isdir("/Volumes/Expansion/dev-tools/build-temp")
            else None
        )
        with tempfile.TemporaryDirectory(dir=temp_root, prefix="rac-py-errlog-") as tmp_dir:
            log_path = pathlib.Path(tmp_dir) / "removebg-errors.log"
            fg_path = pathlib.Path(tmp_dir) / "sample.png"
            fg_path.write_bytes(tiny_png)

            failing_rmbg = RemoveBg(
                "rac_live_errlog",
                error_log_file=str(log_path),
                transport=lambda m, u, h, b, t: (402, {"content-type": "application/json"}, b'{"errors":[{"title":"Insufficient credits"}]}'),
                resolver=lambda _h: ["93.184.216.34"],
            )

            with self.assertRaises(RemoveAcError) as c_b64:
                failing_rmbg.remove_background_from_base64_img("data:image/png,missing-base64-marker", new_file_name="")
            self.assertEqual(c_b64.exception.status_code, 400)

            with self.assertRaises(RemoveAcError) as c_file:
                failing_rmbg.remove_background_from_img_file(str(fg_path), new_file_name="")
            self.assertEqual(c_file.exception.status_code, 402)

            with self.assertRaises(RemoveAcError) as c_url:
                failing_rmbg.remove_background_from_img_url("https://cdn.example.com/item.png", new_file_name="")
            self.assertEqual(c_url.exception.status_code, 402)

            log_text = log_path.read_text(encoding="utf-8")
            lines = [ln for ln in log_text.splitlines() if ln.strip()]
            self.assertEqual(len(lines), 3)
            self.assertIn("malformed data URI", lines[0])
            self.assertIn("Insufficient credits", lines[1])
            self.assertIn("Insufficient credits", lines[2])


if __name__ == "__main__":
    unittest.main()
