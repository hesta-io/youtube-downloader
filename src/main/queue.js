'use strict';

// Download queue: concurrency, pause/resume (resumable via yt-dlp .part
// files), automatic retry of transient failures, persistence across launches.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { DownloadProcess, sanitizeName } = require('./ytdlp');

const ACTIVE = new Set(['downloading', 'processing', 'starting']);
const MAX_AUTO_RETRIES = 3;

class DownloadManager extends EventEmitter {
  constructor({ engine, settings, store }) {
    super();
    this.engine = engine;
    this.settings = settings;
    this.store = store; // JsonFile with { jobs: [] }
    this.procs = new Map();
    this.dirty = new Set();
    this.flushTimer = null;
    this.retryTimer = null;
    this.lastPersist = 0;
    this.shuttingDown = false;

    const resume = settings.get().resumeOnLaunch !== false;
    for (const j of this.jobs) {
      if (ACTIVE.has(j.status) || j.status === 'queued') {
        j.status = resume ? 'queued' : 'paused';
        j.speed = null;
        j.eta = null;
      }
    }
    this.store.save();
  }

  get jobs() {
    return this.store.data.jobs;
  }

  get(id) {
    return this.jobs.find((j) => j.id === id);
  }

  list() {
    return this.jobs;
  }

  // ---------- change notification ----------

  #touch(job, persist = false) {
    if (job) this.dirty.add(job.id);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.#flush(), 200);
    if (persist || Date.now() - this.lastPersist > 5000) {
      this.lastPersist = Date.now();
      this.store.save();
    }
  }

  #flush() {
    this.flushTimer = null;
    const changed = [];
    for (const id of this.dirty) {
      const j = this.get(id);
      changed.push(j || { id, removed: true });
    }
    this.dirty.clear();
    if (changed.length) this.emit('changed', changed);
    this.emit('summary', this.summary());
  }

  summary() {
    let active = 0;
    let queued = 0;
    let downloaded = 0;
    let total = 0;
    let speed = 0;
    for (const j of this.jobs) {
      if (ACTIVE.has(j.status)) {
        active++;
        downloaded += j.downloaded || 0;
        total += j.total || 0;
        speed += j.speed || 0;
      } else if (j.status === 'queued') queued++;
    }
    return { active, queued, speed, progress: total ? downloaded / total : active ? -1 : null };
  }

  // ---------- adding ----------

  /**
   * items: [{ id (videoId), url, title, channel, duration, thumbnail, index, live }]
   * opts:  { folder, quality, subfolder, playlistTitle, indexWidth }
   */
  add(items, opts) {
    const added = [];
    let skipped = 0;
    for (const it of items) {
      const dup = this.jobs.find((j) =>
        j.videoId === it.id && j.quality === opts.quality && j.folder === opts.folder &&
        (j.subfolder || null) === (opts.subfolder || null) &&
        (ACTIVE.has(j.status) || j.status === 'queued' || j.status === 'paused'));
      if (dup) { skipped++; continue; }
      const job = {
        id: crypto.randomUUID(),
        videoId: it.id,
        url: it.url,
        title: it.title,
        channel: it.channel || '',
        duration: it.duration || null,
        thumbnail: it.thumbnail || null,
        live: !!it.live,
        quality: opts.quality,
        folder: opts.folder,
        subfolder: opts.subfolder || null,
        playlistTitle: opts.playlistTitle || null,
        playlistIndex: opts.subfolder && it.index ? it.index : null,
        indexWidth: opts.indexWidth || 2,
        status: 'queued',
        downloaded: 0,
        total: 0,
        speed: null,
        eta: null,
        error: null,
        filepath: null,
        filename: null,
        attempts: 0,
        createdAt: Date.now(),
        finishedAt: null,
      };
      this.jobs.push(job);
      added.push(job);
      this.#touch(job);
    }
    this.store.save();
    this.pump();
    return { added: added.length, skipped };
  }

  // ---------- scheduling ----------

  pump() {
    if (this.shuttingDown || !this.engine.status.ready) return;
    const limit = Math.max(1, Math.min(10, Number(this.settings.get().concurrency) || 3));
    const now = Date.now();
    let nextRetry = Infinity;
    for (const job of this.jobs) {
      if (this.procs.size >= limit) break;
      if (job.status !== 'queued') continue;
      if (job.retryAt && job.retryAt > now) { nextRetry = Math.min(nextRetry, job.retryAt); continue; }
      this.#start(job);
    }
    clearTimeout(this.retryTimer);
    if (nextRetry !== Infinity) this.retryTimer = setTimeout(() => this.pump(), nextRetry - now + 50);
  }

  async #start(job) {
    job.status = 'starting';
    job.error = null;
    job.retryAt = null;
    job.speed = null;
    job.eta = null;
    this.#touch(job, true);

    const dir = job.subfolder ? path.join(job.folder, sanitizeName(job.subfolder)) : job.folder;
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.access(dir, fs.constants.W_OK);
    } catch {
      job.status = 'failed';
      job.error = `Cannot write to “${dir}”. Choose another folder.`;
      this.#touch(job, true);
      this.pump();
      return;
    }
    if (job.status !== 'starting' || !this.get(job.id)) return; // paused/removed meanwhile

    const proc = new DownloadProcess(this.engine, job, this.settings.get());
    this.procs.set(job.id, proc);
    proc.on('progress', (p) => {
      if (!this.get(job.id)) return;
      job.status = p.phase === 'processing' ? 'processing' : 'downloading';
      if (p.total) job.total = p.total;
      if (p.downloaded != null) job.downloaded = Math.max(p.downloaded, p.phase === 'processing' ? job.downloaded : 0);
      job.speed = p.speed;
      job.eta = p.eta;
      this.#touch(job);
    });
    proc.on('done', (r) => this.#onDone(job, proc, r));
    job.status = 'downloading';
    this.#touch(job, true);
    proc.start();
  }

  async #onDone(job, proc, r) {
    this.procs.delete(job.id);
    if (proc.filename) job.filename = proc.filename;
    job.speed = null;
    job.eta = null;
    const stillExists = !!this.get(job.id);

    if (r.ok) {
      job.status = 'completed';
      job.filepath = r.filepath || job.filename;
      job.finishedAt = Date.now();
      try {
        const st = await fsp.stat(job.filepath);
        job.total = job.downloaded = st.size;
      } catch {}
      this.emit('completed', job);
    } else if (r.stopped === 'pause') {
      job.status = 'paused';
    } else if (r.stopped === 'shutdown') {
      job.status = 'queued';
    } else if (r.stopped === 'cancel') {
      await this.#cleanupPartials(job);
    } else if (r.transient && job.attempts < MAX_AUTO_RETRIES) {
      job.attempts += 1;
      job.status = 'queued';
      job.retryAt = Date.now() + 2000 * 2 ** job.attempts;
      job.error = null;
    } else {
      job.status = 'failed';
      job.error = r.error;
      job.raw = r.raw;
      this.emit('failed', job);
    }
    if (stillExists) this.#touch(job, true);
    this.pump();
    if (!this.procs.size) this.emit('idle');
  }

  async #cleanupPartials(job) {
    const name = job.filename;
    if (!name) return;
    const dir = path.dirname(name);
    const stem = path.basename(name).replace(/\.[^.]+$/, '');
    try {
      for (const f of await fsp.readdir(dir)) {
        if (!f.startsWith(stem + '.')) continue;
        if (/\.(part|ytdl)$|\.part-Frag\d+|\.f\d+[^/]*$|\.temp\.[^.]+$/.test(f)) {
          await fsp.rm(path.join(dir, f), { force: true });
        }
      }
    } catch {}
  }

  // ---------- user actions ----------

  pause(id) {
    const job = this.get(id);
    if (!job) return;
    const proc = this.procs.get(id);
    if (proc) proc.stop('pause');
    if (job.status === 'queued' || job.status === 'starting' || (!proc && ACTIVE.has(job.status))) job.status = 'paused';
    job.speed = null;
    this.#touch(job, true);
  }

  resume(id) {
    const job = this.get(id);
    if (!job || this.procs.has(id)) return;
    if (['paused', 'failed', 'canceled'].includes(job.status)) {
      job.status = 'queued';
      job.error = null;
      job.attempts = 0;
      job.retryAt = null;
      this.#touch(job, true);
      this.pump();
    }
  }

  retry(id) {
    const job = this.get(id);
    if (!job) return;
    if (job.status === 'completed') {
      job.downloaded = 0;
      job.total = 0;
      job.status = 'paused';
    }
    this.resume(id);
  }

  /** Cancel (removing partial files) or remove a finished item from the list. */
  async remove(id, { deletePartials = true } = {}) {
    const job = this.get(id);
    if (!job) return;
    const idx = this.jobs.indexOf(job);
    this.jobs.splice(idx, 1);
    this.dirty.add(id);
    const proc = this.procs.get(id);
    if (proc) {
      proc.stop('cancel');
    } else if (deletePartials && job.status !== 'completed') {
      await this.#cleanupPartials(job);
    }
    this.#touch(null, true);
  }

  pauseAll() {
    for (const j of this.jobs) if (ACTIVE.has(j.status) || j.status === 'queued') this.pause(j.id);
  }

  resumeAll() {
    for (const j of this.jobs) {
      if (j.status === 'paused' || j.status === 'failed') {
        j.status = 'queued';
        j.error = null;
        j.attempts = 0;
        this.#touch(j);
      }
    }
    this.store.save();
    this.pump();
  }

  clearFinished() {
    const keep = this.jobs.filter((j) => j.status !== 'completed');
    for (const j of this.jobs) if (j.status === 'completed') this.dirty.add(j.id);
    this.store.data.jobs = keep;
    this.#touch(null, true);
  }

  hasActive() {
    return this.procs.size > 0;
  }

  /** Stop everything for app quit; jobs resume next launch. */
  shutdown() {
    this.shuttingDown = true;
    clearTimeout(this.retryTimer);
    const waits = [];
    for (const [, proc] of this.procs) {
      waits.push(new Promise((res) => proc.once('done', res)));
      proc.stop('shutdown');
    }
    for (const j of this.jobs) if (ACTIVE.has(j.status)) j.status = 'queued';
    this.store.flush();
    return Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, 5000))]).then(() => this.store.flush());
  }
}

module.exports = { DownloadManager };
