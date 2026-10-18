'use strict';

// Renders the Hesta mark into build/icon.png (1024²) and build/icon.icns.
// Run with: npm run icon

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const src = fs.readFileSync(path.join(__dirname, 'icon-source.svg'), 'utf8');
const paths = [...src.matchAll(/<path d="([^"]+)" fill="([^"]+)"/g)].map((m) => ({ d: m[1], fill: m[2] }));

// macOS Big Sur+ grid: 824² rounded square centred on a 1024² canvas.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1c1c1e"/><stop offset="1" stop-color="#050505"/>
    </linearGradient>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)" filter="url(#sh)"/>
  <rect x="100.5" y="100.5" width="823" height="823" rx="185" fill="none" stroke="#ffffff" stroke-opacity="0.08"/>
  <g transform="translate(262 262) scale(${500 / 63})">
    ${paths.map((p) => `<path d="${p.d}" fill="${p.fill === 'white' ? '#ffffff' : p.fill}"/>`).join('\n    ')}
  </g>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`)}`);
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const png = img.resize({ width: 1024, height: 1024, quality: 'best' }).toPNG();
  fs.writeFileSync(path.join(__dirname, 'icon.png'), png);

  const set = fs.mkdtempSync(path.join(os.tmpdir(), 'hesta-icon-')) + '/icon.iconset';
  fs.mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(path.join(set, `icon_${s}x${s}.png`), img.resize({ width: s, height: s, quality: 'best' }).toPNG());
    fs.writeFileSync(path.join(set, `icon_${s}x${s}@2x.png`), img.resize({ width: s * 2, height: s * 2, quality: 'best' }).toPNG());
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', set, '-o', path.join(__dirname, 'icon.icns')]);
  console.log('wrote build/icon.png and build/icon.icns');
  app.quit();
});
