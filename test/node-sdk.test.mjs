import assert from "node:assert/strict";
import test from "node:test";
import { RemoveAcClient, RemoveAcError, removeBackgroundFromImageUrl } from "../node/index.mjs";

test("RemoveAcClient calls /v1.0/removebg for standard inputs", async () => {
  const calls = [];
  const client = new RemoveAcClient({
    apiKey: "rac_live_test_example",
    baseUrl: "https://remove.ac",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "X-Width": "1024",
          "X-Height": "768",
          "X-Credits-Charged": "1",
        },
      });
    },
  });

  const res = await client.removeBackground(new Uint8Array([1, 2, 3]), {
    size: "full",
    shadowType: "contact",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://remove.ac/v1.0/removebg");
  assert.equal(calls[0].init.headers["X-Api-Key"], "rac_live_test_example");
  assert.equal(res.width, 1024);
  assert.equal(res.height, 768);
  assert.equal(res.creditsCharged, 1);
  assert.equal(res.buffer[0], 0x89);
});

test("RemoveAcClient automatically upgrades >4 MB payloads to zero-disk direct cutout tickets", async () => {
  const calls = [];
  const largeBuffer = Buffer.alloc(4 * 1024 * 1024 + 64, 0x42);
  const client = new RemoveAcClient({
    apiKey: "rac_live_test_example",
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/v1.0/removebg/ticket")) {
        return Response.json({
          data: {
            ticket: "signed_ticket_token",
            directEndpoint: "https://gpu.example.invalid/v1.0/direct-cutout",
          },
        });
      }
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "Content-Type": "image/png", "X-Credits-Charged": "1" },
      });
    },
  });

  const res = await client.removeBackground(largeBuffer, { size: "full" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://remove.ac/v1.0/removebg/ticket");
  assert.equal(calls[1].url, "https://gpu.example.invalid/v1.0/direct-cutout");
  assert.equal(calls[1].init.headers.Authorization, "Bearer signed_ticket_token");
  assert.equal(res.creditsCharged, 1);
});

test("RemoveAcClient rejects missing API keys and removeBackgroundFromImageUrl returns base64", async () => {
  const noKey = new RemoveAcClient({ apiKey: "" });
  await assert.rejects(() => noKey.removeBackground(new Uint8Array([1])), RemoveAcError);

  const out = await removeBackgroundFromImageUrl({
    apiKey: "rac_live_test_example",
    url: "https://example.com/item.jpg",
    fetch: async () =>
      new Response(Buffer.from("PNGDATA"), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
  });
  assert.equal(out.base64img, Buffer.from("PNGDATA").toString("base64"));
});
