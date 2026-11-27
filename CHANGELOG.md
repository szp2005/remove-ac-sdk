# Changelog

All notable changes to the `remove-ac` SDK package (Node.js SDK, CLI, MCP server, GitHub Action, Python SDK) and the standalone desktop app. Dates are UTC release dates. Entries are taken from git history and the GitHub Releases.

## [1.3.2] — 2026-11-24

Tag `v1.3.2` (`e3a6f17`, PR #12). Published to npm, PyPI and the MCP Registry as `1.3.2`.

- Added `size=maximum` to the Node.js SDK, CLI, MCP server, GitHub Action and Python SDK.
- MCP server: `format` handling (`auto`, `jpeg`) now matches the SDKs, and `.gif` input files are accepted.
- Combined foreground + background upload is now checked before upload against a 29.5 MiB (30,932,992 bytes) limit.
- Removed the obsolete `smithery.yaml`.

## [1.3.1] — 2026-11-22

Tag `v1.3.1` (`84bbf53`; fixes in `5ad0fd0`, PR #9 and #10). Security and reliability patch.

- Strict `directEndpoint` allowlist. Custom `serverUrl` values with unsafe protocols or userinfo are rejected, so credentials cannot leak (Node.js SDK, CLI, Python SDK, Desktop).
- SSRF hardening for `image_url` / `bg_image_url`: resolved public IPs are pinned (`node/net-safety.mjs`, Python pinned HTTPS connection).
- URL fallback when the server returns `413`. Plus CLI file-output edge cases and MCP server error-handling fixes.
- Docs (`9dc1e1c`, PR #11): added `llms-install.md` (agent install guide) and a 400×400 marketplace icon.

## [1.3.0] — 2026-11-17

Tag `v1.3.0` (`e581dcd`, PR #5).

- Client-side limits raised to 25 MB / 50 MP per image across the Node.js SDK, Python SDK, CLI, GitHub Action and MCP server.
- Custom background image upload: `bgImageFile` / `bg_image_file`, CLI `--bg-image-file`, Action `bg-image-file`, MCP `bgImagePath`.
- New `submitImprove` / `submit_improve` for the zero-charge `POST /v1.0/improve` feedback endpoint.

## Desktop [1.1.1] — 2026-11-22

Tag `desktop-v1.1.1` (`84bbf53`). Assets: `remove-ac-for-windows-1.1.1.exe`, `remove-ac-portable-1.1.1.exe`, `remove-ac-for-macos-1.1.1.dmg`, `remove-ac-for-linux-1.1.1.AppImage`, `SHA256SUMS.txt`.

- Hardened the background removal pipeline and removed legacy fallback URLs.
- First-party host allowlist for the API server and direct GPU endpoints, as in SDK `1.3.1`.
- The builds are not code-signed, and the macOS build is not notarized. See [desktop/README.md](./desktop/README.md#unsigned-binary-notes-first-launch) for first-launch steps.

## Desktop [1.1.0] — 2026-11-17

Tag `desktop-v1.1.0` (`e581dcd`). Raised to 25 MB / 50 MP input and output.
