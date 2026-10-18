'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { friendlyError, outputTemplate, buildFormatArgs, qualityOf, sanitizeName } = require('../src/main/ytdlp');

test('friendly error messages', () => {
  assert.match(friendlyError('ERROR: [youtube] abc: Video unavailable'), /unavailable/);
  assert.match(friendlyError('ERROR: [youtube] abc: Private video. Sign in if you have been granted access'), /private/);
  assert.match(friendlyError("ERROR: [youtube] x: Sign in to confirm you're not a bot"), /cookies from/);
  assert.match(friendlyError('ERROR: unable to download: HTTP Error 429: Too Many Requests'), /rate-limiting/);
  assert.equal(friendlyError('ERROR: [youtube] dQw4w9WgXcQ: Something odd happened'), 'Something odd happened');
});

test('format args per quality', () => {
  const s = { preferCompatible: true, container: 'auto' };
  assert.deepEqual(buildFormatArgs({ quality: '1080' }, s).slice(0, 4), ['-f', 'bv*+ba/b', '-S', 'res:1080,vcodec:h264,acodec:m4a']);
  assert.equal(buildFormatArgs({ quality: 'best' }, { preferCompatible: false })[3], 'res');
  assert.ok(buildFormatArgs({ quality: 'audio-mp3' }, s).includes('mp3'));
  assert.deepEqual(buildFormatArgs({ quality: '576' }, s).slice(2, 4), ['-S', 'res:576,vcodec:h264,acodec:m4a']);
  assert.equal(qualityOf('nonsense'), null);
});

test('output template escapes literal % and numbers playlist items', () => {
  const t = outputTemplate({ folder: '/Users/me/100% Videos', subfolder: 'My/List: 2024', playlistIndex: 7, indexWidth: 3 }, {});
  assert.equal(t, '/Users/me/100%% Videos/My List  2024/007 - %(title).180B [%(id)s].%(ext)s'.replace('My List  2024', sanitizeName('My/List: 2024')));
  const t2 = outputTemplate({ folder: '/x' }, { includeIdInName: false });
  assert.equal(t2, '/x/%(title).180B.%(ext)s');
});
