"use strict";
// Crawler identity verification.
//
// A user agent string is a claim, not an identity. Anyone can send
// "compatible; GPTBot/1.1" and many scrapers do, precisely because sites tend to
// allow it. So a log line saying GPTBot visited is not evidence that OpenAI
// visited. What settles it is the address the request came from, checked against
// the range the operator publishes for exactly this purpose.
//
// Every one of the seven operators we track publishes a machine readable feed,
// and they have converged on the envelope Google introduced:
//
//   { "creationTime": "...", "prefixes": [ { "ipv4Prefix": "1.2.3.0/24" }, ... ] }
//
// One design rule runs through this file: a request is only ever called an
// impostor on positive evidence. If a feed fails to load, if the log has no
// address, if the operator publishes nothing for that crawler, the answer is
// "unverifiable" and never "impostor". The cost of a false accusation here is a
// customer blocking traffic they wanted, so the failure has to land on the side
// that admits ignorance rather than the side that sounds impressive.
const SOURCES = [
  { op: "OpenAI",     url: "https://openai.com/gptbot.json",        bots: ["gptbot"] },
  { op: "OpenAI",     url: "https://openai.com/searchbot.json",     bots: ["oai-searchbot"] },
  { op: "OpenAI",     url: "https://openai.com/chatgpt-user.json",  bots: ["chatgpt-user"] },
  { op: "Anthropic",  url: "https://claude.com/crawling/bots.json",
    bots: ["claudebot", "claude-searchbot", "claude-user"] },
  { op: "Google",     url: "https://developers.google.com/static/crawling/ipranges/common-crawlers.json",
    bots: ["googlebot"] },
  { op: "Google",     url: "https://developers.google.com/static/crawling/ipranges/special-crawlers.json",
    bots: ["googleother"] },
  { op: "Microsoft",  url: "https://www.bing.com/toolbox/bingbot.json", bots: ["bingbot"] },
  { op: "Perplexity", url: "https://www.perplexity.ai/perplexitybot.json", bots: ["perplexitybot"] },
  { op: "Apple",      url: "https://search.developer.apple.com/applebot.json", bots: ["applebot"] },
];

// Crawlers we deliberately do not claim to verify, with the reason. Being able to
// say why a thing is unverifiable is worth more than quietly omitting it.
const NO_FEED = {
  "google-extended": "a robots.txt token, not a crawler: no request ever arrives under this name",
  "ccbot":           "Common Crawl publishes no address range",
  "bytespider":      "ByteDance publishes no address range",
  "meta-externalagent": "Meta publishes no address range",
};

// ---------------------------------------------------------------- CIDR maths

function v4ToInt(s) {
  const p = s.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const o of p) {
    if (!/^\d{1,3}$/.test(o)) return null;
    const v = parseInt(o, 10);
    if (v > 255) return null;
    n = (n * 256) + v;
  }
  return n;
}

// Returns a BigInt, or null. Handles "::" elision and IPv4-mapped tails such as
// "::ffff:1.2.3.4", which is how a dual stack front end often logs a v4 client.
function v6ToBig(s) {
  s = String(s || "").trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  s = s.replace(/%.*$/, "");                       // strip zone id
  if (s.indexOf(":") < 0) return null;

  let tail = 0n, groupsExpected = 8;
  const lastColon = s.lastIndexOf(":");
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.indexOf(".") >= 0) {
    const v4 = v4ToInt(maybeV4);
    if (v4 === null) return null;
    tail = BigInt(v4);
    s = s.slice(0, lastColon + 1) + "0:0";
    groupsExpected = 8;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rear = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;

  let groups;
  if (rear === null) {
    groups = head;
    if (groups.length !== groupsExpected) return null;
  } else {
    const fill = groupsExpected - head.length - rear.length;
    if (fill < 0) return null;
    groups = head.concat(new Array(fill).fill("0"), rear);
  }

  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{0,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g || "0", 16));
  }
  if (tail) n = (n & ~0xffffffffn) | tail;
  return n;
}

// One parsed prefix: { v6:boolean, base:number|BigInt, bits:number }
function parsePrefix(cidr, v6) {
  const [addr, lenRaw] = String(cidr || "").split("/");
  const bits = parseInt(lenRaw, 10);
  if (!addr || isNaN(bits)) return null;
  if (v6) {
    const b = v6ToBig(addr);
    if (b === null || bits < 0 || bits > 128) return null;
    return { v6: true, base: b >> BigInt(128 - bits), bits };
  }
  const n = v4ToInt(addr);
  if (n === null || bits < 0 || bits > 32) return null;
  return { v6: false, base: bits === 0 ? 0 : Math.floor(n / Math.pow(2, 32 - bits)), bits };
}

function ipInPrefix(ip, pre) {
  if (pre.v6) {
    const b = v6ToBig(ip);
    if (b === null) return false;
    return (b >> BigInt(128 - pre.bits)) === pre.base;
  }
  const n = v4ToInt(ip);
  if (n === null) return false;
  return (pre.bits === 0 ? 0 : Math.floor(n / Math.pow(2, 32 - pre.bits))) === pre.base;
}

// --------------------------------------------------------------- feed loading

const TTL_MS = 6 * 3600 * 1000;
let MEM = { at: 0, data: null };

async function fetchFeed(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow",
      headers: { "User-Agent": "OpenAEO/1.0 (+https://openaeo.dev)" } });
    if (!r.ok) return null;
    const j = await r.json();
    const out = [];
    for (const p of (j && j.prefixes) || []) {
      const v6 = !!p.ipv6Prefix;
      const parsed = parsePrefix(p.ipv6Prefix || p.ipv4Prefix, v6);
      if (parsed) out.push(parsed);
    }
    return out.length ? { prefixes: out, creationTime: (j && j.creationTime) || null } : null;
  } catch (e) {
    return null;
  } finally { clearTimeout(t); }
}

// Load every feed once and index it by crawler name. Feeds that fail are recorded
// as failures rather than as empty ranges, so a network blip can never be read as
// "this address is not OpenAI's".
//
// Memory cache only. This runs on your machine, from your network, for the length
// of one command, and a cache that outlives the process would just be a file we
// have to explain in the privacy section of the README.
async function loadRanges() {
  if (MEM.data && (Date.now() - MEM.at) < TTL_MS) return MEM.data;
  const raw = {};
  await Promise.all(SOURCES.map(async (src) => {
    const feed = await fetchFeed(src.url);
    for (const b of src.bots) {
      raw[b] = feed
        ? { ok: true, op: src.op, url: src.url, creationTime: feed.creationTime,
            cidrs: feed.prefixes.map(p => ({ v6: p.v6, base: p.v6 ? p.base.toString() : p.base, bits: p.bits })) }
        : { ok: false, op: src.op, url: src.url, cidrs: [] };
    }
  }));

  const data = rehydrate(raw);
  MEM = { at: Date.now(), data };
  return data;
}

function rehydrate(raw) {
  const out = {};
  for (const k of Object.keys(raw)) {
    const e = raw[k];
    out[k] = { ok: e.ok, op: e.op, url: e.url, creationTime: e.creationTime || null,
      prefixes: (e.cidrs || []).map(c => ({ v6: c.v6, bits: c.bits, base: c.v6 ? BigInt(c.base) : c.base })) };
  }
  return out;
}

// ------------------------------------------------------------- classification

// "verified"     the address sits inside the operator's published range
// "impostor"     the operator publishes ranges, loaded cleanly, and this is outside
// "unverifiable" no feed, no range published, or no usable address in the log
function classify(ip, botName, ranges) {
  const key = String(botName || "").toLowerCase();
  if (!ip) return { status: "unverifiable", why: "no client address in this log line" };

  const noFeed = NO_FEED[key];
  if (noFeed) return { status: "unverifiable", why: noFeed };

  const entry = ranges && ranges[key];
  if (!entry) return { status: "unverifiable", why: "we track no published range for this crawler" };
  if (!entry.ok) return { status: "unverifiable", why: "the operator's range feed did not load, so we will not judge this" };

  for (const p of entry.prefixes) {
    if (ipInPrefix(ip, p)) return { status: "verified", why: "inside " + entry.op + "'s published range", op: entry.op };
  }
  return { status: "impostor", why: "outside every range " + entry.op + " publishes for this crawler", op: entry.op };
}

function sourceList() {
  return SOURCES.map(s => ({ operator: s.op, url: s.url, crawlers: s.bots }));
}

module.exports = { loadRanges, classify, sourceList, SOURCES, NO_FEED,
  _v4ToInt: v4ToInt, _v6ToBig: v6ToBig, _parsePrefix: parsePrefix, _ipInPrefix: ipInPrefix };
