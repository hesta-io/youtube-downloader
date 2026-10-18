#!/usr/bin/env node
'use strict';

// Downloads static FFmpeg + FFprobe builds into vendor/ffmpeg/<os>-<arch>/
// so they ship inside the app (electron-builder extraResources).
//
//   node scripts/fetch-ffmpeg.js              # current platform/arch
//   node scripts/fetch-ffmpeg.js mac-arm64 mac-x64 win-x64 linux-x64
//
// Builds come from https://github.com/eugeneware/ffmpeg-static (release b6.1.1,
// FFmpeg 6.1.1, GPL-3.0). Every archive is checked against the SHA-256 pinned
// below before it is used.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { execFileSync } = require('child_process');

const TAG = 'b6.1.1';
const BASE = `https://github.com/eugeneware/ffmpeg-static/releases/download/${TAG}`;
const VENDOR = path.join(__dirname, '..', 'vendor', 'ffmpeg');

// electron-builder ${os} name → ffmpeg-static platform name
const PLATFORM = { mac: 'darwin', win: 'win32', linux: 'linux' };

const SHA256 = {
  'ffmpeg-darwin-arm64.gz': '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
  'ffmpeg-darwin-x64.gz': '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
  'ffmpeg-linux-arm64.gz': '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0',
  'ffmpeg-linux-x64.gz': 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
  'ffmpeg-win32-x64.gz': '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
  'ffprobe-darwin-arm64.gz': 'd986a8ec7b030899fe66a8a288ed809a3543338705a3ce178cfb85869c5d80be',
  'ffprobe-darwin-x64.gz': 'd4da574d6e2e197bd259b47d69cf262df9e312af24ad960444f6d806d3d4c186',
  'ffprobe-linux-arm64.gz': '2ab6aba60ee84412dff9188720703376cb4e7aaf7e0b5e43aa8249f2acae5bf8',
  'ffprobe-linux-x64.gz': '25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067',
  'ffprobe-win32-x64.gz': 'f309e6223ad89d2fe54bccd420a7709b66fd27540674e92309578ed491a43c8d',
};

function currentTarget() {
  const os = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
  return `${os}-${process.arch}`;
}

async function fetchVerified(asset, dest) {
  const expected = SHA256[asset];
  if (!expected) throw new Error(`No pinned checksum for ${asset} (unsupported platform?)`);
  const res = await fetch(`${BASE}/${asset}`);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} downloading ${asset}`);
  const gz = dest + '.gz.download';
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(gz));
  const actual = crypto.createHash('sha256').update(fs.readFileSync(gz)).digest('hex');
  if (actual !== expected) {
    fs.rmSync(gz, { force: true });
    throw new Error(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
  }
  const tmp = dest + '.download';
  await pipeline(fs.createReadStream(gz), zlib.createGunzip(), fs.createWriteStream(tmp, { mode: 0o755 }));
  fs.rmSync(gz, { force: true });
  fs.renameSync(tmp, dest);
}

async function fetchTarget(target) {
  const [os, arch] = target.split('-');
  const platform = PLATFORM[os];
  if (!platform || !arch) throw new Error(`Bad target "${target}" (use e.g. mac-arm64, mac-x64, win-x64, linux-x64)`);
  const dir = path.join(VENDOR, target);
  fs.mkdirSync(dir, { recursive: true });
  const exe = os === 'win' ? '.exe' : '';
  const stamp = path.join(dir, '.version');

  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === TAG &&
      ['ffmpeg', 'ffprobe'].every((t) => fs.existsSync(path.join(dir, t + exe)))) {
    console.log(`ffmpeg ${target}: up to date (${TAG})`);
    return;
  }
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const asset = `${tool}-${platform}-${arch}.gz`;
    process.stdout.write(`ffmpeg ${target}: downloading ${asset}… `);
    await fetchVerified(asset, path.join(dir, tool + exe));
    console.log('verified');
  }
  // Smoke test when the binary can run on this machine.
  if (target === currentTarget() || (process.platform === 'darwin' && os === 'mac')) {
    try {
      const v = execFileSync(path.join(dir, 'ffmpeg' + exe), ['-version'], { encoding: 'utf8', timeout: 120000 });
      console.log(`ffmpeg ${target}: ${v.split('\n')[0]}`);
    } catch (err) {
      if (target === currentTarget()) throw new Error(`ffmpeg ${target} failed to run: ${err.message}`);
    }
  }
  fs.writeFileSync(stamp, TAG + '\n');
}

(async () => {
  const targets = process.argv.slice(2);
  for (const t of targets.length ? targets : [currentTarget()]) await fetchTarget(t);
})().catch((err) => {
  console.error(`\nfetch-ffmpeg: ${err.message}`);
  process.exit(1);
});
