'use strict';

/* global hesta, fmt, HESTA_MARK, HESTA_WORDMARK */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const icon = (name) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', `#i-${name}`);
  s.appendChild(u);
  return s;
};

const state = {
  settings: {},
  qualities: [],
  jobs: new Map(),
  order: [],
  rows: new Map(),
  filter: 'all',
  selected: null,
  engine: null,
  parsed: [],
  sheet: null,
};

const ACTIVE = new Set(['downloading', 'processing', 'starting', 'queued', 'paused']);
const RUNNING = new Set(['downloading', 'processing', 'starting']);
const FILTERS = {
  all: { title: 'All Downloads', test: () => true },
  active: { title: 'Active', test: (j) => ACTIVE.has(j.status) },
  completed: { title: 'Completed', test: (j) => j.status === 'completed' },
  failed: { title: 'Failed', test: (j) => j.status === 'failed' },
};

function qualityLabel(id) {
  const q = state.qualities.find((x) => x.id === id);
  if (q) return q.audio ? `Audio · ${q.audio.toUpperCase()}` : q.id === 'best' ? 'Best quality' : q.label.replace(/ \(.*\)/, '');
  return /^\d+$/.test(id) ? `${id}p` : id;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// =====================================================================
// Download list
// =====================================================================

function statusText(j) {
  const total = j.total || 0;
  const dl = j.downloaded || 0;
  switch (j.status) {
    case 'queued':
      return j.retryAt && j.retryAt > Date.now()
        ? `Connection problem — retrying (attempt ${j.attempts + 1})…`
        : dl ? `Waiting — ${fmt.bytes(dl)}${total ? ` of ${fmt.bytes(total)}` : ''} downloaded` : 'Waiting…';
    case 'starting':
      return 'Starting…';
    case 'downloading': {
      if (!dl && !total) return 'Connecting…';
      const parts = [total ? `${fmt.bytes(dl)} of ${fmt.bytes(total)}` : fmt.bytes(dl)];
      if (j.speed) parts.push(fmt.speed(j.speed));
      if (j.eta != null) parts.push(fmt.eta(j.eta));
      return parts.join(' — ');
    }
    case 'processing':
      return j.quality.startsWith('audio') ? 'Converting audio…' : 'Finishing — merging video and audio…';
    case 'paused':
      return total ? `Paused — ${fmt.bytes(dl)} of ${fmt.bytes(total)}` : 'Paused';
    case 'completed':
      return null;
    case 'failed':
      return j.error || 'Download failed';
    default:
      return '';
  }
}

function buildRow(j) {
  const row = el('div', 'row');
  row.dataset.id = j.id;
  row.setAttribute('role', 'listitem');

  const thumb = el('div', 'thumb');
  if (j.thumbnail) {
    const img = el('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    img.src = j.thumbnail;
    img.onerror = () => img.remove();
    thumb.appendChild(img);
  }
  if (j.duration) thumb.appendChild(el('span', 'duration', fmt.duration(j.duration)));
  const badge = el('div', 'state-badge');
  thumb.appendChild(badge);

  const main = el('div', 'row-main');
  const title = el('div', 'row-title', j.title);
  title.title = j.title;
  const meta = el('div', 'row-meta');
  const status = el('div', 'row-status');
  const prog = el('div', 'progress');
  prog.appendChild(el('div', 'progress-fill'));
  main.append(title, meta, prog, status);

  const actions = el('div', 'row-actions');
  row.append(thumb, main, actions);
  row._parts = { thumb, badge, title, meta, status, prog, fill: prog.firstChild, actions };
  row._sig = '';
  return row;
}

function actionButton(name, label, fn, cls = '') {
  const b = el('button', `icon-btn ${cls}`);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.appendChild(icon(name));
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  b.addEventListener('dblclick', (e) => e.stopPropagation());
  return b;
}

function updateRow(row, j) {
  const p = row._parts;
  p.title.textContent = j.title;
  const meta = [j.channel, qualityLabel(j.quality), j.playlistTitle].filter(Boolean);
  p.meta.textContent = meta.join(' · ');

  const showBar = ['downloading', 'processing', 'starting', 'paused', 'queued'].includes(j.status) && (j.status !== 'queued' || j.downloaded);
  p.prog.hidden = !showBar;
  if (showBar) {
    const pct = j.total ? Math.min(100, (j.downloaded / j.total) * 100) : 0;
    p.fill.style.width = `${pct}%`;
    p.prog.classList.toggle('paused', j.status === 'paused' || j.status === 'queued');
    p.prog.classList.toggle('indeterminate', j.status === 'processing' || j.status === 'starting' || (j.status === 'downloading' && !j.total));
  }

  const st = statusText(j);
  p.status.className = 'row-status' + (j.status === 'failed' ? ' error' : j.status === 'completed' ? ' done' : '');
  if (j.status === 'completed') {
    p.status.textContent = '';
    p.status.append(el('span', 'ok', 'Downloaded'), document.createTextNode(` — ${fmt.bytes(j.total)} · in ${fmt.folderName(j.filepath ? j.filepath.replace(/\/[^/]+$/, '') : j.folder)}`));
  } else {
    p.status.textContent = st;
  }
  p.status.title = j.status === 'failed' ? j.error || '' : '';

  // Thumbnail overlay for paused / failed
  p.badge.textContent = '';
  p.badge.hidden = !(j.status === 'paused' || j.status === 'failed');
  if (j.status === 'paused') p.badge.appendChild(icon('pause'));
  if (j.status === 'failed') p.badge.appendChild(icon('warn'));

  // Action buttons — rebuild only when the status class changes
  const sig = RUNNING.has(j.status) || j.status === 'queued' ? 'run' : j.status;
  if (row._sig !== sig) {
    row._sig = sig;
    p.actions.textContent = '';
    if (sig === 'run') {
      p.actions.append(
        actionButton('pause', 'Pause', () => hesta.pause(j.id)),
        actionButton('x', 'Cancel', () => hesta.remove(j.id)),
      );
    } else if (sig === 'paused') {
      p.actions.append(
        actionButton('play', 'Resume', () => hesta.resume(j.id), 'accent'),
        actionButton('x', 'Cancel', () => hesta.remove(j.id)),
      );
    } else if (sig === 'failed') {
      p.actions.append(
        actionButton('retry', 'Retry', () => hesta.retry(j.id), 'accent'),
        actionButton('x', 'Remove', () => hesta.remove(j.id)),
      );
    } else if (sig === 'completed') {
      p.actions.append(
        actionButton('search', 'Show in Finder', () => hesta.revealFile(j.id)),
        actionButton('x', 'Remove from list', () => hesta.remove(j.id)),
      );
    }
  }
}

function visibleJobs() {
  const f = FILTERS[state.filter];
  return state.order.map((id) => state.jobs.get(id)).filter((j) => j && f.test(j));
}

function renderList() {
  const list = $('#list');
  const jobs = visibleJobs();
  const wanted = new Set(jobs.map((j) => j.id));

  for (const [id, row] of state.rows) {
    if (!wanted.has(id)) {
      row.remove();
      state.rows.delete(id);
    }
  }
  let prev = null;
  for (const j of jobs) {
    let row = state.rows.get(j.id);
    if (!row) {
      row = buildRow(j);
      state.rows.set(j.id, row);
    }
    updateRow(row, j);
    row.classList.toggle('selected', state.selected === j.id);
    const expectedNext = prev ? prev.nextSibling : list.firstChild;
    if (expectedNext !== row) list.insertBefore(row, expectedNext);
    prev = row;
  }

  const empty = $('#empty');
  empty.hidden = jobs.length > 0;
  if (!jobs.length) {
    const map = {
      all: ['No downloads yet', 'Paste a YouTube link above, or drop one onto this window.\nVideos, Shorts, playlists and channels are all supported.'],
      active: ['Nothing downloading', 'Active and queued downloads appear here.'],
      completed: ['No completed downloads', 'Finished downloads appear here.'],
      failed: ['No failed downloads', 'Everything went smoothly.'],
    }[state.filter];
    $('#empty-title').textContent = map[0];
    $('#empty-text').textContent = map[1];
  }
  renderCounts();
}

function renderCounts() {
  const counts = { all: 0, active: 0, completed: 0, failed: 0 };
  for (const j of state.jobs.values()) {
    counts.all++;
    for (const k of ['active', 'completed', 'failed']) if (FILTERS[k].test(j)) counts[k]++;
  }
  for (const [k, v] of Object.entries(counts)) {
    const b = document.querySelector(`[data-count="${k}"]`);
    if (b) b.textContent = v ? String(v) : '';
  }
  $('#btn-clear').disabled = !counts.completed;
  const anyRunning = [...state.jobs.values()].some((j) => RUNNING.has(j.status) || j.status === 'queued');
  const anyPaused = [...state.jobs.values()].some((j) => j.status === 'paused' || j.status === 'failed');
  $('#btn-pause-all').disabled = !anyRunning;
  $('#btn-resume-all').disabled = !anyPaused;
}

function renderSummary(s) {
  const sub = $('#toolbar-subtitle');
  if (!s) return;
  const parts = [];
  if (s.active) parts.push(`${s.active} downloading`);
  if (s.queued) parts.push(`${s.queued} waiting`);
  let text = parts.join(', ');
  if (s.speed) text += ` — ${fmt.speed(s.speed)}`;
  if (!text) {
    const n = state.jobs.size;
    text = n ? `${n} item${n === 1 ? '' : 's'}` : '';
  }
  sub.textContent = text;
}

function setFilter(f) {
  if (!FILTERS[f]) return;
  state.filter = f;
  for (const b of document.querySelectorAll('.nav-item[data-filter]')) b.classList.toggle('active', b.dataset.filter === f);
  $('#view-title').textContent = FILTERS[f].title;
  renderList();
}

function select(id, scroll) {
  state.selected = id;
  for (const [rid, row] of state.rows) row.classList.toggle('selected', rid === id);
  if (scroll && id) state.rows.get(id)?.scrollIntoView({ block: 'nearest' });
}

function wireList() {
  const list = $('#list');
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    select(row ? row.dataset.id : null);
    list.focus({ preventScroll: true });
  });
  list.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const j = state.jobs.get(row.dataset.id);
    if (j?.status === 'completed') hesta.openFile(j.id).then((ok) => { if (!ok) toast('The file was moved or deleted.'); });
    else if (j?.status === 'paused' || j?.status === 'failed') hesta.resume(j.id);
  });
  list.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    e.preventDefault();
    select(row.dataset.id);
    hesta.jobMenu(row.dataset.id);
  });
  list.addEventListener('keydown', (e) => {
    const jobs = visibleJobs();
    const idx = jobs.findIndex((j) => j.id === state.selected);
    const j = jobs[idx];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = e.key === 'ArrowDown' ? Math.min(jobs.length - 1, idx + 1) : Math.max(0, idx - 1);
      if (jobs[n]) select(jobs[n].id, true);
    } else if (!j) {
      return;
    } else if (e.key === 'Enter' || (e.key === 'o' && e.metaKey)) {
      e.preventDefault();
      if (j.status === 'completed') hesta.openFile(j.id);
    } else if (e.key === ' ') {
      e.preventDefault();
      if (RUNNING.has(j.status) || j.status === 'queued') hesta.pause(j.id);
      else if (j.status === 'paused' || j.status === 'failed') hesta.resume(j.id);
      else if (j.status === 'completed') hesta.revealFile(j.id);
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      if (j.status === 'completed' || j.status === 'failed' || e.metaKey) {
        e.preventDefault();
        const next = jobs[idx + 1] || jobs[idx - 1];
        hesta.remove(j.id);
        select(next ? next.id : null);
      }
    } else if (e.key === 'r' && e.metaKey && e.shiftKey) {
      e.preventDefault();
      hesta.revealFile(j.id);
    }
  });
}

function applyJobChanges(changes) {
  let structural = false;
  for (const c of changes) {
    if (c.removed) {
      if (state.jobs.delete(c.id)) structural = true;
      state.order = state.order.filter((x) => x !== c.id);
      if (state.selected === c.id) state.selected = null;
      continue;
    }
    const prev = state.jobs.get(c.id);
    if (!prev) {
      state.order.push(c.id);
      structural = true;
    } else if (prev.status !== c.status) structural = true;
    state.jobs.set(c.id, c);
  }
  if (structural) renderList();
  else {
    for (const c of changes) {
      const row = state.rows.get(c.id);
      if (row) updateRow(row, c);
    }
  }
}

// =====================================================================
// URL field
// =====================================================================

function describeLinks(links) {
  if (!links.length) return '';
  if (links.length > 1) return `${links.length} links`;
  const l = links[0];
  return {
    video: l.short ? 'Short' : l.live ? 'Live video' : 'Video',
    playlist: l.isMix ? 'Mix' : 'Playlist',
    'video+playlist': 'Video in playlist',
    channel: 'Channel',
  }[l.kind] || 'Link';
}

let parseSeq = 0;
async function parseInput() {
  const input = $('#url-input');
  const text = input.value.trim();
  const seq = ++parseSeq;
  const links = text ? await hesta.parseLinks(text) : [];
  if (seq !== parseSeq) return links;
  state.parsed = links;
  const field = $('#url-field');
  field.classList.toggle('invalid', !!text && !links.length);
  $('#url-hint').textContent = text ? (links.length ? describeLinks(links) : 'Not a YouTube link') : '';
  $('#btn-fetch').disabled = !links.length;
  return links;
}

function wireUrlBar() {
  const input = $('#url-input');
  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(parseInput, 80);
  });
  input.addEventListener('paste', () => {
    const wasEmpty = !input.value.trim() || input.selectionStart === 0 && input.selectionEnd === input.value.length;
    setTimeout(async () => {
      const links = await parseInput();
      if (wasEmpty && links.length) startFetch(links);
    }, 0);
  });
  $('#url-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const links = await parseInput();
    if (links.length) startFetch(links);
    else if (input.value.trim()) toast('That doesn’t look like a YouTube link.');
  });
}

async function fetchText(text) {
  text = typeof text === 'string' ? text : '';
  const links = await hesta.parseLinks(text || '');
  if (!links.length) {
    toast('No YouTube links found.');
    return;
  }
  $('#url-input').value = links.length === 1 ? links[0].url : text.trim();
  await parseInput();
  startFetch(links);
}

// =====================================================================
// Fetch sheet
// =====================================================================

function showSheetPane(name) {
  $('#sheet-wrap').hidden = false;
  $('#sheet-loading').hidden = name !== 'loading';
  $('#sheet-error').hidden = name !== 'error';
  $('#sheet-body').hidden = name !== 'body';
}

function closeSheet() {
  const s = state.sheet;
  if (s?.tokens) for (const tk of s.tokens) hesta.cancelProbe(tk);
  state.sheet = null;
  $('#sheet-wrap').hidden = true;
  $('#pick-list').textContent = '';
  $('#url-input').focus();
}

async function startFetch(links) {
  if (state.engine && !state.engine.ready && state.engine.phase !== 'checking') {
    toast('The download engine is still being set up…');
  }
  $('#clip-banner').hidden = true;
  const sheet = { links, tokens: new Set(), groups: [], errors: [] };
  state.sheet = sheet;
  showSheetPane('loading');
  $('#sheet-loading-text').textContent = links.length > 1
    ? `Fetching 0 of ${links.length} links…`
    : links[0].kind === 'video' ? 'Fetching video info…' : links[0].kind === 'channel' ? 'Fetching channel videos…' : 'Fetching playlist…';

  let done = 0;
  const results = new Array(links.length);
  const queue = links.map((l, i) => [l, i]);
  const worker = async () => {
    while (queue.length && state.sheet === sheet) {
      const [link, i] = queue.shift();
      const token = Math.random().toString(36).slice(2);
      sheet.tokens.add(token);
      const r = await hesta.probe(token, link);
      sheet.tokens.delete(token);
      results[i] = { link, ...r };
      done++;
      if (state.sheet === sheet && links.length > 1) $('#sheet-loading-text').textContent = `Fetching ${done} of ${links.length} links…`;
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, links.length) }, worker));
  if (state.sheet !== sheet) return;

  for (const r of results) {
    if (!r) continue;
    if (r.ok) sheet.groups.push(makeGroup(r.link, r.result));
    else if (!r.cancelled) sheet.errors.push(r.error);
  }
  if (!sheet.groups.length) {
    $('#sheet-error-title').textContent = links.length > 1 ? 'Couldn’t fetch these links' : 'Couldn’t fetch this link';
    $('#sheet-error-text').textContent = sheet.errors[0] || 'Unknown error.';
    showSheetPane('error');
    $('#sheet-error-retry').focus();
    return;
  }
  renderSheet();
}

function makeGroup(link, res) {
  if (res.kind === 'video') {
    return { type: 'video', link, title: res.video.title, channel: res.video.channel, entries: [res.video], formats: res.formats, thumbnail: res.video.thumbnail };
  }
  const g = {
    type: 'playlist',
    link,
    title: res.title,
    channel: res.channel,
    entries: res.entries,
    focusId: res.focusId,
    isChannel: res.isChannel,
    isMix: res.isMix,
    thumbnail: res.entries[0]?.thumbnail,
  };
  if (res.focusId) {
    g.scope = res.isMix ? 'video' : 'playlist';
    g.focus = res.entries.find((e) => e.id === res.focusId) || res.focus || {
      id: res.focusId,
      url: `https://www.youtube.com/watch?v=${res.focusId}`,
      title: 'Video',
      channel: res.channel,
      thumbnail: `https://i.ytimg.com/vi/${res.focusId}/mqdefault.jpg`,
    };
  }
  return g;
}

function groupEntries(g) {
  if (g.type === 'playlist' && g.focus && g.scope === 'video') return [g.focus];
  return g.entries;
}

function renderSheet() {
  const s = state.sheet;
  s.selected = new Set();
  const all = [];
  for (const g of s.groups) {
    for (const e of groupEntries(g)) {
      all.push({ g, e });
      if (!e.unavailable) s.selected.add(`${g.link.url}|${e.id}`);
    }
  }
  s.items = all;
  s.folder = s.folder || state.settings.folder;

  const single = s.groups.length === 1 ? s.groups[0] : null;
  const isSingleVideo = single && groupEntries(single).length === 1 && single.type === 'video';
  const focusVideo = single && single.type === 'playlist' && single.scope === 'video';

  // Head
  const head = single ? (single.type === 'playlist' && single.scope === 'video' ? single.focus : single) : null;
  const thumb = $('#sheet-thumb');
  const thumbSrc = head?.thumbnail || s.groups[0]?.thumbnail;
  thumb.hidden = !thumbSrc;
  if (thumbSrc) thumb.src = thumbSrc;
  if (single) {
    $('#sheet-title').textContent = head.title;
    const total = groupEntries(single).length;
    const dur = groupEntries(single).reduce((a, e) => a + (e.duration || 0), 0);
    const sub = [];
    if (single.type === 'playlist' && !focusVideo) {
      sub.push(single.isChannel ? 'Channel' : single.isMix ? 'Mix' : 'Playlist');
      sub.push(`${total} video${total === 1 ? '' : 's'}`);
    }
    if (head.channel || single.channel) sub.push(head.channel || single.channel);
    if (dur) sub.push(fmt.duration(dur));
    $('#sheet-sub').textContent = sub.join(' · ');
  } else {
    $('#sheet-title').textContent = `${all.length} videos from ${s.groups.length} links`;
    $('#sheet-sub').textContent = s.groups.map((g) => g.title).slice(0, 3).join(' · ') + (s.groups.length > 3 ? ' …' : '');
  }

  // Scope toggle for "video inside playlist" links
  const scope = $('#sheet-scope');
  scope.hidden = !(single && single.type === 'playlist' && single.focus);
  if (!scope.hidden) {
    for (const b of scope.querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.scope === single.scope);
      if (b.dataset.scope === 'playlist') b.textContent = `Entire ${single.isMix ? 'mix' : 'playlist'} (${single.entries.length})`;
    }
  }

  // Notices
  const notes = [];
  if (s.errors.length) notes.push(`${s.errors.length} link${s.errors.length === 1 ? '' : 's'} couldn’t be fetched: ${s.errors[0]}`);
  const unavailable = all.filter((x) => x.e.unavailable).length;
  if (unavailable) notes.push(`${unavailable} video${unavailable === 1 ? ' is' : 's are'} private or unavailable and will be skipped.`);
  if (all.some((x) => x.e.live)) notes.push('Live streams are recorded from the start until the stream ends.');
  const notice = $('#sheet-notice');
  notice.hidden = !notes.length;
  notice.textContent = notes.join(' ');

  // Picker list
  const showPicker = !isSingleVideo && !focusVideo;
  $('#pick').hidden = !showPicker;
  $('#pick-filter').value = '';
  if (showPicker) renderPickList();

  // Quality
  const sel = $('#opt-quality');
  sel.textContent = '';
  const def = state.settings.quality;
  if (isSingleVideo && single.formats?.heights?.length) {
    const f = single.formats;
    const addOpt = (id, label) => {
      const o = el('option', null, label);
      o.value = id;
      sel.appendChild(o);
    };
    addOpt('best', `Best available (${f.maxHeight}p${f.sizes[String(f.maxHeight)] ? ` · ${fmt.bytes(f.sizes[String(f.maxHeight)])}` : ''})`);
    for (const h of f.heights) {
      if (h < 144) continue;
      const size = f.sizes[String(h)];
      const name = h >= 4320 ? '8K' : h >= 2160 ? '4K' : h >= 1440 ? '2K' : null;
      addOpt(String(h), `${h}p${name ? ` (${name})` : ''}${size ? ` · ${fmt.bytes(size)}` : ''}`);
    }
    const sep = el('option', null, '──────────');
    sep.disabled = true;
    sel.appendChild(sep);
    const a = f.sizes.audio ? ` · ${fmt.bytes(f.sizes.audio)}` : '';
    addOpt('audio-m4a', `Audio only (M4A)${a}`);
    addOpt('audio-mp3', 'Audio only (MP3)');
    // Default: the user's preferred quality, or the closest lower one available.
    let pick = def;
    if (/^\d+$/.test(def)) {
      const target = Number(def);
      const lower = f.heights.filter((h) => h <= target && h >= 144);
      pick = lower.length ? String(lower[0]) : String(f.heights[f.heights.length - 1]);
    }
    sel.value = [...sel.options].some((o) => o.value === pick) ? pick : 'best';
  } else {
    for (const q of state.qualities) {
      if (q.audio && !sel.querySelector('option[value^="audio"]')) {
        const sep = el('option', null, '──────────');
        sep.disabled = true;
        sel.appendChild(sep);
      }
      const o = el('option', null, q.label);
      o.value = q.id;
      sel.appendChild(o);
    }
    sel.value = def;
  }
  updateQualityNote();

  // Folder + options
  renderFolder();
  const hasPlaylist = s.groups.some((g) => g.type === 'playlist' && !(g.focus && g.scope === 'video'));
  $('#opt-subfolder-row').hidden = !hasPlaylist;
  $('#opt-subfolder').checked = state.settings.playlistSubfolder !== false;
  $('#opt-default').checked = false;

  updateSheetSummary();
  showSheetPane('body');
  $('#sheet-download').focus();
}

function updateQualityNote() {
  const s = state.sheet;
  const v = $('#opt-quality').value;
  const single = s?.groups.length === 1 && s.items.length === 1;
  $('#opt-quality-note').textContent = single || v === 'best' || v.startsWith('audio')
    ? ''
    : 'or the closest lower quality available';
}

function renderPickList() {
  const s = state.sheet;
  const list = $('#pick-list');
  const q = $('#pick-filter').value.trim().toLowerCase();
  list.textContent = '';
  const frag = document.createDocumentFragment();
  let lastGroup = null;
  for (const it of s.items) {
    const { g, e } = it;
    if (q && !`${e.title} ${e.channel}`.toLowerCase().includes(q)) continue;
    if (s.groups.length > 1 && g !== lastGroup) {
      lastGroup = g;
      const h = el('div', 'pick-item pick-group');
      h.append(el('span'), el('span'), el('span'));
      const t = el('div', 'pick-text');
      t.append(el('div', 'pick-title', g.title), el('div', 'pick-sub', g.type === 'playlist' ? `${groupEntries(g).length} videos` : g.channel));
      h.append(t, el('span'));
      frag.appendChild(h);
    }
    const key = `${g.link.url}|${e.id}`;
    const row = el('label', 'pick-item' + (e.unavailable ? ' disabled' : '') + (g.focusId === e.id && s.groups.length === 1 ? ' focus' : ''));
    row.setAttribute('role', 'listitem');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = s.selected.has(key);
    cb.disabled = !!e.unavailable;
    cb.addEventListener('change', () => {
      if (cb.checked) s.selected.add(key);
      else s.selected.delete(key);
      updateSheetSummary();
    });
    const idx = el('span', 'pick-index', e.index != null ? String(e.index) : '');
    const img = el('img', 'pick-thumb');
    img.loading = 'lazy';
    img.alt = '';
    if (e.thumbnail) img.src = e.thumbnail;
    img.onerror = () => { img.style.visibility = 'hidden'; };
    const text = el('div', 'pick-text');
    text.append(el('div', 'pick-title', e.title), el('div', 'pick-sub', e.unavailable || e.channel || ''));
    text.firstChild.title = e.title;
    const dur = el('span', 'pick-dur', e.live ? 'LIVE' : fmt.duration(e.duration));
    row.append(cb, idx, img, text, dur);
    frag.appendChild(row);
  }
  list.appendChild(frag);
  if (s.groups.length === 1 && s.groups[0].focusId) {
    list.querySelector('.pick-item.focus')?.scrollIntoView({ block: 'center' });
  }
}

function updateSheetSummary() {
  const s = state.sheet;
  if (!s) return;
  const available = s.items.filter((x) => !x.e.unavailable).length;
  const n = s.selected.size;
  const all = $('#pick-all');
  all.checked = n > 0 && n === available;
  all.indeterminate = n > 0 && n < available;
  $('#pick-all-label').textContent = n ? `${n} of ${available} selected` : 'Select all';
  const dl = $('#sheet-download');
  dl.disabled = n === 0;
  dl.textContent = n > 1 ? `Download ${n} Videos` : 'Download';
  $('#sheet-summary').textContent = '';
}

function renderFolder() {
  const s = state.sheet;
  $('#opt-folder-text').textContent = fmt.homePath(s.folder);
  $('#opt-folder').title = s.folder;
}

async function chooseSheetFolder() {
  const s = state.sheet;
  const f = await hesta.chooseFolder(s.folder);
  if (f && state.sheet === s) {
    s.folder = f;
    renderFolder();
  }
}

async function submitSheet() {
  const s = state.sheet;
  if (!s || !s.selected.size) return;
  const quality = $('#opt-quality').value;
  const sub = !$('#opt-subfolder-row').hidden && $('#opt-subfolder').checked;
  let added = 0;
  let skipped = 0;
  const seen = new Set();
  for (const g of s.groups) {
    const entries = groupEntries(g).filter((e) => s.selected.has(`${g.link.url}|${e.id}`) && !e.unavailable && !seen.has(e.id));
    entries.forEach((e) => seen.add(e.id));
    if (!entries.length) continue;
    const isList = g.type === 'playlist' && !(g.focus && g.scope === 'video');
    const r = await hesta.addJobs(entries, {
      folder: s.folder,
      quality,
      subfolder: isList && sub ? g.title : null,
      playlistTitle: isList ? g.title : null,
      indexWidth: String(g.entries.length).length,
    });
    added += r.added;
    skipped += r.skipped;
  }
  if ($('#opt-default').checked) {
    hesta.setSettings({ folder: s.folder, quality });
  }
  if (!$('#opt-subfolder-row').hidden && sub !== (state.settings.playlistSubfolder !== false)) {
    hesta.setSettings({ playlistSubfolder: sub });
  }
  closeSheet();
  $('#url-input').value = '';
  parseInput();
  if (state.filter === 'completed' || state.filter === 'failed') setFilter('all');
  if (skipped && !added) toast(skipped === 1 ? 'That video is already in the queue.' : 'Those videos are already in the queue.');
  else if (skipped) toast(`Added ${added} — ${skipped} already in the queue.`);
  else toast(added === 1 ? 'Download added' : `${added} downloads added`);
  setTimeout(() => {
    const lastId = state.order[state.order.length - 1];
    if (lastId) state.rows.get(lastId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, 300);
}

function wireSheet() {
  $('#sheet-loading-cancel').addEventListener('click', closeSheet);
  $('#sheet-error-close').addEventListener('click', closeSheet);
  $('#sheet-error-retry').addEventListener('click', () => state.sheet && startFetch(state.sheet.links));
  $('#sheet-cancel').addEventListener('click', closeSheet);
  $('#sheet-download').addEventListener('click', submitSheet);
  $('#opt-folder').addEventListener('click', chooseSheetFolder);
  $('#opt-folder-change').addEventListener('click', chooseSheetFolder);
  $('#opt-quality').addEventListener('change', updateQualityNote);
  $('#pick-filter').addEventListener('input', renderPickList);
  $('#pick-all').addEventListener('change', (e) => {
    const s = state.sheet;
    if (!s) return;
    const q = $('#pick-filter').value.trim().toLowerCase();
    for (const { g, e: v } of s.items) {
      if (v.unavailable) continue;
      if (q && !`${v.title} ${v.channel}`.toLowerCase().includes(q)) continue;
      const key = `${g.link.url}|${v.id}`;
      if (e.target.checked) s.selected.add(key);
      else s.selected.delete(key);
    }
    renderPickList();
    updateSheetSummary();
  });
  $('#sheet-scope').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-scope]');
    const g = state.sheet?.groups[0];
    if (!b || !g || g.scope === b.dataset.scope) return;
    g.scope = b.dataset.scope;
    const folder = state.sheet.folder;
    const quality = $('#opt-quality').value;
    renderSheet();
    state.sheet.folder = folder;
    renderFolder();
    if ([...$('#opt-quality').options].some((o) => o.value === quality)) $('#opt-quality').value = quality;
  });
  $('#sheet-wrap').addEventListener('mousedown', (e) => {
    if (e.target.id === 'sheet-wrap' && $('#sheet-body').hidden === false) {
      // Clicking outside a sheet does nothing on macOS; give a subtle nudge instead.
      const sh = $('#sheet');
      sh.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }], { duration: 220 });
    }
  });
  document.addEventListener('keydown', (e) => {
    if ($('#sheet-wrap').hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSheet();
    } else if (e.key === 'Enter' && !$('#sheet-body').hidden && !(e.target instanceof HTMLSelectElement) && e.target.type !== 'checkbox' && e.target.tagName !== 'BUTTON') {
      e.preventDefault();
      submitSheet();
    }
  });
}

// =====================================================================
// Engine / setup overlay
// =====================================================================

let setupTimer;
function renderEngine(info) {
  state.engine = info;
  const line = $('#engine-line');
  line.textContent = '';
  const dot = el('span', 'dot');
  let text;
  if (info.phase === 'error' && !info.ready) {
    dot.classList.add('err');
    text = 'Engine unavailable';
  } else if (['downloading', 'installing', 'verifying'].includes(info.phase)) {
    dot.classList.add('busy');
    text = info.ready ? 'Updating engine…' : 'Setting up…';
  } else if (info.ytdlp?.version) {
    text = `Engine ${info.ytdlp.version}`;
  } else {
    dot.classList.add('busy');
    text = 'Checking engine…';
  }
  line.append(dot, document.createTextNode(text));
  line.title = info.ytdlp?.version ? `yt-dlp ${info.ytdlp.version}\nffmpeg: ${info.ffmpeg?.dir || 'missing'}\nJS runtime: ${info.jsRuntime?.name}` : '';

  const setup = $('#setup');
  const needsOverlay = !info.ready && info.phase !== 'ready';
  clearTimeout(setupTimer);
  if (!needsOverlay) {
    setup.hidden = true;
    return;
  }
  const show = () => {
    setup.hidden = false;
    $('#setup-text').textContent = info.phase === 'error' ? info.message : info.message || 'Preparing the download engine…';
    $('#setup-detail').textContent = info.phase === 'error' ? info.error || '' : info.phase === 'verifying' ? 'macOS is checking the new files — this can take a few seconds.' : 'This only happens once.';
    const fill = $('#setup-fill');
    const bar = fill.parentElement;
    bar.classList.toggle('indeterminate', info.progress == null && info.phase !== 'error');
    fill.style.width = info.progress != null ? `${Math.round(info.progress * 100)}%` : '0%';
    bar.hidden = info.phase === 'error';
    $('#setup-retry').hidden = info.phase !== 'error';
  };
  if (info.phase === 'checking' && setup.hidden) setupTimer = setTimeout(show, 600);
  else show();
}

// =====================================================================
// Clipboard, drag & drop, menu
// =====================================================================

function showClipboard(links) {
  if (!$('#sheet-wrap').hidden) return;
  const current = state.parsed.map((l) => l.url).join(' ');
  if (links.map((l) => l.url).join(' ') === current) return;
  state.clip = links;
  const what = describeLinks(links).toLowerCase();
  $('#clip-text').textContent = links.length === 1 ? `Copied ${what === 'link' ? 'a link' : `a YouTube ${what}`}: ${links[0].url}` : `Copied ${links.length} YouTube links`;
  $('#clip-banner').hidden = false;
}

function wireGlobal() {
  $('#clip-dismiss').addEventListener('click', () => { $('#clip-banner').hidden = true; });
  $('#clip-fetch').addEventListener('click', () => {
    const links = state.clip || [];
    $('#clip-banner').hidden = true;
    if (!links.length) return;
    $('#url-input').value = links.length === 1 ? links[0].url : links.map((l) => l.url).join(' ');
    parseInput();
    startFetch(links);
  });

  // ⌘V anywhere (outside text fields) pastes into the URL bar and fetches.
  document.addEventListener('paste', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    if (!$('#sheet-wrap').hidden) return;
    const text = e.clipboardData?.getData('text') || '';
    if (!text.trim()) return;
    e.preventDefault();
    fetchText(text);
  });

  // Drag & drop of links from a browser.
  let dragDepth = 0;
  const hasText = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === 'text/uri-list' || t === 'text/plain');
  document.addEventListener('dragenter', (e) => {
    if (!hasText(e)) return;
    e.preventDefault();
    dragDepth++;
    $('#drop-hint').hidden = false;
  });
  document.addEventListener('dragover', (e) => { if (hasText(e)) e.preventDefault(); });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#drop-hint').hidden = true;
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#drop-hint').hidden = true;
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (text && $('#sheet-wrap').hidden) fetchText(text);
  });

  for (const b of document.querySelectorAll('.nav-item[data-filter]')) {
    b.addEventListener('click', () => setFilter(b.dataset.filter));
  }
  $('#nav-folder').addEventListener('click', () => hesta.openFolder(state.settings.folder));
  $('#btn-pause-all').addEventListener('click', () => hesta.pauseAll());
  $('#btn-resume-all').addEventListener('click', () => hesta.resumeAll());
  $('#btn-clear').addEventListener('click', () => hesta.clearFinished());
  $('#btn-settings').addEventListener('click', () => hesta.openSettings());
  $('#setup-retry').addEventListener('click', () => hesta.setupEngine());

  hesta.onMenu((cmd) => {
    if (cmd === 'focus-url') {
      if (!$('#sheet-wrap').hidden) return;
      const i = $('#url-input');
      i.focus();
      i.select();
    } else if (cmd.startsWith('filter:')) {
      setFilter(cmd.slice(7));
    } else if (cmd === 'help-links') {
      toast('Supported: youtube.com/watch, youtu.be, Shorts, Live, embeds, music.youtube.com, playlists, mixes and channels (@handle).');
    }
  });
  hesta.onMenuPaste((text) => {
    if ($('#sheet-wrap').hidden) fetchText(text);
  });

  // Keep relative "retrying" text and other time-based statuses fresh.
  setInterval(() => {
    for (const j of state.jobs.values()) {
      if (j.status === 'queued' && j.retryAt) state.rows.get(j.id) && updateRow(state.rows.get(j.id), j);
    }
  }, 1000);
}

function renderSettings(s) {
  state.settings = s;
  $('#nav-folder-name').textContent = fmt.folderName(s.folder);
  $('#nav-folder').title = s.folder;
}

// =====================================================================
// Boot
// =====================================================================

async function boot() {
  $('#brand').innerHTML = HESTA_WORDMARK;
  $('#brand').firstElementChild.classList.add('wordmark');
  $('#brand').appendChild(el('span', 'product', 'Downloader'));
  $('#empty-mark').innerHTML = HESTA_MARK;
  $('#setup-mark').innerHTML = HESTA_MARK;

  const init = await hesta.init();
  state.qualities = init.qualities;
  renderSettings(init.settings);
  for (const j of init.jobs) {
    state.jobs.set(j.id, j);
    state.order.push(j.id);
  }
  wireList();
  wireUrlBar();
  wireSheet();
  wireGlobal();
  renderList();
  renderSummary(init.summary);
  renderEngine(init.engine);

  hesta.onJobsChanged(applyJobChanges);
  hesta.onSummary(renderSummary);
  hesta.onEngineStatus(renderEngine);
  hesta.onSettings(renderSettings);
  hesta.onClipboardLinks(showClipboard);

  $('#url-input').focus();
}

boot();
