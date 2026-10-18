'use strict';

// YouTube link detection & normalisation.
//
// Accepts anything a user is likely to paste: full URLs, URLs without a
// scheme, mobile / music / nocookie / embed / shorts / live links, youtu.be
// short links, attribution & consent redirect wrappers, channel pages and bare
// playlist IDs. Returns canonical, de-duplicated descriptors.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^(?:PL|OL|UU|UL|FL|RD|LL|WL|LP|PU|EL|CL|SP|TL|OLAK5uy_|UUSH|UULF|UUMO|UULV|UULP|UUPS|UUPV|UUMF|UUSU)[A-Za-z0-9_-]{0,64}$|^(?:LL|WL)$/;
const BARE_PLAYLIST = /^(?:PL|OLAK5uy_|UU|FL)[A-Za-z0-9_-]{10,64}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE = /^@[\p{L}\p{N}._-]{1,100}$/u;
const CHANNEL_TABS = new Set(['videos', 'shorts', 'streams', 'live', 'playlists', 'podcasts', 'releases', 'featured']);

const YT_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'gaming.youtube.com', 'kids.youtube.com', 'www.youtubekids.com', 'youtubekids.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com',
  'youtube.googleapis.com', 'invidio.us',
]);
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);
const WRAPPER_HOSTS = new Set(['consent.youtube.com', 'www.google.com', 'google.com']);

// Candidate URL-ish tokens inside arbitrary text.
const CANDIDATE_RE = /(?<![a-z0-9.@-])(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:youtube(?:-nocookie|kids)?\.com|youtu\.be|youtube\.googleapis\.com|google\.com\/url)[^\s"'<>()[\]{}]*/gi;

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function toURL(raw) {
  let s = String(raw).trim().replace(/[.,;:!?)\]}>'"]+$/, '');
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u;
  } catch {
    return null;
  }
}

function cleanId(id) {
  return id ? String(id).trim() : '';
}

function videoResult(id, extra = {}) {
  return { kind: 'video', videoId: id, url: `https://www.youtube.com/watch?v=${id}`, ...extra };
}

function playlistResult(listId, videoId) {
  const url = `https://www.youtube.com/playlist?list=${listId}`;
  if (videoId) {
    return {
      kind: 'video+playlist',
      videoId,
      playlistId: listId,
      url,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      // Mixes / radio lists are auto-generated and effectively endless:
      // default to just the video for those.
      isMix: /^RD/.test(listId),
    };
  }
  return { kind: 'playlist', playlistId: listId, url, isMix: /^RD/.test(listId) };
}

function channelResult(base, tab) {
  const t = tab && CHANNEL_TABS.has(tab.toLowerCase()) ? tab.toLowerCase() : 'videos';
  return { kind: 'channel', channel: base, tab: t, url: `https://www.youtube.com/${base}/${t}` };
}

/**
 * Parse a single URL-ish string. Returns a descriptor or null.
 */
function parseOne(raw, depth = 0) {
  if (raw == null || depth > 3) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  if (BARE_PLAYLIST.test(trimmed)) return playlistResult(trimmed);

  const u = toURL(trimmed);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  const params = u.searchParams;
  // Some links put the query in the hash: /watch#!v=ID or #v=ID
  const hashParams = new URLSearchParams(u.hash.replace(/^#!?/, '').replace(/^[^?=&]*\?/, ''));
  const get = (k) => params.get(k) || hashParams.get(k) || '';

  // Redirect wrappers (google.com/url?q=..., consent.youtube.com?continue=...)
  if (WRAPPER_HOSTS.has(host)) {
    const inner = params.get('q') || params.get('url') || params.get('continue');
    return inner ? parseOne(safeDecode(inner), depth + 1) : null;
  }

  const segs = u.pathname.split('/').filter(Boolean).map(safeDecode);
  const list = cleanId(get('list'));
  const listOk = list && PLAYLIST_ID.test(list);

  if (SHORT_HOSTS.has(host)) {
    const id = cleanId(segs[0]);
    if (!VIDEO_ID.test(id)) return listOk ? playlistResult(list) : null;
    return listOk ? playlistResult(list, id) : videoResult(id);
  }

  if (!YT_HOSTS.has(host) && !host.endsWith('.youtube.com')) return null;

  const first = (segs[0] || '').toLowerCase();

  // attribution_link?u=/watch%3Fv%3D...
  if (first === 'attribution_link' || first === 'redirect') {
    const inner = params.get('u') || params.get('q');
    if (!inner) return null;
    const dec = safeDecode(inner);
    return parseOne(dec.startsWith('/') ? 'https://www.youtube.com' + dec : dec, depth + 1);
  }

  // /watch?v=ID[&list=...], /watch/ID
  if (first === 'watch' || first === 'watch_popup' || first === '') {
    const id = cleanId(get('v') || segs[1]);
    if (VIDEO_ID.test(id)) return listOk ? playlistResult(list, id) : videoResult(id);
    if (listOk) return playlistResult(list);
    return null;
  }

  if (first === 'playlist' || first === 'view_play_list' || first === 'course') {
    const p = cleanId(get('list') || get('p'));
    return PLAYLIST_ID.test(p) ? playlistResult(p) : null;
  }

  // YouTube Music: /browse/VLPL...
  if (first === 'browse' && segs[1] && /^VL/.test(segs[1])) {
    const p = segs[1].slice(2);
    return PLAYLIST_ID.test(p) ? playlistResult(p) : null;
  }

  // /embed/videoseries?list=..., /embed/ID, /v/ID, /e/ID, /shorts/ID, /live/ID
  if (['embed', 'v', 'e', 'shorts', 'live', 'clip'].includes(first)) {
    const id = cleanId(segs[1]);
    if (first === 'embed' && (id === 'videoseries' || !id) && listOk) return playlistResult(list);
    if (first === 'clip') return id ? { kind: 'video', clip: true, url: u.href.split('#')[0], videoId: null } : null;
    if (!VIDEO_ID.test(id)) return listOk ? playlistResult(list) : null;
    const extra = first === 'shorts' ? { short: true } : first === 'live' ? { live: true } : {};
    return listOk ? playlistResult(list, id) : videoResult(id, extra);
  }

  // Channels: /@handle[/tab], /channel/UC..[/tab], /c/name[/tab], /user/name[/tab]
  if (HANDLE.test(segs[0] || '')) return channelResult(segs[0], segs[1]);
  if (first === 'channel' && CHANNEL_ID.test(segs[1] || '')) return channelResult(`channel/${segs[1]}`, segs[2]);
  if ((first === 'c' || first === 'user') && segs[1]) return channelResult(`${first}/${segs[1]}`, segs[2]);

  // Old style /<legacyname>/videos
  if (segs.length === 2 && CHANNEL_TABS.has(segs[1].toLowerCase()) && /^[A-Za-z0-9_-]+$/.test(segs[0])) {
    return channelResult(`c/${segs[0]}`, segs[1]);
  }

  return listOk ? playlistResult(list) : null;
}

function keyOf(r) {
  if (r.kind === 'video') return r.videoId ? `v:${r.videoId}` : `u:${r.url}`;
  if (r.kind === 'playlist') return `p:${r.playlistId}`;
  if (r.kind === 'video+playlist') return `vp:${r.videoId}:${r.playlistId}`;
  return `c:${r.channel.toLowerCase()}/${r.tab}`;
}

/**
 * Extract every YouTube link from arbitrary text (one link, many links,
 * a pasted web page...). Order preserved, duplicates removed.
 */
function extractLinks(text) {
  if (!text) return [];
  const str = String(text);
  const out = [];
  const seen = new Set();
  const push = (r) => {
    if (!r) return;
    const k = keyOf(r);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(r);
  };

  const matches = str.match(CANDIDATE_RE) || [];
  for (const m of matches) push(parseOne(m));

  // Bare playlist IDs pasted on their own.
  if (!out.length) {
    for (const tok of str.split(/\s+/)) if (BARE_PLAYLIST.test(tok)) push(playlistResult(tok));
  }
  return out;
}

module.exports = { parseOne, extractLinks, keyOf, VIDEO_ID };
