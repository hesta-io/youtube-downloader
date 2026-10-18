# Hesta Downloader

A lightweight, native-feeling macOS app for downloading YouTube videos, Shorts, playlists and
channels — built with Electron and branded for [Hesta](https://hesta.io).

Paste (or drop) any YouTube link, pick the videos and resolution, choose a folder, and download.
Downloads are resumable, survive app restarts, and run several at a time.

---

## Download

Latest version: **1.0.0** — [all releases](https://github.com/hesta-io/youtube-downloader/releases)

| Mac | Installer (recommended) | Archive | Size |
| --- | --- | --- | --- |
| **Apple Silicon** (M1, M2, M3, M4…) | [Hesta-Downloader-1.0.0-arm64.dmg](https://github.com/hesta-io/youtube-downloader/releases/download/v1.0.0/Hesta-Downloader-1.0.0-arm64.dmg) | [.zip](https://github.com/hesta-io/youtube-downloader/releases/download/v1.0.0/Hesta-Downloader-1.0.0-arm64.zip) | 154 MB |
| **Intel** | [Hesta-Downloader-1.0.0-x64.dmg](https://github.com/hesta-io/youtube-downloader/releases/download/v1.0.0/Hesta-Downloader-1.0.0-x64.dmg) | [.zip](https://github.com/hesta-io/youtube-downloader/releases/download/v1.0.0/Hesta-Downloader-1.0.0-x64.zip) | 170 MB |

Not sure which Mac you have?  → *Apple menu → About This Mac*: "Chip: Apple M…" means Apple
Silicon, "Processor: Intel…" means Intel.

**Install:** open the `.dmg` and drag **Hesta Downloader** onto **Applications**.

**First launch:** the app is not yet notarized by Apple, so macOS blocks it the first time.
Open *System Settings → Privacy & Security*, scroll down and click **Open Anyway** next to
"Hesta Downloader" (or run `xattr -dr com.apple.quarantine "/Applications/Hesta Downloader.app"`).
On first run the app downloads its download engine (~30 MB) once.

<details>
<summary>SHA-256 checksums</summary>

```
b11a1c3c6be0ea6ccc2549adb11572738cc419e08d079dcede29f3d15f157241  Hesta-Downloader-1.0.0-arm64.dmg
e8b2fe31e2177c54104adbfbdf1b04da305cc294e10fc0d3ee43f263f77e3252  Hesta-Downloader-1.0.0-x64.dmg
5bbe40e0b7defeccd1f8025bca09faf8c08316a824402ec80d1b0d9e5397e155  Hesta-Downloader-1.0.0-arm64.zip
5a29dfe630ba1657ade292f64822b8440299ddf3199b5c03bd6bd22e0962a3c1  Hesta-Downloader-1.0.0-x64.zip
```

Verify with `shasum -a 256 Hesta-Downloader-1.0.0-arm64.dmg`.
</details>

---

## Features

- **Detects every kind of YouTube link** — `youtube.com/watch`, `youtu.be`, Shorts, Live, embeds,
  `youtube-nocookie.com`, `m.` / `music.` / `youtubekids`, playlists, mixes, albums
  (`OLAK5uy_…`), channels (`@handle`, `/channel/UC…`, `/c/…`, `/user/…`), Google/consent/attribution
  redirect links, bare playlist IDs, and many links pasted at once from any text.
- **Playlist & channel fetching** — lists every video with thumbnail, duration and availability;
  select all / some, filter by title. Private or deleted entries are flagged and skipped.
- **Resolution choice** — for a single video only the resolutions it really has are offered,
  with estimated sizes; for playlists choose a target (8K … 144p) and each video gets the closest
  lower quality available. Audio-only M4A / MP3 too.
- **Resumable downloads** — pause/resume at any time; partially downloaded data is kept and
  continued, including after quitting the app. Cancelling removes partial files.
- **Reliable** — automatic retries with back-off for network errors, friendly error messages,
  concurrent downloads (1–6), optional speed limit and proxy.
- **Native macOS feel** — translucent sidebar, inset traffic lights, system font, automatic
  light/dark mode, native menus & context menus, Dock badge and progress, notifications,
  keyboard shortcuts, drag-and-drop, and clipboard link detection.
- **Self-sufficient** — FFmpeg is bundled inside the app; the yt-dlp engine is installed and kept
  up to date automatically; no Homebrew, Python or Node install is required on the user's Mac.

## Requirements

| For | Requirement |
| --- | --- |
| Running the built app | macOS 12 Monterey or later, Apple Silicon or Intel |
| Developing / building | macOS, **Node.js 20+** (uses built-in `fetch` and `node --test`), npm |
| First launch | Internet access (downloads the yt-dlp engine once, ~30 MB) |

## Getting started

```sh
npm install        # also downloads + verifies FFmpeg for this Mac (postinstall)
npm start          # run in development
npm test           # unit tests
```

### Building

```sh
npm run dist       # Hesta-Downloader-<version>-{arm64,x64}.{dmg,zip} → dist/
npm run pack       # unpacked .app for the current architecture only (quick check)
npm run icon       # regenerate build/icon.png + build/icon.icns from the Hesta mark
npm run ffmpeg -- mac-arm64 mac-x64   # (re)fetch bundled FFmpeg for specific targets
```

`npm run dist` fetches FFmpeg for **both** Mac architectures first; electron-builder then places
the matching build into each app at `Contents/Resources/ffmpeg/`.

Builds are unsigned unless a Developer ID certificate is available. To distribute without
Gatekeeper warnings, sign and notarize (set `CSC_LINK`/`CSC_KEY_PASSWORD` and the Apple notarization
environment variables documented by electron-builder). Hardened-runtime entitlements are in
`build/entitlements.mac.plist`.

## Dependencies

### npm packages (development only — the app has **no runtime npm dependencies**)

| Package | Version | Purpose |
| --- | --- | --- |
| [`electron`](https://www.electronjs.org/) | ^44.9.0 | App runtime (Chromium + Node.js 24) |
| [`electron-builder`](https://www.electron.build/) | ^26.15.3 | Packaging `.app`, `.dmg`, `.zip` |

### Bundled / managed tools

| Tool | Version | How it gets there | License |
| --- | --- | --- | --- |
| [FFmpeg + FFprobe](https://ffmpeg.org/) | 6.x static builds from [`eugeneware/ffmpeg-static`](https://github.com/eugeneware/ffmpeg-static) release `b6.1.1` | Downloaded at build time by `scripts/fetch-ffmpeg.js`, **SHA-256 pinned**, shipped inside the app | GPL-3.0 |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | latest (e.g. 2026.08.19) | Official `yt-dlp_macos.zip` downloaded on first launch, SHA-256 verified against the release's `SHA2-256SUMS`; checked for updates daily | Unlicense |
| JavaScript runtime (for YouTube's player challenges) | Node.js built into Electron | Electron's own binary run with `ELECTRON_RUN_AS_NODE=1`; Deno 2+ is used instead if installed | — |

FFmpeg is used to merge the separate video and audio streams YouTube serves above 360p, to
convert audio (MP3/M4A) and to embed metadata/thumbnails. Lookup order at runtime: custom path
(setting) → **bundled copy** → copy downloaded at runtime (only if the bundle is missing/damaged)
→ system install.

Supported FFmpeg targets in the fetch script: `mac-arm64`, `mac-x64`, `win-x64`, `linux-x64`,
`linux-arm64` (the app itself is currently built for macOS only).

## How it works

| Piece | File |
| --- | --- |
| Link detection & normalisation | `src/main/links.js` |
| Engine: yt-dlp install/update, FFmpeg & JS runtime discovery, one-time browser cookie export | `src/main/engine.js` |
| Metadata probing, download process, progress parsing, error messages | `src/main/ytdlp.js` |
| Queue: concurrency, pause/resume, auto-retry, persistence | `src/main/queue.js` |
| Atomic JSON storage (no database) | `src/main/store.js` |
| Windows, menus, Dock, notifications, IPC | `src/main/main.js` |
| Secure bridge to the UI (`contextIsolation`, sandbox) | `src/preload.js` |
| UI (plain HTML/CSS/JS, no framework) | `src/renderer/` |
| FFmpeg fetcher (build time) | `scripts/fetch-ffmpeg.js` |

**Resumable downloads** — yt-dlp writes `.part` files. Pausing sends `SIGINT` to the download's
process group; resuming re-runs the same job, which continues from the last byte. On quit,
active downloads are stopped cleanly and re-queued for the next launch.

**Cookies (optional)** — for age-restricted or "confirm you're not a bot" videos, choose a browser
under *Settings → Use cookies from*. Cookies are read **once** (macOS may ask for Keychain access a
single time — choose *Always Allow*); only YouTube/Google cookies are kept, in a file readable only
by you, refreshed every 12 hours.

## Where things are stored

| What | Location |
| --- | --- |
| Settings, download list | `~/Library/Application Support/Hesta Downloader/settings.json`, `downloads.json` |
| yt-dlp engine | `~/Library/Application Support/Hesta Downloader/engine/` |
| Exported YouTube cookies | `~/Library/Application Support/Hesta Downloader/YouTube Cookies/` |
| Downloads | `~/Downloads` by default (changeable per download or in Settings) |

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| ⌘N | Focus the link field |
| ⌘V (outside a text field) / ⇧⌘V | Paste link(s) and fetch |
| ⌘1 – ⌘4 | All / Active / Completed / Failed |
| ⌥⌘P / ⌥⌘R | Pause all / Resume all |
| ⌥⌘K | Clear completed |
| Space / Enter / ⌫ | Pause-resume / open / remove the selected download |
| ⌘, | Settings |

## Troubleshooting

- **"YouTube is asking to confirm you are not a bot"** — sign in to YouTube in your browser, pick
  that browser under *Settings → Use cookies from*, then *Resume All*.
- **HTTP 403 / formats missing** — *Hesta Downloader → Check for Engine Updates…*.
- **Error details** — right-click a failed download → *Copy Error Details*.
