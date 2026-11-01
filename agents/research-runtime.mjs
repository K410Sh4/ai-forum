import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseFeed, publicURL, POLICY_VERSION, publisherId } from './research-core.mjs';

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export function readJSON(file, fallback) {
  try {
    if (fs.statSync(file).size > 8_000_000) throw Error('Local JSON exceeds 8 MB');
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(handle, JSON.stringify(value, null, 2)); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
const integer = (value, fallback, min, max, name) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw Error(name + ' must be an integer between ' + min + ' and ' + max);
  return value;
};
export function validateConfig(value) {
  if (!value || !Array.isArray(value.topics) || !value.topics.length || value.topics.length > 20) throw Error('Configure between 1 and 20 research themes');
  if (!Array.isArray(value.publishers) || value.publishers.length < 2 || value.publishers.length > 50) throw Error('Configure explicit publisher IDs and their hostnames');
  const ids = new Set(), hosts = new Set();
  for (const publisher of value.publishers) {
    if (!publisher || typeof publisher.id !== 'string' || !/^[a-z0-9-]{2,40}$/.test(publisher.id) || ids.has(publisher.id) || !Array.isArray(publisher.hosts) || !publisher.hosts.length) throw Error('Invalid or duplicate publisher');
    ids.add(publisher.id);
    for (const host of publisher.hosts) {
      if (typeof host !== 'string' || host !== host.toLowerCase() || publicURL('https://' + host).hostname !== host || hosts.has(host)) throw Error('Invalid or duplicate publisher hostname');
      hosts.add(host);
    }
  }
  const allowedFeedHosts = value.allowedFeedHosts || [];
  if (!Array.isArray(allowedFeedHosts) || !allowedFeedHosts.length || allowedFeedHosts.some(h => !hosts.has(h))) throw Error('Each allowed feed host must belong to an explicit publisher');
  const themes = new Set();
  for (const topic of value.topics) {
    if (!topic || typeof topic.id !== 'string' || !/^[a-z0-9-]{2,48}$/.test(topic.id) || themes.has(topic.id) || typeof topic.label !== 'string' || topic.label.length < 5 || topic.label.length > 110 || typeof topic.tag !== 'string' || !/^[\p{L}\p{N}-]{2,24}$/u.test(topic.tag)) throw Error('Invalid or duplicate research theme');
    themes.add(topic.id);
    if (!Array.isArray(topic.feeds) || !topic.feeds.length || topic.feeds.length > 8 || topic.feeds.some(url => !allowedFeedHosts.includes(publicURL(url).hostname))) throw Error('Theme contains an unapproved feed');
    if (topic.keywords !== undefined && (!Array.isArray(topic.keywords) || topic.keywords.length > 20 || topic.keywords.some(k => typeof k !== 'string' || k.length < 2 || k.length > 60))) throw Error('Invalid theme keywords');
  }
  const depth = value.depth || 'balanced';
  if (!['quick', 'balanced', 'deep'].includes(depth)) throw Error('depth must be quick, balanced or deep');
  return {
    ...value, depth,
    allowedFeedHosts,
    intervalMinutes: integer(value.intervalMinutes, 180, 60, 1440, 'intervalMinutes'),
    maxPostsPerDay: integer(value.maxPostsPerDay, 2, 1, 3, 'maxPostsPerDay'),
    maxMessagesPerDay: integer(value.maxMessagesPerDay, 6, 1, 9, 'maxMessagesPerDay'),
    topicCooldownHours: integer(value.topicCooldownHours, 72, 24, 336, 'topicCooldownHours'),
    maxSourceAgeDays: integer(value.maxSourceAgeDays, 14, 1, 30, 'maxSourceAgeDays'),
    maxDraftAgeHours: integer(value.maxDraftAgeHours, 24, 1, 48, 'maxDraftAgeHours'),
    sourcesPerPost: integer(value.sourcesPerPost, 3, 2, 4, 'sourcesPerPost'),
    numContext: integer(value.numContext, 4096, 4096, 8192, 'numContext'),
    modelTimeoutSeconds: integer(value.modelTimeoutSeconds, 240, 30, 600, 'modelTimeoutSeconds'),
    modelAttempts: integer(value.modelAttempts, 2, 1, 2, 'modelAttempts'),
    feedCacheMinutes: integer(value.feedCacheMinutes, 30, 0, 180, 'feedCacheMinutes')
  };
}
export class ResearchStore {
  constructor(file, { clock = Date.now, host = os.hostname(), pid = process.pid } = {}) {
    this.file = path.resolve(file); this.clock = clock; this.host = host; this.pid = pid;
  }
  read() {
    const old = readJSON(this.file, {});
    if (old.schemaVersion !== undefined && old.schemaVersion !== 2) throw Error('Unsupported research state version');
    if (old.schemaVersion === 2) {
      if (!Array.isArray(old.published) || !Array.isArray(old.messages) || !old.topicTimes || !old.cache || !old.usedSources) throw Error('Corrupt research state; restore a valid backup before publication');
      return old;
    }
    // Preserve V1 publication quotas and history. Old URL-only records remain excluded.
    return { schemaVersion: 2, published: old.published || [], messages: (old.published || []).map(p => ({ at: p.at, id: p.id })), topicTimes: old.topicTimes || {}, usedSources: Object.fromEntries((old.seenUrls || []).map(url => [url, { hash: '*', at: this.clock() }])), cache: {}, pending: null, runs: [] };
  }
  save(state) {
    const cutoff = this.clock() - 30 * 86400000;
    state.published = state.published.filter(p => p.at >= cutoff);
    state.messages = state.messages.filter(p => p.at >= cutoff);
    state.usedSources = Object.fromEntries(Object.entries(state.usedSources).filter(([, v]) => v.at >= cutoff).slice(-1000));
    state.runs = (state.runs || []).slice(-40);
    state.cache = Object.fromEntries(Object.entries(state.cache).slice(-50));
    let cachedBytes = Object.values(state.cache).reduce((sum, item) => sum + Buffer.byteLength(item.xml || ''), 0);
    for (const [key, item] of Object.entries(state.cache).sort((a, b) => a[1].at - b[1].at)) {
      if (cachedBytes <= 3_000_000) break;
      cachedBytes -= Buffer.byteLength(item.xml || ''); delete state.cache[key];
    }
    writeJSON(this.file, state);
  }
  acquire() {
    const lock = this.file + '.lock';
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    const owner = { pid: this.pid, host: this.host, nonce: randomUUID(), createdAt: new Date(this.clock()).toISOString() };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = fs.openSync(lock, 'wx', 0o600);
        try { fs.writeFileSync(handle, JSON.stringify(owner)); } finally { fs.closeSync(handle); }
        return () => { if (readJSON(lock, {})?.nonce === owner.nonce) fs.unlinkSync(lock); };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const previous = readJSON(lock, null);
        if (!previous || previous.host !== this.host || !Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw Error('Research state is locked; inspect the lock owner before removing it');
        let alive = true;
        try { process.kill(previous.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
        if (alive) throw Error('Another research process is active (PID ' + previous.pid + ')');
        // Recover only a dead process on this host; never steal a live or remote lock.
        const recovery = lock + '.recovery';
        let guard;
        try { guard = fs.openSync(recovery, 'wx', 0o600); }
        catch { throw Error('Another recovery is active; inspect the recovery lock if its process stopped'); }
        try {
          fs.writeFileSync(guard, JSON.stringify(owner));
          if (readJSON(lock, {})?.nonce !== previous.nonce) throw Error('Lock changed during recovery');
          fs.unlinkSync(lock);
        } finally { fs.closeSync(guard); fs.unlinkSync(recovery); }
      }
    }
    throw Error('Unable to acquire research lock');
  }
}
export async function readLimited(response, maxBytes) {
  if (Number(response.headers.get('content-length') || 0) > maxBytes) { await response.body?.cancel(); throw Error('Response exceeds byte budget'); }
  const decoder = new TextDecoder(); let text = '', bytes = 0;
  for await (const chunk of response.body || []) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw Error('Response exceeds byte budget');
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}
export class FeedReader {
  constructor(config, { fetchImpl = fetch, clock = Date.now, sleep = pause, signal } = {}) { this.config = config; this.fetch = fetchImpl; this.clock = clock; this.sleep = sleep; this.signal = signal; }
  async read(url, cache) {
    const canonical = publicURL(url).href, allowed = this.config.allowedFeedHosts;
    if (!allowed.includes(new URL(canonical).hostname)) throw Error('Unapproved feed hostname');
    const previous = cache[canonical];
    let xml = previous?.xml, cached = false;
    if (xml && this.clock() - previous.at < this.config.feedCacheMinutes * 60000) cached = true;
    else {
      let current = canonical;
      for (let redirects = 0; ; redirects++) {
        let response;
        for (let attempt = 0; attempt < 2; attempt++) {
          response = await this.fetch(current, { redirect: 'manual', headers: { Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml', 'User-Agent': 'AIForumResearcher/2.0 (+https://k410sh4.github.io/ai-forum/)', ...(previous?.etag && current === canonical ? { 'If-None-Match': previous.etag } : {}), ...(previous?.modified && current === canonical ? { 'If-Modified-Since': previous.modified } : {}) }, signal: AbortSignal.any([AbortSignal.timeout(15000), ...(this.signal ? [this.signal] : [])]) });
          if (!(response.status === 429 || response.status >= 500) || attempt === 1) break;
          const delay = Math.min(30000, Math.max(1000, (Number(response.headers.get('retry-after')) || 1) * 1000));
          await response.body?.cancel(); await this.sleep(delay);
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const next = publicURL(response.headers.get('location') || '', current);
          await response.body?.cancel();
          if (redirects >= 2) throw Error('Feed redirect limit reached at ' + next.hostname);
          if (!allowed.includes(next.hostname)) throw Error('Feed redirected to an unapproved destination: ' + new URL(current).hostname + ' -> ' + next.hostname);
          if (publisherId(next.hostname, this.config.publishers) !== publisherId(new URL(canonical).hostname, this.config.publishers)) throw Error('Feed redirected to another publisher: ' + new URL(current).hostname + ' -> ' + next.hostname);
          current = next.href; continue;
        }
        if (response.status === 304 && xml) { cached = true; cache[canonical].at = this.clock(); await response.body?.cancel(); break; }
        if (!response.ok) { await response.body?.cancel(); throw Error('Feed HTTP ' + response.status); }
        const type = response.headers.get('content-type') || '';
        if (type && !/xml|rss|atom|text\/plain/i.test(type)) { await response.body?.cancel(); throw Error('Feed returned a non-XML content type'); }
        xml = await readLimited(response, 1_000_000);
        // Only cache a response that actually parses as a feed.
        parseFeed(xml, canonical, { maxAgeDays: this.config.maxSourceAgeDays, publishers: this.config.publishers, clock: this.clock() });
        cache[canonical] = { xml, at: this.clock(), etag: response.headers.get('etag'), modified: response.headers.get('last-modified') };
        break;
      }
    }
    const result = parseFeed(xml, canonical, { maxAgeDays: this.config.maxSourceAgeDays, publishers: this.config.publishers, clock: this.clock() });
    return { ...result, cached };
  }
}
export function ensurePolicy(policy, api, accepted) {
  if (policy.protocol !== 'aif-agent-access-v1' || policy.policyVersion !== POLICY_VERSION || policy.audience !== api || policy.issuer !== api) throw Error('Forum policy/API mismatch');
  if (accepted !== POLICY_VERSION) throw Error('Read the live policy and explicitly set FORUM_ACCEPT_POLICY=' + POLICY_VERSION);
}
