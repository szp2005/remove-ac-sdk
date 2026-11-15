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

        self.assertEqual(__version__, "1.2.0")
        self.assertEqual(SDK_VERSION, "1.2.0")
        self.assertEqual(USER_AGENT, "remove-ac-python-sdk/1.2.0")
        self.assertIn("25mp", VALID_SIZES)
        self.assertIn("50mp", VALID_SIZES)
        self.assertIsNotNone(SizeLiteral)

        # Verify real urllib _default_transport sends remove-ac-python-sdk/1.2.0 User-Agent (not Python-urllib)
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
            self.assertEqual(captured_uas, ["remove-ac-python-sdk/1.2.0"])
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
            self.assertEqual(headers.get("User-Agent"), "remove-ac-python-sdk/1.2.0")
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


if __name__ == "__main__":
    unittest.main()
