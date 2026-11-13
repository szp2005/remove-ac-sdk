import base64
import json
import unittest

from remove_ac import RemoveAcClient, RemoveAcError, RemoveBg


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

        client = RemoveAcClient(api_key="rac_live_test_example", transport=fake_transport)
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


if __name__ == "__main__":
    unittest.main()
