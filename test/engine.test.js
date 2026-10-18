'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// Stub the electron module so engine.js can load under plain Node.
const appPath = path.join(__dirname, '..');
const stub = { app: { isPackaged: false, getAppPath: () => appPath }, net: {} };
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? stub : origLoad.call(this, request, ...rest);
};
const { Engine } = require('../src/main/engine');
Module._load = origLoad;

function makeTools(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const t of ['ffmpeg', 'ffprobe']) fs.writeFileSync(path.join(dir, t), '#!/bin/sh\n', { mode: 0o755 });
}

const osName = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];

test('bundled ffmpeg path in development', () => {
  assert.equal(Engine.bundledFfmpegDir(), path.join(appPath, 'vendor', 'ffmpeg', `${osName}-${process.arch}`));
});

test('bundled ffmpeg path when packaged', () => {
  stub.app.isPackaged = true;
  const prev = process.resourcesPath;
  process.resourcesPath = '/Applications/Hesta Downloader.app/Contents/Resources';
  try {
    assert.equal(Engine.bundledFfmpegDir(), '/Applications/Hesta Downloader.app/Contents/Resources/ffmpeg');
  } finally {
    stub.app.isPackaged = false;
    process.resourcesPath = prev;
  }
});

test('lookup order: custom → bundled → downloaded', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hesta-engine-'));
  const settings = { ffmpegPath: '' };
  const engine = new Engine({ dataDir: data, settings: { get: () => settings } });
  const bundled = path.join(data, 'bundle');
  const orig = Engine.bundledFfmpegDir;
  Engine.bundledFfmpegDir = () => bundled;
  try {
    makeTools(path.join(data, 'engine', 'ffmpeg'));
    let ff = engine.findFfmpeg();
    // Nothing bundled yet → runtime-downloaded copy (or a system one is never preferred over it).
    assert.equal(ff.source, 'downloaded');

    makeTools(bundled);
    ff = engine.findFfmpeg();
    assert.equal(ff.source, 'bundled');
    assert.equal(ff.dir, bundled);

    const custom = path.join(data, 'custom');
    makeTools(custom);
    settings.ffmpegPath = path.join(custom, 'ffmpeg');
    assert.equal(engine.findFfmpeg().source, 'custom');
  } finally {
    Engine.bundledFfmpegDir = orig;
    fs.rmSync(data, { recursive: true, force: true });
  }
});
