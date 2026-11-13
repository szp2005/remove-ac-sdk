# remove.ac Official SDKs & CLI (Node.js · Python · Drop-in `remove.bg` Migration)

Zero-dependency official developer SDKs and hot-folder CLI for **[remove.ac](https://remove.ac)** — the dual-mode background removal platform pairing a free on-device WebAssembly studio with a `remove.bg`-compatible Cloud GPU REST API (`POST https://remove.ac/v1.0/removebg`).

- **Live Web Workbench (Free On-Device WASM + Batch 50 ZIP):** https://remove.ac
- **Interactive API Sandbox & Docs:** https://remove.ac/api-info
- **Figma, Photoshop UXP, GIMP, Sketch & Make/n8n Integrations:** https://remove.ac/plugins
- **Open Inference & Pricing Dataset (`CC BY 4.0`):** https://remove.ac/benchmarks

---

## Key Capabilities

- **1:1 `remove.bg` v1.0 Field Compatibility:** Swap `https://api.remove.bg/v1.0/removebg` to `https://remove.ac/v1.0/removebg` using standard `X-Api-Key: rac_live_...` headers and form fields (`image_file`, `image_file_b64`, `image_url`, `size`, `format`, `channels`, `type`, `roi`, `crop`, `crop_margin`, `scale`, `position`, `bg_color`, `bg_image_url`, `add_shadow`, `shadow_type`, `shadow_opacity`, `semitransparency`).
- **Up to 25 MB / 40 MP Zero-Disk Direct GPU Streaming:** Payloads above 4 MB automatically negotiate a short-lived HMAC ticket (`POST /v1.0/removebg/ticket`) and stream directly to ephemeral GPU RAM without disk or database blob persistence.
- **Atomic Credit Holds (`Idempotency-Key`):** Upstream timeouts or errors automatically release held credits with zero charge. Every verified account starts with **1 free credit**.
- **Zero External Runtime Dependencies:** Both the Node.js 18+ SDK and Python 3.8+ SDK run purely on standard library primitives (`fetch`/`crypto` in Node, `urllib` in Python).

---

## 1. Quick `curl` Migration

```bash
curl -X POST https://remove.ac/v1.0/removebg \
  -H "X-Api-Key: rac_live_your_key_here" \
  -F "image_file=@photo.jpg" \
  -F "size=full" \
  -o cutout.png
```

---

## 2. Node.js / TypeScript SDK (`Node 18+`)

### Install directly via GitHub

```bash
npm install github:szp2005/remove-ac-sdk
```

### Usage

```ts
import fs from "node:fs";
import { RemoveAcClient } from "remove-ac";

const client = new RemoveAcClient({
  apiKey: process.env.REMOVE_AC_API_KEY, // rac_live_...
});

// Files > 4 MB (up to 25 MB) automatically use /v1.0/removebg/ticket zero-disk GPU streaming
const result = await client.removeBackground("./studio-shot-18mb.png", {
  size: "full",
  format: "png",
  shadowType: "contact",
});

fs.writeFileSync("./studio-shot-cutout.png", result.buffer);
console.log(`Saved ${result.width}x${result.height} (${result.creditsCharged} credit)`);
```

---

## 3. CLI & `--watch` Hot-Folder Batch Tool

Run directly with `npx` or after installing:

```bash
export REMOVE_AC_API_KEY="rac_live_..."

# Process an entire folder with 4 parallel workers
npx github:szp2005/remove-ac-sdk ./input-photos ./output-pngs --concurrency=4 --size=full

# Watch a hot folder continuously and output transparent WebP cutouts
npx github:szp2005/remove-ac-sdk ./incoming ./cutouts --watch --format=webp --crop
```

---

## 4. Python SDK (`Python 3.8+`, Zero External Dependencies)

### Install directly via GitHub

```bash
pip install git+https://github.com/szp2005/remove-ac-sdk.git
```

### Native Client

```python
from remove_ac import RemoveAcClient

client = RemoveAcClient()  # reads REMOVE_AC_API_KEY
png_bytes = client.remove_background(
    "product.jpg",
    size="full",
    shadow_type="contact",
)
with open("product-nobg.png", "wb") as fh:
    fh.write(png_bytes)
```

### 1:1 `removebg` Drop-In Replacement Shim

Existing scripts written for `from removebg import RemoveBg` work without rewriting call sites:

```python
from removebg import RemoveBg

rmbg = RemoveBg("rac_live_your_key_here")
rmbg.remove_background_from_img_file("car.jpg", size="full", new_file_name="car-cutout.png")
```

---

## License

MIT © [remove.ac](https://remove.ac)
