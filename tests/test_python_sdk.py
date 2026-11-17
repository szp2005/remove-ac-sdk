import base64
import json
import unittest

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
)


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
                            "directEndpoint": "https://gpu.example.invalid/v1.0/direct-cutout",
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
        self.assertEqual(calls[1][1], "https://gpu.example.invalid/v1.0/direct-cutout")
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
                            "directEndpoint": "https://gpu.example.invalid/v1.0/direct-cutout",
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
                "https://gpu.example.invalid/v1.0/direct-cutout",
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
                            "directEndpoint": "https://gpu.example.invalid/v1.0/direct-cutout",
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
                                "directEndpoint": "https://gpu.example.invalid/v1.0/direct-cutout",
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
                                    "directEndpoint": "https://gpu.example.invalid/v1.0/direct-cutout",
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

            imp_client = RemoveAcClient(api_key="rac_live_py_imp", transport=improve_transport)
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


if __name__ == "__main__":
    unittest.main()
