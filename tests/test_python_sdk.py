import base64
import json
import unittest

from remove_ac import (
    RemoveAcClient,
    RemoveAcError,
    RemoveBg,
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


if __name__ == "__main__":
    unittest.main()
