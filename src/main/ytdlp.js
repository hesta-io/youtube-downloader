'use strict';

// yt-dlp wrapper: metadata probing and a single download process with
// structured progress reporting.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');

const QUALITIES = [
  { id: 'best', label: 'Best available', height: null },
  { id: '4320', label: '8K (4320p)', height: 4320 },
  { id: '2160', label: '4K (2160p)', height: 2160 },
  { id: '1440', label: '1440p', height: 1440 },
  { id: '1080', label: '1080p', height: 1080 },
  { id: '720', label: '720p', height: 720 },
  { id: '480', label: '480p', height: 480 },
  { id: '360', label: '360p', height: 360 },
  { id: '240', label: '240p', height: 240 },
  { id: '144', label: '144p', height: 144 },
  { id: 'audio-m4a', label: 'Audio only (M4A)', audio: 'm4a' },
  { id: 'audio-mp3', label: 'Audio only (MP3)', audio: 'mp3' },
];

// ---------- error mapping ----------

function friendlyError(text) {
  const t = String(text || '');
  const rules = [
    [/confirm you.?re not a bot|sign in to confirm/i, 'YouTube is asking to confirm you are not a bot. Choose a browser under Settings → “Use cookies from” and try again.'],
    [/private video/i, 'This video is private.'],
    [/members?-only|join this channel/i, 'This video is for channel members only.'],
    [/age.?restrict|confirm your age|inappropriate for some users/i, 'This video is age-restricted. Choose a browser under Settings → “Use cookies from” where you are signed in to YouTube.'],
    [/video (is )?unavailable|this video has been removed|no longer available|account associated with this video has been terminated/i, 'This video is unavailable.'],
    [/not available in your country|geo.?restrict|blocked it in your country/i, 'This video is not available in your country.'],
    [/premieres? in|live event will begin|this live event/i, 'This video has not started yet.'],
    [/playlist does not exist|playlist.*(unavailable|private)|The playlist does not exist/i, 'This playlist does not exist or is private.'],
    [/HTTP Error 429|too many requests/i, 'YouTube is rate-limiting requests. Wait a few minutes and try again.'],
    [/HTTP Error 403/i, 'YouTube refused the request (HTTP 403). Updating the engine in Settings usually fixes this.'],
    [/Requested format is not available/i, 'The selected quality is not available for this video.'],
    [/No space left on device/i, 'The destination disk is full.'],
    [/Permission denied|Operation not permitted/i, 'Hesta Downloader cannot write to the destination folder.'],
    [/getaddrinfo|Name or service not known|nodename nor servname|Network is unreachable|timed out|Connection reset|Unable to connect|urlopen error|EOF occurred/i, 'Network problem — check your internet connection.'],
    [/could not find .* cookies|failed to decrypt|cookies database/i, 'Could not read browser cookies. Close the browser or choose a different one in Settings.'],
    [/ffmpeg.*not found|ffprobe.*not found/i, 'ffmpeg is missing. Restart the app to reinstall it.'],
  ];
  for (const [re, msg] of rules) if (re.test(t)) return msg;
  const m = t.match(/ERROR:\s*(?:\[[^\]]+\]\s*)?(?:[A-Za-z0-9_-]{11}:\s*)?(.+)/);
  return (m ? m[1] : t.split('\n').filter(Boolean).pop() || 'Unknown error').trim().slice(0, 300);
}

function isTransient(text) {
  return /HTTP Error (5\d\d|429)|timed out|Connection reset|Temporary failure|getaddrinfo|Network is unreachable|IncompleteRead|EOF occurred|Unable to connect|urlopen error|fragment.*not found|Got error/i.test(String(text || ''));
}

// ---------- probing ----------

async function runJson(engine, args, opts = {}) {
  const base = await engine.invocation();
  try {
    if (!base.bin) throw new Error('Download engine is not installed yet.');
    return await spawnJson(base, args, opts);
  } finally {
    base.cleanup();
  }
}

function spawnJson(base, args, { timeout = 120000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(base.bin, [...base.args, ...args], { env: base.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(v);
    };
    const onAbort = () => {
      child.kill('SIGKILL');
      const e = new Error('Cancelled');
      e.cancelled = true;
      finish(reject, e);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error('Timed out while contacting YouTube. Check your connection and try again.'));
    }, timeout);
    signal?.addEventListener?.('abort', onAbort);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-100000); });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      const text = Buffer.concat(out).toString('utf8').trim();
      // yt-dlp may print one JSON object per line; take the first parseable.
      for (const line of text ? [text, ...text.split('\n')] : []) {
        try {
          const json = JSON.parse(line);
          if (json && typeof json === 'object') return finish(resolve, { json, stderr: err });
        } catch {}
      }
      const e = new Error(friendlyError(err || `yt-dlp exited with code ${code}`));
      e.raw = err;
      finish(reject, e);
    });
  });
}

function thumbFor(id, info) {
  if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  const t = info?.thumbnails;
  return Array.isArray(t) && t.length ? t[t.length - 1].url : info?.thumbnail || null;
}

function availability(e) {
  const title = e.title || '';
  if (/^\[(private|deleted|unavailable)/i.test(title)) return title.replace(/[[\]]/g, '');
  if (e.availability && /private|needs_auth|premium|subscriber_only/.test(e.availability)) {
    return e.availability === 'subscriber_only' ? 'Members only' : e.availability === 'premium' ? 'Premium only' : e.availability === 'needs_auth' ? 'Requires sign-in' : 'Private video';
  }
  if (e.live_status === 'is_upcoming') return 'Upcoming';
  return null;
}

function summariseFormats(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const duration = info.duration || 0;
  const audio = formats.filter((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none');
  const bestAudio = audio.reduce((a, f) => ((f.tbr || 0) > (a?.tbr || 0) ? f : a), null);
  const sizeOf = (f) => f?.filesize || f?.filesize_approx || (f?.tbr && duration ? (f.tbr * 1000 / 8) * duration : 0);
  const byHeight = new Map();
  for (const f of formats) {
    if (!f.height || f.vcodec === 'none' || !f.vcodec) continue;
    if (/storyboard|mhtml/.test(f.format_note || f.ext || '')) continue;
    // yt-dlp's "res" is the smaller dimension, so vertical Shorts label correctly.
    const res = f.width ? Math.min(f.width, f.height) : f.height;
    const prev = byHeight.get(res);
    if (!prev || (f.tbr || 0) > (prev.tbr || 0)) byHeight.set(res, f);
  }
  const heights = [...byHeight.keys()].sort((a, b) => b - a);
  const sizes = {};
  for (const h of heights) {
    const f = byHeight.get(h);
    const s = sizeOf(f) + (f.acodec && f.acodec !== 'none' ? 0 : sizeOf(bestAudio));
    if (s) sizes[String(h)] = Math.round(s);
  }
  if (bestAudio) sizes.audio = Math.round(sizeOf(bestAudio));
  return { heights, sizes, maxHeight: heights[0] || null };
}

function videoEntry(info, index) {
  const id = info.id;
  return {
    id,
    url: info.webpage_url || info.url || `https://www.youtube.com/watch?v=${id}`,
    title: info.title || id,
    channel: info.channel || info.uploader || '',
    duration: info.duration || null,
    thumbnail: thumbFor(id, info),
    index: index ?? null,
    live: info.live_status === 'is_live' || info.is_live === true,
    unavailable: availability(info),
  };
}

/**
 * Fetch metadata for a parsed link. Returns
 *  { kind: 'video', video, formats } or
 *  { kind: 'playlist', title, channel, count, entries, focusId }
 */
async function probe(engine, link, { signal } = {}) {
  if (link.kind === 'video') {
    const { json } = await runJson(engine, ['-J', '--no-playlist', '--no-warnings', link.url], { signal, timeout: 120000 });
    if (json._type === 'playlist') return playlistResult(json, link);
    return { kind: 'video', video: videoEntry(json), formats: summariseFormats(json) };
  }

  const url = link.url;
  const { json } = await runJson(engine, ['-J', '--flat-playlist', '--yes-playlist', '--no-warnings', url], { signal, timeout: 300000 });
  let entries = json.entries || [];

  // Channel roots return nested tab playlists; expand them one level.
  if (entries.length && entries.every((e) => e._type === 'playlist' || e.ie_key === 'YoutubeTab')) {
    const nested = [];
    for (const e of entries.slice(0, 10)) {
      try {
        const r = await runJson(engine, ['-J', '--flat-playlist', '--yes-playlist', '--no-warnings', e.url], { signal, timeout: 300000 });
        nested.push(...(r.json.entries || []));
      } catch (err) {
        if (err.cancelled) throw err;
      }
    }
    entries = nested;
  }
  const result = playlistResult({ ...json, entries }, link);
  // The linked video may not be part of the (flat) playlist listing; fetch it on its own.
  if (link.videoId && !result.entries.some((e) => e.id === link.videoId)) {
    try {
      const r = await runJson(engine, ['-J', '--no-playlist', '--no-warnings', link.videoUrl], { signal, timeout: 120000 });
      result.focus = videoEntry(r.json);
    } catch (err) {
      if (err.cancelled) throw err;
    }
  }
  return result;
}

function playlistResult(json, link) {
  const seen = new Set();
  const entries = [];
  let i = 0;
  for (const e of json.entries || []) {
    if (!e) continue;
    i += 1;
    if (!e.id || seen.has(e.id)) continue;
    // Skip nested playlists / non-video items.
    if (e._type === 'playlist' || (e.ie_key && e.ie_key !== 'Youtube')) continue;
    seen.add(e.id);
    entries.push(videoEntry({ ...e, webpage_url: `https://www.youtube.com/watch?v=${e.id}` }, i));
  }
  return {
    kind: 'playlist',
    id: json.id,
    title: json.title || 'Playlist',
    channel: json.channel || json.uploader || '',
    count: entries.length,
    entries,
    focusId: link.videoId || null,
    isMix: !!link.isMix,
    isChannel: link.kind === 'channel',
  };
}

// ---------- downloading ----------

function escapeTemplate(s) {
  return String(s).replace(/%/g, '%%');
}

function sanitizeName(s) {
  return String(s || '')
    .replace(/[\u0000-\u001f\u007f/\\:]/g, ' ')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'Untitled';
}

function qualityOf(id) {
  const q = QUALITIES.find((x) => x.id === id);
  if (q) return q;
  if (/^\d{2,4}$/.test(String(id))) return { id: String(id), label: `${id}p`, height: Number(id) };
  return null;
}

function buildFormatArgs(job, settings) {
  const q = qualityOf(job.quality) || QUALITIES[0];
  const args = [];
  if (q.audio) {
    args.push('-f', q.audio === 'm4a' ? 'bestaudio[ext=m4a]/bestaudio/best' : 'bestaudio/best', '-x', '--audio-format', q.audio, '--audio-quality', '0');
    if (settings.embedThumbnail !== false) args.push('--embed-thumbnail', '--convert-thumbnails', 'jpg');
    return args;
  }
  const sort = [];
  if (q.height) sort.push(`res:${q.height}`);
  else sort.push('res');
  if (settings.preferCompatible !== false) sort.push('vcodec:h264', 'acodec:m4a');
  args.push('-f', 'bv*+ba/b', '-S', sort.join(','));
  const container = settings.container || 'auto';
  args.push('--merge-output-format', container === 'auto' ? 'mp4/mkv' : container);
  if (container !== 'auto') args.push('--remux-video', container);
  if (settings.embedThumbnail) args.push('--embed-thumbnail');
  if (settings.embedSubs) args.push('--write-subs', '--sub-langs', 'en.*,-live_chat', '--embed-subs');
  return args;
}

function outputTemplate(job, settings) {
  const parts = [escapeTemplate(job.folder)];
  if (job.subfolder) parts.push(escapeTemplate(sanitizeName(job.subfolder)));
  let name = '';
  if (job.playlistIndex && settings.numberPlaylistItems !== false) {
    name += String(job.playlistIndex).padStart(job.indexWidth || 2, '0') + ' - ';
  }
  name += '%(title).180B';
  if (settings.includeIdInName !== false) name += ' [%(id)s]';
  name += '.%(ext)s';
  return path.join(...parts, name);
}

/**
 * One yt-dlp process downloading one job. Emits:
 *   'progress' { downloaded, total, speed, eta, phase }
 *   'file' (finalPath)
 *   'done' ({ ok, error, transient, cancelled, filepath })
 */
class DownloadProcess extends EventEmitter {
  constructor(engine, job, settings) {
    super();
    this.engine = engine;
    this.job = job;
    this.settings = settings;
    this.child = null;
    this.stopping = null;
    this.streams = new Map();
    this.expectedTotal = 0;
    this.streamCount = 1;
    this.filename = null;
    this.filepath = null;
    this.stderr = '';
  }

  async start() {
    let base;
    try {
      base = await this.engine.invocation();
    } catch (err) {
      // e.g. browser cookies could not be read — fail this job, don't retry in a loop.
      this.finished = true;
      this.emit('done', this.stopping
        ? { ok: false, stopped: this.stopping }
        : { ok: false, error: String(err.message || err), transient: false });
      return;
    }
    this.cleanup = base.cleanup;
    if (this.stopping || !base.bin) {
      base.cleanup();
      this.finished = true;
      this.emit('done', this.stopping
        ? { ok: false, stopped: this.stopping }
        : { ok: false, error: 'Download engine is not installed yet.', transient: true });
      return;
    }
    const s = this.settings;
    const args = [
      ...base.args,
      '--newline', '--progress',
      '--no-playlist',
      '--continue', '--part', '--no-mtime',
      '--retries', '15', '--fragment-retries', '15', '--extractor-retries', '5',
      '--retry-sleep', 'http:exp=1:30', '--retry-sleep', 'fragment:exp=1:30',
      '--concurrent-fragments', '4',
      '--embed-metadata',
      '--progress-template', 'download:@@P %(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.format_id)s',
      '--progress-template', 'postprocess:@@PP %(progress.postprocessor)s|%(progress.status)s',
      '--print', 'before_dl:@@F %(format_id)s|%(filesize,filesize_approx)s|%(height)s|%(ext)s',
      '--print', 'before_dl:@@N %(filename)s',
      '--print', 'after_move:@@D %(filepath)s',
      '--no-simulate',
      ...buildFormatArgs(this.job, s),
      '-o', outputTemplate(this.job, s),
    ];
    if (s.rateLimit) args.push('--limit-rate', String(s.rateLimit));
    if (this.job.live) args.push('--live-from-start');
    args.push('--', this.job.url);

    this.child = spawn(base.bin, args, {
      env: base.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group so ffmpeg children stop with it
    });

    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        this.#line(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => {
      this.stderr += d;
      if (this.stderr.length > 100000) this.stderr = this.stderr.slice(-50000);
      for (const l of d.split('\n')) if (l.startsWith('@@')) this.#line(l);
    });
    this.child.on('error', (e) => this.#finish(-1, String(e.message)));
    this.child.on('close', (code, signal) => this.#finish(code, signal));
  }

  #line(line) {
    if (line.startsWith('@@P ')) {
      const [status, dl, total, est, speed, eta, fmt] = line.slice(4).split('|');
      const num = (v) => (v && v !== 'NA' && v !== 'None' ? Number(v) : null);
      const st = this.streams.get(fmt) || { downloaded: 0, total: 0 };
      st.downloaded = num(dl) ?? (status === 'finished' ? num(total) ?? st.total : st.downloaded);
      st.total = num(total) || num(est) || st.total;
      if (status === 'finished') st.done = true;
      this.streams.set(fmt, st);
      this.#emitProgress(num(speed), num(eta), status === 'finished');
    } else if (line.startsWith('@@PP ')) {
      const [pp, status] = line.slice(5).split('|');
      if (status === 'started' || status === 'processing') {
        this.emit('progress', { ...this.#totals(), speed: null, eta: null, phase: 'processing', step: pp });
      }
    } else if (line.startsWith('@@F ')) {
      const [fmt, size] = line.slice(4).split('|');
      this.streamCount = fmt.split('+').length;
      const n = Number(size);
      if (n > 0) this.expectedTotal = n;
    } else if (line.startsWith('@@N ')) {
      this.filename = line.slice(4).trim();
    } else if (line.startsWith('@@D ')) {
      this.filepath = line.slice(4).trim();
      this.emit('file', this.filepath);
    }
  }

  #totals() {
    let downloaded = 0;
    let total = 0;
    for (const s of this.streams.values()) {
      downloaded += s.downloaded || 0;
      total += s.total || 0;
    }
    if (this.streams.size < this.streamCount && this.expectedTotal > total) total = this.expectedTotal;
    return { downloaded, total: Math.max(total, downloaded) };
  }

  #emitProgress(speed, eta, streamFinished) {
    const t = this.#totals();
    const allDone = streamFinished && [...this.streams.values()].filter((s) => s.done).length >= this.streamCount;
    let overallEta = null;
    if (speed && t.total) overallEta = Math.max(0, (t.total - t.downloaded) / speed);
    else if (eta != null) overallEta = eta;
    this.emit('progress', { ...t, speed: allDone ? null : speed, eta: allDone ? null : overallEta, phase: allDone ? 'processing' : 'downloading' });
  }

  /** Stop the process. reason: 'pause' | 'cancel' | 'shutdown' */
  stop(reason) {
    if (this.stopping || this.finished) return;
    if (!this.child) {
      this.stopping = reason; // still preparing; start() will see this
      return;
    }
    if (this.child.exitCode !== null) return;
    this.stopping = reason;
    const pid = this.child.pid;
    const signal = (sig) => {
      try { process.kill(-pid, sig); } catch { try { this.child.kill(sig); } catch {} }
    };
    signal('SIGINT');
    this.killTimer = setTimeout(() => signal('SIGTERM'), 4000);
    this.hardKillTimer = setTimeout(() => signal('SIGKILL'), 8000);
  }

  #finish(code, signal) {
    if (this.finished) return;
    this.finished = true;
    this.cleanup?.();
    clearTimeout(this.killTimer);
    clearTimeout(this.hardKillTimer);
    const stopped = this.stopping;
    if (stopped) {
      this.emit('done', { ok: false, stopped, filename: this.filename });
      return;
    }
    if (code === 0) {
      this.emit('done', { ok: true, filepath: this.filepath || this.filename });
      return;
    }
    const err = this.stderr || `yt-dlp exited with ${signal || code}`;
    this.emit('done', { ok: false, error: friendlyError(err), raw: err.slice(-4000), transient: isTransient(err), filename: this.filename });
  }
}

module.exports = { probe, DownloadProcess, QUALITIES, qualityOf, friendlyError, sanitizeName, outputTemplate, buildFormatArgs };
