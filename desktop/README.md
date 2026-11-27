# Remove.ac Desktop App (`v1.1.1`)

Standalone native Electron desktop application for **[remove.ac](https://remove.ac/plugins/desktop)** — built for high-volume bulk AI background removal on **Windows 10/11 (`.exe`)**, **macOS Universal (`.dmg`)**, and **Linux x64 (`.AppImage`)**.

## Features

- **Zero Runtime Dependencies for End Users:** Ships a self-contained Electron 45 (Chromium + Node) binary — no Node.js, Python, or system WebView installation required.
- **Drag-and-Drop Folders & Thousands of Photos:** Recursively scans nested directories, preserves subfolder hierarchy under `remove-ac-output` (or a custom destination folder), and automatically excludes previous output folders to prevent duplicate re-ingestion.
- **Up to 25 MB / 50 MP Input & 50 MP Output:** Files above 4 MB (or high-resolution lossless PNGs across `25mp`, `50mp`, `full`, and `auto`) seamlessly negotiate a 180-second HMAC direct ticket (`POST /v1.0/remove/ticket`) and stream straight to ephemeral Cloud GPU memory with zero disk storage. Verified accounts start with **10 full-resolution welcome credits (valid 30 days)**.
- **OS Keychain Encryption:** Encrypts your `rac_live_...` API key locally via Windows DPAPI (`CryptProtectData`), macOS Keychain, or Linux Secret Service (`safeStorage`).
- **System Proxy Aware:** Uses Chromium's native OS networking stack (`electron.net.fetch`) so Windows / macOS system proxies, PAC rules, and enterprise TLS roots work out of the box.
- **Bilingual Native Studio (`English` / `简体中文`):** Switch between transparent PNG/WebP, pure `#FFFFFF` marketplace white, custom hex colors, or 4-file editable `.zip` layer packs, plus auto-crop, realistic drop/car/contact/reflection shadows, `1×–8×` parallel GPU workers, and side-by-side cutout preview.

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
npm run dist:win    # -> dist/remove-ac-for-windows-1.1.1.exe (NSIS) + dist/remove-ac-portable-1.1.1.exe
npm run dist:mac    # -> dist/remove-ac-for-macos-1.1.1.dmg (Universal arm64 + x64)
npm run dist:linux  # -> dist/remove-ac-for-linux-1.1.1.AppImage (x64)
```

The file names follow `version` in `desktop/package.json`. These names match the assets of the [`desktop-v1.1.1` GitHub Release](https://github.com/szp2005/remove-ac-sdk/releases/tag/desktop-v1.1.1), which also includes `SHA256SUMS.txt`.

### Unsigned Binary Notes (First Launch)

The `v1.1.1` installers are **not code-signed**. The macOS build is also **not notarized by Apple**. Before you open any of them, check the download against `SHA256SUMS.txt` on the GitHub Release page:

```bash
# macOS / Linux
shasum -a 256 remove-ac-for-macos-1.1.1.dmg     # compare with SHA256SUMS.txt
# Windows (PowerShell)
Get-FileHash .\remove-ac-for-windows-1.1.1.exe -Algorithm SHA256
```

- **Windows 10/11 SmartScreen:** If Windows Defender SmartScreen shows *"Windows protected your PC"*, click **More info → Run anyway**.
- **macOS 15 Sequoia and later:** The Control-click / right-click → **Open** shortcut no longer bypasses Gatekeeper for apps that are not notarized. Instead:
  1. Drag `Remove.ac.app` to `/Applications` and double-click it once. macOS blocks it with a message such as *"Remove.ac" Not Opened*. Click **Done** (do **not** click *Move to Trash*).
  2. Open **System Settings → Privacy & Security**. Scroll down to the **Security** section.
  3. Next to *"Remove.ac" was blocked to protect your Mac*, click **Open Anyway**. Then confirm with your login password or Touch ID.
  4. Click **Open Anyway** in the final dialog. Later launches open normally.
- **macOS 14 Sonoma and earlier:** Control-click (or right-click) `Remove.ac.app` in `/Applications`, choose **Open**, then click **Open** again in the dialog.
- **macOS fallback (Terminal):** If macOS says the app *"is damaged and can't be opened"*, or the **Open Anyway** button does not appear, you can remove the download quarantine flag from this one app:

  ```bash
  xattr -dr com.apple.quarantine /Applications/Remove.ac.app
  ```

  > **Caution:** This turns off Gatekeeper's download check for `Remove.ac.app`. Run it only after the SHA-256 of the `.dmg` matches `SHA256SUMS.txt` from the official GitHub Release. Never run it on apps from sources you don't trust.

Until signed and notarized macOS builds are published, use the steps above to run the app.
