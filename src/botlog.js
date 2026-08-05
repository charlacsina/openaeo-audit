"use strict";
// Access log parsing, and the reconciliation that turns our probe into evidence.
//
// The old parser counted how many times a crawler's name appeared as a substring
// anywhere in the file. That answers "was this name present", which is close to
// worthless: it cannot tell a crawler that read two hundred articles from one that
// was refused two hundred times, and those are opposite facts about a business.
//
// What a site owner needs from a log is four things: which crawlers arrived, what
// status they got, which paths they reached, and whether the request was really
// from the operator it named. This file extracts all four.
//
// It runs locally on purpose. An access log is a list of your visitors' addresses,
// and the version of this that uploads one is a worse product no matter how much
// nicer the dashboard is. Nothing here sends anything anywhere: the only network
// call in the whole path is fetching the operators' public address ranges.
const BV = require("./botverify");

// Longest token first, so "claude-searchbot" is not swallowed by "claudebot" and
// "googlebot-image" is not filed as "googlebot".
const BOT_TOKENS = [
  ["oai-searchbot", "OAI-SearchBot", "ChatGPT"],
  ["chatgpt-user", "ChatGPT-User", "ChatGPT"],
  ["gptbot", "GPTBot", "ChatGPT"],
  ["claude-searchbot", "Claude-SearchBot", "Claude"],
  ["claude-user", "Claude-User", "Claude"],
  ["claudebot", "ClaudeBot", "Claude"],
  ["perplexitybot", "PerplexityBot", "Perplexity"],
  ["perplexity-user", "Perplexity-User", "Perplexity"],
  ["googleother", "GoogleOther", "Google"],
  ["google-extended", "Google-Extended", "Gemini"],
  ["googlebot", "Googlebot", "AI Overviews"],
  ["bingbot", "Bingbot", "Copilot"],
  ["applebot", "Applebot", "Siri"],
  ["ccbot", "CCBot", "Common Crawl"],
  ["bytespider", "Bytespider", "Doubao"],
  ["meta-externalagent", "Meta-ExternalAgent", "Meta AI"],
  ["amazonbot", "Amazonbot", "Alexa"],
  ["youbot", "YouBot", "You.com"],
].sort((a, b) => b[0].length - a[0].length);

function identifyBot(ua) {
  const low = String(ua || "").toLowerCase();
  if (!low) return null;
  for (const [tok, name, surface] of BOT_TOKENS) {
    if (low.indexOf(tok) >= 0) return { name, surface, token: tok };
  }
  return null;
}

// Combined Log Format, the nginx and Apache default.
// 1.2.3.4 - - [10/Oct/2026:13:55:36 +0000] "GET /a HTTP/1.1" 200 2326 "-" "UA"
const COMBINED = /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"(\S+)\s+([^"\s]*)[^"]*"\s+(\d{3})\s+(\S+)(?:\s+"([^"]*)"\s+"([^"]*)")?/;

// Field names used by the log shippers people actually have. Checked case
// insensitively so Cloudflare's ClientIP and Caddy's client_ip both land.
const F_IP     = ["clientip", "client_ip", "remoteip", "remote_addr", "ip", "c-ip", "cliententryip", "remotehost"];
const F_UA     = ["clientrequestuseragent", "user_agent", "useragent", "http_user_agent", "cs(user-agent)", "ua", "request_user_agent"];
const F_STATUS = ["edgeresponsestatus", "status", "response_status", "sc-status", "statuscode", "response_code", "originresponsestatus"];
const F_PATH   = ["clientrequesturi", "clientrequestpath", "uri", "path", "request_uri", "cs-uri-stem", "url", "requesturi"];
const F_TIME   = ["edgestartTimestamp", "edgestarttimestamp", "timestamp", "time", "datetime", "ts", "@timestamp"];

function pick(obj, names) {
  for (const k of Object.keys(obj)) {
    if (names.indexOf(k.toLowerCase()) >= 0) {
      const v = obj[k];
      if (v !== null && v !== undefined && v !== "") return v;
    }
  }
  return null;
}

// Returns { ip, ts, method, path, status, ua } or null.
function parseLine(line) {
  const s = String(line || "").trim();
  if (!s) return null;

  if (s[0] === "{") {
    try {
      const j = JSON.parse(s);
      const ua = pick(j, F_UA);
      if (!ua) return null;
      let path = pick(j, F_PATH);
      if (path && /^https?:\/\//i.test(path)) {
        try { path = new URL(path).pathname; } catch (e) { /* leave as is */ }
      }
      // Same rule as the combined format: /a?b=1 and /a are one path, or the
      // top-paths list fragments into near-duplicates and stops being readable.
      if (path) path = String(path).split("?")[0].split("#")[0];
      const st = pick(j, F_STATUS);
      return {
        ip: String(pick(j, F_IP) || "").trim(),
        ts: String(pick(j, F_TIME) || "").slice(0, 32),
        method: String(j.ClientRequestMethod || j.method || j.request_method || "").toUpperCase() || null,
        path: path ? String(path).slice(0, 200) : null,
        status: st === null ? null : parseInt(st, 10),
        ua: String(ua),
      };
    } catch (e) { return null; }
  }

  const m = COMBINED.exec(s);
  if (!m) return null;
  return {
    ip: m[1] === "-" ? "" : m[1],
    ts: (m[2] || "").slice(0, 32),
    method: m[3] || null,
    path: m[4] ? m[4].split("?")[0].slice(0, 200) : null,
    status: parseInt(m[5], 10),
    ua: m[8] || "",
  };
}

const MAX_LINES = 200000;
const MAX_PATHS = 12;

// Parse a log into one record per crawler.
//
// `ranges` comes from botverify.loadRanges. Passing null still parses; every hit
// is then marked unverifiable, which is the honest reading when we could not load
// the operator feeds.
function parseAccessLog(text, ranges) {
  const byBot = new Map();
  let lines = 0, parsed = 0, botHits = 0, truncated = false;

  const raw = String(text || "").split(/\r?\n/);
  for (const line of raw) {
    if (!line.trim()) continue;              // blank lines are not log lines
    if (lines >= MAX_LINES) { truncated = true; break; }
    lines++;
    const rec = parseLine(line);
    if (!rec) continue;
    parsed++;
    const bot = identifyBot(rec.ua);
    if (!bot) continue;
    botHits++;

    let e = byBot.get(bot.name);
    if (!e) {
      e = { bot: bot.name, surface: bot.surface, hits: 0, statuses: {}, vStatuses: {}, uStatuses: {},
            paths: new Map(), ips: new Map(), verified: 0, impostor: 0, unverifiable: 0,
            firstSeen: rec.ts || null, lastSeen: rec.ts || null, whyUnverifiable: null };
      byBot.set(bot.name, e);
    }
    e.hits++;
    if (rec.ts) { if (!e.firstSeen) e.firstSeen = rec.ts; e.lastSeen = rec.ts; }
    const st = Number.isFinite(rec.status) ? String(rec.status) : "unknown";
    e.statuses[st] = (e.statuses[st] || 0) + 1;
    if (rec.path) e.paths.set(rec.path, (e.paths.get(rec.path) || 0) + 1);

    // Classify first, because the verdict decides whether this request counts
    // toward what the real crawler experienced.
    let cls = "unverifiable";
    if (rec.ip) {
      const seen = e.ips.get(rec.ip);
      if (seen) { seen.n++; cls = seen.status; }
      else {
        const c = BV.classify(rec.ip, bot.name, ranges);
        e.ips.set(rec.ip, { n: 1, status: c.status, why: c.why });
        cls = c.status;
        if (!e.whyUnverifiable && c.status === "unverifiable") e.whyUnverifiable = c.why;
      }
    } else if (!e.whyUnverifiable) {
      e.whyUnverifiable = "this log format carries no client address";
    }
    // Only the operator's own addresses tell us how the operator is treated. An
    // impostor sailing through on 200 must never soften the reading of a real
    // crawler being refused: those are two separate findings, and averaging them
    // produces a reassuring number that is false in both directions.
    if (cls === "verified") e.vStatuses[st] = (e.vStatuses[st] || 0) + 1;
    else if (cls !== "impostor") e.uStatuses[st] = (e.uStatuses[st] || 0) + 1;
  }

  const bots = [];
  for (const e of byBot.values()) {
    for (const [, v] of e.ips) {
      if (v.status === "verified") e.verified += v.n;
      else if (v.status === "impostor") e.impostor += v.n;
      else e.unverifiable += v.n;
    }
    const noIp = e.hits - (e.verified + e.impostor + e.unverifiable);
    if (noIp > 0) e.unverifiable += noIp;

    // Judge on verified traffic when we have any, and say which basis was used so
    // the reader can tell "the real GPTBot was refused" from "something calling
    // itself GPTBot was refused".
    //
    // The third case matters most and is the easiest to get flatteringly wrong:
    // if every request under this name came from outside the operator's range,
    // the real crawler did not visit at all. Reporting that as "served" would
    // tell a customer their site is reachable on the strength of a scraper
    // wearing the crawler's name. So it gets its own verdict.
    let outcomeBasis, basis;
    if (e.verified > 0) { outcomeBasis = "verified"; basis = e.vStatuses; }
    else if (e.unverifiable > 0) { outcomeBasis = "unverified"; basis = e.uStatuses; }
    else { outcomeBasis = "impostor-only"; basis = {}; }

    let served = 0, refused = 0;
    for (const k of Object.keys(basis)) {
      const n = basis[k], code = parseInt(k, 10);
      if (!Number.isFinite(code)) continue;
      if (code >= 400) refused += n; else served += n;
    }

    const impostorIps = [];
    for (const [ip, v] of e.ips) if (v.status === "impostor") impostorIps.push(ip);

    bots.push({
      bot: e.bot, surface: e.surface, hits: e.hits,
      statuses: e.statuses, verifiedStatuses: e.vStatuses, served, refused, outcomeBasis,
      outcome: outcomeBasis === "impostor-only" ? "impostor-only"
             : (refused === 0 ? "served" : (served === 0 ? "refused" : "mixed")),
      topPaths: [...e.paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_PATHS)
        .map(([p, n]) => ({ path: p, hits: n })),
      distinctPaths: e.paths.size,
      distinctIps: e.ips.size,
      verified: e.verified, impostor: e.impostor, unverifiable: e.unverifiable,
      impostorIps: impostorIps.slice(0, 5),
      ipRows: [...e.ips.entries()].map(([ip, v]) => ({ ip, n: v.n, status: v.status, why: v.why })),
      whyUnverifiable: e.verified === 0 && e.impostor === 0 ? e.whyUnverifiable : null,
      firstSeen: e.firstSeen, lastSeen: e.lastSeen,
    });
  }
  bots.sort((a, b) => b.hits - a.hits);

  // What share of the AI crawler traffic this site thinks it is getting is real.
  //
  // Nobody reports this, and every site owner assumes the answer is all of it.
  // Stated as a share of what we could decide, with the undecided count next to
  // it, because folding "we could not tell" into either column would be the same
  // overstatement this whole file exists to avoid.
  let claimed = 0, confirmed = 0, fake = 0, undetermined = 0;
  for (const b of bots) {
    claimed += b.hits; confirmed += b.verified; fake += b.impostor; undetermined += b.unverifiable;
  }
  const decided = confirmed + fake;
  const authenticity = {
    claimed, confirmed, impostor: fake, undetermined,
    rate: decided ? Math.round((confirmed / decided) * 100) : null,
    note: !decided
      ? "None of these requests could be verified either way, so no share can be stated."
      : Math.round((confirmed / decided) * 100) === 100
        ? "Every request we could decide came from the operator it named."
        : Math.round((confirmed / decided) * 100) + "% of the requests we could decide were genuine. "
          + "The rest wore a crawler's name without owning the address."
      + (undetermined ? " " + undetermined + " could not be decided either way." : ""),
  };

  return {
    bots, lines, parsed, botHits, truncated, authenticity,
    unparsed: lines - parsed,
    format: parsed === 0 ? "unrecognised" : (raw[0] || "").trim()[0] === "{" ? "json" : "combined",
  };
}

// -------------------------------------------------------------- reconciliation

// The probe says what happened when we asked from our address with a crawler's
// name on. The log says what happened when the crawler itself asked. Where they
// disagree, the log is right and we say so plainly: our own measurement being
// wrong is a fact the customer needs, and burying it would make the product a
// worse instrument for the sake of looking confident.
function reconcile(probeBots, logBots) {
  const byName = new Map((logBots || []).map(b => [b.bot.toLowerCase(), b]));
  const rows = [];
  let agree = 0, contradict = 0, unseen = 0;

  for (const p of (probeBots || [])) {
    if (p.kind !== "fetched") continue;
    const l = byName.get(String(p.name || "").toLowerCase());
    if (!l) {
      rows.push({ bot: p.name, surface: p.surface, probe: p.ok ? "served" : "refused",
        log: "never arrived", agreement: "no-log-evidence",
        note: "This crawler does not appear in the log at all. Either it has not visited in this window, or it cannot reach you." });
      unseen++;
      continue;
    }
    const probeSays = p.ok ? "served" : "refused";

    // Only impostors arrived, so we have no evidence about the operator itself.
    if (l.outcome === "impostor-only") {
      rows.push({ bot: p.name, surface: p.surface, probe: probeSays, log: "only impostors arrived",
        agreement: "no-log-evidence", basis: l.outcomeBasis, hits: l.hits,
        verified: 0, impostor: l.impostor,
        note: "Every request under this name came from outside " + l.bot + "'s published range, so the "
            + "real crawler did not visit in this window. We will not read a scraper's success as yours.",
        impostorNote: l.impostor + (l.impostor === 1 ? " request claimed" : " requests claimed")
            + " to be " + l.bot + " and none of them were. "
            + "Addresses seen: " + l.impostorIps.join(", ") + "." });
      unseen++;
      continue;
    }

    const logSays = l.outcome;
    const counted = l.outcomeBasis === "verified" ? l.verified : l.hits;
    const whose = l.outcomeBasis === "verified"
      ? counted + " confirmed requests from " + l.bot + "'s own network"
      : counted + " requests, none of which we could confirm came from " + l.bot + "'s network";

    let agreement, note;
    if (logSays === "mixed") {
      agreement = "mixed";
      note = "Your log shows both: " + l.served + " served and " + l.refused + " refused, across " + whose +
             ". Read this one by path, because something is treating parts of the site differently.";
    } else if (logSays === probeSays) {
      agreement = "confirmed";
      note = "Our probe measured " + probeSays + ", and " + whose + " were " + logSays + " too.";
    } else {
      agreement = "contradicted";
      note = "Our probe measured " + probeSays + ", but " + whose + " were " + logSays +
             ". Trust the log. This is exactly the case where a spoofed fetch misleads, and it is why we ask for one.";
    }
    if (agreement === "confirmed") agree++;
    else if (agreement === "contradicted") contradict++;

    // Impostor traffic is a separate finding, never a softener for the reading above.
    const impostorNote = l.impostor > 0
      ? l.impostor + (l.impostor === 1 ? " further request claimed" : " further requests claimed")
        + " to be " + l.bot + " from an address outside its published range. "
        + "That is someone else scraping you under a name you may have chosen to allow."
      : null;

    rows.push({ bot: p.name, surface: p.surface, probe: probeSays, log: logSays,
      agreement, note, impostorNote, hits: l.hits, basis: l.outcomeBasis,
      verified: l.verified, impostor: l.impostor });
  }

  const impostorTotal = (logBots || []).reduce((n, b) => n + b.impostor, 0);
  const verifiedTotal = (logBots || []).reduce((n, b) => n + b.verified, 0);

  let level, headline;
  if (!logBots || !logBots.length) {
    level = "probe-only";
    headline = "No log supplied, so everything here is an indication rather than evidence.";
  } else if (contradict > 0) {
    level = "measured-contradicted";
    headline = contradict + " of our probe readings were wrong, and your log corrects them.";
  } else if (agree > 0) {
    level = "measured-confirmed";
    headline = "Your log confirms " + agree + " of our probe readings against real crawler traffic.";
  } else {
    level = "measured-partial";
    headline = "Your log is readable, but none of the crawlers we probe appear in it yet.";
  }

  return { level, headline, rows, agree, contradict, unseen, impostorTotal, verifiedTotal };
}

// Second pass: forward-confirmed reverse DNS over the addresses the range check
// could not settle.
//
// This is deliberately separate and async. Parsing a log is arithmetic and should
// stay instant and testable; resolving a few hundred addresses is network, and a
// caller that cannot afford the wait can simply not call this and still get a
// correct, if less complete, answer.
async function enrichWithRdns(parsed, BVmod) {
  const BV = BVmod || require("./botverify");
  const entries = [];
  for (const b of parsed.bots) {
    for (const r of (b.ipRows || [])) entries.push({ ip: r.ip, bot: b.bot, row: r, status: r.status });
  }
  await BV.enrichWithRdns(entries);

  for (const e of entries) {
    e.row.status = e.status;
    if (e.why) e.row.why = e.why;
    if (e.rdns) e.row.rdns = e.rdns;
    if (e.via) e.row.via = e.via;
  }
  // Recount from the rows, because the whole point was that some of them moved.
  for (const b of parsed.bots) {
    b.verified = b.impostor = b.unverifiable = 0;
    for (const r of (b.ipRows || [])) {
      if (r.status === "verified") b.verified += r.n;
      else if (r.status === "impostor") b.impostor += r.n;
      else b.unverifiable += r.n;
    }
    b.impostorIps = (b.ipRows || []).filter(r => r.status === "impostor").map(r => r.ip).slice(0, 5);
    b.rdnsConfirmed = (b.ipRows || []).filter(r => r.via === "rdns").length;
  }
  let claimed = 0, confirmed = 0, fake = 0, undetermined = 0;
  for (const b of parsed.bots) {
    claimed += b.hits; confirmed += b.verified; fake += b.impostor; undetermined += b.unverifiable;
  }
  const decided = confirmed + fake;
  parsed.authenticity = Object.assign({}, parsed.authenticity, {
    claimed, confirmed, impostor: fake, undetermined,
    rate: decided ? Math.round((confirmed / decided) * 100) : null,
    rdnsUsed: true,
  });
  return parsed;
}

module.exports = { parseAccessLog, reconcile, enrichWithRdns, parseLine, identifyBot, BOT_TOKENS };
