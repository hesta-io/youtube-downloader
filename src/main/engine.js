'use strict';

// Manages the external tools Hesta Downloader relies on:
//   • yt-dlp   – the extraction / download engine (official onedir build,
//                SHA-256 verified, kept up to date automatically)
//   • ffmpeg   – merging separate video/audio streams, audio conversion
//                (system install if present, otherwise downloaded)
//   • JS runtime – YouTube requires one for signature solving. Deno is used
//                if installed, otherwise Electron itself runs as Node.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { execFile, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { net, app } = require('electron');

const YTDLP_REPO = 'yt-dlp/yt-dlp';
const YTDLP_ASSET = 'yt-dlp_macos.zip';
const FFMPEG_REPO = 'eugeneware/ffmpeg-static';
const FFMPEG_TAG = 'b6.1.1';
const UPDATE_INTERVAL = 24 * 60 * 60 * 1000;
const COOKIE_MAX_AGE = 12 * 60 * 60 * 1000;
const COOKIE_RETRY_AFTER = 5 * 60 * 1000;
// Only cookies YouTube needs are kept on disk, never the whole browser jar.
const COOKIE_DOMAIN = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|google\.com|googlevideo\.com|ytimg\.com|accounts\.google\.com)$/i;

function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// yt-dlp only accepts Deno 2+; older installs are reported as "unsupported"
// and leave YouTube without a JS runtime. Checked once per path.
const denoChecks = new Map();
function denoSupported(p) {
  if (!denoChecks.has(p)) {
    let ok = false;
    try {
      const out = execFileSync(p, ['--version'], { timeout: 5000, encoding: 'utf8' });
      const m = out.match(/deno (\d+)\./);
      ok = !!m && Number(m[1]) >= 2;
    } catch {}
    denoChecks.set(p, ok);
  }
  return denoChecks.get(p);
}

async function fetchJson(url) {
  const res = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Stream a URL to disk, reporting progress and returning the SHA-256 of the raw bytes. */
async function download(url, dest, { onProgress, gunzip = false } = {}) {
  const res = await net.fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  let received = 0;
  let last = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      received += chunk.length;
      const now = Date.now();
      if (onProgress && (now - last > 150 || received === total)) {
        last = now;
        onProgress(received, total);
      }
      cb(null, chunk);
    },
  });
  const stages = [Readable.fromWeb(res.body), meter];
  if (gunzip) stages.push(zlib.createGunzip());
  stages.push(fs.createWriteStream(dest, { mode: 0o755 }));
  await pipeline(...stages);
  return hash.digest('hex');
}

class Engine extends EventEmitter {
  constructor({ dataDir, settings }) {
    super();
    this.dir = path.join(dataDir, 'engine');
    this.cacheDir = path.join(dataDir, 'cache');
    // Not "cookies": Chromium's own "Cookies" DB lives here and APFS is case-insensitive.
    this.cookieDir = path.join(dataDir, 'YouTube Cookies');
    this.cookieExport = null;
    this.cookieFailure = null;
    this.metaFile = path.join(this.dir, 'engine.json');
    this.settings = settings;
    this.meta = this.#readMeta();
    this.status = { ready: false, phase: 'idle', message: '', progress: null, error: null };
    this.ensuring = null;
    this.updating = null;
  }

  #readMeta() {
    try {
      return JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
    } catch {
      return {};
    }
  }

  #writeMeta() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.metaFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.meta, null, 2));
    fs.renameSync(tmp, this.metaFile);
  }

  #setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  // ---------- resolved paths ----------

  get ytdlpPath() {
    const m = this.meta.ytdlp;
    if (!m) return null;
    const p = path.join(this.dir, 'yt-dlp', m.version, 'yt-dlp_macos');
    return isExecutable(p) ? p : null;
  }

  get ytdlpVersion() {
    return this.meta.ytdlp?.version || null;
  }

  /** FFmpeg shipped inside the app (see scripts/fetch-ffmpeg.js). */
  static bundledFfmpegDir() {
    if (app.isPackaged) return path.join(process.resourcesPath, 'ffmpeg');
    const os = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
    return path.join(app.getAppPath(), 'vendor', 'ffmpeg', `${os}-${process.arch}`);
  }

  /**
   * Order: user override → copy bundled with the app → copy downloaded at
   * runtime (only if the bundle is damaged) → system install as a last resort.
   */
  findFfmpeg() {
    const exe = process.platform === 'win32' ? '.exe' : '';
    const custom = this.settings.get().ffmpegPath;
    const candidates = [];
    if (custom) candidates.push([/ffmpeg(\.exe)?$/i.test(custom) ? path.dirname(custom) : custom, 'custom']);
    candidates.push([Engine.bundledFfmpegDir(), 'bundled'], [path.join(this.dir, 'ffmpeg'), 'downloaded']);
    if (process.platform !== 'win32') {
      for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin']) candidates.push([d, 'system']);
    }
    for (const [dir, source] of candidates) {
      if (isExecutable(path.join(dir, 'ffmpeg' + exe)) && isExecutable(path.join(dir, 'ffprobe' + exe))) {
        return { dir, source, bundled: source === 'bundled' };
      }
    }
    return null;
  }

  findJsRuntime() {
    const home = os.homedir();
    for (const p of [path.join(home, '.deno/bin/deno'), '/opt/homebrew/bin/deno', '/usr/local/bin/deno']) {
      if (isExecutable(p) && denoSupported(p)) return { name: 'deno', path: p, env: {} };
    }
    // Electron's own binary behaves as Node.js with ELECTRON_RUN_AS_NODE=1.
    return { name: 'node', path: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' }, builtin: true };
  }

  /** Base args + env shared by every yt-dlp invocation (no cookies). */
  baseInvocation() {
    const js = this.findJsRuntime();
    const ff = this.findFfmpeg();
    const s = this.settings.get();
    const args = [
      '--ignore-config',
      '--no-colors',
      '--encoding', 'utf-8',
      '--cache-dir', this.cacheDir,
      '--no-js-runtimes',
      '--js-runtimes', `${js.name}:${js.path}`,
      '--socket-timeout', '30',
    ];
    if (ff) args.push('--ffmpeg-location', ff.dir);
    if (s.proxy) args.push('--proxy', s.proxy);
    const env = {
      ...process.env,
      ...js.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      LANG: process.env.LANG || 'en_US.UTF-8',
      PATH: [ff?.dir, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', process.env.PATH]
        .filter(Boolean).join(':'),
    };
    return { bin: this.ytdlpPath, args, env };
  }

  /**
   * Full invocation for a yt-dlp process. Browser cookies are exported once
   * (a single Keychain prompt) and each process gets its own private copy,
   * because yt-dlp rewrites its cookie file on exit. Call cleanup() when done.
   */
  async invocation() {
    const base = this.baseInvocation();
    let cleanup = () => {};
    const master = await this.prepareCookies();
    if (master) {
      const copy = path.join(this.cookieDir, `run-${process.pid}-${crypto.randomUUID()}.txt`);
      await fsp.copyFile(master, copy);
      await fsp.chmod(copy, 0o600);
      base.args.push('--cookies', copy);
      cleanup = () => fs.rm(copy, { force: true }, () => {});
    }
    return { ...base, cleanup };
  }

  /** Returns the exported cookie file for the chosen browser, or null if cookies are off. */
  prepareCookies() {
    const browser = this.settings.get().cookiesBrowser;
    if (!browser || browser === 'none') return Promise.resolve(null);
    const master = path.join(this.cookieDir, `${browser}.txt`);
    try {
      if (Date.now() - fs.statSync(master).mtimeMs < COOKIE_MAX_AGE) return Promise.resolve(master);
    } catch {}
    // Don't re-prompt in a loop after the user denied access or reading failed.
    const f = this.cookieFailure;
    if (f && f.browser === browser && Date.now() - f.at < COOKIE_RETRY_AFTER) return Promise.reject(f.error);
    if (!this.cookieExport) {
      this.cookieExport = this.#exportCookies(browser, master).finally(() => { this.cookieExport = null; });
    }
    return this.cookieExport;
  }

  async #exportCookies(browser, master) {
    const base = this.baseInvocation();
    if (!base.bin) throw new Error('Download engine is not installed yet.');
    await fsp.mkdir(this.cookieDir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.cookieDir, `export-${process.pid}-${Date.now()}.txt`);
    let stderr = '';
    try {
      // With no URL yt-dlp exits with a usage error (code 2) but still writes the jar.
      await run(base.bin, ['--ignore-config', '--no-colors', '--cookies-from-browser', browser, '--cookies', tmp], {
        env: base.env,
        timeout: 180000,
      }).catch((err) => { stderr = String(err.stderr || err.message || ''); });
      let raw = '';
      try { raw = await fsp.readFile(tmp, 'utf8'); } catch {}
      const kept = raw.split('\n').filter((line) => {
        if (!line.trim() || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) return false;
        const domain = line.replace(/^#HttpOnly_/, '').split('\t')[0];
        return COOKIE_DOMAIN.test(domain);
      });
      if (!kept.length) {
        const reason = /ERROR:\s*(.+)/.exec(stderr)?.[1]?.trim();
        throw new Error(reason
          ? `Could not read ${browser} cookies: ${reason}`
          : `No YouTube cookies found in ${browser}. Sign in to YouTube in ${browser}, then try again.`);
      }
      const out = master + '.tmp';
      await fsp.writeFile(out, ['# Netscape HTTP Cookie File', ...kept, ''].join('\n'), { mode: 0o600 });
      await fsp.rename(out, master);
      this.cookieFailure = null;
      return master;
    } catch (error) {
      this.cookieFailure = { browser, at: Date.now(), error };
      throw error;
    } finally {
      fs.rm(tmp, { force: true }, () => {});
    }
  }

  /** Forget exported cookies (browser changed, or YouTube rejected them). */
  clearCookies() {
    this.cookieFailure = null;
    try {
      for (const f of fs.readdirSync(this.cookieDir)) {
        if (!f.startsWith('run-')) fs.rmSync(path.join(this.cookieDir, f), { force: true });
      }
    } catch {}
  }

  info() {
    const ff = this.findFfmpeg();
    const js = this.findJsRuntime();
    return {
      ...this.status,
      ytdlp: { version: this.ytdlpVersion, path: this.ytdlpPath, checkedAt: this.meta.checkedAt || null },
      ffmpeg: ff ? { dir: ff.dir, source: ff.source, bundled: ff.bundled } : null,
      jsRuntime: { name: js.builtin ? 'Built-in (Node.js via Electron)' : 'Deno', path: js.path },
    };
  }

  // ---------- setup ----------

  ensure() {
    if (!this.ensuring) {
      this.ensuring = this.#ensure().finally(() => { this.ensuring = null; });
    }
    return this.ensuring;
  }

  async #ensure() {
    this.#setStatus({ phase: 'checking', message: 'Checking download engine…', error: null, progress: null });
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      if (!this.ytdlpPath) await this.#installYtdlp();
      if (!this.findFfmpeg()) await this.#installFfmpeg();
      this.#setStatus({ ready: true, phase: 'ready', message: '', progress: null });
      // Background freshness check — YouTube changes often, yt-dlp keeps up.
      if (this.settings.get().autoUpdateEngine !== false) {
        const due = !this.meta.checkedAt || Date.now() - this.meta.checkedAt > UPDATE_INTERVAL;
        if (due) this.update().catch(() => {});
      }
    } catch (err) {
      this.#setStatus({
        ready: !!this.ytdlpPath && !!this.findFfmpeg(),
        phase: 'error',
        message: 'Could not set up the download engine.',
        error: String(err.message || err),
        progress: null,
      });
      throw err;
    }
  }

  async #latestYtdlp() {
    try {
      const rel = await fetchJson(`https://api.github.com/repos/${YTDLP_REPO}/releases/latest`);
      const asset = rel.assets.find((a) => a.name === YTDLP_ASSET);
      if (!asset) throw new Error('asset missing');
      return { version: rel.tag_name, url: asset.browser_download_url };
    } catch {
      // API rate-limited/unavailable: follow the "latest" redirect instead.
      const res = await net.fetch(`https://github.com/${YTDLP_REPO}/releases/latest`, { redirect: 'manual' });
      const loc = res.headers.get('location') || '';
      const m = loc.match(/\/tag\/([^/?#]+)/);
      if (!m) throw new Error('Unable to determine latest yt-dlp version');
      return { version: m[1], url: `https://github.com/${YTDLP_REPO}/releases/download/${m[1]}/${YTDLP_ASSET}` };
    }
  }

  async #installYtdlp(release) {
    const rel = release || (await this.#latestYtdlp());
    const label = `yt-dlp ${rel.version}`;
    this.#setStatus({ phase: 'downloading', message: `Downloading ${label}…`, progress: 0 });

    const sums = await fetchText(`https://github.com/${YTDLP_REPO}/releases/download/${rel.version}/SHA2-256SUMS`);
    const line = sums.split('\n').find((l) => l.trim().endsWith(` ${YTDLP_ASSET}`) || l.trim().endsWith(`*${YTDLP_ASSET}`));
    const expected = line?.trim().split(/\s+/)[0]?.toLowerCase();
    if (!expected) throw new Error('Checksum for yt-dlp not published');

    const root = path.join(this.dir, 'yt-dlp');
    const stage = path.join(root, `.stage-${process.pid}-${Date.now()}`);
    await fsp.mkdir(stage, { recursive: true });
    try {
      const zip = path.join(stage, YTDLP_ASSET);
      const digest = await download(rel.url, zip, {
        onProgress: (r, t) => this.#setStatus({ progress: t ? r / t : null }),
      });
      if (digest !== expected) throw new Error('yt-dlp download failed verification (checksum mismatch)');

      this.#setStatus({ phase: 'installing', message: `Installing ${label}…`, progress: null });
      const out = path.join(stage, 'x');
      await run('/usr/bin/ditto', ['-x', '-k', zip, out]);
      const bin = path.join(out, 'yt-dlp_macos');
      if (!isExecutable(bin)) await fsp.chmod(bin, 0o755);

      // First launch of a fresh binary is slow while macOS scans it; do it now.
      this.#setStatus({ phase: 'verifying', message: `Verifying ${label}…` });
      const { stdout } = await run(bin, ['--version'], { timeout: 180000 });
      const version = stdout.trim() || rel.version;

      const final = path.join(root, version);
      await fsp.rm(final, { recursive: true, force: true });
      await fsp.rename(out, final);
      const previous = this.meta.ytdlp?.version;
      this.meta.ytdlp = { version, installedAt: Date.now() };
      this.meta.checkedAt = Date.now();
      this.#writeMeta();
      this.previousYtdlp = previous && previous !== version ? previous : null;
      return version;
    } finally {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #installFfmpeg() {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const dir = path.join(this.dir, 'ffmpeg');
    await fsp.mkdir(dir, { recursive: true });
    let digests = {};
    try {
      const rel = await fetchJson(`https://api.github.com/repos/${FFMPEG_REPO}/releases/tags/${FFMPEG_TAG}`);
      for (const a of rel.assets) if (a.digest) digests[a.name] = a.digest.replace(/^sha256:/, '').toLowerCase();
    } catch {
      digests = {};
    }
    const tools = ['ffmpeg', 'ffprobe'];
    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i];
      const asset = `${tool}-darwin-${arch}.gz`;
      this.#setStatus({ phase: 'downloading', message: `Downloading ${tool}…`, progress: 0 });
      const tmp = path.join(dir, `${tool}.download`);
      const digest = await download(`https://github.com/${FFMPEG_REPO}/releases/download/${FFMPEG_TAG}/${asset}`, tmp, {
        gunzip: true,
        onProgress: (r, t) => this.#setStatus({ progress: t ? (i + r / t) / tools.length : null }),
      });
      if (digests[asset] && digests[asset] !== digest) {
        await fsp.rm(tmp, { force: true });
        throw new Error(`${tool} download failed verification (checksum mismatch)`);
      }
      await fsp.chmod(tmp, 0o755);
      this.#setStatus({ phase: 'verifying', message: `Verifying ${tool}…`, progress: null });
      await run(tmp, ['-version'], { timeout: 180000 });
      await fsp.rename(tmp, path.join(dir, tool));
    }
  }

  // ---------- updates ----------

  /**
   * Check for (and install) a newer yt-dlp. `canSwap` lets the caller defer
   * removing the old version while downloads are running.
   */
  update({ force = false } = {}) {
    if (!this.updating) {
      this.updating = this.#update(force).finally(() => { this.updating = null; });
    }
    return this.updating;
  }

  async #update(force) {
    const current = this.ytdlpVersion;
    const rel = await this.#latestYtdlp();
    this.meta.checkedAt = Date.now();
    this.#writeMeta();
    if (!force && current === rel.version && this.ytdlpPath) {
      this.emit('status', this.status);
      return { updated: false, version: current };
    }
    const prevStatus = { ...this.status };
    try {
      const version = await this.#installYtdlp(rel);
      this.#setStatus({ ...prevStatus, ready: true, phase: 'ready', message: '', progress: null });
      this.emit('updated', version);
      return { updated: version !== current, version };
    } catch (err) {
      this.#setStatus({ ...prevStatus, progress: null });
      throw err;
    }
  }

  /** Remove engine versions other than the current one (call when idle). */
  async prune() {
    try {
      for (const f of await fsp.readdir(this.cookieDir)) {
        if (f.startsWith('run-') && !f.startsWith(`run-${process.pid}-`)) await fsp.rm(path.join(this.cookieDir, f), { force: true });
      }
    } catch {}
    const root = path.join(this.dir, 'yt-dlp');
    const keep = this.ytdlpVersion;
    try {
      for (const name of await fsp.readdir(root)) {
        if (name !== keep && !name.startsWith('.stage-')) await fsp.rm(path.join(root, name), { recursive: true, force: true });
        if (name.startsWith('.stage-') && !name.includes(`-${process.pid}-`)) await fsp.rm(path.join(root, name), { recursive: true, force: true });
      }
    } catch {}
  }
}

module.exports = { Engine };
