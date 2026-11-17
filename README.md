# remove.ac Official SDKs, CLI, GitHub Action & MCP Server (`v1.3.0`)

Zero-dependency official developer SDKs, hot-folder CLI, GitHub Action, and Model Context Protocol (`MCP`) server for **[remove.ac](https://remove.ac)** — the dual-mode background removal platform pairing a free on-device WebAssembly studio with a `remove.bg`-compatible Cloud GPU REST API (`POST https://remove.ac/v1.0/removebg`).

- **Live Web Workbench (Free On-Device WASM + Batch 50 ZIP):** https://remove.ac
- **1-Line `remove.bg` API Migration Guide (Dec 1, 2026 Shutdown):** https://remove.ac/guides/remove-bg-api-migration
- **Interactive API Sandbox & Docs:** https://remove.ac/api-info
- **Figma, Photoshop UXP, GIMP, Sketch & Make/n8n Integrations:** https://remove.ac/plugins
- **Official MCP Registry ID:** `io.github.szp2005/remove-ac`
- **n8n Community Node:** [`n8n-nodes-remove-ac`](https://www.npmjs.com/package/n8n-nodes-remove-ac)
- **Open Inference & Pricing Dataset (`CC BY 4.0`):** https://remove.ac/benchmarks

---

## Key Capabilities

- **1:1 `remove.bg` v1.0 Field Compatibility:** Swap `https://api.remove.bg/v1.0/removebg` to `https://remove.ac/v1.0/removebg` using standard `X-Api-Key: rac_live_...` headers and form fields (`image_file`, `image_file_b64`, `image_url`, `size`, `format`, `channels`, `type`, `roi`, `crop`, `crop_margin`, `scale`, `position`, `bg_color`, `bg_image_file`, `bg_image_file_b64`, `bg_image_url`, `add_shadow`, `shadow_type`, `shadow_opacity`, `semitransparency`), plus `POST /v1.0/improve` (`submitImprove` / `submit_improve`) for hard-case feedback submissions.
- **Up to 25 MB / 50 MP Zero-Disk Direct GPU Streaming:** Single-call `POST https://remove.ac/v1.0/removebg` uploads up to 25 MB / 50 MP (`size=25mp`, `size=50mp`, `size=full`, `size=auto`) — including custom local background images (`bgImageFile` / `bg_image_file`) — stream transparently at the edge via 180-second single-use HMAC tickets (`POST /v1.0/removebg/ticket`) directly to ephemeral GPU RAM without disk or database blob persistence.
- **Atomic Credit Holds (`Idempotency-Key`):** Upstream timeouts or errors automatically release held credits with zero charge. Every verified account starts with **10 full-resolution welcome credits (valid 30 days)**; pay-as-you-go credit packs never expire.
- **Zero External Runtime Dependencies:** The Node.js 18+ SDK, CLI, GitHub Action, MCP stdio server, and Python 3.8+ SDK run purely on standard library primitives (`fetch`/`crypto` in Node, `urllib` in Python).

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

### Install via npm or GitHub

```bash
npm install remove-ac
# via GitHub Packages npm registry (aliased as "remove-ac" for drop-in imports; requires //npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT in .npmrc):
npm install remove-ac@npm:@szp2005/remove-ac --@szp2005:registry=https://npm.pkg.github.com
# or directly from GitHub:
npm install github:szp2005/remove-ac-sdk
```

### Usage

```ts
import fs from "node:fs";
import { RemoveAcClient } from "remove-ac";

const client = new RemoveAcClient({
  apiKey: process.env.REMOVE_AC_API_KEY, // rac_live_...
});

// Files > 4 MB (up to 25 MB / 50 MP) automatically use /v1.0/removebg/ticket zero-disk GPU streaming
const result = await client.removeBackground("./studio-shot-18mb.png", {
  size: "full",
  format: "png",
  bgImageFile: "./studio-backdrop.jpg", // optional path or Buffer/Uint8Array/ArrayBuffer
  shadowType: "contact",
});

fs.writeFileSync("./studio-shot-cutout.png", result.buffer);
console.log(`Saved ${result.width}x${result.height} (${result.creditsCharged} credit)`);
```

---

## 3. CLI & `--watch` Hot-Folder Batch Tool

```bash
export REMOVE_AC_API_KEY="rac_live_..."

# Process an entire folder with 4 parallel workers (up to 50 MP)
npx -y -p remove-ac remove-ac ./input-photos --output-dir ./output-pngs --concurrency=4 --size=50mp

# Watch a hot folder continuously and output transparent WebP cutouts
npx -y -p remove-ac remove-ac ./incoming --output-dir ./cutouts --watch --format=webp --crop
```

---

## 4. Python SDK (`Python 3.8+`, Zero External Dependencies)

### Install via PyPI or GitHub

```bash
pip install remove-ac
# or directly from GitHub:
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

## 5. MCP Server (`Claude Desktop` · `Cursor` · `VS Code` · `Windsurf` · `Cline`)

`remove-ac` includes a zero-dependency Model Context Protocol (`MCP`) stdio server (`remove-ac-mcp`, Official Registry ID `io.github.szp2005/remove-ac`) exposing three tools:

- `remove_background_file` — remove background from any local `.png` / `.jpg` / `.webp` up to `25 MB / 50 MP` (auto-streams `>4 MB` via `/v1.0/removebg/ticket`)
- `remove_background_url` — remove background from a public `https://` image URL and save locally
- `get_account_balance` — inspect remaining `remove.ac` API credits

### Claude Desktop / Cursor Configuration

```json
{
  "mcpServers": {
    "remove-ac": {
      "command": "npx",
      "args": ["-y", "-p", "remove-ac", "remove-ac-mcp"],
      "env": {
        "REMOVE_AC_API_KEY": "rac_live_your_key_here"
      }
    }
  }
}
```

---

## 6. Official GitHub Action (`CI/CD Asset Pipelines`)

Automate storefront product cutouts or PR asset cleanup directly inside GitHub Actions:

```yaml
- name: Remove product photo backgrounds
  uses: szp2005/remove-ac-sdk@v1
  with:
    api_key: ${{ secrets.REMOVE_AC_API_KEY }}
    input_path: "assets/raw-products"
    output_dir: "assets/transparent-pngs"
    size: "50mp"
    format: "png"
    crop: "true"
```

---

## 7. n8n Community Node (`n8n-nodes-remove-ac`)

In self-hosted or desktop n8n, open **Settings → Community Nodes → Install** and enter `n8n-nodes-remove-ac` to replace deprecated `remove.bg` workflow steps with native binary and URL support up to `25 MB / 50 MP`.

---

## 8. Standalone Desktop App (`Windows .exe` · `macOS Universal .dmg` · `Linux .AppImage`)

[`desktop/`](./desktop) contains the official standalone Electron desktop application (`Remove.ac`) for bulk folder and multi-thousand-photo background removal up to `25 MB / 50 MP` — requiring zero Node.js or Python installation on end-user machines:

- **Direct Downloads:** https://remove.ac/plugins/desktop (or [GitHub Releases](https://github.com/szp2005/remove-ac-sdk/releases))
- **Installers:** `remove-ac-for-windows-1.1.0.exe` (NSIS x64), `remove-ac-portable-1.1.0.exe` (zero-install portable x64), `remove-ac-for-macos-1.1.0.dmg` (Universal Apple Silicon + Intel), and `remove-ac-for-linux-1.1.0.AppImage` (x64)

---

## License

MIT © [remove.ac](https://remove.ac)
