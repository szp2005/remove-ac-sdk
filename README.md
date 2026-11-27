# remove.ac Official SDKs, CLI, GitHub Action & MCP Server (`v1.3.2`)

[![szp2005/remove-ac-sdk MCP server](https://glama.ai/mcp/servers/szp2005/remove-ac-sdk/badges/score.svg)](https://glama.ai/mcp/servers/szp2005/remove-ac-sdk)

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
- **Sub-2s Warm Cloud GPU Latency (Measured 2026-11-19 on Real AIM-500 Photos):** Full high-resolution matting and edge refinement finishes in **`0.88–1.04 s` on GPU (`1.58 s` end-to-end)** at 2.2 MP (`1696×1312`) and **`1.49–2.01 s` on GPU (`2.26 s` end-to-end)** at 4K (`3840×2160`); cold scale-from-zero 4K finishes in **`8.41 s` end-to-end**.
- **Free Interactive Cloud GPU Previews (`~612px`, `0` Credits):** In the web studio ([remove.ac/upload](https://remove.ac/upload)), inspect `~612px` (`~0.25 MP`) Cloud GPU cutouts for `0` credits (`5/day` on free accounts, `30/day` with paid credits; images already within preview dimensions deliver full original resolution free) before spending `1` credit to unlock full-resolution Max HD (up to `50 MP / 25 MB`, keeping background/shadow/crop edits).
- **Dec 1 Migration Grant (`30%-50%` Off Through Dec 31, 2026) & `14`-Day Self-Serve Refund:** Self-serve checkout auto-applies `30%` off Starter (`10-75` PAYG, `40` mo/yr), `40%` off Growth (`200-500`), and `50%` off High-Volume (`1,200-5,000` PAYG/mo + `1,200` yr) on first `3` monthly cycles, first annual year up to `1,200`, or non-expiring PAYG packs (up to `3` orders/account, max `1` on `2,800`/`5,000`; Enterprise `2,800`/`5,000` annual concierge-verified via `support@remove.ac`). Initial orders include a `14`-day self-serve trial refund (`100%` if `0` credits used, or 1-click prorated refund if `<= 20%` and `<= 100` credits used, minus `$1` gateway fee, `1` prorated refund/account).
- **Bug & Workflow Idea Credit Rewards:** Report bugs, cutout edge cases, or workflow ideas on the [remove.ac](https://remove.ac) homepage (up to `3` submissions per 24h) to earn `5-20` non-expiring Cloud GPU credits automatically once verified and accepted.

---

## Default `size` per Surface & Credit Cost

The default output `size` is **not the same on every surface**. If you leave `size` out, the cost per successful image depends on which client you use. To get predictable output and billing, always pass `size` explicitly.

| Surface | Default `size` when omitted | Output cap | Credits per successful image |
|---|---|---|---|
| REST `POST /v1.0/removebg` (curl or any HTTP client, `remove.bg`-compatible) | `preview` | ~0.25 MP | `0.25` |
| Node.js SDK `RemoveAcClient.removeBackground()` | `auto` | up to 50 MP | `1` |
| CLI `remove-ac` (`--size`) | `auto` | up to 50 MP | `1` |
| Python SDK `RemoveAcClient.remove_background()` | `auto` | up to 50 MP | `1` |
| Python `RemoveBg` drop-in shim (`remove_background_from_img_file` / `_img_url` / `_base64_img`) | `regular` | ~0.25 MP | `0.25` |
| MCP server tools (`remove_background_file`, `remove_background_url`) | `full` | up to 50 MP | `1` |
| GitHub Action (`size` input) | `full` | up to 50 MP | `1` |
| Desktop app | `full` | up to 50 MP | `1` |

Credit cost depends only on the `size` tier:

- `preview`, `small`, `regular`: output capped at ~0.25 MP (250,000 px). Costs **`0.25` credit**.
- `medium` (1.5 MP), `hd` (4 MP), `4k` (10 MP), `25mp` (25 MP), `50mp`, `full`, `maximum`, `auto` (up to 50 MP): costs **`1` credit**.
- Failed, rejected (for example `413`) or timed-out calls cost `0` credits. The response header `X-Credits-Charged` reports the actual charge.

## Upload Size Limits

| Limit | Value | Enforced by |
|---|---|---|
| Single image (foreground or background file) | 25 MiB (26,214,400 bytes) and 50 MP (max 50,000 px per side) | SDKs, CLI, MCP, Action, Desktop (before upload) and the remove.ac edge |
| Combined foreground + local background file in one request | 29.5 MiB (30,932,992 bytes) of raw image bytes | SDKs, CLI, MCP and Action (before upload). This leaves 512 KiB of headroom for multipart framing |
| Whole HTTP request body | 32 MiB (33,554,432 bytes) | remove.ac edge. Larger requests get `413 payload_too_large` and `X-Credits-Charged: 0` |

The client-side 29.5 MiB check always trips before the 32 MiB edge cap. In `v1.3.2`, client error messages call this the "30 MB multipart envelope"; the byte values in the table above are the exact limits.

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

For Cline and other AI coding agents, see [`./llms-install.md`](./llms-install.md) for deterministic step-by-step setup and a zero-key JSON-RPC handshake check.

### Claude Desktop / Cursor / Cline Configuration

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

## 7. n8n Community Node (`n8n-nodes-remove-ac` `v1.0.3`)

In self-hosted or desktop n8n, open **Settings → Community Nodes → Install** and enter `n8n-nodes-remove-ac` (`v1.0.3`) to replace deprecated `remove.bg` workflow steps with native binary and URL support up to `25 MB / 50 MP`.

---

## 8. Standalone Desktop App (`Windows .exe` · `macOS Universal .dmg` · `Linux .AppImage`)

[`desktop/`](./desktop) contains the official standalone Electron desktop application (`Remove.ac`) for bulk folder and multi-thousand-photo background removal up to `25 MB / 50 MP` — requiring zero Node.js or Python installation on end-user machines:

- **Direct Downloads:** https://remove.ac/plugins/desktop (or [GitHub Releases](https://github.com/szp2005/remove-ac-sdk/releases))
- **Installers:** `remove-ac-for-windows-1.1.1.exe` (NSIS x64), `remove-ac-portable-1.1.1.exe` (zero-install portable x64), `remove-ac-for-macos-1.1.1.dmg` (Universal Apple Silicon + Intel), and `remove-ac-for-linux-1.1.1.AppImage` (x64)
- **First launch:** The installers are not code-signed, and the macOS build is not notarized. See [Unsigned Binary Notes](./desktop/README.md#unsigned-binary-notes-first-launch) for SHA-256 verification and the macOS 15+ **System Settings → Privacy & Security → Open Anyway** steps.

---

## License

MIT © [remove.ac](https://remove.ac)
