'use strict';

// Formatting helpers shared by the renderer pages.
window.fmt = {
  bytes(n) {
    if (!n || n < 0) return '—';
    const u = ['bytes', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
    return i === 0 ? `${n} bytes` : `${n.toFixed(n >= 100 ? 0 : 1)} ${u[i]}`;
  },
  speed(n) {
    return n ? `${fmt.bytes(n)}/s` : '';
  },
  duration(s) {
    if (s == null || !isFinite(s)) return '';
    s = Math.round(s);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  },
  eta(s) {
    if (s == null || !isFinite(s)) return '';
    s = Math.round(s);
    if (s < 5) return 'a few seconds left';
    if (s < 60) return `${s} sec left`;
    if (s < 3600) return `${Math.round(s / 60)} min left`;
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m ? `${h} hr ${m} min left` : `${h} hr left`;
  },
  homePath(p) {
    return String(p || '').replace(/^\/Users\/[^/]+/, '~');
  },
  folderName(p) {
    const parts = String(p || '').split('/').filter(Boolean);
    return parts[parts.length - 1] || '/';
  },
};
