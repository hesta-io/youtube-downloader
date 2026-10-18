'use strict';

/* global hesta, fmt, HESTA_WORDMARK */

const $ = (s) => document.querySelector(s);

let settings = {};

function render(s) {
  settings = s;
  $('#s-folder-path').textContent = fmt.homePath(s.folder);
  $('#s-folder-path').title = s.folder;
  $('#s-quality').value = s.quality;
  $('#s-concurrency').value = String(s.concurrency);
  $('#s-container').value = s.container;
  $('#s-cookies').value = s.cookiesBrowser || 'none';
  if (document.activeElement !== $('#s-rate')) $('#s-rate').value = s.rateLimit || '';
  if (document.activeElement !== $('#s-proxy')) $('#s-proxy').value = s.proxy || '';
  for (const sw of document.querySelectorAll('.switch[data-key]')) sw.checked = s[sw.dataset.key] !== false;
}

function renderEngine(info) {
  const y = info.ytdlp || {};
  let text = y.version ? `Version ${y.version}` : 'Not installed';
  if (['downloading', 'installing', 'verifying'].includes(info.phase)) {
    text = `${info.message}${info.progress != null ? ` ${Math.round(info.progress * 100)}%` : ''}`;
  } else if (y.checkedAt) {
    text += ` · checked ${new Date(y.checkedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
  }
  if (info.phase === 'error' && info.error) text += ` · ${info.error}`;
  $('#e-ytdlp').textContent = text;
  const ffSource = { bundled: 'Included with the app', downloaded: 'Downloaded', system: 'System install', custom: 'Custom' };
  $('#e-ffmpeg').textContent = info.ffmpeg
    ? info.ffmpeg.source === 'bundled' ? ffSource.bundled : `${ffSource[info.ffmpeg.source] || ''} — ${fmt.homePath(info.ffmpeg.dir)}`
    : 'Not found';
  $('#e-js').textContent = info.jsRuntime ? `${info.jsRuntime.name}` : '';
}

async function boot() {
  $('#s-brand').innerHTML = HESTA_WORDMARK;
  const init = await hesta.init();
  const qsel = $('#s-quality');
  for (const q of init.qualities) {
    const o = document.createElement('option');
    o.value = q.id;
    o.textContent = q.label;
    qsel.appendChild(o);
  }
  $('#s-version').textContent = `Hesta Downloader ${init.version}`;
  render(init.settings);
  renderEngine(init.engine);
  hesta.onSettings(render);
  hesta.onEngineStatus(renderEngine);

  $('#s-folder').addEventListener('click', async () => {
    const f = await hesta.chooseFolder(settings.folder);
    if (f) hesta.setSettings({ folder: f });
  });
  $('#s-quality').addEventListener('change', (e) => hesta.setSettings({ quality: e.target.value }));
  $('#s-concurrency').addEventListener('change', (e) => hesta.setSettings({ concurrency: Number(e.target.value) }));
  $('#s-container').addEventListener('change', (e) => hesta.setSettings({ container: e.target.value }));
  $('#s-cookies').addEventListener('change', (e) => hesta.setSettings({ cookiesBrowser: e.target.value }));
  for (const sw of document.querySelectorAll('.switch[data-key]')) {
    sw.addEventListener('change', () => hesta.setSettings({ [sw.dataset.key]: sw.checked }));
  }

  const rate = $('#s-rate');
  rate.addEventListener('change', () => {
    const v = rate.value.trim().toUpperCase().replace(/\s+/g, '').replace(/B(\/S)?$/, '');
    const ok = !v || /^\d+(\.\d+)?[KMG]?$/.test(v);
    rate.classList.toggle('bad', !ok);
    if (ok) {
      rate.value = v;
      hesta.setSettings({ rateLimit: v });
    }
  });
  const proxy = $('#s-proxy');
  proxy.addEventListener('change', () => {
    const v = proxy.value.trim();
    const ok = !v || /^(https?|socks4a?|socks5h?):\/\/[^\s]+$/i.test(v);
    proxy.classList.toggle('bad', !ok);
    if (ok) hesta.setSettings({ proxy: v });
  });

  $('#e-update').addEventListener('click', async () => {
    const b = $('#e-update');
    b.disabled = true;
    b.textContent = 'Checking…';
    const r = await hesta.updateEngine();
    b.disabled = false;
    b.textContent = 'Check for Updates';
    if (!r.ok) $('#e-ytdlp').textContent = `Update failed: ${r.error}`;
    else renderEngine(await hesta.engineInfo());
    if (r.ok && !r.updated) $('#e-ytdlp').textContent += ' · up to date';
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || (e.key === 'w' && e.metaKey)) window.close();
  });
}

boot();
