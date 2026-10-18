'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOne, extractLinks } = require('../src/main/links');

const V = 'dQw4w9WgXcQ';
const PL = 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI';

const videoCases = [
  `https://www.youtube.com/watch?v=${V}`,
  `http://youtube.com/watch?v=${V}`,
  `youtube.com/watch?v=${V}`,
  `www.youtube.com/watch?v=${V}&t=42s`,
  `https://m.youtube.com/watch?v=${V}&feature=share`,
  `https://music.youtube.com/watch?v=${V}&si=abc`,
  `https://www.youtube.com/watch?feature=player_embedded&v=${V}`,
  `https://www.youtube.com/watch/${V}`,
  `https://youtu.be/${V}`,
  `https://youtu.be/${V}?si=Xyz123&t=10`,
  `youtu.be/${V}`,
  `https://www.youtube.com/shorts/${V}`,
  `https://youtube.com/shorts/${V}?feature=share`,
  `https://www.youtube.com/live/${V}?si=1`,
  `https://www.youtube.com/embed/${V}?autoplay=1`,
  `https://www.youtube-nocookie.com/embed/${V}`,
  `https://www.youtube.com/v/${V}?version=3`,
  `https://www.youtube.com/e/${V}`,
  `https://youtube.googleapis.com/v/${V}`,
  `https://www.youtube.com/watch#!v=${V}`,
  `https://www.youtube.com/attribution_link?a=x&u=%2Fwatch%3Fv%3D${V}%26feature%3Dshare`,
  `https://www.google.com/url?sa=t&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${V}`,
  `https://consent.youtube.com/m?continue=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${V}%26cbrd%3D1`,
  `https://www.youtubekids.com/watch?v=${V}`,
  `HTTPS://WWW.YOUTUBE.COM/watch?v=${V}`,
  `https://www.youtube.com/watch?v=${V}.`,
];

for (const c of videoCases) {
  test(`video: ${c}`, () => {
    const r = parseOne(c);
    assert.ok(r, 'should parse');
    assert.equal(r.kind, 'video');
    assert.equal(r.videoId, V);
    assert.equal(r.url, `https://www.youtube.com/watch?v=${V}`);
  });
}

const playlistCases = [
  `https://www.youtube.com/playlist?list=${PL}`,
  `youtube.com/playlist?list=${PL}`,
  `https://m.youtube.com/playlist?list=${PL}`,
  `https://music.youtube.com/playlist?list=${PL}`,
  `https://www.youtube.com/embed/videoseries?list=${PL}`,
  `https://music.youtube.com/browse/VL${PL}`,
  `https://www.youtube.com/watch?list=${PL}`,
  PL,
  `https://music.youtube.com/playlist?list=OLAK5uy_kXeVZ0YLGzOIKdYVLnmzSVJRYXJSPKW4o`,
];

for (const c of playlistCases) {
  test(`playlist: ${c}`, () => {
    const r = parseOne(c);
    assert.ok(r, 'should parse');
    assert.equal(r.kind, 'playlist');
    assert.match(r.url, /^https:\/\/www\.youtube\.com\/playlist\?list=/);
  });
}

test('video inside playlist', () => {
  for (const c of [
    `https://www.youtube.com/watch?v=${V}&list=${PL}&index=3`,
    `https://youtu.be/${V}?list=${PL}`,
    `https://music.youtube.com/watch?v=${V}&list=${PL}`,
  ]) {
    const r = parseOne(c);
    assert.equal(r.kind, 'video+playlist', c);
    assert.equal(r.videoId, V);
    assert.equal(r.playlistId, PL);
    assert.equal(r.isMix, false);
  }
  const mix = parseOne(`https://www.youtube.com/watch?v=${V}&list=RD${V}&start_radio=1`);
  assert.equal(mix.kind, 'video+playlist');
  assert.equal(mix.isMix, true);
});

test('channels', () => {
  assert.deepEqual(parseOne('https://www.youtube.com/@MrBeast').url, 'https://www.youtube.com/@MrBeast/videos');
  assert.deepEqual(parseOne('youtube.com/@MrBeast/shorts').url, 'https://www.youtube.com/@MrBeast/shorts');
  assert.equal(parseOne('https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA').kind, 'channel');
  assert.equal(parseOne('https://www.youtube.com/c/LinusTechTips/videos').kind, 'channel');
  assert.equal(parseOne('https://www.youtube.com/user/PewDiePie').kind, 'channel');
  assert.equal(parseOne('https://www.youtube.com/@كوردستان').kind, 'channel');
});

test('rejects non-YouTube and malformed input', () => {
  for (const c of [
    '', 'hello world', 'https://vimeo.com/123456', 'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=short', 'https://youtu.be/', 'https://www.youtube.com/',
    'https://www.youtube.com/feed/subscriptions', 'ftp://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
  ]) {
    assert.equal(parseOne(c), null, c);
  }
});

test('extracts many links from free text, de-duplicated, in order', () => {
  const text = `
    Check these out: https://youtu.be/${V}?si=1, and (https://www.youtube.com/watch?v=${V})
    playlist → <a href="https://www.youtube.com/playlist?list=${PL}">here</a>
    also www.youtube.com/shorts/jNQXAC9IVRw!
    and notyoutube.com/watch?v=aaaaaaaaaaa plus https://vimeo.com/1
  `;
  const r = extractLinks(text);
  assert.deepEqual(r.map((x) => x.kind), ['video', 'playlist', 'video']);
  assert.equal(r[0].videoId, V);
  assert.equal(r[2].videoId, 'jNQXAC9IVRw');
});

test('extracts newline separated list', () => {
  const ids = ['jNQXAC9IVRw', 'dQw4w9WgXcQ', '9bZkp7q19f0'];
  const r = extractLinks(ids.map((i) => `https://youtu.be/${i}`).join('\n'));
  assert.deepEqual(r.map((x) => x.videoId), ids);
});
