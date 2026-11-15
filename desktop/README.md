# Remove.ac Desktop App (`v1.0.0`)

Standalone native Electron desktop application for **[remove.ac](https://remove.ac/plugins/desktop)** — built for high-volume bulk AI background removal on **Windows 10/11 (`.exe`)**, **macOS Universal (`.dmg`)**, and **Linux x64 (`.AppImage`)**.

## Features

- **Zero Runtime Dependencies for End Users:** Ships a self-contained Electron 45 (Chromium + Node) binary — no Node.js, Python, or system WebView installation required.
- **Drag-and-Drop Folders & Thousands of Photos:** Recursively scans nested directories, preserves subfolder hierarchy under `remove-ac-output` (or a custom destination folder), and automatically excludes previous output folders to prevent duplicate re-ingestion.
- **Up to 25 MB / 40 MP Input & 25 MP Output:** Files above 4 MB seamlessly negotiate a 180-second HMAC direct ticket (`POST /v1.0/remove/ticket`) and stream straight to ephemeral Cloud GPU memory with zero disk storage.
- **OS Keychain Encryption:** Encrypts your `rac_live_...` API key locally via Windows DPAPI (`CryptProtectData`), macOS Keychain, or Linux Secret Service (`safeStorage`).
- **System Proxy Aware:** Uses Chromium's native OS networking stack (`electron.net.fetch`) so Windows / macOS system proxies, PAC rules, and enterprise TLS roots work out of the box.
- **Bilingual Native Studio (`English` / `简体中文`):** Switch between transparent PNG/WebP, pure `#FFFFFF` marketplace white, custom hex colors, or 4-file editable `.zip` layer packs, plus auto-crop, realistic drop/car/contact shadows, `1×–8×` parallel GPU workers, and side-by-side cutout preview.

## Local Development & Verification

```bash
cd desktop
npm install
npm test          # Node unit & integration suite (core, SSRF, DPAPI/keychain, batch queue)
npm run smoke     # Headless Electron + preload + IPC bootstrap smoke check
npm start         # Launch interactive desktop window
```

## Packaging Native Installers

```bash
cd desktop
npm run dist:win    # -> dist/remove-ac-for-windows-1.0.0.exe (NSIS) + dist/remove-ac-portable-1.0.0.exe
npm run dist:mac    # -> dist/remove-ac-for-macos-1.0.0.dmg (Universal arm64 + x64)
npm run dist:linux  # -> dist/remove-ac-for-linux-1.0.0.AppImage (x64)
```

### Unsigned Binary Notes (First Launch)

- **Windows 10/11 SmartScreen:** If Windows Defender SmartScreen displays *"Windows protected your PC"*, click **More info → Run anyway** (verify the SHA-256 hash against `SHA256SUMS.txt` on the GitHub Release page).
- **macOS Gatekeeper:** After dragging `Remove.ac.app` to `/Applications`, right-click `Remove.ac.app` → **Open** (or run `xattr -dr com.apple.quarantine /Applications/Remove.ac.app` once).
